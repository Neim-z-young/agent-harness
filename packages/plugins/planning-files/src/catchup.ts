/**
 * catchup：把「本会话已经发生过什么」从会话文件里捞出来，追加进 `progress.md`。
 *
 * ## 为什么是**显式触发**而不是每轮自动跑
 * 它是 O(会话长度) 的读盘 + 组装，每轮跑等于给每轮加一次全量读；而且它写的是
 * **人读日志**，自动写会让 `progress.md` 被机器噪声灌满。设计稿阶段四把 catchup
 * 定为显式触发，理由就在这里。
 *
 * ## 为什么用 marker 做幂等，而不是"内容比对"
 * `progress.md` 是**追加式**文件（见模板的说明），同一条命令被连敲两次是最常见的
 * 误操作。去重不能靠比对内容 —— 同一天的两轮本来就可能写得很像，但也不该被判成重复。
 * 只能靠**显式标记**：每个 sessionId 一份 `<!-- plan-catchup:<sid> -->` marker，
 * 已存在就跳过。marker 用 HTML 注释，渲染成 markdown 时不显示。
 *
 * ## 时间戳
 * 这里的输出**带时间戳**，与本插件注入块"不含时间戳"的规矩不冲突 ——
 * 注入块要参与"逐字一致"断言，落盘日志不需要，而且人读日志没有时间就没法看。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 幂等标记前缀（进度文件里出现它即代表该会话已 catchup 过） */
export const CATCHUP_MARKER_PREFIX = '<!-- plan-catchup:'

/** 某会话的幂等标记 */
export function catchupMarker(sessionId: string): string {
  return `${CATCHUP_MARKER_PREFIX}${sessionId} -->`
}

/** 该 sessionId 是否已经 catchup 过 */
export function hasCatchup(progressMd: string, sessionId: string): boolean {
  return progressMd.includes(catchupMarker(sessionId))
}

/** 会话文件里的一条消息（结构最小接口，只取需要的字段） */
export interface CatchupMessageLike {
  role?: string
  parts?: Array<{ type?: string; text?: string }>
}

export interface CatchupTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface CatchupExtract {
  /** 收录的轮次（按时间正序） */
  turns: CatchupTurn[]
  /** 因预算被丢掉的轮数（诚实告知条数，不假装完整） */
  dropped: number
  /** 符合条件的总轮数（含被丢的） */
  total: number
}

export interface CatchupOptions {
  /** 最多收录几轮（从最新的往回取），缺省 12 */
  maxTurns?: number
  /** 每轮最多多少字符，缺省 200 */
  maxCharsPerTurn?: number
}

/**
 * 我们自己的注入块不该出现在 catchup 记录里。
 *
 * 正常情况下注入块**不落历史**（`preModel` 不调 `save`），所以它本不该在会话文件里；
 * 但**别的**插件可能以同样方式注入、或历史里有遗留的旧块 —— 与其假设，不如识别。
 */
const INJECTED_BLOCK_RE = /^===\s*BEGIN\s+PLAN\s+DATA\s*===/i

/** 折成单行 + 截断（进度日志一行一条才好扫） */
function clipLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(1, max - 1))}…`
}

/**
 * 从消息列表里提取可汇总的轮次：只取 user / assistant 的文本，从**最新的往回**取。
 *
 * 往回取的理由：catchup 的典型场景是"这个会话已经跑了一阵，把进展落个盘"，
 * 最有价值的是最近发生的事，而不是开头那句寒暄。
 */
export function extractCatchupTurns(messages: readonly CatchupMessageLike[], opts: CatchupOptions = {}): CatchupExtract {
  const maxTurns = opts.maxTurns ?? 12
  const maxChars = opts.maxCharsPerTurn ?? 200
  const picked: CatchupTurn[] = []
  let total = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const role = m?.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = (m.parts ?? [])
      .filter((p) => (p?.type ?? 'text') === 'text' && typeof p.text === 'string')
      .map((p) => String(p.text))
      .join('\n')
      .trim()
    if (text === '' || INJECTED_BLOCK_RE.test(text)) continue
    total += 1
    if (picked.length >= maxTurns) continue // 超出预算仍要继续数 total，才能如实报告 dropped
    picked.push({ role, text })
  }

  picked.reverse()
  const turns = picked.map((t) => ({ role: t.role, text: clipLine(t.text, maxChars) }))
  return { turns, dropped: total - turns.length, total }
}

export interface CatchupRenderInput {
  sessionId: string
  /** 会话标题（可选，写进小标题便于人认） */
  title?: string
  extract: CatchupExtract
  /** 写入时刻（ms） */
  at: number
  /** 会话文件路径（写进正文，便于回溯原始记录） */
  source?: string
}

/** 本地时间 `YYYY-MM-DD HH:mm`（人读日志，不做时区换算） */
function formatStamp(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 渲染一个 catchup 节（**含**幂等 marker，调用方直接 append 即可） */
export function renderCatchupSection(input: CatchupRenderInput): string {
  const { extract } = input
  const lines: string[] = [catchupMarker(input.sessionId)]
  lines.push(`### Catchup ${formatStamp(input.at)}${input.title === undefined || input.title === '' ? '' : `（${input.title}）`}`)
  lines.push('')
  if (input.source !== undefined && input.source !== '') lines.push(`> 来源：${input.source}`)
  if (extract.turns.length === 0) {
    lines.push('（本会话没有可汇总的 user/assistant 文本）')
    return lines.join('\n')
  }
  if (extract.dropped > 0) {
    lines.push(`> 只收录最近 ${extract.turns.length} 轮；更早的 ${extract.dropped} 轮未收录。`)
  }
  if ((input.source !== undefined && input.source !== '') || extract.dropped > 0) lines.push('')
  for (const t of extract.turns) lines.push(`- ${t.role === 'user' ? '用户' : '助手'}：${t.text}`)
  return lines.join('\n')
}

/**
 * 追加一节到 `progress.md`（追加式：原文一字不动，新节接在末尾）。
 * 空文件不产生多余空行。
 */
export function appendCatchupSection(progressMd: string, section: string): string {
  const base = progressMd.trimEnd()
  return base === '' ? `${section}\n` : `${base}\n\n${section}\n`
}

export interface CatchupResult {
  /** 新的 progress.md 内容 */
  md: string
  /** 因为已有同会话 marker 而跳过 */
  skipped: boolean
  extract: CatchupExtract
}

/**
 * 一次性完成"提取 → 渲染 → 追加"，并保证幂等。
 *
 * 抽成一个函数（而不是让命令层自己拼）是因为幂等这条最容易在拼的时候漏掉 ——
 * 命令层只该决定"读哪个文件、写回哪里"。
 */
export function buildCatchup(
  progressMd: string,
  sessionId: string,
  messages: readonly CatchupMessageLike[],
  opts: CatchupOptions & { at?: number; title?: string; source?: string } = {},
): CatchupResult {
  const extract = extractCatchupTurns(messages, opts)
  if (hasCatchup(progressMd, sessionId)) return { md: progressMd, skipped: true, extract }
  const at = opts.at ?? Date.now()
  const section = renderCatchupSection({
    sessionId,
    extract,
    at,
    ...(opts.title === undefined ? {} : { title: opts.title }),
    ...(opts.source === undefined ? {} : { source: opts.source }),
  })
  return { md: appendCatchupSection(progressMd, section), skipped: false, extract }
}

/** 会话文件的**最小**结构（只声明 catchup 需要的字段） */
export interface SessionFileLike {
  title?: string
  messages?: CatchupMessageLike[]
}

/**
 * 读 `<dataDir>/sessions/<sessionId>.json`（容错：缺失 / 损坏 / 非对象 ⇒ undefined）。
 *
 * 刻意不 import `@harness/workspace` 的 `SessionFileStore`：那个包依赖
 * `@harness/session`，而插件层要保持轻量（与 `plan-files.ts` 不依赖 core 同一取舍）。
 * 代价是这里要自己拼路径 —— 路径口径由调用方给的 `dataDir` 决定，不再二次推断。
 */
export function readSessionFile(dataDir: string, sessionId: string): { path: string; file: SessionFileLike } | undefined {
  if (sessionId === '') return undefined
  const path = join(dataDir, 'sessions', `${sessionId}.json`)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    // 数组也是 object，但它是"另一个 JSON 文档"而不是会话文件 —— 明确拒掉，别把 [] 当成合法会话
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const o = raw as { title?: unknown; messages?: unknown }
    const messages = Array.isArray(o.messages) ? (o.messages as CatchupMessageLike[]) : []
    return {
      path,
      file: { ...(typeof o.title === 'string' ? { title: o.title } : {}), messages },
    }
  } catch {
    return undefined
  }
}
