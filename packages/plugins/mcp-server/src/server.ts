/**
 * MCP Streamable HTTP server（MCP 2025-03-26+）。
 *
 * ## 与 `@harness/mcp-client` 的 `HttpTransport` 逐条对齐（它是本 server 的"对侧规范"）
 * | 面 | 客户端行为 | 本 server |
 * |---|---|---|
 * | 请求 | `POST` + `Accept: application/json, text/event-stream` | 两种响应都支持，按 `Accept` 选 |
 * | 会话 | 从响应头取 `Mcp-Session-Id`，后续请求带上 | `initialize` **必带**该头；无/非法会话 ⇒ 404 |
 * | JSON 响应 | 整体当一条消息 | 单请求单响应时走这条 |
 * | SSE 响应 | 按 `\n\n` 切帧、取 `data:` 行 | **需要在响应中途插消息时**才走（即 elicitation） |
 * | `202` | 视为"响应在后续流里" | 客户端 POST 回 elicitation 答复时返回 202 |
 * | `DELETE` | （客户端未用） | 终止会话 |
 *
 * ## 三条刻意的设计
 * 1. **只监听回环**（默认 `127.0.0.1`）：暴露的是本机 harness 的工具集（含写工具），
 *    绑 `0.0.0.0` 等于把工作目录的写权限开到局域网。
 * 2. **`sessionId` 用 MCP 会话 id**：`tools/call` 组装 `ToolContext` 时填的是 MCP 会话 id，
 *    于是权限桥的 `asker` 能凭 `req.sessionId` 判断"这次询问属于 MCP 还是 TUI 里的 Agent"。
 *    这不是巧合 —— 两条链路的会话标识**必须**同源，否则包装型 asker 无从路由。
 * 3. **`GET` 一期不做**：server→client 推送（elicitation）走 POST 内联 SSE 已足够；
 *    过早开长连会引入心跳/重连/多路复用的复杂度。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Harness } from '@harness/core'
import type { ToolContext } from '@harness/tool'
import {
  type AnswerLike,
  type AskInputLike,
  type PromptLike,
  answerFromElicit,
  buildElicitParams,
} from './elicit'
import {
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  encodeError,
  encodeResult,
  encodeSseEvent,
  isNotification,
  isRequest,
  isResponse,
  negotiateProtocolVersion,
  parseMessage,
  supportsElicitation,
} from './protocol'
import { McpSessionTable, type ElicitAnswer, type McpSession } from './session'
import { type ToolExposureOptions, buildToolIndex, toMcpCallResult } from './tools'

export const DEFAULT_MCP_PORT = 7331
export const DEFAULT_MCP_PATH = '/mcp'

export type McpLogLevel = 'info' | 'warn' | 'error'
export type McpLogger = (level: McpLogLevel, message: string, meta?: unknown) => void

export interface McpServerOptions {
  harness: Harness
  /** 监听端口；`0` = 由系统分配。缺省 7331 */
  port?: number
  /** 端点路径，缺省 `/mcp` */
  path?: string
  /** 可选 Bearer token；给了就强制校验 */
  token?: string
  /** 监听地址，缺省 `127.0.0.1`（**不要**改成 0.0.0.0） */
  hostname?: string
  /** 工具名前缀（缺省无前缀） */
  prefix?: string
  /** elicitation 等待上限（毫秒） */
  elicitTtlMs?: number
  serverName?: string
  serverVersion?: string
  log?: McpLogger
}

export interface McpServerHandle {
  readonly url: string
  readonly port: number
  readonly path: string
  readonly sessions: McpSessionTable
  /** 该 sessionId 是否属于本 server（包装型 asker 据此路由） */
  owns(sessionId?: string): boolean
  /**
   * 在当前 MCP 请求的异步上下文里发起一次 elicitation 确认。
   * 不在该上下文里（`AsyncLocalStorage` 无值）⇒ 返回 `undefined`（调用方按 deny 处理）。
   */
  elicitAsk(req: AskInputLike, prompt: PromptLike): Promise<AnswerLike | undefined>
  /**
   * 现成的询问接缝，形状与 `@harness/host` 的 `PermissionAsker` 一致（此处结构化声明，
   * 避免反向依赖 host 形成包级循环）。宿主包装用法：
   * ```ts
   * const prev = engine.getAsker?.()
   * engine.setAsker((req, prompt) => handle.owns(req.sessionId) ? handle.asker(req, prompt) : prev?.(req, prompt))
   * ```
   */
  asker(req: AskInputLike, prompt: PromptLike): Promise<AnswerLike | undefined>
  stop(): Promise<void>
}

interface ElicitContext {
  sessionId: string
  /** 本次响应能否承载 elicitation（= 客户端协议版本支持，且响应通道是 SSE） */
  canElicit: boolean
  emit: (frame: string) => void
}

/** 把客户端对 elicitation 的答复（JSON-RPC response）转成三态 */
function answerFromResponse(msg: JsonRpcResponse): ElicitAnswer {
  // 客户端回了一个错误（典型：不支持 elicitation 的客户端回 -32601）⇒ 按 cancel 结算。
  // 这里必须显式判 error：若只看 result 会得到 undefined，最终虽也 deny，但会少一次
  // 可观测的"客户端不支持"信号，排查时无从区分"用户拒绝"与"客户端没实现"。
  if (msg.error) return { action: 'cancel' }
  const r = msg.result as { action?: unknown; content?: unknown } | undefined
  const action = r?.action
  if (action === 'accept' || action === 'decline' || action === 'cancel') {
    const content =
      r?.content && typeof r.content === 'object' && !Array.isArray(r.content)
        ? (r.content as Record<string, unknown>)
        : undefined
    return { action, content }
  }
  return { action: 'cancel' }
}

/**
 * 创建一个 MCP server（立即开始监听）。
 *
 * 返回的 handle 不持有 `PermissionEngine` —— 装/卸 asker 是**插件层**的事
 * （它才知道怎么保留并委派原 asker）。本层只负责"能问"与"问得对不对"。
 */
export function createMcpServer(opts: McpServerOptions): McpServerHandle {
  const harness = opts.harness
  const path = opts.path ?? DEFAULT_MCP_PATH
  const hostname = opts.hostname ?? '127.0.0.1'
  const token = opts.token
  const log: McpLogger = opts.log ?? (() => {})
  const exposure: ToolExposureOptions = opts.prefix ? { prefix: opts.prefix } : {}
  const sessions = new McpSessionTable(
    opts.elicitTtlMs !== undefined ? { elicitTtlMs: opts.elicitTtlMs } : {},
  )
  const als = new AsyncLocalStorage<ElicitContext>()

  const jsonResponse = (frame: string, extra: Record<string, string> = {}): Response =>
    new Response(frame, {
      status: 200,
      headers: { 'content-type': 'application/json', ...extra },
    })

  /** tools/call 的工具上下文。**sessionId 必须是 MCP 会话 id** —— 权限桥的归属来源 */
  function toolContext(session: McpSession, signal: AbortSignal): ToolContext {
    const now = Date.now()
    return {
      sessionId: session.id,
      agentId: 'mcp-server',
      messageId: `mcp_${now}`,
      toolUseId: `mcp_call_${now}_${Math.random().toString(36).slice(2, 8)}`,
      signal,
      variables: {},
      cwd: harness.cwd,
    }
  }

  async function handleToolCall(session: McpSession, msg: JsonRpcRequest, signal: AbortSignal): Promise<string> {
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown }
    if (typeof params.name !== 'string' || params.name === '') {
      return encodeError(msg.id, RPC_INVALID_PARAMS, 'tools/call 缺少 name')
    }
    // 每次都重建索引：工具可在运行期注册/注销（/tools --global 启停），
    // 复用一份快照会让"列表里有、调用说没有"。这里的成本是一次 Map 构造，可忽略。
    const tool = buildToolIndex(harness.tools, exposure).byName.get(params.name)
    if (!tool) return encodeError(msg.id, RPC_INVALID_PARAMS, `未知工具: ${params.name}`)

    const args = params.arguments ?? {}
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return encodeError(msg.id, RPC_INVALID_PARAMS, 'tools/call 的 arguments 必须是对象')
    }
    try {
      // 必须走流水线（不裸调 tool.call）：否则绕过权限检查与 pre/post hooks，
      // 表现为"MCP 调用的写操作不弹确认、也不进遥测"。
      const result = await harness.toolPipeline.execute(tool, args, toolContext(session, signal))
      return encodeResult(msg.id, toMcpCallResult(result))
    } catch (err) {
      // 工具级失败（权限拒绝 / schema 校验失败 / 工具内抛错）在 MCP 语义下是
      // **`isError` 结果**，不是协议错误。用 -32603 会让客户端抛异常、IDE 只显示
      // "请求失败"，用户看不到"为什么被拒" —— 而权限拒绝恰恰最需要看清原因。
      const message = (err as Error)?.message ?? String(err)
      return encodeResult(msg.id, { content: [{ type: 'text', text: message }], isError: true })
    }
  }

  async function dispatch(session: McpSession, msg: JsonRpcRequest, signal: AbortSignal): Promise<string> {
    switch (msg.method) {
      case 'ping':
        return encodeResult(msg.id, {})
      case 'tools/list':
        return encodeResult(msg.id, { tools: buildToolIndex(harness.tools, exposure).descriptors })
      case 'tools/call':
        return await handleToolCall(session, msg, signal)
      default:
        return encodeError(msg.id, RPC_METHOD_NOT_FOUND, `Method not found: ${msg.method}`)
    }
  }

  async function elicitAsk(req: AskInputLike, prompt: PromptLike): Promise<AnswerLike | undefined> {
    const ctx = als.getStore()
    if (!ctx || ctx.sessionId !== req.sessionId) return undefined
    if (!ctx.canElicit) {
      log('warn', 'mcp: 客户端不支持 elicitation，写操作按拒绝处理', { toolKey: req.toolKey })
      return 'deny'
    }
    const { id, promise } = sessions.registerElicit(ctx.sessionId, prompt.summary)
    ctx.emit(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'elicitation/create',
        params: buildElicitParams(req, prompt),
      }),
    )
    return answerFromElicit(await promise)
  }

  const owns = (sessionId?: string): boolean => sessions.has(sessionId)

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname !== path) return new Response('Not Found', { status: 404 })

    if (token !== undefined && req.headers.get('authorization') !== `Bearer ${token}`) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      })
    }

    if (req.method === 'DELETE') {
      const sid = req.headers.get('mcp-session-id') ?? undefined
      if (!sessions.has(sid)) return new Response('Session Not Found', { status: 404 })
      sessions.delete(sid as string)
      return new Response(null, { status: 204 })
    }
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, DELETE' } })
    }

    const raw = await req.text()
    let msg
    try {
      msg = parseMessage(raw)
    } catch (err) {
      // 解析失败只能用 id: null 回（此时根本读不出请求 id）
      return jsonResponse(encodeError(null, RPC_PARSE_ERROR, (err as Error)?.message ?? String(err)))
    }

    // 答复 / 通知的分支**刻意放在会话校验之后**（见 ④⑤⑥）：放在这里等于让
    // "无会话也能结算 elicitation"，那是可被伪造的一条路。

    // ③ initialize：建会话，响应头必带 Mcp-Session-Id
    if (isRequest(msg) && msg.method === 'initialize') {
      const params = (msg.params ?? {}) as { protocolVersion?: unknown }
      const version = negotiateProtocolVersion(params.protocolVersion)
      const session = sessions.create(version, supportsElicitation(version))
      log('info', 'mcp: 会话建立', {
        sessionId: session.id,
        protocolVersion: version,
        elicitation: session.elicitation,
      })
      return jsonResponse(
        encodeResult(msg.id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: opts.serverName ?? 'harness', version: opts.serverVersion ?? '0.1.0' },
        }),
        { 'mcp-session-id': session.id },
      )
    }

    // ④ 其余**一切**（含 elicitation 答复与通知）都必须带合法会话。
    //    把答复也纳入校验：否则伪造一个答案（猜 id）就能替用户"同意"一次写操作 ——
    //    虽然有 uuid 兜底，但会话校验是更硬的一道，且客户端（含 mcp-client）本就会带。
    const session = sessions.get(req.headers.get('mcp-session-id') ?? undefined)
    if (!session) return new Response('Session Not Found', { status: 404 })
    sessions.touch(session.id)

    // ⑤ 客户端答复 elicitation：无 method、有 id
    if (isResponse(msg)) {
      const hit = sessions.resolveElicit(String(msg.id), answerFromResponse(msg))
      return new Response(null, { status: hit ? 202 : 404 })
    }
    // ⑥ 通知（notifications/initialized 等）：无需响应
    if (isNotification(msg)) return new Response(null, { status: 202 })
    if (!isRequest(msg)) {
      return jsonResponse(encodeError(null, RPC_INVALID_REQUEST, '既非请求也非通知'))
    }

    const signal = new AbortController().signal
    const acceptsSse = (req.headers.get('accept') ?? '').includes('text/event-stream')

    // 不走 SSE ⇒ 单请求单响应。此路径**无法**承载 elicitation ⇒ 写操作 Fail-Closed 拒绝
    if (!acceptsSse) {
      const ctx: ElicitContext = { sessionId: session.id, canElicit: false, emit: () => {} }
      const frame = await als.run(ctx, () => dispatch(session, msg, signal))
      return jsonResponse(frame, { 'mcp-session-id': session.id })
    }

    // SSE 流式：中途可插入 elicitation 请求帧
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel() {
        // 客户端断开：后续 enqueue 会抛，这里把引用清掉让 emit 变成 no-op
        controller = undefined
      },
    })
    const ctx: ElicitContext = {
      sessionId: session.id,
      canElicit: session.elicitation,
      emit: (frame) => {
        try {
          controller?.enqueue(encoder.encode(encodeSseEvent(frame)))
        } catch {
          controller = undefined
        }
      },
    }
    void als.run(ctx, async () => {
      let frame: string
      try {
        frame = await dispatch(session, msg, signal)
      } catch (err) {
        frame = encodeError(msg.id, RPC_INTERNAL_ERROR, (err as Error)?.message ?? String(err))
      }
      ctx.emit(frame)
      try {
        controller?.close()
      } catch {
        /* 已被 cancel */
      }
    })
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'mcp-session-id': session.id,
      },
    })
  }

  const server = Bun.serve({
    hostname,
    port: opts.port ?? DEFAULT_MCP_PORT,
    fetch: (req) => handle(req),
  })

  // `server.port` 在 bun-types 里是可选（unix socket 场景无端口）⇒ 回落到请求值/缺省值
  const actualPort: number = server.port ?? opts.port ?? DEFAULT_MCP_PORT
  const url = `http://${hostname}:${actualPort}${path}`

  return {
    url,
    port: actualPort,
    path,
    sessions,
    owns,
    elicitAsk,
    asker: (req, prompt) => elicitAsk(req, prompt),
    async stop() {
      sessions.clear()
      await server.stop(true)
    },
  }
}

/** 便于测试断言：JsonRpcId 的字符串化（server 侧 id 可能是 string/number/null） */
export function idOf(id: JsonRpcId): string {
  return id === null ? 'null' : String(id)
}
