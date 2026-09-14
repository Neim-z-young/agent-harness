/**
 * 离线分析（按参数组合 × 窗口聚合）：统计**不同参数组合**下的缓存命中率、上下文占用率，
 * 以及压缩比 / 保留率 / tier 块分布，用于对比"哪套压缩参数在真实会话中效果最好"。
 *
 * 数据源：运行时遥测 JSONL（每轮 preModel 都带当时的 params 快照 + acpCacheHit + occupancy）。
 * 把全量事件按「参数组合签名 = params + window」分组，跨会话聚合同组合的所有轮次指标。
 *
 * 可选 --sessions 拼每个 session 的 assistant tokenUsage，补 provider 侧 cacheRead 命中率。
 *
 * 用法：
 *   bun run bench/analysis-params.ts \
 *       --glob='~/.harness/sessions/*.telemetry.jsonl' \
 *       --sessions='~/.harness/sessions/*.json'        # 可选：补 Provider 侧缓存命中
 *
 * 输出 Markdown：每窗口一张「参数组合 → 指标」表 + 全量命中率排行。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

interface PreModelEv {
  kind: 'preModel'; sessionId: string; round: number; window: number
  params: {
    preserveRecentTokens: number; preserveRecentMessages: number; promotionThreshold: number
    tier2Trigger: number; tier3Trigger: number
    maxContextLimitPct: number; minContextLimitPct: number; emergencyThresholdPct: number
    minSummaryLength: number; maxSummaryLength: number; minCompressRange: number
  }
  rawTok: number; requestTok: number; occupancy: number; compressRatio: number; retention: number
  acpCacheHit: number | null
  blocks: { t1: number; t2: number; t3: number }
  suggestedRanges: number; emergencyCompressed: boolean; ts: number
}
interface ProviderCacheEv { kind: 'providerCache'; sessionId: string; round: number; cacheRead: number; cacheWrite: number; requestTok: number; ts: number }
type Ev = PreModelEv | ProviderCacheEv

function glob(pattern: string): string[] {
  const tilde = pattern.replace(/^~/, process.env.HOME ?? '')
  const star = tilde.indexOf('*')
  if (star === -1) return existsSync(tilde) ? [tilde] : []
  // 目录 = 星号前最后一个 / 的部分；文件名前缀 = 星号到星号前 /(不含) 之间；后缀 = 星号后
  const dir = tilde.slice(0, tilde.lastIndexOf('/', star))
  const prefix = tilde.slice(dir.length + 1, star)
  const rest = tilde.slice(star + 1)
  if (!dir || !existsSync(dir)) return []
  const re = new RegExp('^' + prefix.replace(/\./g, '\\.') + '.*' + rest.replace(/\./g, '\\.') + '$')
  return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f))
}

function readJsonl(path: string): Ev[] {
  const out: Ev[] = []
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 忽略坏行 */ }
  }
  return out
}

/** 参数组合签名：把所有结构化的 params + window 压成稳定串，同组合归并 */
function sig(p: PreModelEv['params'], window: number): string {
  return JSON.stringify({ window, ...p })
}

/** 组合的"人读"标签：只看对压缩影响最大的几个旋钮 */
function label(p: PreModelEv['params'], window: number): string {
  return `窗口${window} pTok${p.preserveRecentTokens} t2${p.tier2Trigger} t3${p.tier3Trigger} maxSum${p.maxSummaryLength} minCR${p.minCompressRange}`
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : NaN
}
function fmtPct(x: number): string {
  return Number.isNaN(x) ? '-' : `${(x * 100).toFixed(1)}%`
}

interface ComboAgg {
  key: string
  label: string
  window: number
  params: PreModelEv['params']
  sessions: Set<string>
  rounds: number
  occupancy: number[]
  cacheHit: number[]          // ACP 侧
  provCacheHit: number[]      // Provider 侧
  compressRatio: number[]
  retention: number[]
  lastBlocks: PreModelEv['blocks']
}

function run(): void {
  const args = process.argv.slice(2)
  const globArg = args.find((a) => a.startsWith('--glob='))?.slice(7)
  const sessGlobArg = args.find((a) => a.startsWith('--sessions='))?.slice(11)
  if (!globArg) {
    console.error('需要 --glob 参数指定遥测文件路径，如 --glob=~/.harness/sessions/*.telemetry.jsonl')
    process.exit(1)
  }

  // 1) 读遥测事件
  const events: Ev[] = []
  for (const p of glob(globArg)) events.push(...readJsonl(p))

  // 2) 可选：每 session 按 round 拼 Provider 侧 cacheRead（命中 token/请求 token）
  const provCache = new Map<string, Map<number, number>>() // sessionId -> round -> hitRate
  if (sessGlobArg) {
    for (const p of glob(sessGlobArg)) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf8'))
        const sid = data.id ?? p.replace(/^.*\//, '').replace(/\.json$/, '')
        const byRound = new Map<number, number>()
        let r = 0
        for (const msg of data.messages ?? []) {
          if (msg.role === 'assistant' && msg.meta?.tokenUsage) {
            r++
            const tu = msg.meta.tokenUsage
            const read = tu.cacheRead ?? 0
            const inTok = tu.input_tokens ?? tu.inputTokens ?? txtLen(tu) ?? 1
            if (inTok > 0) byRound.set(r, read / inTok)
          }
        }
        if (byRound.size) provCache.set(sid, byRound)
      } catch { /* 忽略坏文件 */ }
    }
  }

  // 3) 按组合签名归并多组历史往返
  const combos = new Map<string, ComboAgg>()
  for (const ev of events) {
    if (ev.kind !== 'preModel') continue
    const key = sig(ev.params, ev.window)
    let c = combos.get(key)
    if (!c) {
      c = { key, label: label(ev.params, ev.window), window: ev.window, params: ev.params, sessions: new Set(), rounds: 0, occupancy: [], cacheHit: [], provCacheHit: [], compressRatio: [], retention: [], lastBlocks: ev.blocks }
      combos.set(key, c)
    }
    c.sessions.add(ev.sessionId)
    c.rounds++
    c.occupancy.push(ev.occupancy)
    if (ev.acpCacheHit !== null) c.cacheHit.push(ev.acpCacheHit)
    c.compressRatio.push(ev.compressRatio)
    c.retention.push(ev.retention)
    if (ev.emergencyCompressed) c.lastBlocks = ev.blocks
    const pc = provCache.get(ev.sessionId)?.get(ev.round)
    if (pc !== undefined) c.provCacheHit.push(pc)
  }

  const rows = [...combos.values()]
  if (rows.length === 0) { console.log('未读到任何 preModel 事件'); process.exit(0) }

  // 4) 按窗口分组输出
  const byWindow = new Map<number, ComboAgg[]>()
  for (const r of rows) {
    if (!byWindow.has(r.window)) byWindow.set(r.window, [])
    byWindow.get(r.window)!.push(r)
  }

  console.log(`\n## 参数组合 × 指标 分析（${events.length} 条事件，${combos.size} 组合）\n`)

  for (const [win, arr] of byWindow) {
    console.log(`\n### 窗口 ${win}\n`)
    console.log(`| 组合 | 会话数 | 轮数 | 占用率(avg) | ACP缓存命中(avg) | Provider缓存命中(avg) | 压缩比 | 保留率 | t1/t2/t3 |`)
    console.log(`|--|--|--|--|--|--|--|--|--|`)
    for (const c of arr) {
      console.log(`| ${c.label} | ${c.sessions.size} | ${c.rounds} | ${fmtPct(avg(c.occupancy))} | ${fmtPct(avg(c.cacheHit))} | ${fmtPct(avg(c.provCacheHit))} | ${avg(c.compressRatio).toFixed(2)}x | ${fmtPct(avg(c.retention))} | ${c.lastBlocks.t1}/${c.lastBlocks.t2}/${c.lastBlocks.t3} |`)
    }
  }

  // 5) 命中率排行（ACP 缓存命中优先，其次占用率），助选参
  const ranked = [...byWindow.entries()]
    .slice()
    .sort((a, b) => a[0] - b[0])
  if (ranked.length >= 2) {
    console.log(`\n### ACP 缓存命中率排行（跨窗口，按命中降序）\n`)
    const all = rows.slice().sort((a, b) => (avg(b.cacheHit) || 0) - (avg(a.cacheHit) || 0))
    console.log(`| 名次 | 组合 | ACP缓存命中 | 占用率 | 压缩比 |`)
    console.log(`|--|--|--|--|--|`)
    all.slice(0, 15).forEach((c, i) => {
      console.log(`| ${i + 1} | ${c.label} | ${fmtPct(avg(c.cacheHit))} | ${fmtPct(avg(c.occupancy))} | ${avg(c.compressRatio).toFixed(2)}x |`)
    })
  }
}

// tokenUsage 不同 provider 字段名兜底（仅此处离线解析用）
function txtLen(tu: Record<string, unknown>): number | undefined {
  const v = tu.inputTextTokens ?? tu.prompt_tokens ?? tu.promptTokens
  return typeof v === 'number' ? v : undefined
}

run()