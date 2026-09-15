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

// ------------------------------------------------------------------------
// 当日用量 / 水合 / 归并（跨重连累计）
// ------------------------------------------------------------------------

/** 本地时区「当天零点」时间戳（用于当日用量归集） */
export function dayStart(ts: number = Date.now()): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 累积器是否为空（无任何调用 / 小时桶 / 工具记录） */
export function isBlankUsage(u: UsageStats | undefined): boolean {
  if (!u) return true
  return u.llmCalls === 0 && (u.hourly?.length ?? 0) === 0 && (u.tools?.length ?? 0) === 0
}

/**
 * 截取 `fromTs`（含）之后的用量：按小时桶过滤后重算汇总。
 * models / tools / agents 无法按天切分，置空（hourly 保留当日桶，便于时序展示）。
 */
export function usageSince(u: UsageStats, fromTs: number): UsageStats {
  const buckets = (u.hourly ?? []).filter((h) => h.hour >= fromTs)
  let llmCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  for (const h of buckets) {
    llmCalls += h.calls
    inputTokens += h.inputTokens
    outputTokens += h.outputTokens
    cacheReadTokens += h.cacheRead
    cacheWriteTokens += h.cacheWrite
  }
  return {
    llmCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    models: [],
    tools: [],
    agents: [],
    hourly: buckets,
  }
}

/** 当日（本地时区）用量 */
export function todayUsage(u: UsageStats, now: number = Date.now()): UsageStats {
  return usageSince(u, dayStart(now))
}

/** 合并两个累积器（同 key 维度相加；hourly 按小时归并并保持升序） */
export function mergeUsage(a: UsageStats, b: UsageStats): UsageStats {
  const models = [...a.models]
  for (const m of b.models) {
    const i = models.findIndex((x) => x.model === m.model)
    if (i === -1) models.push({ ...m })
    else {
      const c = models[i]
      models[i] = {
        ...c,
        calls: c.calls + m.calls,
        inputTokens: c.inputTokens + m.inputTokens,
        outputTokens: c.outputTokens + m.outputTokens,
        cacheRead: c.cacheRead + m.cacheRead,
        cacheWrite: c.cacheWrite + m.cacheWrite,
      }
    }
  }

  const tools = [...a.tools]
  for (const t of b.tools) {
    const i = tools.findIndex((x) => x.tool === t.tool)
    if (i === -1) tools.push({ ...t })
    else {
      const c = tools[i]
      tools[i] = {
        ...c,
        count: c.count + t.count,
        errors: c.errors + t.errors,
        inputTokens: c.inputTokens + t.inputTokens,
        outputTokens: c.outputTokens + t.outputTokens,
      }
    }
  }

  const agents = [...a.agents]
  for (const g of b.agents) {
    const i = agents.findIndex((x) => x.agentId === g.agentId)
    if (i === -1) agents.push({ ...g })
    else {
      const c = agents[i]
      agents[i] = {
        ...c,
        calls: c.calls + g.calls,
        inputTokens: c.inputTokens + g.inputTokens,
        outputTokens: c.outputTokens + g.outputTokens,
        tasksDone: c.tasksDone + g.tasksDone,
      }
    }
  }

  const hourly = [...a.hourly]
  for (const h of b.hourly) {
    const i = hourly.findIndex((x) => x.hour === h.hour)
    if (i === -1) hourly.push({ ...h })
    else {
      const c = hourly[i]
      hourly[i] = {
        ...c,
        calls: c.calls + h.calls,
        inputTokens: c.inputTokens + h.inputTokens,
        outputTokens: c.outputTokens + h.outputTokens,
        cacheRead: c.cacheRead + h.cacheRead,
        cacheWrite: c.cacheWrite + h.cacheWrite,
      }
    }
  }
  hourly.sort((x, y) => x.hour - y.hour)

  return {
    llmCalls: a.llmCalls + b.llmCalls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    models,
    tools,
    agents,
    hourly,
  }
}

/** 汇总多个累积器（跨会话聚合当日用量用） */
export function sumUsage(list: readonly UsageStats[]): UsageStats {
  let acc = emptyUsage()
  for (const u of list) acc = mergeUsage(acc, u)
  return acc
}

/**
 * 从会话水合用量统计（TUI 挂载 / /stats / /stats-export 共用）。
 *
 * 优先级：meta 持久化的累积器（有数据时）→ 由消息历史重建 → 空累积器。
 * 这样重连（resume）后能立刻看到重连前累计的用量，而不是从 0 开始。
 */
export function hydrateUsage(s?: {
  meta?: Record<string, unknown>
  messages?: Array<{ meta?: Record<string, unknown>; createdAt?: number; parts?: Array<{ type: string; toolId?: string; isError?: boolean }> }>
}): UsageStats {
  const fromMeta = usageFromMeta(s?.meta)
  if (fromMeta && !isBlankUsage(fromMeta)) return fromMeta
  const rebuilt = usageFromMessages(s?.messages ?? [])
  if (!isBlankUsage(rebuilt)) return rebuilt
  return fromMeta ?? emptyUsage()
}

/** 当日用量单行摘要：`今日 N次 · inX/outY` */
export function todayUsageLine(u: UsageStats): string {
  return `今日 ${u.llmCalls}次 · in${u.inputTokens}/out${u.outputTokens}`
}

/**
 * 是否应把 `next` 写入 session.meta：空累积器不得覆盖已持久化的历史。
 *
 * 回归背景：TUI 挂载时累积器初始为空，若无条件写回 meta 并落盘，
 * 会把重连前累计的用量清零（/stats 显示 0、/stats-export 也导不出历史）。
 */
export function shouldPersistUsage(next: UsageStats, persisted: UsageStats | undefined): boolean {
  if (!persisted || isBlankUsage(persisted)) return true
  // 空累积器不得覆盖已有历史
  if (isBlankUsage(next)) return false
  // 水合不全时不得回退：本轮调用数少于已持久化值，说明内存态没接上历史，
  // 写回会静默丢失调用记录（比全空覆盖更隐蔽）。
  if (next.llmCalls < persisted.llmCalls) return false
  return true
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
 *
 * 时间归属：按消息自身的 `createdAt` 归并小时桶（缺失才回落当前时间），
 * 否则历史消息会被全部算到「今天」，导致当天用量虚高。
 */
export function usageFromMessages(messages: Array<{ meta?: Record<string, unknown>; createdAt?: number; parts?: Array<{ type: string; toolId?: string; isError?: boolean }> }>): UsageStats {
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
        ts: typeof m.createdAt === 'number' ? m.createdAt : undefined,
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

/** 导出上下文：会话标识 + 可选的当日（跨会话）用量汇总 */
export interface ExportStatsCtx {
  sessionId?: string
  title?: string
  /** 当日（本地时区、跨会话归集）用量；提供时一并写入报告 */
  today?: UsageStats
}

/** 导出为 JSON 报告文本 */
export function exportStatsJson(u: UsageStats, ctx: ExportStatsCtx = {}): string {
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
    ...(ctx.today
      ? {
          today: {
            llmCalls: ctx.today.llmCalls,
            inputTokens: ctx.today.inputTokens,
            outputTokens: ctx.today.outputTokens,
            cacheReadTokens: ctx.today.cacheReadTokens,
            cacheWriteTokens: ctx.today.cacheWriteTokens,
            uncachedInput: uncachedInput(ctx.today),
            hourly: ctx.today.hourly.map((h) => ({ ...h, label: hourLabel(h.hour) })),
          },
        }
      : {}),
  }, null, 2)
}

/** 导出为 Markdown 报告文本 */
export function exportStatsMarkdown(u: UsageStats, ctx: ExportStatsCtx = {}): string {
  const L: string[] = []
  L.push('# 会话用量统计报告')
  L.push('')
  L.push(`- 会话：${ctx.sessionId ?? '-'}${ctx.title ? `（${ctx.title}）` : ''}`)
  L.push(`- 导出时间：${new Date().toLocaleString()}`)
  L.push('')
  if (ctx.today) {
    L.push('## 当日汇总（全部会话）')
    L.push('')
    L.push('| 指标 | 值 |')
    L.push('| --- | --- |')
    L.push(`| 当日 LLM 调用次数 | ${ctx.today.llmCalls} |`)
    L.push(`| 当日输入 token | ${ctx.today.inputTokens} |`)
    L.push(`| 当日输出 token | ${ctx.today.outputTokens} |`)
    L.push(`| 当日命中缓存 token | ${ctx.today.cacheReadTokens} |`)
    L.push(`| 当日未命中缓存输入 token | ${uncachedInput(ctx.today)} |`)
    L.push('')
  }
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