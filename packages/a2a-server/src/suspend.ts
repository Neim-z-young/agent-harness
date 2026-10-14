/**
 * 挂起任务表（plan §3.4）—— A2A 远程权限的**核心机制**。
 *
 * ## 为什么需要它
 * 权限询问发生在 `session.promptStream` 生成器**内部**（同步调用栈里），而答复会从
 * **另一条 HTTP 请求**（带同一 `taskId` 的 `SendMessage`）到达。因此任务必须能被
 * "停在 ask 上"并跨请求持有：`ask()` 返回一个 Promise，**由本表持有其 resolver**，
 * 后续请求按 `taskId` 找回 resolver → resolve → 生成器继续跑。
 *
 * ## 模式 A（spike 实测，1.3.0）
 * executor 在 `INPUT_REQUIRED` 之后**不返回**（`await` 答复）⇒ 本表只需
 * `taskId → resolver`，**不必跨请求保存/恢复 generator**。
 * 代价：executor 的 Promise 会长期悬挂 ⇒ **TTL 与回收是必需项，不是锦上添花**
 * （没有 TTL 时挂起表与 task 记录会一起泄漏，plan §10.5 补充）。
 *
 * ## 幂等（plan §3.4 要点 3）
 * 重复答复、答复迟到于超时之后、答复里带旧 `messageId`，都必须被**安全忽略** ——
 * `answer()` / `cancel()` 在条目不存在时返回 `false`，调用方据此忽略，而不是报错。
 */
import type { PermissionAnswer, PermissionAskInput } from '@harness/host'

/** 挂起中的待决询问（供 executor 组装 `INPUT_REQUIRED` 的结构化描述） */
export interface PendingAsk {
  taskId: string
  contextId: string
  /** 询问输入（工具名 + 模式） */
  req: PermissionAskInput
  createdAt: number
  deadlineAt: number
}

/** 挂起的结束方式 */
export type SuspendOutcome = 'answered' | 'expired' | 'canceled'

export interface SuspendResult {
  outcome: SuspendOutcome
  /** `outcome === 'answered'` 时的四态答复；其余情况为 `undefined`（引擎按 deny 处理） */
  answer?: PermissionAnswer
}

export interface SuspendTableOptions {
  /** 挂起超时（毫秒）。默认 5 分钟 —— 与被切断的任务同量级，但远短于"永久悬挂"。 */
  ttlMs?: number
  /** 超时回调（executor 用它发布 FAILED / CANCELED 并释放生成器） */
  onExpire?: (pending: PendingAsk) => void
}

/** 默认挂起超时：5 分钟 */
export const DEFAULT_SUSPEND_TTL_MS = 5 * 60 * 1000

interface Entry {
  pending: PendingAsk
  promise: Promise<SuspendResult>
  resolve: (r: SuspendResult) => void
  timer: ReturnType<typeof setTimeout>
}

export class SuspendTable {
  private readonly entries = new Map<string, Entry>()
  private readonly ttlMs: number
  private onExpire: ((pending: PendingAsk) => void) | undefined

  constructor(opts: SuspendTableOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_SUSPEND_TTL_MS
    this.onExpire = opts.onExpire
  }

  /**
   * 替换超时回调。
   *
   * 存在的理由：executor 可能被传入一张**外部构造**的挂起表（`HarnessAgentExecutorOptions.suspendTable`），
   * 那种情况下构造参数里的 `onExpire` 不是 executor 的 —— 而"超时置 `expired`"是 executor 的职责，
   * 不接管就会把"挂起超时"静默报成 `COMPLETED`（`finalize` 只认 `running.expired`）。故必须能补装。
   */
  setOnExpire(fn: ((pending: PendingAsk) => void) | undefined): void {
    this.onExpire = fn
  }

  /**
   * 挂起一个 task，等答复。
   *
   * `onSuspend` 在**登记完成后立刻**同步调用 —— executor 用它发布 `INPUT_REQUIRED`
   * 状态更新（必须在开始等待之前发出去，否则调用方永远看不到"需要输入"）。
   */
  wait(
    taskId: string,
    contextId: string,
    req: PermissionAskInput,
    onSuspend?: (pending: PendingAsk) => void,
  ): Promise<SuspendResult> {
    // 同 taskId 已有挂起 ⇒ 复用同一个 Promise，不覆盖。
    // 覆盖会让前一个 resolver 永远悬着（其生成器再也不会被唤醒 ⇒ 泄漏），
    // 而"同一 task 同时有两个待决询问"在本设计里不该发生（一次 ask 才登记一次）。
    const existing = this.entries.get(taskId)
    if (existing) return existing.promise

    const now = Date.now()
    const pending: PendingAsk = {
      taskId,
      contextId,
      req,
      createdAt: now,
      deadlineAt: now + this.ttlMs,
    }
    let resolveFn!: (r: SuspendResult) => void
    const promise = new Promise<SuspendResult>((resolve) => {
      resolveFn = resolve
    })
    const timer = setTimeout(() => {
      const entry = this.entries.get(taskId)
      if (!entry) return
      this.entries.delete(taskId)
      entry.resolve({ outcome: 'expired' })
      this.onExpire?.(pending)
    }, this.ttlMs)
    // ★**不 unref**：这个 timer 决定挂起 promise 的到期，而 executor 在 await 它。
    // Bun/Windows 上"事件循环里只剩 unref 工作"⇒ 定时器永不到期（upstream #32014）⇒
    // 请求与测试一起挂死。"不阻止进程退出"由 `clear()`（关闭服务时释放全部挂起）负责，
    // 而不是靠 unref 这次等待。

    this.entries.set(taskId, { pending, promise, resolve: resolveFn, timer })
    onSuspend?.(pending)
    return promise
  }

  /** 答复一个挂起的 task；返回是否真的唤醒了（`false` = 迟到/重复/已超时，调用方应忽略） */
  answer(taskId: string, answer: PermissionAnswer): boolean {
    const entry = this.entries.get(taskId)
    if (!entry) return false
    this.entries.delete(taskId)
    clearTimeout(entry.timer)
    entry.resolve({ outcome: 'answered', answer })
    return true
  }

  /** 取消挂起（`CancelTask` 路径）；返回是否命中 */
  cancel(taskId: string): boolean {
    const entry = this.entries.get(taskId)
    if (!entry) return false
    this.entries.delete(taskId)
    clearTimeout(entry.timer)
    entry.resolve({ outcome: 'canceled' })
    return true
  }

  has(taskId: string): boolean {
    return this.entries.has(taskId)
  }

  /** 挂起中的待决项（供 `GetTask` / 自检读取） */
  pending(taskId: string): PendingAsk | undefined {
    return this.entries.get(taskId)?.pending
  }

  /** 当前挂起数（测试与自检用） */
  get size(): number {
    return this.entries.size
  }

  /** 清空（关闭服务时释放全部悬挂的 resolver，避免进程无法退出） */
  clear(): void {
    for (const [taskId, entry] of this.entries) {
      clearTimeout(entry.timer)
      this.entries.delete(taskId)
      entry.resolve({ outcome: 'canceled' })
    }
  }
}
