/**
 * @harness/swarm 单测
 *
 * 覆盖：TeamManager（create/get/list/addMember/delete）、TeammateMailbox（带锁写入/
 * 未读读取/标记已读）、TaskListPlane（状态机 + claim 冲突 + 生命周期校验）、
 * LeaderPermissionBridge（注册/请求/fail-closed）、InboxPoller、in-process teammate
 * （AsyncLocalStorage 身份隔离）、全部工具与插件注入。
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  attachInboxPoller,
  createSendTeammateMessageTool,
  createSwarmPlugin,
  createTaskClaimTool,
  createTaskCreateTool,
  createTaskListTool,
  createTaskStopTool,
  createTeamCreateTool,
  createTeamDeleteTool,
  createTeamStatusTool,
  formatAgentId,
  getCurrentTeammate,
  hasLeaderConfirmQueue,
  registerLeaderConfirmQueue,
  requestPermissionThroughLeader,
  runTeammateTick,
  sanitizeName,
  spawnInProcessTeammate,
  startTeammateLoop,
  TaskListPlane,
  TeammateMailbox,
  TeamManager,
  TeammateRegistry,
  withTeammateIdentity,
  withLock,
  type ConfirmRequest,
  type SwarmTask,
  type TeamMember,
} from './index'
import type { ToolContext } from '@harness/tool'

const tempDirs: string[] = []

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's_lead',
    agentId: 'coordinator',
    messageId: 'm1',
    toolUseId: 't1',
    signal: new AbortController().signal,
    variables: {},
    cwd: '/tmp',
    ...overrides,
  } as unknown as ToolContext
}

// ===== sanitizeName =====

describe('sanitizeName', () => {
  it('小写 + 非字母数字转 -', () => {
    expect(sanitizeName('My Team 2024')).toBe('my-team-2024')
    expect(sanitizeName('  Frontend  ')).toBe('frontend')
  })
  it('全非法字符回退 unnamed', () => {
    expect(sanitizeName('!!!')).toBe('unnamed')
    expect(sanitizeName('')).toBe('unnamed')
  })
})

// ===== TeamManager =====

describe('TeamManager', () => {
  it('create 写入 team.json（lead 自动入队），get 读回', async () => {
    const dir = await makeDir('swarm-team-')
    const mgr = new TeamManager(dir)
    const team = await mgr.create({ name: 'Alpha', description: '调研团队', leadAgentId: 'coordinator', leadSessionId: 's_lead' })
    expect(team.name).toBe('alpha')
    expect(team.members).toHaveLength(1)
    expect(team.members[0]).toMatchObject({ name: 'lead', role: 'lead', agentId: 'coordinator' })

    const loaded = await mgr.get('alpha')
    expect(loaded).toEqual(team)
    // team.json + inboxes 目录已初始化
    expect((await readFile(path.join(dir, 'alpha', 'team.json'), 'utf-8')).length).toBeGreaterThan(0)
    await expect(mkdir(path.join(dir, 'alpha', 'inboxes'))).rejects.toThrow() // 已存在
  })

  it('重复创建同名团队抛错', async () => {
    const dir = await makeDir('swarm-team-')
    const mgr = new TeamManager(dir)
    await mgr.create({ name: 'Alpha', leadAgentId: 'c', leadSessionId: 's' })
    await expect(mgr.create({ name: 'Alpha', leadAgentId: 'c', leadSessionId: 's' })).rejects.toThrow(/already exists/)
  })

  it('addMember 加入成员（同名覆盖）并持久化', async () => {
    const dir = await makeDir('swarm-team-')
    const mgr = new TeamManager(dir)
    await mgr.create({ name: 'Alpha', leadAgentId: 'coordinator', leadSessionId: 's_lead' })
    const member: TeamMember = { agentId: 'researcher', name: 'bob', role: 'teammate', color: 'blue' }
    const team = await mgr.addMember('alpha', member)
    expect(team.members.map((m) => m.name)).toEqual(['lead', 'bob'])
    expect(mgr.getMember(team, 'bob')).toMatchObject({ agentId: 'researcher', color: 'blue' })
    // 同名覆盖
    const team2 = await mgr.addMember('alpha', { ...member, color: 'red' })
    expect(team2.members).toHaveLength(2)
    expect(mgr.getMember(team2, 'bob')!.color).toBe('red')
  })

  it('list 列出全部团队；get 不存在返回 undefined', async () => {
    const dir = await makeDir('swarm-team-')
    const mgr = new TeamManager(dir)
    expect(await mgr.get('ghost')).toBeUndefined()
    await mgr.create({ name: 'A', leadAgentId: 'c', leadSessionId: 's' })
    await mgr.create({ name: 'B', leadAgentId: 'c', leadSessionId: 's' })
    expect((await mgr.list()).map((t) => t.name).sort()).toEqual(['a', 'b'])
  })

  it('delete 递归删除团队目录', async () => {
    const dir = await makeDir('swarm-team-')
    const mgr = new TeamManager(dir)
    await mgr.create({ name: 'Alpha', leadAgentId: 'c', leadSessionId: 's' })
    await mgr.delete('alpha')
    expect(await mgr.get('alpha')).toBeUndefined()
  })
})

// ===== TeammateMailbox =====

describe('TeammateMailbox', () => {
  it('writeToMailbox → readUnreadMessages → markMessageAsRead', async () => {
    const dir = await makeDir('swarm-mail-')
    const mb = new TeammateMailbox(dir)
    await mb.writeToMailbox('alpha', 'bob', { from: 'lead', text: '请调研竞品 A', timestamp: '2026-01-01T00:00:00Z', type: 'message' })
    await mb.writeToMailbox('alpha', 'bob', { from: 'lead', text: '第二条', timestamp: '2026-01-01T00:00:01Z', type: 'message' })

    expect(await mb.countUnread('alpha', 'bob')).toBe(2)
    const unread = await mb.readUnreadMessages('alpha', 'bob')
    expect(unread.map((m) => m.text)).toEqual(['请调研竞品 A', '第二条'])

    // markMessageAsReadByRef 标记第一条
    await mb.markMessageAsReadByRef('alpha', 'bob', { from: 'lead', timestamp: '2026-01-01T00:00:00Z' })
    expect(await mb.countUnread('alpha', 'bob')).toBe(1)
    expect((await mb.readUnreadMessages('alpha', 'bob'))[0]!.text).toBe('第二条')
  })

  it('多收件人隔离', async () => {
    const dir = await makeDir('swarm-mail-')
    const mb = new TeammateMailbox(dir)
    await mb.writeToMailbox('alpha', 'bob', { from: 'lead', text: 'to bob', timestamp: 't1', type: 'message' })
    expect(await mb.countUnread('alpha', 'alice')).toBe(0)
    expect(await mb.countUnread('alpha', 'bob')).toBe(1)
  })

  it('并发写入安全（withLock 串行化，不丢消息）', async () => {
    const dir = await makeDir('swarm-mail-')
    const mb = new TeammateMailbox(dir)
    // 并发 10 条写入同一收件人
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mb.writeToMailbox('alpha', 'bob', { from: 'w', text: `msg-${i}`, timestamp: `t${i}`, type: 'message' }),
      ),
    )
    const all = await mb.readMailbox('alpha', 'bob')
    expect(all).toHaveLength(10)
  })

  it('withLock 超时抛错（锁被永久占用）', async () => {
    const dir = await makeDir('swarm-lock-')
    await writeFile(path.join(dir, 'x.lock'), 'held', 'utf-8')
    await expect(withLock(path.join(dir, 'x.lock'), async () => 'done', 100)).rejects.toThrow(/Lock timeout/)
  })
})

// ===== TaskListPlane =====

describe('TaskListPlane', () => {
  it('create → list → claim → complete 状态机', async () => {
    const dir = await makeDir('swarm-task-')
    const plane = new TaskListPlane(dir)
    const task = await plane.create('alpha', { title: '实现登录页', description: '含表单校验' })
    expect(task.status).toBe('available')

    expect((await plane.list('alpha')).map((t) => t.id)).toEqual([task.id])
    expect((await plane.list('alpha', 'in_progress'))).toHaveLength(0)

    const claimed = await plane.claim('alpha', task.id, 'bob')
    expect(claimed.status).toBe('in_progress')
    expect(claimed.claimedBy).toBe('bob')

    const done = await plane.update('alpha', task.id, { status: 'completed', result: 'done in 2h' })
    expect(done.status).toBe('completed')
    expect(done.result).toBe('done in 2h')
  })

  it('claim 冲突：已被认领/非 available 抛错', async () => {
    const dir = await makeDir('swarm-task-')
    const plane = new TaskListPlane(dir)
    const task = await plane.create('alpha', { title: 'T' })
    await plane.claim('alpha', task.id, 'bob')
    await expect(plane.claim('alpha', task.id, 'alice')).rejects.toThrow(/not claimable/)
    await plane.update('alpha', task.id, { status: 'completed' })
    await expect(plane.claim('alpha', task.id, 'alice')).rejects.toThrow(/not claimable/)
  })

  it('生命周期校验：非法迁移抛错（available → completed 不允许）', async () => {
    const dir = await makeDir('swarm-task-')
    const plane = new TaskListPlane(dir)
    const task = await plane.create('alpha', { title: 'T' })
    await expect(plane.update('alpha', task.id, { status: 'completed' })).rejects.toThrow(/Invalid transition/)
  })

  it('stop：in_progress → cancelled', async () => {
    const dir = await makeDir('swarm-task-')
    const plane = new TaskListPlane(dir)
    const task = await plane.create('alpha', { title: 'T' })
    await plane.claim('alpha', task.id, 'bob')
    const stopped = await plane.stop('alpha', task.id)
    expect(stopped.status).toBe('cancelled')
  })

  it('任务不存在抛错', async () => {
    const dir = await makeDir('swarm-task-')
    const plane = new TaskListPlane(dir)
    await expect(plane.claim('alpha', 'nope', 'bob')).rejects.toThrow(/not found/)
  })
})

// ===== LeaderPermissionBridge =====

describe('LeaderPermissionBridge', () => {
  it('未注册 leader 桥时 fail-closed 拒绝', async () => {
    // 前提：此文件前面的测试未调用 registerLeaderConfirmQueue（本 describe 是首个使用者）
    const decision = await requestPermissionThroughLeader({ toolName: 'bash', input: { command: 'x' } })
    expect(decision).toEqual({ allow: false })
    expect(hasLeaderConfirmQueue()).toBe(false)
  })

  it('registerLeaderConfirmQueue 后 hasLeaderConfirmQueue 为 true，请求入队并 resolve', async () => {
    const queue: ConfirmRequest[] = []
    registerLeaderConfirmQueue((req) => { queue.push(req) })
    expect(hasLeaderConfirmQueue()).toBe(true)

    const pending = requestPermissionThroughLeader({ toolName: 'write_file', input: { path: '/x' }, workerBadge: { name: 'bob' } })
    expect(queue).toHaveLength(1)
    expect(queue[0]!.workerBadge).toEqual({ name: 'bob' })
    queue[0]!.resolve({ allow: true })
    await expect(pending).resolves.toEqual({ allow: true })
  })
})

// ===== InboxPoller =====

describe('InboxPoller', () => {
  it('pollOnce 读取未读消息回调并标记已读', async () => {
    const dir = await makeDir('swarm-poll-')
    const mb = new TeammateMailbox(dir)
    await mb.writeToMailbox('alpha', 'bob', { from: 'lead', text: 'hello', timestamp: 't1', type: 'message' })

    const received: string[] = []
    const poller = attachInboxPoller({ mailbox: mb, team: 'alpha', agent: 'bob', intervalMs: 0, onMessage: (msg) => { received.push(msg.text) } })
    await poller.pollOnce()
    expect(received).toEqual(['hello'])
    expect(await mb.countUnread('alpha', 'bob')).toBe(0)
    poller.stop()
  })

  it('start 自动轮询（intervalMs>0）收到新消息', async () => {
    const dir = await makeDir('swarm-poll-')
    const mb = new TeammateMailbox(dir)
    const received: string[] = []
    const poller = attachInboxPoller({ mailbox: mb, team: 'alpha', agent: 'bob', intervalMs: 20, onMessage: (msg) => { received.push(msg.text) } })
    poller.start()
    await mb.writeToMailbox('alpha', 'bob', { from: 'lead', text: 'auto', timestamp: 't1', type: 'message' })
    await new Promise((r) => setTimeout(r, 80))
    expect(received).toContain('auto')
    poller.stop()
  })
})

// ===== in-process teammate =====

describe('in-process teammate', () => {
  it('formatAgentId + TeammateRegistry 注册/查询/shutdown', () => {
    const registry = new TeammateRegistry()
    const agentId = formatAgentId('bob', 'Alpha')
    expect(agentId).toBe('bob@alpha')
    registry.register({
      agentId,
      identity: { team: 'alpha', name: 'bob', agentId: 'researcher' },
      sessionId: 's_sub',
      status: 'running',
      prompt: '调研',
      abortController: new AbortController(),
      createdAt: Date.now(),
    })
    expect(registry.get(agentId)).toBeDefined()
    expect(registry.findByMember('alpha', 'bob')!.agentId).toBe(agentId)
    expect(registry.requestShutdown(agentId)).toBe(true)
    expect(registry.get(agentId)!.status).toBe('shutdown')
    expect(registry.requestShutdown('ghost')).toBe(false)
  })

  it('withTeammateIdentity 用 AsyncLocalStorage 隔离身份', async () => {
    expect(getCurrentTeammate()).toBeUndefined()
    await withTeammateIdentity({ team: 'alpha', name: 'bob', agentId: 'researcher' }, () => {
      expect(getCurrentTeammate()).toMatchObject({ name: 'bob' })
    })
    expect(getCurrentTeammate()).toBeUndefined()
  })
})

// ===== in-process teammate 完整执行循环 =====

/** mock harness（query 记录调用 + session.create 返回独立 session） */
function makeMockHarness() {
  const queries: Array<{ sessionId: string; agentId: string; message: string }> = []
  const agent = {
    query: async (input: { sessionId: string; agentId?: string; message: string }) => {
      queries.push(input as { sessionId: string; agentId: string; message: string })
      return {
        id: 'm',
        role: 'assistant',
        parts: [{ type: 'text', text: `回复: ${input.message.slice(0, 30)}` }],
        createdAt: Date.now(),
      }
    },
  }
  const session = {
    create: async (opts?: { title?: string; parentId?: string }) => ({
      id: `s_${Math.random().toString(36).slice(2, 7)}`,
      title: opts?.title ?? 'session',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      parentId: opts?.parentId,
    }),
  }
  return { harness: { agent, session } as any, queries }
}

function makeTeammateState(overrides: Partial<Parameters<typeof runTeammateTick>[0]> = {}) {
  const state = {
    agentId: 'bob@alpha',
    identity: { team: 'alpha', name: 'bob', agentId: 'researcher' },
    sessionId: 's_sub',
    status: 'running',
    prompt: '',
    abortController: new AbortController(),
    createdAt: Date.now(),
    ...overrides,
  }
  return state as Parameters<typeof runTeammateTick>[0]
}

describe('runTeammateTick（teammate 执行循环）', () => {
  it('处理 mailbox 未读消息：query 执行 + 回复写回发送者 + 消息标记已读', async () => {
    const dir = await makeDir('swarm-tick-')
    const mb = new TeammateMailbox(dir)
    const plane = new TaskListPlane(dir)
    const { harness, queries } = makeMockHarness()
    const state = makeTeammateState()
    const deps = { harness, mailbox: mb, taskPlane: plane, team: 'alpha', name: 'bob' }

    await mb.writeToMailbox('alpha', 'bob', { from: 'lead', text: '请调研竞品', timestamp: 't1', type: 'message' })

    const result = await runTeammateTick(state, deps)
    expect(result.handledMessages).toBe(1)
    expect(queries).toHaveLength(1)
    expect(queries[0]!.message).toBe('请调研竞品')
    expect(queries[0]!.sessionId).toBe('s_sub')
    // 回复写回 lead 的 inbox
    const leadInbox = await mb.readMailbox('alpha', 'lead')
    expect(leadInbox[0]!.from).toBe('bob')
    expect(leadInbox[0]!.text).toContain('回复: 请调研竞品')
    // 已读
    expect(await mb.countUnread('alpha', 'bob')).toBe(0)
  })

  it('认领并执行 available 任务：claim → query → completed + 通知 leader', async () => {
    const dir = await makeDir('swarm-tick-')
    const mb = new TeammateMailbox(dir)
    const plane = new TaskListPlane(dir)
    const { harness, queries } = makeMockHarness()
    const state = makeTeammateState()
    const deps = { harness, mailbox: mb, taskPlane: plane, team: 'alpha', name: 'bob' }

    const task = await plane.create('alpha', { title: '写 README', description: '中文版' })
    const result = await runTeammateTick(state, deps)

    expect(result.claimedTask?.id).toBe(task.id)
    expect(result.finishedTask?.status).toBe('completed')
    expect(queries[0]!.message).toContain('写 README')
    const updated = await plane.get('alpha', task.id)
    expect(updated!.status).toBe('completed')
    expect(updated!.result).toContain('回复:')
    // leader 收到 task_notification
    const leaderInbox = await mb.readMailbox('alpha', 'lead')
    expect(leaderInbox[0]!.type).toBe('task_notification')
    expect(leaderInbox[0]!.replyTo).toBe(task.id)
  })

  it('任务执行失败 → 任务标记 failed + 通知 leader', async () => {
    const dir = await makeDir('swarm-tick-')
    const mb = new TeammateMailbox(dir)
    const plane = new TaskListPlane(dir)
    const agent = { query: async () => { throw new Error('boom') } }
    const session = { create: async () => ({ id: 's' }) }
    const state = makeTeammateState()
    const deps = { harness: { agent, session } as any, mailbox: mb, taskPlane: plane, team: 'alpha', name: 'bob' }

    const task = await plane.create('alpha', { title: 'T' })
    const result = await runTeammateTick(state, deps)
    expect(result.finishedTask?.status).toBe('failed')
    expect(result.error).toContain('boom')
    const leaderInbox = await mb.readMailbox('alpha', 'lead')
    expect(leaderInbox[0]!.type).toBe('task_notification')
    expect(leaderInbox[0]!.text).toContain('失败')
  })

  it('shutdown 消息：状态置 shutdown 并中止', async () => {
    const dir = await makeDir('swarm-tick-')
    const mb = new TeammateMailbox(dir)
    const plane = new TaskListPlane(dir)
    const { harness } = makeMockHarness()
    const state = makeTeammateState()
    const deps = { harness, mailbox: mb, taskPlane: plane, team: 'alpha', name: 'bob' }

    await mb.writeToMailbox('alpha', 'bob', { from: 'lead', text: '收工', timestamp: 't1', type: 'shutdown' })
    await runTeammateTick(state, deps)
    expect(state.status).toBe('shutdown')
    expect(state.abortController.signal.aborted).toBe(true)
  })
})

describe('spawnInProcessTeammate + startTeammateLoop', () => {
  it('spawnInProcessTeammate：加入团队 + 注册 + 初始 prompt 立即执行', async () => {
    const dir = await makeDir('swarm-spawn-')
    const mgr = new TeamManager(dir)
    const { harness, queries } = makeMockHarness()
    const registry = new TeammateRegistry()

    const state = await spawnInProcessTeammate({
      harness, teamManager: mgr, team: 'Alpha', name: 'bob', agentId: 'researcher', prompt: '初始任务', registry,
    })

    expect(state.agentId).toBe('bob@alpha')
    expect(registry.get('bob@alpha')).toBeDefined()
    expect(state.sessionId).toBeDefined()
    // 团队已建（lead=researcher）+ bob 入队
    const team = await mgr.get('alpha')
    expect(team!.members.map((m) => m.name)).toEqual(['lead', 'bob'])
    // 初始 prompt 执行了一轮
    expect(queries).toHaveLength(1)
    expect(queries[0]!.message).toBe('初始任务')
  })

  it('startTeammateLoop：自动认领任务并完成，stop 停止', async () => {
    const dir = await makeDir('swarm-loop-')
    const mb = new TeammateMailbox(dir)
    const plane = new TaskListPlane(dir)
    const { harness } = makeMockHarness()
    const state = makeTeammateState()
    const deps = { harness, mailbox: mb, taskPlane: plane, team: 'alpha', name: 'bob' }

    await plane.create('alpha', { title: '任务A' })
    const loop = startTeammateLoop(state, deps, { intervalMs: 20 })

    // 等待循环认领并完成
    for (let i = 0; i < 50; i++) {
      const t = await plane.get('alpha', (await plane.list('alpha'))[0]!.id)
      if (t?.status === 'completed') break
      await new Promise((r) => setTimeout(r, 20))
    }
    const task = (await plane.list('alpha'))[0]!
    expect(task.status).toBe('completed')
    expect(task.claimedBy).toBe('bob')

    await loop.stop()
    expect(loop.running).toBe(false)
    expect(state.status).toBe('shutdown')
  })
})

// ===== 工具 =====

describe('Swarm 工具', () => {
  it('team_create：创建团队（lead = 当前 agent），team_status 读取', async () => {
    const dir = await makeDir('swarm-tool-')
    const mgr = new TeamManager(dir)
    const plane = new TaskListPlane(dir)
    const createTool = createTeamCreateTool(() => mgr)
    const statusTool = createTeamStatusTool(() => mgr, () => plane)

    const res = await createTool.call({ name: 'Alpha', description: '调研' }, makeCtx())
    expect(res.ok).toBe(true)
    expect(res.output!.name).toBe('alpha')
    expect(res.output!.leadAgentId).toBe('coordinator')

    const st = await statusTool.call({ name: 'Alpha' }, makeCtx())
    expect(st.ok).toBe(true)
    expect(st.output!.members.map((m) => m.name)).toEqual(['lead'])
    expect(st.output!.tasks).toEqual([])
  })

  it('team_delete：删除团队', async () => {
    const dir = await makeDir('swarm-tool-')
    const mgr = new TeamManager(dir)
    const del = createTeamDeleteTool(() => mgr)
    await mgr.create({ name: 'Alpha', leadAgentId: 'c', leadSessionId: 's' })
    const res = await del.call({ name: 'alpha' }, makeCtx())
    expect(res.ok).toBe(true)
    expect(await mgr.get('alpha')).toBeUndefined()
  })

  it('send_teammate_message：写入收件人 mailbox', async () => {
    const dir = await makeDir('swarm-tool-')
    const mb = new TeammateMailbox(dir)
    const tool = createSendTeammateMessageTool(() => mb)
    const res = await tool.call({ team: 'alpha', to: 'bob', message: 'hi bob', summary: '打招呼' }, makeCtx())
    expect(res.ok).toBe(true)
    expect(res.output!.deliveredTo).toBe('bob')
    const unread = await mb.readUnreadMessages('alpha', 'bob')
    expect(unread[0]).toMatchObject({ from: 'coordinator', text: 'hi bob', summary: '打招呼' })
  })

  it('task_create → task_claim → task_stop 工具链路', async () => {
    const dir = await makeDir('swarm-tool-')
    const plane = new TaskListPlane(dir)
    const create = createTaskCreateTool(() => plane)
    const list = createTaskListTool(() => plane)
    const claim = createTaskClaimTool(() => plane)
    const stop = createTaskStopTool(() => plane)

    const created = await create.call({ team: 'alpha', title: '写 README' }, makeCtx())
    expect(created.ok).toBe(true)
    const taskId = created.output!.id

    const lst = await list.call({ team: 'alpha' }, makeCtx())
    expect(lst.ok).toBe(true)
    expect((lst.output! as SwarmTask[])).toHaveLength(1)

    const claimed = await claim.call({ team: 'alpha', taskId }, makeCtx())
    expect(claimed.ok).toBe(true)
    expect(claimed.output!.status).toBe('in_progress')
    expect(claimed.output!.claimedBy).toBe('coordinator')

    const stopped = await stop.call({ team: 'alpha', taskId }, makeCtx())
    expect(stopped.ok).toBe(true)
    expect(stopped.output!.status).toBe('cancelled')
  })

  it('team_create 重复创建返回 TEAM_CREATE_FAILED（不崩溃）', async () => {
    const dir = await makeDir('swarm-tool-')
    const mgr = new TeamManager(dir)
    await mgr.create({ name: 'Alpha', leadAgentId: 'c', leadSessionId: 's' })
    const tool = createTeamCreateTool(() => mgr)
    const res = await tool.call({ name: 'Alpha' }, makeCtx())
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('TEAM_CREATE_FAILED')
  })
})

// ===== 插件 =====

describe('createSwarmPlugin', () => {
  it('tool.pool.assemble 注入全部 swarm 工具', async () => {
    const plugin = createSwarmPlugin({ teamsDir: await makeDir('swarm-plugin-') })
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    const pool: any = { added: [], add: (t: any) => { pool.added.push(t.id) } }
    await hooks['tool.pool.assemble']({ agentId: 'any' }, pool)
    const ids = (pool.added as string[]).sort()
    expect(ids).toEqual([
      'send_teammate_message',
      'task_claim',
      'task_create',
      'task_list',
      'task_stop',
      'task_update',
      'team_create',
      'team_delete',
      'team_status',
    ])
  })
})
