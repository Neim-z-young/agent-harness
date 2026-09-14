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
 *   缓存命中率 = 相邻两轮投影请求的「相同前序 token」/ 本轮请求 token
 *              （ACP 把旧历史折叠为稳定摘要块 → 前缀稳定，提示前序命中率高）
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
 *       --sweepTier2=3,5,10,18 \
 *       --sweepMaxSummary=5000,10000,20000
 *
 * 输出 Markdown 表格。真实 "模型摘要" 只需替换 SUMMARY_PLACEHOLDER（kernel 内同源）。
 */

import { estimateTokens } from '../src/adapter'
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
  return defaultConfig(modelContextLimit, {
    compress: {
      minCompressRange: p.minCompressRange,
      maxSummaryLength: p.maxSummaryLength,
      minSummaryLength: p.minSummaryLength,
    },
    preserveRecentMessages: p.preserveRecentMessages,
    preserveRecentTokens: p.preserveRecentTokens,
    promotionThreshold: p.promotionThreshold,
    tiers: { enabled: true, tier2Trigger: p.tier2Trigger, tier3Trigger: p.tier3Trigger },
    nudge: {
      maxContextLimitPct: p.maxContextLimitPct,
      minContextLimitPct: p.minContextLimitPct,
      emergencyThresholdPct: p.emergencyThresholdPct,
      frequency: 1e6, // 抑制 warning 注入频率，纯折叠
      iterationThreshold: 1e6,
      force: 'soft',
      growthRatio: 0.15,
      growthFloor: Math.max(1, Math.round(modelContextLimit * 0.05)),
      growthCap: Math.max(2, Math.round(modelContextLimit * 0.2)),
      minGrowthFloor: Math.max(1, Math.round(modelContextLimit * 0.01)),
      minGrowthRatio: 0,
      tier2GrowthMultiplier: 1.5,
    },
  })
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
  blocks: Record<number, number>
  foldedTokens: number
  createdBlocks: number
}

function measure(window: number, p: BenchParams, perTurn: number, steps: number): BenchResult {
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
    requTok = estimateTokens(res.messages) + SYS_ADD

    if (prevReq.length) {
      cacheHits.push(commonPrefixTokens(prevReq, res.messages) / Math.max(1, requTok))
      cacheSteps++
    }
    prevReq = res.messages

    const ranges = res.nudge?.compressibleRanges ?? []
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

  const baseTok = totalRawTok + SYS_ADD
  const cacheHit = cacheSteps > 0 ? cacheHits.reduce((s, x) => s + x, 0) / cacheSteps : 0
  return {
    window,
    baseTok,
    requTok,
    ratio: baseTok / Math.max(1, requTok),
    retention: requTok / baseTok,
    occupancy: requTok / Math.max(1, window),
    cacheHit,
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
  return `| 长度 | 原文 tok | 请求 tok | 压缩比 | 保留率 | 占用率 | 缓存命中 | t1/t2/t3 | 折叠 tok |`
}
function row(r: BenchResult): string {
  return `| ${r.window} | ${r.baseTok} | ${r.requTok} | ${r.ratio.toFixed(2)}x | ${fmtPct(r.retention)} | ${
    fmtOcc(r.occupancy)} | ${fmtPct(r.cacheHit)} | ${r.blocks[1]}/${r.blocks[2]}/${r.blocks[3]} | ${r.foldedTokens} |`
}

/** 每个窗口的步增量：让各窗口都收敛到相近的饱和占用率（每步 = rate*window/N 的固定比例增量），口径一致可比 */
function perTurnOf(window: number, rate: number, steps: number): number {
  return Math.max(500, Math.round((rate * window) / steps))
}

/** 对一组 (标签, 参数集) 打印基线表 */
function printBaseline(lengths: number[], p: BenchParams, rate: number, steps: number): void {
  console.log(`\n## 基线：当前参数集 × 上下文长度（步增量=窗口固定比例）\n`)
  console.log(header())
  console.log(`|--|--|--|--|--|--|--|--|--|`)
  for (const len of lengths) {
    const r = measure(len, p, perTurnOf(len, rate, steps), steps)
    console.log(row(r))
  }
}

/** 参数敏感性扫描：固定其它参数，变个体参 */
function printSweep(label: string, lengths: number[], base: BenchParams, apply: (v: number, p: BenchParams) => void, values: number[], rate: number, steps: number): void {
  console.log(`\n## 扫描：${label}\n`)
  console.log(`| ${label} | 长度 | 请求 tok | 压缩比 | 占用率 | 缓存命中 | t1/t2/t3 |`)
  console.log(`|--|--|--|--|--|--|--|`)
  for (const v of values) {
    const p: BenchParams = { ...base }
    apply(v, p)
    for (const len of lengths) {
      const r = measure(len, p, perTurnOf(len, rate, steps), steps)
      console.log(`| ${v} | ${r.window} | ${r.requTok} | ${r.ratio.toFixed(2)}x | ${fmtOcc(r.occupancy)} | ${fmtPct(r.cacheHit)} | ${r.blocks[1]}/${r.blocks[2]}/${r.blocks[3]} |`)
    }
  }
}

async function run(): Promise<void> {
  const args = parseArgs()
  const lengths = (args.lengths ?? '40000,100000,200000,300000,1000000').split(',').map((s) => parseInt(s.trim(), 10))
  const rate = flt(args, 'rate', 0.9) // 每窗口收敛到的填充比例（占窗口）
  const steps = int(args, 'steps', 30) // 各窗口统一步数
  const base = defaultParams(args)

  printBaseline(lengths, base, rate, steps)

  if (args.sweepPreserve) {
    printSweep(
      'preserveRecentTokens', lengths, base,
      (v, p) => { p.preserveRecentTokens = v }, (args.sweepPreserve ?? '').split(',').map((s) => parseInt(s.trim(), 10)), rate, steps,
    )
  }
  if (args.sweepTier2) {
    printSweep(
      'tier2Trigger', lengths, base,
      (v, p) => { p.tier2Trigger = v }, (args.sweepTier2 ?? '').split(',').map((s) => parseInt(s.trim(), 10)), rate, steps,
    )
  }
  if (args.sweepMaxSummary) {
    printSweep(
      'maxSummaryLength', lengths, base,
      (v, p) => { p.maxSummaryLength = v }, (args.sweepMaxSummary ?? '').split(',').map((s) => parseInt(s.trim(), 10)), rate, steps,
    )
  }
  if (args.sweepMinCompress) {
    printSweep(
      'minCompressRange', lengths, base,
      (v, p) => { p.minCompressRange = v }, (args.sweepMinCompress ?? '').split(',').map((s) => parseInt(s.trim(), 10)), rate, steps,
    )
  }
}

await run()