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

function makeHarness(initTools: Tool[], agentTools: string[], agentExtra?: { mcpServers?: string[]; excludeMcpServers?: string[] }) {
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
      agent: { get: () => ({ id: 'default', tools: agentTools, ...(agentExtra ?? {}) }) },
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

  // 展示与执行必须同一判据：core 已把 `mcpServers` 改成"供给"（声明 server ⇒ 该 server 全部工具可用），
  // `/tools` 若仍按 `filterByWhitelist(agent.tools)` 算，就会把"能调"的工具显示成「禁用」。
  it('★ 显式白名单 + 声明 mcpServers ⇒ MCP 工具在列表中显示为「启用」', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness(
      [mkTool('read_file'), mkTool('mcp__gh__create_issue')],
      ['read_file'],
      { mcpServers: ['gh'] },
    )
    await run(h, '', { harness, out, saved })
    const line = out.join('').split('\n').find((l) => l.includes('mcp__gh__create_issue')) ?? ''
    expect(line).toContain('启用')
    expect(line).toContain('源自mcp')
  })

  it('★ 反向：未声明 mcpServers ⇒ 该 MCP 工具不在「Agent 可用工具」列表里', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness(
      [mkTool('read_file'), mkTool('mcp__gh__create_issue')],
      ['read_file'],
    )
    await run(h, '', { harness, out, saved })
    // 未授权工具不进"可用工具"列表（与白名单外的原生工具同规矩），但 --all 里仍在
    expect(out.join('')).not.toContain('mcp__gh__create_issue')
    await run(h, '--all', { harness, out, saved })
    expect(out.join('')).toContain('mcp__gh__create_issue')
  })

  it('★ 详情视图的「当前 Agent 启用」与列表同源（显式白名单内 ⇒ 是；白名单外 ⇒ 否）', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('read_file'), mkTool('bash')], ['read_file'])
    await run(h, 'read_file', { harness, out, saved })
    expect(out.join('')).toContain('当前 Agent 启用：是')
    await run(h, 'bash', { harness, out, saved })
    expect(out.join('')).toContain('当前 Agent 启用：否')
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

describe('tools-manager 边界与契约', () => {
  /** 只喂 mcpServers（刻意不喂 setMcpServers），用于验证"宿主没提供写回能力"这条路径 */
  async function runMcpRaw(
    h: Hooks,
    arg: string,
    o: { harness: unknown; mcpServers: any[]; setMcpServers?: (l: any[]) => Promise<void> },
  ): Promise<string> {
    const out: string[] = []
    const input = {
      command: 'tools', raw: arg, arg, sessionId: 's',
      out: (s: string) => { out.push(s) },
      harness: o.harness,
      agentId: 'default',
      setAgentTools: async () => undefined,
      mcpServers: o.mcpServers,
      ...(o.setMcpServers ? { setMcpServers: o.setMcpServers } : {}),
    } as unknown as CliCommandInput
    await h['cli.command']?.(input)
    return out.join('')
  }

  // `--json` 曾自己抄一份三元链，唯一漏掉的是权限键的 meta 回退 ⇒ 同一个工具
  // 表格里权限列显示 `read`、JSON 里 permissionKey 字段直接消失。两者必须同源。
  it('★ --json 与表格取同一份安全声明与权限键（含 meta 回退）', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('bash')], ['*'])
    const meta = {
      get: (id: string) => (id === 'glob' ? { id: 'glob', description: 'glob 描述', isReadOnly: true, isConcurrencySafe: false, permissionKey: 'read' } : undefined),
      list: () => [{ id: 'glob', description: 'glob 描述', isReadOnly: true, isConcurrencySafe: false, permissionKey: 'read' }],
    }
    await run(h, '--all --json', { harness, out, saved }, meta)
    const rows = JSON.parse(out.join('')) as Array<Record<string, unknown>>
    const glob = rows.find((r) => r.id === 'glob')!
    expect(glob.permissionKey).toBe('read')          // 关键：meta 的 permissionKey 必须回退到 JSON
    expect(glob.isReadOnly).toBe(true)
    expect(glob.isConcurrencySafe).toBe(false)
    // 已加载工具：三个安全位与 entryFlags 同源（mkTool 声明 可写/非危险/并发安全）
    const bash = rows.find((r) => r.id === 'bash')!
    expect(bash.isReadOnly).toBe(false)
    expect(bash.isConcurrencySafe).toBe(true)
    // 与表格视图对照：同一工具在两种视图里的权限键一致
    out.length = 0
    await run(h, '--all', { harness, out, saved }, meta)
    const line = out.join('').split('\n').find((l) => l.includes('glob'))!
    expect(line).toContain('read')
  })

  it('未知选项报「未知选项」而不是被当成工具 id', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('bash')], ['*'])
    await run(h, '--nope', { harness, out, saved })
    const text = out.join('')
    expect(text).toContain('未知选项')
    expect(text).toContain('--nope')
    expect(text).not.toContain('未找到')   // 旧行为：提示去看 /tools --all，指向一个不存在的地方
  })

  // 掩码写 config.json（跨进程持久），--global 写注册池（进程级、易失）—— 语义相反，
  // 静默二选一会让用户以为"本轮临时停用"实际拿到"永久关掉"。
  it('★ MCP 工具拒绝 --global，且不写 config.json', async () => {
    const h = await getHooks()
    const { harness } = makeHarness([mkTool('mcp__github__create_issue')], ['*'])
    const savedMcp: any[] = []
    const text = await runMcpRaw(h, 'mcp__github__create_issue --global off', {
      harness, mcpServers: [{ name: 'github' }],
      setMcpServers: async (l: any[]) => { savedMcp.push(l) },
    })
    expect(text).toContain('不支持 --global')
    expect(savedMcp.length).toBe(0)        // 没有落盘
    expect(text).not.toContain('已禁用 MCP 工具')
  })

  it('★ 宿主未注入 setMcpServers ⇒ 如实报"无法持久化"，不谎称已写入', async () => {
    const h = await getHooks()
    const { harness } = makeHarness([mkTool('mcp__github__create_issue')], ['*'])
    const text = await runMcpRaw(h, 'mcp__github__create_issue off', {
      harness, mcpServers: [{ name: 'github' }],
    })
    expect(text).toContain('无法持久化')
    expect(text).not.toContain('写入 config.json mcpServers')
  })

  it('on 一个不存在的工具 ⇒ 拒绝，不把拼错的 id 写进白名单', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('bash'), mkTool('read_file')], ['read_file'])
    await run(h, 'bogus_tool on', { harness, out, saved })
    expect(out.join('')).toContain('不存在')
    expect(saved.length).toBe(0)           // 关键：config.json 里不留垃圾条目
  })

  it('★ off 一个不存在的工具（通配白名单）⇒ 拒绝，不展开写坏 config.json', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('bash'), mkTool('read_file')], ['*'])
    await run(h, 'bogus_tool off', { harness, out, saved })
    expect(out.join('')).toContain('不存在')
    expect(saved.length).toBe(0)
    expect(out.join('')).not.toContain('转为显式白名单')
  })

  it('★ 持久化抛错 ⇒ 明确报错，不静默伪装成功', async () => {
    const h = await getHooks()
    const { harness } = makeHarness([mkTool('bash'), mkTool('read_file')], ['read_file'])
    const out: string[] = []
    const input = {
      command: 'tools', raw: 'bash on', arg: 'bash on', sessionId: 's',
      out: (s: string) => { out.push(s) }, harness, agentId: 'default',
      setAgentTools: async () => { throw new Error('disk full') },
    } as unknown as CliCommandInput
    await h['cli.command']?.(input)
    expect(out.join('')).toContain('执行失败')
    expect(out.join('')).toContain('disk full')
    expect(out.join('')).not.toContain('已启用工具')
  })

  it('uninstall 把 --global off 卸下的工具还回注册池', async () => {
    const plugin = createToolsManagerPlugin()
    const h = (await plugin.install({ bus: makeBus() } as never)) as Hooks
    const { harness, out, saved } = makeHarness([mkTool('bash')], ['*'])
    await run(h, 'bash --global off', { harness, out, saved })
    expect((harness as any).tools.get('bash')).toBeUndefined()
    await plugin.uninstall!()
    // "本轮进程生效"的终点就是这个插件的生命周期：卸载后不能永久少一个工具
    expect((harness as any).tools.get('bash')).toBeDefined()
  })

  // 此前"同名工具已加载"这条路径没有任何用例：dedupe 只在实际重叠时才生效，
  // 而既有夹具里运行时工具与 meta 的 id 从不相交 ⇒ 去掉去重也全绿。
  it('--all 对「已加载且 meta 里也有」的工具只出现一次', async () => {
    const h = await getHooks()
    const { harness, out, saved } = makeHarness([mkTool('bash')], ['*'])
    const meta = {
      get: () => undefined,
      list: () => [{ id: 'bash', description: 'bash 描述', isReadOnly: false, permissionKey: 'bash' }, { id: 'glob', description: 'g' }],
    }
    await run(h, '--all', { harness, out, saved }, meta)
    const hits = out.join('').split('\n').filter((l) => l.trimStart().startsWith('bash'))
    expect(hits.length).toBe(1)
    expect(out.join('')).toContain('glob')   // 未重叠的 meta 仍要补上
  })

  // agent 定义缺失时的缺省白名单（`?? ['*']`）也是一个"只有出错时才看见"的判据：
  // 若默认成 []，未知 agent id 会显示"零工具"，而运行时实际是全允许。
  it('agent 定义缺失 ⇒ 缺省白名单为通配（全部显示为启用）', async () => {
    const h = await getHooks()
    const registry = new Map<string, Tool>([['bash', mkTool('bash')]])
    const harness = {
      tools: {
        list: () => [...registry.values()],
        get: (id: string) => registry.get(id),
        unregister: (id: string) => { registry.delete(id) },
        register: (t: Tool) => { registry.set(t.id, t) },
        filterByWhitelist: (wl: string[] | ['*']) => (wl.length === 1 && wl[0] === '*' ? [...registry.values()] : []),
      },
      agent: { get: () => undefined },
    }
    const out: string[] = []
    const input = {
      command: 'tools', raw: '', arg: '', sessionId: 's',
      out: (s: string) => { out.push(s) }, harness, agentId: 'ghost',
      setAgentTools: async () => undefined,
    } as unknown as CliCommandInput
    await h['cli.command']?.(input)
    const line = out.join('').split('\n').find((l) => l.trimStart().startsWith('bash'))!
    expect(line).toContain('启用')
  })
})