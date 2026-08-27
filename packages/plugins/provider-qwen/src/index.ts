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

import type { ChatProvider } from '@harness/core'
import type { AgentPlugin, Hooks, PluginContext } from '@harness/plugin'
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
        async 'harness.init'(_input, output) {
          const harness = (output as { harness?: unknown }).harness as
            | {
                _setChatProvider?: (p: ChatProvider) => void
                tools?: { list?: () => Tool[] }
              }
            | undefined

          if (!provider) return

          if (harness?._setChatProvider) {
            harness._setChatProvider(provider)
          } else {
            ctx.log.warn('Harness._setChatProvider 未找到，Qwen Provider 可能未注册')
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
