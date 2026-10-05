/**
 * @harness/planning-files —— 计划文件模型（阶段一：纯 TS，无 shell 依赖）
 *
 * 三文件模式（对齐上游 planning-with-files）：
 *
 * | 文件 | 作用 | 谁写 |
 * |---|---|---|
 * | `task_plan.md` | 阶段 + 复选框（**唯一的进度权威**） | 模型经 `write_file` 改，改完 `/plan-attest` |
 * | `findings.md` | 调研笔记（事实 + 证据位置） | 模型 |
 * | `progress.md` | 追加式进度日志（怎么走到这里的） | 模型 |
 *
 * 落点 `.planning/`（不污染仓库根；支持 `.active_plan` 多计划；建议 gitignore）。
 *
 * ## 为什么解析要写成纯函数 + 目录参数
 * 本模块**不读进程 cwd、不碰全局单例** —— 调用方给目录。这样单测可以直接拿
 * `mkdtemp` 建的临时目录跑，不需要 mock fs，也不需要"先 cd 到某处"。
 * 插件装配层（`index.ts`）负责把 `ctx.workspace.cwd` 解析成这个目录。
 *
 * ## 与上游的差异（有意）
 * - **不实现 attestation 的"双向签名"**：只做「approved hash 锁」（`/plan-attest` 记下哈希，
 *   注入时比对）。纯工具模式下无法拦写盘，能不做的只有"区分已批准修改与未批准修改"。
 * - **parsePlan 不依赖上游的具体标题文案**：只认 `## Phase N` 与 `- [ ]` / `- [x]` 两种语法，
 *   其余标题当作普通章节 —— 上游模板变了不会把我们解析崩掉。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
// 模板外置为 `.txt`（**不是 `.md`**：Bun 会把 .md 转成 HTML，见 env.d.ts 的说明）
import findingsTemplate from './templates/findings.txt'
import progressTemplate from './templates/progress.txt'
import taskPlanTemplate from './templates/task_plan.txt'

/** 计划目录名（项目根下） */
export const PLAN_DIR_NAME = '.planning'
/** 三文件（顺序即展示顺序） */
export const PLAN_FILE_NAMES = ['task_plan.md', 'findings.md', 'progress.md'] as const
export type PlanFileName = (typeof PLAN_FILE_NAMES)[number]
/** approved hash 记录文件 */
export const ATTEST_FILE_NAME = '.attest.json'
/** 多计划指针文件 */
export const ACTIVE_PLAN_FILE_NAME = '.active_plan'

/** 外置模板（`/plan` 初始化时逐字写入） */
export const PLAN_TEMPLATES: Record<PlanFileName, string> = {
  'task_plan.md': taskPlanTemplate,
  'findings.md': findingsTemplate,
  'progress.md': progressTemplate,
}

// ---------------------------------------------------------------- 路径

/** 项目根 → `.planning/` 绝对路径（不做存在性检查） */
export function resolvePlanDir(cwd: string): string {
  return join(resolve(cwd), PLAN_DIR_NAME)
}

/** slug 合法性：单段、无路径分隔、无 `..` —— 防 `.active_plan` 里写穿越路径 */
export function isValidPlanSlug(slug: string): boolean {
  if (slug === '' || slug === '.' || slug === '..') return false
  if (slug.includes('/') || slug.includes('\\')) return false
  return /^[A-Za-z0-9._-]+$/.test(slug)
}

/** 读 `.active_plan`（多计划指针）；缺失或非法 ⇒ undefined */
export function readActivePlan(dir: string): string | undefined {
  const p = join(dir, ACTIVE_PLAN_FILE_NAME)
  if (!existsSync(p)) return undefined
  try {
    const slug = readFileSync(p, 'utf8').trim()
    return isValidPlanSlug(slug) ? slug : undefined
  } catch {
    return undefined
  }
}

/**
 * 写 / 清 `.active_plan`。
 *
 * 传空串或非法 slug ⇒ 删除指针（回落到 `.planning/` 根的三文件）。
 * 非法 slug **抛错而不是静默忽略** —— 静默会让调用方以为切换成功了。
 */
export function setActivePlan(dir: string, slug: string): void {
  const p = join(dir, ACTIVE_PLAN_FILE_NAME)
  if (slug.trim() === '') {
    if (existsSync(p)) rmSync(p)
    return
  }
  if (!isValidPlanSlug(slug)) throw new Error(`非法计划名 "${slug}"：只允许单段 [A-Za-z0-9._-]，不允许路径分隔符`)
  mkdirSync(dir, { recursive: true })
  atomicWrite(p, `${slug}\n`)
}

/**
 * 三文件实际所在目录：有 `.active_plan` 时是它的子目录，否则就是 `.planning/` 本身。
 * `dir` 必须是 `resolvePlanDir()` 的结果（本函数不认识 cwd）。
 */
export function resolvePlanRoot(dir: string): string {
  const slug = readActivePlan(dir)
  return slug === undefined ? dir : join(dir, slug)
}

/** 绝对路径 → 展示用的短路径（在项目根之下时给相对路径，否则原样返回绝对路径） */
export function displayPlanPath(cwd: string, abs: string): string {
  const root = resolve(cwd)
  if (abs === root) return '.'
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs
}

// ---------------------------------------------------------------- 读写

/** 原子写：同目录临时文件 + rename（避免半截文件被下一轮注入读到） */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (e) {
    if (existsSync(tmp)) rmSync(tmp)
    throw e
  }
}

export interface EnsurePlanResult {
  /** 本次新建的文件 */
  created: PlanFileName[]
  /** 本来就有、未被动过的文件 */
  existed: PlanFileName[]
}

/**
 * 幂等创建三文件（已存在的不动 —— 绝不覆盖用户/模型写过的计划）。
 *
 * `force: true` 时才用模板覆盖（`/plan --force`），这是**破坏性**操作，调用方须先确认。
 */
export function ensurePlanFiles(root: string, opts: { force?: boolean } = {}): EnsurePlanResult {
  mkdirSync(root, { recursive: true })
  const created: PlanFileName[] = []
  const existed: PlanFileName[] = []
  for (const name of PLAN_FILE_NAMES) {
    const p = join(root, name)
    if (existsSync(p) && opts.force !== true) {
      existed.push(name)
      continue
    }
    atomicWrite(p, PLAN_TEMPLATES[name])
    created.push(name)
  }
  return { created, existed }
}

/** 读三文件（缺失 ⇒ 空串，不抛错 —— 注入路径不该因为少一个文件就整轮失败） */
export function readPlanFiles(root: string): Record<PlanFileName, string> {
  const out = {} as Record<PlanFileName, string>
  for (const name of PLAN_FILE_NAMES) {
    const p = join(root, name)
    try {
      out[name] = existsSync(p) ? readFileSync(p, 'utf8') : ''
    } catch {
      out[name] = ''
    }
  }
  return out
}

/** 原子写单个计划文件（供命令用；模型改文件走 write_file，不经过这里） */
export function writePlanFile(root: string, name: PlanFileName, content: string): void {
  mkdirSync(root, { recursive: true })
  atomicWrite(join(root, name), content)
}

export interface PlanFileStatus {
  name: PlanFileName
  exists: boolean
  bytes: number
  mtimeMs: number
}

/** 三文件状态（供 /plan-doctor 自检与"计划存在吗"判定） */
export function planFileStatus(root: string): PlanFileStatus[] {
  return PLAN_FILE_NAMES.map((name) => {
    const p = join(root, name)
    try {
      const st = statSync(p)
      return { name, exists: true, bytes: st.size, mtimeMs: st.mtimeMs }
    } catch {
      return { name, exists: false, bytes: 0, mtimeMs: 0 }
    }
  })
}

/** 计划是否已初始化（判定口径：task_plan.md 存在） */
export function planInitialized(root: string): boolean {
  return existsSync(join(root, 'task_plan.md'))
}

// ---------------------------------------------------------------- 解析

export interface PlanItem {
  /** 去掉 `- [ ]` 前缀后的文本 */
  text: string
  done: boolean
  /** 源文件行号（1 起，供 /plan-status 指位） */
  line: number
}

export interface PlanPhase {
  /** 标题里的编号；无编号的前置章节为 0 */
  index: number
  title: string
  items: PlanItem[]
  doneCount: number
  totalCount: number
}

export interface ParsedPlan {
  phases: PlanPhase[]
  /** 第一个"还有未完成项"的阶段（全完成 / 无条目 ⇒ undefined） */
  activePhase?: PlanPhase
  /** **下一步**：activePhase 里第一个未完成项；无则 undefined */
  nextStep?: string
  doneCount: number
  totalCount: number
  /** 有条目且全部完成 */
  complete: boolean
  /** 目标行（`## Goal` 节下首个非空文本；否则文档首条非空非标题行） */
  goal?: string
}

const PHASE_RE = /^##\s+Phase\s+(\d+)\s*[:：\-]?\s*(.*)$/i
const HEADING_RE = /^##\s+(.*)$/
const CHECKBOX_RE = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/
const GOAL_HEADING_RE = /^##\s+(goal|目标)\s*$/i

/**
 * 解析 `task_plan.md`。
 *
 * 只认两种语法：`## Phase N[: 标题]`（阶段）与 `- [ ] / - [x]`（条目）。
 * 其它标题当普通章节 —— 用来找 Goal，或作为"未分阶段条目"的归属名。
 */
export function parsePlan(markdown: string): ParsedPlan {
  const lines = markdown.split(/\r?\n/)
  const phases: PlanPhase[] = []
  let current: PlanPhase | undefined
  let section = ''
  let goalSection: string[] | undefined
  let goal: string | undefined
  const leading: PlanItem[] = []

  const pushItem = (raw: string, done: boolean, line: number): void => {
    if (goalSection !== undefined) {
      // Goal 节里的复选框不常见，但真出现时不该被当成"目标文本"
      goalSection = undefined
    }
    if (current === undefined) {
      leading.push({ text: raw.trim(), done, line })
      return
    }
    current.items.push({ text: raw.trim(), done, line })
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const lineNo = i + 1

    const phase = PHASE_RE.exec(raw)
    if (phase) {
      current = { index: Number(phase[1]), title: (phase[2] ?? '').trim(), items: [], doneCount: 0, totalCount: 0 }
      phases.push(current)
      section = ''
      goalSection = undefined
      continue
    }

    const heading = HEADING_RE.exec(raw)
    if (heading) {
      section = (heading[1] ?? '').trim()
      goalSection = GOAL_HEADING_RE.test(raw) ? [] : undefined
      // 非 Phase 标题**不重置归属**：`## 备注` 之后的复选框仍算最近那个 Phase 的
      // —— 模型在阶段下写小节标题是常见形态，重置会让那些条目变成"未分阶段"并被
      // unshift 到列表最前，看上去像计划被重排（也不丢数据，但顺序骗人）。
      continue
    }

    const box = CHECKBOX_RE.exec(raw)
    if (box) {
      pushItem(box[2] ?? '', (box[1] ?? ' ').toLowerCase() === 'x', lineNo)
      continue
    }

    const text = raw.trim()
    if (text === '') continue
    if (goalSection !== undefined && !text.startsWith('>')) {
      goalSection.push(text)
      goal = goalSection.find((t) => t !== '') ?? goal
      continue
    }
    if (goal === undefined && phases.length === 0 && leading.length === 0 && section === '' && !text.startsWith('#')) {
      // 文档开头没有 `## Goal`：退化为"第一条非空非标题行"
      goal = text
    }
  }

  if (leading.length > 0) {
    // 前置条目（Phase 之前就出现的复选框）：收进 index 0，不丢数据
    phases.unshift({ index: 0, title: '（未分阶段）', items: leading, doneCount: 0, totalCount: 0 })
  }

  let doneCount = 0
  let totalCount = 0
  for (const p of phases) {
    p.doneCount = p.items.filter((it) => it.done).length
    p.totalCount = p.items.length
    doneCount += p.doneCount
    totalCount += p.totalCount
  }

  const activePhase = phases.find((p) => p.totalCount > 0 && p.doneCount < p.totalCount)
  const nextStep = activePhase?.items.find((it) => !it.done)?.text

  const parsed: ParsedPlan = {
    phases,
    doneCount,
    totalCount,
    complete: totalCount > 0 && doneCount === totalCount,
  }
  if (activePhase !== undefined) parsed.activePhase = activePhase
  if (nextStep !== undefined) parsed.nextStep = nextStep
  if (goal !== undefined) parsed.goal = goal
  return parsed
}

/**
 * 写入 Goal（`/plan <任务描述>`）。
 *
 * 有 `## Goal` 节 ⇒ 替换节内首个非空行；没有 ⇒ 在文档标题之后插入一个新节。
 * 保留原文件其它内容（不做"重新生成"）—— 计划是用户的资产，命令只该改它该改的那一行。
 */
export function replaceGoal(markdown: string, text: string): string {
  const lines = markdown.split(/\r?\n/)
  const goalAt = lines.findIndex((l) => GOAL_HEADING_RE.test(l))
  if (goalAt >= 0) {
    for (let i = goalAt + 1; i < lines.length; i++) {
      const raw = lines[i] ?? ''
      if (HEADING_RE.test(raw)) break // 下一个章节 ⇒ 本节是空的
      if (raw.trim() === '' || raw.trim().startsWith('>')) continue
      lines[i] = text
      return lines.join('\n')
    }
    lines.splice(goalAt + 1, 0, '', text)
    return lines.join('\n')
  }
  const titleAt = lines.findIndex((l) => /^#\s+/.test(l))
  const insertAt = titleAt >= 0 ? titleAt + 1 : 0
  lines.splice(insertAt, 0, '', '## Goal', '', text)
  return lines.join('\n')
}

// ---------------------------------------------------------------- 认证（approved hash 锁）

export interface AttestRecord {
  /** 被认证的文件（目前只锁 task_plan.md —— 进度权威） */
  file: PlanFileName
  /** sha256 hex */
  hash: string
  /** 认证时刻（ms） */
  at: number
}

/** task_plan.md 的 sha256（文件缺失 ⇒ 对空串取哈希，不抛错） */
export function hashPlan(root: string): string {
  let content = ''
  try {
    const p = join(root, 'task_plan.md')
    if (existsSync(p)) content = readFileSync(p, 'utf8')
  } catch {
    content = ''
  }
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 锁定当前 hash（`/plan-attest`） */
export function attestPlan(root: string, at: number = Date.now()): AttestRecord {
  mkdirSync(root, { recursive: true })
  const rec: AttestRecord = { file: 'task_plan.md', hash: hashPlan(root), at }
  atomicWrite(join(root, ATTEST_FILE_NAME), `${JSON.stringify(rec, null, 2)}\n`)
  return rec
}

/** 读认证记录；缺失 / 损坏 ⇒ undefined */
export function readAttestation(root: string): AttestRecord | undefined {
  const p = join(root, ATTEST_FILE_NAME)
  if (!existsSync(p)) return undefined
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<AttestRecord>
    if (typeof raw.hash !== 'string' || raw.hash === '') return undefined
    return { file: 'task_plan.md', hash: raw.hash, at: typeof raw.at === 'number' ? raw.at : 0 }
  } catch {
    return undefined
  }
}

export type AttestationStatus = 'ok' | 'missing' | 'mismatch'

export interface AttestationVerdict {
  status: AttestationStatus
  /** 已认证的哈希（missing 时 undefined） */
  approved?: string
  current: string
}

/**
 * 比对：当前 task_plan.md 的 hash 是否等于已认证 hash。
 *
 * - `missing`：从未 `/plan-attest` 过 —— **不当作篡改**（可能是刚初始化），
 *   注入侧据此走"未认证"文案而不是 TAMPERED。
 * - `mismatch`：认证过但文件被改过 —— 注入 `[PLAN TAMPERED]` 并只给告警行。
 */
export function verifyAttestation(root: string): AttestationVerdict {
  const current = hashPlan(root)
  const rec = readAttestation(root)
  if (rec === undefined) return { status: 'missing', current }
  return rec.hash === current ? { status: 'ok', approved: rec.hash, current } : { status: 'mismatch', approved: rec.hash, current }
}

/** 短哈希（展示用）：`sha256:abcd1234…` */
export function shortHash(hash: string, len = 8): string {
  return `sha256:${hash.slice(0, len)}…`
}

/**
 * 人读摘要（`/plan-status` / `/plan` 输出）。
 *
 * 与注入块（`buildPlanBlock`）**刻意不共用格式**：这份给人看（全角标点、带 emoji 状态符、
 * 缩进树），那份给模型读（半角、固定 key: value、无装饰）。共用一份就会两头都不合身 ——
 * 之前踩过"同一份文本既要给人看又要喂模型"的亏（改给模型的可读性就破坏了终端对齐）。
 */
export function renderPlanSummary(parsed: ParsedPlan): string {
  const out: string[] = []
  if (parsed.goal !== undefined && parsed.goal !== '') out.push(`目标：${parsed.goal}`)
  if (parsed.totalCount === 0) {
    out.push('计划里还没有任何 `- [ ]` 条目（task_plan.md 未被填写）')
    return out.join('\n')
  }
  out.push(`完成度：${parsed.doneCount}/${parsed.totalCount}${parsed.complete ? ' ✅ 全部完成' : ''}`)
  for (const p of parsed.phases) {
    if (p.items.length === 0) continue
    const mark = p.doneCount === p.totalCount ? '✅' : '▶'
    out.push(`${mark} Phase ${p.index}${p.title === '' ? '' : `: ${p.title}`}（${p.doneCount}/${p.totalCount}）`)
    for (const it of p.items) out.push(`   ${it.done ? '[x]' : '[ ]'} ${it.text}`)
  }
  if (parsed.activePhase !== undefined) out.push(`\n当前阶段：Phase ${parsed.activePhase.index}`)
  if (parsed.nextStep !== undefined) out.push(`下一步：${parsed.nextStep}`)
  return out.join('\n')
}
