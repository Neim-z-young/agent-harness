/**
 * 插件**装载后端**（P1-5 的"worker 边界"）。
 *
 * ## 它给出什么 / 不给出什么（**实测得来，不是推测**）
 * 实测（2026-10-12，Bun 1.3.14）六条：
 * | 实测 | 结论 |
 * |---|---|
 * | worker 里能 `import('*.ts')` | 装载可行（bun 运行期转译） |
 * | `resourceLimits.maxOldGenerationSizeMb` 真的拦住内存炸弹 ⇒ worker `Out of memory` 而宿主存活 | **资源上限是真能力** |
 * | worker 里 `while(true){}` 期间主线程 tick 照常 | **事件循环隔离是真能力** |
 * | worker 里未捕获异常 ⇒ `error` 事件 + 宿主存活 | **崩溃隔离是真能力** |
 * | worker 里 `process.env` 键数 / `process.pid` 与宿主**完全一致** | **不是 env 边界** |
 * | worker 里 `writeFileSync` 照常成功 | **不是文件系统边界**（也不是网络边界） |
 *
 * ⇒ 一句话：**它是资源与故障边界，不是安全边界**。文案与文档都要照这个说，
 * 否则就是本方案反复在治的那种"看起来隔离了"。
 *
 * ## 为什么 worker 模式只登记、不装载
 * hooks 是宿主在 agent 循环里**同步**调插件的（`install(ctx)` 返回注册表）。跨线程同步回调
 * 需要完整 RPC 桥 —— 那是一条独立的、有自己验收口径的路线。现在硬接只会得到
 * "看起来装了、实际没生效"的插件，比不装更糟 ⇒ 这一轮**如实只做登记**，并在 notice 里说清楚。
 */
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import {
  PLUGIN_WORKER_DEFAULT_MEMORY_MB,
  PLUGIN_WORKER_DEFAULT_TIMEOUT_MS,
  type PluginExportSummary,
  type PluginWorkerRequest,
  type PluginWorkerResponse,
} from './plugin-worker-protocol'
import { scanPluginCode } from './plugin-scan'

/** worker 装载单个文件的结果 */
export interface WorkerLoadOutcome {
  file: string
  summaries: PluginExportSummary[]
  /** 静态扫描命中的条目（与 in-process 路径同一份判定） */
  findings: string[]
  error?: string
}

export interface WorkerLoadOptions {
  /** 内存上限（MB）；`0` = 不限 */
  memoryMb?: number
  /** 装载超时（ms）；`0` = 不限 */
  timeoutMs?: number
}

/**
 * 在 worker 里装载若干插件文件。
 *
 * **fail-closed**：worker 起不来 / 超时 / 模块报错 ⇒ 该文件**不加载**（不静默回退到
 * "in-process 全权"—— 那等于用户要求收窄却拿到了最宽的那条路）。
 */
export async function loadPluginsInWorker(
  files: string[],
  opts: WorkerLoadOptions = {},
): Promise<WorkerLoadOutcome[]> {
  const out: WorkerLoadOutcome[] = []
  for (const file of files) {
    out.push(await loadOne(file, opts))
  }
  return out
}

async function loadOne(file: string, opts: WorkerLoadOptions): Promise<WorkerLoadOutcome> {
  const findings = readFindings(file)
  const base: WorkerLoadOutcome = { file, summaries: [], findings }

  return new Promise<WorkerLoadOutcome>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let worker: Worker | undefined
    // 统一出口：**这里 terminate**（而不是每个分支各写一次）—— 悬着的 worker 会让测试进程
    // 不退出（本仓踩过"异步用例不 settle ⇒ CPU 空转"的坑，同族）。
    const done = (patch: Partial<WorkerLoadOutcome>): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (worker) void worker.terminate()
      resolve({ ...base, ...patch })
    }

    try {
      worker = new Worker(new URL('./plugin-worker-entry.ts', import.meta.url), {
        workerData: { file } as PluginWorkerRequest,
        ...(opts.memoryMb === 0 ? {} : {
          resourceLimits: { maxOldGenerationSizeMb: opts.memoryMb ?? PLUGIN_WORKER_DEFAULT_MEMORY_MB },
        }),
      })
    } catch (err) {
      // 起不来（例如单文件二进制里 entry 不在）：如实报错并跳过，**不回退到 in-process**
      // —— 用户要求收窄却拿到最宽的那条路，是最坏的一种"降级"。
      done({ error: `worker 无法启动：${(err as Error)?.message ?? String(err)}` })
      return
    }

    const timeoutMs = opts.timeoutMs ?? PLUGIN_WORKER_DEFAULT_TIMEOUT_MS
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        done({ error: `装载超时（${timeoutMs}ms）—— 加载期的死循环只能靠超时拦` })
      }, timeoutMs)
    }

    worker.on('message', (m: PluginWorkerResponse) => {
      if (m.ok) done({ summaries: m.summaries })
      else done({ error: m.error })
    })
    worker.on('error', (err) => {
      // OOM 走这里（实测 `Error: Out of memory`）—— 宿主不受影响正是 worker 模式的价值
      done({ error: `worker 内加载失败：${(err as Error)?.message ?? String(err)}` })
    })
    worker.on('exit', (code) => {
      // message/error 已 settle 的话这里是 no-op；否则是"没回话就退了"
      done({ error: `worker 提前退出（code=${code}）` })
    })
  })
}

function readFindings(file: string): string[] {
  try {
    return scanPluginCode(readFileSync(file, 'utf-8')).map((f) => `${file}:${f.line} [${f.rule}] ${f.label}`)
  } catch {
    return []
  }
}
