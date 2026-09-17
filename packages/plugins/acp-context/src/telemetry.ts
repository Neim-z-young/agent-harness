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

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultCountTokens, type Config, type CoreMessage, type CompressionState, type TokenCountFn } from 'acp-kernel'
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
  blocksAfter: { t1: number; t2: number; t3: number }
}

// ===== 事件：provider 侧缓存命中（模型返回后，由 core 层追加）=====
export interface ProviderCacheEvent {
  kind: 'providerCache'
  ts: number
  sessionId: string
  round: number
  cacheRead: number      // 命中缓存的输入 token
  cacheWrite: number     // 写入缓存（未命中但计入）的输入 token
  requestTok: number     // 本轮发往模型的 token（preModel 估算值，用于计算 provider 侧命中率）
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

// ===== Writer =====

export interface TelemetryWriter {
  /** 追加一条事件；写盘在 flush 中 debounce 执行 */
  write(ev: TelemetryEvent): void
  /** 立即 flush pending 行（正常退出 / session 结束时调用） */
  flush(): void
}

/**
 * 纯 JSONL 追加写入器。debounce 500ms 内多次 write 只写一次盘，
 * 避免每轮 preModel 都 IO。异常吞掉（遥测不影响主流程）。
 */
export function createWriter(path: string | undefined): TelemetryWriter {
  if (!path) return { write: () => {}, flush: () => {} }

  let pending: TelemetryEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const doFlush = () => {
    if (pending.length === 0) return
    try {
      if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
      const lines = pending.map((ev) => JSON.stringify(ev)).join('\n') + '\n'
      writeFileSync(path, lines, { flag: 'a' })
    } catch {
      // 遥测失败不致命
    }
    pending = []
    timer = null
  }

  return {
    write(ev: TelemetryEvent) {
      pending.push(ev)
      if (timer === null) timer = setTimeout(doFlush, 500)
    },
    flush() {
      if (timer !== null) { clearTimeout(timer); timer = null }
      doFlush()
    },
  }
}

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
  const rawTok = estimateTokens(inp.inflatCores)
  const requestTok = estimateTokens(inp.requestCores)
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
  cacheRead: number | undefined
  cacheWrite: number | undefined
  requestTok: number | undefined
}

export function buildProviderCacheEvent(inp: ProviderCacheBuildInput): ProviderCacheEvent | null {
  if (inp.cacheRead === undefined && inp.cacheWrite === undefined) return null
  return {
    kind: 'providerCache',
    ts: Date.now(),
    sessionId: inp.sessionId,
    round: inp.round,
    cacheRead: inp.cacheRead ?? 0,
    cacheWrite: inp.cacheWrite ?? 0,
    requestTok: inp.requestTok ?? 0,
  }
}
