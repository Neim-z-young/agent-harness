/**
 * metrics：跑分口径的回归网。
 *
 * 这个文件此前完全缺席 —— summarize / renderReport / writeResults 是「这次跑分到底
 * 多少分」的唯一口径来源，却一个用例都没有。这里的用例按口径逐条钉住，尤其是 pass^k
 * 的「采样不足 k 不得计为通过」：它错了不会崩，只会静默把分数报高。
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareTaskId, countToolCalls, mean, renderReport, summarize, writeResults, type BenchSummary } from './metrics'
import type { TaskRunResult, TurnRecord } from './types'

const META: BenchSummary['meta'] = {
  domain: 'retail',
  split: 'test',
  model: 'agent-model',
  userModel: 'user-model',
  k: 1,
  maxTurns: 5,
  startedAt: '2026-10-31T00:00:00.000Z',
}

function turn(role: TurnRecord['role'], toolCalls: number, latencyMs = 10): TurnRecord {
  return {
    role,
    text: role === 'assistant' ? 'ok' : 'hi',
    toolCalls: Array.from({ length: toolCalls }, (_, i) => ({
      toolId: `tool-${i}`,
      input: {},
      isError: false,
    })),
    latencyMs,
  }
}

function run(
  taskId: string,
  sampleIndex: number,
  reward: number,
  opts: { toolCalls?: number; error?: string; terminated?: TaskRunResult['terminated'] } = {},
): TaskRunResult {
  return {
    taskId,
    sampleIndex,
    sessionId: 'sess-1',
    terminated: opts.terminated ?? 'user_stop',
    turns: 1,
    trajectory: [turn('assistant', opts.toolCalls ?? 0)],
    dbMatch: reward === 1,
    reward,
    usage: { llmCalls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
    userSimUsage: { calls: 1, inputTokens: 3, outputTokens: 4 },
    latencyMs: 100,
    error: opts.error,
  }
}

describe('口径工具（供明细与均值共用同一份实现）', () => {
  it('mean: 空集记 0 而不是 NaN', () => {
    expect(mean([])).toBe(0)
    expect(mean([1, 2, 3])).toBe(2)
    expect(Number.isNaN(mean([]))).toBe(false)
  })

  it('countToolCalls: 汇总该 run 所有轮的工具调用', () => {
    const r = run('0', 0, 1, { toolCalls: 3 })
    r.trajectory.push(turn('assistant', 2), turn('user', 0))
    expect(countToolCalls(r)).toBe(5)
  })

  it('compareTaskId: 纯数字按数值（"10" 排在 "9" 之后）', () => {
    expect(['10', '9', '1'].sort(compareTaskId)).toEqual(['1', '9', '10'])
  })

  it('compareTaskId: 非数字 id 不产生 NaN 比较器，退回字典序', () => {
    expect(['b', 'a', '10'].sort(compareTaskId)).toEqual(['10', 'a', 'b'])
    expect(Number.isNaN(compareTaskId('abc', 'def'))).toBe(false)
  })
})

describe('summarize', () => {
  it('空输入：全 0 / 不出现 NaN', () => {
    const s = summarize([], META)
    expect(s.numTasks).toBe(0)
    expect(s.numRuns).toBe(0)
    expect(s.numErrors).toBe(0)
    expect(s.passAtK[1]).toBe(0)
    expect(Number.isNaN(s.avgReward)).toBe(false)
    expect(s.avgReward).toBe(0)
  })

  it('两个任务一成一败 ⇒ pass^1 = 0.5', () => {
    const s = summarize([run('0', 0, 1), run('1', 0, 0)], META)
    expect(s.numTasks).toBe(2)
    expect(s.passAtK[1]).toBe(0.5)
  })

  it('k=2 且两次采样都通过 ⇒ pass^1 = pass^2 = 1', () => {
    const s = summarize([run('0', 0, 1), run('0', 1, 1)], { ...META, k: 2 })
    expect(s.passAtK[1]).toBe(1)
    expect(s.passAtK[2]).toBe(1)
  })

  it('同一任务采样部分失败 ⇒ pass^2 = 0（pass^1 只看每次采样的首个采样）', () => {
    const s = summarize([run('0', 0, 1), run('0', 1, 0)], { ...META, k: 2 })
    // pass^k 的分母是任务数：该任务首个采样通过 ⇒ pass^1 = 1；两次未全通过 ⇒ pass^2 = 0。
    expect(s.passAtK[1]).toBe(1)
    expect(s.passAtK[2]).toBe(0)
    // 采样级平均 reward 才是 0.5（与 pass^1 是两把尺子，别混）
    expect(s.avgReward).toBe(0.5)
  })

  // ★ 核心口径：官方 pass^k 要求「k 次采样全部通过」。
  // 采样数不足 k（跑中断 / 报错 / 只跑了部分 k）的任务不得计为通过，
  // 否则残缺跑分会被静默当成通过，系统性高估分数。
  it('采样数不足 k 的任务不计入 pass^k（不静默当成通过）', () => {
    const s = summarize([run('0', 0, 1)], { ...META, k: 2 })
    expect(s.passAtK[1]).toBe(1)
    expect(s.passAtK[2]).toBe(0)
  })

  it('passAtK 覆盖到配置的 k（即便实际采样数更少）', () => {
    const s = summarize([run('0', 0, 1)], { ...META, k: 3 })
    expect(Object.keys(s.passAtK).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('numRuns / numErrors 单独统计（报表能直接回答「这次挂了几个」）', () => {
    const s = summarize(
      [run('0', 0, 1), run('1', 0, 0, { error: 'boom' }), run('2', 0, 0, { error: 'boom' })],
      META,
    )
    expect(s.numRuns).toBe(3)
    expect(s.numErrors).toBe(2)
  })

  it('终止原因分布与明细按 taskId 数值序', () => {
    const s = summarize(
      [
        run('10', 0, 1, { terminated: 'user_stop' }),
        run('9', 0, 1, { terminated: 'max_turns' }),
        run('2', 0, 1, { terminated: 'user_stop' }),
      ],
      META,
    )
    expect(s.perTask.map((t) => t.taskId)).toEqual(['2', '9', '10'])
    expect(s.terminationCounts.user_stop).toBe(2)
    expect(s.terminationCounts.max_turns).toBe(1)
  })

  it('perTask 明细的 toolCalls 与全局均值取同一个口径', () => {
    const s = summarize([run('0', 0, 1, { toolCalls: 2 }), run('1', 0, 1, { toolCalls: 4 })], META)
    expect(s.perTask.find((t) => t.taskId === '0')!.toolCalls[0]).toBe(2)
    expect(s.avgToolCalls).toBe(3)
  })
})

describe('renderReport', () => {
  it('汇总行含 pass^k / runs / 平均 reward', () => {
    const s = summarize([run('0', 0, 1), run('1', 0, 0, { error: 'boom' })], { ...META, k: 2 })
    const text = renderReport(s)
    expect(text).toContain('pass^1=50.0%')
    expect(text).toContain('pass^2=0.0%')
    expect(text).toContain('runs: 2（报错 1）')
    expect(text).toContain('平均 reward: 0.500')
  })

  it('失败明细 > 20 条时截断并提示总数', () => {
    const runs: TaskRunResult[] = []
    for (let i = 0; i < 25; i++) runs.push(run(String(i), 0, 0))
    const text = renderReport(summarize(runs, META))
    expect(text).toContain('未通过任务（25/25）')
    expect(text).toContain('其余 5 个见 results.jsonl')
  })

  it('无 run 时终止分布不渲染成空字符串', () => {
    expect(renderReport(summarize([], META))).toContain('终止分布: —')
  })
})

describe('writeResults', () => {
  it('输出目录不存在时自建（公开 API 不该依赖调用方先 mkdir）', () => {
    const outDir = join(mkdtempSync(join(tmpdir(), 'bench-metrics-')), 'nested', 'out')
    const s = summarize([run('0', 0, 1)], META)
    writeResults([run('0', 0, 1)], s, outDir)

    expect(existsSync(join(outDir, 'results.jsonl'))).toBe(true)
    expect(existsSync(join(outDir, 'summary.json'))).toBe(true)
    const lines = readFileSync(join(outDir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]!).taskId).toBe('0')
    expect(JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8')).numRuns).toBe(1)
  })

  it('history.jsonl 逐次 append（跨多次跑组成趋势）', () => {
    const outDir = join(mkdtempSync(join(tmpdir(), 'bench-hist-')), 'out')
    writeResults([run('0', 0, 1)], summarize([run('0', 0, 1)], META), outDir)
    writeResults([run('0', 0, 0)], summarize([run('0', 0, 0)], META), outDir)
    const hist = readFileSync(join(outDir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean)
    expect(hist.length).toBe(2)
    expect(JSON.parse(hist[0]!).avgReward).toBe(1)
    expect(JSON.parse(hist[1]!).avgReward).toBe(0)
  })

  it('空结果写空文件而不是一个孤立的换行', () => {
    const outDir = join(mkdtempSync(join(tmpdir(), 'bench-empty-')), 'out')
    writeResults([], summarize([], META), outDir)
    expect(readFileSync(join(outDir, 'results.jsonl'), 'utf8')).toBe('')
  })
})
