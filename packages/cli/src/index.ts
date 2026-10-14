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

import { Harness } from '@harness/core'
import type { AgentStreamEvent } from '@harness/core'
import type { AgentPlugin, PluginContext, ProviderConfig } from '@harness/plugin'
import { ProviderTypeRegistry } from '@harness/plugin'
// 运行时能力抽象契约（@harness/plugin）：cli 仅经下方面向 subagent / swarm 的抽象接口交互，
// 不依赖具体实现类型。具体能力对象（subagentCapability / swarmCapability）由插件包导出并在组合根装配。
import type { BackgroundTaskViewLike, ToolMetaLookup } from '@harness/plugin'
// 仅类型（`import type` 被完全擦除，不会拖累启动）：ACP 的「Provider 窗口表」形状 ——
// 装配处要按它构造，写内联结构体就会与插件侧两份定义漂移（本仓"同一个东西两套写法"的老病）。

// 内置 Provider 模块与 tools-builtin 一律惰性加载（见 lazyImport / registerBuiltinProviderTypes）：
// 这里只保留类型导入，运行时值经动态 import() 在真正用到时才加载，避免拖慢启动。
// 例外：tools-builtin 的「静态元信息」（meta）为纯数据、无副作用，可提前加载（多级加载 L1，
// 见 BuiltinToolRegistry）；对应的运行时工具模块（L2）仍经 getBuiltinRegistry().load() 惰性/后台加载。

// 内置工具静态元信息（多级加载 L1，抽象契约 ToolMetaSource）：各工具插件以 toolMetaSource 自描述，
// 由 BuiltinGeneralPlugin.metaSource 自携带（惰性 dynamic import 对应 /meta 模块），
// CLI 经 ToolMetaRegistry（preloadBuiltinToolMetas）统一登记，不硬编码各包的具体导出形态。
// subagent / swarm 均为内置插件（组合根直连），cli 经其导出的能力对象（抽象契约）交互
import { subagentCapability } from '@harness/subagent'
import { CoordinatorEvents } from '@harness/coordinator'
import { swarmCapability } from '@harness/swarm'

import { type SnapshotService } from '@harness/snapshot'
import { ConfigStore, SessionFileStore, SecretCipher, resolveWorkspace, type Workspace, type SessionFile } from '@harness/workspace'
import { createRevertPlugin, createSnapshotPlugin } from '@harness/revert'
// 装配原语上移到 @harness/host（P0 三步：① 外部插件目录加载；② 内置注册表三节 —— Provider
// 类型工厂 / 内置通用插件 / 内置工具静态元信息；③ 配置归一化与上下文窗口推导）。CLI / A2A
// server / 编辑器扩展共用同一份装配，避免"两份装配必然分叉"。
//
// 下面 import 的是本文件内部真正要用的；re-export 保持既有导出面**逐字不变** ——
// cli.test.ts / provider-model.test.ts 直接 import 这些符号，导出面动了就等于制造一次无谓的
// 测试翻修。
import { loadPluginDirs, registerBuiltinProviderTypes, getBuiltinRegistry, unknownBuiltinPluginIds, getBuiltinToolRegistry } from '@harness/host'
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
import { resolveModelArg, formatResolutionRef, checkProviderConfigs, resolveCompactionWindow, buildCompactionOptions, buildConfigOverview, formatProviderTypeList, buildProviderTypesSection } from '@harness/host'
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
// 权限接缝（P0 收尾 S2 第二步）：四态语义 / 模式短路 / 规则写回已上移到 host，cli 只留文本提问适配。
// `createAuditSink` 与之同源（M3 后由 cli 上移到 host）—— 本地也要 import 一份供构造期使用，
// `export ... from` 只重导出、不在本作用域引入名字（见下方 §3.5 的 re-export）。
import { InteractivePermissionEngine, createAuditSink, DEFAULT_PERMISSION_PRINCIPAL } from '@harness/host'
import type { PermissionAnswer, PermissionAsker, PermissionMode, PermissionStoreFile } from '@harness/host'
export type { PermissionAnswer, PermissionAsker, PermissionMode, PermissionStoreFile } from '@harness/host'
export { InteractivePermissionEngine } from '@harness/host'
// 宿主装配主体（P0 收尾 S2 第三步）：`HarnessHost` 连同 `HostOptions` / `SessionRestoreInfo` / 装配期
// 诊断渲染器一并自本文件上移。CLI 只留薄子类 `HarnessApp`（见本文件 §4）与文本提问适配。
import { HarnessHost, renderNotice } from '@harness/host'
import { createHost } from '@harness/host'
// A2A 服务端宿主（宿主/适配器层）。只做协议翻译与装配 —— 复用 host 的同一份装配。
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  DEFAULT_A2A_PORT,
  createA2aServer,
  listControlMethods,
} from '@harness/a2a-server'
import type { HostOptions, SessionRestoreInfo } from '@harness/host'
export type { HostOptions, SessionRestoreInfo } from '@harness/host'
export { HarnessHost, createHost } from '@harness/host'
export type { Host } from '@harness/host'
import type { McpServerEntry } from '@harness/mcp-server-registry'
import { LifecycleEvents } from '@harness/core'
import { startTuiRepl } from './tui'
import { emptyUsage, sumUsage, usageFromMeta, usageFromMessages, renderStatsText, exportStatsJson, exportStatsMarkdown, hydrateUsage, isBlankUsage, cacheHitRate, todayUsageLine, resolveCurrentUsage, renderChildAgentRollup, renderContextOccupancy, type UsageStats } from './usage-stats'
import { formatAgentStatus, initialAgentStatus, reduceAgentStatus } from './agent-status'
import type { CompactOptions } from '@harness/session'
import { collectTodayUsage } from './usage-today'
import { sessionModelMetaPatch, type Message, type Session, type SessionModelOverride } from '@harness/session'

import type { ToolContext, Tool } from '@harness/tool'
import { renderWidgetText, widgetFromToolResult } from '@harness/ui-widget'
import { createJsonlWriter, type JsonlWriter } from '@harness/telemetry'
import type { AuditEvent } from '@harness/host'

import { join, resolve } from 'node:path'

import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { inspect } from 'node:util'

// ========================================================================
// 1. 参数解析
// ========================================================================

export interface CliArgs {
  /** 子命令：repl / start / list-sessions / resume / run / teammate / config / a2a */
  command: 'repl' | 'list-sessions' | 'resume' | 'run' | 'teammate' | 'config' | 'a2a' | 'help'
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
  /** a2a 子命令：监听端口（默认 4321） */
  a2aPort?: number
  /** a2a 子命令：Bearer token（配了才校验 + 卡片声明安全方案） */
  a2aToken?: string
  /**
   * a2a 子命令：以**单行 JSON 握手**启动。
   *
   * stdout 只输出一行机器可读的端点信息（其余人类可读信息一律改走 stderr），
   * 供扩展 / 脚本「spawn 后确定性地取端点」—— 不必解析人类可读文案（那是一个
   * 改一个字就静默崩掉的耦合面，见 `spawn --port 0` 的端口回填场景）。
   */
  json?: boolean
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
    else if (cmd === 'a2a') command = 'a2a'
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
    if (a === '--json') { out.json = true; continue }
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
      case 'port': out.a2aPort = value === undefined ? undefined : Number(value); break
      case 'token': out.a2aToken = value || undefined; break
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

// 外部插件目录加载（PluginLoadResult / probeAgentPlugin / collectAgentPlugins /
// registerProviderTypeFactory / loadPluginDirs）已上移到 @harness/host，本文件顶部 re-export
// 保持导出面逐字不变。

/**
 * CLI 权限引擎：`InteractivePermissionEngine` 的**适配器**（P0 收尾 S2 第二步）。
 *
 * 四态语义 / 模式短路 / 规则写回都已上移到 `@harness/host/permission`（三个宿主共用一份），
 * 这里只留 CLI 的输入形态：文本提问（TUI 模态 或 readline）→ 四态答复的翻译。
 * 导出面与改造前逐字相同（`PermissionStoreFile` 亦从 host re-export）。
 *
 * 为什么不把「文本 → 四态」也上移：`y/n/a/d/A/D` 是 CLI 的输入词汇，不是协议。
 * 远程宿主直接给四态，不该被迫走"伪造文本再解析回来"的往返（见 host 侧文件头）。
 */
export class CliPermissionEngine extends InteractivePermissionEngine {
  constructor(
    rules: Record<string, unknown> = { '*': 'ask' },
    private readonly options: {
      store?: PermissionStoreFile & { save?: (r: Record<string, unknown>) => Promise<void> }
      mode?: PermissionMode
      /** 测试注入：替换真实 readline 交互 */
      askPrompt?: (question: string) => Promise<string>
      stdout?: NodeJS.WritableStream | { write: (s: string) => void }
      /** M3：审计（`decision.human` + `permission.rule.changed`，透传给 host 引擎） */
      audit?: (env: AuditEvent) => void | Promise<void>
      /** P0-9：归属主体解析（透传给 host 引擎；缺省 ⇒ 无归属，写回裸工具键） */
      callerResolver?: (sessionId?: string) => string | undefined
    } = {}
  ) {
    super(rules, {
      store: options.store,
      mode: options.mode,
      asker: cliAsker(options.askPrompt),
      audit: options.audit,
      callerResolver: options.callerResolver,
    })
  }

  /** 替换询问交互器（TUI 在启动后注入模态审批，替代默认 readline 行内提问） */
  setAskPrompt(fn?: (question: string) => Promise<string>): void {
    this.options.askPrompt = fn
    this.setAsker(cliAsker(fn))
  }
}

/** 把 CLI 的文本答复翻成四态；无法识别返回 `undefined` ⇒ 引擎按 deny 处理（与改造前逐位一致） */
export function parseCliAnswer(answer: string): PermissionAnswer | undefined {
  const low = answer.toLowerCase()
  // 先判断"永久"：answer 保留大小写（A/D 直接表示永久），否则"always"/"never"语义
  if (low === 'always' || low === 'all' || answer === 'A') return 'always-allow'
  if (low === 'never' || low === 'none' || answer === 'D') return 'always-deny'
  if (['y', 'yes', 'a', 'allow'].includes(low)) return 'allow'
  if (['n', 'no', 'd', 'deny'].includes(low)) return 'deny'
  return undefined
}

/** 组装 CLI 的 asker：默认 readline 行内提问；`askPrompt` 可替换为 TUI 模态 */
function cliAsker(askPrompt?: (question: string) => Promise<string>): PermissionAsker {
  const ask = askPrompt ?? defaultCliAsk()
  return async (_req, prompt) => parseCliAnswer(((await ask(prompt.text)) ?? '').trim())
}

/** 默认 CLI 读行（process.stdin/readline） */
function defaultCliAsk(): (q: string) => Promise<string> {
  return (q: string) => new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(q, (ans) => { rl.close(); resolve(ans) })
  })
}

// ========================================================================
// 4. HarnessApp：CLI 对宿主装配的薄适配（P0 收尾 S2 第三步）
// ========================================================================
// 装配主体（会话持久化、权限存储、插件装配、boot 全流程 —— 约 1150 行、56 个成员）已上移到
// `@harness/host` 的 `HarnessHost`。CLI 只留两件**终端形态**的事，都在构造期装成接缝：
//   ① `stdout` → `onNotice`（`renderNotice` 复刻的正是搬迁前写进 stdout 的那串字节 ⇒ 文案零变化）
//   ② `askPrompt` / readline → `asker`（文本 → 四态的翻译留在这里：`y/n/a/d/A/D` 是 CLI 的输入
//      词汇，不是协议；远程宿主直接给四态，不该被迫走"伪造文本再解析回来"的往返）
//
// 用**继承**而非组合：实测 56 个成员 0 个 CLI 专属，"宿主"与"CLI 宿主"本就是同一件事的两种
// 终端形态（设计稿 §7 分叉 1）。CLI 专属的适配器（`CliPermissionEngine` / `cliAsker` /
// `defaultCliAsk` / `formatAgo` / `describeSessionRestore`）也**不在类里**，见设计稿 §2.7。

/** CLI 专属选项：在宿主选项之上加「终端输出」与「文本提问」两个适配面 */
export interface HarnessAppOptions extends HostOptions {
  /** 终端输出流。装配期诊断经 `renderNotice` 写这里；缺省落到 `process.stdout`（与搬迁前一致） */
  stdout?: NodeJS.WritableStream | { write: (s: string) => void }
  /** 文本型询问（测试注入 / TUI 模态）。内部转成四态 `PermissionAsker` */
  askPrompt?: (q: string) => Promise<string>
}

/**
 * M3 审计 sink：按会话写 `{dataDir}/sessions/{id}.audit.jsonl`。
 *
 * **实现已上移到 `@harness/host`**（`packages/host/src/audit.ts`）：审计落盘是**宿主无关**的
 * 能力，而三个宿主都要用它（CLI / A2A（VSCode sidecar 走的就是 A2A）/ 将来其它）。
 * 留在 cli 会让 A2A 宿主要么反向依赖 cli、要么各写一份 —— 后者正是"同一条人工决策换个宿主
 * 就没有审计记录"的成因。这里保留 re-export，导出面逐字不变（见 `cli.test.ts` 的同源断言）。
 */
export { createAuditSink } from '@harness/host'

export class HarnessApp extends HarnessHost {
  /**
   * 窄化基类字段的类型：boot 装的是 `CliPermissionEngine`（TUI 的 `setAskPrompt` 依赖它）。
   * `declare` 不产生运行期字段，不改变基类的赋值行为。
   */
  declare public permission: CliPermissionEngine

  /** 构造期捕获：`createPermissionEngine` 在 boot() 里才被调用，那时基类私有 options 已不可见 */
  private readonly cliAskPrompt?: (q: string) => Promise<string>
  /** M3：审计 sink（per-session writer 池） */
  private readonly auditSink?: (env: AuditEvent) => void
  /** P0-9：归属主体解析（构造期捕获；覆写的 createPermissionEngine 在 boot 里才被调用） */
  private readonly permissionPrincipal?: (sessionId?: string) => string | undefined

  constructor(options: HarnessAppOptions) {
    // 未注入输出流时落到真实 stdout：否则装配期诊断与 logger 的 [WARN]/[ERROR] 会被静默丢掉
    // （如「未配置 ANTHROPIC_API_KEY，自动 fallback 到 Mock」——用户永远看不到）。
    const out = options.stdout ?? process.stdout
    // M3 审计：显式注入（`options.audit`）优先；否则按 `dataDir` 默认建 `createAuditSink`。
    // 同一个值既进 host options（基类默认路径用），又留一份给覆写的 `createPermissionEngine`
    // —— 因为覆写**完全替代**基类工厂，基类那份 `audit: options.audit` 在 CLI 路径上不会执行。
    const audit = options.audit ?? (options.dataDir ? createAuditSink(options.dataDir) : undefined)
    super({
      ...options,
      audit,
      onNotice: (n) => out.write(renderNotice(n)),
      logLine: (line) => out.write(line),
      asker: cliAsker(options.askPrompt),
    })
    this.cliAskPrompt = options.askPrompt
    this.auditSink = audit
    this.permissionPrincipal = options.permissionPrincipal
  }

  /**
   * 覆写权限引擎工厂：装 `CliPermissionEngine`（保留 TUI 的 `setAskPrompt` 形态）。
   * 四态语义 / mode 短路 / 规则写回仍在 host —— 这里只多一层"文本问答"的适配，没有第二份语义。
   */
  protected override createPermissionEngine(
    rules: Record<string, unknown>,
    save: (r: Record<string, unknown>) => Promise<void>,
    mode: PermissionMode,
  ): InteractivePermissionEngine {
    return new CliPermissionEngine(rules, {
      mode,
      askPrompt: this.cliAskPrompt,
      store: { ...(rules as any), save },
      audit: this.auditSink,
      // P0-9：CLI 缺省 = 本机单主体。覆写工厂完全替代基类，故这里必须显式给 —— 否则
      // `always-allow` 会退回**裸工具键**，同一 dataDir 下的远程 A2A 调用方一并继承（§8 D2）。
      callerResolver: this.permissionPrincipal ?? (() => DEFAULT_PERMISSION_PRINCIPAL),
    })
  }
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
        // ★**不 unref**：这次等待是被 await 的。Bun/Windows 上"事件循环里只剩 unref 工作"时
        // 定时器永不到期（upstream #32014）⇒ 自动续轮的退避等待会直接挂死。
        // 总预算 ≤1s（50+100+250+600），钉不住进程该退出。
        setTimeout(r, ms)
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
 * 归集当日（本地时区）跨会话用量：只读持久化会话文件、不写回，
 * 因此重连前当天产生的用量依然可统计 / 可导出。失败时回落为当前会话当日用量。
 */
export async function resolveTodayUsage(app: HarnessApp | undefined, current: Session): Promise<UsageStats> {
  return collectTodayUsage(app?.sessionStore, current)
}

// /stats 的装配函数（resolveCurrentUsage / renderChildAgentRollup / renderContextOccupancy）
// 已上移 @harness/usage（P2-v1：sidecar 的 harness/stats.get 也要用，CLI 不能成为唯一定义处）；
// 这里再导出以维持 './index' 的既有导入面（tui / 测试）。
export {
  resolveCurrentUsage,
  renderChildAgentRollup,
  renderContextOccupancy,
} from './usage-stats'

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
            resolveCompactionWindow(statsCfg, statsProvider, app.resolveSessionEndpoint(s as Session | undefined))))
          out(`\n${todayUsageLine(t)}（全部会话·当日）\n`)
          return 'continue'
        }
        case '/stats-export': {
          const u = await resolveCurrentUsage(harness, current)
          const t = await resolveTodayUsage(app, current)
          // ⚠️ 不能用上面的 `arg`（= `line.split(/\s+/, 2)[1]`，**只截第二个 token**）：
          // `/stats-export md /tmp/x.md` 里的路径会被丢掉 ⇒ 报告静默打到 stdout、文件根本没生成。
          // 与 `/permission` 同一处坑、同一处修法：从 `line` 自己重切。
          const [fmtArg, pathArg] = line.split(/\s+/).slice(1).filter(Boolean)
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
          // 同 `/stats-export`：关键词可能多词，必须从 `line` 重切（`arg` 只到第二个 token）
          const keyword = line.split(/\s+/).slice(1).join(' ').trim()
          if (!keyword) { out('用法：/search <keyword>\n'); return 'continue' }
          const results = await harness.session.search(keyword)
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
          // 查看：/permission；设置：/permission <mode> [global] 或 /permission <key>=<behavior>
          if (!arg || arg.trim() === '?') {
            out(`权限交互模式：${app.permission.getMode(current.id)}（本会话；allow-all / ask / deny-all）\n`)
            out(`进程默认模式：${app.permission.getMode()}（新会话的初值；/permission <mode> global 可改）\n`)
            out('当前规则（permissions.json）：\n')
            const rules = app.permission.getRules() as Record<string, unknown>
            const keys = Object.keys(rules)
            if (keys.length === 0) { out('  （无规则，全局默认 ask）\n'); return 'continue' }
            for (const k of keys) out(`  ${k.padEnd(14)}: ${JSON.stringify(rules[k])}\n`)
            out('\n用法：/permission <allow-all|ask|deny-all>          切换本会话交互模式\n')
            out('      /permission <allow-all|ask|deny-all> global 切换进程默认模式（影响未单独切换的会话）\n')
            out('      /permission <key>=<behavior>                设置工具规则，如 /permission bash=deny、/permission write=ask\n')
            out('      /permission reset                          恢复为全局 ask 并清空规则\n')
            return 'continue'
          }
          const t = arg.trim()
          if (t === 'reset') {
            await app.setPermissionRules({ '*': 'ask' }, { source: 'cli', behavior: 'reset', sessionId: current.id })
            // P2-7：模式是**会话级**的，重置也只重置本会话这一层（进程默认不动）
            app.permission.setMode('ask', current.id)
            out('已重置权限：规则清空（全局 ask），本会话模式=ask，并写回 permissions.json。\n')
            return 'continue'
          }
          const eq = t.indexOf('=')
          if (eq > 0) {
            const key = t.slice(0, eq).trim()
            const val = t.slice(eq + 1).trim()
            if (!['allow', 'deny', 'ask'].includes(val)) {
              out(`非法行为 "${val}"（allow / deny / ask）。\n`); return 'continue'
            }
            // 局部变量叫 `rules` 而不是 `current`：`current` 是本轮会话（上面几处都在用
            // `current.id`），若在这里 shadow 成规则对象，下面传 sessionId 就会拿到规则集。
            const rules = app.permission.getRules() as Record<string, unknown>
            const updated = { ...rules, [key]: val }
            await app.setPermissionRules(updated, { source: 'cli', key, behavior: val, sessionId: current.id })
            out(`已设置规则 ${key}=${val} 并写回 permissions.json。\n`)
            return 'continue'
          }
          // P2-7（§8 D7）：模式本来只写清了"进程级"的实情，却被读成"只对本会话生效"。
          // 现在**默认本会话**（与读法一致），要全进程用显式的 `global` 后缀 —— 能力没丢，
          // 只是不再由一个会话静默改掉别的会话（A2A 远程调用方尤其如此）。
          // ⚠️ 不能用上面的 `arg`：它是 `line.split(/\s+/, 2)[1]`，只截到第二个 token，
          //    `ask global` 里的 `global` 会被丢掉。这里从 `line` 自己切。
          const parts = line.split(/\s+/).slice(1)
          const modeArg = parts[0]
          const isGlobal = parts.length === 2 && parts[1] === 'global'
          if (modeArg && ['allow-all', 'ask', 'deny-all'].includes(modeArg)) {
            app.permission.setMode(modeArg as 'allow-all' | 'ask' | 'deny-all', isGlobal ? undefined : current.id)
            const scope = isGlobal ? '进程默认：影响所有未单独切换的会话' : '仅本会话'
            out(`已切换权限交互模式为 ${modeArg}（${scope}；作用于「询问型」请求，规则文件不变）。\n`)
            return 'continue'
          }
          out(`无法解析 "${t}"。/permission 查看，/permission <mode> [global] 或 /permission <key>=<behavior> 设置。\n`)
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
            // 生成式 UI：ui_widget 的结果由 TUI 经流事件渲染为 widget 块，console 文本通道
            // 跳过调用行与结果行，避免双渲染；REPL（无 onEvent）无 widget 渲染器，
            // 结果行给单行摘要降级（见 tool_call_result）。
            if (ev.toolId === 'ui_widget') break
            // 入参完整打印（工具的"命令行"就是它的入参，截断即无法复核）
            out(`🔧  ${ev.toolId} ${formatToolInput(ev.input)}\n`)
            break
          case 'tool_call_result': {
            const status = ev.isError ? '❌' : '✅'
            onEvent?.(ev)
            if (ev.toolId === 'ui_widget') {
              // REPL/headless 降级：渲染器单行摘要；失败仍按错误可见
              if (!onEvent) {
                const w = widgetFromToolResult(ev.toolId, ev.result)
                out(`${w ? renderWidgetText(w.widgetType, w.props) : formatToolResult(ev.result, false)}\n`)
              }
              break
            }
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
  harness a2a [--port <n>] [--token <t>] [--json]   以 A2A 服务启动（默认仅监听 127.0.0.1）
  harness help | -h | --help            显示帮助

teammate 选项:
      --team <team>           所属团队名（sanitize 后）
      --name <name>           成员名（sanitize 后）

a2a 选项:
      --port <n>              JSON-RPC 端点端口（默认 4321；监听地址恒为 127.0.0.1）
      --token <t>             Bearer token：配了则校验并在卡片声明安全方案；不配则匿名（仅本机）
                              取卡：GET http://127.0.0.1:<port>/.well-known/agent-card.json
      --json                  以「单行 JSON 握手」启动：stdout 只输出一行机器可读的端点信息
                              （供扩展 / 脚本 spawn 后确定性地取端点，不必解析人类可读文案）

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
 * `harness a2a` 子命令：以 A2A（Agent2Agent）服务端启动。
 *
 * ## 为什么复用 `createHost` 而不是 `HarnessApp`
 * A2A 是**无终端**宿主：`HarnessApp` 多带的两个终端适配面（`stdout → onNotice`、
 * `askPrompt → asker`）在这里没意义，反而会把"装配"与"终端形态"重新绑回一起。
 * `createHost` 是 host 暴露的"一步装配 + 启动"，与 VSCode 扩展将来要走的路同一条。
 *
 * ## 权限模式的取舍（值得写下来）
 * 默认 `ask`：远程权限点应转 `INPUT_REQUIRED` 挂起、等客户端答复（P1 的核心机制）。
 * 传 `--permission allow-all` 会让引擎直接放行、**完全不挂起** —— 那是"信任调用方"的
 * 主动选择，不是默认；help 里已标明。`deny-all` 同理（一律拒绝、也不挂起）。
 *
 * ## 为什么这里不自己装 asker
 * `createA2aServer` 会把 executor 的 asker 装回 host 的权限引擎（那一步只有它做得到，
 * 因为 executor 是它建的）。CLI 侧**不要**再传 `asker`，否则就是两份装配在抢同一个接缝。
 */
export async function runA2aCli(options: {
  args: CliArgs
  cwd: string
  dataDir: string
  provider: string
  model: string | undefined
  agentId: string
  providers?: ProviderConfig[]
  anthropicApiKey?: string
  snapshot: boolean
  permissionMode: 'allow-all' | 'ask' | 'deny-all'
  write: (s: string) => void
}): Promise<number> {
  const { args, cwd, dataDir, provider, model, agentId, providers, anthropicApiKey, snapshot, permissionMode, write } =
    options

  const port = args.a2aPort ?? DEFAULT_A2A_PORT
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    write(`无效端口: ${String(args.a2aPort)}（应为 0~65535 的整数）\n`)
    return 1
  }

  const host = await createHost({
    cwd,
    dataDir,
    agentId,
    provider,
    ...(model !== undefined ? { model } : {}),
    ...(providers ? { providers } : {}),
    ...(anthropicApiKey ? { anthropicProviderConfig: { apiKey: anthropicApiKey } } : {}),
    permissionMode,
    verbose: args.verbose,
    snapshot,
    allowPluginCode: args.allowPluginCode ?? false,
    // M3 审计（A2A / VSCode 宿主的落盘接入）：远程权限点经 executor 的挂起桥问到人之后，
    // 决策同样要落 `{dataDir}/sessions/{id}.audit.jsonl`。VSCode 扩展的 sidecar 正是本命令
    // （`harness a2a --json --port 0`），故这一处接入即覆盖 A2A 与 VSCode 两个宿主。
    audit: createAuditSink(dataDir),
    // A2A 是服务端：不该"恢复上次会话"（会话由 contextId 显式寻址），也不该在 boot 末尾
    // 静默预加载 —— 启动提示应当是确定性的。
    autoResume: false,
    backgroundPreload: false,
    // 装配期诊断（"无 key 回落到 Mock"这类**必须让调用方知道**的事实）走 stderr，
    // 不混进 stdout（那是给服务启动信息用的）。
    onNotice: (n) => process.stderr.write(renderNotice(n)),
  })

  const server = createA2aServer({
    host,
    port,
    ...(args.a2aToken ? { token: args.a2aToken } : {}),
    logger: {
      info: (m, meta) => process.stderr.write(`[a2a] ${m} ${meta ? JSON.stringify(meta) : ''}\n`),
      warn: (m, meta) => process.stderr.write(`[a2a] ${m} ${meta ? JSON.stringify(meta) : ''}\n`),
    },
  })

  const origin = new URL(server.url).origin
  const cardUrl = `${origin}/${AGENT_CARD_PATH}`

  if (args.json) {
    // 单行 JSON 握手：**stdout 只有这一行**。
    //
    // 为什么需要它（而不是让调用方解析下面那段人类可读文案）：`--port 0` 时端口由内核分配，
    // 调用方**必须**从进程输出里拿回真实端点；而解析带中文标签的多行文本，是一个"文案改一个
    // 字就静默崩掉"的耦合面。握手把这件事变成一个显式的、可版本化的契约（`v` 字段）。
    write(
      `${JSON.stringify({
        v: 1,
        pid: process.pid,
        port: server.port,
        protocolVersion: A2A_PROTOCOL_VERSION,
        rpcUrl: server.url,
        cardUrl,
        controlUrl: server.controlUrl,
        auth: args.a2aToken ? 'bearer' : 'anonymous',
        permissionMode,
        cwd: host.workspace.cwd,
      })}\n`,
    )
  } else {
    write(`A2A 服务已启动\n`)
    write(`  JSON-RPC 端点: ${server.url}\n`)
    write(`  AgentCard:     ${cardUrl}\n`)
    // 控制面（P2-A）：与协议面并列的另一条路径 —— CLI 斜杠命令里"改本进程状态"那 12 条
    // 在 A2A 协议里无处安放，走这里。see packages/a2a-server/src/control.ts
    write(`  控制端点:      ${server.controlUrl}（${listControlMethods().length} 个 harness/* 方法）\n`)
    write(`  认证:          ${args.a2aToken ? 'Bearer（已配置）' : '匿名（仅 127.0.0.1 可达）'}\n`)
    write(`  权限模式:      ${permissionMode}${permissionMode === 'ask' ? '' : '（不会产生 INPUT_REQUIRED 挂起）'}\n`)
    write(`  Ctrl-C 退出\n`)
  }

  // json 模式：握手之后 stdout 不再出现任何字节（调用方可能只读一行就停）——
  // 停机提示这类人类信息改走 stderr。
  const notice = args.json ? (s: string) => process.stderr.write(s) : write

  await new Promise<void>((resolve) => {
    const bye = () => {
      notice('\n[a2a] 正在停止...\n')
      server.stop(true)
      resolve()
    }
    process.once('SIGINT', bye)
    process.once('SIGTERM', bye)
  })
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

  if (args.command === 'a2a') {
    return runA2aCli({
      args,
      cwd,
      dataDir,
      provider,
      model,
      agentId,
      providers: cfg.providers,
      anthropicApiKey,
      snapshot,
      permissionMode,
      write,
    })
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
