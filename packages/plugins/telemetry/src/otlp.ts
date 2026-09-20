/**
 * OTLP/HTTP 日志导出器（最小直连，ingest JSON）。
 *
 * 对齐 OpenCode 的 Observability OTLP 出口思路（`reference/opencode-dev/.../otlp.ts`）：
 * - endpoint 为空 → 完全 no-op，不加载/不发送（冷路径零成本）；
 * - 只发 `v1/logs`，不做 traces —— 控制工程量；
 * - 失败静默（遥测不影响主流程），批量 + debounce 合并请求。
 *
 * 序列化：OTLP/HTTP 支持 `application/json`（ExportLogsServiceRequest）。本模块不引入 protobuf 依赖，
 * 直接产 JSON，便于最小直连测试。真机联调按「真机为准」原则验证 collector 端点接受 JSON 编码。
 */

import type { TelemetryEnvelope } from './envelope.js'

export interface OtlpOptions {
  /** 是否启用（缺省：endpoint 非空即启用） */
  enabled?: boolean
  /** collector 端点；为空则整体 no-op。如 `https://collector:4318`（后接 `v1/logs`） */
  endpoint?: string
  /** 附加请求头（如 API key） */
  headers?: Record<string, string>
  /** 批量合并间隔 ms（缺省 1000） */
  batchMs?: number
  /** 单请求超时 ms（缺省 5000） */
  timeoutMs?: number
}

export interface OtlpExporter {
  enabled: boolean
  /** 累加一条，按 batchMs 批量发送 */
  push(ev: TelemetryEnvelope): void
  /** 立即发送 pending（正常退出 / 崩溃兜底时调用） */
  flush(): Promise<void>
  /** 关闭（取消定时器） */
  close(): void
}

/** OTLP 日志记录的 JSON 形态（最小子集） */
export interface OtlpLogRecord {
  timeUnixNano: string
  severityNumber: number
  severityText: string
  body: { stringValue: string }
  attributes: { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } }[]
}

/** 异常类事件视为 error 级，便于远端告警接入 */
const ERROR_KIND = /(error|fail|crash|doomloop|deny)/i

export function severityFor(kind: string): { number: number; text: string } {
  return ERROR_KIND.test(kind)
    ? { number: 17, text: 'ERROR' }
    : { number: 9, text: 'INFO' }
}

function attr(key: string, v: string | number): OtlpLogRecord['attributes'][number] {
  if (typeof v === 'number') {
    return { key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } }
  }
  return { key, value: { stringValue: v } }
}

/** envelope → OTLP LogRecord（纯函数，便于单测） */
export function toOtlpLogRecord(ev: TelemetryEnvelope): OtlpLogRecord {
  const sev = severityFor(ev.kind)
  const attributes: OtlpLogRecord['attributes'] = [{ key: 'source.kind', value: { stringValue: ev.kind } }]
  for (const [k, v] of Object.entries(ev.attrs)) {
    if (v === undefined) continue
    attributes.push(attr(k, v))
  }
  for (const [k, v] of Object.entries(ev.metrics)) {
    if (v === undefined) continue
    attributes.push(attr(`metric.${k}`, v))
  }
  return {
    timeUnixNano: String(Math.round(ev.ts * 1e6)),
    severityNumber: sev.number,
    severityText: sev.text,
    body: { stringValue: ev.kind },
    attributes,
  }
}

/** LogRecord[] → ExportLogsServiceRequest（纯函数，便于单测） */
export function toExportRequest(records: OtlpLogRecord[]): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attr('service.name', 'agent-harness'),
            attr('telemetry.sdk.name', 'harness-telemetry'),
            attr('telemetry.sdk.version', '0.1.0'),
          ],
        },
        scopeLogs: [
          {
            scope: { name: 'agent-harness' },
            logRecords: records,
          },
        ],
      },
    ],
  }
}

export function createOtlpExporter(opts: OtlpOptions): OtlpExporter {
  const endpoint = opts.endpoint?.replace(/\/+$/, '')
  const enabled = (opts.enabled !== false ? opts.endpoint?.length : 0) !== 0 && !!endpoint

  if (!enabled) return { enabled: false, push: () => {}, flush: async () => {}, close: () => {} }

  const batchMs = opts.batchMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? 5000
  const url = `${endpoint}/v1/logs`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(opts.headers ?? {}),
  }

  let pending: OtlpLogRecord[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const send = async (records: OtlpLogRecord[]) => {
    if (!records.length || closed) return
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(toExportRequest(records)),
        signal: ctrl.signal,
      })
    } catch {
      // OTLP 上报失败不致命：静默丢弃本批，不影响主流程
    } finally {
      clearTimeout(t)
    }
  }

  const doFlush = () => {
    if (!pending.length) return
    const batch = pending
    pending = []
    timer = null
    void send(batch)
  }

  return {
    enabled: true,
    push(ev: TelemetryEnvelope) {
      if (closed) return
      pending.push(toOtlpLogRecord(ev))
      if (timer === null) timer = setTimeout(doFlush, batchMs)
    },
    async flush() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      await send(pending)
      pending = []
    },
    close() {
      closed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      pending = []
    },
  }
}