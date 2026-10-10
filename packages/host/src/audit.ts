/**
 * @harness/host —— 人工决策审计落盘（M3 `decision.human`）
 *
 * ## 为什么在 host 而不是各宿主
 * 审计事件（{@link HumanDecisionEvent}）是**权限接缝的产物**，而权限引擎只有一份
 * （`./permission.ts` 的 `InteractivePermissionEngine`，三个宿主共用）。落盘实现若各宿主
 * 各写一份，就会出现「CLI 落了、A2A 没落」这类**静默残缺**：同一条人工决策，换个宿主
 * 就没有审计记录 —— 而审计的价值恰恰在于不漏。
 *
 * ## 零内容纪律
 * 写入的只有事件信封本身（标量 + `stateHash`），入参原文**不进**文件 —— 与遥测同一条
 * 「可复核不可逆推」的约束，见 {@link HumanDecisionEvent}。
 *
 * ## 失败语义（best-effort，绝不反向影响会话）
 * 落盘失败（磁盘满 / 权限不足）**静默吞掉**：审计是旁路，不该因为写不进文件就让一次
 * 已经由人做出的放行/拒绝失败。这与遥测 writer 的失败静默是同一纪律。
 *
 * ## 为什么用同步 append 而不是遥测的防抖 writer
 * 审计写入频率极低（一次人工决策一条），防抖收益为零；而防抖会在进程被 kill 时丢掉
 * 尾部事件 —— 审计最不能接受的正是"最后那几条没了"。同步 append 保证"函数返回即已落盘"。
 * 也因此**不依赖** `@harness/telemetry`（那是内置插件包，host 对它只有惰性引用，
 * 静态 import 会把"按需"变成"总是进 bundle"）。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HumanDecisionEvent } from './permission'

/**
 * 创建人工决策审计 sink：按会话写 `{dataDir}/sessions/{sessionId}.audit.jsonl`。
 *
 * - **无 `sessionId` 的事件直接丢弃**（事件本身可缺，属审计完整性而非安全问题）；
 * - 目录按需创建（首次写入某会话时 `mkdir -p`，后续复用）；
 * - 任何写入异常静默（见文件头「失败语义」）。
 *
 * @param dataDir 数据根目录（宿主 workspace 的 dataDir；会话目录在其下 `sessions/`）
 */
export function createAuditSink(dataDir: string): (env: HumanDecisionEvent) => void {
  /** 已确保存在过的目录（避免每条都 mkdir） */
  const readyDirs = new Set<string>()
  return (env) => {
    if (!env.sessionId) return
    const path = join(dataDir, 'sessions', `${env.sessionId}.audit.jsonl`)
    try {
      const dir = dirname(path)
      if (!readyDirs.has(dir)) {
        mkdirSync(dir, { recursive: true })
        readyDirs.add(dir)
      }
      appendFileSync(path, `${JSON.stringify(env)}\n`, 'utf8')
    } catch {
      // 审计 best-effort：写不进去不改变决策结果，也不抛给调用方
    }
  }
}
