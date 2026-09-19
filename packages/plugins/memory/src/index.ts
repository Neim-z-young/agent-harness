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
 * 1. **注入走 `prompt.system.transform`** —— 这样合成出的 system 消息不带 `<acp>` ref 标签，
 *    ACP 无从把它圈进压缩范围（实证见计划 §3.4）。若改成塞进 messages 数组，会被打上 ref、
 *    变成可折叠对象。
 * 2. **system 占用永不回收** ⇒ 索引必须有硬上限（`maxLines` / `maxBytes`），且超限要显式
 *    标注"已截断"，不能静默丢弃（Claude Code 的坑：写入成功但下次加载被丢）。
 * 3. **子 Agent 不注入**（决策 B6，对齐 Claude Code）：按 `input.agentMode === 'subagent'` 跳过。
 *
 * 缓存友好性：注入文本只依赖文件内容 —— 文件不变则渲染出的 system 片段逐字相同，
 * 前缀缓存不受影响。故这里按 `mtime + size` 缓存读取结果，既省 IO 也避免无意义的重渲染。
 * （"把变更攒到下次压缩再注入"的分级策略属 M2，见计划 §3.7。）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
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

/**
 * 把若干层渲染成一个 system 片段；**全部不存在时返回空串**（不注入任何噪声）。
 *
 * 措辞上刻意强调"只在相关时参考、不要复述" —— 记忆是上下文而非强制配置
 * （Claude Code 文档同样的定位），否则模型会倾向于在回答里罗列记忆内容。
 */
export function renderMemorySection(layers: MemoryLayer[]): string {
  const present = layers.filter((l) => l.read.exists && l.read.text.trim().length > 0)
  if (present.length === 0) return ''

  const blocks: string[] = [
    '<memory>',
    '以下是跨会话保留的记忆与项目指令，供你参考。它们不是本轮任务的逐字要求：',
    '只在相关时遵循，不要向用户复述或引用本节本身。',
  ]
  for (const l of present) {
    blocks.push('', `## ${l.label}（${l.read.path}）`)
    if (l.read.truncated) {
      const why = l.read.truncatedBy === 'bytes' ? '字节上限' : '行数上限'
      blocks.push(
        `（注意：内容因${why}被截断，完整内容请用 read 工具读取该文件；` +
          `当前仅加载了前 ${l.read.text.split('\n').length} 行 / 原 ${l.read.totalLines} 行）`,
      )
    }
    blocks.push(l.read.text.trimEnd())
  }
  blocks.push('</memory>')
  return blocks.join('\n')
}

// ===== 路径解析 =====

export interface MemoryPaths {
  user: { index: string; instruction: string; dir: string }
  project: { index: string; instruction: string; dir: string }
}

/** 由工作区视图推出四个文件路径（纯函数） */
export function resolveMemoryPaths(ws: PluginWorkspaceView): MemoryPaths {
  return {
    user: {
      dir: ws.user.memory,
      index: join(ws.user.memory, MEMORY_INDEX_FILE),
      instruction: join(ws.dataDir, INSTRUCTION_FILE),
    },
    project: {
      dir: ws.project.memory,
      index: join(ws.project.memory, MEMORY_INDEX_FILE),
      instruction: join(ws.cwd, INSTRUCTION_FILE),
    },
  }
}

// ===== 读取器（带 mtime 缓存）=====

/**
 * 带缓存的文件读取器。
 *
 * 缓存键是路径，校验用 `mtimeMs + size`：文件没变则复用上次的 `CappedRead`。
 * 这保证**同一内容 ⇒ 同一渲染结果 ⇒ 前缀缓存不受影响**（§3.7），也省掉每轮的重复读盘。
 * 文件被外部编辑时会自动失效（下一次 hook 调用即读到新内容）——M1 直接生效；
 * "攒到下次压缩再刷新"的分级策略是 M2 的事。
 */
export class MemoryReader {
  private cache = new Map<string, { stamp: string; view: CappedRead }>()

  constructor(private readonly opts: CapOptions = {}) {}

  read(path: string): CappedRead {
    let stamp = 'missing'
    try {
      const st = statSync(path)
      stamp = `${st.mtimeMs}:${st.size}`
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
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, text, 'utf-8')
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
 * M1 只做读路径（加载 + 注入 + `/memory list|show|path`）；写入与治理见 M2。
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

      const hooks: Hooks = {
        async 'prompt.system.transform'(input, parts) {
          if (options.disableInjection) return
          // 决策 B6：主会话的记忆不注入子 Agent（对齐 Claude Code 的 subagent 隔离）
          if (input.agentMode === 'subagent') {
            injectedSkips += 1
            return
          }
          const section = renderMemorySection(load())
          if (section) parts.push(section)
        },

        'cli.commands'(input) {
          input.commands.push({
            command: 'memory',
            description: '长期记忆：查看 / 追加 / 删除条目（add · rm · show · path · reload）',
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
                `  项目索引    ${p.project.index}\n`,
            )
            return
          }

          if (sub === 'show') {
            const which = (arg.split(/\s+/)[1] ?? '').toLowerCase()
            const layers = load()
            const pick =
              which === 'user' ? layers[1] :
              which === 'project' ? layers[2] :
              which === 'instruction' ? layers[0] :
              undefined
            if (!pick) {
              input.out('用法：/memory show <user|project|instruction>\n')
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
            const label = scope === 'user' ? '用户长期记忆' : '项目长期记忆'
            input.out(
              res.ok
                ? `✅ ${label}${sub === 'add' ? `已追加第 ${res.index} 条` : '已删除 1 条'}（现 ${res.lines} 行 / ${res.bytes} 字节）\n`
                : `⚠️  未写入：${res.message}\n`,
            )
            return
          }

          if (sub === 'reload') {
            reader!.clear()
            input.out('已清空记忆缓存，下一轮注入将读取最新内容。\n')
            return
          }

          // 默认 list
          const layers = load()
          const total = layers.reduce((n, l) => n + (l.read.exists ? 1 : 0), 0)
          const budgets: string[] = []
          for (const [scope, idx] of [['user', p.user.index], ['project', p.project.index]] as const) {
            const st = new MemoryStore(idx, { maxLines: options.maxLines, maxBytes: options.maxBytes })
            const b = st.budget()
            const entries = st.entries()
            budgets.push(
              `\n  ${scope === 'user' ? '用户长期记忆' : '项目长期记忆'}：${entries.length} 条 / ${b.lines} 行 · ${b.bytes} 字节` +
                (entries.length ? `（上限 ${b.maxLines} 行 / ${b.maxBytes} 字节）` : ''),
            )
            for (const e of entries.slice(0, 20)) budgets.push(`      ${String(e.index).padStart(3)}. ${e.text}`)
            if (entries.length > 20) budgets.push(`      …（其余 ${entries.length - 20} 条见 /memory show）`)
          }
          input.out(
            `\n长期记忆（${total}/${layers.length} 个文件存在；注入上限 ${options.maxLines ?? MEMORY_INDEX_MAX_LINES} 行 / ${options.maxBytes ?? MEMORY_INDEX_MAX_BYTES} 字节）\n` +
              `  项目指令  ${instructionLine(layers[0]!.read)}\n` +
              budgets.join('\n') +
              `\n  用法：/memory add [user|project] <内容> · /memory rm [user|project] <序号|内容> · ` +
              `/memory show <user|project|instruction> · /memory path · /memory reload\n` +
              `  说明：默认写入 user 级（项目级会随 git 共享，需显式指定）；主题文件请用 read 工具按需读取\n\n`,
          )
        },
      }
      return hooks
    },

    async uninstall(): Promise<void> {
      paths = undefined
      reader = undefined
      void injectedSkips
    },
  }
}

/** 默认实例（供 `plugins: ["memory"]` 声明式启用） */
export const memoryPlugin: AgentPlugin = createMemoryPlugin()
