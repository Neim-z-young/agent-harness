/**
 * @harness/core bench helpers —— 可复用的压缩块性能压测辅助
 *
 * 供 packages/core/bench/*.ts 复用。构造低成本 mock 环境，便于手动压测
 * core.session.compacting / setBlocks / blocksPatch 等热点路径。
 *
 * 后续切换到真实模型：createHarness 传入真实 ChatProvider（或加载 provider
 * 插件），复用其余装配逻辑即可，本次以 mock ChatProvider + 合成数据为准。
 */

import type { AgentDefinition, ChatCompletionOutput, ChatProvider, Harness, Message } from '../src/index'
import { createHarness } from '../src/index'

/** 最小可跑通的 AgentDefinition */
export function makeAgent(): AgentDefinition {
  return {
    id: 'default',
    name: 'bench-agent',
    description: '性能压测用',
    mode: 'primary',
    tools: [],
    permission: { '*': 'allow' },
    promptFragments: ['You are a fast test assistant.'],
  }
}

/** 低开销 mock ChatProvider：每次 complete 直接返回一条短文本，不依赖网络 */
export function createMockProvider(
  behavior: 'text' = 'text',
  overrides: Record<string, unknown> = {},
): ChatProvider & { calls: number } {
  const provider: ChatProvider & { calls: number } = {
    id: 'bench-mock',
    calls: 0,
    async complete(): Promise<ChatCompletionOutput> {
      provider.calls++
      const out: ChatCompletionOutput = {
        content: behavior === 'text' ? 'ok' : '',
        model: 'bench-v1',
        tokenUsage: { input: 1, output: 1 },
      }
      return { ...out, ...(overrides as any) }
    },
  }
  return provider
}

/** 生成 n 条 user/assistant 交替的短消息（低 token 估算成本，纯粹填充长度用） */
export function makeMessages(n: number, prefix = 'm'): Message[] {
  const arr: Message[] = []
  for (let i = 0; i < n; i++) {
    arr.push({
      id: `${prefix}${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: `Message ${prefix}${i} with a short body to keep encoding cheap.` }],
      createdAt: i,
    })
  }
  return arr
}

/** 生成 n 个压缩块（统一块模型源数据），id 稳定可被 setBlocks 幂等覆盖 */
export function makeBlocks(n: number, opts: { source?: 'generic' | 'acp'; prefix?: string } = {}): import('../src/index').Session['blocks'] {
  const list: import('../src/index').Session['blocks'] = []
  for (let i = 0; i < n; i++) {
    list.push({
      id: `${opts.prefix ?? 'blk'}_${i}`,
      topic: '压测块',
      summary: `summary ${i}`,
      startId: `m${i}`,
      endId: `m${i}`,
      source: opts.source ?? 'generic',
    })
  }
  return list
}

/** 高精度计时：执行 fn 并返回 ms（含重试/预热 external），兼容 performance 被 mock */
export async function timeMs(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now()
  await fn()
  return performance.now() - t0
}

/** 默认装配一个 Harness：创建会话 + 塞入 batch 条消息，返回会话 id */
export async function makeSession(
  h: Harness,
  seedMessages: number,
): Promise<string> {
  const sid = await createSessionId(h)
  const seed = makeMessages(seedMessages)
  for (const m of seed) await h.session.addMessage(sid, m)
  return sid
}

/** h.session.create() 返回会话对象，取 .id 得到会话 id */
export async function createSessionId(h: Harness): Promise<string> {
  const created = await h.session.create()
  return created.id
}