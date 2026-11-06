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

import type { AgentPlugin, CliCommandInput, Hooks, McpConfigureInput } from '@harness/plugin'
import { globalMcpToolIndex, type Tool } from '@harness/tool'
import type { Unsubscribe } from '@harness/bus'
import { LifecycleEvents } from '@harness/core'
import {
  McpClient,
  defaultTransportFactory,
  convertMcpToolToHarnessTool,
  mcpToolBaseName,
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
 * `/mcp` 命令收到的输入 = 契约层 `CliCommandInput` + CLI **额外注入**的两个持久化字段。
 *
 * 这两个字段没进契约层是刻意的：`McpServerEntry` 的类型住在 mcp-client，让 `@harness/plugin`
 * 反向依赖 MCP 插件包会把依赖方向倒过来。但这也意味着"CLI 注入什么"事实上由两边各写一遍
 * （cli 侧一个结构化字面量、这里原本四个 `as any`）—— 故在本文件**只窄化一次**，
 * 字段名与 cli 侧保持一致，读的地方直接用类型，不再逐个 `any`。
 */
interface McpCommandInput extends CliCommandInput {
  /** CLI 注入：当前 config.json 的 mcpServers（与 cli 侧 `mcpServers:` 同源） */
  mcpServers?: McpServerEntry[]
  /** CLI 注入：持久化 mcpServers 回 config.json */
  setMcpServers?: (list: McpServerEntry[]) => Promise<void> | void
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
  /** name → 最近一次连接失败原因；只在"连不上"时存在，供 /mcp servers 把静默失败变成可诊断 */
  const lastError = new Map<string, string>()
  /** 建连去重：两条来源路径（托管 / 代码注册）共用一张 in-flight 表，同名并发只真连一次 */
  const inflight = new Map<string, Promise<McpServerRuntime | undefined>>()
  /** 已卸载：in-flight 连接在 uninstall 之后才 resolve 时不得再登记 */
  let disposed = false
  /** CLI 注入的持久化回调 */
  let cliStore: McpCliStore | undefined
  /** 事件退订句柄（install 注册、uninstall 退订） */
  const offs: Unsubscribe[] = []

  const runtimeOf = (name: string): McpServerRuntime | undefined => runtimes.find((r) => r.name === name)

  /** 关闭一个 runtime 并摘掉它的工具归属索引（"拆除"的唯一口径，三处调用点共用） */
  function closeRuntime(rt: McpServerRuntime): void {
    rt.client.close()
    globalMcpToolIndex.unindex(rt.name)
  }

  /**
   * 登记 runtime。**插件已卸载时立刻关闭并丢弃** —— 连接是异步的，uninstall 之后才
   * resolve 的那一个若照常 push，就既不在任何列表里、也没有人会再去关它（连接与子进程泄漏）。
   */
  function commitRuntime(rt: McpServerRuntime): boolean {
    if (disposed) {
      closeRuntime(rt)
      return false
    }
    runtimes.push(rt)
    return true
  }

  /** 记录一次连接失败（单行、截断）：`/mcp servers` 输出里带上它，否则"连不上"只剩 connected=false */
  function noteError(name: string, err: unknown): void {
    const raw = (err as Error)?.message ?? String(err)
    const oneLine = raw.replace(/\s+/g, ' ').trim().slice(0, 160)
    lastError.set(name, oneLine || '未知错误')
  }

  /**
   * 把一条托管配置折成运行态（缺省口径的唯一出处：enabled 缺省 true、tools 缺省空表）。
   * `cli.mcp.configure` 与 `/mcp add` 两条入口此前各写一遍。
   */
  function toManagedEntry(e: McpServerEntry): ManagedEntry {
    return { entry: e, enabled: e.enabled ?? true, tools: { ...(e.tools ?? {}) } }
  }

  /**
   * 标记一个 server「本次进程内不可用」：先取运行态工具 id 再断开，供 assemble 收敛工具池。
   * 卸载 / 禁用 / 移除三处共用；顺带清掉上一次连接失败原因（此时下线是**有意为之**，不是故障）。
   */
  function markDown(name: string): void {
    downTools.set(name, runtimeOf(name)?.tools.map((t) => t.id) ?? [])
    lastError.delete(name)
  }

  /**
   * 跨层解耦的自检：核对 runtimes 与「托管配置 + 代码注册」两个来源，
   * 清理已不属于任何来源的孤儿 runtime（例如宿主插件被卸载/重载而未正确注销其 server 时）。
   */
  function syncRuntimesFromSources(): void {
    for (let i = runtimes.length - 1; i >= 0; i--) {
      const rt = runtimes[i]
      if (!managed.has(rt.name) && !reg.has(rt.name)) {
        closeRuntime(rt)
        runtimes.splice(i, 1)
        serverSource.delete(rt.name)
        downTools.delete(rt.name)
      }
    }
  }

  /** 建连材料：传输怎么来、McpClient 用什么配置、归属与工具级开关挂在哪条条目上 */
  interface OpenSpec {
    name: string
    createTransport: () => McpTransport | Promise<McpTransport>
    config?: McpServerConfig
    /** 托管条目：assemble 时据此做工具级过滤 */
    entry?: McpServerEntry
    /** 代码注册的来源插件 id（供插件卸载时定位） */
    source?: string
  }

  /**
   * 建立一条 server 连接的**唯一实现**：建传输 → connect → listTools → 转 Harness 工具 → 登记归属索引。
   * 托管 / 代码注册两条路径此前各写一遍这五步，改一处就会与另一处分叉（差异恰好落在
   * OS 绑定与 source 登记上，正是最容易只改一半的地方）。
   */
  async function openRuntime(spec: OpenSpec): Promise<McpServerRuntime> {
    const transport = await spec.createTransport()
    const client = new McpClient(spec.name, transport, spec.config)
    await client.connect()
    const listed = await client.listTools()
    const tools = listed.map((t) => convertMcpToolToHarnessTool(t, spec.name, client))
    globalMcpToolIndex.index(spec.name, tools.map((t) => t.id))
    if (spec.source) serverSource.set(spec.name, spec.source)
    return { name: spec.name, client, tools, entry: spec.entry }
  }

  /** in-flight 去重：同名并发连接共享同一个 promise（懒加载 assemble 与 /mcp enable 会撞在一起） */
  function withInflight(
    name: string,
    task: () => Promise<McpServerRuntime | undefined>,
  ): Promise<McpServerRuntime | undefined> {
    const running = inflight.get(name)
    if (running) return running
    const p = task().finally(() => inflight.delete(name))
    inflight.set(name, p)
    return p
  }

  /** 连接一个托管条目；失败返回 undefined（原因记入 lastError，不再静默） */
  async function connectManaged(name: string): Promise<McpServerRuntime | undefined> {
    const m = managed.get(name)
    if (!m || disposed) return undefined
    const existing = runtimeOf(name)
    if (existing) return existing
    return withInflight(name, async () => {
      try {
        const rt = await openRuntime({
          name,
          // 能力声明按条目判定：只有声明了 fs:"cwd" 且本机有绑定才把 OS 绑定套到子进程上
          createTransport: () => defaultTransportFactory(m.entry, { dataDir, osBinding: bindingFor(m.entry) }),
          config: m.entry,
          entry: m.entry,
        })
        if (!commitRuntime(rt)) return undefined
        lastError.delete(name)
        return rt
      } catch (err) {
        noteError(name, err)
        return undefined
      }
    })
  }

  /**
   * 连接一个「代码注册」server（当前未连接则建立运行时并登记归属索引）。
   * 与懒加载 assemble 共用，供 /mcp enable 在会话内重新启用禁用项。
   */
  async function connectCodeServer(name: string): Promise<McpServerRuntime | undefined> {
    const item = reg.list().find((r) => r.name === name)
    if (!item || disposed) return undefined
    const existing = runtimeOf(name)
    if (existing) return existing
    return withInflight(name, async () => {
      try {
        const rt = await openRuntime({
          name,
          // config 条目：用共享的 defaultTransportFactory（可带 item.dataDir 覆盖）；
          // createTransport 条目：由注册方自己拉起（进程内 server / 自定义启动器）
          createTransport: () =>
            'config' in item
              ? defaultTransportFactory(item.config, { dataDir: item.dataDir ?? dataDir })
              : item.createTransport(),
          config: 'config' in item ? item.config : undefined,
          source: item.source,
        })
        if (!commitRuntime(rt)) return undefined
        lastError.delete(name)
        return rt
      } catch (err) {
        noteError(name, err)
        return undefined
      }
    })
  }

  /** 断开并移除 one server（close 客户端，并清除其工具归属索引） */
  function disconnectServer(name: string): void {
    const rt = runtimeOf(name)
    if (rt) {
      closeRuntime(rt)
      runtimes.splice(runtimes.indexOf(rt), 1)
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
      if (runtimeOf(item.name)) continue
      jobs.push(connectCodeServer(item.name).catch(() => undefined))
    }
    for (const [name, m] of managed) {
      if (!m.enabled || down.has(name)) continue
      if (runtimeOf(name)) continue
      jobs.push(connectManaged(name).catch(() => undefined))
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
      // 跨层解耦：**任何**插件卸载/更新后自检并清理孤儿 runtime（不反向改上层状态）。
      // 注意不能只看 `payload.id === 本插件`：宿主插件（如 code-intel）先注销了注册项却没走
      // serverSource 路线时，孤儿 runtime 只能靠这里收；只认自己等于永远不跑（注释说的才是意图）。
      offs.push(ctx.bus.subscribe(LifecycleEvents.pluginUnloaded, () => syncRuntimesFromSources()))
      offs.push(ctx.bus.subscribe(LifecycleEvents.pluginUpdated, () => syncRuntimesFromSources()))
      // 宿主插件卸载：断开其注册的 MCP server，并记录待移除工具（经 assembleTools 收敛）
      offs.push(
        ctx.bus.subscribe(LifecycleEvents.pluginUnloaded, ({ payload }) => {
          for (const [serverName, src] of Array.from(serverSource)) {
            if (src !== payload.id) continue
            markDown(serverName)
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
            if (runtimeOf(item.name)) continue
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
          for (const e of entries) managed.set(e.name, toManagedEntry(e))
        },

        async 'core.harness.start'() {
          // 懒加载：启动不预连 MCP server，避免阻塞应用启动。
          // 首次 core.tool.pool.assemble（首条消息 / /tools / /mcp 等真正需要工具时）才连接；
          // 单个 server 连接失败仅被跳过，不影响启动与其他 server。
        },

        async 'core.tool.pool.assemble'(_input, pool) {
          // 懒加载：装配工具前确保「启用」server 已连接（in-flight 去重，失败仅跳过）
          await ensureConnected()
          // ① 先把「已禁用」server 的工具从池中移除（收敛运行时 ToolRegistry，避免残留可调用）
          //    直接走契约里的 `ToolPool`：`remove` 是**必选**方法，此前把 pool 强转成
          //    `{ remove?: … }` 再 `if (p.remove)`，等于为一个不可能为假的条件留死分支。
          for (const [, ids] of downTools) for (const id of ids) pool.remove(id)
          // ② 装配启用状态 server 的工具
          const down = new Set<string>(downTools.keys())
          for (const rt of runtimes) {
            if (down.has(rt.name)) continue
            // 工具级过滤：base 名 = 去掉 mcp__<server>__ 前缀；managed.tools[base]===false 时跳过
            const m = rt.entry ? managed.get(rt.name) : undefined
            for (const tool of rt.tools) {
              if (m && m.tools[mcpToolBaseName(rt.name, tool.id)] === false) continue
              pool.add(tool)
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
          // CLI 注入持久化回调（对齐 setAgentTools 模式）。契约层 `CliCommandInput` 里没有这两个
          // 字段（MCP 条目类型住在 mcp-client，不宜让契约包反向依赖），故在**一处**窄化，
          // 而不是在每次读取时各转一次 `any`。
          const cmd = input as McpCommandInput
          if (cmd.setMcpServers) {
            cliStore = { mcpServers: cmd.mcpServers ?? [], save: cmd.setMcpServers }
          }
          const arg = cmd.arg.trim()
          const parts = arg.split(/\s+/)
          let sub = (parts[0] ?? '').toLowerCase()
          // 兼容嵌套写法 /mcp servers enable|disable <s>：把动作提升为主子命令，
          // parts 归一化为 [<sub>, <name>, ...]（如 [disable, code-intel]）
          if (sub === 'servers' && (parts[1] === 'enable' || parts[1] === 'disable')) {
            sub = parts[1]
            parts.splice(0, 2, sub)
          }
          const out = (s: string) => input.out(s)

          /** 一个 server 的展示行（托管 / 代码注册共用；连不上时带上最近一次失败原因） */
          const serverLine = (name: string, tag: string) => {
            const rt = runtimeOf(name)
            const err = rt ? undefined : lastError.get(name)
            const head = `  ${name}  ${tag}  tools=${rt?.tools.length ?? 0}  connected=${rt?.client.isConnected ?? false}`
            out(head + (err ? `  error="${err}"` : '') + '\n')
          }

          const serverList = () => {
            // 计数按**名字去重**：同名条目同处两条来源时（托管 + 代码注册），
            // 此前表头 `managed.size + reg.list().length` 会比实际打印的行多。
            const total = new Set([...managed.keys(), ...reg.list().map((r) => r.name)]).size
            if (total === 0) { out('（无已注册的 MCP Server）\n'); return }
            out(`已注册 ${total} 个 MCP Server（` + (cliStore ? 'config.json 托管 + 代码注册' : '全部为代码注册') + `）：\n`)
            for (const [name, m] of managed) serverLine(name, m.enabled ? '[启用]' : '[禁用]')
            for (const item of reg.list()) {
              if (managed.has(item.name)) continue
              serverLine(item.name, `[代码注册]${downTools.has(item.name) ? ' [会话禁用]' : ' [启用]'}`)
            }
          }

          if (sub === '' || sub === 'servers') {
            serverList()
          } else if (sub === 'tools') {
            const toolList: Array<{ id: string; desc?: string; server: string; disabled?: boolean }> = []
            for (const rt of runtimes) {
              const m = managed.get(rt.name)
              for (const t of rt.tools) {
                const base = mcpToolBaseName(rt.name, t.id)
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
              const rt = m ? await connectManaged(name) : await connectCodeServer(name)
              const why = lastError.get(name)
              out(rt
                ? (m ? `已启用并连接 ${name}\n` : `已启用并重新连接 ${name}（本次进程生效）\n`)
                : `启用失败（未能连接 ${name}${why ? `：${why}` : ''}）\n`)
              await ctx.bus.publish(LifecycleEvents.mcpServerEnabled, { name }, { source: 'mcp.server-registry' })
            } else {
              // 记录待移除的工具 id（先从运行态取，再断开连接），供 core.tool.pool.assemble 收敛注册表
              markDown(name)
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
              const added = toManagedEntry(e)
              managed.set(e.name, added)
              persist()
              // 禁用状态下不连接（此前会打印"已添加并连接"，与实际不符）
              if (!added.enabled) {
                out(`已添加 ${e.name}（enabled=false，当前不连接）\n`)
              } else {
                const rt = await connectManaged(e.name)
                const why = lastError.get(e.name)
                out(rt ? `已添加并连接 ${e.name}\n` : `已添加但连接失败：${why ?? '未知原因'}\n`)
              }
              await ctx.bus.publish(LifecycleEvents.mcpServerAdded, { name: e.name }, { source: 'mcp.server-registry' })
            } catch (err) {
              out(`JSON 解析失败：${(err as Error)?.message ?? String(err)}\n用法：/mcp add <json>（含 name; 可再 -- 前缀）\n`)
            }
          } else if (sub === 'remove') {
            const name = parts[1]
            if (!name) { out('用法：/mcp remove <server>\n'); return }
            if (!managed.has(name)) { out(`未知托管 server："${name}"\n`); return }
            markDown(name) // 移除后从工具池收敛
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
      // 先置位再拆除：in-flight 的连接在 await 返回后才会看到这个标志，
      // 否则它会照常 push 进已清空的 runtimes —— 没人再关它（连接与子进程泄漏）。
      disposed = true
      for (const off of offs) off()
      offs.length = 0
      for (const rt of runtimes) closeRuntime(rt)
      runtimes.length = 0
      managed.clear()
      downTools.clear()
      serverSource.clear()
      lastError.clear()
      inflight.clear()
      cliStore = undefined
    },
  }
}