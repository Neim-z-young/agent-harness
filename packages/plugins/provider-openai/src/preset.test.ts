import { describe, it, expect } from 'bun:test'
import {
  OPENAI_PRESET,
  createOpenAICompatiblePlugin,
  createProviderOpenAIPlugin,
  presetProviderTypeFactory,
  providerTypeFactory,
  resolvePresetConfig,
  type OpenAICompatiblePreset,
} from './index'

/**
 * `OpenAICompatiblePreset` / `createOpenAICompatiblePlugin` 的用例。
 *
 * 这一层是 `provider-glm` / `provider-qwen` **共用的唯一装配实现**，故"能力测试"放这里、
 * 厂商包只留接线用例（本仓口径：能力归实现方，兼容归消费方）。
 */

const THINKING_PRESET: OpenAICompatiblePreset = {
  type: 'glm',
  defaultProviderId: 'glm',
  pluginName: 'GLM Provider',
  pluginDescription: 'x',
  envApiKey: 'HARNESS_TEST_ZHIPU_KEY',
  envBaseUrl: 'HARNESS_TEST_ZHIPU_BASE',
  defaultBaseUrl: 'https://open.bigmodel.cn',
  defaultApiPath: '/api/paas/v4/chat/completions',
  defaultModel: 'glm-4-flash',
  supports: { thinking: true },
}

/** 不支持 thinking 的预设（Qwen 形态：思考开关叫 enable_thinking，不是顶层 thinking） */
const PLAIN_PRESET: OpenAICompatiblePreset = {
  ...THINKING_PRESET,
  type: 'qwen',
  defaultProviderId: 'qwen',
  pluginName: 'Qwen Provider',
  envApiKey: 'HARNESS_TEST_DASHSCOPE_KEY',
  envBaseUrl: 'HARNESS_TEST_DASHSCOPE_BASE',
  defaultBaseUrl: 'https://dashscope.aliyuncs.com',
  defaultApiPath: '/compatible-mode/v1/chat/completions',
  defaultModel: 'qwen-plus',
  supports: undefined,
}

type Logged = { level: 'info' | 'warn'; msg: string; meta?: unknown }

/** 最小 PluginContext 桩：只实现 install 真正用到的 `config.get` / `log` */
function fakeCtx(store: Record<string, unknown> = {}) {
  const logs: Logged[] = []
  const ctx = {
    config: { get: (key: string) => store[key] },
    log: {
      info: (msg: string, meta?: unknown) => logs.push({ level: 'info', msg, meta }),
      warn: (msg: string) => logs.push({ level: 'warn', msg }),
    },
  }
  return { ctx: ctx as never, logs }
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> | T {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  try {
    const out = fn()
    return out instanceof Promise ? out.finally(restore) : (restore(), out)
  } catch (e) {
    restore()
    throw e
  }
}

describe('resolvePresetConfig：预设缺省与环境变量', () => {
  it('三项端点常量全部取自预设，providerId 取 defaultProviderId', () => {
    const r = resolvePresetConfig(PLAIN_PRESET, undefined)
    expect(r.baseUrl).toBe('https://dashscope.aliyuncs.com')
    expect(r.apiPath).toBe('/compatible-mode/v1/chat/completions')
    expect(r.defaultModel).toBe('qwen-plus')
    expect(r.providerId).toBe('qwen')
  })

  it('环境变量介于"显式配置"与"预设缺省"之间', () => {
    withEnv({ HARNESS_TEST_DASHSCOPE_BASE: 'https://proxy.local' }, () => {
      expect(resolvePresetConfig(PLAIN_PRESET, undefined).baseUrl).toBe('https://proxy.local')
      // 显式配置优先级最高
      expect(resolvePresetConfig(PLAIN_PRESET, { baseUrl: 'https://explicit' }).baseUrl).toBe(
        'https://explicit',
      )
      // 空串环境变量按"未配置"处理，回落到预设缺省
      process.env.HARNESS_TEST_DASHSCOPE_BASE = ''
      expect(resolvePresetConfig(PLAIN_PRESET, undefined).baseUrl).toBe('https://dashscope.aliyuncs.com')
    })
  })

  it('key 只认预设声明的环境变量（缺省给空串，不用 undefined）', () => {
    withEnv({ HARNESS_TEST_DASHSCOPE_KEY: 'dash-key' }, () => {
      expect(resolvePresetConfig(PLAIN_PRESET, undefined).apiKey).toBe('dash-key')
      delete process.env.HARNESS_TEST_DASHSCOPE_KEY
      // 空串而非 undefined：`OpenAIChatProvider` 会拿 `?? process.env.OPENAI_API_KEY` 兜底，
      // 放行 undefined 就等于"没配 qwen key 时把 openai 的 key 发去 dashscope"
      expect(resolvePresetConfig(PLAIN_PRESET, undefined).apiKey).toBe('')
    })
  })
})

describe('预设能力门：不支持的请求体字段必须被丢弃', () => {
  it('supports.thinking 缺失 ⇒ thinking / reasoningEffort 被清空', () => {
    const r = resolvePresetConfig(PLAIN_PRESET, { thinking: 'enabled', reasoningEffort: 'high' })
    expect(r.thinking).toBeUndefined()
    expect(r.reasoningEffort).toBeUndefined()
  })

  it('supports.thinking 存在 ⇒ 两个字段原样保留', () => {
    const r = resolvePresetConfig(THINKING_PRESET, { thinking: 'enabled', reasoningEffort: 'high' })
    expect(r.thinking).toBe('enabled')
    expect(r.reasoningEffort).toBe('high')
  })
})

describe('createOpenAICompatiblePlugin：装配与出声', () => {
  it('plugin.id / name 来自预设（providerId 可覆盖）', () => {
    expect(createOpenAICompatiblePlugin(THINKING_PRESET).id).toBe('provider.glm')
    expect(createOpenAICompatiblePlugin(THINKING_PRESET).name).toBe('GLM Provider')
    expect(createOpenAICompatiblePlugin(THINKING_PRESET, { providerId: 'glm-cn' }).id).toBe(
      'provider.glm-cn',
    )
  })

  it('未 install 取 provider 直接抛错，文案含插件名与原因', () => {
    const plugin = createOpenAICompatiblePlugin(THINKING_PRESET)
    expect(() => plugin.provider).toThrow(/GLM Provider 未创建/)
  })

  it('安装日志取解析后的值（不再钻私有 config 字段）', async () => {
    const { ctx, logs } = fakeCtx()
    const plugin = createOpenAICompatiblePlugin(THINKING_PRESET, { apiKey: 'k' })
    await plugin.install?.(ctx)
    const info = logs.find((l) => l.level === 'info')
    expect(info?.msg).toContain('GLM Provider 已安装')
    expect(info?.meta).toEqual({
      baseUrl: 'https://open.bigmodel.cn',
      defaultModel: 'glm-4-flash',
      providerId: 'glm',
    })
  })

  it('key 缺失 ⇒ 告警点名该读的环境变量，且说明不回退 OPENAI_API_KEY', async () => {
    await withEnv({ HARNESS_TEST_ZHIPU_KEY: undefined }, async () => {
      const { ctx, logs } = fakeCtx()
      await createOpenAICompatiblePlugin(THINKING_PRESET).install?.(ctx)
      const warn = logs.find((l) => l.level === 'warn')
      expect(warn?.msg).toContain('HARNESS_TEST_ZHIPU_KEY')
      // 不给"去配 OPENAI_API_KEY"的暗示：预设的 key 只认自己声明的那个变量
      expect(warn?.msg).toContain('provider.glm')
      expect(warn?.msg).toContain('apiKey')
    })
  })

  it('配置了预设不支持的字段 ⇒ 告警点名该字段（不静默丢弃）', async () => {
    const { ctx, logs } = fakeCtx()
    await createOpenAICompatiblePlugin(PLAIN_PRESET, { apiKey: 'k', thinking: 'enabled' }).install?.(ctx)
    const warn = logs.find((l) => l.level === 'warn')
    expect(warn?.msg).toContain('thinking')
    expect(warn?.msg).toContain('不转发')
  })

  it('支持的字段不产生告警', async () => {
    const { ctx, logs } = fakeCtx()
    await createOpenAICompatiblePlugin(THINKING_PRESET, { apiKey: 'k', thinking: 'enabled' }).install?.(ctx)
    expect(logs.filter((l) => l.level === 'warn')).toHaveLength(0)
  })

  it('config store 用 `provider.<id>` 作键，显式配置覆盖 store', async () => {
    const { ctx } = fakeCtx({ 'provider.glm': { apiKey: 'from-store', defaultModel: 'glm-4' } })
    const plugin = createOpenAICompatiblePlugin(THINKING_PRESET, { defaultModel: 'glm-4-plus' })
    await plugin.install?.(ctx)
    expect(plugin.provider.id).toBe('glm')
    // 读取的是合并后的终态：显式参数赢过 store
    let captured: any
    const prevFetch = (globalThis as any).fetch
    ;(globalThis as any).fetch = async (_u: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string)
      return new Response(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          model: captured.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    }
    try {
      await plugin.provider.complete({
        providerId: 'glm',
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 1 }],
        params: {},
      })
    } finally {
      ;(globalThis as any).fetch = prevFetch
    }
    expect(captured.model).toBe('glm-4-plus')
  })
})

describe('createOpenAICompatiblePlugin：core.harness.init 注册', () => {
  function initHookOf(plugin: ReturnType<typeof createOpenAICompatiblePlugin>) {
    return async (harness: unknown) => {
      const { ctx } = fakeCtx()
      const hooks = await plugin.install?.(ctx)
      const init = (hooks as Record<string, unknown>)['core.harness.init'] as (
        input: unknown,
        output: unknown,
      ) => Promise<void>
      await init(undefined, { harness })
    }
  }

  it('注册键 = 解析后的 providerId，type 取预设 type，source 指回插件 id', async () => {
    const calls: Array<[string, unknown, unknown]> = []
    const harness = {
      providers: { register: (key: string, p: unknown, opts: unknown) => calls.push([key, p, opts]) },
      tools: { list: () => [] },
    }
    const plugin = createOpenAICompatiblePlugin(THINKING_PRESET, { apiKey: 'k' })
    await initHookOf(plugin)(harness)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('glm')
    expect(calls[0][1]).toBe(plugin.provider)
    expect(calls[0][2]).toEqual({ source: 'plugin:provider.glm', type: 'glm' })
  })

  it('宿主没有 providers 实例表 ⇒ 告警（不静默）', async () => {
    const { ctx, logs } = fakeCtx()
    const plugin = createOpenAICompatiblePlugin(PLAIN_PRESET, { apiKey: 'k' })
    const hooks = await plugin.install?.(ctx)
    const init = (hooks as Record<string, unknown>)['core.harness.init'] as (
      i: unknown,
      o: unknown,
    ) => Promise<void>
    await init(undefined, { harness: { tools: { list: () => [] } } })
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('Harness.providers 未找到'))).toBe(true)
  })
})

describe('presetProviderTypeFactory：config.json → 插件', () => {
  it('type 与预设一致；id/model/baseUrl/apiPath 逐项映射', async () => {
    const factory = presetProviderTypeFactory(PLAIN_PRESET)
    expect(factory.type).toBe('qwen')
    const plugin = factory.createPlugin({
      id: 'qwen-cn',
      model: 'qwen-max',
      apiKey: 'k',
      baseUrl: 'https://proxy',
      apiPath: '/v1/chat',
    } as never) as ReturnType<typeof createOpenAICompatiblePlugin>
    expect(plugin.id).toBe('provider.qwen-cn')
    await plugin.install?.(fakeCtx().ctx)
    expect(plugin.provider.id).toBe('qwen-cn')
  })

  it('completeTimeoutFactor / thinking 的取值校验只写一份（非法值按未配置）', async () => {
    const factory = presetProviderTypeFactory(THINKING_PRESET)
    const ok = factory.createPlugin({
      id: 'glm',
      model: 'glm-4',
      thinking: 'enabled',
      completeTimeoutFactor: 3,
    } as never) as ReturnType<typeof createOpenAICompatiblePlugin>
    await ok.install?.(fakeCtx().ctx)
    expect(ok.provider['config'].thinking).toBe('enabled')
    expect(ok.provider['config'].completeTimeoutFactor).toBe(3)

    // 非法值（ProviderConfig 有 index signature，这里就是唯一闸门）
    const bad = factory.createPlugin({
      id: 'glm',
      model: 'glm-4',
      thinking: 'yes',
      completeTimeoutFactor: -1,
    } as never) as ReturnType<typeof createOpenAICompatiblePlugin>
    await bad.install?.(fakeCtx().ctx)
    expect(bad.provider['config'].thinking).toBeUndefined()
    expect(bad.provider['config'].completeTimeoutFactor).toBe(10)
  })
})

describe('原生 OpenAI 也走预设装配（迁移回归）', () => {
  it('插件 id / name / description 与迁移前逐字一致', () => {
    const plugin = createProviderOpenAIPlugin()
    expect(plugin.id).toBe('provider.openai')
    expect(plugin.name).toBe('OpenAI Provider')
    expect(plugin.description).toBe('对接 OpenAI Chat Completions API 的 Provider 插件')
    expect(providerTypeFactory.type).toBe('openai')
  })

  it('端点缺省仍是 api.openai.com / /v1/chat/completions / gpt-4o-mini', () => {
    const r = resolvePresetConfig(OPENAI_PRESET, undefined)
    expect(r.baseUrl).toBe('https://api.openai.com')
    expect(r.apiPath).toBe('/v1/chat/completions')
    expect(r.defaultModel).toBe('gpt-4o-mini')
  })

  it('thinking / reasoningEffort 仍被转发（compat 端点如 DeepSeek 依赖）', async () => {
    const plugin = createProviderOpenAIPlugin({
      apiKey: 'k',
      thinking: 'enabled',
      reasoningEffort: 'high',
    })
    await plugin.install?.(fakeCtx().ctx)
    expect(plugin.provider['config'].thinking).toBe('enabled')
    expect(plugin.provider['config'].reasoningEffort).toBe('high')
  })

  it('providerId 可覆盖（deepseek / ollama 等多端点同进程注册）', () => {
    expect(createProviderOpenAIPlugin({ providerId: 'deepseek' }).id).toBe('provider.deepseek')
  })
})
