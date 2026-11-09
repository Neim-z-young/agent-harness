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
  /**
   * 注入 HTTP 实现（缺省 `globalThis.fetch`）。
   *
   * 存在的理由是可测性：此前本模块唯一能断言的只有"不抛"，因为 `send` 直接调全局
   * `fetch` —— 连"非 2xx 被当成功""flush 期间的新事件被清掉"这类缺陷都测不出来
   * （用例只能打真实端点 `http://collector:4318/`，跑一次 DNS 再静默失败）。
   */
  fetchImpl?: OtlpFetch
}

/** 只依赖 fetch 的最小契约：既能被 `globalThis.fetch` 满足，也能在用例里完全受控 */
export type OtlpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status?: number }>

/** 上报计数（只读快照）。静默失败必须能看见：`failed > 0` 就是"collector 在拒收" */
export interface OtlpStats {
  /** 已被 collector 接受（2xx）的记录数 */
  sent: number
  /** 发送失败 / 非 2xx / 超时的记录数 */
  failed: number
  /** 因已 close 而未入队的记录数 */
  dropped: number
}

export interface OtlpExporter {
  enabled: boolean
  /** 累加一条，按 batchMs 批量发送 */
  push(ev: TelemetryEnvelope): void
  /** 立即发送 pending（正常退出 / 崩溃兜底时调用） */
  flush(): Promise<void>
  /** 关闭：先把最后一批尽力发出，再停止接收 */
  close(): void
  /** 只读计数快照 */
  readonly stats: OtlpStats
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

/** 归一化端点：去空白、去尾斜杠（`https://c:4318///` 与 `https://c:4318` 是同一个 collector） */
export function normalizeEndpoint(raw: string | undefined): string | undefined {
  const s = raw?.trim().replace(/\/+$/, '')
  return s ? s : undefined
}

export function createOtlpExporter(opts: OtlpOptions): OtlpExporter {
  const endpoint = normalizeEndpoint(opts.endpoint)
  // 判据只有一条：显式关掉，或没给出可用端点 ⇒ no-op。此前写成
  // `(opts.enabled !== false ? opts.endpoint?.length : 0) !== 0 && !!endpoint` —— 同一件事
  // 换了三种写法（长度、真值、非零比较），端点写成空白串时行为还和直觉不一致。
  const enabled = opts.enabled !== false && endpoint !== undefined

  const stats: OtlpStats = { sent: 0, failed: 0, dropped: 0 }
  if (!enabled) {
    return {
      enabled: false,
      push: () => {},
      flush: async () => {},
      close: () => {},
      stats,
    }
  }

  const batchMs = opts.batchMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? 5000
  const url = `${endpoint}/v1/logs`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(opts.headers ?? {}),
  }
  const doFetch: OtlpFetch = opts.fetchImpl ?? globalThis.fetch

  let pending: OtlpLogRecord[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  /**
   * 发一批。**不看 `closed`**：close() 需要在置位前把最后一批交出去，而
   * "已关闭还在发" 这个状态由调用点保证不会出现（close 先摘队列再置位）。
   */
  const send = async (records: OtlpLogRecord[]): Promise<void> => {
    if (!records.length) return
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(toExportRequest(records)),
        // 用 AbortSignal.timeout 而不是「setTimeout + ctrl.abort」：它内部的定时器是
        // unref 的 ⇒ 收尾那次上报不会把进程退出钉住最多 timeoutMs（collector 黑洞时
        // 用户看到的是"退出卡 5 秒"，且会归因到遥测）。
        signal: AbortSignal.timeout(timeoutMs),
      })
      // 非 2xx 此前**完全没看**：collector 401/413 一律被当成功，stats 里永远是 0 失败。
      if (res.ok) stats.sent += records.length
      else stats.failed += records.length
    } catch {
      // OTLP 上报失败不致命：静默丢弃本批，不影响主流程（但记账）
      stats.failed += records.length
    }
  }

  const doFlush = () => {
    clearTimer()
    const batch = pending
    pending = []
    if (batch.length) void send(batch)
  }

  return {
    enabled: true,
    stats,
    push(ev: TelemetryEnvelope) {
      if (closed) {
        stats.dropped += 1
        return
      }
      pending.push(toOtlpLogRecord(ev))
      if (timer === null) timer = setTimeout(doFlush, batchMs)
    },
    async flush() {
      clearTimer()
      // **先摘队列再 await**：此前是 `await send(pending); pending = []`，于是 await 期间
      // push 进来的事件被同一句 `pending = []` 清掉（既不在这批里、也不在下一批里）。
      const batch = pending
      pending = []
      await send(batch)
    },
    close() {
      if (closed) return
      clearTimer()
      const batch = pending
      pending = []
      // 先发再置位：uninstall 里「flush() 是 void、close() 紧随其后」是既有顺序，
      // 旧实现在 close 里直接丢弃 + send 见到 closed 就早退 ⇒ **最后一批必然发不出去**。
      if (batch.length) void send(batch)
      closed = true
    },
  }
}