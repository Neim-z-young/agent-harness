/**
 * @harness/bench CLI 入口
 *
 * 用法（monorepo 根目录）：
 *   bun packages/bench/src/cli.ts \
 *     --provider openai --model gpt-4o \
 *     --user-model gpt-4o \
 *     [--split test] [--task-ids 0,1,2] [--k 1] [--max-turns 25] [--max-steps 30] \
 *     [--concurrency 4] [--out ./bench-results] [--api-key ... --base-url ... --api-path ...]
 *
 * API key 也可走环境变量（provider 插件自行读取，如 OPENAI_API_KEY）。
 */
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadRetailDb, loadRetailTasks, loadTasksBySplit } from './data'
import { runTask, type ProviderOpts } from './runner'
import { renderReport, summarize, writeResults } from './metrics'
import type { TauTask, TaskRunResult } from './types'

interface CliArgs {
  provider: string
  model: string
  userProvider: string
  userModel: string
  apiKey?: string
  baseUrl?: string
  apiPath?: string
  split: 'train' | 'test' | 'all'
  taskIds?: string[]
  k: number
  maxTurns: number
  maxSteps: number
  concurrency: number
  out: string
}

function parseArgs(argv: string[]): Partial<CliArgs> {
  const out: Partial<CliArgs> & Record<string, unknown> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = () => argv[++i]
    switch (a) {
      case '--provider': out.provider = next(); break
      case '--model': out.model = next(); break
      case '--user-provider': out.userProvider = next(); break
      case '--user-model': out.userModel = next(); break
      case '--api-key': out.apiKey = next(); break
      case '--base-url': out.baseUrl = next(); break
      case '--api-path': out.apiPath = next(); break
      case '--split': out.split = (next() as CliArgs['split']) ?? 'test'; break
      case '--task-ids': out.taskIds = (next() ?? '').split(',').map((s) => s.trim()).filter(Boolean); break
      case '--k': out.k = Number(next()); break
      case '--max-turns': out.maxTurns = Number(next()); break
      case '--max-steps': out.maxSteps = Number(next()); break
      case '--concurrency': out.concurrency = Number(next()); break
      case '--out': out.out = next(); break
      case '--help':
        console.log(`τ-bench retail 跑分

必需: --model <id> --user-model <id>
可选: --provider openai --user-provider openai --api-key/--base-url/--api-path
      --split test|train|all --task-ids 0,1,2 --k 1 --max-turns 25 --max-steps 30
      --concurrency 4 --out ./bench-results`)
        process.exit(0)
      default:
        console.error(`未知参数: ${a}`)
        process.exit(1)
    }
  }
  return out
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.model || !args.userModel) {
    console.error('缺少 --model / --user-model（--help 查看用法）')
    return 1
  }
  const provider = args.provider ?? 'openai'
  const userProvider = args.userProvider ?? provider
  const opts: ProviderOpts = { apiKey: args.apiKey, baseUrl: args.baseUrl, apiPath: args.apiPath }
  const k = Math.max(1, args.k ?? 1)
  const maxTurns = args.maxTurns ?? 25
  const maxSteps = args.maxSteps ?? 30
  const concurrency = Math.max(1, args.concurrency ?? 4)
  const outDir = resolve(args.out ?? './bench-results')
  const split = args.split ?? 'test'

  let tasks: TauTask[]
  if (args.taskIds?.length) {
    const all = loadRetailTasks()
    tasks = args.taskIds.map((id) => all.find((t) => t.id === id)).filter((t): t is TauTask => !!t)
    if (tasks.length === 0) {
      console.error(`task-ids 无匹配: ${args.taskIds.join(',')}`)
      return 1
    }
  } else {
    tasks = loadTasksBySplit(split)
  }

  await mkdir(outDir, { recursive: true })
  console.error(`[bench] ${tasks.length} 个任务 × k=${k} · 并发 ${concurrency} · 输出 ${outDir}`)

  // 任务 × 采样 展平后并发执行
  const jobs: { task: TauTask; sample: number }[] = []
  for (const task of tasks) {
    for (let s = 0; s < k; s++) jobs.push({ task, sample: s })
  }

  const initialDb = loadRetailDb()
  const results: TaskRunResult[] = new Array(jobs.length)
  let cursor = 0
  let done = 0

  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++
      if (idx >= jobs.length) return
      const { task, sample } = jobs[idx]!
      try {
        results[idx] = await runTask({
          task,
          sampleIndex: sample,
          runRootDir: join(outDir, 'sessions'),
          agentProvider: { id: 'bench-agent', type: provider, model: args.model!, opts },
          userProvider: { type: userProvider, model: args.userModel!, opts },
          maxTurns,
          maxSteps,
          initialDb,
        })
      } catch (err) {
        results[idx] = {
          taskId: task.id,
          sampleIndex: sample,
          sessionId: '',
          terminated: 'error',
          turns: 0,
          trajectory: [],
          dbMatch: false,
          reward: 0,
          usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
          userSimUsage: { calls: 0, inputTokens: 0, outputTokens: 0 },
          latencyMs: 0,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      done++
      const r = results[idx]!
      console.error(
        `[bench] ${done}/${jobs.length} task=${task.id} s${sample} reward=${r.reward} db=${r.dbMatch ? 1 : 0} term=${r.terminated} ${(r.latencyMs / 1000).toFixed(1)}s${r.error ? ` ERR: ${r.error}` : ''}`,
      )
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))

  const summary = summarize(results, {
    domain: 'retail',
    split: args.taskIds?.length ? `ids:${args.taskIds.join(',')}` : split,
    model: args.model!,
    userModel: args.userModel!,
    k,
    maxTurns,
    startedAt: new Date().toISOString(),
  })
  writeResults(results, summary, outDir)
  console.log(renderReport(summary))
  console.error(`[bench] 明细: ${join(outDir, 'results.jsonl')} · 汇总: ${join(outDir, 'summary.json')}`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
