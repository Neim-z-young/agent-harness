/**
 * @harness/memory
 *
 * 长期记忆插件（M1 = 读路径）。
 *
 * 三层模型中的两层由本插件负责（见 docs/memory-and-skill-forge-plan.md §3.1）：
 * - **L0 项目指令**：`AGENTS.md`（user 级 `<dataDir>/AGENTS.md` + project 级 `<cwd>/AGENTS.md`）
 * - **L1 长期记忆**：`MEMORY.md` 索引（`<scope>/memory/MEMORY.md`，每会话加载前 N 行 / N 字节）
 *
 * **L2 会话压缩记忆**（`CompactMemory`）由 core 负责，不在这里。
 *
 * 三个已实证/已决策的前提（不要凭直觉改）：
 * 1. **注入走 `core.prompt.system.transform`** —— 这样合成出的 system 消息不带 `<acp>` ref 标签，
 *    ACP 无从把它圈进压缩范围（实证见计划 §3.4）。若改成塞进 messages 数组，会被打上 ref、
 *    变成可折叠对象。
 * 2. **system 占用永不回收** ⇒ 索引必须有硬上限（`maxLines` / `maxBytes`），且超限要显式
 *    标注"已截断"，不能静默丢弃（Claude Code 的坑：写入成功但下次加载被丢）。
 * 3. **子 Agent 不注入**（决策 B6，对齐 Claude Code）：按 `input.agentMode === 'subagent'` 跳过。
 *
 * 缓存友好性：注入文本只依赖文件内容 —— 文件不变则渲染出的 system 片段逐字相同，
 * 前缀缓存不受影响。故这里按 `mtime + size` 缓存读取结果，既省 IO 也避免无意义的重渲染。
 * （"把变更攒到下次压缩再注入"的分级策略见计划 §3.7，已实现 = `MemoryPublisher`。）
 *
 * ⚠️ **发布状态必须按会话隔离**（`publishers` / `hints`，见 `install()` 里的长注释）：
 * 一个进程里主会话与子 Agent 会话共存，而 compress 这类 flush 信号是引擎层广播的。
 * 实例级单例会把"子 Agent 压缩"当成"主会话压缩"，直接把主会话的 system 区重发一遍。
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentPlugin, CliCommandInput, Hooks, PluginContext, PluginWorkspaceView } from '@harness/plugin'

// ===== 常量 =====

/** 索引加载上限：行数（对齐 Claude Code 的 auto memory） */
export const MEMORY_INDEX_MAX_LINES = 200
/** 索引加载上限：字节数（同上，先到先算） */
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024
/** 项目指令（AGENTS.md）上限：比索引宽松，但同样必须有上限 */
export const INSTRUCTION_MAX_BYTES = 32 * 1024

/** 索引文件名 */
export const MEMORY_INDEX_FILE = 'MEMORY.md'
/** 项目指令文件名 */
export const INSTRUCTION_FILE = 'AGENTS.md'
/**
 * **机器自动回写**的失败反馈文件名（与人工维护的 `MEMORY.md` 分开）。
 *
 * 为什么要单列（真机量化，见 `renderFeedbackSection` 的长注释）：
 * `[feedback]` 条目由 harness 在"工具反复失败"时自动追加，**产生时刻与用户的轮无关**。
 * 住在 `MEMORY.md`（system 前缀区）里时，任何一条新反馈都会在下一个轮边界把整段前缀缓存
 * 作废 —— 实测一次 52,096 token（`s_1790163574429_tg1a6` round 32）。
 * 拆出去之后：人工维护的索引继续走 system（分级发布），机器反馈走**尾部动态区**，
 * 反复变化也不付前缀代价。
 */
export const FEEDBACK_FILE = 'FEEDBACK.md'
/** feedback 条目标记（`- [feedback] …`）；迁移与注入都靠它识别 */
export const FEEDBACK_ENTRY_TAG = '[feedback]'
/**
 * 尾部注入的 feedback 条数上限（取**最新**的）与字节上限。
 *
 * 为什么这么小：尾部动态区**不参与前缀缓存** ⇒ 这些 token 每一轮都按全价重算。
 * 一个 450 token 的尾块跑 62 轮就是 ~28K token-equiv，比放进 system（缓存价）贵得多。
 * 所以反馈只保留"最近几次踩过的坑"就够 —— 更早的失败多半已经不再相关。
 */
export const FEEDBACK_INJECT_MAX_ENTRIES = 5
export const FEEDBACK_INJECT_MAX_BYTES = 800

// ===== 纯函数：带上限读取 =====

export interface CappedRead {
  path: string
  exists: boolean
  /** 截断后的文本（不存在时为空串） */
  text: string
  /** 原文件总行数（不存在为 0） */
  totalLines: number
  /** 是否被上限截断 */
  truncated: boolean
  /** 截断原因（行数先到 / 字节先到） */
  truncatedBy?: 'lines' | 'bytes'
}

export interface CapOptions {
  maxLines?: number
  maxBytes?: number
}

/**
 * 读取文件并按行/字节上限截断（纯函数，读取实现可注入）。
 *
 * 截断是**显式**的：返回 `truncated` 与 `truncatedBy`，由调用方在注入文本里标注出来，
 * 避免"写了却读不到"的静默失效。
 */
export function readCapped(
  path: string,
  opts: CapOptions = {},
  read: (p: string) => string = (p) => readFileSync(p, 'utf-8'),
): CappedRead {
  const maxLines = opts.maxLines ?? MEMORY_INDEX_MAX_LINES
  const maxBytes = opts.maxBytes ?? MEMORY_INDEX_MAX_BYTES
  if (!existsSync(path)) {
    return { path, exists: false, text: '', totalLines: 0, truncated: false }
  }
  let raw: string
  try {
    raw = read(path)
  } catch {
    // 读失败（权限等）当作"不存在"处理：记忆是增益能力，不能因为它让整轮推理失败
    return { path, exists: false, text: '', totalLines: 0, truncated: false }
  }
  const lines = raw.split('\n')
  const totalLines = lines.length
  let truncated = false
  let truncatedBy: 'lines' | 'bytes' | undefined

  let kept = lines
  if (lines.length > maxLines) {
    kept = lines.slice(0, maxLines)
    truncated = true
    truncatedBy = 'lines'
  }
  let text = kept.join('\n')
  if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
    // 字节先到：按字符二分不稳，直接截字符数（UTF-8 下 1 字符 ≥ 1 字节 ⇒ 截 maxBytes 字符必然不超）
    text = text.slice(0, maxBytes)
    truncated = true
    truncatedBy = truncatedBy === 'lines' ? 'lines' : 'bytes'
  }
  return { path, exists: true, text, totalLines, truncated, ...(truncatedBy ? { truncatedBy } : {}) }
}

// ===== 组装注入片段 =====

export interface MemoryLayer {
  /** 展示用标签（如「用户长期记忆」） */
  label: string
  read: CappedRead
}

/** 片段样式覆盖（默认给 system 区的记忆段用，签名与措辞都不能随手改 —— 改了就是全量前缀失效） */
export interface MemorySectionStyle {
  /** 外层标签名（默认 `memory`） */
  tag?: string
  /** 引导语（逐行，插在标签之后） */
  intro?: string[]
}

/**
 * 把若干层渲染成一个 system 片段；**全部不存在时返回空串**（不注入任何噪声）。
 *
 * 措辞上刻意强调"只在相关时参考、不要复述" —— 记忆是上下文而非强制配置
 * （Claude Code 文档同样的定位），否则模型会倾向于在回答里罗列记忆内容。
 *
 * ⚠️ 默认措辞（`intro` 缺省时）是**前缀缓存的一部分**：这些字一旦改动，所有历史会话的
 * system 段都会变一次。要调整就单独传 `style`，别动默认值。
 */
export function renderMemorySection(layers: MemoryLayer[], style: MemorySectionStyle = {}): string {
  const present = layers.filter((l) => l.read.exists && l.read.text.trim().length > 0)
  if (present.length === 0) return ''

  const blocks: string[] = [
    `<${style.tag ?? 'memory'}>`,
    ...(style.intro ?? [
      '以下是跨会话保留的记忆与项目指令，供你参考。它们不是本轮任务的逐字要求：',
      '只在相关时遵循，不要向用户复述或引用本节本身。',
      // 快照语义要说清楚：分级注入（§3.7）下刚写进去的内容不一定已经出现在本节里，
      // 否则模型会以为"我写了却没生效"（文件其实早已写入）。给出自证手段即可，不必解释机制。
      '本节是**快照**（上面各节标题里就是文件路径）：若你刚写入过记忆、或怀疑内容已过期，',
      '直接用 read 工具读那些文件 —— 文件永远是最新的，本节只是它的一个副本。',
    ]),
  ]
  for (const l of present) {
    blocks.push('', `## ${l.label}（${l.read.path}）`)
    if (l.read.truncated) {
      const why = l.read.truncatedBy === 'bytes' ? '字节上限' : '行数上限'
      blocks.push(
        `（注意：内容因${why}被截断，超出部分**不会被加载** —— 继续追加只会排在读不到的区间里。` +
          `请先用 read 读取该文件全文，把冗长条目合并或删除后再写；` +
          `当前仅加载了前 ${l.read.text.split('\n').length} 行 / 原 ${l.read.totalLines} 行）`,
      )
    }
    blocks.push(l.read.text.trimEnd())
  }
  blocks.push(`</${style.tag ?? 'memory'}>`)
  return blocks.join('\n')
}

// ===== 失败反馈（机器回写，走尾部动态区）=====

export interface FeedbackSectionOptions {
  /** 注入多少条（取**最新**的），默认 `FEEDBACK_INJECT_MAX_ENTRIES` */
  maxEntries?: number
  /** 注入字节上限，默认 `FEEDBACK_INJECT_MAX_BYTES` */
  maxBytes?: number
}

/**
 * 渲染**失败反馈**块（`FEEDBACK.md`）—— 给 `core.prompt.dynamic.transform` 用，不进前缀区。
 *
 * 为什么不跟 `MEMORY.md` 一起去 system：
 * 这些条目是 harness 自动写的（工具反复失败 ⇒ 回写一条教训），**写入选时刻由工具失败驱动**、
 * 跟用户的轮毫无关系。放在前缀区意味着"某次工具报错"和"整段 system 前缀报废"被绑在一起，
 * 而它换来的收益往往只是避免重复踩一个已经从工具契约层面修掉的坑。
 * 真机证据（`s_1790163574429_tg1a6`）：失败 subagent 的 2 条 grep 失败被回写 ⇒ 主会话
 * round 32 `cacheMissReason: system-changed`、`cacheDropTokens: 52,096`，而主会话那段
 * 压根没碰过 grep_file。
 *
 * 代价侧：尾部**不参与缓存** ⇒ 每一轮全价。故条数与字节都压得很小（默认最近 5 条 / 800 字节），
 * 且只在文件存在时注入（不存在 ⇒ 空串 ⇒ 零成本）。
 */
export function renderFeedbackSection(
  layers: MemoryLayer[],
  opts: FeedbackSectionOptions = {},
): string {
  const maxEntries = opts.maxEntries ?? FEEDBACK_INJECT_MAX_ENTRIES
  const maxBytes = opts.maxBytes ?? FEEDBACK_INJECT_MAX_BYTES
  const present = layers.filter((l) => l.read.exists && l.read.text.trim().length > 0)
  if (present.length === 0) return ''

  const blocks: string[] = [
    '<memory-feedback>',
    '以下是**工具反复失败时自动记下**的教训（不是本轮任务要求，只在相关时用来避免重蹈覆辙；不要向用户复述本节）。',
    '这里只放**最近几条**，完整内容请用 read 工具读下面的文件。',
  ]
  let omitted = 0
  for (const l of present) {
    const entries = parseEntries(l.read.text)
    const taken = entries.slice(-maxEntries)
    omitted += Math.max(0, entries.length - taken.length)
    blocks.push('', `## ${l.label}（${l.read.path}）`)
    // 逐条从**最新往旧**加，超字节就丢最旧的 —— 保证"最近的坑"优先留下
    const lines: string[] = []
    let bytes = 0
    for (const e of [...taken].reverse()) {
      const line = `${ENTRY_PREFIX}${e.text}`
      const b = Buffer.byteLength(line, 'utf-8') + 1
      if (lines.length > 0 && bytes + b > maxBytes) {
        omitted += 1
        continue
      }
      lines.unshift(line)
      bytes += b
    }
    blocks.push(lines.join('\n'))
  }
  if (omitted > 0) blocks.push(`（另有 ${omitted} 条更早的反馈未注入）`)
  blocks.push('</memory-feedback>')
  return blocks.join('\n')
}

/**
 * 把索引里的 `[feedback]` 条目摘出来（迁移到 `FEEDBACK.md` 用）。
 *
 * 返回 `kept`（保留部分的全文，**保留末尾换行**）与 `moved`（摘出的整行）。
 * 迁移是显式命令而不是加载时自动做：改用户记忆文件必须由用户发起。
 */
export function splitFeedbackEntries(text: string): { kept: string; moved: string[] } {
  const moved: string[] = []
  const kept = text.split('\n').filter((l) => {
    const isFeedback =
      l.startsWith(ENTRY_PREFIX) && l.slice(ENTRY_PREFIX.length).trim().startsWith(FEEDBACK_ENTRY_TAG)
    if (isFeedback) moved.push(l)
    return !isFeedback
  })
  return { kept: kept.join('\n'), moved }
}

// ===== 路径解析 =====

export interface MemoryPaths {
  user: { index: string; instruction: string; dir: string; feedback: string }
  project: { index: string; instruction: string; dir: string; feedback: string }
}

/** 由工作区视图推出各文件路径（纯函数） */
export function resolveMemoryPaths(ws: PluginWorkspaceView): MemoryPaths {
  return {
    user: {
      dir: ws.user.memory,
      index: join(ws.user.memory, MEMORY_INDEX_FILE),
      instruction: join(ws.dataDir, INSTRUCTION_FILE),
      feedback: join(ws.user.memory, FEEDBACK_FILE),
    },
    project: {
      dir: ws.project.memory,
      index: join(ws.project.memory, MEMORY_INDEX_FILE),
      instruction: join(ws.cwd, INSTRUCTION_FILE),
      feedback: join(ws.project.memory, FEEDBACK_FILE),
    },
  }
}

// ===== 读取器（带 mtime 缓存）=====

/**
 * 带缓存的文件读取器。
 *
 * 缓存键是路径，校验用 `mtimeNs + size`：文件没变则复用上次的 `CappedRead`。
 * 这保证**同一内容 ⇒ 同一渲染结果 ⇒ 前缀缓存不受影响**（§3.7），也省掉每轮的重复读盘。
 * 文件被外部编辑时会自动失效（下一次 hook 调用即读到新内容）——M1 直接生效；
 * "攒到下次压缩再刷新"的分级策略是 M2 的事。
 *
 * ⚠️ 精度必须到纳秒：原先用 `mtimeMs`，而「同毫秒内写入 + 内容字节数相同」会被判成"没变"，
 * 缓存便返回旧内容 —— 表现为"明明改了却没生效"。模型用 write 工具重写索引、或写入与旧内容
 * 等长的条目时正是这个组合（本插件自己的测试就先被它咬了一口）。
 */
export class MemoryReader {
  private cache = new Map<string, { stamp: string; view: CappedRead }>()

  constructor(private readonly opts: CapOptions = {}) {}

  read(path: string): CappedRead {
    let stamp = 'missing'
    try {
      const st = statSync(path, { bigint: true })
      stamp = `${st.mtimeNs}:${st.size}`
    } catch {
      stamp = 'missing'
    }
    const hit = this.cache.get(path)
    if (hit && hit.stamp === stamp) return hit.view
    const view = readCapped(path, this.opts)
    this.cache.set(path, { stamp, view })
    return view
  }

  /** 清空缓存（测试/强制刷新用） */
  clear(): void {
    this.cache.clear()
  }
}

// ===== 写入（M2）=====

export type MemoryScope = 'user' | 'project'

export interface EntryView {
  /** 1-based 序号（与 `/memory list` 展示一致） */
  index: number
  text: string
  /** 该条目在文件里的物理行号（0-based） */
  line: number
}

export interface WriteResult {
  ok: boolean
  reason?: 'duplicate' | 'over-limit' | 'not-found' | 'io-error' | 'empty'
  /** 人类可读说明（失败时必填，成功时可省） */
  message?: string
  lines?: number
  bytes?: number
  index?: number
}

/** 条目前缀：统一 `- ` 便于按行增删与去重 */
export const ENTRY_PREFIX = '- '

/**
 * 解析索引文件的条目（`- ` 开头的行；标题/空行/其它 Markdown 结构保留但不计入条目）。
 */
export function parseEntries(text: string): EntryView[] {
  const out: EntryView[] = []
  const lines = text.split('\n')
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? ''
    if (l.startsWith(ENTRY_PREFIX)) {
      out.push({ index: ++n, text: l.slice(ENTRY_PREFIX.length).trim(), line: i })
    }
  }
  return out
}

function normalizeEntry(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 索引写入器（M2）。
 *
 * 三条硬规则：
 * 1. **超限即拒绝，且不落盘** —— 先预演新内容再校验，避免 Claude Code 那个
 *    "写入成功但下次加载被丢弃"的静默失效。
 * 2. **去重**：同一条（空白归一化后完全相同）不重复追加 —— 反复"记住同一件事"
 *    不该把索引撑爆。
 * 3. **原子写**：临时文件 + rename，避免写到一半崩溃留下半截索引。
 */
export class MemoryStore {
  constructor(
    private readonly path: string,
    private readonly opts: CapOptions = {},
  ) {}

  private get maxLines(): number {
    return this.opts.maxLines ?? MEMORY_INDEX_MAX_LINES
  }

  private get maxBytes(): number {
    return this.opts.maxBytes ?? MEMORY_INDEX_MAX_BYTES
  }

  /** 全量读取（**不截断**）——条目增删必须基于完整内容，`MemoryReader.read` 的截断视图不能用于写 */
  private readFull(): string {
    if (!existsSync(this.path)) return ''
    try {
      return readFileSync(this.path, 'utf-8')
    } catch {
      return ''
    }
  }

  /** 全量读取（公开只读版本）：给迁移/整理这类"要看到完整原文"的调用方用 */
  rawText(): string {
    return this.readFull()
  }

  entries(): EntryView[] {
    return parseEntries(this.readFull())
  }

  /** 预演校验：返回超限说明（不超限则 undefined） */
  private checkLimit(next: string): WriteResult | undefined {
    const lines = next.split('\n').length
    const bytes = Buffer.byteLength(next, 'utf-8')
    if (lines > this.maxLines) {
      return {
        ok: false,
        reason: 'over-limit',
        message: `索引将达 ${lines} 行，超过上限 ${this.maxLines} 行 —— 已拒绝写入（请先精简或把细节移到主题文件）`,
        lines,
        bytes,
      }
    }
    if (bytes > this.maxBytes) {
      return {
        ok: false,
        reason: 'over-limit',
        message: `索引将达 ${bytes} 字节，超过上限 ${this.maxBytes} 字节 —— 已拒绝写入（请先精简或把细节移到主题文件）`,
        lines,
        bytes,
      }
    }
    return undefined
  }

  private writeAtomic(text: string): void {
    // 目标已是符号链接时拒绝写入（评审建议）：MEMORY.md 被换成符号链接时，
    // 原子写会经链接写到任意文件。正常路径下它不该是链接。
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) {
      throw new Error(`目标是符号链接，拒绝写入：${this.path}`)
    }
    mkdirSync(dirname(this.path), { recursive: true })
    // 权限：**沿用已有文件的模式**，新文件按 0600 建。
    // 为什么要显式管：临时文件 + rename 会把权限重置成 umask 默认（644），
    // 而记忆文件里会有本机绝对路径、个人偏好这类内容；skill-forge 的 writeFeedbackMemory
    // 是按 0600 建的 ⇒ 同一个 FEEDBACK.md 被两条写路径写出两种权限，本身就是不一致。
    let mode = 0o600
    try {
      mode = statSync(this.path).mode & 0o777
    } catch {
      /* 文件不存在 ⇒ 用 0600 */
    }
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, text, 'utf-8')
    chmodSync(tmp, mode) // writeFileSync 的 mode 会被 umask 掩掉，chmod 才是准的
    renameSync(tmp, this.path)
  }

  /** 追加一条；重复（归一化后相同）返回 duplicate；超限返回 over-limit 且不落盘 */
  add(rawText: string): WriteResult {
    const text = normalizeEntry(rawText)
    if (!text) return { ok: false, reason: 'empty', message: '条目为空' }

    const cur = this.readFull()
    const existing = parseEntries(cur).map((e) => normalizeEntry(e.text))
    if (existing.includes(text)) {
      return { ok: false, reason: 'duplicate', message: '该条目已存在，未重复写入' }
    }

    const base = cur.length === 0 || cur.endsWith('\n') ? cur : `${cur}\n`
    const next = `${base}${ENTRY_PREFIX}${text}\n`
    const over = this.checkLimit(next)
    if (over) return over

    try {
      this.writeAtomic(next)
    } catch (e) {
      return { ok: false, reason: 'io-error', message: String((e as Error)?.message ?? e) }
    }
    const lines = next.split('\n').length
    return { ok: true, lines, bytes: Buffer.byteLength(next, 'utf-8'), index: existing.length + 1 }
  }

  /** 按 1-based 序号或文本（归一化精确匹配）删除一条 */
  remove(target: string): WriteResult {
    const cur = this.readFull()
    const entries = parseEntries(cur)
    if (entries.length === 0) return { ok: false, reason: 'not-found', message: '索引为空，无可删除条目' }

    const asNum = Number(target)
    let hit: EntryView | undefined
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= entries.length) {
      hit = entries[asNum - 1]
    } else {
      const want = normalizeEntry(target)
      hit = entries.find((e) => normalizeEntry(e.text) === want)
    }
    if (!hit) return { ok: false, reason: 'not-found', message: `未找到条目：${target}` }

    const lines = cur.split('\n')
    lines.splice(hit.line, 1)
    const next = lines.join('\n')
    try {
      this.writeAtomic(next)
    } catch (e) {
      return { ok: false, reason: 'io-error', message: String((e as Error)?.message ?? e) }
    }
    return { ok: true, lines: next.split('\n').length, bytes: Buffer.byteLength(next, 'utf-8') }
  }

  /** 供诊断：剩余额度（写入前自查） */
  budget(): { lines: number; maxLines: number; bytes: number; maxBytes: number } {
    const cur = this.readFull()
    return {
      lines: cur.split('\n').length,
      maxLines: this.maxLines,
      bytes: Buffer.byteLength(cur, 'utf-8'),
      maxBytes: this.maxBytes,
    }
  }

  /**
   * 整文件重写（迁移/整理用）。仍走**同一套**护栏：上限预演 → 符号链接拒绝 → 原子写。
   *
   * 为什么单独开一个方法而不是让调用方自己 writeFileSync：「先校验再落盘」这条规则
   * 一旦有第二个写入口绕开，`over-limit` 就变成"看运气"。
   */
  rewrite(text: string): WriteResult {
    const over = this.checkLimit(text)
    if (over) return over
    try {
      this.writeAtomic(text)
    } catch (e) {
      return { ok: false, reason: 'io-error', message: String((e as Error)?.message ?? e) }
    }
    return { ok: true, lines: text.split('\n').length, bytes: Buffer.byteLength(text, 'utf-8') }
  }
}

// ===== 分级注入（M3，§3.7）=====

export interface PublishOptions {
  /**
   * 攒批轮数：连续多少**轮**检测到变更后才发布（默认 15）。
   * `0` = 关闭攒批（任何变更立即生效，等价 M2 行为）。
   *
   * 为什么是 15：这个数字是「防静默失效的兜底」而非节流目标 —— 正常情况下发布由**压缩**触发
   * （那种时机下 system 变更免费）。所以它只要"足够大到平时不抢先、又足够小到长时间不压缩时
   * 也能生效"。按一轮 1~3 次模型调用估，15 轮 ≈ 几十次调用内必定生效。
   */
  flushAfterTurns?: number
}

/**
 * 分级发布器：决定**什么时候**把新的记忆文本真正换进 system prompt。
 *
 * 为什么需要它（§3.7）：system 在请求最前面，任何变更都让其后所有分块的前缀缓存失效。
 * 而"压缩"本身已经改写了消息序列 ⇒ 缓存必然失效 ⇒ 把 system 变更**搭车**到那一刻，
 * 边际成本≈0；反过来，在两次压缩之间插一次变更，等于额外制造一次全量失效。
 *
 * 行为：
 * - 首次（进程内无已发布内容）⇒ 立即发布（否则永远不注入）
 * - 内容与已发布一致 ⇒ 什么都不做（这正是"文件不变 ⇒ system 逐字不变"的实现）
 * - 内容有变 ⇒ 标记 dirty，**继续用旧内容**；直到 flush 信号或攒够 `flushAfterTurns` 轮
 * - `flush()`（压缩发生 / 显式写入 / reload）⇒ 下次注入即发布最新内容
 */
export class MemoryPublisher {
  private published: string | null = null
  private dirty = false
  private dirtyTurns = 0
  private forced = false

  constructor(private readonly opts: PublishOptions = {}) {}

  private get flushAfter(): number {
    return this.opts.flushAfterTurns ?? 15
  }

  /** 每轮注入时调用；返回**本次应当注入**的文本 */
  onInject(candidate: string): string {
    if (this.forced || this.published === null || this.flushAfter <= 0) {
      this.publish(candidate)
      return this.published!
    }
    // 双向更新：内容又变回已发布的样子（例如用户撤销了编辑）时也要清掉 dirty，
    // 否则会带着一个永远不会被发布的"待发布"状态空转、并在攒够轮数后白发布一次
    this.dirty = candidate !== this.published
    return this.published
  }

  /** 轮末推进（`turn_end`）：dirty 状态攒够轮数则安排下一次发布（兜底，防止永远等不到压缩） */
  onTurnEnd(): void {
    if (!this.dirty || this.forced) return
    this.dirtyTurns += 1
    if (this.dirtyTurns >= this.flushAfter) this.forced = true
  }

  /** 立即安排发布（压缩发生 / 显式写入 / reload） */
  flush(): void {
    this.forced = true
  }

  private publish(candidate: string): void {
    this.published = candidate
    this.dirty = false
    this.dirtyTurns = 0
    this.forced = false
  }

  /** 诊断（`/memory` 用） */
  state(): { published: boolean; dirty: boolean; dirtyTurns: number; flushAfterTurns: number } {
    return {
      published: this.published !== null,
      dirty: this.dirty,
      dirtyTurns: this.dirtyTurns,
      flushAfterTurns: this.flushAfter,
    }
  }
}

/**
 * 压缩后的一次性"沉淀提示"。
 *
 * 触发时机就是缓存已经失效的那一刻（压缩），所以它多出来的 system 变更是**免费**的
 * —— 与 §3.7 的搭车逻辑同源。刻意写成一次性、并要求"只在真有值得记的内容时写"，
 * 避免模型为了完成提示而制造垃圾记忆。
 */
export function buildReflectionHint(indexPath: string): string {
  return [
    '<memory-hint>',
    '刚刚发生了上下文压缩（部分历史已被折叠成摘要）。',
    `如果刚才的对话里有值得**长期**保留的纠正、决策或偏好，请用 write 工具把它追加到：${indexPath}`,
    '格式：一行一条，以 `- ` 开头；只写一句结论，细节请另建主题文件并用 `read` 工具按需读取。',
    // 防重复：system 里那份是快照，可能还没包含你刚写过的条目 ⇒ 先读文件再决定写什么。
    '写之前先用 read 看一眼该文件，确认这条还没有 —— 避免重复追加（等价条目会被拒，但白跑一趟）。',
    '只在确有值得记的内容时写，不必为了响应本提示而写。',
    '</memory-hint>',
  ].join('\n')
}

// ===== 插件 =====

export interface MemoryPluginOptions {
  /** 覆盖工作区（缺省用 `PluginContext.workspace`；测试用） */
  workspace?: PluginWorkspaceView
  /** 索引上限覆盖 */
  maxLines?: number
  maxBytes?: number
  /** 关闭注入（只保留 /memory 命令）——用于对照实验 */
  disableInjection?: boolean
  /**
   * 攒批轮数（§3.7 分级注入）：`0` = 任何变更立即生效（M2 行为，测试常用），
   * 缺省 **15** 轮 —— 一轮 = 一次「用户输入 → Agent 跑完」（不是一次模型调用）；
   * 期间若发生压缩则立即发布（搭车省缓存）。
   */
  flushAfterTurns?: number
  id?: string
}

/** 把「项目指令」文件状态渲染成一行（不存在也给出路径，便于排障） */
function instructionLine(r: CappedRead): string {
  if (!r.exists) return `不存在（${r.path}）`
  const lines = r.text.split('\n').length
  return (
    `${lines} 行 · ${Buffer.byteLength(r.text, 'utf-8')} 字节` +
    (r.truncated ? `（已截断，原 ${r.totalLines} 行）` : '') +
    ` — ${r.path}`
  )
}

/**
 * 构建记忆插件。
 *
 * 三个里程碑都在本文件里：M1 读路径（加载 + 注入 + `/memory list|show|path`）、
 * M2 写路径（`MemoryStore`：原子写 / 去重 / 超限拒绝）、M3 分级发布（`MemoryPublisher`：把
 * 变更攒到压缩那一刻，避免为一条记忆付整段前缀失效）。M3 的发布状态**按会话隔离** ——
 * 这一点不是优化而是正确性要求，见 `install()` 里的注释与真机事故记录。
 */
export function createMemoryPlugin(options: MemoryPluginOptions = {}): AgentPlugin {
  let paths: MemoryPaths | undefined
  let reader: MemoryReader | undefined
  let injectedSkips = 0

  return {
    id: options.id ?? 'memory',
    version: '0.1.0',
    name: 'Memory',
    description: '长期记忆：加载两级 MEMORY.md 索引与 AGENTS.md 项目指令并注入 system prompt（子 Agent 不注入）',

    async install(ctx: PluginContext): Promise<Hooks | void> {
      const ws = options.workspace ?? ctx.workspace
      if (!ws) {
        // 没有工作区视图就只能靠猜路径 —— 宁可什么都不做（记忆是增益能力，不能因它出错）
        ctx.log.debug?.('未获得 workspace 路径视图，记忆插件已禁用')
        return {}
      }
      paths = resolveMemoryPaths(ws)
      reader = new MemoryReader({ maxLines: options.maxLines, maxBytes: options.maxBytes })
      const p = paths

      const load = (): MemoryLayer[] => {
        const r = reader!
        return [
          { label: '项目指令', read: r.read(p.project.instruction) },
          { label: '用户长期记忆', read: r.read(p.user.index) },
          { label: '项目长期记忆', read: r.read(p.project.index) },
        ]
      }

      /**
       * 失败反馈层（**不进 system**，只走尾部动态区）。见 `renderFeedbackSection`。
       * 与 `load()` 分开是刻意的：这两类的"要不要注入、注入到哪"是不同决策，
       * 合在一个数组里迟早会被某个调用方一起塞进 system。
       */
      const loadFeedback = (): MemoryLayer[] => {
        const r = reader!
        return [
          { label: '用户失败反馈', read: r.read(p.user.feedback) },
          { label: '项目失败反馈', read: r.read(p.project.feedback) },
        ]
      }

      /**
       * 发布器与沉淀提示都**按会话**持有 —— 不能是插件实例级的闭包变量。
       *
       * 为什么必须隔离：一个进程里同时跑着主会话与若干子 Agent 会话（swarm / coordinator 的
       * 后台派工都在同一个 core 里），而 `core.tool.post.execute` 的 compress 判定此前只看
       * `tool.id`。于是**子 Agent 的一次压缩会把主会话发布器的 `forced` 置位**；主会话的
       * system 区又是「一次查询内不变」（core `_prepareQueryOnce`）⇒ 只在轮边界重建 ⇒
       * 下一个轮边界立刻带上一条与它无关的新记忆重发前缀，整段缓存报废。
       *
       * 真机事故（s_1790163574429_tg1a6）：失败 reader 子会话在 19:42:55 / 19:43:23 各压缩
       * 一次 → skill-forge 把它的 grep 失败回写进 `MEMORY.md`（19:43:47，+2 条 = +192 字符）
       * → 主会话 round 32 报 `cacheMissReason: system-changed`、
       * `cacheDropTokens: 52,096`（system 段 427 → 619 字符）。
       * 同一轮请求的尾部动态区恰好 270 字符，与 `buildReflectionHint` 逐字长度完全相等 ⇒
       * 主会话还被喂了一句"刚刚发生了上下文压缩"，而它自己 `compressionCount: 0`。
       *
       * 另外这也顺带解决了另一件事：`/memory add` 的"命令写入立即发布"只对**发起该命令的**
       * 会话生效，不会顺手把别的会话的前缀也打掉。
       */
      const publishers = new Map<string, MemoryPublisher>()
      const hints = new Map<string, string>()
      /** 已确认的非子 Agent 会话；只有它们参与发布与沉淀提示 */
      const mainSessions = new Set<string>()
      /**
       * 惰性建发布器。键只在**主会话**上被创建（system.transform 的非 subagent 分支、
       * CLI 命令）⇒ 数量与进程内主会话数同阶，不会被子 Agent 会话刷爆。
       */
      const publisherFor = (sessionId: string): MemoryPublisher => {
        let pub = publishers.get(sessionId)
        if (!pub) {
          pub = new MemoryPublisher({
            ...(options.flushAfterTurns != null ? { flushAfterTurns: options.flushAfterTurns } : {}),
          })
          publishers.set(sessionId, pub)
        }
        return pub
      }

      const hooks: Hooks = {
        async 'core.prompt.system.transform'(input, parts) {
          // 先记会话再判分支：disableInjection（对照实验）下也要能归因，否则该会话永远收不到发布
          if (input.agentMode !== 'subagent') mainSessions.add(input.sessionId)
          if (options.disableInjection) return
          // 决策 B6：主会话的记忆不注入子 Agent（对齐 Claude Code 的 subagent 隔离）
          if (input.agentMode === 'subagent') {
            injectedSkips += 1
            return
          }
          // 分级发布：新内容不一定立刻进 system（攒到压缩那一刻或攒够轮数），见 MemoryPublisher
          const text = publisherFor(input.sessionId).onInject(renderMemorySection(load()))
          if (text) parts.push(text)
        },

        /**
         * 一次性沉淀提示走**尾部动态区**，不走 system 区。
         *
         * 为什么必须挪：它天然是"出现一轮、下一轮消失"的形态。留在 system 里会产生**两次**
         * 前缀失效 —— 出现时一次、消失时又一次；而"消失"那次并**不**伴随压缩，是纯浪费
         * （压缩时 system 本来就会因 core 的 `appendCompactionMemory` 而变化，搭那次车才免费，
         * 见 PublishOptions.flushAfterTurns 的说明）。放尾部则两次都免费 —— 尾部本来就是
         * 每轮重算的部分，不参与前缀缓存。
         *
         * 分支判据与 system 侧保持一致（子 Agent 不注入、disableInjection 关闭），
         * 否则会出现"主会话提示了、子 Agent 也提示了"的越界。
         * **按会话取**：提示是"谁压缩了就给谁"，跨会话转交等于让模型收到一条假事实。
         */
        /**
         * 尾部动态区承载**两样东西**：一次性沉淀提示（见下）+ 失败反馈快照。
         *
         * 共同点：内容随时会变、且变化时刻与用户的轮无关 ⇒ 只能放在不参与前缀缓存的位置。
         *
         * 分支判据与 system 侧保持一致（子 Agent 不注入、disableInjection 关闭），
         * 否则会出现"主会话提示了、子 Agent 也提示了"的越界。
         * **按会话取**：提示是"谁压缩了就给谁"，跨会话转交等于让模型收到一条假事实。
         */
        'core.prompt.dynamic.transform'(input, parts) {
          if (options.disableInjection) return
          if (input.agentMode === 'subagent') return
          // 反馈块每轮重渲染（Reader 按 mtime+size 缓存读取，代价只有字符串拼接）。
          // 文件不存在 ⇒ 空串 ⇒ 一个 token 都不花。
          const fb = renderFeedbackSection(loadFeedback())
          if (fb) parts.push(fb)
          const hint = hints.get(input.sessionId)
          if (!hint) return
          parts.push(hint)
          hints.delete(input.sessionId) // 一次性（且只对本会话一次性）
        },

        /**
         * 压缩信号（flush 双源之一）：ACP 压缩由模型调 `compress` 工具触发。
         *
         * 走**引擎层** `core.tool.post.execute`（ctx 带 `tool.id` 与 `sessionId`，任何宿主都有）：
         * 早先用的 `cli.agent.stream` 是 UI 消费层通道 —— 以库内嵌 / ACP 宿主自己消费
         * 事件流时收不到（那时只剩轮数兜底与命令写入）。压缩执行完再 flush 语义也更准：
         * 下一次注入（无论同轮续跑还是下一轮）读到的一定是压缩后的干净窗口。
         *
         * **必须判会话归属**：子 Agent 压缩腾的是它自己的窗口，凭什么叫主会话改 system 区。
         * `sessionId` 缺失时按"无法归因"处理 ⇒ **不 flush**（fail-closed）：攒批最多晚发布
         * 几轮，误 flush 是一次 5 万 token 级的前缀报废，代价不对称。
         */
        'core.tool.post.execute'(hctx: unknown, result: unknown) {
          const h = hctx as { tool?: { id?: string }; ctx?: { sessionId?: string } } | undefined
          if (h?.tool?.id !== 'compress') return
          if ((result as { ok?: boolean } | undefined)?.ok === false) return
          const sid = h.ctx?.sessionId
          if (!sid || !mainSessions.has(sid)) return
          publisherFor(sid).flush()
          hints.set(sid, buildReflectionHint(p.user.index))
        },

        /**
         * 兜底：攒够轮数仍未等到压缩 ⇒ 放行（防止"永远不生效"）。
         *
         * 用**引擎层**的 `core.agent.turn.end`（core 广播，任何宿主都有），而不是 `cli.agent.stream` 的
         * turn_end —— 后者只在有 UI 消费层的宿主里才有；靠它计数会"永不推进"，且这种失效
         * 表现为"记忆改了没生效"，极难排查。
         * 只数**主会话**的轮，并排除子 Agent（子 Agent 另开 session，且它的轮不是用户的轮）；
         * 字段缺失时按"无法归因"照常计数 —— 此时对**所有**已发布过的主会话各推进一格
         * （正常路径只有一个）：宁可不精确，也不要让兜底变成死代码。
         */
        'core.agent.turn.end'(signal) {
          if (signal.mode === 'subagent') return
          const sid = signal.sessionId
          if (!sid) {
            for (const pub of publishers.values()) pub.onTurnEnd()
            return
          }
          publishers.get(sid)?.onTurnEnd()
        },

        /** 压缩信号（flush 双源之二）：session compaction（ACP 关闭时的那套），同样按会话 */
        'core.session.compacting'(input) {
          const sid = input?.sessionId
          if (!sid || !mainSessions.has(sid)) return
          publisherFor(sid).flush()
          hints.set(sid, buildReflectionHint(p.user.index))
        },

        'cli.commands'(input) {
          input.commands.push({
            command: 'memory',
            description: '长期记忆：查看 / 追加 / 删除条目（add · rm · show · path · reload · migrate）',
            usage: '/memory [add|rm] [user|project] <内容|序号>',
          })
        },

        'cli.command'(input: CliCommandInput) {
          if (input.command !== 'memory') return
          input.result = 'continue'
          const arg = (input.arg ?? '').trim()
          const sub = arg.split(/\s+/)[0] ?? ''

          if (sub === 'path') {
            input.out(
              `记忆路径\n` +
                `  项目指令    ${p.project.instruction}\n` +
                `  用户索引    ${p.user.index}\n` +
                `  项目索引    ${p.project.index}\n` +
                `  用户反馈    ${p.user.feedback}\n` +
                `  项目反馈    ${p.project.feedback}\n`,
            )
            return
          }

          if (sub === 'show') {
            const which = (arg.split(/\s+/)[1] ?? '').toLowerCase()
            const layers = load()
            const feeds = loadFeedback()
            const pick =
              which === 'user' ? layers[1] :
              which === 'project' ? layers[2] :
              which === 'instruction' ? layers[0] :
              which === 'feedback' ? feeds[0] :
              which === 'feedback-project' ? feeds[1] :
              undefined
            if (!pick) {
              input.out('用法：/memory show <user|project|instruction|feedback|feedback-project>\n')
              return
            }
            if (!pick.read.exists) {
              input.out(`${pick.label}：文件不存在（${pick.read.path}）\n`)
              return
            }
            const tail = pick.read.truncated ? `\n（已截断，原文件 ${pick.read.totalLines} 行）\n` : ''
            input.out(`\n${pick.label} — ${pick.read.path}\n${'─'.repeat(40)}\n${pick.read.text}${tail}\n`)
            return
          }

          // ── 写入：add / rm（M2）──
          if (sub === 'add' || sub === 'rm' || sub === 'remove') {
            const rest = arg.slice(sub.length).trim()
            const scopeArg = (rest.split(/\s+/)[0] ?? '').toLowerCase()
            const isScope = scopeArg === 'user' || scopeArg === 'project'
            const scope: MemoryScope = isScope ? (scopeArg as MemoryScope) : 'user'
            const payload = isScope ? rest.slice(scopeArg.length).trim() : rest
            const store = new MemoryStore(scope === 'user' ? p.user.index : p.project.index, {
              maxLines: options.maxLines,
              maxBytes: options.maxBytes,
            })
            if (!payload) {
              input.out(`用法：/memory ${sub === 'add' ? 'add' : 'rm'} [user|project] <内容或序号>\n`)
              return
            }
            const res = sub === 'add' ? store.add(payload) : store.remove(payload)
            reader!.clear() // 写入后强制刷新（同毫秒内 mtime 可能不变，不能依赖缓存自动失效）
            // 显式写入 ⇒ 立即注入（用户有即时预期，不参与攒批）；只对本会话生效
            if (res.ok) publisherFor(input.sessionId).flush()
            const label = scope === 'user' ? '用户长期记忆' : '项目长期记忆'
            input.out(
              res.ok
                ? `✅ ${label}${sub === 'add' ? `已追加第 ${res.index} 条` : '已删除 1 条'}（现 ${res.lines} 行 / ${res.bytes} 字节）\n`
                : `⚠️  未写入：${res.message}\n`,
            )
            return
          }

          /**
           * 迁移：把 `MEMORY.md` 里的 `[feedback]` 条目搬到 `FEEDBACK.md`。
           *
           * 为什么做成**显式命令**而不是加载时自动做：这是改用户的记忆文件。
           * 但也不能不提供 —— 历史会话留下的 feedback 条目会一直待在 system 前缀区，
           * 拆分的好处对旧数据等于零（真机 `~/.harness/memory/MEMORY.md` 5/5 条全是 feedback）。
           */
          if (sub === 'migrate') {
            const which = (arg.split(/\s+/)[1] ?? 'user').toLowerCase()
            const targets: MemoryScope[] = which === 'project' ? ['project'] : ['user']
            const lines: string[] = []
            let movedTotal = 0
            for (const scope of targets) {
              const idxPath = scope === 'user' ? p.user.index : p.project.index
              const fbPath = scope === 'user' ? p.user.feedback : p.project.feedback
              const idx = new MemoryStore(idxPath, { maxLines: options.maxLines, maxBytes: options.maxBytes })
              const cur = idx.entries() // 仅用于计数展示
              const raw = idx.rawText()
              const { kept, moved } = splitFeedbackEntries(raw)
              if (moved.length === 0) {
                lines.push(`  ${scope}：没有 [feedback] 条目（${cur.length} 条普通记忆未动）`)
                continue
              }
              const fb = new MemoryStore(fbPath, { maxLines: options.maxLines, maxBytes: options.maxBytes })
              let written = 0
              for (const line of moved) {
                if (fb.add(line.slice(ENTRY_PREFIX.length)).ok) written += 1
              }
              const res = idx.rewrite(kept)
              if (!res.ok) {
                lines.push(`  ${scope}：⚠️  索引重写失败（${res.message}）—— 已写入反馈 ${written} 条，索引未改动`)
                continue
              }
              movedTotal += written
              lines.push(
                `  ${scope}：搬走 ${written}/${moved.length} 条 feedback（重复的不重复写）` +
                  `→ ${fbPath}；索引现 ${res.lines} 行 / ${res.bytes} 字节`,
              )
            }
            if (movedTotal > 0) {
              reader!.clear()
              // 索引内容变了 ⇒ 是"用户显式整理"，立即发布会话的 system（不参与攒批）
              publisherFor(input.sessionId).flush()
            }
            input.out(
              `\n[feedback] 迁移（feedback 走尾部动态区，不再占前缀缓存）\n${lines.join('\n')}\n` +
                `  用法：/memory migrate [user|project]\n\n`,
            )
            return
          }

          if (sub === 'reload') {
            reader!.clear()
            publisherFor(input.sessionId).flush()
            input.out('已清空记忆缓存并安排立即发布，下一轮注入将读取最新内容。\n')
            return
          }

          // 默认 list
          const layers = load()
          const total = layers.reduce((n, l) => n + (l.read.exists ? 1 : 0), 0)
          const pubState = publisherFor(input.sessionId).state()
          const budgets: string[] = []
          for (const [scope, idx] of [['user', p.user.index], ['project', p.project.index]] as const) {
            const st = new MemoryStore(idx, { maxLines: options.maxLines, maxBytes: options.maxBytes })
            const b = st.budget()
            const entries = st.entries()
            const stray = entries.filter((e) => e.text.startsWith(FEEDBACK_ENTRY_TAG)).length
            budgets.push(
              `\n  ${scope === 'user' ? '用户长期记忆' : '项目长期记忆'}：${entries.length} 条 / ${b.lines} 行 · ${b.bytes} 字节` +
                (entries.length ? `（上限 ${b.maxLines} 行 / ${b.maxBytes} 字节）` : '') +
                // 旧数据提示：feedback 留在索引里 = 继续占前缀缓存，迁移命令是唯一的出口
                (stray > 0 ? `\n      ⚠️  其中 ${stray} 条是 [feedback]（应搬到 FEEDBACK.md）：/memory migrate` : ''),
            )
            for (const e of entries.slice(0, 20)) budgets.push(`      ${String(e.index).padStart(3)}. ${e.text}`)
            if (entries.length > 20) budgets.push(`      …（其余 ${entries.length - 20} 条见 /memory show）`)
          }
          const fbStat = (label: string, file: string): string => {
            const st = new MemoryStore(file, { maxLines: options.maxLines, maxBytes: options.maxBytes })
            const n = st.entries().length
            const b = st.budget()
            return `  ${label}  ${n} 条 / ${b.bytes} 字节 — ${file}`
          }
          input.out(
            `\n长期记忆（${total}/${layers.length} 个文件存在；注入上限 ${options.maxLines ?? MEMORY_INDEX_MAX_LINES} 行 / ${options.maxBytes ?? MEMORY_INDEX_MAX_BYTES} 字节）\n` +
              `  项目指令  ${instructionLine(layers[0]!.read)}\n` +
              budgets.join('\n') +
              `\n  —— 失败反馈（机器回写，走**尾部动态区**：不占前缀缓存，故只注入最近 ` +
              `${FEEDBACK_INJECT_MAX_ENTRIES} 条 / ${FEEDBACK_INJECT_MAX_BYTES} 字节）——\n` +
              fbStat('用户失败反馈', p.user.feedback) +
              '\n' +
              fbStat('项目失败反馈', p.project.feedback) +
              `\n  用法：/memory add [user|project] <内容> · /memory rm [user|project] <序号|内容> · ` +
              `/memory show <user|project|instruction|feedback> · /memory path · /memory reload · /memory migrate\n` +
              `  说明：默认写入 user 级（项目级会随 git 共享，需显式指定）；主题文件请用 read 工具按需读取\n` +
              `  注入时机（§3.7 分级）：命令写入立即生效；外部改动攒到下次压缩（或 ${pubState.flushAfterTurns} 轮）才发布` +
              (pubState.dirty
                ? `；当前有未发布变更（已积 ${pubState.dirtyTurns} 轮）\n` +
                  `  （轮 = 一次「用户输入 → Agent 跑完」；一轮内多步只算一轮）\n\n`
                : '；当前无未发布变更\n\n'),
          )
        },
      }
      return hooks
    },

    async uninstall(): Promise<void> {
      paths = undefined
      reader = undefined
      void injectedSkips
      // 发布器/提示是 install() 的闭包局部量：重装即整体换新，无需在这里逐个清（旧闭包随引用一起回收）
    },
  }
}

/** 默认实例（供 `plugins: ["memory"]` 声明式启用） */
export const memoryPlugin: AgentPlugin = createMemoryPlugin()
