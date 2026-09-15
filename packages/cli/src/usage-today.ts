/**
 * @harness/cli - 当日（跨会话）用量归集
 *
 * 与 usage-stats.ts 分离的原因：
 * 1. 本模块带 IO（读持久化会话文件），而 usage-stats.ts 保持纯函数、可单测；
 * 2. index.ts 与 tui.tsx 互相 import（存在循环），公共逻辑不能放进任一文件，
 *    否则会加重循环依赖。
 *
 * 设计要点：
 * - 只读持久化文件、不写回，因此重连（resume）前当天产生的用量依然可归集；
 * - 按会话 updatedAt 过滤当天有更新的会话，避免全量加载历史会话；
 * - 当前会话无条件参与归集（可能 updatedAt 早于今天零点但仍有当日用量）；
 * - 任一步失败都回落到「仅当前会话」的当日用量，绝不阻塞主流程。
 */
import {
  dayStart,
  todayUsage,
  sumUsage,
  hydrateUsage,
  isBlankUsage,
  emptyUsage,
  type UsageStats,
} from './usage-stats'

/** 归集所需的最小会话存储接口（结构化约束，避免与 HarnessApp 产生循环依赖） */
export interface UsageStoreLike {
  list(): Promise<Array<{ id: string; updatedAt?: number }>>
  load(id: string): Promise<unknown | undefined>
}

/** 归集所需的最小会话视图（Session / 磁盘会话文件均满足） */
export interface UsageSessionLike {
  id: string
  meta?: Record<string, unknown>
  messages?: Array<{
    meta?: Record<string, unknown>
    createdAt?: number
    parts?: Array<{ type: string; toolId?: string; isError?: boolean }>
  }>
}

/**
 * 归集当日（本地时区）跨会话用量。
 *
 * @param store 会话存储；缺省时退化为仅统计 current
 * @param current 当前会话（内存态优先，避免重复读盘）
 * @param now 时间基准（便于测试）
 */
export async function collectTodayUsage(
  store: UsageStoreLike | undefined,
  current: UsageSessionLike | undefined,
  now: number = Date.now(),
): Promise<UsageStats> {
  if (!current) return emptyUsage()
  const from = dayStart(now)
  try {
    if (store) {
      const list = await store.list()
      // 只加载当天有更新的会话
      const ids = list.filter((s) => (s.updatedAt ?? 0) >= from).map((s) => s.id)
      // 当前会话无条件纳入：新建会话可能尚未落盘，此时 list() 里没有它，
      // 若只按 list 归集会漏掉当前会话的当日用量（TUI 侧栏「今日」不增长）。
      if (!ids.includes(current.id)) ids.unshift(current.id)
      const files = await Promise.all(
        ids.map((id) =>
          id === current.id ? Promise.resolve<unknown>(current) : store.load(id).catch(() => undefined),
        ),
      )
      const per = files.map((f) => (f ? todayUsage(hydrateUsage(f as UsageSessionLike), now) : emptyUsage()))
      const merged = sumUsage(per)
      if (!isBlankUsage(merged)) return merged
    }
  } catch {
    // 归集失败回落当前会话
  }
  return todayUsage(hydrateUsage(current), now)
}
