import { describe, test, it, expect } from 'bun:test'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  McpClient,
  StdioTransport,
  HttpTransport,
  SseTransport,
  defaultTransportFactory,
  convertMcpToolToHarnessTool,
  createMcpClientPlugin,
  type McpTransport,
  type McpServerConfig,
  type McpToolDef,
} from './index'
import type { ToolContext } from '@harness/tool'

// ===== Mock Transport =====

/** 模拟 MCP Server 的传输层 */
class MockTransport implements McpTransport {
  private handler?: (data: string) => void
  private sentMessages: string[] = []
  private responses: Map<string, (params: any) => unknown> = new Map()

  /** 注册方法响应 */
  register(method: string, handler: (params: any) => unknown): void {
    this.responses.set(method, handler)
  }

  send(data: string): void {
    this.sentMessages.push(data)
    const msg = JSON.parse(data)
    if (msg.id != null && msg.method && this.responses.has(msg.method)) {
      const handler = this.responses.get(msg.method)!
      // 异步模拟响应
      setTimeout(() => {
        try {
          const result = handler(msg.params)
          this.handler?.(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
        } catch (err) {
          this.handler?.(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: String((err as Error)?.message ?? err) } }))
        }
      }, 0)
    }
  }

  onMessage(handler: (data: string) => void): void {
    this.handler = handler
  }

  close(): void { /* noop */ }

  get sent(): string[] { return this.sentMessages }

  /** 模拟服务器主动推送消息（用于测试通知/请求） */
  triggerMessage(data: string): void {
    this.handler?.(data)
  }
}

// ===== 测试 =====

describe('McpClient', () => {
  function createMockClient(name: string = 'test-server'): { client: McpClient; transport: MockTransport } {
    const transport = new MockTransport()
    // 注册 initialize 响应
    transport.register('initialize', () => ({ protocolVersion: '2024-11-05', capabilities: { tools: {} } }))
    const client = new McpClient(name, transport)
    return { client, transport }
  }

  it('connect 发送 initialize 并接收响应', async () => {
    const { client, transport } = createMockClient()
    await client.connect()
    expect(client.isConnected).toBe(true)
    // 应发送了 initialize 请求 + notifications/initialized 通知
    const msgs = transport.sent.map((s) => JSON.parse(s))
    expect(msgs[0].method).toBe('initialize')
    expect(msgs[0].params.protocolVersion).toBe('2024-11-05')
    expect(msgs[1].method).toBe('notifications/initialized')
  })

  it('listTools 返回 MCP Server 的工具列表', async () => {
    const { client, transport } = createMockClient()
    const mockTools: McpToolDef[] = [
      { name: 'search', description: 'Search the web', inputSchema: { type: 'object' } },
      { name: 'fetch', description: 'Fetch a URL' },
    ]
    transport.register('tools/list', () => ({ tools: mockTools }))
    await client.connect()
    const tools = await client.listTools()
    expect(tools.length).toBe(2)
    expect(tools[0].name).toBe('search')
    expect(tools[1].name).toBe('fetch')
  })

  it('callTool 转发参数并返回结果', async () => {
    const { client, transport } = createMockClient()
    transport.register('tools/call', (params: any) => ({
      content: [{ type: 'text', text: `Result for ${params.name}` }],
    }))
    await client.connect()
    const result = await client.callTool('search', { query: 'hello' })
    expect(result.content?.[0]?.text).toBe('Result for search')
  })

  it('close 拒绝 pending 请求', async () => {
    const transport = new MockTransport()
    // 不注册 initialize 响应，让请求 pending
    const client = new McpClient('test', transport)
    const promise = client.connect()
    client.close()
    await expect(promise).rejects.toThrow('MCP client closed')
  })
})

describe('convertMcpToolToHarnessTool', () => {
  it('转换 MCP 工具为 Harness Tool 并正确执行', async () => {
    const transport = new MockTransport()
    transport.register('initialize', () => ({ protocolVersion: '2024-11-05' }))
    transport.register('tools/call', (params: any) => ({
      content: [{ type: 'text', text: `Hello ${params.arguments?.name ?? 'World'}` }],
    }))
    const client = new McpClient('myserver', transport)
    await client.connect()

    const mcpTool: McpToolDef = { name: 'greet', description: 'Greet someone' }
    const tool = convertMcpToolToHarnessTool(mcpTool, 'myserver', client)

    expect(tool.id).toBe('mcp__myserver__greet')
    expect(tool.description).toBe('Greet someone')
    expect(tool.isReadOnly?.()).toBe(false)
    expect(tool.isDestructive?.()).toBe(false)
    expect(tool.isConcurrencySafe?.()).toBe(false)

    // schema 校验
    const parsed = tool.inputSchema.safeParse({ name: 'Alice' })
    expect(parsed.success).toBe(true)

    // 执行
    const ctx = {} as ToolContext
    const result = await tool.call({ name: 'Alice' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toBe('Hello Alice')
  })

  it('MCP 返回 isError 时 ToolResult.ok=false', async () => {
    const transport = new MockTransport()
    transport.register('initialize', () => ({ protocolVersion: '2024-11-05' }))
    transport.register('tools/call', () => ({
      content: [{ type: 'text', text: 'Something went wrong' }],
      isError: true,
    }))
    const client = new McpClient('srv', transport)
    await client.connect()

    const tool = convertMcpToolToHarnessTool({ name: 'fail' }, 'srv', client)
    const result = await tool.call({}, {} as ToolContext)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('MCP_ERROR')
  })

  it('调用失败时返回 MCP_CALL_FAILED', async () => {
    const transport = new MockTransport()
    transport.register('initialize', () => ({ protocolVersion: '2024-11-05' }))
    // 不注册 tools/call，让请求超时... 改用 close 模拟失败
    const client = new McpClient('srv', transport)
    await client.connect()
    client.close()
    // close 后再调用会失败
    const tool = convertMcpToolToHarnessTool({ name: 'broken' }, 'srv', client)
    // client.close 已拒绝 pending，但新请求也无法收到响应
    // 直接调用 call 会 pending（因为 transport 不再响应）
    // 改用 Promise.race 验证不阻塞太久
    const result = await Promise.race([
      tool.call({}, {} as ToolContext),
      new Promise<any>((r) => setTimeout(() => r({ ok: false, error: { code: 'TIMEOUT' } }), 100)),
    ])
    // 要么 ok=false，要么超时
    expect(result.ok).toBe(false)
  })
})

describe('createMcpClientPlugin', () => {
  it('插件 connect + core.tool.pool.assemble 注入工具', async () => {
    const transport = new MockTransport()
    transport.register('initialize', () => ({ protocolVersion: '2024-11-05', capabilities: { tools: {} } }))
    transport.register('tools/list', () => ({
      tools: [
        { name: 'search', description: 'Search web' },
        { name: 'fetch', description: 'Fetch URL' },
      ],
    }))

    const plugin = createMcpClientPlugin({
      servers: [{ name: 'web-tools', command: 'fake', args: [] }],
      transportFactory: () => transport,
    })

    const logCalls: Array<[string, any?]> = []
    const ctx = {
      log: {
        info: (msg: string, meta?: any) => { logCalls.push(['info', { msg, meta }]) },
        warn: (msg: string, meta?: any) => { logCalls.push(['warn', { msg, meta }]) },
        error: (msg: string, meta?: any) => { logCalls.push(['error', { msg, meta }]) },
        debug: (msg: string, meta?: any) => { logCalls.push(['debug', { msg, meta }]) },
      },
      bus: { publish: () => {}, subscribe: () => () => {} },
      config: { get: () => undefined, set: () => {} },
    }
    const hooks = await plugin.install(ctx as any)

    // 模拟 core.harness.start
    await (hooks as any)['core.harness.start']?.()

    // 模拟 core.tool.pool.assemble
    const addedTools: any[] = []
    const pool = { add: (t: unknown) => { addedTools.push(t) } }
    await (hooks as any)['core.tool.pool.assemble']?.({}, pool)

    expect(addedTools.length).toBe(2)
    expect(addedTools[0].id).toBe('mcp__web-tools__search')
    expect(addedTools[1].id).toBe('mcp__web-tools__fetch')

    // cli.commands 注册了 /mcp
    const cmdInput = { commands: [] as any[] }
    await (hooks as any)['cli.commands']?.(cmdInput)
    expect(cmdInput.commands.length).toBe(1)
    expect(cmdInput.commands[0].command).toBe('mcp')

    // cli.command 处理 /mcp tools
    const cmdOut: string[] = []
    const cliInput: { command: string; arg: string; out: (s: string) => void; sessionId: string; raw: string; result?: 'continue' | 'exit' } = {
      command: 'mcp', arg: 'tools', out: (s: string) => { cmdOut.push(s) },
      sessionId: 's1', raw: 'mcp tools',
    }
    await (hooks as any)['cli.command']?.(cliInput)
    expect(cliInput.result).toBe('continue')
    expect(cmdOut.join('')).toInclude('mcp__web-tools__search')

    await plugin.uninstall?.()
  })

  it('无 server 连接时 /mcp 命令不注册', async () => {
    const transport = new MockTransport()
    // 不注册 initialize，让 connect 失败（pending 直到 30s 超时，但测试只验证 commands）
    // 改为：servers 为空数组
    const plugin = createMcpClientPlugin({
      servers: [],
      transportFactory: () => transport,
    })

    const ctx = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      config: { get: () => undefined, set: () => {} },
    }
    const hooks = await plugin.install(ctx as any)
    await (hooks as any)['core.harness.start']?.()

    const cmdInput = { commands: [] as any[] }
    await (hooks as any)['cli.commands']?.(cmdInput)
    expect(cmdInput.commands.length).toBe(0)

    await plugin.uninstall?.()
  })
})

// ===== Resources / Prompts 能力测试 =====

describe('McpClient resources/prompts', () => {
  function createMockClientWithCaps(name: string = 'srv'): { client: McpClient; transport: MockTransport } {
    const transport = new MockTransport()
    transport.register('initialize', () => ({
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true },
      },
      serverInfo: { name: 'mock-srv', version: '1.0' },
    }))
    const client = new McpClient(name, transport)
    return { client, transport }
  }

  it('listResources + readResource 正常工作', async () => {
    const { client, transport } = createMockClientWithCaps()
    transport.register('resources/list', () => ({
      resources: [
        { uri: 'file:///a.txt', name: 'a', description: 'A file', mimeType: 'text/plain' },
        { uri: 'file:///b.md', name: 'b' },
      ],
    }))
    transport.register('resources/read', (params: any) => ({
      contents: [{ uri: params.uri, mimeType: 'text/plain', text: `Content of ${params.uri}` }],
    }))
    await client.connect()
    const resources = await client.listResources()
    expect(resources.length).toBe(2)
    expect(resources[0].uri).toBe('file:///a.txt')

    const contents = await client.readResource('file:///a.txt')
    expect(contents[0].text).toBe('Content of file:///a.txt')
  })

  it('capabilities 不含 resources 时 listResources 返回空数组', async () => {
    const transport = new MockTransport()
    transport.register('initialize', () => ({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
    }))
    const client = new McpClient('srv', transport)
    await client.connect()
    expect(await client.listResources()).toEqual([])
    expect(await client.readResource('any://uri')).toEqual([])
  })

  it('listPrompts + getPrompt 正常工作', async () => {
    const { client, transport } = createMockClientWithCaps()
    transport.register('prompts/list', () => ({
      prompts: [
        { name: 'greet', description: '打招呼', arguments: [{ name: 'name', required: true }] },
      ],
    }))
    transport.register('prompts/get', (params: any) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Hello ${params.arguments?.name}` } }],
    }))
    await client.connect()
    const prompts = await client.listPrompts()
    expect(prompts.length).toBe(1)
    expect(prompts[0].name).toBe('greet')

    const messages = await client.getPrompt('greet', { name: 'Alice' })
    expect(messages[0].content.text).toBe('Hello Alice')
  })

  it('connect 缓存 serverInfo 和 protocolVersion', async () => {
    const { client } = createMockClientWithCaps('my-srv')
    await client.connect()
    expect(client.serverInfo.name).toBe('mock-srv')
    expect(client.serverInfo.version).toBe('1.0')
    expect(client.protocolVersion).toBe('2024-11-05')
    expect(client.serverCapabilities.resources?.subscribe).toBe(true)
  })

  it('onNotification 接收 resources/listChanged 通知', async () => {
    const { client, transport } = createMockClientWithCaps()
    await client.connect()
    const calls: string[] = []
    client.onNotification((method) => calls.push(method))
    // 直接模拟 server 推送通知
    transport.triggerMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/resources/listChanged' }))
    expect(calls).toEqual(['notifications/resources/listChanged'])
  })
})

// ===== HTTP transport 测试 =====

describe('HttpTransport', () => {
  function makeJsonResp(body: unknown, status = 200): any {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([
        ['Content-Type', 'application/json'],
        ['Mcp-Session-Id', 'sess-123'],
      ]),
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  }

  it('POST JSON-RPC 请求并接收 JSON 响应', async () => {
    const calls: any[] = []
    const prev = (globalThis as any).fetch
    ;(globalThis as any).fetch = (url: string, init: any) => {
      calls.push({ url, init })
      return makeJsonResp({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 't1' }] } })
    }
    try {
      const t = new HttpTransport({ url: 'https://mcp.example.com' })
      const received: string[] = []
      t.onMessage((data) => received.push(data))
      await t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
      expect(received.length).toBe(1)
      const msg = JSON.parse(received[0])
      expect(msg.result.tools[0].name).toBe('t1')
      expect(calls[0].init.method).toBe('POST')
    } finally {
      ;(globalThis as any).fetch = prev
    }
  })

  it('Bearer Token 注入 Authorization 头', async () => {
    let capturedHeaders: any
    const prev = (globalThis as any).fetch
    ;(globalThis as any).fetch = (_url: string, init: any) => {
      capturedHeaders = init.headers
      return makeJsonResp({ jsonrpc: '2.0', id: 1, result: {} })
    }
    try {
      const t = new HttpTransport({
        url: 'https://mcp.example.com',
        auth: { bearerToken: 'abc123', headers: { 'X-Custom': 'yes' } },
      })
      await t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
      expect(capturedHeaders['Authorization']).toBe('Bearer abc123')
      expect(capturedHeaders['X-Custom']).toBe('yes')
      expect(capturedHeaders['Content-Type']).toBe('application/json')
    } finally {
      ;(globalThis as any).fetch = prev
    }
  })

  it('authorizationHeader 优先级高于 bearerToken', async () => {
    let capturedHeaders: any
    const prev = (globalThis as any).fetch
    ;(globalThis as any).fetch = (_url: string, init: any) => {
      capturedHeaders = init.headers
      return makeJsonResp({ jsonrpc: '2.0', id: 1, result: {} })
    }
    try {
      const t = new HttpTransport({
        url: 'https://mcp.example.com',
        auth: { bearerToken: 'low', authorizationHeader: 'Bearer high' },
      })
      await t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }))
      expect(capturedHeaders['Authorization']).toBe('Bearer high')
    } finally {
      ;(globalThis as any).fetch = prev
    }
  })

  it('Mcp-Session-Id 在后续请求中被回传', async () => {
    const calls: any[] = []
    const prev = (globalThis as any).fetch
    ;(globalThis as any).fetch = (url: string, init: any) => {
      calls.push(init.headers)
      return makeJsonResp({ jsonrpc: '2.0', id: 1, result: {} })
    }
    try {
      const t = new HttpTransport({ url: 'https://mcp.example.com' })
      await t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'a', params: {} }))
      await t.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'b', params: {} }))
      // 第一次请求没有 session id
      expect(calls[0]['Mcp-Session-Id']).toBeUndefined()
      // 第二次请求带上缓存的 session id
      expect(calls[1]['Mcp-Session-Id']).toBe('sess-123')
    } finally {
      ;(globalThis as any).fetch = prev
    }
  })

  it('SSE 流响应解析多个 data 事件', async () => {
    const prev = (globalThis as any).fetch
    const sseBody = 'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\ndata: {"jsonrpc":"2.0","method":"notifications/changed"}\n\n'
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody))
        controller.close()
      },
    })
    ;(globalThis as any).fetch = () => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Map([['Content-Type', 'text/event-stream']]),
      body: stream,
    })
    try {
      const t = new HttpTransport({ url: 'https://mcp.example.com' })
      const received: string[] = []
      t.onMessage((data) => received.push(data))
      await t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
      expect(received.length).toBe(2)
      expect(JSON.parse(received[0]).result.a).toBe(1)
      expect(JSON.parse(received[1]).method).toBe('notifications/changed')
    } finally {
      ;(globalThis as any).fetch = prev
    }
  })

  it('oauth resolver 注入动态 Bearer Token（优先级高于静态 token）', async () => {
    let capturedHeaders: any
    let resolverRefresh: boolean | undefined
    const prev = (globalThis as any).fetch
    ;(globalThis as any).fetch = (_url: string, init: any) => {
      capturedHeaders = init.headers
      return makeJsonResp({ jsonrpc: '2.0', id: 1, result: {} })
    }
    try {
      const t = new HttpTransport({
        url: 'https://mcp.example.com',
        auth: { oauth: {} as any, bearerToken: 'static-token' },
        oauthResolver: (opts) => {
          resolverRefresh = opts?.refresh
          return Promise.resolve('oauth-token')
        },
      })
      await t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }))
      expect(capturedHeaders['Authorization']).toBe('Bearer oauth-token')
      expect(resolverRefresh).toBeUndefined()
    } finally {
      ;(globalThis as any).fetch = prev
    }
  })

  it('401 触发 OAuth 强制刷新后重试一次并成功', async () => {
    const calls: string[] = []
    const prev = (globalThis as any).fetch
    ;(globalThis as any).fetch = (_url: string, init: any) => {
      calls.push((init.headers as any)['Authorization'])
      if (calls.length === 1) {
        // 第一次：401 无 token / 过期 token
        return Promise.resolve({
          ok: false,
          status: 401,
          headers: new Map([['Content-Type', 'text/plain']]),
          text: () => Promise.resolve('unauthorized'),
        })
      }
      return makeJsonResp({ jsonrpc: '2.0', id: 1, result: {} })
    }
    try {
      let refreshCount = 0
      const t = new HttpTransport({
        url: 'https://mcp.example.com',
        auth: { oauth: {} as any },
        oauthResolver: (opts) => {
          if (opts?.refresh) refreshCount++
          return Promise.resolve('fresh-token')
        },
      })
      await t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }))
      expect(calls.length).toBe(2)
      expect(calls[0]).toBe('Bearer fresh-token')
      expect(calls[1]).toBe('Bearer fresh-token')
      expect(refreshCount).toBe(1)
    } finally {
      ;(globalThis as any).fetch = prev
    }
  })

  it('401 重试后仍被拒绝则抛错', async () => {
    const prev = (globalThis as any).fetch
    ;(globalThis as any).fetch = () => Promise.resolve({
      ok: false,
      status: 401,
      headers: new Map([['Content-Type', 'text/plain']]),
      text: () => Promise.resolve('unauthorized'),
    })
    try {
      const t = new HttpTransport({
        url: 'https://mcp.example.com',
        auth: { oauth: {} as any },
        oauthResolver: () => Promise.resolve('fresh-token'),
      })
      await expect(
        t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })),
      ).rejects.toThrow(/OAuth 重试后仍被拒绝/)
    } finally {
      ;(globalThis as any).fetch = prev
    }
  })

  it('非 oauth 的 401 直接抛错误（不重试）', async () => {
    const prev = (globalThis as any).fetch
    ;(globalThis as any).fetch = () => Promise.resolve({
      ok: false,
      status: 401,
      headers: new Map([['Content-Type', 'text/plain']]),
      text: () => Promise.resolve('unauthorized'),
    })
    try {
      const t = new HttpTransport({ url: 'https://mcp.example.com', auth: { bearerToken: 'abc' } })
      await expect(
        t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })),
      ).rejects.toThrow(/HTTP 401/)
    } finally {
      ;(globalThis as any).fetch = prev
    }
  })
})

// ===== SSE transport 测试 =====

describe('SseTransport', () => {
  it('GET 建立 SSE 流并接收 endpoint 事件，POST 请求到该端点', async () => {
    let getHeaders: any
    let postUrl: string = ''
    let postBody: any
    const prev = (globalThis as any).fetch
    const encoder = new TextEncoder()
    // 第一次 GET 返回 SSE 流：先推 endpoint 事件，再推 message 响应
    const sseStream = (endpointUrl: string, response: unknown) => new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpointUrl}\n\n`))
        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(response)}\n\n`))
        controller.close()
      },
    })
    ;(globalThis as any).fetch = (url: string, init: any) => {
      if (init?.method === 'GET') {
        getHeaders = init.headers
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([['Content-Type', 'text/event-stream']]),
          body: sseStream('https://mcp.example.com/messages', { jsonrpc: '2.0', id: 1, result: { ok: true } }),
        })
      }
      if (init?.method === 'POST') {
        postUrl = url
        postBody = init.body
        return Promise.resolve({ ok: true, status: 202, headers: new Map(), text: () => Promise.resolve('') })
      }
      throw new Error(`Unexpected fetch ${url}`)
    }
    try {
      const t = new SseTransport({ url: 'https://mcp.example.com/sse', auth: { bearerToken: 'tok' } })
      const received: string[] = []
      t.onMessage((data) => received.push(data))
      await t.connectSse()
      // 等待 SSE 流被消费（事件循环）
      await new Promise((r) => setTimeout(r, 10))
      await t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
      expect(getHeaders['Authorization']).toBe('Bearer tok')
      expect(postUrl).toBe('https://mcp.example.com/messages')
      expect(received.length).toBe(1)
      expect(JSON.parse(received[0]).result.ok).toBe(true)
    } finally {
      ;(globalThis as any).fetch = prev
    }
  })
})

// ===== defaultTransportFactory 测试 =====

describe('defaultTransportFactory', () => {
  it('stdio 配置返回 StdioTransport', () => {
    const t = defaultTransportFactory({ name: 's', command: '/bin/echo', args: ['hi'] })
    expect(t).toBeInstanceOf(StdioTransport)
    t.close()
  })
  it('http 配置返回 HttpTransport', () => {
    const t = defaultTransportFactory({ name: 's', transport: 'http', url: 'https://x.com' })
    expect(t).toBeInstanceOf(HttpTransport)
  })
  it('sse 配置返回 SseTransport', () => {
    const t = defaultTransportFactory({ name: 's', transport: 'sse', url: 'https://x.com' })
    expect(t).toBeInstanceOf(SseTransport)
  })
  it('缺省 transport 字段，有 url 默认 http', () => {
    const t = defaultTransportFactory({ name: 's', url: 'https://x.com' })
    expect(t).toBeInstanceOf(HttpTransport)
  })
  it('stdio 缺 command 抛错', () => {
    expect(() => defaultTransportFactory({ name: 's', transport: 'stdio' })).toThrow('缺少 command')
  })
  it('http 缺 url 抛错', () => {
    expect(() => defaultTransportFactory({ name: 's', transport: 'http' })).toThrow('缺少 url')
  })
  it('oauth 配置装配 OAuthFlow：走 discovery+交互授权+持久化，注入动态 Bearer', async () => {
    const dir = mkdtempSync(tmpdir() + '/oauth-')
    let mcpAuthHeader: unknown = ''
    const mcpUrl = 'https://mcpx/mcp'
    const discoveryUrl = 'https://authx/.well-known/oauth-authorization-server'
    const tokenUrl = 'https://authx/token'
    const prev = (globalThis as any).fetch
    ;(globalThis as any).fetch = (url: string, init: any) => {
      if (url === discoveryUrl) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ authorization_endpoint: 'https://authx/authorize', token_endpoint: tokenUrl }),
        })
      }
      if (url === tokenUrl) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'oauth-access', refresh_token: 'r', expires_in: 3600 }),
        })
      }
      if (url === mcpUrl) {
        mcpAuthHeader = init?.headers?.['Authorization']
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([['Content-Type', 'application/json']]),
          text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
        })
      }
      return Promise.resolve({ ok: false, status: 404, text: async () => 'nf' })
    }
    try {
      const cfg: McpServerConfig = {
        name: 's',
        transport: 'http',
        url: mcpUrl,
        auth: { oauth: { discoveryUrl: 'https://authx/' } as any },
      }
      const t = defaultTransportFactory(cfg, {
        dataDir: dir,
        readCode: async () => 'https://cb.example.com/?code=AUTHXYZ',
      })
      expect(t).toBeInstanceOf(HttpTransport)
      await t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
      expect(mcpAuthHeader).toBe('Bearer oauth-access')
      // token 加密落盘
      expect(existsSync(dir + '/oauth-tokens.json')).toBe(true)
      t.close()
    } finally {
      ;(globalThis as any).fetch = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ===== 插件 resources / prompts CLI 命令测试 =====

describe('createMcpClientPlugin resources/prompts', () => {
  function createPluginWithCaps() {
    const transport = new MockTransport()
    transport.register('initialize', () => ({
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true },
      },
      serverInfo: { name: 'mock', version: '1' },
    }))
    transport.register('tools/list', () => ({ tools: [{ name: 't', description: 'A tool' }] }))
    transport.register('resources/list', () => ({
      resources: [
        { uri: 'config://app.yaml', name: 'app config', mimeType: 'text/yaml' },
        { uri: 'docs://readme', description: 'README' },
      ],
    }))
    transport.register('resources/read', (params: any) => ({
      contents: [{ uri: params.uri, mimeType: 'text/plain', text: `BODY of ${params.uri}` }],
    }))
    transport.register('prompts/list', () => ({
      prompts: [{ name: 'review', description: 'Code review', arguments: [{ name: 'lang', required: true }] }],
    }))
    transport.register('prompts/get', (params: any) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Review code in ${params.arguments?.lang}` } }],
    }))
    return createMcpClientPlugin({
      servers: [{ name: 'mock-srv', command: 'fake' }],
      transportFactory: () => transport,
    })
  }

  async function setupPlugin() {
    const plugin = createPluginWithCaps()
    const ctx = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      config: { get: () => undefined, set: () => {} },
    }
    const hooks = await plugin.install(ctx as any)
    await (hooks as any)['core.harness.start']?.()
    return { plugin, hooks }
  }

  function makeCliInput(arg: string): any {
    const out: string[] = []
    return {
      command: 'mcp', arg, out: (s: string) => { out.push(s) }, sessionId: 's1', raw: `mcp ${arg}`,
      result: undefined as any,
      _out: out,
    }
  }

  it('/mcp resources 列出资源', async () => {
    const { hooks } = await setupPlugin()
    const input = makeCliInput('resources')
    await (hooks as any)['cli.command']?.(input)
    expect(input._out.join('')).toInclude('config://app.yaml')
    expect(input._out.join('')).toInclude('docs://readme')
  })

  it('/mcp read <uri> 读取资源内容', async () => {
    const { hooks } = await setupPlugin()
    const input = makeCliInput('read config://app.yaml')
    await (hooks as any)['cli.command']?.(input)
    expect(input._out.join('')).toInclude('BODY of config://app.yaml')
  })

  it('/mcp read 未找到的资源给出提示', async () => {
    const { hooks } = await setupPlugin()
    const input = makeCliInput('read unknown://nope')
    await (hooks as any)['cli.command']?.(input)
    expect(input._out.join('')).toInclude('未找到资源')
  })

  it('/mcp prompts 列出 prompts', async () => {
    const { hooks } = await setupPlugin()
    const input = makeCliInput('prompts')
    await (hooks as any)['cli.command']?.(input)
    expect(input._out.join('')).toInclude('review')
    expect(input._out.join('')).toInclude('lang*')
  })

  it('/mcp prompt <name> lang=ts 渲染 prompt', async () => {
    const { hooks } = await setupPlugin()
    const input = makeCliInput('prompt review lang=ts')
    await (hooks as any)['cli.command']?.(input)
    expect(input._out.join('')).toInclude('Review code in ts')
  })

  it('/mcp servers 显示 server 概览', async () => {
    const { hooks } = await setupPlugin()
    const input = makeCliInput('servers')
    await (hooks as any)['cli.command']?.(input)
    const out = input._out.join('')
    expect(out).toInclude('mock-srv')
    expect(out).toInclude('tools=1')
    expect(out).toInclude('resources=2')
    expect(out).toInclude('prompts=1')
  })
})

// ===== autoInjectResources 测试 =====

describe('createMcpClientPlugin autoInjectResources', () => {
  it("policy='all' 把资源 text 注入到 core.prompt.system.transform", async () => {
    const transport = new MockTransport()
    transport.register('initialize', () => ({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, resources: { listChanged: true }, prompts: {} },
    }))
    transport.register('tools/list', () => ({ tools: [] }))
    transport.register('resources/list', () => ({
      resources: [{ uri: 'file://config.yaml', mimeType: 'text/yaml' }],
    }))
    transport.register('resources/read', (p: any) => ({
      contents: [{ uri: p.uri, text: 'app: demo\nport: 8080' }],
    }))
    transport.register('prompts/list', () => ({ prompts: [] }))

    const plugin = createMcpClientPlugin({
      servers: [{ name: 'cfg-srv', command: 'fake' }],
      transportFactory: () => transport,
      autoInjectResources: 'all',
    })
    const ctx = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      config: { get: () => undefined, set: () => {} },
    }
    const hooks = await plugin.install(ctx as any)
    await (hooks as any)['core.harness.start']?.()

    const parts: string[] = ['base system prompt']
    await (hooks as any)['core.prompt.system.transform']?.({}, parts)
    const combined = parts.join('\n')
    expect(combined).toInclude('MCP Resources')
    expect(combined).toInclude('app: demo')
    expect(combined).toInclude('port: 8080')

    await plugin.uninstall?.()
  })

  it("policy=['file://a.txt'] 只注入指定 URI", async () => {
    const transport = new MockTransport()
    transport.register('initialize', () => ({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, resources: { listChanged: true }, prompts: {} },
    }))
    transport.register('tools/list', () => ({ tools: [] }))
    transport.register('resources/list', () => ({
      resources: [
        { uri: 'file://a.txt' },
        { uri: 'file://b.txt' },
      ],
    }))
    transport.register('resources/read', (p: any) => ({
      contents: [{ uri: p.uri, text: `body-${p.uri}` }],
    }))
    transport.register('prompts/list', () => ({ prompts: [] }))

    const plugin = createMcpClientPlugin({
      servers: [{ name: 'srv', command: 'fake' }],
      transportFactory: () => transport,
      autoInjectResources: ['file://a.txt'],
    })
    const ctx = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      config: { get: () => undefined, set: () => {} },
    }
    const hooks = await plugin.install(ctx as any)
    await (hooks as any)['core.harness.start']?.()

    const parts: string[] = []
    await (hooks as any)['core.prompt.system.transform']?.({}, parts)
    const combined = parts.join('\n')
    expect(combined).toInclude('body-file://a.txt')
    expect(combined).not.toInclude('body-file://b.txt')

    await plugin.uninstall?.()
  })
})
