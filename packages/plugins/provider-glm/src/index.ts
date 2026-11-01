/**
 * @harness/provider-glm - 智谱 GLM Provider 插件
 *
 * 基于智谱 BigModel 的 OpenAI 兼容 API：
 * - baseUrl: https://open.bigmodel.cn
 * - apiPath: /api/paas/v4/chat/completions
 * - 认证：Authorization: Bearer {ZHIPU_API_KEY}
 * - 默认模型：glm-4-flash
 *
 * 复用 @harness/provider-openai 的 `OpenAIChatProvider` + `createOpenAICompatiblePlugin`，
 * 本文件**只声明常量**（端点、模型、环境变量名、能力开关）—— 装配逻辑在 provider-openai 里
 * 只有一份，见其 `OpenAICompatiblePreset` 的说明。
 *
 * 配置来源（优先级从高到低）：
 * 1. createProviderGlmPlugin({ ... }) 直接传入配置
 * 2. ctx.config.get('provider.glm')
 * 3. 环境变量 ZHIPU_API_KEY / ZHIPU_BASE_URL
 *
 * ⚠️ **不继承 `OPENAI_API_KEY`**：本预设的 key 只认 `ZHIPU_API_KEY`，未配置时以空 Bearer 发出
 * （安装期告警）。否则"忘了配智谱 key"会安静地把 OpenAI 的 key 送到 bigmodel.cn。
 */

import type { AgentPlugin } from '@harness/plugin'
import {
  createOpenAICompatiblePlugin,
  presetProviderTypeFactory,
  type OpenAICompatiblePreset,
  type OpenAIProviderConfig,
} from '@harness/provider-openai'

/** GLM 的端点常量（装配逻辑见 {@link createOpenAICompatiblePlugin}） */
export const GLM_PRESET: OpenAICompatiblePreset = {
  type: 'glm',
  defaultProviderId: 'glm',
  pluginName: 'GLM Provider',
  pluginDescription: '对接智谱 GLM（BigModel OpenAI 兼容 API）的 Provider 插件',
  envApiKey: 'ZHIPU_API_KEY',
  envBaseUrl: 'ZHIPU_BASE_URL',
  defaultBaseUrl: 'https://open.bigmodel.cn',
  defaultApiPath: '/api/paas/v4/chat/completions',
  defaultModel: 'glm-4-flash',
  // 智谱接受顶层 `thinking: { type }`（与 DeepSeek 同形），故允许转发
  supports: { thinking: true },
}

/**
 * 配置项。字段与缺省值见 {@link GLM_PRESET}（本类型刻意直接复用 `OpenAIProviderConfig`，
 * 避免再维护一份"同样字段、不同注释"的影子类型）。
 */
export type GlmProviderConfig = OpenAIProviderConfig

export function createProviderGlmPlugin(config?: GlmProviderConfig): AgentPlugin & {
  readonly provider: ReturnType<typeof createOpenAICompatiblePlugin>['provider']
} {
  return createOpenAICompatiblePlugin(GLM_PRESET, config)
}

/** 默认导出：无配置常量（配置来自 config store 与环境变量） */
export const providerGlmPlugin = createProviderGlmPlugin()

// ========================================================================
// Provider 类型工厂（抽象层契约：@harness/plugin → ProviderTypeFactory）
// 上层（core/cli）只经 ProviderTypeRegistry 按 type 解析，不感知本模块具体配置结构。
// ========================================================================

export const providerTypeFactory = presetProviderTypeFactory(GLM_PRESET)
