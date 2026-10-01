/**
 * 结构化错误（`AGENTS.md` §5：自定义错误类定义在各模块，不抛裸字符串）。
 *
 * 这些码会进 **JSON-RPC 错误** 或**任务 metadata**，是远程调用方唯一能据以分支的东西 ——
 * 文案可以改，`code` 不能。故集中在这里，不散落在各调用点。
 */

export type A2aErrorCode =
  /** 同 `contextId`（= sessionId）已有活跃任务（并发策略：一期直接拒绝，plan §3.5） */
  | 'CONCURRENT_TASK'
  /** 缺少或错误的 Bearer 凭据 */
  | 'UNAUTHORIZED'
  /** `contextId` 已绑定给别的调用方（隔离：plan §3.5） */
  | 'CONTEXT_FORBIDDEN'
  /** 服务已达到并发上限 */
  | 'TOO_MANY_TASKS'
  /** 请求体不是合法 JSON-RPC */
  | 'BAD_REQUEST'
  /** `messageId` 重复且无法回放（仍在执行中，尚无可回放的快照；plan §3.5 幂等） */
  | 'DUPLICATE_MESSAGE'
  /** 消息带 `taskId`，但该任务已进入终态（协议 MUST：不能再给它发消息） */
  | 'TASK_TERMINAL'
  /** 消息同时带 `taskId` 与不匹配的 `contextId`（协议 MUST：拒绝） */
  | 'CONTEXT_TASK_MISMATCH'

export class A2aServerError extends Error {
  readonly code: A2aErrorCode
  /** 附带的机器可读细节（进 JSON-RPC 错误的 `data`） */
  readonly detail: Record<string, unknown> | undefined
  /** 对应的 JSON-RPC 错误码（-32000 段是"服务器自定义错误"） */
  readonly jsonRpcCode: number

  constructor(
    code: A2aErrorCode,
    message: string,
    opts: { detail?: Record<string, unknown>; jsonRpcCode?: number } = {},
  ) {
    super(message)
    this.name = 'A2aServerError'
    this.code = code
    this.detail = opts.detail
    this.jsonRpcCode = opts.jsonRpcCode ?? -32000
  }

  /** 进 JSON-RPC 错误对象的形状 */
  toJsonRpc(): { code: number; message: string; data?: Record<string, unknown> } {
    return {
      code: this.jsonRpcCode,
      message: this.message,
      ...(this.detail ? { data: { a2aCode: this.code, ...this.detail } } : { data: { a2aCode: this.code } }),
    }
  }
}

/** 同会话并发：显式拒绝而不是排队（无隐藏积压；二期再评估排队） */
export class ConcurrentTaskError extends A2aServerError {
  constructor(contextId: string, activeTaskId: string) {
    super('CONCURRENT_TASK', `会话 ${contextId} 上已有进行中的任务，请等待它结束或先 CancelTask`, {
      detail: { contextId, activeTaskId },
    })
    this.name = 'ConcurrentTaskError'
  }
}

/** 认证失败 */
export class UnauthorizedError extends A2aServerError {
  constructor(message = '缺少或无效的 Bearer token') {
    super('UNAUTHORIZED', message, { jsonRpcCode: -32001 })
    this.name = 'UnauthorizedError'
  }
}

/** 隔离：`contextId` 属于别的调用方 */
export class ContextForbiddenError extends A2aServerError {
  constructor(contextId: string) {
    super('CONTEXT_FORBIDDEN', `无权访问会话 ${contextId}`, { detail: { contextId } })
    this.name = 'ContextForbiddenError'
  }
}

/** 服务已达并发上限 */
export class TooManyTasksError extends A2aServerError {
  constructor(limit: number) {
    super('TOO_MANY_TASKS', `服务并发已达上限（${limit}），请稍后重试或先取消在跑的任务`, {
      detail: { limit },
    })
    this.name = 'TooManyTasksError'
  }
}

/**
 * `messageId` 重复且**无法回放**。
 *
 * 幂等的两条路径（plan §3.5）：① 已执行完 ⇒ 回放任务快照（不重复执行）；
 * ② 仍在执行中 ⇒ 这条错误（既不能重跑、也还没有可回放的终态快照）。
 * 客户端收到它应当**等待**而非重试同一 `messageId`。
 */
export class DuplicateMessageError extends A2aServerError {
  constructor(messageId: string) {
    super('DUPLICATE_MESSAGE', `消息 ${messageId} 正在处理中，请等待其完成后再查询任务`, {
      detail: { messageId },
    })
    this.name = 'DuplicateMessageError'
  }
}

/**
 * 消息带 `taskId`，但该任务**已进入终态**（completed / failed / canceled / rejected）。
 *
 * 协议要求 `SendMessage` 拒绝发往终态任务的消息（官方 a2a-tck `CORE-SEND-002`，MUST）。
 * 客户端收到它应当 **`GetTask` 读终态**，而不是重试。
 *
 * ⚠️ 这条错误**修正了一处原设计偏差**：原先"带 `taskId` 但挂起表里没有 ⇒ 一律回放快照
 * 且不报错"（plan §3.4 要点 3 的"安全忽略"）。那条只对**迟到的权限答复**成立；对"给一个
 * 已结束的任务发新消息"这种普通用法，静默返回快照会把**错误掩盖成成功**。现在按协议报错
 * —— 仍然不重复执行，只是把结果如实告知。**正常续接不受影响**：真续接时
 * `executor.suspend.has(taskId)` 为真，走的是放行分支。
 */
export class TaskTerminalError extends A2aServerError {
  constructor(taskId: string, state: string) {
    super('TASK_TERMINAL', `任务 ${taskId} 已进入终态（${state}），不能再给它发消息`, {
      detail: { taskId, state },
      // -32004 = UnsupportedOperation（A2A 错误码表）
      jsonRpcCode: -32004,
    })
    this.name = 'TaskTerminalError'
  }
}

/**
 * 消息同时带了 `taskId` 与**不属于该任务**的 `contextId`。
 *
 * 协议要求拒绝这种自相矛盾的请求（官方 a2a-tck `CORE-MULTI-006`，MUST）——放行会
 * 让两个会话的历史被同一任务写入。`-32602` = Invalid params。
 */
export class ContextTaskMismatchError extends A2aServerError {
  constructor(taskId: string, contextId: string) {
    super('CONTEXT_TASK_MISMATCH', `contextId ${contextId} 与任务 ${taskId} 所属会话不一致`, {
      detail: { taskId, contextId },
      jsonRpcCode: -32602,
    })
    this.name = 'ContextTaskMismatchError'
  }
}
