/**
 * @harness/provider-qwen - 通义千问 Qwen Provider 插件
 *
 * 基于阿里云 DashScope 的 OpenAI 兼容模式：
 * - baseUrl: https://dashscope.aliyuncs.com
 * - apiPath: /compatible-mode/v1/chat/completions
 * - 认证：Authorization: Bearer {DASHSCOPE_API_KEY}
 * - 默认模型：qwen-plus
 *
 * 复用 @harness/provider-openai 的 `OpenAIChatProvider` + `createOpenAICompatiblePlugin`，
 * 本文件**只声明常量**（端点、模型、环境变量名、能力开关）—— 装配逻辑在 provider-openai 里
 * 只有一份，见其 `OpenAICompatiblePreset` 的说明。
 *
 * 配置来源（优先级从高到低）：
 * 1. createProviderQwenPlugin({ ... }) 直接传入配置
 * 2. ctx.config.get('provider.qwen')
 * 3. 环境变量 DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL
 *
 * ⚠️ **不继承 `OPENAI_API_KEY`**：本预设的 key 只认 `DASHSCOPE_API_KEY`，未配置时以空 Bearer
 * 发出（安装期告警）。
 */

import type { AgentPlugin } from '@harness/plugin'
import {
  createOpenAICompatiblePlugin,
  presetProviderTypeFactory,
  type OpenAICompatiblePreset,
  type OpenAIProviderConfig,
} from '@harness/provider-openai'

/** Qwen 的端点常量（装配逻辑见 {@link createOpenAICompatiblePlugin}） */
export const QWEN_PRESET: OpenAICompatiblePreset = {
  type: 'qwen',
  defaultProviderId: 'qwen',
  pluginName: 'Qwen Provider',
  pluginDescription: '对接通义千问（DashScope OpenAI 兼容模式）的 Provider 插件',
  envApiKey: 'DASHSCOPE_API_KEY',
  envBaseUrl: 'DASHSCOPE_BASE_URL',
  defaultBaseUrl: 'https://dashscope.aliyuncs.com',
  defaultApiPath: '/compatible-mode/v1/chat/completions',
  defaultModel: 'qwen-plus',
  // 刻意**不**声明 supports.thinking：DashScope 的思考开关叫 `enable_thinking`，
  // 顶层 `thinking: { type }` 不是它的语义 ⇒ 照抄过去会 400。配了会在安装期告警。
}

/**
 * 配置项。字段与缺省值见 {@link QWEN_PRESET}（本类型刻意直接复用 `OpenAIProviderConfig`，
 * 避免再维护一份"同样字段、不同注释"的影子类型）。
 */
export type QwenProviderConfig = OpenAIProviderConfig

export function createProviderQwenPlugin(config?: QwenProviderConfig): AgentPlugin & {
  readonly provider: ReturnType<typeof createOpenAICompatiblePlugin>['provider']
} {
  return createOpenAICompatiblePlugin(QWEN_PRESET, config)
}

/** 默认导出：无配置常量（配置来自 config store 与环境变量） */
export const providerQwenPlugin = createProviderQwenPlugin()

// ========================================================================
// Provider 类型工厂（抽象层契约：@harness/plugin → ProviderTypeFactory）
// 上层（core/cli）只经 ProviderTypeRegistry 按 type 解析，不感知本模块具体配置结构。
// ========================================================================

export const providerTypeFactory = presetProviderTypeFactory(QWEN_PRESET)
