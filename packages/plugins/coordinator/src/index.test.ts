import { describe, it, expect } from 'bun:test'
import {
  CoordinatorBarrierTracker,
  CoordinatorEvents,
  CoordinatorFileArbiter,
  COORDINATOR_SYSTEM_PROMPT,
  createCoordinatorPlugin,
  createSendMessageTool,
  pathsOverlap,
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

// ===== CoordinatorFileArbiter 单元测试（§9.4 写操作串行化） =====

describe('pathsOverlap', () => {
  it('相同路径重叠', () => {
    expect(pathsOverlap(['src/a.ts'], ['src/a.ts'])).toBe(true)
  })
  it('目录与子路径重叠', () => {
    expect(pathsOverlap(['src/'], ['src/a.ts'])).toBe(true)
    expect(pathsOverlap(['src/a.ts'], ['src/'])).toBe(true)
  })
  it('祖先目录与后代目录重叠', () => {
    expect(pathsOverlap(['src/'], ['src/features/hook.ts'])).toBe(true)
  })
  it('./ 前缀与尾部斜杠归一化后仍识别', () => {
    expect(pathsOverlap(['./src'], ['src//a.ts'])).toBe(true)
  })
  it('不相关路径不重叠', () => {
    expect(pathsOverlap(['src/a.ts'], ['docs/readme.md'])).toBe(false)
    expect(pathsOverlap(['src/a'], ['src-ab/b'])).toBe(false)
  })
  it('空文件集不重叠', () => {
    expect(pathsOverlap([], ['src/a.ts'])).toBe(false)
    expect(pathsOverlap(['src/a.ts'], [])).toBe(false)
  })
})

describe('CoordinatorFileArbiter', () => {
  it('无冲突立即 acquire 并持有声明', async () => {
    const arb = new CoordinatorFileArbiter()
    await arb.acquire('t1', ['src/a.ts'])
    await arb.acquire('t2', ['docs/'])
    expect(arb.claimed().sort()).toEqual(['t1', 't2'])
  })

  it('冲突阻塞，release 后放行', async () => {
    const arb = new CoordinatorFileArbiter()
    await arb.acquire('t1', ['src/'])
    expect(arb.claimed()).toEqual(['t1'])

    let released = false
    const p2 = arb.acquire('t2', ['src/a.ts']).then(() => { released = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(released).toBe(false) // t2 与 t1 冲突 → 阻塞
    expect(arb.waitingCount()).toBe(1)

    arb.release('t1')
    await p2
    expect(released).toBe(true)
    expect(arb.waitingCount()).toBe(0)
    expect(arb.claimed()).toEqual(['t2'])
  })

  it('多等待者 FIFO：释放一个后按顺序放行', async () => {
    const arb = new CoordinatorFileArbiter()
    await arb.acquire('a', ['src/'])

    const order: string[] = []
    const pb = arb.acquire('b', ['src/a.ts']).then(() => { order.push('b'); return 'b' })
    const pc = arb.acquire('c', ['src/a.ts']).then(() => { order.push('c'); return 'c' })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([])

    arb.release('a') // 唤醒 b（不再冲突），c 继续等
    await pb
    expect(order).toEqual(['b'])
    expect(arb.waitingCount()).toBe(1)

    arb.release('b')
    await pc
    expect(order).toEqual(['b', 'c'])
  })

  it('不同文件集可并行持有（互不阻塞）', async () => {
    const arb = new CoordinatorFileArbiter()
    await arb.acquire('a', ['src/'])
    await arb.acquire('b', ['docs/'])
    await arb.acquire('c', ['test/'])
    expect(arb.claimed().length).toBe(3)
  })

  it('release 幂等：释放未持有的 key 不抛错', () => {
    const arb = new CoordinatorFileArbiter()
    expect(() => arb.release('ghost')).not.toThrow()
    expect(arb.claimed()).toEqual([])
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

  it('serializeWrites：声明 targetFiles 的冲突派工延迟到前序 worker 完成（后台事件释放）', async () => {
    const { bus, harness, plugin } = setup()
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    const calls: string[] = []
    const next = (modified?: any) => { calls.push(modified?.prompt ?? '?'); return { ok: true } }

    // worker A：后台 + targetFiles=['src/a.ts'] → 立即放行并持有声明
    await hooks['tool.pre.execute'](
      { tool: { id: 'subagent' }, input: { agentId: 'researcher', prompt: 'A', targetFiles: ['src/a.ts'], runInBackground: true }, toolUseId: 'tA' },
      next,
    )

    // worker B：同文件集 → 应被阻塞
    let bDone = false
    const pB = hooks['tool.pre.execute'](
      { tool: { id: 'subagent' }, input: { agentId: 'researcher', prompt: 'B', targetFiles: ['src/a.ts'], runInBackground: true }, toolUseId: 'tB' },
      (modified?: any) => { calls.push(modified?.prompt ?? '?'); bDone = true; return { ok: true } },
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(bDone).toBe(false)
    expect(calls).toEqual(['A'])

    // worker A 完成 → 释放声明 → B 放行
    await bus.publish(SubagentEvents.completed, {
      agentId: 'researcher', subSessionId: 'sA', parentSessionId: 's_parent', toolUseId: 'tA',
      replyPreview: 'A done', messageCount: 1, durationMs: 1, taskId: 'task-a', background: true,
    } as any)
    await pB
    expect(bDone).toBe(true)
    expect(calls).toEqual(['A', 'B'])
  })

  it('serializeWrites：未声明 targetFiles 的调用不仲裁（直接放行）', async () => {
    const { bus, harness, plugin } = setup()
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    let nextCalled = false
    await hooks['tool.pre.execute'](
      { tool: { id: 'subagent' }, input: { agentId: 'researcher', prompt: 'no-files', runInBackground: true }, toolUseId: 'tX' },
      () => { nextCalled = true; return { ok: true } },
    )
    expect(nextCalled).toBe(true)
  })

  it('serializeWrites：同步（非后台）调用完成后立即释放声明', async () => {
    const { bus, harness, plugin } = setup()
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    // 同步 worker A：targetFiles 声明，完成后应立即释放（finally 分支）
    await hooks['tool.pre.execute'](
      { tool: { id: 'subagent' }, input: { agentId: 'researcher', prompt: 'A', targetFiles: ['src/a.ts'] }, toolUseId: 'tA' },
      () => { return { ok: true } },
    )
    // 同文件集同步 worker B：A 已释放 → 不再阻塞，直接放行
    let bDone = false
    const pB = hooks['tool.pre.execute'](
      { tool: { id: 'subagent' }, input: { agentId: 'researcher', prompt: 'B', targetFiles: ['src/a.ts'] }, toolUseId: 'tB' },
      () => { bDone = true; return { ok: true } },
    )
    await pB
    expect(bDone).toBe(true)
  })

  it('serializeWrites=false：冲突派工不延迟', async () => {
    const { bus, harness, plugin } = setup({ serializeWrites: false })
    const hooks: any = await plugin.install({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as any)
    await hooks['harness.start']({ harness })

    const calls: string[] = []
    const next = (modified?: any) => { calls.push(modified?.prompt ?? '?'); return { ok: true } }
    await hooks['tool.pre.execute'](
      { tool: { id: 'subagent' }, input: { agentId: 'researcher', prompt: 'A', targetFiles: ['src/a.ts'], runInBackground: true }, toolUseId: 'tA' },
      next,
    )
    let bDone = false
    const pB = hooks['tool.pre.execute'](
      { tool: { id: 'subagent' }, input: { agentId: 'researcher', prompt: 'B', targetFiles: ['src/a.ts'], runInBackground: true }, toolUseId: 'tB' },
      (modified?: any) => { calls.push(modified?.prompt ?? '?'); bDone = true; return { ok: true } },
    )
    await pB
    expect(bDone).toBe(true)
    expect(calls).toEqual(['A', 'B'])
  })
})
