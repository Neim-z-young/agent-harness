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
  /** 本块创建时间戳 */
  at: number
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
   * 模型上下文窗口大小（tokens）。
   * 与 autoCompactThresholdPct / reservedTokens 配合，计算百分比阈值。
   * 默认 200000（200K 窗口）
   */
  contextWindowTokens?: number
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
  /** 流式发送 prompt：逐事件 yield AgentStreamEvent，最后一个为 done（含最终 Message） */
  promptStream(sessionId: string, text: string): AsyncGenerator<import('@harness/core').AgentStreamEvent, void, unknown>

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
  /** 合并更新会话 meta（浅合并 patch 到 meta；供 ACP 等插件持久化运行时状态） */
  updateMeta(sessionId: string, patch: Record<string, unknown>): Promise<void>

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
  /** 估算当前会话的 token 数（按字符长度 / 4） */
  estimateTokens(sessionId: string): Promise<number>
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
}
