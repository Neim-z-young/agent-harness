import { describe, it, expect } from 'bun:test'
import { renderChildAgentRollup, renderContextOccupancy } from './index'
import { emptyUsage, recordCall } from './usage-stats'
import type { CompactOptions } from '@harness/session'

/**
 * 「含子 agent」聚合行（P4）。
 *
 * 背景：子 agent 的用量累积在**自己的会话**里（引擎按会话折叠），所以父会话的 `/stats`
 * 默认只反映本会话 —— 真机 ra6w1 里 6 个子会话约 1.5M 输入 token 此前完全不可见。
 * 这里只做展示层聚合：`usage.children()`（按 Session.parentId 反查）+ `sumUsage`。
 */

/** 最小 harness 替身：只提供 usage 通道 */
const fakeHarness = (
  children: string[],
  usage: Record<string, ReturnType<typeof emptyUsage>>,
  est?: Record<string, number>,
  /** 按会话 id 给 `session.get` 回填 meta（`renderContextOccupancy` 从它读 ACP 的「实际发出」口径） */
  metas?: Record<string, Record<string, unknown>>,
) =>
  ({
    usage: {
      children: async () => children,
      get: async (id: string) => usage[id] ?? emptyUsage(),
    },
    session: {
      estimateTokens: async (id: string) => est?.[id] ?? 0,
      // 供 renderContextOccupancy 回源取「最新一份」会话（它据此解析各会话自己的窗口 + 读 ACP 占用口径）
      get: async (id: string) => ({ id, ...(metas?.[id] ? { meta: metas[id] } : {}) }),
    },
  }) as never

const compactOpts = {
  contextWindowTokens: 200_000,
  reservedTokens: 30_000,
  autoCompactThresholdPct: 80,
  tokenCalibration: 'auto',
} as CompactOptions

describe('renderChildAgentRollup', () => {
  it('无子会话 ⇒ 空串（不占版面）', async () => {
    expect(await renderChildAgentRollup(fakeHarness([], {}), 's1')).toBe('')
  })

  it('有子会话 ⇒ 求和并给出调用数 / in·out / 缓存命中', async () => {
    const a = recordCall(emptyUsage(), { model: 'm', input: 100, output: 10, cacheRead: 80 })
    const b = recordCall(emptyUsage(), { model: 'm', input: 200, output: 20, cacheRead: 150 })
    const line = await renderChildAgentRollup(fakeHarness(['c1', 'c2'], { c1: a, c2: b }), 's1')
    expect(line).toContain('含子 agent：2 个子会话')
    expect(line).toContain('调用 2 次')
    expect(line).toContain('in 300 / out 30')
    expect(line).toContain('缓存命中 230')
  })

  it('宿主没有 usage 通道（旧 harness / 测试替身）⇒ 空串且不抛', async () => {
    expect(await renderChildAgentRollup({} as never, 's1')).toBe('')
  })
})

describe('renderContextOccupancy', () => {
  it('本会话占用 + 阈值；无子会话时只出主行', async () => {
    const line = await renderContextOccupancy(fakeHarness([], {}, { s1: 45_000 }), { id: 's1' } as never, compactOpts)
    expect(line).toContain('上下文占用：45,000 / 200,000 tokens（22.5%）')
    expect(line).toContain('自动压缩阈值 136,000')
    expect(line).not.toContain('子会话')
  })

  it('子会话逐行列出占用率', async () => {
    const line = await renderContextOccupancy(
      fakeHarness(['c1'], {}, { s1: 45_000, c1: 20_000 }),
      { id: 's1' } as never,
      compactOpts,
    )
    expect(line).toContain('子会话 c1：占用 20,000 / 200,000 tokens（10.0%）')
  })

  it('子会话估算失败（0）⇒ 不占版面', async () => {
    const line = await renderContextOccupancy(fakeHarness(['c1'], {}, { s1: 45_000 }), { id: 's1' } as never, compactOpts)
    expect(line).not.toContain('子会话 c1')
  })

  it('子会话分母按自身端点解析：子 Agent 换了窗口就不再沿用父会话的', async () => {
    // 父会话 300K / 子会话 200K、占用 150K：按子会话自己的分母是 75%，沿用父会话的会报成 50%
    // —— 前者才是"该不该压"的依据（虚低会让压缩永不触发）。
    const line = await renderContextOccupancy(
      fakeHarness(['c1'], {}, { s1: 45_000, c1: 150_000 }),
      { id: 's1' } as never,
      { ...compactOpts, contextWindowTokens: 300_000 } as CompactOptions,
      (s) => (s?.id === 'c1' ? 200_000 : 300_000),
    )
    expect(line).toContain('上下文占用：45,000 / 300,000 tokens（15.0%）')
    expect(line).toContain('子会话 c1：占用 150,000 / 200,000 tokens（75.0%）')
  })

  it('端点解析不出来（宿主没有 config / 会话查不到）⇒ 回落父会话窗口，与改造前一致', async () => {
    const line = await renderContextOccupancy(
      fakeHarness(['c1'], {}, { s1: 45_000, c1: 20_000 }),
      { id: 's1' } as never,
      compactOpts,
      () => compactOpts.contextWindowTokens!,
    )
    expect(line).toContain('上下文占用：45,000 / 200,000 tokens（22.5%）')
    expect(line).toContain('子会话 c1：占用 20,000 / 200,000 tokens（10.0%）')
  })

  // 原文口径（estimateTokens）不含压缩效果：只显示它会出现"压缩成功、占用却没降"的误读
  // （真机 s_1791373374635_9hqyb：原文口径 66.8% vs 实际发出 22.0%）。故两个数必须并排。
  it('有 ACP「实际发出」口径时并排两行；原文口径行明确标注口径', async () => {
    const line = await renderContextOccupancy(
      fakeHarness([], {}, { s1: 45_000 }, {
        s1: { 'acp.occupancy.v1': { requestTok: 12_000, rawTok: 45_000, window: 200_000 } },
      }),
      { id: 's1' } as never,
      compactOpts,
    )
    expect(line).toContain('上下文占用：45,000 / 200,000 tokens（22.5%）')
    expect(line).toContain('原文口径（压缩不会降低此数）')
    expect(line).toContain('实际发出：12,000 / 200,000 tokens（6.0%）')
    expect(line).toContain('ACP 压缩后（未压缩为 45,000）')
  })

  // 固定前缀（system + 工具 schema）是窗口闸判据的一部分：只报消息体会与告警对不上
  // （观众拿这一行去核闸门的百分比，会觉得闸门凭空多算了占用）。有值时追加一段并给出「合计」。
  it('ACP 口径带固定前缀时追加「含固定前缀 + 合计」，前半段（消息体口径）逐字不变', async () => {
    const line = await renderContextOccupancy(
      fakeHarness([], {}, { s1: 45_000 }, {
        s1: {
          'acp.occupancy.v1': { requestTok: 12_000, rawTok: 45_000, window: 200_000, fixedTok: 9_600 },
        },
      }),
      { id: 's1' } as never,
      compactOpts,
    )
    expect(line).toContain('实际发出：12,000 / 200,000 tokens（6.0%）')
    expect(line).toContain('含固定前缀 9,600（system + 工具 schema）')
    expect(line).toContain('合计 21,600（10.8%）')
  })

  it('fixedTok 缺失 / 为 0 / 非数 ⇒ 不追加固定前缀段（老会话与老断言逐字不变）', async () => {
    for (const fixedTok of [undefined, 0, 'x']) {
      const line = await renderContextOccupancy(
        fakeHarness([], {}, { s1: 45_000 }, {
          s1: { 'acp.occupancy.v1': { requestTok: 12_000, rawTok: 45_000, window: 200_000, fixedTok } },
        }),
        { id: 's1' } as never,
        compactOpts,
      )
      expect(line).not.toContain('固定前缀')
      expect(line).toContain('实际发出：12,000 / 200,000 tokens（6.0%）')
    }
  })

  it('ACP 口径缺失或结构不对 ⇒ 只有原文口径一行，不出现「实际发出」', async () => {
    const missing = await renderContextOccupancy(fakeHarness([], {}, { s1: 45_000 }), { id: 's1' } as never, compactOpts)
    expect(missing).toContain('上下文占用：45,000 / 200,000 tokens（22.5%）')
    expect(missing).not.toContain('实际发出')

    const malformed = await renderContextOccupancy(
      fakeHarness([], {}, { s1: 45_000 }, { s1: { 'acp.occupancy.v1': { requestTok: 'x' } } }),
      { id: 's1' } as never,
      compactOpts,
    )
    expect(malformed).not.toContain('实际发出')
  })
})
