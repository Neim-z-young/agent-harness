/**
 * @harness/provider-glm - 智谱 GLM Provider 插件
 *
 * 基于智谱 BigModel 的 OpenAI 兼容 API：
 * - baseUrl: https://open.bigmodel.cn
 * - apiPath: /api/paas/v4/chat/completions
 * - 认证：Authorization: Bearer {ZHIPU_API_KEY}
 * - 默认模型：glm-4-flash
 *
 * 复用 @harness/provider-openai 的 OpenAIChatProvider，仅覆盖配置。
 *
 * 配置来源（优先级从高到低）：
 * 1. createProviderGlmPlugin({ ... }) 直接传入配置
 * 2. ctx.config.get('provider.glm')
 * 3. 环境变量 ZHIPU_API_KEY / ZHIPU_BASE_URL
 */

import type { ChatProvider } from '@harness/core'
import type { AgentPlugin, Hooks, PluginContext } from '@harness/plugin'
import type { Tool } from '@harness/tool'
import { OpenAIChatProvider, type OpenAIProviderConfig } from '@harness/provider-openai'

// ===== 配置 =====

export interface GlmProviderConfig {
  /** API Key（默认读 ZHIPU_API_KEY 环境变量） */
  apiKey?: string
  /** API 根路径（默认 https://open.bigmodel.cn） */
  baseUrl?: string
  /** API 路径（默认 /api/paas/v4/chat/completions） */
  apiPath?: string
  /** 默认模型（默认 glm-4-flash） */
  defaultModel?: string
  /** max_tokens 默认值 */
  maxTokens?: number
  /** 请求超时（ms） */
  timeoutMs?: number
  /** 当模型输出空时是否报错 */
  strictEmptyContent?: boolean
  /** Provider ID（默认 'glm'；配置多 GLM 端点时可覆盖为不同 id） */
  providerId?: string
}

function toOpenAIConfig(cfg: GlmProviderConfig): OpenAIProviderConfig {
  const envKey = typeof process !== 'undefined' ? process.env.ZHIPU_API_KEY : undefined
  const envBase = typeof process !== 'undefined' ? process.env.ZHIPU_BASE_URL : undefined
  return {
    apiKey: cfg.apiKey ?? envKey,
    baseUrl: cfg.baseUrl ?? envBase ?? 'https://open.bigmodel.cn',
    apiPath: cfg.apiPath ?? '/api/paas/v4/chat/completions',
    defaultModel: cfg.defaultModel ?? 'glm-4-flash',
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    strictEmptyContent: cfg.strictEmptyContent,
    providerId: cfg.providerId ?? 'glm',
  }
}

// ========================================================================
// 插件工厂
// ========================================================================

export function createProviderGlmPlugin(config?: GlmProviderConfig): AgentPlugin & {
  readonly provider: OpenAIChatProvider
} {
  let provider: OpenAIChatProvider | undefined

  // 插件 id 随 providerId 派生，使多个 GLM 端点可在同一进程内各自注册而不冲突
  const providerId = config?.providerId ?? 'glm'
  const pluginId = `provider.${providerId}`

  const plugin: AgentPlugin & { readonly provider: OpenAIChatProvider } = {
    id: pluginId,
    version: '0.1.0',
    name: 'GLM Provider',
    description: '对接智谱 GLM（BigModel OpenAI 兼容 API）的 Provider 插件',

    async install(ctx: PluginContext): Promise<Hooks | void> {
      const storeCfg = ctx.config.get<GlmProviderConfig>(pluginId)
      const merged: GlmProviderConfig = { ...(storeCfg ?? {}), ...(config ?? {}) }

      provider = new OpenAIChatProvider(toOpenAIConfig(merged), () => [])

      ctx.log.info('GLM Provider 已安装', {
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
            ctx.log.warn('Harness._setChatProvider 未找到，GLM Provider 可能未注册')
          }

          provider.setToolsGetter(() => harness?.tools?.list?.() ?? [])
        },
      }
    },

    async uninstall() {
      provider = undefined
    },

    get provider(): OpenAIChatProvider {
      if (!provider) throw new Error('GLM Provider 未创建 — plugin.install() 未执行')
      return provider
    },
  }

  return plugin
}

/** 默认导出：无配置常量（配置来自 config store 与环境变量） */
export const providerGlmPlugin: AgentPlugin & { readonly provider: OpenAIChatProvider } =
  createProviderGlmPlugin()
