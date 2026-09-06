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
  | { name: string; config: McpServerConfig; dataDir?: string }
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
  /** 配置源条目（来自 config.json mcpServers 的托管 server）；缺省=代码注册的 server */
  entry?: McpServerEntry
}

/**
 * 配置文件里的 MCP Server 条目。由 config.json 的 `mcpServers` 数组提供：
 * 复用 @harness/mcp-client 的 McpServerConfig 字段，并附加两级启停开关。
 */
export type McpServerEntry = McpServerConfig & {
  /** 服务器级开关（缺省 true） */
  enabled?: boolean
  /** 工具级开关：key=工具名（不带 mcp__<server>__ 前缀），value=false 表示停用单个工具（缺省全开） */
  tools?: Record<string, boolean>
}

/** 托管（可由 /mcp 启停的）配置条目运行态 */
interface ManagedEntry {
  entry: McpServerEntry
  /** 服务器级 enabled（缺省 true） */
  enabled: boolean
  /** 工具级开关：base 工具名 → 是否启用 */
  tools: Record<string, boolean>
}

export interface McpServerRegistryPluginOptions {
  /** 设置自定义注册表（缺省用模块级默认） */
  registry?: McpServerRegistry
  /** 透传给 mcp-client defaultTransportFactory 的默认 dataDir（OAuth token 持久化；单项可覆盖） */
  dataDir?: string
}

/**
 * 插件接收的 /mcp 持久化回调（由 CLI 注入，对齐 setAgentTools）。外部接口，供 TUI/Web 复用。
 */
export interface McpCliStore {
  /** 当前 config.json 里的 mcpServers 列表 */
  mcpServers: McpServerEntry[]
  /** 把新列表写回 config.json（调用方负责持久化） */
  save: (list: McpServerEntry[]) => Promise<void> | void
}

/**
 * 创建 MCP Server 注册表插件。
 * 负责：harness.start 时连接所有已注册（代码 + config.json）server → tool.pool.assemble 暴露工具
 *       → /mcp 命令管理（服务器/工具两级启停）→ unload 时断开。
 * 配置源：config.json `mcpServers` 经 `mcp.configure` Hook 注入（boot 时由 CLI 调用），
 *        后续 CLI/TUI/Web 界面经注入的 McpCliStore.save 持久化回 config.json。
 */
export function createMcpServerRegistryPlugin(options: McpServerRegistryPluginOptions = {}): AgentPlugin {
  const reg = options.registry ?? defaultRegistry
  const dataDir = options.dataDir
  const runtimes: McpServerRuntime[] = []
  /** name → 托管配置条目；来自 config.json mcpServers */
  const managed = new Map<string, ManagedEntry>()
  /** CLI 注入的持久化回调 */
  let cliStore: McpCliStore | undefined
  let connected = false

  /** 根据一个 server 配置建立运行时（不落 entries，调用方 push） */
  function makeRuntime(serverName: string, cfg: McpServerConfig, entry?: McpServerEntry): Promise<McpServerRuntime | undefined> {
    return (async () => {
      const transport = defaultTransportFactory(cfg, { dataDir })
      const client = new McpClient(serverName, transport, cfg)
      await client.connect()
      const tools = await client.listTools()
      const harnessTools = tools.map((t) => convertMcpToolToHarnessTool(t, serverName, client))
      return { name: serverName, client, tools: harnessTools, entry }
    })()
  }

  /** 连接一个托管条目，失败返回 false */
  async function connectManaged(name: string): Promise<boolean> {
    const m = managed.get(name)
    if (!m) return false
    if (runtimes.some((r) => r.name === name)) return true
    try {
      const rt = await makeRuntime(name, m.entry, m.entry)
      runtimes.push(rt!)
      return true
    } catch {
      return false
    }
  }

  /** 断开并移除 one server（close 客户端） */
  function disconnectServer(name: string): void {
    const i = runtimes.findIndex((r) => r.name === name)
    if (i >= 0) {
      runtimes[i].client.close()
      runtimes.splice(i, 1)
    }
  }

  /** 持久化当前托管条目到 config.json；无回调时静默跳过 */
  function persist(): void {
    if (!cliStore) return
    const list: McpServerEntry[] = []
    for (const [, m] of managed) list.push({ ...m.entry, enabled: m.enabled, tools: m.tools })
    void cliStore.save(list)
  }

  return {
    id: 'mcp.server-registry',
    version: '0.2.0',
    name: 'MCP Server Registry',
    description: 'MCP Server 注册表：启动所有注册的 MCP Server，并通过 @harness/mcp-client 连接管理',

    async install(ctx) {
      return {
        /**
         * 注入 config.json 的 mcpServers（替换托管列表）。仅建立配置态，不连接；
         * 由 harness.start 按 enabled 开关连接。CLI 在 createHarness 后、start 前调用。
         */
        'mcp.configure'(input: { mcpServers?: McpServerEntry[] }, _output?: unknown) {
          managed.clear()
          for (const e of input.mcpServers ?? []) {
            managed.set(e.name, {
              entry: e,
              enabled: e.enabled ?? true,
              tools: { ...(e.tools ?? {}) },
            })
          }
        },

        async 'harness.start'() {
          if (connected) return
          // ① 代码注册的 server（持续暴露，不受托管开关控制）
          const items = reg.list()
          for (const item of items) {
            try {
              let transport: McpTransport
              let config: McpServerConfig | undefined
              if ('config' in item) {
                config = item.config
                transport = defaultTransportFactory(item.config, { dataDir: item.dataDir ?? dataDir })
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
          // ② 托管配置条目（来自 config.json）：仅连接已启用的 server
          for (const [name, m] of managed) {
            if (!m.enabled) continue
            const ok = await connectManaged(name)
            if (!ok) {
              ctx.log.error(`MCP Server "${name}" 启动/连接失败（config.json mcpServers）`, {})
            }
          }
          connected = true
        },

        async 'tool.pool.assemble'(_input, pool) {
          const add = (t: unknown) => (pool as { add: (t: unknown) => void }).add(t)
          for (const rt of runtimes) {
            // 工具级过滤：base 名 = 去掉 mcp__<server>__ 前缀；managed.tools[base]===false 时跳过
            const prefix = `mcp__${rt.name}__`
            const m = rt.entry ? managed.get(rt.name) : undefined
            for (const tool of rt.tools) {
              const base = tool.id.startsWith(prefix) ? tool.id.slice(prefix.length) : tool.id
              if (m && m.tools[base] === false) continue
              add(tool)
            }
          }
        },

        'cli.commands'(input) {
          if (runtimes.length === 0 && managed.size === 0) return
          input.commands.push({
            command: 'mcp',
            description: 'MCP Server / 工具管理（含 config.json 装配、两级启停）',
            usage: '/mcp [servers | tools | enable <s> | disable <s> | tool <s> <t> on|off | add <json> | remove <s>]',
          })
        },

        async 'cli.command'(input) {
          if (input.command !== 'mcp') return
          // CLI 注入持久化回调（对齐 setAgentTools 模式）
          if ((input as any).setMcpServers) {
            cliStore = { mcpServers: (input as any).mcpServers ?? [], save: (input as any).setMcpServers }
          }
          const arg = (input.arg ?? '').trim()
          const parts = arg.split(/\s+/)
          const sub = (parts[0] ?? '').toLowerCase()
          const out = (s: string) => input.out(s)

          const serverList = () => {
            if (runtimes.length === 0 && managed.size === 0) { out('（无已注册的 MCP Server）\n'); return }
            out(`已注册 ${managed.size + reg.list().length} 个 MCP Server（` + (cliStore ? 'config.json 托管 + 代码注册' : '全部为代码注册') + `）：\n`)
            for (const [name, m] of managed) {
              const rt = runtimes.find((r) => r.name === name)
              out(`  ${name}  ${m.enabled ? '[启用]' : '[禁用]'}  tools=${rt?.tools.length ?? 0}  connected=${rt?.client.isConnected ?? false}\n`)
            }
            for (const r of runtimes) {
              if (managed.has(r.name)) continue
              out(`  ${r.name}  [代码注册]  tools=${r.tools.length}  connected=${r.client.isConnected}\n`)
            }
          }

          if (sub === '' || sub === 'servers') {
            serverList()
          } else if (sub === 'tools') {
            const toolList: Array<{ id: string; desc?: string; server: string; disabled?: boolean }> = []
            for (const rt of runtimes) {
              const m = managed.get(rt.name)
              for (const t of rt.tools) {
                const base = t.id.startsWith(`mcp__${rt.name}__`) ? t.id.slice(`mcp__${rt.name}__`.length) : t.id
                toolList.push({ id: t.id, desc: t.description, server: rt.name, disabled: m ? m.tools[base] === false : undefined })
              }
            }
            if (toolList.length === 0) { out('（无已注册的 MCP 工具）\n'); return }
            out(`已注册 ${toolList.length} 个 MCP 工具（托管 server 支持工具级启停）：\n`)
            for (const t of toolList) {
              const flag = t.disabled === undefined ? '' : t.disabled ? '  [禁用]' : '  [启用]'
              out(`  ${t.id}${flag}  -  ${t.desc ?? ''}\n`)
            }
          } else if (sub === 'enable' || sub === 'disable') {
            const name = parts[1]
            if (!name) { out('用法：/mcp enable <server> | disable <server>\n'); return }
            const m = managed.get(name)
            if (!m) { out(`未知托管 server："${name}"（仅 config.json 装配的 server 可启停）\n`); return }
            m.enabled = sub === 'enable'
            persist()
            if (m.enabled) {
              const ok = await connectManaged(name)
              out(ok ? `已启用并连接 ${name}\n` : `启用失败（未能连接 ${name}）\n`)
            } else {
              disconnectServer(name)
              out(`已禁用 ${name}\n`)
            }
          } else if (sub === 'tool') {
            const name = parts[1]
            const tname = parts[2]
            const flag = (parts[3] ?? '').toLowerCase()
            if (!name || !tname || !['on', 'off'].includes(flag)) { out('用法：/mcp tool <server> <tool> on|off\n'); return }
            const m = managed.get(name)
            if (!m) { out(`未知托管 server："${name}"\n`); return }
            if (flag === 'off') m.tools[tname] = false
            else delete m.tools[tname]
            persist()
            out(`工具 ${name}/${tname} 已${flag === 'off' ? '禁用' : '启用'}\n`)
          } else if (sub === 'add') {
            const json = arg.slice(sub.length).trim().replace(/^--\s*/, '')
            try {
              const e = JSON.parse(json) as McpServerEntry
              if (!e?.name) { out('add 需要 JSON 含 name 字段\n'); return }
              managed.set(e.name, { entry: e, enabled: e.enabled ?? true, tools: { ...(e.tools ?? {}) } })
              persist()
              const ok = managed.get(e.name)!.enabled ? await connectManaged(e.name) : true
              out(ok ? `已添加并连接 ${e.name}\n` : `已添加但仍需连接（config 有误？）${e.name}\n`)
            } catch (err) {
              out(`JSON 解析失败：${(err as Error)?.message ?? String(err)}\n用法：/mcp add <json>（含 name; 可再 -- 前缀）\n`)
            }
          } else if (sub === 'remove') {
            const name = parts[1]
            if (!name) { out('用法：/mcp remove <server>\n'); return }
            if (!managed.has(name)) { out(`未知托管 server："${name}"\n`); return }
            managed.delete(name)
            disconnectServer(name)
            persist()
            out(`已移除 ${name}\n`)
          } else {
            out(`未知子命令：${sub}\n用法：/mcp [servers | tools | enable <s> | disable <s> | tool <s> <t> on|off | add <json> | remove <s>]\n`)
          }
          input.result = 'continue'
        },
      } as Hooks
    },

    async uninstall() {
      for (const rt of runtimes) rt.client.close()
      runtimes.length = 0
      managed.clear()
      cliStore = undefined
      connected = false
    },
  }
}