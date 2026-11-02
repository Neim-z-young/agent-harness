/**
 * 请求时限 / 取消桥 —— 各 Provider 共用**同一份**「外层 signal + 计时器」编排。
 *
 * 抽取前的形态：anthropic / gemini / openai 三家、各自 complete + stream，共 **6 份**
 * 逐字相同的样板：
 *
 * ```ts
 * const inner = new AbortController()
 * const onOuter = () => inner.abort()
 * if (outer) { if (outer.aborted) inner.abort() else outer.addEventListener('abort', onOuter, { once: true }) }
 * const timer = setTimeout(() => inner.abort(new Error(...)), ms)
 * try { ... } finally { clearTimeout(timer); outer?.removeEventListener('abort', onOuter) }
 * ```
 *
 * 这 6 份里任何一份漏掉 `removeEventListener`，长会话下每个请求都会往**同一个**上层
 * signal（会话级取消信号）上挂一个永不摘除的监听器 ⇒ 内存随请求数线性增长，且会话
 * 取消时会一次性触发上千次 abort。这类泄漏在功能上完全无症状，所以只能靠「只有一份
 * 实现」来保证一致。
 *
 * 语义刻意保持原样：
 * - 外层取消用 `abort()`（reason 缺省为 AbortError），**不**覆盖成超时错误；
 * - 超时用 `abort(new Error(消息))`，让 `fetch` 以该 Error 拒绝，调用方看到的是
 *   「超时」而不是「用户取消」——这两者在 UI 上的处理完全不同。
 */
/**
 * 流式总时长兜底系数：总时长上限 = `timeoutMs × 本系数`。
 *
 * 空闲（idle）超时负责「卡住不吐数据」，总时长兜底负责「一直慢慢吐、永不结束」。
 * 取 10 倍作为宽松上限，正常请求不会触及。此前这个**策略数字**在
 * anthropic / gemini / openai 三个包里各写了一遍 —— 同一个口径三份来源，
 * 调其中一处就会静默分叉（"只改了一处"是本仓反复出现的失效来源）。
 */
export const STREAM_TOTAL_TIMEOUT_FACTOR = 10

export class RequestDeadline {
  readonly #controller = new AbortController()
  readonly #outer: AbortSignal | undefined
  readonly #onOuterAbort: () => void
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  #totalTimer: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(outer?: AbortSignal) {
    this.#outer = outer
    this.#onOuterAbort = () => this.#controller.abort(outer?.reason)
    if (outer) {
      if (outer.aborted) this.#onOuterAbort()
      else outer.addEventListener('abort', this.#onOuterAbort, { once: true })
    }
  }

  /** 传给 `fetch` 的 signal（外层取消与超时都收敛到这里） */
  get signal(): AbortSignal {
    return this.#controller.signal
  }

  /** 已取消（外层或超时）—— 调用方可在长循环里提前退出 */
  get aborted(): boolean {
    return this.#controller.signal.aborted
  }

  /**
   * 空闲计时器：**每次**有数据到达时调用以续期。
   *
   * 流式必须用 idle 而不是总时长：总时长语义下，只要模型持续输出超过 `timeoutMs`
   * 就会把长回答无理由掐断，用户看到「内容已经渲染出来了，却报发送失败」。
   */
  armIdle(timeoutMs: number, message: string): void {
    if (this.#disposed || this.#controller.signal.aborted) return
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => this.#controller.abort(new Error(message)), timeoutMs)
  }

  /**
   * 总时长兜底：**不**随数据续期。
   *
   * 存在的理由：上游持续慢速吐数据（每次间隔 < idle 超时，idle 计时器永远被续期）时，
   * 只有总时长上限能把请求收掉，否则它会永远挂住。
   */
  armTotal(timeoutMs: number, message: string): void {
    if (this.#disposed || this.#controller.signal.aborted) return
    if (this.#totalTimer) clearTimeout(this.#totalTimer)
    this.#totalTimer = setTimeout(() => this.#controller.abort(new Error(message)), timeoutMs)
  }

  /** 释放：清计时器 + 摘监听器。**必须**放 `finally`，否则异常路径会漏 */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    if (this.#totalTimer) clearTimeout(this.#totalTimer)
    this.#idleTimer = undefined
    this.#totalTimer = undefined
    if (this.#outer) this.#outer.removeEventListener('abort', this.#onOuterAbort)
  }
}
