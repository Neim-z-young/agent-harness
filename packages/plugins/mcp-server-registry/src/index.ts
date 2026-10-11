/**
 * @harness/mcp-server-registry - MCP Server 注册表插件
 *
 * 设计初衷（插件化，避免与 core 集成）：
 * - 所有 mcpserver 相关插件（如 computer-use）依赖本插件的 Hook 生命周期去启动 server
 * - 其他插件通过 `registerMcpServer()` 注册两条路径之一：
 *   1. `config`：stdio / http / sse 的 McpServerConfig（缺省用 @harness/mcp-client 的 defaultTransportFactory 拉起）
 *   2. `createTransport`：进程内 / 自定义启动器，返回一个 @harness/mcp-client 的 McpTransport
 * - 本插件在 core.harness.start 时连接所有已注册 server，复用 @harness/mcp-client 的
 *   McpClient 管理连接 + convertMcpToolToHarnessTool 转成 Harness 工具，经 core.tool.pool.assemble 暴露
 *
 * 依赖约定：mcpserver 相关插件应 `dependsOn: ['mcp.server-registry']`，确保本插件先安装、先连接。
 */

import type { AgentPlugin, Hooks, McpConfigureInput } from '@harness/plugin'
import { globalMcpToolIndex, type Tool } from '@harness/tool'
import type { Unsubscribe } from '@harness/bus'
import { LifecycleEvents } from '@harness/core'
import {
  McpClient,
  defaultTransportFactory,
  convertMcpToolToHarnessTool,
  type McpServerConfig,
  type McpTransport,
} from '@harness/mcp-client'
import type { OsBinding } from '@harness/isolation'

// ===== 注册类型 =====

/**
 * MCP Server 注册项。
 * - config：外部 server 配置（stdio/http/sse），registry 用 defaultTransportFactory 启动
 * - createTransport：进程内或自定义启动器，返回 McpTransport（供 computer-use 等自包含 server 使用）
 * - source：来源插件 id（可选）。插件 install 时 registerMcpServer 携带，供 registry
 *   在插件卸载/重载时同步断开/重连该插件注册的 server。
 */
export type McpServerRegistration =
  | { name: string; config: McpServerConfig; dataDir?: string; source?: string }
  | { name: string; createTransport: () => McpTransport | Promise<McpTransport>; source?: string }

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
 * MCP server 的**能力声明**（P1-7）。
 *
 * 只有两个维度，且每个维度只有"受限 / 不限"两档 —— 刻意不做细粒度路径清单：
 * server 是外部代码，声明得越细、越容易变成"以为约束住了"的假象。
 *
 * ⚠️ **声明 ≠ 强制**（这是本方案最容易自欺的地方）：
 * - `fs: 'cwd'` + 本机有 OS 绑定 ⇒ **真强制**（子进程被包进原语）；
 * - `fs: 'cwd'` 但没有 OS 绑定 ⇒ **只声明**，装配期发 `config.mcp-inactive` 告警；
 * - `net: 'none'` ⇒ 目前**任何档位都强制不了**（L0 静态门管不到别人的子进程），
 *   只会告警。别把这条当成隔离 —— 要真断网得等 L3（容器/远程 executor）。
 */
export interface McpServerCapabilities {
  /** 文件系统：`'cwd'` = 只在会话工作目录内；`'unrestricted'`（默认，逐位等于改造前） */
  fs?: 'cwd' | 'unrestricted'
  /** 网络：`'none'` = 不该出网；`'unrestricted'`（默认） */
  net?: 'none' | 'unrestricted'
}

/** server 声明的能力**与当前档位下能不能强制**的对照（装配期算一次，进 notice） */
export interface McpCapabilityResolution {
  /** 声明了但**强制不了**的项（人读，逐条一个维度） */
  unenforceable: string[]
  /** 该 server 是否真的被套上 OS 绑定 */
  bound: boolean
}

/**
 * 把「声明」与「本机实际能给的」折成结论（与 `resolveIsolation` 同范式：只给结论、不决定后果）。
 *
 * 入参刻意只收 `osBindingAvailable`（布尔）而不是 `OsBinding` 本身：装配期要**先判定、
 * 后套用**，而 host 的 `config.ts` 只做判定（它不持有绑定对象）—— 收对象会逼着判定方
 * 造一个假绑定，那正是"看起来有了"的形状。
 */
export function resolveMcpCapabilities(
  caps: McpServerCapabilities | undefined,
  opts: { osBindingAvailable?: boolean } = {},
): McpCapabilityResolution {
  const unenforceable: string[] = []
  const wantFs = caps?.fs === 'cwd'
  const bound = wantFs && opts.osBindingAvailable === true
  if (wantFs && !bound) {
    unenforceable.push(
      `声明了 fs:"cwd"，但本次没有 OS 绑定（config.json → sandbox.osBinding="on" 且本机有原语才生效）⇒ 只声明、不强制`,
    )
  }
  if (caps?.net === 'none') {
    unenforceable.push('声明了 net:"none"，但当前任何档位都强制不了子进程出网（L0 静态门管不到外部进程）⇒ 只声明、不强制')
  }
  return { unenforceable, bound }
}

/**
 * 配置文件里的 MCP Server 条目。由 config.json 的 `mcpServers` 数组提供：
 * 复用 @harness/mcp-client 的 McpServerConfig 字段，并附加两级启停开关与能力声明（P1-7）。
 */
export type McpServerEntry = McpServerConfig & {
  /** 服务器级开关（缺省 true） */
  enabled?: boolean
  /** 工具级开关：key=工具名（不带 mcp__<server>__ 前缀），value=false 表示停用单个工具（缺省全开） */
  tools?: Record<string, boolean>
  /** 能力声明（P1-7）：不写 = 全不受限（与改造前逐位一致） */
  capabilities?: McpServerCapabilities
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
  /**
   * OS 绑定（P1-3 / P1-7）：由宿主在装配期构造并自检通过后递入。
   * 只有 server **声明**了 `capabilities.fs:"cwd"` 才套到它的子进程上。
   */
  osBinding?: OsBinding | null
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
 * 负责：core.harness.start 时连接所有已注册（代码 + config.json）server → core.tool.pool.assemble 暴露工具
 *       → /mcp 命令管理（服务器/工具两级启停）→ unload 时断开。
 * 配置源：config.json `mcpServers` 经 `cli.mcp.configure` Hook 注入（boot 时由 CLI 调用），
 *        后续 CLI/TUI/Web 界面经注入的 McpCliStore.save 持久化回 config.json。
 */
export function createMcpServerRegistryPlugin(options: McpServerRegistryPluginOptions = {}): AgentPlugin {
  const reg = options.registry ?? defaultRegistry
  const dataDir = options.dataDir
  // P1-7：OS 绑定只对**声明了 fs 受限**的 server 生效（没声明 = 不受限，与改造前一致）
  const osBinding = options.osBinding ?? null
  const bindingFor = (entry?: McpServerEntry): OsBinding | null =>
    resolveMcpCapabilities(entry?.capabilities, { osBindingAvailable: osBinding != null }).bound ? osBinding : null
  const runtimes: McpServerRuntime[] = []
  /** name → 托管配置条目；来自 config.json mcpServers */
  const managed = new Map<string, ManagedEntry>()
  /** 本次进程内被 /mcp 禁用的 server → 其应从工具池移除的工具 id（含托管与代码注册） */
  const downTools = new Map<string, string[]>()
  /** 代码注册 server → 来源插件 id（供插件卸载/重载时同步断连/重连） */
  const serverSource = new Map<string, string>()
  /** CLI 注入的持久化回调 */
  let cliStore: McpCliStore | undefined
  /** 事件退订句柄（install 注册、uninstall 退订） */
  const offs: Unsubscribe[] = []

  /**
   * 跨层解耦的自检：核对 runtimes 与「托管配置 + 代码注册」两个来源，
   * 清理已不属于任何来源的孤儿 runtime（例如宿主插件被卸载/重载而未正确注销其 server 时）。
   */
  function syncRuntimesFromSources(): void {
    for (let i = runtimes.length - 1; i >= 0; i--) {
      const rt = runtimes[i]
      if (!managed.has(rt.name) && !reg.has(rt.name)) {
        rt.client.close()
        runtimes.splice(i, 1)
      }
    }
  }

  /** 根据一个 server 配置建立运行时（不落 entries，调用方 push；建立后登记归属索引） */
  function makeRuntime(serverName: string, cfg: McpServerConfig, entry?: McpServerEntry): Promise<McpServerRuntime | undefined> {
    return (async () => {
      const transport = defaultTransportFactory(cfg, { dataDir, osBinding: bindingFor(entry) })
      const client = new McpClient(serverName, transport, cfg)
      await client.connect()
      const tools = await client.listTools()
      const harnessTools = tools.map((t) => convertMcpToolToHarnessTool(t, serverName, client))
      globalMcpToolIndex.index(serverName, harnessTools.map((t) => t.id))
      return { name: serverName, client, tools: harnessTools, entry }
    })()
  }

  /** 连接一个托管条目，失败返回 false（in-flight 去重，供懒加载并发安全） */
  const managedInflight = new Map<string, Promise<boolean>>()
  async function connectManaged(name: string): Promise<boolean> {
    const m = managed.get(name)
    if (!m) return false
    if (runtimes.some((r) => r.name === name)) return true
    const inflight = managedInflight.get(name)
    if (inflight) return inflight
    const p = (async () => {
      try {
        const rt = await makeRuntime(name, m.entry, m.entry)
        runtimes.push(rt!)
        return true
      } catch {
        return false
      }
    })().finally(() => managedInflight.delete(name))
    managedInflight.set(name, p)
    return p
  }

  /**
   * 连接一个「代码注册」server（当前未连接则建立运行时并登记归属索引）。
   * 与懒加载 assemble 共用，供 /mcp enable 在会话内重新启用禁用项。
   */
  const codeInflight = new Map<string, Promise<McpServerRuntime | undefined>>()
  async function connectCodeServer(name: string): Promise<McpServerRuntime | undefined> {
    const item = reg.list().find((r) => r.name === name)
    if (!item) return undefined
    const existing = runtimes.find((r) => r.name === name)
    if (existing) return existing
    const inflight = codeInflight.get(name)
    if (inflight) return inflight
    const p = (async () => {
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
      globalMcpToolIndex.index(item.name, harnessTools.map((t) => t.id))
      if (item.source) serverSource.set(item.name, item.source)
      const rt: McpServerRuntime = { name: item.name, client, tools: harnessTools }
      runtimes.push(rt)
      return rt
    })().finally(() => codeInflight.delete(name))
    codeInflight.set(name, p)
    return p
  }

  /** 断开并移除 one server（close 客户端，并清除其工具归属索引） */
  function disconnectServer(name: string): void {
    const i = runtimes.findIndex((r) => r.name === name)
    if (i >= 0) {
      runtimes[i].client.close()
      runtimes.splice(i, 1)
    }
    globalMcpToolIndex.unindex(name)
    serverSource.delete(name)
  }

  /** 懒加载：首次工具池装配（assemble）时连接所有「启用」server（in-flight 去重，失败仅跳过） */
  async function ensureConnected(): Promise<void> {
    const down = new Set<string>(downTools.keys())
    const jobs: Promise<unknown>[] = []
    for (const item of reg.list()) {
      if (down.has(item.name)) continue
      if (runtimes.some((r) => r.name === item.name)) continue
      jobs.push(connectCodeServer(item.name).catch(() => undefined))
    }
    for (const [name, m] of managed) {
      if (!m.enabled || down.has(name)) continue
      if (runtimes.some((r) => r.name === name)) continue
      jobs.push(connectManaged(name).catch(() => false))
    }
    if (jobs.length) await Promise.all(jobs)
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
    version: '0.3.0',
    name: 'MCP Server Registry',
    description: 'MCP Server 注册表：启动所有注册的 MCP Server，并通过 @harness/mcp-client 连接管理',

    async install(ctx) {
      // 跨层解耦：宿主插件卸载/更新时自检并清理孤儿 runtime（不反向改上层状态）
      offs.push(
        ctx.bus.subscribe(LifecycleEvents.pluginUnloaded, ({ payload }) => {
          if (payload.id === 'mcp.server-registry') syncRuntimesFromSources()
        }),
      )
      offs.push(
        ctx.bus.subscribe(LifecycleEvents.pluginUpdated, ({ payload }) => {
          if (payload.id === 'mcp.server-registry') syncRuntimesFromSources()
        }),
      )
      // 宿主插件卸载：断开其注册的 MCP server，并记录待移除工具（经 assembleTools 收敛）
      offs.push(
        ctx.bus.subscribe(LifecycleEvents.pluginUnloaded, ({ payload }) => {
          for (const [serverName, src] of Array.from(serverSource)) {
            if (src !== payload.id) continue
            const rt = runtimes.find((r) => r.name === serverName)
            downTools.set(serverName, rt ? rt.tools.map((t) => t.id) : [])
            disconnectServer(serverName)
            void ctx.bus.publish(LifecycleEvents.mcpServerDisabled, { name: serverName }, { source: 'mcp.server-registry' })
          }
        }),
      )
      // 宿主插件重新启用/重载：重连其注册的 MCP server（reg 里已重新注册）
      offs.push(
        ctx.bus.subscribe(LifecycleEvents.pluginLoaded, ({ payload }) => {
          for (const item of reg.list()) {
            if (item.source !== payload.id) continue
            if (runtimes.some((r) => r.name === item.name)) continue
            downTools.delete(item.name) // 恢复装配（之前卸载时可能被 downTools 记录）
            void (async () => {
              try {
                const rt = await connectCodeServer(item.name)
                if (rt) await ctx.bus.publish(LifecycleEvents.mcpServerEnabled, { name: item.name }, { source: 'mcp.server-registry' })
              } catch { /* 连接失败不阻塞其他 server */ }
            })()
          }
        }),
      )

      return {
        /**
         * 注入 config.json 的 mcpServers（替换托管列表）。仅建立配置态，不连接；
         * 由 core.harness.start 按 enabled 开关连接。CLI 在 createHarness 后、start 前调用。
         *
         * 入参用契约层的 `McpConfigureInput`（`McpServerConfigLike` 与 mcp-client 的
         * `McpServerConfig` 结构一致但刻意不 import —— 避免契约包反向依赖 MCP 插件包）。
         * 这里按本插件自己的 `McpServerEntry` 收窄：字段口径由 mcp-client 定义，双方约定同步。
         */
        'cli.mcp.configure'(input: McpConfigureInput) {
          const entries = (input.mcpServers ?? []) as unknown as McpServerEntry[]
          managed.clear()
          for (const e of entries) {
            managed.set(e.name, {
              entry: e,
              enabled: e.enabled ?? true,
              tools: { ...(e.tools ?? {}) },
            })
          }
        },

        async 'core.harness.start'() {
          // 懒加载：启动不预连 MCP server，避免阻塞应用启动。
          // 首次 core.tool.pool.assemble（首条消息 / /tools / /mcp 等真正需要工具时）才连接；
          // 单个 server 连接失败仅被跳过，不影响启动与其他 server。
        },

        async 'core.tool.pool.assemble'(_input, pool) {
          const p = pool as { add: (t: unknown) => void; remove?: (id: string) => void }
          // 懒加载：装配工具前确保「启用」server 已连接（in-flight 去重，失败仅跳过）
          await ensureConnected()
          // ① 先把「已禁用」server 的工具从池中移除（收敛运行时 ToolRegistry，避免残留可调用）
          if (p.remove) {
            for (const [, ids] of downTools) for (const id of ids) p.remove(id)
          }
          // ② 装配启用状态 server 的工具
          const down = new Set<string>(downTools.keys())
          for (const rt of runtimes) {
            if (down.has(rt.name)) continue
            // 工具级过滤：base 名 = 去掉 mcp__<server>__ 前缀；managed.tools[base]===false 时跳过
            const prefix = `mcp__${rt.name}__`
            const m = rt.entry ? managed.get(rt.name) : undefined
            for (const tool of rt.tools) {
              const base = tool.id.startsWith(prefix) ? tool.id.slice(prefix.length) : tool.id
              if (m && m.tools[base] === false) continue
              p.add(tool)
            }
          }
        },

        'cli.commands'(input) {
          if (runtimes.length === 0 && managed.size === 0 && reg.list().length === 0) return
          input.commands.push({
            command: 'mcp',
            description: 'MCP Server 生命周期管理（config.json 装配、服务器级启停）',
            usage: '/mcp [servers [enable|disable <s>] | tools | enable <s> | disable <s> | add <json> | remove <s>]',
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
          let sub = (parts[0] ?? '').toLowerCase()
          // 兼容嵌套写法 /mcp servers enable|disable <s>：把动作提升为主子命令，
          // parts 归一化为 [<sub>, <name>, ...]（如 [disable, code-intel]）
          if (sub === 'servers' && (parts[1] === 'enable' || parts[1] === 'disable')) {
            sub = parts[1]
            parts.splice(0, 2, sub)
          }
          const out = (s: string) => input.out(s)

          const serverList = () => {
            if (runtimes.length === 0 && managed.size === 0 && reg.list().length === 0) { out('（无已注册的 MCP Server）\n'); return }
            out(`已注册 ${managed.size + reg.list().length} 个 MCP Server（` + (cliStore ? 'config.json 托管 + 代码注册' : '全部为代码注册') + `）：\n`)
            for (const [name, m] of managed) {
              const rt = runtimes.find((r) => r.name === name)
              out(`  ${name}  ${m.enabled ? '[启用]' : '[禁用]'}  tools=${rt?.tools.length ?? 0}  connected=${rt?.client.isConnected ?? false}\n`)
            }
            for (const item of reg.list()) {
              if (managed.has(item.name)) continue
              const rt = runtimes.find((r) => r.name === item.name)
              const disabled = downTools.has(item.name)
              out(`  ${item.name}  [代码注册]${disabled ? ' [会话禁用]' : ' [启用]'}  tools=${rt?.tools.length ?? 0}  connected=${rt?.client.isConnected ?? false}\n`)
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
            const isOn = sub === 'enable'
            const m = managed.get(name)
            const isReg = reg.has(name)
            if (!m && !isReg) { out(`未知 MCP server："${name}"\n`); return }
            if (isOn) {
              downTools.delete(name)
              if (m) { m.enabled = true; persist() }
              const ok = m ? await connectManaged(name) : await connectCodeServer(name)
              out(ok ? (m ? `已启用并连接 ${name}\n` : `已启用并重新连接 ${name}（本次进程生效）\n`) : `启用失败（未能连接 ${name}）\n`)
              await ctx.bus.publish(LifecycleEvents.mcpServerEnabled, { name }, { source: 'mcp.server-registry' })
            } else {
              // 记录待移除的工具 id（先从运行态取，再断开连接），供 core.tool.pool.assemble 收敛注册表
              const rt = runtimes.find((r) => r.name === name)
              downTools.set(name, rt ? rt.tools.map((t) => t.id) : [])
              if (m) { m.enabled = false; persist() }
              disconnectServer(name)
              out(`已禁用 ${name}${m ? '' : '（本次进程生效；重启后恢复连接）'}\n`)
              await ctx.bus.publish(LifecycleEvents.mcpServerDisabled, { name }, { source: 'mcp.server-registry' })
            }
          } else if (sub === 'add') {
            const json = arg.slice(sub.length).trim().replace(/^--\s*/, '')
            try {
              const e = JSON.parse(json) as McpServerEntry
              if (!e?.name) { out('add 需要 JSON 含 name 字段\n'); return }
              managed.set(e.name, { entry: e, enabled: e.enabled ?? true, tools: { ...(e.tools ?? {}) } })
              persist()
              const ok = managed.get(e.name)!.enabled ? await connectManaged(e.name) : true
              out(ok ? `已添加并连接 ${e.name}\n` : `已添加但仍需连接（config 有误？）${e.name}\n`)
              await ctx.bus.publish(LifecycleEvents.mcpServerAdded, { name: e.name }, { source: 'mcp.server-registry' })
            } catch (err) {
              out(`JSON 解析失败：${(err as Error)?.message ?? String(err)}\n用法：/mcp add <json>（含 name; 可再 -- 前缀）\n`)
            }
          } else if (sub === 'remove') {
            const name = parts[1]
            if (!name) { out('用法：/mcp remove <server>\n'); return }
            if (!managed.has(name)) { out(`未知托管 server："${name}"\n`); return }
            const rt = runtimes.find((r) => r.name === name)
            downTools.set(name, rt ? rt.tools.map((t) => t.id) : []) // 移除后从工具池收敛
            managed.delete(name)
            disconnectServer(name)
            persist()
            out(`已移除 ${name}\n`)
            await ctx.bus.publish(LifecycleEvents.mcpServerRemoved, { name }, { source: 'mcp.server-registry' })
          } else {
            out(`未知子命令：${sub}\n用法：/mcp [servers [enable|disable <s>] | tools | enable <s> | disable <s> | add <json> | remove <s>]\n`)
          }
          input.result = 'continue'
        },
      } as Hooks
    },

    async uninstall() {
      for (const off of offs) off()
      offs.length = 0
      for (const rt of runtimes) {
        rt.client.close()
        globalMcpToolIndex.unindex(rt.name)
      }
      runtimes.length = 0
      managed.clear()
      downTools.clear()
      cliStore = undefined
    },
  }
}