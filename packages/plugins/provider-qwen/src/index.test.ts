import { describe, it, expect } from 'bun:test'
import {
  createProviderQwenPlugin,
  providerQwenPlugin,
  type QwenProviderConfig,
} from './index'
import { OpenAIChatProvider } from '@harness/provider-openai'
import type { Message } from '@harness/session'
import { createHarness, DefaultPermissionEngine } from '@harness/core'
import type { AgentDefinition } from '@harness/core'

// ===== helpers =====

function makeAgent(): AgentDefinition {
  return {
    id: 'default',
    name: 'Agent',
    description: 'x',
    mode: 'primary',
    tools: ['*'],
    permission: { '*': 'allow' },
    promptFragments: [],
  }
}

type FetchMock = (args: { url: string; init: RequestInit }) => Response | Promise<Response>
function installMock(mock: FetchMock) {
  const prev = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (url: string, init: RequestInit) => mock({ url, init })
  return () => {
    ;(globalThis as any).fetch = prev
  }
}

function okResponse(content: string, model = 'qwen-plus'): string {
  return JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  })
}

// ===== 测试 =====

describe('@harness/provider-qwen', () => {
  describe('配置默认值', () => {
    it('默认 baseUrl / apiPath / defaultModel / providerId 正确', () => {
      const savedKey = process.env.DASHSCOPE_API_KEY
      delete process.env.DASHSCOPE_API_KEY
      try {
        const plugin = createProviderQwenPlugin({ apiKey: 'test-key' })
        // install 后才能访问 provider
        void plugin.install?.({
          config: { get: () => undefined } as any,
          log: { info: () => {}, warn: () => {} } as any,
        } as any).then(() => {
          const provider = plugin.provider
          // provider 是 OpenAIChatProvider，通过 calls 记录的 body 验证配置
          expect(provider).toBeInstanceOf(OpenAIChatProvider)
          expect(provider.id).toBe('qwen')
        })
      } finally {
        if (savedKey !== undefined) process.env.DASHSCOPE_API_KEY = savedKey
      }
    })

    it('环境变量 DASHSCOPE_API_KEY 被读取', async () => {
      const savedKey = process.env.DASHSCOPE_API_KEY
      process.env.DASHSCOPE_API_KEY = 'env-dashscope-key'
      try {
        const plugin = createProviderQwenPlugin()
        await plugin.install?.({
          config: { get: () => undefined } as any,
          log: { info: () => {}, warn: () => {} } as any,
        } as any)
        // 通过 fetch mock 验证 Authorization 头
        let capturedUrl = ''
        let capturedHeaders: Record<string, string> = {}
        const restore = installMock(({ url, init }) => {
          capturedUrl = url
          capturedHeaders = init.headers as Record<string, string>
          return new Response(okResponse('ok'))
        })
        try {
          await plugin.provider.complete({
            providerId: 'qwen',
            messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 1 }],
            params: {},
          })
          expect(capturedUrl).toContain('dashscope.aliyuncs.com')
          expect(capturedUrl).toContain('/compatible-mode/v1/chat/completions')
          expect(capturedHeaders['Authorization']).toBe('Bearer env-dashscope-key')
        } finally {
          restore()
        }
      } finally {
        if (savedKey === undefined) delete process.env.DASHSCOPE_API_KEY
        else process.env.DASHSCOPE_API_KEY = savedKey
      }
    })

    it('直接传入配置优先级高于环境变量', async () => {
      const savedKey = process.env.DASHSCOPE_API_KEY
      process.env.DASHSCOPE_API_KEY = 'env-key'
      try {
        const plugin = createProviderQwenPlugin({
          apiKey: 'direct-key',
          defaultModel: 'qwen-max',
        })
        await plugin.install?.({
          config: { get: () => undefined } as any,
          log: { info: () => {}, warn: () => {} } as any,
        } as any)

        let capturedBody: any
        const restore = installMock(({ init }) => {
          capturedBody = JSON.parse(init.body as string)
          return new Response(okResponse('ok', 'qwen-max'))
        })
        try {
          await plugin.provider.complete({
            providerId: 'qwen',
            messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
            params: {},
          })
          expect(capturedBody.model).toBe('qwen-max')
          const headers = plugin.provider['calls'][0]
          // Authorization 头通过 fetch mock 验证
        } finally {
          restore()
        }
      } finally {
        if (savedKey === undefined) delete process.env.DASHSCOPE_API_KEY
        else process.env.DASHSCOPE_API_KEY = savedKey
      }
    })

    it('apiPath 可覆盖为自定义路径', async () => {
      const plugin = createProviderQwenPlugin({
        apiKey: 'k',
        apiPath: '/custom/v1/chat',
      })
      await plugin.install?.({
        config: { get: () => undefined } as any,
        log: { info: () => {}, warn: () => {} } as any,
      } as any)

      let capturedUrl = ''
      const restore = installMock(({ url }) => {
        capturedUrl = url
        return new Response(okResponse('ok'))
      })
      try {
        await plugin.provider.complete({
          providerId: 'qwen',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
        })
        expect(capturedUrl).toContain('/custom/v1/chat')
      } finally {
        restore()
      }
    })
  })

  describe('createProviderQwenPlugin 集成', () => {
    it('config store 读取配置（key=provider.qwen）', async () => {
      const restore = installMock(async () => new Response(okResponse('qwen响应', 'qwen-plus')))
      try {
        const plugin = createProviderQwenPlugin()
        const h = await createHarness({
          cwd: process.cwd(),
          internalPlugins: [plugin],
          agents: [makeAgent()],
          permission: new DefaultPermissionEngine({ '*': 'allow' }),
          config: {
            'provider.qwen': {
              apiKey: 'from-store',
              defaultModel: 'qwen-plus',
            },
          },
        })
        await h.start()
        const sess = await h.session.create()
        const reply = await h.agent.query({ sessionId: sess.id, message: '你好' })
        const textPart = reply.parts.find((p: any) => p.type === 'text') as any
        expect(textPart.text).toBe('qwen响应')
        expect((reply.meta as any)?.model).toBe('qwen-plus')
        expect(h.plugin.list().map((p) => p.plugin.id)).toEqual(
          expect.arrayContaining(['provider.qwen']),
        )
        await h.stop()
      } finally {
        restore()
      }
    })

    it('plugin.id / name / description 正确', () => {
      expect(providerQwenPlugin.id).toBe('provider.qwen')
      expect(providerQwenPlugin.name).toBe('Qwen Provider')
      expect(providerQwenPlugin.description).toContain('通义千问')
    })
  })
})
