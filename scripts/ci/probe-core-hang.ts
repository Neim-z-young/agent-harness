/**
 * ⚠️ **临时诊断脚本**（2026-10-13）：在 `packages/core/src/step-gate.test.ts` 里
 * **逐条用例**地跑，用**自己的硬超时**找出到底哪一条永不返回。
 *
 * ## 为什么要这么绕
 * 实测（CI run 38349918446）：`@harness/core` 在 Windows 上挂住 —— 该包**无汇总行、无退出行**，
 * 日志停在 `step-gate.test.ts`（`bun test` 的默认超时**没有触发**，本仓已知：异步用例永不 settle 时
 * bun 不报超时）。`if: always()` 拿到的部分日志只能指到"文件级 + 约等于最后打印的那条"，
 * 而输出经过管道可能有缓冲 ⇒ 不能据此断定具体是哪条。
 *
 * 于是换个做法：**不依赖 bun test 的超时**，由本脚本用 `spawnSync(..., { timeout })` 给每条用例
 * 一个硬上限（45s），并打印退出状态。正常用例 1-5 秒；挂住的那条会被杀掉并以 `KILLED` 记名。
 *
 * ## 为什么不用 `timeout` 命令
 * Windows 的 `System32\timeout.exe` 是另一个程序（只"暂停若干秒"，不执行命令），
 * 而 `spawnSync` 的 `timeout` 选项是 Node/Bun 自带的，跨平台且不依赖 PATH —— 更稳。
 *
 * ## 何时删掉
 * 定位到具体用例、修好之后删掉本文件与 workflow 里那一步。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const CORE = join(REPO, 'packages', 'core')
const TEST_FILE = 'src/step-gate.test.ts'
const PER_TEST_TIMEOUT_MS = 45_000

/** 从测试文件里抽出所有 `it('…')` 的标题（保持文件顺序） */
function titles(): string[] {
  const src = readFileSync(join(CORE, TEST_FILE), 'utf-8')
  const out: string[] = []
  const re = /^\s*it\('([^']+)'/gm
  for (const m of src.matchAll(re)) out.push(m[1]!)
  return out
}

const all = titles()
console.log(`platform=${process.platform} bun=${process.versions.bun ?? 'n/a'}`)
console.log(`step-gate.test.ts 共 ${all.length} 条用例，逐条跑（单条上限 ${PER_TEST_TIMEOUT_MS / 1000}s）`)

const hung: string[] = []
const started = Date.now()
for (const [i, name] of all.entries()) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, ['test', TEST_FILE, '-t', name], {
    cwd: CORE,
    timeout: PER_TEST_TIMEOUT_MS,
    encoding: 'utf-8',
  })
  const ms = Date.now() - t0
  // `status === null` + `signal` 有值 ⇒ 被我们的 timeout 杀掉
  const killed = r.status === null && r.signal !== null
  if (killed) hung.push(name)
  console.log(
    `[${i + 1}/${all.length}] ${killed ? 'KILLED' : `rc=${r.status}`} ${ms}ms :: ${name}`,
  )
}

const totalSec = Math.round((Date.now() - started) / 1000)
console.log(`RESULT=done ${all.length} 条，总耗时 ${totalSec}s`)
if (hung.length > 0) {
  console.log(`RESULT=HUNG_COUNT=${hung.length}`)
  for (const h of hung) console.log(`RESULT=HUNG :: ${h}`)
} else {
  console.log('RESULT=NO_HANG（逐条跑都不挂 —— 见下面"整文件一起跑"的结果）')
}

// 补一步：**整文件**一起跑（与 CI 里真正的跑法一致）。
// 这一步是为了区分两种形态：
//   · 逐条跑挂 ⇒ 那条用例自身的问题；
//   · 逐条跑都好、整文件挂 ⇒ 跨用例共用状态 / 某个 handle 在文件级没释放（那样单条跑就复现不出来）。
const t1 = Date.now()
const whole = spawnSync(process.execPath, ['test', TEST_FILE], {
  cwd: CORE,
  timeout: 150_000,
  encoding: 'utf-8',
})
const wholeKilled = whole.status === null && whole.signal !== null
console.log(
  `RESULT=whole-file ${wholeKilled ? 'KILLED' : `rc=${whole.status}`} ${Math.round((Date.now() - t1) / 1000)}s`
  + (wholeKilled ? '' : `，最后几行：\n${(whole.stdout ?? '').split('\n').slice(-6).join('\n')}`),
)
