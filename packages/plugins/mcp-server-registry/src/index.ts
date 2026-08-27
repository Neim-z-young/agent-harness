/**
 * @harness/mcp-server-registry - MCP Server 注册表插件
 *
 * 设计初衷（插件化，避免与 core 集成）：
 * - 所有 mcpserver 相关插件（如 computer-use）依赖本插件的 Hook 生命周期去启动 server
 * - 其他插件通过 `registerMcpServer()` 注册两条路径之一：
 *   1. `config`：stdio / http / sse 的 McpServerConfig（缺省用 @harness/mcp-client 的 defaultTransportFactory 拉起）
 *   2. `createTransport`：进程内 / 自定义启动器，返回一个 @harness/mcp-client 的 McpTransport
 * - 本插件在 harness.start 时连接所有已注册 server，复用 @harness/mcp-client 的
 *   McpClient 管理连接 + convertMcpToolToHarnessTool 转成 Harness 工具，经 tool.pool.assemble 暴露
 *
 * 依赖约定：mcpserver 相关插件应 `dependsOn: ['mcp.server-registry']`，确保本插件先安装、先连接。
 */

import type { AgentPlugin, Hooks } from '@harness/plugin'
import type { Tool } from '@harness/tool'
import {
  McpClient,
  defaultTransportFactory,
  convertMcpToolToHarnessTool,
  type McpServerConfig,
  type McpTransport,
} from '@harness/mcp-client'

// ===== 注册类型 =====

/**
 * MCP Server 注册项。
 * - config：外部 server 配置（stdio/http/sse），registry 用 defaultTransportFactory 启动
 * - createTransport：进程内或自定义启动器，返回 McpTransport（供 computer-use 等自包含 server 使用）
 */
export type McpServerRegistration =
  | { name: string; config: McpServerConfig }
  | { name: string; createTransport: () => McpTransport | Promise<McpTransport> }

/** MCP Server 注册表 */
export class McpServerRegistry {
  private readonly regs = new Map<string, McpServerRegistration>()

  /** 注册一个 MCP server（同名覆盖） */
  register(reg: McpServerRegistration): void {
    this.regs.set(reg.name, reg)
  }
  /** 注销 */
  unregister(name: string): boolean {
    return this.regs.delete(name)
  }
  /** 是否已注册 */
  has(name: string): boolean {
    return this.regs.has(name)
  }
  /** 列出所有注册项 */
  list(): McpServerRegistration[] {
    return Array.from(this.regs.values())
  }
  /** 清空（测试用） */
  clear(): void {
    this.regs.clear()
  }
}

export function createMcpServerRegistry(): McpServerRegistry {
  return new McpServerRegistry()
}

// ===== 模块级默认注册表（供其他插件在 install / 模块加载期注册）=====

const defaultRegistry = createMcpServerRegistry()

export function registerMcpServer(reg: McpServerRegistration): void {
  defaultRegistry.register(reg)
}
export function unregisterMcpServer(name: string): boolean {
  return defaultRegistry.unregister(name)
}
export function listRegisteredMcpServers(): McpServerRegistration[] {
  return defaultRegistry.list()
}

// ===== 插件 =====

/** server 运行期状态 */
interface McpServerRuntime {
  name: string
  client: McpClient
  tools: Tool[]
}

export interface McpServerRegistryPluginOptions {
  /** 设置自定义注册表（缺省用模块级默认） */
  registry?: McpServerRegistry
}

/**
 * 创建 MCP Server 注册表插件。
 * 负责：harness.start 时连接所有已注册 server → tool.pool.assemble 暴露工具 → /mcp 命令管理 → unload 时断开。
 */
export function createMcpServerRegistryPlugin(options: McpServerRegistryPluginOptions = {}): AgentPlugin {
  const reg = options.registry ?? defaultRegistry
  const runtimes: McpServerRuntime[] = []
  let connected = false

  return {
    id: 'mcp.server-registry',
    version: '0.1.0',
    name: 'MCP Server Registry',
    description: 'MCP Server 注册表：启动所有注册的 MCP Server，并通过 @harness/mcp-client 连接管理',

    async install(ctx) {
      return {
        async 'harness.start'() {
          if (connected) return
          const items = reg.list()
          for (const item of items) {
            try {
              let transport: McpTransport
              let config: McpServerConfig | undefined
              if ('config' in item) {
                config = item.config
                transport = defaultTransportFactory(item.config)
              } else {
                transport = await item.createTransport()
              }
              const client = new McpClient(item.name, transport, config)
              await client.connect()

              const tools = await client.listTools()
              const harnessTools = tools.map((t) => convertMcpToolToHarnessTool(t, item.name, client))
              runtimes.push({ name: item.name, client, tools: harnessTools })
              ctx.log.info(`MCP Server "${item.name}" 已启动并连接`, {
                transport: config ? (config.transport ?? (config.command ? 'stdio' : 'http')) : 'in-process',
                tools: tools.map((t) => t.name),
              })
            } catch (err) {
              ctx.log.error(`MCP Server "${item.name}" 启动/连接失败`, {
                error: (err as Error)?.message ?? String(err),
              })
            }
          }
          connected = true
        },

        async 'tool.pool.assemble'(_input, pool) {
          for (const rt of runtimes) {
            for (const tool of rt.tools) {
              ;(pool as { add: (t: unknown) => void }).add(tool)
            }
          }
        },

        'cli.commands'(input) {
          if (runtimes.length === 0) return
          input.commands.push({
            command: 'mcp',
            description: 'MCP Server / 工具管理',
            usage: '/mcp [servers | tools]',
          })
        },

        async 'cli.command'(input) {
          if (input.command !== 'mcp') return
          const sub = (input.arg.trim().split(/\s+/)[0] ?? '').toLowerCase()
          // /mcp servers：连接状态概览
          if (sub === '' || sub === 'servers') {
            if (runtimes.length === 0) {
              input.out('（无已启动的 MCP Server）\n')
            } else {
              input.out(`已启动 ${runtimes.length} 个 MCP Server（由 mcp-client 管理连接）：\n`)
              for (const rt of runtimes) {
                input.out(`  ${rt.name}  tools=${rt.tools.length}  connected=${rt.client.isConnected}\n`)
              }
            }
          } else if (sub === 'tools') {
            const total = runtimes.reduce((s, r) => s + r.tools.length, 0)
            if (total === 0) {
              input.out('（无已注册的 MCP 工具）\n')
            } else {
              input.out(`已注册 ${total} 个 MCP 工具：\n`)
              for (const rt of runtimes) {
                for (const t of rt.tools) input.out(`  ${t.id}  -  ${t.description}\n`)
              }
            }
          } else {
            input.out(`未知子命令：${sub}\n用法：/mcp [servers | tools]\n`)
          }
          input.result = 'continue'
        },
      } as Hooks
    },

    async uninstall() {
      for (const rt of runtimes) rt.client.close()
      runtimes.length = 0
      connected = false
    },
  }
}