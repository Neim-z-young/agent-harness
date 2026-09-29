/**
 * ACP 运行时遥测：独立 JSONL 文件，记录压缩参数 × 压缩效果 × 缓存命中。
 *
 * 事件类型（都带 ts/round/sessionId）：
 *   - preModel     每轮进入模型前（ACP 侧压缩指标 + ACP 侧缓存命中 + 配置快照）
 *   - compress     模型主动调用 compress 工具
 *   - providerCache 模型返回后 provider 侧 cacheRead/cacheWrite（由 core 层追加）
 *
 * 写入：append JSONL，debounce flush；文件路径由宿主（core/cli）通过 deps.telemetryPath 注入。
 * 本模块只采集 + 写入，不关心文件存放规则。
 *
 * token 估算口径跟随插件配置（`tokenCalibration`）：默认 `auto` = acp-kernel 的 CJK 感知
 * `defaultCountTokens`（中日韩 1 token/字、其余 4 字符/token），`chars4` 为旧口径。
 * 遥测的 `rawTok` / `requestTok` / `occupancy` 因此与内核决策口径一致。
 */

import { defaultCountTokens, type Config, type CoreMessage, type CompressionState, type TokenCountFn } from 'acp-kernel'
import { createJsonlWriter, type JsonlWriter } from '@harness/telemetry'
import { estimateTokens } from './adapter.js'

// ===== 配置快照：每轮 preModel 都记，便于事后还原"参数 × 指标"关系 =====
export interface TelemetryParamSnapshot {
  preserveRecentTokens: number
  preserveRecentMessages: number
  promotionThreshold: number
  tier2Trigger: number
  tier3Trigger: number
  maxContextLimitPct: number
  minContextLimitPct: number
  emergencyThresholdPct: number
  minSummaryLength: number
  maxSummaryLength: number
  minCompressRange: number
}

// ===== 事件：preModel（每轮）=====
export interface PreModelEvent {
  kind: 'preModel'
  ts: number
  sessionId: string
  round: number
  window: number
  params: TelemetryParamSnapshot
  // —— ACP 侧压缩指标（与 bench 脚本口径一致）
  rawTok: number          // 压平后未压缩 token
  requestTok: number      // 发往模型 token
  occupancy: number        // requestTok / window
  compressRatio: number   // rawTok / requestTok
  retention: number       // requestTok / rawTok
  // —— ACP 侧缓存命中（相邻两轮投影请求的同前缀 token 占比；首轮为 null）
  acpCacheHit: number | null
  // —— 块分布
  blocks: { t1: number; t2: number; t3: number }
  // —— 压缩触发
  suggestedRanges: number          // nudge.compressibleRanges 长度
  emergencyCompressed: boolean     // processTurn 是否内部紧急折叠
}

// ===== 事件：compress 工具（模型主动调用时）=====
export interface CompressEvent {
  kind: 'compress'
  ts: number
  sessionId: string
  round: number
  window: number
  ranges: { topic?: string; chars: number }[]
  createdBlocks: number
  tokensCompressed: number
  /**
   * 本次压缩**零收益**（`createdBlocks === 0`）—— 白烧了一次模型调用。
   *
   * 为什么单独标一位而不是"看 createdBlocks 是否 0"：`createdBlocks` 为 0 也可能是
   * 正常的幂等复用（该窗口已被既有块覆盖）。`zeroYield` 只在"模型真的调了 compress、
   * 内核也确实跑了 applyCompression、结果一个块都没建"时为 true —— 这才是可优化的浪费。
   */
  zeroYield?: boolean
  blocksAfter: { t1: number; t2: number; t3: number }
}

// ===== 事件：provider 侧缓存命中（模型返回后，由 core 层追加）=====
export interface ProviderCacheEvent {
  kind: 'providerCache'
  ts: number
  sessionId: string
  round: number
  /**
   * 本轮实际命中的 Provider 实例 id（= `ProviderConfig.id`；引擎未给时为 null）。
   *
   * 为什么这行必须能指认端点：`model` 名在「同一模型挂多个端点」下是**重复**的
   * （`ProviderConfig` 注释明确支持这个场景），只按模型看这行分不出走的是哪个 key/端点 ⇒
   * 多实例启用后「哪条端点的缓存掉了」无从归因。null 而不是 undefined：与本节其它
   * 可空字段同形（JSON 里 null 与"字段不存在"是两种意思，这里要的是前者）。
   */
  providerId: string | null
  cacheRead: number      // 命中缓存的输入 token
  cacheWrite: number     // 写入缓存（未命中但计入）的输入 token
  requestTok: number     // 本轮发往模型的 token（preModel 估算值，用于计算 provider 侧命中率）
  // —— 缓存回退归因（见 CacheMissReason；`cacheMissReason` 直接回答「这轮为什么掉」）
  cacheDropTokens: number
  /** 距上一轮**本会话**请求的空闲毫秒数（首轮为 null）。与 `idle-expiry` 交叉验证 */
  idleMs: number | null
  cacheMissReason: CacheMissReason
  // —— 前缀稳定性（来自同轮 preModel 事件；未采集到为 null）
  prefixStableMessages: number | null
  prefixChangedKind: PromptPrefixDiff['changedKind'] | null
  /**
   * provider 上报输入 / 本地**整包**估算（system + 工具载荷 + 消息）。
   *
   * 本项目两套口径长期分叉：本地估算（acp-kernel CJK 感知口径）与 provider 实际计费输入
   * 不是同一把尺子。分母刻意用引擎给的 `localInputEstimate` 而**不是** `requestTok`：
   * 后者只算历史 cores，拿它当分母量到的是"漏算 system/工具固定开销"，不是 tokenizer 差异
   * （真机首轮比值虚高到 415×，见 `overheadTok`）。
   */
  calibration: number | null
  /**
   * 整包估算 − 历史估算 = **每轮都要重发的固定开销**（system 提示 + 工具载荷）。
   *
   * 真机取证：默认 agent 下 body ≈ 18.7KB，其中 system 仅 187 字符 ⇒ 绝大部分是工具载荷。
   * ACP 的 occupancy 只算历史消息、不含这一项 ⇒ 阈值判断系统性偏保守。
   */
  overheadTok: number | null
  /**
   * 本轮相对上一轮 query **实际变化的 system 段下标**（引擎侧段级归因）。
   *
   * `null` = 引擎未给出（首轮无基线 / 未接线宿主）。有值时 `cacheMissReason` 必然是
   * `system-changed` —— 本字段就是它的"点名片"：system 区是多插件往同一数组 push 拼出来的
   * （agent promptFragments / 压缩记忆 / skill 注入 / subagent roster / MCP resources / memory），
   * 不点名就只能靠猜。
   */
  systemChangedParts: number[] | null
  /** 上项的人读版（每项形如「第 2 段变化：642 → 1 284 字符（原首行：「项目长期记忆」）」） */
  systemChangedDetail: string[] | null
  /**
   * 本轮请求**末尾**由 core 追加的尾部动态块片段数（`null` = 无尾部动态块 / 引擎未提供）。
   *
   * 为什么要有这个字段：`prefixChangedKind` 与 `cacheMissReason` 只看**前缀**，而 core 的
   * 尾部动态区（`core.prompt.dynamic.transform`：MCP resources / memory 提示 / 条件 skill 等）
   * 是在 preModel **之后**才拼上去的 —— ACP 按 `messages` 建归因视图时根本看不见它
   * （core 经 `SessionPreModelInput.dynamicParts` 只把片段本身告知）。
   * 后果：anthropic 显式 promptCache 断点打在最后一条时，末尾那条每轮现拼 ⇒ 最后一段
   * 必然 cache write，而 `cacheMissReason` 仍报 `none`（前缀确实没动）——
   * 本字段就是给这种"读数有写入、归因说无事"提供解释。
   * 自动前缀缓存（OpenAI / DeepSeek 等）不受影响：末尾一条本就在公共前缀之外。
   */
  tailDynamicParts: number | null
  /** 上项的字符数合计（`null` = 无尾部动态块或引擎未提供） */
  tailDynamicChars: number | null
}

export type TelemetryEvent = PreModelEvent | CompressEvent | ProviderCacheEvent

// ===== Helpers =====

/** 从 acp-kernel Config 提取参数快照（供事件记录 + 事后分析） */
export function snapshotParams(cfg: Config): TelemetryParamSnapshot {
  return {
    preserveRecentTokens: cfg.preserveRecentTokens,
    preserveRecentMessages: cfg.preserveRecentMessages,
    promotionThreshold: cfg.promotionThreshold,
    tier2Trigger: cfg.tiers?.enabled !== false ? cfg.tiers?.tier2Trigger ?? 0 : 0,
    tier3Trigger: cfg.tiers?.enabled !== false ? cfg.tiers?.tier3Trigger ?? 0 : 0,
    maxContextLimitPct: cfg.nudge?.maxContextLimitPct ?? 0,
    minContextLimitPct: cfg.nudge?.minContextLimitPct ?? 0,
    emergencyThresholdPct: cfg.nudge?.emergencyThresholdPct ?? 0,
    minSummaryLength: cfg.compress?.minSummaryLength ?? 0,
    maxSummaryLength: cfg.compress?.maxSummaryLength ?? 0,
    minCompressRange: cfg.compress?.minCompressRange ?? 0,
  }
}

/** 取指定 tier 的活跃块数 */
function countTier(state: CompressionState, tier: number): number {
  let n = 0
  for (const b of state.blocks) if (b.active && b.tier === tier) n++
  return n
}

/** 相邻两轮请求的同前缀 token 占比（ACP 侧缓存命中估算） */
export function commonPrefixHit(prev: CoreMessage[] | undefined, curr: CoreMessage[]): number | null {
  if (!prev || prev.length === 0) return null
  let chars = 0
  const max = Math.min(prev.length, curr.length)
  for (let i = 0; i < max; i++) {
    if (prev[i].id !== curr[i].id) break
    chars += (prev[i].text ?? '').length
  }
  const total = Math.max(1, curr.reduce((s, m) => s + (m.text?.length ?? 0), 0))
  return chars / total
}

// ===== 前缀稳定性诊断（回答「缓存为什么掉了」）=====

/**
 * 单条消息的内容指纹。
 *
 * ⚠️ **只取 role + 正文，刻意不含 `id`**：ACP 每轮为 HINT / nudge 生成的临时消息 id 都是新的，
 * 把 id 算进指纹会让"前缀稳定"永远止步于第一条临时消息（指标恒为 0，等于没有）。
 * provider 侧缓存也只看内容字节，与 id 无关。
 *
 * 为什么要指纹而不只比 id：`commonPrefixHit` 只比较 `id`，**同 id 消息内容被就地改写它测不出来**。
 * 而"就地改写"恰恰是本项目最可能的失效源（ACP 折叠/占位符替换会改写早前消息的正文）。
 * 只比 id 会在真实缓存已经塌陷时仍报高命中率 —— 那是**误导性的绿灯**，比没有指标更糟。
 */
function messageDigest(m: { role?: string; text?: string }): string {
  const s = `${m.role ?? ''}\u0000${m.text ?? ''}`
  // djb2 + 长度：够用的非加密指纹，零依赖、够快（每轮只算一遍消息数条）
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${(h >>> 0).toString(36)}:${s.length}`
}

/** 相邻两轮 prompt 的前缀差异（用于定位「缓存为什么没命中」） */
export interface PromptPrefixDiff {
  /** 本轮 prompt 的消息条数 */
  promptMessages: number
  /** 逐条比对内容指纹后，最长公共前缀的消息条数 */
  stableMessages: number
  /** 第一处变化的绝对下标（前缀未动时为 null） */
  changedAt: number | null
  /** 第一处变化处的角色（区分"系统区变了"还是"历史区变了"） */
  changedAtRole: string | null
  /**
   * 变化类型（决定代价大小）：
   * - `none`           逐条一致
   * - `appended`       只是尾部追加 —— 前缀未动，缓存几乎全命中
   * - `tail-rewritten` 只有最后一条被改写（nudge/手册的常规形态）—— 只重算尾部一条
   * - `mutated`        中段某条被就地改写 —— **最致命**，其后全部重算
   * - `shrunk`         prompt 比上轮短（截断/删消息）
   */
  changedKind: 'none' | 'appended' | 'tail-rewritten' | 'mutated' | 'shrunk'
  /** 变化是否落在系统区（前导 system 消息内）—— 系统区一变，整段历史都要重算 */
  systemChanged: boolean
  /** 本轮 prompt 的整体指纹 */
  fingerprint: string
}

/**
 * 计算相邻两轮 prompt 的前缀差异；prev 为空（首轮）时返回 null。
 *
 * ⚠️ 调用方（acp-context）必须在比对前**剔除自己每轮现拼的尾部动态块**（nudge / 压缩手册）：
 * 那块内容不属于缓存前缀，留着会让「历史追加 + 尾部右移」被误判成 `mutated`。
 */
export function diffPromptPrefix(
  prev: readonly { role?: string; text?: string }[] | undefined,
  curr: readonly { role?: string; text?: string }[],
): PromptPrefixDiff | null {
  if (!prev || prev.length === 0) return null
  const prevDigests = prev.map(messageDigest)
  const currDigests = curr.map(messageDigest)

  let stable = 0
  const max = Math.min(prevDigests.length, currDigests.length)
  while (stable < max && prevDigests[stable] === currDigests[stable]) stable++

  // 系统区长度 = 前导 system 消息数
  let systemCount = 0
  while (systemCount < curr.length && curr[systemCount]!.role === 'system') systemCount++

  let changedKind: PromptPrefixDiff['changedKind']
  if (stable === prevDigests.length && stable === currDigests.length) changedKind = 'none'
  else if (stable === prevDigests.length) changedKind = 'appended'
  // 「变短」优先于「改写」：prompt 变短意味着**有消息被删**（压缩/截断 pruned 掉旧消息，
  // 删的通常是中段而不是尾条），此时说"内容被改写"会把真正的原因（少了东西）盖掉。
  // changedAt 仍指向第一处分歧，定位信息不丢。
  else if (curr.length < prev.length) changedKind = 'shrunk'
  else if (stable === curr.length - 1 && curr.length === prev.length) changedKind = 'tail-rewritten'
  else changedKind = 'mutated'

  const prefixIntact = changedKind === 'none' || changedKind === 'appended'
  return {
    promptMessages: curr.length,
    stableMessages: stable,
    changedAt: prefixIntact ? null : stable,
    changedAtRole: prefixIntact ? null : (curr[stable]?.role ?? null),
    changedKind,
    systemChanged: stable < systemCount,
    fingerprint: messageDigest({ role: 'prompt', text: currDigests.join('|') }),
  }
}

/** 缓存未命中的归类（供 providerCache 行直接回答「为什么掉了」） */
export type CacheMissReason =
  | 'first-request'   // 本会话首次请求，无缓存可用
  | 'none'            // 命中量未下降
  | 'system-changed'  // 系统区被改写 ⇒ 其后全部重算（最贵）
  | 'prefix-mutated'  // 历史前缀某条被就地改写
  | 'prefix-shrunk'   // prompt 变短（截断/删消息）
  | 'idle-expiry'     // 前缀没变但命中量掉了 ⇒ 大概率是缓存过期/被逐出（看 idleMs）


// ===== Writer =====

/**
 * 复用 `@harness/telemetry` 的通用 JSONL writer（原自研 createWriter 已上移为通用模块）。
 * debounce 批量 flush、失败静默、无 path=no-op；**保持事件 JSON 结构与现有 bench 脚本兼容**
 * （每行仍是 {kind:'preModel'|'compress'|'providerCache', ...}，不套用统一 envelope）。
 */
export type TelemetryWriter = JsonlWriter<TelemetryEvent>
export const createWriter = createJsonlWriter as (path?: string) => TelemetryWriter

// ===== 事件构造（主流程调用） =====

export interface PreModelBuildInput {
  sessionId: string
  round: number
  config: Config
  state: CompressionState
  prevRequestCores: CoreMessage[] | undefined
  inflatCores: CoreMessage[]     // 压平后、未压缩的 cores
  requestCores: CoreMessage[]    // processTurn 返回、发往模型的 cores
  nudge: { compressibleRanges?: unknown[]; emergencyCompressed?: boolean } | undefined
  /** token 折算口径；缺省 = 内核 CJK 感知口径。应与 `createCore({ countTokens })` 传的一致。 */
  countTokens?: TokenCountFn
}

export function buildPreModelEvent(inp: PreModelBuildInput): PreModelEvent {
  // 必须与 engine（createCore）和 acp_status 用同一个折算函数：缺省时落到内核 CJK 感知口径，
  // 但如果配置了 tokenCalibration: 'chars4' 而此处漏参，遥测就会与决策口径分裂
  // （占用率/rawTok 用另一把尺子，导出报告与 TUI 无法与内核行为互相印证）。
  const rawTok = estimateTokens(inp.inflatCores, inp.countTokens)
  const requestTok = estimateTokens(inp.requestCores, inp.countTokens)
  const acpCacheHit = commonPrefixHit(inp.prevRequestCores, inp.requestCores)
  return {
    kind: 'preModel',
    ts: Date.now(),
    sessionId: inp.sessionId,
    round: inp.round,
    window: inp.config.modelContextLimit,
    params: snapshotParams(inp.config),
    rawTok,
    requestTok,
    occupancy: requestTok / Math.max(1, inp.config.modelContextLimit),
    compressRatio: rawTok / Math.max(1, requestTok),
    retention: requestTok / Math.max(1, rawTok),
    acpCacheHit,
    blocks: {
      t1: countTier(inp.state, 1),
      t2: countTier(inp.state, 2),
      t3: countTier(inp.state, 3),
    },
    suggestedRanges: inp.nudge?.compressibleRanges?.length ?? 0,
    emergencyCompressed: !!inp.nudge?.emergencyCompressed,
  }
}

export interface CompressBuildInput {
  sessionId: string
  round: number
  window: number
  state: CompressionState
  result: { blocksCreated: number; tokensCompressed: number }
  ranges: { topic?: string; chars: number }[]
}

export function buildCompressEvent(inp: CompressBuildInput): CompressEvent {
  return {
    kind: 'compress',
    ts: Date.now(),
    sessionId: inp.sessionId,
    round: inp.round,
    window: inp.window,
    ranges: inp.ranges,
    createdBlocks: inp.result.blocksCreated,
    tokensCompressed: inp.result.tokensCompressed,
    ...(inp.result.blocksCreated === 0 && inp.ranges.length > 0 ? { zeroYield: true } : {}),
    blocksAfter: {
      t1: countTier(inp.state, 1),
      t2: countTier(inp.state, 2),
      t3: countTier(inp.state, 3),
    },
  }
}

export interface ProviderCacheBuildInput {
  sessionId: string
  round: number
  /** 本轮实际命中的 Provider 实例 id（来自 `core.llm.usage` 的 providerId）；引擎未给则 null */
  providerId?: string | undefined
  cacheRead: number | undefined
  cacheWrite: number | undefined
  requestTok: number | undefined
  /** 上一轮本会话的 providerCache 行（用于判断命中量是否下降、以及空闲了多久） */
  prev?: { ts: number; cacheRead: number } | undefined
  /** 本轮的 prompt 前缀差异（来自 preModel 事件）；未采集到时为 null */
  prefix?: PromptPrefixDiff | null
  /** provider 上报的**总输入 token**（= cacheRead + 未命中）。用于校正本地估算口径 */
  providerInput?: number | undefined
  /**
   * 引擎给出的**整包**本地估算（system + 工具载荷 + 消息）。
   *
   * ⚠️ 不能用 `requestTok` 当分母：那个只算历史 cores，不含 system 与工具载荷 ——
   * 真机取证（临时 dataDir 跑 3 轮）首轮比值虚高到 415×，量到的其实是"漏算固定开销"。
   */
  localInputEstimate?: number | undefined
  /** 引擎侧系统区段级归因的「变化段下标」（`null` = 引擎未给；不传按 null 记） */
  systemChangedParts?: number[] | null
  /** 引擎侧系统区段级归因的人读详情 */
  systemChangedDetail?: string[] | null
  /**
   * 本轮 core 追加的尾部动态块片段数（`null`/不传 = 无或引擎未提供）。
   * 见 `ProviderCacheEvent.tailDynamicParts`：用来解释"前缀没动但末尾有 cache write"。
   */
  tailDynamicParts?: number | null
  /** 上项的字符数合计 */
  tailDynamicChars?: number | null
}

export function buildProviderCacheEvent(inp: ProviderCacheBuildInput): ProviderCacheEvent | null {
  if (inp.cacheRead === undefined && inp.cacheWrite === undefined) return null
  const cacheRead = inp.cacheRead ?? 0
  const prev = inp.prev
  const idleMs = prev ? Math.max(0, Date.now() - prev.ts) : null
  const cacheDropTokens = prev && prev.cacheRead > cacheRead ? prev.cacheRead - cacheRead : 0

  // 归类顺序即优先级：系统区改写 > 历史前缀改写 > 变短 > 前缀未变（⇒ 只能是过期/逐出）
  let reason: CacheMissReason
  if (!prev) reason = 'first-request'
  else if (cacheDropTokens === 0) reason = 'none'
  else if (inp.prefix?.systemChanged) reason = 'system-changed'
  else if (inp.prefix?.changedKind === 'mutated') reason = 'prefix-mutated'
  else if (inp.prefix?.changedKind === 'shrunk') reason = 'prefix-shrunk'
  else reason = 'idle-expiry'

  return {
    kind: 'providerCache',
    ts: Date.now(),
    sessionId: inp.sessionId,
    round: inp.round,
    providerId: inp.providerId ?? null,
    cacheRead,
    cacheWrite: inp.cacheWrite ?? 0,
    requestTok: inp.requestTok ?? 0,
    // —— 缓存回退归因（回答「这轮为什么掉」）
    cacheDropTokens,
    idleMs,
    cacheMissReason: reason,
    // 前缀稳定性（0 表示 prompt 顺序/内容在首条就变了）
    prefixStableMessages: inp.prefix?.stableMessages ?? null,
    prefixChangedKind: inp.prefix?.changedKind ?? null,
    // 口径校正：provider 实际输入 / 本地**整包**估算。持续偏离 1 说明本地口径需要校正。
    // 分母必须用整包估算（含 system + 工具），用 requestTok 会把"漏算固定开销"当成 tokenizer 差异。
    calibration: inp.providerInput !== undefined && (inp.localInputEstimate ?? 0) > 0
      ? inp.providerInput / inp.localInputEstimate!
      : null,
    /** 整包估算 − 历史估算 = system + 工具载荷的**固定开销**（每轮都要重发的那部分） */
    overheadTok: inp.localInputEstimate !== undefined
      ? Math.max(0, inp.localInputEstimate - (inp.requestTok ?? 0))
      : null,
    systemChangedParts: inp.systemChangedParts ?? null,
    systemChangedDetail: inp.systemChangedDetail ?? null,
    // 尾部动态块（core 在 preModel 之后追加；不在缓存前缀内，但会占最后一个断点）
    tailDynamicParts: inp.tailDynamicParts ?? null,
    tailDynamicChars: inp.tailDynamicChars ?? null,
  }
}
