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