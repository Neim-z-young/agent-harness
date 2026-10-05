/**
 * MCP 协议层（零 IO）：JSON-RPC 2.0 编解码 + 错误码 + 版本协商 + SSE 事件编解码。
 *
 * ## 为什么单独成模块、且**零 IO**
 * 协议层的正确性有一半在"**与客户端侧对偶**"上：我们编出的帧，`@harness/mcp-client` 的
 * `HttpTransport` / `parseSseChunk` 必须能原样解回来。把编解码做成纯函数后，这条对偶可以
 * 在**没有端口、没有 harness、没有网络**的条件下被钉住（见 `protocol.test.ts` 的往返用例）。
 *
 * ## 与既有两处进程内 server 的关系
 * `code-intel/src/server.ts` 与 `computer-use/src/server.ts` 各自内联了一份 JSON-RPC 壳
 * （`handle(msg, reply)` + switch）。本模块把那套壳中**可复用的部分**（错误码、方法分发约定）
 * 收成一处；两处旧 server 不动（它们是"自包含、零 harness 依赖"的刻意设计）。
 */

// ===== JSON-RPC 2.0 错误码 =====

export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603

/** JSON-RPC 的 id：字符串 / 数字；通知与解析失败时为 null */
export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

/** 通知：有 method、无 id（`id` 显式声明为 undefined，便于类型判别） */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
  id?: undefined
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

/**
 * 响应：有 id、无 method。
 *
 * `result` 与 `error` 二者必居其一 —— 用可选字段而不是联合类型，是因为**解码方**
 * 需要能容忍部分客户端只填其一的宽泛形态（协议要求二选一，但真实客户端未必严格）。
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcErrorObject
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** 解析失败（调用方据此回 `RPC_PARSE_ERROR`，且只能用 `id: null`） */
export class JsonRpcParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonRpcParseError'
  }
}

/**
 * 解析一条 JSON-RPC 报文。
 *
 * 只做"是不是一条 JSON-RPC 报文"的形状校验，**不校验 method 是否已知**（那是分发层的事）：
 * 协议层越少知道业务，越不会被业务带着漂移。
 *
 * @throws {JsonRpcParseError} JSON 不合语法 / 不是对象 / `jsonrpc` 字段不为 `'2.0'`
 */
export function parseMessage(raw: string): JsonRpcMessage {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (err) {
    throw new JsonRpcParseError(`非法 JSON：${(err as Error)?.message ?? String(err)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JsonRpcParseError('JSON-RPC 报文必须是对象')
  }
  const msg = value as Record<string, unknown>
  if (msg.jsonrpc !== '2.0') throw new JsonRpcParseError(`jsonrpc 字段必须为 "2.0"（收到 ${JSON.stringify(msg.jsonrpc)}）`)
  if (typeof msg.method !== 'string' && msg.id === undefined) {
    throw new JsonRpcParseError('既无 method 也无 id：不是请求 / 通知 / 响应中的任何一种')
  }
  return msg as unknown as JsonRpcMessage
}

/** 请求：有 method 且有 id */
export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return typeof (m as { method?: unknown }).method === 'string' && (m as JsonRpcRequest).id !== undefined
}

/** 通知：有 method 且无 id */
export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return typeof (m as { method?: unknown }).method === 'string' && (m as JsonRpcNotification).id === undefined
}

/** 响应：无 method 且有 id */
export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  // `JsonRpcResponse` 类型上没有 `method`，故经宽类型探针读 —— 判别函数本就在做"形状探测"，
  // 直接 as 成响应类型再取 method 会被类型系统正确地拒绝。
  return typeof (m as { method?: unknown }).method !== 'string' && (m as JsonRpcResponse).id !== undefined
}

export function encodeResult(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

export function encodeError(id: JsonRpcId, code: number, message: string, data?: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  })
}

// ===== 版本协商 =====

/**
 * 我们支持的协议版本，**按新→旧排列**（顺序即优先级，协商与能力判定都依赖它）。
 *
 * `2025-06-18` 是当前最新；`2025-03-26` 是 Streamable HTTP 落地的版本；
 * `2024-11-05` 是更早的 HTTP+SSE 时代。
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

export const LATEST_PROTOCOL_VERSION: string = SUPPORTED_PROTOCOL_VERSIONS[0]

/** elicitation 是 2025-06-18 引入的能力 */
export const ELICITATION_SINCE = '2025-06-18'

/**
 * 协商协议版本（MCP 规范行为）：
 * - 客户端要的版本在支持列表内 ⇒ **回显**它（让客户端留在自己熟悉的版本上）；
 * - 否则 ⇒ 返回我们的最新版，由客户端决定去留（它不接受就会自行断开）。
 *
 * 注意**不能**回落到"客户端说的任意版本"：回一个我们不认识的值，等于宣称自己实现了
 * 那版的全部语义 —— 那是把"未知"伪装成"已实现"。
 */
export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested
  }
  return LATEST_PROTOCOL_VERSION
}

/**
 * 该协议版本是否支持 elicitation。
 *
 * **未知版本一律 false**（Fail-Closed）：不认识就不假装支持，否则会在真实客户端上
 * 发出它解析不了的 server→client 请求，把"确认写操作"变成"卡死或静默失败"。
 */
export function supportsElicitation(version: string): boolean {
  const idx = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).indexOf(version)
  if (idx === -1) return false
  return idx <= (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).indexOf(ELICITATION_SINCE)
}

// ===== SSE 事件编解码 =====

/**
 * 编码一个 SSE 事件。
 *
 * 多行数据按 SSE 规范**逐行加 `data: ` 前缀**（单行 JSON 时退化为一行）——
 * 这样 `decodeSseEvents` 的 `join('\n')` 能逐字还原原始报文，不需要额外转义。
 */
export function encodeSseEvent(data: string): string {
  const lines = data.split('\n').map((l) => `data: ${l}`)
  return `${lines.join('\n')}\n\n`
}

/**
 * 从 SSE 文本块中解出 data 行，与 `@harness/mcp-client` 的 `parseSseChunk`
 * （`mcp-client/src/index.ts:198-211`）**逐字对偶**：同样按 `\r?\n\r?\n` 分事件、
 * 同样只取 `data:` 行、同样用 `\n` 拼接多行。
 *
 * 对偶不是巧合而是要求：这两份实现互为一对，任一侧改动都会立刻在跨包往返用例里暴露。
 * （不直接复用它的私有函数，是因为它是**客户端**的内部实现，且被刻意留作 client 私域。）
 */
export function decodeSseEvents(chunk: string): string[] {
  const messages: string[] = []
  const events = chunk.split(/\r?\n\r?\n/)
  for (const ev of events) {
    if (!ev.trim()) continue
    const dataLines = ev
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
    if (dataLines.length > 0) messages.push(dataLines.join('\n'))
  }
  return messages
}
