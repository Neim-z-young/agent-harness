/**
 * @harness/mcp-client
 *
 * MCP Client 插件：对接 Model Context Protocol
 * - stdio transport：通过子进程 stdin/stdout 通信（newline-delimited JSON-RPC 2.0）
 * - 自动发现 MCP Server 的工具并注册到 Harness ToolRegistry
 * - 工具命名：mcp__${serverName}__${toolName}（同 Claude Code 约定）
 * - 工具安全声明：Fail-Closed（isReadOnly=false, isDestructive=false）
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentPlugin, Hooks } from '@harness/plugin'
import type { Tool, ToolResult, Schema, ToolContext } from '@harness/tool'

// ===== 类型定义 =====

/** MCP Server 配置（stdio transport） */
export interface McpServerConfig {
  /** 服务器名称（用于工具命名 mcp__${name}__${tool}） */
  name: string
  /** 启动命令（如 "npx"） */
  command: string
  /** 命令参数 */
  args?: string[]
  /** 环境变量 */
  env?: Record<string, string>
}

/** MCP 工具定义（来自 tools/list 响应） */
export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** MCP 工具调用结果（来自 tools/call 响应） */
export interface McpToolCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>
  isError?: boolean
}

// ===== Transport 抽象 =====

/** 传输层接口（便于测试注入） */
export interface McpTransport {
  /** 发送原始数据 */
  send(data: string): void
  /** 注册消息处理回调 */
  onMessage(handler: (data: string) => void): void
  /** 关闭连接 */
  close(): void
}

/** stdio 传输：通过子进程 stdin/stdout */
export class StdioTransport implements McpTransport {
  private proc: ChildProcessWithoutNullStreams
  private handler?: (data: string) => void
  private buffer = ''

  constructor(config: { command: string; args?: string[]; env?: Record<string, string> }) {
    this.proc = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) this.handler?.(line.trim())
      }
    })
    this.proc.stderr.on('data', () => { /* 忽略 stderr */ })
  }

  send(data: string): void {
    this.proc.stdin.write(data + '\n')
  }

  onMessage(handler: (data: string) => void): void {
    this.handler = handler
  }

  close(): void {
    try { this.proc.kill() } catch { /* 忽略 */ }
  }
}

// ===== MCP Client =====

/** JSON-RPC 2.0 请求/响应管理 */
export class McpClient {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private connected = false

  constructor(
    public readonly name: string,
    private readonly transport: McpTransport,
  ) {
    transport.onMessage((data) => this.handleMessage(data))
  }

  /** 建立 MCP 连接：发送 initialize + notifications/initialized */
  async connect(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'harness-mcp-client', version: '0.1.0' },
    })
    this.connected = true
    // 发送 initialized 通知（不期望响应）
    this.notify('notifications/initialized', {})
    return result as void
  }

  /** 列出 MCP Server 提供的工具 */
  async listTools(): Promise<McpToolDef[]> {
    const result = await this.request('tools/list', {})
    const tools = (result as { tools?: McpToolDef[] })?.tools ?? []
    return tools
  }

  /** 调用 MCP 工具 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.request('tools/call', { name, arguments: args })
    return result as McpToolCallResult
  }

  /** 关闭连接 */
  close(): void {
    this.transport.close()
    this.connected = false
    // 拒绝所有 pending 请求
    for (const [, p] of this.pending) p.reject(new Error('MCP client closed'))
    this.pending.clear()
  }

  get isConnected(): boolean { return this.connected }

  // ----- JSON-RPC 内部 -----

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      // 超时 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP request "${method}" timed out (30s)`))
        }
      }, 30_000)
    })
  }

  private notify(method: string, params: unknown): void {
    this.transport.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  private handleMessage(data: string): void {
    let msg: any
    try { msg = JSON.parse(data) } catch { return }
    // 响应（有 id）
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error?.message ?? 'MCP error'))
      else p.resolve(msg.result)
    }
    // 通知/请求（无 id 或有 method 无 result/error）—暂不处理
  }
}

// ===== MCP Tool → Harness Tool 转换 =====

/** Passthrough schema：接受任何对象输入（MCP Server 自行校验） */
class PassthroughSchema implements Schema<Record<string, unknown>> {
  parse(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null) throw new Error('Expected object')
    return value as Record<string, unknown>
  }
  safeParse(value: unknown) {
    if (typeof value !== 'object' || value === null) {
      return { success: false as const, error: new Error('Expected object') }
    }
    return { success: true as const, data: value as Record<string, unknown> }
  }
}

/** 把 MCP 工具定义转换为 Harness Tool 对象 */
export function convertMcpToolToHarnessTool(
  mcpTool: McpToolDef,
  serverName: string,
  client: McpClient,
): Tool<Record<string, unknown>, unknown> {
  const toolId = `mcp__${serverName}__${mcpTool.name}`
  return {
    id: toolId,
    description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
    // Fail-Closed 安全声明
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    inputSchema: new PassthroughSchema(),
    async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult<unknown>> {
      try {
        const result = await client.callTool(mcpTool.name, input)
        // 提取文本内容
        const texts = (result.content ?? [])
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!)
        const output = texts.length === 1 ? texts[0] : texts.length > 1 ? texts.join('\n') : result
        return {
          ok: !result.isError,
          output: result.isError ? undefined : output,
          error: result.isError ? { message: `MCP tool "${mcpTool.name}" returned error`, code: 'MCP_ERROR' } : undefined,
        }
      } catch (err) {
        return {
          ok: false,
          error: { message: String((err as Error)?.message ?? err), code: 'MCP_CALL_FAILED' },
        }
      }
    },
  }
}

// ===== 插件工厂 =====

/**
 * 创建 MCP Client 插件
 *
 * @param servers MCP Server 配置列表
 * @param transportFactory 可选：自定义传输层工厂（测试注入用）
 */
export function createMcpClientPlugin(options: {
  servers: McpServerConfig[]
  transportFactory?: (config: McpServerConfig) => McpTransport
}): AgentPlugin {
  const { servers, transportFactory } = options
  const clients: McpClient[] = []
  const discoveredTools: Tool[] = []
  let connected = false

  return {
    id: 'mcp.client',
    version: '0.1.0',
    name: 'MCP Client',
    description: `MCP Client 插件：连接 ${servers.length} 个 MCP Server，自动发现并注册工具`,

    async install(ctx) {
      ctx.log.info('MCP Client 插件已加载', { servers: servers.map((s) => s.name) })
      return {
        async 'harness.start'() {
          if (connected) return
          for (const config of servers) {
            try {
              const transport = transportFactory
                ? transportFactory(config)
                : new StdioTransport(config)
              const client = new McpClient(config.name, transport)
              await client.connect()
              const tools = await client.listTools()
              for (const t of tools) {
                discoveredTools.push(convertMcpToolToHarnessTool(t, config.name, client))
              }
              clients.push(client)
              ctx.log.info(`MCP Server "${config.name}" 已连接`, { tools: tools.map((t) => t.name) })
            } catch (err) {
              ctx.log.error(`MCP Server "${config.name}" 连接失败`, { error: String((err as Error)?.message ?? err) })
            }
          }
          connected = true
        },

        async 'tool.pool.assemble'(_input, pool) {
          for (const tool of discoveredTools) {
            ;(pool as { add: (t: unknown) => void }).add(tool)
          }
        },

        'cli.commands'(input) {
          if (discoveredTools.length > 0) {
            input.commands.push({ command: 'mcp', description: '列出已注册的 MCP 工具' })
          }
        },

        async 'cli.command'(input) {
          if (input.command !== 'mcp') return
          if (discoveredTools.length === 0) {
            input.out('（无已注册的 MCP 工具）\n')
          } else {
            input.out(`已注册 ${discoveredTools.length} 个 MCP 工具：\n`)
            for (const t of discoveredTools) {
              input.out(`  ${t.id}  -  ${t.description}\n`)
            }
          }
          input.result = 'continue'
        },
      } as Hooks
    },

    async uninstall() {
      for (const c of clients) c.close()
      clients.length = 0
      discoveredTools.length = 0
      connected = false
    },
  }
}
