import { describe, it, expect } from 'bun:test'
import {
  CoordinatorBarrierTracker,
  CoordinatorEvents,
  COORDINATOR_SYSTEM_PROMPT,
  createCoordinatorPlugin,
  createSendMessageTool,
  FileWriteArbiter,
  type SendMessageInput,
} from './index'
import { createBus } from '@harness/bus'
import { SubagentEvents } from '@harness/subagent'
import type { AgentDefinition } from '@harness/agent'
import type { AgentRuntime, AgentStreamEvent } from '@harness/core'
import type { SessionManager, Session, Message } from '@harness/session'
import type { ToolContext, ToolResult } from '@harness/tool'

// ===== Mock helper =====

function makeMessage(role: 'user' | 'assistant', text: string): Message {
  return {
    id: `m_${Math.random().toString(36).slice(2, 7)}`,
    role,
    parts: [{ type: 'text', text }],
    createdAt: Date.now(),
  }
}

function createMockAgentRuntime(agents: AgentDefinition[], queryImpl?: (input: { sessionId: string; agentId?: string; message: string }) => Promise<Message>): AgentRuntime {
  const agentMap = new Map(agents.map((a) => [a.id, a]))
  return {
    register: (def: AgentDefinition) => { agentMap.set(def.id, def) },
    get: (id: string) => agentMap.get(id),
    list: () => Array.from(agentMap.values()),
    query: queryImpl ?? (async () => makeMessage('assistant', 'mock response')),
    queryStream: async function* (input: { sessionId: string; agentId?: string; message: string }) {
      const msg = queryImpl ? await queryImpl(input) : makeMessage('assistant', 'mock response')
      yield { type: 'done', message: msg }
    },
  }
}

function createMockSessionManager(sessions: Map<string, Session>): SessionManager {
  return {
    create: async (options?: { title?: string; parentId?: string }) => {
      const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const session: Session = { id, title: options?.title ?? 'session', messages: [], createdAt: Date.now(), updatedAt: Date.now(), parentId: options?.parentId }
      sessions.set(id, session)
      return session
    },
    get: async (id: string) => sessions.get(id),
    list: async () => Array.from(sessions.values()),
    search: async () => [],
    prompt: async () => makeMessage('assistant', ''),
    promptStream: async function* () { /* noop */ },
    updateMessage: async () => {},
    updatePart: async () => {},
    addMessage: async (id: string, msg: Message) => {
      const s = sessions.get(id)
      if (s) s.messages.push(msg)
    },
    deleteMessage: async () => {},
    enqueueNotification: () => {},
    drainNotifications: () => [],
    compact: async () => {},
    compactIfNeeded: async () => false,
    getCompactionInfo: async () => ({}),
    estimateTokens: async () => 0,
    exportMarkdown: async () => '',
  } as unknown as SessionManager
}

function makeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's_parent',
    agentId: 'coordinator',
    messageId: 'm1',
    toolUseId: 't1',
    signal: new AbortController().signal,
    variables: {},
    cwd: '/tmp',
    ...overrides,
  } as unknown as ToolContext
}

const coordinatorAgent: AgentDefinition = {
  id: 'coordinator',
  name: 'Coordinator',
  description: '调度 Agent',
  mode: 'coordinator',
  tools: ['subagent', 'send_message'],
  permission: { '*': 'allow' },
  promptFragments: ['你是调度 Agent'],
}

const workerAgent: AgentDefinition = {
  id: 'researcher',
  name: 'Researcher',
  description: '调研 Agent',
  mode: 'subagent',
  tools: ['read_file'],
  permission: { '*': 'allow' },
  promptFragments: ['你是调研 Agent'],
}

// ===== CoordinatorBarrierTracker 单元测试 =====

describe('CoordinatorBarrierTracker', () => {
  it('单任务：启动 → 完成 → 触发 barrier 完成', () => {
    const tracker = new CoordinatorBarrierTracker()
    const fired: Array<[string, string[]]> = []
    tracker.onBarrierCompleted((sessionId, taskIds) => fired.push([sessionId, taskIds]))

    tracker.onWorkerStarted({ taskId: 'task-1', agentId: 'researcher', subSessionId: 's_sub', parentSessionId: 's_parent' })
    expect(tracker.activeCount('s_parent')).toBe(1)
    expect(fired).toHaveLength(0)

    tracker.onWorkerFinished({ taskId: 'task-1', parentSessionId: 's_parent', status: 'completed' })
    expect(tracker.activeCount('s_parent')).toBe(0)
    expect(fired).toHaveLength(1)
    expect(fired[0][0]).toBe('s_parent')
    expect(fired[0][1]).toEqual(['task-1'])
  })

  it('多任务：全部完成才触发 barrier，任务列表包含全部 taskId', () => {
    const tracker = new CoordinatorBarrierTracker()
    const fired: Array<[string, string[]]> = []
    tracker.onBarrierCompleted((sessionId, taskIds) => fired.push([sessionId, taskIds]))

    for (const id of ['task-a', 'task-b', 'task-c']) {
      tracker.onWorkerStarted({ taskId: id, agentId: 'researcher', subSessionId: `s_${id}`, parentSessionId: 's_parent' })
    }
    // 只完成 2 个 → 不触发
    tracker.onWorkerFinished({ taskId: 'task-a', parentSessionId: 's_parent', status: 'completed' })
    tracker.onWorkerFinished({ taskId: 'task-b', parentSessionId: 's_parent', status: 'failed' })
    expect(fired).toHaveLength(0)

    tracker.onWorkerFinished({ taskId: 'task-c', parentSessionId: 's_parent', status: 'completed' })
    expect(fired).toHaveLength(1)
    expect(fired[0][1].sort()).toEqual(['task-a', 'task-b', 'task-c'])
  })

  it('跨 session 隔离：各自独立计数', () => {
    const tracker = new CoordinatorBarrierTracker()
    const fired: string[] = []
    tracker.onBarrierCompleted((sessionId) => fired.push(sessionId))

    tracker.onWorkerStarted({ taskId: 't1', agentId: 'r', subSessionId: 's1', parentSessionId: 'sA' })
    tracker.onWorkerStarted({ taskId: 't2', agentId: 'r', subSessionId: 's2', parentSessionId: 'sB' })
    tracker.onWorkerFinished({ taskId: 't1', parentSessionId: 'sA', status: 'completed' })
    expect(fired).toEqual(['sA'])
    expect(tracker.activeCount('sB')).toBe(1)
  })

  it('barrier 完成后新一轮任务启动 → 新 barrier', () => {
    const tracker = new CoordinatorBarrierTracker()
    const fired: string[][] = []
    tracker.onBarrierCompleted((_s, taskIds) => fired.push(taskIds))

    tracker.onWorkerStarted({ taskId: 't1', agentId: 'r', subSessionId: 's1', parentSessionId: 's_parent' })
    tracker.onWorkerFinished({ taskId: 't1', parentSessionId: 's_parent', status: 'completed' })
    // 第二轮
    tracker.onWorkerStarted({ taskId: 't2', agentId: 'r', subSessionId: 's2', parentSessionId: 's_parent' })
    tracker.onWorkerFinished({ taskId: 't2', parentSessionId: 's_parent', status: 'failed' })

    expect(fired).toEqual([['t1'], ['t2']])
  })

  it('getWorker 返回 worker 信息，状态随完成更新', () => {
    const tracker = new CoordinatorBarrierTracker()
    tracker.onWorkerStarted({ taskId: 't1', agentId: 'researcher', subSessionId: 's_sub', parentSessionId: 's_parent' })
    expect(tracker.getWorker('t1')).toMatchObject({ agentId: 'researcher', subSessionId: 's_sub', status: 'running' })
    tracker.onWorkerFinished({ taskId: 't1', parentSessionId: 's_parent', status: 'completed' })
    expect(tracker.getWorker('t1')!.status).toBe('completed')
    expect(tracker.getWorker('unknown')).toBeUndefined()
  })
})

// ===== FileWriteArbiter 单元测试（文件级写锁） =====

describe('FileWriteArbiter', () => {
  it('不同路径可并行持有（互不阻塞）', async () => {
    const arb = new FileWriteArbiter()
    await arb.acquireWrite('src/a.ts', { sessionId: 's1', toolUseId: 't1' })
    await arb.acquireWrite('docs/b.md', { sessionId: 's1', toolUseId: 't2' })
    await arb.acquireWrite('src/c.ts', { sessionId: 's2', toolUseId: 't3' })
    expect(arb.lockedPaths().sort()).toEqual(['docs/b.md', 'src/a.ts', 'src/c.ts'])
  })

  it('同一路径跨 session 阻塞，release 后放行', async () => {
    const arb = new FileWriteArbiter()
    await arb.acquireWrite('src/a.ts', { sessionId: 's1', toolUseId: 't1' })

    let acquired = false
    const p2 = arb.acquireWrite('src/a.ts', { sessionId: 's2', toolUseId: 't2' }).then(() => { acquired = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(acquired).toBe(false) // 被 s1 持有 → 阻塞
    expect(arb.waitingCount('src/a.ts')).toBe(1)

    arb.releaseWrite('src/a.ts', 't1')
    await p2
    expect(acquired).toBe(true)
    expect(arb.waitingCount('src/a.ts')).toBe(0)
    expect(arb.lockedPaths()).toEqual(['src/a.ts']) // 现在由 t2 持有
  })

  it('同 session 重复获取直接放行（不阻塞自身）', async () => {
    const arb = new FileWriteArbiter()
    await arb.acquireWrite('src/a.ts', { sessionId: 's1', toolUseId: 't1' })
    await arb.acquireWrite('src/a.ts', { sessionId: 's1', toolUseId: 't2' }) // 同 session 串行，直接过
    expect(arb.lockedPaths()).toEqual(['src/a.ts'])
    // t1 释放仍有效（holder 未被 t2 覆盖）
    arb.releaseWrite('src/a.ts', 't1')
    expect(arb.lockedPaths()).toEqual([])
  })

  it('多等待者 FIFO：释放一个后按顺序放行', async () => {
    const arb = new FileWriteArbiter()
    await arb.acquireWrite('src/a.ts', { sessionId: 's1', toolUseId: 't1' })

    const order: string[] = []
    const pb = arb.acquireWrite('src/a.ts', { sessionId: 's2', toolUseId: 't2' }).then(() => { order.push('b') })
    const pc = arb.acquireWrite('src/a.ts', { sessionId: 's3', toolUseId: 't3' }).then(() => { order.push('c') })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([])

    arb.releaseWrite('src/a.ts', 't1') // 唤醒 b
    await pb
    expect(order).toEqual(['b'])

    arb.releaseWrite('src/a.ts', 't2') // 唤醒 c
    await pc
    expect(order).toEqual(['b', 'c'])
  })

  it('release 幂等：释放未持有/非持有者释放不抛错', () => {
    const arb = new FileWriteArbiter()
    expect(() => arb.releaseWrite('ghost.ts', 't0')).not.toThrow()
    expect(arb.lockedPaths()).toEqual([])
  })

  it('尾部斜杠归一化：同一路径不同写法视为同一锁', async () => {
    const arb = new FileWriteArbiter()
    await arb.acquireWrite('src/a.ts', { sessionId: 's1', toolUseId: 't1' })
    let acquired = false
    const p2 = arb.acquireWrite('src/a.ts/', { sessionId: 's2', toolUseId: 't2' }).then(() => { acquired = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(acquired).toBe(false)
    arb.releaseWrite('src/a.ts', 't1')
    await p2
    expect(acquired).toBe(true)
  })
})

// ===== send_message 工具测试 =====

describe('send_message 工具', () => {
  function setup(queryImpl?: (input: { sessionId: string; agentId?: string; message: string }) => Promise<Message>) {
    const tracker = new CoordinatorBarrierTracker()
    tracker.onWorkerStarted({ taskId: 'task-1', agentId: 'researcher', subSessionId: 's_sub', parentSessionId: 's_parent' })
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([workerAgent], queryImpl)
    const session = createMockSessionManager(sessions)
    const harness = { agent, session }
    const tool = createSendMessageTool(() => harness, () => tracker, 5000)
    return { tracker, tool, harness }
  }

  it('续跑已完成 worker：返回 worker 回复', async () => {
    const { tracker, tool } = setup(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return makeMessage('assistant', '补充调研结果')
    })
    tracker.onWorkerFinished({ taskId: 'task-1', parentSessionId: 's_parent', status: 'completed' })

    const res = await tool.call({ taskId: 'task-1', message: '再补充竞品 Z 的定价' }, makeToolContext())
    expect(res.ok).toBe(true)
    expect(res.output!.message).toBe('补充调研结果')
    expect(res.output!.messageCount).toBeGreaterThan(0)
  })

  it('未跟踪的 taskId 返回 TASK_NOT_FOUND', async () => {
    const { tool } = setup()
    const res = await tool.call({ taskId: 'task-unknown', message: 'hi' }, makeToolContext())
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('TASK_NOT_FOUND')
  })

  it('running 中的 worker 拒绝续跑（TASK_RUNNING）', async () => {
    const { tool } = setup() // 未调 onWorkerFinished → 仍 running
    const res = await tool.call({ taskId: 'task-1', message: 'hi' }, makeToolContext())
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('TASK_RUNNING')
  })

  it('mailbox 路由：team + to 单播到成员 inbox', async () => {
    const { tracker } = setup()
    const delivered: string[] = []
    const mailbox = { writeToMailbox: async (_team: string, recipient: string) => { delivered.push(recipient) } }
    const t = createSendMessageTool(() => ({ agent: {} as any, session: {} as any }), () => tracker, {
      mailbox, getTeamMembers: async () => ['lead', 'bob', 'carol'],
    })
    const res = await t.call({ team: 'alpha', to: 'bob', message: 'hi bob' }, makeToolContext())
    expect(res.ok).toBe(true)
    expect(delivered).toEqual(['bob'])
    expect(res.output!.deliveredTo).toEqual(['bob'])
    expect(res.output!.team).toBe('alpha')
  })

  it('mailbox 路由：to="*" 广播到团队所有成员', async () => {
    const { tracker } = setup()
    const delivered: string[] = []
    const mailbox = { writeToMailbox: async (_team: string, recipient: string, msg: any) => {
      delivered.push(`${recipient}:${msg.text}`)
    } }
    const t = createSendMessageTool(() => ({ agent: {} as any, session: {} as any }), () => tracker, {
      mailbox, getTeamMembers: async () => ['lead', 'bob', 'carol'],
    })
    const res = await t.call({ team: 'alpha', to: '*', message: '全员注意', description: '广播' }, makeToolContext())
    expect(res.ok).toBe(true)
    expect(delivered).toEqual(['lead:全员注意', 'bob:全员注意', 'carol:全员注意'])
    expect(res.output!.deliveredTo).toEqual(['lead', 'bob', 'carol'])
  })

  it('mailbox 路由未配置 → MAILBOX_NOT_CONFIGURED', async () => {
    const { tool } = setup() // 未注入 mailbox
    const res = await tool.call({ team: 'alpha', to: 'bob', message: 'hi' }, makeToolContext())
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('MAILBOX_NOT_CONFIGURED')
  })

  it('无目标（无 team+to 也无 taskId）→ INVALID_TARGET', async () => {
    const { tool } = setup()
    const res = await tool.call({ message: 'hi' }, makeToolContext())
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('INVALID_TARGET')
  })
})

// ===== 插件集成测试 =====

describe('createCoordinatorPlugin', () => {
  function setup(pluginOptions: Parameters<typeof createCoordinatorPlugin>[0] = {}) {
    const bus = createBus()
    const sessions = new Map<string, Session>()
    const agent = createMockAgentRuntime([coordinatorAgent, workerAgent], async () => makeMessage('assistant', 'ok'))
    const session = createMockSessionManager(sessions)
    const harness = { agent, session, bus }
    const plugin = createCoordinatorPlugin(pluginOptions)
    return { bus, harness, plugin, agent }
  }

  it('harness.start 后订阅 subagent 事件，barrier 集齐发布 coordinator.barrier.completed', async () => {
    const { bus, harness, plugin } = setup()
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    const barrierEvents: any[] = []
    const off = bus.subscribe(CoordinatorEvents.barrierCompleted, ({ payload }) => { barrierEvents.push(payload) })

    // 模拟 coordinator 派 3 个后台 worker
    await bus.publish(SubagentEvents.started, {
      agentId: 'researcher', agentName: 'Researcher', subSessionId: 's1',
      parentSessionId: 's_parent', parentAgentId: 'coordinator', parentMessageId: 'm1',
      toolUseId: 't1', prompt: '调研 A', isContinuation: false, startedAt: Date.now(),
      taskId: 'task-a', background: true,
    } as any)
    await bus.publish(SubagentEvents.started, {
      agentId: 'researcher', agentName: 'Researcher', subSessionId: 's2',
      parentSessionId: 's_parent', parentAgentId: 'coordinator', parentMessageId: 'm1',
      toolUseId: 't2', prompt: '调研 B', isContinuation: false, startedAt: Date.now(),
      taskId: 'task-b', background: true,
    } as any)
    await bus.publish(SubagentEvents.completed, {
      agentId: 'researcher', subSessionId: 's1', parentSessionId: 's_parent', toolUseId: 't1',
      replyPreview: 'A 结果', messageCount: 3, durationMs: 10, taskId: 'task-a', background: true,
    } as any)
    // 只完成一个 → 未触发
    expect(barrierEvents).toHaveLength(0)

    await bus.publish(SubagentEvents.completed, {
      agentId: 'researcher', subSessionId: 's2', parentSessionId: 's_parent', toolUseId: 't2',
      replyPreview: 'B 结果', messageCount: 3, durationMs: 10, taskId: 'task-b', background: true,
    } as any)
    // 全部完成 → 触发
    expect(barrierEvents).toHaveLength(1)
    expect(barrierEvents[0].sessionId).toBe('s_parent')
    expect(barrierEvents[0].taskIds.sort()).toEqual(['task-a', 'task-b'])
    off()
  })

  it('prompt.system.transform：coordinator 身份注入 orchestrator prompt', async () => {
    const { bus, harness, plugin } = setup()
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    const parts: string[] = []
    await hooks['prompt.system.transform']({ agentId: 'coordinator', sessionId: 's_parent' }, parts)
    expect(parts.join('')).toInclude('You are Harness Coordinator')

    const parts2: string[] = []
    await hooks['prompt.system.transform']({ agentId: 'researcher', sessionId: 's_parent' }, parts2)
    expect(parts2.join('')).not.toInclude('Harness Coordinator')
  })

  it('tool.pool.assemble：只给 coordinator 注入 send_message', async () => {
    const { bus, harness, plugin } = setup()
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    const pool: any = { add: (t: any) => { pool.added = [...(pool.added ?? []), t.id] } }
    await hooks['tool.pool.assemble']({ agentId: 'coordinator' }, pool)
    expect(pool.added).toContain('send_message')

    const pool2: any = { add: (t: any) => { pool2.added = [...(pool2.added ?? []), t.id] } }
    await hooks['tool.pool.assemble']({ agentId: 'researcher' }, pool2)
    expect(pool2.added ?? []).not.toContain('send_message')
  })

  it('forceAsync=true：拦截 subagent 工具调用强制 runInBackground', async () => {
    const { bus, harness, plugin } = setup({ forceAsync: true })
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    const preCtx = { tool: { id: 'subagent' }, input: { agentId: 'researcher', prompt: 'hi' }, ctx: {}, toolUseId: 't1' }
    let nextInput: any
    await hooks['tool.pre.execute'](preCtx, (modified: any) => { nextInput = modified; return { ok: true } })
    expect(nextInput).toEqual({ agentId: 'researcher', prompt: 'hi', runInBackground: true })

    // 非 subagent 工具不改写（next() 无参 → core 语义保留原 input）
    const preCtx2 = { tool: { id: 'read_file' }, input: { path: '/x' }, ctx: {}, toolUseId: 't2' }
    await hooks['tool.pre.execute'](preCtx2, (modified: any) => { nextInput = modified ?? preCtx2.input; return { ok: true } })
    expect(nextInput).toEqual({ path: '/x' })
  })

  it('forceAsync=false（默认）：不改写 subagent 输入', async () => {
    const { bus, harness, plugin } = setup()
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    const preCtx = { tool: { id: 'subagent' }, input: { agentId: 'researcher', prompt: 'hi' }, ctx: {}, toolUseId: 't1' }
    let nextInput: any
    await hooks['tool.pre.execute'](preCtx, (modified: any) => { nextInput = modified ?? preCtx.input; return { ok: true } })
    expect(nextInput).toEqual({ agentId: 'researcher', prompt: 'hi' })
  })

  it('COORDINATOR_SYSTEM_PROMPT 包含四阶段与反模式', () => {
    expect(COORDINATOR_SYSTEM_PROMPT).toInclude('Research')
    expect(COORDINATOR_SYSTEM_PROMPT).toInclude('Synthesis')
    expect(COORDINATOR_SYSTEM_PROMPT).toInclude('Implementation')
    expect(COORDINATOR_SYSTEM_PROMPT).toInclude('Verification')
    expect(COORDINATOR_SYSTEM_PROMPT).toInclude('Don')
    expect(COORDINATOR_SYSTEM_PROMPT).toInclude('send_message')
    expect(COORDINATOR_SYSTEM_PROMPT).toInclude('<task-notification>')
  })

  it('文件级写锁：write_file 被其他 session 持有 → 阻塞到该写完成', async () => {
    const { bus, harness, plugin } = setup()
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    // session sA 写 src/a.ts，next 挂起模拟写操作进行中（锁持有 = 本次写调用）
    const pA = hooks['tool.pre.execute'](
      { tool: { id: 'write_file' }, input: { path: 'src/a.ts', content: 'x' }, toolUseId: 'tA', sessionId: 'sA' },
      () => new Promise((r) => setTimeout(r, 100)),
    )
    // session sB 写同一路径 → 阻塞
    let bDone = false
    const pB = hooks['tool.pre.execute'](
      { tool: { id: 'write_file' }, input: { path: 'src/a.ts', content: 'y' }, toolUseId: 'tB', sessionId: 'sB' },
      () => { bDone = true; return { ok: true } },
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(bDone).toBe(false)

    await pA // sA 写完成 → finally 释放锁
    await pB
    expect(bDone).toBe(true)
  })

  it('文件级写锁：不同路径的写操作并行不阻塞', async () => {
    const { bus, harness, plugin } = setup()
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    const pA = hooks['tool.pre.execute'](
      { tool: { id: 'write_file' }, input: { path: 'src/a.ts' }, toolUseId: 'tA', sessionId: 'sA' },
      () => new Promise((r) => setTimeout(r, 100)),
    )
    let bDone = false
    const pB = hooks['tool.pre.execute'](
      { tool: { id: 'write_file' }, input: { path: 'docs/b.md' }, toolUseId: 'tB', sessionId: 'sB' },
      () => { bDone = true; return { ok: true } },
    )
    await pB
    expect(bDone).toBe(true) // 不同路径不阻塞
    await pA
  })

  it('写工具完成后 finally 释放锁：顺序写同一路径不阻塞', async () => {
    const { bus, harness, plugin } = setup()
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    await hooks['tool.pre.execute'](
      { tool: { id: 'write_file' }, input: { path: 'src/a.ts' }, toolUseId: 'tA', sessionId: 'sA' },
      () => { return { ok: true } },
    )
    // sA 已完成（await 返回时锁已释放）→ sB 同路径直接放行
    let bDone = false
    const pB = hooks['tool.pre.execute'](
      { tool: { id: 'write_file' }, input: { path: 'src/a.ts' }, toolUseId: 'tB', sessionId: 'sB' },
      () => { bDone = true; return { ok: true } },
    )
    await pB
    expect(bDone).toBe(true)
  })

  it('非写工具不被拦截（subagent 派工不再做声明级仲裁）', async () => {
    const { bus, harness, plugin } = setup()
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    // 两个 subagent 调用即使带相同 targetFiles 也直接放行（不再派工级阻塞）
    const calls: string[] = []
    const next = () => { calls.push('called'); return { ok: true } }
    await hooks['tool.pre.execute'](
      { tool: { id: 'subagent' }, input: { agentId: 'researcher', prompt: 'A', targetFiles: ['src/a.ts'], runInBackground: true }, toolUseId: 'tA', sessionId: 'sA' },
      next,
    )
    let bDone = false
    const pB = hooks['tool.pre.execute'](
      { tool: { id: 'subagent' }, input: { agentId: 'researcher', prompt: 'B', targetFiles: ['src/a.ts'], runInBackground: true }, toolUseId: 'tB', sessionId: 'sB' },
      () => { bDone = true; return { ok: true } },
    )
    await pB
    expect(bDone).toBe(true)
    expect(calls).toEqual(['called'])

    // read_file（有 path 但非写工具）不被拦截
    let readDone = false
    await hooks['tool.pre.execute'](
      { tool: { id: 'read_file' }, input: { path: 'src/a.ts' }, toolUseId: 'tR', sessionId: 'sC' },
      () => { readDone = true; return { ok: true } },
    )
    expect(readDone).toBe(true)
  })

  it('serializeWrites=false：写工具不做文件级互斥', async () => {
    const { bus, harness, plugin } = setup({ serializeWrites: false })
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    // sA 挂起写 src/a.ts，sB 同路径 → 直接放行（不等待）
    const pA = hooks['tool.pre.execute'](
      { tool: { id: 'write_file' }, input: { path: 'src/a.ts' }, toolUseId: 'tA', sessionId: 'sA' },
      () => new Promise((r) => setTimeout(r, 100)),
    )
    let bDone = false
    const pB = hooks['tool.pre.execute'](
      { tool: { id: 'write_file' }, input: { path: 'src/a.ts' }, toolUseId: 'tB', sessionId: 'sB' },
      () => { bDone = true; return { ok: true } },
    )
    await pB
    expect(bDone).toBe(true)
    await pA
  })
})
