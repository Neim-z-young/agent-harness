/**
 * @harness/skill - 技能系统
 *
 * 双轨制设计：
 * - Skill = 知识（Markdown 正文）
 * - Tool = 功能（代码执行）
 *
 * 三来源合并：bundled / user / project / mcp
 * 条件触发：paths glob 匹配（修改文件时自动注入上下文）
 * 内嵌 Shell：embeds 支持执行 shell 命令（MCP 来源强制切断）
 */

import { matchGlob } from '@harness/permission'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

/** 支持 Promise 或同步值的类型 */
export type Awaitable<T> = T | Promise<T>

// ===== 技能来源 =====

/**
 * 技能加载来源
 * - bundled：随包内置
 * - user：用户全局配置（~/.harness/skills）
 * - project：项目级（.harness/skills）
 * - mcp：MCP Server 提供（安全限制：禁用 shell embed）
 */
export type SkillSource = 'bundled' | 'user' | 'project' | 'mcp'

/** 任务预估（给 coordinator 参考，用于任务派发优先级） */
export type SkillEffort = 'low' | 'medium' | 'high'

// ===== 内嵌资源 =====

/**
 * 内嵌资源（shell 命令或变量替换）
 * 在 Markdown 中以 !`cmd` 或 {{var}} 形式出现
 */
export interface SkillEmbed {
  /** 类型：shell 命令 / 变量替换 */
  type: 'shell' | 'variable'
  /** 源码："git status" / "${SKILL_DIR}" */
  source: string
}

// ===== Skill 接口 =====

/**
 * 技能接口
 *
 * 安全策略：
 * - MCP 来源（loadedFrom === 'mcp'）强制 allowEmbedShell = false
 *   （防 RCE，同 Claude Code 安全切断）
 */
export interface Skill {
  /** 技能 ID（唯一） */
  id: string
  /** 显示名 */
  name: string
  /** AI 何时使用的触发说明 */
  description: string

  // === 来源 ===
  /** 加载来源（影响安全策略） */
  loadedFrom: SkillSource

  // === 条件触发 ===
  /** glob 匹配：修改这些文件时自动注入上下文 */
  paths?: string[]
  /** /skill-name 命令是否对用户可见 */
  userInvocable?: boolean
  /** 仅这些 Agent 可用（不填则所有 Agent 可用） */
  agentBind?: string[]

  // === 内容（双轨制：Markdown + 可选 Script 执行）===
  /** Markdown 正文 */
  content: string
  /** 内嵌 !`cmd` 或 {{var}} 资源列表 */
  embeds?: SkillEmbed[]
  /**
   * 是否允许内嵌 Shell 执行
   * - MCP 来源强制 false（安全切断，防 RCE）
   * - 其他来源默认 true
   */
  allowEmbedShell?: boolean

  // === 元数据 ===
  /** 加载后额外放开哪些工具 */
  allowedTools?: string[]
  /** 绑定特定模型（不填则跟随 Agent） */
  model?: string
  /** 任务预估（给 coordinator 参考） */
  effort?: SkillEffort
}

// ===== SkillManager 接口 =====

/**
 * 技能管理器接口
 * 负责三来源技能的加载、合并、查询、条件触发
 */
export interface SkillManager {
  /** 列出所有已加载技能 */
  all(): Skill[]
  /** 按 ID 获取技能 */
  get(id: string): Skill | undefined
  /** 加载技能（从指定来源或路径，可选来源标签区分 user/project/mcp） */
  load(source: SkillSource | string, sourceTag?: SkillSource): Promise<Skill[]>
  /** 按路径匹配触发（paths glob 匹配，返回需注入上下文的技能） */
  matchByPath(filePath: string): Skill[]
  /** 按 Agent ID 过滤可用技能 */
  filterByAgent(agentId: string): Skill[]
  /** 重载技能（热更新） */
  reload(id: string): Promise<Skill | undefined>
}

// ===== Frontmatter 解析（简化 YAML，自包含无依赖）=====

/**
 * 解析 Markdown frontmatter + body。
 * 复用 @harness/agent 的 parseFrontmatter 逻辑（简化版本）。
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!fmMatch) return { frontmatter: {}, body: content }
  return { frontmatter: parseSimpleYaml(fmMatch[1]), body: fmMatch[2] }
}

/** 简化 YAML 解析器（与 @harness/agent 包中一致的实现） */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const lines = yaml.split('\n').map((l) => l.replace(/\r$/, ''))
  const result: Record<string, unknown> = {}
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue }

    const m = line.match(/^(\s*)(['"]?[\w*-]+['"]?):\s*(.*)$/)
    if (!m) { i++; continue }

    const indent = m[1].length
    const key = m[2].replace(/^['"]|['"]$/g, '')
    const value = m[3].trim()

    if (indent > 0) { i++; continue }

    if (value === '') {
      const { parsed, nextIdx } = parseBlock(lines, i + 1)
      result[key] = parsed
      i = nextIdx
      continue
    } else if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value.slice(1, -1).split(',').map((s) => parseScalar(s.trim()))
    } else {
      result[key] = parseScalar(value)
    }
    i++
  }
  return result
}

/** 解析缩进块（列表或嵌套对象） */
function parseBlock(lines: string[], startIdx: number): { parsed: unknown; nextIdx: number } {
  let idx = startIdx
  while (idx < lines.length && !lines[idx].trim()) idx++
  if (idx >= lines.length) return { parsed: [], nextIdx: idx }

  const firstLine = lines[idx]
  const firstIndent = firstLine.length - firstLine.trimStart().length

  if (firstLine.trim().startsWith('- ')) {
    const items: unknown[] = []
    while (idx < lines.length) {
      const line = lines[idx]
      if (!line.trim()) { idx++; continue }
      const indent = line.length - line.trimStart().length
      if (indent < firstIndent) break
      const itemMatch = line.match(/^\s*-\s+(.*)$/)
      if (!itemMatch) break
      items.push(parseScalar(itemMatch[1].trim()))
      idx++
    }
    return { parsed: items, nextIdx: idx }
  }

  const obj: Record<string, unknown> = {}
  while (idx < lines.length) {
    const line = lines[idx]
    if (!line.trim()) { idx++; continue }
    const indent = line.length - line.trimStart().length
    if (indent < firstIndent) break
    const kvMatch = line.match(/^\s*(['"]?[\w*-]+['"]?):\s*(.*)$/)
    if (!kvMatch) break
    const k = kvMatch[1].replace(/^['"]|['"]$/g, '')
    const v = kvMatch[2].trim()
    if (v === '') {
      const { parsed, nextIdx } = parseBlock(lines, idx + 1)
      obj[k] = parsed
      idx = nextIdx
    } else if (v.startsWith('[') && v.endsWith(']')) {
      obj[k] = v.slice(1, -1).split(',').map((s) => parseScalar(s.trim()))
    } else {
      obj[k] = parseScalar(v)
    }
    idx++
  }
  return { parsed: obj, nextIdx: idx }
}

/** 解析标量值 */
function parseScalar(s: string): unknown {
  if (!s) return ''
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return undefined
  if (/^-?\d+$/.test(s)) return parseInt(s, 10)
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s)
  return s
}

// ===== skillFromMarkdown：从 SKILL.md 构建 Skill =====

/**
 * 从 Markdown 配置文件构建 Skill 对象。
 *
 * 参考 Claude Code `loadSkillsDir.ts` 的 skill 加载逻辑：
 * - frontmatter 解析 name/description/paths/allowedTools/model 等元数据
 * - body 作为 Skill content（Markdown 正文）
 *
 * @param content SKILL.md 文件内容
 * @param fallbackId 如果 frontmatter 无 name，用此值（如目录名）
 * @param source 加载来源（影响安全策略：mcp 来源强制禁用 shell embed）
 */
export function skillFromMarkdown(
  content: string,
  fallbackId: string,
  source: SkillSource,
): Skill {
  const { frontmatter, body } = parseFrontmatter(content)

  const name = String(frontmatter.name ?? fallbackId)
  // id 优先取 frontmatter.id，最后 fallbackId（目录名）
  // （与 Claude Code 一致：name 是显示名，id 来自目录或显式声明）
  const id = String(frontmatter.id ?? fallbackId)
  const description = String(frontmatter.description ?? '')

  // paths 条件触发路径
  const paths = Array.isArray(frontmatter.paths) ? frontmatter.paths.map(String) : undefined

  // userInvocable：默认 true（/skill-name 命令对用户可见）
  const userInvocable = frontmatter.userInvocable !== false

  // agentBind：绑定特定 Agent
  const agentBind = Array.isArray(frontmatter.agentBind) ? frontmatter.agentBind.map(String) : undefined

  // allowedTools：加载后额外放开的工具
  const allowedTools = Array.isArray(frontmatter.allowedTools) ? frontmatter.allowedTools.map(String) : undefined

  // model：绑定特定模型
  const model = frontmatter.model ? String(frontmatter.model) : undefined

  // effort：任务预估
  const effort = frontmatter.effort ? String(frontmatter.effort) as SkillEffort : undefined

  // allowEmbedShell：MCP 来源强制 false
  const allowEmbedShell = source === 'mcp' ? false : frontmatter.allowEmbedShell !== false

  // embeds：内嵌资源（从 body 中提取 !`cmd` 和 {{var}}）
  const embeds = extractEmbeds(body)

  const skill: Skill = {
    id,
    name,
    description,
    loadedFrom: source,
    content: body.trim(),
    userInvocable,
    allowEmbedShell,
  }

  if (paths) skill.paths = paths
  if (agentBind) skill.agentBind = agentBind
  if (allowedTools) skill.allowedTools = allowedTools
  if (model) skill.model = model
  if (effort) skill.effort = effort
  if (embeds.length > 0) skill.embeds = embeds

  return skill
}

/**
 * 从 Markdown body 中提取内嵌资源：
 * - !`command` → shell embed
 * - {{variable}} → variable embed
 */
function extractEmbeds(body: string): SkillEmbed[] {
  const embeds: SkillEmbed[] = []
  // !`command` 形式
  const shellRe = /!`([^`]+)`/g
  let m: RegExpExecArray | null
  while ((m = shellRe.exec(body)) !== null) {
    embeds.push({ type: 'shell', source: m[1] })
  }
  // {{variable}} 形式
  const varRe = /\{\{(\w+)\}\}/g
  while ((m = varRe.exec(body)) !== null) {
    embeds.push({ type: 'variable', source: m[1] })
  }
  return embeds
}

// ===== SkillManagerImpl：SkillManager 接口实现 =====

/**
 * SkillManager 默认实现。
 *
 * 三来源合并策略（参考 Claude Code loadSkillsDir 并行加载 + 去重）：
 * 1. bundled：随包内置（代码注册）
 * 2. user：用户全局配置（~/.harness/skills/）
 * 3. project：项目级（.harness/skills/）
 * 4. mcp：MCP Server 提供（安全限制：禁用 shell embed）
 *
 * 同 ID 优先级：project > user > bundled > mcp（后加载覆盖先加载）
 */
export class SkillManagerImpl implements SkillManager {
  private skills = new Map<string, Skill>()
  /** 来源目录映射（用于 reload） */
  private sourceDirs = new Map<string, { dir: string; source: SkillSource }>()

  constructor(initial?: Skill[]) {
    if (initial) {
      for (const s of initial) this.skills.set(s.id, s)
    }
  }

  all(): Skill[] {
    return Array.from(this.skills.values())
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id)
  }

  /**
   * 从文件系统目录加载 Skill。
   *
   * 支持两种目录结构：
   * 1. Claude Code 风格：`skills/skill-name/SKILL.md`（目录形式）
   * 2. 简化形式：`skills/skill-name.md`（单文件形式）
   *
   * 来源标签决定安全策略：
   * - `'user'`：用户全局配置（~/.harness/skills），默认允许 shell embed
   * - `'project'`：项目级（.harness/skills），默认允许 shell embed
   * - `'mcp'`：MCP Server 提供，强制 `allowEmbedShell=false`（防 RCE）。
   *   MCP 来源通常不走文件目录，建议用 register() 注册从 MCP Server 拉取的 Skill。
   *
   * 多级覆盖：后加载覆盖先加载。建议按 user → project 顺序调用。
   *
   * @param source 目录路径（绝对路径）或来源标签（'bundled'）
   * @param sourceTag 来源标签，缺省 'project'。仅在 source 为目录路径时生效
   */
  async load(source: SkillSource | string, sourceTag: SkillSource = 'project'): Promise<Skill[]> {
    if (source === 'bundled') {
      // bundled 由构造函数或 register() 注册，load 不处理
      return this.all()
    }

    // source 为目录路径
    const dir = source
    const tag = sourceTag
    if (!existsSync(dir)) return []

    this.sourceDirs.set(dir, { dir, source: tag })
    const loaded: Skill[] = []
    const entries = readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // 目录形式：skill-name/SKILL.md
        const skillFile = join(dir, entry.name, 'SKILL.md')
        if (existsSync(skillFile)) {
          try {
            const content = readFileSync(skillFile, 'utf-8')
            const skill = skillFromMarkdown(content, entry.name, tag)
            this.skills.set(skill.id, skill)
            loaded.push(skill)
          } catch { /* 跳过解析失败的文件 */ }
        }
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        // 单文件形式：skill-name.md
        const filePath = join(dir, entry.name)
        try {
          const content = readFileSync(filePath, 'utf-8')
          const fallbackId = basename(entry.name, '.md')
          const skill = skillFromMarkdown(content, fallbackId, tag)
          this.skills.set(skill.id, skill)
          loaded.push(skill)
        } catch { /* 跳过解析失败的文件 */ }
      }
    }

    return loaded
  }

  /**
   * 按路径匹配触发。
   *
   * 参考 Claude Code 的 paths 条件触发逻辑：
   * 遍历所有 Skill，检查 filePath 是否匹配 skill.paths 中的任一 glob pattern。
   * 无 paths 的 Skill 不触发（需要用户主动调用）。
   */
  matchByPath(filePath: string): Skill[] {
    const matched: Skill[] = []
    for (const skill of this.skills.values()) {
      if (!skill.paths || skill.paths.length === 0) continue
      if (skill.paths.some((p) => matchGlob(p, filePath))) {
        matched.push(skill)
      }
    }
    return matched
  }

  /**
   * 按 Agent ID 过滤可用技能。
   * - agentBind 为空 → 所有 Agent 可用
   * - agentBind 非空 → 仅绑定的 Agent 可用
   */
  filterByAgent(agentId: string): Skill[] {
    return this.all().filter((s) => !s.agentBind || s.agentBind.includes(agentId))
  }

  /** 注册单个 Skill（用于 bundled 来源） */
  register(skill: Skill): void {
    this.skills.set(skill.id, skill)
  }

  /** 重载技能（从原始来源目录重新加载） */
  async reload(id: string): Promise<Skill | undefined> {
    const existing = this.skills.get(id)
    if (!existing) return undefined

    // 查找原始加载目录
    for (const { dir, source } of this.sourceDirs.values()) {
      // 尝试目录形式
      const dirPath = join(dir, id, 'SKILL.md')
      if (existsSync(dirPath)) {
        try {
          const content = readFileSync(dirPath, 'utf-8')
          const skill = skillFromMarkdown(content, id, source)
          this.skills.set(id, skill)
          return skill
        } catch { /* fallthrough */ }
      }
      // 尝试单文件形式
      const filePath = join(dir, `${id}.md`)
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8')
          const skill = skillFromMarkdown(content, id, source)
          this.skills.set(id, skill)
          return skill
        } catch { /* fallthrough */ }
      }
    }

    // bundled 来源无法从文件重载，返回现有
    return existing
  }
}

/**
 * 创建 SkillManager 工厂函数。
 */
export function createSkillManager(initial?: Skill[]): SkillManagerImpl {
  return new SkillManagerImpl(initial)
}

/**
 * 将 Skill content 格式化为可注入 prompt 的文本。
 *
 * 参考 Claude Code `getPromptForCommand`：将 Skill Markdown 正文
 * 包装为清晰的上下文块，附加元数据头。
 */
export function formatSkillForPrompt(skill: Skill): string {
  const header = `# Skill: ${skill.name}`
  const desc = skill.description ? `\n> ${skill.description}` : ''
  const body = skill.content ? `\n\n${skill.content}` : ''
  return `${header}${desc}${body}`
}
