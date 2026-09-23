/**
 * @harness/skill-forge —— 技能锻造（Skill Forge）F1 / F2
 *
 * 定位：把「这次会话里跑通的流程」固化成一个可复用的 Skill（SKILL.md），
 * 让它下次能被 `paths` / `description` 命中自动注入，或被 `/skill-name` 主动调用。
 *
 * 设计取舍（来自 docs/memory-and-skill-forge-plan.md §4）：
 * 1. **人工确认是硬环节** —— 自动生成的技能一旦错了会被反复执行，成本远高于确认成本。
 *    所以命令是两段式：`/skill-forge <name>` 出草稿 → `/skill-forge --confirm <name>` 落盘。
 *    （CLI 的 CliCommandInput 只有 out 没有 stdin，两段式是唯一不阻塞 REPL 的确认方式。）
 * 2. **默认写 user 级**（`--project` 才写项目级）—— 项目级会随 git 共享，个人流程不该默认进仓库。
 * 3. **生成的技能 `allowEmbedShell=false`** —— 不能让模型给自己生成带 !\`cmd\` 的可执行技能
 *    （等于自我授权的 RCE 通道）。落盘由 `@harness/skill` 的 `SkillManager.save()` 强制。
 * 4. **只提示不自动写**（F3 才做隐式检测）；去重命中时提示"更新已有"而不是新建（F2）。
 * 5. **延迟注入队列按会话隔离**（见 `schedulers` 上的长注释）：compress / compacting 都是引擎层
 *    广播，子 Agent 压缩不得替主会话发布技能，子 Agent 建 prompt 也不得 drain 主会话队列。
 * 6. **失败回写落 `FEEDBACK.md`**（不是 `MEMORY.md`）—— 反馈是自动产生的，放 system 前缀区
 *    会让"一次工具报错"绑上"整段前缀缓存报废"。
 *
 * 轨迹来源刻意用**引擎层**的 `core.tool.post.execute`，而不是 `cli.agent.stream`
 * —— 后者是 UI 消费层（只有走 CLI 的宿主才触发），靠它采集会在内嵌/ACP 宿主下静默失效
 * （与 memory 插件 §3.7⑦ 踩过的坑同源）。
 */

import type { AgentPlugin, Hooks, PluginContext, CliCommandInput } from '@harness/plugin'
import { isValidSkillId, type Skill, type SkillSource, type SkillManager } from '@harness/skill'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

// ===== 轨迹记录 =====

/** 一条工具执行记录（轨迹的最小单元） */
export interface TraceEntry {
  toolId: string
  /** 入参摘要（截断后的单行） */
  inputSummary: string
  ok: boolean
  /** 失败原因（ok=false 时） */
  error?: string
}

/**
 * 会话级工具轨迹记录器（有界，防内存膨胀）。
 *
 * 只保留最近 N 条 × 最近 M 个会话；超出按 FIFO 丢弃最旧的会话。
 */
export class TraceRecorder {
  private sessions = new Map<string, TraceEntry[]>()
  private order: string[] = []

  constructor(
    private readonly opts: { maxEntries?: number; maxSessions?: number } = {},
  ) {}

  private get maxEntries(): number {
    return this.opts.maxEntries ?? 200
  }
  private get maxSessions(): number {
    return this.opts.maxSessions ?? 8
  }

  record(sessionId: string, entry: TraceEntry): void {
    if (!sessionId) return
    let list = this.sessions.get(sessionId)
    if (!list) {
      // 会话数上限：按插入顺序 FIFO 淘汰最早记录的会话（够用且可预测；
      // 真正的 LRU 需要每次读都重排，收益不抵复杂度）
      while (this.order.length >= this.maxSessions) {
        const oldest = this.order.shift()
        if (oldest) this.sessions.delete(oldest)
      }
      list = []
      this.sessions.set(sessionId, list)
      this.order.push(sessionId)
    }
    list.push(entry)
    if (list.length > this.maxEntries) list.splice(0, list.length - this.maxEntries)
  }

  list(sessionId: string): TraceEntry[] {
    return this.sessions.get(sessionId) ?? []
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      this.sessions.delete(sessionId)
      this.order = this.order.filter((s) => s !== sessionId)
      return
    }
    this.sessions.clear()
    this.order = []
  }
}

// ===== 草稿 =====

export interface SkillDraft {
  /** 技能 id（同时是目录名：a-z0-9-_） */
  id: string
  name: string
  /** 「何时用」—— 这是唯一的检索信号，比正文更重要 */
  description: string
  /** paths 条件触发（改这些文件时自动注入） */
  paths?: string[]
  steps: string[]
  pitfalls: string[]
  acceptance: string[]
}

/** 入参摘要：只留关键 key，截断，避免把整份文件内容写进技能 */
export function summarizeInput(input: unknown, max = 120): string {
  if (input == null) return '{}'
  let text: string
  if (typeof input === 'string') text = input
  else if (typeof input === 'object') {
    try {
      text = Object.entries(input as Record<string, unknown>)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`)
        .join(' ')
    } catch {
      text = String(input)
    }
  } else text = String(input)
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 折叠重复周期：A,B,A,B,A,B ⇒ A,B。
 *
 * 只认**完整**周期（长度能整除且每一项都对应相等），宁可少折叠也不把真实的多步流程压扁；
 * 找不到就原样返回。
 */
export function collapseCycle(entries: TraceEntry[]): TraceEntry[] {
  const n = entries.length
  if (n < 4) return entries
  const same = (a: TraceEntry, b: TraceEntry) =>
    a.toolId === b.toolId && a.ok === b.ok && a.inputSummary === b.inputSummary
  for (let k = 1; k <= Math.floor(n / 2); k += 1) {
    if (n % k !== 0) continue
    let ok = true
    for (let i = k; i < n; i += 1) {
      if (!same(entries[i]!, entries[i % k]!)) { ok = false; break }
    }
    if (ok) return entries.slice(0, k)
  }
  return entries
}

/**
 * 从工具轨迹生成技能草稿（**确定性**，不调用 LLM）。
 *
 * 刻意不接 LLM：锻造的输入是"刚刚跑通的路径"，照实记录即可；让模型再编一遍反而会
 * 引入幻觉步骤。步骤上限默认 12（超过说明这段轨迹不适合固化成一个技能）。
 */
export function draftFromTrace(
  name: string,
  trace: TraceEntry[],
  opts: { description?: string; maxSteps?: number } = {},
): SkillDraft {
  const maxSteps = opts.maxSteps ?? 12
  // 连续重复的同一调用合并成一条（模型常把同一工具连调多次）
  const collapsed: TraceEntry[] = []
  for (const e of trace) {
    const prev = collapsed[collapsed.length - 1]
    if (prev && prev.toolId === e.toolId && prev.ok === e.ok && prev.inputSummary === e.inputSummary) continue
    collapsed.push(e)
  }
  // 再折叠重复**周期**：A,B,A,B,A,B 只留一个 A,B —— 真机里模型常把同一小循环跑两遍
  // （本次 e2e 实测：list_dir → read_file 整轮重复），照抄进技能只会让步骤翻倍。
  const cycled = collapseCycle(collapsed)
  // 按「工具 + 入参」全局去重（保序）：真机里模型会把同一小循环跑多遍，且中途可能给某个
  // 参数加个开关（本次实测：read_file 时有时带 showLineNumbers）⇒ 完整周期折叠识别不出来，
  // 但"同工具同入参"的步骤本来就是同一步，保留一条即可。只去重完全相同的，不丢真实步骤。
  const seen = new Set<string>()
  const unique = cycled.filter((e) => {
    const key = `${e.toolId}|${e.inputSummary}|${e.ok}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const steps = unique
    .slice(0, maxSteps)
    .map((e, i) => `${i + 1}. 调用 \`${e.toolId}\`${e.inputSummary && e.inputSummary !== '{}' ? `（${e.inputSummary}）` : ''}`)
  const pitfalls = unique
    .filter((e) => !e.ok)
    .slice(0, 8)
    .map((e) => `- \`${e.toolId}\` 曾失败：${e.error ?? '未知原因'}`)
  const last = unique[unique.length - 1] ?? cycled[cycled.length - 1]
  const acceptance = [
    last ? `- 末步 \`${last.toolId}\` 成功返回（与本次一致）` : '- 流程可完整跑通',
    '- 关键结论/产物与本次一致（技能里记录的是路径，不是一次性结果）',
  ]
  return {
    id: name,
    name,
    description:
      opts.description?.trim() ||
      `当需要用同样的步骤完成同类任务时使用（由会话轨迹锻造：${cycled.map((e) => e.toolId).slice(0, 5).join(' → ') || '无轨迹'}）`,
    steps: steps.length ? steps : ['- （本次会话没有可记录的工具调用，请手工补充步骤）'],
    pitfalls,
    acceptance,
  }
}

/**
 * 从轨迹里找「可固化的重复流程」（F3 的**只提示**部分）。
 *
 * 判据（都要求**同一工具+同一入参**，避免把"多次用 bash"这类噪音当成流程）：
 * 1. 单步重复 ≥ minRepeats 次；
 * 2. 长度 2~6 的**连续序列**完整重复 ≥ 2 轮。
 *
 * ⚠️ 刻意**不注入 system**：提示走命令输出（`/skill-forge suggest`），
 * 每轮改 system 会让前缀缓存持续失效（B9），而"提示"根本不需要进模型上下文。
 */
export function detectRepeatable(
  trace: TraceEntry[],
  opts: { minRepeats?: number } = {},
): Array<{ kind: 'single' | 'sequence'; toolIds: string[]; count: number }> {
  const min = opts.minRepeats ?? 3
  const out: Array<{ kind: 'single' | 'sequence'; toolIds: string[]; count: number }> = []
  const key = (e: TraceEntry) => `${e.toolId}|${e.inputSummary}`

  // 1) 单步重复
  const byKey = new Map<string, number>()
  for (const e of trace) byKey.set(key(e), (byKey.get(key(e)) ?? 0) + 1)
  for (const [k, n] of byKey) {
    if (n >= min) out.push({ kind: 'single', toolIds: [k.split('|')[0]!], count: n })
  }

  // 2) 连续序列重复（滑窗找重复出现的 n-gram，且必须连续出现两次才算"跑了一轮以上"）
  const keys = trace.map(key)
  for (let len = 2; len <= 6 && len * 2 <= keys.length; len += 1) {
    const seen = new Map<string, number>()
    for (let i = 0; i + len <= keys.length; i += 1) {
      const gram = keys.slice(i, i + len).join('>')
      seen.set(gram, (seen.get(gram) ?? 0) + 1)
    }
    for (const [gram, n] of seen) {
      if (n >= 2) out.push({ kind: 'sequence', toolIds: gram.split('>').map((k) => k.split('|')[0]!), count: n })
    }
  }
  // 序列命中时，单步命中通常是它的子集 ⇒ 只保留信息量更大的序列结果
  return out.filter((r) => !(r.kind === 'single' && out.some((o) => o.kind === 'sequence')))
}

/** 草稿 → 展示文本（人工确认时打印给用户的就是这份） */
export function renderDraft(draft: SkillDraft): string {
  const lines: string[] = []
  lines.push(`技能草稿：${draft.id}`)
  lines.push(`  何时用（description）：${draft.description}`)
  lines.push('')
  lines.push('## 步骤')
  for (const s of draft.steps) lines.push(s)
  if (draft.pitfalls.length) {
    lines.push('')
    lines.push('## 坑')
    for (const p of draft.pitfalls) lines.push(p)
  }
  lines.push('')
  lines.push('## 验收')
  for (const a of draft.acceptance) lines.push(a)
  return lines.join('\n')
}

/** 草稿 → Skill 对象（正文按模板拼装；allowEmbedShell 恒 false 见文件头 §3） */
export function draftToSkill(draft: SkillDraft, source: SkillSource = 'user'): Skill {
  const body: string[] = []
  body.push('## 步骤')
  body.push('')
  for (const s of draft.steps) body.push(s)
  body.push('')
  if (draft.pitfalls.length) {
    body.push('## 坑')
    body.push('')
    for (const p of draft.pitfalls) body.push(p)
    body.push('')
  }
  body.push('## 验收')
  body.push('')
  for (const a of draft.acceptance) body.push(a)
  return {
    id: draft.id,
    name: draft.name,
    description: draft.description,
    loadedFrom: source,
    content: body.join('\n'),
    userInvocable: true,
    // 见文件头 §3：锻造出来的技能不允许内嵌 shell
    allowEmbedShell: false,
    ...(draft.paths?.length ? { paths: draft.paths } : {}),
  }
}

/** 落盘前校验（模板契约：frontmatter 必填 + 长度上限） */
export function validateDraft(draft: SkillDraft): { ok: boolean; message: string } {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(draft.id)) {
    return { ok: false, message: `技能 id 非法（只允许 a-z0-9-_，1~64 字符）：${draft.id}` }
  }
  if (!draft.description.trim()) return { ok: false, message: 'description（何时用）不能为空' }
  if (draft.description.length > 300) return { ok: false, message: 'description 超过 300 字符（它是唯一检索信号，请压缩）' }
  const text = renderDraft(draft)
  if (text.length > 12_000) return { ok: false, message: `草稿过长（${text.length} 字符 > 12000），请拆成多个技能` }
  if (!draft.steps.length) return { ok: false, message: '步骤为空' }
  return { ok: true, message: 'ok' }
}

// ===== 去重（F2） =====

/** 分词：英文按词、中文按字（够用的近似，不去引分词库） */
function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  const s = text.toLowerCase()
  for (const m of s.matchAll(/[a-z0-9_]+/g)) if (m[0].length > 1) out.add(m[0])
  for (const ch of s) if (/[\u4e00-\u9fa5]/.test(ch)) out.add(ch)
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / (a.size + b.size - inter)
}

/**
 * 与已有技能做描述相似度比对：命中则提示"更新已有技能"而不是新建。
 * 阈值默认 0.5（描述都很短，太高会漏、太低会误报）。
 */
export function findSimilarSkill(
  draft: SkillDraft,
  existing: Skill[],
  threshold = 0.5,
): { skill: Skill; score: number } | undefined {
  const target = tokenize(`${draft.name} ${draft.description}`)
  let best: { skill: Skill; score: number } | undefined
  for (const s of existing) {
    if (s.id === draft.id) return { skill: s, score: 1 }
    const score = jaccard(target, tokenize(`${s.name} ${s.description}`))
    if (score >= threshold && (!best || score > best.score)) best = { skill: s, score }
  }
  return best
}

// ===== 延迟注入调度（与记忆同一套分级策略）=====

/**
 * 锻造技能的**延迟注入**调度器。
 *
 * 为什么延迟：技能一进 `agent.skills` 白名单，下一轮的 system 就变了 ⇒ 前缀缓存失效一次。
 * 锻造常常是连着做几件的（跑通一段就存一个），逐个立即绑定会让 system 连续变好几轮。
 * 与记忆（§3.7）同一套判据：**攒到下次压缩**再统一发布，攒够 N 轮兜底放行，`--now` 例外。
 *
 * ⚠️ 触发源必须双份：`core.session.compacting`（ACP/压缩路径）+ `core.agent.turn.end`
 * （引擎层轮末兜底）—— 只认前者在关闭压缩时永远等不到，只认后者则要白等十几轮。
 *
 * ⚠️ **实例不隔离会话**：本类只管"一个会话的队列与发布状态"，多会话共存时由调用方按
 * sessionId 各持一个实例（见 `createSkillForgePlugin` 里的 `schedulers`）。不要把它改回单例。
 */
export class SkillInjectScheduler {
  private pending = new Map<string, string | undefined>() // skillId → 绑定目标 agentId
  private dirtyTurns = 0
  private forced = false

  constructor(private readonly opts: { flushAfterTurns?: number } = {}) {}

  private get flushAfter(): number {
    return this.opts.flushAfterTurns ?? 15
  }

  /** 排入待注入队列（不立即改白名单）。
   *
   * 评审修复：此前这里无条件 `forced=false; dirtyTurns=0` —— 若 compress/压缩刚 flush 过、
   * 还没被下一次 prompt 构建消费，又锻造了一个技能，会把整个队列的「立即发布」冲掉，
   * 白白再等 15 轮。schedule 只入队，不碰发布状态。
   */
  schedule(skillId: string, agentId?: string): void {
    this.pending.set(skillId, agentId)
  }

  /** 轮末推进：攒够轮数则安排放行（兜底） */
  onTurnEnd(): void {
    if (this.pending.size === 0 || this.forced) return
    this.dirtyTurns += 1
    if (this.dirtyTurns >= this.flushAfter) this.forced = true
  }

  /** 立即安排发布（压缩发生 / 显式 flush） */
  flush(): void {
    if (this.pending.size > 0) this.forced = true
  }

  /** 是否此刻应当发布 */
  get due(): boolean {
    return this.forced || this.flushAfter <= 0
  }

  /** 取出待发布队列并清空调度状态 */
  takeDue(): Array<{ skillId: string; agentId?: string }> {
    if (!this.due) return []
    const out = Array.from(this.pending.entries()).map(([skillId, agentId]) => ({
      skillId,
      ...(agentId ? { agentId } : {}),
    }))
    this.pending.clear()
    this.dirtyTurns = 0
    this.forced = false
    return out
  }

  /** 诊断（`/forge` 面板用） */
  state(): { pending: string[]; dirtyTurns: number; flushAfterTurns: number; due: boolean } {
    return {
      pending: Array.from(this.pending.keys()),
      dirtyTurns: this.dirtyTurns,
      flushAfterTurns: this.flushAfter,
      due: this.due,
    }
  }
}

// ===== 失败回写记忆（F3 闭环的一半）=====

/** 回写记忆的一条候选（节流后才会真的落盘） */
export interface FeedbackCandidate {
  toolId: string
  inputSummary: string
  error: string
  failures: number
}

const MEMORY_INDEX_FILE = 'MEMORY.md'
const ENTRY_PREFIX = '- '

/**
 * 失败回写落到**独立的 `FEEDBACK.md`**（权威定义见 `@harness/memory` 的 `FEEDBACK_FILE`）。
 *
 * 为什么这里重复一份常量而不是 import：`writeFeedbackMemory` 刻意**不依赖** `@harness/memory`
 * —— 用户可能没启用记忆插件，而这只是"顺手留一条事实"。但**文件名必须与那边一致**，
 * 否则反馈会重新落回 `MEMORY.md`（= 回到 system 前缀区：一条自动回写就能让整段前缀缓存报废，
 * 真机实测 52,096 token）。改这里时请同时改 `packages/plugins/memory/src/index.ts`。
 */
const FEEDBACK_FILE = 'FEEDBACK.md'

/** 归一化（与 memory 插件一致：去空白，便于精确去重） */
function normalizeEntry(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 往记忆索引追加一条（`- ` 前缀、精确去重、上限校验、原子写） */
export function appendMemory(file: string, line: string): { ok: boolean; message: string } {
  return writeFeedbackMemory(file, line)
}

/**
 * 把「反复失败」写回长期记忆（feedback 类）。
 *
 * 直接按 memory 插件的文件约定写（`MEMORY.md`，`- ` 前缀条目），**不依赖** @harness/memory
 * —— 用户可能没启用记忆插件，而这里只是"顺手留一条事实"，不该反过来要求启用它。
 * 原子写 + 精确去重 + 行数上限，与 MemoryStore 的约束对齐。
 */
export function writeFeedbackMemory(
  file: string,
  line: string,
): { ok: boolean; message: string } {
  const text = normalizeEntry(line)
  if (!text) return { ok: false, message: '空条目' }
  try {
    // 目标已是符号链接时拒绝（评审建议）：否则会写到链接指向的任意文件
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
      return { ok: false, message: `目标是符号链接，拒绝写入：${file}` }
    }
    mkdirSync(dirname(file), { recursive: true })
    const cur = existsSync(file) ? readFileSync(file, 'utf-8') : ''
    const existing = cur
      .split('\n')
      .map((l) => (l.startsWith(ENTRY_PREFIX) ? l.slice(ENTRY_PREFIX.length) : l))
      .map(normalizeEntry)
    if (existing.includes(text)) return { ok: false, message: '该条目已存在，未重复写入' }
    if (existing.filter((l) => l.length > 0).length >= 200) {
      return { ok: false, message: '记忆索引已达 200 条上限' }
    }
    const base = cur.length === 0 || cur.endsWith('\n') ? cur : `${cur}\n`
    const next = `${base}${ENTRY_PREFIX}${text}\n`
    const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
    writeFileSync(tmp, next, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
    try {
      renameSync(tmp, file)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
    return { ok: true, message: `已写入 ${file}` }
  } catch (err) {
    return { ok: false, message: `写入失败：${(err as Error)?.message ?? err}` }
  }
}

// ===== 插件 =====

export interface SkillForgePluginOptions {
  /** 默认落盘作用域（默认 user：项目级会随 git 共享） */
  scope?: 'user' | 'project'
  /** 治理：技能数量上限（默认 50），超出拒绝新建并提示先整理 */
  maxSkills?: number
  /** 草稿步骤上限（默认 12） */
  maxSteps?: number
  /** F3：工具反复失败时回写一条 feedback 到长期记忆（默认 true） */
  writeBackOnFailure?: boolean
  /** 回写阈值：同一工具+入参失败几次才写（默认 2） */
  minFailures?: number
  /** 回写到哪级记忆（默认 user；project 会随 git 共享） */
  feedbackScope?: 'user' | 'project'
  /** 延迟注入兜底轮数（默认 15，与记忆一致；0 = 立即） */
  flushAfterTurns?: number
  /** 注入 workspace（测试用；运行时走 ctx.workspace） */
  workspace?: {
    user: { skills: string; memory: string }
    project: { skills: string; memory: string }
  }
  /** 注入 skillManager（测试用） */
  skillManager?: SkillManager
}

/** 解析命令行：取出 flag 与位置参数（`--desc "何时用"` 支持双引号） */
export function parseArgs(
  arg: string,
): { flags: Set<string>; positional: string[]; desc?: string } {
  const flags = new Set<string>()
  const positional: string[] = []
  let desc: string | undefined
  const tokens = arg.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!.replace(/^"|"$/g, '')
    if (t === '--desc') {
      desc = (tokens[i + 1] ?? '').replace(/^"|"$/g, '')
      i += 1
      continue
    }
    if (t.startsWith('-')) flags.add(t)
    else positional.push(t)
  }
  return { flags, positional, ...(desc ? { desc } : {}) }
}

/**
 * 创建技能锻造插件。
 *
 * 命令：`/skill-forge <name> [--project] [--desc "何时用"]` 出草稿；
 *       `/skill-forge --confirm <name> [--project] [--overwrite]` 落盘并当轮生效；
 *       另有 `list` / `path` / `disable <id>`。
 */
export function createSkillForgePlugin(options: SkillForgePluginOptions = {}): AgentPlugin {
  const recorder = new TraceRecorder()
  /** 待确认草稿：key = `${scope}:${id}` */
  const pending = new Map<string, { draft: SkillDraft; at: number }>()
  let manager: SkillManager | undefined = options.skillManager
  let ws = options.workspace
  let harnessRef: any
  /** 已回写过记忆的失败（节流：同一工具+入参一次会话只写一条） */
  const writtenFeedback = new Set<string>()
  let ctxLog: PluginContext['log'] | undefined
  /** install 里赋值：/forge 转发子命令时要复用技能侧的命令处理器 */
  let commandHandler: ((input: any) => void) | undefined

  /**
   * 延迟注入队列**按会话隔离**（与 `@harness/memory` 的 publishers 是同一族缺陷、同一套修法）。
   *
   * 为什么不能是实例级单例：一个进程里主会话与若干子 Agent 会话共存，而
   * `core.tool.post.execute` 的 compress 判定 / `core.session.compacting` 都是**引擎层广播**
   * —— 子 Agent 压缩腾的是它自己的窗口，凭什么替主会话按下"发布技能"的键；而技能一旦绑进
   * `agent.skills` 白名单，主会话下一轮 system 就变了 ⇒ 前缀缓存整段报废。
   * 反向也有一条：`core.prompt.system.transform` 里 drain 队列的动作如果不判会话，
   * **子 Agent 建 prompt 会把主会话的待发布队列消费掉**（发布时机被挪到子会话的一轮上）。
   *
   * `mainSessions` 记录"确认过的非子 Agent 会话"；缺失 sessionId 时一律 **fail-closed 不发布**
   * —— 代价不对称：晚发布几轮 vs 一次五万 token 级的前缀报废。
   */
  const schedulers = new Map<string, SkillInjectScheduler>()
  const mainSessions = new Set<string>()
  /** 惰性建调度器。键只在主会话上出现（system.transform 的非 subagent 分支、CLI 命令） */
  const schedulerFor = (sessionId: string): SkillInjectScheduler => {
    let s = schedulers.get(sessionId)
    if (!s) {
      s = new SkillInjectScheduler({
        ...(options.flushAfterTurns != null ? { flushAfterTurns: options.flushAfterTurns } : {}),
      })
      schedulers.set(sessionId, s)
    }
    return s
  }

  const scopeOf = (flags: Set<string>): 'user' | 'project' =>
    flags.has('--project') ? 'project' : (options.scope ?? 'user')

  /**
   * 把技能 id 加进 agent 的 skills 白名单（**运行时**）。
   *
   * 为什么必须做这步：`core.skill-injection` 只注入 `agent.skills` 白名单里的技能
   * （`core/src/index.ts`），锻造出来的技能**不在白名单里就不会被注入**；
   * 而 `paths` 条件触发在仓库里是死代码（matchByPath 无人调用）。
   * 持久化只能改 agent 的 md frontmatter —— 插件不该替用户改配置文件，所以这里只改运行时
   * 并**打印该加的那一行**，由用户决定是否落盘。
   */
  const bindToAgent = (skillId: string, agentId?: string): string => {
    const reg = harnessRef?.agent
    const target = agentId ?? 'default'
    const def = reg?.get?.(target)
    if (!reg?.register || !def) {
      return `⚠️  未能绑定：找不到 Agent "${target}"（可在命令里指定 --bind <agentId>）`
    }
    const cur = Array.isArray(def.skills) ? def.skills : []
    if (cur.includes(skillId)) return `已在 Agent "${target}" 的技能白名单中`
    reg.register({ ...def, skills: [...cur, skillId] })
    return (
      `✅ 已加入 Agent "${target}" 的技能白名单（运行时；重启后需持久化）\n` +
      `   持久化：在该 Agent 的 .md frontmatter 里写  skills: [${[...cur, skillId].join(', ')}]`
    )
  }

  /**
   * 统一沉淀入口 `/forge`（§5：两条线一个入口）。
   *
   * 路由规则：**单条事实 → 记忆，多步流程 → 技能**。
   * - `/forge` 面板：一眼看到「可固化流程 / 待注入技能 / 记忆条目」；
   * - `/forge memory add <内容> [--project]` 写记忆（不依赖 @harness/memory）；
   * - `/forge skill <name> …` 转发到技能锻造；
   * - `/forge flush` 立即发布延迟注入队列。
   *
   * @returns 是否已处理（false 表示不是本插件的命令）
   */
  const handleForge = (input: CliCommandInput): boolean => {
    if (input.command !== 'forge') return false
    input.result = 'continue'
    const out = input.out
    const { flags, positional, desc } = parseArgs(input.arg ?? '')
    const sub = positional[0]

    // 转发：/forge skill <name> … → 与 /skill-forge <name> … 完全等价
    if (sub === 'skill') {
      const rest = (input.arg ?? '').slice('skill'.length).trim()
      commandHandler?.({ ...input, command: 'skill-forge', arg: rest })
      return true
    }

    if (sub === 'flush') {
      // 只作用于**发起命令的会话**：/forge flush 是用户手动的"现在就发布"，不该顺手改别的会话
      const sched = schedulerFor(input.sessionId)
      sched.flush() // 先标记到期，再取 —— 否则 takeDue 只会返回空（面板显示待注入、flush 却说没有）
      const due = sched.takeDue()
      for (const d of due) bindToAgent(d.skillId, d.agentId)
      out(
        due.length
          ? `✅ 已发布延迟注入：${due.map((d) => d.skillId).join('、')}（下一轮起生效）\n`
          : '当前没有待注入的技能。\n',
      )
      return true
    }

    if (sub === 'memory') {
      const verb = positional[1] ?? 'list'
      const scope = flags.has('--project') ? 'project' : (options.feedbackScope ?? 'user')
      const dir = scope === 'project' ? ws?.project.memory : ws?.user.memory
      if (!dir) { out('未获得 workspace 的 memory 路径。\n'); return true }
      const file = join(dir, MEMORY_INDEX_FILE)
      if (verb === 'list' || verb === undefined) {
        const text = existsSync(file) ? readFileSync(file, 'utf-8') : ''
        const entries = text.split('\n').filter((l) => l.trim().length > 0)
        out(
          `\n长期记忆（${scope} 级 · ${file}）：${entries.length} 条\n` +
            entries.slice(0, 20).map((l) => `   ${l}`).join('\n') +
            (entries.length ? '\n' : '  （空）\n') +
            `  写入：/forge memory add <内容>${scope === 'user' ? '（--project 写项目级，会随 git 共享）' : ''}\n`,
        )
        return true
      }
      if (verb === 'add') {
        // 评审修复：此前用 split(/\s+/).slice(3) 按空白切，内容里的词会被当成分隔符丢掉
        // （真机实测"这个项目用 bun 跑测试"只写入"bun 跑测试"）。parseArgs 的 positional
        // 已按引号分组并剔掉 flag，从第 3 个位置参数起就是完整内容。
        const payload = positional.slice(2).join(' ').trim() || desc || ''
        if (!payload) { out('用法：/forge memory add <内容> [--project]\n'); return true }
        const res = appendMemory(file, payload)
        out(res.ok ? `✅ 已写入${scope === 'project' ? '项目' : '用户'}记忆：${payload}\n` : `⚠️  未写入：${res.message}\n`)
        return true
      }
      out('用法：/forge memory add <内容> [--project] · /forge memory list\n')
      return true
    }

    // 默认：沉淀面板
    const trace = recorder.list(input.sessionId ?? '')
    const found = detectRepeatable(trace)
    const st = schedulerFor(input.sessionId).state()
    const memFile = ws?.user.memory ? join(ws.user.memory, MEMORY_INDEX_FILE) : undefined
    const fbFile = ws?.user.memory ? join(ws.user.memory, FEEDBACK_FILE) : undefined
    const countLines = (f: string | undefined): number =>
      f && existsSync(f) ? readFileSync(f, 'utf-8').split('\n').filter((l) => l.trim().length > 0).length : 0
    const memCount = countLines(memFile)
    const fbCount = countLines(fbFile)
    out(
      `\n沉淀面板（单条事实 → 记忆；多步流程 → 技能）\n` +
        `  可固化流程  ${found.length} 段${found.length ? `（${found.slice(0, 3).map((f) => f.toolIds.join('→')).join('、')}）` : ''}\n` +
        `  待注入技能  ${st.pending.length ? `${st.pending.join('、')}（${st.dirtyTurns}/${st.flushAfterTurns} 轮）` : '无'}\n` +
        `  用户记忆    ${memCount} 条\n` +
        // 反馈是机器回写的、走尾部动态区（不进 system 前缀）；单独列出来免得和"人工记忆"混在一起看
        `  失败反馈    ${fbCount} 条（自动回写，尾部注入）\n` +
        `  已装技能    ${manager ? manager.all().length : 0} 个\n` +
        `  下一步：/forge skill <name> 固化流程 · /forge memory add <事实> · /forge flush 立即发布\n`,
    )
    return true
  }

  const ensureDirs = async (): Promise<void> => {
    if (!manager || !ws) return
    // 幂等：已加载过的目录再 load 只是一次重读；未加载过（目录可能还不存在）则登记，
    // 这样 save() 才找得到"该往哪写"
    try {
      await manager.load(ws.user.skills, 'user')
      await manager.load(ws.project.skills, 'project')
    } catch {
      /* 目录不可读时不阻断命令 */
    }
  }

  const insert = {
    // 引擎层信号：任何宿主都会触发（见文件头说明）。
    // Hooks 里这两个参数声明为 unknown（避免 plugin 包反向依赖 tool 包），
    // 运行时实际是 ToolPostHookContext{tool,input,ctx} 与 ToolResult —— 这里按契约取形状。
    'core.tool.post.execute'(hctx: unknown, result: unknown) {
      const h = hctx as { tool?: { id?: string }; input?: unknown; ctx?: { sessionId?: string } } | undefined
      const r = result as { ok?: boolean; error?: { message?: string } } | undefined
      const sessionId = h?.ctx?.sessionId ?? ''
      const toolId = h?.tool?.id ?? 'unknown'
      const inputSummary = summarizeInput(h?.input)
      recorder.record(sessionId, {
        toolId,
        inputSummary,
        ok: r?.ok !== false,
        ...(r?.ok === false ? { error: r?.error?.message } : {}),
      })

      // ACP 压缩信号（延迟注入的第三个触发源，引擎层）：
      // ACP 的模型驱动压缩走「模型调 compress 工具」，**不触发** `core.session.compacting`
      // （那只由 session compaction / /compact 触发）—— 之前只挂 compacting 时，
      // ACP 主路径上延迟队列永远等不到发布。compress 与普通工具一样过
      // core.tool.post.execute 且 ctx 带 tool.id ⇒ 在引擎层就能识别，任何宿主都有。
      //
      // ⚠️ 必须判**会话归属**：子 Agent 压缩不能替主会话发布（见 schedulers 上的注释）。
      // sessionId 缺失 ⇒ 不 flush（fail-closed）。
      if (toolId === 'compress' && r?.ok !== false && sessionId && mainSessions.has(sessionId)) {
        schedulerFor(sessionId).flush()
      }

      // F3 闭环的一半：同一工具+入参反复失败 ⇒ 回写一条 feedback。
      // 节流到"一次会话一条"，否则一次连环失败会把反馈刷满。
      if (options.writeBackOnFailure !== false && r?.ok === false && ws && sessionId) {
        const key = `${sessionId}:${toolId}|${inputSummary}`
        if (!writtenFeedback.has(key)) {
          const failures = recorder.list(sessionId).filter(
            (e) => e.toolId === toolId && e.inputSummary === inputSummary && !e.ok,
          ).length
          if (failures >= (options.minFailures ?? 2)) {
            writtenFeedback.add(key)
            const memoryDir =
              (options.feedbackScope ?? 'user') === 'project' ? ws.project.memory : ws.user.memory
            // 路径为空时绝不落笔：join('', 'FEEDBACK.md') 会解析成相对路径 ⇒ 写到进程 cwd
            if (!memoryDir) return
            // ⚠️ 落 FEEDBACK.md（不是 MEMORY.md）：反馈是**自动**产生的、时刻与用户的轮无关，
            // 放 system 前缀区（MEMORY.md）会让"一次工具报错"绑上"整段前缀缓存报废"。
            const file = join(memoryDir, FEEDBACK_FILE)
            const res = writeFeedbackMemory(
              file,
              `[feedback] ${toolId} 反复失败（${failures} 次）：${(r.error?.message ?? '未知原因').slice(0, 120)}`,
            )
            ctxLog?.debug?.(`失败回写反馈：${res.message}`)
          }
        }
      }
    },
  }

  return {
    id: 'skill-forge',
    version: '0.1.0',
    name: 'Skill Forge',
    description:
      '技能锻造：从会话工具轨迹生成技能草稿，人工确认后落盘为 SKILL.md 并当轮生效（/skill-forge）',

    async install(ctx: PluginContext): Promise<Hooks | void> {
      ws = options.workspace ?? ctx.workspace
      ctxLog = ctx.log

      const hooks: Record<string, unknown> = { ...insert }

      hooks['core.harness.init'] = (_input: unknown, output: unknown) => {
        const h = (output as { harness?: { skillManager?: SkillManager } } | undefined)?.harness
        if (h) harnessRef = h
        if (h?.skillManager) manager = h.skillManager
        void ensureDirs()
      }

      hooks['cli.commands'] = (input: { commands: Array<{ command: string; description: string; usage: string }> }) => {
        input.commands.push({
          command: 'skill-forge',
          description: '技能锻造：把本次跑通的流程固化为技能（草稿 → 确认 → 延迟注入）',
          usage: '/skill-forge <name> [--project] [--desc "何时用"] · --confirm <name> [--now] · list · path · disable <id>',
        })
        // 统一沉淀入口（§5：单条事实 → 记忆，多步流程 → 技能）
        input.commands.push({
          command: 'forge',
          description: '沉淀总入口：查看面板 / 记忆 add·list / 技能 skill·flush（两条线同一入口）',
          usage: '/forge · /forge memory add <内容> [--project] · /forge memory list · /forge skill <name> · /forge flush',
        })
      }

      // 延迟注入的两个触发源（缺一不可，见 SkillInjectScheduler 的注释）。
      // **两处都要判会话归属**：子 Agent 的压缩 / 轮末不能替主会话按下发布键
      // （技能一绑进白名单，主会话下一轮 system 就变 ⇒ 前缀缓存整段报废）。
      // 缺 sessionId ⇒ 不发布（fail-closed，代价不对称：晚几轮 vs 五万 token 级报废）。
      hooks['core.session.compacting'] = (input: { sessionId?: string }) => {
        const sid = input?.sessionId
        if (!sid || !mainSessions.has(sid)) return
        schedulerFor(sid).flush()
      }
      hooks['core.agent.turn.end'] = (signal: { mode?: string; sessionId?: string }) => {
        if (signal?.mode === 'subagent') return
        const sid = signal?.sessionId
        if (!sid) {
          // 字段缺失时按"无法归因"照常推进（正常路径只有一个主会话）；
          // 否则兜底会变成死代码 —— 那种失效表现为"锻造了技能却永远不注入"，极难排查。
          for (const s of schedulers.values()) s.onTurnEnd()
          return
        }
        schedulers.get(sid)?.onTurnEnd()
      }

      // 下一轮真正发生注入前，把到期的技能绑进白名单
      hooks['core.prompt.system.transform'] = (input: { sessionId: string; agentMode?: string }) => {
        // 先记会话再判分支：子 Agent 的 prompt 构建**不得** drain 主会话的待发布队列
        // （否则发布时机被挪到子会话的某一轮上，主会话的 system 会以意料之外的时刻变化）
        if (input.agentMode !== 'subagent') mainSessions.add(input.sessionId)
        if (input.agentMode === 'subagent') return
        const due = schedulerFor(input.sessionId).takeDue()
        for (const d of due) {
          // 评审修复：bindToAgent 失败（找不到目标 Agent）此前被静默吞掉 —— 队列已清空、
          // 技能永远不注入，用户却以为在延迟队列里。失败必须留痕。
          const msg = bindToAgent(d.skillId, d.agentId)
          if (msg.startsWith('⚠️')) ctxLog?.warn?.(`延迟注入绑定失败：${msg}`)
        }
        if (due.length && ctxLog) {
          ctxLog.info?.(`延迟注入已发布：${due.map((d) => d.skillId).join('、')}`)
        }
      }

      const cliCommandHandler = (input: CliCommandInput) => {
        if (input.command === 'forge' && handleForge(input)) return
        if (input.command !== 'skill-forge') return
        input.result = 'continue'
        const out = input.out
        const { flags, positional, desc } = parseArgs(input.arg ?? '')

        // ---- path：打印两级技能目录 ----
        if (positional[0] === 'path') {
          out(
            `技能目录\n` +
              `  用户级  ${ws?.user.skills ?? '(未知)'}\n` +
              `  项目级  ${ws?.project.skills ?? '(未知)'}\n`,
          )
          return
        }

        // ---- list：已有技能 + 治理上限 ----
        if (positional[0] === 'list') {
          if (!manager) { out('未获得 skillManager（技能系统未装配）\n'); return }
          const all = manager.all()
          const max = options.maxSkills ?? 50
          out(
            `\n技能清单（${all.length} 个 / 上限 ${max}）\n` +
              all
                .slice(0, 50)
                .map((s) => `  ${s.id.padEnd(28)} [${s.loadedFrom}] ${s.description.slice(0, 60)}`)
                .join('\n') +
              (all.length ? '\n' : '  （空）\n') +
              (pending.size ? `  待确认草稿：${Array.from(pending.keys()).join('、')}\n` : ''),
          )
          return
        }

        // ---- disable <id>：治理用禁用而非删除 ----
        if (positional[0] === 'disable') {
          const id = positional[1]
          if (!id) { out('用法：/skill-forge disable <id>\n'); return }
          if (!manager) { out('未获得 skillManager（技能系统未装配）\n'); return }
          out(manager.disable(id) ? `✅ 已禁用技能 ${id}（未删除文件，可用 /skills enable 恢复）\n` : `⚠️  未找到技能 ${id}\n`)
          return
        }

        // ---- suggest：隐式重复检测（F3）—— **只提示，不自动写，也不进 system** ----
        if (positional[0] === 'suggest' || positional.length === 0) {
          const trace = recorder.list(input.sessionId ?? '')
          const found = detectRepeatable(trace)
          out(
            found.length
              ? `\n检测到 ${found.length} 段可固化的重复流程（只提示，不会自动创建）：\n` +
                  found
                    .map(
                      (f) =>
                        `  · ${f.kind === 'sequence' ? '序列' : '单步'} ${f.toolIds.join(' → ')}（重复 ${f.count} 次）` +
                        `\n    可执行：/skill-forge <name> --desc "何时用"`,
                    )
                    .join('\n') +
                  '\n'
              : `\n未检测到重复流程（当前会话 ${trace.length} 条工具记录；判据：同一工具+同一入参重复 ≥3 次，或 2~6 步序列完整重复 ≥2 轮）\n`,
          )
          if (positional.length === 0) {
            out(
              '用法：\n' +
                '  /skill-forge <name> [--project] [--desc "何时用"]   生成草稿（仅展示，不落盘）\n' +
                '  /skill-forge --confirm <name> [--project] [--overwrite] [--bind]   确认落盘并当轮生效\n' +
                '  /skill-forge suggest | list | path | disable <id>\n',
            )
          }
          return
        }

        const name = positional[0]
        if (!name) {
          out(
            '用法：\n' +
              '  /skill-forge <name> [--project] [--desc "何时用"]   生成草稿（仅展示，不落盘）\n' +
              '  /skill-forge --confirm <name> [--project] [--overwrite] [--bind]   确认落盘并当轮生效\n' +
              '  /skill-forge suggest | list | path | disable <id>\n',
          )
          return
        }
        if (!manager) { out('未获得 skillManager（技能系统未装配）\n'); return }

        // id 形态在**出草稿前**就校验（评审修复）：否则用户看完草稿、走到 --confirm 才
        // 被 validateDraft 拒绝，白跑一轮。id 同时是目录名，规则与 SkillManager.save 一致。
        if (!isValidSkillId(name)) {
          out(`⚠️  技能名非法：${name}（只允许小写字母/数字/连字符/下划线，1~64 字符，如 acp-param-tuning）\n`)
          return
        }

        const scope = scopeOf(flags)
        const key = `${scope}:${name}`
        // 待确认草稿有界（评审修复）：上限 20，FIFO 淘汰最旧的 —— 防止反复生成草稿
        // 把 Map 撑大（每份草稿含完整正文）。
        while (pending.size >= 20) {
          const oldest = pending.keys().next().value
          if (oldest === undefined) break
          pending.delete(oldest)
        }

        // ---- 确认落盘 ----
        if (flags.has('--confirm') || flags.has('-y')) {
          const held = pending.get(key)
          if (!held) { out(`⚠️  没有待确认的草稿 ${key}，请先运行 /skill-forge ${name}${scope === 'project' ? ' --project' : ''}\n`); return }
          const check = validateDraft(held.draft)
          if (!check.ok) { out(`⚠️  草稿未通过校验：${check.message}\n`); return }
          const limit = options.maxSkills ?? 50
          if (manager.all().length >= limit && !flags.has('--overwrite')) {
            out(`⚠️  技能数已达上限 ${limit}（治理）：请先整理或禁用不用的技能\n`)
            return
          }
          void (async () => {
            await ensureDirs()
            const res = await manager!.save(draftToSkill(held.draft, scope), {
              scope,
              ...(flags.has('--overwrite') ? { overwrite: true } : {}),
            })
            if (res.ok) {
              pending.delete(key)
              out(`✅ ${res.message}\n`)
              const target = positional[1] ?? input.agentId
              // 注入只认 agent.skills 白名单（paths 触发是死代码）。
              // 默认**延迟**：改白名单就会改下一轮 system ⇒ 前缀缓存失效一次，攒到一起发布更划算。
              if (flags.has('--now')) {
                out(`${bindToAgent(name, target)}\n`)
              } else if (flags.has('--bind') || flags.has('--defer')) {
                // 排入**本会话**的队列：发布时机由本会话的压缩/轮末决定（见 schedulers 上的注释）
                const sched = schedulerFor(input.sessionId)
                sched.schedule(name, target)
                const st = sched.state()
                out(
                  `   已排入延迟注入队列（${st.pending.join('、')}）—— 下次压缩、或 ${st.flushAfterTurns} 轮后发布；\n` +
                    `   立即发布：/forge flush（也可在 --confirm 时加 --now）\n`,
                )
              } else {
                out(
                  `   说明：技能注入只认 Agent 的 skills 白名单 —— 加 --bind 排入延迟注入，或 --now 立即生效\n` +
                    `   （不加则只在 /skill-forge list 里可见，不会注入）\n`,
                )
              }
            } else {
              out(`⚠️  ${res.message}\n`)
            }
          })()
          return
        }

        // ---- 生成草稿（不落盘）----
        const trace = recorder.list(input.sessionId ?? '')
        const draft = draftFromTrace(name, trace, {
          ...(desc ? { description: desc } : {}),
          ...(options.maxSteps != null ? { maxSteps: options.maxSteps } : {}),
        })
        pending.set(key, { draft, at: Date.now() })
        const similar = findSimilarSkill(draft, manager.all())
        out(
          `\n${renderDraft(draft)}\n\n` +
            `落盘位置：${scope === 'project' ? ws?.project.skills : ws?.user.skills ?? '(未知)'}/${name}/SKILL.md` +
            `（${scope} 级${scope === 'project' ? '，会随 git 共享' : ''}）\n` +
            (similar
              ? `⚠️  与已有技能 ${similar.skill.id} 相似（${similar.score.toFixed(2)}）：建议改为更新它，或换个更具体的名字\n`
              : '') +
            `确认无误后执行：/skill-forge --confirm ${name}${scope === 'project' ? ' --project' : ''}\n` +
            `（可加 --overwrite 覆盖同名；${trace.length} 条轨迹参与生成）\n`,
        )
      }

      hooks['cli.command'] = cliCommandHandler
      commandHandler = cliCommandHandler
      return hooks as Hooks
    },
  }
}
