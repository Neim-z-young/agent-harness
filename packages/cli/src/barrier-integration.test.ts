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
 *   `bus.publish` 同步调用订阅者（bus/src/index.ts:177，async 包装无前置 await），而 subagent
 *   的 `bus.publish(completed)`（:834）排在 `enqueueNotification`（:864）**之前** ⇒ CLI 收到
 *   `<continue/>` 时通知还没入队 ⇒ 续轮决策前**必须让出宏任务**再 peek，否则会把真正的后台
 *   结果误判为空转、整条吞掉（S4 的空转识别因此设计，此前从未实测过这条时序）。
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
  it('后台任务集齐后真实注入 <continue/>，空转识别不吞通知', async () => {
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

      // 【时序实证】事件同步到达时通知**尚未入队** —— 此刻同步 peek 必然读到空队列，
      // 若 CLI 在这里同步决策就会误判空转、吞掉真正的后台结果。
      expect(injected).toEqual(['<continue/>'])
      expect<string[] | null>(peekAtBarrier).toEqual([])

      // ── 真实续轮（等价 REPL 的 rl.emit('line', '<continue/>')）──
      const r = await processLine('<continue/>')
      expect(r).toBe('continue')

      // 空转识别没有误吞：没有「跳过」提示，模型真的被续轮调用（defaultResponse 渲染进输出）
      expect(out.join('')).not.toContain('跳过本次自动续轮')
      expect(out.join('')).toContain('等待后台任务完成')
      // 通知已被本轮 drain 消费（即：确实作为上下文送进了这一轮推理）
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
