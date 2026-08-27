/**
 * @harness/computer-use 测试
 * - 进程内 MCP server：initialize / tools/list / tools/call（经后端 stub）
 * - transport 对接 McpClient（连通性）
 * - 插件：注册 mcp server + harness.init 注册 plugin 来源 Skill
 */
import { describe, expect, test, afterEach } from 'bun:test'
import { ComputerUseBackend } from './mac'
import { ComputerUseMcpServer, createComputerUseServerTransport } from './server'
import { createComputerUsePlugin, COMPUTER_USE_SERVER_NAME } from './index'
import { McpClient } from '@harness/mcp-client'
import { listRegisteredMcpServers, unregisterMcpServer } from '@harness/mcp-server-registry'

/** 后端 stub：不触碰真实 osascript */
class StubBackend extends ComputerUseBackend {
  public clickLog: unknown[] = []
  constructor() {
    super({ allowScreenshot: false })
  }
  override async checkPermissions() {
    return { accessibility: true, screenRecording: null }
  }
  override async listApps() {
    return { apps: [{ name: 'Finder', pid: 101, running: true }] }
  }
  override async getAppState(opts: { app: string }) {
    return { uiTree: `BUTTON "ok" val=""\n  ${opts.app}`, screenshot: undefined }
  }
  override async click(opts: any) {
    this.clickLog.push(opts)
    return { ok: true as const }
  }
}

function makeCtx() {
  const messages: string[] = []
  const transport = createComputerUseServerTransport(new ComputerUseMcpServer(new StubBackend()))
  return { transport, messages }
}

/** 发起一个 JSON-RPC 请求并等待响应 */
function rpcCall(transport: ReturnType<typeof createComputerUseServerTransport>, body: string): Promise<any> {
  return new Promise((resolve) => {
    transport.onMessage((data) => resolve(JSON.parse(data)))
    transport.send(body)
  })
}

describe('ComputerUseMcpServer（MCP JSON-RPC）', () => {
  test('initialize 返回协议版本与能力', async () => {
    const { transport } = makeCtx()
    const resp = await rpcCall(transport, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    expect(resp.result.protocolVersion).toBe('2024-11-05')
    expect(resp.result.capabilities.tools).toBeDefined()
    expect(resp.result.serverInfo.name).toBe('computer-use')
  })

  test('tools/list 返回参考文档中的全部工具', async () => {
    const { transport } = makeCtx()
    const resp = await rpcCall(transport, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))
    const names = resp.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual([
      'check_permissions', 'click', 'drag', 'get_app_state', 'list_apps',
      'perform_action', 'press_key', 'scroll', 'select_text', 'set_value', 'type_text',
    ])
  })

  test('tools/call 分发到后端方法并返回文本结果', async () => {
    const { transport } = makeCtx()
    const resp = await rpcCall(transport, JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'list_apps', arguments: {} },
    }))
    expect(resp.result.isError).toBeNull()
    expect(resp.result.content[0].type).toBe('text')
    expect(resp.result.content[0].text).toContain('Finder')
  })

  test('tools/call 报错时返回 isError=true', async () => {
    const { transport } = makeCtx()
    const resp = await rpcCall(transport, JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_app_state', arguments: {} }, // 缺 app → 抛错
    }))
    expect(resp.result.isError).toBe(true)
  })

  test('通知（无 id）不产生响应', async () => {
    const { transport } = makeCtx()
    let responded = false
    transport.onMessage(() => { responded = true })
    transport.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }))
    await new Promise((r) => setTimeout(r, 10))
    expect(responded).toBe(false)
  })

  test('未知方法返回 -32601', async () => {
    const { transport } = makeCtx()
    const resp = await rpcCall(transport, JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'nope', params: {} }))
    expect(resp.error.code).toBe(-32601)
  })
})

describe('transport 对接 McpClient（registry 使用路径）', () => {
  test('connect + listTools 可用', async () => {
    const { transport } = makeCtx()
    const client = new McpClient('computer-use', transport)
    await client.connect()
    const tools = await client.listTools()
    expect(tools.length).toBe(11)
    const callResult = await client.callTool('click', { app: 'Finder', x: 1, y: 2 })
    expect(callResult.isError).toBeNull()
    client.close()
  })
})

describe('createComputerUsePlugin', () => {
  afterEach(() => {
    unregisterMcpServer(COMPUTER_USE_SERVER_NAME)
  })

  test('install 注册 computer-use 进程内 MCP server（依赖 registry）', async () => {
    const plugin = createComputerUsePlugin({ backend: new StubBackend() })
    expect(plugin.dependsOn).toContain('mcp.server-registry')
    const hooks = await plugin.install({ log: { info(){}, warn(){}, error(){}, debug(){} } } as any)

    const regs = listRegisteredMcpServers()
    const entry = regs.find((r) => r.name === COMPUTER_USE_SERVER_NAME)
    expect(entry).toBeDefined()
    expect('createTransport' in (entry as any)).toBe(true)

    await plugin.uninstall?.()
    expect(listRegisteredMcpServers().find((r) => r.name === COMPUTER_USE_SERVER_NAME)).toBeUndefined()
    expect(hooks).toBeDefined()
    expect(typeof (hooks as any)['harness.init']).toBe('function')
  })

  test('harness.init 注册 plugin 来源 Skill', async () => {
    const plugin = createComputerUsePlugin({ backend: new StubBackend() })
    const hooks = await plugin.install({ log: { info(){}, warn(){}, error(){}, debug(){} } } as any) as any

    const registered: any[] = []
    const fakeHarness = { skillManager: { register: (s: any) => registered.push(s) } }
    await hooks!['harness.init']!({ harnessOptions: {} }, { harness: fakeHarness })

    expect(registered).toHaveLength(1)
    expect(registered[0].id).toBe('computer-use')
    expect(registered[0].loadedFrom).toBe('plugin')
    expect(registered[0].content).toContain('Computer Use')

    await plugin.uninstall?.()
  })
})