/**
 * 统一遥测事件 Envelope。
 *
 * 所有遥测事件共用这一层包装，便于：
 *  - 与会话级 JSONL / 可选的 OTLP 双出口对齐字段名；
 *  - bench/分析脚本做跨会话聚合时按 `kind` / `sessionId` 分桶。
 *
 * 隐私红线：**只记标量指标与低基数标签，绝不记录代码/提示词/命令正文**。
 * undefined 字段在 JSON.stringify 时会被丢弃（不落盘、不上报）。
 */

/** 低基数标签（供分组 / 裁剪） */
export interface TelemetryAttrs {
  sessionId?: string
  round?: number
  provider?: string
  model?: string
  agentId?: string
  pluginId?: string
  toolId?: string
  source?: string
  signal?: string
  stage?: string
  errName?: string
  [k: string]: string | number | undefined
}

export interface TelemetryEnvelope {
  schema: 1
  /** 事件名（snake_case、点分层，如 telemetry.error / telemetry.crash） */
  kind: string
  /** epoch ms */
  ts: number
  /** 低基数标签 */
  attrs: TelemetryAttrs
  /** 数值指标（可空：undefined 不入盘） */
  metrics: Record<string, number>
}

export const SCHEMA = 1 as const

/** 构造一个 envelope（归一化时间戳，便于测试注入 ts） */
export function makeEnvelope(
  kind: string,
  attrs?: TelemetryAttrs,
  metrics?: Record<string, number>,
  ts: number = Date.now(),
): TelemetryEnvelope {
  return { schema: SCHEMA, kind, ts, attrs: { ...attrs }, metrics: { ...metrics } }
}

/** 从任意对象里挑出数值字段当 metrics（bus 载荷通用提取） */
export function pickMetrics(payload: unknown): Record<string, number> {
  if (payload === null || typeof payload !== 'object') return {}
  const metrics: Record<string, number> = {}
  for (const [k, v] of Object.entries(payload)) {
    const n = asNumber(v)
    if (n !== undefined) metrics[k] = n
  }
  return metrics
}

/** 从任意对象里挑出低基数字符串/数值标签（bus 载荷通用提取） */
export function pickAttrs(payload: unknown): TelemetryAttrs {
  if (payload === null || typeof payload !== 'object') return {}
  const attrs: TelemetryAttrs = {}
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === 'string' && v.length > 0) attrs[k] = v
    else {
      const n = asNumber(v)
      if (n !== undefined) attrs[k] = n
    }
  }
  return attrs
}

/**
 * 归一化"可当数值用的载荷字段"：**布尔折叠为 0 / 1**。
 *
 * 为什么必须折：`pickAttrs` / `pickMetrics` 原本只收 `string | number`，于是载荷里的
 * 布尔字段被**静默丢弃** —— 遥测看不到它，消费方只能把"字段不存在"当成 false，
 * 分不清"确实是 false"与"压根没采到"。已确认中招的载荷：
 * `SubagentEvents.started { isContinuation: boolean }`、
 * `SubagentEvents.*{ background?: boolean }`（`background: true` 一直在发、一直在丢）、
 * `AgentTurnEndSignal { aborted?: boolean }`。
 *
 * 折成 0/1 而不是保留布尔：遥测的两条出口（JSONL / OTLP）都以数值为指标载体，
 * 布尔在 OTLP 里要么另开类型、要么同样丢；0/1 还能直接做 sum/avg 聚合。
 * 真实布尔以外的值（对象、数组、null、NaN、Infinity、空串）一律返回 undefined ⇒ 丢弃。
 */
function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'boolean') return v ? 1 : 0
  return undefined
}

/**
 * 常见 id 主键 → 标准 attrs 键的映射，用于从 bus 载荷提取会话/agent/provider 维度。
 * ⚠️ **不把任意顶层 `id` 当 sessionId**：`tool.enabled {id}` / `plugin.loaded {id}` 等事件的
 * id 是工具/插件 id，顶掉 sessionId 会让会话遥测被切散到错误文件。只认明确的会话键。
 */
const SESSION_KEY_HINTS = ['sessionId', 'session_id']
const AGENT_KEY_HINTS = ['agentId', 'agent_id']

export function extractIdentity(payload: unknown): { sessionId?: string; agentId?: string } {
  if (payload === null || typeof payload !== 'object') return {}
  const out: { sessionId?: string; agentId?: string } = {}
  const rec = payload as Record<string, unknown>
  for (const k of SESSION_KEY_HINTS) {
    const v = rec[k]
    if (typeof v === 'string' && v.length > 0) {
      out.sessionId = v
      break
    }
  }
  for (const k of AGENT_KEY_HINTS) {
    const v = rec[k]
    if (typeof v === 'string' && v.length > 0) {
      out.agentId = v
      break
    }
  }
  return out
}