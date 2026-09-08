import { describe, it, expect } from 'bun:test'
import type { CliCommandInput, Hooks, AgentPlugin, LoadedPlugin } from '@harness/plugin'
import { createPluginManagerPlugin } from './index'

function mkPlugin(id: string): AgentPlugin {
  return {
    id,
    name: id,
    version: '1.0.0',
    install: async () => ({}),
  } as AgentPlugin
}

function makeCtx(loaded: AgentPlugin[]) {
  const emitted: Array<{ name: string; payload: unknown }> = []
  const loadedList: LoadedPlugin[] = loaded.map((p) => ({ plugin: p, hooks: {}, loadedAt: 0, source: 'internal' }))
  const calls: string[] = []
  // 可直接控制的桩 harness
  const h = {
    plugin: {
      list: () => [...loadedList],
      unload: async (id: string) => { calls.push(`unload:${id}`); const i = loadedList.findIndex((x) => x.plugin.id === id); if (i >= 0) loadedList.splice(i, 1) },
      loadInternal: async (plugins: AgentPlugin[]) => { calls.push(`loadInternal:${plugins.map((p) => p.id).join(',')}`); for (const p of plugins) { if (!loadedList.some((x) => x.plugin.id === p.id)) loadedList.push({ plugin: p, hooks: {}, loadedAt: 0, source: 'internal' }) } },
      hotReload: async (id: string) => { calls.push(`hotReload:${id}`) },
    },
    bus: {
      publish: async (event: { name: string }, payload: unknown) => { emitted.push({ name: event.name, payload }) },
    },
  }
  return {
    h,
    calls,
    emitted,
    readLoaded: () => loadedList.map((x) => x.plugin.id),
    manageable: new Map<string, AgentPlugin>(loaded.map((p) => [p.id, p])),
  }
}

async function getHooks() {
  return (await createPluginManagerPlugin().install({} as never)) as Hooks
}

async function run(h: Hooks, arg: string, ctx: ReturnType<typeof makeCtx>, extra?: Record<string, unknown>): Promise<CliCommandInput> {
  const input = {
    command: 'plugins',
    raw: arg,
    arg,
    sessionId: 's',
    out: (s: string) => { (ctx as unknown as { out: string[] }).out?.push(s) },
    harness: ctx.h,
    manageablePlugin: (id: string) => ctx.manageable.get(id),
    pluginManageable: (id: string) => ctx.manageable.has(id),
    ...(extra ?? {}),
  } as unknown as CliCommandInput
  await h['cli.command']?.(input)
  return input
}

describe('manage-plugin 插件', () => {
  it('cli.commands 注册 /plugins 命令', async () => {
    const h = await getHooks()
    const defs: Array<{ command: string; description: string; usage?: string }> = []
    await h['cli.commands']?.({ commands: defs })
    expect(defs.some((d) => d.command === 'plugins')).toBe(true)
  })

  it('list：输出 ID + 名称 + 版本 + 来源 + 可管理标记', async () => {
    const h = await getHooks()
    const ctx = makeCtx([mkPlugin('tools-manager'), mkPlugin('core.skill')])
    ctx.manageable.delete('core.skill') // 内置不可管理
    const ctxOut: string[] = []
    ;(ctx as unknown as { out: string[] }).out = ctxOut
    const input = await run(h, '', ctx)
    const text = ctxOut.join('')
    expect(text).toContain('tools-manager')
    expect(text).toContain('可管理')
    expect(text).toContain('内置')
    expect(input.result).toBe('continue')
  })

  it('disable：卸载并发布 plugin.unloaded', async () => {
    const h = await getHooks()
    const ctx = makeCtx([mkPlugin('tools-manager')])
    const ctxOut: string[] = []
    ;(ctx as unknown as { out: string[] }).out = ctxOut
    await run(h, 'disable tools-manager', ctx)
    expect(ctx.calls).toContain('unload:tools-manager')
    expect(ctx.readLoaded()).toEqual([])
    expect(ctx.emitted).toContainEqual({ name: 'plugin.unloaded', payload: { id: 'tools-manager' } })
  })

  it('disable 不可管理插件返回错误且不发事件', async () => {
    const h = await getHooks()
    const ctx = makeCtx([mkPlugin('core.skill')])
    ctx.manageable.delete('core.skill')
    const ctxOut: string[] = []
    ;(ctx as unknown as { out: string[] }).out = ctxOut
    await run(h, 'disable core.skill', ctx)
    expect(ctxOut.join('')).toContain('不受管理')
    expect(ctx.emitted.length).toBe(0)
  })

  it('enable：loadInternal 并发布 plugin.loaded', async () => {
    const h = await getHooks()
    const ctx = makeCtx([])
    const ctxOut: string[] = []
    ;(ctx as unknown as { out: string[] }).out = ctxOut
    ctx.manageable.set('tools-manager', mkPlugin('tools-manager'))
    await run(h, 'enable tools-manager', ctx)
    expect(ctx.calls).toContain('loadInternal:tools-manager')
    expect(ctx.readLoaded()).toEqual(['tools-manager'])
    expect(ctx.emitted).toContainEqual({ name: 'plugin.loaded', payload: { id: 'tools-manager' } })
  })

  it('enable 已启用插件幂等：不发事件', async () => {
    const h = await getHooks()
    const ctx = makeCtx([mkPlugin('tools-manager')])
    const ctxOut: string[] = []
    ;(ctx as unknown as { out: string[] }).out = ctxOut
    await run(h, 'enable tools-manager', ctx)
    expect(ctxOut.join('')).toContain('已是启用状态')
    expect(ctx.emitted.length).toBe(0)
  })

  it('reload：hotReload 并发布 plugin.updated', async () => {
    const h = await getHooks()
    const ctx = makeCtx([mkPlugin('tools-manager')])
    const ctxOut: string[] = []
    ;(ctx as unknown as { out: string[] }).out = ctxOut
    await run(h, 'reload tools-manager', ctx)
    expect(ctx.calls).toContain('hotReload:tools-manager')
    expect(ctx.emitted).toContainEqual({ name: 'plugin.updated', payload: { id: 'tools-manager' } })
  })

  it('list：禁用插件后仍显示（已登记未加载），标注「已禁用」并支持重新启用', async () => {
    const h = await getHooks()
    const ctx = makeCtx([mkPlugin('tools-manager')]) // 仅 tools-manager 已加载
    const ctxOut: string[] = []
    ;(ctx as unknown as { out: string[] }).out = ctxOut

    // 模拟 code-intel 已登记但被禁用（不在 loaded，在 availablePlugins）
    ctx.manageable.set('code-intel', mkPlugin('code-intel'))
    await run(h, '', ctx, { availablePlugins: () => [
      { id: 'tools-manager', name: 'tools-manager', version: '1.0.0' },
      { id: 'code-intel', name: 'code-intel', version: '1.0.0' },
    ] })

    const text = ctxOut.join('')
    expect(text).toContain('tools-manager')
    expect(text).toContain('已加载')
    expect(text).toContain('code-intel')
    expect(text).toContain('已禁用')

    // 禁用后 enable 可恢复
    const out2: string[] = []
    ;(ctx as unknown as { out: string[] }).out = out2
    await run(h, 'enable code-intel', ctx)
    expect(ctx.calls).toContain('loadInternal:code-intel')
  })
})