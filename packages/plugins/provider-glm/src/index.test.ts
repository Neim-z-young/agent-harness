import { describe, it, expect } from 'bun:test'
import {
  createProviderGlmPlugin,
  providerGlmPlugin,
  type GlmProviderConfig,
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

function okResponse(content: string, model = 'glm-4-flash'): string {
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

describe('@harness/provider-glm', () => {
  describe('配置默认值', () => {
    it('默认 baseUrl / apiPath / providerId 正确', async () => {
      const savedKey = process.env.ZHIPU_API_KEY
      delete process.env.ZHIPU_API_KEY
      try {
        const plugin = createProviderGlmPlugin({ apiKey: 'test-key' })
        await plugin.install?.({
          config: { get: () => undefined } as any,
          log: { info: () => {}, warn: () => {} } as any,
        } as any)
        const provider = plugin.provider
        expect(provider).toBeInstanceOf(OpenAIChatProvider)
        expect(provider.id).toBe('glm')
      } finally {
        if (savedKey !== undefined) process.env.ZHIPU_API_KEY = savedKey
      }
    })

    it('环境变量 ZHIPU_API_KEY 被读取', async () => {
      const savedKey = process.env.ZHIPU_API_KEY
      process.env.ZHIPU_API_KEY = 'env-zhipu-key'
      try {
        const plugin = createProviderGlmPlugin()
        await plugin.install?.({
          config: { get: () => undefined } as any,
          log: { info: () => {}, warn: () => {} } as any,
        } as any)

        let capturedUrl = ''
        let capturedHeaders: Record<string, string> = {}
        const restore = installMock(({ url, init }) => {
          capturedUrl = url
          capturedHeaders = init.headers as Record<string, string>
          return new Response(okResponse('ok'))
        })
        try {
          await plugin.provider.complete({
            providerId: 'glm',
            messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 1 }],
            params: {},
          })
          expect(capturedUrl).toContain('open.bigmodel.cn')
          expect(capturedUrl).toContain('/api/paas/v4/chat/completions')
          expect(capturedHeaders['Authorization']).toBe('Bearer env-zhipu-key')
        } finally {
          restore()
        }
      } finally {
        if (savedKey === undefined) delete process.env.ZHIPU_API_KEY
        else process.env.ZHIPU_API_KEY = savedKey
      }
    })

    it('直接传入配置优先级高于环境变量', async () => {
      const savedKey = process.env.ZHIPU_API_KEY
      process.env.ZHIPU_API_KEY = 'env-key'
      try {
        const plugin = createProviderGlmPlugin({
          apiKey: 'direct-key',
          defaultModel: 'glm-4',
        })
        await plugin.install?.({
          config: { get: () => undefined } as any,
          log: { info: () => {}, warn: () => {} } as any,
        } as any)

        let capturedBody: any
        const restore = installMock(({ init }) => {
          capturedBody = JSON.parse(init.body as string)
          return new Response(okResponse('ok', 'glm-4'))
        })
        try {
          await plugin.provider.complete({
            providerId: 'glm',
            messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
            params: {},
          })
          expect(capturedBody.model).toBe('glm-4')
        } finally {
          restore()
        }
      } finally {
        if (savedKey === undefined) delete process.env.ZHIPU_API_KEY
        else process.env.ZHIPU_API_KEY = savedKey
      }
    })

    it('apiPath 可覆盖为自定义路径', async () => {
      const plugin = createProviderGlmPlugin({
        apiKey: 'k',
        apiPath: '/custom/v4/chat',
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
          providerId: 'glm',
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: 1 }],
          params: {},
        })
        expect(capturedUrl).toContain('/custom/v4/chat')
      } finally {
        restore()
      }
    })
  })

  describe('createProviderGlmPlugin 集成', () => {
    it('config store 读取配置（key=provider.glm）', async () => {
      const restore = installMock(async () => new Response(okResponse('glm响应', 'glm-4-flash')))
      try {
        const plugin = createProviderGlmPlugin()
        const h = await createHarness({
          cwd: process.cwd(),
          internalPlugins: [plugin],
          agents: [makeAgent()],
          permission: new DefaultPermissionEngine({ '*': 'allow' }),
          config: {
            'provider.glm': {
              apiKey: 'from-store',
              defaultModel: 'glm-4-flash',
            },
          },
        })
        await h.start()
        const sess = await h.session.create()
        const reply = await h.agent.query({ sessionId: sess.id, message: '你好' })
        const textPart = reply.parts.find((p: any) => p.type === 'text') as any
        expect(textPart.text).toBe('glm响应')
        expect((reply.meta as any)?.model).toBe('glm-4-flash')
        expect(h.plugin.list().map((p) => p.plugin.id)).toEqual(
          expect.arrayContaining(['provider.glm']),
        )
        await h.stop()
      } finally {
        restore()
      }
    })

    it('plugin.id / name / description 正确', () => {
      expect(providerGlmPlugin.id).toBe('provider.glm')
      expect(providerGlmPlugin.name).toBe('GLM Provider')
      expect(providerGlmPlugin.description).toContain('智谱')
    })
  })
})
