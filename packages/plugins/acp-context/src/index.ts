/**
 * @harness/acp-context - ACP 上下文压缩插件
 *
 * 基于 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 的模型驱动 3 层 LSM
 * 上下文压缩引擎，直接引用它的功能包做宿主适配：
 *
 * - **每轮接入**：通过 core 新增的 `core.session.preModel` hook，在每轮进入模型前
 *   `processTurn` 指派 refs、执行分层压缩过滤、产出 nudge 决策，并把精简后的
 *   会话历史回写持久层（`save`）。
 * - **模型驱动工具**：注入 `compress` / `decompress` / `search_context` / `acp_status`
 *   4 个工具，由模型自己决定压缩时机/范围；nudge 提示模型何时压缩。
 * - **主机兜底**：即使模型不主动调用，nudge 也会在上下文增长达到阈值时以 user 消息
 *   提醒，并最终由 kernel 的 emergency/截断策略兜底。
 *
 * @example
 * import { createHarness } from '@harness/core'
 * import { createAcpContextPlugin } from '@harness/acp-context'
 *
 * const h = await createHarness({
 *   internalPlugins: [createAcpContextPlugin({ modelContextLimit: 200_000 })],
 *   agents: [{ id: 'default', name: 'Agent', mode: 'primary', tools: ['*'],
 *     permission: { '*': 'allow' }, promptFragments: [] }],
 * })
 */

import { defineTool, Schema, ToolResult, ToolContext, withJsonSchema } from '@harness/tool'
import type { AgentPlugin, Hooks, CompactionContext } from '@harness/plugin'
import type { Message } from '@harness/session'
import {
  createCore,
  createInitialState,
  defaultConfig,
  defaultCountTokens,
  parseCompressInput,
  renderNudgeText,
  resolvePrompts,
  buildCompressSystemPrompt,
  assignRefs,
  highestUsedIndex,
  refForRaw,
  coveredMessageIds,
  type Config as AcpConfig,
  type CoreMessage,
  type CompressionState,
  type CompressionBlock,
  type Prompts,
  type TokenCountFn,
} from 'acp-kernel'

import {
  toCores,
  requestMessages,
  estimateTokens,
  cjkAwareCountTokens,
  chars4CountTokens,
  baseId,
  safeString,
} from './adapter.js'
import { applyAutoTune, describeAutoTune, type LooseAcpConfig } from './auto-tune.js'
import { loadPromptFiles } from './prompts.js'
import type { SystemStabilityReport } from '@harness/plugin'
import {
  createWriter as createTelemetryWriter,
  buildPreModelEvent,
  buildCompressEvent,
  buildProviderCacheEvent,
  diffPromptPrefix,
  type PromptPrefixDiff,
  type TelemetryWriter,
} from './telemetry.js'

/** session.meta 中存储 ACP 压缩状态的键 */
export const ACP_META_KEY = 'acp.v1'
/** session.meta 中存储"被 session 压缩折叠窗口的原文归档"的键（跨重启回溯用） */
export const ACP_ARCHIVE_KEY = 'acp.archive.v1'

// ===== 轻量 Schema 工厂（不依赖 zod）=====
function makeSchema<T>(): Schema<T> {
  return {
    parse(value: unknown): T {
      return value as T
    },
    safeParse(value: unknown) {
      return { success: true, data: value as T }
    },
  }
}

/**
 * 脱敏内核压缩系统提示里的**字面示例标签**。
 *
 * 内核默认提示（buildCompressSystemPrompt 输出）里带一个完整的可复制模板：
 * `<acp tokens="2.1K" type="tool:bash">m00175</acp>`，同一页又要求 "NEVER echo these tags"。
 * 实测（会话 s_1789516184627_g800t）DeepSeek 会照抄模板把标签输出进正文，与工具调用协议混淆。
 * 这里把示例改成不完整形态：保住「每条消息都带 ref 标签」的语义，但不再提供可直接复制的模板。
 * （消息上由内核注入的**真实** ref 标签不受影响 —— 那是 compress 选段的机制本身。）
 */
export function sanitizeExampleTags(text: string): string {
  return text.replace(
    /<acp tokens="[^"]*" type="[^"]*">m\d+<\/acp>/g,
    '<acp tokens=… type=…>mNNNNN</acp>',
  )
}

/**
 * 占用率低于压缩阈值时注入的**极简提示**（替代约 1.9K tokens 的完整压缩手册）。
 * 仅告诉模型"何时该压、去哪看用法"，完整要点放在 compress 工具的 `documentation`（每轮都在工具载荷里）。
 * 这样低占用会话不再为一份用不上的说明书长期付费（真机 ra6w1 全程占用率峰值仅 13.3%，却付了 44 次手册钱）。
 */
export const COMPRESS_MANUAL_HINT =
  '接近容量上限时可调用 compress 工具压缩历史；用法见该工具说明（acp_status 可查看当前占用率）。'

/**
 * compress 工具的 `documentation`：每轮都出现在工具载荷里，所以必须短（≤ 600 字符）。
 * 从内核压缩手册（buildCompressSystemPrompt 输出）提炼"何时压 / content 给什么"的要点：
 * 范围用 startId/endId ref、summary 必须自包含、只压"已完成且不再需要原文"的段。
 */
export const COMPRESS_TOOL_DOC = [
  'compress：把 startId..endId 范围内已结束、且不再需要原文的历史折叠成一段自包含摘要，换回上下文空间。',
  '何时压：上下文接近容量上限、或某段任务已完成且后续无需回原文时（先调 acp_status 看占用率）。',
  'content 每段给：topic(可选)、startId/endId(用消息 ref，如 m00012)、summary。',
  'summary 是这段历史被替换后的唯一记录，须自包含完整：用户目标与意图、决策及理由、精确路径/签名/报错原文/数值、结论、踩坑教训；丢弃已提取信息的冗余长日志，勿照搬。',
].join('\n')

/**
 * 手册提前注入系数：占用率到达 `minContextLimitPct × 0.9` 即在**尾部**注入完整手册。
 *
 * 理由：nudge 在 occupancy ≥ minContextLimitPct 时才提示压缩；若手册与 nudge 同轮才出现，
 * 模型在"刚跨阈值、本应开始考虑压缩"的那一轮反而没有手册可用。提前 10%（0.9 倍）注入，
 * 保证跨阈值附近若干轮模型都已持有完整用法。低于此占用率只在前缀留 COMPRESS_MANUAL_HINT。
 *
 * ⚠️ 位置约束（真机量化，见 docs/usage-accounting-and-prompt-cache-plan.md §3）：
 * 完整手册**必须注入在尾部**，不能放前缀 —— 自动前缀缓存按最长公共 token 前缀命中，
 * 放在历史之前会让"手册出现"那一刻其后的**全部内容（含整段历史）**重算：
 * 越阈值时前缀 ≈ 105K tokens，翻转一次 ≈ 95K token-equiv；而按需省下的只有 ≈ 259
 * token-equiv/次 ⇒ 回本要 366 次调用。也就是说，"变量放前缀"对**会越阈值的会话是净亏**，
 * 而那恰恰是需要压缩的那类会话。尾部是本轮新增内容，放在那里翻转代价 ≈ 0。
 */
const MANUAL_INJECT_MARGIN = 0.9

// ===== 工具输入类型 =====

export interface CompressRangeArg {
  topic?: string
  startId: string
  endId: string
  summary: string
  summaryMaxChars?: number
}
export interface CompressInput {
  topic?: string
  content: CompressRangeArg[]
}
export interface CompressOutput {
  blocksCreated: number
  tokensCompressed: number
  errors: string[]
  warnings: string[]
}

export interface DecompressInput {
  blockId: string
  toFile?: boolean
  full?: boolean
}
export interface DecompressOutput {
  blockId: string
  topic?: string
  summary: string
  tokensCompressed: number
  active: boolean
  tier: 1 | 2 | 3
  effectiveMessages: string[]
  /** 断点索引：该块覆盖的原文消息在主会话历史中的起止 id（供宿主 loader 按 [startId,endId] 从归档容器切片回读）。缺省为空串表示无覆盖。 */
  startId: string
  endId: string
  /** 被该块压缩并归档的原始消息全文（按原顺序），便于模型了解被折叠的具体内容 */
  originalMessages: Array<{ id: string; role?: string; text: string }>
}

export interface SearchInput {
  query: string
  limit?: number
}
export interface SearchResult {
  blockId: string
  topic?: string
  summary: string
  score: number
  /** 断点索引：覆盖原文的起止消息 id，供宿主经归档容器切片回读全文 */
  startId?: string
  endId?: string
}
export interface SearchOutput {
  query: string
  limit: number
  results: SearchResult[]
}

export interface AcpStatusInput {}
export interface AcpStatusOutput {
  contextUsage: number
  tokenCount: number
  modelContextLimit: number
  activeBlocks: number
  totalBlocks: number
  tokensCompressed: number
  breakdown: Record<string, number>
}

// ===== 插件选项 =====

export interface AcpContextPluginOptions {
  /** 模型上下文窗口（tokens）。默认 200_000。 */
  modelContextLimit?: number
  /** 覆盖 kernel 的默认 config（tiers / nudge / protectedTools 等）。嵌套对象可只给部分字段。 */
  config?: LooseAcpConfig
  /**
   * 按模型上下文窗口**自动推导** compression/nudge 参数（默认 false = 用 `config` 里的原始值）。
   * 推导规则见 `./auto-tune.ts`。开启后 `config` 里**显式写出**的键仍然优先覆盖推导值，
   * 因此可以「自动打底 + 手工钉一两个键」。
   */
  autoTune?: boolean
  /**
   * token 折算口径（默认 `'auto'`）。
   *
   * - `'auto'`（推荐）：与 acp-kernel 共用 `defaultCountTokens` —— 中日韩字符 1 token/字、
   *   其余 4 字符/token。**英文会话与旧口径逐位等价**；中文会话修正原先约 4 倍的低估。
   * - `'chars4'`：旧口径（一律 `chars/4`）。中文会话下占用率被低估约 4 倍，会让
   *   `maxContextLimitPct` / `emergencyThresholdPct` / 工具输出截断整体偏晚。仅作回退与 A-B 对照。
   *
   * ⚠️ 该口径同时决定内核内部计数（注入 `createCore`）与插件上报的 `tokenCount`，
   * 两者必须一致——这正是早年"占用率显示 26% 而实际已 103%"的根因。
   */
  tokenCalibration?: 'auto' | 'chars4'
  /**
   * 本地 token 估算的额外校正系数（缺省 1 = 不校正）。
   *
   * 本地口径与 provider 实际计费口径**不是同一把尺子**：真机实测（DeepSeek / deepseek-flash）
   * 稳定为 **1.33**（provider 输入 ÷ 本地整包估算 = 1.328 / 1.342 / 1.337 / 1.332）
   * ⇒ 本地系统性低估约 25%，occupancy 与 tier 阈值整体偏保守（报 26.9% 时实际已约 35%）。
   * 观测值可从遥测 `providerCache.calibration` 取；本系数由 `compression.tokenCalibrationScale`
   * 配置。**在这里包装而不是各自乘**：engine 与本插件的占用率必须共用同一把尺子。
   */
  tokenCalibrationScale?: number
  /** 内置 ACP 工具名（默认全部注入，可用其中的子集） */
  toolIds?: Array<'compress' | 'decompress' | 'search_context' | 'acp_status'>
  /**
   * t1/t2/t3 压缩及压缩哲学的提示词覆盖（key 见 acp-kernel 的 Prompts：
   * compressPhilosophy / howToCompressRules / tier2DistillRules / tier3CondenseRules）。
   * 触发 resolvePrompts 合并默认提示（load-bearing，须 acknowledgeRisk）。
   */
  prompts?: Partial<Prompts>
  /** 整段覆盖压缩系统提示（优先级最高，覆盖 prompts 合成的 buildCompressSystemPrompt 输出） */
  systemPrompt?: string
  /**
   * 压缩系统手册（buildCompressSystemPrompt 输出，约 1.9K tokens）的注入策略。
   *
   * - `'on-demand'`（默认）：占用率接近压缩阈值（`config.nudge.minContextLimitPct` 的 0.9 倍）
   *   时，把完整手册注入到请求**尾部**；低于该占用率只在前缀留一行极简提示
   *   `COMPRESS_MANUAL_HINT`，避免为"用不上的说明书"长期付费。
   * - `'always'`：每轮把完整手册注入**前缀**（复刻改造前的行为），便于 A-B 对照或回退。
   *   前缀文本恒定，因此它本身不产生缓存翻转代价。
   *
   * 为什么 on-demand 要注在尾部而不是前缀：前缀里放会变的文本，会让它之后的全部内容
   * （含整段历史）在前缀缓存里失效，一次翻转的代价远大于按需省下的量（量化见
   * `MANUAL_INJECT_MARGIN` 注释 / docs/usage-accounting-and-prompt-cache-plan.md §3）。
   *
   * 例外：`systemPrompt` 被显式赋值时，用户文本始终注入**前缀**（显式配置优先，且它恒定无风险），
   * 不再往尾部注入手册。
   */
  manualInjection?: 'on-demand' | 'always'
  // ---- 遥测 ----
  /** 开启运行时遥测（默认 true）；关闭后不写任何 JSONL 遥测文件 */
  telemetryEnabled?: boolean
  /** 遥测文件路径 builder；未提供则不写遥测（no-op）。通常由 CLI 传入 dataDir/sessions/{sessionId}.telemetry.jsonl */
  telemetryPathBuilder?: (sessionId: string) => string | undefined
}

/** 会话级 ACP 运行时上下文（内存态，跨轮保留；state 会持久化到 session.meta） */
interface AcpSessionCtx {
  state: CompressionState
  /**
   * 本轮映射的原始消息归档（core.id → Message）。
   * 即使某范围的原始消息被压缩出本轮请求，仍可通过它还原全文（decompress full）。
   */
  archive: Map<string, Message>
  /** 最近一次 processTurn 的 core（已指派 refs），供工具引用 */
  lastCores: CoreMessage[]
  /** 是否已从 session.meta 水合过压缩状态 */
  hydrated: boolean
  /** 已持久化到 ACP_ARCHIVE_KEY 的 core id / ref 集合（用于幂等合并原文归档），惰性初始化 */
  archivedKeys: Set<string>
  /** 已回填到 session.blocks 的 ACP 内部折叠块 id（按 blockId 幂等，避免每轮重复写块），惰性初始化 */
  recordedBlockIds: Set<string>
  /** 最近一次持久化的状态 JSON（用于跳过无变化的重复写入） */
  stateSnapshot: string
  // ---- 增量渲染缓存 ----
  /** 已渲染（含压缩效果/refs 标签）的历史前缀的原始消息 id 序列 */
  prefixIds: string[]
  /** 与 prefixIds 对应的渲染结果（不含 system），增量路径直接复用 */
  prefixRender: Message[]
  /** 是否需要强制全量重算（压缩发生/状态变化/水合后置位） */
  needFull: boolean
  /** 全量路径最后一次的 token 估算，用于判断增量是否逼近阈值 */
  lastTokens: number
  /** 会话 meta 写访问器（由 runPreModel 注入，供 compress 工具即时持久化状态） */
  meta?: { patch: (patch: Record<string, unknown>) => Promise<void> }
  // ---- 遥测 ----
  /** 每轮 preModel 递增的 round 序号，供事件打点用 */
  round?: number
  /** 遥测文件 writer（debounced flush；path 未注入时为 no-op） */
  telemetry?: TelemetryWriter
  /** 上轮 processTurn 返回的 cores（用于计算 ACP 侧缓存命中 = 同前缀占比） */
  prevRequestCores?: CoreMessage[]
  // ---- 前缀缓存回退归因 ----
  /** 上一轮**实际发给模型**的 prompt 投影（role + 正文指纹用；不含 id，见 diffPromptPrefix） */
  prevPromptView?: { role: string; text: string }[]
  /** 本轮 prompt 的前缀差异；供随后的 providerCache 行归因 */
  lastPrefixDiff?: PromptPrefixDiff | null
  /** 上一轮 providerCache 行（ts + cacheRead），用于判断命中量是否下降、空等了多久 */
  lastCacheRow?: { ts: number; cacheRead: number }
  /**
   * 本轮来自引擎的**系统区（前缀）段级归因**（`core.session.preModel` 的 input）。
   *
   * 只有引擎检测到 system 区相对上一轮 query 变化时才有值。它把遥测里的
   * `cacheMissReason: 'system-changed'` 从"系统区变了"细化到"**第 N 段**变了"——
   * 本项目 system 区是多插件往同一数组 push 拼出来的，不点名就只能靠猜。
   */
  lastSystemStability?: SystemStabilityReport
}

// ========================================================================
// 插件工厂
// ========================================================================

/**
 * 由 `modelContextLimit` + 用户 config 求解最终内核 config。
 *
 * `autoTune` 为真时先用 `applyAutoTune` 按窗口推导一套参数作为**底**，用户显式写出的键
 * 覆盖在其上；为假时完全按用户 config（缺省回落 kernel 默认值）。
 * 抽成纯函数便于单测与诊断（`describeAutoTune` 可打印推导摘要）。
 */
export function resolveAcpConfig(
  modelContextLimit: number,
  userConfig?: LooseAcpConfig,
  autoTune?: boolean,
): AcpConfig {
  const effective: LooseAcpConfig = autoTune
    ? applyAutoTune(modelContextLimit, userConfig ?? {})
    : (userConfig ?? {})
  return defaultConfig(modelContextLimit, effective as Partial<AcpConfig>)
}

/**
 * 创建 ACP 上下文压缩插件。
 * 每轮通过 core.session.preModel 运行 acp-kernel 的 processTurn，并注入 4 个模型驱动工具。
 */
export function createAcpContextPlugin(options: AcpContextPluginOptions = {}): AgentPlugin {
  const modelContextLimit = options.modelContextLimit ?? 200_000
  const config = resolveAcpConfig(modelContextLimit, options.config, options.autoTune)
  // 提示词：默认来自插件目录 prompts/*.txt（可本地编辑），config 传入的 prompts 覆盖在其上，
  // systemPrompt 整段覆盖为最高优先级。nudge 渲染与本轮压缩系统提示保持一致。
  //
  // 解析走内核 resolvePrompts 契约（prompts.d.ts）：所有 Prompts 字段 load-bearing，
  // 任何覆盖都必须 acknowledgeRisk:true（内核的防呆设计）；且只有 string 值生效
  // （malformed partial 被静默丢弃、不污染内核默认）。注意 filePrompts 是内核默认的
  // 本地快照，内核升级后若 txt 未同步会以旧规则覆盖新规则 —— 升级内核时同步更新 txt。
  const filePrompts = loadPromptFiles()
  const resolvedPrompts: Prompts = resolvePrompts(
    { ...filePrompts, ...(options.prompts ?? {}) },
    { acknowledgeRisk: true },
  )
  const makeSystemPrompt = (): string =>
    options.systemPrompt ?? sanitizeExampleTags(buildCompressSystemPrompt(resolvedPrompts))
  // 手册注入策略：默认 on-demand（低占用只给极简提示，省 token）；explicitSystemPrompt 表示
  // 用户显式整段覆盖了 systemPrompt，必须始终注入完整手册（不受阈值影响）。
  const manualInjection = options.manualInjection ?? 'on-demand'
  const explicitSystemPrompt = options.systemPrompt !== undefined
  // token 折算口径：默认与内核同一份实现（CJK 感知）。'auto' 显式注入等价于内核默认值，
  // 目的是把口径**钉死在一处**——插件上报的 tokenCount 与内核内部计数永远是同一把尺子。
  const baseCountTokens = options.tokenCalibration === 'chars4' ? chars4CountTokens : cjkAwareCountTokens
  // 校正系数在**唯一解析点**包装：engine（createCore）与本插件的占用率/遥测从此共用同一把尺子。
  // 非法值（非正数/NaN）一律按不校正处理，不静默取一个奇怪的数。
  const scale = options.tokenCalibrationScale
  const countTokens: typeof baseCountTokens =
    typeof scale === 'number' && Number.isFinite(scale) && scale > 0 && scale !== 1
      ? (text: string) => Math.ceil(baseCountTokens(text) * scale)
      : baseCountTokens
  // 引擎纯态：state 由宿主显式传入/取回
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const engine = createCore({ countTokens })

  const allowToolIds = new Set<string>(options.toolIds)
  const want = (id: string): boolean =>
    !options.toolIds || options.toolIds.length === 0 || allowToolIds.has(id)

  // 会话级上下文（进程内）
  const sessions = new Map<string, AcpSessionCtx>()
  const telemetryEnabled = options.telemetryEnabled !== false
  const telemetryPathBuilder = options.telemetryPathBuilder

  function getOrCreateCtx(sessionId: string): AcpSessionCtx {
    let ctx = sessions.get(sessionId)
    if (!ctx) {
      const path = telemetryEnabled && telemetryPathBuilder ? telemetryPathBuilder(sessionId) : undefined
      ctx = {
        state: createInitialState(),
        archive: new Map(),
        lastCores: [],
        hydrated: false,
        archivedKeys: new Set(),
        recordedBlockIds: new Set(),
        stateSnapshot: '',
        prefixIds: [],
        prefixRender: [],
        needFull: true,
        lastTokens: 0,
        round: 0,
        telemetry: createTelemetryWriter(path),
      }
      sessions.set(sessionId, ctx)
    }
    return ctx
  }

  // ===== compress / decompress / search_context / acp_status 工具 =====

  const compressTool = want('compress')
    ? defineTool<CompressInput, CompressOutput>({
        id: 'compress',
        description:
          '压缩历史消息：把指定 ref 范围内的旧消息折叠成一段摘要，换回上下文空间。模型写摘要、内核做编排。',
        documentation: COMPRESS_TOOL_DOC,
        inputSchema: withJsonSchema(makeSchema<CompressInput>(), {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '本次压缩的主题（可选，便于日后检索）' },
            content: {
              type: 'array',
              description: '要折叠的范围列表；每段的 summary 是这段历史被替换后的唯一记录，必须自洽完整',
              items: {
                type: 'object',
                properties: {
                  topic: { type: 'string', description: '该段的主题（可选）' },
                  startId: { type: 'string', description: '起始消息 ref（如 m00012）' },
                  endId: { type: 'string', description: '结束消息 ref' },
                  summary: { type: 'string', description: '自包含的摘要：任务状态、结论、关键路径/签名/报错原文、决策及理由' },
                  summaryMaxChars: { type: 'number', description: '摘要长度上限（可选）' },
                },
                required: ['startId', 'endId', 'summary'],
              },
            },
          },
          required: ['content'],
          additionalProperties: false,
        }),
        isConcurrencySafe: () => false,
        isReadOnly: () => false,
        async call(input, ctx) {
          const sctx = sessions.get(ctx.sessionId)
          if (!sctx) {
            return { ok: false, error: { message: '当前会话尚无 ACP 上下文', code: 'NO_CTX' } }
          }
          const ranges = parseCompressInput(
            input,
            ctx.toolUseId,
            (w) => ctx.log?.warn?.(w),
          )
          if (!ranges.length) {
            return { ok: false, error: { message: 'compress 参数无法解析出有效范围', code: 'NO_RANGES' } }
          }
          const applied = engine.applyCompression({
            ranges: ranges.map((r) => ({
              startRef: r.startRef,
              endRef: r.endRef,
              summary: r.summary,
              topic: r.topic,
              compressCallId: r.compressCallId,
            })),
            messages: sctx.lastCores,
            state: sctx.state,
            config,
          })
          sctx.state = applied.state
          // 压缩改变了块结构/历史 → 强制下一轮全量重建，失效增量缓存
          sctx.needFull = true

          // ---- 遥测：compress 事件（模型主动调用时） ----
          const telem = sctx.telemetry ?? createTelemetryWriter(undefined)
          try {
            const ev = buildCompressEvent({
              sessionId: ctx.sessionId,
              round: sctx.round ?? 0,
              window: config.modelContextLimit,
              state: applied.state,
              result: applied.result,
              ranges: ranges.map((r) => ({ topic: r.topic, chars: 0 })),
            })
            telem.write(ev)
          } catch {
            // 遥测失败不影响主流程
          }

          return {
            ok: true,
            output: {
              blocksCreated: applied.result.blocksCreated,
              tokensCompressed: applied.result.tokensCompressed,
              errors: applied.result.errors,
              warnings: applied.result.warnings,
            },
          }
        },
      })
    : undefined

  const decompressTool = want('decompress')
    ? defineTool<DecompressInput, DecompressOutput>({
        id: 'decompress',
        description: '按 blockId 查看某个已压缩上下文块的摘要，可了解被压缩掉的内容梗概。',
        inputSchema: withJsonSchema(makeSchema<DecompressInput>(), {
          type: 'object',
          properties: {
            blockId: { type: 'string', description: '要展开的压缩块 id' },
            toFile: { type: 'boolean', description: '是否落盘为文件（大块时避免撑爆上下文）' },
            full: { type: 'boolean', description: '是否展开全部原文（默认折叠视图）' },
          },
          required: ['blockId'],
          additionalProperties: false,
        }),
        isConcurrencySafe: () => false,
        isReadOnly: () => true,
        async call(input, ctx): Promise<ToolResult<DecompressOutput>> {
          const sctx = sessions.get(ctx.sessionId)
          if (!sctx) {
            return { ok: false, error: { message: '当前会话尚无 ACP 上下文', code: 'NO_CTX' } }
          }
          const block = engine.decompress(input.blockId, sctx.state)
          if (!block) {
            return { ok: false, error: { message: `未找到压缩块: ${input.blockId}`, code: 'NOT_FOUND' } }
          }
          const originalMessages = restoreBlockMessages(
            engine,
            sctx.state,
            sctx.archive,
            block.blockId,
          )
          const span = blockSpan(originalMessages)
          return {
            ok: true,
            output: {
              blockId: block.blockId,
              topic: block.topic,
              summary: block.summary,
              tokensCompressed: block.compressedTokens,
              active: block.active,
              tier: block.tier,
              effectiveMessages: block.effectiveMessageIds,
              startId: span.startId,
              endId: span.endId,
              originalMessages,
            },
          }
        },
      })
    : undefined

  const searchTool = want('search_context')
    ? defineTool<SearchInput, SearchOutput>({
        id: 'search_context',
        description: '按 query 对已压缩的历史上下文块做相关性检索，找到对话主题对应的摘要。',
        inputSchema: withJsonSchema(makeSchema<SearchInput>(), {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词（在已压缩块中查找）' },
            limit: { type: 'number', description: '最大返回条数' },
          },
          required: ['query'],
          additionalProperties: false,
        }),
        isConcurrencySafe: () => false,
        isReadOnly: () => true,
        async call(input, ctx): Promise<ToolResult<SearchOutput>> {
          const sctx = sessions.get(ctx.sessionId)
          if (!sctx) {
            return { ok: false, error: { message: '当前会话尚无 ACP 上下文', code: 'NO_CTX' } }
          }
          const blocks = engine.search(input.query, sctx.state)
          const limit = Math.max(0, input.limit ?? 5)
          const results: SearchResult[] = blocks.slice(0, limit).map((b) => {
            const span = coveredSpan(sctx.state, sctx.archive, b)
            return {
              blockId: b.blockId,
              topic: b.topic,
              summary: b.summary,
              score: 0, // kernel 不返回数值分，展示顺序即相关序
              startId: span.startId,
              endId: span.endId,
            }
          })
          return { ok: true, output: { query: input.query, limit, results } }
        },
      })
    : undefined

  const statusTool = want('acp_status')
    ? defineTool<AcpStatusInput, AcpStatusOutput>({
        id: 'acp_status',
        description: '查看当前上下文压缩状态：上下文占用、已压缩块数、已回收 token 数。',
        inputSchema: withJsonSchema(makeSchema<AcpStatusInput>(), {
          type: 'object',
          properties: {},
          additionalProperties: false,
        }),
        isConcurrencySafe: () => false,
        isReadOnly: () => true,
        async call(_input, ctx): Promise<ToolResult<AcpStatusOutput>> {
          const sctx = sessions.get(ctx.sessionId)
          if (!sctx) {
            return { ok: false, error: { message: '当前会话尚无 ACP 上下文', code: 'NO_CTX' } }
          }
          const tokenCount = estimateTokens(sctx.lastCores, countTokens)
          const rep = engine.status(sctx.state, tokenCount, config)
          return {
            ok: true,
            output: {
              contextUsage: rep.contextUsage,
              tokenCount: rep.tokenCount,
              modelContextLimit: rep.modelContextLimit,
              activeBlocks: rep.activeBlocks,
              totalBlocks: rep.totalBlocks,
              tokensCompressed: rep.tokensCompressed,
              breakdown: rep.breakdown,
            },
          }
        },
      })
    : undefined

  // 收集要注入的工具
  const tools = [compressTool, decompressTool, searchTool, statusTool].filter(
    (t): t is NonNullable<typeof t> => !!t,
  )

  /** 构造一条临时消息（用于注入 ACP 哲学 / nudge，不落入持久层） */
  function tempMessage(role: Message['role'], text: string, sessionId: string): Message {
    return {
      id: `acp_${role}_${sessionId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      role,
      parts: [{ type: 'text', text }],
      createdAt: Date.now(),
    }
  }

  return {
    id: 'context.acp',
    version: '0.1.0',
    name: 'ACP 上下文压缩',
    description: '模型驱动 3 层 LSM 上下文压缩（基于 acp-kernel）',
    async install(plgCtx) {
      plgCtx.log.info('ACP 上下文压缩插件已加载', {
        modelContextLimit,
        autoTune: options.autoTune === true,
        // autoTune 关闭时为 undefined，日志里不会出现该键
        autoTuneParams: options.autoTune ? describeAutoTune(modelContextLimit) : undefined,
        // token 折算口径：auto = CJK 感知（1 字≈1 token），chars4 = 旧口径
        tokenCalibration: options.tokenCalibration === 'chars4' ? 'chars4' : 'auto',
        preserveRecentTokens: config.preserveRecentTokens,
        growthFloor: config.nudge?.growthFloor,
        minCompressRange: config.compress?.minCompressRange,
      })

      return {
        async 'core.tool.pool.assemble'(_input, pool) {
          for (const t of tools) (pool as { add: (t: unknown) => void }).add(t)
        },

        async 'core.session.preModel'(input, rawMessages) {
          const messages = rawMessages as Message[]
          try {
            await runPreModel({
              sessionId: input.sessionId,
              messages,
              getCtx: () => getOrCreateCtx(input.sessionId),
              engine,
              config,
              countTokens,
              meta: input.meta,
              makeSystemPrompt,
              prompts: resolvedPrompts,
              ...(input.systemStability ? { systemStability: input.systemStability } : {}),
              tempMessage,
              manualInjection,
              explicitSystemPrompt,
              // 统一块模型：把每轮内部折叠（tier1/2/3）的 source:'acp' 块 push 给 host，
              // host 合并进 session.blocks，供视图/loader/reconstructHistory/revert 消费
              recordBlocks: (blocks) => {
                if (input.blocksPatch) input.blocksPatch.push(...blocks)
              },
            })
          } catch (err) {
            // 压缩是旁路优化：失败绝不阻断本轮模型请求
            plgCtx.log.warn?.('ACP preModel 处理失败，跳过本轮压缩', { err: String(err) })
          }
        },

        async 'core.session.compacting'(input, compactCtx) {
          try {
            await runCompacting({
              sessionId: input.sessionId,
              input: compactCtx,
              getCtx: () => getOrCreateCtx(input.sessionId),
              engine,
              config,
              meta: compactCtx.meta ?? {
                read: async () => undefined,
                patch: async () => {},
              },
            })
          } catch (err) {
            // 折叠失败不阻断 core 的默认 session 压缩
            plgCtx.log.warn?.('ACP core.session.compacting 处理失败，走默认压缩', { err: String(err) })
          }
        },

        /**
         * provider 侧缓存观测：把引擎广播的用量事实落成 `providerCache` 遥测行。
         *
         * 为什么挂这里而不是由 core 直接写：遥测按 sessionId 分文件、路径由本插件管理，
         * core 不该反向依赖 ACP。此前 `buildProviderCacheEvent` 的注释写着"由 core 层追加"，
         * 但全仓没有调用方 ⇒ provider 侧缓存命中**一直没有数据**，于是"按需注入会不会影响
         * 缓存命中"这类问题无从验证（这正是这次改造要能回答的问题）。
         *
         * 失败不影响对话：用量已写进 assistant 消息，这里只是旁路观测。
         */
        'core.llm.usage'(signal) {
          try {
            const sctx = sessions.get(signal.sessionId)
            if (!sctx) return
            const ev = buildProviderCacheEvent({
              sessionId: signal.sessionId,
              round: sctx.round ?? 0,
              cacheRead: signal.cacheRead,
              cacheWrite: signal.cacheWrite,
              requestTok: sctx.lastTokens,
              // 回退归因三件套：上一行（算降幅/空闲）、本轮前缀差异（算"是不是我们改坏的前缀"）、
              // provider 实际输入（算本地口径偏差）
              prev: sctx.lastCacheRow,
              prefix: sctx.lastPrefixDiff,
              systemChangedParts: sctx.lastSystemStability?.changedParts ?? null,
              systemChangedDetail: sctx.lastSystemStability?.details ?? null,
              providerInput: signal.input,
              // 分母用引擎给的**整包**估算（含 system + 工具），不是 requestTok —— 后者只算历史
              localInputEstimate: signal.localInputEstimate,
            })
            if (!ev) return
            // 与 preModel 同一套 writer（可能为 no-op：未配遥测路径时）
            const telem = sctx.telemetry ?? createTelemetryWriter(undefined)
            telem.write(ev)
            // 记下本行，供下一轮判断降幅与空闲时长
            sctx.lastCacheRow = { ts: ev.ts, cacheRead: ev.cacheRead }
          } catch (err) {
            plgCtx.log.warn?.('ACP providerCache 遥测写入失败（忽略）', { err: String(err) })
          }
        },
      } as Hooks
    },

    async uninstall() {
      // 退出前 flush 所有 writer。
      //
      // 写入器有 500ms debounce，其 `flush()` 的注释明确写着"正常退出 / 信号兜底时调用"——
      // 但此前 uninstall() 只 clear 了 Map，**没有任何调用方**去 flush（同类"只有定义没有调用方"
      // 的缺陷本项目已撞过多次）。日志/遥测"最后一拍丢失"极难察觉，属于典型的静默数据缺失，
      // 因此这里补上：最后一个 query 结束后立刻退出的路径（脚本化 `run`、探针）不再依赖
      // "恰好活过 500ms 的定时器"。
      //
      // 说明：**并未**观测到真实的丢行事故 —— 三次真机取证里 `providerCache` 行数都与
      // `usageStats.llmCalls` 精确相等（4/4、5/5、4/4）。这里修的是"没有调用方"的结构性缺口。
      for (const sctx of sessions.values()) {
        try {
          sctx.telemetry?.flush()
        } catch {
          /* 遥测 flush 失败不阻塞卸载 */
        }
      }
      sessions.clear()
    },
  }
}

// ========================================================================
// 每轮处理（可单测的纯函数核心）
// ========================================================================

interface RunPreModelDeps {
  sessionId: string
  messages: Message[]
  getCtx: () => AcpSessionCtx
  engine: ReturnType<typeof createCore>
  config: AcpConfig
  /**
   * token 折算口径；**必须与 engine 注入的同一函数**，否则占用率闸门与内核内部计数会分裂。
   * 缺省 = 内核 CJK 感知口径（`defaultCountTokens`）。
   */
  countTokens?: TokenCountFn
  /** session.meta 持久化访问器（用于保存/恢复压缩状态） */
  meta: { read: () => Promise<Record<string, unknown> | undefined>; patch: (patch: Record<string, unknown>) => Promise<void> }
  makeSystemPrompt: () => string
  /**
   * 压缩手册注入策略（默认 `'on-demand'`）。`'always'` 走旧行为每轮注入完整手册；
   * `'on-demand'` 仅在占用率接近压缩阈值时注入完整手册，否则只注入极简提示。
   */
  manualInjection?: 'on-demand' | 'always'
  /**
   * 用户是否显式赋值了 `systemPrompt`。为真时无论 manualInjection 与占用率如何都注入完整手册
   * （用户显式要求，不受阈值影响，也不会退化成极简提示）。
   */
  explicitSystemPrompt?: boolean
  /** 解析后的提示词 policy（nudge 渲染与本轮压缩系统提示保持一致）；缺省走内核默认 */
  prompts?: Prompts
  /** 引擎给出的系统区段级归因（仅变化时有值）；用于把 system-changed 点名到段 */
  systemStability?: SystemStabilityReport
  tempMessage: (role: Message['role'], text: string, sessionId: string) => Message
  /** 遥测 JSONL 文件路径（可选，未注入则遥测 writer 为 no-op） */
  telemetryPath?: string
  /**
   * 把本轮内部折叠的压缩块（统一块模型）回传给 host，供其合并进 session.blocks。
   * 缺省则仅落在 ACP 自身状态，不进统一块模型（测试/无 host blocksPatch 时）。
   */
  recordBlocks?: (blocks: {
    id: string
    topic?: string
    summary: string
    startId: string
    endId: string
    source: 'acp'
    archiveRef: string
  }[]) => void
}

/**
 * 每轮进入模型前：从 meta 水合压缩状态 → 压平历史 → processTurn（指派 refs /
 * 分层压缩 / nudge）→ 保留原始消息归档 + 持久化状态 → 重建本轮请求
 * （系统 + ACP 哲学 + 历史 + nudge）。
 *
 * 设计取舍：会话历史保留全文（原始消息持久化在 session 本体，decompress 可完整还原），
 * 压缩只作用于"本轮发给模型的请求"；压缩状态单独持久化到 session.meta，重启后可恢复，
 * 从而既有请求级 token 节省，又保证可回溯。
 */
export async function runPreModel(deps: RunPreModelDeps): Promise<void> {
  const { sessionId, messages, engine, config, meta } = deps
  // token 折算口径：必须与 engine（createCore）注入的一致，缺省即内核 CJK 感知口径
  const countTokens = deps.countTokens ?? defaultCountTokens
  const ctx = deps.getCtx()

  // 遥测 writer 懒初始化：宿主注入 telemetryPath 时替换掉 no-op writer
  if (deps.telemetryPath) ctx.telemetry = createTelemetryWriter(deps.telemetryPath)

  // 引擎侧的系统区段级归因落进本轮 ctx，供随后的 providerCache 行点名"第 N 段变了"。
  // 每轮显式覆盖（含置空）：它是"本轮 vs 上一轮"的结论，上一轮的值留在这里会误报。
  ctx.lastSystemStability = deps.systemStability

  // 从 session.meta 水合压缩状态（仅首次）；水合后置 needFull，强制全量重建一次
  if (!ctx.hydrated) {
    ctx.hydrated = true
    try {
      const saved = (await meta.read())?.[ACP_META_KEY] as CompressionState | undefined
      if (saved && typeof saved === 'object') {
        // 嵌套键二级合并（而非浅展开）：内核升级会给 NudgeState/CompressionStats 等
        // 嵌套对象加新字段（如 nudge.lastShownByTier），浅展开会让旧存档**整体替换**新默认
        // ⇒ 水合后新字段缺失、相关功能静默失效。数组（blocks/absorbed）与标量整体取存档。
        const fresh = createInitialState()
        const s = saved as Partial<CompressionState>
        ctx.state = {
          ...fresh,
          ...s,
          messageRefs: { ...fresh.messageRefs, ...(s.messageRefs ?? {}) },
          tokenSnapshot: { ...fresh.tokenSnapshot, ...(s.tokenSnapshot ?? {}) },
          nudge: { ...fresh.nudge, ...(s.nudge ?? {}) },
          stats: { ...fresh.stats, ...(s.stats ?? {}) },
        }
        ctx.stateSnapshot = JSON.stringify(ctx.state)
      }
    } catch {
      // 水合失败则从空状态开始
    }
    ctx.needFull = true
  }

  // 拆分系统消息与历史
  const systemMsgs: Message[] = []
  const history: Message[] = []
  for (const m of messages) {
    if (m.role === 'system') systemMsgs.push(m)
    else history.push(m)
  }

  // 压平为 core（同时记录原始消息归档，供 decompress 还原全文），运行 processTurn
  const inflat = toCores(history)
  // 归档 = 本轮历史原文 ++ 跨session压缩折叠窗口持久化的原文（后者跨重启后可回溯）
  ctx.archive = new Map(inflat.byId)
  ctx.archivedKeys ??= new Set()
  try {
    const archived = (await meta.read())?.[ACP_ARCHIVE_KEY] as Record<string, Message> | undefined
    if (archived && typeof archived === 'object') {
      for (const [coreId, orig] of Object.entries(archived)) {
        if (orig && typeof orig === 'object') {
          if (!ctx.archive.has(coreId)) ctx.archive.set(coreId, orig as Message)
          // 记录已持久化的挡住键，后续幂等合并不再重复写入
          ctx.archivedKeys.add(coreId)
        }
      }
    }
  } catch {
    // 读取失败不影响主流程
  }
  const tokenCount = estimateTokens(inflat.cores, countTokens)
  const res = engine.processTurn({
    messages: inflat.cores,
    state: ctx.state,
    config,
    tokenCount,
    // renderTags 取舍（compress.d.ts：'all' 默认 / 'text-only' / 'none'）：
    // 选 'text-only' —— ref 标签只注入 user/assistant 文本，工具参数与结果保持原样
    // （工具输出常被粘贴/复制，混入 <acp> 标签会污染其内容语义）。
    // 代价：模型看不到工具结果的 ref，compress 范围若需精确落在工具结果边界上，
    // 只能用相邻文本消息的 ref 近似表达。若未来出现"必须精确压缩某段工具输出"的
    // 场景，再评估切到 'all'（标签只存在于渲染层，不进会话本体与 archive）。
    renderTags: 'text-only',
  })

  // 就地更新会话上下文（ctx 是 Map 里的对象引用）
  ctx.state = res.state
  ctx.lastCores = res.messages

  // ---- 遥测：preModel 事件（每轮必记） ----
  ctx.round = (ctx.round ?? 0) + 1
  const telem = ctx.telemetry ?? createTelemetryWriter(undefined)
  try {
    const ev = buildPreModelEvent({
      sessionId,
      round: ctx.round,
      config,
      state: res.state,
      prevRequestCores: ctx.prevRequestCores,
      inflatCores: inflat.cores,
      requestCores: res.messages,
      nudge: res.nudge,
      countTokens,
    })
    telem.write(ev)
    ctx.prevRequestCores = res.messages
  } catch {
    // 遥测失败不影响主流程
  }

  // 持久化压缩状态（仅变化时写一次，避免每轮无谓 IO）
  const nextSnapshot = JSON.stringify(res.state)
  if (ctx.stateSnapshot !== nextSnapshot) {
    ctx.stateSnapshot = nextSnapshot
    try {
      await meta.patch({ [ACP_META_KEY]: res.state })
    } catch {
      // 持久化失败不致命，内存态仍可用
    }
  }

  // ---- 折叠轮持久化原文到 ACP_ARCHIVE_KEY ----
  // 断点索引回读原文容器：把当前所有块（含 processTurn 紧急折叠、上轮 compress 工具折叠）
  // 所覆盖的原文消息，若尚不在容器的"已持久化键"集合（archivedKeys）中，则合并写入
  // session.meta[ACP_ARCHIVE_KEY]。跨重启后即便会话本体已物理删除窗口，decompress /
  // search_context / loader 仍能按断点索引 [startId,endId] 从该容器还原完整原文。
  const dirty = new Set<string>()
  {
    const covered = new Set<string>()
    for (const b of res.state.blocks) collectCoveredIds(res.state, b, covered)
    for (const idOrRef of covered) {
      if (ctx.archivedKeys.has(idOrRef)) continue
      let orig = ctx.archive.get(idOrRef)
      if (!orig) {
        const raw = res.state.messageRefs?.byRef?.[idOrRef]
        orig = raw ? ctx.archive.get(raw) : undefined
      }
      if (orig && typeof orig === 'object') {
        dirty.add(idOrRef)
        // 记录本次新增的挡 key，避免重复扫描 meta
        ctx.archivedKeys.add(idOrRef)
      }
    }
  }
  if (dirty.size > 0) {
    let archiveObj: Record<string, unknown> = {}
    try {
      const prev = (await meta.read())?.[ACP_ARCHIVE_KEY]
      if (prev && typeof prev === 'object') archiveObj = { ...archiveObj, ...(prev as object) }
    } catch {
      // 读写失败不影响主流程
    }
    for (const coreId of dirty) {
      const orig = ctx.archive.get(coreId)
      if (orig && typeof orig === 'object') archiveObj[coreId] = orig
      else {
        const raw = res.state.messageRefs?.byRef?.[coreId]
        const resolved = raw ? ctx.archive.get(raw) : undefined
        if (resolved && typeof resolved === 'object') archiveObj[coreId] = resolved
      }
    }
    try {
      await meta.patch({ [ACP_ARCHIVE_KEY]: archiveObj })
    } catch {
      // 持久化失败不致命，内存态仍可用
    }
  }

  // ---- 同步内部折叠块到 session.blocks（统一块模型） ----
  // ACP 每轮内部折叠（tier1/2/3）的块经 recordBlocks 回传给 host 合并进 session.blocks，
  // 使全历史重建/revert 也覆盖 ACP 内部折叠（不再只覆盖 core.session.compacting 折叠窗口）。
  // 幂等：以 recordedBlockIds 记录已回传的块，避免每轮重复写；跨重启后该集合为空，
  // 首轮会把既有块重新回传（session.blocks 按 id 去重覆盖，安全幂等）。
  if (deps.recordBlocks) {
    ctx.recordedBlockIds ??= new Set()
    const missing = res.state.blocks.filter((b) => !ctx.recordedBlockIds.has(b.blockId))
    if (missing.length > 0) {
      const blocks = missing.map((b) => {
        const span = coveredSpan(res.state, ctx.archive, b)
        return {
          id: `acp_${b.blockId}`,
          topic: b.topic ?? 'ACP 折叠',
          summary: b.summary,
          startId: span.startId,
          endId: span.endId,
          source: 'acp' as const,
          archiveRef: `${acpRefPrefix(sessionId)}:${b.blockId}`,
        }
      })
      for (const b of missing) ctx.recordedBlockIds.add(b.blockId)
      deps.recordBlocks(blocks)
    }
  }

  // ---- 增量渲染缓存 ----
  // 常态投影路径：若历史前缀与缓存一致、本轮无压缩/截断（res.messages 与输入 cores 等长，
  // 即没有块插入或紧急剔除），则复用缓存的"已渲染前缀"，只对新增尾部 core 做 requestMessages。
  // 全量路径：压缩发生（needFull）、历史前缀漂移、或 res.messages 数量变化（截断）时，全量重建并刷新缓存。
  // 本轮发生压缩/截断（消息数变化）时，历史本体已被改写，缓存前缀不再可信 → 强制下一轮全量。
  if (res.messages.length !== inflat.cores.length) {
    ctx.needFull = true
  }
  let cacheHit = false
  let prefixCoreCount = 0
  if (
    !ctx.needFull &&
    ctx.prefixIds.length > 0 &&
    ctx.prefixIds.length <= history.length &&
    res.messages.length === inflat.cores.length
  ) {
    // 校验历史前缀逐 id 相等（无插入/删除，仅尾部追加）
    let aligned = true
    for (let i = 0; i < ctx.prefixIds.length; i++) {
      if (ctx.prefixIds[i] !== history[i]!.id) {
        aligned = false
        break
      }
    }
    if (aligned) {
      // 前缀对应的 core 数量 = 前 prefixLen 条原始消息展开出的 core 数
      prefixCoreCount = 0
      for (let i = 0; i < ctx.prefixIds.length; i++) {
        prefixCoreCount += (inflat.byBase.get(baseId(history[i]!.id)) ?? []).length
      }
      cacheHit = prefixCoreCount <= res.messages.length
    }
  }

  const request: Message[] = [...systemMsgs]

  // ---- 压缩手册：常量在前缀、变量在尾部 ----
  // 占用率口径与遥测一致：telemetry 的 occupancy = requestTok / window，其中 requestTok =
  // estimateTokens(res.messages)（发往模型的 history cores，不含 system）、window = config.modelContextLimit。
  // 这里用同一公式（estimateTokens(res.messages, countTokens) / modelContextLimit）在注入点之前算一次，
  // 不在两处写分叉的两份算法。
  //
  // 前缀只放**恒定**文本：自动前缀缓存按最长公共 token 前缀命中，放在历史之前的文本一变，
  // 其后全部内容（含整段历史）都要重算（代价量化见 MANUAL_INJECT_MARGIN 的注释）。
  // 会变的完整手册一律挪到**尾部**（与 nudge 同位置），见下方 tailParts。
  const occupancy = estimateTokens(res.messages, countTokens) / Math.max(1, deps.config.modelContextLimit)
  const manualThreshold = (deps.config.nudge?.minContextLimitPct ?? 0.35) * MANUAL_INJECT_MARGIN
  const prefixText =
    deps.explicitSystemPrompt === true || deps.manualInjection === 'always'
      ? deps.makeSystemPrompt() // 宿主显式配置 / 对照臂：恒定，无翻转风险
      : COMPRESS_MANUAL_HINT // 默认档：恒定的一行提示
  request.push(deps.tempMessage('system', prefixText, sessionId))

  if (cacheHit) {
    // 增量：复用缓存前缀 + 只渲染新增尾部 core，并把尾部并入缓存供下一轮继续命中
    const tailCores = res.messages.slice(prefixCoreCount)
    const tailRender = requestMessages(tailCores)
    request.push(...ctx.prefixRender)
    request.push(...tailRender)
    ctx.prefixIds = history.map((m) => m.id)
    ctx.prefixRender = [...ctx.prefixRender, ...tailRender]
    ctx.lastTokens = tokenCount
  } else {
    // 全量：重建整段渲染结果并刷新缓存
    const rendered = requestMessages(res.messages)
    request.push(...rendered)
    ctx.prefixIds = history.map((m) => m.id)
    ctx.prefixRender = rendered
    ctx.lastTokens = tokenCount
    ctx.needFull = false
  }

  // 尾部注入：nudge 与（按需的）完整手册合并成**同一条** user 消息（不推两条相邻临时消息 ——
  // 那只会多一处尾部差异，没有收益）。
  //
  // ⚠️ 必须用 `user` role，不能用 `system`：provider-anthropic 的 extractSystemPrompt 与
  // provider-gemini 的 extractSystem 会把**任意位置**的 system 消息上提进顶层
  // system / systemInstruction 字段（原位置直接 continue 跳过），用 system role 挪到尾部
  // 等于没挪 —— 它会回到前缀，本方案的收益归零。只有 OpenAI 保持原序，不能指望它。
  const nudge = res.nudge
  const needTailManual =
    deps.explicitSystemPrompt !== true &&
    deps.manualInjection !== 'always' &&
    occupancy >= manualThreshold
  const tailParts = [
    nudge?.shouldInject ? renderNudgeText(nudge, deps.prompts).text : '',
    needTailManual ? deps.makeSystemPrompt() : '',
  ].filter(Boolean)
  if (tailParts.length > 0) {
    request.push(deps.tempMessage('user', tailParts.join('\n\n'), sessionId))
  }

  // 原地替换待发消息
  messages.length = 0
  messages.push(...request)

  // ---- 前缀缓存回退归因：把**这一轮真正要发出去**的 prompt 记下来与上轮比对 ----
  //
  // 为什么在这里（而不是更早）：`messages` 直到这一行才是最终待发内容；系统区、HINT、
  // 渲染后的历史、尾部 nudge 全在里面。早一步算的都是"未完成的 prompt"，结论不可信。
  //
  // 为什么用全文投影而不是 core 的 id：ACP 复用 `prefixRender` 时会刻意让早前消息的**字节**
  // 保持不变；只看 id 无法发现"内容被就地改写"，而那是本项目最可能的失效源。
  try {
    // 尾部动态块（nudge / 压缩手册）是 ACP **每轮现拼**的，不属于缓存前缀，必须先从归因视野里剔除：
    // 历史每增长一条，上一轮的尾部块就会在逐条比对中与「新历史的第一条」相撞（上轮 tail 在
    // 位置 n-1，本轮历史占了 n-1），于是把「追加 + 尾部右移」误判成 `mutated`（中段被就地改写）
    // —— 实测复现（prev=5 条时 stable 停在 4、changedKind=mutated）。真实代价只是尾部那一条重算，
    // 与 `appended` 同级；报 `prefix-mutated` 会把排查方向引向"谁改写了历史中段"。
    // 两轮各自剔除自己的尾部块，比对就落在纯历史前缀上（本轮未追加 tail 时视野不变）。
    const stableView = tailParts.length > 0 ? request.slice(0, -1) : request
    const view = stableView.map((m) => ({ role: m.role ?? '', text: partsSignature(m) }))
    ctx.lastPrefixDiff = diffPromptPrefix(ctx.prevPromptView, view)
    ctx.prevPromptView = view
  } catch {
    // 诊断失败不影响本轮请求
    ctx.lastPrefixDiff = undefined
  }
}

/** 把一条消息的全部 part 折叠成一个可比较的字符串（用于前缀指纹；不看 id） */
function partsSignature(m: Message): string {
  const parts = (m.parts ?? []) as Array<Record<string, unknown>>
  let out = ''
  for (const p of parts) {
    out += `${String(p.type ?? '')}\u0001`
    // 逐 part 取"有内容意义"的字段；时间戳/id 这类每轮必变的字段一律不取
    if (typeof p.text === 'string') out += p.text
    if (p.input !== undefined) out += JSON.stringify(p.input)
    if (p.result !== undefined) out += JSON.stringify(p.result)
    if (p.toolId !== undefined) out += String(p.toolId)
    out += '\u0002'
  }
  return out
}

/** 默认导出常量插件（默认配置） */
export const acpContextPlugin: AgentPlugin = createAcpContextPlugin()

/**
 * core.session.compacting hook 的处理核心（可单测纯函数）。
 *
 * 目标：在 core 物理删除历史窗口前，让 ACP 先把这个窗口折叠进自己的压缩块，
 * 从而即使原文被 session 压缩从会话历史删掉，ACP 的块/摘要仍保留该段的梗概，
 * decompress / search_context 依旧能对这段内容起作用。
 *
 * 策略（幂等）：
 * 1. 先水合压缩状态（若未水合）。
 * 2. 仅处理"尚未被 ACP 块覆盖"的窗口消息（复用 coveredMessageIds 判定，已覆盖即跳过 → 幂等）。
 * 3. 对未覆盖消息指派 refs，并整体折叠成一个摘要块（规则摘要兜底，随时可换成模型摘要）。
 * 4. 持久化状态到 session.meta；同时提供 summary 以让 core 复用、避免双份摘要。
 *
 * @returns Promise<boolean> 是否发生了折叠（true = 已处理并豁免 core 自行摘要）
 */
export async function runCompacting(deps: {
  sessionId: string
  input: CompactionContext
  getCtx: () => AcpSessionCtx
  engine: ReturnType<typeof createCore>
  config: AcpConfig
  meta: {
    read: () => Promise<Record<string, unknown> | undefined>
    patch: (patch: Record<string, unknown>) => Promise<void>
  }
  /** 为一段窗口生成规则摘要；缺省用首/尾文本拼接兜底 */
  ruleSummary?: (window: Message[]) => string
}): Promise<boolean> {
  const { sessionId, input, engine, config, meta } = deps
  const window = (input.window ?? []) as Message[]
  if (window.length === 0) return false
  const ctx = deps.getCtx()

  // 尚未水合则先恢复压缩状态（session 压缩可能在首轮 preModel 之前进入）
  if (!ctx.hydrated) {
    ctx.hydrated = true
    ctx.archivedKeys ??= new Set()
    try {
      const saved = (await meta.read())?.[ACP_META_KEY] as CompressionState | undefined
      if (saved && typeof saved === 'object') {
        ctx.state = { ...createInitialState(), ...saved }
        ctx.stateSnapshot = JSON.stringify(ctx.state)
      }
      // 恢复"被 session 压缩折叠窗口"的原文归档，保证跨重启仍可解压回溯
      const archived = (await meta.read())?.[ACP_ARCHIVE_KEY] as
        | Record<string, Message>
        | undefined
      if (archived && typeof archived === 'object') {
        for (const [coreId, orig] of Object.entries(archived)) {
          if (orig && typeof orig === 'object') {
            ctx.archive.set(coreId, orig as Message)
            ctx.archivedKeys.add(coreId)
          }
        }
      }
    } catch {
      // 水合失败则从空状态开始
    }
  }

  // 幂等：先把窗口整体压平成 core，若其核心 id 已全部被 ACP 块覆盖，则已保全、无需再折叠
  const inflat = toCores(window)
  if (inflat.cores.length === 0) return false

  const covered = coveredMessageIds(ctx.state)
  const uncoveredCores = inflat.cores.filter((c) => !covered.has(c.id))
  if (uncoveredCores.length === 0) {
    // 整个窗口都已被 ACP 压缩块覆盖 → 已保全，无需再折叠
    input.windowHandled = true
    return false
  }
  // 只用"尚未覆盖"的片段折叠（避免与既有块重叠重复）
  const uncoveredFlat: import('./adapter.js').Flat = { cores: uncoveredCores, byId: inflat.byId, byBase: inflat.byBase }

  // 保留窗口原文到归档，保证折叠后 decompress 仍能还原该段全文
  for (const [coreId, orig] of inflat.byId) ctx.archive.set(coreId, orig)

  // 指派 refs（基于既有 map 继续增长），再对整段折叠成一个摘要块
  const nextIndex = highestUsedIndex(ctx.state.messageRefs) + 1
  const { map } = assignRefs(uncoveredCores, {
    existing: ctx.state.messageRefs,
    nextIndex,
  })
  const startRef = refForRaw(map, uncoveredCores[0]!.id)
  const endRef = refForRaw(map, uncoveredCores[uncoveredCores.length - 1]!.id)
  if (!startRef || !endRef) return false

  const summary = deps.ruleSummary
    ? deps.ruleSummary(window)
    : defaultRuleSummary(window)
  const applied = engine.applyCompression({
    ranges: [{ startRef, endRef, summary, topic: 'session 压缩折叠' }],
    messages: uncoveredFlat.cores,
    state: { ...ctx.state, messageRefs: map },
    config,
  })
  if (applied.result.blocksCreated === 0 && !input.summary) return false
  ctx.state = applied.state
  ctx.needFull = true

  // 持久化压缩状态（避免覆盖窗口后续仍可回溯）
  const nextSnapshot = JSON.stringify(ctx.state)
  if (ctx.stateSnapshot !== nextSnapshot) {
    ctx.stateSnapshot = nextSnapshot
    await meta.patch({ [ACP_META_KEY]: ctx.state })
  }
  // 持久化被折叠窗口的原文归档：core 物理删除窗口后，跨重启仍可从 meta 还原全文。
  // 只合并"窗口内"的原文（其 original 在 inflat.byId），避免 meta 冗余累积本轮新消息。
  const archiveObj: Record<string, unknown> = {}
  try {
    const prev = (await meta.read())?.[ACP_ARCHIVE_KEY]
    if (prev && typeof prev === 'object') Object.assign(archiveObj, prev)
  } catch {
    // 读旧归档失败则从空开始
  }
  for (const [coreId, orig] of inflat.byId) {
    if (typeof orig === 'object' && orig != null) archiveObj[coreId] = orig
  }
  await meta.patch({ [ACP_ARCHIVE_KEY]: archiveObj })

  // 已把窗口折叠进 ACP 块：让 core 复用它生成的摘要，避免双份摘要
  input.summary = summary
  input.windowHandled = true

  // 统一块模型：把 ACP 折叠块回传 core，追加进 session.blocks（source:'acp'），
  // 使 ACP 折叠与通用 compact 块一致，供视图/loader/reconstructHistory/revert 消费。
  const startId =
    inflat.byId.get(uncoveredCores[0]!.id)?.id ?? uncoveredCores[0]!.id
  const endId =
    inflat.byId.get(uncoveredCores[uncoveredCores.length - 1]!.id)?.id ??
    uncoveredCores[uncoveredCores.length - 1]!.id
  const acpBlockId = `acp_b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  input.blocksPatch = [
    {
      id: acpBlockId,
      topic: 'ACP 折叠',
      summary,
      startId,
      endId,
      source: 'acp',
      // 原文取回引用：宿主层经 session.meta[ACP_ARCHIVE_KEY] 按 [startId,endId] 还原该段全文
      archiveRef: `${acpRefPrefix(sessionId)}:${acpBlockId}`,
    },
  ]
  void sessionId
  return true
}

/** ACP 原文取回引用的前缀（`acp:{sessionId}`），宿主 loader 据此解析归档 */
function acpRefPrefix(sessionId: string): string {
  return `acp:${sessionId}`
}

/** 窗口规则摘要兜底：首/尾消息文本拼接，控制在合理长度 */
export function defaultRuleSummary(window: Message[]): string {
  const head = textOf(window[0])
  const tail = window.length > 1 ? textOf(window[window.length - 1]) : undefined
  const joined = [head, tail ? `…\n${tail}` : ''].join('\n')
  return joined.length > 2000 ? `${joined.slice(0, 2000)}…` : joined
}

function textOf(m?: Message): string {
  if (!m) return ''
  return (m.parts as Array<{ type?: string; text?: string; input?: unknown; result?: unknown }>)
    .map((p) => {
      if (p.type === 'tool') return safeString(p.result ?? p.input)
      return p.text ?? ''
    })
    .filter((t) => typeof t === 'string')
    .join('\n')
}

/**
 * 递归收集一个压缩块"完整覆盖"的原始消息 id / ref（含 tier2/3 嵌套子块）。
 *
 * 断点索引回读原文的语义：不仅要还原该块直接压缩的消息，还要连同它直接嵌套的
 * 子块（directBlockIds，即 tier 分层折叠出的更深层块）所覆盖的消息一起收集，
 * 保证跨重启后 decompress / search_context 能回读"原文容器"取回完整的原始会话。
 *
 * @param out 收集到的消息 id / ref 集合（写入 out，允许复用现有 Set）
 */
export function collectCoveredIds(
  state: CompressionState,
  block: CompressionBlock,
  out: Set<string>,
): void {
  for (const id of block.effectiveMessageIds) out.add(id)
  for (const id of block.directMessageIds) out.add(id)
  for (const childId of block.directBlockIds) {
    const child = state.blocks.find((b) => b.blockId === childId)
    if (child) collectCoveredIds(state, child, out)
  }
}

/**
 * 从 decode 出的 originalMessages 计算断点索引线 span（起止原始消息 id）。
 * 断点索引回读原文容器的定位依据：宿主可按 [startId, endId] 从归档切片还原。
 */
export function blockSpan(
  originalMessages: DecompressOutput['originalMessages'],
): { startId: string; endId: string } {
  const first = originalMessages[0]
  const last = originalMessages[originalMessages.length - 1]
  return {
    startId: first?.id ?? '',
    endId: originalMessages.length > 1 ? last?.id ?? '' : '',
  }
}

/**
 * 仅依据状态 + 归档轻量计算一个块的断点 span（不渲染原文全文），用于 search_context 等
 * 需要附带索引、但不必取回全部原文的场景。
 */
export function coveredSpan(
  state: CompressionState,
  archive: Map<string, Message>,
  block: CompressionBlock,
): { startId: string; endId: string } {
  const covered = new Set<string>()
  collectCoveredIds(state, block, covered)
  const ids: string[] = []
  for (const idOrRef of covered) {
    let orig = archive.get(idOrRef)
    if (!orig) {
      const raw = state.messageRefs?.byRef?.[idOrRef]
      orig = raw ? archive.get(raw) : undefined
    }
    if (orig && typeof orig === 'object') ids.push(orig.id)
  }
  return { startId: ids[0] ?? '', endId: ids.length > 1 ? ids[ids.length - 1] ?? '' : '' }
}

/**
 * 还原一个压缩块所覆盖的原始消息全文（供 decompress）。
 * 通过状态里的"ref → core id → 归档 Message"反解；先试直接 id，再走 byRef。
 * 采用断点索引回读：递归收集 directBlockIds 覆盖的全部嵌套子块消息 id，保证
 * tier2/3 分层折叠的完整原文都能从归档容器（ACP_ARCHIVE_KEY 水合出的 archive）取回。
 */
export function restoreBlockMessages(
  engine: ReturnType<typeof createCore>,
  state: CompressionState,
  archive: Map<string, Message>,
  blockId: string,
): DecompressOutput['originalMessages'] {
  const block = engine.decompress(blockId, state)
  if (!block) return []

  const covered = new Set<string>()
  collectCoveredIds(state, block, covered)

  const out: DecompressOutput['originalMessages'] = []
  const seen = new Set<string>()
  for (const idOrRef of covered) {
    if (seen.has(idOrRef)) continue
    seen.add(idOrRef)
    let orig = archive.get(idOrRef)
    if (!orig) {
      const raw = state.messageRefs?.byRef?.[idOrRef]
      orig = raw ? archive.get(raw) : undefined
    }
    if (!orig) continue
    const text = (orig.parts as Array<{ type?: string; text?: string; input?: unknown; result?: unknown }>)
      .map((p) => {
        if (p.type === 'tool') return safeString(p.result ?? p.input)
        return p.text ?? ''
      })
      .filter((t) => typeof t === 'string')
      .join('\n')
    out.push({ id: orig.id, role: orig.role, text })
  }
  return out
}