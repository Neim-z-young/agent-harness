/**
 * @harness/provider-qwen - 通义千问 Qwen Provider 插件
 *
 * 基于阿里云 DashScope 的 OpenAI 兼容模式：
 * - baseUrl: https://dashscope.aliyuncs.com
 * - apiPath: /compatible-mode/v1/chat/completions
 * - 认证：Authorization: Bearer {DASHSCOPE_API_KEY}
 * - 默认模型：qwen-plus
 *
 * 复用 @harness/provider-openai 的 OpenAIChatProvider，仅覆盖配置。
 *
 * 配置来源（优先级从高到低）：
 * 1. createProviderQwenPlugin({ ... }) 直接传入配置
 * 2. ctx.config.get('provider.qwen')
 * 3. 环境变量 DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL
 */

import type { ChatProvider, ProviderRuntime } from '@harness/core'
import type { AgentPlugin, Hooks, PluginContext, ProviderConfig, ProviderTypeFactory } from '@harness/plugin'
import type { Tool } from '@harness/tool'
import { OpenAIChatProvider, type OpenAIProviderConfig } from '@harness/provider-openai'

// ===== 配置 =====

export interface QwenProviderConfig {
  /** API Key（默认读 DASHSCOPE_API_KEY 环境变量） */
  apiKey?: string
  /** API 根路径（默认 https://dashscope.aliyuncs.com） */
  baseUrl?: string
  /** API 路径（默认 /compatible-mode/v1/chat/completions） */
  apiPath?: string
  /** 默认模型（默认 qwen-plus） */
  defaultModel?: string
  /** max_tokens 默认值 */
  maxTokens?: number
  /** 请求超时（ms） */
  timeoutMs?: number
  /** 当模型输出空时是否报错 */
  strictEmptyContent?: boolean
  /** Provider ID（默认 'qwen'；配置多 Qwen 端点时可覆盖为不同 id） */
  providerId?: string
}

function toOpenAIConfig(cfg: QwenProviderConfig): OpenAIProviderConfig {
  const envKey = typeof process !== 'undefined' ? process.env.DASHSCOPE_API_KEY : undefined
  const envBase = typeof process !== 'undefined' ? process.env.DASHSCOPE_BASE_URL : undefined
  return {
    apiKey: cfg.apiKey ?? envKey,
    baseUrl: cfg.baseUrl ?? envBase ?? 'https://dashscope.aliyuncs.com',
    apiPath: cfg.apiPath ?? '/compatible-mode/v1/chat/completions',
    defaultModel: cfg.defaultModel ?? 'qwen-plus',
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    strictEmptyContent: cfg.strictEmptyContent,
    providerId: cfg.providerId ?? 'qwen',
  }
}

// ========================================================================
// 插件工厂
// ========================================================================

export function createProviderQwenPlugin(config?: QwenProviderConfig): AgentPlugin & {
  readonly provider: OpenAIChatProvider
} {
  let provider: OpenAIChatProvider | undefined

  // 插件 id 随 providerId 派生，使多个 Qwen 端点可在同一进程内各自注册而不冲突
  const providerId = config?.providerId ?? 'qwen'
  const pluginId = `provider.${providerId}`

  const plugin: AgentPlugin & { readonly provider: OpenAIChatProvider } = {
    id: pluginId,
    version: '0.1.0',
    name: 'Qwen Provider',
    description: '对接通义千问 Qwen（DashScope OpenAI 兼容模式）的 Provider 插件',

    async install(ctx: PluginContext): Promise<Hooks | void> {
      const storeCfg = ctx.config.get<QwenProviderConfig>(pluginId)
      const merged: QwenProviderConfig = { ...(storeCfg ?? {}), ...(config ?? {}) }

      provider = new OpenAIChatProvider(toOpenAIConfig(merged), () => [])

      ctx.log.info('Qwen Provider 已安装', {
        baseUrl: provider['config'].baseUrl,
        defaultModel: provider['config'].defaultModel,
      })

      return {
        async 'core.harness.init'(_input, output) {
          const harness = (output as { harness?: unknown }).harness as
            | {
                providers?: ProviderRuntime
                tools?: { list?: () => Tool[] }
              }
            | undefined

          if (!provider) return

          // 注册键由调用方给（= ProviderConfig.id 派生），不让实例自报 id —— 见
          // docs/runtime-registration-plan.md §2.1。**不设默认**：默认由宿主显式 setDefault。
          if (harness?.providers) {
            harness.providers.register(providerId, provider, {
              source: `plugin:${pluginId}`,
              type: 'qwen',
            })
          } else {
            // 无兼容回退：`_setChatProvider` 已删除（见 remaining-work-plan §2-D）。
            // 宿主没有 `providers` 实例表时**只告警不静默** —— 这条 else 是唯一可见出口。
            ctx.log.warn('Harness.providers 未找到，Qwen Provider 可能未注册')
          }

          provider.setToolsGetter(() => harness?.tools?.list?.() ?? [])
        },
      }
    },

    async uninstall() {
      provider = undefined
    },

    get provider(): OpenAIChatProvider {
      if (!provider) throw new Error('Qwen Provider 未创建 — plugin.install() 未执行')
      return provider
    },
  }

  return plugin
}

/** 默认导出：无配置常量（配置来自 config store 与环境变量） */
export const providerQwenPlugin: AgentPlugin & { readonly provider: OpenAIChatProvider } =
  createProviderQwenPlugin()

// ========================================================================
// Provider 类型工厂（抽象层契约：@harness/plugin → ProviderTypeFactory）
// 上层（core/cli）只经 ProviderTypeRegistry 按 type 解析，不感知本模块具体配置结构。
// ========================================================================

export const providerTypeFactory: ProviderTypeFactory = {
  type: 'qwen',
  createPlugin: (config: ProviderConfig): AgentPlugin =>
    createProviderQwenPlugin({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      defaultModel: config.model,
      maxTokens: config.maxTokens,
      timeoutMs: config.timeoutMs,
      apiPath: config.apiPath,
      providerId: config.id,
    }),
}
