/**
 * 真实场景 barrier 集成测试：subagent 后台 → coordinator 集齐 → `<continue/>` → 续轮。
 *
 * 与 cli.test.ts 既有用例的区别：那里是手工 `enqueueNotification` / 手工 `publish` 事件，
 * 只验证「续轮决策」单环；这里走**真实插件链**——subagent 工具真的后台派发、coordinator
 * 真的计数集齐、事件真的从 `subagent.completed` 链式触发——覆盖三层职责的全部接缝：
 *
 *   subagent（后台执行 + 通知入队） → coordinator（barrier 计数 + 事件） → CLI（注入 + 空转识别）
 *
 * 核心时序事实（源码推导，本测试实证）：
 *   `bus.publish` 同步调用订阅者（bus/src/index.ts:177，async 包装无前置 await）。subagent 采取
 *   **先入队、后发事件**：`enqueueNotification()` 排在 `bus.publish(completed)` **之前** ⇒
 *   barrier 事件到达时通知**已经在队列里** ⇒ CLI 续轮前 peek 不会读到空队列，也就不会把真正的
 *   后台结果误判为空转、整条吞掉。
 *
 * ⚠️ 本用例**曾经反过来断言过**（`peekAtBarrier` 应为 `[]`）—— 那时代码是"先发事件后入队"，
 *   真机上因此把已经跑完的结果滞留了 3 分 03 秒（s_1790082671456_82ikm：4 个 reader 21:22:15
 *   全部完成，通知 21:25:16 才随用户敲「?」进入对话）。续 191 修的就是这条，本断言现在是
 *   **回归闸门**：一旦有人把顺序换回去，这里会立刻失败。
 *
 * ⚠️ 2026-09-30 起本用例的**后半段语义变了**：引擎新增「回合结束闸门」（subagent 插件声明
 *   `waitAtTurnEnd` ⇒ 模型收尾时若还有后台任务，引擎在轮内等到结果到达、drain 进对话后继续
 *   本轮）。于是结果**不再需要**靠这一行 `<continue/>` 送达 —— 注入照常发生（事件源没变），
 *   但走到内核时队列已空，`<continue/>` 退化为一次空转。本用例据此改为断言"**结果进了对话**"
 *   这一更强的事实（旧版只能断言"队列里还有、等着被取走"）。
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessApp, attachAutoContinue, createProcessLine } from './index'
import { createSubagentPlugin } from '@harness/subagent'
import { createCoordinatorPlugin, CoordinatorEvents } from '@harness/coordinator'
import type { AgentDefinition } from '@harness/core'

/** 轮询等待条件成立（barrier 事件是异步到达的） */
async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时：barrier 事件未到达')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 子 Agent：无工具，一步完成（defaultResponse 立即返回） */
const researcher: AgentDefinition = {
  id: 'researcher',
  name: '调研员',
  description: 'd',
  mode: 'subagent',
  tools: [],
  permission: { '*': 'allow' },
  promptFragments: ['你是调研员，直接给出结论。'],
}

describe('真实 barrier 场景（subagent 后台 → coordinator → <continue/> → 续轮）', () => {
  it('后台任务集齐后真实注入 <continue/>；结果已由引擎在轮内送达', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-barrier-'))
    try {
      const app = new HarnessApp({
        cwd: dir,
        dataDir: join(dir, '.harness'),
        agentId: 'default',
        provider: 'mock',
        permissionMode: 'allow-all',
        stdout: { write: () => {} },
        agents: [researcher],
        extraPlugins: [createSubagentPlugin(), createCoordinatorPlugin()],
        mockProviderConfig: {
          defaultResponse: '等待后台任务完成。',
          responses: [
            {
              // 父 Agent 第一步：后台派发（once 保证只在首步命中，内部循环的第二步自然收敛为文本）
              match: '派个后台调研',
              once: true,
              toolCalls: [
                {
                  toolUseId: 'tu_bg_1',
                  toolId: 'subagent',
                  input: {
                    agentId: 'researcher',
                    prompt: '调研 X 并给结论',
                    description: '调研 X',
                    runInBackground: true,
                  },
                },
              ],
            },
          ],
        },
      })
      const { harness } = await app.boot()
      const sess = await harness.session.create()

      // 时序探针：barrier 事件（同步）到达的那一刻，通知入队了吗？
      let peekAtBarrier: string[] | null = null
      const detachProbe = harness.bus.subscribe(CoordinatorEvents.barrierCompleted, () => {
        peekAtBarrier = harness.session.peekNotifications(sess.id)
      })
      // 真实 CLI 注入路径（REPL 里也是这个函数）
      const injected: string[] = []
      const detachContinue = attachAutoContinue(harness, (line) => injected.push(line))

      const out: string[] = []
      const processLine = createProcessLine({ app, harness, session: sess, out: (s) => out.push(s) })

      // ── 第一轮：模型后台派发（真实 subagent 工具执行，工具立即返回 taskId）──
      await processLine('派个后台调研任务')

      // 后台子 Agent 完成 → coordinator 集齐 → <continue/> 注入（异步到达）
      await waitFor(() => injected.length > 0)

      // 【时序实证】事件同步到达时通知**已经入队**（先入队、后发事件）——
      // 这才是 barrier 应有的语义：它说"全部完成"，那么结果就必须已经可取。
      expect(injected).toEqual(['<continue/>'])
      expect(peekAtBarrier ?? []).toHaveLength(1)

      // ── 引擎已接管送达：结果在**同一条 query 内**被 drain 进对话 ──
      //
      // 2026-09-30「回合结束闸门」之后的契约：subagent 插件声明 `waitAtTurnEnd` ⇒ lead 给出
      // 最终答复（无工具调用）时，引擎**原地等**后台结果（等待期间不调用模型），拿到通知后
      // 继续本轮。所以走到 `processLine('<continue/>')` 时队列已空 —— 这不是"吞了结果"，
      // 而是结果早已用掉（下面两条断言就是"没丢"的证据：它进了对话）。
      const stored = await harness.session.get(sess.id)
      const texts = (stored?.messages ?? []).flatMap((m) =>
        m.parts.map((p) => (p as { text?: string }).text ?? ''),
      )
      expect(texts.some((t) => t.includes('task-notification'))).toBe(true)

      // ── 真实续轮（等价 REPL 的 rl.emit('line', '<continue/>')）──
      // 现在是一次**空转**：注入照常发生（事件源不变），但内核读到空队列就跳过，不再多跑一轮。
      const r = await processLine('<continue/>')
      expect(r).toBe('continue')
      expect(out.join('')).toContain('跳过本次自动续轮')
      expect(out.join('')).toContain('等待后台任务完成') // 确认第一轮真的跑过（defaultResponse 渲染）
      expect(harness.session.peekNotifications(sess.id)).toEqual([])

      detachProbe()
      detachContinue()
      await app.shutdown()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('没有后台任务时 barrier 不触发（无事不扰）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-barrier-idle-'))
    try {
      const app = new HarnessApp({
        cwd: dir,
        dataDir: join(dir, '.harness'),
        agentId: 'default',
        provider: 'mock',
        permissionMode: 'allow-all',
        stdout: { write: () => {} },
        agents: [researcher],
        extraPlugins: [createSubagentPlugin(), createCoordinatorPlugin()],
        mockProviderConfig: { defaultResponse: '普通回答' },
      })
      const { harness } = await app.boot()
      const sess = await harness.session.create()

      const injected: string[] = []
      const detach = attachAutoContinue(harness, (line) => injected.push(line))

      // 普通同步子 Agent 调用（不经后台）不应触发 barrier
      const subTool = harness.tools.get('subagent')
      expect(subTool).toBeDefined()
      await subTool!.call(
        { agentId: 'researcher', prompt: '前台调研', description: '前台' },
        { sessionId: sess.id, agentId: 'default', messageId: 'm1', toolUseId: 'tu1', signal: new AbortController().signal, variables: {}, cwd: dir, requestPermission: async () => ({ behavior: 'allow' }) } as never,
      )
      // 给事件链留出传播窗口
      await new Promise((r) => setTimeout(r, 100))

      expect(injected).toEqual([]) // 前台派发不集齐 barrier ⇒ 不注入
      detach()
      await app.shutdown()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
