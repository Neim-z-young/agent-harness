/**
 * JSON-RPC 2.0 信封的最小工具集 + A2A 版本头。
 *
 * 只做"组包 / 判错"，**不做**传输 —— 传输在 `transport/a2a.ts`。
 */

/**
 * A2A 版本头的值。
 *
 * **必须显式携带**：实测（见设计稿 §9）缺头时 SDK 的 `validateVersion` 按 `'0.3'`
 * 去校验，而本仓卡片只声明 `1.0` ⇒ 直接 `-32009 VERSION_NOT_SUPPORTED`。
 * 这不是可选的兼容性细节，是能否通信的分水岭。
 */
export const A2A_VERSION = '1.0'

/** 版本头的名字（大小写不敏感，但按 SDK 常量写成形） */
export const A2A_VERSION_HEADER = 'A2A-Version'

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number | string
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: number | string | null
  readonly result?: unknown
  readonly error?: JsonRpcErrorObject
}

export function jsonRpcRequest(
  id: number | string,
  method: string,
  params?: unknown,
): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params }
}

export function isJsonRpcError(r: JsonRpcResponse): r is JsonRpcResponse & { error: JsonRpcErrorObject } {
  return r.error !== undefined && r.error !== null
}

/** 单调递增的请求 id（够用即可：本进程内唯一就行） */
export function createIdGen(): () => number {
  let n = 0
  return () => ++n
}
