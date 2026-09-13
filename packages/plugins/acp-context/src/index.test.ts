import { test, expect } from 'bun:test'
import {
  createCore,
  createInitialState,
  defaultConfig,
  refForRaw,
  activeBlocks,
  type Config,
  type CompressionState,
  type CompressionBlock,
} from 'acp-kernel'
import type { Message } from '@harness/session'
import type { CompactionContext } from '@harness/plugin'
import {
  runPreModel,
  runCompacting,
  restoreBlockMessages,
  collectCoveredIds,
  blockSpan,
  coveredSpan,
  ACP_META_KEY,
  ACP_ARCHIVE_KEY,
} from './index'
import { toCores, compactHistory, idBase, baseId } from './adapter'

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
  ctx: {
    state: CompressionState
    archive: Map<string, Message>
    lastCores: ReturnType<typeof toCores>['cores']
    hydrated: boolean
    archivedKeys: Set<string>
    stateSnapshot: string
    prefixIds: string[]
    prefixRender: Message[]
    needFull: boolean
    lastTokens: number
  }
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
    archivedKeys: new Set<string>(),
    stateSnapshot: '',
    prefixIds: [] as string[],
    prefixRender: [] as Message[],
    needFull: true,
    lastTokens: 0,
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

// ===== 增量渲染缓存 =====

test('runPreModel：增量路径缓存命中，命中后 needFull 复位、prefixIds 更新为全量', async () => {
  const h = makeHarness()

  // 首轮（需全量）
  await h.run(history(4))
  expect(h.ctx.needFull).toBe(false) // 首轮全量重建后 needFull 复位
  expect(h.ctx.prefixIds).toHaveLength(4)
  expect(h.ctx.prefixRender).toHaveLength(4)

  // 第二轮：完整保留历史 + 追加 2 条 → 前缀一致，命中增量路径
  h.ctx.needFull = false
  const lenBefore = h.ctx.prefixRender.length
  const second = [...history(4), ...history(2)]
  await h.run(second)
  // 增量命中：prefixRender 即为请求中的历史渲染；结果含 6 + acp system
  expect(second.filter((m) => m.role === 'system')).toHaveLength(1)
  expect(second.length).toBe(7)
  expect(h.ctx.prefixIds).toHaveLength(6)
  expect(h.ctx.prefixRender.length).toBeGreaterThan(lenBefore) // 缓存追加了新增尾部渲染
})

test('runPreModel：压缩后置 needFull，下一轮全量重建并刷新缓存', async () => {
  const h = makeHarness()
  const config = makeConfig()
  const messages = history(12)
  await h.run([...messages])

  // 模拟 compress 调用置 needFull
  const refs = h.ctx.state.messageRefs
  const cores = h.ctx.lastCores
  const applied = h.engine.applyCompression({
    ranges: [
      { startRef: refForRaw(refs, cores[1]!.id)!, endRef: refForRaw(refs, cores[4]!.id)!, summary: '压缩摘要', topic: '压缩块' },
    ],
    messages: cores,
    state: h.ctx.state,
    config,
  })
  h.ctx.state = applied.state
  h.ctx.needFull = true

  const before = [...messages]
  await h.run(before)
  // 全量路径已重建缓存：needFull 复位、请求被压缩精简
  const reqText = before.map((m) => m.parts.map((p) => (p as any).text ?? '').join('')).join('\n')
  expect(reqText).not.toContain('Message number 3')
  expect(h.ctx.needFull).toBe(false)
  // 压缩轮历史含 12 条原始消息（可裁剪来自本轮全量重建）
  expect(h.ctx.prefixIds.length).toBe(12)
})

test('runPreModel：历史前缀漂移（中间插入/删除）时回落全量路径', async () => {
  const h = makeHarness()
  await h.run(history(4))
  h.ctx.needFull = false

  // 历史被改写：移除 m0（前缀 m1... 长度 3 与缓存 4 不一致）→ 命中条件不成立 → 全量重建
  const drifted = history(4).slice(1)
  const driftedCopy = [...drifted]
  await h.run(drifted)
  expect(h.ctx.needFull).toBe(false)
  // 全量重建后缓存以"完整待发历史"为准
  expect(h.ctx.prefixIds.length).toBe(driftedCopy.length)
  expect(drifted.filter((m) => m.role === 'system')).toHaveLength(1)
  expect(drifted.length).toBe(drifted.filter((m) => m.role !== 'system').length + 1)
})

test('adapter：baseId 导出可复用（核心链路依赖）', () => {
  // 直接校验 baseId 稳定、可消毒非法字符
  expect(baseId('m0')).toBe('m0')
  expect(baseId('a b!c')).toBe('a_b_c')
})

// ===== session.compacting 协同（方案三：先保全原文再物理删除） =====

function compactCtxFor(window: Message[]): CompactionContext {
  return {
    window,
    keepLast: 10,
    strategy: 'summary',
    windowHandled: false,
    summary: undefined,
    blocksPatch: undefined,
  }
}

test('runCompacting：session 压缩前把 window 折叠进 ACP 块，并豁免 core 自行摘要', async () => {
  const engine = createCore()
  const config = makeConfig()
  const meta: Record<string, unknown> = {}
  const patches: Array<Record<string, unknown>> = []
  const ctx = {
    state: createInitialState(),
    archive: new Map<string, Message>(),
    lastCores: [] as ReturnType<typeof toCores>['cores'],
    hydrated: false,
    archivedKeys: new Set<string>(),
    stateSnapshot: '',
    prefixIds: [] as string[],
    prefixRender: [] as Message[],
    needFull: true,
    lastTokens: 0,
  }

  const window = history(8)
  const input = compactCtxFor(window)
  const handled = await runCompacting({
    sessionId: 's1',
    input,
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
  })

  expect(handled).toBe(true)
  // 折叠出至少一个块
  expect(activeBlocks(ctx.state).length).toBeGreaterThan(0)
  // 已处理：windowHandled 置位，且提供了 summary 供 core 复用（避免双份摘要）
  expect(input.windowHandled).toBe(true)
  expect(input.summary).toBeTruthy()
  // 统一块模型：回传 source:'acp' 折叠块（供 core 追加到 session.blocks）
  expect(input.blocksPatch?.length).toBe(1)
  const patch = input.blocksPatch![0]
  expect(patch.source).toBe('acp')
  expect(patch.summary).toBeTruthy()
  expect(patch.startId).toBe(window[0].id)
  expect(patch.endId).toBe(window[window.length - 1].id)
  expect(patch.archiveRef).toMatch(/^acp:s1:/)
  // 状态持久化到 meta
  expect(meta[ACP_META_KEY]).toBeDefined()
})

test('runCompacting：幂等——已覆盖的窗口二次处理不重复折叠', async () => {
  const engine = createCore()
  const config = makeConfig()
  const meta: Record<string, unknown> = {}
  const ctx = {
    state: createInitialState(),
    archive: new Map<string, Message>(),
    lastCores: [] as ReturnType<typeof toCores>['cores'],
    hydrated: true,
    archivedKeys: new Set<string>(),
    stateSnapshot: '',
    prefixIds: [] as string[],
    prefixRender: [] as Message[],
    needFull: true,
    lastTokens: 0,
  }

  const window = history(6)
  // 第一次折叠
  await runCompacting({
    sessionId: 's1',
    input: compactCtxFor(window),
    getCtx: () => ctx,
    engine,
    config,
    meta: { read: async () => meta, patch: async (p) => { Object.assign(meta, p) } },
  })
  const blocksAfterFirst = ctx.state.blocks.length

  // 第二次：整个窗口已覆盖 → 幂等，不新增块，仅标记 handled
  const input2 = compactCtxFor(window)
  const handled2 = await runCompacting({
    sessionId: 's1',
    input: input2,
    getCtx: () => ctx,
    engine,
    config,
    meta: { read: async () => meta, patch: async (p) => { Object.assign(meta, p) } },
  })
  expect(handled2).toBe(false)
  expect(input2.windowHandled).toBe(true)
  expect(ctx.state.blocks.length).toBe(blocksAfterFirst)
})

test('runCompacting：折叠后 decompress 仍能还原窗口原文全文', async () => {
  const engine = createCore()
  const config = makeConfig()
  const meta: Record<string, unknown> = {}
  const ctx = {
    state: createInitialState(),
    archive: new Map<string, Message>(),
    lastCores: [] as ReturnType<typeof toCores>['cores'],
    hydrated: false,
    archivedKeys: new Set<string>(),
    stateSnapshot: '',
    prefixIds: [] as string[],
    prefixRender: [] as Message[],
    needFull: true,
    lastTokens: 0,
  }

  const window = history(10)
  const input = compactCtxFor(window)
  await runCompacting({
    sessionId: 's1',
    input,
    getCtx: () => ctx,
    engine,
    config,
    meta: { read: async () => meta, patch: async (p) => { Object.assign(meta, p) } },
  })

  const block = ctx.state.blocks.find((b) => b.topic === 'session 压缩折叠')
  expect(block).toBeDefined()
  const restored = restoreBlockMessages(engine, ctx.state, ctx.archive, block!.blockId)
  // 折叠后窗口原文仍可从归档还原（物理删除后 decompress 依旧有效）
  expect(restored.length).toBeGreaterThan(0)
})

test('runCompacting：折叠窗口原文持久化到 meta，跨重启后新 ctx 仍可还原全文', async () => {
  const engine = createCore()
  const config = makeConfig()
  const meta: Record<string, unknown> = {}
  const ctx = {
    state: createInitialState(),
    archive: new Map<string, Message>(),
    lastCores: [] as ReturnType<typeof toCores>['cores'],
    hydrated: false,
    archivedKeys: new Set<string>(),
    stateSnapshot: '',
    prefixIds: [] as string[],
    prefixRender: [] as Message[],
    needFull: true,
    lastTokens: 0,
  }
  const patch = async (p: Record<string, unknown>) => Object.assign(meta, p as any)

  const window = history(10)
  await runCompacting({
    sessionId: 's1',
    input: compactCtxFor(window),
    getCtx: () => ctx,
    engine,
    config,
    meta: { read: async () => meta, patch },
  })

  // 折叠后 meta 持久化了状态 + 原文归档
  expect(meta[ACP_META_KEY]).toBeDefined()
  expect(meta[ACP_ARCHIVE_KEY]).toBeDefined()

  // 模拟重启：全新 ctx（空 memory），仅从 meta 水合
  const fresh = {
    state: createInitialState(),
    archive: new Map<string, Message>(),
    lastCores: [] as ReturnType<typeof toCores>['cores'],
    hydrated: false,
    archivedKeys: new Set<string>(),
    stateSnapshot: '',
    prefixIds: [] as string[],
    prefixRender: [] as Message[],
    needFull: true,
    lastTokens: 0,
  }
  await runCompacting({
    sessionId: 's1',
    input: compactCtxFor(window), // 仍是同一窗口：水合后判定已被覆盖 → 幂等跳过，不重复折叠
    getCtx: () => fresh,
    engine,
    config,
    meta: { read: async () => meta, patch },
  })

  // 水合后归档被恢复，解压仍能还原窗口全文
  const block = fresh.state.blocks.find((b) => b.topic === 'session 压缩折叠')
  expect(block).toBeDefined()
  const restored = restoreBlockMessages(engine, fresh.state, fresh.archive, block!.blockId)
  expect(restored.length).toBeGreaterThan(0)
  expect(fresh.archive.size).toBeGreaterThan(0)
})

// ===== 遗留项3：断点索引回读原文容器 =====

/** 构造一个带指定直连子块/消息的压缩块（供 tier 嵌套测试） */
function makeBlock(
  blockId: string,
  opts: Partial<CompressionBlock> = {},
): CompressionBlock {
  return {
    blockId,
    runId: 'r',
    tier: 2,
    summary: `summary:${blockId}`,
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    compressedTokens: 1,
    createdAt: 1,
    survivedCount: 0,
    generation: 'young',
    active: true,
    ...opts,
  }
}

function makeArchive(coreIds: string[], base = 'm'): Map<string, Message> {
  const map = new Map<string, Message>()
  coreIds.forEach((c, i) => map.set(c, msg((i % 2 === 0 ? 'user' : 'assistant') as Message['role'], `orig ${c}`, i)))
  void base
  return map
}

test('collectCoveredIds：tier2/3 嵌套块深度收集全部覆盖消息 id', () => {
  const state = createInitialState()
  const child = makeBlock('cb', {
    tier: 3,
    directMessageIds: ['c1', 'c2'],
    effectiveMessageIds: ['c1', 'c2'],
  })
  const parent = makeBlock('pb', {
    tier: 2,
    directMessageIds: ['c0'],
    effectiveMessageIds: ['c0', 'c1', 'c2'],
    directBlockIds: ['cb'],
  })
  state.blocks = [child, parent]

  const out = new Set<string>()
  collectCoveredIds(state, parent, out)
  expect([...out].sort()).toEqual(['c0', 'c1', 'c2'])

  const childOnly = new Set<string>()
  collectCoveredIds(state, child, childOnly)
  expect([...childOnly].sort()).toEqual(['c1', 'c2'])
})

test('restoreBlockMessages：tier 嵌套块还原完整原文（含更深层子块覆盖消息）', () => {
  const engine = createCore()
  const state = createInitialState()
  const child = makeBlock('cb', {
    tier: 3,
    directMessageIds: ['c1', 'c2'],
    effectiveMessageIds: ['c1', 'c2'],
  })
  const parent = makeBlock('pb', {
    tier: 2,
    directMessageIds: ['c0'],
    effectiveMessageIds: ['c0', 'c1', 'c2'],
    directBlockIds: ['cb'],
  })
  state.blocks = [child, parent]

  const archive = makeArchive(['c0', 'c1', 'c2'])
  const restored = restoreBlockMessages(engine, state, archive, 'pb')
  // 嵌套还原：不仅取回直连 c0，还经 directBlockIds 递归取回 c1、c2 的原文
  expect(restored.map((r) => r.id)).toEqual(['m0', 'm1', 'm2'])
  expect(restored.some((r) => r.text.includes('c1'))).toBe(true)
  expect(restored.some((r) => r.text.includes('c2'))).toBe(true)
})

test('blockSpan：从还原出的原文计算断点索引 startId/endId', () => {
  const span = blockSpan([
    { id: 'm0', role: 'user', text: 'a' },
    { id: 'm1', role: 'assistant', text: 'b' },
  ])
  expect(span).toEqual({ startId: 'm0', endId: 'm1' })
  // 单条消息：endId 为空
  const lone = blockSpan([{ id: 'm0', role: 'user', text: 'a' }])
  expect(lone.startId).toBe('m0')
  expect(lone.endId).toBe('')
})

test('coveredSpan：仅依据状态+归档轻量计算块的断点索引', () => {
  const state = createInitialState()
  const child = makeBlock('cb', {
    tier: 3,
    directMessageIds: ['c1', 'c2'],
    effectiveMessageIds: ['c1', 'c2'],
  })
  const parent = makeBlock('pb', {
    tier: 2,
    directMessageIds: ['c0'],
    effectiveMessageIds: ['c0', 'c1', 'c2'],
    directBlockIds: ['cb'],
  })
  state.blocks = [child, parent]
  const archive = makeArchive(['c0', 'c1', 'c2'])
  expect(coveredSpan(state, archive, parent)).toEqual({ startId: 'm0', endId: 'm2' })
  expect(coveredSpan(state, archive, child)).toEqual({ startId: 'm1', endId: 'm2' })
})

test('runPreModel：压缩块创建后原文持久化到 ACP_ARCHIVE_KEY（断点索引回读容器）', async () => {
  const h = makeHarness()
  const config = makeConfig()
  const messages = history(12)
  // 第一轮：指派 refs，archive 持有全部原文
  await h.run([...messages])

  // 模拟上轮 compress 工具创建一个压缩块（此时块已进入 ctx.state）
  const refs = h.ctx.state.messageRefs
  const cores = h.ctx.lastCores
  const applied = h.engine.applyCompression({
    ranges: [
      { startRef: refForRaw(refs, cores[1]!.id)!, endRef: refForRaw(refs, cores[4]!.id)!, summary: '断点压缩', topic: '断点块' },
    ],
    messages: cores,
    state: h.ctx.state,
    config,
  })
  h.ctx.state = applied.state

  // 第二轮：runPreModel 把该块覆盖的原文合并持久化到 ACP_ARCHIVE_KEY
  expect(h.meta[ACP_ARCHIVE_KEY]).toBeUndefined()
  await h.run([...messages])
  expect(h.meta[ACP_ARCHIVE_KEY]).toBeDefined()

  const block = h.ctx.state.blocks.find((b) => b.topic === '断点块')
  expect(block).toBeDefined()
  // 容器内以 core id 为键存有该块覆盖的原文（回溯定位）
  const archiveObj = h.meta[ACP_ARCHIVE_KEY] as Record<string, unknown>
  expect(Object.keys(archiveObj).length).toBeGreaterThan(0)

  // 跨重启：全新 ctx 从 meta 水合归档后，仍能按块还原全文
  const fresh = makeHarness(config, 's1')
  fresh.meta[ACP_META_KEY] = JSON.parse(JSON.stringify(h.metaOf() as CompressionState))
  fresh.meta[ACP_ARCHIVE_KEY] = archiveObj
  await fresh.run([...messages])
  const restored = restoreBlockMessages(fresh.engine, fresh.ctx.state, fresh.ctx.archive, block!.blockId)
  expect(restored.length).toBeGreaterThan(0)
  expect(restored.some((r) => r.text.includes('Message number 3'))).toBe(true)
})