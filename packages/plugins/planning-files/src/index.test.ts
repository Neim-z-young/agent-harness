import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliCommandInput, CliCommandsInput, Hooks, PluginContext } from '@harness/plugin'
import { createPlanningFilesPlugin, parsePlanArgs, planningFilesSkillContent } from './index'
import { attestPlan, ensurePlanFiles, resolvePlanDir, writePlanFile } from './plan-files'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'plan-plugin-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const PLAN_MD = ['# 任务计划', '', '## Goal', '', '目标甲', '', '## Phase 1: 甲', '- [x] a', '- [ ] b', ''].join('\n')

interface FakeCtx {
  ctx: PluginContext
  warns: string[]
}

function fakeCtx(cwd: string): FakeCtx {
  const warns: string[] = []
  const ctx = {
    bus: {},
    config: { get: () => undefined, set: () => {} },
    log: { info: () => {}, warn: (m: string) => warns.push(m), error: () => {}, debug: () => {} },
    workspace: {
      cwd,
      dataDir: join(cwd, '.harness'),
      user: { root: cwd, plugins: '', skills: '', agents: '', memory: '' },
      project: { root: cwd, plugins: '', skills: '', agents: '', memory: '' },
    },
  } as unknown as PluginContext
  return { ctx, warns }
}

interface PreModelInput {
  sessionId: string
  agentId: string
  providerId: string
  modelId?: string
  parentSessionId?: string
  save: (m: unknown[]) => Promise<void>
}

function preInput(sessionId = 's1', parentSessionId?: string): { input: PreModelInput; saves: number[] } {
  const saves: number[] = []
  const input: PreModelInput = {
    sessionId,
    agentId: 'default',
    providerId: 'mock',
    save: async () => {
      saves.push(1)
    },
  }
  if (parentSessionId !== undefined) input.parentSessionId = parentSessionId
  return { input, saves }
}

type Msg = { id: string; role: string; parts: Array<{ type: string; text: string }>; createdAt: number }

async function install(opts: Parameters<typeof createPlanningFilesPlugin>[0] = {}): Promise<Hooks> {
  const plugin = createPlanningFilesPlugin(opts)
  const { ctx } = fakeCtx(opts.cwd ?? process.cwd())
  const hooks = (await plugin.install!(ctx)) as Hooks
  return hooks
}

describe('parsePlanArgs', () => {
  it('解析 --use / flag / 剩余文本', () => {
    expect(parsePlanArgs('/plan 把 A 做完 --force')).toEqual({ flags: ['force'], text: '把 A 做完' })
    expect(parsePlanArgs('/plan --use task-b')).toEqual({ flags: [], use: 'task-b', text: '' })
    expect(parsePlanArgs('/plan-attest --clear')).toEqual({ flags: ['clear'], text: '' })
    expect(parsePlanArgs('/plan')).toEqual({ flags: [], text: '' })
  })
})

describe('preModel 注入', () => {
  it('计划未初始化 ⇒ 不注入（未启用/未建计划时零行为）', async () => {
    const cwd = tmp()
    const hooks = await install({ cwd })
    const messages: Msg[] = []
    const { input, saves } = preInput()
    hooks['core.session.preModel']!(input as never, messages as never)
    expect(messages).toHaveLength(0)
    expect(saves).toHaveLength(0)
  })

  it('注入一条 user 消息（尾部），且**不落历史**（save 一次都没调）', async () => {
    const cwd = tmp()
    ensurePlanFiles(resolvePlanDir(cwd))
    writePlanFile(resolvePlanDir(cwd), 'task_plan.md', PLAN_MD)
    const hooks = await install({ cwd })
    const messages: Msg[] = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: '你好' }], createdAt: 1 }]
    const { input, saves } = preInput()
    hooks['core.session.preModel']!(input as never, messages as never)
    expect(messages).toHaveLength(2)
    expect(messages[0]!.id).toBe('m1')
    expect(messages[1]!.role).toBe('user')
    expect(messages[1]!.parts[0]!.text).toContain('===BEGIN PLAN DATA===')
    expect(messages[1]!.parts[0]!.text).toContain('下一步: b')
    expect(saves).toHaveLength(0)
  })

  it('计划未变 ⇒ 第二轮的注入文本与第一轮**逐字相同**（D8 缓存友好）', async () => {
    const cwd = tmp()
    ensurePlanFiles(resolvePlanDir(cwd))
    writePlanFile(resolvePlanDir(cwd), 'task_plan.md', PLAN_MD)
    const hooks = await install({ cwd })
    const m1: Msg[] = []
    const m2: Msg[] = []
    hooks['core.session.preModel']!(preInput('s1').input as never, m1 as never)
    hooks['core.session.preModel']!(preInput('s1').input as never, m2 as never)
    expect(m2[0]!.parts[0]!.text).toBe(m1[0]!.parts[0]!.text)
  })

  it('子会话默认不注入；includeSubagents: true 才注入', async () => {
    const cwd = tmp()
    ensurePlanFiles(resolvePlanDir(cwd))
    writePlanFile(resolvePlanDir(cwd), 'task_plan.md', PLAN_MD)
    const sub: Msg[] = []
    const hooks = await install({ cwd })
    hooks['core.session.preModel']!(preInput('s2', 'parent-1').input as never, sub as never)
    expect(sub).toHaveLength(0)

    const withSub: Msg[] = []
    const hooks2 = await install({ cwd, includeSubagents: true })
    hooks2['core.session.preModel']!(preInput('s2', 'parent-1').input as never, withSub as never)
    expect(withSub).toHaveLength(1)
  })

  it('inject: false ⇒ 命令仍注册但不注入', async () => {
    const cwd = tmp()
    ensurePlanFiles(resolvePlanDir(cwd))
    writePlanFile(resolvePlanDir(cwd), 'task_plan.md', PLAN_MD)
    const hooks = await install({ cwd, inject: false })
    const messages: Msg[] = []
    hooks['core.session.preModel']!(preInput().input as never, messages as never)
    expect(messages).toHaveLength(0)
    const cmds: CliCommandsInput = { commands: [] }
    hooks['cli.commands']!(cmds)
    expect(cmds.commands.map((c) => c.command)).toContain('plan')
  })

  it('计划被改而未重新认证 ⇒ 只注入 TAMPERED 告警（不含计划正文）', async () => {
    const cwd = tmp()
    const root = resolvePlanDir(cwd)
    ensurePlanFiles(root)
    writePlanFile(root, 'task_plan.md', PLAN_MD)
    attestPlan(root)
    writePlanFile(root, 'task_plan.md', `${PLAN_MD}\n- [ ] 偷偷加的\n`)
    const hooks = await install({ cwd })
    const messages: Msg[] = []
    hooks['core.session.preModel']!(preInput().input as never, messages as never)
    const text = messages[0]!.parts[0]!.text
    expect(text).toContain('[PLAN TAMPERED]')
    expect(text).not.toContain('下一步: b')
  })

  it('tail 放置：计划块是**最后一条**（后面没有别的消息）', async () => {
    const cwd = tmp()
    ensurePlanFiles(resolvePlanDir(cwd))
    writePlanFile(resolvePlanDir(cwd), 'task_plan.md', PLAN_MD)
    const hooks = await install({ cwd })
    const messages: Msg[] = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }]
    hooks['core.session.preModel']!(preInput().input as never, messages as never)
    expect(messages[messages.length - 1]!.parts[0]!.text).toContain('===END PLAN DATA===')
  })
})

describe('cli.commands / cli.command', () => {
  function run(hooks: Hooks, raw: string): string {
    let text = ''
    const input = {
      raw,
      command: raw.split(/\s+/)[0]!.replace(/^\//, ''),
      arg: raw.split(/\s+/).slice(1).join(' '),
      out: (t: string) => {
        text += t
      },
      sessionId: 's1',
    } as unknown as CliCommandInput
    hooks['cli.command']!(input)
    return text
  }

  it('注册 5 个命令且带用法', async () => {
    const hooks = await install({ cwd: tmp() })
    const cmds: CliCommandsInput = { commands: [] }
    hooks['cli.commands']!(cmds)
    expect(cmds.commands.map((c) => c.command)).toEqual(['plan', 'plan-status', 'plan-attest', 'plan-doctor', 'plan-complete'])
    expect(cmds.commands.every((c) => typeof c.usage === 'string' && c.usage.length > 0)).toBe(true)
  })

  it('非本插件命令直接返回（不产出输出）', async () => {
    const hooks = await install({ cwd: tmp() })
    expect(run(hooks, '/help')).toBe('')
  })

  it('/plan 初始化三文件并展示；第二次运行不覆盖', async () => {
    const cwd = tmp()
    const hooks = await install({ cwd })
    const first = run(hooks, '/plan 把 X 做成 Y')
    expect(first).toContain('新建 3 个')
    expect(first).toContain('目标：把 X 做成 Y')
    const second = run(hooks, '/plan')
    expect(second).toContain('已存在 3 个')
  })

  it('/plan-status 在未初始化时给出可执行提示', async () => {
    const hooks = await install({ cwd: tmp() })
    expect(run(hooks, '/plan-status')).toContain('尚无计划')
  })

  it('/plan-status 展示认证不一致', async () => {
    const cwd = tmp()
    const root = resolvePlanDir(cwd)
    ensurePlanFiles(root)
    writePlanFile(root, 'task_plan.md', PLAN_MD)
    attestPlan(root)
    writePlanFile(root, 'task_plan.md', `${PLAN_MD}\n- [ ] z\n`)
    const hooks = await install({ cwd })
    const out = run(hooks, '/plan-status')
    expect(out).toContain('不一致')
    expect(out).toContain('PLAN TAMPERED')
  })

  it('/plan-attest 认证 → /plan-status 报已认证；--clear 后回到未认证', async () => {
    const cwd = tmp()
    const root = resolvePlanDir(cwd)
    ensurePlanFiles(root)
    writePlanFile(root, 'task_plan.md', PLAN_MD)
    const hooks = await install({ cwd })
    expect(run(hooks, '/plan-attest')).toContain('已认证')
    expect(run(hooks, '/plan-status')).toContain('（已认证）')
    expect(run(hooks, '/plan-attest --clear')).toContain('已清除认证')
    expect(run(hooks, '/plan-status')).toContain('未认证')
  })

  it('/plan-doctor 逐项自检', async () => {
    const cwd = tmp()
    const root = resolvePlanDir(cwd)
    ensurePlanFiles(root)
    writePlanFile(root, 'task_plan.md', PLAN_MD)
    attestPlan(root)
    const hooks = await install({ cwd })
    const out = run(hooks, '/plan-doctor')
    expect(out).toContain('task_plan.md')
    expect(out).toContain('解析：✅')
    expect(out).toContain('认证：✅')
    expect(out).toContain('注入：✅ 开启')
  })

  it('/plan-doctor 在未认证 / 空计划时给出 ⚠️', async () => {
    const cwd = tmp()
    ensurePlanFiles(resolvePlanDir(cwd)) // 模板 ⇒ 有条目（模板里有复选框）
    const hooks = await install({ cwd })
    const out = run(hooks, '/plan-doctor')
    expect(out).toContain('认证：⚠️ 未认证')
  })

  it('/plan-complete 列出未完成项；全完成时提示可收尾', async () => {
    const cwd = tmp()
    const root = resolvePlanDir(cwd)
    ensurePlanFiles(root)
    writePlanFile(root, 'task_plan.md', PLAN_MD)
    const hooks = await install({ cwd })
    const partial = run(hooks, '/plan-complete')
    expect(partial).toContain('完成度：1/2')
    expect(partial).toContain('- [ ] b')
    writePlanFile(root, 'task_plan.md', '## Phase 1: 甲\n- [x] a\n- [x] b\n')
    expect(run(hooks, '/plan-complete')).toContain('全部条目已完成')
  })

  it('命令异常被兜住（输出错误而不是抛穿）', async () => {
    const cwd = tmp()
    ensurePlanFiles(resolvePlanDir(cwd))
    const hooks = await install({ cwd })
    // --use 传非法 slug ⇒ setActivePlan 抛错 ⇒ 命令层捕获
    expect(run(hooks, '/plan --use ../evil')).toContain('命令失败')
  })
})

describe('skill 注册', () => {
  it('core.harness.init 注册 plugin 来源 skill（内容非空、含三文件名）', async () => {
    const hooks = await install({ cwd: tmp() })
    const registered: Array<Record<string, unknown>> = []
    const output = {
      harness: {
        skillManager: {
          register: (s: Record<string, unknown>) => {
            registered.push(s)
          },
        },
      },
    }
    hooks['core.harness.init']!({ } as never, output as never)
    expect(registered).toHaveLength(1)
    const skill = registered[0]!
    expect(skill['id']).toBe('planning-files')
    expect(skill['loadedFrom']).toBe('plugin')
    expect(skill['userInvocable']).toBe(true)
    expect(String(skill['content'])).toContain('task_plan.md')
    expect(planningFilesSkillContent).toContain('/plan-attest')
  })

  it('没有 skillManager 时静默返回（非 CLI 宿主不崩）', async () => {
    const hooks = await install({ cwd: tmp() })
    expect(() => hooks['core.harness.init']!({} as never, { harness: {} } as never)).not.toThrow()
  })
})
