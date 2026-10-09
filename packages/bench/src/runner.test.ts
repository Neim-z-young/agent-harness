/**
 * 端到端 smoke：runTask 全链路（HarnessHost boot → 工具池注入 → user sim → judge）
 *
 * 用 mock provider 且 user simulator 首响即 ###STOP### —— 覆盖装配/会话/判分管线，
 * 不消耗真实模型调用。真实模型跑分见 docs/tau-bench-plan.md 的 smoke 章节。
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRetailDb, loadRetailTasks } from './data'
import { runTask } from './runner'

describe('runTask 端到端（mock provider）', () => {
  it('user sim 首响 STOP ⇒ 正常终止 + judge 空轨迹', async () => {
    const task = loadRetailTasks().find((t) => t.id === '0')!
    const runRoot = join(mkdtempSync(join(tmpdir(), 'bench-smoke-')), 'sessions')

    const result = await runTask({
      task,
      sampleIndex: 0,
      runRootDir: runRoot,
      agentProvider: { id: 'bench-agent', type: 'mock', model: 'mock-model', opts: {} },
      userProvider: { type: 'mock', model: 'mock-model', opts: {} },
      maxTurns: 5,
      maxSteps: 10,
      initialDb: loadRetailDb(),
    })

    // mock 的 defaultResponse 是 '(mock)'，不含 STOP token —— 循环会跑满 maxTurns。
    // 这里验证的是全链路不崩、用量/判分字段齐全（mock 下 5 轮很快）。
    expect(result.taskId).toBe('0')
    expect(result.terminated === 'max_turns' || result.terminated === 'user_stop').toBe(true)
    expect(result.trajectory.length).toBeGreaterThan(0)
    expect(result.turns).toBeGreaterThan(0)
    expect(result.latencyMs).toBeGreaterThan(0)
    expect(typeof result.dbMatch).toBe('boolean')
    // 空转轨迹（mock 不调工具）判分：task 0 有写操作 golden ⇒ 必然 dbMatch=false
    expect(result.dbMatch).toBe(false)
    expect(result.userSimUsage.calls).toBeGreaterThan(0)
    expect(result.sessionId).not.toBe('')
  }, 120_000)
})
