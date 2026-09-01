import { describe, it, expect } from 'bun:test'
import type { CliCommandInput, Hooks } from '@harness/plugin'
import type { Tool } from '@harness/tool'
import { createToolsManagerPlugin } from './index'

function mkTool(id: string): Tool {
  return { id, description: `${id} 描述` } as Tool
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

async function getHooks() {
  return (await createToolsManagerPlugin().install({} as never)) as Hooks
}

async function run(
  h: Hooks,
  arg: string,
  ctx: { harness: unknown; out: string[]; saved: Array<[string, string[]]> },
) {
  const input = {
    command: 'tools',
    raw: arg,
    arg,
    sessionId: 's',
    out: (s: string) => { ctx.out.push(s) },
    harness: ctx.harness,
    agentId: 'default',
    setAgentTools: async (id: string, tools: string[]) => { ctx.saved.push([id, tools]) },
  } as CliCommandInput
  await h['cli.command']?.(input)
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
    await run(h, '', { harness, out, saved })
    expect(out.join('')).toContain('bash')
    expect(out.join('')).toContain('read_file')
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
    await run(h, 'bash off', { harness, out, saved })
    expect(saved).toEqual([['default', ['read_file']]])
    expect(out.join('')).toContain('已禁用工具')
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
  })
})