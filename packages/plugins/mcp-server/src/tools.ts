/**
 * 工具映射：harness `Tool` ⇄ MCP tool 描述 / 调用结果（零 IO、纯函数）。
 *
 * ## 与既有两处 server 的关键差别：**动态**枚举
 * `code-intel` / `computer-use` 的工具表是**硬编码**的（它们各自只暴露自己的四个/若干个工具）。
 * 本包要暴露的是 harness 的**全局工具集**（随插件装配变化），所以这里必须是
 * `ToolRegistry → 描述列表` 的**动态映射**，而不是一张写死的表。
 */
import type { Tool, ToolRegistry, ToolResult } from '@harness/tool'

/** MCP `tools/list` 的元素（与 `@harness/mcp-client` 的 `McpToolDef` 对偶，但自包含不跨包 import） */
export interface McpToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    /** 只读提示（MCP 语义：客户端据此决定是否免确认） */
    readOnlyHint?: boolean
    /** 破坏性提示 */
    destructiveHint?: boolean
  }
}

/** MCP `tools/call` 的返回（单条 text content） */
export interface McpCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError: boolean
}

export interface ToolExposureOptions {
  /**
   * 名字前缀（缺省空）。MCP 名字约束 `[a-zA-Z0-9_-]`，harness 工具 id 本就符合，
   * 故默认**不加前缀**以保持与 harness 侧一致、便于辨认；加前缀只在同一 MCP server
   * 被多来源混装时才需要。
   */
  prefix?: string
  /** 额外排除（返回 true 表示不暴露）。与内置排除规则**取或** */
  exclude?: (tool: Tool) => boolean
}

/** 暴露给 MCP 的名字（前缀 + 工具 id） */
export function exposureName(tool: Tool, prefix = ''): string {
  return `${prefix}${tool.id}`
}

/**
 * 内置排除规则（**不暴露**）：
 * 1. `requiresUserInteraction` 的工具（如 `ask_user_question`）—— MCP 侧没有"提问面"，
 *    暴露出去只会让远端调用永远失败；
 * 2. id 以 `mcp__` 开头的工具 —— 那是**别的 MCP server** 经 mcp-client 拉进来的，
 *    再转发一次会形成二级转发（甚至环路）。
 */
export function isExcludedByDefault(tool: Tool): boolean {
  return tool.requiresUserInteraction === true || tool.id.startsWith('mcp__')
}

/** 取工具声明式入参 schema（`withJsonSchema` / `fromJsonSchema` 注入的那份） */
export function jsonSchemaOf(tool: Tool): Record<string, unknown> {
  const s = tool.inputSchema as { __jsonSchema?: Record<string, unknown> } | undefined
  return s?.__jsonSchema ?? { type: 'object', properties: {} }
}

/**
 * 单个 `Tool` → MCP tool 描述。
 *
 * `inputSchema` **直出**不重新推导：harness 侧那份 JSON Schema 已是"给模型读的唯一参数来源"，
 * 重新推导等于引入第二个口径（mcp-client 曾因丢掉它而让模型看不到任何参数名 —— 见其
 * `convertMcpToolToHarnessTool` 的注释）。
 *
 * `annotations` 一律**Fail-Closed**：工具未声明 `isReadOnly` / `isDestructive` 时按最保守的
 * `false` 报（即"可能写、可能破坏"），由 MCP 客户端决定是否弹确认。
 */
export function toMcpToolDescriptor(tool: Tool, opts: ToolExposureOptions = {}): McpToolDescriptor {
  return {
    name: exposureName(tool, opts.prefix),
    description: tool.description,
    inputSchema: jsonSchemaOf(tool),
    annotations: {
      readOnlyHint: tool.isReadOnly?.() ?? false,
      destructiveHint: tool.isDestructive?.() ?? false,
    },
  }
}

/** 枚举要暴露的工具（过滤后按注册顺序） */
export function listExposedTools(registry: ToolRegistry, opts: ToolExposureOptions = {}): Tool[] {
  const exclude = opts.exclude
  return registry.list().filter((t) => !isExcludedByDefault(t) && !exclude?.(t))
}

export interface ToolIndex {
  /** MCP 名字 → harness Tool（`tools/call` 反查用） */
  byName: Map<string, Tool>
  descriptors: McpToolDescriptor[]
}

/**
 * 构造工具索引：**一次遍历同时得到**"给客户端的描述列表"与"调用时的反查表"。
 *
 * 为什么必须同源：两处若各自过滤一次，过滤规则一改就会漂移 —— 表现是"列表里有、
 * 调用说没有"（或反之），这是最难查的一类不一致。同源后不存在这种可能。
 */
export function buildToolIndex(registry: ToolRegistry, opts: ToolExposureOptions = {}): ToolIndex {
  const byName = new Map<string, Tool>()
  const descriptors: McpToolDescriptor[] = []
  for (const tool of listExposedTools(registry, opts)) {
    const d = toMcpToolDescriptor(tool, opts)
    byName.set(d.name, tool)
    descriptors.push(d)
  }
  return { byName, descriptors }
}

/** 把 `ToolResult` 转成 MCP `tools/call` 的返回形状 */
export function toMcpCallResult(result: ToolResult): McpCallResult {
  if (result.ok) {
    const output = result.output
    const text = typeof output === 'string' ? output : JSON.stringify(output ?? null, null, 2)
    return { content: [{ type: 'text', text }], isError: false }
  }
  const err = result.error
  const text = err ? `${err.code ? `[${err.code}] ` : ''}${err.message}` : '工具执行失败'
  return { content: [{ type: 'text', text }], isError: true }
}
