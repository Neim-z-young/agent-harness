/**
 * @harness/usage - 用量统计累积器（纯函数，可单测；零依赖）
 *
 * 为什么独立成包：累加口径必须**引擎层唯一**。此前只有 TUI 持有累加器与写盘
 * （`tui.tsx` 模块 4），于是 headless / REPL 宿主与子 agent 会话的用量完全不入账
 * （真机：6 个子会话约 1.5M 输入 token 不可见）。抽成零依赖包后，core 可以依赖它
 * 做唯一累加者，cli 保留薄再导出，宿主一律退化为渲染器。
 *
 * 会话级 LLM 用量统计，粒度与维度：
 * - 单轮 llm 对话：每一条 done 事件 = 一次 LLM 调用（llmCalls）
 * - 会话级别：整个 UsageStats 就是当前会话的聚合
 * - 按 Provider：providers[]（**实例路由键**维度调用与 token，见下）
 * - 按模型：models[]（调用次数 + input/output + 缓存命中/写入）
 * - 按 agent/任务：agents[]（agentId 维度调用与 token，任务完成数）
 * - 按工具：tools[]（调用次数 + 失败数 + 归并的 input/output token）
 * - 按小时时序：hourly[]（每小时调用与 token，用于时序展示）
 * - 缓存明细：cacheReadTokens（命中缓存）/ cacheWriteTokens（写入缓存），
 *   未命中缓存 = inputTokens - cacheReadTokens - cacheWriteTokens
 *
 * 「按 Provider」的键是 `ProviderConfig.id`（**实例路由键**，如 `hy3` / `anthropic-2`），
 * 不是 provider 类型（`anthropic`/`openai`）。理由：成本归因的轴是**端点** —— 同一类型挂
 * 两个 key 就是两份账单，按类型分会让它们合成一行，账就对不上。这也与 `core.llm.usage`
 * 事件、`ProviderInstanceInfo.id` 用同一套词汇，不需要在展示层再做一次映射。
 *
 * 分区键是**全覆盖**的（每一次调用都恰好落进一个分组），因此缺省值有语义：
 * - `'default'`：调用方未显式指定端点 ⇒ 走默认 Provider（`_prepareQueryOnce` 的哨兵值）；
 * - `'unknown'`：历史消息里根本没有 `providerId` 字段（本维度引入之前落盘的会话）。
 * 两者刻意不合并 —— 前者是「确定走了默认端点」，后者是「不知道走的哪个」。
 */

/** 一次 LLM 调用的记录参数 */
export interface CallRecord {
  model?: string
  /**
   * Provider 实例路由键（`ProviderConfig.id`，如 `hy3` / `anthropic-2`）。
   * 缺省归 `'unknown'` —— 但注意：真正走默认 Provider 的调用**不该**走缺省，
   * 应由调用方显式传 `'default'`（core 就是这么写的），否则两种情形会被混成一组。
   */
  provider?: string
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

/** 单 Provider 实例统计（键 = ProviderConfig.id 实例路由键；`'default'` / `'unknown'` 见包注释） */
export interface ProviderUsage {
  provider: string
  calls: number
  inputTokens: number
  outputTokens: number
  /** 命中缓存 token */
  cacheRead: number
  /** 写入缓存 token */
  cacheWrite: number
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
  /** 按 Provider 实例路由键（与 models 同为「调用的划分」，粒度更粗） */
  providers: ProviderUsage[]
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
    providers: [],
    models: [],
    tools: [],
    agents: [],
    hourly: [],
  }
}

/**
 * 读边界归一：补齐历史记录里**缺失的维度数组**，返回可直接参与运算的累积器。
 *
 * 为什么必须有：`providers` 是本维度引入后才写进落盘记录的字段，此前会话的
 * `meta.usageStats` 里没有它。而下游是**直接迭代**这些数组的
 * （`[...usage.providers]` / `mergeUsage`），缺失即 `undefined` ⇒ 展开就抛
 * `TypeError: undefined is not iterable`，而且抛点在 `accumulateUsage` 的
 * try/catch 里 ⇒ 症状是"用量静默不增长"，不是崩溃，极难定位。
 *
 * 口径选择：**读边界补齐，不写迁移脚本、不升版本号**。旧会话读出来 `providers: []`，
 * 新调用逐条追加即可（渐进填充）；历史调用不回填（当时的端点信息已不可考，
 * 编一个出来就是假数据）。`models/tools/agents/hourly` 一并防御 —— 同一个反序列化
 * 边界，没理由只保一个字段。
 */
export function normalizeUsage(u: UsageStats | undefined): UsageStats {
  if (!u) return emptyUsage()
  return {
    ...u,
    providers: u.providers ?? [],
    models: u.models ?? [],
    tools: u.tools ?? [],
    agents: u.agents ?? [],
    hourly: u.hourly ?? [],
  }
}

/** 记录一次 LLM 调用（含用量与缓存明细），并按 provider / 模型 / agent / 小时维度归并 */
export function recordCall(usage: UsageStats, rec: CallRecord = {}): UsageStats {
  const m = rec.model || 'unknown'
  const prov = rec.provider || 'unknown'
  const agentId = rec.model ? (rec.agentId || 'root') : 'root'
  const i = rec.input ?? 0
  const o = rec.output ?? 0
  const cr = rec.cacheRead ?? 0
  const cw = rec.cacheWrite ?? 0
  const ts = rec.ts ?? Date.now()

  // 按 Provider 实例归并（粒度最粗，放在最前 —— 与展示顺序一致）
  let providers = usage.providers ?? []
  const pIdx = providers.findIndex((x) => x.provider === prov)
  if (pIdx === -1) {
    providers = [...providers, { provider: prov, calls: 1, inputTokens: i, outputTokens: o, cacheRead: cr, cacheWrite: cw }]
  } else {
    const cur = providers[pIdx]
    providers = [
      ...providers.slice(0, pIdx),
      {
        ...cur,
        calls: cur.calls + 1,
        inputTokens: cur.inputTokens + i,
        outputTokens: cur.outputTokens + o,
        cacheRead: cur.cacheRead + cr,
        cacheWrite: cur.cacheWrite + cw,
      },
      ...providers.slice(pIdx + 1),
    ]
  }

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
    providers,
    models,
    tools: usage.tools,
    agents,
    hourly,
  }
}

/**
 * 记录一次工具/技能调用；可归并本轮紧随 LLM 请求的 token 用量。
 *
 * 口径（真机修复）：**任何一次调用都计入 `count`，失败再额外计入 `errors`**。
 * 早先的写法是 `count: isError ? 0 : 1` —— 只失败过的工具会呈现「调用 0 次 / 错误 1 次」
 * 这种自相矛盾的数（真机会话 s_1789916436883_ra6w1 的 `team_status` 即如此），
 * 用户看 /stats 无法解释。token 归因仍只在成功时累加（失败没有真实产出）。
 */
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
        count: 1,
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
        count: cur.count + 1,
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

/** 缓存命中率（0~100，一位小数）；无输入时为 0 */
export function cacheHitRate(u: UsageStats): number {
  // 非法输入一律归 0，**绝不让 NaN 漏到 UI**。
  //
  // 为什么不能只写 `if (u.inputTokens <= 0)`：`NaN <= 0` 是 **false**，挡不住任何 NaN ——
  // 分子（cacheReadTokens）为 NaN 时会算出 NaN，而两个消费方都是直接插值的
  // （`renderStatsText` 的「缓存：命中 N（X%）」与 CLI 的 run 摘要），
  // 用户看到的就是「命中 NaN%」。非有限值与负值同样按 0 处理。
  const { inputTokens, cacheReadTokens } = u
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return 0
  if (!Number.isFinite(cacheReadTokens) || cacheReadTokens <= 0) return 0
  return Math.round((cacheReadTokens / inputTokens) * 1000) / 10
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
 * providers / models / tools / agents 无法按天切分，一律置空
 * （hourly 保留当日桶，便于时序展示）。
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
    providers: [],
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
  // 归一：任意一侧可能是**旧落盘记录**（没有 providers 等新字段）。
  // 本函数是跨会话聚合（sumUsage / 当日归集 / 子 agent rollup）的收敛点，
  // 在这里补一次比在每个调用方补一次可靠。
  a = normalizeUsage(a)
  b = normalizeUsage(b)

  const providers = [...a.providers]
  for (const p of b.providers) {
    const i = providers.findIndex((x) => x.provider === p.provider)
    if (i === -1) providers.push({ ...p })
    else {
      const c = providers[i]
      providers[i] = {
        ...c,
        calls: c.calls + p.calls,
        inputTokens: c.inputTokens + p.inputTokens,
        outputTokens: c.outputTokens + p.outputTokens,
        cacheRead: c.cacheRead + p.cacheRead,
        cacheWrite: c.cacheWrite + p.cacheWrite,
      }
    }
  }

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
    providers,
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

/** 单 Provider 统计行：`provider ×calls · inN(⚡cr)outN`（与 modelUsageRow 同形，便于对照阅读） */
export function providerUsageRow(p: ProviderUsage): string {
  const cache = p.cacheRead > 0 || p.cacheWrite > 0 ? `⚡${p.cacheRead}/w${p.cacheWrite} ` : ''
  return `${p.provider} ×${p.calls} · ${cache}in${p.inputTokens}/out${p.outputTokens}`
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

/**
 * 从 Session.meta 读取已持久化的用量统计（无则返回 undefined）。
 *
 * **本函数是落盘记录的唯一反序列化入口**，因此归一（补齐缺失维度数组）放在这里 ——
 * 见 {@link normalizeUsage}：旧记录没有 `providers`，下游直接展开就会抛。
 */
export function usageFromMeta(meta: Record<string, unknown> | undefined): UsageStats | undefined {
  const v = meta?.[USAGE_STATS_KEY]
  if (!v || typeof v !== 'object') return undefined
  return normalizeUsage(v as UsageStats)
}

/** 折叠过程的跨消息状态：`pending` = 最近一次 LLM 用量，`attributed` = 是否已归并到工具 */
export interface UsageFoldState {
  /** 最近一次 LLM 调用的 input/output（等待归并到紧随其后的**首个**工具） */
  pending: { input: number; output: number } | null
  /** pending 是否已被某个工具消费（同一轮只归并一次） */
  attributed: boolean
}

/** 空折叠状态 */
export function emptyFoldState(): UsageFoldState {
  return { pending: null, attributed: false }
}

/** `foldMessage` 能消费的最小消息形状（避免包依赖 @harness/session 的 Message） */
export interface UsageMessageLike {
  meta?: Record<string, unknown>
  createdAt?: number
  /** 归属 agent（引擎写在消息上）；缺省按 'root' 归并 */
  agentId?: string
  parts?: Array<{ type: string; toolId?: string; isError?: boolean }>
}

/**
 * 把**一条**消息折叠进累积器，并就地更新 `state`。
 *
 * 与 {@link usageFromMessages} 是同一套规则的两个入口 —— 后者就是逐条调用本函数。
 * 这个约束很重要：引擎的「增量折叠」与「全量自愈重建」必须给出**完全相同**的结果，
 * 否则自愈那一刻会把数字改掉（而自愈的触发条件恰恰是"消息被外部改过"，
 * 两个口径一旦分叉，用户看到的就是用量莫名其妙跳变）。
 */
export function foldMessage(u: UsageStats, m: UsageMessageLike, state: UsageFoldState): UsageStats {
  const meta = m.meta as { model?: string; providerId?: string; tokenUsage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } | undefined
  if (meta?.tokenUsage) {
    const tu = meta.tokenUsage
    u = recordCall(u, {
      model: meta.model,
      // Provider 维度：与 model 同源（都从 assistant 消息的 meta 上取）。
      // **必须**从消息取而不是从事件流取，理由同下面的 agentId：引擎的「增量折叠」与
      // 「全量自愈重建」是同一套规则的两个入口（rebuildUsage 就是逐条调用本函数），
      // 从事件流取会让自愈那一刻把 provider 维度整个丢掉。
      // meta 里没有该字段（本维度引入前落盘的旧会话）⇒ 归 'unknown'，不编造端点。
      provider: meta.providerId,
      // agent 维度：宿主此前是从事件流里取 agentId 归并的，引擎侧改从消息上取
      // （core 会把当前 agentId 写在 assistant 消息上），这样重建与增量同口径。
      agentId: m.agentId,
      input: tu.input,
      output: tu.output,
      cacheRead: tu.cacheRead,
      cacheWrite: tu.cacheWrite,
      ts: typeof m.createdAt === 'number' ? m.createdAt : undefined,
    })
    state.pending = { input: tu.input ?? 0, output: tu.output ?? 0 }
    state.attributed = false
  }
  for (const p of m.parts ?? []) {
    if (p.type === 'tool' && p.toolId) {
      u = recordTool(u, p.toolId, {
        isError: p.isError,
        input: !state.attributed ? state.pending?.input : undefined,
        output: !state.attributed ? state.pending?.output : undefined,
      })
      if (!state.attributed) state.attributed = true
      // 「一次 agent 任务」：subagent 工具成功完成 = 一个子任务结束（对齐 TUI 的
      // `tool === 'subagent' && !isError ⇒ recordTaskDone`，否则 /stats 的按 agent 一栏
      // 会在引擎接管后丢掉 tasksDone）。
      if (p.toolId === 'subagent' && p.isError !== true) u = recordTaskDone(u, m.agentId)
    }
  }
  return u
}

/**
 * 全量重建：同时返回累积器**与**折叠状态。
 * 引擎自愈时两者都要 —— 只重建累积器而丢掉状态，会让后续增量折叠的工具归因错位
 * （pending 丢失 ⇒ 下一个工具的 token 归并落到错误的步上）。
 */
export function rebuildUsage(messages: readonly UsageMessageLike[]): { usage: UsageStats; state: UsageFoldState } {
  const state = emptyFoldState()
  let usage = emptyUsage()
  for (const m of messages) usage = foldMessage(usage, m, state)
  return { usage, state }
}

/**
 * 由消息列表重建用量统计（用于 REPL/已恢复会话等未走 TuiApp onEvent 的场景）。
 * 逐条取 message.meta[{ model, tokenUsage }] 累加为 LLM 调用；工具调用无法反推
 * 但会按 tool part 依次记录 toolId（含 isError）。纯函数、可单测。
 *
 * 时间归属：按消息自身的 `createdAt` 归并小时桶（缺失才回落当前时间），
 * 否则历史消息会被全部算到「今天」，导致当天用量虚高。
 */
export function usageFromMessages(messages: readonly UsageMessageLike[]): UsageStats {
  return rebuildUsage(messages).usage
}

/** 详细统计文本报告（/stats 命令输出，纯文本） */
export function renderStatsText(u: UsageStats): string {
  const lines: string[] = []
  lines.push(`LLM 调用 ${u.llmCalls} 次 · in ${u.inputTokens} / out ${u.outputTokens}`)
  if (u.cacheReadTokens > 0 || u.cacheWriteTokens > 0) {
    lines.push(`缓存：命中 ${u.cacheReadTokens}（${cacheHitRate(u)}%），写入 ${u.cacheWriteTokens}，未命中 ${uncachedInput(u)}`)
  }
  // Provider 在模型**之前**：读统计是自顶向下"先看在哪个端点、再看哪个模型"，
  // 且 provider 是更粗的划分（一个 provider 常含多个模型），粗→细才不会来回跳。
  if (u.providers.length) {
    lines.push('按 Provider：')
    for (const p of u.providers) lines.push(`  ${providerUsageRow(p)}`)
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
    providers: u.providers,
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
  if (u.providers.length) {
    section('按 Provider', ['Provider', '调用', '输入', '输出', '缓存命中', '缓存写入'],
      u.providers.map((p) => [p.provider, String(p.calls), String(p.inputTokens), String(p.outputTokens), String(p.cacheRead), String(p.cacheWrite)]))
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

// ========================================================================
// 统计页装配（/stats 与 harness/stats.get 共用）
//
// 自 @harness/cli 上移（P2-v1，2026-10-02）：sidecar（@harness/a2a-server）要实现
// `harness/stats.get`，而它不能反向依赖 CLI —— 这批函数当时住在 cli/src/index.ts，
// 成了 /stats 进控制面的唯一阻塞（设计稿 §6.3 订正框）。上移后 CLI 与 sidecar
// 共用同一份实现（设计稿 §11「两套界面文案漂移」的对策）。
//
// 依赖纪律：全部走**结构化最小接口**（真实 Harness / Session 均结构性满足），
// 本包不新增对 @harness/core / @harness/session 的依赖，保持零依赖。
// ========================================================================

/** 统计页函数所需的**最小会话视图**（Session / 落盘会话文件均结构性满足） */
export interface StatsSessionLike {
  id: string
  agentId?: string
  meta?: Record<string, unknown>
  messages?: Array<{
    meta?: Record<string, unknown>
    createdAt?: number
    parts?: Array<{ type: string; toolId?: string; isError?: boolean }>
  }>
}

/**
 * 统计页函数所需的**最小 harness 视图**。
 *
 * 用**方法语法**（而非属性箭头）声明：TS 对方法参数做双变检查，
 * 真实 `Harness`（参数更具体、可选参数更多）才能结构性赋值过去。
 */
export interface StatsHarnessLike {
  session?: {
    get?(id: string): Promise<StatsSessionLike | undefined>
    estimateTokens?(id: string, calibration?: 'auto' | 'chars4'): Promise<number>
  }
  usage?: {
    children?(id: string): Promise<readonly string[]>
    get?(id: string): Promise<UsageStats>
  }
}

/** {@link renderContextOccupancy} 用到的 CompactOptions 子集（结构化，避免依赖 @harness/session） */
export interface OccupancyCompactOpts {
  contextWindowTokens?: number
  autoCompactThresholdPct?: number
  reservedTokens?: number
  tokenCalibration?: 'auto' | 'chars4'
}

/**
 * 解析当前会话用量统计：meta 持久化的累积器（有数据时）优先 → 否则由消息历史重建。
 * 与 TUI 共用 `hydrateUsage`，保证重连（resume）后能读到重连前累计的用量，
 * 且不会被「空累积器」误判为无数据。
 */
export async function resolveCurrentUsage(
  harness: StatsHarnessLike,
  current: StatsSessionLike,
): Promise<UsageStats> {
  const hydrated = hydrateUsage(current)
  if (!isBlankUsage(hydrated)) return hydrated
  // 内存态可能是不完整视图（分页/裁剪/仅近期消息），只要水合结果为空就回源再试一次。
  // 注意：不能按 current.messages.length 判断——消息非空也可能全是未带 tokenUsage 的
  // 消息，此时若不回源，磁盘上的历史用量就永远读不到（/stats 与导出均显示 0）。
  const sess = (await harness.session?.get?.(current.id).catch(() => undefined)) ?? undefined
  if (sess && sess !== current) {
    const rebuilt = hydrateUsage(sess)
    if (!isBlankUsage(rebuilt)) return rebuilt
  }
  return hydrated
}

/**
 * 「含子 agent」聚合行（子 agent 用量归一：父会话面板此前完全看不到这部分）。
 *
 * 为什么在**展示层**聚合，而不是把子会话并进父会话的 `meta.usageStats`：子会话有自己的
 * meta 与生命周期（可能被别的入口再次打开），并进去会让同一条链在"全部会话·当日"里被
 * 重复计入；展示层聚合随时可算、可撤。引擎侧已提供 `usage.children()`（按 `meta.parentId`
 * 反查），这里只做求和与排版。
 */
export async function renderChildAgentRollup(harness: StatsHarnessLike, sessionId: string): Promise<string> {
  const usageApi = harness.usage
  if (!usageApi?.children || !usageApi.get) return ''
  const ids = await usageApi.children(sessionId).catch(() => [] as string[])
  if (ids.length === 0) return ''
  const usages: UsageStats[] = []
  for (const id of ids) usages.push(await usageApi.get(id).catch(() => emptyUsage()))
  const sum = sumUsage(usages)
  return (
    `含子 agent：${ids.length} 个子会话 · 调用 ${sum.llmCalls} 次 · ` +
    `in ${sum.inputTokens} / out ${sum.outputTokens}` +
    (sum.cacheReadTokens > 0 ? `（缓存命中 ${sum.cacheReadTokens}）` : '') +
    '\n'
  )
}

/**
 * 统计页上下文占用区：本会话 + 各子会话的上下文占用率。
 *
 * - 窗口 / 阈值 / 保留 / 口径一律取 `/compact` 同一套推导（`buildCompactionOptions`），
 *   避免同一份 config 又算出两个窗口（历史教训：三处各算一次 ⇒ 阈值判据失效）；
 * - 占用 token 用 `session.estimateTokens`（与会话压缩同口径，含 CJK 感知）；
 * - 子会话占用逐行列出，且**分母各自解析**（见 resolveWindow）—— 子 Agent 常被派到
 *   另一个窗口的端点上，沿用父会话的分母会让小窗口子会话的占用率虚低（"报 40% 其实已满"）。
 */
export async function renderContextOccupancy(
  harness: StatsHarnessLike,
  session: StatsSessionLike,
  compactOpts: OccupancyCompactOpts,
  /**
   * 「会话 → 该会话**实际**该用的窗口」，走调用方注入的 `resolveCompactionWindow`。
   * 不传 = 全部用 `compactOpts.contextWindowTokens`（= 改造前行为）：拿不到 config / Provider
   * 注册表的宿主（如测试替身）走这条路，行为不变。
   */
  resolveWindow?: (session: StatsSessionLike | undefined) => number,
): Promise<string> {
  const reserved = compactOpts.reservedTokens ?? 30_000
  const pct = compactOpts.autoCompactThresholdPct ?? 80
  const calibration = compactOpts.tokenCalibration
  const pctOf = (n: number, w: number) => (w > 0 ? (n / w) * 100 : 0).toFixed(1)
  /**
   * 回源取最新一份会话：调用方（尤其 TUI）手里那个对象可能是**调用时的快照**，
   * 而 `/model` 切过后窗口就变了。取不到（测试替身没有 session.get / 会话已删）就用手上这份。
   */
  const liveSession = async (fallback: StatsSessionLike | undefined, id: string): Promise<StatsSessionLike | undefined> => {
    const get = harness.session?.get
    if (!get) return fallback
    try { return (await get.call(harness.session, id)) ?? fallback } catch { return fallback }
  }
  const window = resolveWindow
    ? resolveWindow(await liveSession(session, session.id))
    : (compactOpts.contextWindowTokens ?? 200_000)
  const threshold = Math.floor((window - reserved) * (pct / 100))

  const est = (await harness.session?.estimateTokens?.(session.id, calibration).catch(() => 0)) ?? 0
  const lines = [
    `上下文占用：${est.toLocaleString()} / ${window.toLocaleString()} tokens（${pctOf(est, window)}%）` +
      ` · 自动压缩阈值 ${threshold.toLocaleString()}（${pct}% ×（窗口−保留 ${reserved.toLocaleString()}））`,
  ]
  // 子 agent 上下文：每个子会话单独一行（分母按该子会话自身端点解析 —— 解析不出才回落父会话的窗口；
  // 子会话量小则不可见 —— 有值才列）
  const usageApi = harness.usage
  if (usageApi?.children) {
    const ids = await usageApi.children(session.id).catch(() => [] as string[])
    for (const id of ids) {
      const childEst = (await harness.session?.estimateTokens?.(id, calibration).catch(() => 0)) ?? 0
      if (childEst <= 0) continue
      const childWindow = resolveWindow ? resolveWindow(await liveSession(undefined, id)) : window
      lines.push(
        `  子会话 ${id}：占用 ${childEst.toLocaleString()} / ${childWindow.toLocaleString()} tokens（${pctOf(childEst, childWindow)}%）`,
      )
    }
  }
  return lines.join('\n') + '\n'
}

// ---- 当日（跨会话）用量归集 ------------------------------------------------
// 自 @harness/cli 的 usage-today.ts 上移（P2-v1）：collectTodayUsage 只依赖本包的
// 纯函数 + 两个结构化最小接口，本身无包依赖，没理由留在 CLI。

/** 归集所需的最小会话存储接口（结构化约束，避免与调用方的 App 类型耦合） */
export interface UsageStoreLike {
  list(): Promise<Array<{ id: string; updatedAt?: number }>>
  load(id: string): Promise<unknown | undefined>
}

/** 归集所需的最小会话视图（Session / 磁盘会话文件均满足） */
export interface UsageSessionLike {
  id: string
  meta?: Record<string, unknown>
  messages?: Array<{
    meta?: Record<string, unknown>
    createdAt?: number
    parts?: Array<{ type: string; toolId?: string; isError?: boolean }>
  }>
}

/**
 * 归集当日（本地时区）跨会话用量。
 *
 * - 只读持久化文件、不写回，因此重连（resume）前当天产生的用量依然可归集；
 * - 按会话 updatedAt 过滤当天有更新的会话，避免全量加载历史会话；
 * - 当前会话无条件参与归集（可能 updatedAt 早于今天零点但仍有当日用量）；
 * - 任一步失败都回落到「仅当前会话」的当日用量，绝不阻塞主流程。
 *
 * @param store 会话存储；缺省时退化为仅统计 current
 * @param current 当前会话（内存态优先，避免重复读盘）
 * @param now 时间基准（便于测试）
 */
export async function collectTodayUsage(
  store: UsageStoreLike | undefined,
  current: UsageSessionLike | undefined,
  now: number = Date.now(),
): Promise<UsageStats> {
  if (!current) return emptyUsage()
  const from = dayStart(now)
  try {
    if (store) {
      const list = await store.list()
      // 只加载当天有更新的会话
      const ids = list.filter((s) => (s.updatedAt ?? 0) >= from).map((s) => s.id)
      // 当前会话无条件纳入：新建会话可能尚未落盘，此时 list() 里没有它，
      // 若只按 list 归集会漏掉当前会话的当日用量（TUI 侧栏「今日」不增长）。
      if (!ids.includes(current.id)) ids.unshift(current.id)
      const files = await Promise.all(
        ids.map((id) =>
          id === current.id ? Promise.resolve<unknown>(current) : store.load(id).catch(() => undefined),
        ),
      )
      const per = files.map((f) => (f ? todayUsage(hydrateUsage(f as UsageSessionLike), now) : emptyUsage()))
      const merged = sumUsage(per)
      if (!isBlankUsage(merged)) return merged
    }
  } catch {
    // 归集失败回落当前会话
  }
  return todayUsage(hydrateUsage(current), now)
}
