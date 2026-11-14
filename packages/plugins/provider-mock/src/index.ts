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

import type { ChatProvider, ChatCompletionOutput, ChatStreamChunk, ProviderRuntime, Tool } from '@harness/core'
import type { AgentPlugin, Hooks, PluginContext, ProviderConfig, ProviderTypeFactory } from '@harness/plugin'
import type { Message } from '@harness/session'

// ===== 契约入参（**唯一来源**，不手抄）=====

/**
 * 引擎调用 provider 的入参 —— 直接取 `ChatProvider` 契约的类型，**不再手抄一份**。
 *
 * 为什么：`complete` / `stream` 里曾各自内联同一份参数对象字面量。契约后来新增了
 * `tools`（本 agent **实际可用**的工具，已按白名单过滤），两处内联都没跟上 ⇒ mock 既收不到
 * 也不记录它。而 mock 是全仓 6 个包（core/cli/a2a-server/tools-builtin/bench/host）共用的
 * 测试替身：它看不见的东西，等于全仓都断言不了 —— "白名单是否真的传到了 provider"
 * 这条链路此前没有任何用例能覆盖，看起来却处处都有 mock 在跑。
 *
 * 用 `Parameters<…>` 取型后，契约再加字段时这里自动跟随（至少能编译期暴露"没处理"）。
 */
type CompleteParams = Parameters<ChatProvider['complete']>[0]
/** `stream` 的入参（与 complete 同形，但**各自取型**：任一契约分叉都会在调用点变红） */
type StreamParams = Parameters<NonNullable<ChatProvider['stream']>>[0]

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

/** 一次 `complete` / `stream` 调用的记录（测试断言用） */
export interface MockCallRecord {
  providerId: string
  modelId?: string
  messages: Message[]
  params: Record<string, unknown>
  headers?: Record<string, string>
  sessionId?: string
  agentId?: string
  /**
   * 本 agent **实际可用**的工具 —— 引擎按白名单过滤后传进来的那一份。
   *
   * 缺省 `undefined` 表示调用方未提供（**不是**"没有工具"）。两者必须能区分：
   * 前者是"这条链路上没人传"，后者是"传了、但一个都不允许"，混在一起就分不清
   * 是引擎漏传还是白名单为空。
   */
  tools?: Tool[]
  /**
   * 命中的响应规则下标（`responses` 里第几条）；`undefined` = 无规则命中、走了默认响应。
   *
   * 为什么记：**未命中时现象与"规则写错"完全一致**（都拿到 defaultResponse）。没有这个字段
   * 只能靠复现匹配过程猜；有了它，断言可以直接说"命中的是第 2 条"。
   */
  matchedRuleIndex?: number
}

/** 匹配结果：命中的规则 + 它的下标 */
interface RuleHit {
  rule: MockResponseRule
  index: number
}

/**
 * 关键词 / 正则匹配。
 *
 * ⚠️ 正则**是有状态的**：带 `g` / `y` 标志的 RegExp 会沿用 `lastIndex`，同一个实例第二次
 * `test()` 会从上次命中的位置继续 ⇒ 同一输入交替给出 命中/落空（实测 `/hello/g` 连调三次
 * 得到 hit / miss / hit）。配置允许直接传 RegExp，故每次匹配前必须归零。
 */
function textMatches(match: string | RegExp, text: string): boolean {
  if (typeof match === 'string') return text.includes(match)
  match.lastIndex = 0
  return match.test(text)
}

/**
 * 内部用量 → 契约用量。`total` 与缓存字段的**唯一产地**。
 *
 * 此前 `complete` 与 `stream` 各写一份同样的对象字面量：`total` 的算法一旦有一侧改
 * （比如改成 input+output+cacheWrite），两条路径就会给出不同的用量口径 —— 而用量正是
 * 缓存归因 / 占用率那些用例的输入，注释里"与 complete 逐位一致"的承诺会静默失效。
 */
function toUsage(u: MockTokenUsage): ChatCompletionOutput['tokenUsage'] {
  return {
    input: u.input,
    output: u.output,
    total: u.input + u.output,
    ...(u.cacheRead != null ? { cacheRead: u.cacheRead } : {}),
    ...(u.cacheWrite != null ? { cacheWrite: u.cacheWrite } : {}),
  }
}

/**
 * 结束原因（complete 与 stream 共用的唯一判据）。
 *
 * 对齐真实 Provider 语义：有工具调用 ⇒ 因工具调用结束（`tool_calls`），否则自然结束（`stop`）。
 * 引擎的 agentic loop 依赖这个字段决定是否续轮，mock 若不给就会退化成"finish 缺失"的路径，
 * 主流程测不到。
 */
function finishOf(toolCalls: MockResponseRule['toolCalls']): NonNullable<ChatCompletionOutput['finish']> {
  return toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop'
}

/**
 * 与 `DOMException(…, 'AbortError')` 同形的中断错误。
 *
 * 名字是**契约**：core 的 `isAbortError` 只认 `name === 'AbortError' | 'TimeoutError'`，
 * 名字不对就会被当成真实故障往上抛（"用户取消"被报成崩溃）。
 * 优先透传 `signal.reason`（调用方可能塞了自定义原因，它自带正确的 name）。
 */
function abortError(signal?: AbortSignal): unknown {
  const reason: unknown = signal?.reason
  if (reason && typeof reason === 'object' && (reason as { name?: unknown }).name === 'AbortError') {
    return reason
  }
  return new DOMException('Mock provider call aborted', 'AbortError')
}

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
  /** 调用历史（每次 complete / stream 的入参） */
  readonly calls: MockCallRecord[] = []

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

  /**
   * 模拟网络延迟；`signal` 中断时**立即**结束并抛 AbortError。
   *
   * 两条约束：
   * - 定时器**刻意不 unref**：被 await 的定时器一旦 unref，Windows 上事件循环会认为
   *   没有存活句柄而跳过轮询 ⇒ 永不到期 ⇒ 静默挂死（项目 MEMORY 已钉住）。
   * - 中断时必须 `clearTimeout` 并摘掉监听器，否则被取消的调用还会把定时器留在事件循环里，
   *   把「取消」变成「等满 delayMs 才返回」。
   */
  private async delay(signal?: AbortSignal): Promise<void> {
    const ms = this.config.delayMs
    // 已中断的 signal：一个 chunk 都不该发（更别等延迟）
    if (signal?.aborted) throw abortError(signal)
    if (ms <= 0) return
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(abortError(signal))
      }
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
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

  /**
   * 最后一条 **user** 消息的全部文本片段（按顺序以换行拼接）。
   *
   * 只取第一个 text part 会漏掉后续片段（如 `[text 摘要, text 正文]`）—— 关键词恰好在
   * 被漏掉的那段上时，现象是"文字明明在消息里却走了默认响应"，且没有任何信号可查。
   * 真实 provider 序列化时也是把同一条消息里的多个文本块全部发出去，这里与之一致。
   *
   * 该消息一个文本片段都没有（如只带 file）时继续往前找 —— 否则"末尾一条纯附件消息"
   * 会让整轮匹配退化到默认响应。
   */
  private lastUserText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'user') continue
      const text = m.parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .filter((t) => t.length > 0)
        .join('\n')
      if (text) return text
    }
    return ''
  }

  /** 按 user 消息内容匹配响应规则（首个命中者胜出；`once` 规则用尽后跳过） */
  private matchRule(userText: string): RuleHit | undefined {
    for (let i = 0; i < this.config.responses.length; i++) {
      const rule = this.config.responses[i]
      // 已耗尽的 once 规则直接跳过（complete 与 stream 共享同一份计数）
      if (rule.once && this.consumedOnce.has(rule)) continue
      if (!textMatches(rule.match, userText)) continue
      if (rule.once) this.consumedOnce.add(rule)
      return { rule, index: i }
    }
    return undefined
  }

  /** 记录调用入参（`recordCalls: false` 时整体跳过） */
  private recordCall(params: CompleteParams, matchedRuleIndex: number | undefined): void {
    if (!this.config.recordCalls) return
    this.calls.push({
      providerId: params.providerId,
      modelId: params.modelId,
      messages: params.messages,
      params: params.params,
      headers: params.headers,
      sessionId: params.sessionId,
      agentId: params.agentId,
      ...(params.tools ? { tools: params.tools } : {}),
      ...(matchedRuleIndex != null ? { matchedRuleIndex } : {}),
    })
  }

  /**
   * 一次调用的**全部**事实：延迟 → 记录 → 规则匹配 → 取用量。
   *
   * complete 与 stream 共用本函数。此前两条路径各自内联同一段约 40 行逻辑（含用量字面量与
   * finish 表达式各两份）：只要一侧被改、另一侧忘改，"流式断言"与"非流式断言"就会给出
   * 互相矛盾的结论，而两边跑起来都是绿的。
   *
   * 顺序有意为之：先记录入参再匹配 —— 调用记录反映的是"provider 收到了什么"，
   * 不能因为匹配失败就丢掉（否则排查"为什么拿到默认文案"时连输入都看不到）。
   */
  private async resolveTurn(params: CompleteParams): Promise<{
    response: string
    reasoning: string
    model: string
    toolCalls: MockResponseRule['toolCalls']
    usage: ChatCompletionOutput['tokenUsage']
  }> {
    await this.delay(params.signal)

    const userText = this.lastUserText(params.messages)
    const hit = this.matchRule(userText)
    this.recordCall(params, hit?.index)

    return {
      response: hit?.rule.response ?? this.config.defaultResponse,
      reasoning: hit?.rule.reasoning ?? this.config.defaultReasoning,
      model: hit?.rule.model ?? this.config.model,
      toolCalls: hit?.rule.toolCalls,
      usage: toUsage(this.nextUsage()),
    }
  }

  async complete(params: CompleteParams): Promise<ChatCompletionOutput> {
    const turn = await this.resolveTurn(params)

    const output: ChatCompletionOutput = {
      content: turn.response,
      model: turn.model,
      tokenUsage: turn.usage,
    }
    if (turn.reasoning) output.reasoning = turn.reasoning
    if (turn.toolCalls && turn.toolCalls.length > 0) output.toolCalls = turn.toolCalls
    output.finish = finishOf(turn.toolCalls)
    return output
  }

  /**
   * 流式完成：把同一次 turn 的结果按 token 分块 yield。
   * 默认按空格/换行分词，每块 1-3 个 token。
   * 若 config.chunkSize 设置，按指定大小切字符。
   *
   * `signal` 在**每个 chunk 之前**检查：中断即抛 AbortError（不发 `done`）。
   * 真实 provider 中断时同样是"流半途结束 + 抛中断错误"，若不抛，消费方会把这轮当成
   * 正常结束 —— 取消变成静默成功，且已产出的半截文本会被当成完整回答落库。
   */
  async *stream(params: StreamParams): AsyncGenerator<ChatStreamChunk, void, unknown> {
    const turn = await this.resolveTurn(params)
    const guard = (): void => {
      if (params.signal?.aborted) throw abortError(params.signal)
    }

    // yield reasoning（按行分块）
    if (turn.reasoning) {
      for (const line of this._splitTokens(turn.reasoning)) {
        guard()
        yield { type: 'reasoning_delta', text: line }
      }
    }

    // yield text（按词分块）
    if (turn.response) {
      for (const tok of this._splitTokens(turn.response)) {
        guard()
        yield { type: 'text_delta', text: tok }
      }
    }

    // yield tool calls
    if (turn.toolCalls) {
      for (const tc of turn.toolCalls) {
        guard()
        yield { type: 'tool_use_start', toolUseId: tc.toolUseId, toolId: tc.toolId }
        yield { type: 'tool_use_delta', inputDelta: JSON.stringify(tc.input) }
        yield { type: 'tool_use_stop' }
      }
    }

    guard()
    yield {
      type: 'done',
      model: turn.model,
      tokenUsage: turn.usage,
      finish: finishOf(turn.toolCalls),
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
