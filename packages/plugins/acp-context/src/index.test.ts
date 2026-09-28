import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createCore,
  createInitialState,
  defaultConfig,
  refForRaw,
  activeBlocks,
  assignRefs,
  type Config,
  type CompressionState,
  type CompressionBlock,
  type CoreMessage,
} from 'acp-kernel'
import type { Message } from '@harness/session'
import type { CompactionContext, Hooks } from '@harness/plugin'
import {
  runPreModel,
  runCompacting,
  restoreBlockMessages,
  collectCoveredIds,
  blockSpan,
  coveredSpan,
  measureRangeChars,
  createAcpContextPlugin,
  ACP_META_KEY,
  ACP_ARCHIVE_KEY,
  COMPRESS_MANUAL_HINT,
  COMPRESS_TOOL_DOC,
  TOOL_ARGS_REMINDER,
} from './index'
import { toCores, compactHistory, idBase, baseId, estimateTokens, chars4CountTokens } from './adapter'
import { loadPromptFiles } from './prompts'

// ===== helpers =====

test('loadPromptFiles：从插件目录 prompts/*.txt 加载默认提示词', () => {
  const prompts = loadPromptFiles()
  expect(prompts.howToCompressRules).toInclude('HOW TO COMPRESS')
  expect(prompts.tier2DistillRules).toInclude('TIER 2 COMPRESSION')
  expect(prompts.tier3CondenseRules).toInclude('TIER 3 COMPRESSION')
  expect(prompts.compressPhilosophy).toInclude('All compression serves the primary task')
})

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

function makeConfig(modelContextLimit = 20000): Config {
  return defaultConfig(modelContextLimit, {
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
    recordedBlockIds: Set<string>
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

function makeHarness(
  config: Config = makeConfig(),
  sessionId = 's1',
  opts: { manualInjection?: 'on-demand' | 'always'; explicitSystemPrompt?: boolean; dynamicParts?: string[] } = {},
): Harness {
  const engine = createCore()
  const meta: Record<string, unknown> = {}
  const patches: Array<Record<string, unknown>> = []
  const ctx = {
    state: createInitialState(),
    archive: new Map<string, Message>(),
    lastCores: [] as ReturnType<typeof toCores>['cores'],
    hydrated: false,
    archivedKeys: new Set<string>(),
    recordedBlockIds: new Set<string>(),
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
      manualInjection: opts.manualInjection ?? 'always',
      explicitSystemPrompt: opts.explicitSystemPrompt,
      ...(opts.dynamicParts ? { dynamicParts: opts.dynamicParts } : {}),
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

// ===== 提示词可配置（prompts / systemPrompt）=====

/** 安装插件并取回 core.session.preModel hook 处理器，供端到端验证工厂的提示词解析 */
async function preModelFromPlugin(options: Parameters<typeof createAcpContextPlugin>[0]) {
  const plugin = createAcpContextPlugin(options)
  const hooks = (await plugin.install({ log: { info: () => {} } } as any)) as Hooks
  const handler = hooks['core.session.preModel']!
  return (rawMessages: Message[]) =>
    handler(
      {
        sessionId: 's',
        meta: { read: async () => undefined, patch: async () => {} },
        blocksPatch: [],
      } as any,
      rawMessages,
    )
}

test('createAcpContextPlugin：systemPrompt 整段覆盖后，系统提示即该字符串', async () => {
  const preModel = await preModelFromPlugin({ systemPrompt: '<custom system>', modelContextLimit: 20000 })
  const messages = history(3)
  await preModel(messages)
  expect(messages[0]!.role).toBe('system')
  expect((messages[0]!.parts[0] as any).text).toBe('<custom system>')
})

test('createAcpContextPlugin：prompts 覆盖后系统提示应用自定义 t1 规则并保留默认', async () => {
  const preModel = await preModelFromPlugin({
    modelContextLimit: 20000,
    manualInjection: 'always',
    prompts: {
      howToCompressRules: 'CUSTOM_T1_RULES',
      tier2DistillRules: 'CUSTOM_T2_RULES',
      tier3CondenseRules: 'CUSTOM_T3_RULES',
    },
  })
  const messages = history(3)
  await preModel(messages)
  const sysText = (messages[0]!.parts[0] as any).text
  // t1 规则写入压缩系统提示（resolvePrompts 合并默认，未覆盖则静默丢弃）
  expect(sysText).toInclude('CUSTOM_T1_RULES')
  // 未覆盖的默认字段仍保留（没有把默认提示冲掉）
  expect(sysText).toInclude('All compression serves the primary task')
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

test('runPreModel：旧版存档水合走二级合并，内核后加的嵌套字段不丢失', async () => {
  // 回归：水合原是浅展开 `{...createInitialState(), ...saved}`，旧存档的 nudge/stats
  // **整体替换**新默认 ⇒ 内核升级后加的嵌套字段（如 nudge.lastShownByTier）水合后缺失、
  // 相关功能静默失效。
  const freshHarness = makeHarness()
  const legacyState = {
    blocks: [],
    messageRefs: { byRaw: {}, byRef: {} },
    tokenSnapshot: {},
    nudge: { lastPerMessageNudgeTokens: 0, lastNudgeShownTokens: 0, baselineTokens: 0, anchors: {} },
    stats: { tokensCompressed: 0, compressionCount: 0 },
    nextBlockId: 0,
    nextRunId: 0,
  }
  freshHarness.meta[ACP_META_KEY] = legacyState
  await freshHarness.run(history(3))

  const st = freshHarness.ctx.state
  // 新字段来自内核默认（浅展开下它会是 undefined）
  expect(st.nudge.lastShownByTier).toBeDefined()
  // 旧存档数据仍保留
  expect(st.nudge.baselineTokens).toBe(0)
  expect(st.stats.compressionCount).toBe(0)
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

// ===== core.session.compacting 协同（方案三：先保全原文再物理删除） =====

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
    recordedBlockIds: new Set<string>(),
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
    recordedBlockIds: new Set<string>(),
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
    recordedBlockIds: new Set<string>(),
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
    recordedBlockIds: new Set<string>(),
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
    recordedBlockIds: new Set<string>(),
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

// ===== token 折算口径（CJK 感知 vs chars/4）=====
//
// 背景：插件上报的 tokenCount 决定占用率百分比（maxContextLimitPct / emergencyThresholdPct），
// 而内核内部用同一函数数可压缩范围与保护区。旧口径一律 chars/4，中文会话下占用率恒为真值的
// 约 1/4，压缩触发被拖到真实已超窗之后。以下用例锁住"两侧同口径 + 中文按 1 字≈1 token"。

test('estimateTokens：中文按 1 字 ≈ 1 token 记账（默认口径 = 内核 defaultCountTokens）', () => {
  const zh = '压缩上下文参数调优与口径对齐验证'
  const cores: CoreMessage[] = [{ id: 'a', role: 'user', contentType: 'text', text: zh }]
  expect(estimateTokens(cores)).toBe(zh.length)
  // 旧口径把同一段内容算成约 1/4
  expect(estimateTokens(cores, chars4CountTokens)).toBe(Math.ceil(zh.length / 4))
})

test('estimateTokens：英文两种口径逐位等价（旧行为零回归）', () => {
  const en = 'Estimate tokens for an English sentence of a typical length.'
  const cores: CoreMessage[] = [{ id: 'a', role: 'assistant', contentType: 'text', text: en }]
  expect(estimateTokens(cores, chars4CountTokens)).toBe(Math.ceil(en.length / 4))
  expect(estimateTokens(cores)).toBe(estimateTokens(cores, chars4CountTokens))
})

test('estimateTokens：中英混排按各自折算率累加', () => {
  const cores: CoreMessage[] = [
    { id: 'a', role: 'user', contentType: 'text', text: '中文四个字abcd' },
  ]
  // 5 个汉字 → 5 token；4 个 ASCII → ceil(4/4) = 1
  expect(estimateTokens(cores)).toBe(6)
})

test('estimateTokens：thinkingTokens 计入总量（与内核 countMessageTokens 一致）', () => {
  const cores: CoreMessage[] = [
    { id: 'a', role: 'assistant', contentType: 'text', text: 'abcd', thinkingTokens: 50 },
  ]
  expect(estimateTokens(cores)).toBe(1 + 50)
})

test('端到端：tokenCalibration 决定 acp_status 上报的 tokenCount（中文口径修正）', async () => {
  const zhText = '压'.repeat(4000) // 4000 个汉字 ≈ 4000 token（旧口径只算 1000）

  async function statusOf(tokenCalibration?: 'auto' | 'chars4'): Promise<number> {
    const plugin = createAcpContextPlugin({ modelContextLimit: 1_000_000, tokenCalibration })
    const tools = new Map<string, any>()
    const hooks = (await plugin.install({ log: { info: () => {} } } as any)) as Hooks
    await hooks['core.tool.pool.assemble']!({} as any, { add: (t: any) => tools.set(t.id, t) } as any)
    const messages = [msg('user', zhText, 0), msg('assistant', zhText, 1)]
    await hooks['core.session.preModel']!(
      {
        sessionId: 's',
        meta: { read: async () => undefined, patch: async () => {} },
        blocksPatch: [],
      } as any,
      messages,
    )
    const res = await tools.get('acp_status')!.call({}, { sessionId: 's' } as any)
    expect(res.ok).toBe(true)
    return res.output.tokenCount as number
  }

  const auto = await statusOf('auto')
  const defaulted = await statusOf(undefined) // 缺省即 auto
  const legacy = await statusOf('chars4')

  expect(defaulted).toBe(auto) // 默认口径 = auto
  expect(auto).toBeGreaterThan(legacy * 3) // 中文下旧口径低估约 4 倍
  expect(legacy).toBeLessThanOrEqual(Math.ceil((zhText.length * 2) / 4) + 128) // ≈ 真实字符数的 1/4
})

// ===== 压缩手册按需注入（on-demand，token 成本优化）=====
//
// 背景（ra6w1 实测）：会话全程占用率峰值仅 13.3%，却每轮无条件付约 1.9K tokens 的压缩手册钱
// （44 次）。on-demand（默认）改为仅在占用率接近压缩阈值时才注入完整手册，低占用只给一行极简提示，
// 把完整要点挪到每轮都在载荷里的 compress 工具 documentation。占用率口径与遥测一致：
// estimateTokens(res.messages, countTokens) / config.modelContextLimit。

function onDemandConfig(minContextLimitPct = 0.5): Config {
  // modelContextLimit 压到 2000，便于用少量历史把占用率推过/压到阈值两侧；
  // maxContextLimitPct / emergencyThresholdPct 拉高到 0.95 / 0.99，保证测试占用率区间内
  // processTurn 不会压缩/截断 res.messages，从而占用率决策不被改写。
  return defaultConfig(2000, {
    compress: { minCompressRange: 0, maxSummaryLength: 100000, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    promotionThreshold: 1,
    nudge: {
      maxContextLimitPct: 0.95,
      minContextLimitPct,
      frequency: 1,
      iterationThreshold: 1,
      force: 'soft',
      growthRatio: 0.1,
      growthFloor: 1,
      growthCap: 5000,
      minGrowthFloor: 1,
      minGrowthRatio: 0,
      emergencyThresholdPct: 0.99,
      tier2GrowthMultiplier: 1,
    },
  })
}

test('runPreModel：低占用（on-demand）只注入极简提示、不注入完整手册正文', async () => {
  const h = makeHarness(onDemandConfig(0.5), 's1', { manualInjection: 'on-demand' })
  const messages = history(10) // 占用率 ≈ 160/2000 = 0.08，远低于 0.5×0.9=0.45
  await h.run(messages)
  const sys = messages.find((m) => m.role === 'system')!
  expect((sys.parts[0] as any).text).toBe(COMPRESS_MANUAL_HINT) // 极简提示
  expect((sys.parts[0] as any).text).not.toBe('<acp system>') // 完整手册（mock 正文）未注入
  // 任何位置（含尾部）都不得出现手册正文
  expect(JSON.stringify(messages)).not.toContain('<acp system>')
})

test('runPreModel：占用率超过阈值（on-demand）把完整手册注入**尾部**，前缀保持极简提示', async () => {
  const h = makeHarness(onDemandConfig(0.5), 's1', { manualInjection: 'on-demand' })
  const messages = history(100) // 占用率 ≈ 1600/2000 = 0.8，远超 0.5×0.9=0.45（且 < 0.95 不被压缩改写）
  await h.run(messages)

  // 前缀必须恒定 —— 放前缀会让"手册出现"那一刻之后的整段历史在 provider 缓存里失效
  // （量化见 MANUAL_INJECT_MARGIN 注释与 docs/usage-accounting-and-prompt-cache-plan.md §3）
  const sys = messages.find((m) => m.role === 'system')!
  expect((sys.parts[0] as any).text).toBe(COMPRESS_MANUAL_HINT)

  // 完整手册只在尾部，且**只有一条**尾部临时消息（nudge 与手册合并，不推两条相邻消息）
  const tail = messages.filter((m) => m.id.startsWith('acp_user_'))
  expect(tail).toHaveLength(1)
  expect(tail[0]!.role).toBe('user') // 必须是 user role：system 会被 Anthropic/Gemini 上提前缀
  expect((tail[0]!.parts[0] as any).text).toContain('<acp system>')
  expect(messages[messages.length - 1]!.id).toBe(tail[0]!.id) // 确实在最后
  // system 消息里不得出现手册正文
  expect(
    messages.filter((m) => m.role === 'system').map((m) => JSON.stringify(m.parts)).join(),
  ).not.toContain('<acp system>')
})

test('createAcpContextPlugin：systemPrompt 显式覆盖 + on-demand，低占用也在前缀注入用户文本（不往尾部塞手册）', async () => {
  const preModel = await preModelFromPlugin({ systemPrompt: '<custom system>', modelContextLimit: 200000, manualInjection: 'on-demand' })
  const messages = history(3) // 低占用，但显式覆盖豁免阈值
  await preModel(messages)
  expect(messages[0]!.role).toBe('system')
  expect((messages[0]!.parts[0] as any).text).toBe('<custom system>')
  expect((messages[0]!.parts[0] as any).text).not.toBe(COMPRESS_MANUAL_HINT)
  // 显式配置进**前缀**（恒定，无翻转风险）；尾部不再重复一份
  expect(JSON.stringify(messages.slice(1))).not.toContain('<custom system>')
})

test('createAcpContextPlugin：manualInjection always，低占用也注入完整手册（旧行为）', async () => {
  const preModel = await preModelFromPlugin({ modelContextLimit: 200000, manualInjection: 'always' })
  const messages = history(3) // 低占用，但 'always' 回到旧行为
  await preModel(messages)
  expect(messages[0]!.role).toBe('system')
  const sysText = (messages[0]!.parts[0] as any).text
  expect(sysText).toInclude('All compression serves the primary task') // 完整内核压缩手册正文
  expect(sysText).not.toBe(COMPRESS_MANUAL_HINT)
})

// ── B2-3：工具入参完整性提醒（触发条件是"真丢过参数"，不是占用率）──
//
// 为什么不按占用率触发：真机 s_1790592617954_axqkk 丢 14 次空入参时 occupancy 峰值仅 22.83%，
// 任何长上下文阈值（25% / 35%）都不会触发 ⇒ 那等于没修。改用 `core.tool.params.missing`
// （与 selfHealOnly 免计额度同源的直接信号）作触发条件。
test('B2-3：本会话丢过一次工具入参 ⇒ 之后每轮尾部常驻「入参完整性」提醒', async () => {
  const plugin = createAcpContextPlugin({ modelContextLimit: 20000, manualInjection: 'on-demand' })
  const hooks = (await plugin.install({ log: { info: () => {} } } as any)) as Hooks
  const preModel = (raw: Message[]) =>
    hooks['core.session.preModel']!(
      { sessionId: 's', meta: { read: async () => undefined, patch: async () => {} }, blocksPatch: [] } as any,
      raw,
    )

  // ① 还没丢过参数：尾部不出现提醒（不能无条件常驻 —— 那是白付 token）
  const before = history(3)
  await preModel(before)
  expect(JSON.stringify(before)).not.toContain(TOOL_ARGS_REMINDER)

  // ② core 报了一次「必填项没给全」
  hooks['core.tool.params.missing']!({ toolId: 'read_file', sessionId: 's', agentId: 'lead', step: 3, missingCount: 1 })

  // ③ 之后尾部有提醒、且**只在尾部**（前缀仍恒定，翻转不伤前缀缓存）
  const after = history(3)
  await preModel(after)
  const tail = after.filter((m) => m.id.startsWith('acp_user_'))
  expect(tail).toHaveLength(1)
  expect((tail[0]!.parts[0] as any).text).toContain(TOOL_ARGS_REMINDER)
  expect(after[after.length - 1]!.id).toBe(tail[0]!.id)
  const sys = after.find((m) => m.role === 'system')!
  expect((sys.parts[0] as any).text).toBe(COMPRESS_MANUAL_HINT)
  expect((sys.parts[0] as any).text).not.toContain(TOOL_ARGS_REMINDER)

  // ④ 粘性：后续轮次继续提醒
  const again = history(3)
  await preModel(again)
  expect(JSON.stringify(again)).toContain(TOOL_ARGS_REMINDER)
})

test('B2-3：信号里没有 sessionId 时不抛、也不误置到别的会话', async () => {
  const plugin = createAcpContextPlugin({ modelContextLimit: 20000 })
  const hooks = (await plugin.install({ log: { info: () => {} } } as any)) as Hooks
  expect(() => hooks['core.tool.params.missing']!({ toolId: 'read_file', step: 1, missingCount: 2 })).not.toThrow()

  const messages = history(3)
  await hooks['core.session.preModel']!(
    { sessionId: 's', meta: { read: async () => undefined, patch: async () => {} }, blocksPatch: [] } as any,
    messages,
  )
  expect(JSON.stringify(messages)).not.toContain(TOOL_ARGS_REMINDER)
})

test('createAcpContextPlugin：compress 工具 documentation 非空且 ≤ 600 字符（兜底要点齐备）', async () => {
  const plugin = createAcpContextPlugin({ modelContextLimit: 200000 })
  const tools = new Map<string, any>()
  const hooks = (await plugin.install({ log: { info: () => {} } } as any)) as Hooks
  await hooks['core.tool.pool.assemble']!({} as any, { add: (t: any) => tools.set(t.id, t) } as any)
  const doc = tools.get('compress')!.documentation
  expect(typeof doc).toBe('string')
  expect(doc.length).toBeGreaterThan(0)
  expect(doc.length).toBeLessThanOrEqual(600)
  // 兜底要点：范围用 ref（startId/endId）、summary 必须自包含、只压已完成段
  expect(doc).toInclude('startId')
  expect(doc).toInclude('summary')
  expect(doc).toInclude('不再需要原文')
})

// ===== providerCache 遥测（引擎广播 core.llm.usage → 本插件落行）=====
//
// 背景：`buildProviderCacheEvent` 的注释一直写着"由 core 层追加"，但全仓没有调用方 ⇒
// provider 侧缓存命中**从来没有数据**，于是"按需注入会不会影响缓存命中"这类问题无从验证。
// 现在引擎在拿到用量后触发 `core.llm.usage`，本插件把它落成 providerCache 行。

async function pluginWithTelemetry(): Promise<{ hooks: Hooks; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'acp-telem-'))
  const path = join(dir, 's.telemetry.jsonl')
  const plugin = createAcpContextPlugin({ modelContextLimit: 20000, telemetryPathBuilder: () => path })
  const hooks = (await plugin.install({ log: { info: () => {}, warn: () => {} } } as any)) as Hooks
  return { hooks, path }
}

const runPreModelOnce = (hooks: Hooks, messages: Message[]) =>
  hooks['core.session.preModel']!(
    { sessionId: 's', meta: { read: async () => undefined, patch: async () => {} }, blocksPatch: [] } as any,
    messages,
  )

test('core.llm.usage：把引擎广播的缓存命中/写入落成 providerCache 遥测行', async () => {
  const { hooks, path } = await pluginWithTelemetry()
  // 先跑一轮 preModel：会话上下文（含遥测 writer）在那里按 sessionId 建立
  await runPreModelOnce(hooks, history(3))

  hooks['core.llm.usage']!({ sessionId: 's', input: 1000, output: 50, cacheRead: 900, cacheWrite: 0 })
  // writer 有 500ms debounce：等一拍再读
  await new Promise((r) => setTimeout(r, 600))

  const rows = readFileSync(path, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  const pc = rows.filter((r) => r.kind === 'providerCache')
  expect(pc).toHaveLength(1)
  expect(pc[0].sessionId).toBe('s')
  expect(pc[0].cacheRead).toBe(900)
  expect(pc[0].cacheWrite).toBe(0)
})

test('core.llm.usage：无缓存字段不写行（避免噪声）；未知会话静默跳过（不抛）', async () => {
  const { hooks, path } = await pluginWithTelemetry()
  // 未知会话：不得抛错，也不写任何行
  expect(() => hooks['core.llm.usage']!({ sessionId: 'nope', input: 1, output: 1, cacheRead: 5 })).not.toThrow()

  await runPreModelOnce(hooks, history(3))
  // 已知会话但没有缓存字段 ⇒ builder 返回 null ⇒ 不写 providerCache
  hooks['core.llm.usage']!({ sessionId: 's', input: 10, output: 1 })
  await new Promise((r) => setTimeout(r, 600))

  const text = existsSync(path) ? readFileSync(path, 'utf-8') : ''
  expect(text).not.toContain('providerCache')
  expect(text).toContain('preModel') // 遥测本身是通的（证明"没写"不是因为整条链路没开）
})

test('uninstall：退出前 flush（不依赖 debounce 定时器）', async () => {
  // 写入器有 500ms debounce，其 flush() 注释写着"正常退出 / 信号兜底时调用"，
  // 但 uninstall() 此前只 clear 了 Map、没有调用方 ⇒ 结构性缺口（同类缺陷本项目已撞多次）。
  // 本用例固定**机制**：卸载后立刻可读，不必等 debounce。
  // 注：并未观测到真实丢行 —— 三次真机取证的 providerCache 行数都与 llmCalls 精确相等。
  const dir = mkdtempSync(join(tmpdir(), 'acp-flush-'))
  const path = join(dir, 's.telemetry.jsonl')
  const plugin = createAcpContextPlugin({ modelContextLimit: 20000, telemetryPathBuilder: () => path })
  const hooks = (await plugin.install({ log: { info: () => {}, warn: () => {} } } as any)) as Hooks

  await runPreModelOnce(hooks, history(3))
  hooks['core.llm.usage']!({ sessionId: 's', input: 1000, output: 50, cacheRead: 900, cacheWrite: 0 })
  // 刻意**不等** debounce（500ms）就卸载 —— 真实退出就是这样
  await plugin.uninstall?.()

  const rows = readFileSync(path, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  expect(rows.filter((r) => r.kind === 'providerCache')).toHaveLength(1)
})

// ===== 前缀缓存回退归因（缓存为什么掉）=====

test('前缀归因：历史增长 + 尾部动态块右移 ⇒ appended，不得误报 mutated', async () => {
  // 背景（回归）：ACP 每轮在请求**末尾现拼**尾部动态块（nudge / 压缩手册）。历史增长一条时，
  // 上一轮的尾部块在逐条比对里会与「新历史的第一条」相撞（上轮它在 n-1，本轮历史占了 n-1），
  // 旧实现据此报 `mutated`（"中段某条被就地改写"）—— 排查方向被引向"谁改写了历史中段"，
  // 而真实代价只是尾部那一条重算，与 `appended` 同级。
  // 修法：尾部块不属于缓存前缀，比对前先剔除（两轮各自剔除，视野对齐在纯历史前缀上）。
  const h = makeHarness(makeConfig(2000), 's1', { manualInjection: 'on-demand' })

  const m1 = history(2)
  await h.run(m1)
  // 前提：本轮请求末尾**确实**有 ACP 追加的尾部块（否则本用例没测到目标分支）
  expect(manualInjected(m1)).toBe(true)
  expect((h.ctx as any).lastPrefixDiff).toBeNull() // 首轮无基线

  const m2 = history(3)
  await h.run(m2)
  expect(manualInjected(m2)).toBe(true)
  const d = (h.ctx as any).lastPrefixDiff
  expect(d.changedKind).toBe('appended')
  expect(d.changedAt).toBeNull()
  // 稳定前缀覆盖原有历史（不是被尾部块挤到 0）：system + 上轮两条历史 = 3 条
  expect(d.stableMessages).toBe(3)
})

/** 末尾是否为 ACP 现拼的尾部块（`tempMessage` 生成的 id 前缀 + 手册正文） */
function manualInjected(messages: Message[]): boolean {
  const last = messages.at(-1)
  if (!last || last.role !== 'user') return false
  return (last.parts[0] as { text?: string } | undefined)?.text?.includes('<acp system>') === true
}


// ===== 尾部动态块规模进入归因（core 在 preModel 之后才拼，这里只能拿到规模）=====

test('尾部动态块：core 传入的 dynamicParts 被记为规模，且每轮显式覆盖（含置空）', async () => {
  // 回归背景：core 的尾部动态区（core.prompt.dynamic.transform）在 preModel **返回之后**
  // 才拼成请求末尾的 user 消息，ACP 按 messages 建视图时看不见它 ⇒ 归因里完全没有它。
  // 而它是请求最后一条，正是 anthropic 显式 promptCache 断点的落点：
  // 那种装配下末尾每轮 cache write，`cacheMissReason` 却报 `none`（前缀确实没动）。
  // core 现在通过 SessionPreModelInput.dynamicParts 把片段告知；本插件只记规模。
  const dyn = ['mcp resources（缓存只增不减）', 'memory 一次性沉淀提示']
  const h = makeHarness(makeConfig(), 's1', { dynamicParts: dyn })

  await h.run(history(2))
  expect((h.ctx as unknown as { lastTailDyn?: { parts: number; chars: number } }).lastTailDyn).toEqual({
    parts: 2,
    chars: dyn.join('').length,
  })

  // 下一轮没有尾部块 ⇒ 必须置空（上一轮的规模留在这里会被读成"本轮还有块"）
  dyn.length = 0
  await h.run(history(3))
  expect((h.ctx as unknown as { lastTailDyn?: unknown }).lastTailDyn).toBeUndefined()
})


// ===== 观察点 8：零收益空压缩 =====
//
// 真机 reader#1 round 11：`createdBlocks:0, tokensCompressed:0, ranges:[{chars:0}]`
// —— 模型调了 compress、内核一个块都没建（范围已被覆盖/太小/ref 未知），
// 但工具回的是 `ok: true` + output.errors，模型倾向于把它当成功继续；而遥测里
// `ranges[].chars` 恒为 0（插件写死），"模型要求折叠多少内容"根本测不出来，
// 于是零收益压缩与"真折了一大段"在遥测里长得一模一样。两条都修在这里。

test('measureRangeChars：按压缩前 ref 真实统计区间字符数（此前恒为 0）', () => {
  const cores: CoreMessage[] = [
    { id: 'c1', role: 'user', contentType: 'text', text: 'aaaa' },
    { id: 'c2', role: 'assistant', contentType: 'text', text: 'bbbbbb' },
    { id: 'c3', role: 'user', contentType: 'text', text: 'cc' },
  ]
  const { map } = assignRefs(cores, { existing: createInitialState().messageRefs, nextIndex: 1 })
  const state = { ...createInitialState(), messageRefs: map }
  const stats = measureRangeChars(state, cores, [
    { topic: '前两条', startRef: refForRaw(map, 'c1')!, endRef: refForRaw(map, 'c2')! },
    { topic: '第三条', startRef: refForRaw(map, 'c3')!, endRef: refForRaw(map, 'c3')! },
    { topic: 'ref 解析不出', startRef: 'nope', endRef: 'nope2' },
  ])
  expect(stats.map((s) => s.chars)).toEqual([10, 2, 0])
  expect(stats.map((s) => s.topic)).toEqual(['前两条', '第三条', 'ref 解析不出'])
})

async function pluginWithCompressTool(config?: Config): Promise<{ hooks: Hooks; tools: Map<string, any> }> {
  const plugin = createAcpContextPlugin({
    modelContextLimit: 20000,
    ...(config ? { config } : {}),
  })
  const tools = new Map<string, any>()
  const hooks = (await plugin.install({ log: { info: () => {}, warn: () => {} } } as any)) as Hooks
  await (hooks['core.tool.pool.assemble']! as any)({} as any, { add: (t: any) => tools.set(t.id, t) })
  return { hooks, tools }
}

function toolCtx(sessionId: string): any {
  return {
    sessionId,
    agentId: 'a',
    messageId: 'mm',
    toolUseId: 'tu',
    signal: new AbortController().signal,
    variables: {},
    cwd: process.cwd(),
    requestPermission: async () => ({ behavior: 'allow' }),
  }
}

/** 从渲染后的消息里抓出内核注入的 ref 标签（形如 `<acp …>m00007</acp>`） */
function refsIn(messages: Message[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    for (const p of m.parts as Array<{ type?: string; text?: string }>) {
      if (p?.type !== 'text' || typeof p.text !== 'string') continue
      for (const mm of p.text.matchAll(/<acp[^>]*>(m\d+)<\/acp>/g)) out.push(mm[1]!)
    }
  }
  return out
}

test('compress 工具：零收益时回**失败**结果（NO_EFFECT），并把内核说明原样带给模型', async () => {
  const { hooks, tools } = await pluginWithCompressTool(makeConfig())
  const messages = history(12)
  await (hooks['core.session.preModel']! as any)(
    { sessionId: 's', meta: { read: async () => undefined, patch: async () => {} }, blocksPatch: [] },
    messages,
  )
  // ref 全部未知 ⇒ 内核必然零收益（这条路径不依赖 minCompressRange 配置，稳定）
  const r = await tools.get('compress')!.call(
    { content: [{ startId: 'm99001', endId: 'm99002', summary: '无论写什么都不会生效' }] },
    toolCtx('s'),
  )
  expect(r.ok).toBe(false)
  expect(r.error.code).toBe('NO_EFFECT')
  expect(r.error.message).toContain('零收益')
  expect(r.error.message).toContain('内核说明') // 内核的 gate 说明原样回喂，不是被吞掉
  expect(r.error.message).toContain('acp_status') // 给下一步动作，避免模型反复撞同一面墙
})

test('compress 工具：成功折叠时回 charsCompressed（可判断这次调用有没有价值）', async () => {
  const { hooks, tools } = await pluginWithCompressTool(makeConfig())
  const messages = history(12)
  await (hooks['core.session.preModel']! as any)(
    { sessionId: 's', meta: { read: async () => undefined, patch: async () => {} }, blocksPatch: [] },
    messages,
  )
  const refs = refsIn(messages)
  expect(refs.length).toBeGreaterThanOrEqual(6)
  const r = await tools.get('compress')!.call(
    { content: [{ topic: 'zhe', startId: refs[1]!, endId: refs[4]!, summary: '自包含摘要' }] },
    toolCtx('s'),
  )
  expect(r.ok).toBe(true)
  expect(r.output.blocksCreated).toBe(1)
  expect(r.output.charsCompressed).toBeGreaterThan(0)
})

test('遥测：零收益压缩标 zeroYield，成功压缩不标（且 ranges.chars 真实非 0）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-zero-'))
  const path = join(dir, 's.telemetry.jsonl')
  const plugin = createAcpContextPlugin({
    modelContextLimit: 20000,
    config: makeConfig(),
    telemetryPathBuilder: () => path,
  })
  const tools = new Map<string, any>()
  const hooks = (await plugin.install({ log: { info: () => {}, warn: () => {} } } as any)) as Hooks
  await (hooks['core.tool.pool.assemble']! as any)({} as any, { add: (t: any) => tools.set(t.id, t) })

  const messages = history(12)
  await (hooks['core.session.preModel']! as any)(
    { sessionId: 's', meta: { read: async () => undefined, patch: async () => {} }, blocksPatch: [] },
    messages,
  )
  const refs = refsIn(messages)

  // 一次成功、一次零收益
  await tools.get('compress')!.call(
    { content: [{ startId: refs[1]!, endId: refs[4]!, summary: '摘要 A' }] },
    toolCtx('s'),
  )
  await tools.get('compress')!.call(
    { content: [{ startId: 'm99001', endId: 'm99002', summary: '摘要 B' }] },
    toolCtx('s'),
  )

  // 遥测写入器有 500ms debounce：用 uninstall 的 flush 收口，别靠 sleep
  await plugin.uninstall?.()

  const events = readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'compress')
  expect(events).toHaveLength(2)
  // 成功那次：真实字符数、无 zeroYield
  expect(events[0].createdBlocks).toBe(1)
  expect(events[0].ranges[0].chars).toBeGreaterThan(0)
  expect(events[0].zeroYield).toBeUndefined()
  // 零收益那次：chars 为 0（ref 不可解析）+ 显式标 zeroYield
  expect(events[1].createdBlocks).toBe(0)
  expect(events[1].zeroYield).toBe(true)
})
