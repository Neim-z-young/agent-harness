/**
 * 用量统计端到端回归：会话重连（resume）后不清零 + 历史用量可导出。
 *
 * 复现用户场景：
 *   1. 会话产生了用量并落盘（模拟「重连前」）
 *   2. 从磁盘重新加载会话（模拟 TUI/REPL 重连，内存态全部丢失）
 *   3. /stats 与 /stats-export 仍应看到重连前的累计用量，且当日归集正确
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  HarnessApp,
  resolveCurrentUsage,
  resolveTodayUsage,
} from './index'
import type { Session } from '@harness/session'
import {
  emptyUsage,
  recordCall,
  exportStatsJson,
  exportStatsMarkdown,
  USAGE_STATS_KEY,
  type UsageStats,
} from './usage-stats'

/** 取某天 hh 点的时间戳 */
function at(dayOffset: number, hour: number): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

function makeApp(dir: string): HarnessApp {
  return new HarnessApp({
    cwd: dir,
    dataDir: join(dir, '.harness'),
    agentId: 'default',
    provider: 'mock',
    permissionMode: 'allow-all',
    mockProviderConfig: { defaultResponse: 'hi' },
  })
}

describe('用量统计：重连不清零 + 历史可导出', () => {
  it('重连后仍读到重连前的累计用量，并只把当天部分计入「今日」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-usage-'))
    const app = makeApp(dir)
    try {
      const { harness, session } = await app.boot()

      // 1) 构造「重连前」的用量：昨天 1 次 + 今天 2 次
      let before: UsageStats = emptyUsage()
      before = recordCall(before, { model: 'mock/m1', input: 1000, output: 100, ts: at(-1, 10) })
      before = recordCall(before, { model: 'mock/m1', input: 2000, output: 200, ts: at(0, 9) })
      before = recordCall(before, { model: 'mock/m1', input: 3000, output: 300, ts: at(0, 11) })
      await harness.session.updateMeta(session.id, { [USAGE_STATS_KEY]: before })
      await app.sessionStore.save(session)

      // 2) 模拟重连：丢弃内存态，从磁盘重新加载
      const reloaded = await app.sessionStore.load(session.id)
      expect(reloaded).toBeTruthy()
      const current = reloaded as unknown as Session

      // 3) 重连后解析用量：不应为 0，且等于重连前的累计
      const u = await resolveCurrentUsage(harness, current)
      expect(u.llmCalls).toBe(3)
      expect(u.inputTokens).toBe(6000)
      expect(u.outputTokens).toBe(600)

      // 4) 当日归集：含今天 2 次 / 5000 输入（跨会话归集会带上本会话）
      const t = await resolveTodayUsage(app, current)
      expect(t.llmCalls).toBe(2)
      expect(t.inputTokens).toBe(5000)
      expect(t.outputTokens).toBe(500)

      // 5) 导出能带上重连前的用量
      const json = JSON.parse(exportStatsJson(u, { sessionId: session.id, today: t }))
      expect(json.llmCalls).toBe(3)
      expect(json.inputTokens).toBe(6000)
      expect(json.today.llmCalls).toBe(2)
      expect(exportStatsMarkdown(u, { sessionId: session.id, today: t })).toContain('| 当日输入 token | 5000 |')

      await app.shutdown()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('meta 为空累积器时，仍能由消息历史重建出用量（防清零兜底）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-usage2-'))
    const app = makeApp(dir)
    try {
      const { session } = await app.boot()
      // boot 只建内存会话（0 消息不落盘，等第一条消息由轮末 flush 写出）。本用例测的是
      // "重连后能从磁盘读回用量"，所以先显式落一次 —— 与上一用例同一步。
      await app.sessionStore.save(session)
      const cur = await app.sessionStore.load(session.id)
      expect(cur).toBeTruthy()

      // meta 里放一个空累积器（旧实现会把它当作「有数据」从而显示 0）
      const clobbered = {
        ...cur!,
        meta: { ...(cur!.meta ?? {}), [USAGE_STATS_KEY]: emptyUsage() },
        messages: [
          {
            id: 'm1',
            role: 'assistant' as const,
            createdAt: at(0, 9),
            parts: [{ type: 'text' as const, text: 'hello' }],
            meta: { model: 'mock/m1', tokenUsage: { input: 777, output: 7 } },
          },
        ],
      }
      await app.sessionStore.save(clobbered as never)

      const u = await resolveCurrentUsage(app._harness, clobbered as unknown as Session)
      expect(u.llmCalls).toBe(1)
      expect(u.inputTokens).toBe(777)

      const t = await resolveTodayUsage(app, clobbered as unknown as Session)
      expect(t.inputTokens).toBe(777)

      await app.shutdown()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('内存态消息无 tokenUsage 时，回源 SessionManager 重建出历史用量', async () => {
    // 回归：此前按 current.messages.length 判断是否回源，导致「内存视图消息非空
    // 但都不带 tokenUsage」时直接返回 0，磁盘上的历史用量永远读不到。
    const diskSession = {
      id: 's1',
      meta: {},
      messages: [
        {
          id: 'm1',
          role: 'assistant' as const,
          createdAt: at(0, 9),
          parts: [{ type: 'text' as const, text: 'x' }],
          meta: { model: 'mock/m1', tokenUsage: { input: 999, output: 9 } },
        },
      ],
    }
    // 内存里的不完整视图：消息非空，但没有任何 tokenUsage
    const partialView = {
      id: 's1',
      meta: {},
      messages: [{ id: 'm0', role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }] }],
    }
    const harness = { session: { get: async () => diskSession } } as never
    const u = await resolveCurrentUsage(harness, partialView as unknown as Session)
    expect(u.llmCalls).toBe(1)
    expect(u.inputTokens).toBe(999)
    expect(u.outputTokens).toBe(9)
  })

  it('当天无用量时，今日归集返回空而非报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-usage3-'))
    const app = makeApp(dir)
    try {
      const { session } = await app.boot()
      const t = await resolveTodayUsage(app, session)
      expect(t.llmCalls).toBe(0)
      expect(t.inputTokens).toBe(0)
      await app.shutdown()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
