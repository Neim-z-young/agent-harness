/**
 * @harness/code-intel - 代码情报插件（MCP 解耦版）
 *
 * 插件入口：装配「进程内 MCP server + 直装工具」双路径。
 *
 * - 核心逻辑已下沉到 `./core`（索引 / 符号 / 引用 / 定义 / 结构感知编辑引擎），
 *   零 `@harness/tool` / `@harness/plugin` 依赖，可独立部署。
 * - `./server`：进程内 MCP JSON-RPC server（initialize / tools/list / tools/call），
 *   包装为 `@harness/mcp-client` 的 `McpTransport`，经 `registerMcpServer()` 注册，
 *   由 `@harness/mcp-server-registry` 在 harness.start 时进程内连接并暴露为
 *   `mcp__code-intel__*` 工具——与 harness 主程序解耦。
 * - `./tools`：同时保留直接装配为 `@harness/tool` 的能力（同 id 工具），
 *   保证 REPL `/tools` 展示与既有测试兼容。
 *
 * 工具：code_symbols / code_reference / code_definition / code_semantic_edit
 * （rename | scope 目录限定 | resolveImporters 跨目录反向 import |
 *   replace_node | replace_subtree 批量）
 *
 * 技术选型（对齐 docs/codeintel-plugin.md）：TS/JS 走 @babel/parser + @babel/traverse，
 * Go/Python/Rust/Java 走 web-tree-sitter（wasm 由构建脚本复制到产物目录）。
 *
 * @example
 * import { createHarness } from '@harness/core'
 * import { codeIntelPlugin } from '@harness/code-intel'
 *
 * const h = await createHarness({
 *   internalPlugins: [codeIntelPlugin],
 *   agents: [{ id: 'default', name: 'Agent', mode: 'primary', tools: ['*'], permission: { '*': 'allow' }, promptFragments: [] }],
 * })
 */

import { registerMcpServer, unregisterMcpServer } from '@harness/mcp-server-registry'
import type { AgentPlugin, Hooks } from '@harness/plugin'
import type { Tool } from '@harness/tool'

import { CodeIntelIndex, type CodeIntelOptions } from './core'
import { CodeIntelMcpServer, createCodeIntelServerTransport } from './server'
import { codeSymbolsTool, codeReferenceTool, codeDefinitionTool, codeSemanticEditTool } from './tools'

export * from './core'
export * from './tools'
export { CodeIntelMcpServer, createCodeIntelServerTransport, type McpToolDefParam, type ToolEntry } from './server'

export const CODE_INTEL_SERVER_NAME = 'code-intel'

/**
 * 代码情报插件（装配方式对齐 computer-use：可插拔 / 独立装卸）
 *
 * - install 钩子内注册进程内 MCP server：registry 在 harness.start 时进程内连接，
 *   暴露 `mcp__code-intel__*` 工具（与 harness 解耦，可独立部署 / 跨进程调用）。
 * - 同时把同 id 工具经 tool.pool.assemble 注入（兼容 REPL /tools 与既有测试）。
 * - uninstall 时注销 MCP server 注册，支持装卸。
 *
 * @param options.ignoreDirs 忽略目录名
 * @param options.maxFiles 单次目录索引最大文件数
 * @param options.maxDepth 目录递归最大深度
 */
export function createCodeIntelPlugin(options: CodeIntelOptions = {}): AgentPlugin {
  const index = new CodeIntelIndex(options)
  const tools: Tool[] = [
    codeSymbolsTool(index),
    codeReferenceTool(index),
    codeDefinitionTool(index),
    codeSemanticEditTool(index),
  ]

  return {
    id: 'code-intel',
    version: '0.11.0',
    name: '代码情报',
    description: '代码情报插件（MCP 解耦版）：code_symbols / code_reference / code_definition / code_semantic_edit（rename|scope/反向import|replace_node|replace_subtree 批量），进程内 MCP server 可插拔装配',
    dependsOn: ['mcp.server-registry'],
    async install(ctx) {
      // 注册进程内 MCP server（同名覆盖、幂等）：registry 在 harness.start 进程内连接并暴露 mcp__code-intel__* 工具
      const server = new CodeIntelMcpServer({ index })
      registerMcpServer({
        name: server.serverName,
        createTransport: () => createCodeIntelServerTransport(server),
      })
      ctx.log.info('code-intel 已注册进程内 MCP server（由 mcp-server-registry 启动连接）', {
        mcpServer: server.serverName,
        tools: tools.map((t) => t.id),
      })
      return {
        async 'tool.pool.assemble'(_input, pool) {
          for (const tool of tools) {
            ;(pool as { add: (t: unknown) => void }).add(tool)
          }
        },
      } as Hooks
    },
    async uninstall() {
      unregisterMcpServer(CODE_INTEL_SERVER_NAME)
    },
  }
}

/** 默认导出：代码情报插件常量 */
export const codeIntelPlugin: AgentPlugin = createCodeIntelPlugin()

export default codeIntelPlugin