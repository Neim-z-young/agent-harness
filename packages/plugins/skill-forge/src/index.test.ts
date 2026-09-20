import { describe, it, expect } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSkillManager } from '@harness/skill'
import {
  TraceRecorder,
  collapseCycle,
  createSkillForgePlugin,
  draftFromTrace,
  draftToSkill,
  findSimilarSkill,
  parseArgs,
  renderDraft,
  summarizeInput,
  validateDraft,
  type SkillDraft,
} from './index'

// ===== 测试替身 =====

function fakeCtx(over: Record<string, unknown> = {}): any {
  return {
    bus: { publish: () => {}, subscribe: () => () => {}, subscribeAll: () => () => {} },
    config: { get: () => undefined, set: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    ...over,
  }
}

/** 造一个两级 skills 目录 + manager 的插件环境，并返回命令收集器 */
async function setup(opts: { maxSkills?: number } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'forge-'))
  const ws = {
    cwd: base,
    dataDir: base,
    user: { root: base, plugins: '', skills: join(base, 'user-skills'), agents: '', memory: '' },
    project: { root: base, plugins: '', skills: join(base, 'project-skills'), agents: '', memory: '' },
  }
  const manager = createSkillManager()
  const plugin = createSkillForgePlugin({ workspace: ws, skillManager: manager, ...opts })

  // install 时注入 workspace；再模拟 core.harness.init 注入 harness（含 skillManager）
  const hooks = (await plugin.install(fakeCtx({ workspace: ws }))) as Record<string, any>
  hooks['core.harness.init']({}, { harness: { skillManager: manager } })
  await new Promise((r) => setTimeout(r, 0)) // 等 ensureDirs 的 microtask

  const lines: string[] = []
  const run = (arg: string) => {
    const input: any = { command: 'skill-forge', arg, out: (t: string) => lines.push(t), sessionId: 's1', raw: `skill-forge ${arg}` }
    hooks['cli.command'](input)
    return input.result
  }
  const record = (toolId: string, input: unknown, ok = true, error?: string) => {
    hooks['core.tool.post.execute'](
      { tool: { id: toolId }, input, ctx: { sessionId: 's1' } },
      ok ? { ok: true } : { ok: false, error: { message: error ?? '失败' } },
    )
  }
  return { base, ws, manager, hooks, lines, run, record }
}

// ===== 轨迹与草稿 =====

describe('TraceRecorder', () => {
  it('按会话隔离，且条数有界', () => {
    const r = new TraceRecorder({ maxEntries: 3, maxSessions: 2 })
    for (let i = 0; i < 10; i += 1) r.record('s1', { toolId: `t${i}`, inputSummary: '', ok: true })
    expect(r.list('s1')).toHaveLength(3)
    expect(r.list('s1')[0]!.toolId).toBe('t7') // FIFO 丢最旧
    r.record('s2', { toolId: 'x', inputSummary: '', ok: true })
    r.record('s3', { toolId: 'y', inputSummary: '', ok: true })
    expect(r.list('s1')).toHaveLength(0) // 会话数上限 ⇒ 最早插入的 s1 被 FIFO 淘汰
    expect(r.list('s3')).toHaveLength(1)
  })
})

describe('draftFromTrace', () => {
  const trace = [
    { toolId: 'list_dir', inputSummary: 'path=.', ok: true },
    { toolId: 'list_dir', inputSummary: 'path=.', ok: true }, // 连续重复 ⇒ 合并
    { toolId: 'read_file', inputSummary: 'path=a.ts', ok: false, error: 'ENOENT' },
    { toolId: 'bash', inputSummary: 'command=ls', ok: true },
  ]

  it('合并连续重复调用，并保留失败作为「坑」', () => {
    const d = draftFromTrace('demo', trace)
    expect(d.steps).toHaveLength(3)
    expect(d.pitfalls).toHaveLength(1)
    expect(d.pitfalls[0]).toContain('ENOENT')
  })

  it('无轨迹时给出占位步骤（不产出一个空技能）', () => {
    const d = draftFromTrace('empty', [])
    expect(d.steps[0]).toContain('请手工补充')
    expect(validateDraft(d).ok).toBe(true)
  })

  it('description 缺省由轨迹推导（它是唯一检索信号）', () => {
    const d = draftFromTrace('demo', trace)
    expect(d.description).toContain('list_dir')
  })
})

describe('validateDraft', () => {
  const ok: SkillDraft = {
    id: 'good-id',
    name: 'good-id',
    description: '何时用',
    steps: ['1. 调用 `bash`'],
    pitfalls: [],
    acceptance: ['- 跑通'],
  }
  it('合法草稿通过', () => {
    expect(validateDraft(ok).ok).toBe(true)
  })
  it('id 非法 / description 空 / 过长 都拒绝', () => {
    expect(validateDraft({ ...ok, id: '../x' }).ok).toBe(false)
    expect(validateDraft({ ...ok, description: '  ' }).ok).toBe(false)
    expect(validateDraft({ ...ok, description: 'x'.repeat(301) }).ok).toBe(false)
  })
})

describe('findSimilarSkill', () => {
  const draft: SkillDraft = {
    id: 'new-skill',
    name: 'new-skill',
    description: '批量重命名符号时按 AST 精确替换',
    steps: ['1. 调用 `code_symbols`'],
    pitfalls: [],
    acceptance: [],
  }
  it('同 id ⇒ 命中（提示更新已有）', () => {
    const hit = findSimilarSkill(draft, [{ ...draftToSkill(draft), id: 'new-skill' } as any])
    expect(hit?.score).toBe(1)
  })
  it('描述高度重合 ⇒ 命中', () => {
    const hit = findSimilarSkill(
      draft,
      [{ ...draftToSkill({ ...draft, id: 'other' }), description: '批量重命名符号时按 AST 精确替换' } as any],
    )
    expect(hit && hit.score >= 0.5).toBe(true)
  })
  it('无关技能不命中（避免噪音劝退）', () => {
    const hit = findSimilarSkill(draft, [
      { ...draftToSkill({ ...draft, id: 'x' }), description: '给图片加水印并导出' } as any,
    ])
    expect(hit).toBeUndefined()
  })
})

describe('parseArgs / summarizeInput', () => {
  it('--desc 支持双引号，flag 与位置参数分离', () => {
    const r = parseArgs('my-skill --project --desc "何时用 这个词"')
    expect(r.positional).toEqual(['my-skill'])
    expect(r.flags.has('--project')).toBe(true)
    expect(r.desc).toBe('何时用 这个词')
  })
  it('入参摘要截断且单行', () => {
    const s = summarizeInput({ path: 'x'.repeat(500) }, 40)
    expect(s.length).toBeLessThanOrEqual(41)
    expect(s).not.toContain('\n')
  })
})

// ===== 命令端到端 =====

describe('/skill-forge 命令流程', () => {
  it('两段式：先出草稿（不落盘）→ --confirm 才写文件并当轮生效', async () => {
    const { ws, manager, run, record, lines } = await setup()
    record('list_dir', { path: '.' })
    record('bash', { command: 'ls' }, false, 'boom')

    expect(run('demo-skill')).toBe('continue')
    const draftOut = lines.join('')
    expect(draftOut).toContain('技能草稿：demo-skill')
    expect(draftOut).toContain('boom') // 失败进「坑」
    expect(draftOut).toContain('/skill-forge --confirm demo-skill')
    // 关键：这一步不能落盘
    expect(existsSync(join(ws.user.skills, 'demo-skill', 'SKILL.md'))).toBe(false)

    lines.length = 0
    run('--confirm demo-skill')
    await new Promise((r) => setTimeout(r, 10))
    const file = join(ws.user.skills, 'demo-skill', 'SKILL.md')
    expect(existsSync(file)).toBe(true)
    expect(manager.get('demo-skill')?.description).toBeTruthy()
    expect(lines.join('')).toContain('✅')
  })

  it('默认写 user 级；--project 才写项目级（项目级会随 git 共享）', async () => {
    const { ws, run, record } = await setup()
    record('bash', { command: 'pwd' })
    run('proj-skill --project')
    run('--confirm proj-skill --project')
    await new Promise((r) => setTimeout(r, 10))
    expect(existsSync(join(ws.project.skills, 'proj-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(ws.user.skills, 'proj-skill', 'SKILL.md'))).toBe(false)
  })

  it('未确认直接 --confirm ⇒ 拒绝（草稿是两段式的唯一凭据）', async () => {
    const { run, lines } = await setup()
    run('--confirm ghost')
    expect(lines.join('')).toContain('没有待确认的草稿')
  })

  it('去重：与已有技能相似时提示更新，而不是默默新建一个孪生技能', async () => {
    const { manager, run, record, lines } = await setup()
    manager.register({
      id: 'existing',
      name: 'existing',
      description: '批量重命名符号时按 AST 精确替换',
      loadedFrom: 'user',
      content: 'body',
    } as any)
    record('code_symbols', { path: '.' })
    // 用与已有技能高度重合的 description 锻造 ⇒ 应提示"更新已有"而非新建
    run('twin --desc "批量重命名符号时按 AST 精确替换"')
    expect(lines.join('')).toContain('相似')
    expect(lines.join('')).toContain('existing')
  })

  it('治理：技能数达上限时拒绝新建', async () => {
    const { manager, run, record, lines } = await setup({ maxSkills: 1 })
    manager.register({ id: 'one', name: 'one', description: 'd', loadedFrom: 'user', content: 'b' } as any)
    record('bash', { command: 'x' })
    run('second')
    run('--confirm second')
    await new Promise((r) => setTimeout(r, 10))
    expect(lines.join('')).toContain('上限')
  })

  it('list / path / disable 三个治理子命令', async () => {
    const { manager, run, lines } = await setup()
    manager.register({ id: 'a', name: 'a', description: 'd', loadedFrom: 'user', content: 'b' } as any)
    lines.length = 0
    run('list')
    expect(lines.join('')).toContain('a')
    lines.length = 0
    run('path')
    expect(lines.join('')).toContain('用户级')
    lines.length = 0
    run('disable a')
    expect(lines.join('')).toContain('已禁用')
    expect(manager.isDisabled('a')).toBe(true)
  })

  it('renderDraft 含三段结构（步骤 / 坑 / 验收）', () => {
    const d = draftFromTrace('x', [{ toolId: 'bash', inputSummary: '', ok: true }])
    const text = renderDraft(d)
    expect(text).toContain('## 步骤')
    expect(text).toContain('## 验收')
  })
})

describe('落盘内容安全', () => {
  it('锻造出的技能 allowEmbedShell=false（不能给自己生成可执行 shell）', async () => {
    const { ws, run, record } = await setup()
    record('bash', { command: 'ls' })
    run('safe-skill')
    run('--confirm safe-skill')
    await new Promise((r) => setTimeout(r, 10))
    const text = readFileSync(join(ws.user.skills, 'safe-skill', 'SKILL.md'), 'utf-8')
    expect(text).toContain('allowEmbedShell: false')
    expect(text).not.toContain('allowEmbedShell: true')
  })
})

describe('collapseCycle', () => {
  const e = (toolId: string): any => ({ toolId, inputSummary: '', ok: true })
  it('A,B,A,B,A,B ⇒ A,B（真机实测：模型会把同一小循环跑两遍）', () => {
    const out = collapseCycle([e('a'), e('b'), e('a'), e('b'), e('a'), e('b')])
    expect(out.map((x) => x.toolId)).toEqual(['a', 'b'])
  })
  it('非整周期不折叠（宁可少折叠，也不压扁真实流程）', () => {
    const src = [e('a'), e('b'), e('a'), e('b'), e('c')]
    expect(collapseCycle(src)).toEqual(src)
  })
  it('短序列直接返回', () => {
    expect(collapseCycle([e('a'), e('b')])).toHaveLength(2)
  })
})

describe('步骤去重（真机观察）', () => {
  const mk = (toolId: string, inputSummary: string, ok = true): any => ({ toolId, inputSummary, ok })
  it('同工具同入参只保留一条；不同入参的步骤不丢', () => {
    const trace = [
      mk('list_dir', 'path=.'),
      mk('read_file', 'path=config.json limit=5'),
      mk('list_dir', 'path=.'),
      mk('read_file', 'path=config.json limit=5'),
      mk('list_dir', 'path=.'),
      mk('read_file', 'path=config.json limit=5 showLineNumbers=true'),
    ]
    const d = draftFromTrace('x', trace)
    expect(d.steps).toHaveLength(3)
    expect(d.steps[2]).toContain('showLineNumbers')
  })
})
