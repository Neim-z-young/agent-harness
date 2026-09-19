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

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

function describeLayer(label: string, r: CappedRead): string {
  if (!r.exists) return `${label}：不存在（${r.path}）`
  const lines = r.text.split('\n').length
  return (
    `${label}：${lines} 行 / ${Buffer.byteLength(r.text, 'utf-8')} 字节` +
    (r.truncated ? `（已截断，原 ${r.totalLines} 行）` : '') +
    `\n    ${r.path}`
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
            description: '查看长期记忆与项目指令（list / show <user|project|instruction> / path）',
            usage: '/memory [list|show <user|project|instruction>|path]',
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

          // 默认 list
          const layers = load()
          const total = layers.reduce((n, l) => n + (l.read.exists ? 1 : 0), 0)
          input.out(
            `\n长期记忆（${total}/${layers.length} 个文件存在；上限 ${options.maxLines ?? MEMORY_INDEX_MAX_LINES} 行 / ${options.maxBytes ?? MEMORY_INDEX_MAX_BYTES} 字节）\n` +
              layers.map((l) => `  ${describeLayer(l.label, l.read)}`).join('\n') +
              `\n  写法：/memory show <user|project|instruction> 查看内容 · /memory path 看路径\n` +
              `  说明：写入能力在 M2 落地；当前仅加载索引，主题文件请用 read 工具按需读取\n\n`,
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
