/**
 * 当日（跨会话）用量归集单测。
 *
 * 用假 store 精确控制 list/load 行为，覆盖：
 * - 跨会话合并
 * - 历史会话不被加载（避免全量 IO）
 * - 当前会话即使 updatedAt 早于今天零点也纳入归集
 * - store 异常时回落「仅当前会话」
 */
import { describe, it, expect } from 'bun:test'
import { collectTodayUsage, type UsageStoreLike, type UsageSessionLike } from './usage-today'
import { emptyUsage, recordCall, USAGE_STATS_KEY, type UsageStats } from './usage-stats'

/** 取某天 hh 点的时间戳 */
function at(dayOffset: number, hour: number): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

/** 构造会话视图：用量写进 meta（与真实持久化一致） */
function sess(id: string, stats: UsageStats): UsageSessionLike {
  return { id, meta: { [USAGE_STATS_KEY]: stats }, messages: [] }
}

function call(dayOffset: number, hour: number, input: number): UsageStats {
  return recordCall(emptyUsage(), { model: 'm', input, output: 1, ts: at(dayOffset, hour) })
}

/** 假 store：sessions 为「磁盘」上的会话，loadLog 记录被加载的 id */
function fakeStore(
  sessions: UsageSessionLike[],
  metaOf: Record<string, number>,
): { store: UsageStoreLike; loaded: string[] } {
  const loaded: string[] = []
  return {
    loaded,
    store: {
      async list() {
        return sessions.map((s) => ({ id: s.id, updatedAt: metaOf[s.id] ?? 0 }))
      },
      async load(id: string) {
        loaded.push(id)
        return sessions.find((s) => s.id === id)
      },
    },
  }
}

describe('collectTodayUsage', () => {
  it('合并当天多个会话的用量', async () => {
    const a = sess('a', call(0, 9, 100))
    const b = sess('b', call(0, 10, 200))
    const { store } = fakeStore([b], { b: at(0, 10) })
    const t = await collectTodayUsage(store, a)
    expect(t.llmCalls).toBe(2)
    expect(t.inputTokens).toBe(300)
  })

  it('不加载早于今天零点的历史会话（避免全量 IO）', async () => {
    const a = sess('a', call(0, 9, 100))
    const old = sess('old', call(-3, 9, 5000))
    const { store, loaded } = fakeStore([old], { old: at(-3, 9) })
    const t = await collectTodayUsage(store, a)
    expect(loaded).toEqual([])
    expect(t.llmCalls).toBe(1)
    expect(t.inputTokens).toBe(100)
  })

  it('当前会话即使 updatedAt 早于今天零点也纳入归集', async () => {
    // 场景：昨晚开始的长会话，updatedAt 还停在昨天，但 meta 里已有今天的小时桶
    const a = sess('a', call(0, 1, 42))
    const { store } = fakeStore([a], { a: at(-1, 23) })
    const t = await collectTodayUsage(store, a)
    expect(t.llmCalls).toBe(1)
    expect(t.inputTokens).toBe(42)
  })

  it('只统计今天的小时桶，昨天的用量不计入', async () => {
    let both = emptyUsage()
    both = recordCall(both, { model: 'm', input: 1000, output: 10, ts: at(-1, 10) })
    both = recordCall(both, { model: 'm', input: 300, output: 30, ts: at(0, 10) })
    const a = sess('a', both)
    const { store } = fakeStore([], {})
    const t = await collectTodayUsage(store, a)
    expect(t.llmCalls).toBe(1)
    expect(t.inputTokens).toBe(300)
  })

  it('store 抛错时回落为仅当前会话，不抛异常', async () => {
    const a = sess('a', call(0, 9, 100))
    const broken: UsageStoreLike = {
      async list() { throw new Error('disk gone') },
      async load() { throw new Error('disk gone') },
    }
    const t = await collectTodayUsage(broken, a)
    expect(t.llmCalls).toBe(1)
    expect(t.inputTokens).toBe(100)
  })

  it('无 store 时退化为仅统计当前会话', async () => {
    const a = sess('a', call(0, 9, 100))
    const t = await collectTodayUsage(undefined, a)
    expect(t.llmCalls).toBe(1)
  })

  it('无当前会话时返回空累积器', async () => {
    const t = await collectTodayUsage(undefined, undefined)
    expect(t.llmCalls).toBe(0)
  })
})
