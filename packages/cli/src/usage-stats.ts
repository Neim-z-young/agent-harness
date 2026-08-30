/**
 * @harness/cli - 用量统计累积器（纯函数，可单测）
 *
 * 会话级 LLM 用量统计，粒度与维度：
 * - 单轮 llm 对话：每一条 done 事件 = 一次 LLM 调用（llmCalls）
 * - 会话级别：整个 UsageStats 就是当前会话的聚合
 * - 按模型：models[]（调用次数 + input/output + 缓存命中/写入）
 * - 按 agent/任务：agents[]（agentId 维度调用与 token，任务完成数）
 * - 按工具：tools[]（调用次数 + 失败数 + 归并的 input/output token）
 * - 按小时时序：hourly[]（每小时调用与 token，用于时序展示）
 * - 缓存明细：cacheReadTokens（命中缓存）/ cacheWriteTokens（写入缓存），
 *   未命中缓存 = inputTokens - cacheReadTokens - cacheWriteTokens
 */

/** 一次 LLM 调用的记录参数 */
export interface CallRecord {
  model?: string
  agentId?: string
  input?: number
  output?: number
  /** 命中缓存的输入 token */
  cacheRead?: number
  /** 写入缓存（未命中但进入缓存）的输入 token */
  cacheWrite?: number
  /** 调用时间戳（ms）；缺省用 Date.now() */
  ts?: number
}

/** 工具/技能调用记录参数 */
export interface ToolRecord {
  /** 是否出错（出错只累计 errors，不计入 count） */
  isError?: boolean
  /** 归并到该工具的 input token（本轮紧随 LLM 请求的用量） */
  input?: number
  /** 归并到该工具的 output token */
  output?: number
}

/** 单模型统计 */
export interface ModelUsage {
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  /** 命中缓存 token */
  cacheRead: number
  /** 写入缓存 token */
  cacheWrite: number
}

/** 工具/技能调用统计（含归并 token 用量） */
export interface ToolUsage {
  tool: string
  count: number
  errors: number
  inputTokens: number
  outputTokens: number
}

/** 单 agent/任务统计 */
export interface AgentUsage {
  agentId: string
  calls: number
  inputTokens: number
  outputTokens: number
  /** 已完成任务数 */
  tasksDone: number
}

/** 单小时桶（时序展示） */
export interface HourlyUsage {
  /** 小时时间戳（本小时起点，ms） */
  hour: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

/** 会话级用量统计累积器 */
export interface UsageStats {
  /** LLM 调用次数（单轮 llm 对话粒度） */
  llmCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  models: ModelUsage[]
  tools: ToolUsage[]
  agents: AgentUsage[]
  hourly: HourlyUsage[]
}

/** 空累积器 */
export function emptyUsage(): UsageStats {
  return {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: [],
    tools: [],
    agents: [],
    hourly: [],
  }
}

/** 记录一次 LLM 调用（含用量与缓存明细），并按模型 / agent / 小时维度归并 */
export function recordCall(usage: UsageStats, rec: CallRecord = {}): UsageStats {
  const m = rec.model || 'unknown'
  const agentId = rec.model ? (rec.agentId || 'root') : 'root'
  const i = rec.input ?? 0
  const o = rec.output ?? 0
  const cr = rec.cacheRead ?? 0
  const cw = rec.cacheWrite ?? 0
  const ts = rec.ts ?? Date.now()

  // 按模型归并
  let models = usage.models
  const mIdx = models.findIndex((x) => x.model === m)
  if (mIdx === -1) {
    models = [...models, { model: m, calls: 1, inputTokens: i, outputTokens: o, cacheRead: cr, cacheWrite: cw }]
  } else {
    const cur = models[mIdx]
    models = [
      ...models.slice(0, mIdx),
      {
        ...cur,
        calls: cur.calls + 1,
        inputTokens: cur.inputTokens + i,
        outputTokens: cur.outputTokens + o,
        cacheRead: cur.cacheRead + cr,
        cacheWrite: cur.cacheWrite + cw,
      },
      ...models.slice(mIdx + 1),
    ]
  }

  // 按 agent/任务归并
  let agents = usage.agents
  const aIdx = agents.findIndex((x) => x.agentId === agentId)
  if (aIdx === -1) {
    agents = [...agents, { agentId, calls: 1, inputTokens: i, outputTokens: o, tasksDone: 0 }]
  } else {
    const cur = agents[aIdx]
    agents = [
      ...agents.slice(0, aIdx),
      { ...cur, calls: cur.calls + 1, inputTokens: cur.inputTokens + i, outputTokens: cur.outputTokens + o },
      ...agents.slice(aIdx + 1),
    ]
  }

  // 按小时归并（保持 hour 升序）
  const hour = Math.floor(ts / 3_600_000) * 3_600_000
  let hourly = usage.hourly
  const hIdx = hourly.findIndex((x) => x.hour === hour)
  if (hIdx === -1) {
    const entry = { hour, calls: 1, inputTokens: i, outputTokens: o, cacheRead: cr, cacheWrite: cw }
    const insertAt = hourly.findIndex((x) => x.hour > hour)
    hourly = insertAt === -1 ? [...hourly, entry] : [...hourly.slice(0, insertAt), entry, ...hourly.slice(insertAt)]
  } else {
    const cur = hourly[hIdx]
    hourly = [
      ...hourly.slice(0, hIdx),
      {
        ...cur,
        calls: cur.calls + 1,
        inputTokens: cur.inputTokens + i,
        outputTokens: cur.outputTokens + o,
        cacheRead: cur.cacheRead + cr,
        cacheWrite: cur.cacheWrite + cw,
      },
      ...hourly.slice(hIdx + 1),
    ]
  }

  return {
    llmCalls: usage.llmCalls + 1,
    inputTokens: usage.inputTokens + i,
    outputTokens: usage.outputTokens + o,
    cacheReadTokens: usage.cacheReadTokens + cr,
    cacheWriteTokens: usage.cacheWriteTokens + cw,
    models,
    tools: usage.tools,
    agents,
    hourly,
  }
}

/** 记录一次工具/技能调用；失败只累计 errors；可归并本轮紧随 LLM 请求的 token 用量 */
export function recordTool(usage: UsageStats, tool: string, rec: ToolRecord = {}): UsageStats {
  const t = tool || 'tool'
  const isError = !!rec.isError
  const attrInput = rec.input ?? 0
  const attrOutput = rec.output ?? 0

  let tools = usage.tools
  const idx = tools.findIndex((x) => x.tool === t)
  if (idx === -1) {
    tools = [
      ...tools,
      {
        tool: t,
        count: isError ? 0 : 1,
        errors: isError ? 1 : 0,
        inputTokens: isError ? 0 : attrInput,
        outputTokens: isError ? 0 : attrOutput,
      },
    ]
  } else {
    const cur = tools[idx]
    tools = [
      ...tools.slice(0, idx),
      {
        ...cur,
        count: cur.count + (isError ? 0 : 1),
        errors: cur.errors + (isError ? 1 : 0),
        inputTokens: cur.inputTokens + (isError ? 0 : attrInput),
        outputTokens: cur.outputTokens + (isError ? 0 : attrOutput),
      },
      ...tools.slice(idx + 1),
    ]
  }
  return { ...usage, tools }
}

/** 标记某 agent 完成一个任务（用于 agent 维度 tasksDone） */
export function recordTaskDone(usage: UsageStats, agentId?: string): UsageStats {
  const id = agentId || 'root'
  let agents = usage.agents
  const idx = agents.findIndex((x) => x.agentId === id)
  if (idx === -1) {
    agents = [...agents, { agentId: id, calls: 0, inputTokens: 0, outputTokens: 0, tasksDone: 1 }]
  } else {
    const cur = agents[idx]
    agents = [...agents.slice(0, idx), { ...cur, tasksDone: cur.tasksDone + 1 }, ...agents.slice(idx + 1)]
  }
  return { ...usage, agents }
}

/** 未命中缓存（需实际计费）的输入 token */
export function uncachedInput(u: UsageStats): number {
  return Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens)
}

/** 单模型统计行：`model ×calls · inN(⚡cr)outN` */
export function modelUsageRow(m: ModelUsage): string {
  const cache = m.cacheRead > 0 || m.cacheWrite > 0 ? `⚡${m.cacheRead}/w${m.cacheWrite} ` : ''
  return `${m.model} ×${m.calls} · ${cache}in${m.inputTokens}/out${m.outputTokens}`
}

/** 单工具调用行：`tool ×count(失败)` + 归并 token */
export function toolUsageRow(t: ToolUsage): string {
  const err = t.errors > 0 ? ` (${t.errors}❌)` : ''
  const tok = t.inputTokens > 0 || t.outputTokens > 0 ? ` · ${t.inputTokens}/${t.outputTokens}` : ''
  return `${t.tool} ×${t.count}${err}${tok}`
}

/** 单 agent 行：`agentId ×calls [✓tasks] · in/out` */
export function agentUsageRow(a: AgentUsage): string {
  const tasks = a.tasksDone > 0 ? ` ✓${a.tasksDone}` : ''
  return `${a.agentId} ×${a.calls}${tasks} · ${a.inputTokens}/${a.outputTokens}`
}

/** 小时标签：`HH:00` */
export function hourLabel(hour: number): string {
  const d = new Date(hour)
  return `${String(d.getHours()).padStart(2, '0')}:00`
}

/** 单小时行：`HH:00 ███░░ 123`（迷你条形 + 用量） */
export function hourlyRow(h: HourlyUsage, maxInput: number): string {
  const total = h.inputTokens + h.outputTokens
  const bar = sparkline(h.inputTokens, maxInput, 6)
  return `${hourLabel(h.hour)} ${bar} ${total}`
}

/** 按比例生成 N 格条形 █/░：填充格 = round(value/max * width)，无输入时全空 */
export function sparkline(value: number, maxValue: number, width: number): string {
  const filled = Math.max(0, Math.min(width, maxValue <= 0 ? 0 : Math.round((value / maxValue) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// ------------------------------------------------------------------------
// 会话级持久化 + 报告导出
// ------------------------------------------------------------------------

/** 约定写入 Session.meta 的 key：会话级用量统计数据 */
export const USAGE_STATS_KEY = 'usageStats'

/** 从 Session.meta 读取已持久化的用量统计（无则返回空累积器） */
export function usageFromMeta(meta: Record<string, unknown> | undefined): UsageStats | undefined {
  const v = meta?.[USAGE_STATS_KEY]
  if (!v || typeof v !== 'object') return undefined
  return v as UsageStats
}

/**
 * 由消息列表重建用量统计（用于 REPL/已恢复会话等未走 TuiApp onEvent 的场景）。
 * 逐条取 message.meta[{ model, tokenUsage }] 累加为 LLM 调用；工具调用无法反推
 * 但会按 tool part 依次记录 toolId（含 isError）。纯函数、可单测。
 */
export function usageFromMessages(messages: Array<{ meta?: Record<string, unknown>; parts?: Array<{ type: string; toolId?: string; isError?: boolean }> }>): UsageStats {
  let u = emptyUsage()
  let pending: { input: number; output: number } | null = null
  let attributed = false
  for (const m of messages) {
    const meta = m.meta as { model?: string; tokenUsage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } | undefined
    if (meta?.tokenUsage) {
      const tu = meta.tokenUsage
      u = recordCall(u, {
        model: meta.model,
        input: tu.input,
        output: tu.output,
        cacheRead: tu.cacheRead,
        cacheWrite: tu.cacheWrite,
      })
      pending = { input: tu.input ?? 0, output: tu.output ?? 0 }
      attributed = false
    }
    for (const p of m.parts ?? []) {
      if (p.type === 'tool' && p.toolId) {
        u = recordTool(u, p.toolId, { isError: p.isError, input: !attributed ? pending?.input : undefined, output: !attributed ? pending?.output : undefined })
        if (!attributed) attributed = true
      }
    }
  }
  return u
}

/** 详细统计文本报告（/stats 命令输出，纯文本） */
export function renderStatsText(u: UsageStats): string {
  const lines: string[] = []
  lines.push(`LLM 调用 ${u.llmCalls} 次 · in ${u.inputTokens} / out ${u.outputTokens}`)
  if (u.cacheReadTokens > 0 || u.cacheWriteTokens > 0) {
    lines.push(`缓存：命中 ${u.cacheReadTokens}，写入 ${u.cacheWriteTokens}，未命中 ${uncachedInput(u)}`)
  }
  if (u.models.length) {
    lines.push('按模型：')
    for (const m of u.models) lines.push(`  ${modelUsageRow(m)}`)
  }
  if (u.agents.length) {
    lines.push('按 agent/任务：')
    for (const a of u.agents) lines.push(`  ${agentUsageRow(a)}`)
  }
  if (u.tools.length) {
    lines.push('按工具：')
    for (const t of u.tools) lines.push(`  ${toolUsageRow(t)}`)
  }
  if (u.hourly.length) {
    const max = Math.max(...u.hourly.map((h) => h.inputTokens + h.outputTokens), 1)
    lines.push('按小时时序：')
    for (const h of u.hourly) lines.push(`  ${hourlyRow(h, max)}`)
  }
  if (lines.length === 0) lines.push('（无用量数据）')
  return lines.join('\n')
}

/** 导出为 JSON 报告文本 */
export function exportStatsJson(u: UsageStats, ctx: { sessionId?: string; title?: string } = {}): string {
  return JSON.stringify({
    sessionId: ctx.sessionId,
    title: ctx.title,
    exportedAt: new Date().toISOString(),
    llmCalls: u.llmCalls,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    uncachedInput: uncachedInput(u),
    models: u.models,
    tools: u.tools,
    agents: u.agents,
    hourly: u.hourly.map((h) => ({ ...h, label: hourLabel(h.hour) })),
  }, null, 2)
}

/** 导出为 Markdown 报告文本 */
export function exportStatsMarkdown(u: UsageStats, ctx: { sessionId?: string; title?: string } = {}): string {
  const L: string[] = []
  L.push('# 会话用量统计报告')
  L.push('')
  L.push(`- 会话：${ctx.sessionId ?? '-'}${ctx.title ? `（${ctx.title}）` : ''}`)
  L.push(`- 导出时间：${new Date().toLocaleString()}`)
  L.push('')
  L.push('## 汇总')
  L.push('')
  L.push('| 指标 | 值 |')
  L.push('| --- | --- |')
  L.push(`| LLM 调用次数（单轮对话） | ${u.llmCalls} |`)
  L.push(`| 输入 token | ${u.inputTokens} |`)
  L.push(`| 输出 token | ${u.outputTokens} |`)
  L.push(`| 命中缓存 token | ${u.cacheReadTokens} |`)
  L.push(`| 写入缓存 token | ${u.cacheWriteTokens} |`)
  L.push(`| 未命中缓存输入 token | ${uncachedInput(u)} |`)
  L.push('')
  const section = (title: string, header: string[], rows: string[][]): void => {
    L.push(`## ${title}`)
    L.push('')
    L.push('| ' + header.join(' | ') + ' |')
    L.push('| ' + header.map(() => '---').join(' | ') + ' |')
    for (const r of rows) L.push('| ' + r.join(' | ') + ' |')
    L.push('')
  }
  if (u.models.length) {
    section('按模型', ['模型', '调用', '输入', '输出', '缓存命中', '缓存写入'],
      u.models.map((m) => [m.model, String(m.calls), String(m.inputTokens), String(m.outputTokens), String(m.cacheRead), String(m.cacheWrite)]))
  }
  if (u.agents.length) {
    section('按 agent/任务', ['agent', '调用', '输入', '输出', '完成任务'],
      u.agents.map((a) => [a.agentId, String(a.calls), String(a.inputTokens), String(a.outputTokens), String(a.tasksDone)]))
  }
  if (u.tools.length) {
    section('按工具', ['工具', '调用', '失败', '输入', '输出'],
      u.tools.map((t) => [t.tool, String(t.count), String(t.errors), String(t.inputTokens), String(t.outputTokens)]))
  }
  if (u.hourly.length) {
    section('按小时时序', ['小时', '调用', '输入', '输出', '缓存命中', '缓存写入'],
      u.hourly.map((h) => [hourLabel(h.hour), String(h.calls), String(h.inputTokens), String(h.outputTokens), String(h.cacheRead), String(h.cacheWrite)]))
  }
  return L.join('\n')
}