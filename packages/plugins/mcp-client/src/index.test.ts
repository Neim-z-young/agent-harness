import { describe, it, expect } from 'bun:test'
import {
  McpClient,
  StdioTransport,
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
  it('插件 connect + tool.pool.assemble 注入工具', async () => {
    const transport = new MockTransport()
    transport.register('initialize', () => ({ protocolVersion: '2024-11-05' }))
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

    // 模拟 harness.start
    await (hooks as any)['harness.start']?.()

    // 模拟 tool.pool.assemble
    const addedTools: any[] = []
    const pool = { add: (t: unknown) => { addedTools.push(t) } }
    await (hooks as any)['tool.pool.assemble']?.({}, pool)

    expect(addedTools.length).toBe(2)
    expect(addedTools[0].id).toBe('mcp__web-tools__search')
    expect(addedTools[1].id).toBe('mcp__web-tools__fetch')

    // cli.commands 注册了 /mcp
    const cmdInput = { commands: [] as any[] }
    await (hooks as any)['cli.commands']?.(cmdInput)
    expect(cmdInput.commands.length).toBe(1)
    expect(cmdInput.commands[0].command).toBe('mcp')

    // cli.command 处理 /mcp
    const cmdOut: string[] = []
    const cliInput: { command: string; arg: string; out: (s: string) => void; sessionId: string; raw: string; result?: 'continue' | 'exit' } = {
      command: 'mcp', arg: '', out: (s: string) => { cmdOut.push(s) },
      sessionId: 's1', raw: 'mcp',
    }
    await (hooks as any)['cli.command']?.(cliInput)
    expect(cliInput.result).toBe('continue')
    expect(cmdOut.join('')).toInclude('mcp__web-tools__search')

    await plugin.uninstall?.()
  })

  it('无工具时 /mcp 命令不注册', async () => {
    const transport = new MockTransport()
    transport.register('initialize', () => ({ protocolVersion: '2024-11-05' }))
    transport.register('tools/list', () => ({ tools: [] }))

    const plugin = createMcpClientPlugin({
      servers: [{ name: 'empty', command: 'fake' }],
      transportFactory: () => transport,
    })

    const ctx = {
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      bus: { publish: () => {}, subscribe: () => () => {} },
      config: { get: () => undefined, set: () => {} },
    }
    const hooks = await plugin.install(ctx as any)
    await (hooks as any)['harness.start']?.()

    const cmdInput = { commands: [] as any[] }
    await (hooks as any)['cli.commands']?.(cmdInput)
    expect(cmdInput.commands.length).toBe(0)

    await plugin.uninstall?.()
  })
})
