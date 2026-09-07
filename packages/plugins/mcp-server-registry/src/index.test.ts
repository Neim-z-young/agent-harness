/**
 * @harness/mcp-server-registry 测试
 * - 注册表的 register/unregister/has/list/clear
 * - createMcpServerRegistryPlugin：harness.start 连接 → tool.pool.assemble 暴露工具 → /mcp 命令
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import {
  McpServerRegistry,
  createMcpServerRegistry,
  createMcpServerRegistryPlugin,
  type McpServerRegistration,
} from './index'
import type { PluginContext } from '@harness/plugin'
import type { Bus } from '@harness/bus'
import type { McpTransport } from '@harness/mcp-client'

/** 日志 ctx 桩 */
const mockLog: PluginContext['log'] = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
}

/** Bus 桩：记录发布事件，订阅返回 noop 退订 */
function makeBus(): Bus & { emitted: Array<{ name: string; payload: unknown }> } {
  const emitted: Array<{ name: string; payload: unknown }> = []
  const bus = {
    emitted,
    publish: async (event: { name: string }, payload: unknown) => { emitted.push({ name: event.name, payload }) },
    subscribe: () => () => undefined,
    subscribeAll: () => () => undefined,
  } as unknown as Bus & { emitted: Array<{ name: string; payload: unknown }> }
  return bus
}

/** 进程内假 server：响应 initialize / tools/list / tools/call */
function createFakeTransport(tools: Array<{ name: string; description?: string }>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let handler: ((data: string) => void) | undefined
  const transport: McpTransport = {
    send(data: string) {
      const req = JSON.parse(data) as any
      const respond = (result: unknown) =>
        handler?.(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
      if (req.method === 'initialize') {
        respond({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0.0.0' } })
      } else if (req.method === 'tools/list') {
        respond({ tools })
      } else if (req.method === 'tools/call') {
        calls.push({ name: req.params.name, args: req.params.arguments ?? {} })
        respond({ content: [{ type: 'text', text: `called:${req.params.name}` }], isError: null })
      } else if (req.id != null) {
        handler?.(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Unknown' } }))
      }
    },
    onMessage(h) { handler = h },
    close() { handler = undefined },
  }
  return { transport, calls }
}

function fakePool() {
  const tools: unknown[] = []
  return {
    add: (t: unknown) => tools.push(t),
    addAll: (ts: unknown[]) => tools.push(...ts),
    addIfMissing: () => undefined,
    remove: (id: string) => { const i = tools.findIndex((t: any) => t.id === id); if (i >= 0) tools.splice(i, 1) },
    list: () => tools,
  }
}

describe('McpServerRegistry', () => {
  beforeEach(() => { createMcpServerRegistry().clear() })

  test('register / unregister / has / list / clear', () => {
    const reg = createMcpServerRegistry()
    const entry: McpServerRegistration = { name: 'x', createTransport: () => ({ send(){}, onMessage(){}, close(){} }) }
    expect(reg.has('x')).toBe(false)
    reg.register(entry)
    expect(reg.has('x')).toBe(true)
    expect(reg.list().map((e) => e.name)).toEqual(['x'])

    reg.register({ name: 'x', createTransport: entry.createTransport })
    expect(reg.list().length).toBe(1) // 同名覆盖

    expect(reg.unregister('x')).toBe(true)
    expect(reg.unregister('x')).toBe(false)
    expect(reg.has('x')).toBe(false)

    reg.register(entry)
    reg.clear()
    expect(reg.list().length).toBe(0)
  })
})

describe('createMcpServerRegistryPlugin', () => {
  test('harness.start 连接服务器并用 tool.pool.assemble 暴露工具', async () => {
    const reg = createMcpServerRegistry()
    const { transport, calls } = createFakeTransport([
      { name: 'list_apps', description: 'list apps' },
      { name: 'click', description: 'click' },
    ])
    reg.register({ name: 'fake', createTransport: () => transport })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog, bus: makeBus() } as unknown as PluginContext)

    await hooks!['harness.start']!({ harness: {} } as any, { started: true })
    const pool = fakePool()
    await hooks!['tool.pool.assemble']!({ agentId: 'a' }, pool)
    expect(pool.list().length).toBe(2)
    const ids = pool.list().map((t: any) => t.id).sort()
    expect(ids).toEqual(['mcp__fake__click', 'mcp__fake__list_apps'])

    // 工具可被调用（pass-through → server → McpClient.callTool）
    const clickTool = pool.list().find((t: any) => t.id === 'mcp__fake__click') as any
    const result = await clickTool.call({ app: 'x', x: 1, y: 2 }, { cwd: '/tmp' })
    expect(result.ok).toBe(true)
    expect(result.output).toBe('called:click')
    expect(calls).toEqual([{ name: 'click', args: { app: 'x', x: 1, y: 2 } }])

    await plugin.uninstall?.()
  })

  test('/mcp servers 与 /mcp tools 命令输出', async () => {
    const reg = createMcpServerRegistry()
    const { transport } = createFakeTransport([{ name: 'list_apps' }])
    reg.register({ name: 'fake', createTransport: () => transport })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog, bus: makeBus() } as unknown as PluginContext)
    await hooks!['harness.start']!({ harness: {} } as any, { started: true })

    // 无服务器注册时可不出现在命令列表
    const cmdInput1: any = { commands: [] }
    await hooks!['cli.commands']!(cmdInput1)
    expect(cmdInput1.commands.map((c: any) => c.command)).toContain('mcp')

    // /mcp servers
    const inputA: any = { command: 'mcp', arg: 'servers', raw: 'mcp servers', out: (s: string) => { /* noop */ }, sessionId: 's' }
    const outA: string[] = []
    inputA.out = (s: string) => outA.push(s)
    await hooks!['cli.command']!(inputA)
    expect(inputA.result).toBe('continue')
    expect(outA.join('')).toContain('fake')
    expect(outA.join('')).toContain('tools=1')

    // /mcp tools
    const inputB: any = { command: 'mcp', arg: 'tools', raw: 'mcp tools', out: (s: string) => { /* noop */ }, sessionId: 's' }
    const outB: string[] = []
    inputB.out = (s: string) => outB.push(s)
    await hooks!['cli.command']!(inputB)
    expect(outB.join('')).toContain('mcp__fake__list_apps')

    await plugin.uninstall?.()
  })

  test('config 模式缺 command（stdio）时连接失败不阻塞其余', async () => {
    const reg = createMcpServerRegistry()
    // config 但没有 command/jsonrpc → defaultTransportFactory 抛错
    reg.register({ name: 'bad', config: { name: 'bad' as any, transport: 'stdio' } as any })
    reg.register({ name: 'ok', createTransport: () => (createFakeTransport([{ name: 't' }]).transport) })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog, bus: makeBus() } as unknown as PluginContext)
    await hooks!['harness.start']!({ harness: {} } as any, { started: true })

    const pool = fakePool()
    await hooks!['tool.pool.assemble']!({ agentId: 'a' }, pool)
    const ids = pool.list().map((t: any) => t.id)
    expect(ids).toContain('mcp__ok__t')
    expect(ids).not.toContain('mcp__bad__')
    await plugin.uninstall?.()
  })

  test('/mcp disable/enable 可对代码注册 server 会话内启停（任务B），并登记工具归属索引（任务A）', async () => {
    const reg = createMcpServerRegistry()
    const { transport } = createFakeTransport([{ name: 'list_apps' }])
    reg.register({ name: 'code-intel', createTransport: () => transport })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog, bus: makeBus() } as unknown as PluginContext)
    await hooks!['harness.start']!({ harness: {} } as any, { started: true })

    let pool = fakePool()
    await hooks!['tool.pool.assemble']!({ agentId: 'a' }, pool)
    expect(pool.list().map((t: any) => t.id)).toContain('mcp__code-intel__list_apps')

    // 代码注册 server 禁用：会话内断开连接，工具不再装配
    const out: string[] = []
    await hooks!['cli.command']!({
      command: 'mcp', arg: 'disable code-intel', raw: 'mcp disable code-intel',
      sessionId: 's', out: (s: string) => out.push(s),
    } as any)
    expect(out.join('')).toContain('已禁用')
    expect(reg.has('code-intel')).toBe(true) // 注册项仍在，仅本次进程禁用

    pool = fakePool()
    await hooks!['tool.pool.assemble']!({ agentId: 'a' }, pool)
    expect(pool.list()).toHaveLength(0)

    // 重新启用：重新连接，工具恢复
    const out2: string[] = []
    await hooks!['cli.command']!({
      command: 'mcp', arg: 'enable code-intel', raw: 'mcp enable code-intel',
      sessionId: 's', out: (s: string) => out2.push(s),
    } as any)
    expect(out2.join('')).toContain('重新连接')

    pool = fakePool()
    await hooks!['tool.pool.assemble']!({ agentId: 'a' }, pool)
    expect(pool.list().map((t: any) => t.id)).toContain('mcp__code-intel__list_apps')
    await plugin.uninstall?.()
  })
})

describe('createMcpServerRegistryPlugin config 化管理（config.json mcpServers）', () => {
  const mkInput = (over: Record<string, unknown> = {}): any => ({
    command: 'mcp', arg: '', raw: 'mcp', sessionId: 's', out: () => undefined,
    mcpServers: [], setMcpServers: () => undefined,
    ...over,
  })
  /** mcp.configure 是自定义 Hook，Hooks 类型未声明，转 any 便于测试直接调用 */
  const installAny = async (plugin: ReturnType<typeof createMcpServerRegistryPlugin>) =>
    (await plugin.install({ log: mockLog, bus: makeBus() } as unknown as PluginContext)) as any

  test('mcp.configure 注入配置态：/mcp servers 展示启停状态', async () => {
    const reg = createMcpServerRegistry()
    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await installAny(plugin)

    await hooks['mcp.configure'](
      { mcpServers: [
        { name: 'alpha', transport: 'http', url: 'http://x/a', enabled: true },
        { name: 'beta', transport: 'http', url: 'http://x/b', enabled: false },
      ] },
      {},
    )
    const out: string[] = []
    await hooks!['cli.command']!(mkInput({ arg: '', out: (s: string) => out.push(s) }))
    expect(out.join('')).toContain('alpha')
    expect(out.join('')).toContain('[启用]')
    expect(out.join('')).toContain('beta')
    expect(out.join('')).toContain('[禁用]')
    await plugin.uninstall?.()
  })

  test('工具级启停已迁至 /tools：/mcp tool 报未知子命令', async () => {
    const reg = createMcpServerRegistry()
    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await installAny(plugin)
    await hooks['mcp.configure'](
      { mcpServers: [{ name: 'alpha', transport: 'http', url: 'http://x/a' }] }, {},
    )

    const out: string[] = []
    await hooks!['cli.command']!(mkInput({
      arg: 'tool alpha list_apps off',
      setMcpServers: () => undefined,
      out: (s: string) => out.push(s),
    }))
    expect(out.join('')).toContain('未知子命令')
    await plugin.uninstall?.()
  })

  test('enable/disable/add/remove 发布 mcp.* 事件', async () => {
    const reg = createMcpServerRegistry()
    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const bus = makeBus()
    const hooks = (await plugin.install({ log: mockLog, bus } as unknown as PluginContext)) as any
    await hooks['mcp.configure'](
      { mcpServers: [{ name: 'alpha', transport: 'http', url: 'http://x/a' }] }, {},
    )

    const saved: any[][] = []
    const mkCfg = (arg: string, out: (s: string) => void) => mkInput({
      arg, setMcpServers: (l: any[]) => saved.push(l), out,
    })

    const out1: string[] = []
    await hooks!['cli.command']!(mkCfg('disable alpha', (s: string) => out1.push(s)))
    expect(bus.emitted).toContainEqual({ name: 'mcp.server.disabled', payload: { name: 'alpha' } })

    const out2: string[] = []
    // enable 依赖连接管理 server；这里 force 一次 enable（无真实连接，会失败但事件仍发）
    await hooks!['cli.command']!(mkCfg('enable alpha', (s: string) => out2.push(s)))
    expect(bus.emitted).toContainEqual({ name: 'mcp.server.enabled', payload: { name: 'alpha' } })

    const out3: string[] = []
    await hooks!['cli.command']!(mkCfg('add -- {"name":"beta","transport":"http","url":"http://x/b","enabled":false}', (s: string) => out3.push(s)))
    expect(bus.emitted).toContainEqual({ name: 'mcp.server.added', payload: { name: 'beta' } })

    const out4: string[] = []
    await hooks!['cli.command']!(mkCfg('remove beta', (s: string) => out4.push(s)))
    expect(bus.emitted).toContainEqual({ name: 'mcp.server.removed', payload: { name: 'beta' } })
    await plugin.uninstall?.()
  })

  test('服务器级启停：disable 持久化 enabled=false，enable 写回 true', async () => {
    const reg = createMcpServerRegistry()
    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await installAny(plugin)
    await hooks['mcp.configure'](
      { mcpServers: [{ name: 'alpha', transport: 'http', url: 'http://x/a' }] }, {},
    )

    const saved: any[] = []
    await hooks!['cli.command']!(mkInput({
      arg: 'disable alpha',
      setMcpServers: (list: any[]) => saved.push(list),
      out: () => undefined,
    }))
    expect(saved.length).toBe(1)
    expect(saved[0][0].enabled).toBe(false)

    const saved2: any[] = []
    await hooks!['cli.command']!(mkInput({
      arg: 'enable alpha',
      setMcpServers: (list: any[]) => saved2.push(list),
      out: () => undefined,
    }))
    expect(saved2[0][0].enabled).toBe(true)
    expect(saved2[0][0].name).toBe('alpha')
    await plugin.uninstall?.()
  })

  test('/mcp add 与 remove：新增/移除托管 server 并持久化', async () => {
    const reg = createMcpServerRegistry()
    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await installAny(plugin)
    const saved: any[][] = []

    await hooks!['cli.command']!(mkInput({
      arg: 'add -- {"name":"new","transport":"stdio","command":"echo","args":["hi"],"enabled":false,"tools":{"x":false}}',
      setMcpServers: (list: any[]) => saved.push(list),
      out: () => undefined,
    }))
    expect(saved.length).toBe(1)
    expect(saved[0].map((e: any) => e.name)).toContain('new')
    expect((saved[0].find((e: any) => e.name === 'new')!.tools as any).x).toBe(false)

    // 移除
    const saved2: any[] = []
    await hooks!['cli.command']!(mkInput({
      arg: 'remove new',
      setMcpServers: (list: any[]) => saved2.push(list),
      out: () => undefined,
    }))
    expect(saved2[0].map((e: any) => e.name)).not.toContain('new')
    await plugin.uninstall?.()
  })
})