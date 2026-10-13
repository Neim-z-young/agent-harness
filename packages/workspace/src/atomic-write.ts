/**
 * @harness/workspace —— 原子写（tmp + rename）
 *
 * ## 为什么要抽成公共模块
 * 本包原有 **3 处**各自手写"tmp + rename"（`storage.ts` 1 处、`compaction-store.ts` 2 处），
 * 它们对 Windows 的态度不一致，而且都挡不住同一个平台问题：
 *
 * - **`rename` 在 Windows 上会抛 `EPERM`**：并发写同一目标时，另一个写入者（或杀毒 / 索引器）
 *   短暂持有目标句柄即失败（CI 实测：`Promise.all` 并发写 `last-session.json` **必现**）。
 *   这是平台语义，不是路径写错 ⇒ 有界重试 + 小退避即可稳定。
 * - **tmp 名必须带随机串**：原 `compaction-store` 用 `${p}.${process.pid}.tmp`——同进程并发写
 *   同一目标时两个调用**拿到同一个 tmp 名**，互相覆盖/`ENOENT`。随机串是这里的必要条件。
 *
 * 另：tmp 必须落在**同一目录**（否则跨文件系统 rename 在部分平台会失败或退化为拷贝）。
 */

import { rm, rename, writeFile } from 'node:fs/promises'

/**
 * `rename` 的**瞬时**错误码：Windows 上目标被短暂持有时的典型返回；
 * POSIX 的 `rename` 是原子的、几乎不给这些码 ⇒ 重试对既有行为无影响。
 */
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
/** 重试上限（配合下面的退避，总等待 < 100ms） */
const RENAME_RETRY_MAX = 8

/** 该错误值不值得重试（只认 `code`，别的错误立刻抛出，不掩盖真问题） */
export function isRetryableRenameError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return typeof code === 'string' && RENAME_RETRY_CODES.has(code)
}

/**
 * 原子写：先写临时文件再 `rename` 到目标路径；失败时清理 tmp（不留半截 `.tmp`）。
 *
 * 退避用**非 unref** 的定时器 —— 它被 `await`；`unref` 过的等待定时器在 Windows 上不会到期
 * （见 `core/src/index.ts` 的 `sleepAbortable` 注释与 `host/src/unref-guard.test.ts` 守卫）。
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, content)
    let lastErr: unknown
    for (let attempt = 0; attempt < RENAME_RETRY_MAX; attempt++) {
      try {
        await rename(tmp, path)
        return
      } catch (err) {
        lastErr = err
        if (!isRetryableRenameError(err)) break
        // 退避 1→2→4→…→ 封顶 50ms：让持有目标句柄的一方先松手
        await new Promise((r) => setTimeout(r, Math.min(50, 1 << attempt)))
      }
    }
    throw lastErr
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}
