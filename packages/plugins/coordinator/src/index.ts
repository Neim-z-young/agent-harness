/**
 * @harness/coordinator - Coordinator 插件
 *
 * 把主 Agent 变成 orchestrator（调度器）：自己不写实现，专司四阶段派工
 * （Research → Synthesis → Implementation → Verification）。
 *
 * 核心能力：
 * 1. **Coordinator 身份**：`AgentDefinition.mode === 'coordinator'` 的 Agent
 *    通过 core.prompt.system.transform 注入 Coordinator System Prompt（四阶段规则）。
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

import { defineTool, withJsonSchema, type Tool, type ToolResult, type Schema, type ToolContext } from '@harness/tool'
import type { AgentPlugin } from '@harness/plugin'
import type { AgentDefinition } from '@harness/agent'
import type { AgentRuntime, SessionManager } from '@harness/core'
import type { Message } from '@harness/session'
import { BusEvent, type Bus } from '@harness/bus'
import { SubagentEvents } from '@harness/subagent'
// Coordinator System Prompt 文本（prompts/coordinator.txt，import 加载，参考 opencode）
import coordinatorPrompt from './prompts/coordinator.txt'

// ===== Coordinator Bus 事件 =====

export const CoordinatorEvents = {
  /**
   * Barrier 完成事件：某个 session 派出的后台任务**全部**完成/失败后发布。
   * 外层（CLI REPL / SDK）订阅此事件后应触发下一轮 query（注入 `<continue/>`）。
   *
   * 语义边界（观察点 2 之后）：本事件只负责「这一波结束了」的**收尾判定**，
   * 不再承担「结果就绪」的职责 —— 那是 {@link workerCompleted} 的事。
   * 两者都发时，单个任务那条**不会**在最后一个任务上重复发（见 `remaining === 0` 的分支）。
   */
  barrierCompleted: BusEvent.define<{
    /** 父 session ID（coordinator 所在会话） */
    sessionId: string
    /** 本轮 barrier 包含的任务 ID 列表 */
    taskIds: string[]
  }>('coordinator.barrier.completed'),

  /**
   * **单个** worker 完成/失败（观察点 2）。
   *
   * 为什么需要它：barrier 事件要等**全部**任务结束才发。真机 s_1790163574429_tg1a6 里
   * reader#2 在 19:43:10 就完成了，barrier 直到 19:44:03（最慢那个失败时）才 completed ——
   * 快结果被慢任务拖了 53 秒，而那 53 秒正是"界面停在等待中"的那段。
   *
   * 只在 `remaining > 0` 时发布：`remaining === 0` 意味着这是最后一个任务，
   * 此时 `barrierCompleted` 已经作为"本波收尾"发出——两条都发只会让外层注入两行
   * `<continue/>`（第二行必然空转，白跑一次判定）。
   *
   * 外层消费提示：收到本事件即可唤醒下一轮（CLI 侧的 `attachAutoContinue` 就是这么做的），
   * 但**不要**把它当成"任务全齐了"——那是 barrierCompleted。
   */
  workerCompleted: BusEvent.define<{
    /** 父 session ID（coordinator 所在会话） */
    sessionId: string
    /** 刚结束的后台任务 ID */
    taskId: string
    /** 该任务的结局 */
    status: 'completed' | 'failed'
    /** 本波里**仍未结束**的任务数（>0 才会发本事件） */
    remaining: number
  }>('coordinator.worker.completed'),
} as const

// ===== Coordinator System Prompt =====

/**
 * Coordinator System Prompt 片段（注入到 mode=coordinator 的 Agent）。
 * 参考 Claude Code `coordinatorMode.ts`：主线程身份改写为 orchestrator，
 * 显式分相 + 派工规则 + 反模式。
 * 文本存放于 prompts/coordinator.txt，可直接编辑文本文件修改提示词。
 */
export const COORDINATOR_SYSTEM_PROMPT = coordinatorPrompt.trim()

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
  /** 已派出的后台任务 ID（subagent runInBackground 返回的 taskId；本地续跑路由） */
  taskId?: string
  /** 续跑指令 / 要发送的消息内容 */
  message: string
  /** 简短描述（可选） */
  description?: string
  /** mailbox 路由：目标团队成员名（'*' = 广播给团队所有成员） */
  to?: string
  /** mailbox 路由：团队名（提供 to 时需要） */
  team?: string
}

/** send_message 工具输出 */
export interface SendMessageOutput {
  /** worker 的最终回复文本 / mailbox 路由投递摘要 */
  message: string
  /** worker 会话累计消息数（本地续跑路由） */
  messageCount?: number
  /** mailbox 路由投递目标列表 */
  deliveredTo?: string[]
  /** mailbox 路由团队名 */
  team?: string
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

/** mailbox 路由最小接口（由 swarm TeammateMailbox 注入，避免 coordinator 依赖 swarm 包） */
export interface SendMailbox {
  writeToMailbox(
    team: string,
    recipient: string,
    msg: { from: string; text: string; summary?: string; timestamp: string; type?: string },
  ): Promise<unknown>
}

/** send_message 工具选项 */
export interface SendMessageToolOptions {
  /** 本地续跑超时（毫秒，默认 120_000） */
  timeoutMs?: number
  /** mailbox 路由：注入 swarm mailbox 后支持 to/team 投递 */
  mailbox?: SendMailbox
  /** mailbox 路由：团队成员名列表（广播 to='*' 时使用） */
  getTeamMembers?: (team: string) => Promise<string[]>
}

/**
 * send_message 工具：统一两条路由——
 * 1. **mailbox 路由**（提供 team + to）：向团队成员 mailbox 投递消息；`to='*'` 广播到团队所有成员。
 * 2. **本地续跑路由**（提供 taskId）：向已派出的 worker（taskId）续跑消息，延续其子会话上下文。
 * 仅对 mode=coordinator 的 Agent 注入。
 */
export function createSendMessageTool(
  getHarness: () => HarnessLike | undefined,
  getTracker: () => CoordinatorBarrierTracker,
  timeoutMsOrOptions: number | SendMessageToolOptions = 120_000,
): Tool<SendMessageInput, SendMessageOutput> {
  const opts: SendMessageToolOptions = typeof timeoutMsOrOptions === 'number'
    ? { timeoutMs: timeoutMsOrOptions }
    : timeoutMsOrOptions
  const timeoutMs = opts.timeoutMs ?? 120_000

  return defineTool<SendMessageInput, SendMessageOutput>({
    id: 'send_message',
    aliases: ['resume_worker', 'message_worker'],
    description: '向 worker/团队成员发送消息，两条路由：① mailbox 路由——输入 team + to（成员名或 * 广播到团队全部成员），投递到成员 inbox；② 本地续跑路由——输入 taskId（已派出的后台任务 ID），延续其会话上下文执行并返回回复。',
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    requiresUserInteraction: false,

    inputSchema: withJsonSchema(makeSchema<SendMessageInput>(), {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '本地续跑路由：已派出的后台任务 ID（subagent runInBackground 返回），延续其会话执行' },
        message: { type: 'string', description: '要发送的指令 / 消息内容' },
        description: { type: 'string', description: '简短描述（可选，用于日志展示）' },
        to: { type: 'string', description: 'mailbox 路由：目标团队成员名；"*" 表示广播给团队全部成员' },
        team: { type: 'string', description: 'mailbox 路由：团队名（提供 to 时必填）' },
      },
      required: ['message'],
      additionalProperties: false,
    }),
    permission: { key: 'send_message', extractPatterns: (input) => [input.taskId ?? input.to ?? ''] },

    async call(input: SendMessageInput, ctx: ToolContext): Promise<ToolResult<SendMessageOutput>> {
      // mailbox 路由：team + to（成员名 / '*' 广播）
      if (input.team && input.to) {
        if (!opts.mailbox) {
          return { ok: false, error: { message: 'mailbox 路由未配置（未注入 swarm mailbox）', code: 'MAILBOX_NOT_CONFIGURED' } }
        }
        try {
          const targets = input.to === '*'
            ? (await opts.getTeamMembers?.(input.team)) ?? []
            : [input.to]
          if (targets.length === 0) {
            return { ok: false, error: { message: `广播目标为空：团队 "${input.team}" 无成员`, code: 'MAILBOX_NO_TARGETS' } }
          }
          const now = new Date().toISOString()
          for (const target of targets) {
            await opts.mailbox.writeToMailbox(input.team, target, {
              from: ctx.agentId,
              text: input.message,
              summary: input.description,
              timestamp: now,
              type: 'message',
            })
          }
          return {
            ok: true,
            output: {
              message: input.to === '*'
                ? `已广播到 ${targets.length} 位成员：${targets.join(', ')}`
                : `已投递到 ${targets[0]}`,
              deliveredTo: targets,
              team: input.team,
            },
          }
        } catch (err) {
          return { ok: false, error: { message: `send_message（mailbox）失败：${(err as Error)?.message ?? err}`, code: 'MAILBOX_SEND_FAILED' } }
        }
      }

      // 本地续跑路由：taskId → worker 子会话
      if (!input.taskId) {
        return { ok: false, error: { message: '缺少目标：需提供 team+to（mailbox 路由）或 taskId（续跑路由）', code: 'INVALID_TARGET' } }
      }
      const harness = getHarness()
      if (!harness?.agent || !harness.session) {
        return { ok: false, error: { message: 'Harness 未就绪（core.harness.start 未触发）', code: 'HARNESS_NOT_READY' } }
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
        // 结果已通过本地续跑通道取回：广播事件，subagent 侧将把该后台任务标记为
        // resultFetched，使其稍后的完成通知降级为简短提示，避免重复注入结果全文（去重）
        if (harness.bus && input.taskId) {
          harness.bus.publish(SubagentEvents.resultFetched, {
            taskId: input.taskId,
            parentSessionId: ctx.sessionId,
            fetchedAt: Date.now(),
          }).catch(() => { /* Bus 发布失败不影响主流程 */ })
        }
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
      taskId: input.taskId ?? '',
      to: input.to,
      team: input.team,
      message: input.message.length > 100 ? input.message.slice(0, 100) + '...' : input.message,
    }),
    renderResult: (result) => {
      if (!result.ok || !result.output) return undefined
      return {
        message: result.output.message.length > 200 ? result.output.message.slice(0, 200) + '...' : result.output.message,
        ...(result.output.deliveredTo ? { deliveredTo: result.output.deliveredTo } : {}),
        ...(result.output.messageCount !== undefined ? { messageCount: result.output.messageCount } : {}),
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
  /** send_message mailbox 路由：注入 swarm 的 mailbox（支持 team+to 投递 / '*' 广播） */
  mailbox?: SendMailbox
  /** send_message mailbox 路由：团队成员名列表（广播 to='*' 时使用） */
  getTeamMembers?: (team: string) => Promise<string[]>
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

      sendMessageTool = createSendMessageTool(() => harness, () => tracker, {
        timeoutMs,
        mailbox: options.mailbox,
        getTeamMembers: options.getTeamMembers,
      })

      return {
        async 'core.harness.start'(input) {
          const h = (input as { harness: HarnessLike }).harness
          if (!h?.agent || !h?.session) {
            ctx.log.error('Coordinator 插件：core.harness.start 未提供 agent/session 引用')
            return
          }
          harness = h
          bus = h.bus

          /**
           * 单个 worker 结束的收口点（观察点 2：单任务完成即让外层可以唤醒，不等整波）。
           *
           * 顺序很关键：`remaining` 必须在 `onWorkerFinished` **之前**算 —— 后者在计数归零时
           * 会把这波 barrier 组整个删掉（`active.delete`），之后再问永远是 0，
           * 于是"快任务完成时也报 remaining=0" ⇒ `workerCompleted` 永远发不出来，
           * 又退回"等最慢那个"的老行为。
           */
          const onWorkerDone = (
            parentSessionId: string,
            taskId: string,
            status: 'completed' | 'failed',
          ): void => {
            const remaining = Math.max(0, tracker.activeCount(parentSessionId) - 1)
            tracker.onWorkerFinished({ taskId, parentSessionId, status })
            // 最后一个任务：barrierCompleted 会作为"本波收尾"发出，这里不重复唤醒
            if (remaining <= 0) return
            if (!autoContinue || !bus) return
            bus.publish(CoordinatorEvents.workerCompleted, {
              sessionId: parentSessionId,
              taskId,
              status,
              remaining,
            }).catch(() => { /* Bus 发布失败不影响主流程 */ })
          }

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
              onWorkerDone(payload.parentSessionId, payload.taskId, 'completed')
            })
            bus.subscribe(SubagentEvents.failed, ({ payload }) => {
              if (!payload.taskId) return
              onWorkerDone(payload.parentSessionId, payload.taskId, 'failed')
            })
          }
        },

        // Coordinator 身份：注入 orchestrator System Prompt
        'core.prompt.system.transform'(input, parts) {
          const def = harness?.agent.get(input.agentId)
          if (def?.mode === 'coordinator') {
            parts.push(COORDINATOR_SYSTEM_PROMPT)
          }
        },

        // forceAsync + 文件级写锁：拦截工具调用
        // 注：core 的 preHook next 实际签名是 (modifiedInput?: unknown) => Promise<ToolResult>，
        // 但 Hooks 接口类型声明为 () => Promise<unknown>，此处用 any 兼容传参改写
        async 'core.tool.pre.execute'(ctx: any, next: any) {
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
        'core.tool.pool.assemble'({ agentId }, pool) {
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
