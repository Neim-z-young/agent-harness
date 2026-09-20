/**
 * 通用 JSONL 追加写入器。
 *
 * 提升自 `@harness/acp-context` 的 `createWriter`，泛型化为通用模块：
 *  - debounce 批量 flush，避免每事件一次 IO；
 *  - 失败静默吞掉（遥测影响不了主流程）；
 *  - 无 path 时为 no-op writer（关闭遥测时 0 开销）。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export interface JsonlWriter<T> {
  /** 追加一条对象；实际落盘在 flush（debounce）时执行 */
  write(entry: T): void
  /** 立即 flush（正常退出 / 信号兜底时调用） */
  flush(): void
  /** 是否开启（无路径时为 false） */
  enabled: boolean
}

/**
 * 创建 JSONL 写入器。
 * @param path 目标文件路径；传 undefined 返回 no-op（关闭）
 * @param debounceMs 批量 flush 间隔
 */
export function createJsonlWriter<T>(path: string | undefined, debounceMs = 500): JsonlWriter<T> {
  if (!path) return { write: () => {}, flush: () => {}, enabled: false }

  let pending: T[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const doFlush = () => {
    if (pending.length === 0) return
    try {
      if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
      const lines = pending.map((l) => JSON.stringify(l)).join('\n') + '\n'
      writeFileSync(path, lines, { flag: 'a' })
    } catch {
      // 遥测失败不致命
    }
    pending = []
    timer = null
  }

  return {
    enabled: true,
    write(entry: T) {
      pending.push(entry)
      if (timer === null) timer = setTimeout(doFlush, debounceMs)
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      doFlush()
    },
  }
}