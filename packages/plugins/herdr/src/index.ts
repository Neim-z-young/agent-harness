/**
 * @harness/herdr
 *
 * Herdr 集成插件：把 Agent 运行状态上报到 Herdr（agent 感知的终端复用器）侧栏，
 * 使多 agent 并行时能从侧栏一眼看出「谁在跑 / 谁空闲 / 谁在等你批准」。
 *
 * **上报协议**（herdr.dev/docs/integrations「Integrate your own agent」）：
 * ```
 * "$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" \
 *   --source custom:harness --agent harness --state working \
 *   [--seq N] [--agent-session-id <id>] [--message <desc>]
 * # 退出时释放（不是报 done —— 协议只有 working / idle / blocked 三态）
 * "$HERDR_BIN_PATH" pane release-agent "$HERDR_PANE_ID" --source custom:harness --agent harness
 * ```
 *
 * 三条硬约束（均来自官方原文）：
 * 1. **只在 Herdr 内生效** —— 必须 `HERDR_ENV=1` 且 `HERDR_PANE_ID`/`HERDR_BIN_PATH` 齐备，
 *    否则全程 no-op。这是官方明确要求（"keeps the integration a no-op outside Herdr"），
 *    也是本插件不在非 Herdr 环境产生任何副作用/进程的原因。
 * 2. **乱序防护用 `--seq`** —— 官方：若上报可能乱序，需带严格递增序号，Herdr 丢弃同源旧序号。
 *    本插件的 spawn 是 fire-and-forget（并发上报无法保证完成顺序），故**必须**带。
 * 3. 退出时要 `release-agent` 交还生命周期权威，而不是报 done。
 *
 * 为什么做成插件而非内嵌 CLI：状态上报属于「环境集成」，与 CLI 主流程无耦合；
 * 做成插件后可 `plugins: ["herdr"]` 按需启用，不在 Herdr 里跑的用户零开销、零代码路径。
 */

import { spawn, spawnSync } from 'node:child_process'
import type {
  AgentPlugin,
  AgentStatusSnapshot,
  AgentStreamSignal,
  Hooks,
  PermissionDecisionLike,
  PermissionRequestLike,
} from '@harness/plugin'

// ===== 环境探测 =====

/** Herdr 注入给 pane 内进程的环境（缺一即判定不在 Herdr 内） */
export interface HerdrEnv {
  paneId: string
  binPath: string
  socketPath?: string
}

/** 官方约定的四个环境变量名 */
export const HERDR_ENV_VARS = {
  marker: 'HERDR_ENV',
  paneId: 'HERDR_PANE_ID',
  binPath: 'HERDR_BIN_PATH',
  socketPath: 'HERDR_SOCKET_PATH',
} as const

/**
 * 探测是否运行在 Herdr pane 内；否则返回 undefined 表示「应全程 no-op」。
 *
 * 判定严格按官方要求：`HERDR_ENV=1` **且** paneId/binPath 齐备
 * （socketPath 可选 —— 本插件走 CLI，不用 socket IPC）。
 */
export function detectHerdrEnv(
  env: Record<string, string | undefined> = process.env,
): HerdrEnv | undefined {
  if (env[HERDR_ENV_VARS.marker] !== '1') return undefined
  const paneId = env[HERDR_ENV_VARS.paneId]
  const binPath = env[HERDR_ENV_VARS.binPath]
  if (!paneId || !binPath) return undefined
  const socketPath = env[HERDR_ENV_VARS.socketPath]
  return { paneId, binPath, ...(socketPath ? { socketPath } : {}) }
}

// ===== 状态映射 =====

/** Herdr 的三个语义状态（**没有 done** —— 结束靠 release） */
export type HerdrState = 'working' | 'idle' | 'blocked'

export const DEFAULT_SOURCE = 'custom:harness'
export const DEFAULT_AGENT = 'harness'

/**
 * Agent 状态 → Herdr 状态。
 *
 * - `thinking` / `streaming` / `tool` ⇒ working（模型在产出，或工具在跑）
 * - `idle` / `aborted` ⇒ idle —— 中断后进程回到等待输入，对 Herdr 而言就是空闲
 *   （不是 blocked：中断是用户主动结束，不需要「等你决策」）
 */
export function mapStatusToHerdrState(status: AgentStatusSnapshot): HerdrState {
  return status.phase === 'idle' || status.phase === 'aborted' ? 'idle' : 'working'
}

// ===== 命令构造（纯函数，便于单测） =====

export interface ReportOptions {
  state: HerdrState
  /** 严格递增序号；由 reporter 维护（官方要求乱序防护） */
  seq: number
  sessionId?: string
  message?: string
  source?: string
  agent?: string
}

export function buildReportArgs(env: HerdrEnv, o: ReportOptions): string[] {
  const args = [
    'pane',
    'report-agent',
    env.paneId,
    '--source',
    o.source ?? DEFAULT_SOURCE,
    '--agent',
    o.agent ?? DEFAULT_AGENT,
    '--state',
    o.state,
    '--seq',
    String(o.seq),
  ]
  if (o.sessionId) args.push('--agent-session-id', o.sessionId)
  if (o.message) args.push('--message', o.message)
  return args
}

export function buildReleaseArgs(
  env: HerdrEnv,
  o: { source?: string; agent?: string } = {},
): string[] {
  return [
    'pane',
    'release-agent',
    env.paneId,
    '--source',
    o.source ?? DEFAULT_SOURCE,
    '--agent',
    o.agent ?? DEFAULT_AGENT,
  ]
}

// ===== 执行抽象（可注入，便于测试） =====

/**
 * herdr 命令执行器。
 *
 * 拆成 run / runSync 两个方法是必要的：进程退出（'exit' 事件）里**不能**异步等待，
 * 那时事件循环已不再调度 ⇒ release 必须走同步版本。
 */
export interface HerdrRunner {
  /** 异步、fire-and-forget（不阻塞主流程；状态上报的失败不得影响 Agent 执行） */
  run(binPath: string, args: string[]): void
  /** 同步执行（仅用于进程退出时的 release） */
  runSync(binPath: string, args: string[]): void
}

/** 上报命令的超时（ms）：卡住的 herdr 进程不该拖住 Agent 生命周期 */
const REPORT_TIMEOUT_MS = 3000

function defaultRunner(onError?: (msg: string) => void): HerdrRunner {
  return {
    run(binPath, args) {
      try {
        const child = spawn(binPath, args, { stdio: 'ignore' })
        // 上报失败（herdr 未运行 / 参数不兼容）一律静默：状态上报是装饰性的，
        // 绝不能因为它把 Agent 主流程拖垮或刷屏。
        child.on('error', () => undefined)
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {
            /* ignore */
          }
        }, REPORT_TIMEOUT_MS)
        // 不 unref：超时定时器不必强留进程，且 kill 后自然退出
        timer.unref?.()
      } catch (e) {
        onError?.(String((e as Error)?.message ?? e))
      }
    },
    runSync(binPath, args) {
      try {
        spawnSync(binPath, args, { stdio: 'ignore', timeout: REPORT_TIMEOUT_MS })
      } catch {
        /* 退出路径上的最后一步，失败也无所谓 */
      }
    },
  }
}

// ===== Reporter =====

export interface HerdrReporterOptions {
  /** 环境变量表（默认 process.env；测试可注入） */
  env?: Record<string, string | undefined>
  runner?: HerdrRunner
  source?: string
  agent?: string
  /** 调试日志（可选） */
  log?: (msg: string) => void
}

/**
 * 状态上报器：节流 + 序号递增 + 退出释放。
 *
 * **节流是必需的，不是优化**：`agent.stream` 每收到一个 `text_delta` 就触发一次，
 * 一轮流式输出成百上千个增量 —— 每个都 spawn 一次进程既打满 CPU 也会让 Herdr 侧栏抖动。
 * 故只在「状态实质变化」时上报（state / sessionId / message 三者构成判定键）。
 */
export class HerdrReporter {
  /** 是否处于 Herdr 环境（false 时所有方法 no-op） */
  readonly active: boolean
  private readonly env?: HerdrEnv
  private readonly runner: HerdrRunner
  private readonly source: string
  private readonly agent: string
  private seq = 0
  private lastKey = ''
  private released = false
  /** 最近一次上报的状态（调试/测试用） */
  lastState?: HerdrState

  constructor(options: HerdrReporterOptions = {}) {
    this.env = detectHerdrEnv(options.env ?? process.env)
    this.active = this.env != null
    this.runner = options.runner ?? defaultRunner(options.log)
    this.source = options.source ?? DEFAULT_SOURCE
    this.agent = options.agent ?? DEFAULT_AGENT
  }

  /** 上报一次状态；未变化则跳过。返回是否真的发了命令 */
  report(state: HerdrState, sessionId?: string, message?: string): boolean {
    if (!this.active || !this.env || this.released) return false
    const key = `${state}|${sessionId ?? ''}|${message ?? ''}`
    if (key === this.lastKey) return false
    this.lastKey = key
    this.lastState = state
    this.seq += 1
    this.runner.run(
      this.env.binPath,
      buildReportArgs(this.env, {
        state,
        seq: this.seq,
        ...(sessionId ? { sessionId } : {}),
        ...(message ? { message } : {}),
        source: this.source,
        agent: this.agent,
      }),
    )
    return true
  }

  /** 处理 agent.stream 事件（映射 + 上报） */
  handleStream(signal: AgentStreamSignal): boolean {
    return this.report(mapStatusToHerdrState(signal.status), signal.sessionId)
  }

  /**
   * 报「等待用户决策」。
   *
   * 由 `permission.check` 触发，但**仅在决策确实是 ask 时**才报 —— 若规则已记住
   * （behavior=allow/deny），这次检查根本不会弹窗，报 blocked 会制造假阳性
   * （侧栏高亮但没人真的在等你）。
   */
  reportBlocked(message: string, sessionId?: string): boolean {
    return this.report('blocked', sessionId, message)
  }

  /** 交还生命周期权威（进程退出 / 插件卸载）。幂等。 */
  release(): boolean {
    if (!this.active || !this.env || this.released) return false
    this.released = true
    this.runner.runSync(this.env.binPath, buildReleaseArgs(this.env, { source: this.source, agent: this.agent }))
    return true
  }
}

// ===== 插件 =====

export interface HerdrPluginOptions extends HerdrReporterOptions {
  /** 插件 ID（默认 'herdr'） */
  id?: string
}

/**
 * 创建 Herdr 集成插件。不在 Herdr 环境时 install 返回空 Hooks（零副作用）。
 */
export function createHerdrPlugin(options: HerdrPluginOptions = {}): AgentPlugin {
  let reporter: HerdrReporter | undefined
  let onExit: (() => void) | undefined

  return {
    id: options.id ?? 'herdr',
    version: '0.1.0',
    name: 'Herdr Agent State',
    description:
      '把 Agent 状态上报到 Herdr 侧栏（working / idle / blocked）；仅在 Herdr pane 内生效，环境外为 no-op',

    async install(ctx): Promise<Hooks | void> {
      reporter = new HerdrReporter(options)
      if (!reporter.active) {
        ctx.log.debug?.('未检测到 Herdr 环境（HERDR_ENV≠1 或缺少 PANE_ID/BIN_PATH），上报已禁用')
        return {}
      }
      ctx.log.info?.(`Herdr 集成已启用（pane=${reporter.active ? 'ok' : '?'}）`)

      // 进程退出时释放：不 release 会让 Herdr 一直认为该 pane 归本 source 管，
      // 之后的 state 推断（甚至自动恢复）都可能失真。
      onExit = () => {
        try {
          reporter?.release()
        } catch {
          /* ignore */
        }
      }
      process.once('exit', onExit)

      return {
        'agent.stream': (signal) => {
          reporter?.handleStream(signal)
        },
        'permission.check': (req: PermissionRequestLike, decision: PermissionDecisionLike) => {
          // 只有真的会弹窗（ask）才报 blocked；已记住的规则不产生等待。
          if (decision?.behavior !== 'ask') return
          const label = req?.toolKey ?? 'permission'
          reporter?.reportBlocked(`等待批准：${label}`, undefined)
        },
      }
    },

    async uninstall(): Promise<void> {
      if (onExit) {
        process.off('exit', onExit)
        onExit = undefined
      }
      try {
        reporter?.release()
      } catch {
        /* ignore */
      }
      reporter = undefined
    },
  }
}

/** 默认插件实例（供 `plugins: ["herdr"]` 声明式启用） */
export const herdrPlugin: AgentPlugin = createHerdrPlugin()
