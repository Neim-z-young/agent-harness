import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentDefinition } from '@harness/core'
import {
  HarnessApp,
  parseCliArgs,
  describeSessionRestore,
  startRepl,
  main,
  type HarnessAppOptions,
} from './index'

// ==========================================================================
// 功能一：启动时自动恢复上次会话
// ==========================================================================
// 背景：此前只有显式 `-s/--session <id>` 才会恢复，其余情况每次 boot 都是全新会话。
// 现在默认接着「当前工作目录里 updatedAt 最新」的会话继续，且必须能解释「为什么没恢复」。

/** 建一个 app（同一 dataDir 可多次 boot，用于模拟「退出后重开」） */
function mount(cwd: string, dataDir: string, extra: Partial<HarnessAppOptions> = {}) {
  const chunks: string[] = []
  const stdout = { write: (s: string) => { chunks.push(s) } }
  const app = new HarnessApp({
    cwd, dataDir, agentId: 'default', provider: 'mock',
    permissionMode: 'allow-all', stdout,
    mockProviderConfig: { defaultResponse: 'hi' },
    ...extra,
  })
  return { app, chunks, stdout }
}

describe('启动时自动恢复上次会话', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-resume-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('不带 -s 启动：接着同目录最近的会话（消息与模型覆盖一起回来）', async () => {
    const dataDir = join(dir, '.harness')

    // 第一次启动：新会话 → 造历史 + 会话级模型覆盖 → 落盘退出
    const a1 = mount(dir, dataDir)
    const { harness: h1, session: s1 } = await a1.app.boot()
    expect(a1.app.sessionRestore.source).toBe('new')
    await h1.session.addMessage(s1.id, { id: 'm1', role: 'user', parts: [{ type: 'text', text: '你好' }], createdAt: 1 })
    await a1.app.setSessionModel(s1, { modelId: 'hy3-prev' })
    await a1.app.sessionStore.save((await h1.session.get(s1.id))!)
    await a1.app.shutdown()

    // 第二次启动：应自动恢复同一个会话
    const a2 = mount(dir, dataDir)
    const { session: s2 } = await a2.app.boot()
    expect(a2.app.sessionRestore.source).toBe('auto')
    expect(a2.app.sessionRestore.sessionId).toBe(s1.id)
    expect(s2.id).toBe(s1.id)
    expect(s2.messages.map((m) => m.id)).toEqual(['m1'])
    expect(a2.app.resolveSessionModel(s2)).toBe('hy3-prev')
    expect(describeSessionRestore(a2.app.sessionRestore)).toInclude('已自动恢复上次会话')
    await a2.app.shutdown()
  })

  it('REPL 启动时打印恢复提示与当前 agent/model，并给出 /new、--no-resume 出口', async () => {
    const dataDir = join(dir, '.harness')
    const a1 = mount(dir, dataDir)
    const { harness: h1, session: s1 } = await a1.app.boot()
    await a1.app.sessionStore.save((await h1.session.get(s1.id))!)
    await a1.app.shutdown()

    const a2 = mount(dir, dataDir)
    const { harness, session } = await a2.app.boot()
    await startRepl({ app: a2.app, harness, session, stdout: a2.stdout, scriptedStdin: ['/exit'] })
    const out = a2.chunks.join('')
    expect(out).toInclude('已自动恢复上次会话')
    expect(out).toInclude('/new 开新会话')
    expect(out).toInclude('--no-resume')
    expect(out).toInclude('当前 agent=default · model=')
    expect(out).toInclude('会话内可用 /agent、/model 切换')
    await a2.app.shutdown()
  })

  it('autoResume: false 关掉自动恢复，并明确记为「被关掉」而不是静默新建', async () => {
    const dataDir = join(dir, '.harness')
    const a1 = mount(dir, dataDir)
    const { harness: h1, session: s1 } = await a1.app.boot()
    await a1.app.sessionStore.save((await h1.session.get(s1.id))!)
    await a1.app.shutdown()

    const a2 = mount(dir, dataDir, { autoResume: false })
    const { session: s2 } = await a2.app.boot()
    expect(a2.app.sessionRestore.source).toBe('new')
    expect(s2.id).not.toBe(s1.id)
    expect(a2.app.sessionRestore.skipped?.reason).toBe('disabled')
    expect(describeSessionRestore(a2.app.sessionRestore)).toBe('')
    await a2.app.shutdown()
  })

  it('只恢复同一工作目录的会话：别的项目里更新的会话不会被误恢复', async () => {
    const dataDir = join(dir, 'shared')
    const projA = join(dir, 'projA'); mkdirSync(projA, { recursive: true })
    const projB = join(dir, 'projB'); mkdirSync(projB, { recursive: true })

    const a = mount(projA, dataDir)
    const { harness: ha, session: sa } = await a.app.boot()
    await ha.session.addMessage(sa.id, { id: 'A1', role: 'user', parts: [{ type: 'text', text: 'in A' }], createdAt: 1 })
    await a.app.sessionStore.save((await ha.session.get(sa.id))!)
    await a.app.shutdown()

    // B 的会话更晚创建（updatedAt 更大）。留一点间隔：updatedAt 是毫秒精度，
    // 同毫秒会让「谁更近」失去确定性，测试要断言的是「按时间选最近」这条语义本身。
    await new Promise((r) => setTimeout(r, 5))
    const b = mount(projB, dataDir)
    const { harness: hb, session: sb } = await b.app.boot()
    await hb.session.addMessage(sb.id, { id: 'B1', role: 'user', parts: [{ type: 'text', text: 'in B' }], createdAt: 2 })
    await b.app.sessionStore.save((await hb.session.get(sb.id))!)
    await b.app.shutdown()

    // 谁都不属于的目录：新建，并说明「最近的会话（B 的）属于别处」而不是静默新建。
    // 注意顺序：这一步必须在「重新进 A」之前 —— 恢复会把会话的 updatedAt 刷成当前时间，
    // 之后最近的就变成 A 的会话了（这是预期行为：恢复 = 最近用过）。
    const projC = join(dir, 'projC'); mkdirSync(projC, { recursive: true })
    const c = mount(projC, dataDir)
    const { session: sc } = await c.app.boot()
    expect(c.app.sessionRestore.source).toBe('new')
    expect(sc.id).not.toBe(sb.id)
    expect(c.app.sessionRestore.skipped?.reason).toBe('other-cwd')
    expect(c.app.sessionRestore.skipped?.id).toBe(sb.id)
    const notice = describeSessionRestore(c.app.sessionRestore)
    expect(notice).toInclude('属于其它工作目录')
    expect(notice).toInclude(projB)
    expect(notice).toInclude(`/resume ${sb.id}`)
    await c.app.shutdown()

    // 回到 A：必须恢复 A 自己的，而不是时间上更新的 B
    const a2 = mount(projA, dataDir)
    const { session: s2 } = await a2.app.boot()
    expect(a2.app.sessionRestore.source).toBe('auto')
    expect(s2.id).toBe(sa.id)
    expect(s2.messages.map((m) => m.id)).toEqual(['A1'])
    await a2.app.shutdown()
  })

  it('显式 -s/--session 优先于自动恢复', async () => {
    const dataDir = join(dir, '.harness')
    const a1 = mount(dir, dataDir)
    const { harness: h1, session: older } = await a1.app.boot()
    await h1.session.addMessage(older.id, { id: 'old1', role: 'user', parts: [{ type: 'text', text: '旧会话' }], createdAt: 1 })
    await a1.app.sessionStore.save((await h1.session.get(older.id))!)
    await a1.app.shutdown()

    // 再开一个更新的会话（关掉自动恢复才会真新建），确保「自动恢复」选中的不是 older
    const a2 = mount(dir, dataDir, { autoResume: false })
    const { session: newer } = await a2.app.boot()
    await a2.app.shutdown()

    const a3 = mount(dir, dataDir, { sessionId: older.id })
    const { session: restored } = await a3.app.boot()
    expect(a3.app.sessionRestore.source).toBe('explicit')
    expect(restored.id).toBe(older.id)
    expect(restored.id).not.toBe(newer.id)
    expect(restored.messages.map((m) => m.id)).toEqual(['old1'])
    await a3.app.shutdown()
  })

  it('--no-resume 解析（默认不关闭）', () => {
    expect(parseCliArgs([]).noResume).toBeUndefined()
    expect(parseCliArgs(['--no-resume']).noResume).toBe(true)
    expect(parseCliArgs(['--tui', '--no-resume']).noResume).toBe(true)
    expect(parseCliArgs(['-s', 'abc']).sessionId).toBe('abc')
  })

  it('harness run 始终新建会话：脚本化调用不接着上次会话往下写', async () => {
    const dataDir = join(dir, '.harness')
    const a = mount(dir, dataDir)
    const { harness: h, session: s } = await a.app.boot()
    await a.app.sessionStore.save((await h.session.get(s.id))!)
    await a.app.shutdown()
    const before = readdirSync(join(dataDir, 'sessions')).filter((f) => f.endsWith('.json')).length

    const originalWrite = process.stdout.write.bind(process.stdout) as any
    process.stdout.write = ((x: any) => { void x; return true }) as any
    try {
      await main(['run', 'hello', '-p', 'mock', '-d', dataDir, '-c', dir, '--permission', 'allow-all'])
      await main(['run', 'hello', '-p', 'mock', '-d', dataDir, '-c', dir, '--permission', 'allow-all'])
    } finally {
      process.stdout.write = originalWrite
    }
    const after = readdirSync(join(dataDir, 'sessions')).filter((f) => f.endsWith('.json')).length
    expect(after).toBe(before + 2)
  })
})

// ==========================================================================
// 功能二：会话内 agent / model 各自独立切换
// ==========================================================================
// 用一个真实 HTTP 网关记录每轮请求体里的 model，端到端验证「到底用了哪个模型」
// —— 只看命令回显会漏掉「解析对了但发送用的是旧模型」这类问题。

const coderAgent: AgentDefinition = {
  id: 'coder',
  name: 'Coder',
  description: '测试用第二个 Agent',
  mode: 'primary',
  tools: ['*'],
  permission: { '*': 'allow' },
  systemPrompt: 'you are coder',
}

describe('会话内切换 agent / model', () => {
  let dir: string
  let server: ReturnType<typeof Bun.serve>
  let seen: string[]
  let baseUrl: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-switch-'))
    seen = []
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { model?: string }
        seen.push(body.model ?? '')
        const chunk = (delta: Record<string, unknown>, finish: string | null) =>
          `data: ${JSON.stringify({
            id: 'c', object: 'chat.completion.chunk', model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        const sse = chunk({ role: 'assistant', content: 'ok' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n'
        return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })
    baseUrl = `http://127.0.0.1:${server.port}`
  })
  afterEach(() => {
    server?.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })

  const mount = (extra: Partial<HarnessAppOptions> = {}) => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'hy3',
      permissionMode: 'allow-all', stdout,
      providers: [
        { id: 'hy3', type: 'openai', baseUrl: `${baseUrl}/v1`, apiKey: 'k', model: 'hy3' },
        { id: 'hy3b', type: 'openai', baseUrl: `${baseUrl}/v1`, apiKey: 'k', model: 'hy3b' },
      ],
      agents: [coderAgent],
      ...extra,
    })
    return { app, chunks, stdout }
  }

  it('模型覆盖随会话走：本会话切 hy3b → /new 沿用 → reset 回默认 → /resume 老会话仍是 hy3b', async () => {
    const m = mount()
    const { harness, session } = await m.app.boot()
    const sessionA = session.id

    const r = await startRepl({
      app: m.app, harness, session, stdout: m.stdout,
      scriptedStdin: [
        '/model hy3b',        // 会话 A：切到 hy3b 实例
        'hi',                 // → 应发 hy3b
        '/new',               // 新会话（沿用当前 agent 与模型，上下文清空）
        'hi',                 // → 仍 hy3b
        '/model reset',       // 清掉本会话覆盖
        'hi',                 // → 回到 Agent/Provider 默认 hy3
        `/resume ${sessionA}`, // 回到会话 A
        'hi',                 // → A 自己的覆盖还在，仍是 hy3b
        '/exit',
      ],
    })
    expect(r).toBe('exit')
    expect(seen).toEqual(['hy3b', 'hy3b', 'hy3', 'hy3b'])

    const out = m.chunks.join('')
    expect(out).toInclude('已切换模型 hy3b/hy3b')
    expect(out).toInclude('仅本会话')
    expect(out).toInclude('已清除本会话的模型覆盖')
    expect(out).toInclude('已恢复会话')
    await m.app.shutdown()
  })

  it('/model 只改会话：Agent 定义与 config.json 都不动', async () => {
    const m = mount()
    const { harness, session } = await m.app.boot()
    await startRepl({
      app: m.app, harness, session, stdout: m.stdout,
      scriptedStdin: ['/model hy3b', '/exit'],
    })
    expect(m.app.sessionModelOverride(session)).toEqual({ providerId: 'hy3b', modelId: 'hy3b' })
    expect(harness.agent.get('default')?.model).toBeUndefined()
    expect(m.app.getModel('default')).toBeUndefined()
    // config.json 根本不该被创建/改写（provider 来自启动参数，切模型不写全局）
    expect(existsSync(join(dir, '.harness', 'config.json'))).toBe(false)
    await m.app.shutdown()
  })

  it('/agent 切换本会话 Agent：立即落盘、下一条消息起生效、agent 维度也记录在消息上', async () => {
    const m = mount()
    const { harness, session } = await m.app.boot()
    const r = await startRepl({
      app: m.app, harness, session, stdout: m.stdout,
      scriptedStdin: ['/agent ?', '/agent coder', 'hi', '/exit'],
    })
    expect(r).toBe('exit')
    const out = m.chunks.join('')
    expect(out).toInclude('已注册 Agent（本会话当前：default）')
    expect(out).toInclude('coder')
    expect(out).toInclude('← 当前')
    expect(out).toInclude('已切换到 Agent coder（仅本会话，已保存')

    // 不等下一次 send：磁盘上的 agentId 立刻就是 coder（切完就退出也不丢）
    const onDisk = await m.app.sessionStore.load(session.id)
    expect(onDisk?.agentId).toBe('coder')
    // 该轮 assistant 消息用的是 coder（agent 维度可追溯）
    const assistant = onDisk?.messages.at(-1)
    expect(assistant?.agentId).toBe('coder')
    await m.app.shutdown()
  })

  it('重启后自动恢复：会话级 agent 与模型覆盖都回到原样', async () => {
    const m1 = mount()
    const { harness: h1, session: s1 } = await m1.app.boot()
    await startRepl({
      app: m1.app, harness: h1, session: s1, stdout: m1.stdout,
      scriptedStdin: ['/agent coder', '/model hy3b', 'hi', '/exit'],
    })
    expect(seen).toEqual(['hy3b'])
    await m1.app.shutdown()

    const m2 = mount()
    const { session: s2 } = await m2.app.boot()
    expect(m2.app.sessionRestore.source).toBe('auto')
    expect(s2.id).toBe(s1.id)
    expect(s2.agentId).toBe('coder')
    expect(m2.app.resolveSessionModel(s2)).toBe('hy3b/hy3b')
    await m2.app.shutdown()
  })

  it('未知 Agent 被拒绝，不会把会话改坏', async () => {
    const m = mount()
    const { harness, session } = await m.app.boot()
    await startRepl({
      app: m.app, harness, session, stdout: m.stdout,
      scriptedStdin: ['/agent 不存在', '/exit'],
    })
    const out = m.chunks.join('')
    expect(out).toInclude('Agent "不存在" 未注册')
    expect(out).toInclude('可用：')
    expect(session.agentId).toBe('default')
    await m.app.shutdown()
  })
})
