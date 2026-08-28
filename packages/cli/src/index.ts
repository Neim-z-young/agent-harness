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
 *   --permission <mode>       allow-all / ask（默认 ask）
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
import type { AgentPlugin, PluginContext } from '@harness/plugin'
import {
  createProviderMockPlugin,
  providerMockPlugin,
  MockChatProvider,
} from '@harness/provider-mock'
import { createProviderAnthropicPlugin, providerAnthropicPlugin, AnthropicChatProvider } from '@harness/provider-anthropic'
import { createProviderOpenAIPlugin, OpenAIProviderConfig } from '@harness/provider-openai'
import { createProviderGeminiPlugin, GeminiProviderConfig } from '@harness/provider-gemini'
import { createProviderGlmPlugin, GlmProviderConfig } from '@harness/provider-glm'
import { createProviderQwenPlugin, QwenProviderConfig } from '@harness/provider-qwen'
import { toolsBuiltinPlugin, createToolsBuiltinPlugin } from '@harness/tools-builtin'
import { BackgroundTaskMonitor, type BackgroundTaskView } from '@harness/subagent'
import { CoordinatorEvents } from '@harness/coordinator'
import {
  createSwarmManagers,
  formatAgentId,
  sanitizeName,
  startTeammateLoop,
  type TeammateTaskState,
  type TeammateTickDeps,
} from '@harness/swarm'
import { createSnapshotService, type SnapshotService } from '@harness/snapshot'
import { createSessionRevert, RevertEvents, type RevertState } from '@harness/revert'
import { startTuiRepl } from './tui'
import type { Message, Session } from '@harness/session'
import { formatSkillSource } from '@harness/skill'
import type { ToolContext, Tool } from '@harness/tool'

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
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
  permissionMode?: 'allow-all' | 'ask'
  verbose?: boolean
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
      case 'permission': out.permissionMode = value === 'allow-all' ? 'allow-all' : 'ask'; break
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

/** 会话存储结构（文件 = sessionId.json） */
export interface SessionFile {
  /** 会话元数据 */
  id: string
  title?: string
  createdAt: number
  updatedAt: number
  agentId?: string
  cwd?: string
  meta?: Record<string, unknown>
  /** 完整消息列表 */
  messages: Message[]
}

export class SessionFileStore {
  constructor(public readonly dataDir: string) {}

  private sessionsDir(): string {
    return join(this.dataDir, 'sessions')
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.sessionsDir(), { recursive: true })
  }

  /** 会话文件路径 */
  pathFor(sessionId: string): string {
    return join(this.sessionsDir(), `${sessionId}.json`)
  }

  /** 从 Session → 文件对象 */
  toFile(s: Session): SessionFile {
    return {
      id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
      agentId: s.agentId, cwd: s.cwd, meta: s.meta, messages: s.messages,
    }
  }

  /** 持久化一个 Session */
  async save(session: Session): Promise<void> {
    await this.ensureDir()
    await writeFile(this.pathFor(session.id), JSON.stringify(this.toFile(session), null, 2))
  }

  /** 从文件恢复为 Session 对象（未注入 SessionManager） */
  async load(sessionId: string): Promise<SessionFile | undefined> {
    const p = this.pathFor(sessionId)
    if (!existsSync(p)) return undefined
    return JSON.parse(await readFile(p, 'utf-8')) as SessionFile
  }

  /** 列出所有会话（按 updatedAt 倒序） */
  async list(): Promise<Array<{ id: string; title?: string; updatedAt: number; messageCount: number }>> {
    if (!existsSync(this.sessionsDir())) return []
    const files = await readdir(this.sessionsDir())
    const ids = files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    const items: Array<{ id: string; title?: string; updatedAt: number; messageCount: number }> = []
    for (const id of ids) {
      const s = await this.load(id)
      if (s) items.push({ id, title: s.title, updatedAt: s.updatedAt, messageCount: s.messages.length })
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return items
  }
}

// ========================================================================
// 2.1 全局配置（model / agent / provider / apiKey 持久化到 config.json）
// ========================================================================
// 配置来源优先级（从高到低）：CLI 参数 > config.json > 环境变量。
// HarnessApp 只依赖 boot() 时已解析好的 options；config.json 在 main() 里
// 与 CLI 参数合并后传入，保证两者优先级正确。

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
}

/** 单个 Provider 定义（config.json 的 providers 数组元素） */
export interface ProviderConfig {
  /** 唯一 ID：运行时 `provider/model` 前缀据此分发（如 anthropic / openai / deepseek / ollama / glm / qwen） */
  id: string
  /** Provider 类型：内置支持 anthropic / openai / gemini / glm / qwen / mock；可通过 plugins 插件导出 providerTypeFactory 扩展任意自定义 type（插件化） */
  type: string
  /** API 根路径（如 api.openai.com / api.deepseek.com / http://localhost:11434（Ollama）） */
  baseUrl?: string
  /** API Key */
  apiKey?: string
  /** 该 Provider 默认模型（运行时无 `provider/model` 前缀且未绑定到具体模型时使用） */
  model?: string
  /** OpenAI 类型专用：API 路径（默认 /v1/chat/completions；智谱等兼容 API 可改 /chat/completions） */
  apiPath?: string
  /** max_tokens 默认值（默认 Provider 内部值，如 4096） */
  maxTokens?: number
  /** 请求超时（ms，默认 120_000） */
  timeoutMs?: number
}

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

/** dataDir/config.json 读写（保持幂等：文件缺失 / 解析失败均返回空配置） */
export class ConfigStore {
  constructor(public readonly dataDir: string) {}

  private path(): string {
    return join(this.dataDir, 'config.json')
  }

  async load(): Promise<HarnessConfig> {
    const p = this.path()
    if (!existsSync(p)) return {}
    try {
      return JSON.parse(await readFile(p, 'utf-8')) as HarnessConfig
    } catch {
      return {}
    }
  }

  async save(cfg: HarnessConfig): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    await writeFile(this.path(), JSON.stringify(cfg, null, 2))
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

/** Provider 类型工厂：`config.type` → 插件构造。第三方插件可注册任意 type */
export interface ProviderTypeFactory {
  /** 对应 ProviderConfig.type 的值 */
  type: string
  /** 根据 ProviderConfig 构造 Provider 插件（返回 undefined 表示该配置不可用） */
  createPlugin: (config: ProviderConfig) => AgentPlugin | undefined
}

/** Provider 类型注册表：内置类型 + 外部 plugins 插件注册的工厂按 type 动态解析（替代硬编码 switch） */
export class ProviderTypeRegistry {
  private readonly factories = new Map<string, ProviderTypeFactory>()

  register(factory: ProviderTypeFactory): void {
    this.factories.set(factory.type, factory)
  }

  resolve(type: string): ProviderTypeFactory | undefined {
    return this.factories.get(type)
  }

  list(): string[] {
    return [...this.factories.keys()]
  }
}

/** 注册 CLI 内置 Provider 类型工厂（openai / anthropic / gemini / glm / qwen / mock） */
export function registerBuiltinProviderTypes(
  registry: ProviderTypeRegistry,
  options: { anthropicProviderConfig?: any } = {},
): void {
  registry.register({
    type: 'openai',
    createPlugin: (pc) => createProviderOpenAIPlugin({
      baseUrl: pc.baseUrl, apiKey: pc.apiKey, defaultModel: pc.model,
      maxTokens: pc.maxTokens, timeoutMs: pc.timeoutMs, apiPath: pc.apiPath, providerId: pc.id,
    }),
  })
  registry.register({
    type: 'glm',
    createPlugin: (pc) => createProviderGlmPlugin({
      baseUrl: pc.baseUrl, apiKey: pc.apiKey, defaultModel: pc.model,
      maxTokens: pc.maxTokens, timeoutMs: pc.timeoutMs, apiPath: pc.apiPath, providerId: pc.id,
    } as GlmProviderConfig),
  })
  registry.register({
    type: 'qwen',
    createPlugin: (pc) => createProviderQwenPlugin({
      baseUrl: pc.baseUrl, apiKey: pc.apiKey, defaultModel: pc.model,
      maxTokens: pc.maxTokens, timeoutMs: pc.timeoutMs, apiPath: pc.apiPath, providerId: pc.id,
    } as QwenProviderConfig),
  })
  registry.register({
    type: 'gemini',
    createPlugin: (pc) => createProviderGeminiPlugin({
      baseUrl: pc.baseUrl, apiKey: pc.apiKey, defaultModel: pc.model,
      maxTokens: pc.maxTokens, timeoutMs: pc.timeoutMs,
    } as GeminiProviderConfig),
  })
  registry.register({
    type: 'anthropic',
    createPlugin: (pc) => createProviderAnthropicPlugin({
      baseUrl: pc.baseUrl,
      apiKey: pc.apiKey ?? options.anthropicProviderConfig?.apiKey,
      defaultModel: pc.model,
      maxTokens: pc.maxTokens,
      timeoutMs: pc.timeoutMs,
    }) as any,
  })
  registry.register({
    type: 'mock',
    createPlugin: (pc) => createProviderMockPlugin({
      ...pc,
      defaultResponse: pc.model ? undefined : '(Mock Provider) 你好，我是测试助手。',
    }),
  })
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
  // 通用插件按 id 去重：后加载覆盖先加载（project 覆盖 user）
  const byId = new Map<string, AgentPlugin>()
  for (const entry of dirs) {
    const dir = typeof entry === 'string' ? entry : entry.dir
    if (!existsSync(dir)) continue
    let files: string[]
    try { files = await readdir(dir) } catch { continue }
    for (const file of files) {
      if (!/\.(ts|js|mjs)$/.test(file)) continue
      const full = join(dir, file)
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
  }
  return { plugins: [...byId.values()] }
}

// ------------------------------------------------------------------------
// 2.3 密钥加密存储 + 配置校验（多 Provider 健壮性）
// ------------------------------------------------------------------------

/** 配置校验/密钥解析失败（含定位信息），启动时一次性抛出 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

/**
 * API Key 加密（AES-256-GCM）。主密钥来源（优先级从高到低）：
 * 1. HARNESS_CONFIG_KEY 环境变量（sha256 派生 32 字节）
 * 2. <data-dir>/.config-key 文件（首次自动生成 64 位 hex，chmod 600）
 */
export class SecretCipher {
  constructor(public readonly dataDir: string) {}

  private keyFile(): string {
    return join(this.dataDir, '.config-key')
  }

  async masterKey(): Promise<Buffer> {
    const env = typeof process !== 'undefined' ? process.env.HARNESS_CONFIG_KEY : undefined
    if (env && env.length >= 8) return createHash('sha256').update(env).digest()
    const p = this.keyFile()
    if (existsSync(p)) return Buffer.from((await readFile(p, 'utf-8')).trim(), 'hex')
    const key = randomBytes(32).toString('hex')
    await mkdir(this.dataDir, { recursive: true })
    await writeFile(p, key, { mode: 0o600 })
    return Buffer.from(key, 'hex')
  }

  /** 加密为 `enc:v1:<iv>:<tag>:<ct>`（base64） */
  async encrypt(plain: string): Promise<string> {
    const key = await this.masterKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
  }

  /** 解密 enc:v1 值；非 enc: 前缀原样返回 */
  async decrypt(token: string): Promise<string> {
    if (!token.startsWith('enc:v1:')) return token
    const parts = token.split(':')
    const ivB64 = parts[2]
    const tagB64 = parts[3]
    const ctB64 = parts.slice(4).join(':')
    if (!ivB64 || !tagB64 || !ctB64) {
      throw new ConfigValidationError(`无效的加密密钥格式：${token.slice(0, 24)}…`)
    }
    try {
      const key = await this.masterKey()
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf-8')
    } catch (err: any) {
      throw new ConfigValidationError(
        `加密密钥解密失败（HARNESS_CONFIG_KEY / .config-key 与写入时不一致？）：${err?.message ?? String(err)}`,
      )
    }
  }
}

/**
 * apiKey 值解析：
 * - `${ENV_VAR}` → 环境变量（未设置时抛 ConfigValidationError）
 * - `enc:v1:...` → SecretCipher 解密
 * - 其他 → 原样明文返回
 */
export async function resolveSecret(value: string | undefined, cipher: SecretCipher): Promise<string | undefined> {
  if (!value) return undefined
  const trimmed = value.trim()
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed)
  if (m) {
    const v = typeof process !== 'undefined' ? process.env[m[1]] : undefined
    if (v === undefined) {
      throw new ConfigValidationError(`环境变量 ${m[1]} 未设置（apiKey 引用了它）`)
    }
    return v
  }
  if (trimmed.startsWith('enc:v1:')) return cipher.decrypt(trimmed)
  return value
}

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

// ========================================================================
// 3. 权限交互（CLI 提示符：allow / deny / always）
// ========================================================================

/** 规则持久化（dataDir/permissions.json） */
export interface PermissionStoreFile {
  rules: Record<string, unknown> // 对应 PermissionRuleset
}

export class CliPermissionEngine extends DefaultPermissionEngine {
  constructor(
    rules: Record<string, unknown> = { '*': 'ask' },
    private readonly options: {
      store?: PermissionStoreFile & { save?: (r: Record<string, unknown>) => Promise<void> }
      mode?: 'allow-all' | 'ask'
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

  /** CLI 级 ask：默认 mode=allow-all 直接 allow；mode=ask 则 prompt 用户 */
  override async ask(req: any): Promise<PermissionDecision> {
    if (this.options.mode === 'allow-all') return { behavior: 'allow', matchedRule: 'global' }
    const promptFn = this.options.askPrompt ?? defaultCliAsk(this.write)
    const pat = (req.patterns ?? []).slice(0, 3).join(', ') || '(无路径)'
    const q = `\n⚠️  权限请求 [${req.toolKey}] ${pat}\n` +
      `  操作: allow / deny / always(a) / deny-always(d)? [a/d/A/D] `
    const answer = (await promptFn(q)).trim()
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
  permissionMode?: 'allow-all' | 'ask'
  /** 测试注入 */
  mockProviderConfig?: Parameters<typeof createProviderMockPlugin>[0]
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
}

export class HarnessApp {
  public readonly sessionStore: SessionFileStore
  public readonly permissionStorePath: string
  /** 全局配置读写（config.json：model / provider / apiKey 持久化） */
  public readonly configStore: ConfigStore
  /** Provider 类型注册表（内置 + 外部 plugins 插件注册的工厂；config.type 据此动态解析） */
  public readonly providerTypes: ProviderTypeRegistry
  /** 文件快照服务（options.snapshot 开启时创建，供 createHarness 注入与 /revert 命令） */
  public readonly snapshotService: SnapshotService | undefined
  /** 插件管理：boot 时登记的「可管理」插件对象（pluginId → AgentPlugin），供 /plugins enable 重新安装 */
  readonly pluginRegistry = new Map<string, AgentPlugin>()
  private harness!: Harness
  private options: Required<Pick<HarnessAppOptions, 'cwd' | 'dataDir' | 'agentId' | 'provider'>> & HarnessAppOptions

  constructor(options: HarnessAppOptions) {
    const cwd = resolve(options.cwd)
    this.options = { ...options, cwd, dataDir: resolve(options.dataDir), agentId: options.agentId, provider: options.provider }
    this.sessionStore = new SessionFileStore(this.options.dataDir)
    this.permissionStorePath = join(this.options.dataDir, 'permissions.json')
    this.configStore = new ConfigStore(this.options.dataDir)
    // Provider 类型注册表：注册内置类型（openai/anthropic/gemini/glm/qwen/mock），
    // boot() 时再加载外部 plugins 插件注册的自定义 type
    this.providerTypes = new ProviderTypeRegistry()
    registerBuiltinProviderTypes(this.providerTypes, this.options)
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
    await mkdir(this.options.dataDir, { recursive: true })
    await writeFile(this.permissionStorePath, JSON.stringify({ rules }, null, 2))
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
  // 插件管理（/plugins）与技能管理（/skills）
  // ------------------------------------------------------------------

  /** 插件信息（供 /plugins 展示） */
  pluginInfos(): Array<{ id: string; name: string; version: string; source: string; manageable: boolean; enabled: boolean }> {
    if (!this.harness) return []
    return this.harness.plugin.list().map((lp) => ({
      id: lp.plugin.id,
      name: lp.plugin.name,
      version: lp.plugin.version,
      source: lp.source,
      manageable: this.pluginRegistry.has(lp.plugin.id),
      enabled: true,
    }))
  }

  /** 禁用插件（仅可管理插件可禁用；返回错误消息或 undefined 表示成功） */
  async disablePlugin(id: string): Promise<string | undefined> {
    const obj = this.pluginRegistry.get(id)
    if (!obj) return `插件 "${id}" 不受管理（内置/未登记插件不可禁用）。`
    try {
      await this.harness.plugin.unload(id)
    } catch (err: any) {
      return `禁用插件 "${id}" 失败：${err?.message ?? String(err)}`
    }
    return undefined
  }

  /** 启用插件：将登记的原插件对象重新安装进 Harness */
  async enablePlugin(id: string): Promise<string | undefined> {
    const obj = this.pluginRegistry.get(id)
    if (!obj) return `插件 "${id}" 不受管理（内置/未登记插件不可启用）。`
    try {
      // 已启用则幂等成功
      const already = this.harness.plugin.list().find((p) => p.plugin.id === id)
      if (already) return `${id} 已是启用状态。`
      await this.harness.plugin.loadInternal([obj])
    } catch (err: any) {
      return `启用插件 "${id}" 失败：${err?.message ?? String(err)}`
    }
    return undefined
  }

  /** 重载插件 */
  async reloadPlugin(id: string): Promise<string | undefined> {
    if (!this.harness.plugin.list().some((p) => p.plugin.id === id)) return `插件 "${id}" 未加载。`
    try {
      await this.harness.plugin.hotReload(id)
    } catch (err: any) {
      return `重载插件 "${id}" 失败：${err?.message ?? String(err)}`
    }
    return undefined
  }

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
  private buildProviderPlugin(pc: ProviderConfig): AgentPlugin | undefined {
    return this.providerTypes.resolve(pc.type)?.createPlugin(pc)
  }

  /** 列出当前已注册 Provider id（供 /model ? /状态栏） */
  listProviders(): string[] {
    const ids: string[] = []
    // config 里显式定义的 Provider id 优先
    for (const pc of this.options.providers ?? []) if (!ids.includes(pc.id)) ids.push(pc.id)
    // 默认 provider（mock/anthropic 或自定义）放最前
    const def = this.options.provider ?? 'anthropic'
    if (!ids.includes(def)) ids.unshift(def)
    return ids
  }

  /** 装配并启动 Harness，返回已 start 的实例；加载/恢复 session */
  async boot(): Promise<{ harness: Harness; session: Session }> {
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

    // ------------------------------------------------------------------
    // Provider 装配：支持多 Provider 自由切换
    // 1) 优先安装 config.providers 里显式定义的多 Provider（按顺序注册到注册表，供跨 Provider 分发）
    // 2) 默认 Provider 最后注册 —— 作为无 provider 前缀模型的兜底（也是运行时 /model 落盘的默认 provider）
    // ------------------------------------------------------------------
    const cfg = await this.configStore.load()
    const rawProviderConfigs = this.options.providers?.length ? this.options.providers : (cfg.providers ?? [])
    const defaultProviderId = this.options.provider ?? cfg.provider ?? 'anthropic'

    // 加载外部插件（user ~/.harness/plugins → project .harness/plugins，后加载覆盖先加载）：
    // 通用 AgentPlugin 汇总到 externalPlugins 参与 Hooks 生命周期；Provider 类型工厂注册进 providerTypes 供 config.type 动态解析
    const home = typeof process !== 'undefined' ? (process.env.HOME ?? homedir()) : '/tmp'
    const externalPlugins = await loadPluginDirs(this.providerTypes, [
      { dir: join(home, '.harness', 'plugins'), source: 'user' },
      { dir: join(this.options.cwd, '.harness', 'plugins'), source: 'project' },
    ], (s) => this.options.stdout?.write?.(s + '\n'))

    // 显式校验 + 密钥解析（错误一次性汇总，避免静默跳过/误导）
    const cipher = new SecretCipher(this.options.dataDir)
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
      pushBuilt(this.buildProviderPlugin(pc), pc.id)
    }

    // 2) 默认 Provider（最后注册 → 作为无前缀模型的兜底）
    if (defaultPc) {
      // 默认 Provider 的默认模型优先取 --model / config.model 指定的模型（去 provider 前缀）
      const defaultModel = parseModelSpec(this.options.model ?? '').modelId || defaultPc.model
      const plugin = this.buildProviderPlugin({ ...defaultPc, model: defaultModel })
      if (!plugin) {
        this.options.stdout?.write?.(`⚠️  未能构造默认 Provider "${defaultProviderId}"（未知 type）。\n\n`)
        chosenProvider = createProviderMockPlugin({
          defaultResponse: '(Mock Provider) 你好，我是测试助手。',
          ...(this.options.mockProviderConfig ?? {}),
        })
      } else {
        chosenProvider = plugin as any
      }
    } else if (defaultProviderId === 'mock') {
      chosenProvider = createProviderMockPlugin({
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
        chosenProvider = createProviderAnthropicPlugin(mergedAnthropic) as any
      } else if (hasKey && defaultProviderId !== 'anthropic') {
        // 默认 provider 是自定义 id 但未在 providers 中配置 → 提示并 fallback mock
        this.options.stdout?.write?.(
          `ℹ️  未在 config.json → providers 中找到默认 Provider "${defaultProviderId}"，` +
          `自动 fallback 到 Mock Provider。\n` +
          `   可在 <data-dir>/config.json 的 providers 数组中定义它（type=openai/anthropic/gemini）。\n\n`
        )
        chosenProvider = createProviderMockPlugin({
          defaultResponse: '(Mock Provider) 你好，我是测试助手。',
          ...(this.options.mockProviderConfig ?? {}),
        })
      } else {
        this.options.stdout?.write?.(
          'ℹ️  未配置 ANTHROPIC_API_KEY，自动 fallback 到 Mock Provider。\n' +
          '   如要使用真实 Claude，请 export ANTHROPIC_API_KEY=xxx。\n\n'
        )
        chosenProvider = createProviderMockPlugin({
          defaultResponse: '(Mock Provider) 你好，我是测试助手。',
          ...(this.options.mockProviderConfig ?? {}),
        })
      }
    }
    providerPlugins.push(chosenProvider)
    providerPlugins.push(toolsBuiltinPlugin)
    // 其余能力一律通过外部插件目录（~/.harness/plugins、.harness/plugins）可插拔加载，
    // CLI 不做硬编码依赖（避免依赖倒置）：此处 externalPlugins 来自 loadPluginDirs（user → project）。
    if (externalPlugins.plugins.length) providerPlugins.push(...externalPlugins.plugins)
    if (this.options.extraPlugins?.length) providerPlugins.push(...this.options.extraPlugins)

    // 登记「可管理」插件（/plugins enable 需要对象引用重新安装）：
    // 排除 core 内置工具插件（toolsBuiltin）与后续由 core 内部注册的 core.*（skill-injection 等），
    // 仅管理用户装配的 Provider / 插件目录 / extraPlugins。
    this.pluginRegistry.clear()
    for (const p of providerPlugins) {
      if (p.id === toolsBuiltinPlugin.id) continue
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
        { dir: join(home, '.harness', 'agents'), source: 'user' },
        '.harness/agents',
      ],
      // Skill 多级加载：user 全局目录在前，project 项目目录在后（后者覆盖前者）
      skillDirs: [
        { dir: join(home, '.harness', 'skills'), source: 'user' },
        '.harness/skills',
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
    await harness.start()
    this.harness = harness

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
        ;(session as any).id = sid
      } else {
        session = await sm.create({ title: sid, agentId: this.options.agentId, cwd: this.options.cwd })
        ;(session as any).id = sid
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
const REPL_COMMANDS = ['/help', '/exit', '/quit', '/sessions', '/new', '/switch', '/model', '/config', '/save', '/compact', '/plugins', '/skills']

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
 * 挂载后台任务面板（P1-4 前端事件驱动展示）。
 *
 * 订阅 subagent.started / completed / failed Bus 事件，任务状态变化时
 * 增量打印到 stdout（⏳ 开始 / ✅ 完成 / ❌ 失败 + 结果预览），
 * 用户无需执行 /tasks、无需大模型主动查询。
 *
 * UI 无关：本函数只做"事件 → 文本行"的渲染，底层状态由
 * @harness/subagent 的 BackgroundTaskMonitor 维护。
 *
 * @returns 卸载函数（取消订阅 + 释放 monitor）
 */
export function attachBackgroundTaskPanel(options: BackgroundTaskPanelOptions): () => void {
  const { harness } = options
  if (!harness.bus) return () => {}
  const out = (s: string) => (options.stdout ?? process.stdout).write(s)

  const monitor = new BackgroundTaskMonitor({
    bus: harness.bus,
    parentSessionIds: options.parentSessionIds,
  })
  /** taskId → 已打印的状态（增量渲染，同一状态只打印一次） */
  const printed = new Map<string, BackgroundTaskView['status']>()
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
      switch (cmd) {
        case '/help':
          out('命令列表：\n')
          out('  /help              显示帮助\n')
          out('  /exit, /quit       退出 REPL\n')
          out('  /sessions          列出持久化会话\n')
          out('  /new               新建会话（保留当前历史到磁盘）\n')
          out('  /save              手动保存当前会话\n')
          out('  /switch <agentId>  切换默认 Agent（下一条 send 生效）\n')
          out('  /switch ?          列出已注册 Agent\n')
          out('  /model             查看当前模型\n')
          out('  /model <spec>      切换模型：provider/modelId 跨 Provider（如 /model openai/gpt-4o）\n')
          out('  /model ?           列出已注册 Provider\n')
          out('  /config            查看 Provider / 模型配置概览（config.json）\n')
          out('  /compact [mode]    立即压缩会话：mode=prune/summary(默认)/agent\n')
          out('  /compact auto      达到阈值才压缩（默认 80% 可用窗口才触发）\n')
          out('  /search <keyword>  关键词搜索会话（匹配消息文本）\n')
          out('  /export [sessionId]  导出会话为 Markdown（默认当前会话）\n')
          out('  /revert <sub>         文件快照回滚：stage/clear/commit/status/help\n')
          out('  /plugins              列出已加载插件（含来源/是否可管理）\n')
          out('  /plugins <op> <id>    enable|disable|reload 插件（如 /plugins reload my-gw）\n')
          out('  /skills               列出所有技能（含来源标注）\n')
          out('  /skills <op> <id>     enable|disable|reload 技能（如 /skills disable foo）\n')
          // 收集插件注册的命令
          try {
            const cmdInput = { commands: [] as Array<{ command: string; description: string; usage?: string }> }
            await harness.plugin.trigger('cli.commands', cmdInput)
            for (const c of cmdInput.commands) {
              out(`  /${c.command.padEnd(16)}${c.description}\n`)
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
        case '/revert': {
          if (!app.snapshotService) {
            out('快照未启用：构造 HarnessApp 时传 snapshot: true 后可用 /revert。\n')
            return 'continue'
          }
          const revert = createSessionRevert({
            session: harness.session,
            snapshot: app.snapshotService,
            bus: harness.bus,
          })
          const parts = line.split(/\s+/).filter(Boolean)
          const sub = parts[1] ?? 'help'
          const sid = current.id
          try {
            switch (sub) {
              case 'help': {
                out('用法：\n')
                out('  /revert stage <messageID>  回滚该消息之后的文件变更（生成 diff）\n')
                out('  /revert clear              撤销回滚（恢复回滚前状态）\n')
                out('  /revert commit             接受回滚（文件保持回滚后状态）\n')
                out('  /revert status             查看当前回滚状态\n')
                return 'continue'
              }
              case 'status': {
                const state = await revert.getState(sid)
                if (!state) { out('（当前无进行中的回滚）\n'); return 'continue' }
                out(`回滚状态：messageID=${state.messageID}\n`)
                out(`快照：${state.snapshot}\n`)
                const filesText = (state.files ?? []).map((f) => `${f.path} (+${f.additions}/-${f.deletions})`).join(', ')
                out(`变更文件：${filesText || '（无）'}\n`)
                return 'continue'
              }
              case 'clear': {
                await revert.clear(sid)
                out('已撤销回滚，文件恢复回滚前状态。\n')
                return 'continue'
              }
              case 'commit': {
                await revert.commit(sid)
                out('已接受回滚，文件保持回滚后状态。\n')
                return 'continue'
              }
              case 'stage': {
                const messageID = parts[2]
                if (!messageID) { out('用法：/revert stage <messageID>\n'); return 'continue' }
                const state = await revert.stage({ sessionId: sid, messageID })
                out(`已回滚 ${messageID} 之后的文件变更（${state.files?.length ?? 0} 个文件）：\n`)
                for (const f of state.files ?? []) {
                  out(`  ${f.status.padEnd(8)} ${f.path}  +${f.additions}/-${f.deletions}\n`)
                  if (f.patch) out(`${f.patch.slice(0, 400)}${f.patch.length > 400 ? '...' : ''}\n`)
                }
                return 'continue'
              }
              default:
                out(`未知子命令：${sub}，输入 /revert help 查看用法。\n`)
                return 'continue'
            }
          } catch (err: any) {
            out(`回滚失败：${err?.message ?? String(err)}\n`)
            return 'continue'
          }
        }
        case '/plugins': {
          const parts = line.split(/\s+/).map((s) => s.trim()).filter(Boolean)
          const op = parts[1]
          const pid = parts[2]
          if (!op || !pid || !['enable', 'disable', 'reload'].includes(op)) {
            const infos = app.pluginInfos()
            if (infos.length === 0) { out('（未加载任何插件）\n'); return 'continue' }
            for (const p of infos) {
              const manage = p.manageable ? '可管理' : '内置'
              out(`  ${p.id.padEnd(28)}${p.name}  v${p.version}  来源=${p.source}  [${manage}]\n`)
            }
            if (parts.length === 1) { out('\n用法：/plugins <enable|disable|reload> <pluginId>\n'); return 'continue' }
            out('用法：/plugins <enable|disable|reload> <pluginId>\n')
            return 'continue'
          }
          const msg = op === 'disable'
            ? await app.disablePlugin(pid)
            : op === 'enable'
              ? await app.enablePlugin(pid)
              : await app.reloadPlugin(pid)
          out((msg ?? `${op === 'reload' ? '已重载' : `已${op === 'enable' ? '启用' : '禁用'}`}插件 "${pid}"。`) + '\n')
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
          // 尝试交给插件处理
          const cmdInput: { raw: string; command: string; arg: string; out: (s: string) => void; sessionId: string; result?: 'continue' | 'exit' } = {
            raw: line.slice(1),
            command: cmd.slice(1),
            arg: (arg ?? '').trim(),
            out,
            sessionId: current.id,
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
  try {
    return await startReplCore(options)
  } finally {
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
      --permission <mode>  allow-all / ask（默认 ask）
  -v, --verbose            输出调试信息
      --tui                以 TUI（alt-screen 全屏）模式启动 REPL
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
 * 复用 HarnessApp.boot（provider/harness/会话），从团队共享目录读取 mailbox/taskPlane，
 * 启动 startTeammateLoop 持续轮询 mailbox + 认领任务，直到收到 shutdown
 * （approve_shutdown 决策 / 外部 stop）退出。
 */
export async function runTeammateCli(options: {
  args: CliArgs
  cwd: string
  dataDir: string
  provider: string
  agentId: string
  permissionMode: 'allow-all' | 'ask'
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
  const { mailbox, taskPlane } = createSwarmManagers(join(dataDir, 'teams'))

  const memberTeam = sanitizeName(team)
  const memberName = sanitizeName(name)
  const state: TeammateTaskState = {
    agentId: formatAgentId(name, team),
    identity: { team: memberTeam, name: memberName, agentId },
    sessionId: session.id,
    status: 'running',
    prompt: '',
    abortController: new AbortController(),
    createdAt: Date.now(),
  }
  const deps: TeammateTickDeps = { harness, mailbox, taskPlane, team: memberTeam, name: memberName }
  write(`[teammate] ${memberName}@${memberTeam} 已上线（session=${session.id}），开始轮询 mailbox...\n`)

  const loop = startTeammateLoop(state, deps, { intervalMs: 1000 })
  // 挂起直到 shutdown（approve_shutdown / stop 将状态置 shutdown）
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (state.status === 'shutdown') { clearInterval(poll); resolve() }
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
  registerBuiltinProviderTypes(registry, {})
  const home = typeof process !== 'undefined' ? (process.env.HOME ?? homedir()) : '/tmp'
  await loadPluginDirs(registry, [
    { dir: join(home, '.harness', 'plugins'), source: 'user' },
    { dir: join(cwd, '.harness', 'plugins'), source: 'project' },
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
  dataDir: string
  cwd: string
  write: (s: string) => void
}): Promise<number> {
  const { args, dataDir, cwd, write } = options
  const sub = args.arg
  const store = new ConfigStore(dataDir)
  const cfg = await store.load()
  const cipher = new SecretCipher(dataDir)
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
    const registry = await buildCheckRegistry(cwd, write)
    const defaultProviderId = cfg.provider ?? 'anthropic'
    const issues = validateProviderConfigs(providers, defaultProviderId, registry.list())
    write(buildConfigOverview(cfg, defaultProviderId) + '\n')
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

  if (args.command === 'help' || args.showHelp) { write(HELP_TEXT); return 0 }

  const cwd = args.cwd ?? process.cwd()
  const home = typeof process !== 'undefined' ? (process.env.HOME ?? homedir()) : '/tmp'
  const dataDir = args.dataDir ?? join(home, '.harness')
  const permissionMode = args.permissionMode ?? 'ask'

  // 加载 config.json 并与 CLI 合并：CLI > config
  const cfg = await new ConfigStore(dataDir).load()
  const { agentId, provider, model, anthropicApiKey } = resolveConfig(args, cfg)

  if (args.command === 'list-sessions') {
    const store = new SessionFileStore(dataDir)
    const list = await store.list()
    if (list.length === 0) { write('（无持久化会话）\n'); return 0 }
    for (const s of list) {
      const when = new Date(s.updatedAt).toLocaleString()
      write(`${s.id}\t${s.title ?? ''}\t${s.messageCount} msgs\t${when}\n`)
    }
    return 0
  }

  if (args.command === 'config') {
    return runConfigCommand({ args, dataDir, cwd, write })
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
    permissionMode, verbose: args.verbose,
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
