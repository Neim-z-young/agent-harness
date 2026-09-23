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