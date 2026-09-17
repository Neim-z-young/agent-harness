/**
 * @harness/acp-context ACP 上下文压缩**参数 × 上下文长度**压测（可复用，手动运行）
 *
 * 在 config.json `compression` 各可调参数驱动下，对不同上下文窗口长度（40k / 100k / 200k / 300k / 1m）
 * 渐进填充并模拟「理性模型」每轮顺从 ACP 建议折叠，收敛后统计：
 *
 *   baseTok   = 无 ACP 时发往模型的 token（系统提示 + 累计全文历史）
 *   requTok   = 经 ACP 折叠后真正发往模型的 token（稳态投影）
 *   压缩比    = baseTok / requTok（越大越省）
 *   保留率    = requTok / baseTok
 *   上下文占用率 = requTok / modelContextLimit（折叠后请求占窗口比例）
 *   缓存命中率 = (系统提示词 + 相邻两轮投影请求的「相同前序 token」) / 本轮请求 token
 *              系统提示词每轮原样发送、ACP 不压缩，永远是稳定前缀（计入命中分子）；
 *              ACP 把旧历史折叠为稳定摘要块 → 投影前缀逐步稳定，提示缓存命中率随会话变长而上升。
 *              每次折叠把新摘要块插在「旧块之后、保留窗口之前」，使保留窗口整体后移一位（该轮全部失配），
 *              故命中率呈锯齿：非折叠轮命中≈1−本轮新增/请求，折叠轮骤降至 sys+旧块 占比。
 *   有效成本  = 均请求 tok × [ (1−命中) + 命中 × cacheDiscount ]，cacheDiscount 默认 0.04（命中按 1/25 计价）。
 *   t1/t2/t3 = 稳态各层活跃块数（反映分层蒸馏程度）
 *
 * token 估算 = chars/4（与 acp-kernel 默认 tokenizer 一致，见 adapter.estimateTokens）。
 *
 * 用法定口径：
 *   1. 渐进填充：每步追加一个 freshTurn，窗长/窗口大小决定步数，让窗口趋近饱和。
 *   2. 理性模型：每轮若 ACP 建议 compressibleRanges 立即 applyCompression，直至无建议=稳态。
 *   3. 基线/扫描：--lengths 逐长度跑基线参数集；--sweep<Param>=v1,v2,... 做参数敏感性扫描。
 *
 * 用法：
 *   bun run bench/compress-params.ts \
 *       --lengths=40000,100000,200000,300000,1000000 --perTurn=4000 \
 *       --preserveRecentTokens=50000 --preserveRecentMessages=10 \
 *       --promotionThreshold=10 --tier2Trigger=5 --tier3Trigger=18 \
 *       --maxSummaryLength=10000 --minSummaryLength=1000 --minCompressRange=5000 \
 *       --maxPct=0.65 --minPct=0.35 --emergencyPct=0.80 \
 *       --sweepPreserve=0,2000,8000,20000,50000 \
 *       --sweepGrowthFloor=17500,26250,35000,52500,70000 --autoTune=0 \
 *       --sweepTier2=3,5,10,18 \
 *       --sweepMaxSummary=5000,10000,20000
 *
 * 输出 Markdown 表格。真实 "模型摘要" 只需替换 SUMMARY_PLACEHOLDER（kernel 内同源）。
 */

import { estimateTokens } from '../src/adapter'
import { deriveAutoTuneParams, describeAutoTune } from '../src/auto-tune'
import { createCore, createInitialState, defaultConfig } from 'acp-kernel'
import type { Config, CoreMessage, CompressionState } from 'acp-kernel'

// ===== 参数解析 =====
function parseArgs(): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]
    const eq = a.indexOf('=')
    if (eq === -1) out[a.replace(/^--/, '')] = '1'
    else out[a.slice(2, eq)] = a.slice(eq + 1)
  }
  return out
}

const SYSPROMPT = 'You are a precise assistant. Compress the context faithfully. '
const SYS_ADD = Math.ceil(SYSPROMPT.length / 4)

/** 模型摘要占位：长度落在 [minSummaryLength, maxSummaryLength] 内（≈ 上限的 30%），
 *  真实模型会把每个折叠块写成此量级梗概（块越大、每块覆盖越省，但消耗更多摘要 token）。 */
function placeholderText(p: BenchParams): string {
  const targetChars = Math.max(p.minSummaryLength, Math.round(p.maxSummaryLength * 0.3))
  const n = Math.min(p.maxSummaryLength, Math.max(1, targetChars))
  const sentence = 'This block summarizes earlier conversation and records prior decisions, outcomes, constraints and open follow-ups so later work stays coherent without re-reading the full raw exchange. '
  return sentence.repeat(Math.ceil(n / sentence.length)).slice(0, n)
}

// ===== 可调参数集（对应 config.json compression.*） =====
export interface BenchParams {
  maxSummaryLength: number
  minSummaryLength: number
  minCompressRange: number
  preserveRecentTokens: number
  preserveRecentMessages: number
  promotionThreshold: number
  tier2Trigger: number
  tier3Trigger: number
  maxContextLimitPct: number
  minContextLimitPct: number
  emergencyThresholdPct: number
  /** 单次压缩量上限（占窗口比）。原固定 0.2；单轮输入很大时需调高，否则压缩追不上增长 */
  growthCapPct: number
  /** 每轮压缩量占窗口比（nudge growthRatio） */
  growthRatioPct: number
  /** 折叠触发占用率：仅当「当前投影 token / 窗口」≥ 此值时模型才顺从压缩（0=每轮都折叠）。
   *  用于模拟「等到上下文长到某阈值才成批折叠」，如 0.333 → 300k 窗口下 ~100k 才折。 */
  foldAtUsage: number
  /** 仅当 nudge.shouldInject 为真时才折叠（贴近真实「模型被提醒才折」，1=启用；0=每轮都折）。 */
  foldOnNudge: number
  /** nudge.growthFloor 绝对 token（>0 覆盖内置 5% 窗口推导） */
  growthFloorTok: number
  /** nudge.minGrowthFloor 绝对 token（>0 覆盖内置 1% 窗口推导） */
  minGrowthFloorTok: number
  /** nudge.minGrowthRatio（折叠节奏 = max(minGrowthFloor, minGrowthRatio×nudgeGrowthTokens)） */
  minGrowthRatio: number
  /** 命中缓存的 token 相对未命中的计价折扣（默认 0.04 = 1/25；0 = 命中不计费） */
  cacheDiscount: number
  /** 用出厂公式（src/auto-tune.ts）按窗口推导 preserveRecentTokens/growthFloor/minCompressRange，覆盖手填值（1=启用） */
  autoTune: number
}

function defaultParams(args: Record<string, string>): BenchParams {
  return {
    maxSummaryLength: int(args, 'maxSummaryLength', 20000),
    minSummaryLength: int(args, 'minSummaryLength', 50),
    minCompressRange: int(args, 'minCompressRange', 5000),
    preserveRecentTokens: int(args, 'preserveRecentTokens', 5000),
    preserveRecentMessages: int(args, 'preserveRecentMessages', 5),
    promotionThreshold: int(args, 'promotionThreshold', 5),
    tier2Trigger: int(args, 'tier2Trigger', 5),
    tier3Trigger: int(args, 'tier3Trigger', 10),
    maxContextLimitPct: flt(args, 'maxPct', 0.75),
    minContextLimitPct: flt(args, 'minPct', 0.45),
    emergencyThresholdPct: flt(args, 'emergencyPct', 0.95),
    growthCapPct: flt(args, 'growthCapPct', 0.2),
    growthRatioPct: flt(args, 'growthRatioPct', 0.15),
    foldAtUsage: flt(args, 'foldAtUsage', 0),
    foldOnNudge: int(args, 'foldOnNudge', 0),
    growthFloorTok: int(args, 'growthFloorTok', 0),
    minGrowthFloorTok: int(args, 'minGrowthFloorTok', 0),
    minGrowthRatio: flt(args, 'minGrowthRatio', 0),
    cacheDiscount: flt(args, 'cacheDiscount', 0.04),
    autoTune: int(args, 'autoTune', 0),
  }
}

function int(a: Record<string, string>, k: string, d: number): number {
  return a[k] !== undefined ? parseInt(a[k], 10) : d
}
function flt(a: Record<string, string>, k: string, d: number): number {
  return a[k] !== undefined ? parseFloat(a[k]) : d
}

/** 由可调参数集 + 窗口长度构造内核 config（nudge 高频抑制，保证确定性折叠） */
function buildConfig(p: BenchParams, modelContextLimit: number): Config {
  // autoTune：用**出厂公式**（src/auto-tune.ts，与插件同一份实现）推导缩放参数，覆盖手填值。
  // 这样 `--autoTune=1` 验证的就是线上真正会跑的参数，而不是手抄的近似。
  const eff: BenchParams = p.autoTune
    ? { ...p, ...autoTuneAsBenchParams(modelContextLimit) }
    : p
  return defaultConfig(modelContextLimit, {
    compress: {
      minCompressRange: eff.minCompressRange,
      maxSummaryLength: eff.maxSummaryLength,
      minSummaryLength: eff.minSummaryLength,
    },
    preserveRecentMessages: eff.preserveRecentMessages,
    preserveRecentTokens: eff.preserveRecentTokens,
    promotionThreshold: eff.promotionThreshold,
    tiers: { enabled: true, tier2Trigger: eff.tier2Trigger, tier3Trigger: eff.tier3Trigger },
    nudge: {
      maxContextLimitPct: eff.maxContextLimitPct,
      minContextLimitPct: eff.minContextLimitPct,
      emergencyThresholdPct: eff.emergencyThresholdPct,
      frequency: 1e6, // 抑制 warning 注入频率，纯折叠
      iterationThreshold: 1e6,
      force: 'soft',
      growthRatio: eff.growthRatioPct,
      growthFloor: eff.growthFloorTok > 0 ? eff.growthFloorTok : Math.max(1, Math.round(modelContextLimit * 0.05)),
      growthCap: Math.max(2, Math.round(modelContextLimit * eff.growthCapPct)),
      minGrowthFloor: eff.minGrowthFloorTok > 0 ? eff.minGrowthFloorTok : Math.max(1, Math.round(modelContextLimit * 0.01)),
      minGrowthRatio: eff.minGrowthRatio,
      tier2GrowthMultiplier: 1.5,
    },
  })
}

/** 把 `deriveAutoTuneParams` 的推导结果翻译成 bench 参数键（autoTune 模式用） */
function autoTuneAsBenchParams(modelContextLimit: number): Partial<BenchParams> {
  const t = deriveAutoTuneParams(modelContextLimit)
  return {
    preserveRecentTokens: t.retainTokens,
    growthFloorTok: t.growthFloor,
    minGrowthFloorTok: t.growthFloor,
    minCompressRange: t.minCompressRange,
    // growthRatio / minGrowthRatio 在 buildConfig 内恒为 0（nudgeGrowthTokens ≡ cadenceFloor ≡ GF）
    growthRatioPct: 0,
    growthCapPct: 1.0, // 让 growthCap 足够大，不截断 growthFloor
    minGrowthRatio: 0,
  }
}

// ===== 合成 fresh turn（每步追加的用户 + 助手对） =====
function freshTurn(step: number, freshTok: number): { cores: CoreMessage[]; tok: number } {
  const pad = 'Working on a long synthetic conversation with enough repeated words to reach the target length. '
  // 用户与助手均分：各 freshTok/2
  const half = Math.max(4, Math.floor(freshTok / 2))
  const msg = (id: string, role: 'user' | 'assistant'): CoreMessage => {
    const body = pad.repeat(Math.ceil((half * 4) / pad.length)).slice(0, half * 4)
    return { id, role, contentType: 'text', text: body }
  }
  const u = msg(`f${step}u`, 'user')
  const a = msg(`f${step}a`, 'assistant')
  return { cores: [u, a], tok: Math.ceil((u.text.length + a.text.length) / 4) }
}

/** 相邻两轮投影请求的相同前序 token 长度（前缀命中；用于提示缓存命中估算） */
function commonPrefixTokens(a: CoreMessage[], b: CoreMessage[]): number {
  let chars = 0
  const max = Math.min(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (a[i].id !== b[i].id) break
    chars += (a[i].text ?? '').length
  }
  return Math.ceil(chars / 4)
}

const SUMMARY_ID_PREFIX = 'acp_summary_'
/** 数值块 id（b5 < b10） */
const numericBlockId = (blockId: string): number => parseInt((blockId.match(/\d+/) ?? ['0'])[0], 10)

/** 取指定 tier 中最旧的活跃块（块 id 最小者） */
function oldestActiveOfTier(state: CompressionState, tier: number): (typeof state.blocks)[number] | undefined {
  let best: (typeof state.blocks)[number] | undefined
  for (const b of state.blocks) {
    if (!b.active || b.tier !== tier) continue
    if (!best || numericBlockId(b.blockId) < numericBlockId(best.blockId)) best = b
  }
  return best
}

/** 把一个块按块边界压缩，蒸馏到更高 tier（t1→t2 或 t2→t3），返回 { state, created, folded } */
function distillBlock(
  engine: ReturnType<typeof createCore>,
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  tok: number,
  tier: 1 | 2,
  placeholder: string,
): { state: CompressionState; created: number; folded: number } {
  const target = oldestActiveOfTier(state, tier)
  if (!target) return { state, created: 0, folded: 0 }
  // block 边界 ref 用块 id（bN）：resolve 到该块，outputTier = minTier+1（t1→t2 / t2→t3）
  const id = target.blockId
  const applied = engine.applyCompression({
    ranges: [{
      startRef: id,
      endRef: id,
      summary: placeholder,
      topic: 'acp-bench-tier',
      chars: 0,
    }],
    messages,
    state,
    config,
    tokenCount: tok,
  })
  return {
    state: applied.state,
    created: applied.result.blocksCreated,
    folded: applied.result.tokensCompressed,
  }
}

/** 当前活跃块中的首层待蒸馏块数 */
function countActiveTier(state: CompressionState, tier: number): number {
  let n = 0
  for (const b of state.blocks) if (b.active && b.tier === tier) n++
  return n
}

/** 稳态各层活跃块数 */
function tallyTiers(state: CompressionState): Record<number, number> {
  const o: Record<number, number> = { 1: 0, 2: 0, 3: 0 }
  for (const b of state.blocks) {
    if (b.active) o[b.tier] = (o[b.tier] ?? 0) + 1
  }
  return o
}

export interface BenchResult {
  window: number
  baseTok: number
  requTok: number
  ratio: number
  retention: number
  occupancy: number // requTok/window
  cacheHit: number // 平均前缀命中
  cacheHits: number[] // 逐轮前缀命中（占本轮请求 token 比）
  avgRequTok: number // 全流程平均请求 token（成本口径）
  maxRequTok: number // 峰值请求 token
  minRequTok: number // 稳态谷值请求 token（后半程最小值 = 请求地板：刚折叠完的最小请求体）
  costPerTurn: number // 每轮有效成本：均请求 × [(1−命中) + 命中×cacheDiscount]
  cacheDiscount: number // 命中缓存计价折扣（默认 0.04 = 1/25）
  blocks: Record<number, number>
  foldedTokens: number
  createdBlocks: number
}

function measure(window: number, p: BenchParams, perTurn: number, steps: number, sysTok = SYS_ADD): BenchResult {
  const engine = createCore()
  const config = buildConfig(p, window)
  const placeholder = placeholderText(p)

  let state = createInitialState()
  let messages: CoreMessage[] = []
  let prevReq: CoreMessage[] = []
  let totalRawTok = 0
  let cacheHits: number[] = []
  let cacheSteps = 0
  let requTok = 0
  let requTokSum = 0
  let requTokMax = 0
  let requTokMin = Number.POSITIVE_INFINITY
  let createdBlocks = 0
  let foldedTokens = 0

  for (let step = 0; step < steps; step++) {
    const turn = freshTurn(step, perTurn)
    messages = messages.concat(turn.cores)
    totalRawTok += turn.tok

    const tok = estimateTokens(messages)
    const res = engine.processTurn({
      messages,
      state,
      config,
      tokenCount: tok,
      renderTags: 'text-only',
    })
    state = res.state
    requTok = estimateTokens(res.messages) + sysTok
    requTokSum += requTok
    requTokMax = Math.max(requTokMax, requTok)
    // 谷值只在后半程（稳态区）取样：前半程是「还没攒够内容折叠」的热身区，请求体天然很小，
    // 计入会掩盖真实的请求地板。
    if (step >= Math.floor(steps / 2)) requTokMin = Math.min(requTokMin, requTok)

    if (prevReq.length) {
      // 系统提示词每轮原样发送、不参与压缩，永远是稳定前缀 → 计入缓存命中分子；
      // 投影前缀 = 相邻两轮投影请求的相同前序 token（commonPrefixTokens 按下标逐项比对消息 id）。
      const cached = sysTok + commonPrefixTokens(prevReq, res.messages)
      cacheHits.push(cached / Math.max(1, requTok))
      cacheSteps++
    }
    prevReq = res.messages

    // 折叠触发门控：foldOnNudge=1 时仅当 nudge.shouldInject 为真才折（贴近真实模型）；
    // 另可用 foldAtUsage 叠加占用率门控（0=不额外限制）。配合 preserveRecentTokens 决定单次折叠量。
    const usageNow = tok / Math.max(1, window)
    const nudgeOk = p.foldOnNudge ? res.nudge?.shouldInject === true : true
    const ranges = nudgeOk && usageNow >= p.foldAtUsage ? res.nudge?.compressibleRanges ?? [] : []
    if (ranges.length > 0) {
      const applied = engine.applyCompression({
        ranges: ranges.map((r) => ({
          startRef: r.startRef,
          endRef: r.endRef,
          summary: placeholder,
          topic: 'acp-bench',
          chars: r.chars,
        })),
        messages: res.messages,
        state,
        config,
        tokenCount: tok,
      })
      state = applied.state
      createdBlocks += applied.result.blocksCreated
      foldedTokens += applied.result.tokensCompressed
    }

    // 理性模型：当活跃块数达到 tier 阈值时逐层蒸馏（每步至多蒸馏一个块，
    // 新块的摘要消息需在后续轮次的投影中才出现，故跨步累积而非本步连立）。
    if (countActiveTier(state, 1) >= p.tier2Trigger) {
      const d = distillBlock(engine, res.messages, state, config, tok, 1, placeholder)
      state = d.state
      createdBlocks += d.created
      foldedTokens += d.folded
    } else if (countActiveTier(state, 2) >= p.tier3Trigger) {
      const d = distillBlock(engine, res.messages, state, config, tok, 2, placeholder)
      state = d.state
      createdBlocks += d.created
      foldedTokens += d.folded
    }

    messages = res.messages
  }

  const baseTok = totalRawTok + sysTok
  const cacheHit = cacheSteps > 0 ? cacheHits.reduce((s, x) => s + x, 0) / cacheSteps : 0
  const avgRequTok = Math.round(requTokSum / Math.max(1, steps))
  // 有效成本：命中缓存的 token 按 cacheDiscount 计价（默认 1/25），未命中按全价。
  //   = 均请求 × [ (1 − 命中) × 1 + 命中 × cacheDiscount ]
  const costPerTurn = Math.round(avgRequTok * (1 - cacheHit * (1 - p.cacheDiscount)))
  return {
    window,
    baseTok,
    requTok,
    ratio: baseTok / Math.max(1, requTok),
    retention: requTok / baseTok,
    occupancy: requTok / Math.max(1, window),
    cacheHit,
    cacheHits,
    avgRequTok,
    maxRequTok: requTokMax,
    minRequTok: Number.isFinite(requTokMin) ? requTokMin : requTok,
    costPerTurn,
    cacheDiscount: p.cacheDiscount,
    blocks: tallyTiers(state),
    foldedTokens,
    createdBlocks,
  }
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`
}
function fmtOcc(x: number): string {
  return x >= 1 ? `${(x * 100).toFixed(1)}%` : `${(x * 100).toFixed(2)}%`
}

function header(): string {
  return `| 长度 | 原文 tok | 请求 tok | 均请求 tok | 峰请求 tok | 谷请求 tok | 有效成本 tok | 压缩比 | 保留率 | 占用率 | 缓存命中 | t1/t2/t3 | 折叠 tok |`
}
function row(r: BenchResult): string {
  return `| ${r.window} | ${r.baseTok} | ${r.requTok} | ${r.avgRequTok} | ${r.maxRequTok} | ${r.minRequTok} | ${r.costPerTurn} | ${r.ratio.toFixed(2)}x | ${fmtPct(r.retention)} | ${
    fmtOcc(r.occupancy)} | ${fmtPct(r.cacheHit)} | ${r.blocks[1]}/${r.blocks[2]}/${r.blocks[3]} | ${r.foldedTokens} |`
}

/** 逐轮缓存命中率明细：cacheHits 从第 1 轮起（step 0 无前序请求，不计入），
 *  下标 i 对应第 i+1 轮投影相对上一轮的「相同前序 token / 本轮请求 token」。 */
function printCacheTrace(r: BenchResult): void {
  console.log(`\n### 缓存命中率逐轮明细（窗口 ${r.window}，末轮请求 ${r.requTok} tok，共 ${r.cacheHits.length} 轮采样）`)
  console.log('| 轮次 | 前缀命中（占本轮请求 token 比） |')
  console.log('|--|--|')
  r.cacheHits.forEach((h, i) => {
    console.log(`| ${i + 1} | ${fmtPct(h)} |`)
  })
  console.log(`| **平均** | **${fmtPct(r.cacheHit)}** |`)
}

/** 每个窗口的步增量：让各窗口都收敛到相近的饱和占用率（每步 = rate*window/N 的固定比例增量），口径一致可比。
 *  给 --perTurn 时改用固定每轮增量（模拟「单轮输入固定很大」的真实场景，如 80k/轮）。 */
function perTurnOf(window: number, rate: number, steps: number, fixed?: number): number {
  if (fixed && fixed > 0) return fixed
  return Math.max(500, Math.round((rate * window) / steps))
}

/** 对一组 (标签, 参数集) 打印基线表 */
function printBaseline(lengths: number[], p: BenchParams, rate: number, steps: number, fixed?: number, sysTok = SYS_ADD, budget = 0, cacheTrace = false): void {
  console.log(`\n## 基线：当前参数集 × 上下文长度${fixed ? `（固定每轮增量 ${fixed} tok）` : '（步增量=窗口固定比例）'}\n`)
  console.log(budget > 0 ? `${header()} 达标 |` : `${header()}|`)
  console.log(budget > 0 ? `|--|--|--|--|--|--|--|--|--|--|--|--|--|--|` : `|--|--|--|--|--|--|--|--|--|--|--|--|--|`)
  for (const len of lengths) {
    const r = measure(len, p, perTurnOf(len, rate, steps, fixed), steps, sysTok)
    console.log(budget > 0 ? `${row(r)} ${r.requTok <= budget ? '✅' : '❌'} |` : row(r))
    if (cacheTrace) printCacheTrace(r)
  }
}

/** 参数敏感性扫描：固定其它参数，变个体参 */
function printSweep(label: string, lengths: number[], base: BenchParams, apply: (v: number, p: BenchParams) => void, values: number[], rate: number, steps: number, fixed?: number, sysTok = SYS_ADD, budget = 0, cacheTrace = false): void {
    console.log(`\n## 扫描：${label}\n`)
    console.log(budget > 0 ? `| ${label} | 长度 | 请求 tok | 有效成本 tok | 压缩比 | 占用率 | 缓存命中 | t1/t2/t3 | 达标 |` : `| ${label} | 长度 | 请求 tok | 有效成本 tok | 压缩比 | 占用率 | 缓存命中 | t1/t2/t3 |`)
    console.log(budget > 0 ? `|--|--|--|--|--|--|--|--|--|` : `|--|--|--|--|--|--|--|--|`)
    for (const v of values) {
      const p: BenchParams = { ...base }
      apply(v, p)
      for (const len of lengths) {
        const r = measure(len, p, perTurnOf(len, rate, steps, fixed), steps, sysTok)
        const mark = budget > 0 ? `| ${r.requTok <= budget ? '✅' : '❌'} |` : '|'
        console.log(`| ${v} | ${r.window} | ${r.requTok} | ${r.costPerTurn} | ${r.ratio.toFixed(2)}x | ${fmtOcc(r.occupancy)} | ${fmtPct(r.cacheHit)} | ${r.blocks[1]}/${r.blocks[2]}/${r.blocks[3]} ${mark}`)
        if (cacheTrace) printCacheTrace(r)
      }
    }
}

async function run(): Promise<void> {
  const args = parseArgs()
  const lengths = (args.lengths ?? '40000,100000,200000,300000,1000000').split(',').map((s) => parseInt(s.trim(), 10))
  const rate = flt(args, 'rate', 0.9) // 每窗口收敛到的填充比例（占窗口）
  const steps = int(args, 'steps', 30) // 各窗口统一步数
  const fixed = int(args, 'perTurn', 0) // 固定每轮增量（>0 时覆盖 rate 算法）
  const sysTok = int(args, 'sysTok', SYS_ADD) // 系统提示词 token（真实场景常达 1w+）
  const budget = int(args, 'budget', 0) // 请求 token 预算上限（>0 时输出 ✅/❌ 达标列）
  const cacheTrace = args.cacheTrace === '1' || args.cacheTrace === 'true' // 逐轮缓存命中率明细
  const base = defaultParams(args)

  const foldNote = `${base.foldOnNudge ? '，仅 nudge 触发折叠' : ''}${base.foldAtUsage > 0 ? `，折叠触发占用率 ${base.foldAtUsage}` : ''}`
  const costNote = `，命中缓存按 ${base.cacheDiscount} 计价（未命中=1）`
  if (base.autoTune) {
    // 直接打印每个窗口的推导值，便于与线上日志（describeAutoTune）逐字核对
    console.log(`\n> autoTune 启用：preserveRecentTokens / growthFloor / minCompressRange 由出厂公式按窗口推导，忽略手填值`)
    for (const w of lengths) console.log(`  · ${describeAutoTune(w)}`)
  }
  if (sysTok > 0 && sysTok !== SYS_ADD) console.log(`\n> 场景：系统提示词 ${sysTok} tok${fixed ? `，每轮固定增量 ${fixed} tok` : ''}${budget ? `，请求预算 ${budget} tok` : ''}${foldNote}${costNote}`)
  else if (fixed || foldNote) console.log(`\n> 场景：${fixed ? `每轮固定增量 ${fixed} tok` : ''}${budget ? `，请求预算 ${budget} tok` : ''}${foldNote}${costNote}`)

  printBaseline(lengths, base, rate, steps, fixed, sysTok, budget, cacheTrace)

  const sweep = (flag: string, label: string, apply: (v: number, p: BenchParams) => void): void => {
    if (!args[flag]) return
    printSweep(
      label, lengths, base, apply,
      (args[flag] ?? '').split(',').map((s) => parseFloat(s.trim())), rate, steps, fixed, sysTok, budget, cacheTrace,
    )
  }
  sweep('sweepPreserve', 'preserveRecentTokens', (v, p) => { p.preserveRecentTokens = v })
  sweep('sweepTier2', 'tier2Trigger', (v, p) => { p.tier2Trigger = v })
  sweep('sweepMaxSummary', 'maxSummaryLength', (v, p) => { p.maxSummaryLength = v })
  sweep('sweepMinCompress', 'minCompressRange', (v, p) => { p.minCompressRange = v })
  // 折叠量 GF：growthFloor 与 minGrowthFloor 一起变（autoTune 模式下三者恒相等，
  // 因此这条扫描就是「GF 敏感性」——调参时用来确认 GF = 1.5R 是否落在最优平台内）
  sweep('sweepGrowthFloor', 'growthFloor=minGrowthFloor', (v, p) => { p.growthFloorTok = v; p.minGrowthFloorTok = v })
  sweep('sweepMaxPct', 'maxContextLimitPct', (v, p) => { p.maxContextLimitPct = v })
  sweep('sweepMinPct', 'minContextLimitPct', (v, p) => { p.minContextLimitPct = v })
  sweep('sweepEmergency', 'emergencyThresholdPct', (v, p) => { p.emergencyThresholdPct = v })
  sweep('sweepGrowthCap', 'growthCapPct', (v, p) => { p.growthCapPct = v })
  sweep('sweepGrowthRatio', 'growthRatioPct', (v, p) => { p.growthRatioPct = v })
}

await run()