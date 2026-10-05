/**
 * 注入块组装 + 逐字稳定缓存（阶段二）。
 *
 * ## 两个约束决定了这里的形状
 *
 * 1. **注入文本必须逐字稳定**（设计稿 D8）。计划没变时，注入块必须与上一轮完全相同 ——
 *    否则「计划块 → 新消息」这一段的 prefill 每轮都失配，尾部注入省下的缓存又赔回去。
 *    做法：先对三文件取**签名**（size+mtime），签名不变就直接复用上轮文本，连重算都不做。
 * 2. **注入的是一份可以人读的文本，不是 JSON**。模型读它、用户也可能从日志里看它；
 *    格式固定成 `===BEGIN PLAN DATA===` 块，便于人眼扫、也便于排查"模型怎么知道计划的"。
 *
 * ## 无时间戳
 * 块内**不放时间**（`Date.now()` 之类）。理由不是洁癖：本模块的输出要参与"逐字一致"断言，
 * 任何随时刻变化的字段都会让那条断言变成假的（测不出真正的稳定性）。
 */

import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PLAN_FILE_NAMES, shortHash, type AttestationVerdict, type ParsedPlan } from './plan-files'

export const PLAN_BLOCK_BEGIN = '===BEGIN PLAN DATA==='
export const PLAN_BLOCK_END = '===END PLAN DATA==='

/** 注入块字符预算（近似 token 上限；中文约 1.5 字符/token，1200 字符 ≈ 400 token 量级） */
export const DEFAULT_MAX_CHARS = 1200

export type PlanInjectMode = 'smart' | 'full'

export interface PlanBlockOptions {
  mode: PlanInjectMode
  maxChars?: number
  /** 展示用计划路径（如 `.planning/task_plan.md`） */
  planPath: string
}

export interface PlanBlockInput {
  parsed: ParsedPlan
  verdict: AttestationVerdict
  options: PlanBlockOptions
}

/**
 * 三文件签名：`name:size:mtime` 逐个拼接后取 sha256。
 *
 * 为什么不用内容哈希：注入路径**每轮**都会跑，读三个文件全文只为算签名是浪费；
 * size+mtime 在"人改文件"这个尺度上足够灵敏（同尺寸同毫秒的改写才会漏，而那意味着
 * 模型在同一毫秒内写了两次，实际不可能）。真正需要内容级判定的是 attestation，
 * 那里用的就是内容哈希（`hashPlan`）。
 */
export function planSignature(root: string): string {
  const parts: string[] = []
  for (const name of PLAN_FILE_NAMES) {
    const p = join(root, name)
    let size = 0
    let mtime = 0
    try {
      if (existsSync(p)) {
        const st = statSync(p)
        size = st.size
        mtime = st.mtimeMs
      }
    } catch {
      size = 0
      mtime = 0
    }
    parts.push(`${name}:${size}:${mtime}`)
  }
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex')
}

/** 单行截断（超长加省略号；不截断为 0 长度） */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`
}

function progressLine(parsed: ParsedPlan): string {
  if (parsed.totalCount === 0) return '完成度: 0/0（task_plan.md 尚未填写条目）'
  return `完成度: ${parsed.doneCount}/${parsed.totalCount}`
}

function currentPhaseLine(parsed: ParsedPlan): string {
  if (parsed.complete) return `当前阶段: 无（全部完成 ${parsed.doneCount}/${parsed.totalCount}）`
  const p = parsed.activePhase
  if (p === undefined) return '当前阶段: 无（尚无条目）'
  const title = p.index === 0 ? p.title : `Phase ${p.index}${p.title === '' ? '' : `: ${p.title}`}`
  return `当前阶段: ${title}（进行中 ${p.doneCount}/${p.totalCount}）`
}

function attestLine(verdict: AttestationVerdict): string {
  switch (verdict.status) {
    case 'ok':
      return `认证: ${shortHash(verdict.approved ?? verdict.current)}（已认证）`
    case 'missing':
      return '认证: 未认证（改动计划后运行 /plan-attest 可锁定当前版本）'
    default:
      return `认证: ${shortHash(verdict.current)}（与已认证 ${shortHash(verdict.approved ?? '')} 不一致）`
  }
}

/** 篡改块：**只注入告警行，不注入计划正文**（设计稿 D4） */
function tamperedBlock(opts: PlanBlockOptions, verdict: AttestationVerdict): string {
  return [
    PLAN_BLOCK_BEGIN,
    `计划: ${opts.planPath}`,
    '[PLAN TAMPERED] task_plan.md 自上次 /plan-attest 之后被改动过。',
    `  已认证: ${shortHash(verdict.approved ?? '')}`,
    `  当前:   ${shortHash(verdict.current)}`,
    '  计划正文**已拒绝注入**。若这次改动是你本人（模型）写的 ⇒ 先自查改动，再运行 /plan-attest 重新认证；',
    '  若不是 ⇒ 视为外部篡改，先与用户确认再继续。',
    PLAN_BLOCK_END,
  ].join('\n')
}

/**
 * 组装注入块。
 *
 * 返回 `undefined` 只在一种情况下：`maxChars` 小到连最小块都放不下（极端配置），
 * 此时宁可不注入也不注入半截 —— 半截计划比没有计划更误导。
 */
export function buildPlanBlock(input: PlanBlockInput): string | undefined {
  const { parsed, verdict, options } = input
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS

  if (verdict.status === 'mismatch') {
    const text = tamperedBlock(options, verdict)
    return text.length <= maxChars ? text : undefined
  }

  const head: string[] = [PLAN_BLOCK_BEGIN, `计划: ${options.planPath}`]
  if (parsed.goal !== undefined && parsed.goal !== '') head.push(`目标: ${clip(parsed.goal, 200)}`)
  head.push(currentPhaseLine(parsed))
  if (parsed.nextStep !== undefined && parsed.nextStep !== '') head.push(`下一步: ${clip(parsed.nextStep, 200)}`)
  head.push(progressLine(parsed))
  head.push(attestLine(verdict))

  const tail: string[] = [PLAN_BLOCK_END]

  if (options.mode === 'full') {
    const detail: string[] = ['阶段明细:']
    for (const p of parsed.phases) {
      if (p.items.length === 0) continue
      const label = p.index === 0 ? p.title : `Phase ${p.index}${p.title === '' ? '' : `: ${p.title}`}`
      detail.push(`  ${p.doneCount === p.totalCount ? '[x]' : '[ ]'} ${label}（${p.doneCount}/${p.totalCount}）`)
      for (const it of p.items) {
        if (it.done) continue
        detail.push(`      - [ ] ${clip(it.text, 120)}`)
      }
    }
    if (detail.length === 1) detail.push('  （无条目）')
    const full = [...head, ...detail, ...tail].join('\n')
    if (full.length <= maxChars) return full
    // 超预算：先砍明细（smart 形态），下面继续走降级
  }

  let text = [...head, ...tail].join('\n')
  if (text.length <= maxChars) return text

  // 逐级降级：目标 → 下一步 → 认证行，最后只剩"计划路径 + 当前阶段"
  const minimal: string[] = [PLAN_BLOCK_BEGIN, `计划: ${options.planPath}`, currentPhaseLine(parsed), PLAN_BLOCK_END]
  if (minimal.join('\n').length <= maxChars) {
    // 砍掉最长的可选行（目标 / 下一步）后仍超 ⇒ 只留最小块
    const withoutGoal = head.filter((l) => !l.startsWith('目标: '))
    const withoutNext = withoutGoal.filter((l) => !l.startsWith('下一步: '))
    const withoutAttest = withoutNext.filter((l) => !l.startsWith('认证: '))
    for (const candidate of [withoutGoal, withoutNext, withoutAttest]) {
      text = [...candidate, ...tail].join('\n')
      if (text.length <= maxChars) return text
    }
    return minimal.join('\n')
  }
  return undefined
}

export interface InjectCache {
  sig?: string
  block?: string
}

export interface ResolvedBlock {
  /** 本轮要注入的文本；`undefined` = 不注入 */
  text?: string
  /** 本轮签名（不论是否命中缓存都返回） */
  sig: string
  /** 是否命中"逐字复用"（供 /plan-doctor 与测试观察） */
  reused: boolean
}

/**
 * 取本轮注入块：**签名不变 ⇒ 逐字复用上轮文本**（D8 的落点）。
 *
 * 注意"命中"的判据是**签名**而不是"文本相等" —— 签名一样就不需要重新读盘与组装，
 * 这才是这条优化真正的收益（也保证复用出来的文本必然逐字相同）。
 */
export function resolveInjectedBlock(
  cache: InjectCache,
  root: string,
  opts: PlanBlockOptions,
  build: (opts: PlanBlockOptions) => string | undefined,
): ResolvedBlock {
  const sig = planSignature(root)
  if (cache.sig === sig && cache.block !== undefined) return { text: cache.block, sig, reused: true }
  const text = build(opts)
  cache.sig = sig
  if (text === undefined) {
    delete cache.block
  } else {
    cache.block = text
  }
  return text === undefined ? { sig, reused: false } : { text, sig, reused: false }
}
