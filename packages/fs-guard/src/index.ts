/**
 * `@harness/fs-guard` —— 文件系统边界判定（**全仓唯一一份**）
 *
 * ## 为什么要单独一个包（P3-1）
 * `resolvePath` / `isWithinCwd` 这两个函数曾在 **6 个包各写一份**（`tools-builtin` /
 * `tools-glob` / `tools-search` / `tools-media` / `code-intel` / `subagent`）—— 安全边界
 * **修一处漏五处**，且语义已经开始漂移（有的只比字符串、有的比真实路径）。
 *
 * 不放进 `@harness/tool` 的原因：`code-intel` 的 `core.ts` / `server.ts` 刻意**不 import
 * `@harness/tool`**（它要能脱离 harness 单独跑），而它恰恰是副本之一。本包**零依赖**
 * （只有 `node:*`），谁都能引。
 *
 * ## P0-4：字符串判定守不住符号链接
 * 改造前是 `isWithinCwd = !relative(cwd, p).startsWith('..')` + `resolvePath = resolve`，
 * 全程不解析符号链接 ⇒ 工作目录里一条 `ln -s /etc secret` 就让 `secret/passwd` 的
 * `relative` 变成 `secret/passwd`（**判定通过**），而 `stat` / `open` 会跟着链接读到外部。
 * 现在两步都落到**真实路径**（`realpath`）上再比。
 *
 * ## 两条纪律
 * 1. `resolvePath` **不碰文件系统**（保持纯字符串），它产出的路径是真正拿去 `open` 的那个；
 *    边界判定则由 `isWithinCwd` 单独做 —— 两者分开，是为了让"写入一个还不存在的新文件"
 *    这条路径不被 realpath 的 ENOENT 影响。
 * 2. 目标不存在（新建文件）是常态 ⇒ 真实路径按**逐级上溯到最近存在的祖先**再拼回剩余段
 *    （`realpathBestEffort`）。cwd 自身也走同一函数 —— 否则 macOS 上 `/var` → `/private/var`
 *    这类合法链接会把"目录本身在链接下"误判成越界。
 *
 * ## 已知边界（有意不堵）
 * 目标路径上有一环是**悬空**符号链接（指向不存在的路径）时，`realpath` 抛 ENOENT ⇒ 我们
 * 把它当作"不存在的一段"拼回去，判定结果为"在 cwd 内"。此时后续 `open` **也会失败**
 * （ENOENT），所以不构成逃逸面。真要做符号链接级强隔离，是 L2（OS 级只读绑定）的事。
 */

import { isAbsolute, resolve, relative, dirname, basename, join, sep } from 'node:path'
import { realpathSync } from 'node:fs'

/**
 * 把路径解析为绝对路径（相对 `cwd`）。**纯字符串运算，不触碰文件系统**。
 *
 * 产出的是真正拿去 `open` / `stat` 的那个路径 —— 保留符号链接（不做 realpath），
 * 因为 realpath 对"还不存在的新文件"会抛错。边界判定交给 {@link isWithinCwd}。
 */
export function resolvePath(inputPath: string, cwd: string): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath)
}

/**
 * 取路径的**真实位置**（跟随符号链接）；路径不存在时**逐级上溯到最近存在的祖先**，
 * 再把剩下的段拼回去。
 *
 * 逐级上溯是为"新建文件"服务的：`<cwd>/a/b.txt` 里的 `b.txt` 与 `a` 都可能还不存在，
 * 但最终落盘位置仍必须被判定为"在 `<cwd>` 内"。
 *
 * 到根都取不到真实路径（极端情况：根不可达）⇒ 退回 `resolve(p)` 的结果。
 */
export function realpathBestEffort(p: string): string {
  const abs = resolve(p)
  let cur = abs
  const rest: string[] = []
  for (;;) {
    try {
      const real = realpathSync(cur)
      return rest.length === 0 ? real : join(real, ...rest)
    } catch {
      /* `cur` 不存在 / 不可达 ⇒ 退到上一级再试 */
    }
    const parent = dirname(cur)
    if (parent === cur) return abs // 到根了还是没有 ⇒ 退回 resolve 结果
    rest.unshift(basename(cur))
    cur = parent
  }
}

/**
 * 真实路径版的包含判定：`p === root` 或在 `root` 之下。**两个入参都应已是真实路径**
 * （由 {@link realpathBestEffort} 产出），本函数只看字符串。
 *
 * 边界细节（与改造前那 6 份副本的差别）：
 * - 兄弟目录不算在内：`root=/a/b` 时 `/a/bc` 落在外面（`relative` 给 `../bc`）；
 * - `..` 只认**整段**：`root=/a/b` 时 `/a/b/..foo` 是 `..foo` 段，**算在内部**
 *   （老实现用 `startsWith('..')`，会把 `..foo` 误判成越界 —— 一个只会误杀的假阳性）。
 */
export function isWithinRoot(p: string, root: string): boolean {
  const rel = relative(root, p)
  if (rel === '') return true // 就是根本身
  if (isAbsolute(rel)) return false // 不同盘符 / 根（Windows）
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * `filePath` 是否**真实落在** `cwd` 内（含 `cwd` 本身）。
 *
 * 两侧都取真实路径 ⇒ 一条 `ln -s /etc secret` 之后 `secret/passwd` 会被判成**界外**，
 * 而不是像改造前那样"字符串看着在里头，`open` 却读了外面"。
 */
export function isWithinCwd(filePath: string, cwd: string): boolean {
  return isWithinRoot(realpathBestEffort(filePath), realpathBestEffort(cwd))
}
