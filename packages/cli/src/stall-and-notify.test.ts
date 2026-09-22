/**
 * 两个「静默失败」相关的可观测性 helper。
 *
 * 都来自真机会话 `s_1790082671456_82ikm` 的两个 P0：
 *   - 后台结果**跑完了却送不到**（滞留 3 分钟）⇒ `waitForPendingNotifications`；
 *   - 首轮请求**7 分 20 秒零产出且毫无反馈** ⇒ `startStallNotice`。
 *
 * 这两个 helper 刻意做成**依赖可注入**（steps / sleep / scheduler），因此不必靠真实计时器
 * 就能确定性地验证行为 —— 否则「等待」类逻辑的测试要么很慢、要么 flaky。
 */

import { describe, it, expect } from 'bun:test'
import {
  waitForPendingNotifications,
  startStallNotice,
  NOTIFICATION_PEEK_BACKOFF_MS,
  STALL_NOTICE_STEPS_MS,
} from './index'

describe('waitForPendingNotifications：自动续轮前的退避重试', () => {
  /** 队列在第 `fillAfter` 次 peek 之后才有内容（模拟"事件先到、数据后到"） */
  function deferredQueue(fillAfter: number) {
    let calls = 0
    return {
      peekNotifications: () => {
        calls++
        return calls > fillAfter ? ['<task-notification>…</task-notification>'] : []
      },
      get calls() {
        return calls
      },
    }
  }

  function emptyQueue() {
    return { peekNotifications: () => [] as string[] }
  }

  it('队列里已经有内容 ⇒ 立即返回，一次都不必等', async () => {
    const slept: number[] = []
    const n = await waitForPendingNotifications(deferredQueue(0), 's1', {
      steps: [10, 10, 10],
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    expect(n).toBe(1)
    expect(slept).toEqual([])
  })

  it('事件先到、数据后到 ⇒ 退避重试能等到（这正是真机滞留的成因）', async () => {
    const q = deferredQueue(2)
    const slept: number[] = []
    const n = await waitForPendingNotifications(q, 's1', {
      steps: [10, 20, 30],
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    expect(n).toBe(1)
    // 第 1 次 peek 空 → 等 10；第 2 次 peek 空 → 等 20；第 3 次 peek 命中
    expect(slept).toEqual([10, 20])
    expect(q.calls).toBe(3)
  })

  it('始终为空 ⇒ 返回 0，且按 steps 全部走完（不无限重试）', async () => {
    const slept: number[] = []
    const n = await waitForPendingNotifications(emptyQueue(), 's1', {
      steps: [10, 20, 30],
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    expect(n).toBe(0)
    expect(slept).toEqual([10, 20, 30])
  })

  it('默认 steps 的总等待预算约 1s（远小于误判空转的代价）', () => {
    const total = NOTIFICATION_PEEK_BACKOFF_MS.reduce((a, b) => a + b, 0)
    expect(total).toBeLessThanOrEqual(1000)
    expect(total).toBeGreaterThan(0)
  })
})

describe('startStallNotice：请求停滞的可见心跳', () => {
  /** 可手动推进的假时钟：记录每次排期的等待时长，fire 一次即触发一个 */
  function fakeClock() {
    const scheduled: Array<{ fn: () => void; ms: number }> = []
    return {
      scheduler: (fn: () => void, ms: number) => {
        let cancelled = false
        scheduled.push({
          ms,
          fn: () => {
            if (!cancelled) fn()
          },
        })
        return () => {
          cancelled = true
        }
      },
      fire(times = 1) {
        for (let i = 0; i < times; i++) {
          scheduled.shift()?.fn()
        }
      },
      /** 当前排着的等待时长（下一次触发前的间隔） */
      nextWait: () => scheduled[0]?.ms,
    }
  }

  it('按 steps 递增出声，并报出累计等待秒数', () => {
    const clock = fakeClock()
    const lines: string[] = []
    const h = startStallNotice((s) => lines.push(s), { steps: [10_000, 20_000, 30_000], scheduler: clock.scheduler })

    expect(clock.nextWait()).toBe(10_000)
    expect(h.notices()).toBe(0)

    clock.fire()
    expect(h.notices()).toBe(1)
    expect(lines[0]).toContain('10s')
    expect(clock.nextWait()).toBe(20_000)

    clock.fire()
    expect(h.notices()).toBe(2)
    expect(lines[1]).toContain('30s') // 累计 10 + 20
    expect(clock.nextWait()).toBe(30_000)

    clock.fire()
    expect(lines[2]).toContain('60s')
    // steps 用完后沿用最后一个间隔，避免长任务里刷屏
    expect(clock.nextWait()).toBe(30_000)
  })

  it('stop() 后不再出声（收到首个事件或本轮结束时调用）', () => {
    const clock = fakeClock()
    const lines: string[] = []
    const h = startStallNotice((s) => lines.push(s), { steps: [10_000], scheduler: clock.scheduler })
    clock.fire()
    expect(h.notices()).toBe(1)

    h.stop()
    clock.fire(3)
    expect(h.notices()).toBe(1) // 不再增长
    expect(lines).toHaveLength(1)

    h.stop() // 幂等
    expect(h.notices()).toBe(1)
  })

  it('默认节奏：尽早出声（≤15s），随后不超过 60s 一次', () => {
    expect(STALL_NOTICE_STEPS_MS[0]).toBeLessThanOrEqual(15_000)
    expect(Math.max(...STALL_NOTICE_STEPS_MS)).toBeLessThanOrEqual(60_000)
  })
})
