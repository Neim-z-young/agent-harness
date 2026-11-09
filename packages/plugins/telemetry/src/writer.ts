/**
 * 通用 JSONL 追加写入器。
 *
 * 提升自 `@harness/acp-context` 的 `createWriter`，泛型化为通用模块：
 *  - 批量 flush（首次写入后固定 `flushIntervalMs` 落一次，**不是** debounce：
 *    空闲时才重置窗口会让高频写入永不落盘 —— 遥测宁可多几次 IO，也要保证有界延迟）；
 *  - 失败静默吞掉（遥测影响不了主流程），但**记账**到 `dropped`：静默不等于无痕，
 *    否则"遥测文件少了一半"与"根本没产生事件"在宿主机上完全同形；
 *  - 无 path 时为 no-op writer（关闭遥测时 0 开销）。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export interface JsonlWriter<T> {
  /** 追加一条对象；实际落盘在 flush（批量间隔）时执行 */
  write(entry: T): void
  /** 立即 flush（正常退出 / 信号兜底时调用） */
  flush(): void
  /** 是否开启（无路径时为 false） */
  enabled: boolean
  /** 累计因写盘失败而丢弃的条目数（只增不减，供诊断） */
  readonly dropped: number
}

/**
 * 创建 JSONL 写入器。
 * @param path 目标文件路径；传 undefined 返回 no-op（关闭）
 * @param flushIntervalMs 批量 flush 间隔
 */
export function createJsonlWriter<T>(path: string | undefined, flushIntervalMs = 500): JsonlWriter<T> {
  let dropped = 0
  if (!path) return { write: () => {}, flush: () => {}, enabled: false, get dropped() { return dropped } }

  let pending: T[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const doFlush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.length === 0) return
    const batch = pending
    pending = []
    try {
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(path, batch.map((l) => JSON.stringify(l)).join('\n') + '\n', { flag: 'a' })
    } catch {
      // 遥测失败不致命：本批丢弃，但记账（否则只剩"文件里没有"这一种现象）
      dropped += batch.length
    }
  }

  return {
    enabled: true,
    get dropped() {
      return dropped
    },
    write(entry: T) {
      pending.push(entry)
      if (timer === null) timer = setTimeout(doFlush, flushIntervalMs)
    },
    flush() {
      doFlush()
    },
  }
}