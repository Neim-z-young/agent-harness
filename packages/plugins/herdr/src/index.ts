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
 * # 退出：先报 unknown（离开 working/idle 语义态），再交还生命周期权威（不是报 done）
 * "$HERDR_BIN_PATH" pane report-agent  "$HERDR_PANE_ID" --source … --agent … --state unknown --seq N
 * "$HERDR_BIN_PATH" pane release-agent "$HERDR_PANE_ID" --source … --agent … --seq N+1
 * ```
 *
 * 三条硬约束（均来自官方原文）：
 * 1. **只在 Herdr 内生效** —— 必须 `HERDR_ENV=1` 且 `HERDR_PANE_ID`/`HERDR_BIN_PATH` 齐备，
 *    否则全程 no-op。这是官方明确要求（"keeps the integration a no-op outside Herdr"），
 *    也是本插件不在非 Herdr 环境产生任何副作用/进程的原因。
 * 2. **乱序防护用 `--seq`** —— 官方："If reports can arrive out of order, include a strictly
 *    increasing `--seq`; Herdr ignores stale sequence numbers from the same source."
 *    本插件的 spawn 是 fire-and-forget（并发上报无法保证完成顺序），故**必须**带。
 * 3. 退出时要 `release-agent` 交还生命周期权威，而不是报 done。
 *
 * **0.2.0：三处「照官方原文写、真机却不生效」的地方**（herdr 0.9.0 + Bun 1.3.14 实测，见开发日志续 158）：
 * - `--seq` 的水位线是**按 (pane, source) 存、与上报方进程无关**的：同一 pane/source 先 seq=100
 *   再 seq=1，后者被静默丢弃。旧实现每个进程都从 1 重新计数 ⇒ 上一次运行没来得及 release 时
 *   （见下一条），新进程的前 N 条上报全被当 stale 丢掉 —— 表现就是「刚启动却不显示已启动」。
 *   现序号基线取时间戳量级，恒大于历史上任何一次运行的计数。
 * - **`release-agent` 也必须带 `--seq`**：一旦用过 `--seq` 上报，不带序号的 release 会被同一个
 *   水位线丢掉（实测 agent 标签留在 pane 上、状态停在 working）⇒「退出后不显示已退出」。
 * - **`process.once('exit')` 覆盖不到信号退出**：SIGTERM / SIGHUP 会直接终止进程、不触发 'exit'
 *   （而「关掉这个 pane」正是 SIGHUP）。现额外挂 SIGTERM/SIGHUP，同步 release 后按默认处置重发信号。
 *   刻意**不挂 SIGINT** —— CLI 的 REPL/TUI 用它表示「中断当前查询」，抢它会把用户的 Ctrl-C 语义改坏；
 *   而走 Ctrl-C 正常退出时会经 `process.exit()` ⇒ 仍由 'exit' 兜住。
 * - 启动时补一次 `idle` 上报：只挂 `cli.agent.stream` 的话，侧栏要等到用户按下第一个回车才有状态。
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

/**
 * Herdr 的语义状态（**没有 done** —— 结束靠 release）。
 *
 * `unknown` 是官方 `--state` 的合法取值之一，语义为「本 source 不再声明状态」：
 * 退出时先报它，即使随后的 release 因故丢失，侧栏也不会停留在「还在跑」。
 */
export type HerdrState = 'working' | 'idle' | 'blocked' | 'unknown'

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

/**
 * release-agent 参数。
 *
 * `seq` **不是可选的装饰**：真机 A/B 实测（herdr 0.9.0）——同一 source 先
 * `report --seq 50`，再 `release`（不带 seq）⇒ 注册纹丝不动（agent 标签仍在、状态停在 working）；
 * 而 `release --seq 51` ⇒ 标签清掉、状态回到 unknown。
 * 结论：一旦用过 `--seq` 上报，release 必须带一个**更高**的序号，否则被同一个水位线丢掉。
 */
export function buildReleaseArgs(
  env: HerdrEnv,
  o: { source?: string; agent?: string; seq?: number } = {},
): string[] {
  const args = [
    'pane',
    'release-agent',
    env.paneId,
    '--source',
    o.source ?? DEFAULT_SOURCE,
    '--agent',
    o.agent ?? DEFAULT_AGENT,
  ]
  if (o.seq !== undefined) args.push('--seq', String(o.seq))
  return args
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

/** 当前时刻，带亚毫秒精度（epoch 毫秒的浮点值） */
function epochMillis(): number {
  const p = globalThis.performance
  if (p && typeof p.now === 'function') {
    const origin = typeof p.timeOrigin === 'number' ? p.timeOrigin : Date.now() - p.now()
    return origin + p.now()
  }
  return Date.now()
}

/**
 * 本次运行的序号基线：把墙上时钟（微秒精度）直接当首个序号。
 *
 * 为什么基线要这么大、这么细：Herdr 的「旧序号丢弃」水位线按 **(pane, source)** 存，
 * **跨进程不重置**（真机实测：同一 pane/source 先 seq=100 再 seq=1，后者被静默丢弃）。
 * 所以新进程的序号必须恒大于上一次运行的末序号 —— 而基线只要取自「晚于上一次运行」的时钟，
 * 就天然满足（上一次运行最多几百条上报，微秒量级的间隔远大于它）。
 * 反例是原来的 `seq = 0` + 自增：每个进程都从 1 重新计数，于是上一次没来得及 release 时
 * （被 kill / 关 pane），新进程的前 N 条上报全被当 stale 丢掉 —— 表现正是
 * 「刚启动却不显示已启动」。量级 ≈ 1.8e15，已在 herdr 0.9.0 真机确认被接受。
 */
export function nextSeqBase(epochMs: number = epochMillis()): number {
  return Math.round(epochMs * 1000)
}

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
  /**
   * 序号基线（默认取微秒级时钟）。
   * 测试注入它来验证「新运行的序号恒大于上一次运行的末序号」这条跨进程不变量。
   */
  seqBase?: number
}

/**
 * 状态上报器：节流 + 序号递增 + 退出释放。
 *
 * **节流是必需的，不是优化**：`cli.agent.stream` 每收到一个 `text_delta` 就触发一次，
 * 一轮流式输出成百上千个增量 —— 每个都 spawn 一次进程既打满 CPU 也会让 Herdr 侧栏抖动。
 * 故只在「状态实质变化」时上报（state / sessionId / message 三者构成判定键）。
 */
export class HerdrReporter {
  /** 是否处于 Herdr 环境（false 时所有方法 no-op） */
  readonly active: boolean
  /** 本进程所在 pane（未在 Herdr 内为 undefined）—— 供日志/排查用 */
  readonly paneId?: string
  private readonly env?: HerdrEnv
  private readonly runner: HerdrRunner
  private readonly source: string
  private readonly agent: string
  /**
   * 序号基线 = 微秒级墙上时钟（见 {@link nextSeqBase}），构造时确定并自增。
   *
   * 为什么不是 0：Herdr 的「旧序号丢弃」水位线按 **(pane, source)** 存，**与上报方进程无关**
   * （真机实测：同一 pane/source 先 seq=100 再 seq=1，后者被静默丢弃）。若每个进程都从 1 计数，
   * 那么只要上一次运行没来得及 release（被 kill / 关 pane），新进程的前 N 条上报就全被当 stale
   * 丢掉 —— 表现正是「刚启动却不显示已启动」。基线取时钟量级，恒大于任何一次历史运行的末序号。
   */
  private seq = 0
  private lastKey = ''
  private released = false
  /** 最近一次上报的状态（调试/测试用） */
  lastState?: HerdrState

  constructor(options: HerdrReporterOptions = {}) {
    this.env = detectHerdrEnv(options.env ?? process.env)
    this.active = this.env != null
    this.paneId = this.env?.paneId
    this.runner = options.runner ?? defaultRunner(options.log)
    this.source = options.source ?? DEFAULT_SOURCE
    this.agent = options.agent ?? DEFAULT_AGENT
    this.seq = options.seqBase ?? nextSeqBase()
  }

  /** 上报一次状态；未变化则跳过。返回是否真的发了命令 */
  report(state: HerdrState, sessionId?: string, message?: string): boolean {
    return this.emit(state, sessionId, message, false)
  }

  /**
   * 启动上报：让侧栏**立刻**出现本 agent（`idle` = 已启动、等待输入）。
   *
   * 只挂 `cli.agent.stream` 的话，侧栏要等到用户按下第一个回车、模型开始产出才有状态
   * ——「启动后侧栏半天没反应」。
   */
  reportStarted(sessionId?: string): boolean {
    return this.report('idle', sessionId)
  }

  /** 处理 cli.agent.stream 事件（映射 + 上报） */
  handleStream(signal: AgentStreamSignal): boolean {
    return this.report(mapStatusToHerdrState(signal.status), signal.sessionId)
  }

  /**
   * 报「等待用户决策」。
   *
   * 由 `core.permission.check` 触发，但**仅在决策确实是 ask 时**才报 —— 若规则已记住
   * （behavior=allow/deny），这次检查根本不会弹窗，报 blocked 会制造假阳性
   * （侧栏高亮但没人真的在等你）。
   */
  reportBlocked(message: string, sessionId?: string): boolean {
    return this.report('blocked', sessionId, message)
  }

  /**
   * 交还生命周期权威（进程退出 / 插件卸载）。幂等。
   *
   * **必须带一个更高的 `--seq`**：一旦用过 `--seq` 上报，不带序号的 release 会被 Herdr
   * 当旧序号丢弃（真机 A/B 实测：标签留在 pane 上、状态停在 working）—— 这正是
   * 「退出后侧栏不显示已退出」的根因。
   */
  release(): boolean {
    if (!this.active || !this.env || this.released) return false
    this.released = true
    this.seq += 1
    this.runner.runSync(
      this.env.binPath,
      buildReleaseArgs(this.env, { source: this.source, agent: this.agent, seq: this.seq }),
    )
    return true
  }

  /**
   * 退出序列：① 报 `unknown` 离开 working/idle 语义态；② release 交还权限（清 agent 标签）。
   *
   * 两步都走**同步**执行器：本方法只在进程退出 / 卸载路径上调用，那时事件循环已不再调度，
   * 异步 spawn 可能根本起不来；顺序也有意义（report 的序号低于 release，若乱序到达会被丢弃，
   * 恰好是「以 release 为准」的正确结果）。
   *
   * 幂等：`released` 之后直接返回 false。
   */
  shutdown(sessionId?: string): boolean {
    if (!this.active || !this.env || this.released) return false
    this.emit('unknown', sessionId, undefined, true)
    return this.release()
  }

  /** 上报实现；sync=true 走同步执行器（仅退出路径）。返回是否真的发了命令 */
  private emit(
    state: HerdrState,
    sessionId: string | undefined,
    message: string | undefined,
    sync: boolean,
  ): boolean {
    if (!this.active || !this.env || this.released) return false
    const key = `${state}|${sessionId ?? ''}|${message ?? ''}`
    if (key === this.lastKey) return false
    this.lastKey = key
    this.lastState = state
    this.seq += 1
    const args = buildReportArgs(this.env, {
      state,
      seq: this.seq,
      ...(sessionId ? { sessionId } : {}),
      ...(message ? { message } : {}),
      source: this.source,
      agent: this.agent,
    })
    if (sync) this.runner.runSync(this.env.binPath, args)
    else this.runner.run(this.env.binPath, args)
    return true
  }
}

// ===== 插件 =====

export interface HerdrPluginOptions extends HerdrReporterOptions {
  /** 插件 ID（默认 'herdr'） */
  id?: string
}

/**
 * 需要额外挂的退出信号。
 *
 * `process.once('exit')` **覆盖不到信号退出** —— 真机实测（Bun 1.3.14）：SIGTERM / SIGHUP
 * 直接终止进程，'exit' 处理器根本不运行；而「关掉这个 pane」正是 SIGHUP，是用户最常见的
 * 退出方式之一 ⇒ 不挂这两个信号就等于「永不 release」。
 *
 * 刻意**不含 SIGINT**：CLI 的 REPL / TUI 用 SIGINT 表示「中断当前查询」，插件抢这个信号会把
 * 用户的 Ctrl-C 语义改坏；而走 Ctrl-C 正常退出时进程会经 `process.exit()` ⇒ 仍由 'exit' 兜住。
 * SIGKILL 无法捕获，属于协议外的必然丢失。
 */
export const EXIT_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGHUP']

/**
 * 创建 Herdr 集成插件。不在 Herdr 环境时 install 返回空 Hooks（零副作用）。
 */
export function createHerdrPlugin(options: HerdrPluginOptions = {}): AgentPlugin {
  let reporter: HerdrReporter | undefined
  /** 卸下所有进程级监听（'exit' + 信号）；uninstall / 信号重发前调用 */
  let detachProcessListeners: (() => void) | undefined

  return {
    id: options.id ?? 'herdr',
    version: '0.2.0',
    name: 'Herdr Agent State',
    description:
      '把 Agent 状态上报到 Herdr 侧栏（working / idle / blocked）；仅在 Herdr pane 内生效，环境外为 no-op',

    async install(ctx): Promise<Hooks | void> {
      reporter = new HerdrReporter(options)
      if (!reporter.active) {
        ctx.log.debug?.('未检测到 Herdr 环境（HERDR_ENV≠1 或缺少 PANE_ID/BIN_PATH），上报已禁用')
        return {}
      }
      ctx.log.info?.(`Herdr 集成已启用（pane=${reporter.paneId ?? '?'}）`)

      // 退出路径三条，缺一条就会出现「退出后侧栏不显示已退出」：
      // 1) 'exit' —— 正常退出（Ctrl-D / /exit / TUI 关闭后 process.exit）
      // 2) 信号 —— 关 pane（SIGHUP）/ 被 kill（SIGTERM）；信号终止**不触发** 'exit'
      // 3) 处理完要交还默认处置，否则进程会因我们的监听而"留下来不退出"
      const shutdownQuietly = () => {
        try {
          reporter?.shutdown()
        } catch {
          /* 退出路径上的最后一步，失败也无所谓 */
        }
      }
      const onExit = () => shutdownQuietly()
      const onSignal = (sig: NodeJS.Signals) => {
        shutdownQuietly()
        detachProcessListeners?.()
        try {
          process.kill(process.pid, sig) // 重新按默认处置终止，保住退出码/信号语义
        } catch {
          process.exit(1)
        }
      }

      process.once('exit', onExit)
      for (const sig of EXIT_SIGNALS) process.on(sig, onSignal)
      detachProcessListeners = () => {
        process.off('exit', onExit)
        for (const sig of EXIT_SIGNALS) process.off(sig, onSignal)
      }

      return {
        // 启动即报一次 idle（= 已启动、等待输入）：只挂 cli.agent.stream 的话，
        // 侧栏要等到用户按下第一个回车才有状态。
        'core.harness.start': () => {
          reporter?.reportStarted()
        },
        'cli.agent.stream': (signal) => {
          reporter?.handleStream(signal)
        },
        'core.permission.check': (req: PermissionRequestLike, decision: PermissionDecisionLike) => {
          // 只有真的会弹窗（ask）才报 blocked；已记住的规则不产生等待。
          if (decision?.behavior !== 'ask') return
          const label = req?.toolKey ?? 'permission'
          reporter?.reportBlocked(`等待批准：${label}`, undefined)
        },
      }
    },

    async uninstall(): Promise<void> {
      detachProcessListeners?.()
      detachProcessListeners = undefined
      try {
        reporter?.shutdown()
      } catch {
        /* ignore */
      }
      reporter = undefined
    },
  }
}

/** 默认插件实例（供 `plugins: ["herdr"]` 声明式启用） */
export const herdrPlugin: AgentPlugin = createHerdrPlugin()
