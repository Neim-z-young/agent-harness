/**
 * `unref()` 的**跨平台守卫**（2026-10-13）
 *
 * ## 为什么需要（一次真实的 CI 事故）
 * CI 的 `windows-latest` 上，`core` / `cli` / `a2a-server` **三个包整包挂住**（各 240s 被
 * 逐包超时杀掉，一个用例都没跑完），下游包跟着起不来。日志显示：每个包都停在"某条需要
 * **等待**的用例"上，此后再无输出。
 *
 * 共同点不是包，而是**等待原语**：三处的等待都是 `setTimeout(...)` 后 `.unref()`，
 * 而那个 promise 正被 `await`。
 *
 * ## 根因（上游实锤，不是本仓推理）
 * Bun 在 Windows 上有个已知缺陷：当事件循环里**只剩 `unref` 过的工作**时，
 * `uv__loop_alive()` 为 0 ⇒ `uv_run()` **整段跳过 `uv_poll`**，这些定时器**永不到期**；
 * 而 `bun:test` 的驱动器只会空转（busy-spin），既不推进也不报超时 ⇒ **静默挂死**。
 *   - upstream：#32014（条件闸驱动器 busy-spin）、#33334 / #34158（unref 定时器同族）、
 *     #34478（同机制在 spawn 上的修复与逐字分析）；
 *   - 同形第三方复现：gbrain#5332（Bun 1.3.14，症状＝"打完已通过的用例后无限阻塞"，
 *     结论＝"`timer.unref()` 是触发点，改用非 unref 的 `setTimeout` 即可"）。
 *
 * ⚠️ 这也解释了两个"看起来矛盾"的现象，别再用它们否定此结论：
 *   1. **早先的探针报 FIRED 是被自身污染的** —— 它带一个**不 unref 的 5s 看门狗**，
 *      正是那个 ref 句柄把事件循环吊住，unref 定时器才有机会跑；
 *   2. **`mcp-server` 的同款 unref 定时器测试却通过** —— 因为那个用例有 `Bun.serve`
 *      的正在监听的 socket（ref 句柄）在场。是巧合，不是语义。
 *
 * ## 判据
 * 1. 全仓**非测试**源码里，`.unref` 调用**只能出现在白名单**里，每条都写明"它为什么
 *    不会让某个 `await` 永不 settle"（即：那个定时器的回调**不被 await**，且有别的
 *    ref 句柄保活）。
 *    —— **被 await 的等待定时器一律不得 unref**；想"不钉住进程退出"请走 `signal`
 *    中断 / 显式 shutdown，而不是把这次等待本身取消掉。
 * 2. **双向**：白名单里的条目必须仍能在源码里找到对应调用 —— 防"白名单腐烂"
 *    （条目留着、代码早改走了，下一个看白名单的人就被误导）。
 * 3. **控制组**：断言扫描集合非空（读到足够多的源文件）—— 防"扫描路径写错 ⇒ 永远绿"
 *    这种退化解（与 `repo-scripts-guard.test.ts` / `plugin-shell-requirement.test.ts` 同纪律）。
 *
 * ⚠️ 守卫能抓的是"**有人把等待定时器 unref 回去**"这一类静默回归；它**不能**证明
 * Windows 上真跑通（那需要真机 / CI）。它挡的是"改一行就把三个包重新挂死"。
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, relative } from 'node:path'
// toPosix 只保留一份（`./files`）：测试里再定义一个"同名不同源"的副本，迟早与实现漂移
// —— 本仓已见过 `lookupEnvCI` 双份漂移的实录。
import { toPosix } from './files'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/**
 * 相对仓库根的路径，**统一折成 `/`**。
 *
 * ⚠️ 必须折：Windows 上 `relative()` 给的是 `packages\cli\src\index.ts`，而白名单键写的是
 * `packages/cli/src/index.ts` —— 不折就会把两个**已白名单**的文件当成"未白名单命中"
 * （本守卫首轮 CI 就踩了这条，与 `fs-guard` 的 `PathDialect` 是同一类坑）。
 */
function relPosix(abs: string): string {
  return toPosix(relative(REPO_ROOT, abs))
}

/**
 * 白名单：允许保留 `.unref` 的**源码文件** → 理由（必须说明"回调不被 await"）。
 * 新增条目 = 你在声称"这个定时器不参与任何 await 的结算"，请把理由写足。
 */
const ALLOWED_UNREF: Record<string, string> = {
  'packages/cli/src/index.ts':
    'startStallNotice 的**心跳**定时器：回调只是往终端打一行提示，没有任何人 await 它；' +
    '且 CLI 的 readline/TUI 句柄本身就是 ref 的，不存在"只剩 unref 工作"的状态',
  'packages/plugins/herdr/src/index.ts':
    'kill 超时定时器：回调只是 child.kill()，不被 await；且被 kill 的子进程句柄本身是 ref 的',
}

/** 判据：这一行是不是一次**真正的 `unref` 调用**（先剥掉注释行，免得把说明文字当命中） */
export function isUnrefCallLine(line: string): boolean {
  const t = line.trim()
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
  // `.unref?.()` 里的 `?.` 是**可选链**（`unref` + `?.` + `()`），不是"可选的 `?` 后接 `()`"；
  // 两者都要认（本仓两种写法都存在过）。
  return /\.unref(?:\?\.)?\(\)/.test(line)
}

/** 递归收集 `packages/**` 下的**非测试**源文件（`packages/plugins/*` 也在内） */
function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue
        walk(p)
        continue
      }
      if (!/\.tsx?$/.test(e.name)) continue
      if (/\.test\.tsx?$/.test(e.name)) continue // 测试文件不参与（守卫自身也在其中）
      out.push(p)
    }
  }
  walk(join(REPO_ROOT, 'packages'))
  return out
}

interface UnrefHit {
  file: string
  line: number
  text: string
}

/** 全仓非测试源码里的 `.unref` 调用 */
function unrefCalls(): UnrefHit[] {
  const hits: UnrefHit[] = []
  for (const abs of sourceFiles()) {
    const lines = readFileSync(abs, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (isUnrefCallLine(line)) {
        hits.push({ file: relPosix(abs), line: i + 1, text: line.trim() })
      }
    })
  }
  return hits
}

describe('等待定时器不得 unref（Bun/Windows 会因此整包挂死）', () => {
  it('★`.unref` 只出现在白名单文件里（被 await 的等待定时器一律不得 unref）', () => {
    const offenders = unrefCalls().filter((h) => !(h.file in ALLOWED_UNREF))
    expect(offenders.map((h) => `${h.file}:${h.line}: ${h.text}`)).toEqual([])
  })

  it('★双向：白名单每条都仍能在源码里找到对应调用（防白名单腐烂）', () => {
    const files = new Set(unrefCalls().map((h) => h.file))
    const stale = Object.keys(ALLOWED_UNREF).filter((f) => !files.has(f))
    expect(stale).toEqual([])
  })

  it('控制组：扫描确实读到了源码（否则"零命中"是路径写错，不是干净）', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(100)
    // 白名单里的两个文件必须真的在扫描集合内（否则上一条会"因为扫不到"而假绿）
    for (const f of Object.keys(ALLOWED_UNREF)) {
      expect(files.some((abs) => relPosix(abs) === f)).toBe(true)
    }
  })

  it('反向自查：判据能抓到 unref 调用、且不把注释当命中（否则它是空转）', () => {
    expect(isUnrefCallLine(';(timer as unknown as { unref?: () => void }).unref?.()')).toBe(true)
    expect(isUnrefCallLine('timer.unref()')).toBe(true)
    // 注释行不算（本仓大量注释在解释 unref）
    expect(isUnrefCallLine('    // ★**不 unref**：这次等待是被 await 的')).toBe(false)
    expect(isUnrefCallLine(' * 定时器不 unref：因为……')).toBe(false)
    // 与 unref 无关的普通代码行不算
    expect(isUnrefCallLine('const timer = setTimeout(resolve, ms)')).toBe(false)
    // 路径归一：Windows 风格必须折成 `/`（否则白名单键对不上 —— 首轮 CI 就踩了这条）。
    // 这条断言在**任何平台**上都可验（不依赖 sep），这正是抽成纯函数的目的。
    expect(toPosix('packages\\cli\\src\\index.ts')).toBe('packages/cli/src/index.ts')
    expect(toPosix('packages/cli/src/index.ts')).toBe('packages/cli/src/index.ts')
    expect(toPosix('packages\\plugins\\herdr\\src\\index.ts')).toBe('packages/plugins/herdr/src/index.ts')
  })
})
