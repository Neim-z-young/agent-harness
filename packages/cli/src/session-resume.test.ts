import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
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
// 功能一续：「上次会话」记在**当前工作目录**里
// ==========================================================================
// 背景：sessions 目录（dataDir/sessions）是全局共享的，多个项目的会话全躺在同一层。
// 只靠「会话里记的 cwd 字符串」反查该恢复哪条，路径写法一变（符号链接、相对路径）就会误判；
// 现在把「本目录上次用的会话 id」写进 <cwd>/.harness/last-session.json：
// 「谁属于谁」由文件位置决定，不同工作目录各自一份，不靠字符串比对。

describe('自动恢复的会话 id 记在当前工作目录下', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-pointer-cli-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** 本目录的指针文件（不存在则 undefined） */
  const readPointer = (cwd: string): { sessionId: string } | undefined => {
    const p = join(cwd, '.harness', 'last-session.json')
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : undefined
  }

  /** 绕过 app 直接塞一条会话文件：模拟「别的入口 / 别的进程」写的会话（不会碰指针） */
  const seedSessionFile = async (app: HarnessApp, cwd: string, id: string, updatedAt: number) => {
    await app.sessionStore.ensureDir()
    writeFileSync(app.sessionStore.pathFor(id), JSON.stringify({
      id, title: 'seeded', createdAt: 1, updatedAt, agentId: 'default', cwd,
      messages: [{ id: `${id}-m1`, role: 'user', parts: [{ type: 'text', text: 'seeded' }], createdAt: 1 }],
    }, null, 2))
  }

  it('恢复的是「本目录记录的会话」，不是同目录里时间更新的一条', async () => {
    const dataDir = join(dir, 'shared')
    const proj = join(dir, 'proj'); mkdirSync(proj, { recursive: true })

    const a1 = mount(proj, dataDir)
    const { harness: h1, session: s1 } = await a1.app.boot()
    await h1.session.addMessage(s1.id, { id: 'used', role: 'user', parts: [{ type: 'text', text: '上次用的' }], createdAt: 1 })
    await a1.app.sessionStore.save((await h1.session.get(s1.id))!)
    await a1.app.shutdown()

    // 记录确实落在当前工作目录下
    expect(readPointer(proj)?.sessionId).toBe(s1.id)

    // 同目录里再放一条「时间更新」的会话：老逻辑（按 cwd 扫最新）会挑走它，
    // 指针必须压过时间 —— 否则「上次用的会话」会被别的入口写进来的会话顶掉。
    await seedSessionFile(a1.app, proj, 's_seeded_newer', Date.now() + 60_000)

    const a2 = mount(proj, dataDir)
    const { session: s2 } = await a2.app.boot()
    expect(a2.app.sessionRestore.source).toBe('auto')
    expect(s2.id).toBe(s1.id)
    expect(s2.messages.map((m) => m.id)).toEqual(['used'])
    await a2.app.shutdown()
  })

  it('各目录各一份指针：在别的目录启动不再影响本目录', async () => {
    const dataDir = join(dir, 'shared')
    const projA = join(dir, 'projA'); mkdirSync(projA, { recursive: true })
    const projB = join(dir, 'projB'); mkdirSync(projB, { recursive: true })

    const a = mount(projA, dataDir)
    const { harness: ha, session: sa } = await a.app.boot()
    await ha.session.addMessage(sa.id, { id: 'A1', role: 'user', parts: [{ type: 'text', text: 'in A' }], createdAt: 1 })
    await a.app.sessionStore.save((await ha.session.get(sa.id))!)
    await a.app.shutdown()

    const b = mount(projB, dataDir)
    const { harness: hb, session: sb } = await b.app.boot()
    await hb.session.addMessage(sb.id, { id: 'B1', role: 'user', parts: [{ type: 'text', text: 'in B' }], createdAt: 2 })
    await b.app.sessionStore.save((await hb.session.get(sb.id))!)
    await b.app.shutdown()

    // B 的会话在全局列表里更新，但两份指针各指各的
    expect(readPointer(projA)?.sessionId).toBe(sa.id)
    expect(readPointer(projB)?.sessionId).toBe(sb.id)

    const a2 = mount(projA, dataDir)
    const { session: s2 } = await a2.app.boot()
    expect(a2.app.sessionRestore.source).toBe('auto')
    expect(s2.id).toBe(sa.id)
    await a2.app.shutdown()
  })

  it('在本目录 /resume 了外目录的会话：指针不会被改写，下次启动仍回本目录自己的会话', async () => {
    const dataDir = join(dir, 'shared')
    const projA = join(dir, 'projA'); mkdirSync(projA, { recursive: true })
    const projB = join(dir, 'projB'); mkdirSync(projB, { recursive: true })

    const b = mount(projB, dataDir)
    const { harness: hb, session: sb } = await b.app.boot()
    await hb.session.addMessage(sb.id, { id: 'B1', role: 'user', parts: [{ type: 'text', text: 'in B' }], createdAt: 1 })
    await b.app.sessionStore.save((await hb.session.get(sb.id))!)
    await b.app.shutdown()

    const a = mount(projA, dataDir)
    const { harness: ha, session: sa } = await a.app.boot()
    await ha.session.addMessage(sa.id, { id: 'A1', role: 'user', parts: [{ type: 'text', text: 'in A' }], createdAt: 1 })
    await a.app.sessionStore.save((await ha.session.get(sa.id))!)
    await startRepl({
      app: a.app, harness: ha, session: sa, stdout: a.stdout,
      scriptedStdin: [`/resume ${sb.id}`, '/exit'],
    })
    expect(a.chunks.join('')).toInclude(`已恢复会话 ${sb.id}`)
    await a.app.shutdown()

    // A 的指针仍是 A 的会话：不因为「刚才手动恢复过 B 的」就把 A 目录的记录改成 B 的 ——
    // 否则下次在 A 启动又会加载出别的目录的会话。
    expect(readPointer(projA)?.sessionId).toBe(sa.id)

    const a2 = mount(projA, dataDir)
    const { session: s2 } = await a2.app.boot()
    expect(s2.id).toBe(sa.id)
    expect(s2.messages.map((m) => m.id)).toEqual(['A1'])
    await a2.app.shutdown()
  })

  it('autoResume: false（服务端形态）不写指针：脚本化不该改写历史', async () => {
    const dataDir = join(dir, 'shared')
    const proj = join(dir, 'proj'); mkdirSync(proj, { recursive: true })

    // 先正常形态跑一轮，留下「本目录上次会话」的记录
    const a1 = mount(proj, dataDir)
    const { harness: h1, session: s1 } = await a1.app.boot()
    await h1.session.addMessage(s1.id, {
      id: 'real', role: 'user', parts: [{ type: 'text', text: '真的聊过' }], createdAt: 1,
    })
    await a1.app.sessionStore.save((await h1.session.get(s1.id))!)
    await a1.app.shutdown()
    expect(readPointer(proj)?.sessionId).toBe(s1.id)

    // 服务端形态 boot（A2A 侧车 / `harness run` 都传 autoResume:false）：它每次新建一条
    // 一次性会话（会话由 contextId 或 prompt 显式寻址），**不该**把它写成「本目录上次会话」。
    // 旧行为会写 —— 实测把 CLI 的指针指到过一个 0 消息空壳（`s_1791382595159_sopo1`），
    // 下次交互式启动就恢复出一个空会话。
    const a2 = mount(proj, dataDir, { autoResume: false })
    const { session: s2 } = await a2.app.boot()
    await a2.app.shutdown()
    expect(s2.id).not.toBe(s1.id)
    expect(readPointer(proj)?.sessionId).toBe(s1.id)
  })

  it('0 消息的会话不落盘：boot 不留空壳，聊过才写文件', async () => {
    const dataDir = join(dir, 'shared')
    const proj = join(dir, 'proj'); mkdirSync(proj, { recursive: true })

    // boot 只在内存里建了会话，磁盘上不该出现文件。旧行为无条件 save，会留下一个
    // 194 字节空壳（无 title/meta、无 telemetry）—— VSCode 每 spawn 一次 A2A 侧车
    // 就 boot 一次，实测积到过 499 个。
    const a1 = mount(proj, dataDir)
    const { harness: h1, session: s1 } = await a1.app.boot()
    expect(existsSync(a1.app.sessionStore.pathFor(s1.id))).toBe(false)
    expect(await a1.app.sessionStore.list()).toHaveLength(0)

    // 聊过之后由轮末 flushDirtySessions 补上 —— `/sessions` 从第一条消息起照常可见
    await h1.session.addMessage(s1.id, {
      id: 'm1', role: 'user', parts: [{ type: 'text', text: '你好' }], createdAt: 1,
    })
    await a1.app.flushDirtySessions()
    expect(existsSync(a1.app.sessionStore.pathFor(s1.id))).toBe(true)
    expect(await a1.app.sessionStore.list()).toHaveLength(1)
    await a1.app.shutdown()
  })

  it('指针失效（会话被删 / 文件损坏）退回同目录兜底，不阻断启动', async () => {
    const dataDir = join(dir, 'shared')
    const proj = join(dir, 'proj'); mkdirSync(proj, { recursive: true })

    const a1 = mount(proj, dataDir)
    const { session: s1 } = await a1.app.boot()
    await a1.app.shutdown()

    const pointerFile = join(proj, '.harness', 'last-session.json')
    // 兜底目标：同目录、时间更新的一条
    await seedSessionFile(a1.app, proj, 's_fallback', Date.now() + 60_000)

    // 1) 指针指向一个已不存在的会话（换了 dataDir / 会话被删）
    writeFileSync(pointerFile, JSON.stringify({ sessionId: 's_gone', savedAt: Date.now() }))
    const a2 = mount(proj, dataDir)
    const { session: s2 } = await a2.app.boot()
    expect(a2.app.sessionRestore.source).toBe('auto')
    expect(s2.id).toBe('s_fallback')
    // 兜底命中后会自愈：把指针改写成实际恢复的那条
    expect(readPointer(proj)?.sessionId).toBe('s_fallback')
    expect(s2.id).not.toBe(s1.id)
    await a2.app.shutdown()

    // 2) 指针文件本身坏掉（非 JSON）
    writeFileSync(pointerFile, '{ 这不是 json')
    const a3 = mount(proj, dataDir)
    const { session: s3 } = await a3.app.boot()
    expect(a3.app.sessionRestore.source).toBe('auto')
    expect(s3.id).toBe('s_fallback')
    await a3.app.shutdown()
  })

  it('/resume 无参与启动自动恢复判定一致；/sessions 标出本目录与「本目录上次」', async () => {
    const dataDir = join(dir, 'shared')
    const proj = join(dir, 'proj'); mkdirSync(proj, { recursive: true })
    const other = join(dir, 'other'); mkdirSync(other, { recursive: true })

    // other 目录先来一条（全局列表里更新，但不属于 proj）
    const o = mount(other, dataDir)
    const { harness: ho, session: so } = await o.app.boot()
    await o.app.sessionStore.save((await ho.session.get(so.id))!)
    await o.app.shutdown()

    const a1 = mount(proj, dataDir)
    const { harness: h1, session: s1 } = await a1.app.boot()
    await h1.session.addMessage(s1.id, { id: 'p1', role: 'user', parts: [{ type: 'text', text: 'proj' }], createdAt: 1 })
    await a1.app.sessionStore.save((await h1.session.get(s1.id))!)
    await a1.app.shutdown()

    const a2 = mount(proj, dataDir)
    const { harness: h2, session: s2 } = await a2.app.boot()
    expect(s2.id).toBe(s1.id)
    const r = await startRepl({
      app: a2.app, harness: h2, session: s2, stdout: a2.stdout,
      scriptedStdin: ['/sessions', '/new', '/resume', '/exit'],
    })
    expect(r).toBe('exit')
    const out = a2.chunks.join('')
    // /sessions：本目录、本目录上次、以及别目录的会话都不加标记
    expect(out).toInclude(`（本工作目录：${proj}；上次会话：${s1.id}）`)
    expect(out).toInclude('← 本目录上次')
    expect(out).toInclude(so.id)
    // /new 之后 /resume 无参：与启动恢复同一套判定（此时指针已指向 /new 出来的会话，
    // 与老逻辑「同目录最新」一致 —— 有意保持两条路径同源）
    const newId = out.match(/已新建会话 (s_\w+)/)?.[1]
    expect(newId).toBeTruthy()
    expect(readPointer(proj)?.sessionId).toBe(newId as string)
    expect(out).toInclude(`已在会话 ${newId}`)
    await a2.app.shutdown()
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
