/**
 * usage-stats 单元测试：用量累积、持久化水合、当日归集与导出。
 *
 * 重点覆盖两类回归：
 * 1. 重连（resume）后用量不能从 0 开始 → hydrateUsage / shouldPersistUsage
 * 2. 历史消息不能被算到「今天」→ usageFromMessages 按 createdAt 归并小时桶
 */
import { describe, it, expect } from 'bun:test'
import {
  emptyUsage,
  recordCall,
  uncachedInput,
  dayStart,
  usageSince,
  todayUsage,
  mergeUsage,
  sumUsage,
  hydrateUsage,
  isBlankUsage,
  usageFromMeta,
  usageFromMessages,
  shouldPersistUsage,
  todayUsageLine,
  exportStatsJson,
  exportStatsMarkdown,
  USAGE_STATS_KEY,
  type UsageStats,
} from './usage-stats'

/** 取某天本地时间 hh:mm 的时间戳 */
function at(dayOffset: number, hour: number): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

function msg(tokenUsage: { input: number; output: number }, createdAt: number, model = 'mock/m1') {
  return { meta: { model, tokenUsage }, createdAt, parts: [{ type: 'text', text: 'x' }] }
}

describe('dayStart', () => {
  it('返回本地当天零点，且当天内任意时刻都落在同一天', () => {
    const now = Date.now()
    const s = dayStart(now)
    const d = new Date(s)
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
    expect(d.getSeconds()).toBe(0)
    expect(dayStart(now)).toBe(s)
  })

  it('昨天与今天零点不同', () => {
    expect(dayStart(at(-1, 10))).toBeLessThan(dayStart(at(0, 10)))
  })
})

describe('usageFromMessages 时间归属', () => {
  it('按消息 createdAt 归并小时桶（历史消息不算到今天）', () => {
    const u = usageFromMessages([
      msg({ input: 100, output: 10 }, at(-2, 9)),
      msg({ input: 200, output: 20 }, at(0, 9)),
    ])
    expect(u.llmCalls).toBe(2)
    expect(u.inputTokens).toBe(300)
    // 两个不同天的桶
    expect(u.hourly.length).toBe(2)
    // 今天只应命中 1 次调用 / 200 输入
    const t = todayUsage(u)
    expect(t.llmCalls).toBe(1)
    expect(t.inputTokens).toBe(200)
  })

  it('同一小时的多条消息归并到同一桶', () => {
    const u = usageFromMessages([
      msg({ input: 10, output: 1 }, at(0, 8)),
      msg({ input: 20, output: 2 }, at(0, 8)),
    ])
    expect(u.hourly.length).toBe(1)
    expect(u.hourly[0]!.calls).toBe(2)
    expect(u.hourly[0]!.inputTokens).toBe(30)
  })
})

describe('usageSince / todayUsage', () => {
  it('只统计 from 之后的小时桶', () => {
    let u = emptyUsage()
    u = recordCall(u, { model: 'm', input: 50, output: 5, ts: at(-1, 10) })
    u = recordCall(u, { model: 'm', input: 70, output: 7, ts: at(0, 10) })
    const t = todayUsage(u)
    expect(t.llmCalls).toBe(1)
    expect(t.inputTokens).toBe(70)
    expect(t.outputTokens).toBe(7)
    // 全量仍包含昨天
    expect(u.llmCalls).toBe(2)
    expect(u.inputTokens).toBe(120)
  })

  it('usageSince(0) 等于全量', () => {
    let u = emptyUsage()
    u = recordCall(u, { model: 'm', input: 1, output: 2, ts: at(0, 1) })
    expect(usageSince(u, 0).llmCalls).toBe(1)
  })

  it('无数据当天返回空累积器', () => {
    expect(isBlankUsage(todayUsage(emptyUsage()))).toBe(true)
  })
})

describe('mergeUsage / sumUsage', () => {
  it('跨会话合并时同小时桶相加', () => {
    let a = emptyUsage()
    a = recordCall(a, { model: 'm', input: 10, output: 1, ts: at(0, 10) })
    let b = emptyUsage()
    b = recordCall(b, { model: 'm', input: 30, output: 3, ts: at(0, 10) })
    const m = mergeUsage(a, b)
    expect(m.llmCalls).toBe(2)
    expect(m.hourly.length).toBe(1)
    expect(m.hourly[0]!.inputTokens).toBe(40)
    expect(m.hourly[0]!.outputTokens).toBe(4)
  })

  it('不同小时桶各自保留并升序', () => {
    let a = emptyUsage()
    a = recordCall(a, { model: 'm', input: 1, output: 1, ts: at(0, 10) })
    let b = emptyUsage()
    b = recordCall(b, { model: 'm', input: 2, output: 2, ts: at(0, 8) })
    const m = mergeUsage(a, b)
    expect(m.hourly.length).toBe(2)
    expect(m.hourly[0]!.hour).toBeLessThan(m.hourly[1]!.hour)
  })

  it('sumUsage 汇总多个会话', () => {
    let a = emptyUsage()
    a = recordCall(a, { model: 'm', input: 5, output: 1, ts: at(0, 9) })
    let b = emptyUsage()
    b = recordCall(b, { model: 'm', input: 6, output: 2, ts: at(0, 9) })
    expect(sumUsage([a, b, emptyUsage()]).inputTokens).toBe(11)
  })
})

describe('hydrateUsage 水合（重连不清零）', () => {
  it('meta 有数据时优先使用 meta', () => {
    let persisted = emptyUsage()
    persisted = recordCall(persisted, { model: 'm', input: 999, output: 9, ts: at(0, 9) })
    const u = hydrateUsage({ meta: { [USAGE_STATS_KEY]: persisted }, messages: [] })
    expect(u.llmCalls).toBe(1)
    expect(u.inputTokens).toBe(999)
  })

  it('meta 为空累积器时，由消息历史重建（重连后仍能看到用量）', () => {
    const u = hydrateUsage({
      meta: { [USAGE_STATS_KEY]: emptyUsage() },
      messages: [msg({ input: 123, output: 4 }, at(0, 9))],
    })
    expect(u.llmCalls).toBe(1)
    expect(u.inputTokens).toBe(123)
  })

  it('meta 与消息都无数据时返回空', () => {
    expect(isBlankUsage(hydrateUsage({ meta: {}, messages: [] }))).toBe(true)
    expect(isBlankUsage(hydrateUsage(undefined))).toBe(true)
  })
})

describe('shouldPersistUsage（防止空累积器清零历史）', () => {
  it('空累积器 + 已有历史 → 不写入', () => {
    let persisted = emptyUsage()
    persisted = recordCall(persisted, { model: 'm', input: 100, output: 1, ts: at(0, 9) })
    expect(shouldPersistUsage(emptyUsage(), persisted)).toBe(false)
  })

  it('有数据 → 允许写入', () => {
    let next = emptyUsage()
    next = recordCall(next, { model: 'm', input: 1, output: 1, ts: at(0, 9) })
    expect(shouldPersistUsage(next, undefined)).toBe(true)
    expect(shouldPersistUsage(next, emptyUsage())).toBe(true)
  })

  it('双方都为空 → 允许写入（不阻塞初始化）', () => {
    expect(shouldPersistUsage(emptyUsage(), emptyUsage())).toBe(true)
  })

  it('水合不全（本轮少于历史）→ 不写入，防止回退丢失调用记录', () => {
    let persisted = emptyUsage()
    for (let i = 0; i < 100; i++) persisted = recordCall(persisted, { model: 'm', input: 10, ts: at(0, 9) })
    const partial = recordCall(emptyUsage(), { model: 'm', input: 10, ts: at(0, 9) })
    expect(persisted.llmCalls).toBe(100)
    expect(shouldPersistUsage(partial, persisted)).toBe(false)
  })

  it('正常累加（本轮多于历史）→ 允许写入', () => {
    let persisted = emptyUsage()
    persisted = recordCall(persisted, { model: 'm', input: 10, ts: at(0, 9) })
    let next = persisted
    next = recordCall(next, { model: 'm', input: 20, ts: at(0, 10) })
    expect(shouldPersistUsage(next, persisted)).toBe(true)
  })
})

describe('导出报告', () => {
  let u: UsageStats = emptyUsage()
  u = recordCall(u, { model: 'mock/m1', input: 300, output: 30, ts: at(0, 9) })
  const today = todayUsage(u)

  it('JSON 导出包含当日汇总', () => {
    const j = JSON.parse(exportStatsJson(u, { sessionId: 's1', title: 't', today }))
    expect(j.sessionId).toBe('s1')
    expect(j.today.llmCalls).toBe(1)
    expect(j.today.inputTokens).toBe(300)
    expect(j.today.hourly[0].label).toMatch(/^\d{2}:00$/)
  })

  it('未提供 today 时不输出该字段', () => {
    const j = JSON.parse(exportStatsJson(u, { sessionId: 's1' }))
    expect(j.today).toBeUndefined()
  })

  it('Markdown 导出包含当日汇总小节', () => {
    const md = exportStatsMarkdown(u, { sessionId: 's1', today })
    expect(md).toContain('## 当日汇总（全部会话）')
    expect(md).toContain('| 当日输入 token | 300 |')
  })

  it('Markdown 未传 today 时无当日小节', () => {
    expect(exportStatsMarkdown(u, { sessionId: 's1' })).not.toContain('当日汇总')
  })
})

describe('usageFromMeta / 杂项', () => {
  it('usageFromMeta 读取持久化值，缺失返回 undefined', () => {
    let persisted = emptyUsage()
    persisted = recordCall(persisted, { model: 'm', input: 7, output: 0, ts: at(0, 9) })
    expect(usageFromMeta({ [USAGE_STATS_KEY]: persisted })?.inputTokens).toBe(7)
    expect(usageFromMeta(undefined)).toBeUndefined()
    expect(usageFromMeta({ other: 1 })).toBeUndefined()
  })

  it('todayUsageLine 输出可读摘要', () => {
    let u2 = emptyUsage()
    u2 = recordCall(u2, { model: 'm', input: 12, output: 3, ts: at(0, 9) })
    expect(todayUsageLine(todayUsage(u2))).toBe('今日 1次 · in12/out3')
  })

  it('uncachedInput 扣除缓存命中/写入', () => {
    let u2 = emptyUsage()
    u2 = recordCall(u2, { model: 'm', input: 100, output: 0, cacheRead: 30, cacheWrite: 20, ts: at(0, 9) })
    expect(uncachedInput(u2)).toBe(50)
  })
})
