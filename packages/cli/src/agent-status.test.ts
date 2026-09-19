/**
 * Agent 状态机测试。
 *
 * 状态机是纯函数，故可在无 UI 的环境下完整验证 —— 这也是把它从 tui.tsx 里抽出来的
 * 主要理由：UI 只负责渲染，状态推导的正确性在这里锁定。
 */
import { describe, it, expect } from 'bun:test'
import {
  formatAgentPhase,
  formatAgentStatus,
  initialAgentStatus,
  isAgentBusy,
  reduceAgentStatusAll,
  type AgentStatus,
} from './agent-status'
import type { AgentStreamEvent } from '@harness/core'

const identity = { agentId: 'coordinator', agentName: '编排者', mode: 'coordinator' }

const ev = (o: Partial<AgentStreamEvent> & { type: AgentStreamEvent['type'] }): AgentStreamEvent =>
  o as AgentStreamEvent

describe('agent 状态机', () => {
  it('初始为空闲', () => {
    const s = initialAgentStatus(identity)
    expect(s.phase).toBe('idle')
    expect(isAgentBusy(s)).toBe(false)
  })

  it('典型多步链：推理 → 工具 → 输出 → 下一步 → 整轮结束', () => {
    const s = reduceAgentStatusAll(identity, [
      ev({ type: 'reasoning_delta', text: '想' }),
      ev({ type: 'tool_call_start', toolId: 'bash', toolUseId: 'tu1', input: {} }),
      ev({ type: 'tool_call_result', toolId: 'bash', toolUseId: 'tu1', result: 'ok' }),
      ev({ type: 'done', step: 1, finish: 'tool_calls' }),
      ev({ type: 'text_delta', text: '完成' }),
      ev({ type: 'done', step: 2, finish: 'stop' }),
      ev({ type: 'turn_end' }),
    ])
    // 步号停在末步；整轮结束后回到空闲
    expect(s.step).toBe(2)
    expect(s.phase).toBe('idle')
    expect(s.finish).toBe('stop')
    // 工具执行过 ⇒ 状态里留着工具名（供统计行回显）
    expect(s.toolId).toBe('bash')
  })

  it('工具执行中：phase=tool 且携带工具名', () => {
    const s = reduceAgentStatusAll(identity, [
      ev({ type: 'tool_call_start', toolId: 'read_file', toolUseId: 'tu1', input: {} }),
    ])
    expect(s.phase).toBe('tool')
    expect(s.toolId).toBe('read_file')
    expect(isAgentBusy(s)).toBe(true)
    expect(formatAgentPhase(s)).toBe('工具·read_file')
  })

  it('工具返回后回到"推理"而非空闲（同一 Turn 内模型仍在工作）', () => {
    const s = reduceAgentStatusAll(identity, [
      ev({ type: 'tool_call_start', toolId: 'bash', toolUseId: 'tu1', input: {} }),
      ev({ type: 'tool_call_result', toolId: 'bash', toolUseId: 'tu1', result: '', isError: true }),
    ])
    // 出错时保持在 tool 态（便于显示"卡在哪个工具上"）；成功则回到 thinking
    expect(s.phase).toBe('tool')
    const ok = reduceAgentStatusAll(identity, [
      ev({ type: 'tool_call_start', toolId: 'bash', toolUseId: 'tu1', input: {} }),
      ev({ type: 'tool_call_result', toolId: 'bash', toolUseId: 'tu1', result: 'ok' }),
    ])
    expect(ok.phase).toBe('thinking')
  })

  it('中断：done.aborted / turn_end.aborted 都记为已中断，且不会被 turn_end 冲掉', () => {
    const s = reduceAgentStatusAll(identity, [
      ev({ type: 'tool_call_start', toolId: 'bash', toolUseId: 'tu1', input: {} }),
      ev({ type: 'tool_call_result', toolId: 'bash', toolUseId: 'tu1', result: 'aborted', isError: true }),
      ev({ type: 'done', step: 1, aborted: true }),
      ev({ type: 'turn_end', aborted: true }),
    ])
    expect(s.phase).toBe('aborted')
    // 中断后不算忙（UI 应收起 spinner）
    expect(isAgentBusy(s)).toBe(false)
    expect(formatAgentPhase(s)).toBe('已中断')
  })

  it('异常路径也能收到 turn_end ⇒ 状态能回到空闲（不会一直显示忙）', () => {
    // core 用 try/finally 保证 turn_end 送达；这里验证归约器能正确处理"提前中断的事件流"
    const s = reduceAgentStatusAll(identity, [
      ev({ type: 'text_delta', text: '半截' }),
      ev({ type: 'turn_end' }),
    ])
    expect(s.phase).toBe('idle')
  })

  it('格式化：详细态含 agent / 模式 / 步数 / 结束原因', () => {
    const s: AgentStatus = {
      ...identity,
      phase: 'idle',
      step: 3,
      finish: 'stop',
    }
    const text = formatAgentStatus(s)
    expect(text).toContain('agent=coordinator(编排)')
    expect(text).toContain('第3步')
    expect(text).toContain('结束=stop')
  })

  it('格式化：primary 模式不显示模式后缀（避免噪音）', () => {
    expect(formatAgentStatus({ agentId: 'default', mode: 'primary', phase: 'idle' })).toBe(
      'agent=default',
    )
  })
})

// ===== 端到端：REPL 统计行确实带上了状态（不只有单测）=====

describe('agent 状态显示（REPL 统计行）', () => {
  it('多步工具链的统计行含步数与结束原因', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'agent-status-'))
    try {
      const { HarnessApp, createProcessLine } = await import('./index')
      const { defineTool } = await import('@harness/core')
      const app = new HarnessApp({
        cwd: dir,
        dataDir: join(dir, '.harness'),
        agentId: 'default',
        provider: 'mock',
        permissionMode: 'allow-all',
        stdout: { write: () => {} },
        mockProviderConfig: {
          defaultResponse: '完成',
          // 首步调工具 ⇒ 引擎内自主续轮第二步（文本收尾）
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

      const text = out.join('')
      // 统计行现在形如：⏱️ 12ms | agent=default · 第2步 · 结束=stop | model=…
      expect(text).toContain('agent=default')
      expect(text).toContain('第2步')
      expect(text).toContain('结束=stop')
      await app.shutdown()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
