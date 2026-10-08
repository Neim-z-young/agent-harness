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

import { defineTool, ToolResult, ToolContext, fromJsonSchema } from '@harness/tool'
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
  type CompressibleRange,
  type ProcessTurnResult,
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
import {
  decideWindowGuardAction,
  formatWindowGuardNotice,
  formatWindowGuardRefusal,
  resolveWindowGuard,
  WindowGuardExceededError,
  type ResolvedWindowGuard,
  type WindowGuardConfig,
} from './window-guard.js'
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
/**
 * session.meta 中存储「上一轮**实际发出** token 口径」的键（面板展示用）。
 *
 * 为什么**单列一个键**、不塞进 {@link ACP_META_KEY} 的 state：state 是按 JSON 快照 diff
 * 决定写不写的（见 `stateSnapshot`），把"每轮都在变的 token 数"混进去会让那个
 * "仅在变化时写"的优化失效 —— 变成每轮都写一次完整 state 与归档。单列后两边各按各的
 * 变化频率写。
 *
 * 消费方：`@harness/usage` 的 `renderContextOccupancy`。它原本只显示 `estimateTokens`
 * 的**原文口径**，而那个数不含压缩效果 ⇒ 真机上出现"压缩成功、占用百分比却纹丝不动"
 * 的误读。两个数并排后，面板才能同时回答"离强制压缩还有多远"与"这次请求实际带多少"。
 */
export const ACP_OCCUPANCY_KEY = 'acp.occupancy.v1'

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
 * 长上下文「工具入参完整性」提醒（B2-3，注入在**尾部**）。
 *
 * 动机：模型在长上下文下会**整段丢** tool-call arguments（真机 100 次调用 37 次失败、
 * 其中 34 次是 `input:{}`，失败率随上下文从 12% 升到 50%）；会话 `s_1790592617954_axqkk`
 * 又采样到 14 次，每次多烧一轮全量上下文（14 × 约 48.6k ≈ 0.68M ≈ 10% 成本）。
 * core 的 `[入参自愈]` 兜住的是"报错之后能补"，兜不住"先丢一次"本身。
 *
 * 触发条件刻意**不用占用率**：那次事故的 occupancy 峰值只有 22.83%，任何"长上下文阈值"
 * （25% / 35%）都不会触发，等于没修。改用 `core.tool.params.missing`（与 selfHealOnly
 * 免计额度同源的直接信号）—— 本会话真的丢过一次参数才提醒，零猜测、零误报。
 *
 * 为什么放尾部而不是系统区：本提醒一旦置位就粘住（翻转代价 ≈ 0 只因为它不在前缀）；
 * 放前缀则每翻转一次都要连带重算其后整段历史（量化见 MANUAL_INJECT_MARGIN 注释）。
 */
export const TOOL_ARGS_REMINDER =
  '⚠️ 调用工具时必须携带**完整** arguments（必填参数一个都不能少）；'
  + '若上一次调用因缺参被拒，请补齐参数后重试，不要重发空入参的调用。'

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

/** ref（形如 `m00012`）末尾的序号；解析不出返回 NaN */
function refSeq(ref: string | null | undefined): number {
  const m = /(\d+)\s*$/.exec(String(ref ?? ''))
  return m ? Number(m[1]) : NaN
}

/**
 * 统计各 range 覆盖的**原文字符数**（遥测口径，纯计算、不改状态）。
 *
 * 为什么需要：`compress` 事件的 `ranges[].chars` 长期恒为 0 ⇒「模型要求折叠多少内容」
 * 完全不可测，**零收益压缩**在遥测里与「折了一大段」长得一模一样
 * （真机 round 11：`createdBlocks:0, tokensCompressed:0, ranges:[{chars:0}]`）。
 * 这里按**压缩前**的 ref 映射把区间还原成字符数。
 */
export function measureRangeChars(
  state: CompressionState,
  cores: readonly CoreMessage[],
  ranges: readonly { topic?: string; startRef?: string; endRef?: string }[],
): { topic?: string; chars: number }[] {
  return ranges.map((r) => {
    const topic = r.topic ?? undefined
    const lo = refSeq(r.startRef)
    const hi = refSeq(r.endRef)
    if (Number.isNaN(lo) || Number.isNaN(hi)) return { topic, chars: 0 }
    let chars = 0
    for (const c of cores) {
      let ref: string | undefined
      try {
        ref = refForRaw(state.messageRefs, c.id) ?? undefined
      } catch {
        ref = undefined
      }
      const n = refSeq(ref)
      if (!Number.isNaN(n) && n >= lo && n <= hi) chars += c.text?.length ?? 0
    }
    return { topic, chars }
  })
}

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
  /** 本次实际折叠掉的原文字符数（零收益时为 0；便于模型判断这次调用有没有价值） */
  charsCompressed?: number
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

/**
 * 手册 / 压缩提示的注入策略。
 *
 * - `'on-demand'`（默认）：占用率接近压缩阈值时才注入完整手册，否则只在前缀留一行极简提示。
 * - `'always'`：每轮把完整手册注入**前缀**（复刻改造前行为，便于 A-B 对照或回退）。
 * - `'off'`：**一次都不注入**（前缀提示 / 尾部手册 / nudge 三处全静默）。
 */
export type ManualInjectionMode = 'on-demand' | 'always' | 'off'

/**
 * 「作用域档位」：叠加到**某一类会话 / 某个 Agent** 上的压缩配置。
 *
 * 字段与 `config` 同形 —— 直接复用内核的 {@link LooseAcpConfig}（`modelContextLimit` /
 * `preserveRecentTokens` / `preserveRecentMessages` / `promotionThreshold` / `tiers` / `nudge` /
 * `compress` …），再额外加一个 `manualInjection`。
 *
 * **刻意没有 `tokenCalibration` / `tokenCalibrationScale`**：折算口径与 `createCore` 注入的
 * `countTokens` 是**同一个函数**，全进程只能有一把尺子。按档位分化必然造成"占用率与内核阈值
 * 不同源"，而这正是本仓早年"占用率显示 26% 而实际已 103%"的根因。
 */
export interface AcpScopeOverride extends LooseAcpConfig {
  /** 该档位的压缩提示注入策略；缺省沿用上一层 */
  manualInjection?: ManualInjectionMode
}

/** 某个作用域解析后的**生效**配置（`scopeFor` 的返回值） */
export interface AcpResolvedScope {
  /** 生效的内核 config（`modelContextLimit` 已换成该档位的窗口） */
  config: AcpConfig
  /** 生效的压缩提示注入策略 */
  manualInjection: ManualInjectionMode
}

/**
 * 「Provider / 模型 → 上下文窗口」表 —— 供**按本会话实际使用的端点**解析占用率分母。
 *
 * 为什么不能只给一个 `modelContextLimit`：它是装配期按**默认** Provider 算出的**单个**数，
 * 而 Provider / 模型是**按 Agent 解析、且每次派工都可覆盖**的
 * （core：`input.model?.providerId ?? agent.model?.providerId ?? 'default'`）。
 * 子 Agent 被派到另一个端点上时，两端窗口不同 ⇒ 分母错：**分母偏大 = 占用率虚低 = 压缩永不触发**，
 * 且全程没有任何症状（工具照常报数、只是报的是别人的分母）。真机形态：默认 Provider 1M，
 * 子 Agent 走 200K 端点 ⇒ 报 20% 时实际已 100%。
 *
 * 由装配方（CLI，它才拿得到 config）构造后传入；插件不查注册表（`PluginContext` 里没有）。
 */
export interface ProviderWindowTable {
  /** `ProviderConfig.id` → 窗口（实例维度，最具体） */
  byProvider?: Record<string, number>
  /**
   * 模型名 → 窗口（模型维度）。
   *
   * 为什么两个维度都要：`providerId` 缺省时 core 传的是 `'default'` 哨兵（不是真实端点），
   * 此时唯一线索是 `modelId`；而 `agent md` 里写 `model: { modelId: 'hy3' }` 比写派生出的
   * provider id 自然得多。**同名模型挂多个端点**时由装配方取**最小**窗口 —— 保守方向是
   * 「宁可早压」，取最大会让分母虚高、压缩不触发。
   */
  byModel?: Record<string, number>
  /** 两个维度都查不到时的兜底（= 默认 Provider 的窗口）。缺省由插件补 200_000。 */
  fallback?: number
}

export interface AcpContextPluginOptions {
  /**
   * 模型上下文窗口（tokens）—— **显式覆盖**，压过按 Provider 的推导。默认 200_000。
   *
   * ⚠️ 只该传「用户明确指定的窗口」（CLI 的 `compression.modelContextLimit`）。把
   * 「默认 Provider 推导出来的窗口」塞进这里，会让所有会话都用同一个分母 —— 那正是
   * 本选项旁边的 `providerWindows` 要修的病。推导值应放进 `providerWindows.fallback`。
   */
  modelContextLimit?: number
  /**
   * 按本会话**实际**使用的 Provider / 模型解析窗口（见 {@link ProviderWindowTable}）。
   *
   * 缺省（undefined）= 不按端点分化，行为与改造前逐位一致 —— 单测直调、非 CLI 宿主都落这条路。
   */
  providerWindows?: ProviderWindowTable
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
   * - `'off'`：**一次都不注入**（前缀提示 / 尾部手册 / nudge 三处全静默）。给"工具白名单里
   *   没有 `compress` 的 Agent"用 —— 对它是误导而非说明书：模型会照着手册拼出字段完整的
   *   `compress` 调用，然后撞 `TOOL_NOT_ALLOWED`（真机会话 `s_1790685043685_1p8sw` 里 12 次全撞，
   *   模型自己都只能打断"the compress tool isn't actually available despite the philosophy text"）。
   *   注意**自动分层压缩照常运行**，关掉的只是"给模型看的提示"。
   *
   * 例外：`systemPrompt` 被显式赋值时，用户文本始终注入**前缀**（显式配置优先，且它恒定无风险），
   * 不再往尾部注入手册；`'off'` 也不抑制它（那是用户明确要的文本，不是我们塞的说明书）。
   */
  manualInjection?: ManualInjectionMode
  /**
   * **窗口保护闸（B3）**：按**真实占用率**（折叠后 `requestTok / window`）逐级升级处置。
   *
   * 为什么需要独立于会话压缩：`compactIfNeeded` 判的是**原文口径**（守内存/磁盘），ACP 启用后
   * 两把尺子分离 ⇒ 窗口保护事实上缺位。真机 `s_1791373374635_9hqyb`：原文口径 79.6% 撞线时
   * 真实请求只有 31.5%。详见 {@link ./window-guard.js}。
   *
   * 四档：`notifyPct`（告警）/ `forceCompressPct`（**复用内核折叠**，非破坏、可 decompress）/
   * 内核 `truncate.threshold`（既有静默截断，破坏性）/ `onExceedPct` + `onExceed:'refuse'`（中止本轮）。
   *
   * **刻意不做成作用域档位**（`subagent` / `perAgent` 那一层）：阈值是**占用率**，
   * 已随各档位自己的 `modelContextLimit` 自动缩放，再分化只会多一处口径来源。
   */
  windowGuard?: WindowGuardConfig
  /**
   * **子会话档位**：对有父会话（`parentSessionId` —— `session.create({ parentId })` 写入，
   * subagent / swarm 派生）的会话叠加的配置。
   *
   * 与 `config` 同形（见 {@link AcpScopeOverride}）。不配 = 不叠加 ⇒ 子会话逐位沿用顶层（旧行为）。
   */
  subagent?: AcpScopeOverride
  /**
   * **按 Agent 的档位**（key = agent 定义 id，如 `reader` / `reviewer` / `lead`）。
   *
   * 比 `subagent` 更具体：同样是子会话，"只读速读员"和"实现者"的合理档位并不相同。
   * 优先级：`perAgent[agentId]` > `subagent` > 顶层。
   */
  perAgent?: Record<string, AcpScopeOverride>
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
  /** 最近一次写入 {@link ACP_OCCUPANCY_KEY} 的 JSON（同样用于跳过无变化的重复写入） */
  occupancySnapshot?: string
  // ---- 增量渲染缓存 ----
  /** 已渲染（含压缩效果/refs 标签）的历史前缀的原始消息 id 序列 */
  prefixIds: string[]
  /** 与 prefixIds 对应的渲染结果（不含 system），增量路径直接复用 */
  prefixRender: Message[]
  /** 是否需要强制全量重算（压缩发生/状态变化/水合后置位） */
  needFull: boolean
  /** 全量路径最后一次的 token 估算，用于判断增量是否逼近阈值 */
  lastTokens: number
  /**
   * 本会话已出现过「工具必填项没给全」⇒ 之后每轮在尾部提醒一次（B2-3）。
   *
   * 粘性（置位后本会话不再清除）：丢参数是"上下文一长就复发"的形态，
   * 提醒只有一行且落在尾部，常驻比反复开关更省、也更可靠。
   */
  needsArgsReminder?: boolean
  /**
   * 本会话生效的压缩档位（由 `core.session.preModel` 解析后绑上）。
   *
   * **工具必须取这一份**（`compress` 的 applyCompression、`acp_status` 的 engine.status），
   * 不能再用工厂闭包里的全局 `config` —— 否则 hook 按档位决策、工具按全局报表，
   * 两处口径分裂（本仓的忌讳形态："占用率显示 26% 实际已 103%"就是这一类的历史事故）。
   *
   * 为 undefined 时（会话尚未跑过 preModel，如 session 压缩先到）回落到默认档位。
   */
  scope?: AcpResolvedScope
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
  /**
   * 本轮请求**末尾** core 追加的尾部动态块规模（来自 `core.session.preModel` 的 `dynamicParts`）。
   *
   * 为什么要记：core 在 preModel **之后**才把它拼到 `messages` 末尾，所以本插件建归因视图时
   * 看不到它；而它恰好是请求的最后一条 —— anthropic 显式 promptCache 断点的落点。
   * 只记规模不记内容：它是每轮重算的，内容没有留存价值，规模足以解释末尾的 cache write。
   * 每轮显式覆盖（含置空），与 `lastSystemStability` 同一纪律。
   */
  lastTailDyn?: { parts: number; chars: number }
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
 * 把一层作用域档位合并到已有配置上：浅合并 + `tiers` / `nudge` / `compress` **三个子树深一层**。
 *
 * 为什么不是 `{ ...base, ...layer }`：这三个键是**子树**，浅展开会让"只改 nudge 的一个键"
 * 把整棵 nudge 树替掉 ⇒ 其余键静默回落内核默认值（本仓同类坑已有前车：ACP 状态水合时
 * 就是因为浅展开而让新字段缺失，见 `runPreModel` 里二级合并那段注释）。
 *
 * `manualInjection`（插件自己的键）与 `modelContextLimit`（由调用方单独取出当窗口用）**不进**
 * 内核 config —— 后者留着会让 `defaultConfig` 收到两份窗口来源。
 */
function mergeScopeConfig(base: LooseAcpConfig | undefined, layer: AcpScopeOverride): LooseAcpConfig {
  const baseCfg = (base ?? {}) as Record<string, unknown>
  const merged: Record<string, unknown> = { ...baseCfg }
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue
    if (key === 'manualInjection' || key === 'modelContextLimit') continue
    if (key === 'tiers' || key === 'nudge' || key === 'compress') {
      merged[key] = { ...(baseCfg[key] as object), ...(value as object) }
    } else {
      merged[key] = value
    }
  }
  return merged as LooseAcpConfig
}

/**
 * 摘掉 config 里的 `modelContextLimit`。
 *
 * 内核的 `defaultConfig(modelContextLimit, overrides)` 实现是 `{ ...base, ...overrides }` ——
 * overrides 里的 `modelContextLimit` 会**盖掉**作为第一个参数传进去的窗口。所以窗口必须由调用方
 * 独占：留着它，档位里写的窗口就会被顶层 `config.modelContextLimit` 静默盖回去
 *（"配了却不生效"，而且没有任何症状）。
 */
function stripWindow(cfg: LooseAcpConfig | undefined): LooseAcpConfig | undefined {
  if (!cfg || cfg.modelContextLimit === undefined) return cfg
  const out = { ...cfg }
  delete out.modelContextLimit
  return out
}

/**
 * 这份 Agent 工具清单里到底有没有 `compress`。
 *
 * 返回 `undefined` 表示**未知**（宿主没传 `agentTools`，如单测直调、非 core 宿主）——
 * 消费方应 fail-open。刻意不把"未知"当空集：两者判错的代价不对称 ——
 * 未知时按旧行为注入只是多付一份说明书，而误判成空集会**静默关掉**一个本来能用压缩的
 * Agent 的全部提示（用户看不到任何报错，只会觉得"压缩怎么不提醒了"）。
 *
 * 只认 `'compress'` 而不认 `'acp_status'`：被注入的文本（`COMPRESS_MANUAL_HINT` / 完整手册 /
 * nudge）说的都是"调 compress 压历史"，只给 `acp_status` 的 Agent 照着它去调同样是白撞。
 */
export function agentCanUseCompress(agentTools: readonly string[] | undefined): boolean | undefined {
  if (!agentTools) return undefined
  return agentTools.includes('compress')
}

/** 窗口得是个能当分母的正有限数 —— 表里混进 `0` / `NaN` / 负数时按「查不到」处理，别拿去算占用率 */
function isUsableWindow(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/**
 * 按「本会话**实际**使用的 Provider / 模型」查上下文窗口（见 {@link ProviderWindowTable}）。
 *
 * 查表顺序：`providerId`（实例维度，最具体）→ `modelId`（模型维度）。
 * 两者都可能缺：`providerId` 缺省时 core 传 `'default'` 哨兵（表里没有这个键 ⇒ 落 fallback，
 * 而 fallback 恰是默认 Provider 的窗口，正是想要的那个值）；`modelId` 缺省表示用端点默认模型。
 *
 * 刻意不按 `providerId + '/' + modelId` 组组合键：`contextWindowTokens` 挂在 **Provider 实例**
 * 上（config 里没有「模型级窗口」这一层），组合键查不出更细的答案，只会多一个永远 miss 的分支。
 */
export function lookupProviderWindow(
  table: ProviderWindowTable | undefined,
  providerId?: string,
  modelId?: string,
): number | undefined {
  if (!table) return undefined
  const byProvider = providerId ? table.byProvider?.[providerId] : undefined
  if (isUsableWindow(byProvider)) return byProvider
  const byModel = modelId ? table.byModel?.[modelId] : undefined
  if (isUsableWindow(byModel)) return byModel
  return undefined
}

/**
 * 创建 ACP 上下文压缩插件。
 * 每轮通过 core.session.preModel 运行 acp-kernel 的 processTurn，并注入 4 个模型驱动工具。
 */
export function createAcpContextPlugin(options: AcpContextPluginOptions = {}): AgentPlugin {
  // 「调用方显式给的窗口」保持 undefined 原样 —— 一旦在这里 `?? 200_000`，窗口解析链上的
  // 「按 Provider 查表」就永远轮不到（恒被这个默认值截胡），那正是本选项要修的 bug。
  // 单独留一个 modelContextLimit 常量只作**诊断口径**（install 日志 / autoTune 摘要 = 默认档位）。
  const optionWindow = options.modelContextLimit
  const modelContextLimit = optionWindow ?? 200_000
  const baseManualInjection: ManualInjectionMode = options.manualInjection ?? 'on-demand'
  // 窗口保护闸（B3）：归一化一次，后续每轮直接用（决策点不做第二遍默认值）。
  // 缺省**开启**且四档取 WINDOW_GUARD_DEFAULTS —— 见 window-guard.ts 的取舍说明；
  // 想回到改造前行为（窗口保护只剩内核那三层）就显式配 `windowGuard.enabled: false`。
  const windowGuard: ResolvedWindowGuard = resolveWindowGuard(options.windowGuard)

  /**
   * 解析某个作用域**生效**的压缩配置。
   *
   * 优先级（后写覆盖前写）：**顶层 → `subagent`（子会话）→ `perAgent[agentId]`**。
   *
   * 为什么要两个维度而不是一个：它们回答的是不同问题 ——
   * 「凡事派生出来的子会话该怎么压」（预算小、只回摘要）与「这一种 Agent 该怎么压」
   * （`reader` 是短命只读 worker，保留量该小些；`reviewer` 又要留多些原文）。
   * 两者可以叠，`perAgent` 更具体所以优先级更高。
   *
   * 结果是纯函数（输入只有判别符），所以按 key 缓存 —— 这个解析每轮都走，
   * 但一个进程里的档位 × 端点的组合就那么几个。
   */
  const scopeCache = new Map<string, AcpResolvedScope>()
  function scopeFor(
    agentId?: string,
    parentSessionId?: string,
    providerId?: string,
    modelId?: string,
  ): AcpResolvedScope {
    // 缓存 key 必须带 `providerId` / `modelId`：窗口是**跟着端点走**的，漏了它就会拿先到者的
    // 窗口去算后来者的占用率（子 Agent 被派到小窗口端点上时正是这个形态）。
    const key = `${parentSessionId ? 'child' : 'root'}\u0000${agentId ?? ''}\u0000${providerId ?? ''}\u0000${modelId ?? ''}`
    const cached = scopeCache.get(key)
    if (cached) return cached
    let loose: LooseAcpConfig | undefined = options.config
    let manual = baseManualInjection
    // 窗口解析链 —— 前两级是「用户显式指定」，压过一切推导；第三级才按本会话**实际**用的
    // 端点查表；最后两级兜底（默认 Provider 的窗口 → 插件默认）。
    //
    // 为什么显式要排在推导之前：`compression.modelContextLimit` 的文档语义就是「我不管端点
    // 是什么，就按这个数算」。它排后面等于让用户写了也不生效。
    let window =
      loose?.modelContextLimit ??
      optionWindow ??
      lookupProviderWindow(options.providerWindows, providerId, modelId) ??
      options.providerWindows?.fallback ??
      200_000
    // 数组顺序即优先级顺序：越具体的越靠后写
    const layers: (AcpScopeOverride | undefined)[] = [
      parentSessionId ? options.subagent : undefined,
      agentId ? options.perAgent?.[agentId] : undefined,
    ]
    for (const layer of layers) {
      if (!layer) continue
      if (layer.modelContextLimit !== undefined) window = layer.modelContextLimit
      if (layer.manualInjection !== undefined) manual = layer.manualInjection
      loose = mergeScopeConfig(loose, layer)
    }
    const scope: AcpResolvedScope = {
      // 窗口单独传（loose 里的已抹掉）—— 见 stripWindow 的注释
      config: resolveAcpConfig(window, stripWindow(loose), options.autoTune),
      manualInjection: manual,
    }
    scopeCache.set(key, scope)
    return scope
  }
  /** 默认档位（无 agentId、非子会话）—— 拿不到判别符的宿主与单测都落这里，行为与改造前一致 */
  const defaultScope = scopeFor()
  const config = defaultScope.config
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
  // 手册注入策略已改为**按作用域解析**（见上方 scopeFor）：顶层 `manualInjection` 是底，
  // `subagent` / `perAgent` 档位可以覆盖。explicitSystemPrompt 表示用户显式整段覆盖了
  // systemPrompt —— 那份文本必须始终注入（不受阈值、也不受 'off' 影响）。
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
        inputSchema: fromJsonSchema<CompressInput>({
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
          // 取本会话生效的档位 —— 与 preModel 用的是同一份，不是工厂闭包里的全局 config
          const scope = sctx.scope ?? scopeFor(ctx.agentId)
          const ranges = parseCompressInput(
            input,
            ctx.toolUseId,
            (w) => ctx.log?.warn?.(w),
          )
          if (!ranges.length) {
            return { ok: false, error: { message: 'compress 参数无法解析出有效范围', code: 'NO_RANGES' } }
          }
          // 遥测要统计的是"模型要求折叠多少"，必须用**压缩前**的 ref 映射（压缩后 refs 会变）
          const preState = sctx.state
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
            config: scope.config,
          })
          sctx.state = applied.state
          // 压缩改变了块结构/历史 → 强制下一轮全量重建，失效增量缓存
          sctx.needFull = true

          // ---- 遥测：compress 事件（模型主动调用时） ----
          // ranges 的 chars 用**压缩前**的 ref 映射真实统计（此前恒为 0，零收益与真折叠不可分辨）。
          const rangeStats = measureRangeChars(preState, sctx.lastCores, ranges)
          const charsAttempted = rangeStats.reduce((n, r) => n + r.chars, 0)
          const telem = sctx.telemetry ?? createTelemetryWriter(undefined)
          try {
            const ev = buildCompressEvent({
              sessionId: ctx.sessionId,
              round: sctx.round ?? 0,
              window: scope.config.modelContextLimit,
              state: applied.state,
              result: applied.result,
              ranges: rangeStats,
            })
            telem.write(ev)
          } catch {
            // 遥测失败不影响主流程
          }

          // ---- 零收益：一个块都没建 ⇒ 不是「成功但没变化」，而是**这次调用白烧了** ----
          // 内核已经给出很具体的 gate 说明（哪些 ref 已覆盖 / 范围太小 / ref 未知），
          // 之前把它塞在 `ok: true` 的 output.errors 里 ⇒ 模型倾向于当成成功继续。
          // 这里升级为失败结果，把内核说明原样回喂，并给下一步动作。
          if (applied.result.blocksCreated === 0) {
            return {
              ok: false,
              error: {
                message: [
                  `本次 compress **零收益**（未产生任何压缩块，尝试范围共 ${charsAttempted} 字符）——这次调用等于白烧。`,
                  ...(applied.result.errors.length > 0 ? ['内核说明：', ...applied.result.errors] : []),
                  ...(applied.result.warnings.length > 0 ? ['内核提示：', ...applied.result.warnings] : []),
                  '下一步：先调 acp_status 取**当前**可压缩范围再发 compress；或把范围扩大到未被覆盖的连续段。',
                ].join('\n'),
                code: 'NO_EFFECT',
              },
            }
          }

          return {
            ok: true,
            output: {
              blocksCreated: applied.result.blocksCreated,
              tokensCompressed: applied.result.tokensCompressed,
              errors: applied.result.errors,
              warnings: applied.result.warnings,
              charsCompressed: charsAttempted,
            },
          }
        },
      })
    : undefined

  const decompressTool = want('decompress')
    ? defineTool<DecompressInput, DecompressOutput>({
        id: 'decompress',
        description: '按 blockId 查看某个已压缩上下文块的摘要，可了解被压缩掉的内容梗概。',
        inputSchema: fromJsonSchema<DecompressInput>({
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
        inputSchema: fromJsonSchema<SearchInput>({
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
        inputSchema: fromJsonSchema<AcpStatusInput>({
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
          // 同上：报表口径必须与决策口径同源，否则“工具说占 30%、压到 0.35 才触发”就成了两个事实
          const rep = engine.status(sctx.state, tokenCount, (sctx.scope ?? scopeFor(ctx.agentId)).config)
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
        // 按端点分化的窗口表（占用率分母）—— 配了就点名条目数；缺省说明所有会话共用同一个分母
        // （单测直调 / 非 CLI 宿主），此时行为与改造前逐位一致。
        providerWindows: options.providerWindows
          ? {
              byProvider: Object.keys(options.providerWindows.byProvider ?? {}).length,
              byModel: Object.keys(options.providerWindows.byModel ?? {}).length,
              fallback: options.providerWindows.fallback,
            }
          : undefined,
        autoTune: options.autoTune === true,
        // autoTune 关闭时为 undefined，日志里不会出现该键
        autoTuneParams: options.autoTune ? describeAutoTune(modelContextLimit) : undefined,
        // token 折算口径：auto = CJK 感知（1 字≈1 token），chars4 = 旧口径
        tokenCalibration: options.tokenCalibration === 'chars4' ? 'chars4' : 'auto',
        preserveRecentTokens: config.preserveRecentTokens,
        growthFloor: config.nudge?.growthFloor,
        minCompressRange: config.compress?.minCompressRange,
        // 作用域档位：配了就点名，否则"配了却不生效"只能靠猜（档位是纯叠加，缺省行为不变）
        manualInjection: baseManualInjection,
        subagentTier: options.subagent !== undefined,
        perAgentTiers: options.perAgent ? Object.keys(options.perAgent) : undefined,
      })

      return {
        /**
         * 档位里的 key 是 **agent id**，写错了完全没有反馈（这个键只在本插件里被查表，
         * 写歪一个字母的效果与“特意不配”一模一样）。本仓已有前车：`subagents` 这个 frontmatter
         * 字段在某 agent 定义里列了 15 项却毫无作用。所以在 agent 注册表就绪后核对一次 ——
         * **只告警、不阻断**（也可能有运行期才注册的 agent，那时这台告警就是个善意的提醒）。
         */
        'core.harness.start'(input) {
          const tiers = options.perAgent
          if (!tiers || Object.keys(tiers).length === 0) return
          // `harness` 在 hook 契约里是 unknown（非 CLI 宿主可能给别的形状）⇒ 全程防御式取用，
          // 取不到就当“不知道”，不猜也不报。
          const registry = (input.harness as { agent?: { list?: () => unknown } } | undefined)?.agent
          let known: string[] | undefined
          try {
            const list = registry?.list?.()
            known = Array.isArray(list)
              ? list.map((a) => String((a as { id?: unknown })?.id ?? '')).filter(Boolean)
              : undefined
          } catch {
            known = undefined
          }
          if (!known || known.length === 0) return
          const unknownIds = Object.keys(tiers).filter((id) => !known.includes(id))
          if (unknownIds.length > 0) {
            plgCtx.log.warn?.(
              `compression.perAgent 里有未注册的 Agent id：${unknownIds.join('、')}`
              + ` —— 该档位不会生效（当前可用：${known.join(' / ')}）`,
            )
          }
        },

        async 'core.tool.pool.assemble'(_input, pool) {
          for (const t of tools) (pool as { add: (t: unknown) => void }).add(t)
        },

        /**
         * B2-3：模型把一次工具调用的必填参数整段丢了 ⇒ 给本会话置一个**粘性**标记，
         * 从下一轮起在尾部常驻提醒（见 {@link TOOL_ARGS_REMINDER} 处为何不用占用率触发）。
         *
         * 只置位、不做任何 IO、不改本轮结果 —— 这条 hook 与 selfHealOnly 免计额度同源。
         */
        'core.tool.params.missing'(input) {
          if (input.sessionId) getOrCreateCtx(input.sessionId).needsArgsReminder = true
        },

        async 'core.session.preModel'(input, rawMessages) {
          const messages = rawMessages as Message[]
          try {
            // 判别符全在 input 里（core 透传）：这是哪个 Agent 的会话、是不是子会话、它
            // **实际能用哪些工具**、以及本轮**实际打到哪个端点/模型**（占用率分母按它解析）。
            // 三者共同决定本会话走哪个档位、提示该不该注入。不让插件自己去查 agent 注册表：
            // `PluginContext` 里根本没有它（拿不到就只能猜）。
            const scope = scopeFor(input.agentId, input.parentSessionId, input.providerId, input.modelId)
            const sctx = getOrCreateCtx(input.sessionId)
            // 把档位绑到会话上：随后的 `compress` / `acp_status` 工具必须读**同一份** config，
            // 否则 hook 按档位决策、工具按全局报表 —— 两处口径分裂。
            sctx.scope = scope
            // 能力判据：白名单里确实没有 compress ⇒ 模型侧提示一律不注入（P0-1 的根因修复，
            // 见 agentCanUseCompress 的注释）。全局 toolIds 把 compress 排除时同理。
            const canCompress = want('compress') ? agentCanUseCompress(input.agentTools) : false
            await runPreModel({
              sessionId: input.sessionId,
              messages,
              getCtx: () => sctx,
              engine,
              config: scope.config,
              countTokens,
              meta: input.meta,
              makeSystemPrompt,
              prompts: resolvedPrompts,
              ...(input.systemStability ? { systemStability: input.systemStability } : {}),
              ...(input.dynamicParts ? { dynamicParts: input.dynamicParts } : {}),
              tempMessage,
              manualInjection: scope.manualInjection,
              ...(canCompress !== undefined ? { canCompress } : {}),
              explicitSystemPrompt,
              // 窗口保护闸（B3）：配置与告警出口。入口给日志（`notify` / `forceCompress` 两档要可见），
              // 这也是它唯一的出口 —— 宿主若没接日志，闸门就静默降级成"只按档位动手"。
              windowGuard,
              notify: (msg) => plgCtx.log.warn?.(msg),
              // 统一块模型：把每轮内部折叠（tier1/2/3）的 source:'acp' 块 push 给 host，
              // host 合并进 session.blocks，供视图/loader/reconstructHistory/revert 消费
              recordBlocks: (blocks) => {
                if (input.blocksPatch) input.blocksPatch.push(...blocks)
              },
            })
          } catch (err) {
            // 窗口保护闸的 refuse 档**必须上抛**：它存在的意义就是"这一轮不发请求"。
            // 被下面那条"压缩是旁路优化"的兜底吞掉，就等于把"静默损坏"换成"静默报错"——
            // 而本闸的全部价值就在于这个动作不能被静默。
            if (err instanceof WindowGuardExceededError) throw err
            // 其余失败：压缩是旁路优化，绝不阻断本轮模型请求
            plgCtx.log.warn?.('ACP preModel 处理失败，跳过本轮压缩', { err: String(err) })
          }
        },

        async 'core.session.compacting'(input, compactCtx) {
          try {
            const sctx = getOrCreateCtx(input.sessionId)
            await runCompacting({
              sessionId: input.sessionId,
              input: compactCtx,
              getCtx: () => sctx,
              engine,
              // 本 hook 的入参是 `PromptInput`（有 agentId，**没有** parentSessionId），
              // 所以优先用 preModel 已绑到会话上的那份档位；会话还没跑过 preModel
              // （session 压缩可能先到）才按 agentId 现算 —— 那一档少了 subagent 覆盖，
              // 但此时本来也没有子会话判据可用。
              config: (sctx.scope ?? scopeFor(input.agentId)).config,
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
              // 端点维度：同一模型挂多个 Provider 实例时，model 名重复，只有它能区分端点
              providerId: signal.providerId,
              cacheRead: signal.cacheRead,
              cacheWrite: signal.cacheWrite,
              requestTok: sctx.lastTokens,
              // 回退归因三件套：上一行（算降幅/空闲）、本轮前缀差异（算"是不是我们改坏的前缀"）、
              // provider 实际输入（算本地口径偏差）
              prev: sctx.lastCacheRow,
              prefix: sctx.lastPrefixDiff,
              systemChangedParts: sctx.lastSystemStability?.changedParts ?? null,
              systemChangedDetail: sctx.lastSystemStability?.details ?? null,
              // 尾部动态块规模（core 在 preModel 之后追加，归因视野看不见它本身）
              tailDynamicParts: sctx.lastTailDyn?.parts ?? null,
              tailDynamicChars: sctx.lastTailDyn?.chars ?? null,
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
   * `'on-demand'` 仅在占用率接近压缩阈值时注入完整手册，否则只注入极简提示；
   * `'off'` 三处提示全静默（见 {@link ManualInjectionMode}）。
   */
  manualInjection?: ManualInjectionMode
  /**
   * 窗口保护闸（B3）的**已归一化**配置（缺省 = 关闭该闸，行为与改造前逐位一致）。
   *
   * 归一化在工厂侧完成（`resolveWindowGuard`），这里只收结果 —— 决策点不该再做一遍默认值。
   */
  windowGuard?: ResolvedWindowGuard
  /**
   * 告警出口（`notify` / `forceCompress` 两档都走它）。缺省静默。
   *
   * 刻意复用一个出口而不是给每档一个回调：三档说的是同一条链上的事，
   * 分开接会给宿主"这可能是三件无关的事"的错觉。
   */
  notify?: (message: string) => void
  /**
   * 本会话的 Agent 是否**真的能调 `compress`**（工具白名单判据，见 {@link agentCanUseCompress}）。
   *
   * 为 `false` 时**不注入任何模型侧压缩提示**（前缀提示 / 尾部完整手册 / nudge）——
   * 对用不了这个工具的 Agent，那三段文本不是说明书而是**误导**：模型会照着手册拼出字段完整的
   * `compress` 调用，然后撞 `TOOL_NOT_ALLOWED`（真机会话 `s_1790685043685_1p8sw` 里 12 次全撞）。
   *
   * `undefined` = **未知**（非 core 宿主、单测直调时没有 `agentTools`）⇒ **fail-open**，
   * 按改造前的行为照样注入。两种判错的代价不对称，所以只抑制"确实不可用"这一种。
   */
  canCompress?: boolean
  /**
   * 用户是否显式赋值了 `systemPrompt`。为真时无论 manualInjection 与占用率如何都注入完整手册
   * （用户显式要求，不受阈值影响，也不会退化成极简提示，且**不受 canCompress 抑制**）。
   */
  explicitSystemPrompt?: boolean
  /** 解析后的提示词 policy（nudge 渲染与本轮压缩系统提示保持一致）；缺省走内核默认 */
  prompts?: Prompts
  /** 引擎给出的系统区段级归因（仅变化时有值）；用于把 system-changed 点名到段 */
  systemStability?: SystemStabilityReport
  /**
   * 本轮 core 将在 preModel 之后追加到请求末尾的尾部动态片段。
   * 本插件**看不到它拼进去之后的样子**（拼接发生在 hook 返回后），只能拿到规模用于归因；
   * 切勿把它当历史一部分参与压缩/计数。空数组与 undefined 等价：都表示没有。
   */
  dynamicParts?: string[]
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
 * 窗口保护闸的**折叠动作**：复用内核已经算好的可压范围与折叠入口，自己不划范围、不写折叠实现。
 *
 * 为什么取 `res.nudge.compressibleRanges`：那是内核 `recommendNode` 的产出
 * （`mergeRangesToThreshold(buildCompressibleRanges(...), config.compress.minCompressRange)`），
 * 即遥测里 `suggestedRanges` 指的东西 —— **内核已经算过一遍了**，没有理由在插件侧再划一次。
 *
 * 为什么调 `engine.applyCompression` 而不是插件的 `runCompacting`：后者是**为会话压缩服务**的
 * （响应 `core.session.compacting`，输入是 core 给的待删窗口，语义是"配合别人删"），
 * 与窗口闸"我自己觉得该压了"的目标不同。两者在**折叠动作**上本就同源
 * （`runCompacting` 内部也调 `applyCompression`），分道的是**触发与选段**，不是折叠实现。
 *
 * 摘要文本复用既有纯函数 {@link defaultRuleSummary}（头/尾拼接），**不新增第二份摘要实现**：
 * `applyCompression` 要求调用方提供 `summary`（内核不生成摘要）。范围首尾的原文从 `archive`
 * （core.id → 原始 Message）取 —— 那些 core 都是本轮可见历史的成员，`byRef[ref]` 必然命中。
 *
 * 内核自身的 `minCompressRange` 门槛按**整个批次合计**字符数判定（不是每条范围），
 * 所以这里把范围**整批**交给内核、不预先逐条过滤 —— 过滤反而会把"合起来够格"的批次拆散。
 *
 * @returns 折叠结果；`undefined` = 本轮没有折叠（无可折内容 / 未过内核门槛），调用方应放行到内核兜底
 */
function foldForWindowGuard(input: {
  res: ProcessTurnResult
  engine: ReturnType<typeof createCore>
  config: AcpConfig
  archive: Map<string, Message>
}): { state: CompressionState; blocks: number; tokens: number } | undefined {
  const ranges: CompressibleRange[] = input.res.nudge?.compressibleRanges ?? []
  if (ranges.length === 0) return undefined
  const specs: { startRef: string; endRef: string; summary: string; topic: string }[] = []
  for (const r of ranges) {
    const summary = windowGuardRangeSummary(input.res.state, input.archive, r)
    if (!summary) continue
    specs.push({ startRef: r.startRef, endRef: r.endRef, summary, topic: '窗口保护闸自动折叠' })
  }
  if (specs.length === 0) return undefined
  const applied = input.engine.applyCompression({
    ranges: specs,
    messages: input.res.messages,
    state: input.res.state,
    config: input.config,
  })
  if (applied.result.blocksCreated === 0) return undefined
  return {
    state: applied.state,
    blocks: applied.result.blocksCreated,
    tokens: applied.result.tokensCompressed,
  }
}

/**
 * 给一段待折范围生成摘要文本。
 *
 * 取该范围**首尾**两条原始消息交给 {@link defaultRuleSummary}（它本来就只读头尾）——
 * 复用既有纯函数，不新增摘要实现。两者都取不到时返回空串，调用方跳过该范围
 * （宁可少折一段，也不用"无中生有"的摘要顶替 —— 摘要会被写进块并被模型长期引用）。
 */
function windowGuardRangeSummary(
  state: CompressionState,
  archive: Map<string, Message>,
  range: CompressibleRange,
): string {
  const first = originalMessageForRef(state, archive, range.startRef)
  const last = originalMessageForRef(state, archive, range.endRef)
  const window = [first, last].filter((m): m is Message => m !== undefined)
  if (window.length === 0) return ''
  return defaultRuleSummary(window)
}

/** ref（mNNNNN）→ 原始 harness Message（经 state.messageRefs.byRef 反查 core id，再查归档） */
function originalMessageForRef(
  state: CompressionState,
  archive: Map<string, Message>,
  ref: string,
): Message | undefined {
  const coreId = state.messageRefs?.byRef?.[ref]
  if (!coreId) return undefined
  const m = archive.get(coreId)
  return m && typeof m === 'object' ? m : undefined
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

  // 尾部动态块规模同上：core 在 preModel 之后才拼，归因视野看不到它，只记规模备查。
  const tailDyn = deps.dynamicParts ?? []
  ctx.lastTailDyn = tailDyn.length > 0
    ? { parts: tailDyn.length, chars: tailDyn.join('').length }
    : undefined

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
  // processTurn 的入参抽出成局部常量：窗口保护闸触发时要用**同一份入参**、只换 state 再跑一次
  // （见下方 B3 段），两处各写一遍必然漂移。
  const turnInput = {
    messages: inflat.cores,
    config,
    tokenCount,
    // renderTags 取舍（compress.d.ts：'all' 默认 / 'text-only' / 'none'）：
    // 选 'text-only' —— ref 标签只注入 user/assistant 文本，工具参数与结果保持原样
    // （工具输出常被粘贴/复制，混入 <acp> 标签会污染其内容语义）。
    // 代价：模型看不到工具结果的 ref，compress 范围若需精确落在工具结果边界上，
    // 只能用相邻文本消息的 ref 近似表达。若未来出现"必须精确压缩某段工具输出"的
    // 场景，再评估切到 'all'（标签只存在于渲染层，不进会话本体与 archive）。
    renderTags: 'text-only' as const,
  }
  let res = engine.processTurn({ ...turnInput, state: ctx.state })

  // ---- B3：窗口保护闸 ----
  //
  // 位置刻意在**写遥测 / 持久化 / 渲染之前**：本闸会替换 `res`（强制折叠后用新 state 重跑一次
  // processTurn），若把它放在下游，state 持久化 / 面板的「实际发出」口径 / 原文归档 /
  // 统一块模型 / 增量渲染缓存 / 尾部 nudge 就会各自基于**不同版本**的 res ——
  // 正是本仓反复出事的"同一个东西两套口径"。放在这里 ⇒ 下游只有一份 res。
  // 代价：真正触发的那一轮会跑两次 processTurn（罕见），其余轮零开销。
  //
  // 占用率口径与遥测/面板**同源**（`requestTok / modelContextLimit`，其中 requestTok 是
  // 折叠后真正发往模型的量）—— 这正是"真实上下文占用率"，也是本闸独立于 `compactIfNeeded`
  // （原文口径）的意义所在。
  const guardWindow = Math.max(1, config.modelContextLimit)
  let occupancy = estimateTokens(res.messages, countTokens) / guardWindow
  if (deps.windowGuard?.enabled) {
    const guard = deps.windowGuard
    const action = decideWindowGuardAction({ occupancy, guard })
    const used = (): number => estimateTokens(res.messages, countTokens)
    if (action === 'refuse') {
      // 抛错是**故意**的：只有调用方不吞它，本轮才会真的中止（见 hook 里的 WindowGuardExceededError 分支）。
      throw new WindowGuardExceededError(
        formatWindowGuardRefusal({ occupancy, window: guardWindow, used: used(), guard }),
      )
    }
    if (action === 'notify') {
      deps.notify?.(formatWindowGuardNotice({ occupancy, window: guardWindow, used: used(), guard }))
    } else if (action === 'forceCompress') {
      const folded = foldForWindowGuard({ res, engine, config, archive: ctx.archive })
      if (folded) {
        // 用折叠后的 state 重建本轮请求；tokenCount 仍传**原文口径**（与常态一致 ——
        // 内核的 nudge 压力判据一直吃的是折叠前的量，见 window-guard.ts 头注的"三层"表）。
        res = engine.processTurn({ ...turnInput, state: folded.state })
        ctx.needFull = true
        occupancy = estimateTokens(res.messages, countTokens) / guardWindow
      }
      deps.notify?.(
        formatWindowGuardNotice({
          occupancy,
          window: guardWindow,
          used: used(),
          guard,
          ...(folded ? { folded: { blocks: folded.blocks, tokens: folded.tokens } } : { foldSkipped: true }),
        }),
      )
    }
  }

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

  // ---- 面板口径：把「本轮真正发出去的 token」落进独立 meta 键 ----
  // 与 ACP_META_KEY 分开写：那边按 state 的 JSON 快照 diff（仅变化时写），而 token 数每轮都在动，
  // 混进去会让那个优化失效。消费方 @harness/usage 的 renderContextOccupancy 用它展示
  // 「实际发出」，与"原文口径"并排 —— 只给原文口径会被读成"压缩完怎么还没降"。
  try {
    const occSnap = {
      // 发往模型的量（已应用压缩：被块覆盖的区间换成了摘要）
      requestTok: estimateTokens(res.messages, countTokens),
      // 同期未压缩口径，供面板展示"省了多少"
      rawTok: estimateTokens(inflat.cores, countTokens),
      window: deps.config.modelContextLimit,
    }
    const occJson = JSON.stringify(occSnap)
    if (ctx.occupancySnapshot !== occJson) {
      ctx.occupancySnapshot = occJson
      await meta.patch({ [ACP_OCCUPANCY_KEY]: occSnap })
    }
  } catch {
    // 写失败不影响主流程；消费方在键缺失时退化为只输出原文口径那一行
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
  // 该值**已在函数上方（窗口保护闸处）算过一次**，这里直接复用局部变量 `occupancy` ——
  // 不在两处写分叉的两份算法（闸门若折叠过，`occupancy` 已随最终 res 重算）。
  //
  // 前缀只放**恒定**文本：自动前缀缓存按最长公共 token 前缀命中，放在历史之前的文本一变，
  // 其后全部内容（含整段历史）都要重算（代价量化见 MANUAL_INJECT_MARGIN 的注释）。
  // 会变的完整手册一律挪到**尾部**（与 nudge 同位置），见下方 tailParts。
  const manualThreshold = (deps.config.nudge?.minContextLimitPct ?? 0.35) * MANUAL_INJECT_MARGIN
  // ---- 模型侧压缩提示是否整体静默 ----
  // 两个来源，任一成立即静默：
  // ① 档位显式关了（`manualInjection: 'off'`）—— 给“由外部判定不可压”的场景；
  // ② **能力判据**：本 Agent 的工具白名单里确实没有 compress（`canCompress === false`）。
  //    这一条才是 P0-1 的根因修复：手册过去是**无条件下发**的，而只读 worker 白名单里
  //    只有 read_file/list_dir/glob/grep_file，却拿着手册拼出字段完整的 compress 调用去撞
  //    `TOOL_NOT_ALLOWED`（真机会话 12 次全撞）。`undefined`（未知）不算，见 canCompress。
  // 显式 systemPrompt / `'always'` 不受影响：那是用户明确要的文本，不是我们塞的说明书。
  const suppressHints = deps.canCompress === false || deps.manualInjection === 'off'
  const prefixText =
    deps.explicitSystemPrompt === true || deps.manualInjection === 'always'
      ? deps.makeSystemPrompt() // 宿主显式配置 / 对照臂：恒定，无翻转风险
      : suppressHints
        ? '' // 静默：连那一行极简提示也不留（它同样在教模型去调 compress）
        : COMPRESS_MANUAL_HINT // 默认档：恒定的一行提示
  if (prefixText) request.push(deps.tempMessage('system', prefixText, sessionId))

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
    !suppressHints &&
    deps.explicitSystemPrompt !== true &&
    deps.manualInjection !== 'always' &&
    occupancy >= manualThreshold
  const tailParts = [
    // nudge 与手册同源，说的都是“该压了”。用不了 compress 的 Agent 收到它只会困惑，
    // 所以与手册同一判据一起静默（自动分层压缩不受影响 —— 那是引擎行为，不依赖模型配合）。
    nudge?.shouldInject && !suppressHints ? renderNudgeText(nudge, deps.prompts).text : '',
    needTailManual ? deps.makeSystemPrompt() : '',
    // B2-3：本会话已丢过参数 ⇒ 尾部常驻一行提醒（尾部翻转不伤前缀缓存）
    ctx.needsArgsReminder ? TOOL_ARGS_REMINDER : '',
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
 * 窗口保护闸（B3）的对外面：决策 / 归一化 / 错误类型 / 文案。
 *
 * 从 index 转出而非让调用方深引 `./window-guard.js`：包只有一个公开入口，
 * 宿主侧（`@harness/host`）只按包名依赖。
 */
export {
  decideWindowGuardAction,
  formatWindowGuardNotice,
  formatWindowGuardRefusal,
  resolveWindowGuard,
  WindowGuardExceededError,
  WINDOW_GUARD_DEFAULTS,
  type ResolvedWindowGuard,
  type WindowGuardAction,
  type WindowGuardConfig,
} from './window-guard.js'

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