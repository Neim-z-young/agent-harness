/**
 * @harness/provider-mock - Mock LLM Provider 插件
 *
 * 用于测试和开发的可配置 Mock ChatProvider。
 *
 * 功能：
 * - 可配置默认文本响应 / reasoning / model / tokenUsage
 * - 按用户消息关键词匹配不同响应（含 tool call 模拟）
 * - 记录所有调用历史（calls 数组，供测试断言）
 * - 通过 core.harness.init Hook 注入到 Harness 的 ChatProvider 槽位
 *
 * 配置（通过 PluginContext.config 传入）：
 *   config key: "provider.mock"
 *   value: MockProviderConfig 对象
 *
 * @example
 * const harness = await createHarness({
 *   internalPlugins: [providerMockPlugin],
 *   config: {
 *     'provider.mock': {
 *       defaultResponse: '你好',
 *       responses: [
 *         { match: '调用工具', response: '', toolCalls: [{ toolUseId: 't1', toolId: 'echo', input: { msg: 'hi' } }] },
 *       ],
 *     },
 *   },
 * })
 */

import type { ChatProvider, ChatCompletionOutput, ChatStreamChunk, ProviderRuntime } from '@harness/core'
import type { AgentPlugin, Hooks, PluginContext, ProviderConfig, ProviderTypeFactory } from '@harness/plugin'
import type { Message } from '@harness/session'

// ===== 配置类型 =====

/** 单次调用的 token 用量 */
export interface MockTokenUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** 单条响应规则 */
export interface MockResponseRule {
  /** 匹配关键词（字符串子串匹配，或正则） */
  match: string | RegExp
  /** 文本响应 */
  response?: string
  /** 工具调用 */
  toolCalls?: Array<{
    toolUseId: string
    toolId: string
    input: unknown
  }>
  /** 推理内容 */
  reasoning?: string
  /** 覆盖模型名 */
  model?: string
  /**
   * 只匹配一次（命中后不再参与后续匹配）。
   *
   * 用于模拟"真实模型的行为序列"——例如引擎内自主多步时，第一步要求调用工具、
   * 第二步（看到工具结果后）给出文本结论。缺省 `false` 表示可重复命中。
   */
  once?: boolean
}

/** Mock Provider 配置 */
export interface MockProviderConfig {
  /** 默认文本响应（无规则匹配时使用） */
  defaultResponse?: string
  /** 默认推理内容 */
  defaultReasoning?: string
  /** 模型名（默认 "mock-v1"） */
  model?: string
  /** token 用量（默认 { input: 10, output: 5 }，可含缓存命中/写入） */
  tokenUsage?: MockTokenUsage
  /**
   * 按**调用次序**取用的用量序列（第 n 次调用取第 n 项；越界则回落到 `tokenUsage`）。
   *
   * 为什么需要：`tokenUsage` 是静态值，而"缓存塌陷""用量台阶""校准比值"这类**滚动 rollout**
   * 场景必须逐轮可变 —— 否则无法验证任何依赖"相邻两轮差值"的归因逻辑
   * （`cacheMissReason` / `cacheDropTokens` / `calibration`）。
   * 缺省不配 ⇒ 行为与旧版完全一致（每次都取 `tokenUsage`）。
   */
  usageSequence?: MockTokenUsage[]
  /** 按关键词匹配的响应规则列表 */
  responses?: MockResponseRule[]
  /** 是否记录调用历史（默认 true） */
  recordCalls?: boolean
  /** 自定义延迟（ms，模拟网络延迟，默认 0） */
  delayMs?: number
  /**
   * 装配实例 id（**路由键**，默认 `'mock'`）。
   *
   * 由 `providerTypeFactory.createPlugin` 从 `ProviderConfig.id` 透传（唯一权威来源）。
   */
  providerId?: string
}

// ===== MockChatProvider 实现 =====

/**
 * Mock ChatProvider 实现
 *
 * 可独立使用（直接传给 createHarness({ chatProvider })），
 * 也可通过 providerMockPlugin 自动注入。
 */
export class MockChatProvider implements ChatProvider {
  /**
   * 装配实例 id —— **路由键**（= ProviderConfig.id），默认 `'mock'`。
   *
   * 不再是硬编码常量：硬编码会让多实例自报同一个 id，在注册表里互相覆盖。
   */
  readonly id: string
  /** 调用历史（每次 complete 的 params） */
  readonly calls: Array<{
    providerId: string
    modelId?: string
    messages: Message[]
    params: Record<string, unknown>
    headers?: Record<string, string>
    sessionId?: string
    agentId?: string
  }> = []

  private readonly config: Required<
    Pick<MockProviderConfig, 'defaultResponse' | 'defaultReasoning' | 'model' | 'tokenUsage' | 'recordCalls' | 'delayMs'>
  > & { responses: MockResponseRule[]; usageSequence?: MockTokenUsage[] }

  /** 已命中的 `once` 规则（用对象引用去重，允许同一规则对象被多个 provider 复用） */
  private readonly consumedOnce = new Set<MockResponseRule>()

  /** 已取用的调用次数（供 `usageSequence` 顺序推进；complete/stream 共用一条序列） */
  private usageCursor = 0

  /** 取本次调用的用量：优先 `usageSequence`，越界回落 `tokenUsage` */
  private nextUsage(): MockTokenUsage {
    const seq = this.config.usageSequence
    const u = seq && this.usageCursor < seq.length ? seq[this.usageCursor] : this.config.tokenUsage
    this.usageCursor++
    return u
  }

  constructor(config: MockProviderConfig = {}) {
    this.id = config.providerId ?? 'mock'
    this.config = {
      defaultResponse: config.defaultResponse ?? 'This is a mock response.',
      defaultReasoning: config.defaultReasoning ?? '',
      model: config.model ?? 'mock-v1',
      tokenUsage: config.tokenUsage ?? { input: 10, output: 5 },
      recordCalls: config.recordCalls ?? true,
      delayMs: config.delayMs ?? 0,
      responses: config.responses ?? [],
      ...(config.usageSequence ? { usageSequence: config.usageSequence } : {}),
    }
  }

  /** 从 messages 提取最后一条 user 消息的文本内容 */
  private lastUserText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user') {
        const textPart = m.parts.find((p) => p.type === 'text') as { type: 'text'; text: string } | undefined
        if (textPart) return textPart.text
      }
    }
    return ''
  }

  /** 按 user 消息内容匹配响应规则 */
  private matchRule(userText: string): MockResponseRule | undefined {
    for (const rule of this.config.responses) {
      // 已耗尽的 once 规则直接跳过（complete 与 stream 共享同一份计数）
      if (rule.once && this.consumedOnce.has(rule)) continue
      const hit = typeof rule.match === 'string'
        ? userText.includes(rule.match)
        : rule.match.test(userText)
      if (hit) {
        if (rule.once) this.consumedOnce.add(rule)
        return rule
      }
    }
    return undefined
  }

  async complete(params: {
    providerId: string
    modelId?: string
    messages: Message[]
    params: Record<string, unknown>
    headers?: Record<string, string>
    signal?: AbortSignal
    sessionId?: string
    agentId?: string
  }): Promise<ChatCompletionOutput> {
    // 模拟延迟
    if (this.config.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayMs))
    }

    // 记录调用
    if (this.config.recordCalls) {
      this.calls.push({
        providerId: params.providerId,
        modelId: params.modelId,
        messages: params.messages,
        params: params.params,
        headers: params.headers,
        sessionId: params.sessionId,
        agentId: params.agentId,
      })
    }

    // 匹配规则
    const userText = this.lastUserText(params.messages)
    const rule = this.matchRule(userText)

    const response = rule?.response ?? this.config.defaultResponse
    const reasoning = rule?.reasoning ?? this.config.defaultReasoning
    const model = rule?.model ?? this.config.model
    const toolCalls = rule?.toolCalls
    const tokenUsage = this.nextUsage()
    const outUsage = {
      input: tokenUsage.input,
      output: tokenUsage.output,
      total: tokenUsage.input + tokenUsage.output,
      ...(tokenUsage.cacheRead != null ? { cacheRead: tokenUsage.cacheRead } : {}),
      ...(tokenUsage.cacheWrite != null ? { cacheWrite: tokenUsage.cacheWrite } : {}),
    }

    const output: ChatCompletionOutput = {
      content: response,
      model,
      tokenUsage: outUsage,
    }
    if (reasoning) output.reasoning = reasoning
    if (toolCalls && toolCalls.length > 0) output.toolCalls = toolCalls
    // 对齐真实 Provider 语义：有工具调用 ⇒ 因工具调用结束（tool_calls），否则自然结束（stop）。
    // 引擎的 agentic loop 依赖这个字段决定是否续轮，mock 若不给就会退化成"finish 缺失"的路径，
    // 测不到主流程。
    output.finish = toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop'
    return output
  }

  /**
   * 流式完成：把 complete() 的结果按 token 分块 yield。
   * 默认按空格/换行分词，每块 1-3 个 token。
   * 若 config.chunkSize 设置，按指定大小切字符。
   */
  async *stream(params: {
    providerId: string
    modelId?: string
    messages: Message[]
    params: Record<string, unknown>
    headers?: Record<string, string>
    signal?: AbortSignal
    sessionId?: string
    agentId?: string
  }): AsyncGenerator<ChatStreamChunk, void, unknown> {
    // 模拟延迟
    if (this.config.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayMs))
    }

    // 记录调用
    if (this.config.recordCalls) {
      this.calls.push({
        providerId: params.providerId,
        modelId: params.modelId,
        messages: params.messages,
        params: params.params,
        headers: params.headers,
        sessionId: params.sessionId,
        agentId: params.agentId,
      })
    }

    // 匹配规则（与 complete 共用）
    const userText = this.lastUserText(params.messages)
    const rule = this.matchRule(userText)
    const response = rule?.response ?? this.config.defaultResponse
    const reasoning = rule?.reasoning ?? this.config.defaultReasoning
    const model = rule?.model ?? this.config.model
    const toolCalls = rule?.toolCalls
    const tokenUsage = this.nextUsage()

    // yield reasoning（按行分块）
    if (reasoning) {
      for (const line of this._splitTokens(reasoning)) {
        yield { type: 'reasoning_delta', text: line }
      }
    }

    // yield text（按词分块）
    if (response) {
      for (const tok of this._splitTokens(response)) {
        yield { type: 'text_delta', text: tok }
      }
    }

    // yield tool calls
    if (toolCalls) {
      for (const tc of toolCalls) {
        yield { type: 'tool_use_start', toolUseId: tc.toolUseId, toolId: tc.toolId }
        yield { type: 'tool_use_delta', inputDelta: JSON.stringify(tc.input) }
        yield { type: 'tool_use_stop' }
      }
    }

    // done
    yield {
      type: 'done',
      model,
      tokenUsage: {
        input: tokenUsage.input,
        output: tokenUsage.output,
        total: tokenUsage.input + tokenUsage.output,
        ...(tokenUsage.cacheRead != null ? { cacheRead: tokenUsage.cacheRead } : {}),
        ...(tokenUsage.cacheWrite != null ? { cacheWrite: tokenUsage.cacheWrite } : {}),
      },
      // 与 complete() 同一套语义（见该处注释）
      finish: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }
  }

  /** 将文本按词/标点分块（模拟逐 token 流式） */
  private _splitTokens(text: string): string[] {
    // 按空格/换行分词，保留分隔符
    const tokens: string[] = []
    let buf = ''
    for (const ch of text) {
      buf += ch
      if (ch === ' ' || ch === '\n' || ch === '.' || ch === ',' || ch === '，' || ch === '。' || ch === '！' || ch === '？') {
        tokens.push(buf)
        buf = ''
      }
    }
    if (buf) tokens.push(buf)
    return tokens
  }
}

// ===== 插件工厂 =====

/**
 * 创建 Mock Provider 插件
 *
 * 流程：
 * 1. install：从 ctx.config.get('provider.mock') 读取配置 → 创建 MockChatProvider 实例
 * 2. core.harness.init Hook：从 output.harness 拿到 HarnessImpl → `providers.register` 注册实例
 *
 * @param config 可选：直接传入配置（覆盖 config store 中的值）
 * @returns AgentPlugin 实例
 */
export function createProviderMockPlugin(config?: MockProviderConfig): AgentPlugin & {
  /** 暴露 MockChatProvider 实例（测试断言用） */
  readonly provider: MockChatProvider
} {
  let provider: MockChatProvider | undefined

  // 插件 id 随 providerId 派生，使多个 Mock 端点可在同一进程内各自注册而不冲突
  const providerId = config?.providerId ?? 'mock'
  const pluginId = `provider.${providerId}`

  const plugin: AgentPlugin & { readonly provider: MockChatProvider } = {
    id: pluginId,
    version: '0.1.0',
    name: 'Mock Provider',
    description: '可配置的 Mock LLM Provider，用于测试和开发',

    async install(ctx: PluginContext): Promise<Hooks | void> {
      // 优先用直接传入的 config，否则从 config store 读取
      const cfg = config ?? (ctx.config.get<MockProviderConfig>(pluginId) ?? {})
      provider = new MockChatProvider(cfg)

      ctx.log.info('Mock Provider installed', { model: provider.id, providerId })

      return {
        async 'core.harness.init'(_input, output) {
          // 从 core.harness.init 的 output 拿到 harness 实例，注入 provider
          const harness = (output as { harness?: unknown }).harness as
            | {
                providers?: ProviderRuntime
              }
            | undefined
          if (!provider) return
          // 注册键由调用方给（= ProviderConfig.id 派生），不让实例自报 id。**不设默认**。
          if (harness?.providers) {
            harness.providers.register(providerId, provider, {
              source: `plugin:${pluginId}`,
              type: 'mock',
            })
          } else {
            // 无兼容回退：`_setChatProvider` 已删除（见 remaining-work-plan §2-D）。
            // 宿主没有 `providers` 实例表时**只告警不静默** —— 这条 else 是唯一可见出口。
            ctx.log.warn('Harness.providers not found, Mock Provider may not be registered')
          }
        },
      }
    },

    async uninstall() {
      provider = undefined
    },

    get provider(): MockChatProvider {
      if (!provider) throw new Error('MockChatProvider not yet created — plugin.install() has not been called')
      return provider
    },
  }

  return plugin
}

/** 默认导出：无配置的 Mock Provider 插件（配置从 config store 读取） */
export const providerMockPlugin: AgentPlugin & { readonly provider: MockChatProvider } = createProviderMockPlugin()

// ========================================================================
// Provider 类型工厂（抽象层契约：@harness/plugin → ProviderTypeFactory）
// 上层（core/cli）只经 ProviderTypeRegistry 按 type 解析，不感知本模块具体配置结构。
// ========================================================================

export const providerTypeFactory: ProviderTypeFactory = {
  type: 'mock',
  createPlugin: (config: ProviderConfig): AgentPlugin => {
    const defaultResponse = config.defaultResponse as string | undefined
    return createProviderMockPlugin({
      ...(config as MockProviderConfig),
      // 装配实例键：ProviderConfig.id 是唯一权威来源（缺省时退回 'mock'）
      providerId: config.id,
      // 未指定默认响应（且未绑定具体模型）时给一个兜底文案，与 CLI 旧行为保持一致
      defaultResponse: defaultResponse ?? (config.model ? undefined : '(Mock Provider) 你好，我是测试助手。'),
    })
  },
}
