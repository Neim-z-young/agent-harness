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
  MultiDirLoader,
  normalizeDirs,
  createWorkspaceOriginalStore,
  type Workspace,
  type SessionFile,
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
  hydrateUsage,
  isBlankUsage,
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
   * 启动时经 cli.mcp.configure Hook 注入 mcp-server-registry 插件；/mcp 命令可即时启用/禁用并写回。
   */
  mcpServers?: McpServerEntry[]
  /**
   * 内置插件启用列表（**声明式，无需写 `.harness/plugins/*.ts`**）。
   *
   * 元素取 BuiltinPluginRegistry 的 id，例如 `["code-intel", "subagent", "coordinator"]`。
   * 依赖按插件上的 dependsOn 自动补齐（如 coordinator → subagent、computer-use → mcp.server-registry），
   * 安装顺序由 core 的拓扑排序保证（宿主先装）；未登记的 id 只告警、不阻断启动。
   * 与外部插件目录并存时按 id 去重（外部插件目录优先，便于临时替换实现）。
   *
   * 这里的插件实例一律用**无参工厂**创建：需要的配置从别处来（子 Agent 定义取 AgentRuntime
   * 注册表、coordinator 的 forceAsync 走 HARNESS_FORCE_ASYNC 环境变量）；要带参装配
   * （如自定义 subagents 数组）请改用外部插件目录 `.harness/plugins/*.ts` + 下方 `allowPluginCode`。
   */
  plugins?: string[]
  /**
   * 长期记忆（`@harness/memory`）的参数覆盖，**与 `plugins: ["memory"]` 配合**。
   *
   * 只覆盖参数、不负责启用：启用仍看 `plugins` 里有没有 `"memory"`（写了本段却未启用会告警）。
   * 这是目前唯一"带参装配"的内置插件 —— `plugins` 数组只表达「启用」，而记忆的攒批轮数、
   * 注入上限这类参数需要按人/按项目调，且不宜写死在组合根。
   */
  memory?: {
    /**
     * 攒批轮数：记忆**文件**变更后，最多再等几轮才把新内容换进 system prompt。
     *
     * 一轮 = 一次「用户输入 → Agent 跑完」（**不是**一次模型调用；一轮内多步只算一轮）。
     * `0` = 立即生效；缺省 **15**。期间若发生上下文压缩则提前发布（那时缓存本就失效，
     * system 变更搭车不额外花钱）。它的定位是「防静默失效的兜底」，不是节流目标。
     */
    flushAfterTurns?: number
    /** 记忆索引注入上限（行，缺省 200）；超出部分不会被加载 */
    maxLines?: number
    /** 记忆索引注入上限（字节，缺省 25600） */
    maxBytes?: number
    /** 只保留 `/memory` 命令、完全不做注入（对照实验用） */
    disableInjection?: boolean
  }
  /**
   * 是否允许加载**外部插件目录里的代码**（`.harness/plugins/*.ts|js|mjs`，默认 **false**）。
   *
   * 为什么默认关：那些文件是可执行代码。若无条件 `import()`，克隆一个带 `.harness/plugins`
   * 的仓库、在该目录里跑一次 harness 就会执行他人代码（代码注入）。声明式 `plugins` 数组已能
   * 覆盖内置能力，绝大多数场景不需要开这个闸。
   *
   * 注意：开闸后**不会**为插件目录补任何 node_modules 软链（那等于把 harness 内核依赖树暴露
   * 给工作目录下的任意文件），插件需放在能解析到其依赖的位置。
   */
  allowPluginCode?: boolean
  /** 开启文件快照 + /revert 能力（默认 false）；CLI `--snapshot` 优先覆盖此行 */
  snapshot?: boolean
  /**
   * 启动时自动恢复上次会话（默认 **true**）。
   * 规则：不带 `-s/--session` 启动 REPL/TUI 时，取「当前工作目录」内 updatedAt 最新的
   * 会话继续；目录不匹配的会话不会被误恢复。`--no-resume` 可临时关闭。
   */
  autoResume?: boolean
  /**
   * 兼容的嵌套写法（表现同顶层 snapshot）：`{ "harness": { "snapshot": true } }`。
   * 若顶层 snapshot 未填，则回退读此字段。
   */
  harness?: { snapshot?: boolean }
  /**
   * 通用遥测（本地采集为主 + 可选 OTLP）。**写出 `telemetry` 段才装配** `@harness/telemetry`
   * 插件（默认不启用，避免生成遥测文件）；开启后按会话写
   * `dataDir/sessions/{sessionId}.telemetry.jsonl`（bus 事件 → 统一 envelope），
   * 附带崩溃兜底（SIGTERM/SIGHUP / uncaughtException → telemetry.crash）。
   */
  telemetry?: {
    /** 总开关（默认 true，仅在该段存在时生效） */
    enabled?: boolean
    /** 会话文件路径生成（缺省 `{dataDir}/sessions/{sessionId}.telemetry.jsonl`） */
    path?: string
    /** 批量 flush 间隔 ms（缺省 500） */
    debounceMs?: number
    /** 是否挂崩溃兜底（缺省 true） */
    crash?: boolean
    /** 跨会话匿名 user id（缺省从 `.config-key` 派生，仅供聚合，非明文） */
    userId?: string
    /** 可选 OTLP 上报：endpoint 非空才启用（collector 根地址，如 `https://collector:4318`） */
    otlp?: {
      /** 总开关（默认 true，endpoint 非空即启用） */
      enabled?: boolean
      /** collector 端点；为空则完全不上报 */
      endpoint?: string
      /** 附加请求头（如 API key） */
      headers?: Record<string, string>
    }
  }
  /**
   * ACP 上下文压缩配置（`compression.enabled: true` 开启才装配 @harness/acp-context 插件）。
   * 装配后运行 @harness/acp-context 的 runPreModel：保留历次折叠的 source:'acp' 压缩块到统一块模型。
   */
  compression?: {
    /** 是否启用 ACP 上下文压缩（默认 false）。 */
    enabled?: boolean
    /**
     * 按上下文窗口自动推导 compression/nudge 参数（默认 false = 用下面的原始参数控制）。
     *
     * 开启后 `preserveRecentTokens` / `nudge.*` / `compress.minCompressRange` 会按
     * `modelContextLimit` 推导（见 docs/acp-context-config.md §7.4）；**显式写出**的字段
     * 仍优先覆盖推导值，故可「自动打底 + 手工钉一两个键」。
     */
    autoTune?: boolean
    /**
     * token 折算口径（默认 `'auto'`）。
     *
     * - `'auto'`：与 acp-kernel 共用 `defaultCountTokens` —— 中日韩字符 1 token/字、
     *   其余 4 字符/token。**英文会话与旧口径逐位等价**；中文会话修正原先约 4 倍的低估
     *   （旧口径下中文占用率恒显示真值的 1/4，`maxContextLimitPct` /
     *   `emergencyThresholdPct` 等百分比闸门整体偏晚，折叠会被拖到真实已超窗之后）。
     * - `'chars4'`：旧口径，一律 `chars/4`。仅作回退与 A-B 对照。
     */
    tokenCalibration?: 'auto' | 'chars4'
    /**
     * 模型上下文窗口（输入 tokens）显式覆盖。缺省时按「当前默认 Provider 的
     * providers[].contextWindowTokens → 插件默认 200_000」推导。
     */
    modelContextLimit?: number
    /** 覆盖 t1/t2/t3 压缩及压缩哲学的提示词（key 见 acp-kernel Prompts，load-bearing） */
    prompts?: Partial<import('acp-kernel').Prompts>
    /** 整段覆盖压缩系统提示（优先级最高，覆盖 prompts 合成的压缩系统提示） */
    systemPrompt?: string
    /** 层保留：保留最近 N 条原始消息（其余按窗口折叠） */
    preserveRecentMessages?: number
    /** 层保留：最近 N tokens 的原始上下文始终保留不压缩 */
    preserveRecentTokens?: number
    /** 块"存活次数"达该值才升层（promotionThreshold，kernel 默认 5；设极大如 1e9 可选为不升层） */
    promotionThreshold?: number
    /** t1/t2/t3 各层压缩触发阈值 */
    tiers?: {
      /** 活跃 t1 块数达到该值才把部分 t1 蒸馏为 t2（默认 5） */
      tier2Trigger?: number
      /** 活跃 t2 块数达到该值才把部分 t2 压缩为 t3（默认 10） */
      tier3Trigger?: number
    }
    /** 上下文压力档位（nudge 触发阈值） */
    nudge?: {
      /** 触发"效率型"压缩提醒的上下文占用下限（默认 0.2 = 20%） */
      maxContextLimitPct?: number
      /** nudge 提示的上下文占用下限（默认 0.02） */
      minContextLimitPct?: number
      /** 紧急提醒占用：≥ 该比例无条件提醒（默认 0.98） */
      emergencyThresholdPct?: number
    }
    /** 高级透传：不入上面的结构化字段的其它 kernel config（compress / truncate / protectedTools 等） */
    config?: Record<string, unknown>
    /**
     * 运行时遥测（默认开启）：每轮 preModel 把压缩指标 / ACP 缓存命中 / 配置快照
     * 追加写入 `dataDir/sessions/{sessionId}.telemetry.jsonl`。
     * 关闭后不写任何遥测文件（零开销）。离线用 `bench/report.ts` 分析。
     */
    telemetry?: { enabled?: boolean }
  }
  /**
   * **会话压缩**（`session.compact` / `/compact`，与上面的 ACP 是**两套独立机制**）。
   *
   * 区别：ACP 按 token 分级折叠、**每轮自动**、摘要可解压回溯；会话压缩按**消息条数**裁剪
   * （丢弃旧消息原文 + 留一段摘要），只在 REPL 启动与 `/compact` 时判定一次。
   * 两者可并存，但会话压缩会丢原文，与 ACP 同时激进启用会造成重复压缩。
   */
  compaction?: {
    /**
     * 压缩策略（默认 `'summary'`）
     * - `prune`：只截断旧消息，不生成摘要（信息全丢）
     * - `summary`：对被截断的窗口做轻量规则摘要（按消息类型统计 + 首尾要点）
     * - `agent`：调 LLM 生成摘要（失败自动 fallback 到 summary）
     */
    strategy?: 'prune' | 'summary' | 'agent'
    /**
     * 自动压缩的触发阈值（估算 token 占「可用窗口 = 窗口 − reservedTokens」的百分比，默认 80）。
     *
     * 注意：窗口**不在本段配置**，按 `compaction.contextWindowTokens → compression.modelContextLimit
     * → 默认 Provider 的 contextWindowTokens → 200000` 推导。早些版本 core 内硬编码 200000，
     * 于是 providers 写 102400 时阈值算成 136000 > 窗口本身 ⇒ 永远压不到；
     * 想临时指定窗口可用 `contextWindowTokens` 覆盖。
     */
    autoCompactThresholdPct?: number
    /** 给摘要生成预留的 tokens（默认 30000，参考 Claude Code 的 20K max output + 13K buffer） */
    reservedTokens?: number
    /**
     * 上下文窗口显式覆盖。缺省时按上述优先级推导（推荐留空，跟着 Provider 走）。
     * 乱填会把阈值算到窗口之上或之下，同样导致"配了却不生效"。
     */
    contextWindowTokens?: number
    /** 压缩后保留的最近消息数（user+assistant 算一对；默认 10 条 = 5 轮对话） */
    keepRecentMessages?: number
    /** 摘要最大字符数（仅 summary / agent 策略；默认 8000） */
    summaryMaxChars?: number
    /**
     * token 折算口径（默认 `'auto'` = CJK 感知，与 ACP 层同一口径）。
     * `'chars4'` 会让中文会话的估算只有真值约 1/4 ⇒ 自动压缩更难触发。仅作回退与 A-B 对照。
     */
    tokenCalibration?: 'auto' | 'chars4'
  }
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

/**
 * 已归一化的 Provider 定义：`id` 必定存在（显式指定，或由 `normalizeProviderConfigs` 从 model 派生）。
 * 归一化之后的下游代码（装配 / 路由 / 展示）一律按「id 必有」处理，无需到处判空。
 */
export interface ResolvedProviderConfig extends ProviderConfig {
  id: string
}

/** 把任意字符串规整为可用的 id 片段：保留 [A-Za-z0-9._-]，其余折叠为 '-'，去首尾连字符 */
export function sanitizeProviderId(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * 归一化 providers 数组：把可选的 `id` 补全为**确定性且唯一**的实例 id。
 *
 * 设计意图（本函数是「id 不再必须冗长/手写」的落点）：
 * - 显式写了 `id` → 原样保留；重复则报错（沿用旧校验语义，避免静默覆盖注册）。
 * - 未写 `id` 但写了 `model` → 由模型名派生（去 `provider/` 前缀、规整非法字符）；
 *   与已占用 id 冲突时按数组顺序追加 `-2` / `-3`…（结果确定、可复现，无需人工起名）。
 * - `id` 与 `model` 都缺失 → 报错（无从派生）。
 *
 * 纯函数（无 IO），`issues[].index` 对应原始数组下标，便于在报错中定位。
 */
export function normalizeProviderConfigs(raw: ProviderConfig[]): {
  providers: ResolvedProviderConfig[]
  issues: ProviderConfigIssue[]
} {
  const issues: ProviderConfigIssue[] = []
  const taken = new Set<string>()
  const providers: ResolvedProviderConfig[] = []
  raw.forEach((pc, index) => {
    const explicit = pc.id?.trim()
    if (explicit) {
      if (taken.has(explicit)) {
        issues.push({
          index,
          message: `providers[${index}].id "${explicit}" 与前面的 provider 重复（显式 id 必须唯一，否则后注册的会被覆盖；也可省略 id，交由系统按 model 自动派生）`,
        })
      }
      taken.add(explicit)
      // 首个同 id 保留，保持与旧行为一致（默认 provider 仍能在数组中找到）
      if (!providers.some((p) => p.id === explicit)) providers.push({ ...pc, id: explicit })
      return
    }
    const derived = pc.model ? sanitizeProviderId(parseModelSpec(pc.model).modelId) : ''
    if (!derived) {
      issues.push({ index, message: `providers[${index}] 既未写 id 也未写 model，无法派生实例 id（至少填写其一）` })
      return
    }
    let id = derived
    for (let n = 2; taken.has(id); n++) id = `${derived}-${n}`
    taken.add(id)
    providers.push({ ...pc, id })
  })
  return { providers, issues }
}

/**
 * `/model <arg>` 的解析结果。把「用户敲什么」与「怎么切」解耦：
 * 由本函数一次性判定，调用方只负责按 kind 执行/提示，不再散落 `split('/')` 式判断。
 */
export type ModelResolution =
  /** 命中某个配置实例（按序号 / 实例 id / 模型名），provider 与 model 一并确定 */
  | { kind: 'instance'; providerId: string; modelId?: string; matchedBy: 'index' | 'id' | 'model'; index: number }
  /** 显式 `provider/model`（provider 未在当前进程装配时 providerKnown=false，调用方提示即可） */
  | { kind: 'explicit'; providerId?: string; modelId: string; providerKnown: boolean }
  /** 裸模型名：挂到当前 Provider（仅当未配置 providers 实例时允许，保持旧用法） */
  | { kind: 'model'; modelId: string }
  /** 命中多个实例：必须消歧，不静默选第一个 */
  | { kind: 'ambiguous'; arg: string; candidates: Array<{ index: number; id: string; model?: string; type: string; matchedBy: 'id' | 'model' }> }
  /** 序号越界 */
  | { kind: 'bad-index'; arg: string; total: number }
  /** arg 是 Provider **类型**名而非实例，且没有可用模型 → 给出用法提示，不切换 */
  | { kind: 'type-hint'; arg: string }
  /** 已配置 providers 但 arg 谁都不匹配 → 拒绝并提示（避免把拼错的 provider 名当成模型名写进配置） */
  | { kind: 'not-found'; arg: string }

/**
 * 解析 `/model` 的实参，支持四种写法（优先级由高到低）：
 *
 * 1. `id/model`        显式跨 Provider（旧写法，保留）；provider 是否已装配由调用方提示
 * 2. `序号`（如 `2`）    按 `/model ?` 列表序号选择
 * 3. `实例 id`          如 `hy3` —— 命中实例即同时采用其配置的 model
 * 4. `模型名`           如 `hy3`（与实例 id 同名时同样命中）；跨实例重名则要求消歧
 *
 * 兜底（**仅当未配置任何 providers 实例时**）：裸模型名挂当前 Provider，
 * 即 `/model claude-3-7-sonnet` 这类未声明实例的老用法。
 *
 * 为什么要有 `not-found`：旧实现把任何裸词都当模型名写进 config.model，
 * 于是 `/model local-hy4` 这种「想切 provider 却拼错」会静默落成垃圾模型名。
 * 现在只要配置了 providers，裸词必须命中实例，否则明确报错。
 *
 * 纯函数，便于单测。
 */
export function resolveModelArg(
  arg: string,
  providers: ResolvedProviderConfig[],
  knownRefs: Iterable<string> = [],
): ModelResolution {
  const raw = arg.trim()
  // 已知引用 = 显式传入的（实例 id / Provider 类型 / 默认 provider）+ 本次传入的实例 id
  const known = new Set<string>(knownRefs)
  for (const p of providers) known.add(p.id)

  // 1) 显式 provider/model
  if (raw.includes('/')) {
    const { providerId, modelId } = parseModelSpec(raw)
    const providerKnown = !providerId || known.has(providerId)
    return { kind: 'explicit', providerId, modelId, providerKnown }
  }

  // 2) 纯数字 → 列表序号（1-based）
  if (/^\d+$/.test(raw)) {
    const idx = Number(raw)
    if (idx >= 1 && idx <= providers.length) {
      const p = providers[idx - 1]
      return { kind: 'instance', providerId: p.id, modelId: p.model, matchedBy: 'index', index: idx }
    }
    return { kind: 'bad-index', arg: raw, total: providers.length }
  }

  // 3/4) 按实例 id 或模型名命中（两者取并集：仅唯一命中才自动选择）
  const hits = providers
    .map((p, i) => ({ p, index: i + 1 }))
    .filter(({ p }) => p.id === raw || p.model === raw)
  if (hits.length === 1) {
    const { p, index } = hits[0]
    return {
      kind: 'instance',
      providerId: p.id,
      modelId: p.model,
      matchedBy: p.id === raw ? 'id' : 'model',
      index,
    }
  }
  if (hits.length > 1) {
    return {
      kind: 'ambiguous',
      arg: raw,
      candidates: hits.map(({ p, index }) => ({
        index,
        id: p.id,
        model: p.model,
        type: p.type,
        matchedBy: (p.id === raw ? 'id' : 'model') as 'id' | 'model',
      })),
    }
  }

  // 5) 谁都不匹配：未配置 providers → 旧用法（裸模型名挂当前 Provider）
  if (!providers.length) {
    if (known.has(raw)) return { kind: 'type-hint', arg: raw }
    return { kind: 'model', modelId: raw }
  }
  if (known.has(raw)) return { kind: 'type-hint', arg: raw }
  return { kind: 'not-found', arg: raw }
}

/** 把解析结果格式化成可展示的 `provider/model` 引用（用于「已切换模型 X」回显与持久化前预览） */
export function formatResolutionRef(r: ModelResolution): string | undefined {
  switch (r.kind) {
    case 'instance':
      return formatModel(r.providerId, r.modelId) ?? r.providerId
    case 'explicit':
      return formatModel(r.providerId, r.modelId) ?? r.modelId
    case 'model':
      return r.modelId
    default:
      return undefined
  }
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
   * **登记但默认不装配**：不参与 boot 末尾的后台预加载（scheduleBuiltinPreload），
   * 因而不会被自动安装——需经 `config.json → plugins` 声明式启用，或由外部插件目录
   * （.harness/plugins）显式装配。
   *
   * 两种典型用法：
   *  1. 进程内 MCP server 类插件（computer-use / code-intel）：工具要靠 mcp-client 连上才可用，
   *     故只预登记 metaSource 供 /tools 展示，不自动拉起 MCP 通道；
   *  2. 可选能力插件（subagent / coordinator / swarm）：默认不给所有 Agent 注入额外工具与编排 Hook，
   *     由用户按需声明（这类插件通常不提供 metaSource）。
   */
  optIn?: boolean
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
    // 仅携带 metaSource（/tools 可提前展示），optIn=true 使其不被后台预加载实例化——
    // 启用方式二选一（都无需改动 CLI/core）：config.json → plugins: ["code-intel"]，或
    // 外部插件目录 .harness/plugins 里显式装配 createMcpServerRegistryPlugin + createCodeIntelPlugin。
    defaultBuiltinRegistry.register({
      id: 'code-intel',
      name: 'Code Intel',
      description: '代码情报 MCP server 插件（mcp__code-intel__*）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createCodeIntelPlugin: () => AgentPlugin }>('@harness/code-intel')).createCodeIntelPlugin(),
      metaSource: lazyToolMetaSource('@harness/code-intel/meta'),
    })
    // computer-use：进程内 MCP server，工具经 mcp-client 连接后才可用。仅携带 metaSource
    // （/tools 可提前展示 mcp__computer-use__* 元信息），optIn=true 使其不被后台预加载实例化。
    defaultBuiltinRegistry.register({
      id: 'computer-use',
      name: 'Computer Use',
      description: '电脑控制 MCP server 插件（mcp__computer-use__*）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createComputerUsePlugin: () => AgentPlugin }>('@harness/computer-use')).createComputerUsePlugin(),
      metaSource: lazyToolMetaSource('@harness/computer-use/meta'),
    })
    // mcp.server-registry：computer-use / code-intel 这类「进程内 MCP server 插件」的宿主
    // （自身不提供工具，故无 metaSource）。optIn=true → 默认不自动装配：不给用不到的能力拉起
    // MCP 通道；**必须在 core.harness.start 之前**装好，否则 applyMcpServers 的 cli.mcp.configure
    // 注入与 start 时的连接都会落空（这正是它不能靠「后台预加载」补装的原因）。
    // 由 config.json → plugins 声明式启用（依赖闭包也会自动补上），或外部插件目录显式装配。
    defaultBuiltinRegistry.register({
      id: 'mcp.server-registry',
      name: 'MCP Server Registry',
      description: 'MCP Server 注册表（连接进程内/外部 MCP server 并暴露其工具，提供 /mcp 命令）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createMcpServerRegistryPlugin: () => AgentPlugin }>('@harness/mcp-server-registry')).createMcpServerRegistryPlugin(),
    })
    // ── Agent 编排类插件（subagent / coordinator / swarm）──
    // 与 tools-* 的区别是 **optIn**：登记只让它们「可声明」（config.json → plugins 校验/补全、
    // /plugins 可见），不自动装配——不给用不到的会话注入 subagent 工具与编排 Hook。
    //
    // **工厂一律不传参**：这些能力的「配置」本就不该写在组合根——
    //   · 子 Agent 定义以 AgentRuntime 注册表为准（md frontmatter 定义），插件里的
    //     `subagents` 数组只是「本插件自注册」的兜底，写死会与注册表形成两个口径；
    //   · coordinator 的 forceAsync 走环境变量 HARNESS_FORCE_ASYNC，其余选项取默认。
    // 需要带参的装配用外部插件目录（.harness/plugins/*.ts）。
    defaultBuiltinRegistry.register({
      id: 'subagent',
      name: 'Subagent',
      description: '子 Agent 派工：subagent 工具 + /subagents 命令（目标取 AgentRuntime 注册表）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createSubagentPlugin: () => AgentPlugin }>('@harness/subagent')).createSubagentPlugin(),
    })
    defaultBuiltinRegistry.register({
      id: 'coordinator',
      name: 'Coordinator',
      description: '主 Agent 编排：四阶段派工 + barrier 自动续轮 + send_message（依赖 subagent，自动补齐）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createCoordinatorPlugin: () => AgentPlugin }>('@harness/coordinator')).createCoordinatorPlugin(),
    })
    defaultBuiltinRegistry.register({
      id: 'swarm',
      name: 'Swarm',
      description: '长期在线团队协作：Team / Mailbox / Task List 工具（leader 侧；teammate 由 `harness teammate` 启动）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createSwarmPlugin: () => AgentPlugin }>('@harness/swarm')).createSwarmPlugin(),
    })
    // ── 外部集成类插件 ──
    // herdr：把 Agent 状态（working / idle / blocked）上报到 Herdr 侧栏。
    // optIn + 环境内自查双保险：未声明 ⇒ 不加载；已声明但不在 Herdr pane 内 ⇒ install 时
    // 检测不到 HERDR_ENV=1 就返回空 Hooks（零进程、零副作用）。所以**常驻声明也安全**。
    defaultBuiltinRegistry.register({
      id: 'herdr',
      name: 'Herdr Agent State',
      description: '把 Agent 状态上报到 Herdr 终端复用器侧栏（仅在 Herdr pane 内生效，环境外为 no-op）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createHerdrPlugin: () => AgentPlugin }>('@harness/herdr')).createHerdrPlugin(),
    })
    // memory：长期记忆（L0 项目指令 AGENTS.md + L1 记忆索引 MEMORY.md）注入 system prompt。
    // optIn：不声明 `plugins: ["memory"]` 就完全不加载 —— 记忆会占用 system（永不回收的窗口成本），
    // 必须由用户显式开启。无工作区视图时插件自身也会退化为空 Hooks（宁可不做也不猜路径）。
    defaultBuiltinRegistry.register({
      id: 'memory',
      name: 'Memory',
      description: '长期记忆：加载两级 MEMORY.md 索引与 AGENTS.md 项目指令并注入 system prompt（子 Agent 不注入）',
      source: 'builtin',
      optIn: true,
      load: async () => (await lazyImport<{ createMemoryPlugin: () => AgentPlugin }>('@harness/memory')).createMemoryPlugin(),
    })
    // skill-forge：技能锻造（F1/F2）。optIn：会往 skills 目录写文件，必须显式声明才启用。
    // 与 memory 互补：单条事实进记忆，多步流程进技能（见 docs/memory-and-skill-forge-plan.md §0）。
    defaultBuiltinRegistry.register({
      id: 'skill-forge',
      name: 'Skill Forge',
      description: '技能锻造：从会话工具轨迹生成技能草稿，人工确认后落盘为 SKILL.md 并当轮生效（/skill-forge）',
      source: 'builtin',
      optIn: true,
      load: async () =>
        (await lazyImport<{ createSkillForgePlugin: () => AgentPlugin }>('@harness/skill-forge')).createSkillForgePlugin(),
    })
  }
  return defaultBuiltinRegistry
}

/**
 * 校验 config.json → `plugins` 里的 id 是否都在 BuiltinPluginRegistry 登记（只查表，不加载模块）。
 * 供 `harness config check` 与 boot 的告警使用。
 */
export function unknownBuiltinPluginIds(ids: string[] | undefined, registry = getBuiltinRegistry()): string[] {
  const wanted = [...new Set((ids ?? []).map((s) => String(s).trim()).filter(Boolean))]
  return wanted.filter((id) => !registry.has(id))
}

/**
 * 解析 config.json → `plugins`（内置插件 id）→ 插件实例（含 dependsOn 依赖闭包）。
 *
 * 这是与「外部插件目录 .harness/plugins」并列的第二条装配路径：只想开一个内置能力的用户
 * 改一行配置即可，**不必写代码**，也不必知道 mcp.server-registry 这种宿主插件的存在——
 * 依赖按实例上的 dependsOn 递归补齐（如 computer-use → mcp.server-registry）。
 * 同一批实例交给 core 的 loadInternal，由它按 dependsOn 拓扑排序保证宿主先安装。
 *
 * 失败隔离：未登记的 id / 单个模块加载失败都只记入 `unknown` 并继续，不阻断 boot。
 *
 * @returns plugins：按声明顺序去重的实例；unknown：未登记或加载失败的 id 描述
 */
export async function resolveBuiltinPlugins(
  ids: string[] | undefined,
  registry = getBuiltinRegistry(),
): Promise<{ plugins: AgentPlugin[]; unknown: string[] }> {
  const plugins: AgentPlugin[] = []
  const unknown: string[] = []
  const done = new Set<string>()
  const queue = [...(ids ?? [])]
  while (queue.length) {
    const id = String(queue.shift() ?? '').trim()
    if (!id || done.has(id)) continue
    const entry = registry.get(id)
    if (!entry) { unknown.push(id); continue }
    done.add(id)
    try {
      const plugin = await entry.load()
      plugins.push(plugin)
      for (const dep of plugin.dependsOn ?? []) if (!done.has(dep)) queue.push(dep)
    } catch (err) {
      unknown.push(`${id}（加载失败：${(err as Error)?.message ?? String(err)}）`)
    }
  }
  return { plugins, unknown }
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
 *
 * ## 安全：插件代码默认不加载
 * 插件目录里的 `.ts/.js/.mjs` 是**可执行代码**。若无条件 `import()`，那么克隆一个带
 * `.harness/plugins/*.ts` 的仓库、在该目录里跑一次 harness 就会执行他人代码（代码注入）。
 * 故默认**只扫描不加载**：`opts.allowCode` 为 false 时仅告警并返回空。真正需要扩展能力时二选一：
 *   1. **声明式启用内置插件**（推荐，零代码）：`config.json → "plugins": ["code-intel"]`；
 *   2. **显式开闸**：`config.json → "allowPluginCode": true` 或启动参数 `--allow-plugin-code`。
 *
 * ## 安全：不为插件目录补任何 node_modules 软链
 * 曾实现过「裸依赖解析不到就软链到 harness 内核的 node_modules」，已移除：那等于把 harness
 * 内核的整棵依赖树暴露给工作目录下的任意文件（且软链会被写进用户仓库、被提交、还可能悬空）。
 * 裸依赖解析不到就是解析不到——自定义插件应放在能解析到其依赖的位置。
 */
export async function loadPluginDirs(
  registry: ProviderTypeRegistry,
  dirs: Array<string | { dir: string; source?: 'user' | 'project' }>,
  log?: (s: string) => void,
  opts: { allowCode?: boolean } = {},
): Promise<PluginLoadResult> {
  const out = log ?? ((s: string) => { if (typeof process !== 'undefined') process.stderr.write(s + '\n') })
  // 枚举交给通用多级目录加载器（workspace 收敛「scan + 来源标注」），来源顺序 user → project
  const items = new MultiDirLoader(normalizeDirs(dirs)).scan({ name: (n) => /\.(ts|js|mjs)$/.test(n) })
  // 默认闸门：代码注入防护 —— 只登记文件、不执行
  if (!opts.allowCode) {
    if (items.length) {
      out(`已跳过 ${items.length} 个插件代码文件（默认不加载外部插件代码，防止代码注入）：\n`)
      for (const it of items.slice(0, 5)) out(`  - ${it.full}\n`)
      if (items.length > 5) out(`  …… 其余 ${items.length - 5} 个\n`)
      out('  启用内置能力请改用 config.json → "plugins": ["code-intel"]（零代码，推荐）；\n')
      out('  确需加载自定义插件代码时，设置 config.json → "allowPluginCode": true 或启动参数 --allow-plugin-code。\n')
    }
    return { plugins: [] }
  }
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
      const msg = (err as Error)?.message ?? String(err)
      out(`插件加载失败 ${full}：${msg}\n`)
      if (/Cannot find (?:module|package)\s+["']/.test(msg)) {
        out('  （该插件目录无法解析裸依赖：请把它放在能解析到依赖的位置；或改用 config.json → "plugins" 声明式启用内置能力）\n')
      }
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
 * - type 未知 → 报错（列出已注册类型）
 * - 默认 provider 指向未定义的 id（非内置 mock/anthropic）→ 报错
 *
 * 注：id 的存在性/唯一性由 `normalizeProviderConfigs` 前置保证（缺省按 model 派生、重名加序号、
 * 显式重复报错），因此本函数收到的是已归一化的列表，`!pc.id` 分支仅为防御性兜底。
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

/**
 * 归一化 + 校验的组合入口（供 `config check` / `--check-config` 使用，与 boot 同一套语义）：
 * 先按 model 派生缺省 id（`normalizeProviderConfigs`），再校验 type / 默认 provider（`validateProviderConfigs`），
 * 返回归一化结果与扁平化的问题文本。避免「概览按派生 id 展示、校验却按原始 config 报 id 缺失」的不一致。
 */
export function checkProviderConfigs(
  rawProviders: ProviderConfig[],
  defaultProviderId: string,
  knownTypes: Iterable<string>,
): { providers: ResolvedProviderConfig[]; issues: string[] } {
  const { providers, issues: idIssues } = normalizeProviderConfigs(rawProviders)
  const issues = idIssues.map((i) => i.message)
  for (const iss of validateProviderConfigs(providers, defaultProviderId, knownTypes)) issues.push(iss.message)
  return { providers, issues }
}

/**
 * apiKey 展示标签（配置概览与 `/model` 列表共用，避免两处口径不一）：
 * - 未配置 → `（未配置）`
 * - 加密态（`enc:v1:`）→ `已加密`（无法回显指纹）
 * - `${ENV}` 引用 → `env(ENV)`（引用名非机密，可直接展示）
 * - 明文：默认脱敏为 `已配置`；`fingerprint` 时附末 4 位（`已配置(…AB12)`），
 *   供「同端点同模型、仅 token 不同」的实例之间互相区分。
 */
export function formatApiKeyTag(
  apiKey: string | undefined,
  opts: { fingerprint?: boolean } = {},
): string {
  const raw = apiKey?.trim()
  if (!raw) return '（未配置）'
  if (raw.startsWith('enc:v1:')) return '已加密'
  if (/^\$\{.*\}$/.test(raw)) return `env(${raw.slice(2, -1)})`
  if (!opts.fingerprint) return '已配置'
  return raw.length > 4 ? `已配置(…${raw.slice(-4)})` : '已配置'
}

/**
 * 找出「type + baseUrl + model 完全相同」的实例组——即**同配置不同 token**（或多端点同模型）的场景。
 *
 * 为什么要单独识别：这类实例的内容差异只在 apiKey 上，而 `/model ?` 列表里 type/baseUrl/model 全同、
 * 人眼无法区分；它们又只能靠 `normalizeProviderConfigs` 派生出的 `-2`/`-3` id 区分，而派生 id 与
 * **数组顺序绑定**（调整顺序后同名 id 会指向另一个 token），因此值得显式提示用户手写 id。
 *
 * `distinctKeys` = 组内不同 apiKey 的个数：1 表示完全重复（多余项，建议删除），>1 即同配置不同 token。
 * 纯函数，便于单测。
 */
export function findTokenOnlyDuplicates(providers: ResolvedProviderConfig[]): Array<{
  key: string
  members: ResolvedProviderConfig[]
  distinctKeys: number
}> {
  const groups = new Map<string, ResolvedProviderConfig[]>()
  for (const p of providers) {
    const key = `${p.type}|${p.baseUrl ?? ''}|${p.model ?? ''}`
    const list = groups.get(key)
    if (list) list.push(p)
    else groups.set(key, [p])
  }
  const out: Array<{ key: string; members: ResolvedProviderConfig[]; distinctKeys: number }> = []
  for (const [key, members] of groups) {
    if (members.length < 2) continue
    const distinctKeys = new Set(members.map((m) => m.apiKey ?? '')).size
    out.push({ key, members, distinctKeys })
  }
  return out
}

// ------------------------------------------------------------------------
// 2.4 compression 配置校验（未知键 / 非法取值）
// ------------------------------------------------------------------------

/**
 * 内核 `defaultConfig` 的合并尾部是 `{...base, ...overrides, 子树:{...}}` ⇒ **未知键被静默丢弃**；
 * 而 `tokenCalibration` 走的是 `=== 'chars4' ? 旧口径 : 自动`，拼错会**静默降级到默认值 auto**
 * （概览还照常显示"自动（CJK 感知）"，全无症状）。
 *
 * 后者的实际代价不是"少一行提示"而是**实验结论反向**：想用 `chars4` 做 A-B 对照组却写成
 * `'chars/4'`，两组都跑 auto ⇒ 实测差 ≈ 0 ⇒ 得出"两个口径没差"，而真相是差约 4 倍。
 *
 * 下列白名单刻意写成 `Record<keyof X, true>` 而不是 `string[]`：内核字段新增 / 改名时**编译期即报错**，
 * 白名单不会静默过期 —— 这是本函数能长期有效的唯一保证。
 */
const KERNEL_CONFIG_KEYS: Record<keyof import('acp-kernel').Config, true> = {
  tiers: true,
  nudge: true,
  promotionThreshold: true,
  truncate: true,
  compress: true,
  protectedTools: true,
  isToolProtected: true,
  preserveRecentMessages: true,
  preserveRecentTokens: true,
  modelContextLimit: true,
  absorb: true,
  messageFilters: true,
}
const KERNEL_TIER_KEYS: Record<keyof import('acp-kernel').TierConfig, true> = {
  enabled: true,
  tier2Trigger: true,
  tier3Trigger: true,
}
const KERNEL_NUDGE_KEYS: Record<keyof import('acp-kernel').NudgeConfig, true> = {
  maxContextLimitPct: true,
  minContextLimitPct: true,
  frequency: true,
  iterationThreshold: true,
  force: true,
  growthRatio: true,
  growthFloor: true,
  growthCap: true,
  minGrowthFloor: true,
  minGrowthRatio: true,
  emergencyThresholdPct: true,
  tier2GrowthMultiplier: true,
  minPressureBenefitTokens: true,
}
const KERNEL_COMPRESS_KEYS: Record<keyof import('acp-kernel').CompressValidationConfig, true> = {
  minCompressRange: true,
  maxSummaryLength: true,
  minSummaryLength: true,
}
const KERNEL_TRUNCATE_KEYS: Record<keyof import('acp-kernel').TruncateConfig, true> = { threshold: true }
const KERNEL_ABSORB_KEYS: Record<keyof import('acp-kernel').AbsorbConfig, true> = {
  enabled: true,
  toolName: true,
  minToolTokens: true,
  contextThresholdPct: true,
  excludeTools: true,
}
const PROMPT_KEYS: Record<keyof import('acp-kernel').Prompts, true> = {
  compressPhilosophy: true,
  howToCompressRules: true,
  tier2DistillRules: true,
  tier3CondenseRules: true,
}
/** compression 顶层合法键（与 HarnessConfig.compression 一一对应） */
const COMPRESSION_KEYS: Record<keyof NonNullable<HarnessConfig['compression']>, true> = {
  enabled: true,
  autoTune: true,
  tokenCalibration: true,
  modelContextLimit: true,
  prompts: true,
  systemPrompt: true,
  preserveRecentMessages: true,
  preserveRecentTokens: true,
  promotionThreshold: true,
  tiers: true,
  nudge: true,
  config: true,
  telemetry: true,
}
const COMPRESSION_TIER_KEYS: Record<keyof NonNullable<HarnessConfig['compression']>['tiers'], true> = {
  tier2Trigger: true,
  tier3Trigger: true,
}
const COMPRESSION_NUDGE_KEYS: Record<keyof NonNullable<HarnessConfig['compression']>['nudge'], true> = {
  maxContextLimitPct: true,
  minContextLimitPct: true,
  emergencyThresholdPct: true,
}
const COMPRESSION_TELEMETRY_KEYS: Record<keyof NonNullable<HarnessConfig['compression']>['telemetry'], true> = {
  enabled: true,
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 收集 `obj` 里不属于 `allowed` 的键，返回 `[问题路径]`（空值/非对象视为无问题） */
function collectUnknown(obj: unknown, allowed: Iterable<string>, path: string): string[] {
  if (!isPlainObject(obj)) return []
  const ok = new Set(allowed)
  return Object.keys(obj)
    .filter((k) => !ok.has(k))
    .map((k) => `${path}.${k}`)
}

/**
 * 校验 `config.json → compression`：未知键 + `tokenCalibration` 非法取值。
 *
 * 纯函数（无 IO），便于单测。返回**人类可读**的问题列表（空数组表示无问题）。
 *
 * 形参刻意标为 `unknown` 而不是 `HarnessConfig['compression']`：本函数存在的理由就是
 * "config.json 由 `JSON.parse` 得来、形状完全不受编译期保护"。若标成结构化类型，反而会让
 * 调用方误以为形状已被类型系统保证（TS 也**不会**拦住运行时的多余键，只拦字面量）。
 *
 * 检查深度只到"内核真正消费的那一层"：比 `config.nudge.xxx` 更深的键不报 ——
 * 内核读的就是 `tiers` / `nudge` / `compress` / `truncate` / `absorb` 这几个子树本身，
 * 越级的字段既不会被读取也没有默认值可言。
 */
export function checkCompressionConfig(c: unknown): string[] {
  if (!isPlainObject(c)) return []
  const out: string[] = []
  const push = (paths: string[], tail: string): void => {
    for (const p of paths) out.push(`compression${p} ${tail}`)
  }

  push(collectUnknown(c, Object.keys(COMPRESSION_KEYS), ''), '未被识别，该配置不会生效')
  if (c.tokenCalibration !== undefined && c.tokenCalibration !== 'auto' && c.tokenCalibration !== 'chars4') {
    out.push(
      `compression.tokenCalibration 取值 ${JSON.stringify(c.tokenCalibration)} 未知（可选：auto / chars4），已按默认 auto 处理`,
    )
  }
  push(collectUnknown(c.tiers, Object.keys(COMPRESSION_TIER_KEYS), '.tiers'), '未被识别，该配置不会生效')
  push(collectUnknown(c.nudge, Object.keys(COMPRESSION_NUDGE_KEYS), '.nudge'), '未被识别，该配置不会生效')
  push(collectUnknown(c.telemetry, Object.keys(COMPRESSION_TELEMETRY_KEYS), '.telemetry'), '未被识别，该配置不会生效')
  push(collectUnknown(c.prompts, Object.keys(PROMPT_KEYS), '.prompts'), '不是 acp-kernel Prompts 的字段，该配置不会生效')

  // config：高级透传，原样喂给内核 defaultConfig 的 overrides ⇒ 按内核 Config 形状校验
  if (isPlainObject(c.config)) {
    push(collectUnknown(c.config, Object.keys(KERNEL_CONFIG_KEYS), '.config'), '内核 Config 无此字段，该配置不会生效')
    push(collectUnknown(c.config.tiers, Object.keys(KERNEL_TIER_KEYS), '.config.tiers'), '内核 TierConfig 无此字段，该配置不会生效')
    push(collectUnknown(c.config.nudge, Object.keys(KERNEL_NUDGE_KEYS), '.config.nudge'), '内核 NudgeConfig 无此字段，该配置不会生效')
    push(collectUnknown(c.config.compress, Object.keys(KERNEL_COMPRESS_KEYS), '.config.compress'), '内核 CompressValidationConfig 无此字段，该配置不会生效')
    push(collectUnknown(c.config.truncate, Object.keys(KERNEL_TRUNCATE_KEYS), '.config.truncate'), '内核 TruncateConfig 无此字段，该配置不会生效')
    push(collectUnknown(c.config.absorb, Object.keys(KERNEL_ABSORB_KEYS), '.config.absorb'), '内核 AbsorbConfig 无此字段，该配置不会生效')
  }
  return out
}

/** compaction 段合法键（与 HarnessConfig.compaction 一一对应） */
const COMPACTION_KEYS: Record<keyof NonNullable<HarnessConfig['compaction']>, true> = {
  strategy: true,
  autoCompactThresholdPct: true,
  reservedTokens: true,
  contextWindowTokens: true,
  keepRecentMessages: true,
  summaryMaxChars: true,
  tokenCalibration: true,
}
const COMPACTION_STRATEGIES: ReadonlySet<string> = new Set(['prune', 'summary', 'agent'])

/**
 * 上下文窗口推导（ACP 默认 Provider 口径）：
 * `compression.modelContextLimit → 默认 Provider 的 contextWindowTokens → 200000`。
 *
 * 抽成函数是因为**三处**都要它：boot 装配 ACP、配置概览、会话压缩选项。此前概览与 boot
 * 各写一份、会话压缩干脆硬编码 200000，于是同一份 config 能同时得出 200000 和 102400
 * 两个窗口 —— 按概览做的判断全部落空，会话压缩则因阈值 136000 > 真实窗口而从不触发。
 * 默认 provider 的 id 可能省略（由 model 派生），故同样走 normalizeProviderConfigs。
 */
export function resolveContextWindowTokens(cfg: HarnessConfig, defaultProviderId: string): number {
  const { providers } = normalizeProviderConfigs(cfg.providers ?? [])
  const defaultPc = providers.find((p) => p.id === defaultProviderId)
  return cfg.compression?.modelContextLimit ?? defaultPc?.contextWindowTokens ?? 200_000
}

/** 校验 `config.json → compaction`：未知键 + `strategy` / `tokenCalibration` 非法取值 */
export function checkCompactionConfig(c: unknown): string[] {
  if (!isPlainObject(c)) return []
  const out: string[] = []
  for (const k of collectUnknown(c, Object.keys(COMPACTION_KEYS), 'compaction')) {
    out.push(`${k} 未被识别，该配置不会生效`)
  }
  if (c.strategy !== undefined && !COMPACTION_STRATEGIES.has(c.strategy as string)) {
    out.push(
      `compaction.strategy 取值 ${JSON.stringify(c.strategy)} 未知（可选：prune / summary / agent），已按默认 summary 处理`,
    )
  }
  if (c.tokenCalibration !== undefined && c.tokenCalibration !== 'auto' && c.tokenCalibration !== 'chars4') {
    out.push(
      `compaction.tokenCalibration 取值 ${JSON.stringify(c.tokenCalibration)} 未知（可选：auto / chars4），已按默认 auto 处理`,
    )
  }
  return out
}

/** 会话压缩的 `CompactOptions`：配置 → core 的入参。**窗口按统一优先级推导**（见 resolveContextWindowTokens） */
export function buildCompactionOptions(cfg: HarnessConfig, defaultProviderId: string): CompactOptions {
  const k = cfg.compaction
  return {
    contextWindowTokens: k?.contextWindowTokens ?? resolveContextWindowTokens(cfg, defaultProviderId),
    ...(k?.strategy != null ? { strategy: k.strategy } : {}),
    ...(k?.keepRecentMessages != null ? { keepRecentMessages: k.keepRecentMessages } : {}),
    ...(k?.summaryMaxChars != null ? { summaryMaxChars: k.summaryMaxChars } : {}),
    ...(k?.autoCompactThresholdPct != null ? { autoCompactThresholdPct: k.autoCompactThresholdPct } : {}),
    ...(k?.reservedTokens != null ? { reservedTokens: k.reservedTokens } : {}),
    ...(k?.tokenCalibration != null ? { tokenCalibration: k.tokenCalibration } : {}),
  }
}

/**
 * 会话压缩的**阈值可达性**提醒：阈值 = (窗口 − reservedTokens) × pct%，
 * 若阈值 ≥ 窗口，则无论会话多长都不可能自动触发 —— 配置写了一堆却零效果，且全程静默。
 *
 * 这条必须由配置算出而不是靠人记住：窗口来自 Provider，阈值来自本段配置，两边任一改动
 * 都可能悄悄越过这条线。返回 undefined 表示可达。
 */
export function checkCompactionReachability(cfg: HarnessConfig, defaultProviderId: string): string | undefined {
  const opt = buildCompactionOptions(cfg, defaultProviderId)
  const window = opt.contextWindowTokens ?? 200_000
  const reserved = opt.reservedTokens ?? 30_000
  const pct = opt.autoCompactThresholdPct ?? 80
  const threshold = Math.floor((window - reserved) * (pct / 100))
  if (threshold < window) return undefined
  return (
    `会话压缩阈值（${threshold} tokens）≥ 上下文窗口（${window}），自动压缩永远不会触发。` +
    `请降低 compaction.autoCompactThresholdPct 或 reservedTokens，或确认 providers[].contextWindowTokens 填写正确`
  )
}

/** memory 段合法键（与 HarnessConfig.memory 一一对应） */
const MEMORY_KEYS: Record<keyof NonNullable<HarnessConfig['memory']>, true> = {
  flushAfterTurns: true,
  maxLines: true,
  maxBytes: true,
  disableInjection: true,
}

/**
 * 概览里显示的默认上限。刻意抄一份常量而不是静态 import `@harness/memory`：
 * CLI 对插件一律懒加载（`lazyImport`），为两个数字在启动路径上加载整个插件模块不划算。
 * 改动时需与 memory 包的 `MEMORY_INDEX_MAX_LINES` / `MEMORY_INDEX_MAX_BYTES` 保持一致。
 */
const MEMORY_INDEX_LINES_HINT = 200
const MEMORY_INDEX_BYTES_HINT = 25 * 1024

/**
 * 校验 `config.json → memory`：未知键 + 类型/取值。纯函数（无 IO），便于单测。
 *
 * 为什么必须校验：这段配置**没有任何一处会主动报错** —— 键拼错会被静默忽略（记忆照旧工作、
 * 看起来一切正常），而 `flushAfterTurns` 若写成字符串（JSON 没有类型保护），
 * `dirtyTurns >= flushAfter` 恒为 false ⇒ 兜底永不触发，表现是"改了记忆好几轮都不生效"。
 * 偏偏记忆是「开了就不再盯着」的能力，只能靠这里的白名单比对暴露出来。
 */
export function checkMemoryConfig(c: unknown): string[] {
  if (!isPlainObject(c)) return []
  const out: string[] = []
  for (const k of collectUnknown(c, Object.keys(MEMORY_KEYS), 'memory')) {
    out.push(`${k} 未被识别，该配置不会生效`)
  }
  const numeric: Array<[string, unknown]> = [
    ['memory.flushAfterTurns', c.flushAfterTurns],
    ['memory.maxLines', c.maxLines],
    ['memory.maxBytes', c.maxBytes],
  ]
  for (const [path, v] of numeric) {
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      out.push(`${path} 应为非负整数，收到 ${JSON.stringify(v)} ⇒ 已忽略该项`)
    }
  }
  if (typeof c.disableInjection === 'boolean' || c.disableInjection === undefined) {
    // ok
  } else {
    out.push(`memory.disableInjection 应为布尔值，收到 ${JSON.stringify(c.disableInjection)} ⇒ 已忽略该项`)
  }
  if (c.maxLines === 0 || c.maxBytes === 0) {
    out.push('memory.maxLines / maxBytes 为 0 会让索引完全不注入（等于只留 /memory 命令），请确认是否有意如此')
  }
  return out
}

/**
 * `config.json → memory` → memory 插件的构造参数。
 *
 * **逐项显式映射**（而不是整段 spread）：JSON 里的值不受类型系统保护，非法值若直接透传，
 * 插件侧只会"按默认以外的怪值工作"（如 `flushAfterTurns: "15"` ⇒ 兜底永不触发）。
 * 这里只放行校验过的值，非法项一律丢弃（并在 checkMemoryConfig 里给出提示）。
 */
export function memoryPluginOptions(c: HarnessConfig['memory']): Record<string, unknown> {
  if (!c) return {}
  const out: Record<string, unknown> = {}
  const int = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
  const flush = int(c.flushAfterTurns)
  if (flush !== undefined) out.flushAfterTurns = flush
  const lines = int(c.maxLines)
  if (lines !== undefined) out.maxLines = lines
  const bytes = int(c.maxBytes)
  if (bytes !== undefined) out.maxBytes = bytes
  if (typeof c.disableInjection === 'boolean') out.disableInjection = c.disableInjection
  return out
}

/**
 * `config.json → telemetry` → telemetry 插件的构造参数（含秘设备注入前的显式映射）。
 *
 * 与 memory 同模式：逐项显式映射，非法值丢弃并在 checkTelemetryConfig 里提示。
 * 返回 `null` 表示「未装配」（config 没写 telemetry 段）——保持默认零影响。
 */
export function telemetryPluginOptions(c: HarnessConfig['telemetry']): Record<string, unknown> | null {
  if (!c) return null
  const out: Record<string, unknown> = {}
  if (typeof c.enabled === 'boolean') out.enabled = c.enabled
  if (typeof c.path === 'string' && c.path.length > 0) out.pathBuilder = (_sid?: string) => c.path as string
  if (typeof c.debounceMs === 'number' && Number.isInteger(c.debounceMs) && c.debounceMs >= 0) out.debounceMs = c.debounceMs
  if (typeof c.crash === 'boolean') out.crash = c.crash
  if (typeof c.userId === 'string' && c.userId.length > 0) out.userID = c.userId
  if (c.otlp && typeof c.otlp === 'object') {
    const o: Record<string, unknown> = {}
    if (typeof c.otlp.enabled === 'boolean') o.enabled = c.otlp.enabled
    if (typeof c.otlp.endpoint === 'string' && c.otlp.endpoint.length > 0) o.endpoint = c.otlp.endpoint
    if (c.otlp.headers && typeof c.otlp.headers === 'object' && !Array.isArray(c.otlp.headers)) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(c.otlp.headers)) if (typeof v === 'string') headers[k] = v
      if (Object.keys(headers).length) o.headers = headers
    }
    out.otlp = o as import('@harness/telemetry').OtlpOptions
  }
  return out
}

const TELEMETRY_OTLP_KEYS: Record<string, true> = { enabled: true, endpoint: true, headers: true }

const TELEMETRY_KEYS: Record<keyof NonNullable<HarnessConfig['telemetry']>, true> = {
  enabled: true,
  path: true,
  debounceMs: true,
  crash: true,
  userId: true,
  otlp: true,
}

/**
 * 校验 `config.json → telemetry`：未知键。纯函数（无 IO），便于单测。
 */
export function checkTelemetryConfig(c: unknown): string[] {
  if (!isPlainObject(c)) return []
  const out: string[] = []
  for (const k of collectUnknown(c, Object.keys(TELEMETRY_KEYS), 'telemetry')) {
    out.push(`${k} 未被识别，该配置不会生效`)
  }
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') {
    out.push(`telemetry.enabled 应为布尔值，收到 ${JSON.stringify(c.enabled)} ⇒ 已忽略该项`)
  }
  if (c.path !== undefined && (typeof c.path !== 'string' || c.path.length === 0)) {
    out.push(`telemetry.path 应为非空字符串，已忽略该项`)
  }
  if (c.debounceMs !== undefined && (typeof c.debounceMs !== 'number' || !Number.isInteger(c.debounceMs) || c.debounceMs < 0)) {
    out.push(`telemetry.debounceMs 应为非负整数，收到 ${JSON.stringify(c.debounceMs)} ⇒ 已忽略该项`)
  }
  if (c.crash !== undefined && typeof c.crash !== 'boolean') {
    out.push(`telemetry.crash 应为布尔值，已忽略该项`)
  }
  // otlp 子段（白名单里的 otlp 是被 type 保护的；这里只查子键）
  if (isPlainObject(c.otlp)) {
    for (const k of collectUnknown(c.otlp, Object.keys(TELEMETRY_OTLP_KEYS), 'telemetry.otlp')) {
      out.push(`${k} 未被识别，该配置不会生效`)
    }
    if (c.otlp.enabled !== undefined && typeof c.otlp.enabled !== 'boolean') {
      out.push(`telemetry.otlp.enabled 应为布尔值，已忽略该项`)
    }
    if (c.otlp.endpoint !== undefined && (typeof c.otlp.endpoint !== 'string' || c.otlp.endpoint.length === 0)) {
      out.push(`telemetry.otlp.endpoint 应为非空字符串，已忽略该项`)
    }
    if (c.otlp.headers !== undefined && !isPlainObject(c.otlp.headers)) {
      out.push(`telemetry.otlp.headers 应为对象，已忽略该项`)
    }
  }
  return out
}

/** 配置概览（--check-config / /config 共用），apiKey 默认脱敏展示 */
export function buildConfigOverview(cfg: HarnessConfig, defaultProviderId: string): string {
  const lines: string[] = []
  lines.push(`默认 provider：${cfg.provider ?? defaultProviderId}`)
  if (cfg.model) lines.push(`默认 model：${cfg.model}`)
  const c = cfg.compression
  // 窗口必须与 boot 装配处、会话压缩处同一套推导：compression.modelContextLimit →
  // 默认 provider 的 contextWindowTokens → 兜底 200_000。此前概览直接兜底 200000、会话压缩
  // 在 core 内另摊一个硬编码 200000，于是同一份 config 能同时得出 200000 和 102400 两个窗口
  // ——按概览做的判断全部落空，会话压缩则因阈值 136000 > 真实窗口而从不触发。
  const acpWindow = resolveContextWindowTokens(cfg, defaultProviderId)
  const acpMode = c?.autoTune
    ? `按窗口自动适配参数（autoTune，窗口 ${acpWindow}）`
    : `原始压缩参数控制（autoTune 关闭）`
  const acpCaliber = c?.tokenCalibration === 'chars4' ? 'token 口径 chars/4（旧）' : 'token 口径 自动（CJK 感知）'
  lines.push(
    c?.enabled
      ? `上下文压缩（ACP）：启用 fitWindow=${acpWindow} · ${acpMode} · ${acpCaliber}${c.prompts ? ' · 自定义提示词' : ''}`
      : '上下文压缩（ACP）：未启用（config.json → compression.enabled: true 开启）'
  )
  // compression 的未生效项：未知键被内核静默丢弃、tokenCalibration 拼错会静默降级到 auto，
  // 两者都「看起来完全正常」，只能在概览/check 时显式比对白名单才发现（详见 checkCompressionConfig 注释）。
  const compressionIssues = checkCompressionConfig(c)
  if (compressionIssues.length) {
    lines.push('上下文压缩（ACP）配置告警（下列项不会被应用）：')
    for (const m of compressionIssues) lines.push(`  - ${m}`)
  }
  // 会话压缩（/compact 与启动自动判定）：与 ACP 是两套机制，单独展示窗口与阈值，
  // 因为"阈值 ≥ 窗口 ⇒ 永远不触发"这类问题只能在这儿看出来。
  {
    const k = cfg.compaction
    const opt = buildCompactionOptions(cfg, defaultProviderId)
    const window = opt.contextWindowTokens ?? 200_000
    const reserved = opt.reservedTokens ?? 30_000
    const pct = opt.autoCompactThresholdPct ?? 80
    const threshold = Math.floor((window - reserved) * (pct / 100))
    lines.push(
      `会话压缩（/compact）：窗口 ${window} · 阈值 ${threshold} tokens（${pct}% ×（窗口−${reserved}））· ` +
        `策略 ${opt.strategy ?? 'summary'} · 保留最近 ${opt.keepRecentMessages ?? 10} 条 · ` +
        `token 口径 ${opt.tokenCalibration === 'chars4' ? 'chars/4（旧）' : '自动（CJK 感知）'}` +
        (k ? '' : '（全部默认值，config.json → compaction 可配）'),
    )
    const compactionIssues = checkCompactionConfig(k)
    for (const m of compactionIssues) lines.push(`  - ${m}`)
    const unreachable = checkCompactionReachability(cfg, defaultProviderId)
    if (unreachable) lines.push(`  - ${unreachable}`)
  }
  {
    // 长期记忆：既报「有没有开」，也报「参数最终会怎么用」—— 攒批轮数这类值一旦写错
    // （拼错键名 / 传成字符串）全都不会报错、只是行为不同，只能在概览里对照。
    const m = cfg.memory
    const declared = (cfg.plugins ?? []).some((id) => String(id).trim() === 'memory')
    const opt = memoryPluginOptions(m)
    lines.push(
      declared
        ? `长期记忆（memory）：已启用 · 索引上限 ${opt.maxLines ?? MEMORY_INDEX_LINES_HINT} 行 / ` +
            `${opt.maxBytes ?? MEMORY_INDEX_BYTES_HINT} 字节 · 文件变更攒批 ${
              opt.flushAfterTurns === undefined ? '15（默认）' : `${opt.flushAfterTurns} 轮`
            }` +
            (opt.disableInjection ? ' · 已关闭注入（只留 /memory 命令）' : '')
        : '长期记忆（memory）：未启用（config.json → plugins 加 "memory" 开启；可选 memory 段调参）',
    )
    for (const issue of checkMemoryConfig(m)) lines.push(`  - ${issue}`)
    if (m && !declared) lines.push('  - memory 段已写但未启用 ⇒ 该段不会生效（需 plugins 里加 "memory"）')
  }
  // 通用遥测：报「装没装」「开没开」「崩溃兜底挂没挂」「OTLP 上不上报」。
  {
    const t = cfg.telemetry
    const opt = telemetryPluginOptions(t)
    const on = opt && opt.enabled !== false
    lines.push(
      t
        ? `遥测（telemetry）：${on ? '已启用 · ' + (opt?.pathBuilder ? '自定义路径' : '会话级 dataDir/sessions/*.telemetry.jsonl') : '已装配但关闭（telemetry.enabled: false）'}${opt?.crash === false ? ' · 崩溃兜底已关' : ' · 崩溃兜底开启'}${opt?.otlp ? ' · OTLP 上报开启（' + String((opt.otlp as { endpoint?: string })?.endpoint ?? '?') + '）' : ''}`
        : '遥测（telemetry）：未启用（config.json 写 telemetry 段开启；默认不生成遥测文件）',
    )
    for (const issue of checkTelemetryConfig(t)) lines.push(`  - ${issue}`)
  }
  const rawProviders = cfg.providers ?? []
  if (!rawProviders.length) {
    lines.push('providers：（未配置，使用内置 mock / anthropic）')
    return lines.join('\n')
  }
  // 展示归一化后的实例 id（省略 id 的项按 model 派生），与实际装配结果一致
  const providers = normalizeProviderConfigs(rawProviders).providers
  lines.push('providers：')
  for (const pc of providers) {
    const api = formatApiKeyTag(pc.apiKey)
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

  /**
   * boot() 的会话决策结果（explicit / auto / new），供 REPL、TUI 提示用。
   * 每次 boot 覆盖。
   */
  sessionRestore: SessionRestoreInfo = { source: 'new', sessionId: '' }

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
   */
  listConfiguredProviders(): Array<{
    index: number
    id: string
    model?: string
    baseUrl?: string
    apiPath?: string
    type?: string
    keyTag?: string
  }> {
    const dupIds = new Set(findTokenOnlyDuplicates(this.loadedProviders).flatMap((g) => g.members.map((m) => m.id)))
    return this.loadedProviders.map((p, i) => ({
      index: i + 1,
      id: p.id,
      model: p.model,
      baseUrl: p.baseUrl,
      apiPath: p.apiPath,
      type: p.type,
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
    // 2) 默认 Provider 最后注册 —— 作为无 provider 前缀模型的兜底（也是运行时 /model 落盘的默认 provider）
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
      const acpConfig: Record<string, unknown> = {
        ...(compression.config ?? {}),
        ...(compression.preserveRecentMessages != null ? { preserveRecentMessages: compression.preserveRecentMessages } : {}),
        ...(compression.preserveRecentTokens != null ? { preserveRecentTokens: compression.preserveRecentTokens } : {}),
        ...(compression.promotionThreshold != null ? { promotionThreshold: compression.promotionThreshold } : {}),
      }
      if (compression.tiers) {
        acpConfig.tiers = {
          ...(compression.tiers.tier2Trigger != null ? { tier2Trigger: compression.tiers.tier2Trigger } : {}),
          ...(compression.tiers.tier3Trigger != null ? { tier3Trigger: compression.tiers.tier3Trigger } : {}),
        }
      }
      if (compression.nudge) {
        acpConfig.nudge = {
          ...(compression.nudge.maxContextLimitPct != null ? { maxContextLimitPct: compression.nudge.maxContextLimitPct } : {}),
          ...(compression.nudge.minContextLimitPct != null ? { minContextLimitPct: compression.nudge.minContextLimitPct } : {}),
          ...(compression.nudge.emergencyThresholdPct != null ? { emergencyThresholdPct: compression.nudge.emergencyThresholdPct } : {}),
        }
      }
      // 遥测默认开启：每轮 preModel 追加 dataDir/sessions/{sessionId}.telemetry.jsonl
      const telemetryEnabled = compression.telemetry?.enabled !== false
      const sessionsDir = join(this.workspace.dataDir, 'sessions')
      providerPlugins.push(acp.createAcpContextPlugin({
        // 与配置概览、会话压缩共用同一套窗口推导（此前三处各算一次，同份 config 能出两个值）
        modelContextLimit: resolveContextWindowTokens(cfg, defaultProviderId),
        systemPrompt: compression.systemPrompt,
        prompts: compression.prompts as any,
        config: acpConfig as any,
        // autoTune：按窗口推导 compression/nudge 参数（显式字段仍优先，见 compression.autoTune 注释）
        autoTune: compression.autoTune === true,
        // token 折算口径：缺省 auto（CJK 感知），与内核内部计数共用同一函数
        tokenCalibration: compression.tokenCalibration,
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
      snapshot: this.snapshotService ? () => this.snapshotService! : undefined,
      // 上下文压缩·阶段二（Route B）：宿主注入原文档案存储器，compact 裁剪前把被压缩窗口原文落盘到
      // sessions/{id}.cmp.orig/，供惰性 loader 按块还原全文（内存瘦身 + 全文可回溯）。
      originalStore: createWorkspaceOriginalStore(this.workspace),
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
          // 会话压缩参数统一取自 config.json → compaction（窗口按 Provider 推导）。
          // 此前 core 内硬编码 200000，小窗口模型（如 102400）的阈值算成 136000 > 窗口本身，
          // 于是「配了却在正常会话下永远不触发」，且跳过的提示里也没有任何线索。
          const cfg = await app.configStore.load()
          const compactOpts = buildCompactionOptions(cfg, cfg.provider ?? 'anthropic')
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
      // ⚠️ 必须先让出一个宏任务再 peek：subagent 里 `bus.publish(completed)` 排在
      // `enqueueNotification()` **之前**，而 publish 会同步驱动 coordinator 的 barrier →
      // 本函数。若在此同步读取，会在通知入队之前看到空队列而误判空转。
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (harness.session.peekNotifications(current.id).length === 0) {
        out('ℹ️  无待处理的后台任务结果，跳过本次自动续轮\n')
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
    try {
      const curSessionId = current.id
      const gen = app.sendStream(curSessionId, line, ctl.signal)
      let inReasoning = false
      let inText = false
      let inToolOutput = false
      // 引擎自主多步（agentic loop）：A 方案下**每步**都发一次 done，故 done ≠ 整轮结束。
      // 这里把 done 当作「这一步的收尾渲染」；若之后还有事件到来，说明引擎在自主续轮，
      // 打一行分隔让人看得出它自己在往下走，而不是长时间无反馈。
      let lastDoneStep: number | null = null
      for await (const ev of gen) {
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
        // turn_end 是「整轮结束」标记，不是「下一步开始了」⇒ 不能触发续轮分隔
        if (ev.type !== 'done' && ev.type !== 'turn_end' && lastDoneStep != null) {
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
      // 一次性执行也要上报状态（在 Herdr 里跑 `harness run` 同样需要侧栏反馈）
      let runStatus = initialAgentStatus({ agentId: session.agentId ?? 'default' })
      for await (const ev of gen) {
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
      return 0
    }

    // repl / resume / start → REPL（--tui 时进入 alt-screen 全屏 TUI）
    {
      // 窗口按统一优先级推导后显式传入（此前走 core 内的硬编码 200000，
      // providers 写 102400 时阈值 136000 > 窗口 ⇒ 这次判定恒为 false）
      const did = await harness.session.compactIfNeeded(session.id, buildCompactionOptions(cfg, provider))
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
