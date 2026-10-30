/**
 * τ³-bench 指标与报表
 *
 * pass^k（官方口径）：任务级「k 次采样全部通过」的比例（对 k=1..K 逐级计算）。
 * 自有指标（方案定稿，从运行结果聚合）：成本（agent + user simulator tokens）、
 * 延迟（总/轮/agent 轮）、步数（工具调用数）、终止原因分布。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
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
  /** 实际 run 数（pass^k 的分母是任务数；run 数用于核对 任务数 × k 是否跑满） */
  numRuns: number
  /** 报错 run 数（可观测性：不必逐行翻 results.jsonl 才知道这次跑挂了几个） */
  numErrors: number
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

/**
 * 单 run 的工具调用总数。
 *
 * 「步数」这个口径此前在 per-task 明细与全局均值里各写了一遍 reduce，两处一旦漂移
 * 就会出现「明细和均值对不上」且全程无症状 —— 收敛成一份，两个调用点共用。
 */
export function countToolCalls(r: TaskRunResult): number {
  return r.trajectory.reduce((n, t) => n + t.toolCalls.length, 0)
}

/** 均值（空集记 0 而不是 NaN —— NaN 会一路渗进 summary.json 与报表） */
export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

/**
 * 任务 id 排序：两侧都是有限数字时按数值，否则按字典。
 *
 * 原先直接 `Number(a) - Number(b)`：非数字 id 会算出 NaN，而 NaN 比较器在规范里是
 * 「实现定义」—— 排序结果不可预期且无声无息。显式分派后任何 id 都有确定顺序。
 */
export function compareTaskId(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  const numeric = Number.isFinite(na) && Number.isFinite(nb) && a.trim() !== '' && b.trim() !== ''
  return numeric ? na - nb : a.localeCompare(b)
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
      toolCalls: runs.map(countToolCalls),
      latencyMs: runs.map((r) => r.latencyMs),
      error: runs.find((r) => r.error)?.error,
    })
  }
  perTask.sort((a, b) => compareTaskId(a.taskId, b.taskId))

  // pass^k 的 K：以「配置的 k」为准，实际采样数只用来兜底（配置缺失/为 0 时）。
  // 此前只用实际采样数，报表上会出现「meta.k=3 但只报 pass^1」的自相矛盾。
  const k = Math.max(1, Number.isFinite(meta.k) ? Math.floor(meta.k) : 0, ...perTask.map((t) => t.rewards.length))
  const passAtK: Record<number, number> = {}
  for (let kk = 1; kk <= k; kk++) {
    // 官方口径：「k 次采样全部通过」⇒ 采样数不足 k 的任务不得计为通过。
    // 此前 `rewards.slice(0, kk)` 对短数组静默退化成「有几个算几个」——
    // 一次中断/报错的跑分会据此把残缺任务当成通过，系统性高估 pass^k。
    const passed = perTask.filter(
      (t) => t.rewards.length >= kk && t.rewards.slice(0, kk).every((r) => r === 1),
    ).length
    passAtK[kk] = perTask.length > 0 ? passed / perTask.length : 0
  }

  const allRuns = results
  const terminationCounts: Partial<Record<TerminationReason, number>> = {}
  for (const r of allRuns) terminationCounts[r.terminated] = (terminationCounts[r.terminated] ?? 0) + 1

  return {
    meta,
    numTasks: perTask.length,
    numRuns: allRuns.length,
    numErrors: allRuns.filter((r) => !!r.error).length,
    passAtK,
    avgReward: mean(allRuns.map((r) => r.reward)),
    avgTurns: mean(allRuns.map((r) => r.turns)),
    avgToolCalls: mean(allRuns.map(countToolCalls)),
    avgLatencyMs: mean(allRuns.map((r) => r.latencyMs)),
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
  lines.push(`pass^k: ${passKeys.map((kk) => `pass^${kk}=${pct(s.passAtK[kk] ?? 0)}`).join('  ')}`)
  lines.push(
    `runs: ${s.numRuns}（报错 ${s.numErrors}）· 平均 reward: ${s.avgReward.toFixed(3)} · 平均轮数: ${s.avgTurns.toFixed(1)} · 平均工具调用: ${s.avgToolCalls.toFixed(1)}`,
  )
  lines.push(
    `平均耗时: ${(s.avgLatencyMs / 1000).toFixed(1)}s · agent tokens: in ${s.agentTokens.input} / out ${s.agentTokens.output} (缓存读 ${s.agentTokens.cacheRead}, ${s.agentTokens.llmCalls} 次调用) · user sim tokens: in ${s.userSimTokens.input} / out ${s.userSimTokens.output} (${s.userSimTokens.calls} 次)`,
  )
  const term = Object.entries(s.terminationCounts).map(([k2, v]) => `${k2}:${v}`).join(' ')
  lines.push(`终止分布: ${term || '—'}`)
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
  // 公开 API 不该要求调用方先 mkdir：CLI 建过目录，但直接调 metrics 的宿主没有，
  // 原实现会在 ENOENT 上崩且报错信息指不到「目录没建」。
  mkdirSync(outDir, { recursive: true })
  const jsonl = results
    .map((r) => JSON.stringify(r))
    .join('\n')
  // 空结果写空文件（原实现会写一个孤立的 "\n"，读取方按行解析时多出一条空记录）
  writeFileSync(join(outDir, 'results.jsonl'), results.length > 0 ? jsonl + '\n' : '')
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  // M4：跑分历史追加（逐次 append，跨多次跑组成 pass^k 趋势 / 成本·延迟对比）。
  // 单行一 summary（无换行），读取方按行解析；TUI 面板建议 `--out <dataDir>/bench` 以便可见。
  writeFileSync(join(outDir, 'history.jsonl'), JSON.stringify(summary) + '\n', { flag: 'a' })
}
