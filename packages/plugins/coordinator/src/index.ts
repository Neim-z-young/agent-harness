/**
 * @harness/coordinator - Coordinator 插件
 *
 * 把主 Agent 变成 orchestrator（调度器）：自己不写实现，专司四阶段派工
 * （Research → Synthesis → Implementation → Verification）。
 *
 * 核心能力：
 * 1. **Coordinator 身份**：`AgentDefinition.mode === 'coordinator'` 的 Agent
 *    通过 prompt.system.transform 注入 Coordinator System Prompt（四阶段规则）。
 * 2. **Barrier 自动集齐**：跟踪该 session 派出的后台任务（subagent.started
 *    background=true），全部完成/失败后发布 `coordinator.barrier.completed`
 *    事件。外层（CLI REPL）订阅后注入 `<continue/>` 自动续轮，父 Agent 无需
 *    用户介入即可汇总结果继续派工（解决"多调研→等齐→自动汇总"场景）。
 * 3. **forceAsync**：插件选项或 `HARNESS_FORCE_ASYNC=true` 时，拦截 subagent
 *    工具调用强制 runInBackground=true（所有派工后台化）。
 * 4. **send_message 工具**：向已派出的 worker（taskId）发送续跑消息，延续其
 *    session 上下文，返回 worker 回复。给 mode=coordinator 的 Agent 使用。
 *
 * 边界（见架构文档 §9.3）：
 * - 插件只负责"检测 barrier 完成 + 发布事件"，不直接驱动 query；
 *   自动触发下一轮 query 由外层（CLI/SDK）消费事件实现。
 * - 写操作按文件集串行化调度列为后续增强。
 *
 * @example
 * import { createHarness } from '@harness/core'
 * import { createSubagentPlugin } from '@harness/subagent'
 * import { createCoordinatorPlugin } from '@harness/coordinator'
 *
 * const h = await createHarness({
 *   internalPlugins: [
 *     createSubagentPlugin({ subagents: [researcherAgent, coderAgent] }),
 *     createCoordinatorPlugin({ forceAsync: true }),
 *   ],
 *   agents: [coordinatorAgent], // mode: 'coordinator'
 * })
 */

import { defineTool, type Tool, type ToolResult, type Schema, type ToolContext } from '@harness/tool'
import type { AgentPlugin } from '@harness/plugin'
import type { AgentDefinition } from '@harness/agent'
import type { AgentRuntime, SessionManager } from '@harness/core'
import type { Message } from '@harness/session'
import { BusEvent, type Bus } from '@harness/bus'
import { SubagentEvents } from '@harness/subagent'

// ===== Coordinator Bus 事件 =====

export const CoordinatorEvents = {
  /**
   * Barrier 完成事件：某个 session 派出的后台任务全部完成/失败后发布。
   * 外层（CLI REPL / SDK）订阅此事件后应触发下一轮 query（注入 `<continue/>`）。
   */
  barrierCompleted: BusEvent.define<{
    /** 父 session ID（coordinator 所在会话） */
    sessionId: string
    /** 本轮 barrier 包含的任务 ID 列表 */
    taskIds: string[]
  }>('coordinator.barrier.completed'),
} as const

// ===== Coordinator System Prompt =====

/**
 * Coordinator System Prompt 片段（注入到 mode=coordinator 的 Agent）。
 * 参考 Claude Code `coordinatorMode.ts`：主线程身份改写为 orchestrator，
 * 显式分相 + 派工规则 + 反模式。
 */
export const COORDINATOR_SYSTEM_PROMPT = `You are Harness Coordinator, an AI assistant that orchestrates tasks across multiple workers.

## 职责
- 你负责调度，不亲自执行大段实现工作。通过 subagent 工具派出 worker（研究/实现/验证），综合结果，继续派工，对用户汇报。
- 规划要显式分相：Research（研究/找文件/理解）→ Synthesis（汇总设计）→ Implementation（分派实现）→ Verification（分派验证）。

## 派工规则
- 独立的子任务（不同领域/不同文件集）并行派出：使用 runInBackground: true 后台执行。系统会自动等待全部后台任务完成并自动续轮，无需用户介入、无需你 sleep/poll。
- 有依赖的任务串行：收到上游 worker 的完成通知后再派下游。
- 写操作任务按文件集错开，避免多个 worker 同时改同一批文件。
- 不要让一个 worker 去检查另一个 worker 的进度。

## 反模式（必须遵守）
- Don't race：派发后台任务后不要伪造或预测尚未到达的结果。
- Don't peek：不要主动读取 worker 的输出文件来查进度。

## 续轮
- 当系统注入 <task-notification>（worker 完成/失败）或 <continue/> 时：先汇总已到达的 worker 结果，再判断是否派发下一阶段任务。
- 若需要补充信息，可用 send_message 向已有 worker（taskId）续跑追问。
- 全部阶段完成时，向用户输出最终结果并停止，不要空转。`

// ===== Barrier Tracker =====

/** 单个 worker（后台任务）的跟踪信息 */
export interface CoordinatorWorker {
  /** 后台任务 ID */
  taskId: string
  /** 子 Agent ID */
  agentId: string
  /** 子 session ID（send_message 续跑目标） */
  subSessionId: string
  /** worker 状态 */
  status: 'running' | 'completed' | 'failed'
}

/**
 * Barrier 同步原语（纯逻辑，可独立测试）。
 *
 * 语义：一个 session 派出的后台任务视为一个"barrier 组"——
 * 首个任务启动时开始计数，全部完成/失败（计数归零）时触发 barrier 完成，
 * 携带该组任务 ID 列表。再次有任务启动则开启新一轮 barrier。
 */
export class CoordinatorBarrierTracker {
  /** sessionId → 当前运行中的后台任务数 */
  private readonly active = new Map<string, number>()
  /** sessionId → 本轮 barrier 的任务 ID 列表 */
  private readonly barrierTasks = new Map<string, string[]>()
  /** taskId → worker 信息 */
  private readonly workers = new Map<string, CoordinatorWorker>()
  /** barrier 完成监听器 */
  private readonly listeners = new Set<(sessionId: string, taskIds: string[]) => void>()

  /** 记录 worker 启动（subagent.started + background=true） */
  onWorkerStarted(input: { taskId: string; agentId: string; subSessionId: string; parentSessionId: string }): void {
    this.workers.set(input.taskId, {
      taskId: input.taskId,
      agentId: input.agentId,
      subSessionId: input.subSessionId,
      status: 'running',
    })
    const active = (this.active.get(input.parentSessionId) ?? 0) + 1
    this.active.set(input.parentSessionId, active)
    const list = this.barrierTasks.get(input.parentSessionId) ?? []
    if (!list.includes(input.taskId)) list.push(input.taskId)
    this.barrierTasks.set(input.parentSessionId, list)
  }

  /** 记录 worker 结束（subagent.completed/failed） */
  onWorkerFinished(input: { taskId: string; parentSessionId: string; status: 'completed' | 'failed' }): void {
    const w = this.workers.get(input.taskId)
    if (w) w.status = input.status

    const active = (this.active.get(input.parentSessionId) ?? 1) - 1
    if (active <= 0) {
      // barrier 组全部结束 → 触发完成
      this.active.delete(input.parentSessionId)
      const taskIds = this.barrierTasks.get(input.parentSessionId) ?? []
      this.barrierTasks.delete(input.parentSessionId)
      if (taskIds.length > 0) this.fire(input.parentSessionId, taskIds)
    } else {
      this.active.set(input.parentSessionId, active)
    }
  }

  /** 订阅 barrier 完成（返回取消订阅函数） */
  onBarrierCompleted(listener: (sessionId: string, taskIds: string[]) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 查询 worker 信息（send_message 续跑用） */
  getWorker(taskId: string): CoordinatorWorker | undefined {
    return this.workers.get(taskId)
  }

  /** 当前某 session 运行中的任务数（诊断） */
  activeCount(sessionId: string): number {
    return this.active.get(sessionId) ?? 0
  }

  private fire(sessionId: string, taskIds: string[]): void {
    for (const listener of this.listeners) {
      try { listener(sessionId, taskIds) } catch { /* 单个监听器错误不影响其他 */ }
    }
  }
}

// ===== FileWriteArbiter：文件级写锁（跨 session 互斥） =====

/**
 * 文件级写锁：按 canonical 路径互斥，锁持有 = 单次写工具调用（write_file/edit_file）。
 *
 * 语义（对比旧的"派工声明级"仲裁，锁粒度大幅收窄）：
 * - 不在 subagent 派工时按 targetFiles 整组阻塞——agent 实际写哪些文件在执行前
 *   并不确定，声明级锁会误伤不相关 worker（见架构文档 §9.4 设计修正）。
 * - 改为在真正写文件时按目标路径加锁：同一路径被其他 session 的写操作持有时，
 *   本次写等待其完成；同 session 内天然串行，无需加锁。
 *
 * 纯逻辑、无外部依赖，可独立测试。
 */
export class FileWriteArbiter {
  /** 规范化路径 → 持有者 */
  private readonly holders = new Map<string, { sessionId: string; toolUseId: string }>()
  /** 规范化路径 → 等待者队列（FIFO） */
  private readonly waiters = new Map<string, Array<() => void>>()

  /** 当前持有写锁的路径（诊断/测试） */
  lockedPaths(): string[] {
    return Array.from(this.holders.keys())
  }

  /** 某路径当前等待数量（诊断/测试） */
  waitingCount(writePath?: string): number {
    if (writePath) return this.waiters.get(normalizeWritePath(writePath))?.length ?? 0
    let total = 0
    for (const q of this.waiters.values()) total += q.length
    return total
  }

  /**
   * 获取写锁：路径被其他 session 持有时阻塞（per-path FIFO），直到释放。
   * 同 session 重复获取直接放行（单 session 工具调用天然串行）。
   */
  async acquireWrite(writePath: string, owner: { sessionId: string; toolUseId: string }): Promise<void> {
    const norm = normalizeWritePath(writePath)
    for (;;) {
      const holder = this.holders.get(norm)
      if (!holder) {
        this.holders.set(norm, owner)
        return
      }
      if (holder.sessionId === owner.sessionId) return // 同 session 串行，无需改 holder
      await new Promise<void>((resolve) => {
        const q = this.waiters.get(norm) ?? []
        q.push(resolve)
        this.waiters.set(norm, q)
      })
      // 被 release 唤醒后回到循环重新检查
    }
  }

  /** 释放写锁（幂等），唤醒该路径 FIFO 队首等待者 */
  releaseWrite(writePath: string, toolUseId: string): void {
    const norm = normalizeWritePath(writePath)
    const holder = this.holders.get(norm)
    if (!holder || holder.toolUseId !== toolUseId) return
    this.holders.delete(norm)
    const q = this.waiters.get(norm)
    if (q && q.length > 0) {
      q.shift()!()
      if (q.length === 0) this.waiters.delete(norm)
    }
  }
}

/** 规范化写路径：resolve + 去尾斜杠 + 小写（仅路径语义，不做存在性检查） */
export function normalizeWritePath(p: string): string {
  return p.replace(/\/+$/, '')
}

/** 写类工具（有明确 path 输入参数；bash 无法可靠解析写入路径，不纳入） */
const WRITE_TOOL_IDS = ['write_file', 'edit_file']

/** 从写工具输入提取目标路径；非写工具/无路径返回 undefined */
function extractWritePath(toolId: string, input: unknown): string | undefined {
  if (!WRITE_TOOL_IDS.includes(toolId) || !input || typeof input !== 'object') return undefined
  const p = (input as { path?: unknown }).path
  return typeof p === 'string' && p.length > 0 ? p : undefined
}

// ===== SendMessage 工具 =====

/** send_message 工具输入 */
export interface SendMessageInput {
  /** 已派出的后台任务 ID（subagent runInBackground 返回的 taskId） */
  taskId: string
  /** 续跑指令（延续该 worker 的会话上下文） */
  message: string
  /** 简短描述（可选） */
  description?: string
}

/** send_message 工具输出 */
export interface SendMessageOutput {
  /** worker 的最终回复文本 */
  message: string
  /** worker 会话累计消息数 */
  messageCount: number
}

/** Harness 引用最小接口（避免循环依赖） */
interface HarnessLike {
  agent: AgentRuntime
  session: SessionManager
  bus?: Bus
}

/** Schema helper（自包含，避免跨包依赖） */
function makeSchema<T>(): Schema<T> {
  return { parse: (v) => v as T, safeParse: (v) => ({ success: true, data: v as T }) }
}

/** 从 Message 提取最终文本 */
function extractText(msg: Message): string {
  return msg.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
}

/**
 * send_message 工具：向已派出的 worker（taskId）续跑消息。
 * 延续该 worker 的子 session 上下文（多轮对话），返回 worker 回复。
 * 仅对 mode=coordinator 的 Agent 注入。
 */
export function createSendMessageTool(
  getHarness: () => HarnessLike | undefined,
  getTracker: () => CoordinatorBarrierTracker,
  timeoutMs: number,
): Tool<SendMessageInput, SendMessageOutput> {
  return defineTool<SendMessageInput, SendMessageOutput>({
    id: 'send_message',
    aliases: ['resume_worker', 'message_worker'],
    description: '向已派出的 worker（后台任务 taskId）发送续跑消息，延续其会话上下文，返回 worker 回复。用于协调器给已有 worker 补充指令、追问细节或催办。输入：taskId（后台任务 ID）、message（续跑指令）、description（可选）。',
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    requiresUserInteraction: false,

    inputSchema: makeSchema<SendMessageInput>(),
    permission: { key: 'send_message', extractPatterns: (input) => [input.taskId] },

    async call(input: SendMessageInput, _ctx: ToolContext): Promise<ToolResult<SendMessageOutput>> {
      const harness = getHarness()
      if (!harness?.agent || !harness.session) {
        return { ok: false, error: { message: 'Harness 未就绪（harness.start 未触发）', code: 'HARNESS_NOT_READY' } }
      }
      const worker = getTracker().getWorker(input.taskId)
      if (!worker) {
        return { ok: false, error: { message: `任务 "${input.taskId}" 不存在或未被跟踪`, code: 'TASK_NOT_FOUND' } }
      }
      if (worker.status === 'running') {
        return { ok: false, error: { message: `任务 "${input.taskId}" 仍在运行，无法中途续跑，请等其完成后再发送`, code: 'TASK_RUNNING' } }
      }
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`send_message 执行超时（${timeoutMs}ms）`)), timeoutMs)
        })
        const msgPromise = harness.agent.query({
          sessionId: worker.subSessionId,
          agentId: worker.agentId,
          message: input.message,
        })
        const msg = await Promise.race([msgPromise, timeout])
        return {
          ok: true,
          output: {
            message: extractText(msg) || '(worker 无文本回复)',
            messageCount: msg.parts.length,
          },
        }
      } catch (err) {
        return { ok: false, error: { message: `send_message 失败：${(err as Error)?.message ?? err}`, code: 'SEND_MESSAGE_FAILED' } }
      }
    },

    renderUse: (input) => ({
      taskId: input.taskId,
      message: input.message.length > 100 ? input.message.slice(0, 100) + '...' : input.message,
    }),
    renderResult: (result) => {
      if (!result.ok || !result.output) return undefined
      return {
        message: result.output.message.length > 200 ? result.output.message.slice(0, 200) + '...' : result.output.message,
        messageCount: result.output.messageCount,
      }
    },
  })
}

// ===== 插件 =====

export interface CoordinatorPluginOptions {
  /** 强制所有 subagent spawn 后台化（默认 false；环境变量 HARNESS_FORCE_ASYNC=true 也生效） */
  forceAsync?: boolean
  /** barrier 完成后是否发布 coordinator.barrier.completed 事件（默认 true） */
  autoContinue?: boolean
  /** send_message 执行超时（毫秒），缺省 120_000 */
  timeoutMs?: number
  /**
   * 文件级写锁（默认 true）：write_file/edit_file 等写工具按目标路径互斥——
   * 同一路径被其他 session（worker）的写操作持有时，本次写等待其完成再执行。
   * 锁粒度 = 单次写工具调用（不再按 targetFiles 派工声明整组阻塞）。
   */
  serializeWrites?: boolean
}

/** 读取环境变量布尔值（'1' / 'true' / 'yes'） */
function isEnvTruthy(v: string | undefined): boolean {
  if (!v) return false
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

/** 创建 Coordinator 插件 */
export function createCoordinatorPlugin(options: CoordinatorPluginOptions = {}): AgentPlugin {
  const forceAsync = options.forceAsync ?? isEnvTruthy(process.env.HARNESS_FORCE_ASYNC)
  const autoContinue = options.autoContinue ?? true
  const timeoutMs = options.timeoutMs ?? 120_000
  const serializeWrites = options.serializeWrites ?? true

  let harness: HarnessLike | undefined
  let bus: Bus | undefined
  let sendMessageTool: Tool<SendMessageInput, SendMessageOutput> | undefined
  const tracker = new CoordinatorBarrierTracker()
  const arbiter = new FileWriteArbiter()

  return {
    id: 'coordinator',
    version: '0.1.0',
    name: 'Coordinator',
    description: `Coordinator 插件：主 Agent 变 orchestrator（四阶段派工）+ barrier 自动集齐续轮 + forceAsync=${forceAsync} + send_message 续跑 + 写操作串行化=${serializeWrites}`,
    dependsOn: ['subagent'],

    async install(ctx) {
      ctx.log.info('Coordinator 插件已加载', { forceAsync, autoContinue, serializeWrites })

      sendMessageTool = createSendMessageTool(() => harness, () => tracker, timeoutMs)

      return {
        async 'harness.start'(input) {
          const h = (input as { harness: HarnessLike }).harness
          if (!h?.agent || !h?.session) {
            ctx.log.error('Coordinator 插件：harness.start 未提供 agent/session 引用')
            return
          }
          harness = h
          bus = h.bus

          // barrier 完成 → 发布事件（外层订阅后注入 <continue/> 自动续轮）
          tracker.onBarrierCompleted((sessionId, taskIds) => {
            if (!autoContinue || !bus) return
            bus.publish(CoordinatorEvents.barrierCompleted, { sessionId, taskIds })
              .catch(() => { /* Bus 发布失败不影响主流程 */ })
          })

          // 订阅 subagent 事件跟踪 barrier（依赖 subagent 插件事件）
          if (bus) {
            bus.subscribe(SubagentEvents.started, ({ payload }) => {
              if (!payload.taskId || !payload.background) return
              tracker.onWorkerStarted({
                taskId: payload.taskId,
                agentId: payload.agentId,
                subSessionId: payload.subSessionId,
                parentSessionId: payload.parentSessionId,
              })
            })
            bus.subscribe(SubagentEvents.completed, ({ payload }) => {
              if (!payload.taskId) return
              tracker.onWorkerFinished({
                taskId: payload.taskId,
                parentSessionId: payload.parentSessionId,
                status: 'completed',
              })
            })
            bus.subscribe(SubagentEvents.failed, ({ payload }) => {
              if (!payload.taskId) return
              tracker.onWorkerFinished({
                taskId: payload.taskId,
                parentSessionId: payload.parentSessionId,
                status: 'failed',
              })
            })
          }
        },

        // Coordinator 身份：注入 orchestrator System Prompt
        'prompt.system.transform'(input, parts) {
          const def = harness?.agent.get(input.agentId)
          if (def?.mode === 'coordinator') {
            parts.push(COORDINATOR_SYSTEM_PROMPT)
          }
        },

        // forceAsync + 文件级写锁：拦截工具调用
        // 注：core 的 preHook next 实际签名是 (modifiedInput?: unknown) => Promise<ToolResult>，
        // 但 Hooks 接口类型声明为 () => Promise<unknown>，此处用 any 兼容传参改写
        async 'tool.pre.execute'(ctx: any, next: any) {
          // 文件级写锁：写类工具按目标路径跨 session 互斥（锁持有 = 本次写调用）
          if (serializeWrites && ctx?.input && typeof ctx.input === 'object') {
            const writePath = extractWritePath(ctx?.tool?.id, ctx.input)
            if (writePath) {
              await arbiter.acquireWrite(writePath, { sessionId: ctx.sessionId, toolUseId: ctx.toolUseId })
              try {
                return await next()
              } finally {
                arbiter.releaseWrite(writePath, ctx.toolUseId)
              }
            }
          }

          // forceAsync：强制 subagent spawn 后台化（不做派工级写仲裁）
          if (forceAsync && ctx?.tool?.id === 'subagent' && ctx?.input && typeof ctx.input === 'object') {
            return next({ ...ctx.input, runInBackground: true })
          }
          return next()
        },

        // 给 coordinator Agent 注入 send_message 工具
        'tool.pool.assemble'({ agentId }, pool) {
          const def = harness?.agent.get(agentId)
          if (def?.mode === 'coordinator' && sendMessageTool) {
            ;(pool as { add: (t: unknown) => void }).add(sendMessageTool)
          }
        },
      }
    },
  }
}

/** 便捷导出：默认 Coordinator 插件 */
export const coordinatorPlugin = createCoordinatorPlugin()
