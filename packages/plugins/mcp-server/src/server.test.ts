/**
 * 传输层 + 权限桥测试。
 *
 * ## 两种客户端形态，各测一半
 * 1. **真 `@harness/mcp-client`**（`HttpTransport` + `McpClient`）连自己 —— 这是协议层的
 *    "对偶性"证明：我们编的帧，真实客户端必须能解；它发的请求，我们必须能答。
 *    它的 `handleMessage` 对 server→client 请求一律回 `-32601`，**恰好就是**"客户端不支持
 *    elicitation"的真实形态 ⇒ 用它测 Fail-Closed 分支。
 * 2. **手工 fetch 客户端** —— 用 `decodeSseEvents` 逐帧读 SSE，能完整走完
 *    accept / decline / 超时三条分支（真客户端走不到这三条）。
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { Harness } from '@harness/core'
import { HttpTransport, McpClient } from '@harness/mcp-client'
import { type Schema, ToolPipeline, ToolRegistry, defineTool, withJsonSchema } from '@harness/tool'
import type { AnswerLike, AskInputLike, PromptLike } from './elicit'
import { decodeSseEvents } from './protocol'
import { type McpServerHandle, createMcpServer } from './server'

// ===== 测试用最小装配 =====

function passthrough(): Schema<Record<string, unknown>> {
  return {
    parse: (v) => v as Record<string, unknown>,
    safeParse: (v) => ({ success: true as const, data: v as Record<string, unknown> }),
  }
}

function makeTool(
  id: string,
  opts: {
    output?: unknown
    readOnly?: boolean
    requiresInteraction?: boolean
    /** 声明权限键后，pipeline 的 Step 4 才会跑（未声明 ⇒ 整体跳过权限） */
    permissionKey?: string
  } = {},
) {
  return defineTool({
    id,
    description: `${id} 描述`,
    inputSchema: withJsonSchema(passthrough(), {
      type: 'object',
      properties: { path: { type: 'string' } },
    }),
    isReadOnly: () => opts.readOnly ?? false,
    requiresUserInteraction: opts.requiresInteraction ?? false,
    ...(opts.permissionKey
      ? {
          permission: {
            key: opts.permissionKey,
            extractPatterns: (input: unknown) => [
              String((input as { path?: unknown } | null)?.path ?? ''),
            ] as never,
          },
        }
      : {}),
    async call() {
      return { ok: true, output: opts.output ?? `ok:${id}` }
    },
  })
}

/**
 * 记录型 ask 引擎。
 *
 * 只复刻 `core.resolvePermission` 的两步（`check` → 仍 ask 则 `ask`）——
 * 真实的 `resolvePermission` 是 core 内部函数、不导出，而插件层的**契约面**就是
 * `engine.check` / `engine.ask` / `setAsker` 这三处，测这三处即测到了接缝本身。
 */
class RecordingAskEngine {
  private asker?: (req: AskInputLike, prompt: PromptLike) => Promise<AnswerLike | undefined>
  readonly askedSessions: Array<string | undefined> = []
  readonly askedKeys: string[] = []

  setAsker(fn?: (req: AskInputLike, prompt: PromptLike) => Promise<AnswerLike | undefined>): void {
    this.asker = fn
  }

  getAsker(): typeof this.asker {
    return this.asker
  }

  updateRules(): void {
    /* noop */
  }

  async check(): Promise<{ behavior: 'ask' }> {
    return { behavior: 'ask' }
  }

  async ask(req: AskInputLike): Promise<{ behavior: 'allow' | 'deny' }> {
    this.askedSessions.push(req.sessionId)
    this.askedKeys.push(req.toolKey)
    const prompt: PromptLike = {
      toolKey: req.toolKey,
      patterns: req.patterns ?? [],
      sessionId: req.sessionId,
      summary: `权限请求 [${req.toolKey}]`,
      text: `权限请求 [${req.toolKey}]`,
    }
    const answer = this.asker ? await this.asker(req, prompt) : undefined
    return { behavior: answer === 'allow' ? 'allow' : 'deny' }
  }
}

function makeHarness(tools: unknown[], engine?: RecordingAskEngine): Harness {
  const registry = new ToolRegistry()
  registry.registerAll(tools as never)
  const pipeline = new ToolPipeline(
    engine
      ? {
          checkPermission: async (req) => {
            const d = await engine.check()
            if (d.behavior !== 'ask') return d
            return await engine.ask(req as AskInputLike)
          },
        }
      : {},
  )
  return { tools: registry, toolPipeline: pipeline, cwd: '/tmp' } as unknown as Harness
}

const servers: McpServerHandle[] = []
const clients: McpClient[] = []
const track = (s: McpServerHandle): McpServerHandle => (servers.push(s), s)
const trackClient = (c: McpClient): McpClient => (clients.push(c), c)

afterEach(async () => {
  for (const c of clients) c.close()
  clients.length = 0
  for (const s of servers) await s.stop()
  servers.length = 0
})

/** 逐帧读 SSE（用被测的 `decodeSseEvents`，顺带验证编解码对偶） */
async function* readSse(resp: Response): AsyncGenerator<string> {
  const reader = resp.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const boundary = buf.lastIndexOf('\n\n')
    if (boundary === -1) continue
    const complete = buf.slice(0, boundary + 2)
    buf = buf.slice(boundary + 2)
    for (const m of decodeSseEvents(complete)) yield m
  }
  if (buf.trim()) for (const m of decodeSseEvents(`${buf}\n\n`)) yield m
}

/** 手工客户端：initialize + 发出 tools/call，返回 sessionId 与 SSE 帧流 */
async function openCall(
  server: McpServerHandle,
  over: { version?: string; tool?: string; args?: Record<string, unknown> } = {},
): Promise<{ sid: string; frames: AsyncGenerator<string> }> {
  const initRes = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: over.version ?? '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    }),
  })
  const sid = initRes.headers.get('mcp-session-id')
  expect(sid).toBeTruthy()
  const callRes = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'mcp-session-id': sid! },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: over.tool ?? 'write_file', arguments: over.args ?? { path: '/x', content: 'y' } },
    }),
  })
  return { sid: sid as string, frames: readSse(callRes) }
}

async function answerElicit(server: McpServerHandle, sid: string, id: unknown, result: unknown): Promise<void> {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-session-id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  })
  expect(res.status).toBe(202)
}

// ===== 协议对齐：真客户端连自己 =====

describe('与 @harness/mcp-client 的 HttpTransport 对齐', () => {
  it('initialize 协商：回显客户端版本，返回 tools 能力与 serverInfo', async () => {
    const server = track(createMcpServer({ harness: makeHarness([makeTool('read_file', { readOnly: true })]), port: 0 }))
    const client = trackClient(new McpClient('self', new HttpTransport({ url: server.url })))
    await client.connect()
    expect(client.protocolVersion).toBe('2024-11-05') // McpClient 默认请求该版本 ⇒ 回显
    expect(client.serverCapabilities.tools).toBeDefined()
    expect(client.serverInfo.name).toBe('harness')
    expect(server.url).toContain('/mcp')
  })

  it('tools/list 直出 JSON Schema、Fail-Closed annotations，并排除不可暴露的工具', async () => {
    const server = track(
      createMcpServer({
        harness: makeHarness([
          makeTool('read_file', { readOnly: true }),
          makeTool('ask_user_question', { requiresInteraction: true }),
          makeTool('mcp__other__t'),
        ]),
        port: 0,
      }),
    )
    const client = trackClient(new McpClient('self', new HttpTransport({ url: server.url })))
    await client.connect()
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['read_file'])
    expect(tools[0]!.inputSchema).toEqual({ type: 'object', properties: { path: { type: 'string' } } })
    const raw = tools[0] as unknown as { annotations?: Record<string, unknown> }
    expect(raw.annotations).toEqual({ readOnlyHint: true, destructiveHint: false })
  })

  it('只读工具 tools/call 走通，返回 text content', async () => {
    const server = track(createMcpServer({ harness: makeHarness([makeTool('read_file', { readOnly: true })]), port: 0 }))
    const client = trackClient(new McpClient('self', new HttpTransport({ url: server.url })))
    await client.connect()
    const res = await client.callTool('read_file', { path: '/a' })
    expect(res.isError).toBe(false)
    expect(res.content?.[0]?.text).toBe('ok:read_file')
  })

  it('未知工具 / arguments 非对象 ⇒ 协议级错误（客户端 reject）', async () => {
    const server = track(createMcpServer({ harness: makeHarness([makeTool('read_file')]), port: 0 }))
    const client = trackClient(new McpClient('self', new HttpTransport({ url: server.url })))
    await client.connect()
    await expect(client.callTool('nope', {})).rejects.toThrow(/未知工具/)
    await expect(
      client.callTool('read_file', [] as unknown as Record<string, unknown>),
    ).rejects.toThrow(/arguments 必须是对象/)
  })

  it('prefix 生效：MCP 名字带前缀，调用也用带前缀的名字', async () => {
    const server = track(
      createMcpServer({ harness: makeHarness([makeTool('bash')]), port: 0, prefix: 'h_' }),
    )
    const client = trackClient(new McpClient('self', new HttpTransport({ url: server.url })))
    await client.connect()
    expect((await client.listTools()).map((t) => t.name)).toEqual(['h_bash'])
    expect((await client.callTool('h_bash', {})).isError).toBe(false)
  })
})

// ===== HTTP 边界 =====

describe('HTTP 边界：会话 / 鉴权 / 方法 / 端点', () => {
  it('无会话的非 initialize 请求 ⇒ 404', async () => {
    const server = track(createMcpServer({ harness: makeHarness([makeTool('read_file')]), port: 0 }))
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(404)
  })

  it('伪造会话 id ⇒ 404', async () => {
    const server = track(createMcpServer({ harness: makeHarness([makeTool('read_file')]), port: 0 }))
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'forged' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(404)
  })

  it('非法 JSON ⇒ -32700（且只能用 id:null 回）', async () => {
    const server = track(createMcpServer({ harness: makeHarness([]), port: 0 }))
    const res = await fetch(server.url, { method: 'POST', body: '{oops' })
    const body = (await res.json()) as { id: null; error: { code: number } }
    expect(body.id).toBeNull()
    expect(body.error.code).toBe(-32700)
  })

  it('未知方法 ⇒ -32601', async () => {
    const { sid } = await openCall(track(createMcpServer({ harness: makeHarness([]), port: 0 })), { tool: 'x' })
    const server = servers[servers.length - 1]!
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'resources/list' }),
    })
    const body = (await res.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32601)
  })

  it('Bearer token：缺/错 ⇒ 401，对 ⇒ 通过', async () => {
    const server = track(createMcpServer({ harness: makeHarness([makeTool('read_file')]), port: 0, token: 's3cr3t' }))
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect((await fetch(server.url, { method: 'POST', body })).status).toBe(401)
    expect(
      (await fetch(server.url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body })).status,
    ).toBe(401)
    expect(
      (await fetch(server.url, { method: 'POST', headers: { authorization: 'Bearer s3cr3t' }, body })).status,
    ).toBe(200)
  })

  it('DELETE 终止会话（204），随后该会话不可用（404）', async () => {
    const server = track(createMcpServer({ harness: makeHarness([makeTool('read_file')]), port: 0 }))
    const init = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    })
    const sid = init.headers.get('mcp-session-id') as string
    expect(server.sessions.has(sid)).toBe(true)
    expect((await fetch(server.url, { method: 'DELETE', headers: { 'mcp-session-id': sid } })).status).toBe(204)
    expect(server.sessions.has(sid)).toBe(false)
    const after = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    expect(after.status).toBe(404)
  })

  it('非 POST/DELETE 方法与错误路径 ⇒ 405 / 404', async () => {
    const server = track(createMcpServer({ harness: makeHarness([]), port: 0 }))
    expect((await fetch(server.url, { method: 'GET' })).status).toBe(405)
    expect((await fetch(`http://127.0.0.1:${server.port}/other`, { method: 'POST', body: '{}' })).status).toBe(404)
  })
})

// ===== 权限桥：三条 elicitation 分支 + Fail-Closed =====

describe('权限桥：ask ⇒ elicitation', () => {
  function setup(engine: RecordingAskEngine, opts: { elicitTtlMs?: number } = {}) {
    const server = track(
      createMcpServer({
        harness: makeHarness([makeTool('write_file', { permissionKey: 'write' })], engine),
        port: 0,
        ...(opts.elicitTtlMs !== undefined ? { elicitTtlMs: opts.elicitTtlMs } : {}),
      }),
    )
    // 插件层的包装形态：属于本 server 的询问走 elicitation，否则交回上一个 asker
    engine.setAsker((req, prompt) =>
      server.owns(req.sessionId) ? server.asker(req, prompt) : Promise.resolve(undefined),
    )
    return server
  }

  it('accept + confirm=true ⇒ 放行；询问带的 sessionId 是 MCP 会话 id（路由的基础）', async () => {
    const engine = new RecordingAskEngine()
    const server = setup(engine)
    const { sid, frames } = await openCall(server)
    const first = JSON.parse((await frames.next()).value as string) as {
      method: string
      id: string
      params: { message: string; requestedSchema: Record<string, unknown> }
    }
    expect(first.method).toBe('elicitation/create')
    // message 以 prompt.summary（`权限请求 [<权限键>] <patterns>`）为骨架
    expect(first.params.message).toContain('权限请求 [write]')
    expect(first.params.message).toContain('仅本次')
    expect(first.params.requestedSchema).toMatchObject({ required: ['confirm'] })

    await answerElicit(server, sid, first.id, { action: 'accept', content: { confirm: true } })
    const final = JSON.parse((await frames.next()).value as string) as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    expect(final.result.isError).toBe(false)
    expect(final.result.content[0]!.text).toBe('ok:write_file')

    // 归属打通：引擎看到的不是 agent 会话，而是 MCP 会话
    expect(engine.askedSessions).toEqual([sid])
    expect(server.sessions.has(engine.askedSessions[0])).toBe(true)
  })

  it('decline ⇒ 拒绝（工具级失败，isError 结果而非协议错误）', async () => {
    const engine = new RecordingAskEngine()
    const server = setup(engine)
    const { sid, frames } = await openCall(server)
    const first = JSON.parse((await frames.next()).value as string) as { id: string }
    await answerElicit(server, sid, first.id, { action: 'decline' })
    const final = JSON.parse((await frames.next()).value as string) as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    expect(final.result.isError).toBe(true)
    expect(final.result.content[0]!.text).toContain('permission denied')
  })

  it('accept 但 confirm 不为 true（缺字段）⇒ 同样拒绝（不因 action 是 accept 就放行）', async () => {
    const engine = new RecordingAskEngine()
    const server = setup(engine)
    const { sid, frames } = await openCall(server)
    const first = JSON.parse((await frames.next()).value as string) as { id: string }
    await answerElicit(server, sid, first.id, { action: 'accept', content: {} })
    const final = JSON.parse((await frames.next()).value as string) as { result: { isError: boolean } }
    expect(final.result.isError).toBe(true)
  })

  it('超时未答复 ⇒ 按 cancel 结算 ⇒ 拒绝（响应流不会永久挂住）', async () => {
    const engine = new RecordingAskEngine()
    const server = setup(engine, { elicitTtlMs: 30 })
    const { frames } = await openCall(server)
    const first = JSON.parse((await frames.next()).value as string) as { id: string }
    expect(first.id).toStartWith('elicit_')
    const final = JSON.parse((await frames.next()).value as string) as { result: { isError: boolean } }
    expect(final.result.isError).toBe(true)
  })

  it('客户端不支持 elicitation（旧协议版本）⇒ Fail-Closed 拒绝，且不发送 elicitation 请求', async () => {
    const engine = new RecordingAskEngine()
    const server = setup(engine)
    // 真客户端默认 2024-11-05：它的 handleMessage 对 server→client 请求回 -32601
    const client = trackClient(new McpClient('self', new HttpTransport({ url: server.url })))
    await client.connect()
    const res = await client.callTool('write_file', { path: '/x', content: 'y' })
    expect(res.isError).toBe(true)
    expect(res.content?.[0]?.text).toContain('permission denied')
    // 归属仍然打通（拒绝的原因是"客户端不支持"，不是"没走到权限"）
    expect(server.sessions.has(engine.askedSessions[0])).toBe(true)
  })

  it('旧协议版本 ⇒ 不发 elicitation 帧，首帧即最终拒绝（Fail-Closed 的行为分水岭）', async () => {
    const engine = new RecordingAskEngine()
    const server = setup(engine)
    const { frames } = await openCall(server, { version: '2024-11-05' })
    const first = JSON.parse((await frames.next()).value as string) as {
      id: unknown
      result?: { isError?: boolean }
    }
    // 首帧就是 tools/call 的响应（id=2）—— 若照发 elicitation，"第一帧"会是 elicit_* 的请求帧
    expect(first.id).toBe(2)
    expect(first.result?.isError).toBe(true)
    expect(engine.askedSessions).toHaveLength(1) // 权限检查确实跑过（不是"没走到权限"）
  })

  it('路由：不属于本 server 的会话（TUI 侧）交回原 asker，MCP 不接管', async () => {
    const engine = new RecordingAskEngine()
    const server = setup(engine)
    const delegated: string[] = []
    engine.setAsker((req, prompt) =>
      server.owns(req.sessionId)
        ? server.asker(req, prompt)
        : (delegated.push(req.toolKey), Promise.resolve('allow' as AnswerLike)),
    )
    const d = await engine.ask({ toolKey: 'bash', patterns: ['rm -rf /'], sessionId: 'tui-session' })
    expect(d.behavior).toBe('allow') // 原 asker 的答复被采纳
    expect(delegated).toEqual(['bash'])
    expect(server.sessions.size).toBe(0) // 全程没有 MCP 会话参与
  })

  it('elicitation 答复必须带合法会话（伪造答复 ⇒ 404，不结算）', async () => {
    const engine = new RecordingAskEngine()
    const server = setup(engine)
    const { frames } = await openCall(server)
    const first = JSON.parse((await frames.next()).value as string) as { id: string }
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'forged' },
      body: JSON.stringify({ jsonrpc: '2.0', id: first.id, result: { action: 'accept', content: { confirm: true } } }),
    })
    expect(res.status).toBe(404)
    expect(server.sessions.pendingCount).toBe(1) // 仍待决
  })
})
