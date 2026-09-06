/**
 * 项目级插件入口（.harness/plugins，project 来源）：
 * 通过外部插件目录可插拔加载，CLI 不做硬编码依赖（避免依赖倒置）。
 *
 * 这里启用「进程内 MCP server」能力：mcp-server-registry 负责在 harness.start 时连接所有
 * 已注册的 MCP server（复用 @harness/mcp-client 管理连接），computer-use 插件
 * 依赖 registry 注册一个进程内 MCP server 并对接 macOS 自动化；code-intel 插件
 * 依赖 registry 暴露代码情报工具（mcp__code-intel__*：code_symbols/code_reference/
 * code_definition/code_semantic_edit）。
 *
 * 可插拔：删除本文件（或改名为非 .ts/.js/.mjs）即停用所有进程内 MCP server 能力，
 * 无需改动 CLI/core。
 */
import { createMcpServerRegistryPlugin } from '@harness/mcp-server-registry'
import { createComputerUsePlugin } from '@harness/computer-use'
import { createCodeIntelPlugin } from '@harness/code-intel'

export const plugins = [
  createMcpServerRegistryPlugin(),
  createComputerUsePlugin(),
  createCodeIntelPlugin(),
]