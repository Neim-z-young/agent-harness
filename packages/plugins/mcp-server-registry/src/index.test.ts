/**
 * @harness/mcp-server-registry 测试
 * - 注册表的 register/unregister/has/list/clear
 * - createMcpServerRegistryPlugin：core.harness.start 连接 → core.tool.pool.assemble 暴露工具 → /mcp 命令
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import {
  McpServerRegistry,
  createMcpServerRegistry,
  createMcpServerRegistryPlugin,
  type McpServerRegistration,
  resolveMcpCapabilities,
} from './index'
import type { PluginContext } from '@harness/plugin'
import type { Bus } from '@harness/bus'
import { LifecycleEvents } from '@harness/core'
import { globalMcpToolIndex } from '@harness/tool'
import type { McpTransport } from '@harness/mcp-client'

/** 日志 ctx 桩 */
const mockLog: PluginContext['log'] = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
}

/** Bus 桩：记录发布事件，订阅返回 noop 退订；publish 同步触发同事件订阅回调（便于测试插件装卸联动） */
function makeBus(): Bus & { emitted: Array<{ name: string; payload: unknown }> } {
  const emitted: Array<{ name: string; payload: unknown }> = []
  const subs: Array<{ name: string; cb: (e: { payload: unknown }) => void }> = []
  const bus = {
    emitted,
    publish: async (event: { name: string }, payload: unknown) => {
      emitted.push({ name: event.name, payload })
      for (const s of subs) if (s.name === event.name) s.cb({ payload })
    },
    subscribe: (event: { name: string }, cb: (e: { payload: unknown }) => void) => {
      subs.push({ name: event.name, cb })
      return () => undefined
    },
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
  test('core.harness.start 连接服务器并用 core.tool.pool.assemble 暴露工具', async () => {
    const reg = createMcpServerRegistry()
    const { transport, calls } = createFakeTransport([
      { name: 'list_apps', description: 'list apps' },
      { name: 'click', description: 'click' },
    ])
    reg.register({ name: 'fake', createTransport: () => transport })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog, bus: makeBus() } as unknown as PluginContext)

    await hooks!['core.harness.start']!({ harness: {} } as any, { started: true })
    const pool = fakePool()
    await hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, pool)
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
    await hooks!['core.harness.start']!({ harness: {} } as any, { started: true })
    // 懒加载：经过一次 core.tool.pool.assemble 后才真正连接 server（启动不预连）
    await hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, fakePool())

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
    await hooks!['core.harness.start']!({ harness: {} } as any, { started: true })

    const pool = fakePool()
    await hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, pool)
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
    await hooks!['core.harness.start']!({ harness: {} } as any, { started: true })

    // 复用同一个 pool：验证禁用时工具被真正移除、启用时恢复（而非只是不再 add）
    const pool = fakePool()
    await hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, pool)
    expect(pool.list().map((t: any) => t.id)).toContain('mcp__code-intel__list_apps')

    // 代码注册 server 禁用（嵌套写法 servers disable）：会话内断开连接，工具从池中移除
    const out: string[] = []
    await hooks!['cli.command']!({
      command: 'mcp', arg: 'servers disable code-intel', raw: 'mcp servers disable code-intel',
      sessionId: 's', out: (s: string) => out.push(s),
    } as any)
    expect(out.join('')).toContain('已禁用')
    expect(reg.has('code-intel')).toBe(true) // 注册项仍在，仅本次进程禁用

    await hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, pool)
    expect(pool.list()).toHaveLength(0) // 已在池中的工具也被移除

    // 重新启用（嵌套写法 servers enable）：重新连接，工具恢复
    const out2: string[] = []
    await hooks!['cli.command']!({
      command: 'mcp', arg: 'servers enable code-intel', raw: 'mcp servers enable code-intel',
      sessionId: 's', out: (s: string) => out2.push(s),
    } as any)
    expect(out2.join('')).toContain('重新连接')

    await hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, pool)
    expect(pool.list().map((t: any) => t.id)).toContain('mcp__code-intel__list_apps')
    await plugin.uninstall?.()
  })

  test('宿主插件卸载（/plugins disable）：断开其 MCP server 并收敛工具；重载后重连恢复', async () => {
    const reg = createMcpServerRegistry()
    const { transport } = createFakeTransport([{ name: 'code_symbols' }])
    const bus = makeBus()
    reg.register({ name: 'code-intel', createTransport: () => transport, source: 'code-intel' })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog, bus } as unknown as PluginContext)
    await hooks!['core.harness.start']!({ harness: {} } as any, { started: true })

    const pool = fakePool()
    await hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, pool)
    expect(pool.list().map((t: any) => t.id)).toContain('mcp__code-intel__code_symbols')

    // 插件卸载 → server 断开 + 工具从工具池收敛
    // ★ 必须复刻生产时序：manage-plugin 先跑 uninstall()（code-intel 注销注册项）
    //   再 publish pluginUnloaded。少了这步，无条件 sync 不会抢跑，回归测不出来。
    reg.unregister('code-intel')
    await bus.publish(LifecycleEvents.pluginUnloaded, { id: 'code-intel' })
    await hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, pool)
    expect(pool.list()).toHaveLength(0)
    expect(bus.emitted.some((e) => e.name === LifecycleEvents.mcpServerDisabled.name)).toBe(true)

    // 插件重载 → 重新注册并重连，工具恢复
    reg.register({ name: 'code-intel', createTransport: () => transport, source: 'code-intel' })
    await bus.publish(LifecycleEvents.pluginLoaded, { id: 'code-intel' })
    await new Promise((r) => setTimeout(r, 10)) // 等待异步重连完成
    await hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, pool)
    expect(pool.list().map((t: any) => t.id)).toContain('mcp__code-intel__code_symbols')
    await plugin.uninstall?.()
  })
})

describe('createMcpServerRegistryPlugin config 化管理（config.json mcpServers）', () => {
  const mkInput = (over: Record<string, unknown> = {}): any => ({
    command: 'mcp', arg: '', raw: 'mcp', sessionId: 's', out: () => undefined,
    mcpServers: [], setMcpServers: () => undefined,
    ...over,
  })
  /**
   * 安装插件并取回 Hooks。
   *
   * `cli.mcp.configure` 已声明进 `Hooks`（此前是"契约外自定义 hook"，只能用 any 调用），
   * 这里仍转 any 仅为免去 `!` 非空断言的噪音 —— 调用形态与生产一致（单个 input 参数）。
   */
  const installAny = async (plugin: ReturnType<typeof createMcpServerRegistryPlugin>) =>
    (await plugin.install({ log: mockLog, bus: makeBus() } as unknown as PluginContext)) as any

  test('cli.mcp.configure 注入配置态：/mcp servers 展示启停状态', async () => {
    const reg = createMcpServerRegistry()
    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await installAny(plugin)

    await hooks['cli.mcp.configure'](
      { mcpServers: [
        { name: 'alpha', transport: 'http', url: 'http://x/a', enabled: true },
        { name: 'beta', transport: 'http', url: 'http://x/b', enabled: false },
      ] },
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
    await hooks['cli.mcp.configure'](
      { mcpServers: [{ name: 'alpha', transport: 'http', url: 'http://x/a' }] },
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
    await hooks['cli.mcp.configure'](
      { mcpServers: [{ name: 'alpha', transport: 'http', url: 'http://x/a' }] },
    )

    const saved: any[][] = []
    const mkCfg = (arg: string, out: (s: string) => void) => mkInput({
      arg, setMcpServers: (l: any[]) => saved.push(l), out,
    })

    const out1: string[] = []
    await hooks!['cli.command']!(mkCfg('disable alpha', (s: string) => out1.push(s)))
    expect(bus.emitted).toContainEqual({ name: 'mcp.server.disabled', payload: { name: 'alpha' } })

    const out2: string[] = []
    // ★ 旧断言写的是「无真实连接，会失败但事件仍发」—— 那是把 bug 当契约：
    //   连不上还广播 mcp.server.enabled，会让遥测记下一条根本没启用的假事件。
    //   现在要求：失败路径输出原因、且**不发** enabled。
    await hooks!['cli.command']!(mkCfg('enable alpha', (s: string) => out2.push(s)))
    expect(out2.join('')).toContain('启用失败')
    expect(bus.emitted.some((e) => e.name === 'mcp.server.enabled')).toBe(false)

    const out3: string[] = []
    await hooks!['cli.command']!(mkCfg('add -- {"name":"beta","transport":"http","url":"http://x/b","enabled":false}', (s: string) => out3.push(s)))
    expect(bus.emitted).toContainEqual({ name: 'mcp.server.added', payload: { name: 'beta' } })

    const out4: string[] = []
    await hooks!['cli.command']!(mkCfg('remove beta', (s: string) => out4.push(s)))
    expect(bus.emitted).toContainEqual({ name: 'mcp.server.removed', payload: { name: 'beta' } })
    await plugin.uninstall?.()
  })

  test('★ /mcp enable 连上了才发 enabled（成功路径的正向契约）', async () => {
    const reg = createMcpServerRegistry()
    const { transport } = createFakeTransport([{ name: 'ping' }])
    reg.register({ name: 'gamma', createTransport: () => transport })
    const bus = makeBus()
    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = (await plugin.install({ log: mockLog, bus } as unknown as PluginContext)) as any

    const out: string[] = []
    await hooks['cli.command']!(mkInput({ arg: 'enable gamma', out: (s: string) => out.push(s) }))
    expect(out.join('')).toContain('已启用并重新连接')
    expect(bus.emitted).toContainEqual({ name: 'mcp.server.enabled', payload: { name: 'gamma' } })
    await plugin.uninstall?.()
  })

  test('服务器级启停：disable 持久化 enabled=false，enable 写回 true', async () => {
    const reg = createMcpServerRegistry()
    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await installAny(plugin)
    await hooks['cli.mcp.configure'](
      { mcpServers: [{ name: 'alpha', transport: 'http', url: 'http://x/a' }] },
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
// ===== P1-7：MCP server 能力声明 —— 声明 ≠ 强制 =====

describe('resolveMcpCapabilities（P1-7）', () => {
  test('没声明 ⇒ 没有不可强制项，也不绑（与改造前逐位一致）', () => {
    const r = resolveMcpCapabilities(undefined, { osBindingAvailable: true })
    expect(r.unenforceable).toEqual([])
    expect(r.bound).toBe(false)
  })

  test('声明 fs:"cwd" 且有 OS 绑定 ⇒ **真强制**（bound=true，无告警）', () => {
    const r = resolveMcpCapabilities({ fs: 'cwd' }, { osBindingAvailable: true })
    expect(r.bound).toBe(true)
    expect(r.unenforceable).toEqual([])
  })

  test('★声明 fs:"cwd" 但没有绑定 ⇒ 只声明、不强制（必须说出来）', () => {
    const r = resolveMcpCapabilities({ fs: 'cwd' }, { osBindingAvailable: false })
    expect(r.bound).toBe(false)
    expect(r.unenforceable.join()).toContain('fs:"cwd"')
    expect(r.unenforceable.join()).toContain('只声明、不强制')
  })

  test('★net:"none" 任何档位都强制不了（L0 静态门管不到别人的子进程）', () => {
    for (const available of [true, false]) {
      const r = resolveMcpCapabilities({ net: 'none' }, { osBindingAvailable: available })
      expect(r.unenforceable.join()).toContain('强制不了子进程出网')
    }
  })

  test('两项都声明、都没法强制 ⇒ 两条都在（不合并成一句）', () => {
    const r = resolveMcpCapabilities({ fs: 'cwd', net: 'none' }, { osBindingAvailable: false })
    expect(r.unenforceable).toHaveLength(2)
  })
})

// ===== 连接生命周期：孤儿清理 / 失败可诊断 / 卸载后迟到的连接 / 计数去重 =====

describe('连接生命周期与可诊断性', () => {
  /** 装一个带假 transport 的代码注册 server，并记录 close 次数 */
  function setup(tools: Array<{ name: string; description?: string }> = [{ name: 't' }]) {
    const reg = createMcpServerRegistry()
    const fake = createFakeTransport(tools)
    let closed = 0
    const transport: McpTransport = { ...fake.transport, close: () => { closed += 1; fake.transport.close() } }
    return { reg, transport, closed: () => closed }
  }

  test('★孤儿 runtime：宿主插件注销了注册项却没走 serverSource 路线 ⇒ 任意外来卸载事件都要收掉', async () => {
    const { reg, transport, closed } = setup()
    const bus = makeBus()
    reg.register({ name: 'ghost', createTransport: () => transport, source: 'ghost' })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog, bus } as unknown as PluginContext)
    const pool = fakePool()
    await hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, pool)
    expect(pool.list().map((t: any) => t.id)).toEqual(['mcp__ghost__t'])
    expect(globalMcpToolIndex.serverOf('mcp__ghost__t')).toBe('ghost')

    // 宿主插件只注销了注册项（没通过 source 路线下线），随后**别的**插件被卸载
    reg.unregister('ghost')
    await bus.publish(LifecycleEvents.pluginUnloaded, { id: 'some-other-plugin' })

    expect(closed()).toBe(1)
    // 工具归属索引也要摘掉 —— 否则 /tools 里还挂着已死 server 的工具
    expect(globalMcpToolIndex.serverOf('mcp__ghost__t')).toBeUndefined()
    await plugin.uninstall?.()
  })

  test('★建连失败也要关 transport（stdio 子进程不泄漏）', async () => {
    const { reg, transport, closed } = setup()
    // send 同步抛错 ⇒ connect() 失败；openRuntime 的 catch 必须关掉这个 transport
    const broken: McpTransport = { ...transport, send: () => { throw new Error('boom') } }
    reg.register({ name: 'broken', createTransport: () => broken })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog, bus: makeBus() } as unknown as PluginContext)
    await hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, fakePool())
    expect(closed()).toBeGreaterThan(0)
    await plugin.uninstall?.()
  })

  test('★连接失败必须留下可读原因：/mcp servers 输出里带 error="…"', async () => {
    const reg = createMcpServerRegistry()
    // 缺 command 的 stdio 配置 ⇒ defaultTransportFactory 抛错（真正的"配错了"）
    reg.register({ name: 'bad', config: { name: 'bad', transport: 'stdio' } as any })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog, bus: makeBus() } as unknown as PluginContext)
    await hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, fakePool())

    const out: string[] = []
    await hooks!['cli.command']!({
      command: 'mcp', arg: 'servers', raw: 'mcp servers', sessionId: 's', out: (s: string) => out.push(s),
    } as any)
    const text = out.join('')
    expect(text).toContain('connected=false')
    expect(text).toContain('error="')
    await plugin.uninstall?.()
  })

  test('★卸载后才 resolve 的 in-flight 连接：立刻关闭并丢弃，不留泄漏', async () => {
    const { reg, transport, closed } = setup()
    // createTransport 延迟 20ms ⇒ uninstall 一定发生在 connect 完成之前
    reg.register({
      name: 'slow',
      createTransport: () => new Promise<McpTransport>((resolve) => setTimeout(() => resolve(transport), 20)),
    })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = await plugin.install({ log: mockLog, bus: makeBus() } as unknown as PluginContext)
    const assembling = hooks!['core.tool.pool.assemble']!({ agentId: 'a' }, fakePool())
    await new Promise((r) => setTimeout(r, 5)) // 让连接进入 await（尚未 resolve）
    await plugin.uninstall?.()
    await assembling
    await new Promise((r) => setTimeout(r, 40)) // 等那条迟到的连接完成

    expect(closed()).toBe(1)
    expect(globalMcpToolIndex.serverOf('mcp__slow__t')).toBeUndefined()
  })

  test('同名条目同时出现在「托管」与「代码注册」时，表头计数按名字去重（与打印行数一致）', async () => {
    const reg = createMcpServerRegistry()
    reg.register({ name: 'dup', createTransport: () => createFakeTransport([{ name: 't' }]).transport })

    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = (await plugin.install({ log: mockLog, bus: makeBus() } as unknown as PluginContext)) as any
    await hooks['cli.mcp.configure']({ mcpServers: [{ name: 'dup', transport: 'http', url: 'http://x/a' }] })

    const out: string[] = []
    await hooks['cli.command']({ command: 'mcp', arg: 'servers', raw: 'mcp servers', sessionId: 's', out: (s: string) => out.push(s) })
    const text = out.join('')
    expect(text).toContain('已注册 1 个 MCP Server')
    expect(text.split('dup').length - 1).toBe(1) // 只打一行，不与表头计数打架
    await plugin.uninstall?.()
  })

  test('/mcp add 一条 enabled=false 的条目：如实说"不连接"，不谎称已连接', async () => {
    const reg = createMcpServerRegistry()
    const plugin = createMcpServerRegistryPlugin({ registry: reg })
    const hooks = (await plugin.install({ log: mockLog, bus: makeBus() } as unknown as PluginContext)) as any

    const out: string[] = []
    await hooks['cli.command']({
      command: 'mcp',
      arg: 'add -- {"name":"off","transport":"http","url":"http://x/a","enabled":false}',
      raw: 'mcp add', sessionId: 's', out: (s: string) => out.push(s),
    })
    expect(out.join('')).toContain('已添加 off（enabled=false，当前不连接）')
    await plugin.uninstall?.()
  })
})
