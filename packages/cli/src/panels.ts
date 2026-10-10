/**
 * M4 面板纯函数 —— 审计面板（decision.human 时间线/放行率/responseMs）+ 跑分面板（pass^k 趋势/成本·延迟）。
 *
 * 全为纯函数/文件读取（可单测），TUI 侧边栏渲染消费；不依赖 React。
 *
 * ## 审计（audit）
 * 数据源：`{dataDir}/sessions/{sessionId}.audit.jsonl`（M3 `createAuditSink` 落盘）。
 * 信封：`{schema, kind, ts, tool, riskLevel, actionTaken, responseMs, rememberScope, stateHash, …}`。
 * 指标口径（核心指标反转）：**responseMs（人工响应耗时）与放行率衡量决策卡片 UI 辅助效果**，
 * 而非机器决策准确率。
 *
 * ## 跑分（bench）
 * 数据源：`{dataDir}/bench/{summary.json, history.jsonl}`。`history.jsonl` 每次跑分 append 一行
 * summary（见 @harness/bench writeResults），跨多次跑组成趋势。建议跑分时 `--out <dataDir>/bench`。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ===== 审计面板 =====

export interface AuditDecision {
  ts: number
  tool: string
  riskLevel: 'low' | 'medium' | 'high' | string
  actionTaken: 'allow' | 'deny' | 'always-allow' | 'always-deny' | string
  rememberScope: 'tool' | 'once' | string
  responseMs: number
}

export interface AuditSummary {
  /** 有效决策总数（有完整 actionTaken/responseMs 的行） */
  total: number
  /** 放行率：allow + always-allow 占有效决策比例 */
  allowRate: number
  /** 平均 / 中位 / 最近一次响应耗时（ms） */
  avgResponseMs: number
  medianResponseMs: number
  lastResponseMs?: number
  /** 风险分布（high/medium/low 计数） */
  riskCounts: Record<string, number>
  /** 时间线：按 ts 升序，最近的在末尾 */
  timeline: AuditDecision[]
  /** 解析出的非法行数（非 JSON / 非 decision.human） */
  malformed: number
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

/** 解析 audit.jsonl 全文 → 汇总（纯函数；非法行计数，不抛） */
export function parseAuditLog(text: string): AuditSummary {
  const timeline: AuditDecision[] = []
  let malformed = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let e: Record<string, unknown>
    try {
      e = JSON.parse(line) as Record<string, unknown>
    } catch {
      malformed++
      continue
    }
    if (e.kind !== 'decision.human') continue
    const ts = typeof e.ts === 'number' ? e.ts : NaN
    const responseMs = typeof e.responseMs === 'number' ? e.responseMs : NaN
    const actionTaken = e.actionTaken as AuditDecision['actionTaken']
    if (Number.isNaN(ts) || Number.isNaN(responseMs) || !actionTaken) {
      malformed++
      continue
    }
    timeline.push({
      ts,
      tool: String(e.tool ?? 'unknown'),
      riskLevel: String(e.riskLevel ?? 'medium'),
      actionTaken,
      rememberScope: String(e.rememberScope ?? 'once'),
      responseMs,
    })
  }
  timeline.sort((a, b) => a.ts - b.ts)

  const allowed = timeline.filter((d) => d.actionTaken === 'allow' || d.actionTaken === 'always-allow')
  const rms = timeline.map((d) => d.responseMs)
  const riskCounts: Record<string, number> = {}
  for (const d of timeline) riskCounts[d.riskLevel] = (riskCounts[d.riskLevel] ?? 0) + 1

  return {
    total: timeline.length,
    allowRate: timeline.length > 0 ? allowed.length / timeline.length : 0,
    avgResponseMs: rms.length > 0 ? rms.reduce((s, v) => s + v, 0) / rms.length : 0,
    medianResponseMs: median(rms),
    lastResponseMs: rms.length > 0 ? rms[rms.length - 1] : undefined,
    riskCounts,
    timeline,
    malformed,
  }
}

// ===== 跑分面板 =====

export interface BenchRecord {
  /** 跑分时间（当前样本的时间戳，缺省用数组下标 → 见 parseBenchHistory） */
  model: string
  userModel: string
  split: string
  k: number
  /** pass^1 与 pass^k（任务级全通过率） */
  pass1: number
  passK: number
  avgReward: number
  avgLatencyMs: number
}

/** 解析单份 summary.json 内容 → 面板需要的精简字段 */
export function parseBenchSummary(text: string): BenchRecord | null {
  let j: Record<string, unknown>
  try {
    j = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  const meta = (j.meta ?? {}) as Record<string, unknown>
  const passAtK = j.passAtK as Record<string, number> | undefined
  const pass1 = passAtK?.['1']
  return {
    model: String(meta.model ?? '?'),
    userModel: String(meta.userModel ?? '?'),
    split: String(meta.split ?? '?'),
    k: Number(meta.k ?? 0),
    pass1: typeof pass1 === 'number' ? pass1 : 0,
    passK: typeof passAtK?.[String(Number(meta.k) || 1)] === 'number'
      ? (passAtK![String(Number(meta.k) || 1)] as number)
      : (typeof pass1 === 'number' ? pass1 : 0),
    avgReward: Number(j.avgReward ?? 0),
    avgLatencyMs: Number(j.avgLatencyMs ?? 0),
  }
}

/** 解析 history.jsonl（每行一份 summary，按时间序）→ 跑分记录序列（最近的在末尾） */
export function parseBenchHistory(text: string): BenchRecord[] {
  const out: BenchRecord[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const r = parseBenchSummary(line)
    if (r) out.push(r)
  }
  return out
}

/** 从磁盘发现跑分数据（TUI 用）：返回历史记录列表（跨多次跑的 pass^k 趋势） */
export function loadBenchHistory(dataDir: string): { history: BenchRecord[]; error?: string } {
  try {
    const p = join(dataDir, 'bench', 'history.jsonl')
    const text = readFileSync(p, 'utf8')
    return { history: parseBenchHistory(text) }
  } catch (err) {
    return { history: [], error: err instanceof Error ? err.message : String(err) }
  }
}

// ===== 面板渲染行（纯字符串，TUI 逐行 <text>；无 React 依赖，可单测） =====

const RISK_MARK: Record<string, string> = { low: '🟢', medium: '🟡', high: '🔴' }
const ACTION_MARK: Record<string, string> = {
  allow: '✓放行', 'always-allow': '✓永久', deny: '✗拒绝', 'always-deny': '✗永久',
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}

/** 审计面板渲染行 */
export function auditPanelLines(s: AuditSummary): string[] {
  if (s.total === 0) return ['（本会话暂无人工决策审计）', '权限询问放行/拒绝后会在此记录']
  const out: string[] = []
  out.push(`决策 ${s.total} · 放行率 ${pct(s.allowRate)}`)
  out.push(`响应 ${Math.round(s.avgResponseMs)}ms 均 / ${Math.round(s.medianResponseMs)}ms 中位 · 最近 ${Math.round(s.lastResponseMs ?? 0)}ms`)
  const r = s.riskCounts
  out.push(`风险 高${r['high'] ?? 0} 中${r['medium'] ?? 0} 低${r['low'] ?? 0}`)
  out.push(`── 时间线 ──`)
  const last = s.timeline.slice(-12)
  for (const d of last) {
    out.push(`${fmtTime(d.ts)} ${RISK_MARK[d.riskLevel] ?? '·'} ${ACTION_MARK[d.actionTaken] ?? d.actionTaken} ${d.tool}`)
  }
  if (s.timeline.length > 12) out.push(`… 其余 ${s.timeline.length - 12} 条`)
  return out
}

/** 跑分面板渲染行（跨多次跑的 pass^k 趋势 / 成本·延迟对比） */
export function benchPanelLines(history: BenchRecord[]): string[] {
  if (history.length === 0) {
    return ['（未发现跑分数据）', '用 --out <dataDir>/bench 跑分后在此显示趋势']
  }
  const last = history[history.length - 1]!
  const out: string[] = []
  out.push(`跑分 ${history.length} 次 · 最近 pass^1=${pct(last.pass1)}`)
  for (const h of history.slice(-12)) {
    out.push(`${h.model} ${h.split} k${h.k} ${pct(h.pass1)} reward ${h.avgReward.toFixed(2)} ${(h.avgLatencyMs / 1000).toFixed(1)}s`)
  }
  if (history.length > 12) out.push(`… 其余 ${history.length - 12} 次`)
  return out
}