/**
 * usage-stats 单元测试：用量累积、持久化水合、当日归集与导出。
 *
 * 重点覆盖两类回归：
 * 1. 重连（resume）后用量不能从 0 开始 → hydrateUsage
 * 2. 历史消息不能被算到「今天」→ usageFromMessages 按 createdAt 归并小时桶
 */
import { describe, it, expect } from 'bun:test'
import {
  emptyUsage,
  emptyFoldState,
  foldMessage,
  rebuildUsage,
  recordCall,
  recordTool,
  recordTaskDone,
  uncachedInput,
  cacheHitRate,
  renderStatsText,
  dayStart,
  usageSince,
  todayUsage,
  mergeUsage,
  sumUsage,
  hydrateUsage,
  isBlankUsage,
  normalizeUsage,
  usageFromMeta,
  usageFromMessages,
  todayUsageLine,
  providerUsageRow,
  modelUsageRow,
  toolUsageRow,
  agentUsageRow,
  hourlyRow,
  sparkline,
  exportStatsJson,
  exportStatsMarkdown,
  USAGE_STATS_KEY,
  type UsageStats,
  type UsageMessageLike,
} from './index'

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

  it('recordCall 自己就把小时桶插在升序位置（不能指望 mergeUsage 事后排）', () => {
    // 覆盖缺口（反向验证实测）：上面那条「不同小时桶各自保留并升序」全程走 mergeUsage。
    // 引擎的增量折叠路径**只**调 recordCall、不经过 mergeUsage，所以必须直接钉它：
    // 乱序到达的时间戳（真机上跨小时、甚至时钟回拨）也得插在正确位置，
    // 否则当日截取（usageSince 按 hour 前缀比较）与时间序列会错位。
    let u = emptyUsage()
    u = recordCall(u, { model: 'm', input: 1, output: 1, ts: at(0, 10) })
    u = recordCall(u, { model: 'm', input: 2, output: 2, ts: at(0, 8) })
    u = recordCall(u, { model: 'm', input: 3, output: 3, ts: at(0, 9) })
    expect(u.hourly.map((h) => h.hour)).toStrictEqual([at(0, 8), at(0, 9), at(0, 10)])
    expect(u.hourly.map((h) => h.inputTokens)).toStrictEqual([2, 3, 1])
  })

  it('★recordCall 喂 NaN/Infinity：入口归 0，五个维度与落盘都不被污染', () => {
    const u = recordCall(emptyUsage(), { model: 'm', input: NaN, output: Infinity, cacheRead: -1, cacheWrite: 3, ts: at(0, 8) })
    expect(u.inputTokens).toBe(0)
    expect(u.outputTokens).toBe(0)
    expect(u.cacheReadTokens).toBe(0)
    expect(u.providers[0]!.inputTokens).toBe(0)
    expect(u.models[0]!.outputTokens).toBe(0)
    expect(u.hourly[0]!.inputTokens).toBe(0)
    expect(JSON.stringify(u)).not.toContain('null') // NaN/Infinity 序列化成 null
  })

  it('★mergeUsage 传入乱序 a.hourly 仍保证升序', () => {
    let a = emptyUsage()
    a = recordCall(a, { model: 'm', input: 1, output: 1, ts: at(0, 10) })
    a = recordCall(a, { model: 'm', input: 2, output: 2, ts: at(0, 8) })
    const shuffled = { ...a, hourly: [...a.hourly].reverse() }
    expect(shuffled.hourly.map((h) => h.hour)).toStrictEqual([at(0, 10), at(0, 8)]) // 前提：输入确实乱序
    expect(mergeUsage(shuffled, emptyUsage()).hourly.map((h) => h.hour)).toStrictEqual([at(0, 8), at(0, 10)])
  })

  it('★mergeUsage 返回体不与入参 b 共享行对象', () => {
    let b = emptyUsage()
    b = recordCall(b, { model: 'm', input: 1, output: 1, ts: at(0, 8) })
    const merged = mergeUsage(emptyUsage(), b)
    expect(merged.providers).toHaveLength(1)
    merged.providers[0]!.calls = 99
    expect(b.providers[0]!.calls).toBe(1)
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

  it('cacheHitRate：命中/输入 百分比（一位小数）', () => {
    let u = emptyUsage()
    u = recordCall(u, { model: 'm', input: 1000, output: 0, cacheRead: 250, ts: at(0, 9) })
    expect(cacheHitRate(u)).toBe(25)
    expect(cacheHitRate(emptyUsage())).toBe(0)
  })

  it('cacheHitRate：非法输入归 0，不得把 NaN 漏到 UI', () => {
    // 回归背景：`NaN <= 0` 是 false，旧实现只在分母上做了一次 `<= 0` 判断就除法，
    // 分子为 NaN（provider 只回报了部分字段 / 水合时字段缺失）时算出 NaN，
    // 直接插值成「缓存：命中 NaN（NaN%）」。
    const base = (patch: Partial<UsageStats>): UsageStats => ({ ...emptyUsage(), ...patch })
    expect(cacheHitRate(base({ inputTokens: 1000, cacheReadTokens: NaN }))).toBe(0)
    expect(cacheHitRate(base({ inputTokens: NaN, cacheReadTokens: 100 }))).toBe(0)
    expect(cacheHitRate(base({ inputTokens: -5, cacheReadTokens: 100 }))).toBe(0)
    expect(cacheHitRate(base({ inputTokens: Number.POSITIVE_INFINITY, cacheReadTokens: 100 }))).toBe(0)
    expect(cacheHitRate(base({ inputTokens: 1000, cacheReadTokens: -1 }))).toBe(0)

    // 渲染层端到端：绝不出现 NaN。
    // ⚠️ 这里**必须**给 cacheWriteTokens 一个正数：缓存行的渲染条件是
    // `cacheReadTokens > 0 || cacheWriteTokens > 0`，而 NaN > 0 是 false ⇒
    // 只写 NaN 时整行都不会输出，断言「不含 NaN」在**任何实现下**都成立（空转守卫）。
    // 早期版本就是这么写的，于是 uncachedInput 的 NaN 漏出一直没被发现。
    const nanLine = renderStatsText(base({ inputTokens: 1000, cacheReadTokens: NaN, cacheWriteTokens: 5 }))
      .split('\n')
      .find((l) => l.startsWith('缓存：'))
    expect(nanLine).toBeDefined() // 证明真的走到了缓存行
    expect(nanLine).not.toContain('NaN')
    // ★ 不能只守缓存行：第一行 `in ${u.inputTokens}` 与下面各 row 也会把 NaN 打进报告。
    //   早期用例把整篇断言收窄成单行，于是第一行的坏值一直没被抓到。
    expect(renderStatsText(base({ inputTokens: NaN, cacheReadTokens: NaN, cacheWriteTokens: 5 }))).not.toContain('NaN')
    // 未命中 = 已知项相减，非有限项按 0 计（与命中率同口径）
    expect(uncachedInput(base({ inputTokens: 1000, cacheReadTokens: NaN, cacheWriteTokens: 5 }))).toBe(995)
    expect(uncachedInput(base({ inputTokens: NaN, cacheReadTokens: 1, cacheWriteTokens: 1 }))).toBe(0)
  })

  it('renderStatsText 缓存行含命中率', () => {
    let u = emptyUsage()
    u = recordCall(u, { model: 'm', input: 1000, output: 0, cacheRead: 250, cacheWrite: 100, ts: at(0, 9) })
    expect(renderStatsText(u)).toContain('缓存：命中 250（25%），写入 100，未命中 650')
  })
})

describe('recordTool 计数口径（真机修复）', () => {
  it('任何调用都计入 count，失败再额外计入 errors（不得出现"调用 0 / 错误 1"）', () => {
    let u = emptyUsage()
    u = recordTool(u, 'team_status', { isError: true })
    const first = u.tools.find((t) => t.tool === 'team_status')!
    expect(first.count).toBe(1)
    expect(first.errors).toBe(1)

    u = recordTool(u, 'team_status', { isError: true })
    u = recordTool(u, 'team_status', { input: 100, output: 20 })
    const t = u.tools.find((x) => x.tool === 'team_status')!
    expect(t.count).toBe(3)
    expect(t.errors).toBe(2)
    // token 归因仍只在成功时累加
    expect(t.inputTokens).toBe(100)
    expect(t.outputTokens).toBe(20)
  })

  it('从未成功的工具也不会出现 count=0 的条目', () => {
    const u = recordTool(emptyUsage(), 'only-fails', { isError: true })
    expect(u.tools.every((t) => t.count > 0)).toBe(true)
  })
})

describe('foldMessage / rebuildUsage（引擎增量折叠与全量重建必须同口径）', () => {
  const msg = (o: Partial<UsageMessageLike> & { id?: string }): UsageMessageLike => o as UsageMessageLike

  /** 一轮：assistant(带用量 + 工具) → assistant(带用量，无工具) */
  const script: UsageMessageLike[] = [
    msg({ meta: { model: 'm', tokenUsage: { input: 100, output: 20, cacheRead: 80 } }, agentId: 'root', parts: [{ type: 'tool', toolId: 'bash' }] }),
    msg({ meta: { model: 'm', tokenUsage: { input: 150, output: 10 } }, agentId: 'root', parts: [{ type: 'text' }] }),
    msg({ meta: { model: 'm', tokenUsage: { input: 90, output: 5 } }, agentId: 'worker', parts: [{ type: 'tool', toolId: 'read_file' }] }),
  ]

  it('分批折叠的累积器 === 一次性重建（引擎增量路径不会跑偏）', () => {
    const rebuilt = rebuildUsage(script)
    const state = emptyFoldState()
    let u = emptyUsage()
    for (const m of script.slice(0, 1)) u = foldMessage(u, m, state)
    for (const m of script.slice(1)) u = foldMessage(u, m, state)
    expect(u).toEqual(rebuilt.usage)
    expect(state).toEqual(rebuilt.state)
  })

  it('跨消息的归因状态被保留：本步用量归并到紧随的首个工具', () => {
    const { usage } = rebuildUsage(script)
    const bash = usage.tools.find((t) => t.tool === 'bash')!
    const read = usage.tools.find((t) => t.tool === 'read_file')!
    expect(bash.inputTokens).toBe(100)
    expect(read.inputTokens).toBe(90)
  })

  it('agentId 归因（引擎从消息上取，不再只落 root）', () => {
    const { usage } = rebuildUsage(script)
    expect(usage.agents.map((a) => a.agentId).sort()).toEqual(['root', 'worker'])
    expect(usage.agents.find((a) => a.agentId === 'worker')!.calls).toBe(1)
  })

  it('subagent 调用成功 ⇒ 计入该 agent 的 tasksDone（对齐 TUI 时代的口径）', () => {
    const { usage } = rebuildUsage([
      msg({ meta: { model: 'm', tokenUsage: { input: 10, output: 1 } }, agentId: 'root', parts: [{ type: 'tool', toolId: 'subagent' }] }),
      msg({ meta: { model: 'm', tokenUsage: { input: 10, output: 1 } }, agentId: 'root', parts: [{ type: 'tool', toolId: 'subagent', isError: true }] }),
    ])
    // 只有成功那次算一个子任务
    expect(usage.agents.find((a) => a.agentId === 'root')!.tasksDone).toBe(1)
  })

  it('是 usageFromMessages 的同一套规则（wrapper 与 rebuild 结果一致）', () => {
    expect(usageFromMessages(script)).toEqual(rebuildUsage(script).usage)
  })
})

// ============================================================================
// Provider 维度
//
// 键是**实例路由键**（ProviderConfig.id），不是 provider 类型 —— 成本归因的轴是端点。
// 两个必须守住的点：
// 1. 分区键全覆盖，且 `'default'`（未指定 ⇒ 走默认端点）与 `'unknown'`（旧会话无此字段）
//    不得合并 —— 前者是事实，后者是缺失；
// 2. 与 model / agent 同源：provider 从**消息 meta** 取，否则「全量自愈重建」会整个丢掉
//    这一维度（见 core 的 accumulateUsage 双入口）。
// ============================================================================

describe('Provider 维度', () => {
  it('recordCall 按 provider 归并 calls / token / 缓存，不同 provider 各自成行', () => {
    let u = emptyUsage()
    u = recordCall(u, { provider: 'hy3', model: 'm', input: 100, output: 10, cacheRead: 30, cacheWrite: 5, ts: at(0, 9) })
    u = recordCall(u, { provider: 'hy3', model: 'm', input: 50, output: 5, cacheRead: 20, cacheWrite: 0, ts: at(0, 9) })
    u = recordCall(u, { provider: 'openai-2', model: 'gpt', input: 7, output: 1, ts: at(0, 9) })

    expect(u.providers.map((p) => p.provider)).toEqual(['hy3', 'openai-2'])
    const hy3 = u.providers.find((p) => p.provider === 'hy3')!
    expect(hy3.calls).toBe(2)
    expect(hy3.inputTokens).toBe(150)
    expect(hy3.outputTokens).toBe(15)
    expect(hy3.cacheRead).toBe(50)
    expect(hy3.cacheWrite).toBe(5)
  })

  it("缺省归 'unknown'，显式 'default' 另成一组（「缺失」与「确定走默认端点」不得混淆）", () => {
    let u = emptyUsage()
    u = recordCall(u, { input: 1, output: 1, ts: at(0, 9) }) // 调用方没给 ⇒ 旧会话/未记录
    u = recordCall(u, { provider: 'default', input: 2, output: 2, ts: at(0, 9) }) // 哨兵：确定走默认
    expect(u.providers.map((p) => p.provider).sort()).toEqual(['default', 'unknown'])
    expect(u.providers.find((p) => p.provider === 'default')!.inputTokens).toBe(2)
    expect(u.providers.find((p) => p.provider === 'unknown')!.inputTokens).toBe(1)
  })

  it('mergeUsage 同 provider 相加、异 provider 并列', () => {
    let a = emptyUsage()
    a = recordCall(a, { provider: 'p1', model: 'm', input: 10, output: 1, cacheRead: 2, ts: at(0, 9) })
    let b = emptyUsage()
    b = recordCall(b, { provider: 'p1', model: 'm', input: 20, output: 2, cacheRead: 3, ts: at(0, 9) })
    b = recordCall(b, { provider: 'p2', model: 'm', input: 5, output: 1, ts: at(0, 9) })

    const m = mergeUsage(a, b)
    expect(m.providers.map((p) => p.provider)).toEqual(['p1', 'p2'])
    expect(m.providers.find((p) => p.provider === 'p1')).toMatchObject({
      calls: 2, inputTokens: 30, outputTokens: 3, cacheRead: 5,
    })
  })

  it('normalizeUsage：旧落盘记录缺 providers 等字段时补齐（否则下游展开即抛）', () => {
    // 形态 = 本维度引入之前落盘的 meta.usageStats（真机形态：没有 providers 键）
    const legacy = {
      llmCalls: 2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
      models: [], tools: [], agents: [], hourly: [],
    } as unknown as UsageStats
    const n = normalizeUsage(legacy)
    expect(n.providers).toEqual([])
    // 补齐后可直接参与运算（这正是崩溃点：`[...usage.providers]`）
    const after = recordCall(n, { provider: 'p1', model: 'm', input: 1, output: 1 })
    expect(after.providers).toHaveLength(1)
    expect(after.llmCalls).toBe(3)
    expect(normalizeUsage(undefined).providers).toEqual([])
  })

  it('usageFromMeta 是落盘记录的唯一反序列化入口 ⇒ 归一化在这里生效', () => {
    const legacy = {
      llmCalls: 1, inputTokens: 9, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      models: [], tools: [], agents: [], hourly: [],
    }
    const u = usageFromMeta({ [USAGE_STATS_KEY]: legacy })!
    expect(u.providers).toEqual([])
    // 关键回归：折叠路径不会因为旧记录缺字段而抛 TypeError（那会被 catch 吞成"用量静默不增长"）
    expect(() => foldMessage(u, { meta: { model: 'm', tokenUsage: { input: 1, output: 1 } } }, emptyFoldState())).not.toThrow()
  })

  it('mergeUsage 容忍旧记录（跨会话聚合的收敛点也补一次）', () => {
    const legacy = {
      llmCalls: 1, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      models: [], tools: [], agents: [], hourly: [],
    } as unknown as UsageStats
    let fresh = emptyUsage()
    fresh = recordCall(fresh, { provider: 'p1', model: 'm', input: 1, output: 1 })
    const m = mergeUsage(legacy, fresh)
    expect(m.llmCalls).toBe(2)
    expect(m.providers.map((p) => p.provider)).toEqual(['p1'])
  })

  it('foldMessage 从 meta.providerId 取 provider（增量与全量重建同口径）', () => {
    const script: UsageMessageLike[] = [
      { meta: { model: 'm', providerId: 'hy3', tokenUsage: { input: 100, output: 20 } }, agentId: 'root', parts: [{ type: 'text' }] },
      { meta: { model: 'm', providerId: 'openai-2', tokenUsage: { input: 50, output: 5 } }, agentId: 'root', parts: [{ type: 'text' }] },
      { meta: { model: 'm', tokenUsage: { input: 7, output: 1 } }, agentId: 'root', parts: [{ type: 'text' }] }, // 旧消息：无 providerId
    ]
    const rebuilt = rebuildUsage(script)
    expect(rebuilt.usage.providers.map((p) => p.provider)).toEqual(['hy3', 'openai-2', 'unknown'])

    // 分批折叠（引擎的增量路径）必须得出同一份
    const state = emptyFoldState()
    let u = emptyUsage()
    for (const m of script.slice(0, 1)) u = foldMessage(u, m, state)
    for (const m of script.slice(1)) u = foldMessage(u, m, state)
    expect(u.providers).toEqual(rebuilt.usage.providers)
  })

  it('当日视图不切分 Provider（与 models/tools/agents 同：无法按天切）', () => {
    let u = emptyUsage()
    u = recordCall(u, { provider: 'p1', model: 'm', input: 10, output: 1, ts: at(0, 9) })
    expect(todayUsage(u).providers).toEqual([])
    expect(usageSince(u, 0).providers).toEqual([])
  })

  it('providerUsageRow 格式化（与 modelUsageRow 同形，便于对照阅读）', () => {
    expect(providerUsageRow({ provider: 'hy3', calls: 2, inputTokens: 150, outputTokens: 30, cacheRead: 10, cacheWrite: 0 }))
      .toBe('hy3 ×2 · ⚡10/w0 in150/out30')
    expect(providerUsageRow({ provider: 'default', calls: 1, inputTokens: 200, outputTokens: 30, cacheRead: 0, cacheWrite: 0 }))
      .toBe('default ×1 · in200/out30')
  })

  it('renderStatsText：Provider 节在模型节之前（粗→细）', () => {
    let u = emptyUsage()
    u = recordCall(u, { provider: 'hy3', model: 'm', input: 10, output: 1, ts: at(0, 9) })
    const text = renderStatsText(u)
    expect(text).toContain('按 Provider：')
    expect(text).toContain('hy3 ×1')
    expect(text.indexOf('按 Provider：')).toBeLessThan(text.indexOf('按模型：'))
    // 无调用时不出现该节（否则空会话 /stats 会多一行噪音）
    expect(renderStatsText(emptyUsage())).not.toContain('按 Provider')
  })

  it('导出报告带 Provider 维度（JSON 字段 + Markdown 小节）', () => {
    let u = emptyUsage()
    u = recordCall(u, { provider: 'hy3', model: 'm', input: 300, output: 30, ts: at(0, 9) })
    const j = JSON.parse(exportStatsJson(u, { sessionId: 's1' }))
    expect(j.providers).toEqual([{ provider: 'hy3', calls: 1, inputTokens: 300, outputTokens: 30, cacheRead: 0, cacheWrite: 0 }])
    const md = exportStatsMarkdown(u, { sessionId: 's1' })
    expect(md).toContain('## 按 Provider')
    expect(md).toContain('| hy3 | 1 | 300 | 30 | 0 | 0 |')
  })
})

// ============================================================================
// 归并原语与格式化的收敛守卫
//
// 这一节钉的是"本包只有一份维度加法"这件事的结果，而不是实现细节：
// 5 个维度（provider / model / tool / agent / hour）走同一个 accumulateRows，
// 任何一个维度漏加一列，都会在这里表现为某条断言对不上。
// ============================================================================

describe('recordCall 归因口径', () => {
  it('给了 agentId 就必须落到该 agent 名下（不得因为缺 model 而静默记到 root）', () => {
    // 回归背景：旧写法是 `rec.model ? (rec.agentId || 'root') : 'root'` ——
    // 把"有没有 model"当成了"要不要认 agentId"的门。而 foldMessage 传的是
    // `{ model: meta.model, agentId: m.agentId }`，meta 缺 model 的 assistant 消息
    // （provider 未回报模型名的旧记录）会把子 agent 的用量整笔记到 root，
    // /stats 的「按 agent」一栏于是长期少算，且没有任何信号。
    const u = recordCall(emptyUsage(), { agentId: 'worker', input: 5, output: 1, ts: at(0, 9) })
    expect(u.agents.map((a) => a.agentId)).toStrictEqual(['worker'])
    expect(u.agents[0]!.inputTokens).toBe(5)
    // 同时：模型维度按缺省口径仍是 unknown（两件事互不牵连）
    expect(u.models.map((m) => m.model)).toStrictEqual(['unknown'])
  })

  it('旧落盘记录（连 models/agents/hourly 都缺）可直接进 recordCall，不抛', () => {
    // 回归背景：normalizeUsage 存在的原因就是"旧记录缺维度数组"。但 recordCall 内部
    // 只给 providers 写了 `?? []`，另外三个维度直接 `.findIndex` ⇒ 从这条路进来的
    // 旧记录抛 `undefined is not an object`，抛点又在 core 的 try/catch 里
    // ⇒ 症状是"用量静默不增长"。归一必须放在入口，且覆盖全部维度。
    const legacy = {
      llmCalls: 1, inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    } as unknown as UsageStats
    const after = recordCall(legacy, { model: 'm', provider: 'p1', input: 2, output: 3 })
    expect(after.llmCalls).toBe(2)
    expect(after.models).toHaveLength(1)
    expect(after.agents).toHaveLength(1)
    expect(after.hourly).toHaveLength(1)
    expect(after.providers).toHaveLength(1)
  })

  it('五个维度用同一份加法：每次调用都累加 calls/input/output/cacheRead/cacheWrite', () => {
    let u = emptyUsage()
    u = recordCall(u, { provider: 'p1', model: 'm', agentId: 'w', input: 100, output: 10, cacheRead: 40, cacheWrite: 6, ts: at(0, 9) })
    u = recordCall(u, { provider: 'p1', model: 'm', agentId: 'w', input: 50, output: 5, cacheRead: 10, cacheWrite: 4, ts: at(0, 9) })
    // provider / model / hour 有缓存列；agent 没有（任务维度不切缓存）
    for (const row of [u.providers[0]!, u.models[0]!, u.hourly[0]!]) {
      expect(row).toMatchObject({ calls: 2, inputTokens: 150, outputTokens: 15, cacheRead: 50, cacheWrite: 10 })
    }
    expect(u.agents[0]).toMatchObject({ calls: 2, inputTokens: 150, outputTokens: 15 })
    // 汇总列与维度列必须自洽（权威口径：usageStats.inputTokens）
    expect(u.inputTokens).toBe(150)
    expect(u.cacheReadTokens).toBe(50)
  })
})

describe('recordTaskDone', () => {
  it('首次为该 agent 建行（calls 保持 0），再次调用只加 tasksDone', () => {
    let u = recordTaskDone(emptyUsage(), 'worker')
    u = recordTaskDone(u, 'worker')
    u = recordTaskDone(u)
    expect(u.agents).toHaveLength(2)
    expect(u.agents.find((a) => a.agentId === 'worker')).toMatchObject({ calls: 0, tasksDone: 2 })
    expect(u.agents.find((a) => a.agentId === 'root')!.tasksDone).toBe(1)
    // 任务不产生调用
    expect(u.llmCalls).toBe(0)
  })
})

describe('格式化：同形与同量', () => {
  it('providerUsageRow 与 modelUsageRow 对同一组计数输出完全同形（只差 key）', () => {
    const tally = { calls: 3, inputTokens: 120, outputTokens: 30, cacheRead: 50, cacheWrite: 7 }
    const p = providerUsageRow({ provider: 'K', ...tally })
    const m = modelUsageRow({ model: 'K', ...tally })
    // 这行断言的目的：两份格式化此前是逐字重复的实现，改一处漏一处会让
    // 同一个面板里两行长不一样。现在它们必须恒等（只差 key 字符串）。
    expect(p).toBe(m)
    expect(p).toBe('K ×3 · ⚡50/w7 in120/out30')
  })

  it('无缓存时省略缓存段（不出现 ⚡0/w0 的噪音）', () => {
    expect(modelUsageRow({ model: 'm', calls: 1, inputTokens: 2, outputTokens: 3, cacheRead: 0, cacheWrite: 0 }))
      .toBe('m ×1 · in2/out3')
  })

  it('toolUsageRow：失败数与 token 段各有值才出现', () => {
    expect(toolUsageRow({ tool: 'bash', count: 5, errors: 0, inputTokens: 0, outputTokens: 0 })).toBe('bash ×5')
    expect(toolUsageRow({ tool: 'bash', count: 5, errors: 2, inputTokens: 0, outputTokens: 0 })).toBe('bash ×5 (2❌)')
    expect(toolUsageRow({ tool: 'bash', count: 1, errors: 0, inputTokens: 9, outputTokens: 4 })).toBe('bash ×1 · 9/4')
  })

  it('agentUsageRow：tasksDone 为 0 时不显示 ✓', () => {
    expect(agentUsageRow({ agentId: 'root', calls: 2, inputTokens: 10, outputTokens: 5, tasksDone: 0 })).toBe('root ×2 · 10/5')
    expect(agentUsageRow({ agentId: 'w', calls: 2, inputTokens: 10, outputTokens: 5, tasksDone: 3 })).toBe('w ×2 ✓3 · 10/5')
  })

  it('sparkline：按比例取整、夹在 [0, width]、分母非正时全空', () => {
    expect(sparkline(0, 100, 4)).toBe('░░░░')
    expect(sparkline(50, 100, 4)).toBe('██░░')
    expect(sparkline(100, 100, 4)).toBe('████')
    expect(sparkline(999, 100, 4)).toBe('████') // 上界夹紧
    expect(sparkline(-5, 100, 4)).toBe('░░░░') // 下界夹紧
    expect(sparkline(10, 0, 4)).toBe('░░░░') // 分母 0：不得算出 Infinity/NaN
  })

  it('hourlyRow：条形与右侧数字是同一个量（都含输出）', () => {
    // 回归背景：条形只画 inputTokens，而 renderStatsText 传的分母是 input+output 的最大值
    // ⇒ 只要有输出，条形就系统性偏短（满峰也画不满）。这里用"该小时即峰值"钉死它。
    const row = hourlyRow({ hour: at(0, 9), calls: 1, inputTokens: 10, outputTokens: 90, cacheRead: 0, cacheWrite: 0 }, 100)
    expect(row).toMatch(/^09:00 ██████ 100$/)
  })
})
