/**
 * @harness/agent - Agent 定义
 *
 * 配置化 + 可组合的 Agent 人设。
 *
 * 四模式分层（参考 Claude Code 三层体系 + 扩展）：
 * - primary：主 Agent，可直接对用户
 * - subagent：只能被主 Agent 调用（独立 worker）
 * - coordinator：调度器身份（不自己写代码，专派工）
 * - teammate：Swarm 协作成员（带 inbox/task list）
 *
 * 能力白名单：tools / skills / subagents
 * 权限配置：PermissionRuleset（结构兼容 @harness/permission）
 * Prompt 片段：可组合叠加，systemPrompt 优先级更高
 */

// ===== Agent 角色 =====

/**
 * Agent 角色模式
 * - primary：主 Agent，可直接对用户
 * - subagent：只能被主 Agent 调用（独立 worker）
 * - coordinator：调度器身份（不自己写代码，专派工）
 * - teammate：Swarm 协作成员（带 inbox/task list）
 */
export type AgentMode = 'primary' | 'subagent' | 'coordinator' | 'teammate'

// ===== 模型偏好 =====

/**
 * Agent 模型偏好（覆盖默认 Provider/模型）
 * 同 OpenCode agent.model 配置
 */
export interface AgentModelPreference {
  /** Provider ID（如 "anthropic"、"openai"） */
  providerId?: string
  /** 模型 ID（如 "claude-3-5-sonnet"、"gpt-4o"） */
  modelId?: string
  /** 温度（0-2） */
  temperature?: number
  /** 其他模型选项（如 top_p、max_tokens） */
  options?: Record<string, unknown>
}

// ===== Swarm 协作能力 =====

/**
 * Swarm 协作能力声明
 * 由 Swarm 插件读取，决定 Agent 的协作能力
 */
export interface SwarmCapabilities {
  /** 是否可派生 teammate（默认 false，teammate 不能嵌套） */
  canSpawnTeammate?: boolean
  /** 是否可认领共享任务 */
  canClaimTask?: boolean
  /** 是否可使用邮箱（接收其他 Agent 消息） */
  canUseMailbox?: boolean
}

// ===== Agent 权限配置（结构兼容 @harness/permission 的 PermissionRuleset）=====

/** 权限行为 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask'

/** 路径级规则 */
export interface AgentPathRules {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}

/**
 * Agent 权限配置
 * 结构兼容 @harness/permission 的 PermissionRuleset
 */
export interface AgentPermissionConfig {
  [toolKey: string]: PermissionBehavior | AgentPathRules | undefined
  '*'?: PermissionBehavior
}

// ===== AgentDefinition 接口 =====

/**
 * Agent 定义
 *
 * 完整描述一个 Agent 的能力、权限、Prompt、协作能力。
 * 可通过配置文件加载或代码注册。
 */
export interface AgentDefinition {
  /** Agent ID（唯一） */
  id: string
  /** 显示名 */
  name: string
  /** 描述（给 coordinator 用于任务派发决策） */
  description: string
  /** 图标（UI 呈现） */
  icon?: string
  /** 标签（用于分类/搜索） */
  tags?: string[]

  // === 分层角色声明 ===
  /**
   * 角色模式
   * - primary：主 Agent，可直接对用户
   * - subagent：只能被主 Agent 调用（独立 worker）
   * - coordinator：调度器身份（不自己写代码，专派工）
   * - teammate：Swarm 协作成员（带 inbox/task list）
   */
  mode: AgentMode

  // === 后台执行声明 ===
  /**
   * 是否默认后台执行（不依赖模型每次传 runInBackground）。
   * 参考 Claude Code `selectedAgent.background === true`（Fork/Coordinator 强制异步）。
   * 仅对 mode=subagent 的 Agent 生效；为 true 时该 Agent 被派出默认走 runInBackground 路径。
   */
  background?: boolean

  // === 写操作声明（Coordinator 文件集串行化读取） ===
  /**
   * 该 Agent 预计写入的文件/目录（项目相对路径）。
   * Coordinator 派工时的写操作串行化据此仲裁：subagent 调用未显式传 targetFiles 时，
   * 自动用此声明填充（声明了 targetFiles 的调用优先）。
   */
  writesTo?: string[]

  // === 能力白名单 ===
  /** 工具 ID 列表，['*'] 表示全部工具 */
  tools: string[] | ['*']
  /** 技能 ID 白名单 */
  skills?: string[]
  /** 允许派出的 subagent ID 列表（mode=primary/coordinator 时有效） */
  subagents?: string[]

  // === MCP Server 白名单（可选） ===
  /**
   * MCP Server 白名单：按 server 名（`mcp__<server>__<tool>` 中的 <server>）声明该 Agent 可用哪些 MCP server 的全部工具。
   * - 缺省(undefined)：不限制，MCP server 全部可见（保持向后兼容）
   * - 定义了（含空数组）：仅保留白名单内 server 的工具；白名单优先于 excludeMcpServers
   * - 空数组 [] 含义为「拒绝全部 MCP 工具」，与 undefined（全可见）刻意区分
   */
  mcpServers?: string[]
  /**
   * MCP Server 黑名单：当 mcpServers 未定义（undefined）时生效，剔除这些 server 的全部工具。
   * 白名单优先于黑名单。
   */
  excludeMcpServers?: string[]

  // === 权限配置 ===
  /** 权限规则集（结构兼容 @harness/permission） */
  permission: AgentPermissionConfig

  // === 模型偏好 ===
  /** 模型偏好（覆盖默认 Provider/模型） */
  model?: AgentModelPreference

  // === Prompt 片段（可组合叠加） ===
  /** System Prompt 片段数组（按顺序拼接） */
  promptFragments?: string[]
  /** 完整覆盖 Prompt（优先级高于 promptFragments） */
  systemPrompt?: string

  // === 协作能力（Swarm 插件读取）===
  /** Swarm 协作能力声明 */
  swarm?: SwarmCapabilities
}

// ===== 从 Markdown 配置文件加载 Agent =====

/**
 * Frontmatter 解析结果
 */
export interface ParsedMarkdown {
  /** YAML frontmatter 解析结果 */
  frontmatter: Record<string, unknown>
  /** Markdown body（frontmatter 之后的正文） */
  body: string
}

/**
 * 解析 Markdown 文件的 YAML frontmatter 和 body。
 *
 * 参考 Claude Code `frontmatterParser.ts` 和 OpenCode 的 agent 配置加载。
 * 支持简化的 YAML 语法：
 * - `key: value`（标量：字符串/数字/布尔值）
 * - `key:\n  - item`（列表）
 * - `key:\n  nested: value`（嵌套对象）
 * - `key: [a, b]`（内联列表）
 * - `key: "quoted"`（引号字符串，去除引号）
 *
 * @param content Markdown 文件内容
 * @returns { frontmatter, body }
 */
export function parseFrontmatter(content: string): ParsedMarkdown {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!fmMatch) {
    return { frontmatter: {}, body: content }
  }
  const yamlBlock = fmMatch[1]
  const body = fmMatch[2]
  const frontmatter = parseSimpleYaml(yamlBlock)
  return { frontmatter, body }
}

/**
 * 简化 YAML 解析器（自包含，无外部依赖）。
 * 支持标量、列表、嵌套对象、内联列表。
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const lines = yaml.split('\n').map((l) => l.replace(/\r$/, ''))
  const result: Record<string, unknown> = {}
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    // 跳过空行和注释
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }

    const m = line.match(/^(\s*)(['"]?[\w*-]+['"]?):\s*(.*)$/)
    if (!m) {
      i++
      continue
    }

    const indent = m[1].length
    const key = m[2].replace(/^['"]|['"]$/g, '')
    const value = m[3].trim()

    if (indent > 0) {
      // 顶层解析器忽略缩进行（由嵌套处理逻辑消费）
      i++
      continue
    }

    if (value === '') {
      // 可能是列表或嵌套对象
      const { parsed, nextIdx } = parseBlock(lines, i + 1, 2)
      result[key] = parsed
      i = nextIdx
      continue // parseBlock 已返回下一个未消费行索引，跳过 i++
    } else if (value.startsWith('[') && value.endsWith(']')) {
      // 内联列表：[a, b, c]
      result[key] = value.slice(1, -1).split(',').map((s) => parseScalar(s.trim()))
    } else if (value.startsWith('{') && value.endsWith('}')) {
      // 内联对象：{key: value}（简化，不常用）
      result[key] = parseInlineObject(value)
    } else {
      // 标量
      result[key] = parseScalar(value)
    }
    i++
  }

  return result
}

/** 解析缩进块（列表或嵌套对象） */
function parseBlock(
  lines: string[],
  startIdx: number,
  expectedIndent: number,
): { parsed: unknown; nextIdx: number } {
  // 检查第一个非空行是列表项还是 key-value
  let idx = startIdx
  while (idx < lines.length && !lines[idx].trim()) idx++
  if (idx >= lines.length) return { parsed: [], nextIdx: idx }

  const firstLine = lines[idx]
  const firstIndent = firstLine.length - firstLine.trimStart().length

  if (firstLine.trim().startsWith('- ')) {
    // 列表
    const items: unknown[] = []
    while (idx < lines.length) {
      const line = lines[idx]
      if (!line.trim()) {
        idx++
        continue
      }
      const indent = line.length - line.trimStart().length
      if (indent < firstIndent) break
      const itemMatch = line.match(/^\s*-\s+(.*)$/)
      if (!itemMatch) break
      const itemValue = itemMatch[1].trim()
      if (itemValue === '') {
        // 列表项是嵌套对象
        const { parsed, nextIdx } = parseBlock(lines, idx + 1, firstIndent + 2)
        items.push(parsed)
        idx = nextIdx
      } else {
        items.push(parseScalar(itemValue))
      }
      idx++
    }
    return { parsed: items, nextIdx: idx }
  }

  // 嵌套对象
  const obj: Record<string, unknown> = {}
  while (idx < lines.length) {
    const line = lines[idx]
    if (!line.trim()) {
      idx++
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent < firstIndent) break
    const kvMatch = line.match(/^\s*(['"]?[\w*-]+['"]?):\s*(.*)$/)
    if (!kvMatch) break
    const k = kvMatch[1].replace(/^['"]|['"]$/g, '')
    const v = kvMatch[2].trim()
    if (v === '') {
      const { parsed, nextIdx } = parseBlock(lines, idx + 1, firstIndent + 2)
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

/** 解析标量值：去除引号，转换布尔值/数字 */
function parseScalar(s: string): unknown {
  if (!s) return ''
  // 去除引号
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  // 布尔值
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return undefined
  // 数字
  if (/^-?\d+$/.test(s)) return parseInt(s, 10)
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s)
  return s
}

/** 解析内联对象 {key: value, key2: value2} */
function parseInlineObject(s: string): Record<string, unknown> {
  const inner = s.slice(1, -1).trim()
  if (!inner) return {}
  const obj: Record<string, unknown> = {}
  for (const pair of inner.split(',')) {
    const colonIdx = pair.indexOf(':')
    if (colonIdx === -1) continue
    const k = pair.slice(0, colonIdx).trim()
    const v = pair.slice(colonIdx + 1).trim()
    obj[k] = parseScalar(v)
  }
  return obj
}

/**
 * 解析「可选字符串数组」字段（mcpServers / excludeMcpServers 用）。
 * 支持三种写法：内联数组 `[a, b]`、块级列表 `["- a", ...]`、裸逗号字符串 `a, b`。
 * - 未提供（字段缺失/空字符串）→ undefined
 * - 显式空数组 `[]` → []（用于表示「空白名单=拒绝全部 MCP」，与 undefined 区分）
 * - 有值 → trim 后的非空字符串数组
 */
function parseStringArr(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return undefined
}

/**
 * 从 Markdown 配置文件内容构建 AgentDefinition。
 *
 * frontmatter 字段映射到 AgentDefinition 的字段：
 * - id, name, description, icon, tags, mode, tools, skills, subagents
 * - background（默认后台执行）
 * - permission, model
 * - body（Markdown 正文）→ promptFragments[0]
 *
 * 必填字段缺失时抛错（id, name, mode, tools, permission）。
 *
 * @param content Markdown 文件内容
 * @param fallbackId 如果 frontmatter 无 id，用此值（如文件名）
 * @returns AgentDefinition
 */
export function agentFromMarkdown(content: string, fallbackId?: string): AgentDefinition {
  const { frontmatter, body } = parseFrontmatter(content)

  const id = String(frontmatter.id ?? fallbackId ?? '')
  const name = String(frontmatter.name ?? id)
  const mode = String(frontmatter.mode ?? 'subagent') as AgentMode
  const description = String(frontmatter.description ?? '')

  if (!id) {
    throw new Error('Agent 配置文件缺少 id（frontmatter.id 或 fallbackId）')
  }

  // tools: 支持 ['*'] 或 string[]
  const toolsRaw = frontmatter.tools
  const tools: string[] | ['*'] = Array.isArray(toolsRaw)
    ? toolsRaw.map(String)
    : typeof toolsRaw === 'string' && toolsRaw === '*'
      ? ['*']
      : []

  // permission: 简写 'allow'/'deny'/'ask' → { '*': value }
  // 或详细对象 { read: 'allow', write: 'ask', '*': 'deny' }
  const permRaw = frontmatter.permission
  let permission: AgentPermissionConfig
  if (typeof permRaw === 'string') {
    permission = { '*': permRaw as PermissionBehavior }
  } else if (permRaw && typeof permRaw === 'object') {
    permission = permRaw as AgentPermissionConfig
  } else {
    permission = { '*': 'ask' }
  }

  // model
  const modelRaw = frontmatter.model as Record<string, unknown> | undefined
  const model = modelRaw && typeof modelRaw === 'object'
    ? {
        providerId: modelRaw.providerId ? String(modelRaw.providerId) : undefined,
        modelId: modelRaw.modelId ? String(modelRaw.modelId) : undefined,
        temperature: typeof modelRaw.temperature === 'number' ? modelRaw.temperature : undefined,
      }
    : undefined

  // tags
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : undefined

  // skills
  const skills = Array.isArray(frontmatter.skills) ? frontmatter.skills.map(String) : undefined

  // subagents
  const subagents = Array.isArray(frontmatter.subagents) ? frontmatter.subagents.map(String) : undefined

  // mcpServers / excludeMcpServers（MCP server 粒度白名单/黑名单）
  const mcpServers = parseStringArr(frontmatter.mcpServers)
  const excludeMcpServers = parseStringArr(frontmatter.excludeMcpServers)

  // background（frontmatter.background: true|false）
  const background = typeof frontmatter.background === 'boolean'
    ? frontmatter.background
    : undefined

  // writesTo（frontmatter.writesTo: [路径列表]，Coordinator 写操作串行化用）
  const writesTo = Array.isArray(frontmatter.writesTo) ? frontmatter.writesTo.map(String) : undefined

  // icon
  const icon = frontmatter.icon ? String(frontmatter.icon) : undefined

  // promptFragments：body 作为第一个片段
  const bodyText = body.trim()
  const promptFragments = bodyText ? [bodyText] : undefined

  const def: AgentDefinition = {
    id,
    name,
    description,
    mode,
    tools,
    permission,
  }

  if (icon) def.icon = icon
  if (tags) def.tags = tags
  if (skills) def.skills = skills
  if (subagents) def.subagents = subagents
  if (background !== undefined) def.background = background
  if (writesTo) def.writesTo = writesTo
  if (mcpServers) def.mcpServers = mcpServers
  if (excludeMcpServers) def.excludeMcpServers = excludeMcpServers
  if (model) def.model = model
  if (promptFragments) def.promptFragments = promptFragments

  return def
}
