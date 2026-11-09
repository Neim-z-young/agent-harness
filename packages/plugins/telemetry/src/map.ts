/**
 * bus 事件 → 遥测 envelope 转换。
 *
 * 通用策略：任何 bus 事件都映射为一条 `telemetry.bus.<name>`，数值字段 → metrics、
 * 低基数字段 → attrs，并尝试提取 sessionId/agentId。这样采集不依赖枚举，新事件自动入明细。
 * 几个特殊事件（错误/生命周期）落到更语义化的 kind，便于异常检索。
 */

import type { BusEventRecord } from '@harness/bus'
import {
  makeEnvelope,
  pickMetrics,
  pickAttrs,
  extractIdentity,
  isRecord,
  asFiniteNumber,
  type TelemetryAttrs,
  type TelemetryEnvelope,
} from './envelope.js'

/**
 * 需要单独语义化 kind 的特殊事件（其余走 telemetry.bus.<name>）。
 *
 * 判据不是「重要与否」，而是**它是错误状态还是正常事实**：正常事实（注册 / 反注册 /
 * 默认变更）落通用 kind 就够，它们本就该按时间线读；错误状态必须能被独立检索，
 * 否则会被同类正常事实淹没。
 */
const SEMANTIC_KINDS: Record<string, string> = {
  'harness.error': 'telemetry.error',
  // `provider.resolveMiss`：「配置指向了一个不存在的 Provider 实例」——
  // 它是**错误状态**而不是注册事实：模型请求会**悄悄换一个 Provider 去发**，
  // 表面上完全正常。落 `telemetry.bus.provider.resolveMiss` 的话，与
  // registered / defaultChanged 这些每次都发生的正常事实挤在一起，检索时拉不出来。
  'provider.resolveMiss': 'telemetry.provider.resolveMiss',
}

/** 只在有限数值时落指标（0 也是有效值，故判据是"能取到数"而不是"非零"） */
function setMetric(target: Record<string, number>, key: string, v: unknown): void {
  const n = asFiniteNumber(v)
  if (n !== undefined) target[key] = n
}

/** 从任何 signal 形态里取会话归属（4 个 envelope 共用一套口径） */
function identityAttrs(s: { sessionId?: string; agentId?: string }): TelemetryAttrs {
  return { sessionId: s.sessionId, agentId: s.agentId }
}

/**
 * 把一条 bus 事件转成遥测 envelope。
 *
 * 恒返回 envelope（没有"该事件不落盘"的分支）：脱敏发生在提取层（只收标量与低基数标签），
 * 不在这里丢整条 —— 丢整条会让"某类事件完全不在遥测里"变成沉默的默认行为。
 */
export function mapBusEvent(ev: BusEventRecord): TelemetryEnvelope {
  const kind = SEMANTIC_KINDS[ev.name] ?? `telemetry.bus.${ev.name}`
  const identity = extractIdentity(ev.payload)
  const attrs = {
    ...pickAttrs(ev.payload),
    ...semanticAttrs(ev.name, ev.payload),
    source: ev.source,
    sessionId: identity.sessionId,
    agentId: identity.agentId,
    round: pickRound(ev.payload),
  }
  return makeEnvelope(kind, attrs, pickMetrics(ev.payload), ev.timestamp)
}

/**
 * 语义化事件的专项 attrs：把载荷里的近义键提到 `TelemetryAttrs` 的**标准维度**上。
 *
 * 为什么值得多这一步：标准键（`provider`）才能与其它事件的同一维度一起 group by；
 * 载荷原名一律保留（`pickAttrs` 已落），所以这步只做**加**、不做改名。
 */
function semanticAttrs(name: string, payload: unknown): TelemetryAttrs {
  if (name !== 'provider.resolveMiss' || !isRecord(payload)) return {}
  const v = payload['requested']
  // provider 维度 = 「哪个实例没命中」，这也是消费方唯一想聚合的那个问题
  return typeof v === 'string' && v.length > 0 ? { provider: v } : {}
}

/** `round` 是**步号/轮号**这类结构性字段 ⇒ 只认真正的有限数值，不折布尔 */
function pickRound(payload: unknown): number | undefined {
  return isRecord(payload) ? asFiniteNumber(payload['round']) : undefined
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
  if (!isRecord(signal)) return null
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
  // `freeSteps` 为 0 时不落（省无用字段）；`billedSteps` 是派生的额度口径，与 step 同生同灭
  const free = asFiniteNumber(s.freeSteps) ?? 0
  if (free > 0) metrics.freeSteps = free
  const step = asFiniteNumber(s.step)
  if (step !== undefined) {
    metrics.step = step
    metrics.billedSteps = step - free
  }
  // 空步数（有值才落）：「模型连续零产出」与「请求层整轮没跑起来」的区分依据
  const emptySteps = asFiniteNumber(s.emptySteps)
  if (emptySteps !== undefined && emptySteps > 0) metrics.emptySteps = emptySteps
  // 只在真的中断时记一位（缺省即 0，不落无用字段）
  if (s.aborted === true) metrics.aborted = 1
  return makeEnvelope(
    'telemetry.turn.end',
    {
      ...identityAttrs(s),
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
  if (!isRecord(signal)) return null
  const s = signal as { toolId?: string; sessionId?: string; agentId?: string; step?: number; missingCount?: number }
  if (!s.toolId) return null
  const metrics: Record<string, number> = {}
  setMetric(metrics, 'step', s.step)
  setMetric(metrics, 'missingCount', s.missingCount)
  return makeEnvelope('telemetry.tool.params.missing', { ...identityAttrs(s), toolId: s.toolId }, metrics)
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
  if (!isRecord(signal)) return null
  const s = signal as { sessionId?: string; agentId?: string; step?: number; hasTokenUsage?: boolean; aborted?: boolean }
  const metrics: Record<string, number> = {}
  setMetric(metrics, 'step', s.step)
  metrics.hasTokenUsage = s.hasTokenUsage === true ? 1 : 0
  metrics.aborted = s.aborted === true ? 1 : 0
  return makeEnvelope('telemetry.step.empty', identityAttrs(s), metrics)
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
  if (!isRecord(signal)) return null
  const s = signal as { toolId?: string; sessionId?: string; agentId?: string; step?: number }
  if (!s.toolId) return null
  const metrics: Record<string, number> = {}
  setMetric(metrics, 'step', s.step)
  return makeEnvelope('telemetry.tool.whitelist.blocked', { ...identityAttrs(s), toolId: s.toolId }, metrics)
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
  setMetric(metrics, 'durationMs', r.meta?.durationMs)
  return makeEnvelope(
    kind,
    { ...identityAttrs(h?.ctx ?? {}), toolId, errName },
    metrics,
  )
}