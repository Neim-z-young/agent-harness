/**
 * 离线分析：读 ACP 遥测 JSONL 文件（可选拼 session 文件 tokenUsage），
 * 输出和压测脚本同口径的 Markdown 报告，便于事后调参。
 *
 * 用法：
 *   bun run bench/report.ts \
 *       --glob='~/.harness/sessions/*.telemetry.jsonl' \
 *       --sessions='~/.harness/sessions/*.json'   # 可选：补 provider 侧 cacheRead
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

interface PreModelEv { kind: 'preModel'; sessionId: string; round: number; window: number; params: any; rawTok: number; requestTok: number; occupancy: number; compressRatio: number; retention: number; acpCacheHit: number | null; blocks: { t1: number; t2: number; t3: number }; suggestedRanges: number; emergencyCompressed: boolean; ts: number }
interface CompressEv { kind: 'compress'; sessionId: string; round: number; window: number; ranges: any[]; createdBlocks: number; tokensCompressed: number; blocksAfter: { t1: number; t2: number; t3: number }; ts: number }
interface ProviderCacheEv { kind: 'providerCache'; sessionId: string; round: number; cacheRead: number; cacheWrite: number; requestTok: number; ts: number }
type Ev = PreModelEv | CompressEv | ProviderCacheEv

function glob(pattern: string): string[] {
  // 简化实现：支持 *.jsonl 结尾的模式，在同一目录下列出匹配文件
  const tildeExpanded = pattern.replace(/^~/, process.env.HOME ?? '')
  const star = tildeExpanded.indexOf('*')
  if (star === -1) return existsSync(tildeExpanded) ? [tildeExpanded] : []
  const dir = tildeExpanded.slice(0, tildeExpanded.lastIndexOf('/', star))
  const prefix = tildeExpanded.slice(dir.length + 1, star)
  const rest = tildeExpanded.slice(star + 1)
  if (!dir || !existsSync(dir)) return []
  const files = readdirSync(dir)
  const re = new RegExp('^' + prefix.replace(/\./g, '\\.') + '.*' + rest.replace(/\./g, '\\.') + '$')
  return files.filter((f) => re.test(f)).map((f) => join(dir, f))
}

function readJsonl(path: string): Ev[] {
  const out: Ev[] = []
  if (!existsSync(path)) return out
  const text = readFileSync(path, 'utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 忽略坏行 */ }
  }
  return out
}

function pct(nums: number[]): { avg: number; p50: number; p95: number; min: number; max: number } {
  if (nums.length === 0) return { avg: 0, p50: 0, p95: 0, min: 0, max: 0 }
  const s = [...nums].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))]
  const sum = s.reduce((a, b) => a + b, 0)
  return { avg: sum / s.length, p50: q(0.5), p95: q(0.95), min: s[0], max: s[s.length - 1] }
}

function fmt(x: number): string { return `${(x * 100).toFixed(1)}%` }

function run(): void {
  const args = process.argv.slice(2)
  const glob = args.find((a) => a.startsWith('--glob='))?.slice(7)
  const sessGlob = args.find((a) => a.startsWith('--sessions='))?.slice(11)

  if (!glob) {
    console.error('需要 --glob 参数指定遥测文件路径，如 --glob=~/.harness/sessions/*.telemetry.jsonl')
    process.exit(1)
  }

  const paths = glob(glob.replace(/^~/, process.env.HOME ?? ''))
  console.log(`\n## ACP 遥测分析：${paths.length} 个会话\n`)

  // 读遥测
  const perSession = new Map<string, Ev[]>()
  for (const p of paths) {
    const evs = readJsonl(p)
    if (evs.length === 0) continue
    const sid = evs[0].sessionId
    perSession.set(sid, evs)
  }

  // 可选读 session 文件的 tokenUsage（provider 侧 cacheRead/cacheWrite）
  const provCache = new Map<string, Map<number, { cacheRead: number; cacheWrite: number }>>()
  if (sessGlob) {
    const spaths = glob(sessGlob.replace(/^~/, process.env.HOME ?? ''))
    for (const p of spaths) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf8'))
        const sid = data.id ?? p.replace(/^.*\//, '').replace(/\.json$/, '')
        const round2tok = new Map<number, { cacheRead: number; cacheWrite: number }>()
        let r = 0
        for (const msg of data.messages ?? []) {
          if (msg.role === 'assistant' && msg.meta?.tokenUsage) {
            r++
            const tu = msg.meta.tokenUsage
            if (tu.cacheRead !== undefined || tu.cacheWrite !== undefined) {
              round2tok.set(r, { cacheRead: tu.cacheRead ?? 0, cacheWrite: tu.cacheWrite ?? 0 })
            }
          }
        }
        if (round2tok.size > 0) provCache.set(sid, round2tok)
      } catch { /* 忽略坏文件 */ }
    }
  }

  // 逐会话统计
  const agg: Array<{
    sid: string; rounds: number; window: number;
    occupancy: number; compressRatio: number; retention: number;
    acpCacheHit: number | null; provCacheHit: number | null;
    t1: number; t2: number; t3: number;
    params: any;
  }> = []

  for (const [sid, evs] of perSession) {
    const preMs = evs.filter((e): e is PreModelEv => e.kind === 'preModel')
    if (preMs.length === 0) continue
    const last = preMs[preMs.length - 1]
    const occ = pct(preMs.map((e) => e.occupancy))
    const ratio = pct(preMs.map((e) => e.compressRatio))
    const ret = pct(preMs.map((e) => e.retention))
    const acpHits = preMs.map((e) => e.acpCacheHit).filter((h): h is number => h !== null)
    const acpHit = acpHits.length ? acpHits.reduce((s, x) => s + x, 0) / acpHits.length : null

    // provider 侧缓存命中率（cacheRead / requestTok）
    let provHit: number | null = null
    const pc = provCache.get(sid)
    if (pc) {
      const rates: number[] = []
      for (const ev of preMs) {
        const p = pc.get(ev.round)
        if (p && ev.requestTok > 0) rates.push(p.cacheRead / ev.requestTok)
      }
      provHit = rates.length ? rates.reduce((s, x) => s + x, 0) / rates.length : null
    }

    agg.push({
      sid,
      rounds: preMs.length,
      window: last.window,
      occupancy: occ.avg,
      compressRatio: ratio.avg,
      retention: ret.avg,
      acpCacheHit: acpHit,
      provCacheHit: provHit,
      t1: last.blocks.t1,
      t2: last.blocks.t2,
      t3: last.blocks.t3,
      params: last.params,
    })
  }

  // 输出主表
  console.log('### 会话汇总\n')
  console.log(`| sessionId | 轮数 | 窗口 | 压缩比 | 占用率 | ACP缓存命中 | Provider缓存命中 | t1/t2/t3 |`)
  console.log(`|--|--|--|--|--|--|--|--|`)
  for (const a of agg) {
    console.log(`| ${a.sid.slice(0, 12)} | ${a.rounds} | ${a.window} | ${a.compressRatio.toFixed(2)}x | ${fmt(a.occupancy)} | ${a.acpCacheHit !== null ? fmt(a.acpCacheHit) : '-'} | ${a.provCacheHit !== null ? fmt(a.provCacheHit) : '-'} | ${a.t1}/${a.t2}/${a.t3} |`)
  }

  // 参数扫描：按 window 分组，看不同参数组合下的指标
  if (agg.length > 1) {
    console.log('\n### 参数敏感性（按窗口分组）\n')
    const groups = new Map<number, typeof agg>()
    for (const a of agg) {
      if (!groups.has(a.window)) groups.set(a.window, [])
      groups.get(a.window)!.push(a)
    }
    for (const [win, arr] of groups) {
      console.log(`\n**窗口 ${win}**（${arr.length} 个会话）\n`)
      console.log(`| 会话 | 压缩比 | 占用率 | ACP缓存命中 | t1/t2/t3 | preserveTokens | tier2 | tier3 |`)
      console.log(`|--|--|--|--|--|--|--|--|`)
      for (const a of arr) {
        console.log(`| ${a.sid.slice(0, 12)} | ${a.compressRatio.toFixed(2)}x | ${fmt(a.occupancy)} | ${a.acpCacheHit !== null ? fmt(a.acpCacheHit) : '-'} | ${a.t1}/${a.t2}/${a.t3} | ${a.params.preserveRecentTokens} | ${a.params.tier2Trigger} | ${a.params.tier3Trigger} |`)
      }
    }
  }

  // 总体
  if (agg.length >= 3) {
    const occAll = pct(agg.map((a) => a.occupancy))
    const ratioAll = pct(agg.map((a) => a.compressRatio))
    const acpAll = pct(agg.filter((a) => a.acpCacheHit !== null).map((a) => a.acpCacheHit!))
    const provAll = pct(agg.filter((a) => a.provCacheHit !== null).map((a) => a.provCacheHit!))
    console.log(`\n### 总体统计\n`)
    console.log(`| 指标 | avg | p50 | p95 | min | max |`)
    console.log(`|--|--|--|--|--|--|`)
    console.log(`| 压缩比 | ${ratioAll.avg.toFixed(2)}x | ${ratioAll.p50.toFixed(2)}x | ${ratioAll.p95.toFixed(2)}x | ${ratioAll.min.toFixed(2)}x | ${ratioAll.max.toFixed(2)}x |`)
    console.log(`| 占用率 | ${fmt(occAll.avg)} | ${fmt(occAll.p50)} | ${fmt(occAll.p95)} | ${fmt(occAll.min)} | ${fmt(occAll.max)} |`)
    if (acpAll.min > 0 || acpAll.max > 0)
      console.log(`| ACP缓存命中 | ${fmt(acpAll.avg)} | ${fmt(acpAll.p50)} | ${fmt(acpAll.p95)} | ${fmt(acpAll.min)} | ${fmt(acpAll.max)} |`)
    if (provAll.min > 0 || provAll.max > 0)
      console.log(`| Provider缓存命中 | ${fmt(provAll.avg)} | ${fmt(provAll.p50)} | ${fmt(provAll.p95)} | ${fmt(provAll.min)} | ${fmt(provAll.max)} |`)
  }
}

run()
