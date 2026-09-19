/**
 * `agent.stream` hook 的端到端验证：CLI 真的把**归约后**的状态广播给了插件。
 *
 * 这是「Herdr 集成做成插件」能成立的前提 —— 该 hook 是插件化唯一需要新增的引擎侧入口，
 * 若它没被触发，插件就只是个空壳。故这里不 mock hook 调用，而是走真实 processLine 链路。
 *
 * 注意分层：`agent.stream` 是 **UI 消费层**的通道（本文件验证的就是它，UI 收 busy/idle 靠它）；
 * 引擎层的整轮终态走另一条 hook **`agent.turn.end`**（core 广播，任何宿主都有，
 * 见 core/src/agent-turn-end.test.ts）。两条通道刻意不混 —— 终态若两层都发，
 * 消费方分不清来源，按轮计数的逻辑会被计两次。
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessApp, createProcessLine } from './index'
import { defineTool } from '@harness/core'
import type { AgentPlugin, AgentStreamSignal } from '@harness/plugin'

describe('agent.stream hook（外部集成入口）', () => {
  it('多步链路中按事件广播归约后的状态，末事件为 idle+finish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-stream-'))
    try {
      const seen: AgentStreamSignal[] = []
      const probe: AgentPlugin = {
        id: 'probe.agent-stream',
        version: '0.0.0',
        name: 'probe',
        async install() {
          return {
            'agent.stream': (s) => {
              seen.push(JSON.parse(JSON.stringify(s)) as AgentStreamSignal)
            },
          }
        },
      }

      const app = new HarnessApp({
        cwd: dir,
        dataDir: join(dir, '.harness'),
        agentId: 'default',
        provider: 'mock',
        permissionMode: 'allow-all',
        stdout: { write: () => {} },
        extraPlugins: [probe],
        mockProviderConfig: {
          defaultResponse: '完成',
          responses: [
            {
              match: '干活',
              once: true,
              toolCalls: [{ toolUseId: 'tu1', toolId: 'echo', input: { msg: 'hi' } }],
            },
          ],
        },
      })
      const { harness } = await app.boot()
      harness.tools.register(
        defineTool({
          id: 'echo',
          description: '回显',
          inputSchema: {
            parse: (v: unknown) => v as { msg: string },
            safeParse: (v: unknown) => ({ success: true as const, data: v as { msg: string } }),
          },
          isReadOnly: () => true,
          async call(input: { msg: string }) {
            return { ok: true as const, output: { reply: `echo:${input.msg}` } }
          },
        }),
      )
      const sess = await harness.session.create()

      const out: string[] = []
      const processLine = createProcessLine({ app, harness, session: sess, out: (s) => out.push(s) })
      await processLine('干活')

      // 广播确实发生了（不是空壳）
      expect(seen.length).toBeGreaterThan(2)
      // 每个信号都带会话 ID（外部集成长按它做会话关联/恢复）
      expect(seen.every((s) => s.sessionId === sess.id)).toBe(true)
      // turn_end（UI 状态流：整轮结束 ⇒ idle）**恰好一次**：这条通道只由 CLI 触发，
      // 引擎终态在另一条 hook（agent.turn.end），两边都发会让按轮计数的消费方翻倍
      expect(seen.filter((s) => s.eventType === 'turn_end')).toHaveLength(1)
      // 归约结果里有「工具执行中」这一态（外部 UI 最关心的状态之一）
      expect(seen.some((s) => s.status.phase === 'tool')).toBe(true)
      // 事件类型透传（供排障；插件一般不用，但要有）
      expect(seen.some((s) => s.eventType === 'tool_call_start')).toBe(true)
      // 末事件：整轮结束 ⇒ idle + 结束原因（Herdr 据此报 idle）
      const last = seen[seen.length - 1]!
      expect(last.status.phase).toBe('idle')
      expect(last.status.finish).toBe('stop')
      expect(last.eventType).toBe('turn_end')
      // 多步：至少有一个信号落在第 2 步（证明引擎内自主续轮也被覆盖）
      expect(seen.some((s) => s.status.step === 2)).toBe(true)

      await app.shutdown()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
