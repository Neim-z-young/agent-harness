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
import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { join, basename, extname, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 支持 Promise 或同步值的类型 */
export type Awaitable<T> = T | Promise<T>

// ===== 技能来源 =====

/**
 * 技能加载来源
 * - bundled：随包内置
 * - user：用户全局配置（~/.harness/skills）
 * - project：项目级（.harness/skills）
 * - mcp：MCP Server 提供（安全限制：禁用 shell embed）
 * - plugin：由插件（.harness/plugins）在其 install/core.harness.init 时注册
 */
export type SkillSource = 'bundled' | 'user' | 'project' | 'mcp' | 'plugin'

/** 技能来源的中文标注（供 /skills 等管理界面展示） */
export function formatSkillSource(source: SkillSource): string {
  switch (source) {
    case 'bundled': return '内置'
    case 'user': return '用户'
    case 'project': return '项目'
    case 'mcp': return 'MCP'
    case 'plugin': return '插件'
  }
}

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
  /** 禁用技能（从可用列表移除，可被 enable 恢复） */
  disable(id: string): boolean
  /** 恢复先前禁用（或仍存源的）技能 */
  enable(id: string): Promise<Skill | undefined>
  /** 是否已禁用 */
  isDisabled(id: string): boolean
  /**
   * 落盘一个技能并当轮生效（技能锻造 F0）。
   *
   * 安全边界（缺一不可）：
   * - 目标目录必须是**已 load 过的来源目录**（或显式传入的 dir），不允许写到任意路径；
   * - id 只接受 `a-z0-9-_`，且解析后的最终路径必须仍在目标目录内（防 `../` 穿越）；
   * - 目标已存在且是**符号链接**时拒绝（否则会写到目录外的真实文件）；
   * - 先写同目录临时文件再 rename（原子写，不会留下半截文件）。
   */
  save(skill: Skill, opts?: SkillSaveOptions): Promise<SkillSaveResult>
}

/** 技能落盘选项 */
export interface SkillSaveOptions {
  /** 目标目录；缺省时按 scope 从已加载的来源目录里挑 */
  dir?: string
  /** 目标作用域（dir 未给时按它挑已加载目录） */
  scope?: 'user' | 'project'
  /** 覆盖同名（默认 false） */
  overwrite?: boolean
  /** 目录形式 `<id>/SKILL.md`（默认）或单文件 `<id>.md` */
  layout?: 'dir' | 'file'
}

/** 技能落盘结果 */
export interface SkillSaveResult {
  ok: boolean
  /** 落盘路径（成功时） */
  path?: string
  /** 失败原因 / 成功说明 */
  message: string
  /** 落盘并 reload 后的技能（成功时） */
  skill?: Skill
}

/** 技能 id 的合法形态：小写字母数字 + 连字符/下划线（同时保证它是安全的文件名） */
const SKILL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** 校验技能 id 是否为安全的文件名（路径穿越与大小写混乱都靠这一道挡） */
export function isValidSkillId(id: string): boolean {
  return SKILL_ID_RE.test(id)
}

/**
 * 把 Skill 序列化为 SKILL.md 文本（frontmatter + 正文），与 `skillFromMarkdown` 互逆。
 *
 * 只写有值的字段 —— 空字段塞进 frontmatter 会让 `!== false` 这类默认值判定失真。
 */
export function skillToMarkdown(skill: Skill): string {
  const lines: string[] = ['---']
  lines.push(`name: ${skill.name}`)
  lines.push(`description: ${skill.description}`)
  if (skill.paths?.length) lines.push(`paths: [${skill.paths.map((p) => JSON.stringify(p)).join(', ')}]`)
  if (skill.agentBind?.length) lines.push(`agentBind: [${skill.agentBind.map((a) => JSON.stringify(a)).join(', ')}]`)
  if (skill.allowedTools?.length) lines.push(`allowedTools: [${skill.allowedTools.map((t) => JSON.stringify(t)).join(', ')}]`)
  if (skill.userInvocable === false) lines.push('userInvocable: false')
  // 生成/落盘的技能默认**不允许**内嵌 shell：这是防止"模型给自己写可执行技能"的硬约束
  lines.push(`allowEmbedShell: ${skill.allowEmbedShell === true ? 'true' : 'false'}`)
  if (skill.model) lines.push(`model: ${skill.model}`)
  if (skill.effort) lines.push(`effort: ${skill.effort}`)
  lines.push('---')
  lines.push('')
  lines.push(skill.content.trim())
  lines.push('')
  return lines.join('\n')
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
  /** 已禁用技能缓存（enable 时恢复） */
  private disabled = new Map<string, Skill>()
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
    // 即使目录还不存在也登记：技能锻造（save）需要按 scope 找到"该往哪写"，
    // 而首次锻造时 skills 目录往往还没建 —— 那时 reload 找不到文件是正常语义。
    this.sourceDirs.set(dir, { dir, source: tag })
    if (!existsSync(dir)) return []
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
    const existing = this.skills.get(id) ?? this.disabled.get(id)
    if (!existing) return undefined

    // 查找原始加载目录
    for (const { dir, source } of this.sourceDirs.values()) {
      // 尝试目录形式
      const dirPath = join(dir, id, 'SKILL.md')
      if (existsSync(dirPath)) {
        try {
          const content = readFileSync(dirPath, 'utf-8')
          const skill = skillFromMarkdown(content, id, source)
          // 重载保持原启用/禁用状态
          if (this.disabled.has(id)) this.disabled.set(id, skill)
          else this.skills.set(id, skill)
          return skill
        } catch { /* fallthrough */ }
      }
      // 尝试单文件形式
      const filePath = join(dir, `${id}.md`)
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8')
          const skill = skillFromMarkdown(content, id, source)
          if (this.disabled.has(id)) this.disabled.set(id, skill)
          else this.skills.set(id, skill)
          return skill
        } catch { /* fallthrough */ }
      }
    }

    // bundled / plugin / mcp 来源无法从文件重载，返回现有
    return existing
  }

  /** 禁用技能：从可用列表移除，保留到 cache 以便 enable 恢复；重复禁用返回 false */
  disable(id: string): boolean {
    const s = this.skills.get(id)
    if (!s) return false
    this.skills.delete(id)
    this.disabled.set(id, s)
    return true
  }

  /** 恢复被禁用（或仍存源文件）的技能 */
  async enable(id: string): Promise<Skill | undefined> {
    const cached = this.disabled.get(id)
    if (cached) {
      this.disabled.delete(id)
      this.skills.set(id, cached)
      return cached
    }
    // 未在禁用缓存中：尝试从来源文件重载（新增的技能）
    return this.reload(id)
  }

  isDisabled(id: string): boolean {
    return this.disabled.has(id)
  }

  /** 已登记的来源目录（供 save 选目标与宿主展示） */
  sourceDirectories(): Array<{ dir: string; source: SkillSource }> {
    return Array.from(this.sourceDirs.values())
  }

  async save(skill: Skill, opts: SkillSaveOptions = {}): Promise<SkillSaveResult> {
    // ① 目标目录：只允许已 load 过的来源目录（或显式传入且已登记的 dir）
    const dir = this.resolveTargetDir(opts)
    if (!dir) {
      return {
        ok: false,
        message:
          opts.dir
            ? `目录 ${opts.dir} 未登记为技能来源（只能写入已加载的技能目录）`
            : `没有可写入的 ${opts.scope ?? 'user/project'} 级技能目录（需先由宿主 load 过）`,
      }
    }
    const { dir: base, source } = dir

    // ② id 校验：既是唯一性也是文件名安全
    if (!isValidSkillId(skill.id)) {
      return { ok: false, message: `技能 id 非法（只允许 a-z0-9-_，1~64 字符）：${skill.id}` }
    }

    // ③ 路径解析 + 穿越校验
    const root = resolve(base)
    const rel = opts.layout === 'file' ? `${skill.id}.md` : join(skill.id, 'SKILL.md')
    const target = resolve(root, rel)
    if (target !== root && !target.startsWith(root + sep)) {
      return { ok: false, message: `目标路径越出技能目录：${target}` }
    }

    // ④ 已存在：符号链接拒绝（防止写到目录外），非覆盖也拒绝
    if (existsSync(target)) {
      const st = lstatSync(target)
      if (st.isSymbolicLink()) {
        return { ok: false, message: `目标是符号链接，拒绝写入（防穿越）：${target}` }
      }
      // 已存在文件若真实位置已在目录外（父目录被换过），同样拒绝。
      // ⚠️ 基准必须也取 realpath：macOS 上 /var 是 /private/var 的符号链接，
      //    拿未解析的 root 去比对会把「目录本身在链接下」误判成越界。
      try {
        const rootReal = realpathSync(root)
        const real = realpathSync(target)
        if (real !== rootReal && !real.startsWith(rootReal + sep)) {
          return { ok: false, message: `目标真实路径越出技能目录：${real}` }
        }
      } catch {
        /* 读不到 realpath 就按上面已通过的 startWith 判定放行 */
      }
      if (!opts.overwrite) {
        return { ok: false, message: `技能已存在（加 --overwrite 覆盖）：${target}` }
      }
    }

    // ⑤ 原子写：同目录临时文件 → rename（不会留下半截文件，也不会被读到写了一半的内容）
    const content = skillToMarkdown(skill)
    try {
      const parent = resolve(target, '..')
      mkdirSync(parent, { recursive: true })
      // 中间目录逃逸校验（评审修复）：root/<id> 本身可能是符号链接（攻击者在已登记目录里
      // 预置、指向外部目录），此时 target 尚不存在 ⇒ ④ 的检查全部被绕过，tmp 与最终文件
      // 都会经符号链接写到根目录**外**。父目录 realpath 必须仍在根内（根自身也取 realpath，
      // 兼容 macOS /var → /private/var 这类合法链接）。
      const rootReal = realpathSync(root)
      const parentReal = realpathSync(parent)
      if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
        return { ok: false, message: `目标父目录真实路径越出技能目录（疑似符号链接）：${parentReal}` }
      }
      const tmp = join(parent, `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
      writeFileSync(tmp, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
      try {
        renameSync(tmp, target)
      } catch (err) {
        rmSync(tmp, { force: true })
        throw err
      }
    } catch (err) {
      return { ok: false, message: `写入失败：${(err as Error)?.message ?? err}` }
    }

    // ⑥ 写后立即生效：register 兜底（目录首次出现时 reload 找不到源）+ reload 走正规加载
    const loaded = await this.reload(skill.id)
    if (!loaded) this.register({ ...skill, loadedFrom: source })
    return {
      ok: true,
      path: target,
      message: `已写入 ${target}（来源=${source}）并当轮生效`,
      skill: this.skills.get(skill.id) ?? this.disabled.get(skill.id),
    }
  }

  /** 按 opts 挑一个可写目录：显式 dir 必须已登记；否则按 scope 在来源目录里找 */
  private resolveTargetDir(opts: SkillSaveOptions): { dir: string; source: SkillSource } | undefined {
    if (opts.dir) {
      const hit = this.sourceDirs.get(opts.dir) ?? this.sourceDirs.get(resolve(opts.dir))
      if (!hit) return undefined
      return hit
    }
    const want = opts.scope ?? 'user'
    // 优先精确匹配 scope；用户级目录不存在时退回 project（宿主可能只加载了一级）
    const exact = Array.from(this.sourceDirs.values()).find((d) => d.source === want)
    if (exact) return exact
    const fallback = Array.from(this.sourceDirs.values()).find((d) => d.source === 'user' || d.source === 'project')
    return fallback
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
