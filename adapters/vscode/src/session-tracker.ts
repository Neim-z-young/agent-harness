/**
 * 「当前会话」承载点（P3-D，设计稿 §14.2 ③）。
 *
 * ## 为什么需要它
 *
 * P2 的会话归属靠 `ChatResult.metadata` 在**轮次之间**传递（`TurnState`，见 `participant.ts`）——
 * 因为 `ChatContext` 只有 `history`、没有 session id。
 *
 * 但 **Copilot 的 `lm.invokeTool` 发生在参与者轮次之外**：那时候既没有 `ChatContext`
 * 也没有 `TurnState` 可读。于是必须有一个**跨轮次、模块级**的"当前会话"落点。
 *
 * ## 三条纪律
 *
 * 1. **`get()` 拿不到就返回 `undefined`，绝不回落**。回落 sidecar 的 boot 会话
 *    （`contextId` 缺省时 A2A 会新建/复用）会把工具执行的遥测、事实事件、权限询问
 *    全部记到**另一个会话**上 —— "归属不明就挑一个"正是本仓反复栽过的那类静默失效。
 *    调用方拿到 `undefined` 时必须**明确报错**。
 * 2. **只认非空字符串**：空白串 / `undefined` 一律当"没设置"（`set(undefined)` 是空操作），
 *    因为 `extractTaskIds` 的返回是可选的，调用点写成 `tracker.set(ids.contextId)` 最省事，
 *    而"把 undefined 写进去"必须等于"什么都没发生"。
 * 3. **不持有会话对象**，只持有 id 字符串 —— 会话内容在 sidecar 里，扩展这侧只做归属转发。
 */
export class SessionTracker {
  private current: string | undefined

  /** 记下当前会话（`undefined` / 空白串 = 空操作，见纪律 2） */
  set(sessionId: string | undefined): void {
    if (typeof sessionId !== 'string') return
    const trimmed = sessionId.trim()
    if (trimmed === '') return
    this.current = trimmed
  }

  /** 当前会话 id；未绑定时 `undefined`（**不回落**，见纪律 1） */
  get(): string | undefined {
    return this.current
  }

  /** 是否已绑定（调用方想先问一句"有没有"时用） */
  get bound(): boolean {
    return this.current !== undefined
  }

  /** 清空（重新绑定到别的会话之前、或扩展停用时） */
  clear(): void {
    this.current = undefined
  }
}
