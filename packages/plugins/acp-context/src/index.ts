/**
 * @harness/acp-context - ACP 上下文压缩插件
 *
 * 基于 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 的模型驱动 3 层 LSM
 * 上下文压缩引擎，直接引用它的功能包做宿主适配：
 *
 * - **每轮接入**：通过 core 新增的 `session.preModel` hook，在每轮进入模型前
 *   `processTurn` 指派 refs、执行分层压缩过滤、产出 nudge 决策，并把精简后的
 *   会话历史回写持久层（`save`）。
 * - **模型驱动工具**：注入 `compress` / `decompress` / `search_context` / `acp_status`
 *   4 个工具，由模型自己决定压缩时机/范围；nudge 提示模型何时压缩。
 * - **主机兜底**：即使模型不主动调用，nudge 也会在上下文增长达到阈值时以 user 消息
 *   提醒，并最终由 kernel 的 emergency/截断策略兜底。
 *
 * @example
 * import { createHarness } from '@harness/core'
 * import { createAcpContextPlugin } from '@harness/acp-context'
 *
 * const h = await createHarness({
 *   internalPlugins: [createAcpContextPlugin({ modelContextLimit: 200_000 })],
 *   agents: [{ id: 'default', name: 'Agent', mode: 'primary', tools: ['*'],
 *     permission: { '*': 'allow' }, promptFragments: [] }],
 * })
 */

import { defineTool, Schema, ToolResult, ToolContext } from '@harness/tool'
import type { AgentPlugin, Hooks, CompactionContext } from '@harness/plugin'
import type { Message } from '@harness/session'
import {
  createCore,
  createInitialState,
  defaultConfig,
  parseCompressInput,
  renderNudgeText,
  buildCompressSystemPrompt,
  assignRefs,
  highestUsedIndex,
  refForRaw,
  coveredMessageIds,
  type Config as AcpConfig,
  type CoreMessage,
  type CompressionState,
  type CompressionBlock,
} from 'acp-kernel'

import {
  toCores,
  requestMessages,
  estimateTokens,
  baseId,
  safeString,
} from './adapter.js'

/** session.meta 中存储 ACP 压缩状态的键 */
export const ACP_META_KEY = 'acp.v1'

// ===== 轻量 Schema 工厂（不依赖 zod）=====
function makeSchema<T>(): Schema<T> {
  return {
    parse(value: unknown): T {
      return value as T
    },
    safeParse(value: unknown) {
      return { success: true, data: value as T }
    },
  }
}

// ===== 工具输入类型 =====

export interface CompressRangeArg {
  topic?: string
  startId: string
  endId: string
  summary: string
  summaryMaxChars?: number
}
export interface CompressInput {
  topic?: string
  content: CompressRangeArg[]
}
export interface CompressOutput {
  blocksCreated: number
  tokensCompressed: number
  errors: string[]
  warnings: string[]
}

export interface DecompressInput {
  blockId: string
  toFile?: boolean
  full?: boolean
}
export interface DecompressOutput {
  blockId: string
  topic?: string
  summary: string
  tokensCompressed: number
  active: boolean
  tier: 1 | 2 | 3
  effectiveMessages: string[]
  /** 被该块压缩并归档的原始消息全文（按原顺序），便于模型了解被折叠的具体内容 */
  originalMessages: Array<{ id: string; role?: string; text: string }>
}

export interface SearchInput {
  query: string
  limit?: number
}
export interface SearchResult {
  blockId: string
  topic?: string
  summary: string
  score: number
}
export interface SearchOutput {
  query: string
  limit: number
  results: SearchResult[]
}

export interface AcpStatusInput {}
export interface AcpStatusOutput {
  contextUsage: number
  tokenCount: number
  modelContextLimit: number
  activeBlocks: number
  totalBlocks: number
  tokensCompressed: number
  breakdown: Record<string, number>
}

// ===== 插件选项 =====

export interface AcpContextPluginOptions {
  /** 模型上下文窗口（tokens）。默认 200_000。 */
  modelContextLimit?: number
  /** 覆盖 kernel 的默认 config（tiers / nudge / protectedTools 等） */
  config?: Partial<AcpConfig>
  /** 内置 ACP 工具名（默认全部注入，可用其中的子集） */
  toolIds?: Array<'compress' | 'decompress' | 'search_context' | 'acp_status'>
}

/** 会话级 ACP 运行时上下文（内存态，跨轮保留；state 会持久化到 session.meta） */
interface AcpSessionCtx {
  state: CompressionState
  /**
   * 本轮映射的原始消息归档（core.id → Message）。
   * 即使某范围的原始消息被压缩出本轮请求，仍可通过它还原全文（decompress full）。
   */
  archive: Map<string, Message>
  /** 最近一次 processTurn 的 core（已指派 refs），供工具引用 */
  lastCores: CoreMessage[]
  /** 是否已从 session.meta 水合过压缩状态 */
  hydrated: boolean
  /** 最近一次持久化的状态 JSON（用于跳过无变化的重复写入） */
  stateSnapshot: string
  // ---- 增量渲染缓存 ----
  /** 已渲染（含压缩效果/refs 标签）的历史前缀的原始消息 id 序列 */
  prefixIds: string[]
  /** 与 prefixIds 对应的渲染结果（不含 system），增量路径直接复用 */
  prefixRender: Message[]
  /** 是否需要强制全量重算（压缩发生/状态变化/水合后置位） */
  needFull: boolean
  /** 全量路径最后一次的 token 估算，用于判断增量是否逼近阈值 */
  lastTokens: number
  /** 会话 meta 写访问器（由 runPreModel 注入，供 compress 工具即时持久化状态） */
  meta?: { patch: (patch: Record<string, unknown>) => Promise<void> }
}

// ========================================================================
// 插件工厂
// ========================================================================

/**
 * 创建 ACP 上下文压缩插件。
 * 每轮通过 session.preModel 运行 acp-kernel 的 processTurn，并注入 4 个模型驱动工具。
 */
export function createAcpContextPlugin(options: AcpContextPluginOptions = {}): AgentPlugin {
  const modelContextLimit = options.modelContextLimit ?? 200_000
  const config = defaultConfig(modelContextLimit, options.config)
  // 引擎纯态：state 由宿主显式传入/取回
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const engine = createCore() // 使用 kernel 默认 tokenizer（chars/4）

  const allowToolIds = new Set(options.toolIds)
  const want = (id: string): boolean =>
    !options.toolIds || options.toolIds.length === 0 || allowToolIds.has(id as any)

  // 会话级上下文（进程内）
  const sessions = new Map<string, AcpSessionCtx>()

  function getOrCreateCtx(sessionId: string): AcpSessionCtx {
    let ctx = sessions.get(sessionId)
    if (!ctx) {
      ctx = {
        state: createInitialState(),
        archive: new Map(),
        lastCores: [],
        hydrated: false,
        stateSnapshot: '',
        prefixIds: [],
        prefixRender: [],
        needFull: true,
        lastTokens: 0,
      }
      sessions.set(sessionId, ctx)
    }
    return ctx
  }

  // ===== compress / decompress / search_context / acp_status 工具 =====

  const compressTool = want('compress')
    ? defineTool<CompressInput, CompressOutput>({
        id: 'compress',
        description:
          '压缩历史消息：把指定 ref 范围内的旧消息折叠成一段摘要，换回上下文空间。模型写摘要、内核做编排。',
        inputSchema: makeSchema<CompressInput>(),
        isConcurrencySafe: () => false,
        isReadOnly: () => false,
        async call(input, ctx) {
          const sctx = sessions.get(ctx.sessionId)
          if (!sctx) {
            return { ok: false, error: { message: '当前会话尚无 ACP 上下文', code: 'NO_CTX' } }
          }
          const ranges = parseCompressInput(
            input,
            ctx.toolUseId,
            (w) => ctx.log?.warn?.(w),
          )
          if (!ranges.length) {
            return { ok: false, error: { message: 'compress 参数无法解析出有效范围', code: 'NO_RANGES' } }
          }
          const applied = engine.applyCompression({
            ranges: ranges.map((r) => ({
              startRef: r.startRef,
              endRef: r.endRef,
              summary: r.summary,
              topic: r.topic,
              compressCallId: r.compressCallId,
            })),
            messages: sctx.lastCores,
            state: sctx.state,
            config,
          })
          sctx.state = applied.state
          // 压缩改变了块结构/历史 → 强制下一轮全量重建，失效增量缓存
          sctx.needFull = true
          return {
            ok: true,
            output: {
              blocksCreated: applied.result.blocksCreated,
              tokensCompressed: applied.result.tokensCompressed,
              errors: applied.result.errors,
              warnings: applied.result.warnings,
            },
          }
        },
      })
    : undefined

  const decompressTool = want('decompress')
    ? defineTool<DecompressInput, DecompressOutput>({
        id: 'decompress',
        description: '按 blockId 查看某个已压缩上下文块的摘要，可了解被压缩掉的内容梗概。',
        inputSchema: makeSchema<DecompressInput>(),
        isConcurrencySafe: () => false,
        isReadOnly: () => true,
        async call(input, ctx): Promise<ToolResult<DecompressOutput>> {
          const sctx = sessions.get(ctx.sessionId)
          if (!sctx) {
            return { ok: false, error: { message: '当前会话尚无 ACP 上下文', code: 'NO_CTX' } }
          }
          const block = engine.decompress(input.blockId, sctx.state)
          if (!block) {
            return { ok: false, error: { message: `未找到压缩块: ${input.blockId}`, code: 'NOT_FOUND' } }
          }
          return {
            ok: true,
            output: {
              blockId: block.blockId,
              topic: block.topic,
              summary: block.summary,
              tokensCompressed: block.compressedTokens,
              active: block.active,
              tier: block.tier,
              effectiveMessages: block.effectiveMessageIds,
              originalMessages: restoreBlockMessages(engine, sctx.state, sctx.archive, block.blockId),
            },
          }
        },
      })
    : undefined

  const searchTool = want('search_context')
    ? defineTool<SearchInput, SearchOutput>({
        id: 'search_context',
        description: '按 query 对已压缩的历史上下文块做相关性检索，找到对话主题对应的摘要。',
        inputSchema: makeSchema<SearchInput>(),
        isConcurrencySafe: () => false,
        isReadOnly: () => true,
        async call(input, ctx): Promise<ToolResult<SearchOutput>> {
          const sctx = sessions.get(ctx.sessionId)
          if (!sctx) {
            return { ok: false, error: { message: '当前会话尚无 ACP 上下文', code: 'NO_CTX' } }
          }
          const blocks = engine.search(input.query, sctx.state)
          const limit = Math.max(0, input.limit ?? 5)
          const results: SearchResult[] = blocks.slice(0, limit).map((b) => ({
            blockId: b.blockId,
            topic: b.topic,
            summary: b.summary,
            score: 0, // kernel 不返回数值分，展示顺序即相关序
          }))
          return { ok: true, output: { query: input.query, limit, results } }
        },
      })
    : undefined

  const statusTool = want('acp_status')
    ? defineTool<AcpStatusInput, AcpStatusOutput>({
        id: 'acp_status',
        description: '查看当前上下文压缩状态：上下文占用、已压缩块数、已回收 token 数。',
        inputSchema: makeSchema<AcpStatusInput>(),
        isConcurrencySafe: () => false,
        isReadOnly: () => true,
        async call(_input, ctx): Promise<ToolResult<AcpStatusOutput>> {
          const sctx = sessions.get(ctx.sessionId)
          if (!sctx) {
            return { ok: false, error: { message: '当前会话尚无 ACP 上下文', code: 'NO_CTX' } }
          }
          const tokenCount = estimateTokens(sctx.lastCores)
          const rep = engine.status(sctx.state, tokenCount, config)
          return {
            ok: true,
            output: {
              contextUsage: rep.contextUsage,
              tokenCount: rep.tokenCount,
              modelContextLimit: rep.modelContextLimit,
              activeBlocks: rep.activeBlocks,
              totalBlocks: rep.totalBlocks,
              tokensCompressed: rep.tokensCompressed,
              breakdown: rep.breakdown,
            },
          }
        },
      })
    : undefined

  // 收集要注入的工具
  const tools = [compressTool, decompressTool, searchTool, statusTool].filter(
    (t): t is NonNullable<typeof t> => !!t,
  )

  /** 构造一条临时消息（用于注入 ACP 哲学 / nudge，不落入持久层） */
  function tempMessage(role: Message['role'], text: string, sessionId: string): Message {
    return {
      id: `acp_${role}_${sessionId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      role,
      parts: [{ type: 'text', text }],
      createdAt: Date.now(),
    }
  }

  return {
    id: 'context.acp',
    version: '0.1.0',
    name: 'ACP 上下文压缩',
    description: '模型驱动 3 层 LSM 上下文压缩（基于 acp-kernel）',
    async install(plgCtx) {
      plgCtx.log.info('ACP 上下文压缩插件已加载', { modelContextLimit })

      return {
        async 'tool.pool.assemble'(_input, pool) {
          for (const t of tools) (pool as { add: (t: unknown) => void }).add(t)
        },

        async 'session.preModel'(input, rawMessages) {
          const messages = rawMessages as Message[]
          try {
            await runPreModel({
              sessionId: input.sessionId,
              messages,
              getCtx: () => getOrCreateCtx(input.sessionId),
              engine,
              config,
              meta: input.meta,
              makeSystemPrompt: () => buildCompressSystemPrompt(),
              tempMessage,
            })
          } catch (err) {
            // 压缩是旁路优化：失败绝不阻断本轮模型请求
            plgCtx.log.warn?.('ACP preModel 处理失败，跳过本轮压缩', { err: String(err) })
          }
        },

        async 'session.compacting'(input, compactCtx) {
          try {
            await runCompacting({
              sessionId: input.sessionId,
              input: compactCtx,
              getCtx: () => getOrCreateCtx(input.sessionId),
              engine,
              config,
              meta: {
                read: async () => undefined,
                patch: async () => {},
              },
            })
          } catch (err) {
            // 折叠失败不阻断 core 的默认 session 压缩
            plgCtx.log.warn?.('ACP session.compacting 处理失败，走默认压缩', { err: String(err) })
          }
        },
      } as Hooks
    },

    async uninstall() {
      sessions.clear()
    },
  }
}

// ========================================================================
// 每轮处理（可单测的纯函数核心）
// ========================================================================

interface RunPreModelDeps {
  sessionId: string
  messages: Message[]
  getCtx: () => AcpSessionCtx
  engine: ReturnType<typeof createCore>
  config: AcpConfig
  /** session.meta 持久化访问器（用于保存/恢复压缩状态） */
  meta: { read: () => Promise<Record<string, unknown> | undefined>; patch: (patch: Record<string, unknown>) => Promise<void> }
  makeSystemPrompt: () => string
  tempMessage: (role: Message['role'], text: string, sessionId: string) => Message
}

/**
 * 每轮进入模型前：从 meta 水合压缩状态 → 压平历史 → processTurn（指派 refs /
 * 分层压缩 / nudge）→ 保留原始消息归档 + 持久化状态 → 重建本轮请求
 * （系统 + ACP 哲学 + 历史 + nudge）。
 *
 * 设计取舍：会话历史保留全文（原始消息持久化在 session 本体，decompress 可完整还原），
 * 压缩只作用于"本轮发给模型的请求"；压缩状态单独持久化到 session.meta，重启后可恢复，
 * 从而既有请求级 token 节省，又保证可回溯。
 */
export async function runPreModel(deps: RunPreModelDeps): Promise<void> {
  const { sessionId, messages, engine, config, meta } = deps
  const ctx = deps.getCtx()

  // 从 session.meta 水合压缩状态（仅首次）；水合后置 needFull，强制全量重建一次
  if (!ctx.hydrated) {
    ctx.hydrated = true
    try {
      const saved = (await meta.read())?.[ACP_META_KEY] as CompressionState | undefined
      if (saved && typeof saved === 'object') {
        ctx.state = { ...createInitialState(), ...saved }
        ctx.stateSnapshot = JSON.stringify(ctx.state)
      }
    } catch {
      // 水合失败则从空状态开始
    }
    ctx.needFull = true
  }

  // 拆分系统消息与历史
  const systemMsgs: Message[] = []
  const history: Message[] = []
  for (const m of messages) {
    if (m.role === 'system') systemMsgs.push(m)
    else history.push(m)
  }

  // 压平为 core（同时记录原始消息归档，供 decompress 还原全文），运行 processTurn
  const inflat = toCores(history)
  ctx.archive = new Map(inflat.byId)
  const tokenCount = estimateTokens(inflat.cores)
  const res = engine.processTurn({
    messages: inflat.cores,
    state: ctx.state,
    config,
    tokenCount,
    renderTags: 'text-only',
  })

  // 就地更新会话上下文（ctx 是 Map 里的对象引用）
  ctx.state = res.state
  ctx.lastCores = res.messages

  // 持久化压缩状态（仅变化时写一次，避免每轮无谓 IO）
  const nextSnapshot = JSON.stringify(res.state)
  if (ctx.stateSnapshot !== nextSnapshot) {
    ctx.stateSnapshot = nextSnapshot
    try {
      await meta.patch({ [ACP_META_KEY]: res.state })
    } catch {
      // 持久化失败不致命，内存态仍可用
    }
  }

  // ---- 增量渲染缓存 ----
  // 常态投影路径：若历史前缀与缓存一致、本轮无压缩/截断（res.messages 与输入 cores 等长，
  // 即没有块插入或紧急剔除），则复用缓存的"已渲染前缀"，只对新增尾部 core 做 requestMessages。
  // 全量路径：压缩发生（needFull）、历史前缀漂移、或 res.messages 数量变化（截断）时，全量重建并刷新缓存。
  // 本轮发生压缩/截断（消息数变化）时，历史本体已被改写，缓存前缀不再可信 → 强制下一轮全量。
  if (res.messages.length !== inflat.cores.length) {
    ctx.needFull = true
  }
  let cacheHit = false
  let prefixCoreCount = 0
  if (
    !ctx.needFull &&
    ctx.prefixIds.length > 0 &&
    ctx.prefixIds.length <= history.length &&
    res.messages.length === inflat.cores.length
  ) {
    // 校验历史前缀逐 id 相等（无插入/删除，仅尾部追加）
    let aligned = true
    for (let i = 0; i < ctx.prefixIds.length; i++) {
      if (ctx.prefixIds[i] !== history[i]!.id) {
        aligned = false
        break
      }
    }
    if (aligned) {
      // 前缀对应的 core 数量 = 前 prefixLen 条原始消息展开出的 core 数
      prefixCoreCount = 0
      for (let i = 0; i < ctx.prefixIds.length; i++) {
        prefixCoreCount += (inflat.byBase.get(baseId(history[i]!.id)) ?? []).length
      }
      cacheHit = prefixCoreCount <= res.messages.length
    }
  }

  const request: Message[] = [...systemMsgs]
  request.push(deps.tempMessage('system', deps.makeSystemPrompt(), sessionId))

  if (cacheHit) {
    // 增量：复用缓存前缀 + 只渲染新增尾部 core，并把尾部并入缓存供下一轮继续命中
    const tailCores = res.messages.slice(prefixCoreCount)
    const tailRender = requestMessages(tailCores)
    request.push(...ctx.prefixRender)
    request.push(...tailRender)
    ctx.prefixIds = history.map((m) => m.id)
    ctx.prefixRender = [...ctx.prefixRender, ...tailRender]
    ctx.lastTokens = tokenCount
  } else {
    // 全量：重建整段渲染结果并刷新缓存
    const rendered = requestMessages(res.messages)
    request.push(...rendered)
    ctx.prefixIds = history.map((m) => m.id)
    ctx.prefixRender = rendered
    ctx.lastTokens = tokenCount
    ctx.needFull = false
  }

  const nudge = res.nudge
  if (nudge?.shouldInject) {
    const rendered = renderNudgeText(nudge)
    request.push(deps.tempMessage('user', rendered.text, sessionId))
  }

  // 原地替换待发消息
  messages.length = 0
  messages.push(...request)
}

/** 默认导出常量插件（默认配置） */
export const acpContextPlugin: AgentPlugin = createAcpContextPlugin()

/**
 * session.compacting hook 的处理核心（可单测纯函数）。
 *
 * 目标：在 core 物理删除历史窗口前，让 ACP 先把这个窗口折叠进自己的压缩块，
 * 从而即使原文被 session 压缩从会话历史删掉，ACP 的块/摘要仍保留该段的梗概，
 * decompress / search_context 依旧能对这段内容起作用。
 *
 * 策略（幂等）：
 * 1. 先水合压缩状态（若未水合）。
 * 2. 仅处理"尚未被 ACP 块覆盖"的窗口消息（复用 coveredMessageIds 判定，已覆盖即跳过 → 幂等）。
 * 3. 对未覆盖消息指派 refs，并整体折叠成一个摘要块（规则摘要兜底，随时可换成模型摘要）。
 * 4. 持久化状态到 session.meta；同时提供 summary 以让 core 复用、避免双份摘要。
 *
 * @returns Promise<boolean> 是否发生了折叠（true = 已处理并豁免 core 自行摘要）
 */
export async function runCompacting(deps: {
  sessionId: string
  input: CompactionContext
  getCtx: () => AcpSessionCtx
  engine: ReturnType<typeof createCore>
  config: AcpConfig
  meta: {
    read: () => Promise<Record<string, unknown> | undefined>
    patch: (patch: Record<string, unknown>) => Promise<void>
  }
  /** 为一段窗口生成规则摘要；缺省用首/尾文本拼接兜底 */
  ruleSummary?: (window: Message[]) => string
}): Promise<boolean> {
  const { sessionId, input, engine, config, meta } = deps
  const window = (input.window ?? []) as Message[]
  if (window.length === 0) return false
  const ctx = deps.getCtx()

  // 尚未水合则先恢复压缩状态（session 压缩可能在首轮 preModel 之前进入）
  if (!ctx.hydrated) {
    ctx.hydrated = true
    try {
      const saved = (await meta.read())?.[ACP_META_KEY] as CompressionState | undefined
      if (saved && typeof saved === 'object') {
        ctx.state = { ...createInitialState(), ...saved }
        ctx.stateSnapshot = JSON.stringify(ctx.state)
      }
    } catch {
      // 水合失败则从空状态开始
    }
  }

  // 幂等：先把窗口整体压平成 core，若其核心 id 已全部被 ACP 块覆盖，则已保全、无需再折叠
  const inflat = toCores(window)
  if (inflat.cores.length === 0) return false

  const covered = coveredMessageIds(ctx.state)
  const uncoveredCores = inflat.cores.filter((c) => !covered.has(c.id))
  if (uncoveredCores.length === 0) {
    // 整个窗口都已被 ACP 压缩块覆盖 → 已保全，无需再折叠
    input.windowHandled = true
    return false
  }
  // 只用"尚未覆盖"的片段折叠（避免与既有块重叠重复）
  const uncoveredFlat: import('./adapter.js').Flat = { cores: uncoveredCores, byId: inflat.byId, byBase: inflat.byBase }

  // 保留窗口原文到归档，保证折叠后 decompress 仍能还原该段全文
  for (const [coreId, orig] of inflat.byId) ctx.archive.set(coreId, orig)

  // 指派 refs（基于既有 map 继续增长），再对整段折叠成一个摘要块
  const nextIndex = highestUsedIndex(ctx.state.messageRefs) + 1
  const { map } = assignRefs(uncoveredCores, {
    existing: ctx.state.messageRefs,
    nextIndex,
  })
  const startRef = refForRaw(map, uncoveredCores[0]!.id)
  const endRef = refForRaw(map, uncoveredCores[uncoveredCores.length - 1]!.id)
  if (!startRef || !endRef) return false

  const summary = deps.ruleSummary
    ? deps.ruleSummary(window)
    : defaultRuleSummary(window)
  const applied = engine.applyCompression({
    ranges: [{ startRef, endRef, summary, topic: 'session 压缩折叠' }],
    messages: uncoveredFlat.cores,
    state: { ...ctx.state, messageRefs: map },
    config,
  })
  if (applied.result.blocksCreated === 0 && !input.summary) return false
  ctx.state = applied.state
  ctx.needFull = true

  // 持久化压缩状态（避免覆盖窗口后续仍可回溯）
  const nextSnapshot = JSON.stringify(ctx.state)
  if (ctx.stateSnapshot !== nextSnapshot) {
    ctx.stateSnapshot = nextSnapshot
    await meta.patch({ [ACP_META_KEY]: ctx.state })
  }

  // 已把窗口折叠进 ACP 块：让 core 复用它生成的摘要，避免双份摘要
  input.summary = summary
  input.windowHandled = true
  void sessionId
  return true
}

/** 窗口规则摘要兜底：首/尾消息文本拼接，控制在合理长度 */
export function defaultRuleSummary(window: Message[]): string {
  const head = textOf(window[0])
  const tail = window.length > 1 ? textOf(window[window.length - 1]) : undefined
  const joined = [head, tail ? `…\n${tail}` : ''].join('\n')
  return joined.length > 2000 ? `${joined.slice(0, 2000)}…` : joined
}

function textOf(m?: Message): string {
  if (!m) return ''
  return (m.parts as Array<{ type?: string; text?: string; input?: unknown; result?: unknown }>)
    .map((p) => {
      if (p.type === 'tool') return safeString(p.result ?? p.input)
      return p.text ?? ''
    })
    .filter((t) => typeof t === 'string')
    .join('\n')
}

/**
 * 还原一个压缩块所覆盖的原始消息全文（供 decompress）。
 * 通过状态里的"ref → core id → 归档 Message"反解；先试直接 id，再走 byRef。
 */
export function restoreBlockMessages(
  engine: ReturnType<typeof createCore>,
  state: CompressionState,
  archive: Map<string, Message>,
  blockId: string,
): DecompressOutput['originalMessages'] {
  const block = engine.decompress(blockId, state)
  if (!block) return []

  const out: DecompressOutput['originalMessages'] = []
  const seen = new Set<string>()
  const ids = [...(block.effectiveMessageIds ?? []), ...(block.directMessageIds ?? [])]
  for (const idOrRef of ids) {
    if (seen.has(idOrRef)) continue
    seen.add(idOrRef)
    let orig = archive.get(idOrRef)
    if (!orig) {
      const raw = state.messageRefs?.byRef?.[idOrRef]
      orig = raw ? archive.get(raw) : undefined
    }
    if (!orig) continue
    const text = (orig.parts as Array<{ type?: string; text?: string; input?: unknown; result?: unknown }>)
      .map((p) => {
        if (p.type === 'tool') return safeString(p.result ?? p.input)
        return p.text ?? ''
      })
      .filter((t) => typeof t === 'string')
      .join('\n')
    out.push({ id: orig.id, role: orig.role, text })
  }
  return out
}