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
