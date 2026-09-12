import { test, expect } from 'bun:test'
import {
  createCore,
  createInitialState,
  defaultConfig,
  refForRaw,
  activeBlocks,
  type Config,
  type CompressionState,
} from 'acp-kernel'
import type { Message } from '@harness/session'
import { runPreModel, restoreBlockMessages, ACP_META_KEY } from './index'
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
      minContextLimitPct: 0.02,
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
  engine: ReturnType<typeof createCore>
  ctx: { state: CompressionState; archive: Map<string, Message>; lastCores: ReturnType<typeof toCores>['cores']; hydrated: boolean; stateSnapshot: string }
  meta: Record<string, unknown>
  patches: Array<Record<string, unknown>>
  metaOf: () => unknown
  run: (messages: Message[]) => Promise<void>
}

function makeHarness(config: Config = makeConfig(), sessionId = 's1'): Harness {
  const engine = createCore()
  const meta: Record<string, unknown> = {}
  const patches: Array<Record<string, unknown>> = []
  const ctx = {
    state: createInitialState(),
    archive: new Map<string, Message>(),
    lastCores: [] as ReturnType<typeof toCores>['cores'],
    hydrated: false,
    stateSnapshot: '',
  }
  const h: Harness = {
    engine,
    ctx,
    meta,
    patches,
    metaOf: () => meta[ACP_META_KEY],
    run: async () => {},
  }
  h.run = async (messages: Message[]) => {
    await runPreModel({
      sessionId,
      messages,
      getCtx: () => ctx,
      engine,
      config,
      meta: {
        read: async () => meta,
        patch: async (p) => {
          Object.assign(meta, p)
          patches.push(p)
        },
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
  expect(flat.cores).toHaveLength(2)
  const toolCore = flat.cores.find((c) => c.contentType === 'tool-call')
  expect(toolCore?.toolName).toBe('read_file')
})

test('compactHistory：core 未变化时复用原始对象、不触发 changed', () => {
  const msgs = history(4)
  const flat = toCores(msgs)
  const out = compactHistory(flat, flat.cores)
  expect(out.changed).toBe(false)
  expect(out.messages).toHaveLength(4)
  expect(out.messages[0]).toBe(msgs[0])
})

test('compactHistory：kernel 生成的摘要块触发 changed 并补入新消息', () => {
  const msgs = history(3)
  const flat = toCores(msgs)
  const summaryCore = { id: 'b1#99', role: 'assistant' as const, contentType: 'text' as const, text: '<acp block>SUM' }
  const out = compactHistory(flat, [flat.cores[0]!, summaryCore])
  expect(out.changed).toBe(true)
  expect(out.messages).toHaveLength(2)
  expect(out.messages.some((m) => (m.parts[0] as any).text.includes('SUM'))).toBe(true)
})

// ===== runPreModel 每轮流程 =====

test('runPreModel：普通轮压缩状态持久化到 meta，请求含 ACP 哲学 + 完整历史', async () => {
  const h = makeHarness()
  const messages = history(4)
  await h.run(messages)
  expect(messages.length).toBe(5) // acp system + 4 历史
  expect(messages[0]!.role).toBe('system')
  expect(messages[1]!.role).toBe('user')
  // 状态已持久化（首轮指派 refs / 初始化即产生差异）
  expect(h.metaOf()).toBeDefined()
})

test('runPreModel：ACP 哲学 system 每轮注入一次', async () => {
  const h = makeHarness()
  let messages = history(2)
  await h.run(messages)
  expect(messages.filter((m) => m.role === 'system')).toHaveLength(1)
  expect((messages[0]!.parts[0] as any).text).toBe('<acp system>')
  messages = history(2)
  await h.run(messages)
  expect(messages.filter((m) => m.role === 'system')).toHaveLength(1)
})

test('runPreModel：压缩后状态持久化、请求被精简，且可还原原始消息全文', async () => {
  const h = makeHarness()
  const messages = history(12)
  const config = makeConfig()

  // 第一轮：建立会话上下文并指派 refs
  await h.run([...messages])

  // 构造一个跨越中间消息的压缩块（模拟模型 compress 调用）
  const refs = h.ctx.state.messageRefs
  const cores = h.ctx.lastCores
  const startRef = refForRaw(refs, cores[1]!.id)
  const endRef = refForRaw(refs, cores[4]!.id)
  expect(startRef).toBeTruthy()
  expect(endRef).toBeTruthy()
  const applied = h.engine.applyCompression({
    ranges: [{ startRef: startRef!, endRef: endRef!, summary: '压缩摘要：中间内容', topic: '中间讨论' }],
    messages: cores,
    state: h.ctx.state,
    config,
  })
  expect(applied.result.blocksCreated).toBeGreaterThan(0)
  h.ctx.state = applied.state

  // 第二轮：processTurn 剪掉被压缩范围 → 请求精简 + 状态持久化到 meta
  await h.run(messages)
  const reqText = messages.map((m) => m.parts.map((p) => (p as any).text ?? '').join('')).join('\n')
  expect(reqText).not.toContain('Message number 3') // 中间内容被压缩出请求
  expect(h.metaOf()).toBeDefined() // 压缩状态已持久化

  // 反解被压缩的原始消息：decompress full 能还原全文
  const block = h.ctx.state.blocks.find((b) => b.topic === '中间讨论')
  expect(block).toBeDefined()
  const restored = restoreBlockMessages(h.engine, h.ctx.state, h.ctx.archive, block!.blockId)
  expect(restored.length).toBeGreaterThan(0)
  expect(restored.some((r) => r.text.includes('Message number 3'))).toBe(true)
})

test('runPreModel：重启后从 meta 水合压缩状态，块仍可定位', async () => {
  const h = makeHarness()
  const messages = history(12)
  const config = makeConfig()
  await h.run([...messages])

  const refs = h.ctx.state.messageRefs
  const cores = h.ctx.lastCores
  const applied2 = h.engine.applyCompression({
    ranges: [
      { startRef: refForRaw(refs, cores[1]!.id)!, endRef: refForRaw(refs, cores[4]!.id)!, summary: '压缩摘要', topic: '重启块' },
    ],
    messages: cores,
    state: h.ctx.state,
    config,
  })
  h.ctx.state = applied2.state
  // 再跑一轮，让 block 状态真正持久化到 meta
  await h.run([...messages])
  // 模拟重启：丢弃内存 ctx，仅保留已持久化的 meta
  const persisted = JSON.parse(JSON.stringify(h.metaOf() as CompressionState))
  const freshHarness = makeHarness(config, 's1')
  // 预置 meta 为持久化内容
  freshHarness.meta[ACP_META_KEY] = persisted
  await freshHarness.run([...messages])
  expect(activeBlocks(freshHarness.ctx.state).length).toBeGreaterThan(0)
  const block = freshHarness.ctx.state.blocks.find((b) => b.topic === '重启块')
  expect(block).toBeDefined()
})