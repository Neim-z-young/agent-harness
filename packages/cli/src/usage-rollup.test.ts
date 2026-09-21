import { describe, it, expect } from 'bun:test'
import { renderChildAgentRollup } from './index'
import { emptyUsage, recordCall } from './usage-stats'

/**
 * 「含子 agent」聚合行（P4）。
 *
 * 背景：子 agent 的用量累积在**自己的会话**里（引擎按会话折叠），所以父会话的 `/stats`
 * 默认只反映本会话 —— 真机 ra6w1 里 6 个子会话约 1.5M 输入 token 此前完全不可见。
 * 这里只做展示层聚合：`usage.children()`（按 Session.parentId 反查）+ `sumUsage`。
 */

/** 最小 harness 替身：只提供 usage 通道 */
const fakeHarness = (children: string[], usage: Record<string, ReturnType<typeof emptyUsage>>) =>
  ({
    usage: {
      children: async () => children,
      get: async (id: string) => usage[id] ?? emptyUsage(),
    },
  }) as never

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
