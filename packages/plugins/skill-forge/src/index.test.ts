import { describe, it, expect } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSkillManager } from '@harness/skill'
import {
  TraceRecorder,
  appendMemory,
  collapseCycle,
  createSkillForgePlugin,
  SkillInjectScheduler,
  draftFromTrace,
  detectRepeatable,
  draftToSkill,
  findSimilarSkill,
  writeFeedbackMemory,
  parseArgs,
  renderDraft,
  summarizeInput,
  validateDraft,
  type SkillDraft,
} from './index'

// ===== 测试替身 =====

function fakeCtx(over: Record<string, unknown> = {}, logWarns: string[] = []): any {
  return {
    bus: { publish: () => {}, subscribe: () => () => {}, subscribeAll: () => () => {} },
    config: { get: () => undefined, set: () => {} },
    log: {
      info: () => {},
      warn: (m: string) => logWarns.push(m),
      error: () => {},
      debug: () => {},
    },
    ...over,
  }
}

/** 造一个两级 skills 目录 + manager 的插件环境，并返回命令收集器 */
async function setup(opts: { maxSkills?: number } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'forge-'))
  const ws = {
    cwd: base,
    dataDir: base,
    user: { root: base, plugins: '', skills: join(base, 'user-skills'), agents: '', memory: join(base, 'user-memory') },
    project: { root: base, plugins: '', skills: join(base, 'project-skills'), agents: '', memory: join(base, 'project-memory') },
  }
  const manager = createSkillManager()
  const logWarns: string[] = []
  const plugin = createSkillForgePlugin({ workspace: ws, skillManager: manager, ...opts })

  // 最小 agent 注册表（core 的注入只认 agent.skills 白名单 ⇒ 绑定测试需要它）
  const agents: Record<string, any> = {
    default: { id: 'default', name: 'Default', mode: 'primary', skills: [] as string[] },
  }
  const agentRegistry = {
    get: (id: string) => agents[id],
    register: (def: any) => { agents[def.id] = def },
    list: () => Object.values(agents),
  }

  // install 时注入 workspace；再模拟 core.harness.init 注入 harness（含 skillManager / agent）
  const hooks = (await plugin.install(fakeCtx({ workspace: ws }, logWarns))) as Record<string, any>
  hooks['core.harness.init']({}, { harness: { skillManager: manager, agent: agentRegistry } })
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
  /**
   * 模拟"这一轮开始建 prompt"：真实链路里 `core.prompt.system.transform` 一定**先于**
   * 任何 compress / turn_end 发生（它顺带把会话登记成主会话）。
   * 不先登记就没有发布权 —— 那正是按会话隔离的核心语义，所以测试也要按真实顺序走。
   */
  const beginPrompt = (sessionId = 's1', agentMode?: string) => {
    const parts: string[] = []
    hooks['core.prompt.system.transform']({ sessionId, ...(agentMode ? { agentMode } : {}) }, parts)
    return parts
  }
  beginPrompt() // 建立会话基线（此时队列为空，不会提前发布任何东西）
  return { base, ws, manager, hooks, lines, run, record, beginPrompt, agents, logWarns }
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

// ===== F3：隐式重复检测（只提示不自动写）=====

describe('detectRepeatable', () => {
  const mk = (toolId: string, inputSummary = ''): any => ({ toolId, inputSummary, ok: true })

  it('同一工具+同一入参重复 ≥3 次 ⇒ 提示', () => {
    const r = detectRepeatable([mk('bash', 'cmd=ls'), mk('bash', 'cmd=ls'), mk('bash', 'cmd=ls')])
    expect(r).toHaveLength(1)
    expect(r[0]!.kind).toBe('single')
    expect(r[0]!.count).toBe(3)
  })

  it('入参不同不算重复（避免把"多次用 bash"当流程）', () => {
    const r = detectRepeatable([mk('bash', 'cmd=ls'), mk('bash', 'cmd=cat'), mk('bash', 'cmd=grep')])
    expect(r).toHaveLength(0)
  })

  it('2~6 步序列完整重复 ⇒ 报序列（信息量大于单步，单步结果被吸收）', () => {
    const seq = [mk('a'), mk('b'), mk('a'), mk('b')]
    const r = detectRepeatable(seq)
    expect(r.some((x) => x.kind === 'sequence' && x.toolIds.join('>') === 'a>b')).toBe(true)
    expect(r.every((x) => x.kind !== 'single')).toBe(true)
  })

  it('不足阈值不提示（避免噪音劝退）', () => {
    expect(detectRepeatable([mk('a'), mk('a')])).toHaveLength(0)
  })
})

describe('writeFeedbackMemory', () => {
  it('写入 - 前缀条目，去重，且超限拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-'))
    const file = join(dir, 'MEMORY.md')
    expect(writeFeedbackMemory(file, '[feedback] bash 反复失败').ok).toBe(true)
    expect(readFileSync(file, 'utf-8')).toContain('- [feedback] bash 反复失败')
    // 精确去重（含空白归一化）
    expect(writeFeedbackMemory(file, '[feedback]  bash   反复失败').ok).toBe(false)
    // 上限 200 条
    const many = Array.from({ length: 201 }, (_, i) => `条目 ${i}`).join('\n')
    writeFileSync(join(dir, 'big.md'), many, 'utf-8')
    expect(writeFeedbackMemory(join(dir, 'big.md'), '新条目').ok).toBe(false)
  })
})

describe('F3 命令侧', () => {
  it('suggest 只打印提示，**不创建任何技能**', async () => {
    const { manager, run, record, lines } = await setup()
    for (let i = 0; i < 3; i += 1) record('bash', { command: 'ls' })
    run('suggest')
    expect(lines.join('')).toContain('可固化')
    expect(lines.join('')).toContain('不会自动创建')
    expect(manager.all()).toHaveLength(0)
  })

  it('无重复时明确说明判据（不静默）', async () => {
    const { run, record, lines } = await setup()
    record('bash', { command: 'ls' })
    run('suggest')
    expect(lines.join('')).toContain('未检测到')
  })

  it('反复失败 ⇒ 回写一条 feedback 到 FEEDBACK.md（同一工具+入参只写一次）', async () => {
    const { ws, record } = await setup()
    for (let i = 0; i < 3; i += 1) record('read_file', { path: 'x' }, false, 'ENOENT')
    await new Promise((r) => setTimeout(r, 5))
    // 落 FEEDBACK.md 而不是 MEMORY.md：反馈是自动产生的，进 system 前缀区会让
    // "一次工具报错"绑上"整段前缀缓存报废"（真机 52,096 token）
    const file = join(ws.user.memory, 'FEEDBACK.md')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(join(ws.user.memory, 'MEMORY.md'))).toBe(false)
    const text = readFileSync(file, 'utf-8')
    expect(text).toContain('[feedback]')
    expect(text.split('\n').filter((l) => l.includes('[feedback]')).length).toBe(1)
  })

  it('--bind 排入延迟队列：压缩触发后才真正进白名单（注入只认白名单）', async () => {
    const { run, record, lines, agents, hooks } = await setup()
    record('bash', { command: 'ls' })
    run('bindme')
    lines.length = 0
    run('--confirm bindme --bind')
    await new Promise((r) => setTimeout(r, 10))
    // 关键：此刻还**没**进白名单（否则下一轮 system 就变，前缀缓存白失效一次）
    expect(agents.default.skills).not.toContain('bindme')
    expect(lines.join('')).toContain('延迟注入队列')

    // 压缩（ACP 路径）触发发布 ⇒ 下一轮 prompt 构建时进白名单
    hooks['core.session.compacting']({ sessionId: 's1' })
    hooks['core.prompt.system.transform']({ sessionId: 's1' }, [])
    expect(agents.default.skills).toContain('bindme')
  })

  it('不带 --bind 时明确告知"不会自动注入"（否则用户以为锻造完就能用）', async () => {
    const { run, record, lines, agents } = await setup()
    record('bash', { command: 'ls' })
    run('nobind')
    lines.length = 0
    run('--confirm nobind')
    await new Promise((r) => setTimeout(r, 10))
    expect(agents.default.skills).not.toContain('nobind')
    expect(lines.join('')).toContain('--bind')
  })
})

// ===== 延迟注入（与记忆同一套分级策略）=====

describe('SkillInjectScheduler', () => {
  it('排入队列后不立即发布；攒够轮数才 due', () => {
    const s = new SkillInjectScheduler({ flushAfterTurns: 3 })
    s.schedule('a')
    expect(s.due).toBe(false)
    expect(s.takeDue()).toHaveLength(0)
    s.onTurnEnd(); s.onTurnEnd()
    expect(s.takeDue()).toHaveLength(0)
    s.onTurnEnd()
    expect(s.takeDue().map((x) => x.skillId)).toEqual(['a'])
  })
  it('压缩触发 flush（ACP 路径）与显式 flush 都立即到期', () => {
    const a = new SkillInjectScheduler()
    a.schedule('x'); a.flush()
    expect(a.takeDue().map((x) => x.skillId)).toEqual(['x'])
    const b = new SkillInjectScheduler()
    b.schedule('y'); b.flush()
    expect(b.due).toBe(true)
  })
  it('队列为空时 flush 不产生空发布（避免白改一次 system）', () => {
    const s = new SkillInjectScheduler()
    s.flush()
    expect(s.due).toBe(false)
    expect(s.takeDue()).toHaveLength(0)
  })
  it('flushAfterTurns=0 ⇒ 立即（关闭延迟）', () => {
    const s = new SkillInjectScheduler({ flushAfterTurns: 0 })
    s.schedule('z')
    expect(s.takeDue()).toHaveLength(1)
  })
})

describe('延迟注入命令侧', () => {
  it('--bind 后**不**立即进白名单；/forge flush 才发布', async () => {
    const { run, record, lines, agents } = await setup()
    record('bash', { command: 'ls' })
    run('defer-me')
    run('--confirm defer-me --bind')
    await new Promise((r) => setTimeout(r, 10))
    expect(agents.default.skills).not.toContain('defer-me')
    expect(lines.join('')).toContain('延迟注入队列')

    lines.length = 0
    run('/x') // 占位，避免空
    // 统一入口发布
    const forge = { command: 'forge', arg: 'flush', out: (t: string) => lines.push(t), sessionId: 's1' } as any
    ;(await import('./index')).createSkillForgePlugin // 保持引用
    // 直接走同一个 handler：用 setup 暴露的 hooks 转发
    // （setup 的 run 只支持 skill-forge，这里借 /forge skill 转发路径）
    lines.length = 0
    run('flush') === 'continue' // skill-forge 无 flush 子命令 ⇒ 落到用法提示
    // 用 /forge 面板的 flush：通过 hooks 直接调用
    const { hooks } = await setup()
    const out2: string[] = []
    hooks['cli.command']({ command: 'forge', arg: 'flush', out: (t: string) => out2.push(t), sessionId: 's1' } as any)
    expect(out2.join('')).toContain('没有待注入')
  })

  it('/forge flush 能真正发布待注入队列（先 flush 再取，否则恒为空）', async () => {
    const { hooks, run, record, agents } = await setup()
    record('bash', { command: 'ls' })
    run('flush-me')
    run('--confirm flush-me --bind')
    await new Promise((r) => setTimeout(r, 10))
    expect(agents.default.skills).not.toContain('flush-me')
    const out: string[] = []
    hooks['cli.command']({ command: 'forge', arg: 'flush', out: (t: string) => out.push(t), sessionId: 's1' } as any)
    expect(out.join('')).toContain('已发布延迟注入')
    expect(agents.default.skills).toContain('flush-me')
  })

  it('--now 立即注入（用户有即时预期时的例外）', async () => {
    const { run, record, agents } = await setup()
    record('bash', { command: 'ls' })
    run('nower')
    run('--confirm nower --now')
    await new Promise((r) => setTimeout(r, 10))
    expect(agents.default.skills).toContain('nower')
  })
})

// ===== 两条线串联（/forge 统一入口）=====

describe('/forge 统一入口', () => {
  it('面板同时给出两条线的状态（可固化流程 / 待注入 / 记忆 / 技能数）', async () => {
    const { hooks, record } = await setup()
    for (let i = 0; i < 3; i += 1) record('bash', { command: 'ls' })
    const out: string[] = []
    hooks['cli.command']({ command: 'forge', arg: '', out: (t: string) => out.push(t), sessionId: 's1' } as any)
    const text = out.join('')
    expect(text).toContain('可固化流程')
    expect(text).toContain('待注入技能')
    expect(text).toContain('用户记忆')
    expect(text).toContain('已装技能')
  })

  it('/forge memory add 写记忆（单条事实走这条线）', async () => {
    const { hooks, ws } = await setup()
    const out: string[] = []
    hooks['cli.command']({ command: 'forge', arg: 'memory add 这个项目用 bun 跑测试', out: (t: string) => out.push(t), sessionId: 's1' } as any)
    expect(out.join('')).toContain('已写入')
    expect(readFileSync(join(ws.user.memory, 'MEMORY.md'), 'utf-8')).toContain('bun 跑测试')
  })

  it('/forge skill <name> 转发到技能锻造（多步流程走这条线）', async () => {
    const { hooks, record } = await setup()
    record('bash', { command: 'ls' })
    const out: string[] = []
    hooks['cli.command']({ command: 'forge', arg: 'skill via-forge --desc "经统一入口"', out: (t: string) => out.push(t), sessionId: 's1' } as any)
    expect(out.join('')).toContain('技能草稿：via-forge')
  })
})

describe('ACP 压缩触发延迟注入（引擎层 compress 工具信号）', () => {
  it('模型调 compress 成功 ⇒ 队列到期，下一轮 prompt 构建时进白名单', async () => {
    const { run, record, agents, hooks } = await setup()
    record('bash', { command: 'ls' })
    run('acp-defer')
    run('--confirm acp-defer --bind')
    await new Promise((r) => setTimeout(r, 10))
    expect(agents.default.skills).not.toContain('acp-defer')

    // ACP 主路径：模型调 compress 工具（不触发 core.session.compacting！）
    hooks['core.tool.post.execute'](
      { tool: { id: 'compress' }, input: { content: [] }, ctx: { sessionId: 's1' } },
      { ok: true },
    )
    hooks['core.prompt.system.transform']({ sessionId: 's1' }, [])
    expect(agents.default.skills).toContain('acp-defer')
  })

  it('compress 失败不发布（窗口没腾出来，发布了也不划算）', async () => {
    const { run, record, agents, hooks } = await setup()
    record('bash', { command: 'ls' })
    run('fail-comp')
    run('--confirm fail-comp --bind')
    await new Promise((r) => setTimeout(r, 10))
    hooks['core.tool.post.execute'](
      { tool: { id: 'compress' }, input: {}, ctx: { sessionId: 's1' } },
      { ok: false, error: { message: 'x' } },
    )
    hooks['core.prompt.system.transform']({ sessionId: 's1' }, [])
    expect(agents.default.skills).not.toContain('fail-comp')
  })

  it('其他工具执行不误触发', async () => {
    const { run, record, agents, hooks } = await setup()
    record('bash', { command: 'ls' })
    run('other-tool')
    run('--confirm other-tool --bind')
    await new Promise((r) => setTimeout(r, 10))
    hooks['core.tool.post.execute'](
      { tool: { id: 'list_dir' }, input: {}, ctx: { sessionId: 's1' } },
      { ok: true },
    )
    hooks['core.prompt.system.transform']({ sessionId: 's1' }, [])
    expect(agents.default.skills).not.toContain('other-tool')
  })
})

// ===== 会话隔离：子 Agent 的压缩不得替主会话发布 =====
//
// 与 @harness/memory 的 publishers 是同一族缺陷。真机事故（s_1790163574429_tg1a6）：
// 失败 reader 子会话压缩 ⇒ 主会话 round 32 前缀缓存报废 52,096 token。

describe('会话隔离：子会话不得替主会话发布技能', () => {
  const tick = () => new Promise((r) => setTimeout(r, 10))

  /** 造一个"已排入延迟队列"的主会话（s1），返回 hooks 与断言用的 agents */
  async function deferOne(name: string) {
    const env = await setup()
    env.record('bash', { command: 'ls' })
    env.run(name)
    env.run(`--confirm ${name} --bind`)
    await tick()
    expect(env.agents.default.skills).not.toContain(name)
    return env
  }

  it('子会话的 compress 不发布；主会话自己的 compress 照旧发布（正向对照）', async () => {
    const { hooks, agents } = await deferOne('sub-leak')
    // 子 Agent 会话压缩（引擎层广播，sessionId 是子会话）
    hooks['core.tool.post.execute'](
      { tool: { id: 'compress' }, input: {}, ctx: { sessionId: 'sub-1' } },
      { ok: true },
    )
    hooks['core.prompt.system.transform']({ sessionId: 's1' }, [])
    expect(agents.default.skills).not.toContain('sub-leak')

    // 正向对照：不能为了"防子会话"把主会话自己也防死
    hooks['core.tool.post.execute'](
      { tool: { id: 'compress' }, input: {}, ctx: { sessionId: 's1' } },
      { ok: true },
    )
    hooks['core.prompt.system.transform']({ sessionId: 's1' }, [])
    expect(agents.default.skills).toContain('sub-leak')
  })

  it('子会话的 compacting 同样不发布（两个触发源都要判归属）', async () => {
    const { hooks, agents } = await deferOne('sub-compact')
    hooks['core.session.compacting']({ sessionId: 'sub-1' })
    hooks['core.prompt.system.transform']({ sessionId: 's1' }, [])
    expect(agents.default.skills).not.toContain('sub-compact')
  })

  it('compress 缺 sessionId ⇒ fail-closed 不发布（代价不对称：晚几轮 vs 五万 token）', async () => {
    const { hooks, agents } = await deferOne('no-sid')
    hooks['core.tool.post.execute']({ tool: { id: 'compress' }, input: {}, ctx: {} }, { ok: true })
    hooks['core.prompt.system.transform']({ sessionId: 's1' }, [])
    expect(agents.default.skills).not.toContain('no-sid')
  })

  it('子 Agent 建 prompt 不得 drain 主会话的待发布队列', async () => {
    const { hooks, agents } = await deferOne('keep-me')
    hooks['core.session.compacting']({ sessionId: 's1' }) // 本会话已到期
    // 真实链路里子 Agent 的 prompt 构建会先跑 —— 它不能把主会话的队列消费掉
    hooks['core.prompt.system.transform']({ sessionId: 'sub-1', agentMode: 'subagent' }, [])
    expect(agents.default.skills).not.toContain('keep-me')

    hooks['core.prompt.system.transform']({ sessionId: 's1' }, [])
    expect(agents.default.skills).toContain('keep-me')
  })

  it('turn_end 只推进对应会话的计数（别人的轮不是你的轮）', async () => {
    const { hooks, agents } = await deferOne('counter')
    // flushAfterTurns 默认 15：别的会话攒 14 轮 + 本会话 1 轮，仍不该到期
    for (let i = 0; i < 14; i += 1) hooks['core.agent.turn.end']({ sessionId: 'other' })
    hooks['core.agent.turn.end']({ sessionId: 's1' })
    hooks['core.prompt.system.transform']({ sessionId: 's1' }, [])
    expect(agents.default.skills).not.toContain('counter')
  })

  it('子 Agent 模式（mode=subagent）的轮末不计入任何会话', async () => {
    const { hooks, agents } = await deferOne('sub-turn')
    for (let i = 0; i < 20; i += 1) hooks['core.agent.turn.end']({ sessionId: 's1', mode: 'subagent' })
    hooks['core.prompt.system.transform']({ sessionId: 's1' }, [])
    expect(agents.default.skills).not.toContain('sub-turn')
  })
})

// ===== 评审修复的回归守卫 =====

describe('评审修复', () => {
  it('/forge memory add 保留完整内容（此前 split.slice(3) 会丢词）', async () => {
    const { hooks, ws } = await setup()
    const out: string[] = []
    hooks['cli.command']({ command: 'forge', arg: 'memory add 这个项目用 bun 跑测试', out: (t: string) => out.push(t), sessionId: 's1' } as any)
    expect(out.join('')).toContain('这个项目用 bun 跑测试')
    expect(readFileSync(join(ws.user.memory, 'MEMORY.md'), 'utf-8')).toContain('这个项目用 bun 跑测试')
  })

  it('延迟绑定失败（目标 Agent 不存在）必须留 warn 日志，不得静默吞掉', async () => {
    const { hooks, run, record, logWarns, agents } = await setup()
    record('bash', { command: 'ls' })
    run('ghost-bind')
    run('--confirm ghost-bind --bind missing-agent')
    await new Promise((r) => setTimeout(r, 10))
    // 发布时 Agent 不存在 ⇒ bindToAgent 返回 ⚠️ ⇒ 必须出现在 warn 日志里（评审修复前被吞掉）
    hooks['core.session.compacting']({ sessionId: 's1' }) // 触发发布（否则队列未到期）
    hooks['core.prompt.system.transform']({ sessionId: 's1' }, [])
    expect(logWarns.join('\n')).toContain('延迟注入绑定失败')
    // 且技能不得凭空进入白名单
    expect(agents.default.skills).not.toContain('ghost-bind')
  })
})


describe('评审修复（续）', () => {
  it('schedule 不得冲掉已到期的发布状态（compress flush 后又锻造 ⇒ 照常立即发布）', () => {
    const s = new SkillInjectScheduler()
    s.schedule('first')
    s.flush() // 压缩触发 ⇒ 立即到期
    s.schedule('second') // 此刻又锻造了一个 —— 不得重置 forced
    expect(s.due).toBe(true)
    const ids = s.takeDue().map((x) => x.skillId).sort()
    expect(ids).toEqual(['first', 'second'])
  })

  it('非法技能名在出草稿前就被拒绝（不用等 --confirm 才报错）', async () => {
    const { run, lines } = await setup()
    run('Bad Name')
    expect(lines.join('')).toContain('技能名非法')
    expect(lines.join('')).not.toContain('技能草稿')
  })

  it('待确认草稿有界（超过 20 份 FIFO 淘汰最旧）', async () => {
    const { run, lines } = await setup()
    for (let i = 1; i <= 21; i += 1) {
      run('draft-' + String(i).padStart(2, '0'))
    }
    // draft-01 最旧 ⇒ 已被 FIFO 淘汰 ⇒ confirm 报"没有待确认的草稿"
    lines.length = 0
    run('--confirm draft-01')
    expect(lines.join('')).toContain('没有待确认的草稿')
    // 最新的一份仍在
    lines.length = 0
    run('--confirm draft-21')
    expect(lines.join('')).not.toContain('没有待确认的草稿')
  })
})
