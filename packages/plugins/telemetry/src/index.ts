/**
 * @harness/telemetry - 通用遥测插件。
 *
 * 本地采集为主：订阅 `core.bus` 全部事件，映射为统一 envelope，会话级写入
 * `dataDir/sessions/*.telemetry.jsonl`。附带：
 *  - 异常场景监控：harness.error → telemetry.error，bus 事件通用落明细；
 *  - 崩溃兜底：SIGTERM/SIGHUP / uncaughtException / unhandledRejection →
 *    `telemetry.crash`（不抢 SIGINT）；
 *  - 跨会话匿名 user id：由 `dataDir/.config-key` 派生（可经 `userID` 注入），
 *    仅用于跨会话聚合，不记任何正文。
 *
 * 插件形态：`createTelemetryPlugin(opts)` 返回 `AgentPlugin`（可插拔装入 cli）；
 * `createTelemetryService(opts)` 额外暴露 controller，宿主可调 `record()`/`flush()`。
 *
 * @example
 * const svc = createTelemetryService({ dataDir: configDir })
 * harnessPlugins.push(svc.plugin)      // 订阅 bus + 挂崩溃兜底
 * svc.telemetry.record('telemetry.session.start', { sessionId }, { durationMs: 42 })
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { AgentPlugin, Hooks, PluginContext } from '@harness/plugin'
import type { BusEventRecord, Unsubscribe } from '@harness/bus'
import { createJsonlWriter, type JsonlWriter } from './writer.js'
import { makeEnvelope, type TelemetryAttrs, type TelemetryEnvelope } from './envelope.js'
import { mapBusEvent, toolFailureEnvelope, turnEndEnvelope, paramsMissingEnvelope, stepEmptyEnvelope, whitelistBlockedEnvelope } from './map.js'
import { createCrashGuard, type CrashState } from './crash.js'
import { createOtlpExporter, type OtlpOptions } from './otlp.js'

export * from './envelope.js'
export * from './writer.js'
export * from './map.js'
export * from './crash.js'
export * from './otlp.js'

export interface TelemetryOptions {
  /** 总开关；false 时完全 no-op（不写盘、不订阅） */
  enabled?: boolean
  /** 数据根目录（缺省 ~/.harness），会话遥测落在 `{dataDir}/sessions/` */
  dataDir?: string
  /** 会话文件路径生成；缺省 `{dataDir}/sessions/{sessionId}.telemetry.jsonl`（无 sessionId 用 `run`） */
  pathBuilder?: (sessionId: string | undefined) => string
  /** 批量 flush 间隔 */
  debounceMs?: number
  /** 是否挂崩溃兜底（默认 true） */
  crash?: boolean
  /** 跨会话匿名 user id（缺省从 `.config-key` 派生） */
  userID?: string
  /** 可选 OTLP 上报：endpoint 非空才启用（对齐 OpenCode，冷路径零成本） */
  otlp?: OtlpOptions
}

export interface TelemetryController {
  /** 手动记录一条事件 */
  record(kind: string, attrs?: TelemetryAttrs, metrics?: Record<string, number>): void
  /** 记录一条已构造好的 envelope */
  recordRaw(ev: TelemetryEnvelope): void
  /** 立即 flush */
  flush(): void
  /** 是否开启 */
  enabled: boolean
}

export interface TelemetryService {
  plugin: AgentPlugin
  telemetry: TelemetryController
}

const DEFAULT_PLUGIN_ID = 'telemetry'

/** 从 `.config-key`（或 dataDir 种子）派生稳定的匿名 user id（非明文身份） */
export function deriveUserID(dataDir: string): string {
  try {
    const keyFile = join(dataDir, '.config-key')
    const seed = existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : `${dataDir}:${process.env.HOME ?? ''}`
    return createHash('sha256').update(seed).digest('hex').slice(0, 24)
  } catch {
    return 'anon'
  }
}

export function createTelemetryService(opts: TelemetryOptions = {}): TelemetryService {
  const enabled = opts.enabled !== false
  const dataDir = opts.dataDir ?? join(homedir(), '.harness')
  const sessionsDir = join(dataDir, 'sessions')
  const userID = opts.userID ?? deriveUserID(dataDir)
  const pathBuilder = opts.pathBuilder ?? ((sid: string | undefined) => join(sessionsDir, `${sid ?? 'run'}.telemetry.jsonl`))
  const debounceMs = opts.debounceMs ?? 500

  // 崩溃兜底用：内存里最后已知的会话状态
  let lastKnown: CrashState = {}

  // 可选 OTLP 上报（endpoint 非空才启用；关闭时 no-op）
  const otlpExporter = createOtlpExporter(opts.otlp ?? { enabled: false })

  // 单活跃 writer（跟随会话边界切换；会话分摊 writer 不保留，边界处切换）
  const UNSET = '\u0000uninitialized'
  let activeSessionId: string = UNSET
  let writer: JsonlWriter<TelemetryEnvelope> = createJsonlWriter<TelemetryEnvelope>(undefined)

  const switchWriter = (sessionId: string | undefined) => {
    if (sessionId === activeSessionId) return
    writer.flush()
    activeSessionId = sessionId ?? UNSET
    writer = createJsonlWriter<TelemetryEnvelope>(enabled ? pathBuilder(sessionId) : undefined, debounceMs)
  }

  const persist = (ev: TelemetryEnvelope) => {
    if (!enabled) return
    switchWriter(ev.attrs.sessionId)
    if (ev.attrs.sessionId) lastKnown.sessionId = ev.attrs.sessionId
    if (typeof ev.attrs.round === 'number') lastKnown.round = ev.attrs.round
    lastKnown.lastKind = ev.kind
    writer.write(ev)
    // OTLP 上报与本地同步写：本地始终落盘，OTLP 仅添加上报（可单独关闭）
    otlpExporter.push(ev)
  }

  const record = (kind: string, attrs?: TelemetryAttrs, metrics?: Record<string, number>) => {
    persist(makeEnvelope(kind, { userID, ...attrs }, metrics))
  }

  const flush = () => {
    writer.flush()
    void otlpExporter.flush()
  }

  const onBusEvent = (ev: BusEventRecord) => {
    if (!enabled) return
    persist(mapBusEvent(ev))
  }

  const controller: TelemetryController = { record, recordRaw: persist, flush, enabled }

  // 异常场景专项埋点 hooks（工具执行失败 → 细分 kind）。不改 core，只注册已有 hook。
  const hooks: Hooks = {
    async 'core.tool.post.execute'(ctx: unknown, result: unknown): Promise<unknown> {
      if (!enabled) return result
      const ev = toolFailureEnvelope(ctx, result)
      if (ev) persist(ev)
      // 遥测只读不改结果，原样返回以保持 pipeline 语义
      return result
    },
    /**
     * 整轮终态（`core.agent.turn.end`）：落 `telemetry.turn.end`。
     *
     * 这条是**额度口径唯一的线上证据**：`step`（展示步号）与 `billedSteps`（吃 `maxSteps`
     * 的步数）在观察点 9 之后会分叉 —— 只看步号会以为"额度算错了"。subagent 的轮也走这里
     * （引擎不做"哪一轮算用户的轮"的判断），靠 `mode` 标签区分，消费方自己筛。
     *
     * 同步返回即可（core 的调用点是 `void ... .catch(() => undefined)`，本 hook 抛错也不会
     * 影响主流程，但仍不要抛 —— 上报绝不顶掉主语义）。
     */
    'core.agent.turn.end'(signal: unknown): void {
      if (!enabled) return
      const ev = turnEndEnvelope(signal)
      if (ev) persist(ev)
    },
    /**
     * 入参缺失（`core.tool.params.missing`）：落 `telemetry.tool.params.missing`。
     *
     * 单独一条 kind 而不是并入 `telemetry.tool.fail`：后者触发得**更早**（那时 core 还没把
     * `[入参自愈]` 说明拼进错误消息），消费方在那里无从判断"这次失败是缺参数"。
     */
    'core.tool.params.missing'(signal: unknown): void {
      if (!enabled) return
      const ev = paramsMissingEnvelope(signal)
      if (ev) persist(ev)
    },
    /**
     * 空步（`core.step.empty`）：落 `telemetry.step.empty`。
     *
     * 「一次完整 prompt 换来零产出」此前在遥测里**完全隐形**（没有用量 ⇒ 没有 providerCache 行；
     * 没有工具调用 ⇒ 整轮结束；会话里只多一条空 parts 的 assistant）。真机开场 3 轮各 1 空步。
     */
    'core.step.empty'(signal: unknown): void {
      if (!enabled) return
      const ev = stepEmptyEnvelope(signal)
      if (ev) persist(ev)
    },
    /**
     * 白名单越界（`core.tool.whitelist.blocked`）：落 `telemetry.tool.whitelist.blocked`。
     *
     * 这是**能力边界**事件，与 `telemetry.tool.fail`（工具自身报错）不同类：它说明模型
     * 试图调用一个本不在其白名单内的工具。此前该调用会被静默放行，遥测里看不出异常。
     */
    'core.tool.whitelist.blocked'(signal: unknown): void {
      if (!enabled) return
      const ev = whitelistBlockedEnvelope(signal)
      if (ev) persist(ev)
    },
  }

  // bus 事件订阅 + 崩溃兜底（在 install(ctx) 里接线，chhug 需要 bus）
  let unsubscribe: Unsubscribe | undefined
  let crashGuard: ReturnType<typeof createCrashGuard> | undefined

  const plugin: AgentPlugin = {
    id: DEFAULT_PLUGIN_ID,
    version: '0.1.0',
    name: 'Telemetry',
    description: '通用遥测：本地 JSONL 采集 + 异常监控 + 崩溃兜底',
    async install(ctx: PluginContext) {
      if (!enabled) return
      unsubscribe = ctx.bus.subscribeAll(onBusEvent)
      if (opts.crash !== false) {
        crashGuard = createCrashGuard({
          getState: () => lastKnown,
          recordCrash: (f) => {
            record('telemetry.crash', {
              sessionId: lastKnown.sessionId,
              round: lastKnown.round,
              signal: f.signal,
              errName: f.reason,
              stackHash: f.stackHash,
            })
            flush()
          },
          flush,
        })
        crashGuard.attach()
      }
      // 异常场景专项埋点：tools pipeline 的 post.execute 里细分权限拒绝 / DOOM_LOOP / 工具失败。
      // 不改 core，只注册已有 hook（core. 层任何宿主都触发）。
      return hooks
    },
    async uninstall() {
      unsubscribe?.()
      crashGuard?.detach()
      flush()
      otlpExporter.close()
    },
  }

  return { plugin, telemetry: controller }
}

/** 兼容工厂：只返回 AgentPlugin（无需 host 拿 controller 时用） */
export function createTelemetryPlugin(opts: TelemetryOptions = {}): AgentPlugin {
  return createTelemetryService(opts).plugin
}