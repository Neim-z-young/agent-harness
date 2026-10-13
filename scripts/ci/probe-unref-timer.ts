/**
 * ⚠️ **临时诊断脚本**（2026-10-13）：只回答一个问题 ——
 * **`unref()` 过的定时器在当前平台上会不会真的触发？**
 *
 * ## 为什么要问这个
 * CI 首轮实测：Windows 的测试步骤挂住 25 分钟被超时杀掉，日志显示卡在
 * `@harness/core` 的 `src/step-gate.test.ts` **第一条真引擎用例**上（该包无汇总、无退出行），
 * 而它在下游 ⇒ 另外 22 个包一个都没启动。
 *
 * 那条用例第一次真正走 `core.agent.step.gate` 的等待路径，而等待用的是 `sleepAbortable()`：
 *
 * ```ts
 * const timer = setTimeout(() => { cleanup(); resolve() }, ms)
 * ;(timer as unknown as { unref?: () => void }).unref?.()
 * ```
 *
 * 若某个平台上 `unref()` 会让定时器**永不到期**，那么这个 `await` 永不 settle ⇒
 * 用例永远不结束（本仓已知：异步用例永不 settle 时 bun 不超时报错）。
 * 本机（macOS）验不出这件事 —— 这正是它需要跑在 Windows runner 上的原因。
 *
 * ## 设计约束
 * **探针自己绝不能挂**：看门狗定时器**不 unref**，5s 必到，到了就判"没触发"并退出。
 * 输出用 `RESULT=` 前缀，方便在 CI 日志里 `grep`。
 *
 * ## 何时删掉
 * 拿到结论后删：若是 `unref` 的问题 ⇒ 修 `sleepAbortable`；若不是 ⇒ 换别的假设继续查。
 */

const log = (s: string): void => {
  process.stdout.write(`${s}\n`)
}

log(`platform=${process.platform} bun=${process.versions.bun ?? 'n/a'}`)

const anyTimer = setTimeout(() => {}, 0) as unknown as { unref?: () => void; ref?: () => void }
log(`RESULT=unref-available:${typeof anyTimer.unref === 'function'}`)
clearTimeout(anyTimer as unknown as ReturnType<typeof setTimeout>)

let watchdogArmed = true
const watchdog = setTimeout(() => {
  if (!watchdogArmed) return
  log('RESULT=unref-timer-NEVER-FIRED')
  process.exit(0)
}, 5_000)

// 与 `sleepAbortable` **同形**：一个被 unref 的定时器，await 它
await new Promise<void>((resolve) => {
  const timer = setTimeout(() => {
    log('probe: callback ran')
    resolve()
  }, 50)
  ;(timer as unknown as { unref?: () => void }).unref?.()
})

watchdogArmed = false
clearTimeout(watchdog)
log('RESULT=unref-timer-FIRED')
