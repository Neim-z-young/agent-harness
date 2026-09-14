/**
 * @harness/acp-context ACP 压缩率压测（可复用，手动运行）
 *
 * 目标：模拟「模型使用 ACP」在不同上下文长度（40k / 100k / 200k / 300k / 1m token）
 * 下的输入瘦身压缩率。压缩率口径：
 *
 *   baseTok  = 无 ACP 时发往模型的 token（系统提示 + 全量历史）
 *   requTok  = 经 runPreModel 投影后真正发往模型的 token
 *   保留率 = requTok / baseTok（越小越好）
 *   压缩比 = baseTok / requTok（如 12.5x）
 *
 * token 估算 = chars/4（与 acp-kernel 默认 tokenizer 一致，见 adapter.estimateTokens）。
 * 直接调用 runPreModel（纯 kernel processTurn，无需真实模型），合成历史按目标 token
 * 拆成等长消息（每条固定 token 数），便于 kernel 按窗口折叠。
 *
 * 用法：
 *   bun run bench/ratio.ts --lengths=40000,100000,200000,300000,1000000 \
 *       --keep=0,8000 --perMsg=400
 *
 * 输出 Markdown 表格；切换真实 "模型摘要" 只需替换 defaultRuleSummary 类摘要源（kernel 内）。
 */

import { toCores, estimateTokens } from '../src/adapter'
import { createCore, createInitialState, defaultConfig } from 'acp-kernel'
import type { Message } from '@harness/session'
import type { Config, CoreMessage } from 'acp-kernel'

// ===== 参数 =====
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

/** 生成目标 token 长度的合成历史：拆成等长消息，便于 ACP 按层折叠 */
function genHistory(targetTokens: number, perMsgTokens: number): Message[] {
  const perMsgChars = Math.max(4, perMsgTokens * 4) // chars/4 ≈ token
  const n = Math.max(1, Math.ceil((targetTokens * 4) / perMsgChars))
  const msg: Message[] = []
  const pad = 'Sentence with enough repeated words to reach the length. '
  const hr = Math.ceil(perMsgChars / pad.length)
  const body = pad.repeat(hr).slice(0, perMsgChars)
  for (let i = 0; i < n; i++) {
    msg.push({
      id: `h${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: body }],
      createdAt: i,
    })
  }
  return msg
}

/** 按 ch/4 估算 Message[] 的 token（含系统提示） */
function tokOf(msgs: Message[]): number {
  return estimateTokens(toCores(msgs).cores)
}

function buildConfig(keepRecent: number, contextWindow: number) {
  return defaultConfig(contextWindow, {
    compress: { minCompressRange: 0, maxSummaryLength: 25000, minSummaryLength: 30 },
    preserveRecentMessages: 0,
    preserveRecentTokens: keepRecent,
    promotionThreshold: 1e9, // 禁 promote，压测只看折叠
    nudge: {
      maxContextLimitPct: 0.2,
      minContextLimitPct: 0.02,
      frequency: 10000, // 高频抑制 warning 注入频率
      iterationThreshold: 10000,
      force: 'soft',
      growthRatio: 0.1,
      growthFloor: 1,
      growthCap: 5000,
      minGrowthFloor: 1,
      minGrowthRatio: 0,
      emergencyThresholdPct: 0.95,
      tier2GrowthMultiplier: 1,
    },
  })
}

/** 模型摘要占位：真实模型会为每个折叠块写一段梗概，这里用固定中等长度近似（≈50 token/块）。 */
const SUMMARY_PLACEHOLDER =
  'This block summarizes earlier conversation context to reclaim window space for continued work. It condenses key prior decisions and facts so downstream steps stay coherent without re-reading the full exchange. '

async function measure(
  targetTokens: number,
  perMsgTokens: number,
  keepRecent: number,
): Promise<Record<string, number>> {
  // 关键口径：把上下文窗口设为「目标长度」，让该长度窗口满载即触发压缩，
  // 测得"上下文窗口=该长度的模型在使用 ACP"满载于窗口时的压缩率。
  const engine = createCore()
  const config = buildConfig(keepRecent, targetTokens)
  const history = genHistory(targetTokens, perMsgTokens)
  const baseTok = tokOf(history) + Math.ceil(SYSPROMPT.length / 4)
  const sysAdd = Math.ceil(SYSPROMPT.length / 4)

  // 模拟「理性模型」：每轮 processTurn 得到 ACP 建议的可压缩范围（compressibleRanges），
  // 立即按建议调用 applyCompression 折叠（等价于模型每次都顺从 ACP 建议压缩）。
  // 直到 ACP 不再建议（无可压缩内容），收敛即"该上下文长度下模型主动压缩的稳态"。
  let state = createInitialState()
  let messages: CoreMessage[] = toCores(history).cores
  let blocksCreated = 0
  let tokensCompressed = 0
  let requTok = baseTok

  for (let iter = 0; iter < 500; iter++) {
    const tok = estimateTokens(messages)
    const res = engine.processTurn({
      messages,
      state,
      config,
      tokenCount: tok,
      renderTags: 'text-only',
    })
    state = res.state
    requTok = estimateTokens(res.messages) + sysAdd
    const ranges = res.nudge?.compressibleRanges ?? []
    if (ranges.length === 0) break
    const applied = engine.applyCompression({
      ranges: ranges.map((r) => ({
        startRef: r.startRef,
        endRef: r.endRef,
        summary: SUMMARY_PLACEHOLDER,
        topic: 'acp-bench',
        chars: r.chars,
      })),
      messages: res.messages,
      state,
      config,
      tokenCount: tok,
    })
    state = applied.state
    blocksCreated += applied.result.blocksCreated
    tokensCompressed += applied.result.tokensCompressed
    messages = res.messages
  }

  return {
    baseTok,
    requTok,
    blocks: state.blocks.length,
    folded: tokensCompressed,
    recorded: blocksCreated,
  }
}

async function run(): Promise<void> {
  const args = parseArgs()
  const lengths = (args.lengths ?? '40000,100000,200000,300000,1000000').split(',').map((s) => parseInt(s.trim(), 10))
  const keeps = (args.keep ?? '0,8000').split(',').map((s) => parseInt(s.trim(), 10))
  const perMsg = parseInt(args.perMsg ?? '400', 10)

  console.log(`| 上下文长度 | 保留近期 | 原文 token | 请求 token | 保留率 | 压缩比 | 块数 | 被压 token |`)
  console.log(`|--|--|--|--|--|--|--|--|`)
  for (const len of lengths) {
    for (const keep of keeps) {
      const r = await measure(len, perMsg, keep)
      const keepTag = keep === 0 ? '全压' : `${keep}`
      console.log(
        `| ${len} | ${keepTag} | ${r.baseTok} | ${r.requTok} | ${((r.requTok / r.baseTok) * 100).toFixed(2)}% | ${(r.baseTok / r.requTok).toFixed(2)}x | ${r.blocks} | ${r.folded} |`,
      )
    }
  }
}

await run()