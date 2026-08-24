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
import type { Session, SessionManager } from '@harness/session'
import { createBus } from '@harness/bus'
import { createSnapshotService } from '@harness/snapshot'
import {
  attachSnapshotToMessage,
  collectSnapshotMap,
  createSessionRevert,
  RevertError,
  RevertEvents,
} from './index'

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
