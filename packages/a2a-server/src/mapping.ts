/**
 * A2A ↔ harness 的**纯映射层**（无 IO、无网络、可单独测试）。
 *
 * ## 为什么单独成文件
 * 协议翻译是本包最容易出错、也最值得单独钉住的一层 —— 它有两个**静默失败**的形态
 * （见 `docs/external-integration-plan.md` §3.1.1）：
 *
 * 1. **Part / Message 有两套表示**。SDK 内部是 protobuf 判别式结构
 *    （`content: { $case: 'text', value }`），而**线上 JSON 是 `{"text":"..."}`**。
 *    把内部表示直接 `JSON.stringify` 发出去，对端 `fromJSON` 会**静默丢弃内容、不报错**
 *    （实测 `echo: hello` 退化成 `echo: `）。⇒ 本文件构造的**一律是内部表示**，
 *    出口必须在 `server.ts` 里交给 SDK 的 `MessageFns.toJSON()`（`Response.json()` 亦可，
 *    protobuf 对象自带 `toJSON()`，`JSON.stringify` 会自动调用）。
 * 2. **`TaskState` 是数字 enum，线上是字符串**。`TaskState.TASK_STATE_COMPLETED === 3`，
 *    而 JSON 里是 `"TASK_STATE_COMPLETED"`。故状态比较一律走 `stateName()`（`taskStateToJSON`），
 *    **不写字面量** —— 写死字符串在 SDK 改枚举名时会静默不匹配（比较恒 false）。
 *
 * ## 事件合并（plan §3.3）：不是逐条转发
 * `text_delta` / `reasoning_delta` 是**分片级**（每几十 token 一次），而 A2A 事件是
 * **任务生命周期级**。逐条转 `status-update` 会产生上千条状态更新（客户端 UI 抖动 + 流量浪费）。
 * 合并只发生在**展示粒度**上，不改引擎语义 —— 由本文件的 `StreamAdapter` 负责，
 * 它是纯状态机，测试不需要起服务。
 */
import {
  Role,
  TaskState,
  taskStateFromJSON,
  taskStateToJSON,
  type Artifact,
  type Message as A2aMessage,
  type Part,
  type TaskArtifactUpdateEvent,
  type TaskState as TaskStateValue,
  type TaskStatus,
  type TaskStatusUpdateEvent,
} from '@a2a-js/sdk'
import type { AgentStreamEvent } from '@harness/core'
import type { PermissionAnswer, PermissionAskInput } from '@harness/host'

// ========================================================================
// 1. 常量与 id
// ========================================================================

/** A2A 卡片的默认媒体类型（harness 的文本通道） */
export const TEXT_MEDIA_TYPE = 'text/plain'

/** 默认 artifact 名（一个 task 的正文文本都挂在它下面） */
export const ANSWER_ARTIFACT_NAME = 'answer'

/**
 * 每累积多少字符就发一条 `artifact-update(append:true)`。
 *
 * 400 是个折中：SSE 客户端能感到"在流"，而一个 4000 字的回答只产生 10 条左右事件
 * （而不是上千条）。**不得按 delta 发**（plan §3.3）。
 */
export const DEFAULT_CHUNK_CHARS = 400

let seq = 0
/** 生成局部唯一 id（进程内够用；A2A 只要求 `messageId` 非空且由发送方给出） */
export function localId(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`
}

// ========================================================================
// 2. Part / Message 构造与解析
// ========================================================================

/** 文本 Part（内部表示；出口由 `toJSON` 转线上格式） */
export function textPart(value: string, mediaType: string = TEXT_MEDIA_TYPE): Part {
  return { content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType }
}

/** 结构化数据 Part —— 用于把 harness 的结构化事实（用量、待决项）带出去 */
export function dataPart(value: unknown): Part {
  return {
    content: { $case: 'data', value },
    metadata: undefined,
    filename: '',
    mediaType: 'application/json',
  }
}

/** 取消息里的文本（非 text part 跳过；多段拼接，与 harness 的 `parts.filter(text)` 口径一致） */
export function extractText(msg: A2aMessage | undefined): string {
  if (!msg) return ''
  return (msg.parts ?? [])
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .join('')
}

/** 构造一条 agent/user 消息（内部表示） */
export function messageOf(opts: {
  role: 'user' | 'agent'
  parts: Part[]
  messageId?: string
  contextId?: string
  taskId?: string
  metadata?: Record<string, unknown>
}): A2aMessage {
  return {
    messageId: opts.messageId ?? localId('msg'),
    contextId: opts.contextId ?? '',
    taskId: opts.taskId ?? '',
    role: opts.role === 'user' ? Role.ROLE_USER : Role.ROLE_AGENT,
    parts: opts.parts,
    metadata: opts.metadata,
    extensions: [],
    referenceTaskIds: [],
  }
}

// ========================================================================
// 3. 状态
// ========================================================================

/**
 * 状态名（线上字符串口径）。
 *
 * **不写字面量**：`TaskState.TASK_STATE_COMPLETED === 3`（数字 enum），线上是字符串
 * `"TASK_STATE_COMPLETED"`；写死字符串在 SDK 改枚举名时会静默不匹配。
 */
export function stateName(state: TaskStateValue): string {
  return taskStateToJSON(state)
}

/** 线上字符串 → enum（供需要比较的地方用；比较一律用 `stateName` 更稳） */
export function stateFromName(name: string): TaskStateValue {
  return taskStateFromJSON(name)
}

/** 构造 `TaskStatus` */
export function taskStatus(state: TaskStateValue, message?: A2aMessage): TaskStatus {
  return { state, message, timestamp: new Date().toISOString() }
}

/** 终态判定（与服务端 `TERMINAL_STATE_LIST` 同口径） */
export function isTerminalState(state: TaskStateValue): boolean {
  return (
    state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_CANCELED ||
    state === TaskState.TASK_STATE_REJECTED
  )
}

// ========================================================================
// 4. 权限：四态词汇表（plan §3.4 / §3.5）
// ========================================================================

/**
 * 线上可用的权限答复词汇 —— **就是 `PermissionAnswer` 的四态本身**。
 *
 * 刻意不做"客户端说 allow-once、服务端翻成 allow"这种翻译：多一层翻译就多一处
 * "两套写法"（本仓的老病）。四态是 host 的既有契约，直接当线上词汇表即可。
 */
export const PERMISSION_ANSWERS: readonly PermissionAnswer[] = [
  'allow',
  'deny',
  'always-allow',
  'always-deny',
] as const

/** 线上答复文本 → 四态；无法识别返回 `undefined`（调用方按 deny 或回错处理） */
export function parsePermissionAnswer(text: string): PermissionAnswer | undefined {
  const t = text.trim().toLowerCase()
  const hit = PERMISSION_ANSWERS.find((a) => a === t)
  if (hit) return hit
  // 少量等价写法（客户端可能只发 y/n）
  if (t === 'y' || t === 'yes' || t === 'allow-once') return 'allow'
  if (t === 'n' || t === 'no' || t === 'deny-once') return 'deny'
  if (t === 'a') return 'always-allow'
  if (t === 'd') return 'always-deny'
  return undefined
}

/**
 * `INPUT_REQUIRED` 的**结构化待决描述**（plan §3.4 要点 5）。
 *
 * 标准客户端只看到"需要输入"却不知道答什么就没用 —— 故必须带工具名、模式、
 * 可选项清单与一句人话。这些字段同时进 `status.message.metadata`（客户端可读）
 * 与 `statusUpdate.metadata`（不经 message 也能拿到）。
 */
export function buildPermissionMetadata(req: PermissionAskInput): Record<string, unknown> {
  return {
    kind: 'permission-request',
    tool: req.toolKey,
    patterns: req.patterns ?? [],
    options: PERMISSION_ANSWERS,
  }
}

/** 待决描述的人话（`status.message` 的文本 Part） */
export function buildPermissionQuestion(req: PermissionAskInput): string {
  const pat = (req.patterns ?? []).slice(0, 3).join(', ') || '(无路径)'
  return (
    `需要授权：[${req.toolKey}] ${pat}\n` +
    `请以 SendMessage 回复其一：${PERMISSION_ANSWERS.join(' / ')}`
  )
}

// ========================================================================
// 5. 流事件 → A2A 输出（合并策略）
// ========================================================================

/** `StreamAdapter.push()` 的输出项：要么一条 artifact 增量，要么一条状态更新 */
export type A2aEmission =
  | { kind: 'artifact'; event: TaskArtifactUpdateEvent }
  | { kind: 'status'; event: TaskStatusUpdateEvent }

/**
 * harness `AgentStreamEvent` 流 → A2A 事件的**合并器**。
 *
 * 输出的是 SDK 的**内部表示**（`TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`），
 * 由 `executor.ts` 包成 `AgentEvent.*` 投到 bus。这样合并逻辑可以脱离网络与 bus 测试。
 */
export class StreamAdapter {
  private readonly artifactId = localId('art')
  private text = ''
  private flushed = 0
  private reasoningChars = 0
  private artifactStarted = false

  constructor(
    private readonly taskId: string,
    private readonly contextId: string,
    /** 每条 artifact 增量最多攒多少字符（测试可压到很小以观察分片） */
    private readonly chunkChars: number = DEFAULT_CHUNK_CHARS,
  ) {}

  /** 处理一条流事件，返回本次应发出的 A2A 输出（可能为空） */
  push(ev: AgentStreamEvent): A2aEmission[] {
    switch (ev.type) {
      case 'text_delta':
        this.text += ev.text ?? ''
        return this.drainChunk()

      case 'reasoning_delta':
        // 推理过程**不进 artifact**（它是 agent 的内部活动，不是任务产出）；
        // 只在状态更新的 metadata 里报规模，供 UI 显示"在思考"。
        this.reasoningChars += (ev.text ?? '').length
        return []

      case 'tool_call_start':
        return [this.status(TaskState.TASK_STATE_WORKING, { phase: 'tool-start', tool: ev.toolId })]

      case 'tool_call_result':
        return [
          this.status(TaskState.TASK_STATE_WORKING, {
            phase: 'tool-result',
            tool: ev.toolId,
            isError: ev.isError === true,
          }),
        ]

      case 'step_gate':
        // 长等待心跳（AGENTS.md：>15s 无输出必须有可见反馈）。等待期间不烧 token，
        // 但客户端需要知道"没卡死"。预算语义已在引擎内（`overBudget`），此处只转述。
        return [
          this.status(TaskState.TASK_STATE_WORKING, {
            phase: 'gate',
            waitMs: ev.gate?.waitMs,
            plannedMs: ev.gate?.plannedMs,
            waitedMs: ev.gate?.waitedMs,
            overBudget: ev.gate?.overBudget === true,
          }),
        ]

      case 'done': {
        // **一步**结束（不是整轮）：把攒下的正文冲出去 + 报一次步号。
        const out = this.drainChunk()
        out.push(this.status(TaskState.TASK_STATE_WORKING, { phase: 'step', step: ev.step }))
        return out
      }

      case 'turn_end':
        // 尾巴统一由 `finish()` 冲（那时才知道终态是 COMPLETED 还是 FAILED/CANCELED）。
        // 在这里多冲一次会产生重复的最后一块 —— 冲盘点只留一个。
        return []

      default:
        return []
    }
  }

  /**
   * 整轮结束：补发最后一段正文（`lastChunk: true`），并给出终态。
   *
   * `state` 由调用方决定（正常 = COMPLETED，中断 = CANCELED，异常 = FAILED），
   * 因为"这一轮为什么结束"只有 executor 知道（`turn_end.aborted` / 抛错 / 挂起超时）。
   */
  finish(state: TaskStateValue, message?: A2aMessage, metadata?: Record<string, unknown>): A2aEmission[] {
    const out: A2aEmission[] = []
    const tail = this.takePending()
    if (tail) {
      // `append` 必须在 `artifactOf()` **之前**取值 —— 后者会把 `artifactStarted` 置为真，
      // 先取值才能区分"这条是首块"与"这条是续写"（写成 `artifact: this.artifactOf(x), append: this.artifactStarted`
      // 会让首块也带 append:true，客户端于是认为"追加到并不存在的产物上"）。
      const append = this.artifactStarted
      out.push({
        kind: 'artifact',
        event: {
          taskId: this.taskId,
          contextId: this.contextId,
          artifact: this.artifactOf(tail),
          append,
          lastChunk: true,
          metadata: undefined,
        },
      })
    }
    out.push({
      kind: 'status',
      event: {
        taskId: this.taskId,
        contextId: this.contextId,
        status: taskStatus(state, message),
        metadata,
      },
    })
    return out
  }

  /** 已产出的正文（供 executor 回写 / 自检） */
  get textSoFar(): string {
    return this.text
  }

  /** 推理过程累计字符数（进终态 metadata，供 UI 与取证） */
  get reasoningLength(): number {
    return this.reasoningChars
  }

  // ---------------------------------------------------------------- 内部

  private takePending(): string {
    const pending = this.text.slice(this.flushed)
    this.flushed = this.text.length
    return pending
  }

  /** 攒够 `chunkChars` 就冲一条 artifact 增量 */
  private drainChunk(): A2aEmission[] {
    if (this.text.length - this.flushed < this.chunkChars) return []
    const chunk = this.takePending()
    if (!chunk) return []
    const append = this.artifactStarted // 同 finish()：取值必须在 artifactOf() 之前
    return [
      {
        kind: 'artifact',
        event: {
          taskId: this.taskId,
          contextId: this.contextId,
          artifact: this.artifactOf(chunk),
          append,
          lastChunk: false,
          metadata: undefined,
        },
      },
    ]
  }

  private artifactOf(chunk: string): Artifact {
    this.artifactStarted = true
    return {
      artifactId: this.artifactId,
      name: ANSWER_ARTIFACT_NAME,
      description: '',
      parts: [textPart(chunk)],
      metadata: undefined,
      extensions: [],
    }
  }

  private status(state: TaskStateValue, metadata: Record<string, unknown>): A2aEmission {
    return {
      kind: 'status',
      event: { taskId: this.taskId, contextId: this.contextId, status: taskStatus(state), metadata },
    }
  }
}
