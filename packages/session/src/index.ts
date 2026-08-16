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
    /** token 用量 */
    tokenUsage?: { input: number; output: number }
    [key: string]: unknown
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
  /** 工作目录 */
  cwd?: string
  /** 元数据 */
  meta?: Record<string, unknown>
}

// ===== SessionManager 接口 =====

/** 创建会话选项 */
export interface SessionCreateOptions {
  title?: string
  agentId?: string
  cwd?: string
  meta?: Record<string, unknown>
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
  /** 列出会话 */
  list(options?: SessionListOptions): Promise<Session[]>
  /** 发送 prompt（触发 LLM 调用，返回 assistant 消息） */
  prompt(sessionId: string, text: string): Promise<Message>

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

  /** 创建快照（用于 revert） */
  snapshot(sessionId: string): Promise<string>
  /** 回滚到快照 */
  revert(sessionId: string, snapshotId: string): Promise<void>
  /** 撤销回滚 */
  unrevert(sessionId: string, snapshotId: string): Promise<void>

  /** 压缩会话（控制上下文长度） */
  compact(sessionId: string, strategy?: CompactionStrategy): Promise<void>
}
