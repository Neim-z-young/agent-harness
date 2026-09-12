import { test, expect } from 'bun:test'
import {
  createCore,
  createInitialState,
  defaultConfig,
  refForRaw,
  type Config,
  type CompressionState,
} from 'acp-kernel'
import type { Message } from '@harness/session'
import { runPreModel } from './index'
import { toCores, compactHistory, idBase } from './adapter'

// ===== helpers =====

function msg(role: Message['role'], text: string, i: number): Message {
  return { id: `m${i}`, role, parts: [{ type: 'text', text }], createdAt: i }
}

function history(n: number): Message[] {
  const arr: Message[] = []
  for (let i = 0; i < n; i++) {
    arr.push(msg(i % 2 === 0 ? 'user' : 'assistant', `Message number ${i} with enough padding text to estimate tokens.`, i))
  }
  return arr
}

function makeConfig(): Config {
  return defaultConfig(20000, {
    compress: { minCompressRange: 0, maxSummaryLength: 100000, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    promotionThreshold: 1,
    nudge: {
      maxContextLimitPct: 0.2,
      minContextLimitPct: 0.05,
      frequency: 1,
      iterationThreshold: 1,
      force: 'soft',
      growthRatio: 0.1,
      growthFloor: 1,
      growthCap: 5000,
      minGrowthFloor: 1,
      minGrowthRatio: 0,
      emergencyThresholdPct: 0.95,
      tier2GrowthMultiplier: 1,
    },
  })
}

function tempMessage(role: Message['role'], text: string, _sid: string): Message {
  return { id: `acp_${role}_${Date.now()}_tmp`, role, parts: [{ type: 'text', text }], createdAt: Date.now() }
}

interface Harness {
  ctx: { state: CompressionState; lastCores: ReturnType<typeof toCores>['cores']; systemInjected: boolean }
  saved: Message[] | null
  run: (messages: Message[]) => Promise<void>
}

function makeHarness(config: Config = makeConfig(), sessionId = 's1'): Harness {
  const engine = createCore()
  const ctx = { state: createInitialState(), lastCores: [] as ReturnType<typeof toCores>['cores'], systemInjected: false }
  const h: Harness = { ctx, saved: null, run: async () => {} }
  h.run = async (messages: Message[]) => {
    await runPreModel({
      sessionId,
      messages,
      getCtx: () => ctx,
      engine,
      config,
      save: async (ms: unknown[]) => {
        h.saved = ms as Message[]
      },
      makeSystemPrompt: () => '<acp system>',
      tempMessage,
    })
  }
  return h
}

// ===== adapter =====

test('toCores：文本消息压平成一个 text core，idBase 可还原 base', () => {
  const flat = toCores([msg('user', 'hello', 0)])
  expect(flat.cores).toHaveLength(1)
  expect(flat.cores[0]!.contentType).toBe('text')
  expect(idBase(flat.cores[0]!.id)).toBe('m0')
})

test('toCores：工具调用 + 文本拆分为多个 core', () => {
  const withTool: Message = {
    id: 'm1',
    role: 'assistant',
    createdAt: 1,
    parts: [
      { type: 'text', text: 'I will look' },
      { type: 'tool', toolUseId: 'tu1', toolId: 'read_file', input: { path: 'a' } },
    ],
  }
  const flat = toCores([withTool])
  // 1 个 tool-call core + 1 个 text core
  expect(flat.cores).toHaveLength(2)
  const toolCore = flat.cores.find((c) => c.contentType === 'tool-call')
  expect(toolCore?.toolName).toBe('read_file')
})

test('compactHistory：core 未变化时不触发保存（原样复用）', () => {
  const msgs = history(4)
  const flat = toCores(msgs)
  const out = compactHistory(flat, flat.cores)
  expect(out.changed).toBe(false)
  expect(out.messages).toHaveLength(4)
  // 对象身份复用
  expect(out.messages[0]).toBe(msgs[0])
})

test('compactHistory：kernel 生成的摘要块会触发 changed 并补入新消息', () => {
  const msgs = history(3)
  const flat = toCores(msgs)
  const summaryCore = { id: 'b1#99', role: 'assistant' as const, contentType: 'text' as const, text: '<acp block>SUM' }
  const out = compactHistory(flat, [flat.cores[0]!, summaryCore])
  expect(out.changed).toBe(true)
  expect(out.messages).toHaveLength(2)
  expect(out.messages.some((m) => m.parts[0]!.type === 'text' && (m.parts[0] as any).text.includes('SUM'))).toBe(true)
})

// ===== runPreModel 每轮流程 =====

test('runPreModel：普通轮不触发保存，请求含 ACP 哲学 + 完整历史', async () => {
  const h = makeHarness()
  const messages = history(4)
  await h.run(messages)
  // 原地替换：acp system + 4 条历史
  expect(h.saved).toBeNull()
  expect(messages.length).toBe(5)
  expect(messages[0]!.role).toBe('system')
  expect(messages[1]!.role).toBe('user')
})

test('runPreModel：ACP 哲学 system 每轮注入一次', async () => {
  const h = makeHarness()
  let messages = history(2)
  await h.run(messages)
  expect(messages.filter((m) => m.role === 'system')).toHaveLength(1)
  expect((messages[0]!.parts[0] as any).text).toBe('<acp system>')
  // 二次轮仍注入恰好一条 system
  messages = history(2)
  await h.run(messages)
  expect(messages.filter((m) => m.role === 'system')).toHaveLength(1)
})

test('runPreModel：模型 compress 应用后，下一轮回写精简历史（save 触发、消息变少）', async () => {
  const h = makeHarness()
  const messages = history(12)
  const engine = createCore()

  // 第一轮：建立会话上下文并指派 refs
  await h.run([...messages])

  // 构造一个跨越中间消息的压缩块（模拟模型 compress 调用）
  const refs = h.ctx.state.messageRefs
  const cores = h.ctx.lastCores
  const startRef = refForRaw(refs, cores[1]!.id)
  const endRef = refForRaw(refs, cores[4]!.id)
  expect(startRef).toBeTruthy()
  expect(endRef).toBeTruthy()
  const applied = engine.applyCompression({
    ranges: [{ startRef: startRef!, endRef: endRef!, summary: '压缩摘要：中间内容', topic: '中间讨论' }],
    messages: cores,
    state: h.ctx.state,
    config: makeConfig(),
  })
  expect(applied.result.blocksCreated).toBeGreaterThan(0)
  h.ctx.state = applied.state

  // 第二轮：processTurn 应剪掉被压缩的范围并对会话做精简
  await h.run(messages)
  expect(h.saved).not.toBeNull()
  expect(h.saved!.length).toBeLessThan(12)
  // 精简后的历史里应包含摘要文字
  const allText = h.saved!.map((m) => m.parts.map((p) => (p as any).text ?? '').join('')).join('\n')
  expect(allText).toContain('压缩摘要')
})