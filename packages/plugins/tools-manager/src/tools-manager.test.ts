import { describe, it, expect } from 'bun:test'
import type { CliCommandInput, Hooks } from '@harness/plugin'
import type { Tool } from '@harness/tool'
import { createToolsManagerPlugin } from './index'

/** Bus 桩：记录发布事件，订阅记录 handler 便于手动触发 */
interface BusStub {
  emitted: Array<{ name: string; payload: unknown }>
  handlers: Map<string, (record: { name: string; payload: any }) => void>
  publish: (event: { name: string }, payload: unknown) => Promise<void>
  subscribe: (event: { name: string }, h: (r: { name: string; payload: any }) => void) => () => void
  emit: (name: string, payload: any) => void
}
function makeBus(): BusStub {
  const emitted: Array<{ name: string; payload: unknown }> = []
  const handlers: Map<string, (record: { name: string; payload: any }) => void> = new Map()
  return {
    emitted,
    handlers,
    publish: async (event: { name: string }, payload: unknown) => { emitted.push({ name: event.name, payload }) },
    subscribe: (_event: { name: string }, h: (r: { name: string; payload: any }) => void) => { handlers.set(_event.name, h); return () => handlers.delete(_event.name) },
    emit: (name: string, payload: any) => handlers.get(name)?.({ name, payload }),
  }
}

function mkTool(id: string): Tool {
  return {
    id,
    description: `${id} 描述`,
    call: async () => ({ ok: true, output: {} }),
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
  } as unknown as Tool
}

function makeHarness(initTools: Tool[], agentTools: string[]) {
  const registry = new Map<string, Tool>()
  for (const t of initTools) registry.set(t.id, t)
  const calls: string[] = []
  return {
    harness: {
      tools: {
        list: () => [...registry.values()],
        get: (id: string) => registry.get(id),
        unregister: (id: string) => { calls.push(`unreg:${id}`); registry.delete(id) },
        register: (t: Tool) => { calls.push(`reg:${t.id}`); registry.set(t.id, t) },
        filterByWhitelist: (wl: string[] | ['*']) =>
          wl.length === 1 && wl[0] === '*' ? [...registry.values()] : wl.map((id) => registry.get(id)).filter((t): t is Tool => !!t),
      },
      agent: { get: () => ({ id: 'default', tools: agentTools }) },
    } as unknown as CliCommandInput['harness'],
    out: [] as string[],
    saved: [] as Array<[string, string[]]>,
    calls,
  }
}

async function getHooks(bus?: ReturnType<typeof makeBus>): Promise<Hooks> {
  return (await createToolsManagerPlugin().install({ bus: bus ?? makeBus() } as never)) as Hooks
}

async function run(
  h: Hooks,
  arg: string,
  ctx: { harness: unknown; out: string[]; saved: Array<[string, string[]]> },
  toolMeta?: { get(id: string): unknown; list(): unknown[] },
): Promise<CliCommandInput> {
  const input = {
    command: 'tools',
    raw: arg,
    arg,
    sessionId: 's',
    out: (s: string) => { ctx.out.push(s) },
    harness: ctx.harness,
    agentId: 'default',
    setAgentTools: async (id: string, tools: string[]) => { ctx.saved.push([id, tools]) },
    ...(toolMeta ? { toolMeta } : {}),
  } as CliCommandInput
  await h['cli.command']?.(input)
  return input
}

describe('tools-manager 插件', () => {
  it('cli.commands 注册 /tools 命令', async () => {
    const h = await getHooks()
    const defs: Array<{ command: string; description: string; usage?: string }> = []
    await h['cli.commands']?.({ commands: defs })
    expect(defs.some((d) => d.command === 'tools')).toBe(true)
  })

  it('空参数列出当前 Agent 可用工具（白名单 * → 全部）', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('bash'), mkTool('read_file')], ['*'])
    const input = await run(h, '', { harness, out, saved })
    expect(out.join('')).toContain('bash')
    expect(out.join('')).toContain('read_file')
    expect(input.result).toBe('continue') // 关键：避免 cli fallthrough 到"未知命令"
  })

  it('--global off 卸载工具，--global on 恢复注册', async () => {
    const h = await getHooks()
    const { harness, out, saved, calls } = makeHarness([mkTool('bash'), mkTool('read_file')], ['*'])
    await run(h, 'bash --global off', { harness, out, saved })
    expect(calls).toContain('unreg:bash')
    expect(out.join('')).toContain('已全局禁用')
    await run(h, 'bash --global on', { harness, out, saved })
    expect(calls).toContain('reg:bash')
    expect(out.join('')).toContain('已全局启用')
  })

  it('作用域 A：off 从非通配白名单移除并持久化', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('bash'), mkTool('read_file')], ['bash', 'read_file'])
    const input = await run(h, 'bash off', { harness, out, saved })
    expect(saved).toEqual([['default', ['read_file']]])
    expect(out.join('')).toContain('已禁用工具')
    expect(input.result).toBe('continue')
  })

  it('作用域 A：on 追加到白名单并持久化', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('bash'), mkTool('read_file')], ['read_file'])
    await run(h, 'bash on', { harness, out, saved })
    expect(saved).toEqual([['default', ['read_file', 'bash']]])
  })

  it('作用域 A：off 通配白名单展开为显式白名单（排除目标）', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('bash'), mkTool('read_file')], ['*'])
    await run(h, 'bash off', { harness, out, saved })
    expect(saved[0][1]).toEqual(['read_file'])
    expect(out.join('')).toContain('转为显式白名单')
  })

  it('查看工具详情未注册时报错提示', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('bash')], ['*'])
    await run(h, 'nonexistent', { harness, out, saved })
    expect(out.join('')).toContain('未找到')
    expect((await run(h, '', { harness, out, saved })).result).toBe('continue')
  })

  it('列表含状态列：启用/禁用 + 加载状态；元信息含权限键', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('bash')], ['*'])
    await run(h, '', { harness, out, saved })
    const text = out.join('')
    expect(text).toContain('状态')
    expect(text).toContain('权限')
    expect(text).toContain('启用·已加载')
  })

  it('--all 合并未加载工具元信息（状态为 仅元信息），详情回退静态元信息并含权限键', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('bash')], ['*'])
    const meta = {
      get: (id: string) => (id === 'glob' ? { id: 'glob', description: 'glob 描述', isReadOnly: true, permissionKey: 'read' } : undefined),
      list: () => [{ id: 'glob', description: 'glob 描述', isReadOnly: true, permissionKey: 'read' }],
    }
    await run(h, '--all', { harness, out, saved }, meta)
    const text = out.join('')
    expect(text).toContain('glob')
    expect(text).toContain('仅元信息')
    expect(text).toContain('read')
  })
})

describe('tools-manager 事件解耦 + mcp 工具掩码', () => {
  async function runMcp(h: Hooks, arg: string, ctx: {
    harness: unknown; out: string[]; mcpServers: any[]; savedMcp: any[]; bus: ReturnType<typeof makeBus>;
  }): Promise<CliCommandInput> {
    const input = {
      command: 'tools', raw: arg, arg, sessionId: 's',
      out: (s: string) => { ctx.out.push(s) },
      harness: ctx.harness,
      agentId: 'default',
      setAgentTools: async () => undefined,
      mcpServers: ctx.mcpServers,
      setMcpServers: async (list: any[]) => { ctx.savedMcp.push(list) },
    } as unknown as CliCommandInput
    await h['cli.command']?.(input)
    return input
  }

  it('mcp__ 工具 off 写入 server 级掩码；on 删除掩码', async () => {
    const bus = makeBus()
    const h = await getHooks(bus)
    const mcpServers = [{ name: 'github', transport: 'http', url: 'http://g', tools: {} as Record<string, boolean> }]
    const ctx: any = makeHarness([mkTool('mcp__github__create_issue'), mkTool('bash')], ['*'])
    ctx.mcpServers = mcpServers
    ctx.savedMcp = []
    ctx.out = []
    ctx.bus = bus

    // off → 写掩码
    await runMcp(h, 'mcp__github__create_issue off', ctx)
    expect(ctx.savedMcp.length).toBe(1)
    expect(ctx.savedMcp[0][0].tools.create_issue).toBe(false)
    expect(bus.emitted).toContainEqual({ name: 'tool.disabled', payload: { id: 'mcp__github__create_issue', agentId: 'default' } })

    // on → 删除掩码
    await runMcp(h, 'mcp__github__create_issue on', ctx)
    expect(ctx.savedMcp.length).toBe(2)
    expect(ctx.savedMcp[1][0].tools.create_issue).toBeUndefined()
    expect(bus.emitted).toContainEqual({ name: 'tool.enabled', payload: { id: 'mcp__github__create_issue', agentId: 'default' } })
  })

  it('mcp 工具详情视图展示启停语法与 server 状态', async () => {
    const bus = makeBus()
    const h = await getHooks(bus)
    const ctx: any = makeHarness([mkTool('mcp__github__create_issue')], ['*'])
    ctx.mcpServers = [{ name: 'github', transport: 'http', url: 'http://g' }]
    ctx.savedMcp = []
    ctx.out = []
    ctx.bus = bus
    await runMcp(h, 'mcp__github__create_issue', ctx)
    expect(ctx.out.join('')).toContain('mcp__github__create_issue')
    expect(ctx.out.join('')).toContain('on|off')
  })

  it('收到 mcp.server.disabled 后 /tools 列表标注该 server 工具不可用', async () => {
    const bus = makeBus()
    const h = await getHooks(bus)
    const ctx: any = makeHarness([mkTool('mcp__github__create_issue')], ['*'])
    ctx.mcpServers = [{ name: 'github', transport: 'http', url: 'http://g' }]
    ctx.savedMcp = []
    ctx.out = []
    ctx.bus = bus
    // 触发下行事件（等价 /mcp disable github）
    bus.emit('mcp.server.disabled', { name: 'github' })
    await runMcp(h, '', ctx)
    expect(ctx.out.join('')).toContain('·server已禁用')
    expect(ctx.out.join('')).toContain('·源自mcp')
  })

  it('作用域 A 启停发布 tool.* 事件', async () => {
    const bus = makeBus()
    const h = await getHooks(bus)
    const { harness, out, saved } = makeHarness([mkTool('bash'), mkTool('read_file')], ['read_file'])
    await run(h, 'bash on', { harness, out, saved })
    expect(bus.emitted).toContainEqual({ name: 'tool.enabled', payload: { id: 'bash', agentId: 'default' } })
    await run(h, 'read_file off', { harness, out, saved })
    expect(bus.emitted).toContainEqual({ name: 'tool.disabled', payload: { id: 'read_file', agentId: 'default' } })
  })
})