import { describe, it, expect } from 'bun:test'
import { USAGE_STATS_KEY, usageFromMessages } from '@harness/usage'
import {
  createHarness,
  defineTool,
  type AgentDefinition,
  type AgentStreamEvent,
  type ChatProvider,
  type ChatStreamChunk,
} from './index'

/**
 * 用量纳管的引擎层不变量。
 *
 * 背景：累加与写盘此前**只有 TUI**（`tui.tsx` 模块 4）在做，于是 headless / REPL 宿主与
 * 子 agent 会话完全没有 `meta.usageStats`（真机：6 个子会话约 1.5M 输入 token 不入账）。
 * 现在引擎每步折叠一条 assistant 消息，因此必须守住三条：
 *
 * 1. **累加正确**（LLM 调用 / tool 归因）；
 * 2. **幂等** —— 再 prompt 一次不得把历史重新折一遍（否则就是"重连后清零"的反面：翻倍）；
 * 3. **自愈** —— 检查点被外部改写（`/compact`、`deleteMessage`）后按消息全量重建，
 *    且结果与增量口径**完全一致**（两条路径共用 `foldMessage`）。
 */

const agent: AgentDefinition = {
  id: 'default',
  name: 'usage 测试 Agent',
  description: 'd',
  mode: 'primary',
  tools: ['*'],
  permission: { '*': 'allow' },
  promptFragments: ['You are a test agent.'],
}

const echoTool = defineTool({
  id: 'echo',
  description: '回显 msg',
  inputSchema: {
    parse: (v: unknown) => v as { msg: string },
    safeParse: (v: unknown) => ({ success: true as const, data: v as { msg: string } }),
  },
  isReadOnly: () => true,
  async call(input: { msg: string }) {
    return { ok: true as const, output: { reply: `echo:${input.msg}` } }
  },
})

/** 带 tokenUsage 的剧本：便于断言引擎折叠出的数字 */
const toolCallChunks: ChatStreamChunk[] = [
  { type: 'tool_use_start', toolUseId: 'tu_1', toolId: 'echo' },
  { type: 'tool_use_delta', inputDelta: '{"msg":"hi"}' },
  { type: 'tool_use_stop', toolUseId: 'tu_1' },
  { type: 'done', model: 'm', finish: 'tool_calls', finishRaw: 'tool_calls', tokenUsage: { input: 100, output: 20, cacheRead: 80 } },
]

const finalTextChunks: ChatStreamChunk[] = [
  { type: 'text_delta', text: 'ok' },
  { type: 'done', model: 'm', finish: 'stop', finishRaw: 'stop', tokenUsage: { input: 150, output: 10 } },
]

/**
 * 纯文本回复且**不回报用量**（provider 未给 usage 字段 / 流式中断）。
 *
 * 价值：它折叠之后**累积器完全为空**（llmCalls=0 / hourly=[] / tools=[]），而检查点仍然有效 ——
 * 这是「累积器为空」与「检查点有效」同时成立的唯一现实形态，正是双计缺陷的触发条件。
 */
const plainNoUsageChunks: ChatStreamChunk[] = [
  { type: 'text_delta', text: 'hi' },
  { type: 'done', model: 'm', finish: 'stop', finishRaw: 'stop' },
]

const plainUsage150Chunks: ChatStreamChunk[] = [
  { type: 'text_delta', text: 'again' },
  { type: 'done', model: 'm', finish: 'stop', finishRaw: 'stop', tokenUsage: { input: 150, output: 10 } },
]

function scriptedProvider(
  script: ChatStreamChunk[][],
): ChatProvider & { calls: number } {
  const p = {
    id: 'scripted',
    calls: 0,
    async complete() {
      throw new Error('本测试只走流式路径')
    },
    async *stream() {
      const chunks = script[Math.min(p.calls, script.length - 1)]
      p.calls++
      for (const c of chunks) yield c
    },
  }
  return p
}

async function collect(gen: AsyncGenerator<AgentStreamEvent, void, unknown>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

async function setup() {
  // 剧本按需重复最后一段（越界回落），这里给足四段：两轮各两步（工具 → 收尾）
  const provider = scriptedProvider([toolCallChunks, finalTextChunks, toolCallChunks, finalTextChunks])
  const h = await createHarness({ agents: [agent], chatProvider: provider })
  h.tools.register(echoTool)
  const sess = await h.session.create()
  return { h, provider, sess }
}

/** 取「活的」会话对象（session.get 返回内存中的同一份，消息已就位） */
const liveSession = async (h: Awaited<ReturnType<typeof createHarness>>, id: string) => {
  const s = await h.session.get(id)
  if (!s) throw new Error('session 不存在')
  return s
}

describe('用量纳管：引擎层折叠', () => {
  it('每步折叠：LLM 用量按步累加，工具调用被记录且归并到本步用量', async () => {
    const { h, sess } = await setup()
    await collect(h.session.promptStream(sess.id, 'go', 2))

    const u = await h.usage.get(sess.id)
    expect(u.llmCalls).toBe(2)
    expect(u.inputTokens).toBe(250)
    expect(u.outputTokens).toBe(30)
    expect(u.cacheReadTokens).toBe(80)

    const echo = u.tools.find((t) => t.tool === 'echo')!
    expect(echo.count).toBe(1)
    // 「本步 LLM 用量归并到紧随的首个工具」：第一步（100/20）归到 echo；第二步无工具
    expect(echo.inputTokens).toBe(100)
    expect(echo.outputTokens).toBe(20)
    await h.stop()
  })

  it('写进 meta[usageStats] 且带检查点（供下次增量折叠）', async () => {
    const { h, sess } = await setup()
    await collect(h.session.promptStream(sess.id, 'go', 1))

    const live = await liveSession(h, sess.id)
    expect(live.meta?.[USAGE_STATS_KEY]).toBeDefined()
    const ck = live.meta?.['usageFold'] as { upToMessageId?: string } | undefined
    expect(typeof ck?.upToMessageId).toBe('string')
    // 检查点必须指向真实存在的消息（否则下次会被判为失效而重建）
    expect(live.messages.some((m) => m.id === ck!.upToMessageId)).toBe(true)
    await h.stop()
  })

  it('幂等：同一会话再 prompt 一次，历史不被重复折叠（llmCalls == 实际调用数）', async () => {
    const { h, provider, sess } = await setup()
    await collect(h.session.promptStream(sess.id, 'go', 2))
    await collect(h.session.promptStream(sess.id, 'again', 2))

    expect(provider.calls).toBe(4)
    const u = await h.usage.get(sess.id)
    const live = await liveSession(h, sess.id)
    // 若把历史重折一遍会得到 6；正确值是 4
    expect(u.llmCalls).toBe(4)
    // 与「按消息全量重建」完全一致 —— 增量与重建必须是同一个口径
    expect(u.llmCalls).toBe(usageFromMessages(live.messages).llmCalls)
    expect(u.inputTokens).toBe(usageFromMessages(live.messages).inputTokens)
    await h.stop()
  })

  it('自愈：检查点指向的消息不存在时全量重建，不翻倍也不抛错', async () => {
    const { h, provider, sess } = await setup()
    await collect(h.session.promptStream(sess.id, 'go', 2))

    // 模拟 /compact、deleteMessage 之类的外部改写把检查点弄脏
    await h.session.updateMeta(sess.id, {
      usageFold: { upToMessageId: 'ghost-does-not-exist', state: { pending: null, attributed: false } },
    })

    await collect(h.session.promptStream(sess.id, 'third', 1))
    const u = await h.usage.get(sess.id)
    const live = await liveSession(h, sess.id)
    expect(u.llmCalls).toBe(provider.calls)
    expect(u.llmCalls).toBe(usageFromMessages(live.messages).llmCalls)
    // 自愈后检查点必须被修复（下一轮回到增量路径）
    const ck = (await liveSession(h, sess.id)).meta?.['usageFold'] as { upToMessageId?: string }
    expect(live.messages.some((m) => m.id === ck?.upToMessageId)).toBe(true)
    await h.stop()
  })

  it('回归：「累积器存在但为空」不得回退到按消息重建（否则当前消息被折两遍）', async () => {
    // 触发条件（真机可达）：provider 未回报用量 + 该轮没有工具调用 ⇒ 折叠后累积器恰好完全为空
    // （llmCalls=0 / hourly=[] / tools=[]），但检查点有效并指向真实消息。
    // 修复前：下一轮走「累积器为空 ⇒ 按消息重建」，而重建用的 messages **已含当前消息**，
    // 再 fold 一次 ⇒ 双计（实测 llmCalls 2 / input 300，正确值 1 / 150）。
    // 判据：必须区分「累积器存在但为空」（合法 → 直接增量）与「字段缺失」（→ 重建）。
    const provider = scriptedProvider([plainNoUsageChunks, plainUsage150Chunks])
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(echoTool)
    const sess = await h.session.create()

    await collect(h.session.promptStream(sess.id, 'turn1', 1))
    // 前提必须成立，否则本用例没打到目标分支（避免"测试绿但没测到东西"）
    const mid = await liveSession(h, sess.id)
    expect(mid.meta?.[USAGE_STATS_KEY]).toMatchObject({ llmCalls: 0 })
    const ck1 = mid.meta?.['usageFold'] as { upToMessageId?: string } | undefined
    expect(mid.messages.some((m) => m.id === ck1?.upToMessageId)).toBe(true)

    await collect(h.session.promptStream(sess.id, 'turn2', 1))
    const u = await h.usage.get(sess.id)
    const live = await liveSession(h, sess.id)
    expect(u.llmCalls).toBe(1)
    expect(u.inputTokens).toBe(150)
    // 增量口径仍须与全量重建一致
    expect(u.llmCalls).toBe(usageFromMessages(live.messages).llmCalls)
    await h.stop()
  })

  it('meta 被外部写坏（非对象/垃圾值）时不抛错，用量仍可算', async () => {
    const { h, sess } = await setup()
    await h.session.updateMeta(sess.id, { [USAGE_STATS_KEY]: 'garbage', usageFold: 42 })
    await collect(h.session.promptStream(sess.id, 'go', 1))

    const u = await h.usage.get(sess.id)
    expect(u.llmCalls).toBe(1)
    await h.stop()
  })

  it('usage.children 按 Session.parentId 反查子会话（供"含子 agent"聚合）', async () => {
    const { h, sess } = await setup()
    // parentId 是 **Session 顶层字段**（不是 meta）：与 subagent 插件派生、落盘/恢复口径一致
    const child = await h.session.create({ parentId: sess.id })

    expect(await h.usage.children(sess.id)).toEqual([child.id])
    expect(await h.usage.children(child.id)).toEqual([])
    // 落盘字段位置也要一致（真机核对过：子会话 json 顶层有 parentId、meta 里没有）
    expect((await h.session.get(child.id))?.parentId).toBe(sess.id)
    await h.stop()
  })

  it('不存在的会话：usage.get 返回空累积器（不抛）', async () => {
    const { h } = await setup()
    const u = await h.usage.get('s_not_exist')
    expect(u.llmCalls).toBe(0)
    await h.stop()
  })
})

// ===== Provider 维度：引擎把「这次调用走了哪个端点」写进消息 meta =====
//
// 这个字段必须落在**消息 meta**（与 model 同位），不能只写进 meta.usageStats：
// 引擎的累加有两条入口（`accumulateUsage` 增量折叠 / 自愈时 `rebuildUsage(消息)` 全量重建），
// 后者只看得见消息上的字段 —— 只写累加器会让自愈那一刻把整个维度丢掉。
// 下面第 3 条用例就是钉住这个不变量的。

describe('用量纳管：Provider 维度', () => {
  it("未指定端点 ⇒ 消息 meta 记 'default' 哨兵，统计按 'default' 归并", async () => {
    const { h, sess } = await setup()
    await collect(h.session.promptStream(sess.id, 'go', 2))

    const u = await h.usage.get(sess.id)
    expect(u.providers).toHaveLength(1)
    expect(u.providers[0]).toMatchObject({ provider: 'default', calls: 2, inputTokens: 250, outputTokens: 30 })
    // 不变量：Provider 是**全覆盖分区** —— 各行 calls 之和恒等于 llmCalls
    expect(u.providers.reduce((s, p) => s + p.calls, 0)).toBe(u.llmCalls)

    const assistants = (await liveSession(h, sess.id)).messages.filter((m) => m.role === 'assistant')
    expect(assistants.length).toBe(2)
    for (const m of assistants) expect(m.meta?.providerId).toBe('default')
    await h.stop()
  })

  it('显式 providerId ⇒ 按实例路由键归并（同一模型挂多端点时能分开算账）', async () => {
    const provider = scriptedProvider([toolCallChunks, finalTextChunks])
    const h = await createHarness({
      agents: [{ ...agent, model: { providerId: 'p1', modelId: 'm' } }],
      chatProvider: provider,
    })
    h.tools.register(echoTool)
    const sess = await h.session.create()
    await collect(h.session.promptStream(sess.id, 'go', 2))

    const u = await h.usage.get(sess.id)
    expect(u.providers.map((p) => p.provider)).toEqual(['p1'])
    expect(u.providers[0]!.calls).toBe(2)
    expect((await liveSession(h, sess.id)).messages.find((m) => m.role === 'assistant')?.meta?.providerId).toBe('p1')
    await h.stop()
  })

  it('自愈（全量重建）不丢 Provider 维度：重建值必须等于增量值', async () => {
    const { h, sess } = await setup()
    await collect(h.session.promptStream(sess.id, 'go', 2))

    // 弄脏检查点（模拟 /compact、deleteMessage 这类外部改写）⇒ 下一轮走 rebuildUsage(消息)
    await h.session.updateMeta(sess.id, {
      usageFold: { upToMessageId: 'ghost-does-not-exist', state: { pending: null, attributed: false } },
    })
    await collect(h.session.promptStream(sess.id, 'third', 1))

    const u = await h.usage.get(sess.id)
    const live = await liveSession(h, sess.id)
    expect(u.providers).toEqual(usageFromMessages(live.messages).providers)
    expect(u.providers.length).toBeGreaterThan(0)
    expect(u.providers.reduce((s, p) => s + p.calls, 0)).toBe(u.llmCalls)
    await h.stop()
  })
})

// ===== core.llm.usage：引擎把 provider 用量广播给插件（P3 的前提）=====
//
// 这条通道此前**根本不存在**：`@harness/acp-context` 的 `buildProviderCacheEvent` 注释写着
// "由 core 层追加"，但全仓没有调用方 ⇒ provider 侧缓存命中一直没有数据。没有它，就没法回答
// "ACP 手册按需注入会不会影响缓存命中"这类问题（本次改造要能回答的第一个问题）。

describe('core.llm.usage 广播', () => {
  it('每次 LLM 调用后触发，带 input/output 与缓存字段', async () => {
    const seen: Array<Record<string, unknown>> = []
    const provider = scriptedProvider([toolCallChunks, finalTextChunks])
    const h = await createHarness({ agents: [agent], chatProvider: provider })
    h.tools.register(echoTool)
    await h.plugin.loadInternal([
      {
        id: 'probe.llm-usage',
        version: '0.0.0',
        name: 'probe',
        async install() {
          return {
            'core.llm.usage': (s: unknown) => {
              seen.push(JSON.parse(JSON.stringify(s)) as Record<string, unknown>)
            },
          }
        },
      },
    ])
    const sess = await h.session.create()
    await collect(h.session.promptStream(sess.id, 'go', 2))

    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ sessionId: sess.id, step: 1, input: 100, output: 20, cacheRead: 80 })
    // 第二步没有 cacheRead 字段（剧本未给）⇒ 不该凭空补 0（分辨"未返回"与"返回 0"）
    expect(seen[1]).toMatchObject({ step: 2, input: 150, output: 10 })
    expect(seen[1]!.cacheRead).toBeUndefined()
    await h.stop()
  })
})
