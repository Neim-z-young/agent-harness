/**
 * bus 事件 → 遥测 envelope 转换。
 *
 * 通用策略：任何 bus 事件都映射为一条 `telemetry.bus.<name>`，数值字段 → metrics、
 * 低基数字段 → attrs，并尝试提取 sessionId/agentId。这样采集不依赖枚举，新事件自动入明细。
 * 几个特殊事件（错误/生命周期）落到更语义化的 kind，便于异常检索。
 */

import type { BusEventRecord } from '@harness/bus'
import { makeEnvelope, pickMetrics, pickAttrs, extractIdentity, type TelemetryEnvelope } from './envelope.js'

/** 需要单独语义化 kind 的特殊事件（其余走 telemetry.bus.<name>） */
const ERROR_NAMES = new Set(['harness.error'])
/** 当作"会话边界"的事件（仅用于更新 lastKnown，不强依赖） */
const LIFECYCLE_NAMES = new Set(['harness.initialized', 'harness.started', 'harness.stopped'])

/**
 * 把一条 bus 事件转成遥测 envelope。
 * 返回 null 表示该事件不落盘（极端脱敏场景专用，默认恒非 null）。
 */
export function mapBusEvent(ev: BusEventRecord): TelemetryEnvelope {
  const kind = ERROR_NAMES.has(ev.name) ? 'telemetry.error' : `telemetry.bus.${ev.name}`
  const identity = extractIdentity(ev.payload)
  const attrs = {
    ...pickAttrs(ev.payload),
    source: ev.source,
    sessionId: identity.sessionId,
    agentId: identity.agentId,
    round: pickRound(ev.payload),
  }
  return makeEnvelope(kind, attrs, pickMetrics(ev.payload), ev.timestamp)
}

function pickRound(payload: unknown): number | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const rec = payload as Record<string, unknown>
  const v = rec['round']
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 该事件是否为一次生命周期/会话边界（供 lastKnown 刷新） */
export function isBoundaryEvent(name: string): boolean {
  return LIFECYCLE_NAMES.has(name)
}

/**
 * 整轮终态 → 遥测事件（`core.agent.turn.end` hook 的消费）。
 *
 * 为什么注册这条 hook 而不是新开一条 bus 事件：`core.agent.turn.end` **本来就带**
 * `step` / `freeSteps` / `finish` / `aborted`，且 core 的调用点已经 `.catch(() => undefined)`
 * —— 再加一条同名事实的 bus 事件就是**同一件事两条通道**（历史事故：同一个名字由两层
 * 分别触发 ⇒ 消费方分不清来源、按轮计数翻倍）。此处只是把既有事实落盘。
 *
 * `billedSteps` 是**派生量**（`step - freeSteps`），它才是 `maxSteps` 的消耗口径：
 * 观察点 9 落地后"步号 30 但额度没耗尽"是正常现象，只看 `step` 会以为出了 bug。
 * 两个都落，消费方不必自己猜。
 *
 * 缺失 `sessionId` 时**不丢事件**（照 `toolFailureEnvelope` 的口径：只在语义上该过滤时才返回
 * null）—— 无 sessionId 的轮会落到 run 级文件，那也是它的正确归宿。
 */
export function turnEndEnvelope(signal: unknown): TelemetryEnvelope | null {
  if (signal === null || typeof signal !== 'object') return null
  const s = signal as {
    agentId?: string
    agentName?: string
    mode?: string
    sessionId?: string
    step?: number
    freeSteps?: number
    emptySteps?: number
    finish?: string
    aborted?: boolean
  }
  const metrics: Record<string, number> = {}
  if (typeof s.step === 'number' && Number.isFinite(s.step)) metrics.step = s.step
  const free = typeof s.freeSteps === 'number' && Number.isFinite(s.freeSteps) ? s.freeSteps : 0
  if (free > 0) metrics.freeSteps = free
  if (typeof s.step === 'number' && Number.isFinite(s.step)) metrics.billedSteps = s.step - free
  // 空步数（有值才落）：「模型连续零产出」与「请求层整轮没跑起来」的区分依据
  if (typeof s.emptySteps === 'number' && Number.isFinite(s.emptySteps) && s.emptySteps > 0) {
    metrics.emptySteps = s.emptySteps
  }
  // 只在真的中断时记一位（缺省即 0，不落无用字段）
  if (s.aborted === true) metrics.aborted = 1
  return makeEnvelope(
    'telemetry.turn.end',
    {
      sessionId: s.sessionId,
      agentId: s.agentId,
      agentName: s.agentName,
      mode: s.mode,
      finish: s.finish,
    },
    metrics,
  )
}

/**
 * 入参缺失 → `telemetry.tool.params.missing`。
 *
 * 三件套里的消费方：`core.tool.params.missing` hook 由 core 在「必填全缺」的唯一命中点
 * 触发，这里落盘 ⇒ 终于能统计「入参缺失型失败」的次数与分布。此前只能靠
 * `telemetry.tool.fail` 数失败总数，分不出类型（真机 14 次 `input: {}`，见
 * s_1790592617954_axqkk）。
 *
 * 只记**缺了几个**（`missingCount`）与工具 id —— 遥测红线是不落提示词/入参正文，
 * 参数名虽是低基数但会随工具膨胀，故也不落。
 */
export function paramsMissingEnvelope(signal: unknown): TelemetryEnvelope | null {
  if (signal === null || typeof signal !== 'object') return null
  const s = signal as { toolId?: string; sessionId?: string; agentId?: string; step?: number; missingCount?: number }
  if (!s.toolId) return null
  const metrics: Record<string, number> = {}
  if (typeof s.step === 'number' && Number.isFinite(s.step)) metrics.step = s.step
  if (typeof s.missingCount === 'number' && Number.isFinite(s.missingCount)) metrics.missingCount = s.missingCount
  return makeEnvelope(
    'telemetry.tool.params.missing',
    { toolId: s.toolId, sessionId: s.sessionId, agentId: s.agentId },
    metrics,
  )
}

/**
 * 空步 → `telemetry.step.empty`。
 *
 * 「一次完整 prompt 换来零产出」是纯浪费，且此前**完全不可观测**：没有 tokenUsage ⇒
 * 不触发 `core.llm.usage` ⇒ ACP 的 providerCache 行没有；没有 tool call ⇒ 整轮就此结束。
 * 遥测里只剩一条 `telemetry.turn.end { step:1, billedSteps:1 }`，与正常收尾无异。
 *
 * `hasTokenUsage` / `aborted` 折成 0/1（布尔在 attrs 里会被 JSON 保留，但指标出口
 * 只收数值，统一折 0/1 才能聚合）。
 */
export function stepEmptyEnvelope(signal: unknown): TelemetryEnvelope | null {
  if (signal === null || typeof signal !== 'object') return null
  const s = signal as { sessionId?: string; agentId?: string; step?: number; hasTokenUsage?: boolean; aborted?: boolean }
  const metrics: Record<string, number> = {}
  if (typeof s.step === 'number' && Number.isFinite(s.step)) metrics.step = s.step
  metrics.hasTokenUsage = s.hasTokenUsage === true ? 1 : 0
  metrics.aborted = s.aborted === true ? 1 : 0
  return makeEnvelope(
    'telemetry.step.empty',
    { sessionId: s.sessionId, agentId: s.agentId },
    metrics,
  )
}

/**
 * 白名单越界 → `telemetry.tool.whitelist.blocked`。
 *
 * 三件套里的消费方：`core.tool.whitelist.blocked` hook 由 core 在"解析出的工具不在
 * `allowedTools` 内"的唯一命中点触发，这里落盘 ⇒ 能力边界事件可被统计（哪台 agent、
 * 第几步、点了哪个工具）。此前这类调用会被静默放行，遥测里与正常调用**完全同形**
 * （真机 s_1790592617954_axqkk：reader 只授权 4 个只读工具，`compress` 却调用了）。
 *
 * 只落工具 id 与步号 —— 不落入参正文（遥测红线）。
 */
export function whitelistBlockedEnvelope(signal: unknown): TelemetryEnvelope | null {
  if (signal === null || typeof signal !== 'object') return null
  const s = signal as { toolId?: string; sessionId?: string; agentId?: string; step?: number }
  if (!s.toolId) return null
  const metrics: Record<string, number> = {}
  if (typeof s.step === 'number' && Number.isFinite(s.step)) metrics.step = s.step
  return makeEnvelope(
    'telemetry.tool.whitelist.blocked',
    { toolId: s.toolId, sessionId: s.sessionId, agentId: s.agentId },
    metrics,
  )
}

/**
 * 工具执行失败 → 细分遥测事件（异常场景专项埋点）。
 *
 * `core.tool.post.execute` hook 的 (ctx, result) 里：
 *  - `ctx.tool.id`：工具 id；
 *  - `ctx.ctx.sessionId / agentId`：**归属**（会话级 JSONL 靠它分流，见下）；
 *  - `result.ok === false` 且 `result.error.code`：`PERMISSION_DENIED` / `DOOM_LOOP` / 其它。
 * 据此把三类失败细分到独立 kind（而非全落在通用的 telemetry.bus.*），便于异常检索/告警。
 * 纯函数（无 IO），便于单测。成功（ok !== false）返回 null。
 *
 * ⚠️ `sessionId` 必须带上：`TelemetryService.persist` 用 `attrs.sessionId` 决定写哪个文件，
 * 缺了就会 `switchWriter(undefined)` ⇒ 事件全部落到 **run 级** `run.telemetry.jsonl`，
 * 会话文件里一条都没有（实测 79 条 tool.fail 的 `sessionId` 全为 undefined，9 个会话文件合计 0 条）
 * —— 于是"按会话取证"永远看不到工具失败，而工具失败恰恰是最需要会话归属的一类事件。
 */
export function toolFailureEnvelope(ctx: unknown, result: unknown): TelemetryEnvelope | null {
  const h = ctx as
    | { tool?: { id?: string }; ctx?: { sessionId?: string; agentId?: string } }
    | undefined
  const r = result as { ok?: boolean; error?: { code?: string }; meta?: { durationMs?: number } } | undefined
  if (!r || r.ok !== false) return null
  const toolId = h?.tool?.id
  const code = r.error?.code
  let kind = 'telemetry.tool.fail'
  let errName: string | undefined = code
  if (code === 'PERMISSION_DENIED') {
    kind = 'telemetry.permission.deny'
    errName = 'ToolPermissionDeniedError'
  } else if (code === 'DOOM_LOOP') {
    kind = 'telemetry.doomloop'
    errName = 'DOOM_LOOP'
  }
  const metrics: Record<string, number> = {}
  if (typeof r.meta?.durationMs === 'number') metrics.durationMs = r.meta.durationMs
  return makeEnvelope(
    kind,
    { toolId, errName, sessionId: h?.ctx?.sessionId, agentId: h?.ctx?.agentId },
    metrics,
  )
}