/**
 * 案 A 传输实现：A2A v1.0 over HTTP + SSE。
 *
 * 复用度是选它的全部理由（设计稿 §2.5）：`SendStreamingMessage` / `CancelTask`
 * 与 P1 做的服务端**同一套协议**，且已被官方 `a2a-tck` 外部验收过。
 *
 * 边界：
 * - 控制面走**另一条路径** `/harness/rpc`，与 `/a2a` 并列、共用 Bearer，
 *   但不做 A2A 版本校验、不进 AgentCard（`control.ts` 文件头有完整论证）。
 * - 本文件不 import `vscode`：只有 `participant.ts` 碰 VSCode API。
 */

import {
  A2A_VERSION,
  A2A_VERSION_HEADER,
  createIdGen,
  isJsonRpcError,
  jsonRpcRequest,
  type JsonRpcResponse,
} from '../protocol/jsonrpc'
import { SseDecoder } from '../protocol/sse'
import type { Sidecar } from '../sidecar'
import type { HarnessTransport, SidecarHandshake } from '../types'

/** 可注入的 fetch（测试用假实现；生产用 `globalThis.fetch`） */
export type FetchLike = typeof globalThis.fetch

export interface A2aTransportOptions {
  readonly sidecar: Sidecar
  readonly token?: string
  readonly fetchImpl?: FetchLike
}

export class TransportError extends Error {
  constructor(
    message: string,
    /** JSON-RPC 错误码（协议错误）或 HTTP 状态码（传输错误） */
    readonly code: number,
  ) {
    super(message)
    this.name = 'TransportError'
  }
}

export class A2aTransport implements HarnessTransport {
  private readonly fetchImpl: FetchLike
  private readonly nextId = createIdGen()

  constructor(private readonly opts: A2aTransportOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  async start(): Promise<SidecarHandshake> {
    return this.opts.sidecar.start()
  }

  // ---------------------------------------------------------------- 流式发送

  async *send(
    ctx: { contextId?: string; taskId?: string },
    text: string,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    const hs = this.opts.sidecar.endpoint

    // `messageId` 是幂等键：重复 ⇒ 服务端回放而不重复执行（P1-C）。
    // 故每次真实发送都必须新生成一个。
    const params: Record<string, unknown> = {
      message: {
        kind: 'message',
        role: 'user',
        messageId: `vscode-${Date.now()}-${this.nextId()}`,
        parts: [{ kind: 'text', text }],
        ...(ctx.contextId ? { contextId: ctx.contextId } : {}),
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      },
    }

    const res = await this.fetchImpl(hs.rpcUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(jsonRpcRequest(this.nextId(), 'SendStreamingMessage', params)),
      signal,
    })

    if (!res.ok) {
      // 传输层错误：没有 SSE 体可读，直接抛。这里**不**尝试 `res.json()` ——
      // 404 之类的非 JSON 体会让 `json()` 抛出一个掩盖真因的错误。
      throw new TransportError(`SendStreamingMessage 失败：HTTP ${res.status}`, res.status)
    }

    // ★ 预流错误必须在这里分流（真机踩过，见 docs/vscode-chat-sessions-spike.md §5c）：
    // A2A 的**预流错误**（任务已终态 / contextId 与任务不符 / 同会话并发 / 鉴权失败）走的是
    // `server.ts` 的 `serverErrorResponse` → `Response.json(...)`，也就是
    // **HTTP 200 + `application/json`**（JSON-RPC over HTTP 的惯例：错误在体里，状态码仍是 200）。
    // 无条件按 SSE 解帧 ⇒ `SseDecoder` 解出 **0 帧** ⇒ 调用方的 for-await 一次循环体都不进
    // ⇒ 表现为"这一轮正常结束、但什么都没有"，**错误被彻底吞掉**。
    // 实测：第二轮的消息带上第一轮的 `taskId` ⇒ `-32004 TASK_TERMINAL` 就是这样被吃掉的。
    //
    // 判据必须是 **content-type**，不能是状态码 —— 上述情形状态码**全是 200**。
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const text = await res.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new TransportError(
          `SendStreamingMessage 返回既非 SSE 也非 JSON（HTTP ${res.status}，ct=${contentType}）：${text.slice(0, 200)}`,
          res.status,
        )
      }
      // 原样吐出：`mapA2aEvent` 认得 `{jsonrpc,id,error}` 信封，会翻成 `kind:'error'`
      //（而非在此另造一套错误语义 —— 错误渲染只有一处定义）。
      yield parsed
      return
    }

    if (res.body === null) throw new TransportError('SSE 响应没有 body', -1)

    const decoder = new SseDecoder()
    const reader = res.body.getReader()
    const decoderText = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // 一帧可能被切成多次 read —— SseDecoder 持有残留缓冲正是为此
        for (const frame of decoder.push(decoderText.decode(value, { stream: true }))) {
          yield frame.data
        }
      }
      for (const frame of decoder.flush()) yield frame.data
    } finally {
      reader.releaseLock()
    }
  }

  // ---------------------------------------------------------------- 取消

  async cancel(taskId: string): Promise<void> {
    const hs = this.opts.sidecar.endpoint
    const res = await this.fetchImpl(hs.rpcUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(jsonRpcRequest(this.nextId(), 'CancelTask', { id: taskId })),
    })
    await expectOk(res, 'CancelTask')
  }

  // ---------------------------------------------------------------- 任务清单

  /**
   * `ListTasks`（A2A 协议方法）—— 面板"后台任务"分区的数据源。
   *
   * 走 `/a2a` 而不是 `/harness/rpc`：协议里有的方法不许搬进控制面（设计稿 §12.2）。
   * 服务端不认识它 ⇒ `MethodNotFound`，调用方按分区降级处理。
   */
  async listTasks(): Promise<unknown> {
    const hs = this.opts.sidecar.endpoint
    const res = await this.fetchImpl(hs.rpcUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(jsonRpcRequest(this.nextId(), 'ListTasks', { pageSize: 20 })),
    })
    return (await expectOk(res, 'ListTasks')).result
  }

  // ---------------------------------------------------------------- 控制面

  async control(method: string, params?: unknown): Promise<unknown> {
    const hs = this.opts.sidecar.endpoint
    const res = await this.fetchImpl(hs.controlUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(jsonRpcRequest(this.nextId(), method, params)),
    })
    // 控制面的错误码是**独立的一套**（`ControlErrorCode`），不复用 A2A 的 ——
    // 这里只当不透明数字传出去，解释权在调用方。
    return (await expectOk(res, method)).result
  }

  // ---------------------------------------------------------------- 生命周期

  async dispose(): Promise<void> {
    await this.opts.sidecar.dispose()
  }

  // ---------------------------------------------------------------- 内部

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      // **必须**：缺头 ⇒ SDK 按 '0.3' 校验 ⇒ -32009（实测，见设计稿 §9）
      [A2A_VERSION_HEADER]: A2A_VERSION,
    }
    if (this.opts.token && this.opts.token !== '') {
      h['authorization'] = `Bearer ${this.opts.token}`
    }
    return h
  }
}

/** 读完整响应并判错；返回解析后的 JSON-RPC 响应 */
async function expectOk(res: Response, what: string): Promise<JsonRpcResponse> {
  const text = await res.text()
  let parsed: JsonRpcResponse
  try {
    parsed = JSON.parse(text) as JsonRpcResponse
  } catch {
    throw new TransportError(`${what} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`, res.status)
  }
  if (isJsonRpcError(parsed)) {
    throw new TransportError(`${what} 被拒：${parsed.error.message}`, parsed.error.code)
  }
  return parsed
}
