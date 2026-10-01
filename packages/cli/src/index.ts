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
import type { AgentPlugin, PluginContext, ProviderConfig } from '@harness/plugin'
import { ProviderTypeRegistry } from '@harness/plugin'
// 运行时能力抽象契约（@harness/plugin）：cli 仅经下方面向 subagent / swarm 的抽象接口交互，
// 不依赖具体实现类型。具体能力对象（subagentCapability / swarmCapability）由插件包导出并在组合根装配。
import type { BackgroundTaskViewLike, ToolMetaLookup } from '@harness/plugin'
// 仅类型（`import type` 被完全擦除，不会拖累启动）：ACP 的「Provider 窗口表」形状 ——
// 装配处要按它构造，写内联结构体就会与插件侧两份定义漂移（本仓"同一个东西两套写法"的老病）。
import type { ProviderWindowTable } from '@harness/acp-context'
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
// 默认 Agent 提示词：独立文本文件（prompts/default-agent.txt），import 加载（参考 opencode）
import defaultAgentPrompt from './prompts/default-agent.txt'
import {
  ConfigStore,
  SessionFileStore,
  SessionPointerStore,
  SecretCipher,
  ConfigValidationError,
  resolveSecret,
  resolveWorkspace,
  createWorkspaceOriginalStore,
  type Workspace,
  type SessionFile,
} from '@harness/workspace'
import { createRevertPlugin, createSnapshotPlugin } from '@harness/revert'
// 装配原语上移到 @harness/host（P0 三步：① 外部插件目录加载；② 内置注册表三节 —— Provider
// 类型工厂 / 内置通用插件 / 内置工具静态元信息；③ 配置归一化与上下文窗口推导）。CLI / A2A
// server / 编辑器扩展共用同一份装配，避免"两份装配必然分叉"。
//
// 下面 import 的是本文件内部真正要用的；re-export 保持既有导出面**逐字不变** ——
// cli.test.ts / provider-model.test.ts 直接 import 这些符号，导出面动了就等于制造一次无谓的
// 测试翻修。
import {
  loadPluginDirs,
  lazyImport,
  registerBuiltinProviderTypes,
  getBuiltinRegistry,
  unknownBuiltinPluginIds,
  resolveBuiltinPlugins,
  getBuiltinToolRegistry,
  preloadBuiltinToolMetas,
  // B 档：配置归一化与窗口推导（boot 装配 ACP / 配置概览 / 会话压缩三处共用同一套口径）
  parseModelSpec,
  formatModel,
  normalizeProviderConfigs,
  resolveContextWindowTokens,
  buildProviderWindowTable,
  isUsableWindow,
} from '@harness/host'
import type { ResolvedProviderConfig, ProviderConfigIssue } from '@harness/host'
export {
  loadPluginDirs,
  collectAgentPlugins,
  registerProviderTypeFactory,
  lazyImport,
  registerBuiltinProviderTypes,
  getBuiltinRegistry,
  unknownBuiltinPluginIds,
  resolveBuiltinPlugins,
  getBuiltinToolRegistry,
  preloadBuiltinToolMetas,
  parseModelSpec,
  formatModel,
  sanitizeProviderId,
  normalizeProviderConfigs,
  resolveContextWindowTokens,
  buildProviderWindowTable,
  isUsableWindow,
  // 本文件内部不再直接引用，仅为保持导出面而 re-export（外部/测试仍可按下述名字取得）
  BuiltinPluginRegistry,
  BuiltinToolRegistry,
} from '@harness/host'
export type {
  PluginLoadResult,
  BuiltinGeneralPlugin,
  ResolvedProviderConfig,
  ProviderConfigIssue,
} from '@harness/host'
// 配置层（P0 收尾 S2 第一步）：HarnessConfig / 模型解析 / Provider 校验 / 各段配置检查 /
// ACP 档位翻译 / 配置概览。boot 直接依赖它们，故随 host 装配层一并上移；此处 import（本文件
// 内部仍在用）+ re-export（保持导出面逐字不变）。
import {
  resolveModelArg,
  formatResolutionRef,
  validateProviderConfigs,
  checkProviderConfigs,
  formatApiKeyTag,
  findTokenOnlyDuplicates,
  toAcpConfig,
  toAcpScope,
  toAcpScopeMap,
  checkCompressionConfig,
  resolveCompactionWindow,
  checkCompactionConfig,
  buildCompactionOptions,
  checkCompactionReachability,
  checkMemoryConfig,
  memoryPluginOptions,
  telemetryPluginOptions,
  checkTelemetryConfig,
  buildConfigOverview,
  formatProviderTypeList,
  buildProviderTypesSection,
} from '@harness/host'
import type { HarnessConfig, AcpScopeSection, ModelResolution, SessionEndpoint } from '@harness/host'
export {
  resolveModelArg,
  formatResolutionRef,
  validateProviderConfigs,
  checkProviderConfigs,
  formatApiKeyTag,
  findTokenOnlyDuplicates,
  toAcpConfig,
  toAcpScope,
  toAcpScopeMap,
  checkCompressionConfig,
  resolveCompactionWindow,
  checkCompactionConfig,
  buildCompactionOptions,
  checkCompactionReachability,
  checkMemoryConfig,
  memoryPluginOptions,
  telemetryPluginOptions,
  checkTelemetryConfig,
  buildConfigOverview,
  formatProviderTypeList,
  buildProviderTypesSection,
} from '@harness/host'
export type { HarnessConfig, AcpScopeSection, ModelResolution, SessionEndpoint } from '@harness/host'
import type { McpServerEntry } from '@harness/mcp-server-registry'
import { LifecycleEvents } from '@harness/core'
import { startTuiRepl } from './tui'
import {
  emptyUsage,
  sumUsage,
  usageFromMeta,
  usageFromMessages,
  renderStatsText,
  exportStatsJson,
  exportStatsMarkdown,
  hydrateUsage,
  isBlankUsage,
  cacheHitRate,
  todayUsageLine,
  type UsageStats,
} from './usage-stats'
import { formatAgentStatus, initialAgentStatus, reduceAgentStatus } from './agent-status'
import type { CompactOptions } from '@harness/session'
import { collectTodayUsage } from './usage-today'
import { reconstructHistory, buildResolveBlock, getSessionModelOverride, sessionModelMetaPatch, type Message, type Session, type SessionModelOverride, type HistoryLoadRange, type SessionOriginalStore, type CompactionBlock } from '@harness/session'
import { formatSkillSource } from '@harness/skill'
import type { ToolContext, Tool } from '@harness/tool'

import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { inspect } from 'node:util'

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
  /**
   * 关闭「启动时自动恢复上次会话」（默认开启）。
   * 开启时：不带 -s/--session 启动会接着当前工作目录里最近更新的会话继续；
   * `harness run "<prompt>"` 一次性执行不受影响（始终是新会话，除非显式 -s）。
   */
  noResume?: boolean
  /** 开启文件快照 + /revert 能力（cli 传入时覆盖 config.json 的 harness.snapshot） */
  snapshot?: boolean
  /** 以 TUI（alt-screen 全屏）模式启动 REPL */
  tui?: boolean
  /** 仅校验 config.json 配置并打印概览后退出 */
  checkConfig?: boolean
  showHelp?: boolean
  /** 允许加载外部插件目录里的代码（默认 false，防代码注入；等价于 config.json 的 allowPluginCode） */
  allowPluginCode?: boolean
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
    if (a === '--no-resume') { out.noResume = true; continue }
    // 代码注入防护：默认不加载外部插件代码，需显式开闸
    if (a === '--allow-plugin-code') { out.allowPluginCode = true; continue }
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
export { SessionPointerStore, LAST_SESSION_FILE, type SessionPointerFile } from '@harness/workspace'
export { ConfigStore, SecretCipher, ConfigValidationError, resolveSecret } from '@harness/workspace'

/** 全局配置（写 dataDir/config.json）与命令行参数合并、默认值收敛 */
// ------------------------------------------------------------------------
// 2. 配置层（HarnessConfig / AcpScopeSection / 模型解析 / Provider 校验 /
//    compression·compaction·memory·telemetry 段检查 / ACP 档位翻译 / 配置概览）
//    已上移到 @harness/host（P0 收尾 S2 第一步）—— boot 主体紧随其后也要上移，
//    而 host 不能反向 import cli，故这一层必须先动。
//    本文件顶部 import + re-export 保持导出面逐字不变（测试与 REPL /config 路径直接
//    import 这些符号）。注：`resolveConfig` 依赖 `CliArgs`，属 CLI 专属，留在本文件。
// ------------------------------------------------------------------------

/** 单个 Provider 定义（config.json 的 providers 数组元素）——复用 @harness/plugin 抽象层契约 */
export type { ProviderConfig } from '@harness/plugin'

// provider/model 规格解析与配置归一化（parseModelSpec / formatModel / ResolvedProviderConfig /
// sanitizeProviderId / ProviderConfigIssue / normalizeProviderConfigs）已上移到 @harness/host
// —— P0 第三步（B 档）。本文件顶部 import + re-export 保持导出面逐字不变。



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

// 2.2 / 2.2.1 / 2.2.2 三节（Provider 类型工厂注册表、内置通用插件注册表、内置工具
// 静态元信息注册表，连同它们共用的 lazyImport 入口）已上移到 @harness/host —— P0 第二步。
// 本文件顶部 import + re-export 保持导出面逐字不变（cli.test.ts 直接 import 这些符号）。

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

// 外部插件目录加载（PluginLoadResult / probeAgentPlugin / collectAgentPlugins /
// registerProviderTypeFactory / loadPluginDirs）已上移到 @harness/host，本文件顶部 re-export
// 保持导出面逐字不变。


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
  /**
   * 工作目录。启动时参数传入（CLI 上是 `-c/--cwd <dir>`）即以此为准；
   * **不传时取当前进程目录**（`process.cwd()`）。
   */
  cwd?: string
  /** 持久化目录。不传时取默认数据目录（`~/.harness`）；会话/配置/权限文件都在其下。 */
  dataDir?: string
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
  /**
   * 启动时自动恢复上次会话（默认 true，等价 config.autoResume）。
   * `harness run "<prompt>"` 一次性执行请显式传 false —— 脚本化调用不该悄悄接着上一个会话写。
   */
  autoResume?: boolean
  /** 是否启用 boot 末尾的后台静默预加载内置插件/工具（多级加载 L2，默认 true）。设为 false 关闭。 */
  backgroundPreload?: boolean
  /**
   * 允许加载外部插件目录里的**代码**（默认 false）。
   * 等价于 config.json 的 `allowPluginCode`；两者任一为真即开闸（CLI 参数优先）。
   * 关闭时插件目录里的文件只被登记、不 import —— 防止克隆来的仓库借 `.harness/plugins` 执行代码。
   */
  allowPluginCode?: boolean
}

/** boot() 的会话决策结果，供 REPL/TUI 提示（「已恢复上次会话」/「为何没恢复」） */
export interface SessionRestoreInfo {
  /** explicit：`-s/--session` 指定；auto：自动恢复最近会话；new：新建 */
  source: 'explicit' | 'auto' | 'new'
  sessionId: string
  /** source=auto 时：该会话的消息条数 */
  messageCount?: number
  /** source=auto 时：该会话最后更新时间（ms） */
  updatedAt?: number
  /**
   * 被跳过的「最近会话」：它属于其它工作目录（或自动恢复已关闭）。
   * 明确记录是为了让「为什么这次没接着上次」有答案，而不是让用户对着空会话猜。
   */
  skipped?: { id: string; cwd?: string; updatedAt: number; reason: 'other-cwd' | 'disabled' }
}

/** 相对时间描述（仅用于「上次会话是多久以前」这类提示） */
export function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/**
 * 「本次启动如何决定当前会话」的一句话说明（REPL 与 TUI 共用文案）。
 * 无提示（新会话且无跳过项）时返回空串。
 */
export function describeSessionRestore(restore: SessionRestoreInfo, now = Date.now()): string {
  if (restore.source === 'auto') {
    const ago = formatAgo(now - (restore.updatedAt ?? 0))
    return `已自动恢复上次会话 ${restore.sessionId}（${restore.messageCount ?? 0} 条消息${ago ? `，${ago}` : ''}）；/new 开新会话 · --no-resume 关闭自动恢复`
  }
  if (restore.skipped?.reason === 'other-cwd') {
    const s = restore.skipped
    return `未自动恢复会话 ${s.id}：它属于其它工作目录（${s.cwd ?? '未记录'}）；要用它：/resume ${s.id}`
  }
  return ''
}

export class HarnessApp {
  /** 工作区布局（两级目录 + 数据文件路径），由 cwd/dataDir 解析而得 */
  public readonly workspace: Workspace
  public readonly sessionStore: SessionFileStore
  /**
   * 项目级「上次会话」指针（`<cwd>/.harness/last-session.json`）。
   * 自动恢复的会话 id 记在**当前工作目录**里，见 findResumeTarget / rememberSession。
   */
  public readonly sessionPointer: SessionPointerStore
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
  /**
   * boot() 装载的 Provider 配置（CLI options.providers 优先，其次 config.json providers），
   * 已归一化（id 必定存在）——供 /model ? 展示，也是 /model 解析实例的直接数据源。
   */
  private loadedProviders: ResolvedProviderConfig[] = []
  /** boot() 的会话决策结果（explicit / auto / new），供 REPL、TUI 提示用。每次 boot 覆盖。 */
  sessionRestore: SessionRestoreInfo = { source: 'new', sessionId: '' }
  /**
   * 引擎侧运行时告警（如「system 区前缀变化 ⇒ 缓存整段重算」）的可挂载出口。
   *
   * TUI 会挂一个 sink：OpenTUI 接管 stdout 做布局排版，而 boot 里 `logger.warn/error`
   * 默认直写 `stdout` —— 引擎每轮跑出的告警会**混进渲染字符流、把 UI 排错位**（用户反馈）。
   * 挂上 sink 后，TUI 的 `warn/error` 改走应用层（渲染成 console 块）；headless/REPL
   * 不挂 sink，行为不变（仍写 stdout）。
   */
  private logSink?: (level: 'warn' | 'error', msg: string, meta?: unknown) => void
  /** 挂载/卸载命令日志出口（TUI 用；传 undefined 卸载，回到写 stdout）。 */
  setLogSink(fn: ((level: 'warn' | 'error', msg: string, meta?: unknown) => void) | undefined): void {
    this.logSink = fn
  }
  /** 引擎告警统一出口：有 sink 走应用层（TUI console 块），否则写 stdout（headless/REPL）。 */
  private emitLog(level: 'warn' | 'error', msg: string, meta?: unknown): void {
    const line = `[${level.toUpperCase()}] ${msg}${meta !== undefined ? ' ' + JSON.stringify(meta) : ''}\n`
    if (this.logSink) this.logSink(level, msg, meta)
    else this.options.stdout?.write?.(line)
  }

  constructor(options: HarnessAppOptions) {
    // 工作目录：**启动参数传入即用传入值，未传才取当前进程目录**（dataDir 同理，未传取默认数据目录）。
    // 统一交给 resolveWorkspace 解析，避免「谁先算 cwd」两处各算一遍导致口径不一致。
    this.workspace = resolveWorkspace({ cwd: options.cwd, dataDir: options.dataDir })
    const cwd = this.workspace.cwd
    this.options = {
      ...options,
      cwd,
      dataDir: this.workspace.dataDir,
      agentId: options.agentId,
      provider: options.provider,
      // 未注入输出流时落到真实 stdout：否则 logger 的 [WARN]/[ERROR] 会被静默丢掉
      // （如「md 未声明 tools，按只读兜底」「内置插件预加载失败」——用户永远看不到）。
      stdout: options.stdout ?? process.stdout,
    }
    this.sessionStore = new SessionFileStore(this.workspace)
    this.sessionPointer = new SessionPointerStore(this.workspace)
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

  /** 默认 Agent 定义（无 agent 指定时使用）；含 CLI/config 解析出的默认模型。
   *  提示词文本存放于 prompts/default-agent.txt（参考 opencode：prompt 独立成文件，import 加载），
   *  便于直接编辑文本而不改代码。 */
  defaultAgent(): AgentDefinition {
    const def: AgentDefinition = {
      id: this.options.agentId,
      name: 'Harness Agent',
      description: 'CLI 默认 Agent',
      mode: 'primary',
      tools: ['*'],
      permission: { '*': 'ask' },
      systemPrompt: defaultAgentPrompt.trim(),
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
      // source=config + overlay：这是文档化覆盖链的最后一环（会覆盖 options / dir 来源的同名定义），
      // 属于正常路径 ⇒ 只发 agent.reregistered（from/to 带来源）不打 WARN。
      harness.agent.register(merged, { source: 'config', overlay: true })
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
    // source=cli.tools：与启动回读（source=config）区分开，归因时能看出"这次是 /tools 干的"；
    // overlay：用户显式操作，只发事件不打 WARN。
    const existing = this.harness?.agent?.get?.(agentId)
    if (existing) this.harness!.agent.register({ ...existing, tools: [...tools] }, { source: 'cli.tools', overlay: true })
  }

  /** 读取 config.json 的 mcpServers 列表（缺省 []） */
  async getMcpServers(): Promise<McpServerEntry[]> {
    const cfg = await this.configStore.load()
    return [...(cfg.mcpServers ?? [])]
  }

  /**
   * 持久化 mcpServers 列表到 config.json（upsert 顶层 mcpServers）。供 mcp-server-registry 的
   * /mcp 命令在启用/禁用/增删后写回；重启后由 boot 阶段经 cli.mcp.configure 重新注入生效。
   */
  async setMcpServers(list: McpServerEntry[]): Promise<void> {
    const cfg = await this.configStore.load()
    await this.configStore.save({ ...cfg, mcpServers: [...list] })
  }

  /**
   * 把 config.json 的 mcpServers 应用到运行时：createHarness 后、core.harness.start 前触发
   * cli.mcp.configure Hook，注入 mcp-server-registry 插件（按 enabled 开关在 start 时连接）。
   *
   * 该 hook 已在 @harness/plugin 的 `Hooks` 里声明 ⇒ 不再需要 `as any` 绕过类型
   * （此前调用点用 `(harness.plugin as any)?.trigger?.(...)`，hook 名写错也不会报错）。
   * `harness.plugin` 由 createHarness 建好，可空断言仅为防手写 Harness 桩。
   */
  async applyMcpServers(harness: Harness): Promise<void> {
    const cfg = await this.configStore.load()
    const list = [...(cfg.mcpServers ?? [])]
    await harness.plugin?.trigger('cli.mcp.configure', { mcpServers: list })
  }

  /**
   * 当前生效模型展示（`provider/model`）：优先读取活动 Agent 定义的 model，回退 options.model。
   * 只绑定了 provider、未指定 model 时显示 `<provider>/(默认模型)`——让 /model 输出不至于空着。
   */
  getModel(agentId: string): string | undefined {
    const a = this.harness?.agent?.get?.(agentId)
    if (a?.model?.providerId) return formatModel(a.model.providerId, a.model.modelId) ?? `${a.model.providerId}/(provider 默认模型)`
    if (a?.model?.modelId) return a.model.modelId
    return this.options.model
  }

  /**
   * 「本会话实际会用的模型」展示标签 —— 优先级与 core 的解析链严格一致：
   * 会话级覆盖（Session.meta.model）> Agent 定义 > 启动参数 -m > Provider 默认模型。
   */
  resolveSessionModel(session: Pick<Session, 'agentId' | 'meta'> | undefined): string | undefined {
    const ov = getSessionModelOverride(session)
    if (ov) {
      if (ov.providerId) return formatModel(ov.providerId, ov.modelId) ?? `${ov.providerId}/(provider 默认模型)`
      return ov.modelId
    }
    return this.getModel(session?.agentId ?? this.options.agentId)
  }

  /**
   * 本会话**实际端点**（`providerId` / `modelId`）—— `resolveSessionModel` 的 id 版。
   *
   * 为什么另开一个而不是复用展示标签：标签是 `provider/model` 的合串（还可能带
   * `/(provider 默认模型)` 这类文案），拿它去查窗口表只会永远 miss；这里给的是查表要的原始字段。
   *
   * 解析链与 core `_prepareQueryOnce` 严格一致（`input.model?.providerId ?? agent.model?.providerId`）：
   * 会话级覆盖（`Session.meta.model`）> Agent 定义 model。**注意**：覆盖里只写了 modelId 时
   * providerId 仍回落到 Agent 定义，与 core 同；两边都解析不出就返回空对象，由查表侧落
   * fallback（= 默认 Provider 的窗口），与改造前逐位相同。
   */
  resolveSessionEndpoint(session: Pick<Session, 'agentId' | 'meta'> | undefined): SessionEndpoint {
    const ov = getSessionModelOverride(session)
    const a = this.harness?.agent?.get?.(session?.agentId ?? this.options.agentId)
    const providerId = ov?.providerId ?? a?.model?.providerId
    const modelId = ov?.modelId ?? a?.model?.modelId
    return { ...(providerId ? { providerId } : {}), ...(modelId ? { modelId } : {}) }
  }

  /** 当前会话的模型覆盖（undefined = 未覆盖，跟随 Agent 定义与全局默认） */
  sessionModelOverride(session: Pick<Session, 'meta'> | undefined): SessionModelOverride | undefined {
    return getSessionModelOverride(session)
  }

  /**
   * 写「会话级模型覆盖」并立即落盘：只影响本会话，**不动** Agent 定义、**不写** config.json。
   * `override` 传 undefined 即清除覆盖（回落该 Agent 的默认模型）。
   *
   * 为什么必须落盘：重启后「自动恢复上次会话」要把这个选择一起带回来，
   * 否则用户每次重启都得重新切一遍模型。
   */
  async setSessionModel(session: Session, override: SessionModelOverride | undefined): Promise<Session> {
    await this.harness.session.updateMeta(session.id, sessionModelMetaPatch(override))
    const fresh = (await this.harness.session.get(session.id)) ?? session
    await this.sessionStore.save(fresh)
    return fresh
  }

  /** 解析指定 providerId 在当前 harness 实际命中的 ChatProvider；未装配的 provider 会回退到默认 Provider */
  resolveChatProvider(providerId?: string): ChatProvider | undefined {
    const h = this.harness as { resolveChatProvider?: (id?: string) => ChatProvider } | undefined
    return h?.resolveChatProvider?.(providerId)
  }

  /** 当前已配置的 Provider 实例（归一化后，id 必有）；供 /model 解析与展示 */
  configuredProviders(): ResolvedProviderConfig[] {
    return this.loadedProviders.length ? this.loadedProviders : normalizeProviderConfigs(this.options.providers ?? []).providers
  }

  /**
   * 运行时切换模型（兼容入口）：接受 `/model` 的全部写法（序号 / 实例 id / 模型名 / `provider/model`）。
   * 解析不成立（歧义、序号越界、拼错）时返回 false，不产生任何副作用。
   */
  async setModel(agentId: string, spec: string): Promise<boolean> {
    const r = resolveModelArg(spec, this.configuredProviders(), this.providerTypes.list())
    switch (r.kind) {
      case 'instance':
        // 命中实例：provider 与其配置的 model 一并生效；实例未声明 model 时清空 modelId，
        // 交由该 Provider 的默认模型接管（避免把上一个模型的 id 带到新 Provider）
        return this.applyModel(agentId, r.providerId, r.modelId, { replaceModel: true })
      case 'explicit':
        return this.applyModel(agentId, r.providerId, r.modelId, { replaceModel: true })
      case 'model':
        return this.applyModel(agentId, undefined, r.modelId)
      default:
        return false
    }
  }

  /**
   * 落地一次模型切换：更新 Agent 的 model 覆盖 + 持久化到 config.json。
   * `replaceModel`：即使 modelId 为空也覆盖（并删除旧的 modelId），用于「切到某实例」的语义。
   */
  private async applyModel(
    agentId: string,
    providerId: string | undefined,
    modelId: string | undefined,
    opts: { replaceModel?: boolean } = {},
  ): Promise<boolean> {
    const a = this.harness?.agent?.get?.(agentId)
    if (!a) return false
    const next = { ...(a.model ?? {}) }
    if (providerId) next.providerId = providerId
    if (modelId) next.modelId = modelId
    else if (opts.replaceModel) delete next.modelId
    a.model = next
    // provider 与 model 同步落盘：保证 config.provider/model 与运行时一致。
    // （旧实现只在 `provider/` 前缀命中时改 provider，会出现 provider 指向 A、model 属于 B 的不自洽配置。）
    const cfg = await this.configStore.load()
    const nextCfg: HarnessConfig = { ...cfg, ...(providerId ? { provider: providerId } : {}) }
    if (modelId) nextCfg.model = modelId
    else if (opts.replaceModel) delete nextCfg.model
    await this.configStore.save(nextCfg)
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
    // config / CLI 定义的 Provider 实例 id 优先（已归一化：省略 id 的项也已按 model 派生）
    for (const pc of this.configuredProviders()) if (!ids.includes(pc.id)) ids.push(pc.id)
    // 默认 provider（mock/anthropic 或自定义）放最前
    const def = this.options.provider ?? 'anthropic'
    if (!ids.includes(def)) ids.unshift(def)
    // 合并注册表里已注册的 Provider 类型（内置 + 外部插件自定义 type，来自 providerTypes）
    for (const t of this.providerTypes.list()) if (!ids.includes(t)) ids.push(t)
    return ids
  }

  /**
   * 启动装载的 Provider 实例配置（含各自默认/附加模型），供 /model ? 展示。
   * `index` 为 1-based 列表序号，用户可直接 `/model <序号>` 选择。
   *
   * `keyTag`：apiKey 展示标签。**仅当该实例与别的实例「type+baseUrl+model 全同」时才附指纹**
   * （`已配置(…AB12)`），因为只有这种情况下列表行会完全一样、只能靠 token 区分；其余场景保持简洁。
   *
   * `source`：实例在**运行期注册表**里的来源（`plugin:provider.anthropic` / `legacy` / `runtime` …）。
   * 与 config 侧的配置意图是两件事：配置说「我想要这个端点」，source 说「谁把它装了上去」——
   * 只有后者能区分「配置写了但压根没装配」（`未注册`）。
   * boot 前（harness 未建）不做交叉，此时不带 source（展示层也就不会有来源列）。
   */
  listConfiguredProviders(): Array<{
    index: number
    id: string
    model?: string
    baseUrl?: string
    apiPath?: string
    type?: string
    keyTag?: string
    source?: string
  }> {
    const dupIds = new Set(findTokenOnlyDuplicates(this.loadedProviders).flatMap((g) => g.members.map((m) => m.id)))
    // 老宿主 / 测试桩可能没有 providers 视图 ⇒ 可选链，取不到就不交叉（等于 boot 前的行为）
    const runtime = (this.harness as Harness | undefined)?.providers?.list?.()
    const sourceById = new Map((runtime ?? []).map((p) => [p.id, p.source]))
    return this.loadedProviders.map((p, i) => ({
      index: i + 1,
      id: p.id,
      model: p.model,
      baseUrl: p.baseUrl,
      apiPath: p.apiPath,
      type: p.type,
      ...(runtime ? { source: sourceById.get(p.id) ?? '未注册' } : {}),
      ...(dupIds.has(p.id) ? { keyTag: formatApiKeyTag(p.apiKey, { fingerprint: true }) } : {}),
    }))
  }

  /**
   * 「同端点同模型」实例组（同配置不同 token / 完全重复）——供 /model ? 提示：
   * 这类实例的 id 是从 model 派生的（`-2`/`-3`），与数组顺序绑定，调整顺序会让
   * `config.provider` 悄悄指到另一个 token，因此建议显式写 id。
   */
  tokenOnlyDuplicateGroups(): ReturnType<typeof findTokenOnlyDuplicates> {
    return findTokenOnlyDuplicates(this.loadedProviders)
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
    // 2) 默认 Provider 的**实例只构造一次**（放在这一段的末尾，见下方 `chosenProvider`）。
    // 默认由谁担当**不再由注册顺序决定** —— 构造完所有实例后显式 `providers.setDefault(...)`。
    // ------------------------------------------------------------------
    const cfg = await this.configStore.load()
    const rawProviderConfigs = this.options.providers?.length ? this.options.providers : (cfg.providers ?? [])
    // 归一化：把可选的 id 补全为唯一实例 id（缺省由 model 派生、重名自动加序号）。
    // 之后所有环节（装配 / 路由 / 校验 / 展示）都按「id 必定存在」处理，无需到处判空。
    const normalized = normalizeProviderConfigs(rawProviderConfigs)
    this.loadedProviders = normalized.providers
    const defaultProviderId = this.options.provider ?? cfg.provider ?? 'anthropic'

    // 加载外部插件（user ~/.harness/plugins → project .harness/plugins，后加载覆盖先加载）：
    // 通用 AgentPlugin 汇总到 externalPlugins 参与 Hooks 生命周期；Provider 类型工厂注册进 providerTypes 供 config.type 动态解析
    // 路径统一来自解析好的 workspace（dataDir 支持 --data-dir 覆盖，非写死 $HOME）
    // 代码注入防护：默认**不执行**插件目录里的代码（只登记告警），需 allowPluginCode 显式开闸
    const externalPlugins = await loadPluginDirs(this.providerTypes, [
      { dir: this.workspace.user.plugins, source: 'user' },
      { dir: this.workspace.project.plugins, source: 'project' },
    ], (s) => this.options.stdout?.write?.(s + '\n'), {
      allowCode: this.options.allowPluginCode ?? cfg.allowPluginCode ?? false,
    })

    // 显式校验 + 密钥解析（错误一次性汇总，避免静默跳过/误导）
    const cipher = new SecretCipher(this.workspace)
    const configIssues: string[] = []
    // 归一化阶段的问题（id 重复 / id 与 model 均缺失）优先上报，避免后续就着残缺配置继续跑
    for (const iss of normalized.issues) configIssues.push(iss.message)
    const providerConfigs: ResolvedProviderConfig[] = []
    for (const [index, pc] of normalized.providers.entries()) {
      try {
        providerConfigs.push({ ...pc, apiKey: await resolveSecret(pc.apiKey, cipher) })
      } catch (err: any) {
        configIssues.push(`providers[${index}]（id=${pc.id}）：${err?.message ?? String(err)}`)
      }
    }
    for (const iss of validateProviderConfigs(normalized.providers, defaultProviderId, this.providerTypes.list())) {
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
    /**
     * 实际装配为默认的**实例 id**（= 注册键）—— 供下面显式 `providers.setDefault` 用。
     *
     * 刻意不复用展示用的 `cpId`：两者口径不同 ——
     * `cpId` 说的是**配置意图**（config.json → provider），这里说的是**实际装配的事实**。
     * 无 ANTHROPIC_API_KEY 时配置意图是 anthropic、实际装配的是 mock；此时若拿意图去
     * `setDefault('anthropic')` 会抛「未注册」——正是要避免的静默/误导。
     */
    let chosenProviderId: string

    // 1) 其他（非默认）Provider
    const builtIds = new Set<string>()
    const pushBuilt = (plugin: AgentPlugin | undefined, id: string) => {
      if (!plugin || builtIds.has(id)) return
      builtIds.add(id)
      providerPlugins.push(plugin)
    }
    for (const pc of providerConfigs) {
      // 默认实例只在下面构造一次（避免同一 id 出现两个实例、互相覆盖注册键）
      if (defaultPc && pc.id === defaultPc.id) continue
      pushBuilt(await this.buildProviderPlugin(pc), pc.id)
    }

    // 2) 默认 Provider 的实例
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
        chosenProviderId = 'mock'
      } else {
        chosenProvider = plugin as any
        chosenProviderId = defaultPc.id
      }
    } else if (defaultProviderId === 'mock') {
      chosenProvider = await lazyMockProvider({
        defaultResponse: '(Mock Provider) 你好，我是测试助手。',
        ...(this.options.mockProviderConfig ?? {}),
      })
      chosenProviderId = 'mock'
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
        chosenProviderId = 'anthropic'
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
        chosenProviderId = 'mock'
      } else {
        this.options.stdout?.write?.(
          'ℹ️  未配置 ANTHROPIC_API_KEY，自动 fallback 到 Mock Provider。\n' +
          '   如要使用真实 Claude，请 export ANTHROPIC_API_KEY=xxx。\n\n'
        )
        chosenProvider = await lazyMockProvider({
          defaultResponse: '(Mock Provider) 你好，我是测试助手。',
          ...(this.options.mockProviderConfig ?? {}),
        })
        chosenProviderId = 'mock'
      }
    }
    providerPlugins.push(chosenProvider)
    // 明确输出启动时装配的默认 Provider（不触碰 lazy getter，直接用已解析的配置信息）
    const cpId = defaultProviderId === 'mock'
      ? 'mock'
      : defaultPc?.id ?? 'anthropic'
    const cpLabel = cpId === 'mock' ? '（测试 Mock）' : defaultPc?.type ? `（type=${defaultPc.type} · model=${parseModelSpec(this.options.model ?? '').modelId || defaultPc.model}）` : ''
    this.options.stdout?.write?.(
      `✅ 默认 Provider: ${cpId}${cpLabel}\n` +
      (defaultProviderId !== cpId ? `   config.json → provider="${defaultProviderId}"，实际装配 "${cpId}"。\n` : '') +
      `   /model 命令可切换；若 "当前模型" 仍显示 Mock，请重启 CLI 使配置生效。\n\n`
    )
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
    // 内置插件声明式启用（config.json → plugins）：与外部插件目录并列的第二条装配路径，
    // 让「只想开个内置能力」的用户改一行配置即可（依赖闭包自动补齐，如 computer-use → mcp.server-registry）。
    // 这里只解析实例，实际入列在外部插件之后（见下方按 id 去重），避免与 .harness/plugins 里的同 id 重复安装。
    const declaredPlugins = await resolveBuiltinPlugins(cfg.plugins)
    if (declaredPlugins.unknown.length) {
      this.options.stdout?.write?.(
        `[WARN] config.json → plugins 有未生效项：${declaredPlugins.unknown.join('、')}\n` +
        `       可用内置插件：${getBuiltinRegistry().list().map((p) => p.id).join(' / ')}\n`,
      )
    }
    // ACP 上下文压缩：config.json → compression.enabled 为真时才惰性装配 @harness/acp-context。
    // 上下文窗口推导优先级：compression.modelContextLimit → 默认 Provider 的 contextWindowTokens → 插件默认 200_000；
    // t1/t2/t3 阈值与层保留从结构化字段翻译进 kernel config。
    const compression = cfg.compression
    // 未生效项告警（未知键被静默丢弃 / tokenCalibration 拼错静默降级）：
    // 放在 enabled 判断之外 —— 开关关着时恰好是「照抄参数表却怎么也不生效」最常发生的场景。
    const compressionIssues = checkCompressionConfig(compression)
    if (compressionIssues.length) {
      this.options.stdout?.write?.(
        `[WARN] config.json → compression 有以下未生效项：\n` +
          compressionIssues.map((m) => `       - ${m}`).join('\n') +
          '\n',
      )
    }
    // 会话压缩（另一套机制）：同样会因未知键 / 拼错取值静默失效；
    // 额外的「阈值 ≥ 窗口 ⇒ 永不触发」检查尤其重要 —— 它没有任何其它症状。
    const compactionIssues = checkCompactionConfig(cfg.compaction)
    const compactionUnreachable = checkCompactionReachability(cfg, defaultProviderId)
    if (compactionIssues.length || compactionUnreachable) {
      const all = compactionUnreachable ? [...compactionIssues, compactionUnreachable] : compactionIssues
      this.options.stdout?.write?.(
        `[WARN] config.json → compaction 有以下问题：\n` + all.map((m) => `       - ${m}`).join('\n') + '\n',
      )
    }
    if (compression?.enabled) {
      const acp = await lazyImport<{ createAcpContextPlugin: (o?: any) => AgentPlugin }>('@harness/acp-context')
      // 与档位段（`subagent` / `perAgent`）**共用同一份翻译**：此前顶层在这里内联写一遍、
      // 档位那边再写一遍，两套语法一旦漂移就是"顶层这么写生效、档位那样写不生效"。
      const acpConfig = toAcpConfig(compression)
      // 遥测默认开启：每轮 preModel 追加 dataDir/sessions/{sessionId}.telemetry.jsonl
      const telemetryEnabled = compression.telemetry?.enabled !== false
      const sessionsDir = join(this.workspace.dataDir, 'sessions')
      providerPlugins.push(acp.createAcpContextPlugin({
        // 只传「用户显式指定」的窗口（`compression.modelContextLimit`），压过按端点的推导。
        // 缺省刻意留 undefined —— 若把默认 Provider 推导出的窗口塞进这里，它会在窗口解析链上
        // 截胡，下面那条按端点分化的腿永远走不到（那正是本次要修的 bug）。
        modelContextLimit: compression.modelContextLimit,
        // 占用率分母按**本会话实际用的端点**解析：子 Agent 常被派到另一个 Provider（也可被
        // `SubagentTool.model` 逐次覆盖），两端窗口不同时分母必须跟着走。都查不到时回落
        // `fallback` = 改造前那个数，故缺省行为逐位不变。
        providerWindows: buildProviderWindowTable(cfg, defaultProviderId),
        systemPrompt: compression.systemPrompt,
        prompts: compression.prompts as any,
        config: acpConfig as any,
        // autoTune：按窗口推导 compression/nudge 参数（显式字段仍优先，见 compression.autoTune 注释）
        autoTune: compression.autoTune === true,
        // token 折算口径：缺省 auto（CJK 感知），与内核内部计数共用同一函数
        tokenCalibration: compression.tokenCalibration,
        tokenCalibrationScale: compression.tokenCalibrationScale,
        // 压缩提示注入策略（顶层）。另有一条能力判据与它叠加：该 Agent 白名单里确实没有
        // compress 时一律不注入（只读 worker 拿着手册只会去撞 TOOL_NOT_ALLOWED）。
        manualInjection: compression.manualInjection,
        // 作用域档位：subagent（按 parentId，即子会话）/ perAgent（按 agent id）。
        // 两者都不配置时不传 ⇒ 插件侧不叠加，缺省行为与改造前逐位一致。
        subagent: toAcpScope(compression.subagent) as never,
        perAgent: toAcpScopeMap(compression.perAgent) as never,
        telemetryEnabled,
        telemetryPathBuilder: telemetryEnabled
          ? (sessionId: string) => join(sessionsDir, `${sessionId}.telemetry.jsonl`)
          : undefined,
      }))
    }
    // 其余能力一律通过外部插件目录（~/.harness/plugins、.harness/plugins）可插拔加载，
    // CLI 不做硬编码依赖（避免依赖倒置）：此处 externalPlugins 来自 loadPluginDirs（user → project）。
    if (externalPlugins.plugins.length) providerPlugins.push(...externalPlugins.plugins)
    // 长期记忆：`plugins: ["memory"]` 启用，`memory` 段覆盖参数 —— 目前唯一"带参装配"的内置插件。
    //
    // 位置刻意是「外部插件目录之后、declaredPlugins 之前」：外部插件已入列 ⇒ 下面的按 id 去重会
    // 跳过注册表那份（保持"外部插件目录优先"的既有语义，便于临时替换实现）；参数则来自 config.json，
    // 不在组合根写死 —— 与 compression → acp-context 同一模式，不违背"无参工厂"的初衷。
    const memoryCfg = cfg.memory
    const memoryDeclared = (cfg.plugins ?? []).some((id) => String(id).trim() === 'memory')
    if (memoryDeclared && !providerPlugins.some((p) => p.id === 'memory')) {
      const memoryMod = await lazyImport<{ createMemoryPlugin: (o?: Record<string, unknown>) => AgentPlugin }>(
        '@harness/memory',
      )
      providerPlugins.push(memoryMod.createMemoryPlugin(memoryPluginOptions(memoryCfg)))
    } else if (memoryCfg && !memoryDeclared) {
      this.options.stdout?.write?.(
        '[WARN] config.json 写了 memory 段，但没有启用记忆（plugins 里加 "memory"）⇒ 该段不会生效\n',
      )
    }
    const memoryIssues = checkMemoryConfig(memoryCfg)
    if (memoryIssues.length) {
      this.options.stdout?.write?.(
        `[WARN] config.json → memory 有以下问题：\n` + memoryIssues.map((m) => `       - ${m}`).join('\n') + '\n',
      )
    }
    // 通用遥测：config.json → telemetry 段存在才装配 @harness/telemetry（默认零影响）。
    // 会话级 JSONL 采集（bus 事件 → 统一 envelope）+ 崩溃兜底。dataDir 用 CLI 实际 workspace，
    // 避免路径口径分裂（--data-dir 时 core 自推导会拼错目录）。
    const telemetryOpts = telemetryPluginOptions(cfg.telemetry)
    if (telemetryOpts) {
      const telMod = await lazyImport<{
        createTelemetryService: (o?: Record<string, unknown>) => { plugin: AgentPlugin }
      }>('@harness/telemetry')
      providerPlugins.push(
        telMod.createTelemetryService({ dataDir: this.workspace.dataDir, ...telemetryOpts }).plugin,
      )
    }
    const telemetryIssues = checkTelemetryConfig(cfg.telemetry)
    if (telemetryIssues.length) {
      this.options.stdout?.write?.(
        `[WARN] config.json → telemetry 有以下问题：\n` + telemetryIssues.map((m) => `       - ${m}`).join('\n') + '\n',
      )
    }
    // config.json → plugins 声明的内置插件：与外部插件目录按 id 去重（外部插件目录优先，便于临时替换实现）
    if (declaredPlugins.plugins.length) {
      const present = new Set(providerPlugins.map((p) => p.id))
      for (const p of declaredPlugins.plugins) if (!present.has(p.id)) providerPlugins.push(p)
    }
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
      // 工作区路径视图交给插件（记忆/技能目录定位）：CLI 的 dataDir 可能来自 --data-dir，
      // 让 core 自己 resolve 会算错 ⇒ 传实际 workspace，避免路径口径分裂。
      workspace: this.workspace,
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
      // token 折算口径：与 acp-context 传的是**同一个值**（引擎侧用量估算与 ACP 占用率闸门
      // 必须用同一把尺子，否则"本地 vs provider"的偏差无法归因）
      tokenCalibration: compression?.tokenCalibration,
      tokenCalibrationScale: compression?.tokenCalibrationScale,
      snapshot: this.snapshotService ? () => this.snapshotService! : undefined,
      // 上下文压缩·阶段二（Route B）：宿主注入原文档案存储器，compact 裁剪前把被压缩窗口原文落盘到
      // sessions/{id}.cmp.orig/，供惰性 loader 按块还原全文（内存瘦身 + 全文可回溯）。
      originalStore: createWorkspaceOriginalStore(this.workspace),
      logger: {
        info: (msg, meta) => this.options.verbose
          ? this.options.stdout?.write?.(`[INFO] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`)
          : undefined,
        warn: (msg, meta) => this.emitLog('warn', msg, meta),
        error: (msg, meta) => this.emitLog('error', msg, meta),
        debug: (msg, meta) => this.options.verbose
          ? this.options.stdout?.write?.(`[DEBUG] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`)
          : undefined,
      },
    })
    // 显式指定默认 Provider —— 不再依赖「最后注册赢」的注册顺序。
    // 各 Provider 插件在 core.harness.init 里只 register、不 setDefault（默认是组合根的决定），
    // 这样「只追加一个实例、不动默认」才成为可能。见 docs/runtime-registration-plan.md §2.1/§2.2。
    if (harness.providers.get(chosenProviderId)) {
      harness.providers.setDefault(chosenProviderId)
    } else {
      // 不静默：setDefault 是唯一入口，落空说明「装配」与「预期默认」不一致
      this.options.stdout?.write?.(
        `[WARN] 默认 Provider "${chosenProviderId}" 未注册为实例；已回退 resolve() 默认链` +
        `（首个已注册 → 构造期 Provider）。\n`,
      )
    }
    // 回读 config.json 的 agents[] 覆盖（tools 白名单 + mcpServers/excludeMcpServers）到已注册 Agent（createHarness 全部组装完成后、query 前）
    await this.applyConfigAgentOverrides(harness)
    // 把 config.json 的 mcpServers 注入 mcp-server-registry 插件（在 start 前建立配置态，
    // 由 core.harness.start 按 enabled 开关连接外部 MCP server）。
    await this.applyMcpServers(harness)
    await harness.start()
    this.harness = harness

    // 多级加载 L2：boot 末尾后台静默预加载内置插件/工具（fire-and-forget，
    // allSettled，失败仅记录日志，不阻塞 boot、不向上抛错）。
    this.scheduleBuiltinPreload()

    // 会话：显式指定 > 自动恢复上次 > 新建
    const sm = harness.session
    let session: Session
    const sid = this.options.sessionId
    if (sid) {
      const saved = await this.sessionStore.load(sid)
      if (saved) {
        session = await this.restoreSession(saved)
        this.sessionRestore = {
          source: 'explicit',
          sessionId: session.id,
          messageCount: saved.messages.length,
          updatedAt: saved.updatedAt,
        }
      } else {
        // 指定了 id 但磁盘上不存在：沿用原语义建一个「同名」会话（用于预置 id 的场景）
        session = await sm.create({ title: sid, agentId: this.options.agentId, cwd: this.options.cwd })
        await sm.setId(session.id, sid)
        this.sessionRestore = { source: 'explicit', sessionId: session.id }
      }
    } else {
      const pick = await this.pickResumeCandidate()
      if (pick.kind === 'hit') {
        session = await this.restoreSession(pick.saved)
        this.sessionRestore = {
          source: 'auto',
          sessionId: session.id,
          messageCount: pick.item.messageCount,
          updatedAt: pick.item.updatedAt,
        }
      } else {
        session = await sm.create({ agentId: this.options.agentId, cwd: this.options.cwd })
        this.sessionRestore = { source: 'new', sessionId: session.id, ...(pick.skipped ? { skipped: pick.skipped } : {}) }
      }
    }
    await this.sessionStore.save(session)
    // 记下「本工作目录下次要恢复的会话」：无论是显式 -s、自动恢复还是新建，
    // 都要把指针指向本次实际在用的这条，否则下次启动会回到更早的会话。
    await this.rememberSession(session)

    return { harness, session }
  }

  /**
   * 把磁盘会话还原为运行中的 Session。
   *
   * SessionManager 接口没有批量 restore，只能 `create` 一个新会话 → 逐条 `addMessage`
   * → 再 `setId` 把临时 id 换成磁盘里的原 id（setId 会同步内部索引键）。
   * boot 的显式恢复与 `/resume` 共用这一份实现，避免两处各写一遍、各自漏掉压缩块。
   */
  async restoreSession(saved: SessionFile): Promise<Session> {
    const sm = this.harness.session
    const session = await sm.create({
      title: saved.title,
      agentId: saved.agentId,
      cwd: saved.cwd ?? this.options.cwd,
      meta: saved.meta,
      ...(saved.parentId ? { parentId: saved.parentId } : {}),
    })
    for (const m of saved.messages) await sm.addMessage(session.id, m)
    await sm.setId(session.id, saved.id)
    // 上下文压缩·阶段二（Route B）：恢复压缩块并注册惰性加载器，供 /history 等按需读盘还原被压缩原文
    if (saved.blocks?.length) {
      session.blocks = saved.blocks
      sm.setHistoryLoader(session.id, { load: (s, range) => this.loadFullHistory(s, range) })
    }
    return session
  }

  /**
   * 找出「本工作目录上次用的会话」。
   *
   * 判定顺序：
   * 1. **项目级指针** `<cwd>/.harness/last-session.json`（权威）。会话 id 就写在当前工作
   *    目录里，所以「哪个目录恢复哪条会话」由文件位置决定——不需要拿 cwd 字符串互相比对，
   *    符号链接 / 相对路径 / 大小写差异都不会让判定漂移，也不会跨目录串台。
   *    指针另带 `dataDir`：同一 cwd 换 `--data-dir` 启动时，sessionId 撞号也不会把
   *    另一个 dataDir 的会话恢复出来（旧指针无该字段 → 兼容照常返回）。
   * 2. **兜底**：全局 sessions 里 cwd 与本目录一致的最新一条。只为兼容「指针出现之前建的
   *    会话」；命中后 boot 会把它写进指针，此后一律走 1。
   *
   * 两处返回 undefined 的语义都是「本目录没有可恢复的会话」，调用方按新建处理。
   */
  async findResumeTarget(): Promise<
    { id: string; updatedAt: number; messageCount: number; cwd?: string; saved: SessionFile } | undefined
  > {
    // 指针绑定了 dataDir：同 cwd 换 --data-dir 时不该把另一个 dataDir 的会话恢复出来
    // （sessionId 形如 s_<ts>_<5位随机>，理论上可能撞号）。旧指针无 dataDir 字段 → 兼容照常返回。
    const pointer = await this.sessionPointer.readIfOwnedBy(this.workspace.dataDir)
    if (pointer) {
      const saved = await this.sessionStore.load(pointer.sessionId)
      // 指针里的会话文件不见了（被删 / 换了 dataDir）就往下走兜底，别让启动卡在一个坏指针上
      if (saved) {
        // 指针只校验了「dataDir 归属」，没校验「会话自己的 cwd」：把 .harness/ 整目录复制到
        // 别处后，在新目录启动会恢复出旧目录的会话（跨目录串台）。这里再比对 saved.cwd 与当前
        // cwd，不一致（含旧会话 saved.cwd 为 undefined）就**不**从指针分支返回，落到同 cwd 兜底
        // 分支——rememberSession 只在会话属于当前目录时才写指针，两边语义要对齐，复制目录不该串台。
        if (resolve(saved.cwd ?? '') === this.workspace.cwd) {
          return {
            id: saved.id,
            updatedAt: saved.updatedAt,
            messageCount: saved.messages.length,
            cwd: saved.cwd,
            saved,
          }
        }
      }
    }
    const list = await this.sessionStore.list()
    const cwd = this.workspace.cwd
    const hit = list.find((s) => !!s.cwd && resolve(s.cwd) === cwd)
    if (!hit) return undefined
    const saved = await this.sessionStore.load(hit.id)
    if (!saved) return undefined
    return { id: hit.id, updatedAt: hit.updatedAt, messageCount: hit.messageCount, cwd: hit.cwd, saved }
  }

  /**
   * 把「本目录下次要恢复的会话」写进项目级指针。
   *
   * 只在会话确实属于当前工作目录时写：本目录里 `/resume` 了别的目录的会话后，不该把本目录
   * 的记录改成外目录会话——那正是「A 目录又恢复了 B 目录的会话」的来源。
   *
   * 写盘失败一律忽略（只读挂载、权限不足等）：这是启动路径上的记录动作，不能因为它
   * 把整个 boot 拖挂。失败时下次启动退回「同 cwd 兜底」，功能仍在。
   */
  async rememberSession(session: Session): Promise<void> {
    const cwd = this.workspace.cwd
    if (resolve(session.cwd ?? cwd) !== cwd) return
    try {
      await this.sessionPointer.write(session.id)
    } catch { /* 指针写不动不影响本次会话 */ }
  }

  /**
   * 挑「上次会话」用于自动恢复。
   *
   * 命中判定交给 findResumeTarget（指针优先、同 cwd 兜底）。没命中时把「全局最近的会话」
   * 原样回报给调用方：这样提示能说清是「目录不同」还是「被 --no-resume 关掉了」，而不是
   * 让用户对着一个空会话猜。
   */
  private async pickResumeCandidate(): Promise<
    | { kind: 'hit'; item: { id: string; updatedAt: number; messageCount: number; cwd?: string }; saved: SessionFile }
    | { kind: 'miss'; skipped?: SessionRestoreInfo['skipped'] }
  > {
    const autoResume = this.options.autoResume !== false
    const list = await this.sessionStore.list()
    if (list.length === 0) return { kind: 'miss' }
    const newest = list[0]
    if (!autoResume) {
      return { kind: 'miss', skipped: { id: newest.id, cwd: newest.cwd, updatedAt: newest.updatedAt, reason: 'disabled' } }
    }
    const target = await this.findResumeTarget()
    if (!target) {
      return { kind: 'miss', skipped: { id: newest.id, cwd: newest.cwd, updatedAt: newest.updatedAt, reason: 'other-cwd' } }
    }
    return { kind: 'hit', item: target, saved: target.saved }
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

  /**
   * 上下文压缩·阶段二（Route B）：按需读盘还原被压缩原文的全文历史。
   * 以会话「近期消息 + blocks」为骨架，经 originalStore 逐块取回被压缩窗口原文，
   * 再与近期合并、去重排序得到全文；可选按 range（startId/endId/blockIds）过滤。
   * 无 blocks 或读盘失败时 best-effort 返回近期消息，不阻断调用方。
   */
  async loadFullHistory(sessionId: string, range?: HistoryLoadRange): Promise<Message[]> {
    const h = this.harness
    const sess = await h.session.get(sessionId)
    if (!sess) return []
    if (!sess.blocks?.length) return range ? this.filterByRange([...sess.messages], range) : [...sess.messages]
    const originalStore: SessionOriginalStore = createWorkspaceOriginalStore(this.workspace)
    // 统一块模型：generic 块经 originalStore(.cmp.orig)，acp 块经 session.meta[acp.archive.v1] 还原
    const acpArchive = (sess.meta?.['acp.archive.v1'] ?? {}) as Record<string, Message>
    const resolveBlock = async (block: CompactionBlock): Promise<Message[]> => {
      if (block.source === 'acp' && Object.keys(acpArchive).length > 0) {
        return resolveAcpBlockOriginals(acpArchive, block)
      }
      return buildResolveBlock(originalStore, sessionId)(block)
    }
    const full = await reconstructHistory(sess, resolveBlock)
    // 阶段四·按需渲染：blockIds 存在时只返回命中块的原文段（压缩提示行惰性展开用）
    if (range?.blockIds?.length) {
      const wanted = new Set(range.blockIds)
      const parts: Message[] = []
      for (const b of sess.blocks ?? []) {
        if (!wanted.has(b.id)) continue
        parts.push(...(await resolveBlock(b)))
      }
      return parts
    }
    return range ? this.filterByRange(full, range) : full
  }

  /** 供 /revert 注入的会话全文回溯器（统一块模型）：经 loadFullHistory 还原） */
  private getFullHistory = (sessionId: string): Promise<Message[]> =>
    this.loadFullHistory(sessionId)

  /** 按 range（startId/endId/blockIds）过滤消息列表 */
  private filterByRange(
    messages: Message[],
    range: HistoryLoadRange,
  ): Message[] {
    let out = messages
    if (range.blockIds?.length) {
      // 块级过滤经 reconstructHistory 无法直接映射原文，此处忽略 blockIds（按时间范围兜底）
      void range.blockIds
    }
    if (range.startId || range.endId) {
      const startIdx = range.startId ? out.findIndex((m) => m.id === range.startId) : -1
      const endIdx = range.endId ? out.findIndex((m) => m.id === range.endId) : out.length - 1
      const from = startIdx >= 0 ? startIdx : 0
      const to = endIdx >= 0 ? endIdx : out.length - 1
      out = out.slice(from, to + 1)
    }
    return out
  }

  /**
   * 流式发送：逐事件 yield AgentStreamEvent，完成后自动持久化 session。
   * `signal` 用于中断（引擎会在步边界与每个工具执行前响应它）。
   */
  /**
   * 落盘所有「脏会话」（自上次保存以来有变更的会话）。
   *
   * 设计（缺陷修复：子 agent 会话不落盘）：
   * - 只保存有变化的会话（DefaultSessionManager 在 create / addMessage / updateMeta 等变更时统一标脏），
   *   不无脑全量保存，避免子会话文件每轮被反复重写放大 IO；
   * - 子会话是 subagent 插件内部 `harness.session.create()` 出来的、不在 CLI 持有的列表里，
   *   但同属 DefaultSessionManager，标脏后这里一并保存 —— 子会话的消息与 meta（含 usageStats）随之落盘；
   * - 落盘失败绝不能让 agent 跑挂（可观测性增强）：单条失败仅告警，并重新标脏以便后续重试。
   */
  async flushDirtySessions(): Promise<void> {
    let dirty: Session[] = []
    try {
      dirty = this.harness.session.takeDirtySessions()
    } catch {
      return
    }
    if (dirty.length === 0) return
    for (const s of dirty) {
      try {
        await this.sessionStore.save(s)
      } catch (err) {
        // 可观测性增强：落盘失败不应中断主流程
        console.warn(`[WARN] 脏会话落盘失败（${s.id}）：${(err as Error)?.message ?? String(err)}`)
        try { this.harness.session.markDirty(s.id) } catch { /* ignore */ }
      }
    }
  }

  async *sendStream(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<import('@harness/core').AgentStreamEvent, void, unknown> {
    const h = this.harness
    const gen = h.session.promptStream(sessionId, text, undefined, signal)
    for await (const ev of gen) {
      yield ev
    }
    // 持久化：轮末把「有变化」的会话（含本轮主会话与期间产生的子会话）统一落盘
    await this.flushDirtySessions()
  }

  /** 关闭 harness */
  async shutdown(): Promise<void> {
    // 退出前把残留的脏会话（含子会话）兜底落盘
    await this.flushDirtySessions().catch(() => undefined)
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
   *    的 core.tool.pool.assemble）才注册，/tools 会一直停留在「仅元信息」，list_dir 等场景
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
      // optIn 插件（computer-use / code-intel / subagent / coordinator / swarm）只「登记」，
      // 不在此实例化：要么其工具需 mcp-client 连上才可用，要么是不该默认注入的可选能力。
      // 它们的启用路径是 config.json → plugins 声明式启用，或外部插件目录显式装配。
      const loadable = items.filter((p) => !p.optIn)
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
const REPL_COMMANDS = ['/help', '/exit', '/quit', '/sessions', '/new', '/resume', '/agent', '/switch', '/model', '/config', '/save', '/compact', '/plugins', '/skills', '/stats', '/stats-export', '/permission', '/history', '/tree']

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
 * 禁用/启用/新增/移除 server 后，mcp-server-registry 的 core.tool.pool.assemble 会
 * 移除 / 装配对应 server 的工具；若不主动重组，运行时 ToolRegistry 里旧工具会一直
 * 「残留下线」，导致 /tools 仍把禁用 server 的工具显示为启用/可调用。本函数把事件
 * 桥接到 harness.assembleTools()，让禁用即时生效。
 *
 * @returns 卸载函数（取消全部订阅）
 */
/**
 * 统一块模型·ACP 原文取回：从 session.meta[acp.archive.v1]（coreId → Message）中，
 * 还原被某 ACP 折叠块（source:'acp'）覆盖的原文。
 * 归档记录保持消息插入序，故按 startId/endId 定位切片；id 不存在/范围非法时返回空
 * （加载方回退到 buildResolveBlock 的通用兜底，最终退化为仅摘要，不阻断）。
 */
function resolveAcpBlockOriginals(
  archive: Record<string, Message>,
  block: CompactionBlock,
): Message[] {
  const ordered = Object.values(archive).filter((m): m is Message => !!m && typeof m.id === 'string')
  const startIdx = ordered.findIndex((m) => m.id === block.startId)
  const endIdx = ordered.findIndex((m) => m.id === block.endId)
  if (startIdx < 0 || endIdx < startIdx) return []
  return ordered.slice(startIdx, endIdx + 1)
}

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
 * 自动续轮前**退避重试**地等待后台结果入队，返回最终待处理条数。
 *
 * 为什么不能只 peek 一次就判空转：barrier 事件是由 `bus.publish(completed)` 驱动的，而
 * `publish` 是**异步**的；即便 subagent 已经把入队排在 publish 之前，barrier 到达本函数时
 * 仍可能跨在入队之前（两个独立异步分支，没有先后保证）。只 peek 一次 ⇒ 读到空队列 ⇒
 * 判定空转 ⇒ **放弃且不重试** ⇒ 已跑完的结果滞留到用户下一次发话才送达。
 *
 * 真机（s_1790082671456_82ikm）：4 个 reader 21:22:15 全部完成、barrier 也触发了，通知却到
 * 21:25:16 才随用户敲「?」进入对话 —— 中间 3 分钟界面毫无动静。总等待预算约 1s，远小于
 * 一次模型调用的代价，换来的是"不再丢".
 */
export const NOTIFICATION_PEEK_BACKOFF_MS: readonly number[] = [50, 100, 250, 600]

export async function waitForPendingNotifications(
  session: { peekNotifications: (sessionId: string) => string[] },
  sessionId: string,
  opts: {
    steps?: readonly number[]
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<number> {
  const steps = opts.steps ?? NOTIFICATION_PEEK_BACKOFF_MS
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms)
        // 不阻止进程退出
        ;(t as unknown as { unref?: () => void }).unref?.()
      }))
  for (const wait of steps) {
    const n = session.peekNotifications(sessionId).length
    if (n > 0) return n
    await sleep(wait)
  }
  return session.peekNotifications(sessionId).length
}

/**
 * 「请求已发出但迟迟没有任何响应」的**可见心跳**。
 *
 * 动机（真机 s_1790082671456_82ikm）：首轮请求发出后 **7 分 20 秒**内没有产出任何内容，
 * 期间既不报错也不提示，界面完全静止 —— 用户只能靠"再发一遍"自救。静默卡死比报错更难自查
 * （用户分不清是卡了、还是任务本来就慢）。心跳不改变任何超时语义，只结束"毫无反馈"这一段。
 *
 * 间隔刻意**递增**（15s / 30s / 60s / 之后每 60s）：既要尽早出声，又不能在长任务里刷屏。
 * 收到第一个事件（或本轮结束）即停 —— 之后有内容在动，不需要再提示。
 */
export const STALL_NOTICE_STEPS_MS: readonly number[] = [15_000, 15_000, 30_000, 60_000]

export interface StallNoticeHandle {
  /** 收到第一个事件 / 本轮结束时调用（幂等） */
  stop: () => void
  /** 已提示次数（诊断与测试用） */
  notices: () => number
}

export function startStallNotice(
  out: (s: string) => void,
  opts: {
    steps?: readonly number[]
    /** 可注入的调度器（测试用同步/假时钟） */
    scheduler?: (fn: () => void, ms: number) => () => void
  } = {},
): StallNoticeHandle {
  const steps = opts.steps ?? STALL_NOTICE_STEPS_MS
  const schedule =
    opts.scheduler ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      ;(t as unknown as { unref?: () => void }).unref?.()
      return () => clearTimeout(t)
    })
  let stopped = false
  let count = 0
  let elapsed = 0
  let idx = 0
  let cancel: (() => void) | undefined
  const tick = (): void => {
    if (stopped) return
    const wait = steps[Math.min(idx, steps.length - 1)]!
    idx++
    cancel = schedule(() => {
      if (stopped) return
      elapsed += wait
      count++
      out(`⏳  模型尚无响应（已 ${Math.round(elapsed / 1000)}s）…\n`)
      tick()
    }, wait)
  }
  tick()
  return {
    stop() {
      stopped = true
      cancel?.()
    },
    notices: () => count,
  }
}

/**
 * 挂载 Coordinator 自动续轮（Coordinator 插件配套）。
 *
 * 订阅两条 Coordinator 事件，都向 REPL 注入一行 `<continue/>` 作为伪用户输入，
 * 从而启动下一轮 query：drainNotifications 将任务完成通知注入对话，coordinator
 * 自动汇总结果、继续派工或输出最终报告（用户零操作）。
 *
 * 为什么要订阅**两条**（观察点 2）：`coordinator.barrier.completed` 只在**全部**任务
 * 结束时发 —— 真机 s_1790163574429_tg1a6 里 reader#2 19:43:10 就完成了，barrier 到
 * 19:44:03（最慢那个失败）才触发，快结果被拖了 53 秒，那 53 秒正是"界面停在等待中"的那段。
 * `coordinator.worker.completed` 是"单个任务完成"（coordinator 只在**还剩**其它任务时才发它），
 * 因此两条不会在同一时刻都注入：最后一个任务走 barrier，中间的走 worker。
 *
 * 两处注入都不怕重复：`processLine` 对 `<continue/>` 会先退避 peek 待处理通知，
 * 读到空就跳过该轮 —— 所以"多注入一行"的代价只是一次 peek，不会被放大成空转。
 *
 * @param emitLine 把一行注入 REPL 输入队列的函数（readline 模式：rl.emit('line', l)）
 * @returns 卸载函数
 */
export function attachAutoContinue(harness: Harness, emitLine: (line: string) => void): () => void {
  if (!harness.bus) return () => {}
  const offBarrier = harness.bus.subscribe(CoordinatorEvents.barrierCompleted, () => emitLine(AUTO_CONTINUE_LINE))
  const offWorker = harness.bus.subscribe(CoordinatorEvents.workerCompleted, () => emitLine(AUTO_CONTINUE_LINE))
  return () => {
    offBarrier()
    offWorker()
  }
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
  /**
   * 中断句柄：`processLine` 执行查询期间会把当前查询的 `AbortController` 写进 `current`，
   * 结束后清空。上层（REPL 的 SIGINT / TUI 的 Ctrl-C）据此实现「执行中按键 = 中断当前查询，
   * 空闲时按键 = 退出」。
   */
  activeAbort?: { current: AbortController | null }
}

export type ProcessLineResult = 'continue' | 'exit'

/**
 * 解析当前会话用量统计：meta 持久化的累积器（有数据时）优先 → 否则由消息历史重建。
 * 与 TUI 共用 `hydrateUsage`，保证重连（resume）后能读到重连前累计的用量，
 * 且不会被「空累积器」误判为无数据。
 */
/**
 * 「含子 agent」聚合行（子 agent 用量归一：父会话面板此前完全看不到这部分）。
 *
 * 为什么在**展示层**聚合，而不是把子会话并进父会话的 `meta.usageStats`：子会话有自己的
 * meta 与生命周期（可能被别的入口再次打开），并进去会让同一条链在"全部会话·当日"里被
 * 重复计入；展示层聚合随时可算、可撤。引擎侧已提供 `usage.children()`（按 `meta.parentId`
 * 反查），这里只做求和与排版。
 */
export async function renderChildAgentRollup(harness: Harness, sessionId: string): Promise<string> {
  const usageApi = (harness as { usage?: Harness['usage'] }).usage
  if (!usageApi) return ''
  const ids = await usageApi.children(sessionId).catch(() => [] as string[])
  if (ids.length === 0) return ''
  const usages: UsageStats[] = []
  for (const id of ids) usages.push(await usageApi.get(id).catch(() => emptyUsage()))
  const sum = sumUsage(usages)
  return (
    `含子 agent：${ids.length} 个子会话 · 调用 ${sum.llmCalls} 次 · ` +
    `in ${sum.inputTokens} / out ${sum.outputTokens}` +
    (sum.cacheReadTokens > 0 ? `（缓存命中 ${sum.cacheReadTokens}）` : '') +
    '\n'
  )
}

/**
 * 统计页上下文占用区：本会话 + 各子会话的上下文占用率。
 *
 * - 窗口 / 阈值 / 保留 / 口径一律取 `/compact` 同一套推导（`buildCompactionOptions`），
 *   避免同一份 config 又算出两个窗口（历史教训：三处各算一次 ⇒ 阈值判据失效）；
 * - 占用 token 用 `session.estimateTokens`（与会话压缩同口径，含 CJK 感知）；
 * - 子会话占用逐行列出，且**分母各自解析**（见下方 resolveWindow）—— 子 Agent 常被派到
 *   另一个窗口的端点上，沿用父会话的分母会让小窗口子会话的占用率虚低（"报 40% 其实已满"）。
 */
export async function renderContextOccupancy(
  harness: Harness,
  session: Session,
  compactOpts: CompactOptions,
  /**
   * 「会话 → 该会话**实际**该用的窗口」，走 {@link resolveCompactionWindow}。
   * 不传 = 全部用 `compactOpts.contextWindowTokens`（= 改造前行为）：拿不到 config / Provider
   * 注册表的宿主（如测试替身）走这条路，行为不变。
   */
  resolveWindow?: (session: Session | undefined) => number,
): Promise<string> {
  const reserved = compactOpts.reservedTokens ?? 30_000
  const pct = compactOpts.autoCompactThresholdPct ?? 80
  const calibration = compactOpts.tokenCalibration
  const pctOf = (n: number, w: number) => (w > 0 ? (n / w) * 100 : 0).toFixed(1)
  /**
   * 回源取最新一份会话：调用方（尤其 TUI）手里那个对象可能是**调用时的快照**，
   * 而 `/model` 切过后窗口就变了。取不到（测试替身没有 session.get / 会话已删）就用手上这份。
   */
  const liveSession = async (fallback: Session | undefined, id: string): Promise<Session | undefined> => {
    const get = (harness as { session?: { get?: (id: string) => Promise<Session | undefined> } }).session?.get
    if (!get) return fallback
    try { return (await get.call(harness.session, id)) ?? fallback } catch { return fallback }
  }
  const window = resolveWindow
    ? resolveWindow(await liveSession(session, session.id))
    : (compactOpts.contextWindowTokens ?? 200_000)
  const threshold = Math.floor((window - reserved) * (pct / 100))

  const est = await harness.session.estimateTokens(session.id, calibration).catch(() => 0)
  const lines = [
    `上下文占用：${est.toLocaleString()} / ${window.toLocaleString()} tokens（${pctOf(est, window)}%）` +
      ` · 自动压缩阈值 ${threshold.toLocaleString()}（${pct}% ×（窗口−保留 ${reserved.toLocaleString()}））`,
  ]
  // 子 agent 上下文：每个子会话单独一行（分母按该子会话自身端点解析 —— 解析不出才回落父会话的窗口；
  // 子会话量小则不可见 —— 有值才列）
  const usageApi = (harness as { usage?: Harness['usage'] }).usage
  if (usageApi) {
    const ids = await usageApi.children(session.id).catch(() => [] as string[])
    for (const id of ids) {
      const childEst = await harness.session.estimateTokens(id, calibration).catch(() => 0)
      if (childEst <= 0) continue
      const childWindow = resolveWindow ? resolveWindow(await liveSession(undefined, id)) : window
      lines.push(
        `  子会话 ${id}：占用 ${childEst.toLocaleString()} / ${childWindow.toLocaleString()} tokens（${pctOf(childEst, childWindow)}%）`,
      )
    }
  }
  return lines.join('\n') + '\n'
}

export async function resolveCurrentUsage(harness: Harness, current: Session): Promise<UsageStats> {
  const hydrated = hydrateUsage(current)
  if (!isBlankUsage(hydrated)) return hydrated
  // 内存态可能是不完整视图（分页/裁剪/仅近期消息），只要水合结果为空就回源再试一次。
  // 注意：不能按 current.messages.length 判断——消息非空也可能全是未带 tokenUsage 的
  // 消息，此时若不回源，磁盘上的历史用量就永远读不到（/stats 与导出均显示 0）。
  const sess = await harness.session.get(current.id).catch(() => undefined)
  if (sess && sess !== current) {
    const rebuilt = hydrateUsage(sess)
    if (!isBlankUsage(rebuilt)) return rebuilt
  }
  return hydrated
}

/**
 * 归集当日（本地时区）跨会话用量：只读持久化会话文件、不写回，
 * 因此重连前当天产生的用量依然可统计 / 可导出。失败时回落为当前会话当日用量。
 */
export async function resolveTodayUsage(app: HarnessApp | undefined, current: Session): Promise<UsageStats> {
  return collectTodayUsage(app?.sessionStore, current)
}

/**
 * 工具结果「续行」标记：多行输出的第 2..N 行以此开头。
 *
 * 为什么需要：TUI 的控制台文本是**逐行**分类的（`pushConsole`），一行读不出前缀就只能落成
 * system 块 —— 一条 `read_file` / `bash` 输出会被劈成「tool 块 + system 块」两个块；而
 * tool 块的渲染器**本来就按多行设计**（首行加粗，结果行自动补 `│ `/`└ ` 树状缩进），
 * 且**每个块各带一个「⧉ 复制」按钮** ⇒ 截断一去掉，一次工具调用就会冒出两个复制按钮。
 * 给续行一个标记，分类器就能把它并回**同一个** tool 块。
 *
 * 该标记纯属传输用：`classifyConsoleLine` 会把它剥掉，界面与复制出的文本里都看不到它。
 * 用 `┆`(U+2506) 而不用 `│`：后者是 tool 块渲染器给结果行补的**视觉**前缀，两者不能混。
 */
export const TOOL_CONT_MARK = '┆'

/**
 * JSON 序列化；失败（循环引用 / BigInt 等）退化为 `util.inspect`。
 * 两条路径都保证是**完整**文本：工具入参/结果都来自 JSON 解析，正常走不到这里，
 * 但真走到了也不该变成"看不见内容"的 `[object Object]`。
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? inspect(value, { depth: null, breakLength: Infinity })
  } catch {
    return inspect(value, { depth: null, breakLength: Infinity })
  }
}

/**
 * 工具调用回显的入参文本：**完整序列化，不截断**。
 *
 * 此前这里写死 `JSON.stringify(input).slice(0, 60) + '...'`：bash 命令稍长就只剩前半截，
 * 用户看到的是一个**已经变形**的命令（少了重定向、少了后半段管道），而末尾那个 `...`
 * 只说明"被砍过"，不说明砍掉了什么 —— 复核这条调用必须回去翻原始日志。
 * 事件的 `input` 本就是完整值（core 侧 `tool_call_start` 注释明写"含 input 完整值"），
 * 截断发生在展示层，属于自己把上游给的信息丢掉。
 */
export function formatToolInput(input: unknown): string {
  if (input === undefined) return '{}'
  return safeStringify(input)
}

/**
 * 工具结果回显的文本：**完整打印，不截断**。
 *
 * 此前只取前 120 字符：grep / read_file / 测试日志这类长输出永远看不到结论，
 * 用户只能再让模型复述一遍 —— 多烧一轮上下文，复述本身还可能失真。
 * string 原样输出（保留换行）；其它类型 JSON 序列化。
 *
 * @param markContinuation 是否给第 2..N 行加 {@link TOOL_CONT_MARK}。**只有 TUI 需要**
 *   （它逐行分类，靠标记把续行并回同一个 tool 块）；REPL 是直写 stdout 的纯文本通道，
 *   带标记等于往用户眼前打符号。调用方按 `onEvent`（本文件里即"TUI 结构化模式"）判定。
 */
export function formatToolResult(result: unknown, markContinuation = false): string {
  const body = typeof result === 'string'
    ? result
    : result === undefined ? '' : safeStringify(result)
  if (!markContinuation || !body.includes('\n')) return body
  return body.split('\n').map((l, i) => (i === 0 ? l : TOOL_CONT_MARK + l)).join('\n')
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

  /**
   * `/resume` 的共用落地：先把当前会话落盘，再还原目标会话并换绑指针。
   * 与 boot() 的恢复共用 `app.restoreSession` —— 顺带把「会话级模型覆盖」也一起带回来。
   */
  const doResume = async (saved: SessionFile): Promise<ProcessLineResult> => {
    const prev = await harness.session.get(current.id)
    if (prev) await app.sessionStore.save(prev)
    const next = await app.restoreSession(saved)
    current = next
    options.setSession?.(next)
    // 指针跟着走：本次在这个目录用的是哪条会话，下次启动就恢复哪条
    await app.rememberSession(next)
    const totalMsg = (await app.loadFullHistory(saved.id).catch(() => []))?.length ?? saved.messages.length
    const ov = app.sessionModelOverride(next)
    out(
      `已恢复会话 ${saved.id}（${totalMsg} 条消息${ov ? ` · model=${app.resolveSessionModel(next)}（本会话覆盖）` : ''}）\n`,
    )
    return 'continue'
  }

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
          out('  /resume [id]       恢复会话：给 id 恢复指定会话，不给则接着同目录最近一次（/sessions 看 id）\n')
          out('  /save              手动保存当前会话\n')
          out('  /agent             列出已注册 Agent（含各自绑定模型与当前项）\n')
          out('  /agent <id>        切换**本会话**的 Agent（立即保存，下一条消息起）\n')
          out('  /switch <id>       /agent 的旧写法，等价\n')
          out('  /model             查看当前模型及其来源（本会话覆盖 / Agent 绑定）\n')
          out('  /model <模型名>    切换模型（**仅本会话**）：按已配置的 model 名（如 /model hy3）或实例 id\n')
          out('  /model <序号>      按 /model ? 列表序号切换（如 /model 2）\n')
          out('  /model <id>/<模型>  显式跨 Provider（如 /model openai/gpt-4o）\n')
          out('  /model --global <spec> 写成全局默认（同步 Agent 定义 + config.json）\n')
          out('  /model reset       清除本会话覆盖，回到该 Agent 的默认模型\n')
          out('  /model ?           列出已注册 Provider 与已配置模型（带序号）\n')
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
          // 会话目录是全局共享的（多个项目混在一起），所以标出「本目录上次恢复哪条」与
          // 哪些属于本目录 —— 否则自动恢复「怎么挑的」纯黑盒，用户只能怀疑是不是恢复错了。
          const pointer = await app.sessionPointer.read()
          const cwd = app.workspace.cwd
          out(`（本工作目录：${cwd}；上次会话：${pointer?.sessionId ?? '（无记录）'}）\n`)
          for (const s of list) {
            const when = new Date(s.updatedAt).toLocaleString()
            const mine = !!s.cwd && resolve(s.cwd) === cwd
            const mark = s.id === pointer?.sessionId ? '  ← 本目录上次' : mine ? '  ← 本目录' : ''
            out(`  ${s.id}  ${s.title ?? '(untitled)'}  ${s.messageCount} msgs  ${when}${mark}\n`)
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
          // 继承 agentId 与会话级模型覆盖：用户切完 agent/model 后开新会话，预期是「同样的设置、干净的上下文」，
          // 让新会话回落到 Agent 默认反而像是设置被重置了。
          const carry = app.sessionModelOverride(cur)
          const next = await harness.session.create({
            agentId: current.agentId,
            cwd: cur.cwd ?? app.workspace.cwd,
            meta: carry ? sessionModelMetaPatch(carry) : undefined,
          })
          // 换绑当前会话：工厂内部指针 + 通知调用方
          current = next
          options.setSession?.(next)
          await app.sessionStore.save(next)
          await app.rememberSession(next)
          out(`已新建会话 ${next.id}（沿用 agent=${next.agentId ?? 'default'}${carry ? ` · model=${app.resolveSessionModel(next)}` : ''}）\n`)
          return 'continue'
        }
        case '/resume': {
          if (!arg || !arg.trim()) {
            // 无参 /resume = 接着「本工作目录上次用过的会话」，与启动时的自动恢复同一套判定
            // （项目级指针优先，其次是同 cwd 兜底）—— 两条路径必须一致，否则启动恢复的和
            // 手敲 /resume 恢复的可能不是同一条。
            const target = await app.findResumeTarget()
            if (!target) { out('没有可恢复的会话（本工作目录下暂无历史）；/sessions 可查看全部。\n'); return 'continue' }
            if (target.id === current.id) { out(`已在会话 ${target.id}\n`); return 'continue' }
            return await doResume(target.saved)
          }
          const saved = await app.sessionStore.load(arg)
          if (!saved) { out(`会话 "${arg}" 不存在（可用 /sessions 查看）。\n`); return 'continue' }
          if (saved.id === current.id) { out(`已在会话 ${arg}\n`); return 'continue' }
          return await doResume(saved)
        }
        case '/agent': case '/switch': {
          const cur = (await harness.session.get(current.id))!
          const currentAgentId = cur.agentId ?? 'default'
          if (!arg || arg === '?') {
            out(`已注册 Agent（本会话当前：${currentAgentId}）：\n`)
            for (const a of harness.agent.list()) {
              const bound = app.getModel(a.id)
              const mark = a.id === currentAgentId ? '  ← 当前' : ''
              out(`  ${a.id}  -  ${a.name}${bound ? `  [model=${bound}]` : ''}${mark}\n`)
            }
            out('切换：/agent <id>（只改本会话，已注册即可切换）\n')
            return 'continue'
          }
          const exists = harness.agent.get(arg)
          if (!exists) {
            out(`Agent "${arg}" 未注册。可用：${harness.agent.list().map((a) => a.id).join(' / ') || '（无）'}\n`)
            return 'continue'
          }
          if (currentAgentId === arg) { out(`本会话已是 Agent ${arg}\n`); return 'continue' }
          cur.agentId = arg
          cur.updatedAt = Date.now()
          // 立即落盘：agent 是会话属性，等到下一次 send 才保存会在「切完就退出」时丢掉
          await app.sessionStore.save(cur)
          out(`已切换到 Agent ${arg}（仅本会话，已保存；下一条消息起）\n`)
          const ov = app.sessionModelOverride(cur)
          if (ov) {
            // 会话级模型覆盖优先级高于 Agent 绑定 —— 不同步说明会让人以为切换没生效
            out(`  提示：本会话有模型覆盖 ${app.resolveSessionModel(cur)}，它会盖过该 Agent 的绑定模型；/model reset 可清除。\n`)
          } else {
            out(`  本会话将使用 model=${app.resolveSessionModel(cur) ?? '（Provider 默认）'}\n`)
          }
          return 'continue'
        }
        case '/model': {
          // `line.split(/\s+/, 2)` 只切出两个 token，表达不了 `/model --global hy3`，
          // 这里按完整参数列表重切一次（最后一个参数才是模型 spec）。
          const parts = line.slice('/model'.length).trim().split(/\s+/).filter(Boolean)
          const useGlobal = parts.some((p) => p === '--global' || p === '-g' || p === 'global')
          const spec = parts.filter((p) => p !== '--global' && p !== '-g' && p !== 'global').join(' ').trim()
          const cur = (await harness.session.get(current.id))!
          const agentId = cur.agentId ?? 'default'
          const configured = app.listConfiguredProviders()
          // `/model reset`（等价 default / clear）：清除本会话覆盖，回到 Agent 的默认模型
          if (spec === 'reset' || spec === 'default' || spec === 'clear') {
            const before = app.sessionModelOverride(cur)
            await app.setSessionModel(cur, undefined)
            const eff = app.resolveSessionModel(cur)
            out(
              before
                ? `已清除本会话的模型覆盖，回到 Agent "${agentId}" 的默认：${eff ?? '（Provider 默认）'}\n`
                : `本会话本就没有模型覆盖，当前即 Agent "${agentId}" 的默认：${eff ?? '（Provider 默认）'}\n`,
            )
            return 'continue'
          }
          if (!spec || spec === '?') {
            const prods = app.listProviders()
            out('已注册 Provider：' + (prods.length ? prods.join(' / ') : '（默认 mock/anthropic）') + '\n')
            // 展示 config.json / CLI 里配置的 Provider 实例及其默认/附加模型（带序号，可直接 /model <序号>）
            if (configured.length) {
              out('配置的模型（providers）：\n')
              for (const p of configured) {
                const model = p.model ? `${p.id}/${p.model}` : `${p.id}（未指定 model，用 Provider 默认）`
                const extra = [
                  p.baseUrl ? `baseUrl=${p.baseUrl}` : '',
                  p.apiPath ? `apiPath=${p.apiPath}` : '',
                  p.type ? `type=${p.type}` : '',
                  // 来源 = 运行期注册表里的 source（谁把它装上去的），不是配置意图 ——
                  // 「配置写了却没装配」在这里表现为 来源=未注册
                  p.source ? `来源=${p.source}` : '',
                  p.keyTag ? `key=${p.keyTag}` : '',
                ].filter(Boolean).join(' · ')
                out(`  ${p.index}) ${model}${extra ? `  (${extra})` : ''}\n`)
              }
              // 同端点同模型（仅 token 不同 / 完全重复）时给出明确提示：这类实例只能靠派生 id 区分，
              // 而派生 id 与数组顺序绑定 —— 调整顺序会让 config.provider 悄悄指向另一个 token
              const dups = app.tokenOnlyDuplicateGroups()
              if (dups.length) {
                out(`⚠️  有 ${dups.length} 组实例的 type/baseUrl/model 完全相同：\n`)
                for (const g of dups) {
                  const ids = g.members.map((m) => m.id).join(' / ')
                  out(
                    g.distinctKeys > 1
                      ? `   ${ids}（仅 apiKey 不同，列表里已用 key=…<末4位> 区分）\n`
                      : `   ${ids}（apiKey 也完全相同，属重复项，建议删掉多余的那条）\n`,
                  )
                }
                out('   这些 id 是按 model 自动派生的（-2/-3），与 providers 数组顺序绑定：调整顺序会让\n' +
                  '   config.provider 指向另一个实例，删掉前面一条也会让 -2 变成无名可指。建议为其显式写 id。\n')
              }
              const first = configured[0]
              const sample = first.model ?? first.id
              out(`切换：/model ${sample}（按模型名）· /model ${first.index}（按序号）· /model ${first.id}/${first.model ?? '<model>'}（显式跨 Provider）\n`)
            }
            const ov = app.sessionModelOverride(cur)
            const eff = app.resolveSessionModel(cur)
            out(`当前模型：${eff ?? '（未绑定，用 Provider 默认）'}\n`)
            if (ov) {
              out('  来源：本会话模型覆盖（只影响本会话，已随会话落盘）\n')
              out('        改回该 Agent 默认：/model reset；写成全局默认：/model --global <spec>\n')
            } else {
              out(`  来源：Agent "${agentId}" 的绑定（全局）；/model <spec> 只改本会话\n`)
            }
            if (harness.agent.get(agentId)?.model?.options) {
              out(`模型附加选项：${JSON.stringify(harness.agent.get(agentId)!.model!.options)}\n`)
            }
            return 'continue'
          }
          // 统一解析用户输入（序号 / 实例 id / 模型名 / provider/model），再按结果执行或提示
          const knownRefs = app.listProviders()
          const r = resolveModelArg(spec, app.configuredProviders(), knownRefs)
          if (r.kind === 'ambiguous') {
            out(`"${r.arg}" 同时命中多个 Provider 实例，请指明其一：\n`)
            for (const c of r.candidates) {
              // key 指纹：同端点同模型、仅 token 不同时，光看 id/type 无法判断是哪个 key
              const keyTag = configured[c.index - 1]?.keyTag
              out(`  ${c.index}) ${c.id}/${c.model ?? ''}  (type=${c.type}${keyTag ? ` · key=${keyTag}` : ''}，命中其 ${c.matchedBy === 'id' ? 'id' : 'model'})\n`)
            }
            out(`   改为 /model <序号>（如 /model ${r.candidates[0].index}），或直接写成 <id>/<model>，如 /model ${r.candidates[0].id}/${r.candidates[0].model ?? '<model>'}\n`)
            return 'continue'
          }
          if (r.kind === 'bad-index') {
            out(`序号 ${r.arg} 超出范围（当前配置 ${r.total} 个 Provider 实例；用 /model ? 查看列表）。\n`)
            return 'continue'
          }
          if (r.kind === 'type-hint') {
            out(`"${r.arg}" 是 Provider **类型**名，不是可用实例，无法直接切换。\n`)
            out(`   · 想用该类型：/model ${r.arg}/<模型名>（如 /model ${r.arg}/gpt-4o）\n`)
            out(`   · 想固定某个端点：在 config.json → providers 里写一项 { "type": "${r.arg}", "baseUrl": "...", "model": "..." }（id 可省略，会自动按 model 命名）\n`)
            return 'continue'
          }
          if (r.kind === 'not-found') {
            const refs = configured.map((p) => p.model ?? p.id)
            out(`未找到 "${r.arg}" 对应的 Provider 实例或模型。\n`)
            out(`   已配置可用：${refs.length ? refs.join(' / ') : '（无）'}\n`)
            out(`   也可显式写成 <provider>/<model>，如 /model ${configured[0]?.id ?? 'openai'}/${configured[0]?.model ?? 'gpt-4o'}\n`)
            return 'continue'
          }
          if (r.kind === 'explicit' && r.providerId && !r.providerKnown) {
            out(`Provider "${r.providerId}" 未注册。可用：${knownRefs.join(' / ') || '（默认）'}\n`)
            out('   可在 <data-dir>/config.json → providers 中定义后重新启动。\n')
            return 'continue'
          }
          // 会话级覆盖的落值：实例未声明 model 时只记 providerId，交由该 Provider 的默认模型接管
          const providerIdForOverride = r.kind === 'model' ? undefined : r.providerId
          const override: SessionModelOverride = {
            ...(providerIdForOverride ? { providerId: providerIdForOverride } : {}),
            ...(r.modelId ? { modelId: r.modelId } : {}),
          }
          const ref = formatResolutionRef(r) ?? spec
          const detail = r.kind === 'instance' && !r.modelId ? '（该 Provider 未声明 model，使用其默认模型）' : ''
          if (useGlobal) {
            const ok = await app.setModel(agentId, spec)
            if (!ok) { out(`Agent "${agentId}" 未注册。\n`); return 'continue' }
            // 全局切换后必须清掉本会话覆盖：否则「已切全局」却仍走旧模型，用户会以为命令没生效
            const had = app.sessionModelOverride(cur)
            if (had) await app.setSessionModel(cur, undefined)
            out(`已切换模型 ${ref}${detail}（Agent "${agentId}" 的全局默认，已写入 config.json）\n`)
            if (had) out('  已一并清除本会话的模型覆盖，使该设置立刻对本会话生效。\n')
          } else {
            // 默认：只改本会话（不碰 Agent 定义、不写 config.json）
            await app.setSessionModel(cur, override)
            out(`已切换模型 ${ref}${detail}（仅本会话，已随会话保存；下一条消息起）\n`)
            out('  其他会话与 Agent 默认不受影响；要写成全局默认用 /model --global <spec>\n')
          }
          // 目标 Provider 若未装配到当前 harness，会静默回退默认（如 mock）——明确提示，避免「为什么一直 mock」
          const targetProvider = r.kind === 'instance' || r.kind === 'explicit' ? r.providerId : undefined
          if (targetProvider) {
            const actual = app.resolveChatProvider(targetProvider)?.id
            if (actual && actual !== targetProvider) {
              out(`⚠️  当前进程未装配 Provider "${targetProvider}"，实际将以 "${actual}" 发送。\n` +
                `   请重启 REPL 使 config.json → providers 中该 Provider 生效（或先写入后再启动）。\n`)
            }
          }
          return 'continue'
        }
        case '/config': {
          const cfg = await app.configStore.load()
          const agentId = current.agentId ?? 'default'
          out(`当前 agent=${agentId}\n`)
          const prods = app.listProviders()
          out(`已注册 Provider：${prods.length ? prods.join(' / ') : '（默认 mock/anthropic）'}\n`)
          const cur = (await harness.session.get(current.id))!
          const m = app.resolveSessionModel(cur)
          if (m) out(`当前模型：${m}\n`)
          out(buildConfigOverview(cfg, cfg.provider ?? 'anthropic') + '\n')
          return 'continue'
        }
        case '/compact': {
          const curSessionId = current.id
          // 会话压缩参数统一取自 config.json → compaction（窗口按**本会话实际端点**推导）。
          // 此前 core 内硬编码 200000，小窗口模型（如 102400）的阈值算成 136000 > 窗口本身，
          // 于是「配了却在正常会话下永远不触发」，且跳过的提示里也没有任何线索。
          //
          // `current` 是调用方手里的会话快照，而 `/model` 切过模型后窗口就变了 —— 回源取最新一份，
          // 否则会按"切之前的模型"算阈值（300K 端点上切到 200K 模型 ⇒ 阈值 256500 > 200000）。
          const curSess = (await harness.session.get(curSessionId)) ?? current
          const cfg = await app.configStore.load()
          const compactOpts = buildCompactionOptions(cfg, cfg.provider ?? 'anthropic', app.resolveSessionEndpoint(curSess))
          if (arg === 'auto' || arg === 'ifneeded') {
            const did = await harness.session.compactIfNeeded(curSessionId, compactOpts)
            const info = await harness.session.getCompactionInfo(curSessionId)
            if (did) out(`已触发压缩（阈值命中）：策略=${info.meta?.lastStrategy}，前=${info.meta?.lastMessagesBefore} 后=${info.meta?.lastMessagesAfter}\n`)
            else {
              const est = await harness.session.estimateTokens(curSessionId, compactOpts.tokenCalibration)
              const window = compactOpts.contextWindowTokens ?? 200_000
              const reserved = compactOpts.reservedTokens ?? 30_000
              const pct = compactOpts.autoCompactThresholdPct ?? 80
              const threshold = Math.floor((window - reserved) * (pct / 100))
              out(`未达阈值（估算 ${est} / 阈值 ${threshold} tokens，窗口 ${window}），跳过压缩。\n`)
            }
          } else {
            const strategy = (arg === 'prune' || arg === 'summary' || arg === 'agent') ? arg : 'summary'
            await harness.session.compact(curSessionId, strategy, compactOpts)
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
          const t = await resolveTodayUsage(app, current)
          out(renderStatsText(u) + '\n')
          out(await renderChildAgentRollup(harness, current.id))
          // 上下文占用区：窗口/阈值取 /compact 同一套推导；子会话占用逐行列（无值不占版面）
          const statsCfg = await app.configStore.load()
          const statsProvider = statsCfg.provider ?? 'anthropic'
          const statsCompactOpts = buildCompactionOptions(statsCfg, statsProvider)
          // 本会话与各子会话的分母**各自**按自身端点解析：子 Agent 常被派到另一个窗口的端点上，
          // 沿用父会话的分母会让小窗口子会话的占用率虚低（"报 40% 其实已满"）。
          out(await renderContextOccupancy(harness, current, statsCompactOpts, (s) =>
            resolveCompactionWindow(statsCfg, statsProvider, app.resolveSessionEndpoint(s))))
          out(`\n${todayUsageLine(t)}（全部会话·当日）\n`)
          return 'continue'
        }
        case '/stats-export': {
          const u = await resolveCurrentUsage(harness, current)
          const t = await resolveTodayUsage(app, current)
          const [fmtArg, pathArg] = (arg ?? '').trim().split(/\s+/)
          const isJson = fmtArg === 'json' || fmtArg === '--json'
          const content = isJson
            ? exportStatsJson(u, { sessionId: current.id, title: current.title, today: t })
            : exportStatsMarkdown(u, { sessionId: current.id, title: current.title, today: t })
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
    if (isAutoContinue) {
      // 空转识别：自动续轮的**唯一目的**是让模型看到后台任务结果（`<task-notification>`）。
      // 没有任何待处理通知时，这一轮不会带来新信息 —— 白烧一次完整模型调用
      // （内部循环上线后尤其明显：一轮可能是多步）。
      //
      // ⚠️ 不能只 peek 一次就判空转：barrier 由**异步**的 `bus.publish(completed)` 驱动，
      // 与 `enqueueNotification()` 是两个独立分支 —— 没有任何"事件到达时通知已入队"的保证
      // （此前靠一句 `setTimeout(0)` 去赌，真机上赌输了：结果滞留 3 分钟才送达）。
      // 改成退避重试若干次，总预算约 1s，远小于误判空转的代价。
      const pending = await waitForPendingNotifications(harness.session, current.id)
      if (pending === 0) {
        // 两个来源都会走到这里，措辞要同时覆盖：
        // ① **引擎已在轮内送达**（subagent 声明了 `waitAtTurnEnd` ⇒ 回合结束闸门把通知 drain 进
        //   了对话）—— 这是 2026-09-30 之后的常态，此时注入 `<continue/>` 已是空转；
        // ② 结果尚未就绪（barrier 由异步的 `bus.publish` 驱动，理论上可能与入队错开）。
        out('ℹ️  无待处理的后台结果（已处理或未就绪），跳过本次自动续轮\n')
        return 'continue'
      }
    } else {
      await options.onLine?.(line)
      out(`\n🧑  ${line}\n`)
    }
    const started = Date.now()
    let assistant: Message | undefined
    // Agent 状态：由事件流归约（纯函数），供末尾统计行显示「第几步 / 在跑哪个工具 / 是否被中断」。
    // 声明在 try 之外 —— 统计行在 try/catch 之后，异常路径也要能显示已归约到的状态。
    const statusAgentId = current.agentId ?? 'default'
    const statusDef = harness.agent?.get?.(statusAgentId)
    let agentStatus = initialAgentStatus({
      agentId: statusAgentId,
      ...(statusDef?.name ? { agentName: statusDef.name } : {}),
      ...(statusDef?.mode ? { mode: statusDef.mode } : {}),
    })
    // 中断句柄：执行期间暴露给上层（REPL 的 SIGINT / TUI 的 Ctrl-C），
    // 让「执行中按键 = 中断当前查询」而不是直接退出进程。
    const ctl = new AbortController()
    if (options.activeAbort) options.activeAbort.current = ctl
    // 停滞心跳：请求已发出但迟迟没有任何事件时周期性给一行可见反馈（收到首个事件即停）。
    // 静默卡死比报错更难自查 —— 这一行是用户区分"卡住了"和"任务本来就慢"的唯一线索。
    // 刻意声明在 try **之外**：请求报错时循环体里的 stop 不会执行，必须靠 finally 兜住，
    // 否则定时器会一直往界面写"模型尚无响应"。
    const stall = startStallNotice((s) => out(s))
    try {
      const curSessionId = current.id
      const gen = app.sendStream(curSessionId, line, ctl.signal)
      let inReasoning = false
      let inText = false
      let inToolOutput = false
      // 本次 query 是否已提示过"等待超预算"（普通 step_gate 心跳每档都发，这个警告只发一次防刷屏）
      let overBudgetNotified = false
      // 引擎自主多步（agentic loop）：A 方案下**每步**都发一次 done，故 done ≠ 整轮结束。
      // 这里把 done 当作「这一步的收尾渲染」；若之后还有事件到来，说明引擎在自主续轮，
      // 打一行分隔让人看得出它自己在往下走，而不是长时间无反馈。
      let lastDoneStep: number | null = null
      for await (const ev of gen) {
        stall.stop() // 已经有内容在动，不必再提示
        agentStatus = reduceAgentStatus(agentStatus, ev)
        // 外部集成（Herdr 等）：把**归约后**的状态广播给插件。刻意不 await ——
        // 每个 text_delta 都等一次插件链会把流式渲染拖成串行；代价是上报可能乱序，
        // 这正是 herdr 插件必须带严格递增 --seq 的原因（Herdr 会丢弃同源旧序号）。
        //
        // 这是**UI 消费层**的通道（含末条 turn_end ⇒ idle，UI 收 busy 靠它）。
        // 引擎层的整轮终态走另一条 hook `core.agent.turn.end`（core 广播，任何宿主都有）；
        // 两条通道刻意不混：同一条终态若两个来源都发，消费方就分不清"这条是谁发的"。
        void harness.plugin
          .trigger('cli.agent.stream', {
            eventType: ev.type,
            status: agentStatus,
            sessionId: curSessionId,
          })
          .catch(() => undefined)
        // turn_end 是「整轮结束」标记，不是「下一步开始了」⇒ 不能触发续轮分隔。
        // step_gate 同样不能：它发生在**下一步开跑之前**，此时打「第 N 步（自主续轮）」
        // 会让"等待中"看起来像"已经在跑下一步了"。
        if (ev.type !== 'done' && ev.type !== 'turn_end' && ev.type !== 'step_gate' && lastDoneStep != null) {
          if (!onEvent) out(`\n🔄  第 ${lastDoneStep + 1} 步（自主续轮）\n`)
          lastDoneStep = null
          inText = false
          inReasoning = false
        }
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
            // 入参完整打印（工具的"命令行"就是它的入参，截断即无法复核）
            out(`🔧  ${ev.toolId} ${formatToolInput(ev.input)}\n`)
            break
          case 'tool_call_result': {
            const status = ev.isError ? '❌' : '✅'
            onEvent?.(ev)
            // 结果完整打印：一条工具输出的结论往往在长文本尾部，截断等于没给。
            // 多行结果的续行标记只给 TUI（它逐行分类，靠标记并回同一个 tool 块）
            out(`${status}  → ${formatToolResult(ev.result, !!onEvent)}\n`)
            break
          }
          case 'done':
            assistant = ev.message
            // 本步收尾：结束当前文本/推理行（多步时每步各占一段），并记下步号。
            // 后续若再来事件即视为续轮，由循环顶部的分隔逻辑接手。
            if (!onEvent && (inText || inReasoning)) out('\n')
            inText = false
            inReasoning = false
            if (ev.step != null) lastDoneStep = ev.step
            onEvent?.(ev)
            break
          case 'turn_end':
            // 整轮结束：转发给 TUI 收尾（busy 状态等），REPL 的收尾在循环外统一做
            onEvent?.(ev)
            break
          case 'step_gate': {
            // 步间闸门：派工后后台任务还没跑完，引擎让出时间（单档最长 60s）。
            // 必须打一行 —— 静默等几十秒等于把「静默卡死」重新引入一次（心跳约定）。
            if (inText || inReasoning) { out('\n'); inText = false; inReasoning = false }
            onEvent?.(ev)
            const g = ev.gate
            if (g) {
              const alive = g.aliveCount !== undefined ? `，${g.aliveCount} 个在跑` : ''
              // 秒数带一位小数：档内分片重探会提前结束（如 3s 档只等了 1.5s），
              // 而 `Math.round(0.5)` 会把 500ms 报成"1s" —— 报出去的数字必须是实际发生的。
              const secs = (ms: number): string =>
                ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`
              // 提前结束时把原定档位一并报出：只说"本次 1.5s"会让人以为阶梯改了
              const span = g.plannedMs !== undefined
                ? `${secs(g.waitMs)}（原定 ${secs(g.plannedMs)}）`
                : secs(g.waitMs)
              out(`⏳  等一会再跑下一步：${g.reason ?? '后台任务尚未跑完'}${alive}`
                + `（本次 ${span}，累计 ${secs(g.waitedMs)}）\n`)
              // 超过等待总预算 ⇒ 后台任务可能卡死/异常。这是"提醒阈值"，引擎仍继续等，
              // 但必须让用户知道异常可能存在、可用 Ctrl-C 结束 —— 否则会被误当成"任务本来就慢"。
              // 只提示一次（后面的 step_gate 心跳照发，但不再重复刷这一行）。
              if (g.overBudget && !overBudgetNotified) {
                overBudgetNotified = true
                out('⚠️  等待后台任务已超过 5 分钟预算，可能卡死/异常；可 Ctrl-C 结束本轮，'
                  + '或 等待任务自行收尾。\n')
              }
            }
            break
          }
        }
      }
      // 结构化模式（onEvent）下收尾换行由 TUI 负责，避免向控制台混入空行
      if (!onEvent && (inText || inReasoning)) out('\n') // 换行收尾
    } catch (err: any) {
      out(`\n❌  发送失败：${err?.message ?? String(err)}\n`)
      return 'continue'
    } finally {
      // 正常结束 / 中断 / 报错都要清掉句柄，否则下一次 SIGINT 会 abort 一个早已结束的查询
      if (options.activeAbort) options.activeAbort.current = null
      // 心跳也必须停：请求报错或从未产出任何事件时，循环体里的 stop 不会被执行，
      // 定时器会一直周期性往界面写"模型尚无响应"
      stall.stop()
    }
    const duration = Date.now() - started
    // 中断过就明说：core 会吞掉 AbortError 并保留已完成的部分，不提示的话看起来像"正常跑完了"
    if (ctl.signal.aborted) out('⏹️  已中断（保留已完成的部分）\n')
    // 用「本会话实际会用的模型」而非 Agent 绑定值：会话级覆盖（/model）后若还读 Agent 定义，
    // 统计行会一直显示旧模型，看起来像切换没生效
    const modelLabel = app.resolveSessionModel(current)
    // agent 部分用状态机输出（含步数 / 工具 / 中断），比单纯的 agent=<id> 信息量大得多
    const agentLabel = formatAgentStatus({
      ...agentStatus,
      ...(assistant?.agentId ? { agentId: assistant.agentId } : {}),
    })
    out(`⏱️  ${duration}ms | ${agentLabel}` +
      (modelLabel ? ` | model=${modelLabel}` : '') + '\n\n')
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
  // 自动恢复的提示必须显式给出：否则用户会以为「怎么一进来就有历史」是 bug，
  // 也不知道该用 /new 开新会话。没恢复时同样给出原因，避免对着空会话猜。
  const notice = describeSessionRestore(app.sessionRestore)
  if (notice) out(notice + '\n')
  const modelNow = app.resolveSessionModel(session)
  out(`输入问题开始对话；输入 /help 查看特殊命令；/exit 退出。\n`)
  out(`当前 agent=${session.agentId ?? 'default'} · model=${modelNow ?? '（Provider 默认）'}；会话内可用 /agent、/model 切换。\n\n`)

  let idx = 0
  const scripted = options.scriptedStdin ? [...options.scriptedStdin] : null

  // 中断句柄：执行查询期间由 processLine 写入当前 AbortController，
  // SIGINT（Ctrl-C）据此区分「执行中 ⇒ 中断本次查询」与「空闲 ⇒ 退出」
  const activeAbort: { current: AbortController | null } = { current: null }

  // 会话处理内核（与 TUI 共用）：流式渲染、/ 命令、插件 cli.command hook
  const processLine = createProcessLine({
    app,
    harness,
    session,
    out,
    onLine: options.onLine,
    setSession: (s) => { (options as any).session = s },
    activeAbort,
  })

  if (scripted) {
    for (const line of scripted) {
      idx++
      const res = await processLine(line)
      if (res === 'exit') return 'exit'
    }
    // 脚本结束后顺手落盘（含期间产生的子会话）
    await app.flushDirtySessions().catch(() => undefined)
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
    /**
     * Ctrl-C 的两段语义（对齐主流 CLI 的习惯）：
     * - **正在执行查询** ⇒ 中断本次查询（引擎在步边界与每个工具执行前响应，已完成的部分照常保留），
     *   而不是把整个进程杀掉；
     * - **空闲** ⇒ 退出 REPL。
     */
    rl.on('SIGINT', () => {
      if (activeAbort.current) {
        activeAbort.current.abort()
        out('\n⏹️  已请求中断，正在停止…（已完成的步骤会保留）\n')
        return
      }
      rl.close()
      resolve('exit')
    })
  })
}

// ========================================================================
// 6. help 文本
// ========================================================================

export const HELP_TEXT = `harness — Agent Harness CLI

用法:
  harness [repl|start] [options]        启动交互式 REPL（默认）
  harness list-sessions [options]       列出持久化会话
  harness resume [sessionId] [opt]      恢复会话进入 REPL（省略 id 则接着当前目录最近一次）
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
  -c, --cwd <dir>            工作目录（启动时传入即以此为准；不传才取当前目录）。
                             决定项目级 .harness/（last-session.json、agents/、plugins/）
                             与会话记录的归属，TUI 的 /tree、/edit 相对路径也以它为准
  -a, --agent <id>           默认 Agent ID（默认 default）
  -p, --provider <id>      默认 Provider id：mock / anthropic，或 config.providers 中定义的自定义 id（默认 anthropic，无 key 时 fallback mock）
  -m, --model <spec>       默认模型：provider/modelId 跨 Provider 指定（如 openai/gpt-4o）。运行时可用 /model 切换
  -s, --session <id>       指定会话 ID（用于 resume/run 时复用历史）
      --no-resume          本次启动不恢复上次会话（默认按工作目录自动恢复，见下）
  -d, --data-dir <dir>     持久化目录（默认 ~/.harness）
      --permission <mode>  allow-all / ask / deny-all（默认 ask）
  -v, --verbose            输出调试信息
      --tui                以 TUI（alt-screen 全屏）模式启动 REPL
      --snapshot           开启文件快照 + /revert 能力（默认 false；config.json 设 "snapshot": true 或 harness.snapshot 常开）
      --allow-plugin-code  允许加载 .harness/plugins/*.ts 的插件代码（默认**关闭**，防代码注入）
      --check-config       校验 config.json 配置并打印 Provider/模型概览后退出

会话（启动即恢复 · 会话内可切 Agent / 模型）:
  默认启动会接着「当前工作目录上次用的」会话继续；记录写在 <cwd>/.harness/last-session.json
  （会话 id 与目录绑定，不同工作目录各自一份，不会在 A 目录恢复出 B 目录的会话）。
  关闭自动恢复：--no-resume，或 config.json 设 "autoResume": false。run "<prompt>" 始终新建（脚本化不该改写历史）。
  REPL/TUI 内：
    /agent [id]             查看/切换**本会话**的 Agent（立即保存；/switch 为旧写法）
    /model <spec>           切换模型，**只影响本会话**（写入 Session.meta.model，随会话持久化）
    /model --global <spec>  写成全局默认（同步 Agent 定义 + config.json，并清除本会话覆盖）
    /model reset            清除本会话覆盖，回到该 Agent 的默认模型
    /new                    新建会话（沿用当前 agent 与模型）；/resume [id] 恢复会话

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

/**
 * 构造用于配置自检的 Provider 类型注册表（内置 + 外部 plugins 插件注册的 Provider 类型工厂）。
 *
 * `allowPluginCode` 与 boot 同一闸门：默认不加载插件代码，避免 `harness config check`
 * 在一个克隆来的仓库里顺手执行了 `.harness/plugins/*.ts`。
 */
export async function buildCheckRegistry(
  cwd: string,
  log: (s: string) => void,
  allowPluginCode = false,
): Promise<ProviderTypeRegistry> {
  const registry = new ProviderTypeRegistry()
  registerBuiltinProviderTypes(registry)
  const ws = resolveWorkspace({ cwd })
  await loadPluginDirs(registry, [
    { dir: ws.user.plugins, source: 'user' },
    { dir: ws.project.plugins, source: 'project' },
  ], log, { allowCode: allowPluginCode })
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
    const registry = await buildCheckRegistry(workspace.cwd, write, cfg.allowPluginCode ?? false)
    const defaultProviderId = cfg.provider ?? 'anthropic'
    const { issues } = checkProviderConfigs(providers, defaultProviderId, registry.list())
    write(buildConfigOverview(cfg, defaultProviderId) + '\n')
    // 展示含外部插件的完整 Provider 类型清单（含用法提示）
    write(buildProviderTypesSection(registry) + '\n')
    // config.json → plugins（内置插件声明式启用）自检：只查 BuiltinPluginRegistry，不加载模块
    const unknownPlugins = unknownBuiltinPluginIds(cfg.plugins)
    if (cfg.plugins?.length) write(`内置插件（config.json → plugins）：${cfg.plugins.join('、')}\n`)
    if (unknownPlugins.length) {
      write(
        `配置错误（config.json → plugins）：未登记的内置插件 ${unknownPlugins.join('、')}\n` +
        `  可用：${getBuiltinRegistry().list().map((p) => p.id).join(' / ')}\n`,
      )
    }
    if (issues.length) {
      write('配置错误（config.json → providers）：\n' + issues.map((s) => `  - ${s}`).join('\n') + '\n')
      return 1
    }
    if (unknownPlugins.length) return 1
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
    const registry = await buildCheckRegistry(cwd, write, args.allowPluginCode ?? cfg.allowPluginCode ?? false)
    const { issues } = checkProviderConfigs(cfg.providers ?? [], provider, registry.list())
    write(buildConfigOverview(cfg, provider) + '\n')
    if (issues.length) {
      write('配置错误（config.json → providers）：\n' + issues.map((s) => `  - ${s}`).join('\n') + '\n')
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
    // 自动恢复上次会话：CLI --no-resume > config.json autoResume > 默认开启。
    // `run "<prompt>"` 是脚本化一次性执行，强制关闭 —— 否则它会悄悄接着上一个会话往下写。
    autoResume: args.command === 'run' ? false : args.noResume ? false : cfg.autoResume !== false,
    permissionMode, verbose: args.verbose, snapshot,
    // 代码注入防护：默认不加载插件目录里的代码（CLI 参数 > config.json > 关闭）
    allowPluginCode: args.allowPluginCode ?? cfg.allowPluginCode ?? false,
  })
  const { harness, session } = await app.boot()

  try {
    if (args.command === 'run') {
      const prompt = args.arg ?? ''
      if (!prompt) { write('用法: harness run "<prompt>"\n'); return 1 }
      // 流式输出（逐 token 打印到 stdout，脚本友好）
      const gen = app.sendStream(session.id, prompt)
      // 停滞心跳走 **stderr**：`harness run` 的 stdout 要保持"纯结果"以便脚本消费
      const stall = startStallNotice((s) => process.stderr.write(s))
      // 一次性执行也要上报状态（在 Herdr 里跑 `harness run` 同样需要侧栏反馈）
      let runStatus = initialAgentStatus({ agentId: session.agentId ?? 'default' })
      for await (const ev of gen) {
        stall.stop()
        runStatus = reduceAgentStatus(runStatus, ev)
        // UI 状态流（含末条 turn_end ⇒ idle）。引擎层终态在 `core.agent.turn.end`，两条通道不混。
        void harness.plugin
          .trigger('cli.agent.stream', {
            eventType: ev.type,
            status: runStatus,
            sessionId: session.id,
          })
          .catch(() => undefined)
        if (ev.type === 'text_delta') write(ev.text ?? '')
        else if (ev.type === 'tool_call_start') {
          // 引擎自主多步时把工具活动写到 stderr —— stdout 保持「纯结果」，脚本可安全消费
          process.stderr.write(`\n[工具] ${ev.toolId}\n`)
        } else if (ev.type === 'tool_call_result' && (ev.isError || args.verbose)) {
          // 失败结果必须可见（DOOM_LOOP / 权限拒绝 / 执行异常此前在 headless 下完全无声，
          // 只有 TUI 能看到）；成功结果仅在 --verbose 时给一行摘要。同样走 stderr。
          const detail =
            typeof ev.result === 'string'
              ? ev.result
              : ((ev.result as any)?.message ?? JSON.stringify(ev.result) ?? '(无详情)')
          const oneLine = String(detail ?? '(无详情)').split('\n')[0]!.slice(0, 300)
          const tag = ev.isError ? '失败' : '结果'
          process.stderr.write(`[工具${tag}] ${ev.toolId}: ${oneLine}${String(detail).length > oneLine.length ? '…' : ''}\n`)        } else if (ev.type === 'done') {
          if (ev.message) {
            // 换行收尾
            const textParts = ev.message.parts.filter((p: any) => p.type === 'text')
            if (textParts.length > 0) write('\n')
          }
        }
      }
      // 请求报错时循环体会直接抛出，走不到上面那句 stop ⇒ 这里再停一次（幂等）
      stall.stop()
      // headless 用量展示（`harness run` 没有 /stats 入口）：stdout 保持纯结果，用量走 stderr
      const runUsage = await harness.usage.get(session.id).catch(() => undefined)
      if (runUsage && !isBlankUsage(runUsage)) {
        const hit = runUsage.cacheReadTokens > 0 ? ` · 缓存命中 ${runUsage.cacheReadTokens}（${cacheHitRate(runUsage)}%）` : ''
        process.stderr.write(
          `[用量] LLM 调用 ${runUsage.llmCalls} 次 · in ${runUsage.inputTokens} / out ${runUsage.outputTokens}${hit}\n`,
        )
        const childLine = await renderChildAgentRollup(harness, session.id)
        if (childLine) process.stderr.write(childLine)
      }
      return 0
    }

    // repl / resume / start → REPL（--tui 时进入 alt-screen 全屏 TUI）
    {
      // 窗口按本会话**实际端点**推导后显式传入（此前走 core 内的硬编码 200000，
      // providers 写 102400 时阈值 136000 > 窗口 ⇒ 这次判定恒为 false；
      // 会话切过模型时同理：分母得是它自己的窗口，不是默认 Provider 的）
      const did = await harness.session.compactIfNeeded(session.id, buildCompactionOptions(cfg, provider, app.resolveSessionEndpoint(session)))
      if (did) {
        const info = await harness.session.getCompactionInfo(session.id)
        write(`[会话] 自动压缩：策略=${info.meta?.lastStrategy}，前=${info.meta?.lastMessagesBefore} 后=${info.meta?.lastMessagesAfter}\n`)
      }
    }
    if (args.tui) {
      // 状态栏 provider 用实际解析出的 ChatProvider，而非静态配置值（更真实、避免过期误报）
      await startTuiRepl({
        app,
        harness,
        session,
        provider: app.resolveChatProvider()?.id ?? provider,
        model,
        // 阶段四·按需渲染：压缩块提示行点击展开 / 更早分页经 loadFullHistory 惰性加载原文
        loadHistory: (sid, range) => app.loadFullHistory(sid, range),
      })
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
