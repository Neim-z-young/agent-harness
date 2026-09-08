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
import type { AgentPlugin } from '@harness/plugin'

import { CodeIntelIndex, type CodeIntelOptions } from './core'
import { CodeIntelMcpServer, createCodeIntelServerTransport } from './server'

export * from './core'
export * from './tools'
export { CodeIntelMcpServer, createCodeIntelServerTransport, type McpToolDefParam, type ToolEntry } from './server'

export const CODE_INTEL_SERVER_NAME = 'code-intel'

/**
 * 代码情报插件（进程内 MCP server，装配方式对齐 computer-use：纯 MCP、可插拔）
 *
 * 通过 `.harness/plugins`（或 user `~/.harness/plugins`）外部插件目录显式装配，
 * CLI 不做硬编码依赖（code-intel 在 BuiltinPluginRegistry 登记为 metaOnly，仅预登记元信息、
 * 不自动实例化）。装配后：
 *
 * - `install` 钩子内注册进程内 MCP server（registerMcpServer，同名覆盖、幂等）；
 *   registry 在 harness.start 时进程内连接，把工具暴露为 `mcp__code-intel__*`（与 harness 解耦）。
 * - 不直装 harness 工具（纯 MCP，对齐 computer-use）；core 能力可经 `./tools` 薄适配程序化调用。
 * - `uninstall` 注销 MCP server 注册，支持装卸。
 *
 * @example
 * // .harness/plugins/mcp.ts
 * import { createMcpServerRegistryPlugin } from '@harness/mcp-server-registry'
 * import { createCodeIntelPlugin } from '@harness/code-intel'
 * export const plugins = [createMcpServerRegistryPlugin(), createCodeIntelPlugin()]
 *
 * @param options.ignoreDirs 忽略目录名
 * @param options.maxFiles 单次目录索引最大文件数
 * @param options.maxDepth 目录递归最大深度
 */
export function createCodeIntelPlugin(options: CodeIntelOptions = {}): AgentPlugin {
  return {
    id: 'code-intel',
    version: '0.11.0',
    name: '代码情报',
    description: '代码情报 MCP server 插件（mcp__code-intel__*）：code_symbols / code_reference / code_definition / code_semantic_edit（rename|scope/反向import|replace_node|replace_subtree 批量）',
    dependsOn: ['mcp.server-registry'],
    async install(ctx) {
      const index = new CodeIntelIndex(options)
      // 注册进程内 MCP server（同名覆盖、幂等）：registry 在 harness.start 进程内连接并暴露 mcp__code-intel__* 工具
      const server = new CodeIntelMcpServer({ index })
      registerMcpServer({
        name: server.serverName,
        createTransport: () => createCodeIntelServerTransport(server),
        source: 'code-intel', // 供 mcp-server-registry 在插件卸载/重载时同步断开/重连
      })
      ctx.log.info('code-intel 已注册进程内 MCP server（由 mcp-server-registry 启动连接，纯 MCP 装配）', {
        mcpServer: server.serverName,
      })
      return {}
    },
    async uninstall() {
      unregisterMcpServer(CODE_INTEL_SERVER_NAME)
    },
  }
}

/** 默认导出：代码情报插件常量（供 .harness/plugins 直接引用） */
export const codeIntelPlugin: AgentPlugin = createCodeIntelPlugin()

export default codeIntelPlugin