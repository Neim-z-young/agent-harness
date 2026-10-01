/**
 * `HarnessAgentExecutor` 端到端：用**真实装配**（`HarnessHost` + mock provider + 自注入工具）
 * 跑通 A2A 的任务生命周期，而不是给 executor 喂假事件。
 *
 * 为什么必须走真实装配：本 executor 的难点全在**跨层交互**上 —— 权限 `ask()` 发生在
 * `promptStream` 生成器内部，靠 `AsyncLocalStorage` 定位 taskId 与 bus；挂起后生成器要
 * 能停在原地、被另一条 `execute` 唤醒后继续。用假事件测不到这些（它们正是 P0.5 spike
 * 里唯一没被覆盖、也最容易做错的部分）。
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DefaultExecutionEventBus,
  DefaultExecutionEventBusManager,
  RequestContext,
  ServerCallContext,
  type ExecutionEventBus,
} from '@a2a-js/sdk/server'
import {
  TaskState,
  type SendMessageRequest,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from '@a2a-js/sdk'
import { defineTool, type Hooks } from '@harness/core'
import { HarnessHost, type Host } from '@harness/host'
import type { MockProviderConfig } from '@harness/provider-mock'
import { HarnessAgentExecutor } from './executor'
import { messageOf, textPart } from './mapping'

// ========================================================================
// 夹具
// ========================================================================

/**
 * 注入一个只读 `echo` 工具（不碰真实文件系统 / shell）。
 *
 * ⚠️ **必须声明 `permission`**：权限询问不是"工具一执行就自动弹"，而是
 * `ToolPipeline.execute` 在**工具声明了 `permission` 且有 `checkPermission`** 时才
 * 构造 `PermissionRequest` 去问引擎（`packages/tool/src/index.ts:1330`）。
 * 不声明 ⇒ 整条权限链路（check → ask → asker → 挂起）根本不启动，
 * 于是"INPUT_REQUIRED 挂起/续接"这些用例全部静默退化成"任务直接 COMPLETED"。
 * 真实工具（write/bash 等）都声明了它 —— 这里照抄同一形状才能测到真实路径。
 */
function echoPlugin() {
  const tool = defineTool({
    id: 'echo',
    description: '回显 msg',
    inputSchema: {
      parse: (v: unknown) => v as { msg: string },
      safeParse: (v: unknown) => ({ success: true as const, data: v as { msg: string } }),
    },
    isReadOnly: () => true,
    // 权限键与 pattern 形状对齐真实工具：key 决定规则命中，patterns 是"问什么"。
    permission: { key: 'echo', extractPatterns: (input) => [input.msg] },
    async call(input: { msg: string }) {
      return { ok: true as const, output: { reply: `echo:${input.msg}` } }
    },
  })
  return {
    id: 'test-echo',
    version: '0.0.0',
    name: 'test-echo',
    async install(): Promise<Hooks> {
      return {
        'core.tool.pool.assemble'(_input: unknown, pool: unknown) {
          ;(pool as { add: (t: unknown) => void }).add(tool)
        },
      } as unknown as Hooks
    },
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

interface Pair {
  host: Host
  executor: HarnessAgentExecutor
  /** 让 mock 第一轮调用 echo 工具、第二轮给出文本 */
  dir: string
}

/**
 * 造一对 host + executor（模拟 CLI/server 的真实装配顺序：
 * 先建 executor 拿 asker，再 createHost 回填 host）。
 */
async function makePair(opts: {
  mock: MockProviderConfig
  permissionMode?: 'allow-all' | 'ask' | 'deny-all'
  suspendTtlMs?: number
  maxSteps?: number
}): Promise<Pair> {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-exec-'))
  dirs.push(dir)
  let host!: Host
  const executor = new HarnessAgentExecutor({
    getHost: () => host,
    suspendTtlMs: opts.suspendTtlMs ?? 5000,
    maxSteps: opts.maxSteps ?? 4,
    chunkChars: 1000, // 不切块，测试看单条最终 artifact 即可
  })
  host = new HarnessHost({
    cwd: dir,
    dataDir: join(dir, '.harness'),
    agentId: 'default',
    provider: 'mock',
    permissionMode: opts.permissionMode ?? 'ask',
    asker: executor.asker,
    mockProviderConfig: opts.mock,
    extraPlugins: [echoPlugin() as never],
    autoResume: false,
    backgroundPreload: false,
  })
  await host.boot()
  return { host, executor, dir }
}

/** 让 mock 第一轮调 echo、之后给文本 */
function toolThenText(toolText: string, finalText: string): MockProviderConfig {
  return {
    defaultResponse: finalText,
    responses: [
      {
        match: toolText,
        response: '',
        once: true,
        toolCalls: [{ toolUseId: 'tu1', toolId: 'echo', input: { msg: 'hi' } }],
      },
    ],
  }
}

function requestOf(text: string, contextId = '', taskId = ''): SendMessageRequest {
  return {
    tenant: '',
    message: messageOf({ role: 'user', parts: [textPart(text)], contextId, taskId }),
    configuration: undefined,
    metadata: undefined,
  }
}

function ctxOf(req: SendMessageRequest, taskId: string, contextId: string, task?: Task): RequestContext {
  return new RequestContext(req, taskId, contextId, new ServerCallContext({ requestedVersion: '1.0' }), task)
}

function collect(bus: ExecutionEventBus): any[] {
  const events: any[] = []
  bus.on('event', (e: any) => events.push(e))
  return events
}

const statuses = (events: any[]): unknown[] =>
  events.filter((e) => e.kind === 'statusUpdate').map((e) => e.data.status.state)
const artifacts = (events: any[]): TaskArtifactUpdateEvent[] =>
  events.filter((e) => e.kind === 'artifactUpdate').map((e) => e.data)

async function waitUntil(fn: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('waitUntil 超时')
}

/** 组装一个"停在 INPUT_REQUIRED"的 Task（模拟 SDK 在续接轮交给 executor 的那一份） */
function inputRequiredTask(taskId: string, contextId: string): Task {
  return {
    id: taskId,
    contextId,
    status: {
      state: TaskState.TASK_STATE_INPUT_REQUIRED,
      message: undefined,
      timestamp: new Date().toISOString(),
    },
    artifacts: [],
    history: [],
    metadata: undefined,
  }
}

// ========================================================================
// 正常路径
// ========================================================================

describe('HarnessAgentExecutor：正常完成', () => {
  it('首个事件是 task(SUBMITTED) → WORKING → artifact → COMPLETED', async () => {
    const { executor } = await makePair({ mock: { defaultResponse: '你好世界' } })
    const bus = new DefaultExecutionEventBus()
    const events = collect(bus)

    await executor.execute(ctxOf(requestOf('hi'), 't1', 'c1'), bus)

    expect(events[0]!.kind).toBe('task')
    // SUBMITTED 挂在 **task 事件本体**上（SDK 的 ResultManager 据此建任务记录），
    // 不是一条独立的 statusUpdate —— 所以 statuses() 的首条是 WORKING 而非 SUBMITTED。
    expect(events[0]!.data.status.state).toBe(TaskState.TASK_STATE_SUBMITTED)
    expect(statuses(events)[0]).toBe(TaskState.TASK_STATE_WORKING)
    expect(statuses(events).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED)

    const arts = artifacts(events)
    expect(arts).toHaveLength(1)
    expect(arts[0]!.lastChunk).toBe(true)
    expect(arts[0]!.append).toBe(false)
    expect((arts[0]!.artifact!.parts[0]!.content as any).value).toBe('你好世界')
  })

  it('工具调用走 status metadata 而不是 artifact 正文', async () => {
    const { executor } = await makePair({
      mock: toolThenText('go', '工具说 ok'),
      permissionMode: 'allow-all',
    })
    const bus = new DefaultExecutionEventBus()
    const events = collect(bus)

    await executor.execute(ctxOf(requestOf('go'), 't1', 'c1'), bus)

    const phases = events
      .filter((e) => e.kind === 'statusUpdate' && e.data.metadata?.phase)
      .map((e) => e.data.metadata.phase)
    expect(phases).toContain('tool-start')
    expect(phases).toContain('tool-result')
    const meta = events.find((e) => e.data?.metadata?.phase === 'tool-start')!.data.metadata
    expect(meta.tool).toBe('echo')
    // 正文只有模型最终文本
    const text = artifacts(events)
      .flatMap((a) => a.artifact!.parts)
      .map((p: any) => p.content?.value ?? '')
      .join('')
    expect(text).toBe('工具说 ok')
  })

  it('contextId 被用作 sessionId（复用同一持久化会话）', async () => {
    const { executor, host } = await makePair({ mock: { defaultResponse: 'x' } })
    const bus = new DefaultExecutionEventBus()
    await executor.execute(ctxOf(requestOf('hi'), 't1', 'ctx-abc'), bus)
    const sess = await host.harness.session.get('ctx-abc')
    expect(sess).toBeDefined()
    // 该会话里应有 user + assistant
    expect((sess!.messages ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

// ========================================================================
// 权限：INPUT_REQUIRED 挂起与续接（P1 核心机制）
// ========================================================================

describe('HarnessAgentExecutor：权限挂起与续接', () => {
  it('ask 点转 INPUT_REQUIRED（含结构化待决描述），答复后同一任务续接到 COMPLETED', async () => {
    const { executor } = await makePair({ mock: toolThenText('go', '工具说 ok'), permissionMode: 'ask' })

    // 用共享的 bus manager：模拟服务端"同一 taskId 拿到同一条 bus"
    const manager = new DefaultExecutionEventBusManager()
    const bus = manager.createOrGetByTaskId('t1')
    const events = collect(bus)

    // 第一轮：阻塞在 ask 上（execute 不返回）
    const first = executor.execute(ctxOf(requestOf('go'), 't1', 'c1'), bus)
    await waitUntil(() =>
      events.some(
        (e) => e.kind === 'statusUpdate' && e.data.status.state === TaskState.TASK_STATE_INPUT_REQUIRED,
      ),
    )
    const req = events.find(
      (e) => e.kind === 'statusUpdate' && e.data.status.state === TaskState.TASK_STATE_INPUT_REQUIRED,
    )!
    // 结构化待决描述：客户端据此知道"该答什么"
    expect(req.data.metadata.kind).toBe('permission-request')
    expect(req.data.metadata.tool).toBe('echo')
    expect(req.data.metadata.options).toContain('allow')
    expect(req.data.status.message.parts[0].content.value).toContain('需要授权')
    // 此刻任务确实挂着（并发判定要把它算作活跃）
    expect(executor.suspend.size).toBe(1)
    expect(executor.activeTaskFor('c1')).toBe('t1')

    // 第二轮：带同一 taskId 的答复 ⇒ executor 立即返回（不自己发事件）
    await executor.execute(
      ctxOf(requestOf('allow', 'c1', 't1'), 't1', 'c1', inputRequiredTask('t1', 'c1')),
      bus,
    )
    // 第二轮一条事件都不发
    expect(events.some((e) => e.data?.metadata?.phase === 'resume')).toBe(false)

    // 第一轮被唤醒并跑完
    await first
    expect(statuses(events).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED)
    const text = artifacts(events)
      .flatMap((a) => a.artifact!.parts)
      .map((p: any) => p.content?.value ?? '')
      .join('')
    expect(text).toBe('工具说 ok')
    expect(executor.suspend.size).toBe(0)
  })

  it('deny 答复 ⇒ 工具不执行，本轮仍以 COMPLETED 收尾（拒绝是正常业务结果，不是失败）', async () => {
    const { executor } = await makePair({ mock: toolThenText('go', '工具说 ok'), permissionMode: 'ask' })
    const manager = new DefaultExecutionEventBusManager()
    const bus = manager.createOrGetByTaskId('t2')
    const events = collect(bus)

    const first = executor.execute(ctxOf(requestOf('go'), 't2', 'c2'), bus)
    await waitUntil(() => executor.suspend.size === 1)
    await executor.execute(ctxOf(requestOf('deny', 'c2', 't2'), 't2', 'c2', inputRequiredTask('t2', 'c2')), bus)
    await first

    expect(statuses(events).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED)
    // 工具被拒 ⇒ 没有 tool-result 的成功路径（拒绝本身以失败 ToolResult 回喂模型）
    const rejected = events.find((e) => e.data?.metadata?.phase === 'tool-result')
    expect(rejected?.data.metadata.isError).toBe(true)
  })

  it('答复不可识别 ⇒ 再发一次 INPUT_REQUIRED 并说明原因（任务保持可重试）', async () => {
    const { executor } = await makePair({ mock: toolThenText('go', 'x'), permissionMode: 'ask' })
    const manager = new DefaultExecutionEventBusManager()
    const bus = manager.createOrGetByTaskId('t3')
    const events = collect(bus)

    const first = executor.execute(ctxOf(requestOf('go'), 't3', 'c3'), bus)
    await waitUntil(() => executor.suspend.size === 1)
    const before = events.length

    await executor.execute(
      ctxOf(requestOf('我不知道', 'c3', 't3'), 't3', 'c3', inputRequiredTask('t3', 'c3')),
      bus,
    )
    const added = events.slice(before)
    expect(added).toHaveLength(1)
    expect(added[0].data.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
    expect(added[0].data.metadata.error).toBe('UNRECOGNIZED_ANSWER')
    // 仍挂着（可重试）
    expect(executor.suspend.size).toBe(1)

    // 收尾：正常答复一次，避免测试结束后留悬挂任务
    await executor.execute(ctxOf(requestOf('deny', 'c3', 't3'), 't3', 'c3', inputRequiredTask('t3', 'c3')), bus)
    await first
  })

  it('重复 / 迟到的答复被安全忽略（不重复执行、不报错）', async () => {
    const { executor } = await makePair({ mock: toolThenText('go', 'x'), permissionMode: 'ask' })
    const manager = new DefaultExecutionEventBusManager()
    const bus = manager.createOrGetByTaskId('t4')
    const events = collect(bus)

    const first = executor.execute(ctxOf(requestOf('go'), 't4', 'c4'), bus)
    await waitUntil(() => executor.suspend.size === 1)
    await executor.execute(ctxOf(requestOf('allow', 'c4', 't4'), 't4', 'c4', inputRequiredTask('t4', 'c4')), bus)
    const countAfterAnswer = events.length

    // 迟到/重复答复：桶里已没有该 task ⇒ 安全忽略
    await executor.execute(
      ctxOf(requestOf('allow', 'c4', 't4'), 't4', 'c4', inputRequiredTask('t4', 'c4')),
      bus,
    )
    expect(events.length).toBe(countAfterAnswer)
    await first
  })
})

// ========================================================================
// 取消 / 超时 / 失败
// ========================================================================

describe('HarnessAgentExecutor：取消与超时', () => {
  it('CancelTask 把挂起中的任务转 CANCELED 并释放挂起表', async () => {
    const { executor } = await makePair({ mock: toolThenText('go', 'x'), permissionMode: 'ask' })
    const manager = new DefaultExecutionEventBusManager()
    const bus = manager.createOrGetByTaskId('t5')
    const events = collect(bus)

    const first = executor.execute(ctxOf(requestOf('go'), 't5', 'c5'), bus)
    await waitUntil(() => executor.suspend.size === 1)

    await executor.cancelTask('t5', bus)
    await first

    expect(executor.suspend.size).toBe(0)
    expect(statuses(events)).toContain(TaskState.TASK_STATE_CANCELED)
    expect(statuses(events).at(-1)).toBe(TaskState.TASK_STATE_CANCELED)
    // 取消后的终态只有一条 CANCELED，没有被随后的 COMPLETED 覆盖
    expect(statuses(events).filter((s) => s === TaskState.TASK_STATE_COMPLETED)).toHaveLength(0)
  })

  it('挂起超时（无人答复）⇒ FAILED + INPUT_REQUIRED_TIMEOUT，且释放挂起表', async () => {
    const { executor } = await makePair({
      mock: toolThenText('go', 'x'),
      permissionMode: 'ask',
      suspendTtlMs: 40,
    })
    const manager = new DefaultExecutionEventBusManager()
    const bus = manager.createOrGetByTaskId('t6')
    const events = collect(bus)

    await executor.execute(ctxOf(requestOf('go'), 't6', 'c6'), bus)

    expect(statuses(events).at(-1)).toBe(TaskState.TASK_STATE_FAILED)
    const final = events.filter((e) => e.kind === 'statusUpdate').at(-1)!
    expect(final.data.metadata.code).toBe('INPUT_REQUIRED_TIMEOUT')
    expect(executor.suspend.size).toBe(0)
  })

  it('executor 抛异常 ⇒ FAILED 且只给安全文案（不泄露堆栈）', async () => {
    // 用桩 host 造一条必然抛错的 promptStream（真实装配里很难自然触发）
    const boomHost = {
      harness: {
        cwd: '/tmp',
        session: {
          async get() {
            return { id: 's' }
          },
          async create() {
            return { id: 's' }
          },
          async setId(_o: string, n: string) {
            return { id: n }
          },
          async *promptStream() {
            throw new Error('内部炸了\n    at /secret/path/file.ts:42:7\n    at …')
          },
        },
      },
      sessionStore: { async load() { return undefined } },
      restoreSession: async (s: unknown) => s,
      session: { agentId: 'default' },
    } as unknown as Host

    const executor = new HarnessAgentExecutor({ getHost: () => boomHost })
    const bus = new DefaultExecutionEventBus()
    const events = collect(bus)
    await executor.execute(ctxOf(requestOf('hi'), 't9', 'c9'), bus)

    const final = events.filter((e) => e.kind === 'statusUpdate').at(-1)!
    expect(final.data.status.state).toBe(TaskState.TASK_STATE_FAILED)
    expect(final.data.metadata.code).toBe('EXECUTION_FAILED')
    expect(final.data.metadata.message).toBe('内部炸了')
    // 堆栈不外泄
    expect(final.data.metadata.message).not.toContain('at ')
    expect(JSON.stringify(events)).not.toContain('/secret/path')
  })
})

// ========================================================================
// 并发
// ========================================================================

describe('HarnessAgentExecutor：并发与自检', () => {
  it('activeTaskFor 能查到挂起中的任务（挂起也算活跃）', async () => {
    const { executor } = await makePair({ mock: toolThenText('go', 'x'), permissionMode: 'ask' })
    const manager = new DefaultExecutionEventBusManager()
    const bus = manager.createOrGetByTaskId('t7')
    const events = collect(bus)

    const first = executor.execute(ctxOf(requestOf('go'), 't7', 'c7'), bus)
    await waitUntil(() => executor.suspend.size === 1)
    expect(executor.activeTaskFor('c7')).toBe('t7')
    // 别的会话不受影响
    expect(executor.activeTaskFor('c-other')).toBeUndefined()
    // 自己可以被排除（用于"幂等回放"路径）
    expect(executor.activeTaskFor('c7', 't7')).toBeUndefined()

    await executor.cancelTask('t7', bus)
    await first
    expect(executor.activeTaskFor('c7')).toBeUndefined()
  })

  it('shutdown 释放全部挂起（避免进程无法退出）', async () => {
    const { executor } = await makePair({ mock: toolThenText('go', 'x'), permissionMode: 'ask' })
    const manager = new DefaultExecutionEventBusManager()
    const bus = manager.createOrGetByTaskId('t8')
    collect(bus)
    const first = executor.execute(ctxOf(requestOf('go'), 't8', 'c8'), bus)
    await waitUntil(() => executor.suspend.size === 1)

    executor.shutdown()
    await first
    expect(executor.suspend.size).toBe(0)
    expect(executor.runningCount).toBe(0)
  })
})
