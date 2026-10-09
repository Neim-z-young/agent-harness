/**
 * `AgentExecutor` 实现：把 harness 的流式会话翻译成 A2A 任务生命周期。
 *
 * ## 职责边界（plan §3.2）
 * 只做翻译与装配：**不内置业务决策、不绕过权限、不直接调工具**。全部能力经 `@harness/host`
 * 的既有公共面进入（`host.harness.session.promptStream` / `host.sessionStore` / …）。
 *
 * ## 权限桥：`AsyncLocalStorage` 是这里唯一不串话的解法
 * 权限 `ask()` 发生在 `promptStream` 生成器**内部**，而它只认得 `toolKey` / `patterns` ——
 * 不知道自己是哪个 task、更不知道往哪条 bus 上发 `INPUT_REQUIRED`。用模块级可变变量记
 * "当前 task"在并发任务下必然串话（两条生成器的 await 交错）。`AsyncLocalStorage` 按
 * **异步调用链**隔离，实测跨 `await` 保持且并发不串话，是本场景的标准工具。
 *
 * ## 模式 A（spike 实测，1.3.0）
 * 在 `INPUT_REQUIRED` 之后**不返回**（`await` 答复），挂起表只需 `taskId → resolver`，
 * **不必跨请求保存/恢复 generator**。被唤醒后补发 artifact + 终态 ⇒ 续接请求的调用方
 * 直接拿到最终 artifact。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server'
import { TaskState, type Message as A2aMessage } from '@a2a-js/sdk'
import type { Session } from '@harness/session'
import type { Host, PermissionAnswer, PermissionAsker, PermissionAskInput } from '@harness/host'
import {
  type A2aEmission,
  StreamAdapter,
  buildPermissionMetadata,
  buildPermissionQuestion,
  extractText,
  messageOf,
  parsePermissionAnswer,
  taskStatus,
  textPart,
} from './mapping'
import { DEFAULT_SUSPEND_TTL_MS, SuspendTable, type PendingAsk } from './suspend'

/** 结构化日志出口（默认丢弃；CLI/server 接到 stderr 或服务日志） */
export interface A2aLogger {
  info?(msg: string, meta?: unknown): void
  warn?(msg: string, meta?: unknown): void
}

/** 任务上下文的 ALS 载体 —— `ask()` 据此定位 taskId / contextId / bus */
interface TaskContext {
  taskId: string
  contextId: string
  bus: ExecutionEventBus
  running: RunningTask
}

interface RunningTask {
  taskId: string
  contextId: string
  controller: AbortController
  /** 收到 `CancelTask` */
  canceled: boolean
  /** 挂起超时过（`INPUT_REQUIRED` 无人答复） */
  expired: boolean
  /** `ensureSession` 解出的会话 id（= contextId） */
  sessionId?: string
}

export interface HarnessAgentExecutorOptions {
  /**
   * 取 `Host` 的**延迟**引用。
   *
   * 存在的理由是一个真实的循环依赖：`createHost({ asker })` 需要本 executor 的 asker，
   * 而本 executor 需要 host —— 用 getter 让"先建 executor、再建 host、最后回填"这条
   * 唯一可行的装配顺序显式化，而不是靠 `as any` 造一个半成品 host 传进来。
   */
  getHost: () => Host
  /** 挂起表（不传则新建一个；传入时 `onExpire` 由本 executor 接管） */
  suspendTable?: SuspendTable
  /** 挂起超时（毫秒），仅在不传 `suspendTable` 时生效。默认 5 分钟。 */
  suspendTtlMs?: number
  /** 挂起超时后的终态：`failed`（默认，保留已完成部分）| `canceled`（plan §10.5） */
  timeoutState?: 'failed' | 'canceled'
  /** 单轮最大步数（透传 `promptStream`；不传用引擎默认） */
  maxSteps?: number
  /** artifact 分块阈值（透传 `StreamAdapter`） */
  chunkChars?: number
  logger?: A2aLogger
}

/** harness 侧异常 → A2A 失败码（**对外只给码与安全文案，不给堆栈**，plan §3.3） */
const FAILED_CODE = 'EXECUTION_FAILED'
/** 挂起超时（`INPUT_REQUIRED` 无人答复） */
const TIMEOUT_CODE = 'INPUT_REQUIRED_TIMEOUT'
/** 答复无法识别 */
const BAD_ANSWER_CODE = 'UNRECOGNIZED_ANSWER'

function safeMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // 截断并剥掉换行 —— 堆栈内容不外出（远程调用方不该看到内部路径与实现细节）
  return msg.split('\n')[0]!.slice(0, 300)
}

export class HarnessAgentExecutor implements AgentExecutor {
  private readonly als = new AsyncLocalStorage<TaskContext>()
  private readonly running = new Map<string, RunningTask>()
  private readonly suspendTable: SuspendTable
  private readonly timeoutState: 'failed' | 'canceled'
  private readonly maxSteps: number | undefined
  private readonly chunkChars: number | undefined
  private readonly logger: A2aLogger | undefined

  constructor(private readonly opts: HarnessAgentExecutorOptions) {
    this.timeoutState = opts.timeoutState ?? 'failed'
    this.maxSteps = opts.maxSteps
    this.chunkChars = opts.chunkChars
    this.logger = opts.logger
    this.suspendTable =
      opts.suspendTable ??
      new SuspendTable({
        ttlMs: opts.suspendTtlMs ?? DEFAULT_SUSPEND_TTL_MS,
        onExpire: (p) => this.markExpired(p),
      })
    this.asker = this.makeAsker()
  }

  /** 交给 `createHost({ asker })` 的权限询问接缝 */
  readonly asker: PermissionAsker

  /** 挂起表（server 用它做自检 / 释放） */
  get suspend(): SuspendTable {
    return this.suspendTable
  }

  // ======================================================================
  // AgentExecutor
  // ======================================================================

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const taskId = ctx.taskId
    const contextId = ctx.contextId
    const text = extractText(ctx.userMessage)
    const prevState = ctx.task?.status?.state

    // ---- 续接轮：上一轮停在 INPUT_REQUIRED，这条消息就是答复（模式 A）----
    if (prevState === TaskState.TASK_STATE_INPUT_REQUIRED) {
      // ★ 必须先补发一次任务快照。原因：SDK 的 `ResultManager` 要求**每个响应的首事件
      // 是 `task` / `message`**，而续接轮真正产出事件的是**第一轮那次 in-flight 的生成器**
      // —— 它挂在**旧的 bus** 上（见下面 `makeAsker` 的 ALS 说明）。新 bus 若一个事件都不发，
      // 跨 bus 流进这条响应的第一个 `statusUpdate` 就会被判
      // "Received statusUpdate before initial 'Message'/'Task' event"（-32004）：
      // 整条续接请求被拒、任务**永远停在 INPUT_REQUIRED**，而它仍算"活跃任务"
      // ⇒ 该 `contextId` 之后的**每一条**消息都被 `ConcurrentTaskError` 拒（会话卡死）。
      //
      // 为什么单测没抓到：非流式 `SendMessage` 恰好绕过这一步（直接取终态快照），
      // 而既有用例全走 `send()`；走 `SendStreamingMessage` 的 `streamSend()` 从没测过续接轮。
      if (ctx.task) bus.publish(AgentEvent.task(ctx.task))
      this.resume(taskId, contextId, text, bus)
      return
    }

    // ---- 新任务 ----
    const running: RunningTask = {
      taskId,
      contextId,
      controller: new AbortController(),
      canceled: false,
      expired: false,
    }
    this.running.set(taskId, running)

    // 首个事件必须是 task（SDK 的 ResultManager 用它建立任务记录）
    bus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: taskStatus(TaskState.TASK_STATE_SUBMITTED),
        artifacts: [],
        history: [],
        metadata: undefined,
      }),
    )
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: taskStatus(TaskState.TASK_STATE_WORKING),
        metadata: undefined,
      }),
    )

    const adapter = new StreamAdapter(taskId, contextId, this.chunkChars)
    let aborted = false
    try {
      await this.als.run({ taskId, contextId, bus, running }, async () => {
        const session = await this.ensureSession(contextId)
        running.sessionId = session.id
        const host = this.opts.getHost()
        for await (const ev of host.harness.session.promptStream(
          session.id,
          text,
          this.maxSteps,
          running.controller.signal,
        )) {
          for (const em of adapter.push(ev)) this.emit(bus, em)
          // `aborted` 只出现在 done / turn_end（见 AgentStreamEvent.aborted 语义）
          if (ev.aborted) aborted = true
        }
        // 轮末落盘。**不能省**：`host.sendStream()` 同样是"循环后 flush"（`host.ts`），
        // 而这里直连引擎层 `session.promptStream`，绕过了那一步 —— 少了它 A2A 会话
        // **从不落盘**（只剩 `<contextId>.telemetry.jsonl`），后果是 `ensureSession` 的
        // 第二级回退 `sessionStore.load(contextId)`（断线重连）**永远读不到东西**：
        // 侧车一重启，同一个 contextId 拿到的是全新空会话，对话静默清空。
        // 另外 `flushDirtySessions` 是"只存有变化的会话"，含本轮主会话与期间产生的子会话。
        await host.flushDirtySessions()
      })
      const { state, metadata } = this.finalize(running, aborted)
      const message = this.finalMessage(state, running)
      for (const em of adapter.finish(state, message, metadata)) this.emit(bus, em)
    } catch (err) {
      // 异常归一为 FAILED：结构化 code + 安全文案，**不泄露堆栈**（plan §3.3）
      this.log('warn', 'a2a: 任务执行失败', { taskId, message: safeMessage(err) })
      for (const em of adapter.finish(TaskState.TASK_STATE_FAILED, undefined, {
        code: FAILED_CODE,
        message: safeMessage(err),
      })) {
        this.emit(bus, em)
      }
    } finally {
      this.running.delete(taskId)
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const running = this.running.get(taskId)
    if (running) {
      running.canceled = true
      running.controller.abort()
    }
    // 正挂在 ask 上 ⇒ 以"取消"唤醒（answer 缺省 = deny），让生成器自然收尾并释放
    const wasSuspended = this.suspendTable.cancel(taskId)
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: running?.contextId ?? '',
        status: taskStatus(TaskState.TASK_STATE_CANCELED),
        metadata: wasSuspended ? { phase: 'cancel-while-suspended' } : undefined,
      }),
    )
  }

  // ======================================================================
  // 并发 / 自检
  // ======================================================================

  /**
   * 该 `contextId`（= sessionId）上是否已有活跃任务。
   *
   * 并发策略（plan §3.5 / §10.6，一期**直接拒绝**而非排队）：同一会话并行两条消息会让
   * 两个 loop 交错写同一会话 —— 必须显式拒绝并给结构化错误，不能默认并行。
   * 挂起中的任务**也算活跃**（它仍在 `running` 里，因为 executor 没返回）。
   */
  activeTaskFor(contextId: string, exceptTaskId?: string): string | undefined {
    for (const r of this.running.values()) {
      if (r.contextId === contextId && r.taskId !== exceptTaskId) return r.taskId
    }
    return undefined
  }

  /** 活跃任务数（自检） */
  get runningCount(): number {
    return this.running.size
  }

  /**
   * 该 `taskId` 是否仍在执行（**含挂起中**）。
   *
   * 消费方是 server 的事件总线结算策略（`settleByTaskId`）：续接请求的 executor
   * 不发任何事件就返回，SDK 因此观察到 `lastObservedState === undefined`，默认策略会
   * **立刻结束这条共享 bus** —— 而第一轮此刻仍在跑（它稍后要补发 artifact + 终态）。
   * 判据必须是"任务还在跑"，而不是"这条请求发了事件"。
   */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId)
  }

  /** 释放全部挂起与运行中的任务（关闭服务时用，避免进程无法退出） */
  shutdown(): void {
    this.suspendTable.clear()
    for (const r of this.running.values()) r.controller.abort()
    this.running.clear()
  }

  // ======================================================================
  // 内部
  // ======================================================================

  /** 续接：解析答复 → 唤醒第一轮。不可识别时再发一次 INPUT_REQUIRED 并说明原因。 */
  private resume(taskId: string, contextId: string, text: string, bus: ExecutionEventBus): void {
    const answer = parsePermissionAnswer(text)
    if (answer === undefined) {
      const pending = this.suspendTable.pending(taskId)
      this.publishInputRequired(bus, taskId, contextId, pending?.req ?? { toolKey: '', patterns: [] }, {
        error: BAD_ANSWER_CODE,
        received: text.slice(0, 200),
      })
      return
    }
    const woke = this.suspendTable.answer(taskId, answer as PermissionAnswer)
    if (!woke) {
      // 迟到 / 重复 / 已超时 ⇒ **安全忽略**（plan §3.4 要点 3）：不报错、不重复执行
      this.log('warn', 'a2a: 答复未命中挂起表（迟到/重复/已超时），已忽略', { taskId, answer })
    }
  }

  /** 权限询问接缝：经 ALS 定位 task → 登记挂起 → 先发 `INPUT_REQUIRED` 再等待 */
  private makeAsker(): PermissionAsker {
    return async (req, prompt) => {
      const ctx = this.als.getStore()
      if (!ctx) {
        // 不在 A2A 任务上下文里（例如装配期的 boot 会话）⇒ 按 deny 处理（fail-safe）
        this.log('warn', 'a2a: 权限询问发生在任务上下文之外，按 deny 处理', {
          toolKey: req.toolKey,
          summary: prompt?.summary,
        })
        return undefined
      }
      const res = await this.suspendTable.wait(ctx.taskId, ctx.contextId, req, (pending) => {
        this.publishInputRequired(ctx.bus, ctx.taskId, ctx.contextId, req, {
          expiresAt: pending.deadlineAt,
        })
      })
      return res.answer
    }
  }

  /** 发布 `INPUT_REQUIRED` + 结构化待决描述（客户端据此知道"该答什么"） */
  private publishInputRequired(
    bus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    req: PermissionAskInput,
    extra: Record<string, unknown>,
  ): void {
    const md = buildPermissionMetadata(req)
    const message = messageOf({
      role: 'agent',
      parts: [textPart(buildPermissionQuestion(req))],
      contextId,
      taskId,
      metadata: md,
    })
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: taskStatus(TaskState.TASK_STATE_INPUT_REQUIRED, message),
        metadata: { ...md, ...extra },
      }),
    )
  }

  private emit(bus: ExecutionEventBus, em: A2aEmission): void {
    if (em.kind === 'artifact') bus.publish(AgentEvent.artifactUpdate(em.event))
    else bus.publish(AgentEvent.statusUpdate(em.event))
  }

  /** 终态裁决：取消 > 超时 > 中断 > 正常完成（顺序即优先级） */
  private finalize(
    running: RunningTask,
    aborted: boolean,
  ): { state: TaskState; metadata?: Record<string, unknown> } {
    if (running.canceled) return { state: TaskState.TASK_STATE_CANCELED, metadata: { phase: 'canceled' } }
    if (running.expired) {
      const state =
        this.timeoutState === 'canceled' ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED
      return { state, metadata: { code: TIMEOUT_CODE, message: '等待授权答复超时' } }
    }
    if (aborted) return { state: TaskState.TASK_STATE_CANCELED, metadata: { phase: 'aborted' } }
    return { state: TaskState.TASK_STATE_COMPLETED }
  }

  private finalMessage(state: TaskState, running: RunningTask): A2aMessage | undefined {
    if (state === TaskState.TASK_STATE_COMPLETED) return undefined
    if (!running.expired && !running.canceled) return undefined
    const text =
      state === TaskState.TASK_STATE_CANCELED ? '任务已取消（保留已完成部分）' : '等待授权答复超时，任务未完成'
    return messageOf({ role: 'agent', parts: [textPart(text)], contextId: running.contextId, taskId: running.taskId })
  }

  private markExpired(pending: PendingAsk): void {
    const running = this.running.get(pending.taskId)
    if (running) running.expired = true
    this.log('warn', 'a2a: 权限挂起超时（无人答复）', { taskId: pending.taskId, toolKey: pending.req.toolKey })
  }

  /**
   * 解析会话：`contextId = sessionId`（plan §3.6）。
   *
   * 三级回退：内存中的活会话 → 落盘的持久化会话（断线重连）→ 新建（并把新 id 改成
   * `contextId`，否则下一轮按 `contextId` 就找不到了）。
   */
  private async ensureSession(contextId: string): Promise<Session> {
    const host = this.opts.getHost()
    if (contextId) {
      const live = await host.harness.session.get(contextId)
      if (live) return live
      // 第二级：读盘。**写盘方是 `execute()` 循环后那次 `flushDirtySessions()`** ——
      // 少一次它就永远走到第三级（新建），同一个 contextId 重启后拿全新空会话。
      const saved = await host.sessionStore.load(contextId).catch(() => undefined)
      if (saved) return host.restoreSession(saved)
    }
    const created = await host.harness.session.create({
      agentId: host.session.agentId,
      cwd: host.harness.cwd,
    })
    if (contextId && contextId !== created.id) {
      return host.harness.session.setId(created.id, contextId)
    }
    return created
  }

  private log(level: 'info' | 'warn', msg: string, meta?: unknown): void {
    if (!this.logger) return
    if (level === 'info') this.logger.info?.(msg, meta)
    else this.logger.warn?.(msg, meta)
  }
}
