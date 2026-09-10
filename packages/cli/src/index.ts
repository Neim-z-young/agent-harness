#!/usr/bin/env bun
/**
 * @harness/cli - Agent Harness 命令行入口
 *
 * 命令：
 *   harness repl                 交互式 REPL（默认命令，start 别名）
 *   harness start                同 repl
 *   harness list-sessions        列出持久化会话
 *   harness resume <sessionId>   恢复指定会话继续交互
 *   harness run "<prompt>"       一次性执行 prompt 并输出结果
 *
 * CLI 选项（适用于 repl/start/run）：
 *   --cwd <dir>               工作目录
 *   --agent <id>              默认 Agent ID
 *   --provider <name>         mock / anthropic（默认 anthropic，未配 key 时自动 fallback mock）
 *   --session <id>            复用/新建指定 ID 的会话（如 resume）
 *   --data-dir <dir>          持久化目录（默认 ~/.harness）
 *   --permission <mode>       allow-all / ask / deny-all（默认 ask）
 *   --tui                     以 TUI（alt-screen 全屏）模式启动 REPL
 *   --verbose                 输出调试信息
 *
 * 可执行入口（shebang 指向 bun）。模块对外导出 CLIApp 类，便于测试。
 */

import {
  createHarness,
  AgentDefinition,
  Harness,
  DefaultPermissionEngine,
  ChatProvider,
  PermissionDecision,
} from '@harness/core'
import type { AgentStreamEvent } from '@harness/core'
import type { AgentPlugin, PluginContext, ProviderConfig, ProviderTypeFactory, ProviderTypeMeta } from '@harness/plugin'
import { ProviderTypeRegistry, resolveProviderTypeFactory } from '@harness/plugin'
// 运行时能力抽象契约（@harness/plugin）：cli 仅经下方面向 subagent / swarm 的抽象接口交互，
// 不依赖具体实现类型。具体能力对象（subagentCapability / swarmCapability）由插件包导出并在组合根装配。
import type { BackgroundTaskViewLike, ToolMetaEntry, ToolMetaLookup, ToolMetaRegistry, ToolMetaSource } from '@harness/plugin'
// 内置 Provider 模块与 tools-builtin 一律惰性加载（见 lazyImport / registerBuiltinProviderTypes）：
// 这里只保留类型导入，运行时值经动态 import() 在真正用到时才加载，避免拖慢启动。
// 例外：tools-builtin 的「静态元信息」（meta）为纯数据、无副作用，可提前加载（多级加载 L1，
// 见 BuiltinToolRegistry）；对应的运行时工具模块（L2）仍经 getBuiltinRegistry().load() 惰性/后台加载。
import type { MockProviderConfig } from '@harness/provider-mock'
// 内置工具静态元信息（多级加载 L1，抽象契约 ToolMetaSource）：各工具插件以 toolMetaSource 自描述，
// 由 BuiltinGeneralPlugin.metaSource 自携带（惰性 dynamic import 对应 /meta 模块），
// CLI 经 ToolMetaRegistry（preloadBuiltinToolMetas）统一登记，不硬编码各包的具体导出形态。
// subagent / swarm 均为内置插件（组合根直连），cli 经其导出的能力对象（抽象契约）交互
import { subagentCapability } from '@harness/subagent'
import { CoordinatorEvents } from '@harness/coordinator'
import { swarmCapability } from '@harness/swarm'
import { createWorkspacePlugin } from '@harness/workspace-shell'
import { createSnapshotService, type SnapshotService } from '@harness/snapshot'
import {
  ConfigStore,
  SessionFileStore,
  SecretCipher,
  ConfigValidationError,
  resolveSecret,
  resolveWorkspace,
  MultiDirLoader,
  normalizeDirs,
  type Workspace,
} from '@harness/workspace'
import { createRevertPlugin, createSnapshotPlugin } from '@harness/revert'
import type { McpServerEntry } from '@harness/mcp-server-registry'
import { LifecycleEvents } from '@harness/core'
import { startTuiRepl } from './tui'
import {
  emptyUsage,
  usageFromMeta,
  usageFromMessages,
  renderStatsText,
  exportStatsJson,
  exportStatsMarkdown,
  type UsageStats,
} from './usage-stats'
import type { Message, Session } from '@harness/session'
import { formatSkillSource } from '@harness/skill'
import type { ToolContext, Tool } from '@harness/tool'

import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

// ========================================================================
// 1. 参数解析
// ========================================================================

export interface CliArgs {
  /** 子命令：repl / start / list-sessions / resume / run / teammate / config */
  command: 'repl' | 'list-sessions' | 'resume' | 'run' | 'teammate' | 'config' | 'help'
  /** resume / run / config 的参数（config 为子命令如 set-key / get-key / check） */
  arg?: string
  /** config 子命令的剩余参数（如 set-key 后的 <providerId> <apiKey>） */
  rest?: string[]
  /** 选项 */
  cwd?: string
  agentId?: string
  /** teammate 子命令：所属团队（sanitize 后） */
  team?: string
  /** teammate 子命令：成员名（sanitize 后） */
  name?: string
  /** 默认 Provider id（如 anthropic / openai / gemini / 自定义） */
  provider?: string
  /** 默认模型 ID（如 claude-3-5-sonnet，或 provider/model 跨 Provider 指定），覆盖 config.json */
  model?: string
  sessionId?: string
  dataDir?: string
  permissionMode?: 'allow-all' | 'ask' | 'deny-all'
  verbose?: boolean
  /** 开启文件快照 + /revert 能力（cli 传入时覆盖 config.json 的 harness.snapshot） */
  snapshot?: boolean
  /** 以 TUI（alt-screen 全屏）模式启动 REPL */
  tui?: boolean
  /** 仅校验 config.json 配置并打印概览后退出 */
  checkConfig?: boolean
  showHelp?: boolean
}

/**
 * 最小化参数解析（不引入外部依赖）
 * 支持：短形式 (-c dir) 与长形式 (--cwd dir / --cwd=dir) / 布尔标记 --verbose
 */
export function parseCliArgs(raw: string[]): CliArgs {
  const args = raw.slice()
  let command: CliArgs['command'] = 'repl'
  let arg: string | undefined

  const out: CliArgs = { command: 'repl' }

  // 第一个非标记 token → 子命令
  if (args.length > 0 && !args[0].startsWith('-')) {
    const cmd = args.shift()!
    if (['repl', 'start'].includes(cmd)) command = 'repl'
    else if (cmd === 'list-sessions') command = 'list-sessions'
    else if (cmd === 'resume') command = 'resume'
    else if (cmd === 'run') command = 'run'
    else if (cmd === 'config') command = 'config'
    else if (cmd === 'teammate') command = 'teammate'
    else if (cmd === 'help' || cmd === '--help' || cmd === '-h') { out.showHelp = true; command = 'help' }
    else { arg = cmd } // 非标准：直接填 arg 用于 run 无命令场景
    if ((command === 'resume' || command === 'run') && args.length > 0 && !args[0].startsWith('-')) {
      arg = args.shift()!
    }
    if (command === 'config' && args.length > 0 && !args[0].startsWith('-')) {
      arg = args.shift()!
      const rest: string[] = []
      while (args.length > 0 && !args[0].startsWith('-')) rest.push(args.shift()!)
      out.rest = rest
    }
    out.command = command
    out.arg = arg
  }

  while (args.length > 0) {
    const a = args.shift()!
    if (a === '-h' || a === '--help') { out.showHelp = true; continue }
    if (a === '-v' || a === '--verbose') { out.verbose = true; continue }
    if (a === '--snapshot') { out.snapshot = true; continue }
    if (a === '--tui') { out.tui = true; continue }
    if (a === '--check-config') { out.checkConfig = true; continue }
    const [k, v] = a.startsWith('--')
      ? a.slice(2).split('=', 2) as [string, string | undefined]
      : (() => {
          // 短选项：-s=foo → [s, foo]；-s → [s, undefined]
          const body = a.slice(1)
          const eq = body.indexOf('=')
          if (eq >= 0) return [body.slice(0, eq), body.slice(eq + 1)] as [string, string]
          return [body[0] ?? '', undefined] as [string, undefined]
        })()
    // 短选项特殊处理：-s=foo → k=s, v=foo；-s foo → k=s, v 从后续取
    let key = k
    let value: string | undefined = v
    if (!a.startsWith('--') && v === undefined) {
      // 短选项 -Xval 形式：key 已取 body[0]，value=body.slice(1)（如果是单字符 key 且无 =）
      const body = a.slice(1)
      if (body.length > 0 && body.indexOf('=') < 0 && body.length > 1) {
        // 仅在未用 = 形式，且 body 长度 >1 时当 -Xval
        key = body[0]
        value = body.slice(1)
      }
    }
    if (value === undefined) value = args.shift()
    switch (key) {
      case 'c': case 'cwd': out.cwd = value; break
      case 'a': case 'agent': out.agentId = value; break
      case 'team': out.team = value; break
      case 'name': out.name = value; break
      case 'p': case 'provider': out.provider = value || undefined; break
      case 'm': case 'model': out.model = value; break
      case 's': case 'session': out.sessionId = value; break
      case 'd': case 'data-dir': out.dataDir = value; break
      case 'permission':
        out.permissionMode = value === 'allow-all' ? 'allow-all' : value === 'deny-all' ? 'deny-all' : 'ask'; break
      case 'run': // "harness --run xxx" 场景
        out.command = 'run'; out.arg = value; break
      default: break // 忽略未知
    }
  }
  if (out.showHelp) out.command = 'help'
  return out
}

// ========================================================================
// 2. 会话持久化（文件 JSON）
// ========================================================================
// 会话存储 / 配置 / 密钥存储已抽离至 @harness/workspace（消费 Workspace 解析路径），
// 本模块统一重导出，保持对外（含测试）接口不变。
export { SessionFileStore, type SessionFile } from '@harness/workspace'
export { ConfigStore, SecretCipher, ConfigValidationError, resolveSecret } from '@harness/workspace'

/** 全局配置（写 dataDir/config.json）与命令行参数合并、默认值收敛 */
export interface HarnessConfig {
  /** 默认 Agent ID */
  agentId?: string
  /** 默认 Provider id（如 anthropic / openai / gemini / 自定义，来自 config.providers） */
  provider?: string
  /** 默认模型 ID（如 claude-3-5-sonnet，或 openai/gpt-4o 跨 Provider 指定） */
  model?: string
  /** Anthropic API Key（可选，便于命令行快捷配置） */
  anthropicApiKey?: string
  /** 多 Provider 定义：可同时注册多个（anthropic / openai / gemini / mock + 任意 OpenAI 兼容端点如 DeepSeek / Ollama） */
  providers?: ProviderConfig[]
  /**
   * Agent 工具/能力覆盖：`[{ id, tools, mcpServers, excludeMcpServers }]`，启动时按 id 覆盖合并到对应 Agent。
   * 由 `/tools` 等插件持久化；缺省 Agent 为 tools:['*']（全部），配置指定数组则收窄。
   * mcpServers/excludeMcpServers：Agent 级 MCP server 白名单/黑名单（声明式，见 .md frontmatter 同名字段）。
   */
  agents?: Array<{
    id: string
    tools?: string[]
    mcpServers?: string[]
    excludeMcpServers?: string[]
  }>
  /**
   * MCP Server 装配列表：从 config.json 以 JSON 形式新增外部 MCP server（stdio/sse/http）。
   * 元素复用 McpServerConfig 字段 + enabled（服务器级）、tools（工具级）开关。
   * 启动时经 mcp.configure Hook 注入 mcp-server-registry 插件；/mcp 命令可即时启用/禁用并写回。
   */
  mcpServers?: McpServerEntry[]
  /** 开启文件快照 + /revert 能力（默认 false）；CLI `--snapshot` 优先覆盖此行 */
  snapshot?: boolean
  /**
   * 兼容的嵌套写法（表现同顶层 snapshot）：`{ "harness": { "snapshot": true } }`。
   * 若顶层 snapshot 未填，则回退读此字段。
   */
  harness?: { snapshot?: boolean }
}

/** 单个 Provider 定义（config.json 的 providers 数组元素）——复用 @harness/plugin 抽象层契约 */
export type { ProviderConfig } from '@harness/plugin'

/** 解析 `[provider/]modelId` 规格。示例：'openai/gpt-4o' → { providerId:'openai', modelId:'gpt-4o' }；'claude-3-5-sonnet' → { modelId:'claude-3-5-sonnet' } */
export function parseModelSpec(spec: string): { providerId?: string; modelId: string } {
  const s = spec.trim()
  const idx = s.indexOf('/')
  if (idx <= 0) return { providerId: undefined, modelId: s }
  return { providerId: s.slice(0, idx).trim() || undefined, modelId: s.slice(idx + 1).trim() || s }
}

/** 格式化显示 `provider/modelId`（无 providerId 时仅返回 modelId） */
export function formatModel(providerId: string | undefined, modelId: string | undefined): string | undefined {
  if (!modelId) return undefined
  return providerId ? `${providerId}/${modelId}` : modelId
}

/** 合并 CLI 参数与 config.json（CLI 优先），供 main() 汇总默认值 */
export function resolveConfig(args: CliArgs, cfg: HarnessConfig): {
  agentId: string
  provider: string
  model?: string
  anthropicApiKey?: string
} {
  return {
    agentId: args.agentId ?? cfg.agentId ?? 'default',
    provider: args.provider ?? cfg.provider ?? 'anthropic',
    model: args.model ?? cfg.model,
    anthropicApiKey: cfg.anthropicApiKey,
  }
}

// ------------------------------------------------------------------------
// 2.2 Provider 类型注册表（插件化扩展点）
// ------------------------------------------------------------------------
// 抽象层契约（ProviderTypeFactory / ProviderTypeRegistry / resolveProviderTypeFactory）
// 定义于 @harness/plugin —— 本模块（CLI）只经此抽象层与 Provider 插件交互，
// 不直接依赖任何具体 provider-* 包；具体 Provider 包通过导出 providerTypeFactory 实现该契约。

/** 惰性 import 一个随应用打包的模块并返回其命名导出（内置插件的统一惰性加载入口） */
export async function lazyImport<T extends Record<string, unknown>>(specifier: string): Promise<T> {
  return (await import(specifier)) as T
}

/**
 * 内置 Provider 类型的展示元信息（惰性注册时同步登记，不加载 Provider 模块即可在 help / config check 中展示）。
 */
const BUILTIN_PROVIDER_META: Record<string, ProviderTypeMeta> = {
  anthropic: { type: 'anthropic', description: 'Anthropic Claude', defaultModel: 'claude-3-5-sonnet', requiresApiKey: true, builtin: true, usage: '/model anthropic/claude-3-5-sonnet' },
  openai: { type: 'openai', description: 'OpenAI 及任意 OpenAI 兼容端点（DeepSeek / Ollama / 智谱 GLM / 通义等）', defaultModel: 'gpt-4o', requiresApiKey: false, builtin: true, usage: '/model openai/gpt-4o' },
  gemini: { type: 'gemini', description: 'Google Gemini', defaultModel: 'gemini-2.0-flash', requiresApiKey: true, builtin: true, usage: '/model gemini/gemini-2.0-flash' },
  glm: { type: 'glm', description: '智谱 GLM', defaultModel: 'glm-4', requiresApiKey: true, builtin: true, usage: '/model glm/glm-4' },
  qwen: { type: 'qwen', description: '阿里通义千问', defaultModel: 'qwen-max', requiresApiKey: true, builtin: true, usage: '/model qwen/qwen-max' },
  mock: { type: 'mock', description: '内置 Mock（无网络，测试 / 兜底）', defaultModel: 'mock', requiresApiKey: false, builtin: true, usage: '/model mock/…' },
}

/**
 * 注册一个内置 Provider 类型工厂（惰性）。
 * 只登记「type → 惰性 createPlugin」描述符；createPlugin 在按 config.type 真正解析 Provider 时
 * 才 dynamic import 对应 provider-* 模块、取其 providerTypeFactory（抽象层契约）构造插件。
 * 因此即使配置里只用某一种 Provider，其余模块也不会被加载，尽量不影响启动速度。
 * 同时登记展示元信息（BUILTIN_PROVIDER_META），help / config check 无需加载模块即可列出。
 */
function registerBuiltinProviderType(registry: ProviderTypeRegistry, type: string, specifier: string): void {
  registry.register(
    {
      type,
      async createPlugin(config: ProviderConfig) {
        const mod = await lazyImport<Record<string, unknown>>(specifier)
        const factory = resolveProviderTypeFactory(mod)
        if (!factory) {
          throw new Error(`内置 Provider 模块 "${specifier}" 未导出 providerTypeFactory（抽象层契约）`)
        }
        return factory.createPlugin(config)
      },
    },
    BUILTIN_PROVIDER_META[type],
  )
}

/**
 * 注册 CLI 内置 Provider 类型工厂（anthropic / openai / gemini / glm / qwen / mock）。
 * 全部经 provider-* 包的 providerTypeFactory（@harness/plugin 抽象层契约）惰性加载，
 * 本函数不含任何具体 Provider 配置结构 / 工厂的硬编码映射。
 */
export function registerBuiltinProviderTypes(registry: ProviderTypeRegistry): void {
  registerBuiltinProviderType(registry, 'anthropic', '@harness/provider-anthropic')
  registerBuiltinProviderType(registry, 'openai', '@harness/provider-openai')
  registerBuiltinProviderType(registry, 'gemini', '@harness/provider-gemini')
  registerBuiltinProviderType(registry, 'glm', '@harness/provider-glm')
  registerBuiltinProviderType(registry, 'qwen', '@harness/provider-qwen')
  registerBuiltinProviderType(registry, 'mock', '@harness/provider-mock')
}

// ------------------------------------------------------------------------
// 2.2.1 内置（随应用打包）通用插件统一注册表 —— 惰性加载，来源=builtin
// ------------------------------------------------------------------------

/** 内置通用插件描述符：登记随应用打包的通用插件（如 tools-builtin），统一惰性加载 */
export interface BuiltinGeneralPlugin {
  id: string
  name: string
  description: string
  source: 'builtin'
  /** 惰性加载：首次用到（boot 装配 / /plugins 管理）才 dynamic import，返回 AgentPlugin 实例 */
  load: () => Promise<AgentPlugin>
  /**
   * 静态元信息来源（多级加载 L1）：插件自携带，惰性 dynamic import 对应 /meta 模块（纯数据、无副作用），
   * 供 /tools 等在任何运行时模块（L2）加载前展示描述/别名/安全声明/权限键。
   */
  metaSource?: () => Promise<ToolMetaSource>
  /**
   * 仅登记 metaSource，不参与后台预加载/运行时实例化。用于 computer-use 这类进程内 MCP server 插件：
   * 其工具经 mcp-client 连接后才可用，CLI 只预登记元信息（/tools 可展示），不自动 register server。
   */
  metaOnly?: boolean
}

/** 内置通用插件注册表：`内置插件也要支持加载`的统一入口（与外部插件目录 loadPluginDirs 并列） */
export class BuiltinPluginRegistry {
  private readonly items = new Map<string, BuiltinGeneralPlugin>()

  register(p: BuiltinGeneralPlugin): void {
    this.items.set(p.id, p)
  }
  get(id: string): BuiltinGeneralPlugin | undefined {
    return this.items.get(id)
  }
  has(id: string): boolean {
    return this.items.has(id)
  }
  list(): BuiltinGeneralPlugin[] {
    return [...this.items.values()]
  }
}

let defaultBuiltinRegistry: BuiltinPluginRegistry | undefined

/** 惰性取某工具插件 /meta 模块的 toolMetaSource（多级加载 L1，纯数据、无副作用） */
function lazyToolMetaSource(specifier: string): () => Promise<ToolMetaSource> {
  return async () => (await lazyImport<{ toolMetaSource?: ToolMetaSource }>(specifier)).toolMetaSource!
}

/** 全局默认内置通用插件注册表（登记 tools-builtin 等随应用打包的插件，惰性加载） */
export function getBuiltinRegistry(): BuiltinPluginRegistry {
  if (!defaultBuiltinRegistry) {
    defaultBuiltinRegistry = new BuiltinPluginRegistry()
    defaultBuiltinRegistry.register({
      id: 'tools-builtin',
      name: 'Builtin Tools',
      description: '内置工作台工具（文件读写 + Shell）',
      source: 'builtin',
      load: async () => (await lazyImport<{ toolsBuiltinPlugin: AgentPlugin }>('@harness/tools-builtin')).toolsBuiltinPlugin,
      metaSource: lazyToolMetaSource('@harness/tools-builtin/meta'),
    })
    defaultBuiltinRegistry.register({
      id: 'tools-manager',
      name: 'Tools Manager',
      description: '工具管理命令 /tools（查看 / Agent 白名单持久化 / --global 运行时启停 / mcp__ 工具掩码）',
      source: 'builtin',
      load: async () => (await lazyImport<{ createToolsManagerPlugin: () => AgentPlugin }>('@harness/tools-manager')).createToolsManagerPlugin(),
    })
    defaultBuiltinRegistry.register({
      id: 'manage-plugin',
      name: 'Plugin Manager',
      description: '插件生命周期管理命令 /plugins（查看 / 启用 / 禁用 / 重载）',
      source: 'builtin',
      load: async () => (await lazyImport<{ createPluginManagerPlugin: () => AgentPlugin }>('@harness/manage-plugin')).createPluginManagerPlugin(),
    })
    // 场景化工具插件（search/glob/web/media，metaSource 由各插件自携带）：
    // 登记进 BuiltinPluginRegistry 后，boot 末尾的后台预加载（scheduleBuiltinPreload）
    // 就会真正预热这些运行时模块，使「后台加载」生效——不再停留在"仅元信息"。
    defaultBuiltinRegistry.register({
      id: 'tools-search',
      name: 'Search Tools',
      description: '搜索类工具插件：list_dir 目录列举 + grep_file 内容检索',
      source: 'builtin',
      load: async () => (await lazyImport<{ toolsSearchPlugin: AgentPlugin }>('@harness/tools-search')).toolsSearchPlugin,
      metaSource: lazyToolMetaSource('@harness/tools-search/meta'),
    })
    defaultBuiltinRegistry.register({
      id: 'tools-glob',
      name: 'Glob Tools',
      description: 'glob 文件匹配工具插件',
      source: 'builtin',
      load: async () => (await lazyImport<{ toolsGlobPlugin: AgentPlugin }>('@harness/tools-glob')).toolsGlobPlugin,
      metaSource: lazyToolMetaSource('@harness/tools-glob/meta'),
    })
    defaultBuiltinRegistry.register({
      id: 'tools-web',
      name: 'Web Tools',
      description: 'Web 抓取工具插件：web_fetch',
      source: 'builtin',
      load: async () => (await lazyImport<{ toolsWebPlugin: AgentPlugin }>('@harness/tools-web')).toolsWebPlugin,
      metaSource: lazyToolMetaSource('@harness/tools-web/meta'),
    })
    defaultBuiltinRegistry.register({
      id: 'tools-media',
      name: 'Media Tools',
      description: '媒体工具插件：view_image',
      source: 'builtin',
      load: async () => (await lazyImport<{ toolsMediaPlugin: AgentPlugin }>('@harness/tools-media')).toolsMediaPlugin,
      metaSource: lazyToolMetaSource('@harness/tools-media/meta'),
    })
    // code-intel：进程内 MCP server（mcp__code-intel__*），工具经 mcp-client 连接后才可用。
    // 仅携带 metaSource（/tools 可提前展示），metaOnly=true 使其不被后台预加载实例化——
    // 需经 .harness/plugins 或 ~/.harness/plugins 外部插件目录装配（createMcpServerRegistryPlugin + createCodeIntelPlugin）。
    defaultBuiltinRegistry.register({
      id: 'code-intel',
      name: 'Code Intel',
      description: '代码情报 MCP server 插件（mcp__code-intel__*）',
      source: 'builtin',
      metaOnly: true,
      load: async () => (await lazyImport<{ createCodeIntelPlugin: () => AgentPlugin }>('@harness/code-intel')).createCodeIntelPlugin(),
      metaSource: lazyToolMetaSource('@harness/code-intel/meta'),
    })
    // computer-use：进程内 MCP server，工具经 mcp-client 连接后才可用。仅携带 metaSource
    // （/tools 可提前展示 mcp__computer-use__* 元信息），metaOnly=true 使其不被后台预加载实例化。
    defaultBuiltinRegistry.register({
      id: 'computer-use',
      name: 'Computer Use',
      description: '电脑控制 MCP server 插件（mcp__computer-use__*）',
      source: 'builtin',
      metaOnly: true,
      load: async () => (await lazyImport<{ createComputerUsePlugin: () => AgentPlugin }>('@harness/computer-use')).createComputerUsePlugin(),
      metaSource: lazyToolMetaSource('@harness/computer-use/meta'),
    })
  }
  return defaultBuiltinRegistry
}

// ------------------------------------------------------------------------
// 2.2.2 内置工具静态元信息注册表 —— 多级加载 L1（描述可提前加载，运行时模块 L2 保持惰性/后台）
// ------------------------------------------------------------------------

/**
 * 内置工具静态元信息注册表（多级加载 L1）。
 *
 * 在 boot 早期同步登记全部内置工具的 meta（描述/别名/安全声明/权限键），
 * 无需加载对应的运行时工具模块（L2），即可供 REPL `/tools`、help 等展示。
 * 实现 `ToolMetaRegistry` 抽象契约（@harness/plugin），内部存储统一为 `ToolMetaEntry`；
 * 实现 `ToolMetaLookup`，注入 cli.command 输入供工具管理插件合并展示。
 */
export class BuiltinToolRegistry implements ToolMetaRegistry, ToolMetaLookup {
  private readonly byId = new Map<string, ToolMetaEntry>()

  register(m: ToolMetaEntry): void {
    this.byId.set(m.id, m)
  }
  registerAll(metas: ToolMetaEntry[]): void {
    for (const m of metas) this.register(m)
  }
  /** 登记一个 ToolMetaSource：合并其 list() 元信息（抽象契约统一入口） */
  registerSource(source: ToolMetaSource): void {
    this.registerAll(source.list())
  }
  has(id: string): boolean {
    return this.byId.has(id)
  }
  get(id: string): ToolMetaEntry | undefined {
    if (this.byId.has(id)) return this.byId.get(id)
    for (const m of this.byId.values()) {
      if (m.aliases?.includes(id)) return m
    }
    return undefined
  }
  list(): ToolMetaEntry[] {
    return [...this.byId.values()]
  }
  get size(): number {
    return this.byId.size
  }
}

let defaultToolMetaRegistry: BuiltinToolRegistry | undefined

/**
 * 全局默认内置工具元信息注册表（多级加载 L1）。注册表本体同步可访问；
 * 具体来源由各随应用打包工具插件自携带（BuiltinGeneralPlugin.metaSource），
 * 经 `preloadBuiltinToolMetas()` 异步登记。boot 早期 await 预载后，/tools 等命令
 * 在任何运行时模块（L2）加载前即可展示内置工具描述。
 */
export function getBuiltinToolRegistry(): BuiltinToolRegistry {
  if (!defaultToolMetaRegistry) defaultToolMetaRegistry = new BuiltinToolRegistry()
  return defaultToolMetaRegistry
}

/**
 * 预载全部随应用打包工具插件的静态元信息来源（L1）：
 * 遍历 `getBuiltinRegistry().list()`，对每个携带 `metaSource` 的插件 dynamic import 其 /meta 模块
 * （纯数据、无副作用）并登记到 `getBuiltinToolRegistry()`。plugin 自携带，CLI 不硬编码具体包导出。
 * 失败按插件隔离，不阻塞整体登记（避免单个 meta 模块异常影响 boot）。
 */
export async function preloadBuiltinToolMetas(): Promise<void> {
  const reg = getBuiltinToolRegistry()
  const items = getBuiltinRegistry().list().filter((p) => p.metaSource)
  await Promise.all(
    items.map(async (p) => {
      try {
        const source = await p.metaSource!()
        reg.registerSource(source)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[WARN] 内置插件「${p.id}」元信息来源预载失败：${(err as Error)?.message ?? String(err)}`)
      }
    }),
  )
}

/**
 * 惰性构造 Mock Provider 插件（默认 provider 兜底时使用；Mock 模块用时才加载）。
 */
async function lazyMockProvider(config?: MockProviderConfig): Promise<AgentPlugin & { provider: ChatProvider & { calls?: unknown[] } }> {
  const { createProviderMockPlugin } = await lazyImport<{ createProviderMockPlugin: (c?: MockProviderConfig) => AgentPlugin & { provider: ChatProvider & { calls?: unknown[] } } }>('@harness/provider-mock')
  return createProviderMockPlugin(config) as any
}

/**
 * 惰性构造 Anthropic Provider 插件（默认 provider=anthropic 且已配置 key 时使用；模块用时才加载）。
 */
async function lazyAnthropicProvider(config: unknown): Promise<AgentPlugin & { provider: ChatProvider & { calls?: unknown[] } }> {
  const { createProviderAnthropicPlugin } = await lazyImport<{ createProviderAnthropicPlugin: (c: unknown) => AgentPlugin & { provider: ChatProvider & { calls?: unknown[] } } }>('@harness/provider-anthropic')
  return createProviderAnthropicPlugin(config as any) as any
}

/** 插件目录加载结果：通用 AgentPlugin（Hooks 插件）列表；Provider 类型工厂已注册进 registry */
export interface PluginLoadResult {
  /** 从插件目录加载出的通用 AgentPlugin（非 Provider 专用，参与 Hooks 生命周期） */
  plugins: AgentPlugin[]
}

/** 探测一个值是否为合法的 AgentPlugin（id + install） */
const probeAgentPlugin = (o: unknown): AgentPlugin | null => {
  if (!o || typeof o !== 'object') return null
  const x = o as Record<string, unknown>
  if (typeof x['id'] === 'string' && typeof x['install'] === 'function') return x as unknown as AgentPlugin
  return null
}

/** 从模块导出中提取通用 AgentPlugin（default / plugin / plugins 三种形态，含一层 default 包装） */
function collectAgentPlugins(mod: Record<string, unknown>): AgentPlugin[] {
  const out: AgentPlugin[] = []
  const push = (o: unknown): void => {
    if (Array.isArray(o)) { for (const item of o) push(item); return }
    const p = probeAgentPlugin(o)
    if (p) out.push(p)
  }
  push(mod.default)
  push(mod.plugin)
  push(mod.plugins)
  // 兼容 default 里再包一层命名导出
  if (mod.default && typeof mod.default === 'object') {
    const d = mod.default as Record<string, unknown>
    push(d.plugin)
    push(d.plugins)
  }
  return out
}

/** 从模块导出中提取 Provider 类型工厂并注册（providerTypeFactory 或 providerType + createProviderPlugin） */
function registerProviderTypeFactory(
  registry: ProviderTypeRegistry,
  mod: Record<string, unknown>,
  full: string,
  out: (s: string) => void,
): void {
  // 该模块已导出通用 AgentPlugin → 是「通用插件」，无需因缺少 Provider 工厂而报警告
  if (collectAgentPlugins(mod).length > 0) return
  const defaultHolder = (mod.default && typeof mod.default === 'object' ? mod.default : {}) as Record<string, unknown>
  const holders = [mod, defaultHolder] as const
  for (const holder of holders) {
    const factory = holder.providerTypeFactory as
      | { type?: string; createPlugin?: (config: ProviderConfig) => AgentPlugin | undefined }
      | undefined
    if (factory && typeof factory.type === 'string' && typeof factory.createPlugin === 'function') {
      registry.register({ type: factory.type, createPlugin: factory.createPlugin })
      return
    }
    const type = holder.providerType as string | undefined
    const createPlugin = holder.createProviderPlugin as ((config: ProviderConfig) => AgentPlugin | undefined) | undefined
    if (typeof type === 'string' && typeof createPlugin === 'function') {
      registry.register({ type, createPlugin })
      return
    }
  }
  out(`插件模块既未导出通用 AgentPlugin 也未导出有效 Provider 类型工厂，已忽略：${full}`)
}

/**
 * 从多级目录加载外部插件（user → project，后加载覆盖先加载）。
 * 插件目录统一为 plugins，一个 .ts/.js/.mjs 模块可同时导出多种插件：
 *   1. 通用 AgentPlugin（Hooks 插件）：default / plugin / plugins
 *   2. Provider 类型工厂（扩展 config.type）：providerTypeFactory 或 providerType + createProviderPlugin
 * 通用插件汇总返回；Provider 类型工厂按 type 注册进 registry（供 config.type 动态解析）。
 */
export async function loadPluginDirs(
  registry: ProviderTypeRegistry,
  dirs: Array<string | { dir: string; source?: 'user' | 'project' }>,
  log?: (s: string) => void,
): Promise<PluginLoadResult> {
  const out = log ?? ((s: string) => { if (typeof process !== 'undefined') process.stderr.write(s + '\n') })
  // 枚举交给通用多级目录加载器（workspace 收敛「scan + 来源标注」），来源顺序 user → project
  const items = new MultiDirLoader(normalizeDirs(dirs)).scan({ name: (n) => /\.(ts|js|mjs)$/.test(n) })
  // 通用插件按 id 去重：后加载覆盖先加载（project 覆盖 user，扫描顺序即覆盖顺序）
  const byId = new Map<string, AgentPlugin>()
  for (const item of items) {
    const full = item.full
    try {
      const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>
      // 1) 通用 AgentPlugin
      for (const p of collectAgentPlugins(mod)) byId.set(p.id, p)
      // 2) Provider 类型工厂
      registerProviderTypeFactory(registry, mod, full, out)
    } catch (err) {
      out(`插件加载失败 ${full}：${(err as Error)?.message ?? String(err)}`)
    }
  }
  return { plugins: [...byId.values()] }
}

// ------------------------------------------------------------------------
// 2.3 密钥加密存储 + 配置校验（多 Provider 健壮性）
// ------------------------------------------------------------------------

/** providers 配置校验问题（index=-1 表示非数组内问题，如默认 provider 未定义） */
export interface ProviderConfigIssue {
  index: number
  message: string
}

/**
 * 校验 providers 数组与默认 provider（已知类型由 ProviderTypeRegistry 动态提供，插件化）：
 * - id 缺失 / 重复 → 报错（避免静默覆盖注册）
 * - type 未知 → 报错（列出已注册类型）
 * - 默认 provider 指向未定义的 id（非内置 mock/anthropic）→ 报错
 */
export function validateProviderConfigs(
  providers: ProviderConfig[],
  defaultProviderId: string,
  knownTypes: Iterable<string>,
): ProviderConfigIssue[] {
  const issues: ProviderConfigIssue[] = []
  const seen = new Set<string>()
  const known = new Set(knownTypes)
  const knownTypesText = [...known].join(' / ') || '（无已注册类型）'
  providers.forEach((pc, i) => {
    if (!pc.id?.trim()) {
      issues.push({ index: i, message: `providers[${i}] 缺少 id（必须唯一）` })
      return
    }
    if (seen.has(pc.id)) {
      issues.push({ index: i, message: `providers[${i}].id "${pc.id}" 与前面的 provider 重复（id 必须唯一，否则后注册的会被覆盖）` })
    }
    seen.add(pc.id)
    if (!pc.type || !known.has(pc.type)) {
      issues.push({ index: i, message: `providers[${i}].type "${pc.type}" 未知（已注册类型：${knownTypesText}；可在 ~/.harness/plugins 或 .harness/plugins 中添加导出 providerTypeFactory 的插件扩展）` })
    }
  })
  if (defaultProviderId && defaultProviderId !== 'mock' && defaultProviderId !== 'anthropic' && !seen.has(defaultProviderId)) {
    issues.push({ index: -1, message: `默认 provider "${defaultProviderId}" 未在 providers 数组中定义（已注册类型：${knownTypesText}）` })
  }
  return issues
}

/** 配置概览（--check-config / /config 共用），maskKey 为 true 时隐藏明文 apiKey */
export function buildConfigOverview(cfg: HarnessConfig, defaultProviderId: string, maskKey = true): string {
  const lines: string[] = []
  lines.push(`默认 provider：${cfg.provider ?? defaultProviderId}`)
  if (cfg.model) lines.push(`默认 model：${cfg.model}`)
  const providers = cfg.providers ?? []
  if (!providers.length) {
    lines.push('providers：（未配置，使用内置 mock / anthropic）')
    return lines.join('\n')
  }
  lines.push('providers：')
  for (const pc of providers) {
    const api = pc.apiKey
      ? pc.apiKey.startsWith('enc:v1:')
        ? '已加密'
        : /^\$\{.*\}$/.test(pc.apiKey.trim())
          ? `env(${pc.apiKey.trim().slice(2, -1)})`
          : maskKey
            ? '已配置'
            : pc.apiKey
      : '（未配置）'
    const isDefault = pc.id === (cfg.provider ?? defaultProviderId) ? ' ← 默认' : ''
    const path = [pc.type, pc.baseUrl ?? '（默认端点）', pc.apiPath ?? ''].filter(Boolean).join(' · ')
    lines.push(`  - ${pc.id}${isDefault}  type=${path}  model=${pc.model ?? '（Provider 默认）'}  apiKey=${api}`)
  }
  return lines.join('\n')
}

/**
 * 生成"可用的 Provider 类型"清单（从 ProviderTypeRegistry 展示元信息构建）。
 * 关键：只读 registry.listMeta()，不触发任何 Provider 模块加载；因此即使插件未完全加载
 * （惰性描述符已登记），help / config check 也能列出并给人机交互友好的用法提示。
 */
export function formatProviderTypeList(registry: ProviderTypeRegistry, includeUsage = true): string {
  const metas = registry.listMeta()
  if (!metas.length) return '（无已注册 Provider 类型）'
  const width = Math.max(...metas.map((m) => m.type.length), 1)
  return metas
    .map((m) => {
      const label = m.type.padEnd(width)
      const tag = m.builtin ? '[内置]' : '[插件]'
      const key = m.requiresApiKey ? '（需 apiKey）' : ''
      const model = m.defaultModel ? `默认模型 ${m.defaultModel}` : '默认模型未指定'
      let line = `  ${label}  ${tag} ${m.description ?? m.type}${key}，${model}`
      if (includeUsage && m.usage) line += `，例 ${m.usage}`
      return line
    })
    .join('\n')
}

/** help / config check 结束时追加"可用的 Provider 类型"段落（含用法提示，不加载 Provider 模块） */
export function buildProviderTypesSection(registry: ProviderTypeRegistry): string {
  return `可用的 Provider 类型（未完全加载即可展示；调用对应 provider 时自动加载模块）：
${formatProviderTypeList(registry)}
  更多类型：在 ~/.harness/plugins 或 <project>/.harness/plugins 中用插件导出 providerTypeFactory 扩展；运行 \`harness config check\` 查看含插件的完整清单。
`
}

/** 规则持久化（dataDir/permissions.json） */
export interface PermissionStoreFile {
  rules: Record<string, unknown> // 对应 PermissionRuleset
}

export class CliPermissionEngine extends DefaultPermissionEngine {
  constructor(
    rules: Record<string, unknown> = { '*': 'ask' },
    private readonly options: {
      store?: PermissionStoreFile & { save?: (r: Record<string, unknown>) => Promise<void> }
      mode?: 'allow-all' | 'ask' | 'deny-all'
      /** 测试注入：替换真实 readline 交互 */
      askPrompt?: (question: string) => Promise<string>
      stdout?: NodeJS.WritableStream | { write: (s: string) => void }
    } = {}
  ) {
    super(rules as any)
  }

  private write(s: string) {
    ;(this.options.stdout ?? process.stdout).write(s)
  }

  /** 当前交互模式（allow-all / ask / deny-all），供 /permission 查看与切换 */
  getMode(): 'allow-all' | 'ask' | 'deny-all' {
    return this.options.mode ?? 'ask'
  }
  /** 切换交互模式（不影响持久化规则，仅影响「询问型请求」的自动答复） */
  setMode(mode: 'allow-all' | 'ask' | 'deny-all'): void {
    this.options.mode = mode
  }
  /** 替换询问交互器（TUI 在启动后注入模态审批，替代默认 readline 行内提问） */
  setAskPrompt(fn?: (question: string) => Promise<string>): void {
    this.options.askPrompt = fn
  }

  /** CLI 级 ask：默认 mode=allow-all 直接 allow；mode=ask 则 prompt 用户 */
  override async ask(req: any): Promise<PermissionDecision> {
    if (this.options.mode === 'allow-all') return { behavior: 'allow', matchedRule: 'global' }
    if (this.options.mode === 'deny-all') return { behavior: 'deny', matchedRule: 'global' }
    const promptFn = this.options.askPrompt ?? defaultCliAsk(this.write)
    const pat = (req.patterns ?? []).slice(0, 3).join(', ') || '(无路径)'
    const q = `\n⚠️  权限请求 [${req.toolKey}] ${pat}\n` +
      `  操作: allow / deny / always(a) / deny-always(d)? [a/d/A/D] `
    const answer = ((await promptFn(q)) ?? '').trim()
    const low = answer.toLowerCase()
    // 先判断"永久"：answer 保留大小写（A/D 直接表示永久），否则"always"/"never"语义
    const permanentAllow = low === 'always' || low === 'all' || answer === 'A'
    const permanentDeny = low === 'never' || low === 'none' || answer === 'D'
    if (permanentAllow) {
      const current = this.getRules()
      const updated = { ...current, [req.toolKey]: 'allow' }
      this.updateRules(updated)
      await this.options.store?.save?.(updated)
      return { behavior: 'allow', matchedRule: 'tool', remember: true }
    }
    if (permanentDeny) {
      const current = this.getRules()
      const updated = { ...current, [req.toolKey]: 'deny' }
      this.updateRules(updated)
      await this.options.store?.save?.(updated)
      return { behavior: 'deny', matchedRule: 'tool', remember: true }
    }
    // 单次
    if (['y', 'yes', 'a', 'allow'].includes(low)) return { behavior: 'allow', matchedRule: 'tool' }
    if (['n', 'no', 'd', 'deny'].includes(low)) return { behavior: 'deny', matchedRule: 'tool' }
    return { behavior: 'deny', matchedRule: 'global' }
  }
}

/** 默认 CLI 读行（process.stdin/readline） */
function defaultCliAsk(write: (s: string) => void): (q: string) => Promise<string> {
  return (q: string) => new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(q, (ans) => { rl.close(); resolve(ans) })
  })
}

// ========================================================================
// 4. HarnessApp：CLI 级的 Harness 封装（会话持久化、权限存储、插件装配）
// ========================================================================

export interface HarnessAppOptions {
  cwd: string
  dataDir: string
  agentId: string
  provider: string
  /** 默认模型 ID（如 claude-3-5-sonnet，或 provider/model 跨 Provider 指定），设置到默认 Agent 的 model */
  model?: string
  sessionId?: string
  permissionMode?: 'allow-all' | 'ask' | 'deny-all'
  /** 测试注入 */
  mockProviderConfig?: MockProviderConfig
  anthropicProviderConfig?: any
  /** 多 Provider 定义（来自 config.json 的 providers；boot 时逐项安装，支持运行时跨 Provider 切换） */
  providers?: ProviderConfig[]
  askPrompt?: (q: string) => Promise<string>
  stdout?: NodeJS.WritableStream | { write: (s: string) => void }
  verbose?: boolean
  /** 额外要注册的 Agent 列表 */
  agents?: AgentDefinition[]
  /** 额外 internalPlugins */
  extraPlugins?: AgentPlugin[]
  /**
   * 启用文件快照 + /revert 命令（默认 false）。
   * 开启后：createHarness 注入 @harness/snapshot 工厂（每轮 query 自动 capture
   * 并挂载 meta.snapshot），REPL 提供 /revert stage|clear|commit|status。
   */
  snapshot?: boolean
  /** 是否启用 boot 末尾的后台静默预加载内置插件/工具（多级加载 L2，默认 true）。设为 false 关闭。 */
  backgroundPreload?: boolean
}

export class HarnessApp {
  /** 工作区布局（两级目录 + 数据文件路径），由 cwd/dataDir 解析而得 */
  public readonly workspace: Workspace
  public readonly sessionStore: SessionFileStore
  public readonly permissionStorePath: string
  /** 全局配置读写（config.json：model / provider / apiKey 持久化） */
  public readonly configStore: ConfigStore<HarnessConfig>
  /** Provider 类型注册表（内置 + 外部 plugins 插件注册的工厂；config.type 据此动态解析） */
  public readonly providerTypes: ProviderTypeRegistry
  /** 文件快照服务（options.snapshot 开启时创建，供 createHarness 注入与 /revert 命令） */
  public readonly snapshotService: SnapshotService | undefined
  /** 权限引擎（boot 时构建）。/permission 命令据此查看/切换交互模式与规则 */
  public permission!: CliPermissionEngine
  /** 插件管理：boot 时登记的「可管理」插件对象（pluginId → AgentPlugin），供 /plugins enable 重新安装 */
  readonly pluginRegistry = new Map<string, AgentPlugin>()
  private harness!: Harness
  private options: Required<Pick<HarnessAppOptions, 'cwd' | 'dataDir' | 'agentId' | 'provider'>> & HarnessAppOptions
  /** boot() 装载的 Provider 配置（CLI options.providers 优先，其次 config.json providers），供 /model ? 展示 */
  private loadedProviders: ProviderConfig[] = []

  constructor(options: HarnessAppOptions) {
    const cwd = resolve(options.cwd)
    this.options = { ...options, cwd, dataDir: resolve(options.dataDir), agentId: options.agentId, provider: options.provider }
    this.workspace = resolveWorkspace({ cwd, dataDir: this.options.dataDir })
    this.sessionStore = new SessionFileStore(this.workspace)
    this.permissionStorePath = this.workspace.files.permissions
    this.configStore = new ConfigStore<HarnessConfig>(this.workspace)
    // Provider 类型注册表：注册内置类型（openai/anthropic/gemini/glm/qwen/mock），
    // boot() 时再加载外部 plugins 插件注册的自定义 type
    this.providerTypes = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(this.providerTypes)
    if (options.snapshot) {
      this.snapshotService = createSnapshotService({ worktree: cwd })
    }
  }

  /** 加载权限文件 */
  private async loadRules(): Promise<Record<string, unknown>> {
    if (existsSync(this.permissionStorePath)) {
      try {
        const s = JSON.parse(await readFile(this.permissionStorePath, 'utf-8')) as PermissionStoreFile
        return s.rules ?? { '*': 'ask' }
      } catch { return { '*': 'ask' } }
    }
    return { '*': 'ask' }
  }
  private async saveRules(rules: Record<string, unknown>): Promise<void> {
    await mkdir(this.workspace.dataDir, { recursive: true })
    await writeFile(this.permissionStorePath, JSON.stringify({ rules }, null, 2))
  }
  /** 更新权限引擎规则并落盘（/permission 使用） */
  async setPermissionRules(rules: Record<string, unknown>): Promise<void> {
    this.permission.updateRules(rules as any)
    await this.saveRules(rules)
  }

  /** 默认 Agent 定义（无 agent 指定时使用）；含 CLI/config 解析出的默认模型 */
  defaultAgent(): AgentDefinition {
    const def: AgentDefinition = {
      id: this.options.agentId,
      name: 'Harness Agent',
      description: 'CLI 默认 Agent',
      mode: 'primary',
      tools: ['*'],
      permission: { '*': 'ask' },
      promptFragments: [
        'You are Harness Agent, a helpful assistant with access to tools (file system, shell).',
        'Be concise and precise.',
      ],
    }
    if (this.options.model) {
      const spec = parseModelSpec(this.options.model)
      def.model = { providerId: spec.providerId, modelId: spec.modelId }
    }
    return def
  }

  /**
   * 合并 config.json 的 agents[].tools 到已注册 Agent 定义（按 id 覆盖 tools 白名单）。
   * 必须放在 createHarness 之后、query 之前：工具池在 query 时经 filterByWhitelist(agent.tools)
   * 实时读白名单，因此覆盖任何来源（default / options.agents / agentDirs 的 md）的同名 Agent。
   */
  async applyConfigAgentOverrides(harness: Harness): Promise<void> {
    const cfg = await this.configStore.load()
    if (!cfg.agents?.length) return
    for (const { id, tools, mcpServers, excludeMcpServers } of cfg.agents) {
      if (!tools?.length && !mcpServers && !excludeMcpServers) continue
      const existing = harness.agent.get(id)
      if (!existing) continue
      const merged: AgentDefinition = { ...existing }
      if (tools) merged.tools = [...tools]
      if (mcpServers) merged.mcpServers = [...mcpServers]
      if (excludeMcpServers) merged.excludeMcpServers = [...excludeMcpServers]
      harness.agent.register(merged)
    }
  }

  /**
   * 持久化某 Agent 的 tools 白名单到 config.json（upsert agents[].tools）并即时应用到运行时。
   * 供 /tools 等插件调用：写入端 + 内存覆盖一次完成，重启后由 applyConfigAgentOverrides 回读生效。
   * 保留已有 entry 的 mcpServers/excludeMcpServers 声明，避免 /tools 触发时静默丢弃。
   */
  async setAgentTools(agentId: string, tools: string[]): Promise<void> {
    const cfg = await this.configStore.load()
    const agents = [...(cfg.agents ?? [])]
    const idx = agents.findIndex((a) => a.id === agentId)
    const prev = idx >= 0 ? agents[idx] : undefined
    const entry: { id: string; tools: string[]; mcpServers?: string[]; excludeMcpServers?: string[] } = {
      id: agentId,
      tools: [...tools],
      ...(prev?.mcpServers ? { mcpServers: [...prev.mcpServers] } : {}),
      ...(prev?.excludeMcpServers ? { excludeMcpServers: [...prev.excludeMcpServers] } : {}),
    }
    if (idx >= 0) agents[idx] = entry
    else agents.push(entry)
    await this.configStore.save({ ...cfg, agents })
    // 即时覆盖运行时同名 Agent（query 时实时 filterByWhitelist(agent.tools)）
    const existing = this.harness?.agent?.get?.(agentId)
    if (existing) this.harness!.agent.register({ ...existing, tools: [...tools] })
  }

  /** 读取 config.json 的 mcpServers 列表（缺省 []） */
  async getMcpServers(): Promise<McpServerEntry[]> {
    const cfg = await this.configStore.load()
    return [...(cfg.mcpServers ?? [])]
  }

  /**
   * 持久化 mcpServers 列表到 config.json（upsert 顶层 mcpServers）。供 mcp-server-registry 的
   * /mcp 命令在启用/禁用/增删后写回；重启后由 boot 阶段经 mcp.configure 重新注入生效。
   */
  async setMcpServers(list: McpServerEntry[]): Promise<void> {
    const cfg = await this.configStore.load()
    await this.configStore.save({ ...cfg, mcpServers: [...list] })
  }

  /**
   * 把 config.json 的 mcpServers 应用到运行时：createHarness 后、harness.start 前触发
   * mcp.configure Hook，注入 mcp-server-registry 插件（按 enabled 开关在 start 时连接）。
   */
  async applyMcpServers(harness: Harness): Promise<void> {
    const cfg = await this.configStore.load()
    const list = [...(cfg.mcpServers ?? [])]
    await (harness.plugin as any)?.trigger?.('mcp.configure', { mcpServers: list })
  }

  /** 当前生效模型（`provider/model` 展示）：优先读取活动 Agent 定义的 model，回退 options.model */
  getModel(agentId: string): string | undefined {
    const a = this.harness?.agent?.get?.(agentId)
    if (a?.model?.modelId) return formatModel(a.model.providerId, a.model.modelId)
    return this.options.model
  }

  /**
   * 运行时切换模型：接受 `[provider/]modelId` 规格（如 `openai/gpt-4o` 跨 Provider 切换），
   * 更新指定 Agent 的 model 并持久化到 config.json（provider + model）作为下次启动默认。
   */
  async setModel(agentId: string, spec: string): Promise<boolean> {
    const a = this.harness?.agent?.get?.(agentId)
    if (!a) return false
    const parsed = parseModelSpec(spec.trim())
    a.model = {
      ...(a.model ?? {}),
      ...(parsed.providerId ? { providerId: parsed.providerId } : {}),
      modelId: parsed.modelId,
    }
    // 持久化：provider 前缀命中则更新默认 provider；model 仅存 modelId（前缀在 /model 已显式跨 Provider 时由 provider 字段接管）
    const cfg = await this.configStore.load()
    const provider = parsed.providerId ?? this.options.provider ?? cfg.provider ?? a.model?.providerId
    await this.configStore.save({ ...cfg, provider, model: parsed.modelId })
    return true
  }

  // ------------------------------------------------------------------
  // 技能管理（/skills）
  // ------------------------------------------------------------------

  /** 技能信息（供 /skills 展示，来源中文标注） */
  skillInfos(): Array<{ id: string; name: string; source: string; sourceLabel: string; enabled: boolean }> {
    const mgr = this.harness?.skillManager
    if (!mgr) return []
    return mgr.all().map((s) => ({
      id: s.id,
      name: s.name,
      source: s.loadedFrom,
      sourceLabel: formatSkillSource(s.loadedFrom),
      enabled: true,
    }))
  }

  /** 禁用技能 */
  async disableSkill(id: string): Promise<{ ok: boolean; message: string }> {
    const mgr = this.harness?.skillManager
    if (!mgr) return { ok: false, message: '技能系统未启用。' }
    if (!mgr.get(id)) return { ok: false, message: `技能 "${id}" 不存在。` }
    const ok = mgr.disable(id)
    return ok
      ? { ok: true, message: `已禁用技能 "${id}"（可在 /skills enable ${id} 恢复）。` }
      : { ok: false, message: `技能 "${id}" 已是禁用状态。` }
  }

  /** 启用技能 */
  async enableSkill(id: string): Promise<{ ok: boolean; message: string }> {
    const mgr = this.harness?.skillManager
    if (!mgr) return { ok: false, message: '技能系统未启用。' }
    if (mgr.get(id)) return { ok: false, message: `技能 "${id}" 已是启用状态。` }
    const s = await mgr.enable(id)
    return s
      ? { ok: true, message: `已启用技能 "${id}"（来源：${formatSkillSource(s.loadedFrom)}）。` }
      : { ok: false, message: `技能 "${id}" 不存在且无可恢复来源。` }
  }

  /** 重载技能 */
  async reloadSkill(id: string): Promise<{ ok: boolean; message: string }> {
    const mgr = this.harness?.skillManager
    if (!mgr) return { ok: false, message: '技能系统未启用。' }
    const s = await mgr.reload(id)
    return s
      ? { ok: true, message: `已重载技能 "${id}"（来源：${formatSkillSource(s.loadedFrom)}）。` }
      : { ok: false, message: `技能 "${id}" 不存在。` }
  }

  /**
   * 根据一条 ProviderConfig 构造对应 Provider 插件。
   * 通过 ProviderTypeRegistry 按 config.type 动态解析（内置类型 + 外部 plugins 插件注册的工厂），
   * 不再硬编码 switch —— 新增 Provider 类型无需改 CLI 代码。
   * type=openai 支持任意 OpenAI 兼容端点（DeepSeek / Ollama / GLM/Qwen 兼容 API）。
   */
  private async buildProviderPlugin(pc: ProviderConfig): Promise<AgentPlugin | undefined> {
    return this.providerTypes.resolve(pc.type)?.createPlugin(pc)
  }

  /**
   * 列出当前可切换的 Provider 候选（供 /model ? / /config ?）：config.providers 的实例 id +
   * 默认 provider + 注册表里已注册的 Provider 类型（含插件扩展的自定义 type）。
   * 后两者不依赖该 type 是否已在 config 定义实例，因此插件注册的 type 也能在 /model 中展示与校验。
   */
  listProviders(): string[] {
    const ids: string[] = []
    // config 里显式定义的 Provider 实例 id 优先
    for (const pc of this.options.providers ?? []) if (!ids.includes(pc.id)) ids.push(pc.id)
    // 默认 provider（mock/anthropic 或自定义）放最前
    const def = this.options.provider ?? 'anthropic'
    if (!ids.includes(def)) ids.unshift(def)
    // 合并注册表里已注册的 Provider 类型（内置 + 外部插件自定义 type，来自 providerTypes）
    for (const t of this.providerTypes.list()) if (!ids.includes(t)) ids.push(t)
    return ids
  }

  /** 启动装载的 Provider 实例配置（含各自默认/附加模型），供 /model ? 展示 config.json / CLI 配置的模型 */
  listConfiguredProviders(): Array<{ id: string; model?: string; baseUrl?: string; apiPath?: string; type?: string }> {
    return this.loadedProviders.map((p) => ({ id: p.id, model: p.model, baseUrl: p.baseUrl, apiPath: p.apiPath, type: p.type }))
  }

  /** 装配并启动 Harness，返回已 start 的实例；加载/恢复 session */
  async boot(): Promise<{ harness: Harness; session: Session }> {
    // 多级加载 L1：预载内置工具静态元信息（描述/别名/安全），由各工具插件自携带 metaSource，
    // 保证后续 /tools 等命令在任何运行时工具模块（L2）加载前即可展示内置工具描述。
    await preloadBuiltinToolMetas()

    const rules = await this.loadRules()
    const mode = this.options.permissionMode ?? 'ask'
    const perm = new CliPermissionEngine(rules, {
      mode,
      askPrompt: this.options.askPrompt,
      stdout: this.options.stdout,
      store: {
        ...(rules as any),
        save: (r) => this.saveRules(r),
      },
    })
    this.permission = perm

    // ------------------------------------------------------------------
    // Provider 装配：支持多 Provider 自由切换
    // 1) 优先安装 config.providers 里显式定义的多 Provider（按顺序注册到注册表，供跨 Provider 分发）
    // 2) 默认 Provider 最后注册 —— 作为无 provider 前缀模型的兜底（也是运行时 /model 落盘的默认 provider）
    // ------------------------------------------------------------------
    const cfg = await this.configStore.load()
    const rawProviderConfigs = this.options.providers?.length ? this.options.providers : (cfg.providers ?? [])
    this.loadedProviders = rawProviderConfigs
    const defaultProviderId = this.options.provider ?? cfg.provider ?? 'anthropic'

    // 加载外部插件（user ~/.harness/plugins → project .harness/plugins，后加载覆盖先加载）：
    // 通用 AgentPlugin 汇总到 externalPlugins 参与 Hooks 生命周期；Provider 类型工厂注册进 providerTypes 供 config.type 动态解析
    // 路径统一来自解析好的 workspace（dataDir 支持 --data-dir 覆盖，非写死 $HOME）
    const externalPlugins = await loadPluginDirs(this.providerTypes, [
      { dir: this.workspace.user.plugins, source: 'user' },
      { dir: this.workspace.project.plugins, source: 'project' },
    ], (s) => this.options.stdout?.write?.(s + '\n'))

    // 显式校验 + 密钥解析（错误一次性汇总，避免静默跳过/误导）
    const cipher = new SecretCipher(this.workspace)
    const configIssues: string[] = []
    const providerConfigs: ProviderConfig[] = []
    for (const pc of rawProviderConfigs) {
      try {
        providerConfigs.push({ ...pc, apiKey: await resolveSecret(pc.apiKey, cipher) })
      } catch (err: any) {
        configIssues.push(`providers[${rawProviderConfigs.indexOf(pc)}]（id=${pc.id ?? '?'}）：${err?.message ?? String(err)}`)
      }
    }
    for (const iss of validateProviderConfigs(rawProviderConfigs, defaultProviderId, this.providerTypes.list())) {
      configIssues.push(iss.message)
    }
    if (configIssues.length) {
      this.options.stdout?.write?.('配置错误（config.json → providers）：\n' + configIssues.map((s) => `  - ${s}`).join('\n') + '\n')
      throw new ConfigValidationError(configIssues.join('；'))
    }

    // 默认 Provider 若是命名 Provider（非 mock/anthropic），从配置中找到它（避免重复注册，放到最后作默认）
    const isCustomDefault = defaultProviderId !== 'mock' && defaultProviderId !== 'anthropic'
    const defaultPc = isCustomDefault
      ? providerConfigs.find((p) => p.id === defaultProviderId)
      : undefined

    const providerPlugins: AgentPlugin[] = []
    let chosenProvider: AgentPlugin & { provider: ChatProvider & { calls?: unknown[] } }

    // 1) 其他（非默认）Provider
    const builtIds = new Set<string>()
    const pushBuilt = (plugin: AgentPlugin | undefined, id: string) => {
      if (!plugin || builtIds.has(id)) return
      builtIds.add(id)
      providerPlugins.push(plugin)
    }
    for (const pc of providerConfigs) {
      if (defaultPc && pc.id === defaultPc.id) continue // 默认放到最后
      pushBuilt(await this.buildProviderPlugin(pc), pc.id)
    }

    // 2) 默认 Provider（最后注册 → 作为无前缀模型的兜底）
    if (defaultPc) {
      // 默认 Provider 的默认模型优先取 --model / config.model 指定的模型（去 provider 前缀）
      const defaultModel = parseModelSpec(this.options.model ?? '').modelId || defaultPc.model
      const plugin = await this.buildProviderPlugin({ ...defaultPc, model: defaultModel })
      if (!plugin) {
        this.options.stdout?.write?.(`⚠️  未能构造默认 Provider "${defaultProviderId}"（未知 type）。\n\n`)
        chosenProvider = await lazyMockProvider({
          defaultResponse: '(Mock Provider) 你好，我是测试助手。',
          ...(this.options.mockProviderConfig ?? {}),
        })
      } else {
        chosenProvider = plugin as any
      }
    } else if (defaultProviderId === 'mock') {
      chosenProvider = await lazyMockProvider({
        defaultResponse: '(Mock Provider) 你好，我是测试助手。',
        ...(this.options.mockProviderConfig ?? {}),
      })
    } else {
      // anthropic（或无 key 时 fallback mock）
      const envKey = typeof process !== 'undefined' ? process.env.ANTHROPIC_API_KEY : undefined
      let mergedApiKey = this.options.anthropicProviderConfig?.apiKey ?? cfg.anthropicApiKey ?? envKey
      try {
        mergedApiKey = await resolveSecret(mergedApiKey, cipher)
      } catch (err: any) {
        this.options.stdout?.write?.(`配置错误：${err?.message ?? String(err)}\n`)
        throw new ConfigValidationError(err?.message ?? String(err))
      }
      const mergedAnthropic = {
        ...(this.options.anthropicProviderConfig ?? {}),
        apiKey: mergedApiKey,
        defaultModel: this.options.anthropicProviderConfig?.defaultModel ?? (parseModelSpec(this.options.model ?? '').modelId || undefined),
      }
      const hasKey = !!mergedAnthropic.apiKey
      if (hasKey && (defaultProviderId === 'anthropic' || this.options.provider === undefined)) {
        chosenProvider = await lazyAnthropicProvider(mergedAnthropic)
      } else if (hasKey && defaultProviderId !== 'anthropic') {
        // 默认 provider 是自定义 id 但未在 providers 中配置 → 提示并 fallback mock
        this.options.stdout?.write?.(
          `ℹ️  未在 config.json → providers 中找到默认 Provider "${defaultProviderId}"，` +
          `自动 fallback 到 Mock Provider。\n` +
          `   可在 <data-dir>/config.json 的 providers 数组中定义它（type=openai/anthropic/gemini）。\n\n`
        )
        chosenProvider = await lazyMockProvider({
          defaultResponse: '(Mock Provider) 你好，我是测试助手。',
          ...(this.options.mockProviderConfig ?? {}),
        })
      } else {
        this.options.stdout?.write?.(
          'ℹ️  未配置 ANTHROPIC_API_KEY，自动 fallback 到 Mock Provider。\n' +
          '   如要使用真实 Claude，请 export ANTHROPIC_API_KEY=xxx。\n\n'
        )
        chosenProvider = await lazyMockProvider({
          defaultResponse: '(Mock Provider) 你好，我是测试助手。',
          ...(this.options.mockProviderConfig ?? {}),
        })
      }
    }
    providerPlugins.push(chosenProvider)
    // 内置（随应用打包）通用插件：经 BuiltinPluginRegistry 统一惰性加载
    const toolsBuiltin = await getBuiltinRegistry().get('tools-builtin')!.load()
    providerPlugins.push(toolsBuiltin)
    const toolsManager = await getBuiltinRegistry().get('tools-manager')!.load()
    providerPlugins.push(toolsManager)
    const managePlugin = await getBuiltinRegistry().get('manage-plugin')!.load()
    providerPlugins.push(managePlugin)
    // 薄壳插件：/workspace 查看工作区布局（依赖 cli 注入的 workspace，见 cmdInput.workspace）
    providerPlugins.push(createWorkspacePlugin())
    // 薄壳插件：/revert 文件快照回滚（依赖 cli 注入的 snapshotService 与 harness.session/bus，见 cmdInput）
    providerPlugins.push(createRevertPlugin())
    // 薄壳插件：/snapshot 快照信息命令（依赖 cli 注入的 snapshotService，见 cmdInput）
    providerPlugins.push(createSnapshotPlugin())
    // 其余能力一律通过外部插件目录（~/.harness/plugins、.harness/plugins）可插拔加载，
    // CLI 不做硬编码依赖（避免依赖倒置）：此处 externalPlugins 来自 loadPluginDirs（user → project）。
    if (externalPlugins.plugins.length) providerPlugins.push(...externalPlugins.plugins)
    if (this.options.extraPlugins?.length) providerPlugins.push(...this.options.extraPlugins)

    // 登记「可管理」插件（/plugins enable 需要对象引用重新安装）：
    // 排除 core 内置工具插件（toolsBuiltin）与后续由 core 内部注册的 core.*（skill-injection 等），
    // 仅管理用户装配的 Provider / 插件目录 / extraPlugins。
    this.pluginRegistry.clear()
    for (const p of providerPlugins) {
      if (p.id === toolsBuiltin.id) continue
      this.pluginRegistry.set(p.id, p)
    }

    // 创建 Harness
    const harness = await createHarness({
      cwd: this.options.cwd,
      defaultAgentId: this.options.agentId,
      internalPlugins: providerPlugins,
      agents: [this.defaultAgent(), ...(this.options.agents ?? [])],
      // Agent 多级加载：user 全局目录在前，project 项目目录在后（后者覆盖前者）
      agentDirs: [
        { dir: this.workspace.user.agents, source: 'user' },
        this.workspace.project.agents,
      ],
      // Skill 多级加载：user 全局目录在前，project 项目目录在后（后者覆盖前者）
      skillDirs: [
        { dir: this.workspace.user.skills, source: 'user' },
        this.workspace.project.skills,
      ],
      permission: perm,
      snapshot: this.snapshotService ? () => this.snapshotService! : undefined,
      logger: {
        info: (msg, meta) => this.options.verbose
          ? this.options.stdout?.write?.(`[INFO] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`)
          : undefined,
        warn: (msg, meta) => this.options.stdout?.write?.(`[WARN] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`),
        error: (msg, meta) => this.options.stdout?.write?.(`[ERROR] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`),
        debug: (msg, meta) => this.options.verbose
          ? this.options.stdout?.write?.(`[DEBUG] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`)
          : undefined,
      },
    })
    // 回读 config.json 的 agents[] 覆盖（tools 白名单 + mcpServers/excludeMcpServers）到已注册 Agent（createHarness 全部组装完成后、query 前）
    await this.applyConfigAgentOverrides(harness)
    // 把 config.json 的 mcpServers 注入 mcp-server-registry 插件（在 start 前建立配置态，
    // 由 harness.start 按 enabled 开关连接外部 MCP server）。
    await this.applyMcpServers(harness)
    await harness.start()
    this.harness = harness

    // 多级加载 L2：boot 末尾后台静默预加载内置插件/工具（fire-and-forget，
    // allSettled，失败仅记录日志，不阻塞 boot、不向上抛错）。
    this.scheduleBuiltinPreload()

    // 会话：恢复 / 新建
    const sm = harness.session
    let session: Session
    const sid = this.options.sessionId
    if (sid) {
      const saved = await this.sessionStore.load(sid)
      if (saved) {
        // 先 create 后回填 messages（SessionManager 接口没有批量 restore，这里创建新 session + 逐行 addMessage）
        session = await sm.create({ title: saved.title, agentId: saved.agentId, cwd: this.options.cwd, meta: saved.meta })
        // 将 session.id 改为 sid（通过直接操作 manager 内部）：这里简单使用默认 ID，但把 messages 写回去
        for (const m of saved.messages) await sm.addMessage(session.id, m)
        // 若用户明确 --session sid，实际文件 id ≠ sid，做个 save 用正确 id
        await sm.setId(session.id, sid)
      } else {
        session = await sm.create({ title: sid, agentId: this.options.agentId, cwd: this.options.cwd })
        await sm.setId(session.id, sid)
      }
    } else {
      session = await sm.create({ agentId: this.options.agentId, cwd: this.options.cwd })
    }
    await this.sessionStore.save(session)

    return { harness, session }
  }

  /** 发送一次用户消息，得到 assistant Message（内部持久化） */
  async send(sessionId: string, text: string): Promise<Message> {
    const h = this.harness
    // 通过 harness.session.prompt 发送，内部会写入消息 + 调用 agent.query
    const assistant = await h.session.prompt(sessionId, text)
    const sess = (await h.session.get(sessionId))!
    await this.sessionStore.save(sess)
    return assistant
  }

  /** 流式发送：逐事件 yield AgentStreamEvent，完成后自动持久化 session */
  async *sendStream(sessionId: string, text: string): AsyncGenerator<import('@harness/core').AgentStreamEvent, void, unknown> {
    const h = this.harness
    const gen = h.session.promptStream(sessionId, text)
    for await (const ev of gen) {
      yield ev
    }
    // 持久化
    const sess = (await h.session.get(sessionId))!
    await this.sessionStore.save(sess)
  }

  /** 关闭 harness */
  async shutdown(): Promise<void> {
    const sess = await this.harness.session.list({ limit: 1 })
    if (sess?.[0]) await this.sessionStore.save(sess[0])
    await this.harness.stop()
  }

  /**
   * 多级加载 L2 —— boot 末尾后台静默预加载内置插件/工具。
   *
   * fire-and-forget：不阻塞 boot、不向上抛错；经 Promise.allSettled 采集结果，
   * 失败仅向 stdout 写一条 WARN 日志。职责：
   * 1) 预热已登记的内置插件（tools-builtin / tools-manager 等，动态 import 已被运行时缓存，重复调用开销极低）；
   * 2) 将预加载出的插件模块安装进 Harness（跳过 boot 阶段已同步安装的），并触发
   *    harness.assembleTools() 主动组装工具池——否则工具只在用户首条消息后（query 内
   *    的 tool.pool.assemble）才注册，/tools 会一直停留在「仅元信息」，list_dir 等场景
   *    工具也无法开箱即用。
   */
  private scheduleBuiltinPreload(): void {
    const stdout = this.options.stdout
    const verbose = this.options.verbose
    if (this.options.backgroundPreload === false) return
    const harness = this.harness
    const items = getBuiltinRegistry().list()
    if (!items.length || !harness) return
    void (async () => {
      // metaOnly 插件（如 computer-use）仅预登记元信息（preloadBuiltinToolMetas 处理），
      // 不在此实例化，避免自动 register MCP server。
      const loadable = items.filter((p) => !p.metaOnly)
      const results = await Promise.allSettled(loadable.map((p) => p.load()))
      const installedIds = new Set(harness.plugin.list().map((lp) => lp.plugin.id))
      const toInstall: AgentPlugin[] = []
      for (let i = 0; i < loadable.length; i++) {
        const item = loadable[i]!
        const r = results[i]!
        if (r.status === 'rejected') {
          stdout?.write?.(`[WARN] 内置插件「${item.id}」后台预加载失败：${(r.reason as Error)?.message ?? String(r.reason)}\n`)
        } else {
          const plugin = r.value
          if (plugin && !installedIds.has(plugin.id)) toInstall.push(plugin)
          if (verbose) stdout?.write?.(`[INFO] 内置插件「${item.id}」已后台预热。\n`)
        }
      }
      if (toInstall.length > 0) {
        try {
          await harness.plugin.loadInternal(toInstall)
        } catch (err) {
          stdout?.write?.(`[WARN] 内置插件安装失败：${(err as Error)?.message ?? String(err)}\n`)
        }
      }
      try {
        await harness.assembleTools()
      } catch (err) {
        stdout?.write?.(`[WARN] 工具池预热失败：${(err as Error)?.message ?? String(err)}\n`)
      }
    })()
  }

  get _harness(): Harness { return this.harness }
}

// ========================================================================
// 5. REPL
// ========================================================================

export interface ReplOptions {
  app: HarnessApp
  harness: Harness
  session: Session
  stdout?: NodeJS.WritableStream | { write: (s: string) => void }
  stdin?: NodeJS.ReadableStream
  /** 测试注入：返回数组每取一条当作一行 stdin，取完后自动 /exit */
  scriptedStdin?: string[]
  onLine?: (line: string) => Promise<void> | void
}

/** 特殊 REPL 命令（以 / 开头） */
const REPL_COMMANDS = ['/help', '/exit', '/quit', '/sessions', '/new', '/resume', '/switch', '/model', '/config', '/save', '/compact', '/plugins', '/skills', '/stats', '/stats-export', '/permission', '/history', '/tree']

/**
 * 收集 TUI `/` 命令补全候选：内置 REPL 命令 + 插件经 `cli.commands` hook 注册的命令。
 * TUI 输入以 `/` 开头时据此渲染命令菜单弹层。
 */
export async function listReplCommands(harness: Harness): Promise<Array<{ command: string; description: string }>> {
  const names = REPL_COMMANDS.map((cmd) => ({ command: cmd, description: '' }))
  try {
    const cmdInput = { commands: [] as Array<{ command: string; description: string; usage?: string }> }
    await harness.plugin.trigger('cli.commands', cmdInput)
    for (const c of cmdInput.commands) {
      if (!names.some((n) => n.command === `/${c.command}`)) names.push({ command: `/${c.command}`, description: c.description })
    }
  } catch { /* 忽略插件 hook 错误 */ }
  return names
}

// ========================================================================
// 5.1 后台任务面板（P1-4 前端事件驱动展示）
// ========================================================================

export interface BackgroundTaskPanelOptions {
  /** Harness 实例（提供 bus） */
  harness: Harness
  /** 输出流（默认 process.stdout） */
  stdout?: NodeJS.WritableStream | { write: (s: string) => void }
  /** 仅展示这些父 session 派发的任务；不传则展示所有 */
  parentSessionIds?: string[]
}

/**
 * 订阅 MCP server 生命周期事件，触发工具池重组（assembleTools）。
 *
 * 禁用/启用/新增/移除 server 后，mcp-server-registry 的 tool.pool.assemble 会
 * 移除 / 装配对应 server 的工具；若不主动重组，运行时 ToolRegistry 里旧工具会一直
 * 「残留下线」，导致 /tools 仍把禁用 server 的工具显示为启用/可调用。本函数把事件
 * 桥接到 harness.assembleTools()，让禁用即时生效。
 *
 * @returns 卸载函数（取消全部订阅）
 */
export function attachMcpReassemble(harness: Harness): () => void {
  if (!harness.bus) return () => {}
  const offs = [
    harness.bus.subscribe(LifecycleEvents.mcpServerDisabled, () => { void harness.assembleTools() }),
    harness.bus.subscribe(LifecycleEvents.mcpServerEnabled, () => { void harness.assembleTools() }),
    harness.bus.subscribe(LifecycleEvents.mcpServerAdded, () => { void harness.assembleTools() }),
    harness.bus.subscribe(LifecycleEvents.mcpServerRemoved, () => { void harness.assembleTools() }),
  ]
  return () => { for (const off of offs) off() }
}

/**
 * 挂载后台任务面板（P1-4 前端事件驱动展示）。
 *
 * 订阅 subagent.started / completed / failed Bus 事件，任务状态变化时
 * 增量打印到 stdout（⏳ 开始 / ✅ 完成 / ❌ 失败 + 结果预览），
 * 用户无需执行 /tasks、无需大模型主动查询。
 *
 * UI 无关：本函数只做"事件 → 文本行"的渲染，底层状态由 subagent 插件能力
 * （@harness/plugin.SubagentCapability.createMonitor）维护。
 *
 * @returns 卸载函数（取消订阅 + 释放 monitor）
 */
export function attachBackgroundTaskPanel(options: BackgroundTaskPanelOptions): () => void {
  const { harness } = options
  if (!harness.bus) return () => {}
  const out = (s: string) => (options.stdout ?? process.stdout).write(s)

  const monitor = subagentCapability.createMonitor({
    bus: harness.bus,
    parentSessionIds: options.parentSessionIds,
  })
  /** taskId → 已打印的状态（增量渲染，同一状态只打印一次） */
  const printed = new Map<string, BackgroundTaskViewLike['status']>()
  /** 已打印的进度条目（taskId:toolUseId:toolStatus，P1-5） */
  const printedProgress = new Set<string>()

  const off = monitor.subscribe((tasks) => {
    for (const t of tasks) {
      if (printed.get(t.taskId) !== t.status) {
        printed.set(t.taskId, t.status)
        if (t.status === 'running') {
          out(`⏳  [后台任务] ${t.taskId} 开始：${t.agentName}${t.description ? `（${t.description}）` : ''}\n`)
        } else if (t.status === 'completed') {
          out(`✅  [后台任务] ${t.taskId} 完成：${t.agentName}（${t.durationMs ?? '?'}ms）\n`)
          if (t.result) {
            out(`     ↳ ${t.result.length > 140 ? t.result.slice(0, 140) + '…' : t.result}\n`)
          }
        } else if (t.status === 'failed') {
          out(`❌  [后台任务] ${t.taskId} 失败：${t.agentName} — ${t.error?.message ?? '未知错误'}\n`)
        }
      }
      // P1-5：增量打印工具调用进度（最新在前，遍历找未打印的）
      for (const p of t.progress ?? []) {
        const key = `${t.taskId}:${p.toolUseId}:${p.toolStatus}`
        if (printedProgress.has(key)) continue
        printedProgress.add(key)
        if (p.toolStatus === 'running') {
          out(`  🔧  [${t.taskId}] ${p.toolName}${p.summary ? `：${p.summary}` : ''}...\n`)
        } else if (p.toolStatus === 'completed') {
          out(`  ✅  [${t.taskId}] ${p.toolName} → ${p.summary || '完成'}\n`)
        } else {
          out(`  ❌  [${t.taskId}] ${p.toolName} 失败 → ${p.summary || '未知错误'}\n`)
        }
      }
    }
  })

  return () => { off(); monitor.dispose() }
}

/**
 * 挂载 Coordinator 自动续轮（Coordinator 插件配套）。
 *
 * 订阅 `coordinator.barrier.completed` 事件——coordinator 派出的后台任务
 * 全部完成/失败时触发——向 REPL 注入一行 `<continue/>` 作为伪用户输入，
 * 从而启动下一轮 query：drainNotifications 将任务完成通知注入对话，
 * coordinator 自动汇总结果、继续派工或输出最终报告（用户零操作）。
 *
 * @param emitLine 把一行注入 REPL 输入队列的函数（readline 模式：rl.emit('line', l)）
 * @returns 卸载函数
 */
export function attachAutoContinue(harness: Harness, emitLine: (line: string) => void): () => void {
  if (!harness.bus) return () => {}
  return harness.bus.subscribe(CoordinatorEvents.barrierCompleted, () => emitLine('<continue/>'))
}

/** REPL 自动续轮标记消息（不作为用户输入展示/回显） */
const AUTO_CONTINUE_LINE = '<continue/>'

// ========================================================================
// 5.2 processLine 工厂（REPL / TUI 共用会话处理内核）
// ========================================================================

export interface ProcessLineOptions {
  app: HarnessApp
  harness: Harness
  /** 当前会话（可变：/new 会换绑新会话，工厂内部维护 current 指针） */
  session: Session
  /** 输出函数 */
  out: (s: string) => void
  /** 收到普通用户输入时回调（REPL 回显前触发） */
  onLine?: (line: string) => Promise<void> | void
  /**
   * TUI 结构化事件回传：reasoning/text/tool/done 逐帧透传。
   * 提供时，推理与正文增量不再经 `out`（由调用方按其格式渲染，如 markdown 流）；
   * 用户回显 / 工具行 / 命令输出 / 计时等仍走 `out`。
   */
  onEvent?: (ev: AgentStreamEvent) => void
  /** /new 换绑新会话后回调（让调用方同步自身会话引用） */
  setSession?: (session: Session) => void
}

export type ProcessLineResult = 'continue' | 'exit'

/** 解析当前会话用量统计：优先读 session.meta 持久化值；无则从消息历史重建 */
async function resolveCurrentUsage(harness: Harness, current: Session): Promise<UsageStats> {
  const fromMeta = usageFromMeta(current.meta)
  if (fromMeta) return fromMeta
  const sess = current.messages?.length ? current : await harness.session.get(current.id)
  if (sess && sess.messages) return usageFromMessages(sess.messages)
  return emptyUsage()
}

/**
 * 创建「处理一行输入」的函数（REPL 与 TUI 共用同一套会话处理逻辑）。
 *
 * - 处理 `/` 特殊命令（/help /exit /sessions /save /new /switch /compact
 *   /search /export /revert + 插件 cli.commands / cli.command hook）
 * - 普通消息经 app.sendStream 流式渲染（reasoning_delta / text_delta /
 *   tool_call_start / tool_call_result / done 事件）
 * - AUTO_CONTINUE_LINE（<continue/>）为系统注入的伪输入，不回显
 *
 * @returns (raw) => Promise<'continue' | 'exit'>
 */
export function createProcessLine(options: ProcessLineOptions): (raw: string) => Promise<ProcessLineResult> {
  const { app, harness } = options
  const out = options.out
  const onEvent = options.onEvent
  let current = options.session

  return async (raw) => {
    const line = raw.trim()
    if (!line) return 'continue'

    // 特殊命令
    if (line.startsWith('/')) {
      const [cmd, arg] = line.split(/\s+/, 2)
      // TUI 模式：回显命令输入为 user 块，使其出现在对话历史、并在欢迎页状态下触发切换
      if (options.onEvent) out(`\n🧑  ${line}\n`)
      try {
      switch (cmd) {
        case '/help':
          out('命令列表：\n')
          out('  /help              显示帮助\n')
          out('  /exit, /quit       退出 REPL\n')
          out('  /sessions          列出持久化会话\n')
          out('  /new               新建会话（保留当前历史到磁盘）\n')
          out('  /resume <id>       恢复持久化会话继续交互（/sessions 查看 id）\n')
          out('  /save              手动保存当前会话\n')
          out('  /switch <agentId>  切换默认 Agent（下一条 send 生效）\n')
          out('  /switch ?          列出已注册 Agent\n')
          out('  /model             查看当前模型\n')
          out('  /model <spec>      切换模型：provider/modelId 跨 Provider（如 /model openai/gpt-4o）\n')
          out('  /model ?           列出已注册 Provider\n')
          out('  /config            查看 Provider / 模型配置概览（config.json）\n')
          out('  /permission        查看权限交互模式与规则（permissions.json）\n')
          out('  /permission <mode>  切换交互模式：allow-all | ask | deny-all\n')
          out('  /permission <k>=<v> 设置工具规则：如 bash=deny、write=ask\n')
          out('  /compact [mode]    立即压缩会话：mode=prune/summary(默认)/agent\n')
          out('  /compact auto      达到阈值才压缩（默认 80% 可用窗口才触发）\n')
          out('  /search <keyword>  关键词搜索会话（匹配消息文本）\n')
          out('  /export [sessionId]  导出会话为 Markdown（默认当前会话）\n')
          out('  /plugins              列出已加载插件（含来源/是否可管理）\n')
          out('  /plugins <op> <id>    enable|disable|reload 插件（如 /plugins reload my-gw）\n')
          out('  /skills              列出所有技能（含来源标注）\n')
          out('  /skills <op> <id>     enable|disable|reload 技能（如 /skills disable foo）\n')
          out('  /stats               查看本会话用量统计（LLM/token/模型/工具/小时时序/缓存）\n')
          out('  /stats-export [md|json] [path] 导出统计报告（默认 md 打印，给定 path 写文件）\n')
          // 收集插件注册的命令
          try {
            const cmdInput = { commands: [] as Array<{ command: string; description: string; usage?: string }> }
            await harness.plugin.trigger('cli.commands', cmdInput)
            for (const c of cmdInput.commands) {
              out(`  /${c.command.padEnd(16)}${c.description}\n`)
              if (c.usage) out(`     用法：${c.usage}\n`)
            }
          } catch { /* 忽略插件 hook 错误 */ }
          return 'continue'

        case '/exit': case '/quit':
          return 'exit'

        case '/sessions': {
          const list = await app.sessionStore.list()
          if (list.length === 0) { out('（无持久化会话）\n'); return 'continue' }
          for (const s of list) {
            const when = new Date(s.updatedAt).toLocaleString()
            out(`  ${s.id}  ${s.title ?? '(untitled)'}  ${s.messageCount} msgs  ${when}\n`)
          }
          return 'continue'
        }
        case '/save': {
          const s = (await harness.session.get(current.id))!
          await app.sessionStore.save(s)
          out(`已保存会话 ${current.id}\n`)
          return 'continue'
        }
        case '/new': {
          const cur = (await harness.session.get(current.id))!
          await app.sessionStore.save(cur)
          const next = await harness.session.create({ agentId: current.agentId })
          // 换绑当前会话：工厂内部指针 + 通知调用方
          current = next
          options.setSession?.(next)
          out(`已新建会话 ${next.id}\n`)
          return 'continue'
        }
        case '/resume': {
          if (!arg || !arg.trim()) { out('用法：/resume <sessionId> 恢复持久化会话继续交互\n'); return 'continue' }
          const saved = await app.sessionStore.load(arg)
          if (!saved) { out(`会话 "${arg}" 不存在（可用 /sessions 查看）。\n`); return 'continue' }
          if (saved.id === current.id) { out(`已在会话 ${arg}\n`); return 'continue' }
          // 先保存当前会话历史
          const cur = await harness.session.get(current.id)
          if (cur) await app.sessionStore.save(cur)
          // 与 boot() resume 一致：create 新会话 + 回填消息 + 复写 id 为原会话 id
          const next = await harness.session.create({ title: saved.title, agentId: saved.agentId, cwd: saved.cwd, meta: saved.meta })
          for (const m of saved.messages) await harness.session.addMessage(next.id, m)
          await harness.session.setId(next.id, saved.id)
          current = next
          options.setSession?.(next)
          out(`已恢复会话 ${saved.id}（${saved.messages.length} 条消息）\n`)
          return 'continue'
        }
        case '/switch': {
          if (!arg || arg === '?') {
            out('已注册 Agent：\n')
            for (const a of harness.agent.list()) out(`  ${a.id}  -  ${a.name}\n`)
            return 'continue'
          }
          const exists = harness.agent.get(arg)
          if (!exists) { out(`Agent "${arg}" 未注册。\n`); return 'continue' }
          const cur = (await harness.session.get(current.id))!
          cur.agentId = arg
          out(`已切换到 Agent ${arg}（影响下次 send）\n`)
          return 'continue'
        }
        case '/model': {
          const agentId = current.agentId ?? 'default'
          if (!arg || arg === '?') {
            const prods = app.listProviders()
            out('已注册 Provider：' + (prods.length ? prods.join(' / ') : '（默认 mock/anthropic）') + '\n')
            // 展示 config.json / CLI 里配置的 Provider 实例及其默认/附加模型
            const configured = app.listConfiguredProviders()
            if (configured.length) {
              out('配置的模型（providers）：\n')
              for (const p of configured) {
                const model = p.model ? `${p.id}/${p.model}` : `${p.id}（未指定 model，用 Provider 默认）`
                const extra = [
                  p.baseUrl ? `baseUrl=${p.baseUrl}` : '',
                  p.apiPath ? `apiPath=${p.apiPath}` : '',
                  p.type ? `type=${p.type}` : '',
                ].filter(Boolean).join(' · ')
                out(`  - ${model}${extra ? `  (${extra})` : ''}\n`)
              }
            }
            const m = app.getModel(agentId)
            if (m) out(`当前模型：${m}（agent=${agentId}）\n`)
            else out(`Agent "${agentId}" 未绑定模型，使用 Provider 默认。\n`)
            if (harness.agent.get(agentId)?.model?.options) {
              out(`模型附加选项：${JSON.stringify(harness.agent.get(agentId)!.model!.options)}\n`)
            }
            return 'continue'
          }
          // 校验：跨 Provider 切换时目标 provider 需已注册/配置
          const parsed = parseModelSpec(arg.trim())
          const providers = app.listProviders()
          if (parsed.providerId && !providers.includes(parsed.providerId)) {
            out(`Provider "${parsed.providerId}" 未注册。可用：${providers.join(' / ') || '（默认）'}\n`)
            out('   可在 <data-dir>/config.json → providers 中定义后重新启动。\n')
            return 'continue'
          }
          const ok = await app.setModel(agentId, arg.trim())
          if (!ok) { out(`Agent "${agentId}" 未注册。\n`); return 'continue' }
          out(`已切换模型 ${arg.trim()}（agent=${agentId}，影响下次 send；已写入 config.json）\n`)
          return 'continue'
        }
        case '/config': {
          const cfg = await app.configStore.load()
          const agentId = current.agentId ?? 'default'
          out(`当前 agent=${agentId}\n`)
          const prods = app.listProviders()
          out(`已注册 Provider：${prods.length ? prods.join(' / ') : '（默认 mock/anthropic）'}\n`)
          const m = app.getModel(agentId)
          if (m) out(`当前模型：${m}\n`)
          out(buildConfigOverview(cfg, cfg.provider ?? 'anthropic') + '\n')
          return 'continue'
        }
        case '/compact': {
          const curSessionId = current.id
          if (arg === 'auto' || arg === 'ifneeded') {
            const did = await harness.session.compactIfNeeded(curSessionId)
            const info = await harness.session.getCompactionInfo(curSessionId)
            if (did) out(`已触发压缩（阈值命中）：策略=${info.meta?.lastStrategy}，前=${info.meta?.lastMessagesBefore} 后=${info.meta?.lastMessagesAfter}\n`)
            else {
              const est = await harness.session.estimateTokens(curSessionId)
              out(`未达阈值（估算 ${est} tokens），跳过压缩。\n`)
            }
          } else {
            const strategy = (arg === 'prune' || arg === 'summary' || arg === 'agent') ? arg : 'summary'
            await harness.session.compact(curSessionId, strategy)
            const info = await harness.session.getCompactionInfo(curSessionId)
            out(`已压缩会话（策略=${strategy}）：`)
            out(`累计压缩次数=${info.meta?.count ?? 0}，累计压缩消息=${info.meta?.totalPrunedMessages ?? 0}\n`)
            out(`本轮：前=${info.meta?.lastMessagesBefore} 后=${info.meta?.lastMessagesAfter}；摘要轮次=${info.memory?.round ?? 0}\n`)
            if (info.memory?.summaryText) out(`摘要（前 400 字）：${info.memory.summaryText.slice(0, 400)}\n`)
          }
          return 'continue'
        }
        case '/stats': {
          const u = await resolveCurrentUsage(harness, current)
          out(renderStatsText(u) + '\n')
          return 'continue'
        }
        case '/stats-export': {
          const u = await resolveCurrentUsage(harness, current)
          const [fmtArg, pathArg] = (arg ?? '').trim().split(/\s+/)
          const isJson = fmtArg === 'json' || fmtArg === '--json'
          const content = isJson
            ? exportStatsJson(u, { sessionId: current.id, title: current.title })
            : exportStatsMarkdown(u, { sessionId: current.id, title: current.title })
          if (pathArg) {
            await writeFile(pathArg, content)
            out(`已导出统计报告 → ${pathArg}\n`)
          } else {
            out(content + '\n')
          }
          return 'continue'
        }
        case '/search': {
          if (!arg || !arg.trim()) { out('用法：/search <keyword>\n'); return 'continue' }
          const results = await harness.session.search(arg.trim())
          if (results.length === 0) { out('（无匹配会话）\n'); return 'continue' }
          for (const s of results) {
            const when = new Date(s.updatedAt).toLocaleString()
            out(`  ${s.id}  ${s.title ?? '(untitled)'}  ${s.messages.length} msgs  ${when}\n`)
          }
          return 'continue'
        }
        case '/export': {
          const exportSid = arg?.trim() || current.id
          const md = await harness.session.exportMarkdown(exportSid)
          if (!md) { out(`会话 ${exportSid} 不存在或为空\n`); return 'continue' }
          out(md)
          out('\n')
          return 'continue'
        }
        case '/permission': {
          // 查看：/permission；设置：/permission <mode> 或 /permission <key>=<behavior>
          if (!arg || arg.trim() === '?') {
            out(`权限交互模式：${app.permission.getMode()}（allow-all / ask / deny-all）\n`)
            out('当前规则（permissions.json）：\n')
            const rules = app.permission.getRules() as Record<string, unknown>
            const keys = Object.keys(rules)
            if (keys.length === 0) { out('  （无规则，全局默认 ask）\n'); return 'continue' }
            for (const k of keys) out(`  ${k.padEnd(14)}: ${JSON.stringify(rules[k])}\n`)
            out('\n用法：/permission <allow-all|ask|deny-all>   切换交互模式\n')
            out('      /permission <key>=<behavior>           设置工具规则，如 /permission bash=deny、/permission write=ask\n')
            out('      /permission reset                      恢复为全局 ask 并清空规则\n')
            return 'continue'
          }
          const t = arg.trim()
          if (t === 'reset') {
            await app.setPermissionRules({ '*': 'ask' })
            app.permission.setMode('ask')
            out('已重置权限：规则清空（全局 ask），交互模式=ask，并写回 permissions.json。\n')
            return 'continue'
          }
          const eq = t.indexOf('=')
          if (eq > 0) {
            const key = t.slice(0, eq).trim()
            const val = t.slice(eq + 1).trim()
            if (!['allow', 'deny', 'ask'].includes(val)) {
              out(`非法行为 "${val}"（allow / deny / ask）。\n`); return 'continue'
            }
            const current = app.permission.getRules() as Record<string, unknown>
            const updated = { ...current, [key]: val }
            await app.setPermissionRules(updated)
            out(`已设置规则 ${key}=${val} 并写回 permissions.json。\n`)
            return 'continue'
          }
          if (['allow-all', 'ask', 'deny-all'].includes(t)) {
            app.permission.setMode(t as 'allow-all' | 'ask' | 'deny-all')
            out(`已切换权限交互模式为 ${t}（作用于「询问型」请求；规则文件不变）。\n`)
            return 'continue'
          }
          out(`无法解析 "${t}"。/permission 查看，/permission <mode> 或 /permission <key>=<behavior> 设置。\n`)
          return 'continue'
        }
        case '/skills': {
          const parts = line.split(/\s+/).map((s) => s.trim()).filter(Boolean)
          const op = parts[1]
          const sid = parts[2]
          if (!op || !sid || !['enable', 'disable', 'reload'].includes(op)) {
            const infos = app.skillInfos()
            if (infos.length === 0) { out('（未加载任何技能）\n'); return 'continue' }
            out('已加载技能（来源标注）：\n')
            for (const s of infos) {
              out(`  ${s.id.padEnd(24)}${s.name}  [${s.sourceLabel}(${s.source})]\n`)
            }
            if (parts.length === 1) { out('\n用法：/skills <enable|disable|reload> <skillId>\n'); return 'continue' }
            out('用法：/skills <enable|disable|reload> <skillId>\n')
            return 'continue'
          }
          const res = op === 'disable'
            ? await app.disableSkill(sid)
            : op === 'enable'
              ? await app.enableSkill(sid)
              : await app.reloadSkill(sid)
          out(`${res.ok ? '✅' : '❌'}  ${res.message}\n`)
          return 'continue'
        }
        default: {
          // 尝试交给插件处理（注入 harness / 当前 agentId / 工具白名单持久化 / MCP 装配持久化 / 工具静态元信息）
          const cmdInput: {
            raw: string; command: string; arg: string; out: (s: string) => void; sessionId: string;
            harness: Harness; agentId?: string;
            setAgentTools: (agentId: string, tools: string[]) => Promise<void>;
            mcpServers: McpServerEntry[];
            setMcpServers: (list: McpServerEntry[]) => Promise<void>;
            toolMeta: ToolMetaLookup;
            workspace: Workspace;
            snapshotService?: SnapshotService;
            manageablePlugin: (id: string) => AgentPlugin | undefined;
            pluginManageable: (id: string) => boolean;
            availablePlugins: () => Array<{ id: string; name: string; version: string }>;
            result?: 'continue' | 'exit'
          } = {
            raw: line.slice(1),
            command: cmd.slice(1),
            arg: line.slice(cmd.length).trim(),
            out,
            sessionId: current.id,
            harness,
            agentId: current.agentId,
            setAgentTools: (id, tools) => app.setAgentTools(id, tools),
            mcpServers: await app.getMcpServers(),
            setMcpServers: (list) => app.setMcpServers(list),
            toolMeta: getBuiltinToolRegistry(),
            workspace: app.workspace,
            snapshotService: app.snapshotService,
            manageablePlugin: (id) => app.pluginRegistry.get(id),
            pluginManageable: (id) => app.pluginRegistry.has(id),
            availablePlugins: () => Array.from(app.pluginRegistry.entries()).map(([id, p]) => ({ id, name: p.name ?? id, version: p.version ?? '0.0.0' })),
          }
          try {
            await harness.plugin.trigger('cli.command', cmdInput)
          } catch { /* 忽略插件 hook 错误 */ }
          if (cmdInput.result === 'exit') return 'exit'
          if (cmdInput.result === 'continue') return 'continue'
          out(`未知命令：${line}，输入 /help 查看。\n`)
          return 'continue'
        }
      }
      } catch (err: any) {
        out(`❌  /${cmd} 执行失败：${err?.message ?? String(err)}\n`)
        return 'continue'
      }
    }

    // 正常发送（流式）
    // 自动续轮（<continue/>）是系统注入的伪输入，不回显用户前缀
    const isAutoContinue = line === AUTO_CONTINUE_LINE
    if (!isAutoContinue) {
      await options.onLine?.(line)
      out(`\n🧑  ${line}\n`)
    }
    const started = Date.now()
    let assistant: Message | undefined
    try {
      const curSessionId = current.id
      const gen = app.sendStream(curSessionId, line)
      let inReasoning = false
      let inText = false
      let inToolOutput = false
      for await (const ev of gen) {
        switch (ev.type) {
          case 'reasoning_delta':
            // TUI 结构化模式（onEvent）：推理增量直接回传，由 TUI 渲染成 thinking 块；
            // REPL（无 onEvent）：保留原前缀「💭  增量」打印行为。
            if (onEvent) {
              inReasoning = true
              onEvent(ev)
            } else {
              if (!inReasoning) { out('💭  '); inReasoning = true }
              out(ev.text ?? '')
            }
            break
          case 'text_delta':
            if (onEvent) {
              inText = true
              onEvent(ev)
            } else {
              if (!inText) { if (inReasoning) out('\n'); out('🤖  '); inText = true }
              out(ev.text ?? '')
            }
            break
          case 'tool_call_start':
            if (inText || inReasoning) { out('\n'); inText = false; inReasoning = false }
            onEvent?.(ev)
            out(`🔧  ${ev.toolId} ${JSON.stringify(ev.input).slice(0, 60)}...\n`)
            break
          case 'tool_call_result': {
            const status = ev.isError ? '❌' : '✅'
            const preview = typeof ev.result === 'string'
              ? ev.result.slice(0, 120)
              : JSON.stringify(ev.result ?? '').slice(0, 120)
            onEvent?.(ev)
            out(`${status}  → ${preview}\n`)
            break
          }
          case 'done':
            assistant = ev.message
            onEvent?.(ev)
            break
        }
      }
      // 结构化模式（onEvent）下收尾换行由 TUI 负责，避免向控制台混入空行
      if (!onEvent && (inText || inReasoning)) out('\n') // 换行收尾
    } catch (err: any) {
      out(`\n❌  发送失败：${err?.message ?? String(err)}\n`)
      return 'continue'
    }
    const duration = Date.now() - started
    out(`⏱️  ${duration}ms | agent=${assistant?.agentId ?? current.agentId ?? '?'}` +
      (assistant?.meta?.model ? ` | model=${assistant.meta.model}` : '') + '\n\n')
    return 'continue'
  }
}

/**
 * 启动交互式 REPL。
 *
 * - 用户输入文本 → HarnessApp.send()
 * - 显示 assistant 文本 + 每个 tool call（执行前→执行后）
 * - /exit、/quit 退出；/sessions 列出持久化会话；/new 清空当前会话；/save 手动保存
 * - 支持 scriptedStdin（测试用，或流水线一次性脚本）
 * - 自动挂载后台任务面板：subagent 后台任务开始/完成/失败时实时打印（P1-4）
 *
 * @returns 退出原因：'exit' / 'eof' / 'scripted-done'
 */
export async function startRepl(options: ReplOptions): Promise<'exit' | 'eof' | 'scripted-done'> {
  // P1-4：挂载后台任务面板（事件驱动自动展示，无需 /tasks）
  const detachPanel = attachBackgroundTaskPanel({
    harness: options.harness,
    stdout: options.stdout,
  })
  const detachMcpReassemble = attachMcpReassemble(options.harness)
  try {
    return await startReplCore(options)
  } finally {
    detachMcpReassemble()
    detachPanel()
  }
}

/** startRepl 内部实现（由 startRepl wrapper 挂载任务面板后调用） */
async function startReplCore(options: ReplOptions): Promise<'exit' | 'eof' | 'scripted-done'> {
  const { app, harness, session } = options
  const out = (s: string) => (options.stdout ?? process.stdout).write(s)

  out(`Harness CLI (session=${session.id}, agent=${session.agentId ?? 'default'})\n`)
  out(`输入问题开始对话；输入 /help 查看特殊命令；/exit 退出。\n\n`)

  let idx = 0
  const scripted = options.scriptedStdin ? [...options.scriptedStdin] : null

  // 会话处理内核（与 TUI 共用）：流式渲染、/ 命令、插件 cli.command hook
  const processLine = createProcessLine({
    app,
    harness,
    session,
    out,
    onLine: options.onLine,
    setSession: (s) => { (options as any).session = s },
  })

  if (scripted) {
    for (const line of scripted) {
      idx++
      const res = await processLine(line)
      if (res === 'exit') return 'exit'
    }
    // 脚本结束后顺手 /save
    const cur = (await harness.session.get((options as any).session.id))
    if (cur) await app.sessionStore.save(cur)
    return 'scripted-done'
  }

  // 使用 readline 交互
  return new Promise((resolve) => {
    const rl = createInterface({
      input: options.stdin ?? process.stdin,
      output: options.stdout ?? process.stdout as any,
      prompt: '❯ ',
    })
    // Coordinator 自动续轮：barrier 完成后注入 <continue/> 触发下一轮 query
    const detachAutoContinue = attachAutoContinue(harness, (line) => rl.emit('line', line))
    rl.prompt()
    rl.on('line', async (line) => {
      const r = await processLine(line)
      if (r === 'exit') { rl.close(); resolve('exit') }
      else rl.prompt()
    })
    rl.on('close', () => { detachAutoContinue(); resolve('eof') })
  })
}

// ========================================================================
// 6. help 文本
// ========================================================================

export const HELP_TEXT = `harness — Agent Harness CLI

用法:
  harness [repl|start] [options]        启动交互式 REPL（默认）
  harness list-sessions [options]       列出持久化会话
  harness resume <sessionId> [opt]      恢复指定会话进入 REPL
  harness run "<prompt>" [opt]          一次性执行 prompt，输出结果后退出
  harness teammate --team <t> --name <n> [opt]   以 out-of-process teammate 身份运行（终端后端 spawn）
  harness config set-key <providerId> <apiKey>   加密写入 provider 的 apiKey（enc:v1 密文）
  harness config get-key <providerId>            解密查看 provider 的 apiKey
  harness config check [options]       校验 config.json 并打印 Provider/模型概览
  harness help | -h | --help            显示帮助

teammate 选项:
      --team <team>           所属团队名（sanitize 后）
      --name <name>           成员名（sanitize 后）

选项:
  -c, --cwd <dir>            工作目录（默认当前目录）
  -a, --agent <id>           默认 Agent ID（默认 default）
  -p, --provider <id>      默认 Provider id：mock / anthropic，或 config.providers 中定义的自定义 id（默认 anthropic，无 key 时 fallback mock）
  -m, --model <spec>       默认模型：provider/modelId 跨 Provider 指定（如 openai/gpt-4o）。运行时可用 /model 切换
  -s, --session <id>       指定会话 ID（用于 resume/run 时复用历史）
  -d, --data-dir <dir>     持久化目录（默认 ~/.harness）
      --permission <mode>  allow-all / ask / deny-all（默认 ask）
  -v, --verbose            输出调试信息
      --tui                以 TUI（alt-screen 全屏）模式启动 REPL
      --snapshot           开启文件快照 + /revert 能力（默认 false；config.json 设 "snapshot": true 或 harness.snapshot 常开）
      --check-config       校验 config.json 配置并打印 Provider/模型概览后退出

多 Provider（config.json → providers）:
  [
    { "id": "openai",   "type": "openai",    "baseUrl": "https://api.openai.com", "apiKey": "...", "model": "gpt-4o" },
    { "id": "deepseek", "type": "openai",    "baseUrl": "https://api.deepseek.com", "apiKey": "...", "model": "deepseek-chat" },
    { "id": "ollama",   "type": "openai",    "baseUrl": "http://localhost:11434", "model": "qwen2.5" },
    { "id": "glm",      "type": "openai",    "baseUrl": "https://open.bigmodel.cn", "apiPath": "/api/paas/v4/chat/completions", "model": "glm-4" },
    { "id": "gemini",   "type": "gemini",    "apiKey": "...", "model": "gemini-2.0-flash" },
    { "id": "anthropic","type": "anthropic", "apiKey": "...", "model": "claude-3-5-sonnet" }
  ]
  运行时用 provider/modelId 前缀自由切换，如：/model openai/gpt-4o、/model deepseek/deepseek-chat、/model ollama/qwen2.5

Provider 类型插件扩展（插件化，无需改 CLI）:
  providers[].type 不限于内置类型。插件放在 ~/.harness/plugins（user）或 <project>/.harness/plugins（project），
  一个 .ts/.js 插件模块可同时导出通用 AgentPlugin（default/plugin/plugins，Hooks 生命周期）与 Provider 类型工厂:
    export const providerType = 'my-gw'
    export function createProviderPlugin(config) { /* 返回 AgentPlugin，install 内注册 ChatProvider */ }
  或导出 providerTypeFactory = { type, createPlugin }。
  config.json 中即可使用 { "id": "my-gw", "type": "my-gw", "baseUrl": "...", "apiKey": "..." }

配置优先级（model / provider / agent）:
  CLI 参数 > <data-dir>/config.json > 环境变量（ANTHROPIC_API_KEY）
`

// ========================================================================
// 7. 顶层 main()：处理脚本入口
// ========================================================================

/**
 * teammate 子命令：以 out-of-process teammate 身份运行（终端后端 spawn 的独立 CLI 进程）。
 *
 * 复用 HarnessApp.boot（provider/harness/会话），经 swarm 插件能力（SwarmCapability）
 * 从团队共享目录启动 teammate 循环持续轮询 mailbox + 认领任务，直到收到 shutdown
 * （approve_shutdown 决策 / 外部 stop）退出。
 */
export async function runTeammateCli(options: {
  args: CliArgs
  cwd: string
  dataDir: string
  provider: string
  agentId: string
  permissionMode: 'allow-all' | 'ask' | 'deny-all'
}): Promise<number> {
  const { args, cwd, dataDir, provider, agentId, permissionMode } = options
  const write = (s: string) => process.stdout.write(s)
  const team = args.team
  const name = args.name
  if (!team || !name) {
    write('用法: harness teammate --team <team> --name <成员名> --agent <agentId>\n')
    return 1
  }

  const app = new HarnessApp({ cwd, dataDir, agentId, provider, permissionMode, verbose: args.verbose })
  const { harness, session } = await app.boot()

  const memberTeam = swarmCapability.sanitizeName(team)
  const memberName = swarmCapability.sanitizeName(name)
  // mailbox/taskPlane 创建、teammate 状态与循环细节均由 swarm 插件能力封装
  const loop = swarmCapability.startTeammateLoop({
    teamsDir: app.workspace.files.teams,
    team: memberTeam,
    name: memberName,
    agentId,
    sessionId: session.id,
    harness,
  })
  write(`[teammate] ${memberName}@${memberTeam} 已上线（session=${session.id}），开始轮询 mailbox...\n`)

  // 挂起直到 shutdown（approve_shutdown / stop 将状态置 shutdown）
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (loop.isDone()) { clearInterval(poll); resolve() }
    }, 300)
  })
  await loop.stop()
  try { await app.shutdown() } catch {}
  write('[teammate] 已退出\n')
  return 0
}

/** 构造用于配置自检的 Provider 类型注册表（内置 + 外部 plugins 插件注册的 Provider 类型工厂） */
export async function buildCheckRegistry(cwd: string, log: (s: string) => void): Promise<ProviderTypeRegistry> {
  const registry = new ProviderTypeRegistry()
  registerBuiltinProviderTypes(registry)
  const ws = resolveWorkspace({ cwd })
  await loadPluginDirs(registry, [
    { dir: ws.user.plugins, source: 'user' },
    { dir: ws.project.plugins, source: 'project' },
  ], log)
  return registry
}

/**
 * config 子命令：密钥管理与配置自检。
 *   harness config set-key <providerId> <apiKey>   加密 apiKey 并写入 config.json（enc:v1 密文）
 *   harness config get-key <providerId>            解密输出指定 provider 的 apiKey
 *   harness config check                           校验配置并打印概览（等价 --check-config）
 */
export async function runConfigCommand(options: {
  args: CliArgs
  workspace: Workspace
  write: (s: string) => void
}): Promise<number> {
  const { args, workspace, write } = options
  const sub = args.arg
  const store = new ConfigStore<HarnessConfig>(workspace)
  const cfg = await store.load()
  const cipher = new SecretCipher(workspace)
  const providers = cfg.providers ?? []

  if (sub === 'set-key') {
    const [providerId, key] = args.rest ?? []
    if (!providerId || !key) { write('用法: harness config set-key <providerId> <apiKey>\n'); return 1 }
    const idx = providers.findIndex((p) => p.id === providerId)
    if (idx < 0) { write(`Provider "${providerId}" 不在 config.json → providers 中。\n`); return 1 }
    const encrypted = await cipher.encrypt(key)
    providers[idx] = { ...providers[idx], apiKey: encrypted }
    await store.save({ ...cfg, providers })
    write(`已加密写入 "${providerId}" 的 apiKey（config.json 中为 enc:v1 密文，主密钥见 HARNESS_CONFIG_KEY / <data-dir>/.config-key）。\n`)
    return 0
  }

  if (sub === 'get-key') {
    const [providerId] = args.rest ?? []
    if (!providerId) { write('用法: harness config get-key <providerId>\n'); return 1 }
    const idx = providers.findIndex((p) => p.id === providerId)
    if (idx < 0) { write(`Provider "${providerId}" 不在 config.json → providers 中。\n`); return 1 }
    const raw = providers[idx]?.apiKey
    if (!raw) { write(`Provider "${providerId}" 未配置 apiKey。\n`); return 0 }
    const plain = await cipher.decrypt(raw)
    write(plain + '\n')
    return 0
  }

  if (sub === 'check') {
    const registry = await buildCheckRegistry(workspace.cwd, write)
    const defaultProviderId = cfg.provider ?? 'anthropic'
    const issues = validateProviderConfigs(providers, defaultProviderId, registry.list())
    write(buildConfigOverview(cfg, defaultProviderId) + '\n')
    // 展示含外部插件的完整 Provider 类型清单（含用法提示）
    write(buildProviderTypesSection(registry) + '\n')
    if (issues.length) {
      write('配置错误（config.json → providers）：\n' + issues.map((s) => `  - ${s.message}`).join('\n') + '\n')
      return 1
    }
    write('配置校验通过。\n')
    return 0
  }

  write('用法: harness config <set-key|get-key|check> ...\n')
  return 1
}

export async function main(rawArgs: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseCliArgs(rawArgs)
  const stdout: { write: (s: string) => void } = process.stdout
  const write = (s: string) => stdout.write(s)

  if (args.command === 'help' || args.showHelp) {
    write(HELP_TEXT)
    // 追加"可用的 Provider 类型"清单：仅同步登记内置元信息，不加载任何 Provider 模块
    const registry = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(registry)
    write('\n' + buildProviderTypesSection(registry))
    return 0
  }

  const ws = resolveWorkspace({ cwd: args.cwd, dataDir: args.dataDir })
  const cwd = ws.cwd
  const dataDir = ws.dataDir
  const permissionMode = args.permissionMode ?? 'ask'

  // 加载 config.json 并与 CLI 合并：CLI > config
  const cfg = await new ConfigStore<HarnessConfig>(ws).load()
  const { agentId, provider, model, anthropicApiKey } = resolveConfig(args, cfg)
  // 快照优先级：CLI（--snapshot）> config.json（顶层 snapshot 或 harness.snapshot）> 默认 false
  const snapshot = args.snapshot ?? cfg.snapshot ?? cfg.harness?.snapshot ?? false

  if (args.command === 'list-sessions') {
    const store = new SessionFileStore(ws)
    const list = await store.list()
    if (list.length === 0) { write('（无持久化会话）\n'); return 0 }
    for (const s of list) {
      const when = new Date(s.updatedAt).toLocaleString()
      write(`${s.id}\t${s.title ?? ''}\t${s.messageCount} msgs\t${when}\n`)
    }
    return 0
  }

  if (args.command === 'config') {
    return runConfigCommand({ args, workspace: ws, write })
  }

  if (args.checkConfig) {
    const registry = await buildCheckRegistry(cwd, write)
    const issues = validateProviderConfigs(cfg.providers ?? [], provider, registry.list())
    write(buildConfigOverview(cfg, provider) + '\n')
    if (issues.length) {
      write('配置错误（config.json → providers）：\n' + issues.map((s) => `  - ${s.message}`).join('\n') + '\n')
      return 1
    }
    write('配置校验通过。\n')
    return 0
  }

  if (args.command === 'teammate') {
    return runTeammateCli({ args, cwd, dataDir, provider, agentId, permissionMode })
  }

  const app = new HarnessApp({
    cwd, dataDir, agentId, provider, model,
    providers: cfg.providers,
    anthropicProviderConfig: anthropicApiKey ? { apiKey: anthropicApiKey } : undefined,
    sessionId: args.command === 'resume' ? args.arg ?? args.sessionId : args.sessionId,
    permissionMode, verbose: args.verbose, snapshot,
  })
  const { harness, session } = await app.boot()

  try {
    if (args.command === 'run') {
      const prompt = args.arg ?? ''
      if (!prompt) { write('用法: harness run "<prompt>"\n'); return 1 }
      // 流式输出（逐 token 打印到 stdout，脚本友好）
      const gen = app.sendStream(session.id, prompt)
      for await (const ev of gen) {
        if (ev.type === 'text_delta') write(ev.text ?? '')
        else if (ev.type === 'done') {
          if (ev.message) {
            // 换行收尾
            const textParts = ev.message.parts.filter((p: any) => p.type === 'text')
            if (textParts.length > 0) write('\n')
          }
        }
      }
      return 0
    }

    // repl / resume / start → REPL（--tui 时进入 alt-screen 全屏 TUI）
    {
      const did = await harness.session.compactIfNeeded(session.id)
      if (did) {
        const info = await harness.session.getCompactionInfo(session.id)
        write(`[会话] 自动压缩：策略=${info.meta?.lastStrategy}，前=${info.meta?.lastMessagesBefore} 后=${info.meta?.lastMessagesAfter}\n`)
      }
    }
    if (args.tui) {
      await startTuiRepl({ app, harness, session, provider, model })
    } else {
      await startRepl({ app, harness, session })
    }
    return 0
  } finally {
    try { await app.shutdown() } catch {}
  }
}

// ========================================================================
// 8. 作为脚本直接执行
// ========================================================================

// 仅当该文件是 CLI 入口时运行 main。
// Bun 的 import.meta.main 语义与 ESM 一致。
// 这里用 typeof Bun !== undefined + require.main 等价策略。
if (typeof process !== 'undefined' && typeof Bun !== 'undefined') {
  const isEntry = (Bun as any)?.main === import.meta.path || (process as any)?.mainModule?.filename === (import.meta as any).filename
  if (isEntry) {
    main()
      .then((code) => { if (typeof process !== 'undefined') process.exit(code) })
      .catch((err) => {
        process.stderr.write('Fatal: ' + (err?.message ?? String(err)) + '\n')
        process.exit(1)
      })
  }
}
