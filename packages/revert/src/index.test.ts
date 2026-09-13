/**
 * @harness/revert 单测
 *
 * 覆盖：stage（回滚 + RevertState + 事件）、clear（撤销回滚）、commit（接受回滚）、
 * 消息快照引用辅助（attachSnapshotToMessage / collectSnapshotMap）、错误路径。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Session, SessionManager, SessionView } from '@harness/session'
import { buildView } from '@harness/session'
import { createBus } from '@harness/bus'
import { createSnapshotService } from '@harness/snapshot'
import {
  attachSnapshotToMessage,
  collectSnapshotMap,
  createSessionRevert,
  createRevertPlugin,
  createSnapshotPlugin,
  RevertError,
  RevertEvents,
} from './index'
import type { CliCommandInput, Hooks } from '@harness/plugin'

const tempDirs: string[] = []

/** 最小内存 SessionManager：仅实现测试需要的成员 */
class FakeSessionManager implements SessionManager {
  private readonly sessions = new Map<string, Session>()

  constructor(seed: Session) {
    this.sessions.set(seed.id, seed)
  }

  async get(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId)
  }
  async setId(oldId: string, newId: string): Promise<Session> {
    const sess = this.sessions.get(oldId)
    if (!sess) throw new Error('not found')
    this.sessions.delete(oldId)
    sess.id = newId
    this.sessions.set(newId, sess)
    return sess
  }
  async create(): Promise<Session> {
    throw new Error('not implemented')
  }
  async list(): Promise<Session[]> {
    return Array.from(this.sessions.values())
  }
  async search(): Promise<Session[]> {
    return []
  }
  async prompt(): Promise<never> {
    throw new Error('not implemented')
  }
  async *promptStream(): AsyncGenerator<never> {
    throw new Error('not implemented')
  }
  async updateMessage(): Promise<void> {
    throw new Error('not implemented')
  }
  async updatePart(): Promise<void> {
    throw new Error('not implemented')
  }
  async addMessage(sessionId: string, message: Session['messages'][number]): Promise<void> {
    const session = this.sessions.get(sessionId)
    session?.messages.push(message)
  }
  async setMessages(sessionId: string, messages: Session['messages']): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) session.messages = messages
  }
  async updateMeta(sessionId: string, patch: Record<string, unknown>): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) session.meta = { ...(session.meta ?? {}), ...patch }
  }
  async getView(sessionId: string): Promise<SessionView> {
    const session = this.sessions.get(sessionId)
    if (!session) return { blocks: [], messages: [], slimmed: false }
    return buildView(session.blocks, session.messages)
  }
  setHistoryLoader(): void {
    /* not implemented */
  }
  async flushHistory(): Promise<Session['messages']> {
    return []
  }
  async deleteMessage(): Promise<void> {
    throw new Error('not implemented')
  }
  async snapshot(): Promise<string> {
    throw new Error('not implemented')
  }
  async revert(): Promise<void> {
    throw new Error('not implemented')
  }
  async unrevert(): Promise<void> {
    throw new Error('not implemented')
  }
  async compact(): Promise<void> {
    throw new Error('not implemented')
  }
  async compactIfNeeded(): Promise<boolean> {
    return false
  }
  async estimateTokens(): Promise<number> {
    return 0
  }
  async getCompactionInfo() {
    return {}
  }
  async exportMarkdown(): Promise<string> {
    return ''
  }
  enqueueNotification(): void {
    throw new Error('not implemented')
  }
  drainNotifications(): string[] {
    return []
  }
}

interface Env {
  worktree: string
  session: Session
  manager: FakeSessionManager
  svc: ReturnType<typeof createSnapshotService>
  bus: ReturnType<typeof createBus>
}

async function makeEnv(): Promise<Env> {
  const worktree = await mkdtemp(path.join(tmpdir(), 'harness-revert-wt-'))
  const gitDir = await mkdtemp(path.join(tmpdir(), 'harness-revert-git-'))
  tempDirs.push(worktree, gitDir)
  const session: Session = {
    id: 's1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  }
  return {
    worktree,
    session,
    manager: new FakeSessionManager(session),
    svc: createSnapshotService({ worktree, gitDirectory: gitDir }),
    bus: createBus(),
  }
}

function makeMessage(id: string, role: Session['messages'][number]['role']): Session['messages'][number] {
  return { id, role, parts: [], createdAt: Date.now() }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SessionRevert', () => {
  test('stage：回滚 boundary 之后的文件变更，发布 staged 事件并保存 RevertState', async () => {
    const env = await makeEnv()
    const { session, manager, svc, bus, worktree } = env
    const aPath = path.join(worktree, 'a.txt')

    // 消息链：m0(user 边界) → m1(assistant, snap1: a=v1) → m2(assistant, snap2: a=v2)
    await writeFile(aPath, 'v1\n')
    const snap1 = await svc.capture()
    await writeFile(aPath, 'v2\n')
    const snap2 = await svc.capture()
    session.messages.push(makeMessage('m0', 'user'))
    session.messages.push(makeMessage('m1', 'assistant'))
    session.messages.push(makeMessage('m2', 'assistant'))
    attachSnapshotToMessage(session, 'm1', snap1!, ['a.txt'])
    attachSnapshotToMessage(session, 'm2', snap2!, ['a.txt'])

    const revert = createSessionRevert({ session: manager, snapshot: svc, bus })
    const staged: Array<{ sessionId: string; messageID: string }> = []
    bus.subscribe(RevertEvents.staged, ({ payload }) => { staged.push(payload) })

    const state = await revert.stage({ sessionId: 's1', messageID: 'm0' })

    // 文件回滚到 m1 快照（v1）
    expect(await readFile(aPath, 'utf-8')).toBe('v1\n')
    // RevertState 已保存
    expect(state.messageID).toBe('m0')
    expect(state.snapshot).toBeDefined()
    expect(state.files).toBeDefined()
    expect(state.files![0]!.path).toBe('a.txt')
    expect(state.diff).toContain('v1')
    // session.meta.revert 已写入
    expect((session.meta?.['revert'] as any)?.messageID).toBe('m0')
    // staged 事件已发布
    expect(staged).toHaveLength(1)
    expect(staged[0]!.sessionId).toBe('s1')
  })

  test('stage：显式 snapshotMap 优先于消息收集', async () => {
    const env = await makeEnv()
    const { session, manager, svc, bus, worktree } = env
    const aPath = path.join(worktree, 'a.txt')

    await writeFile(aPath, 'v1\n')
    const snap1 = await svc.capture()
    await writeFile(aPath, 'v2\n')
    session.messages.push(makeMessage('m0', 'user'))

    const revert = createSessionRevert({ session: manager, snapshot: svc, bus })
    await revert.stage({ sessionId: 's1', messageID: 'm0', snapshotMap: new Map([['a.txt', snap1!]]) })

    expect(await readFile(aPath, 'utf-8')).toBe('v1\n')
  })

  test('stage：消息不存在时抛 RevertError', async () => {
    const env = await makeEnv()
    const { session, manager, svc, bus } = env
    session.messages.push(makeMessage('m0', 'user'))

    const revert = createSessionRevert({ session: manager, snapshot: svc, bus })
    await expect(
      revert.stage({ sessionId: 's1', messageID: 'no-such-message' }),
    ).rejects.toBeInstanceOf(RevertError)
  })

  test('stage：boundary 在折叠块内（仅全文可回溯定位）时仍能回退最近消息', async () => {
    const env = await makeEnv()
    const { session, manager, svc, bus, worktree } = env
    const aPath = path.join(worktree, 'a.txt')

    // 折叠：session.messages 只保留近期（m0→m2），boundary m0 与 m1 被折叠进块原文，仅经全文可回溯
    await writeFile(aPath, 'v1\n')
    const snap1 = await svc.capture() // m1 快照（a=v1）
    await writeFile(aPath, 'v2\n')
    const snap2 = await svc.capture() // m2 快照（a=v2）
    const foldedBoundary = makeMessage('m0', 'user')
    const foldedFollow = makeMessage('m1', 'assistant')
    attachSnapshotToMessage({ messages: [foldedBoundary, foldedFollow] } as any, 'm1', snap1!, ['a.txt'])
    session.messages = [foldedFollow, makeMessage('m2', 'assistant')]
    attachSnapshotToMessage(session, 'm2', snap2!, ['a.txt'])
    // 近期 messages 里没有 boundary m0（已被折叠），只有全文回溯能定位
    expect(session.messages.some((m) => m.id === 'm0')).toBe(false)

    // 注入全文回溯器：还原折叠块原文 + 近期
    const revert = createSessionRevert({
      session: manager,
      snapshot: svc,
      bus,
      getFullHistory: async () => [foldedBoundary, foldedFollow, ...session.messages],
    })

    const state = await revert.stage({ sessionId: 's1', messageID: 'm0' })
    // 文件回滚到离 boundary 最近的后继快照 m1（a=v1）——即便 m1 在折叠块内也能被收集
    expect(await readFile(aPath, 'utf-8')).toBe('v1\n')
    expect(state.messageID).toBe('m0')
    expect(state.files?.some((f) => f.path === 'a.txt')).toBe(true)
  })

  test('clear：撤销回滚（文件恢复回滚前状态），发布 cleared，清除 revert 状态', async () => {
    const env = await makeEnv()
    const { session, manager, svc, bus, worktree } = env
    const aPath = path.join(worktree, 'a.txt')

    await writeFile(aPath, 'v1\n')
    const snap1 = await svc.capture()
    await writeFile(aPath, 'v2\n')
    session.messages.push(makeMessage('m0', 'user'))
    session.messages.push(makeMessage('m1', 'assistant'))
    attachSnapshotToMessage(session, 'm1', snap1!, ['a.txt'])

    const revert = createSessionRevert({ session: manager, snapshot: svc, bus })
    await revert.stage({ sessionId: 's1', messageID: 'm0' })
    expect(await readFile(aPath, 'utf-8')).toBe('v1\n') // 已回滚

    const cleared: Array<{ sessionId: string }> = []
    bus.subscribe(RevertEvents.cleared, ({ payload }) => { cleared.push(payload) })

    await revert.clear('s1')

    // 撤销回滚 → 恢复回滚前（stage 时捕获的 original = v2）
    expect(await readFile(aPath, 'utf-8')).toBe('v2\n')
    expect(session.meta?.['revert']).toBeUndefined()
    expect(cleared).toHaveLength(1)
  })

  test('commit：接受回滚（文件保持回滚后状态），发布 committed，清除 revert 状态', async () => {
    const env = await makeEnv()
    const { session, manager, svc, bus, worktree } = env
    const aPath = path.join(worktree, 'a.txt')

    await writeFile(aPath, 'v1\n')
    const snap1 = await svc.capture()
    await writeFile(aPath, 'v2\n')
    session.messages.push(makeMessage('m0', 'user'))
    session.messages.push(makeMessage('m1', 'assistant'))
    attachSnapshotToMessage(session, 'm1', snap1!, ['a.txt'])

    const revert = createSessionRevert({ session: manager, snapshot: svc, bus })
    await revert.stage({ sessionId: 's1', messageID: 'm0' })

    const committed: Array<{ sessionId: string; messageID: string }> = []
    bus.subscribe(RevertEvents.committed, ({ payload }) => { committed.push(payload) })

    await revert.commit('s1')

    // 接受回滚 → 文件保持 v1（回滚后状态）
    expect(await readFile(aPath, 'utf-8')).toBe('v1\n')
    expect(session.meta?.['revert']).toBeUndefined()
    expect(committed).toHaveLength(1)
    expect(committed[0]!.messageID).toBe('m0')
  })

  test('重复 stage 沿用首次捕获的 original 快照', async () => {
    const env = await makeEnv()
    const { session, manager, svc, bus } = env
    await writeFile(path.join(env.worktree, 'a.txt'), 'v1\n')
    session.messages.push(makeMessage('m0', 'user'))

    const revert = createSessionRevert({ session: manager, snapshot: svc, bus })
    const first = await revert.stage({ sessionId: 's1', messageID: 'm0' })
    const second = await revert.stage({ sessionId: 's1', messageID: 'm0' })

    expect(second.snapshot).toBe(first.snapshot)
  })
})

describe('消息快照引用辅助', () => {
  test('attachSnapshotToMessage 挂载到 meta.snapshot', async () => {
    const env = await makeEnv()
    const session = env.session
    session.messages.push(makeMessage('m1', 'assistant'))

    attachSnapshotToMessage(session, 'm1', 'abc123' as any, ['a.txt', 'b.txt'])
    expect(session.messages[0]!.meta?.snapshot).toEqual({
      start: 'abc123',
      files: ['a.txt', 'b.txt'],
    })
  })

  test('attachSnapshotToMessage 消息不存在抛 RevertError', async () => {
    const env = await makeEnv()
    expect(() =>
      attachSnapshotToMessage(env.session, 'missing', 'abc123' as any),
    ).toThrow(RevertError)
  })

  test('collectSnapshotMap 收集边界后 assistant 消息快照（去重 + 跳过无快照消息）', async () => {
    const env = await makeEnv()
    const session = env.session
    session.messages.push(makeMessage('m0', 'user'))
    session.messages.push(makeMessage('m1', 'assistant'))
    session.messages.push(makeMessage('m2', 'user')) // 非 assistant，跳过
    session.messages.push(makeMessage('m3', 'assistant'))
    session.messages.push(makeMessage('m4', 'assistant')) // 无快照引用，跳过

    attachSnapshotToMessage(session, 'm1', 'snap1' as any, ['a.txt'])
    attachSnapshotToMessage(session, 'm3', 'snap3' as any, ['a.txt', 'b.txt'])

    const map = collectSnapshotMap(session, 'm0')
    // a.txt 取最早（m1 的 snap1），b.txt 取 snap3
    expect(map.get('a.txt')).toBe('snap1' as any)
    expect(map.get('b.txt')).toBe('snap3' as any)
    expect(map.size).toBe(2)
  })

  test('collectSnapshotMap 边界消息不存在返回空 Map', async () => {
    const env = await makeEnv()
    expect(collectSnapshotMap(env.session, 'no-such')).toEqual(new Map())
  })
})

describe('createRevertPlugin · 薄壳 /revert 命令', () => {
  function cmdInput(partial: { raw?: string; snapshotService?: unknown; harness?: unknown } = {}): CliCommandInput & {
    snapshotService?: unknown
  } {
    const raw = partial.raw ?? 'revert'
    return {
      raw,
      command: raw.split(/\s+/)[0],
      arg: raw.split(/\s+/, 2)[1] ?? '',
      sessionId: 's1',
      result: undefined,
      out: () => {},
      snapshotService: partial.snapshotService,
      harness: partial.harness,
    }
  }

  async function hooksOf(p: ReturnType<typeof createRevertPlugin>): Promise<NonNullable<Hooks>> {
    return (await (p.install as (ctx?: unknown) => Promise<Hooks | void>)(undefined))!
  }

  test('命中 revert 时注册命令定义（cli.commands）', async () => {
    const hooks = await hooksOf(createRevertPlugin())
    const cmds: Array<{ command: string; description: string; usage?: string }> = []
    await hooks['cli.commands']!({ commands: cmds })
    expect(cmds.some((c) => c.command === 'revert')).toBe(true)
  })

  test('未配套 snapshot 时提示启用且设 result=continue', async () => {
    const hooks = await hooksOf(createRevertPlugin())
    const out: string[] = []
    const input = cmdInput()
    input.out = (s) => void out.push(s)
    await hooks['cli.command']!(input)
    expect(out.join('')).toInclude('快照未启用')
    expect(input.result).toBe('continue')
  })

  test('snapshot 就绪但 harness 未注入 session/bus 时提示', async () => {
    const hooks = await hooksOf(createRevertPlugin())
    const out: string[] = []
    const input = cmdInput({ snapshotService: {} })
    input.out = (s) => void out.push(s)
    await hooks['cli.command']!(input)
    expect(out.join('')).toInclude('session/bus')
    expect(input.result).toBe('continue')
  })

  test('非 revert 命令不设 result（留给别的插件）', async () => {
    const hooks = await hooksOf(createRevertPlugin())
    const input = cmdInput({ raw: 'workspace', snapshotService: {} })
    await hooks['cli.command']!(input)
    expect(input.result).toBeUndefined()
  })

  test('暴露稳定 id', () => {
    expect(createRevertPlugin().id).toBe('revert-shell')
  })
})

describe('createSnapshotPlugin · 薄壳 /snapshot 命令', () => {
  function cmdInput(partial: { raw?: string; snapshotService?: unknown } = {}): CliCommandInput & {
    snapshotService?: unknown
  } {
    const raw = partial.raw ?? 'snapshot'
    return {
      raw,
      command: raw.split(/\s+/)[0],
      arg: raw.split(/\s+/, 2)[1] ?? '',
      sessionId: 's1',
      result: undefined,
      out: () => {},
      snapshotService: partial.snapshotService,
    }
  }

  async function hooksOf(p: ReturnType<typeof createSnapshotPlugin>): Promise<Hooks> {
    return (await (p.install as (ctx?: unknown) => Promise<Hooks | void>)(undefined))!
  }

  function fakeSvc(overrides: Record<string, unknown> = {}) {
    return {
      enabled: true,
      backend: 'git',
      capture: async (scope?: string) => scope ? `snap-${scope}` : 'snap-a',
      files: async (from: string, to: string) => to === 'to2' ? ['a.ts', 'b.ts'] : [],
      list: async () => [
        { id: 'snap-c', timestamp: 2000 },
        { id: 'snap-b', timestamp: 1000 },
      ],
      diff: async () => [],
      preview: async () => [],
      restore: async () => {},
      checkout: async () => {},
      gc: async () => {},
      ...overrides,
    } as any
  }

  /** 构造输入并运行子命令，捕获输出 */
  async function run(hooks: Hooks, raw: string, svc: unknown): Promise<string> {
    const out: string[] = []
    const input = cmdInput({ raw, snapshotService: svc })
    input.out = (s) => void out.push(s)
    await hooks['cli.command']!(input)
    expect(input.result).toBe('continue')
    return out.join('')
  }

  test('命中 snapshot 时注册命令定义（cli.commands）', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const cmds: Array<{ command: string; description: string; usage?: string }> = []
    await hooks['cli.commands']!({ commands: cmds })
    expect(cmds.some((c) => c.command === 'snapshot')).toBe(true)
  })

  test('未配套 snapshot 时提示开启方式且设 result=continue', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const out: string[] = []
    const input = cmdInput()
    input.out = (s) => void out.push(s)
    await hooks['cli.command']!(input)
    expect(out.join('')).toInclude('--snapshot')
    expect(input.result).toBe('continue')
  })

  test('缺省子命令输出 status（已启用 + 后端 + 最新快照）', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const out = await run(hooks, 'snapshot', fakeSvc())
    expect(out).toInclude('状态：已启用')
    expect(out).toInclude('后端：git')
    expect(out).toInclude('快照数：2')
    expect(out).toInclude('最新快照：snap-c')
  })

  test('capture 子命令输出快照 ID', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const out: string[] = []
    const input = cmdInput({ raw: 'snapshot capture', snapshotService: fakeSvc() })
    input.out = (s) => void out.push(s)
    await hooks['cli.command']!(input)
    expect(out.join('')).toInclude('已捕获快照：snap-a')
  })

  test('files 子命令列出变更路径；缺参提示用法', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const outA: string[] = []
    const a = cmdInput({ raw: 'snapshot files f1 to2', snapshotService: fakeSvc() })
    a.out = (s) => void outA.push(s)
    await hooks['cli.command']!(a)
    expect(outA.join('')).toInclude('a.ts')

    const outB: string[] = []
    const b = cmdInput({ raw: 'snapshot files f1', snapshotService: fakeSvc() })
    b.out = (s) => void outB.push(s)
    await hooks['cli.command']!(b)
    expect(outB.join('')).toInclude('用法')
  })

  test('list 子命令输出快照历史（最新在前，含时间戳）', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const out = await run(hooks, 'snapshot list', fakeSvc())
    expect(out).toInclude('快照（2）')
    expect(out).toInclude('snap-c')
    expect(out).toInclude('snap-b')
    // 时间戳渲染为本地时间串
    expect(out).toInclude('1970')
  })

  test('list 无快照时提示捕获', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const out = await run(hooks, 'snapshot list', fakeSvc({ list: async () => [] }))
    expect(out).toInclude('暂无快照')
  })

  test('diff 子命令输出统计摘要；带 path 时附补丁', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const svc = fakeSvc({
      diff: async (from: string, to: string) => [
        { path: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new\n' },
      ],
    })
    const summary = await run(hooks, 'snapshot diff f1 to2', svc)
    expect(summary).toInclude('修改')
    expect(summary).toInclude('a.ts')
    expect(summary).toInclude('+2/-1')

    const withPatch = await run(hooks, 'snapshot diff f1 to2 a.ts', svc)
    expect(withPatch).toInclude('@@ -1 +1 @@')
  })

  test('diff 缺参提示用法；无差异时提示', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    expect(await run(hooks, 'snapshot diff', fakeSvc())).toInclude('用法')
    const noDiff = await run(hooks, 'snapshot diff f1 to2', fakeSvc({ diff: async () => [] }))
    expect(noDiff).toInclude('无差异')
  })

  test('restore 子命令从快照恢复指定文件', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const restored: Map<string, string> = new Map()
    const svc = fakeSvc({
      restore: async (files: Map<string, string>) => {
        for (const [p, to] of files) restored.set(p, to)
      },
    })
    const out = await run(hooks, 'snapshot restore to2 a.ts b.ts', svc)
    expect(out).toInclude('已从快照 to2 恢复 2 个文件')
    expect(restored.get('a.ts')).toBe('to2')
    expect(restored.get('b.ts')).toBe('to2')
  })

  test('restore 缺参提示用法', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    expect(await run(hooks, 'snapshot restore to2', fakeSvc())).toInclude('用法')
  })

  test('checkout 子命令整仓恢复', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const checked: string[] = []
    const svc = fakeSvc({ checkout: async (id: string) => { checked.push(id) } })
    const out = await run(hooks, 'snapshot checkout to2', svc)
    expect(out).toInclude('已整仓恢复到快照 to2')
    expect(checked).toEqual(['to2'])
  })

  test('checkout 缺参提示用法', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    expect(await run(hooks, 'snapshot checkout', fakeSvc())).toInclude('用法')
  })

  test('status 无快照时提示捕获', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const out = await run(hooks, 'snapshot status', fakeSvc({ list: async () => [] }))
    expect(out).toInclude('状态：已启用')
    expect(out).toInclude('快照数：0')
    expect(out).toInclude('暂无')
  })

  test('preview 子命令零副作用输出 diff（不落盘）', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const previewed: Map<string, string> = new Map()
    const svc = fakeSvc({
      preview: async (files: Map<string, string>) => {
        for (const [p, to] of files) previewed.set(p, to)
        return [
          { path: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new\n' },
        ]
      },
    })
    const out = await run(hooks, 'snapshot preview to2 a.ts', svc)
    expect(out).toInclude('回滚预览')
    expect(out).toInclude('修改')
    expect(out).toInclude('+1/-1')
    expect(out).toInclude('@@ -1 +1 @@')
    expect(previewed.get('a.ts')).toBe('to2')
  })

  test('preview 缺参提示用法', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    expect(await run(hooks, 'snapshot preview to2', fakeSvc())).toInclude('用法')
  })

  test('gc 子命令触发清理并提示', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    let called = 0
    const svc = fakeSvc({ gc: async () => { called++ } })
    const out = await run(hooks, 'snapshot gc', svc)
    expect(out).toInclude('已清理过期快照存储')
    expect(called).toBe(1)
  })

  test('gc 后端不支持时提示', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const svc = fakeSvc()
    delete svc.gc
    expect(await run(hooks, 'snapshot gc', svc)).toInclude('不支持')
  })

  test('非 snapshot 命令不设 result', async () => {
    const hooks = await hooksOf(createSnapshotPlugin())
    const input = cmdInput({ raw: 'revert', snapshotService: fakeSvc() })
    await hooks['cli.command']!(input)
    expect(input.result).toBeUndefined()
  })

  test('暴露稳定 id', () => {
    expect(createSnapshotPlugin().id).toBe('snapshot-shell')
  })
})
