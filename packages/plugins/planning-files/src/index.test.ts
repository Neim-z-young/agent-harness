import { describe, it, expect, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliCommandInput, CliCommandsInput, Hooks, PluginContext } from '@harness/plugin'
import { createPlanningFilesPlugin, parsePlanArgs, planningFilesSkillContent } from './index'
import { attestPlan, ensurePlanFiles, readPlanFiles, resolvePlanDir, resolvePlanRoot, setActivePlan, writePlanFile } from './plan-files'

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

/** 往 `fakeCtx` 约定的 dataDir（`<cwd>/.harness`）里放一个会话文件（供 /plan-catchup 用） */
function writeSession(cwd: string, sessionId: string, turns: Array<{ role: string; text: string }>, title = '会话标题'): void {
  const dir = join(cwd, '.harness', 'sessions')
  mkdirSync(dir, { recursive: true })
  const messages = turns.map((t) => ({ role: t.role, parts: [{ type: 'text', text: t.text }] }))
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ title, messages }), 'utf8')
}

describe('parsePlanArgs', () => {
  it('解析 --use / flag / 剩余文本', () => {
    expect(parsePlanArgs('/plan 把 A 做完 --force')).toEqual({ flags: ['force'], text: '把 A 做完' })
    expect(parsePlanArgs('/plan --use task-b')).toEqual({ flags: [], use: 'task-b', text: '' })
    // 原始行里没有 shell 拆词 ⇒ 引号原样进来，必须归一成空串（否则会当成非法 slug 抛错）
    expect(parsePlanArgs('/plan --use ""')).toEqual({ flags: [], use: '', text: '' })
    expect(parsePlanArgs("/plan --use ''")).toEqual({ flags: [], use: '', text: '' })
    expect(parsePlanArgs('/plan-attest --clear')).toEqual({ flags: ['clear'], text: '' })
    expect(parsePlanArgs('/plan')).toEqual({ flags: [], text: '' })
  })

  it('子动作只在**首个** token 上识别：`use` 出现在目标文本里不算子动作', () => {
    expect(parsePlanArgs('/plan use task-b')).toEqual({ flags: [], use: 'task-b', text: '', sub: 'use' })
    expect(parsePlanArgs('/plan use')).toEqual({ flags: [], text: '', sub: 'use' })
    expect(parsePlanArgs('/plan use ""')).toEqual({ flags: [], use: '', text: '', sub: 'use' })
    expect(parsePlanArgs('/plan list')).toEqual({ flags: [], text: '', sub: 'list' })
    expect(parsePlanArgs('/plan catchup')).toEqual({ flags: [], text: '', sub: 'catchup' })
    // 关键边界：目标文本里的 use / list 不该被当成子动作吃掉
    expect(parsePlanArgs('/plan 把 use 命令做完')).toEqual({ flags: [], text: '把 use 命令做完' })
    expect(parsePlanArgs('/plan 整理 list 输出')).toEqual({ flags: [], text: '整理 list 输出' })
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
    expect(messages[1]!.parts[0]!.text).toContain('未完成阶段: 1 个（Phase 1）')
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

/** 跑一条 `/plan*` 命令并收集输出（模块级：多个 describe 共用） */
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

describe('cli.commands / cli.command', () => {
  it('注册 6 个命令且带用法', async () => {
    const hooks = await install({ cwd: tmp() })
    const cmds: CliCommandsInput = { commands: [] }
    hooks['cli.commands']!(cmds)
    expect(cmds.commands.map((c) => c.command)).toEqual([
      'plan',
      'plan-status',
      'plan-attest',
      'plan-doctor',
      'plan-catchup',
      'plan-complete',
    ])
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
    expect(partial).toContain('未完成阶段 1 个')
    expect(partial).toContain('- [ ] b')
    writePlanFile(root, 'task_plan.md', '## Phase 1: 甲\n- [x] a\n- [x] b\n')
    const done = run(hooks, '/plan-complete')
    expect(done).toContain('全部条目已完成')
    expect(done).toContain('未完成阶段 0 个')
  })

  it('命令异常被兜住（输出错误而不是抛穿）', async () => {
    const cwd = tmp()
    ensurePlanFiles(resolvePlanDir(cwd))
    const hooks = await install({ cwd })
    // --use 传非法 slug ⇒ setActivePlan 抛错 ⇒ 命令层捕获
    expect(run(hooks, '/plan --use ../evil')).toContain('命令失败')
  })
})

describe('阶段四：多计划', () => {
  it('/plan use <名> 切到不存在的计划 ⇒ 用模板建起来（不报"没有这个计划"）', async () => {
    const cwd = tmp()
    const hooks = await install({ cwd })
    const out = run(hooks, '/plan use task-b')
    expect(out).toContain('已切换到计划 task-b')
    expect(out).toContain('新建 3 个文件')
    expect(readPlanFiles(join(resolvePlanDir(cwd), 'task-b'))['task_plan.md']).toContain('#')
  })

  it('/plan use 落到已有计划 ⇒ 报「已存在」不覆盖', async () => {
    const cwd = tmp()
    const dir = resolvePlanDir(cwd)
    writePlanFile(join(dir, 'task-b'), 'task_plan.md', '## Phase 1: b\n- [x] x\n')
    const hooks = await install({ cwd })
    const out = run(hooks, '/plan use task-b')
    expect(out).toContain('已存在 3 个文件')
    expect(out).toContain('1/1 条完成')
  })

  it('/plan use "" 回落默认计划', async () => {
    const cwd = tmp()
    const dir = resolvePlanDir(cwd)
    ensurePlanFiles(dir)
    setActivePlan(dir, 'task-b')
    const hooks = await install({ cwd })
    expect(run(hooks, '/plan use ""')).toContain('已回落到默认计划')
    expect(run(hooks, '/plan list')).toContain('▶ （默认）')
  })

  it('/plan use 无参只展示、**不改状态**（误敲不该清掉活动计划）', async () => {
    const cwd = tmp()
    const dir = resolvePlanDir(cwd)
    ensurePlanFiles(dir)
    writePlanFile(join(dir, 'task-b'), 'task_plan.md', '## Phase 1: b\n- [ ] x\n')
    setActivePlan(dir, 'task-b')
    const hooks = await install({ cwd })
    const out = run(hooks, '/plan use')
    expect(out).toContain('当前活动计划：task-b')
    expect(out).toContain('▶ task-b')
    expect(run(hooks, '/plan use')).toContain('当前活动计划：task-b') // 仍是 task-b
  })

  it('/plan list 空计划目录给可执行提示', async () => {
    const hooks = await install({ cwd: tmp() })
    expect(run(hooks, '/plan list')).toContain('尚无任何计划')
  })

  it('切换后注入与状态都读新计划（resolvePlanRoot 生效）', async () => {
    const cwd = tmp()
    const dir = resolvePlanDir(cwd)
    writePlanFile(dir, 'task_plan.md', PLAN_MD)
    writePlanFile(join(dir, 'task-b'), 'task_plan.md', '## Phase 1: b\n- [ ] 只属于 task-b\n')
    const hooks = await install({ cwd })
    expect(run(hooks, '/plan-status')).toContain('下一步：b')

    run(hooks, '/plan use task-b')
    expect(resolvePlanRoot(dir)).toBe(join(dir, 'task-b'))
    expect(run(hooks, '/plan-status')).toContain('下一步：只属于 task-b')
    expect(run(hooks, '/plan-status')).toContain('活动计划：task-b')
  })
})

describe('阶段四：进度回退（并行写守卫降级版）', () => {
  it('认证后完成项被改回未完成 ⇒ /plan-status 报回退', async () => {
    const cwd = tmp()
    const root = resolvePlanDir(cwd)
    writePlanFile(root, 'task_plan.md', '## Phase 1: a\n- [x] x\n- [x] y\n')
    attestPlan(root) // 快照 = 2
    writePlanFile(root, 'task_plan.md', '## Phase 1: a\n- [x] x\n- [ ] y\n') // 掉回 1
    const hooks = await install({ cwd })
    const out = run(hooks, '/plan-status')
    expect(out).toContain('进度回退')
    expect(out).toContain('少 1 条')
  })

  it('正常推进（完成数上升）不报回退', async () => {
    const cwd = tmp()
    const root = resolvePlanDir(cwd)
    writePlanFile(root, 'task_plan.md', '## Phase 1: a\n- [x] x\n- [ ] y\n')
    attestPlan(root) // 快照 = 1
    writePlanFile(root, 'task_plan.md', '## Phase 1: a\n- [x] x\n- [x] y\n') // 升到 2
    const hooks = await install({ cwd })
    expect(run(hooks, '/plan-status')).not.toContain('进度回退')
  })

  it('/plan-doctor 带出多计划 / 进度守卫 / catchup 三行', async () => {
    const cwd = tmp()
    const root = resolvePlanDir(cwd)
    ensurePlanFiles(root)
    writePlanFile(root, 'task_plan.md', PLAN_MD)
    attestPlan(root)
    const hooks = await install({ cwd })
    const out = run(hooks, '/plan-doctor')
    expect(out).toContain('多计划：默认计划（共 1 个')
    expect(out).toContain('进度守卫：✅ 无回退')
    expect(out).toContain('catchup：（本会话尚未 /plan-catchup）')
  })
})

describe('阶段四：catchup', () => {
  it('/plan-catchup 把本会话轮次写进 progress.md（保留原文、带 marker）', async () => {
    const cwd = tmp()
    const root = resolvePlanDir(cwd)
    ensurePlanFiles(root)
    writeSession(cwd, 's1', [
      { role: 'user', text: '做 A' },
      { role: 'assistant', text: 'A 做完了' },
    ])
    const hooks = await install({ cwd })
    const out = run(hooks, '/plan-catchup')
    expect(out).toContain('已把 2 轮汇总进 progress.md')
    const progress = readPlanFiles(root)['progress.md']
    expect(progress).toContain('<!-- plan-catchup:s1 -->')
    expect(progress).toContain('- 用户：做 A')
    expect(progress).toContain('- 助手：A 做完了')
    expect(progress).toContain('会话标题')
  })

  it('同一会话再跑一次 ⇒ 跳过，progress.md 不再增长（追加式文件不能写两份）', async () => {
    const cwd = tmp()
    const root = resolvePlanDir(cwd)
    ensurePlanFiles(root)
    writeSession(cwd, 's1', [{ role: 'user', text: '做 A' }])
    const hooks = await install({ cwd })
    run(hooks, '/plan-catchup')
    const first = readPlanFiles(root)['progress.md']
    expect(run(hooks, '/plan-catchup')).toContain('已 catchup 过，跳过')
    expect(readPlanFiles(root)['progress.md']).toBe(first)
  })

  it('会话文件不存在 ⇒ 明确提示（不写空节）', async () => {
    const cwd = tmp()
    const root = resolvePlanDir(cwd)
    ensurePlanFiles(root)
    const before = readPlanFiles(root)['progress.md']
    const hooks = await install({ cwd })
    expect(run(hooks, '/plan-catchup')).toContain('找不到会话文件')
    expect(readPlanFiles(root)['progress.md']).toBe(before)
  })

  it('尚无计划 ⇒ 提示先 /plan（不建文件）', async () => {
    const hooks = await install({ cwd: tmp() })
    expect(run(hooks, '/plan-catchup')).toContain('尚无计划')
  })

  it('宿主未提供 dataDir ⇒ 明确报"无法定位"，不猜路径', async () => {
    const cwd = tmp()
    ensurePlanFiles(resolvePlanDir(cwd))
    const plugin = createPlanningFilesPlugin({ cwd })
    const { ctx } = fakeCtx(cwd)
    const bare = { ...ctx, workspace: { cwd } } as unknown as PluginContext // 无 dataDir
    const hooks = (await plugin.install!(bare)) as Hooks
    expect(run(hooks, '/plan-catchup')).toContain('未提供 dataDir')
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
