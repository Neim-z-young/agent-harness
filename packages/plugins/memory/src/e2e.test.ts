/**
 * 端到端：文件 → 插件注入 → **模型请求**（而不是只验证 hook 被调用）。
 *
 * 用真实 core 装配（`createHarness`）+ 探针 Provider 捕获请求体，覆盖整条链路：
 *   ctx.workspace（core 注入） → 读 AGENTS.md / MEMORY.md → prompt.system.transform
 *   → system 消息 → provider.stream 收到的 messages
 *
 * 同时验证决策 B6：subagent 跑同一链路时**不带**记忆。
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarness } from '@harness/core'
import { resolveWorkspace } from '@harness/workspace'
import type { AgentDefinition, ChatProvider, Message } from '@harness/core'
import { createMemoryPlugin } from './index'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 探针 Provider：记录每次请求的 messages，立即返回一段文本 */
function probeProvider(sink: Message[][]): ChatProvider {
  return {
    id: 'probe',
    async *stream(params: { messages: Message[] }) {
      sink.push(params.messages)
      yield { type: 'text_delta', text: '收到' } as const
      yield { type: 'done', model: 'probe', finish: 'stop' } as const
    },
  } as unknown as ChatProvider
}

async function setup(memory: string, opts: { withAgentsMd?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mem-e2e-'))
  dirs.push(dir)
  const cwd = join(dir, 'proj')
  const dataDir = join(dir, 'store')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(dataDir, 'memory'), { recursive: true })
  writeFileSync(join(dataDir, 'memory', 'MEMORY.md'), memory)
  if (opts.withAgentsMd) writeFileSync(join(cwd, 'AGENTS.md'), '项目约定：提交前跑 typecheck')

  const workspace = resolveWorkspace({ cwd, dataDir })
  const sink: Message[][] = []
  const agents: AgentDefinition[] = [
    { id: 'default', name: 'd', description: 'd', mode: 'primary', tools: [], permission: { '*': 'allow' } },
    { id: 'sub', name: 's', description: 's', mode: 'subagent', tools: [], permission: { '*': 'allow' } },
  ]
  const h = await createHarness({
    cwd,
    workspace,
    agents,
    chatProvider: probeProvider(sink),
  })
  await h.plugin.loadInternal([createMemoryPlugin()])
  return { h, sink, cwd, dataDir }
}

/** 取出请求里 system 消息的文本 */
function systemTextOf(messages: Message[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => m.parts.map((p) => (p as { text?: string }).text ?? '').join('\n'))
    .join('\n')
}

describe('端到端：记忆真的到达模型请求', () => {
  it('主 Agent：system 里出现 <memory> 段，含索引与项目指令内容', async () => {
    const { h, sink } = await setup('用户偏好：回复用中文', { withAgentsMd: true })
    const sess = await h.session.create()
    for await (const _ of h.agent.queryStream({ sessionId: sess.id, agentId: 'default', message: 'hi' })) {
      void _
    }
    expect(sink.length).toBeGreaterThan(0)
    const sys = systemTextOf(sink[0]!)
    expect(sys).toContain('<memory>')
    expect(sys).toContain('用户偏好：回复用中文')
    expect(sys).toContain('项目约定：提交前跑 typecheck')
    await h.stop()
  })

  it('决策 B6：subagent 的请求里不含记忆（隔离）', async () => {
    const { h, sink } = await setup('不该进子 Agent 的记忆')
    const sess = await h.session.create()
    for await (const _ of h.agent.queryStream({ sessionId: sess.id, agentId: 'sub', message: 'hi' })) {
      void _
    }
    const sys = systemTextOf(sink[0]!)
    expect(sys).not.toContain('不该进子 Agent 的记忆')
    expect(sys).not.toContain('<memory>')
    await h.stop()
  })

  it('索引为空文件时也不注入（零噪声）', async () => {
    const { h, sink } = await setup('   ')
    const sess = await h.session.create()
    for await (const _ of h.agent.queryStream({ sessionId: sess.id, agentId: 'default', message: 'hi' })) {
      void _
    }
    expect(systemTextOf(sink[0]!)).not.toContain('<memory>')
    await h.stop()
  })
})
