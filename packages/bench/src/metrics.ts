/**
 * τ³-bench 指标与报表
 *
 * pass^k（官方口径）：任务级「k 次采样全部通过」的比例（对 k=1..K 逐级计算）。
 * 自有指标（方案定稿，从运行结果聚合）：成本（agent + user simulator tokens）、
 * 延迟（总/轮/agent 轮）、步数（工具调用数）、终止原因分布。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskRunResult, TerminationReason } from './types'

export interface TaskSummary {
  taskId: string
  /** 各采样 reward（长度 = 实际采样数） */
  rewards: number[]
  /** k 次全部通过 */
  allPass: boolean
  dbMatch: number[]
  terminated: TerminationReason[]
  turns: number[]
  toolCalls: number[]
  latencyMs: number[]
  error?: string
}

export interface BenchSummary {
  meta: {
    domain: string
    split: string
    model: string
    userModel: string
    k: number
    maxTurns: number
    startedAt: string
  }
  numTasks: number
  /** pass^1 .. pass^K（任务级全通过率，官方口径） */
  passAtK: Record<number, number>
  /** 平均单采样 reward（与 pass^1 不同：不含跨采样一致性惩罚） */
  avgReward: number
  avgTurns: number
  avgToolCalls: number
  avgLatencyMs: number
  agentTokens: { input: number; output: number; cacheRead: number; llmCalls: number }
  userSimTokens: { input: number; output: number; calls: number }
  terminationCounts: Partial<Record<TerminationReason, number>>
  perTask: TaskSummary[]
}

export function summarize(
  results: TaskRunResult[],
  meta: BenchSummary['meta'],
): BenchSummary {
  const byTask = new Map<string, TaskRunResult[]>()
  for (const r of results) {
    const list = byTask.get(r.taskId) ?? []
    list.push(r)
    byTask.set(r.taskId, list)
  }

  const perTask: TaskSummary[] = []
  for (const [taskId, runs] of byTask) {
    runs.sort((a, b) => a.sampleIndex - b.sampleIndex)
    perTask.push({
      taskId,
      rewards: runs.map((r) => r.reward),
      allPass: runs.every((r) => r.reward === 1),
      dbMatch: runs.map((r) => (r.dbMatch ? 1 : 0)),
      terminated: runs.map((r) => r.terminated),
      turns: runs.map((r) => r.turns),
      toolCalls: runs.map((r) =>
        r.trajectory.reduce((n, t) => n + t.toolCalls.length, 0),
      ),
      latencyMs: runs.map((r) => r.latencyMs),
      error: runs.find((r) => r.error)?.error,
    })
  }
  perTask.sort((a, b) => Number(a.taskId) - Number(b.taskId))

  const k = Math.max(1, ...perTask.map((t) => t.rewards.length))
  const passAtK: Record<number, number> = {}
  for (let kk = 1; kk <= k; kk++) {
    const passed = perTask.filter((t) => t.rewards.slice(0, kk).every((r) => r === 1)).length
    passAtK[kk] = perTask.length > 0 ? passed / perTask.length : 0
  }

  const allRuns = results
  const terminationCounts: Partial<Record<TerminationReason, number>> = {}
  for (const r of allRuns) terminationCounts[r.terminated] = (terminationCounts[r.terminated] ?? 0) + 1

  return {
    meta,
    numTasks: perTask.length,
    passAtK,
    avgReward: allRuns.length > 0 ? allRuns.reduce((s, r) => s + r.reward, 0) / allRuns.length : 0,
    avgTurns: allRuns.length > 0 ? allRuns.reduce((s, r) => s + r.turns, 0) / allRuns.length : 0,
    avgToolCalls:
      allRuns.length > 0
        ? allRuns.reduce((s, r) => s + r.trajectory.reduce((n, t) => n + t.toolCalls.length, 0), 0) / allRuns.length
        : 0,
    avgLatencyMs: allRuns.length > 0 ? allRuns.reduce((s, r) => s + r.latencyMs, 0) / allRuns.length : 0,
    agentTokens: {
      input: allRuns.reduce((s, r) => s + r.usage.inputTokens, 0),
      output: allRuns.reduce((s, r) => s + r.usage.outputTokens, 0),
      cacheRead: allRuns.reduce((s, r) => s + r.usage.cacheReadTokens, 0),
      llmCalls: allRuns.reduce((s, r) => s + r.usage.llmCalls, 0),
    },
    userSimTokens: {
      input: allRuns.reduce((s, r) => s + r.userSimUsage.inputTokens, 0),
      output: allRuns.reduce((s, r) => s + r.userSimUsage.outputTokens, 0),
      calls: allRuns.reduce((s, r) => s + r.userSimUsage.calls, 0),
    },
    terminationCounts,
    perTask,
  }
}

/** 控制台报表（stdout 汇总块） */
export function renderReport(s: BenchSummary): string {
  const lines: string[] = []
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  lines.push('════════ τ-bench (retail) 汇总 ════════')
  lines.push(
    `模型: ${s.meta.model} · 用户模拟: ${s.meta.userModel} · split: ${s.meta.split} · 任务数: ${s.numTasks} · k: ${s.meta.k}`,
  )
  const passKeys = Object.keys(s.passAtK).map(Number).sort((a, b) => a - b)
  lines.push(`pass^k: ${passKeys.map((kk) => `pass^${kk}=${pct(s.passAtK[kk]!)}`).join('  ')}`)
  lines.push(`平均 reward: ${s.avgReward.toFixed(3)} · 平均轮数: ${s.avgTurns.toFixed(1)} · 平均工具调用: ${s.avgToolCalls.toFixed(1)}`)
  lines.push(
    `平均耗时: ${(s.avgLatencyMs / 1000).toFixed(1)}s · agent tokens: in ${s.agentTokens.input} / out ${s.agentTokens.output} (缓存读 ${s.agentTokens.cacheRead}, ${s.agentTokens.llmCalls} 次调用) · user sim tokens: in ${s.userSimTokens.input} / out ${s.userSimTokens.output} (${s.userSimTokens.calls} 次)`,
  )
  const term = Object.entries(s.terminationCounts).map(([k2, v]) => `${k2}:${v}`).join(' ')
  lines.push(`终止分布: ${term}`)
  // 失败任务明细（前 20）
  const failed = s.perTask.filter((t) => !t.allPass)
  if (failed.length > 0) {
    lines.push(`── 未通过任务（${failed.length}/${s.numTasks}）──`)
    for (const t of failed.slice(0, 20)) {
      lines.push(
        `  task ${t.taskId}: reward=[${t.rewards.join(',')}] db=[${t.dbMatch.join(',')}] term=[${t.terminated.join(',')}]${t.error ? ` err=${t.error}` : ''}`,
      )
    }
    if (failed.length > 20) lines.push(`  … 其余 ${failed.length - 20} 个见 results.jsonl`)
  }
  return lines.join('\n')
}

/** 结果落盘：results.jsonl（每 run 一行）+ summary.json */
export function writeResults(results: TaskRunResult[], summary: BenchSummary, outDir: string): void {
  const jsonl = results
    .map((r) => JSON.stringify(r))
    .join('\n')
  writeFileSync(join(outDir, 'results.jsonl'), jsonl + '\n')
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  // M4：跑分历史追加（逐次 append，跨多次跑组成 pass^k 趋势 / 成本·延迟对比）。
  // 单行一 summary（无换行），读取方按行解析；TUI 面板建议 `--out <dataDir>/bench` 以便可见。
  writeFileSync(join(outDir, 'history.jsonl'), JSON.stringify(summary) + '\n', { flag: 'a' })
}
