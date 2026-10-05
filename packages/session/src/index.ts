/**
 * @harness/session - 会话管理
 *
 * 融合 OpenCode Session 文档的完整结构：
 * - Message + Part 模型（text/tool/file/reasoning/patch/image）
 * - Compaction 三级：prune → summary → auto agent 压缩
 * - Snapshot + Revert/Unrevert（同 OpenCode revert.ts）
 * - Todo List Plane（独立存储 + Bus 通知）
 */

import type { Awaitable } from '@harness/bus'
import type { TokenUsage } from '@harness/core'

// ===== Part 类型 =====

/** 文本片段 */
export interface TextPart {
  type: 'text'
  text: string
}

/** 工具调用（含请求与结果） */
export interface ToolCallPart {
  type: 'tool'
  /** 工具调用 ID（LLM 生成的 tool_use_id） */
  toolUseId: string
  /** 工具 ID */
  toolId: string
  /** 工具输入参数 */
  input: unknown
  /** 工具执行结果（assistant 回调时填充） */
  result?: unknown
  /** 是否出错 */
  isError?: boolean
}

/** 文件附件 */
export interface FilePart {
  type: 'file'
  /** 文件路径 */
  path: string
  /** MIME 类型 */
  mimeType?: string
  /** 内联内容（小文件）或路径引用 */
  content?: string
}

/** 推理过程（思维链） */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
  /** 是否截断 */
  truncated?: boolean
}

/** 代码/文件补丁 */
export interface PatchPart {
  type: 'patch'
  /** 目标文件路径 */
  path: string
  /** 补丁内容（unified diff 或操作列表） */
  patch: string
  /** 操作类型 */
  operation?: 'create' | 'edit' | 'delete'
}

/** 图片 */
export interface ImagePart {
  type: 'image'
  /** 文件路径（二选一） */
  path?: string
  /** base64 内联（二选一） */
  content?: string
  /** MIME 类型 */
  mimeType?: string
}

/**
 * 所有 Part 类型联合
 * 支持扩展：未识别的 type 会落入兜底分支
 */
export type Part =
  | TextPart
  | ToolCallPart
  | FilePart
  | ReasoningPart
  | PatchPart
  | ImagePart
  | { type: string; [key: string]: unknown }

// ===== Message =====

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

/**
 * 消息接口
 * 一条消息可包含多个 Part（混合文本、工具调用、文件等）
 */
export interface Message {
  /** 消息 ID */
  id: string
  /** 角色 */
  role: MessageRole
  /** 内容片段数组（按顺序呈现） */
  parts: Part[]
  /** 创建时间戳（ms） */
  createdAt: number
  /** 关联 Agent ID（assistant 消息必填） */
  agentId?: string
  /** 父消息 ID（用于分支/编辑回退） */
  parentId?: string
  /** 元数据 */
  meta?: {
    /** 模型名 */
    model?: string
    /**
     * Provider 实例路由键（`ProviderConfig.id`；未显式指定时为 `'default'` 哨兵）。
     *
     * 引擎在构造 assistant 消息时与 `model` 一同写入。**用量统计的 Provider 维度
     * 就靠它**（`@harness/usage` 的 `foldMessage` 从这里读，因而增量折叠与全量重建同口径）。
     * 本维度引入之前落盘的会话没有这个字段 ⇒ 统计侧归 `'unknown'`（"不知道走的哪个"），
     * 与 `'default'`（"确定走了默认端点"）刻意区分。
     */
    providerId?: string
    /** token 用量（含缓存命中/未命中明细） */
    tokenUsage?: TokenUsage
    [key: string]: unknown
  }
}

// ===== Session Compaction Schema =====

/** 压缩状态元数据（约定写入 Session.meta.compaction） */
export interface CompactionMeta {
  /** 累计压缩次数 */
  count: number
  /** 最近一次压缩策略 */
  lastStrategy?: CompactionStrategy
  /** 最近一次压缩时间 */
  lastAt?: number
  /** 最近一次压缩前的消息数 */
  lastMessagesBefore?: number
  /** 最近一次压缩后的消息数 */
  lastMessagesAfter?: number
  /** 累计被压缩掉的消息数（用于统计/调试） */
  totalPrunedMessages?: number
}

/**
 * 会话压缩"记忆"接口（约定写入 Session.meta.compactMemory）。
 * memory 是压缩后的长期对话摘要。Agent 在每次推理前把它作为 system prompt 的一部分注入，
 * 让 LLM 知道已经被压缩掉的历史上下文。
 */
export interface CompactMemory {
  /** 摘要文本（由 summary / agent 策略生成；prune 策略为 null） */
  summaryText?: string
  /** 压缩前的消息窗口起始（messages[0] 原来的时间戳或 createdAt） */
  memoryStartAt?: number
  /** 摘要轮次：每多一次压缩累加 1，summary 策略会把"上一轮摘要"作为上下文参考 */
  round: number
}

/** 约定写入 Session.meta 的 key */
export const COMPACT_META_KEY = 'compaction' as const
export const COMPACT_MEMORY_KEY = 'compactMemory' as const
export const SESSION_MODEL_META_KEY = 'model' as const

// ===== 会话级模型覆盖（会话内自由切模型）=====
// 语义：覆盖只作用于「本会话」，不写 Agent 定义、不写 config.json。
// 优先级最高（高于 Agent 定义、启动参数），下一轮 query 即生效；
// 置为 null / undefined 表示「清除覆盖」，回落到 Agent 定义与全局默认。
//
// 为什么不复用 Agent 定义：Agent 定义是全局共享对象（按 id 常驻注册表），
// 改它等于把所有用该 Agent 的会话一起改掉 —— 这正是「切换模型串台」的根源。

/** 会话级模型覆盖（约定写入 Session.meta.model） */
export interface SessionModelOverride {
  providerId?: string
  modelId?: string
}

/**
 * 读取会话级模型覆盖：形状非法或字段全空时返回 undefined（视作未覆盖）。
 */
export function getSessionModelOverride(
  session: Pick<Session, 'meta'> | undefined | null,
): SessionModelOverride | undefined {
  const raw = session?.meta?.[SESSION_MODEL_META_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const providerId = str(o.providerId)
  const modelId = str(o.modelId)
  if (!providerId && !modelId) return undefined
  return { ...(providerId ? { providerId } : {}), ...(modelId ? { modelId } : {}) }
}

/**
 * 生成 updateMeta 用的 patch。
 * `undefined` 会显式写成 null（而非删除 key）—— 因为 updateMeta 是浅合并，
 * 只有显式给值才能把已有的覆盖清掉。
 */
export function sessionModelMetaPatch(override: SessionModelOverride | undefined): Record<string, unknown> {
  return { [SESSION_MODEL_META_KEY]: override ?? null }
}

// ===== Session 压缩视图（上下文压缩·阶段二）=====
// 目标：内存只驻留「摘要块 + 近期消息」，原文在盘按需懒加载。
// session 层不直接读盘（盘由 workspace/cli 层承担），故这里只定义视图类型与
// 纯组装函数，盘访问通过 host 注入的 HistoryLoader 回调提供。
// 与 @harness/workspace 的 CompactionBlock 保持同构（session 不反向依赖 workspace）。

/** 会话压缩块：摘要 + 指向原文 id 段的断点 */
export interface CompactionBlock {
  /** 块 ID（稳定，跨重启可定位原文） */
  id: string
  /** 主题（可选） */
  topic?: string
  /** 压缩摘要内容 */
  summary: string
  /** 被压缩原文消息范围的起始 message id */
  startId: string
  /** 被压缩原文消息范围的结束 message id */
  endId: string
  /** 本块创建时间戳（缺省时由写入方填充） */
  at?: number
  /**
   * 该块原文在 SessionOriginalStore 中的归档 key（供 loader 按块还原原文）。
   * 缺省沿用 block.id。
   */
  origKey?: string
  /** 块来源（统一块模型）：通用 compact 折叠 / ACP 插件折叠。缺省视为 'generic'。 */
  source?: 'generic' | 'acp'
  /**
   * 原文取回引用（统一块模型，source==='acp' 时用）：
   * 指向 ACP 归档 key（如 `acp:...`），供 loader/reconstructHistory 据此取回原文，
   * 避免同一窗口原文双写（meta 归档 + .cmp.orig）。
   */
  archiveRef?: string
}

/** 组装待发请求的精简视图：摘要块 + 近期完整消息 */
export interface SessionView {
  blocks: CompactionBlock[]
  messages: Message[]
  /** 是否为"已精简"视图（有 blocks 且不全量） */
  slimmed: boolean
}

/** 惰性加载原文的范围选择 */
export interface HistoryLoadRange {
  /** 起始消息 id（含） */
  startId?: string
  /** 结束消息 id（含） */
  endId?: string
  /** 按块 id 加载对应原文段 */
  blockIds?: string[]
}

/** 由 host 注入的懒加载器：按需从盘加载原文消息全文 */
export interface HistoryLoader {
  /**
   * 加载指定会话中 range 范围内的原文消息。
   * 未指定 range（或 loader 无法满足）时，语义由 host 决定（通常加载全部可用原文）。
   */
  load(sessionId: string, range?: HistoryLoadRange): Promise<Message[]>
}

/**
 * 原文档案存储器（上下文压缩·阶段二，Route B）。
 * 由宿主注入 core：compact 裁剪前把被压缩窗口原文落盘到内存之外，
 * loader/flushHistory 经此按块还原，实现「内存瘦身 + 全文可回溯」。
 * core 不直接读写文件，只依赖本接口。
 */
export interface SessionOriginalStore {
  /**
   * 把某压缩块对应的原文消息序列化到盘。
   * 返回写入的绝对路径；失败由调用方容错。实现需幂等（同 key 覆盖式写）。
   */
  save(sessionId: string, blockId: string, messages: Message[]): Promise<string | void>
  /** 读取某压缩块归档的原文消息；不存在返回 undefined */
  load(sessionId: string, blockId: string): Promise<Message[] | undefined>
  /**
   * 按引用取回原文（统一块模型，可选）：当块带 `archiveRef`（source==='acp' 时）
   * 而非传统 `origKey` 时，供 loader/reconstructHistory 据此取回 ACP 归档的原文。
   * 未实现时返回 undefined，调用方回退到 `load(sessionId, origKey ?? id)`。
   */
  loadRef?(sessionId: string, ref: string): Promise<Message[] | undefined>
}

/**
 * 构造 `reconstructHistory` 用的 `resolveBlock`：按块的 source/引用统一分派原文取回。
 * - `source:'acp'` 且提供 OriginalStore.loadRef 时 → 走 archiveRef；
 * - 否则回退 OriginalStore.load(sessionId, origKey ?? id)。
 * 供 core/cli/revert 复用，保证"全文回溯"对 ACP 与通用折叠一致取原文。
 */
export function buildResolveBlock(
  store: SessionOriginalStore | undefined,
  sessionId: string,
): (block: CompactionBlock) => Promise<Message[]> {
  return async (block) => {
    if (!store) return []
    const ref = block.source === 'acp' ? block.archiveRef : undefined
    if (ref && typeof store.loadRef === 'function') {
      try {
        const msgs = await store.loadRef(sessionId, ref)
        if (msgs) return msgs
      } catch {
        /* 落到回退 */
      }
    }
    const key = block.origKey ?? block.id
    const msgs = await store.load(sessionId, key)
    return msgs ?? []
  }
}

/**
 * 组装精简视图：无 blocks 时完全退化为「blocks=[]、messages=原样、slimmed=false」，
 * 保证在未启用压缩/无压缩块时现有行为零变化。
 */
export function buildView(
  blocks: CompactionBlock[] | undefined,
  messages: Message[],
): SessionView {
  if (!blocks || blocks.length === 0) {
    return { blocks: [], messages, slimmed: false }
  }
  return { blocks, messages, slimmed: true }
}

/**
 * 把压缩块渲染成一条摘要占位消息（user 角色、text part）。
 * 供未来 query 在组装 finalMessages 时把已压缩历史「折叠」为一条摘要，减少 token。
 * 无块时返回 undefined。
 */
export function renderBlocksAsMessage(blocks: CompactionBlock[] | undefined): Message | undefined {
  if (!blocks || blocks.length === 0) return undefined
  const lines: string[] = ['===COMPACTED HISTORY SUMMARY===']
  for (const b of blocks) {
    const head = b.topic ? `[${b.topic}]` : ''
    lines.push(`${head} ${b.summary}`)
  }
  return {
    id: `__compaction_view__`,
    role: 'user',
    parts: [{ type: 'text', text: lines.join('\n') }],
    createdAt: Date.now(),
  }
}

/**
 * 重建会话"全文历史"：按 blocks 顺序经 `resolveBlock` 取回各块归档的原文，
 * 再拼接近期 `messages`（id 去重，保证块原文与近期不重叠，block 在前、近期在后，
 * 由于块按压缩时序追加、近期是未压缩的最新段，故拼接结果保持时间顺序）。
 *
 * - 有 loader/OriginalStore 时：`resolveBlock` 返回该块原文，实现"全文可回溯"。
 * - 块原文取回失败/未提供：`resolveBlock` 返回空数组，不抛错，退化为「仅近期 + 摘要块」。
 *
 * 供 CLI loader、core exportMarkdown、/history 等消费方共用；纯函数可单测。
 */
export async function reconstructHistory(
  sess: Pick<Session, 'blocks' | 'messages'>,
  resolveBlock?: (block: CompactionBlock) => Promise<Message[]>,
): Promise<Message[]> {
  const out: Message[] = []
  const seen = new Set<string>()
  const push = (m: Message | undefined): void => {
    if (!m) return
    if (seen.has(m.id)) return
    seen.add(m.id)
    out.push(m)
  }
  for (const b of sess.blocks ?? []) {
    let restored: Message[] = []
    if (resolveBlock) {
      try {
        restored = (await resolveBlock(b)) ?? []
      } catch {
        restored = []
      }
    }
    for (const m of restored) push(m)
  }
  for (const m of sess.messages ?? []) push(m)
  return out
}

// ===== Session =====

/**
 * 会话接口
 * 一个会话包含完整的消息历史和上下文
 */
export interface Session {
  /** 会话 ID */
  id: string
  /** 标题（自动生成或用户指定） */
  title?: string
  /** 创建时间 */
  createdAt: number
  /** 最后更新时间 */
  updatedAt: number
  /** 当前 Agent ID */
  agentId?: string
  /** 消息列表（按时间顺序） */
  messages: Message[]
  /**
   * 已压缩摘要块（可选；阶段二）：内存驻留的"已压缩历史"摘要，原文在盘由 HistoryLoader 按需加载。
   * 缺省 / undefined 表示未启用压缩视图，消息仍以 messages 全量内存驻留。
   */
  blocks?: CompactionBlock[]
  /** 工作目录 */
  cwd?: string
  /** 父会话 ID（子 Agent 派生时关联，便于审计追溯） */
  parentId?: string
  /**
   * 元数据（推荐使用 `CompactionMeta` / `CompactMemory` 约定：
   *   - meta[COMPACT_META_KEY]: CompactionMeta
   *   - meta[COMPACT_MEMORY_KEY]: CompactMemory
   */
  meta?: Record<string, unknown>
}

// ===== SessionManager 接口 =====

/** 创建会话选项 */
export interface SessionCreateOptions {
  title?: string
  agentId?: string
  cwd?: string
  meta?: Record<string, unknown>
  /** 父会话 ID（子 Agent 派生时关联，便于审计追溯） */
  parentId?: string
}

/** 列表查询选项 */
export interface SessionListOptions {
  /** 限制数量 */
  limit?: number
  /** 偏移量 */
  offset?: number
  /** 按 agentId 过滤 */
  agentId?: string
}

/** 压缩策略 */
export type CompactionStrategy = 'prune' | 'summary' | 'agent'

/** token 折算口径 */
export type TokenCalibration = 'auto' | 'chars4'

/**
 * CJK 感知的 token 估算（默认口径）。
 *
 * 中日韩字符按 1 token/字、其余按 4 字符/token。**口径必须与 acp-kernel 的
 * `defaultCountTokens` 保持一致** —— 那是 ACP 插件占用率闸门的唯一输入，而这里是会话
 * 自动压缩阈值的输入；两边只要有一侧不同，就会出现「ACP 认为已超窗、会话层判定远未到
 * 阈值」的错位（历史上英文会话两者逐位等价、中文会话低估约 4 倍）。
 *
 * 之所以在 session 包里独立实现一份而不直接 import acp-kernel：acp-kernel 只被
 * @harness/acp-context 依赖，core/session 拉它会让第三方压缩内核成为底层包的硬依赖；
 * 代价是要靠 `session.test` 里的定值断言守住漂移。
 */
export function countTokensCJK(text: string): number {
  if (!text) return 0
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)
  const cjkCount = cjk?.length ?? 0
  return cjkCount + Math.ceil((text.length - cjkCount) / 4)
}

/** 旧口径：一律 `chars/4`（Claude Code 的 roughTokenCountEstimation）。仅作回退与 A-B 对照。 */
export function countTokensChars4(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

/**
 * 按口径取计数函数；缺省取 CJK 感知口径。
 *
 * @param calibration `auto`（缺省，CJK 感知）/ `chars4`（旧口径）
 * @param scale 额外校正系数（缺省 1 = 不校正）。
 *
 * 为什么需要 scale：本地估算与 provider 实际计费口径**不是同一把尺子**。真机实测
 * （临时 dataDir 跑 3 轮，DeepSeek / deepseek-flash）稳定为 **1.33**（provider 输入 ÷
 * 本地整包估算 = 1.328 / 1.342 / 1.337 / 1.332），即本地**系统性低估约 25%**（1 − 1/1.33）。
 * 后果是 occupancy / 自动压缩阈值整体偏保守：报"占 26.9%"时实际已约 35%，于是压缩迟迟不触发。
 *
 * 刻意做成**显式系数**而不是偷偷乘：系数与模型/语料相关，应由 `compression.tokenCalibrationScale`
 * 按实测配置；缺省 1 保证不改变既有行为。观测值见遥测 `providerCache.calibration`。
 */
export function resolveCountTokens(
  calibration?: TokenCalibration,
  scale: number = 1,
): (text: string) => number {
  const base = calibration === 'chars4' ? countTokensChars4 : countTokensCJK
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return base
  return (text: string) => Math.ceil(base(text) * scale)
}

/** compact() / compactIfNeeded() 共用选项 */
export interface CompactOptions {
  /**
   * 压缩策略
   * - prune：只截断最旧的消息（保留 system 消息 + 最近 K 条 user/assistant 对），不生成摘要
   * - summary（默认）：对被截断的窗口做轻量规则摘要（按消息类型统计 + 首尾要点），结果写入 CompactMemory.summaryText
   * - agent：调用 LLM 生成摘要（调用者需提供调用能力；若缺失自动 fallback 到 summary）
   */
  strategy?: CompactionStrategy
  /**
   * 上下文窗口（tokens）。**必须显式传入**——调用方（CLI）要按「显式覆盖 → 默认 Provider
   * 的 contextWindowTokens → 兜底」推导，core 内的 200000 只是兜底。
   * 传错窗口的直接后果：阈值 = (窗口 − reserved) × pct%，窗口虚高时阈值高于真实窗口上限，
   * 自动压缩永远不可能触发（"配了但从不生效"）。
   */
  contextWindowTokens?: number
  /**
   * token 折算口径（默认 `'auto'` = CJK 感知）。
   * - `'auto'`：中日韩 1 token/字，其余 4 字符/token，与 ACP 层同一口径
   * - `'chars4'`：一律 chars/4。中文会话会低估约 4 倍 ⇒ 自动压缩阈值更难达到
   * @see countTokensCJK
   */
  tokenCalibration?: TokenCalibration
  /** 本地估算的额外校正系数（缺省 1）；与 `compression.tokenCalibrationScale` 同源 */
  tokenCalibrationScale?: number
  /**
  /**
   * 触发百分比：估算 token 占"可用窗口"（contextWindow - reserved）的百分比达到此值才压缩。
   * 默认 80（即 80% 使用率才触发），适配从 128K 到 1M 窗口的模型。
   */
  autoCompactThresholdPct?: number
  /**
   * 预留 tokens（给摘要生成留空间）。
   * 默认 30000（参考 Claude Code 的 20K max output + 13K buffer）。
   */
  reservedTokens?: number
  /**
   * 固定阈值（估算总 token 数达到多少才压缩）。
   * 优先于百分比计算；不传则用 (contextWindow - reserved) * pct% 计算。
   */
  thresholdTokens?: number
  /**
   * [已废弃] 每条消息的平均 token 估算。
   * 现改用字符长度 / 4 精确估算（参考 Claude Code 的 roughTokenCountEstimation）。
   * 保留向后兼容：传入时仍按此值估算。
   */
  tokensPerMessage?: number
  /** 压缩后保留的最近消息数（user+assistant 算一对；默认 10 条 = 5 轮对话） */
  keepRecentMessages?: number
  /** 摘要最大字符数（仅 summary / agent 策略；默认 8000） */
  summaryMaxChars?: number
}

/**
 * 会话管理器接口
 *
 * 职责：
 * - 创建/获取/列表会话
 * - prompt 触发 LLM 调用
 * - 更新消息/Part
 * - 快照与回滚
 * - 压缩（控制上下文长度）
 */
export interface SessionManager {
  /** 创建会话 */
  create(options?: SessionCreateOptions): Promise<Session>
  /** 获取会话 */
  get(sessionId: string): Promise<Session | undefined>
  /**
   * 重命名会话 ID（同步更新会话对象与内部索引）。
   * 用于「恢复持久化会话」：create 新会话获得临时 id 后，改为磁盘上的真实 id，
   * 从而后续 prompt/send 能按真实 id 查得该会话。
   * @returns 重命名后的会话（id 已更新）
   */
  setId(oldId: string, newId: string): Promise<Session>
  /** 列出会话 */
  list(options?: SessionListOptions): Promise<Session[]>
  /** 关键词搜索会话（匹配消息文本，大小写不敏感） */
  search(query: string, options?: SessionListOptions): Promise<Session[]>
  /** 发送 prompt（触发 LLM 调用，返回 assistant 消息） */
  prompt(sessionId: string, text: string): Promise<Message>
  /**
   * 流式发送 prompt：逐事件 yield AgentStreamEvent。
   *
   * 注意 `done` 的语义是「**这一步**结束」而非「整轮结束」—— 引擎内自主多步时
   * 每个 step 都会发一次 done（带 `step` 序号），上层应由"是否还有后续事件"判断收尾。
   *
   * @param maxSteps 引擎内自主多步步数上限；缺省用引擎默认值（AgentDefinition.maxSteps 或全局默认）
   * @param signal 中断信号：在步边界与每个工具执行前生效，中断时保留已完成的成果
   */
  promptStream(
    sessionId: string,
    text: string,
    maxSteps?: number,
    signal?: AbortSignal,
  ): AsyncGenerator<import('@harness/core').AgentStreamEvent, void, unknown>

  /** 更新整条消息（部分字段） */
  updateMessage(sessionId: string, messageId: string, patch: Partial<Message>): Promise<void>
  /** 更新某个 Part */
  updatePart(
    sessionId: string,
    messageId: string,
    partIndex: number,
    patch: Partial<Part>
  ): Promise<void>

  /** 添加消息 */
  addMessage(sessionId: string, message: Message): Promise<void>
  /** 删除消息 */
  deleteMessage(sessionId: string, messageId: string): Promise<void>
  /** 整体覆盖会话消息（供上下文压缩/裁剪插件回写精简后的消息列表） */
  setMessages(sessionId: string, messages: Message[]): Promise<void>
  /**
   * 合并写入会话压缩块（统一块模型）：按块 id 去重覆盖 session.blocks，
   * 供 host 把插件（ACP 等）回传的折叠块并入统一块列表（幂等）。
   */
  setBlocks(sessionId: string, blocks: CompactionBlock[]): Promise<void>
  /** 合并更新会话 meta（浅合并 patch 到 meta；供 ACP 等插件持久化运行时状态） */
  updateMeta(sessionId: string, patch: Record<string, unknown>): Promise<void>

  /**
   * 标脏：登记某会话自上次落盘后有变更。由 SessionManager 实现统一登记，
   * 供宿主（CLI）在轮末只保存"有变化"的会话，而非无脑全量保存（避免子会话反复重写放大 IO）。
   */
  markDirty(sessionId: string): void
  /**
   * 取出自上次落盘以来变更的会话（脏会话）并清空脏标记；供宿主在轮末批量保存。
   * 返回的是当前内存中的 Session 引用，宿主应负责写盘（失败可重新 markDirty 以便重试）。
   */
  takeDirtySessions(): Session[]

  /** 创建快照（用于 revert） */
  snapshot(sessionId: string): Promise<string>
  /** 回滚到快照 */
  revert(sessionId: string, snapshotId: string): Promise<void>
  /** 撤销回滚 */
  unrevert(sessionId: string, snapshotId: string): Promise<void>

  /** 立即压缩会话 */
  compact(sessionId: string, strategy?: CompactionStrategy, options?: CompactOptions): Promise<void>
  /** 估算当前上下文长度达到阈值时才压缩（无触发时为 no-op）；返回是否真的执行了压缩 */
  compactIfNeeded(sessionId: string, options?: CompactOptions): Promise<boolean>
  /** 估算当前会话的 token 数（默认 CJK 感知口径；传 'chars4' 走旧的 chars/4） */
  estimateTokens(sessionId: string, calibration?: TokenCalibration): Promise<number>
  /** 读取当前压缩记忆（CompactMemory + 元数据），供 Agent 注入 system prompt */
  getCompactionInfo(sessionId: string): Promise<{ meta?: CompactionMeta; memory?: CompactMemory }>
  /** 组装发送给模型的精简视图（摘要块 + 近期完整消息）；无压缩块时退化为全量 messages */
  getView(sessionId: string): Promise<SessionView>
  /**
   * 注入/移除该会话的惰性加载器（原文在盘按需加载；由 host 提供读盘实现）。
   * 传 undefined 表示移除 loader（此时 flushHistory 返回空）。
   */
  setHistoryLoader(sessionId: string, loader?: HistoryLoader): void
  /**
   * 惰性加载指定会话的原文消息全文（经注入的 HistoryLoader）。
   * 未注入 loader 或加载失败时返回空数组（不抛错，一级容错）。
   */
  flushHistory(sessionId: string, range?: HistoryLoadRange): Promise<Message[]>
  /** 导出会话为 Markdown 文本 */
  exportMarkdown(sessionId: string): Promise<string>

  /**
   * 向会话的待处理通知队列追加一条通知消息（如后台任务完成通知）。
   * 通知会在下一次 query 开始时通过 drainNotifications 取出并注入为 user-role 消息。
   */
  enqueueNotification(sessionId: string, message: string): void
  /**
   * 取出并清空会话的所有待处理通知消息，返回通知文本数组。
   * 在 AgentRuntime.query 开始时调用，将通知作为 user-role 消息注入对话。
   */
  drainNotifications(sessionId: string): string[]
  /**
   * 只读查看待处理通知（**不消费**）。
   *
   * 用途：自动续轮（CLI 注入的 `<continue/>`）前判断"是否真有后台结果要处理" ——
   * 没有待处理通知的续轮是纯空转，会白烧一次完整模型调用。
   */
  peekNotifications(sessionId: string): string[]
}
