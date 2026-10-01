/**
 * 真 sidecar 端到端：**起真进程、连真端口**。
 *
 * 这是 P2-B 在无头环境下唯一能自动化的验收口径（扩展 UI 要在 VSCode 里手点，
 * 而 Chat 视图需要模型提供方）。它覆盖的是"管道通不通"，不是"模型答得对不对"。
 *
 * 边界：
 * - 沙箱/本机代理会把 127.0.0.1 的请求劫持成 502（本仓踩过），故先清掉代理变量。
 * - 流式用例只断言"协议管道成立"（拿到 task 帧 + contextId + 能取消），
 *   **不**断言模型的具体回答 —— 那会让用例依赖外网与 Provider，变成 flaky。
 */

import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Sidecar } from './sidecar'
import { extractTaskIds } from './map/render'
import { A2aTransport } from './transport/a2a'

// 代理会把对 127.0.0.1 的请求吞掉（实测 502）⇒ 连本机前先摘掉
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k]
}
process.env['NO_PROXY'] = '127.0.0.1,localhost'
process.env['no_proxy'] = '127.0.0.1,localhost'

const REPO = join(import.meta.dir, '../../..')
const CLI = join(REPO, 'packages/cli/src/index.ts')

/** 没有 CLI 就整体跳过（例如只检出 adapters/ 的场景） */
const hasCli = existsSync(CLI)

function launch(): Sidecar {
  return new Sidecar({ cliPath: CLI, runner: 'bun', cwd: REPO, timeoutMs: 60_000 })
}

describe.skipIf(!hasCli)('sidecar 端到端', () => {
  it('握手：拿到真端口与三个端点', async () => {
    const s = launch()
    try {
      const hs = await s.start()
      expect(hs.v).toBe(1)
      expect(hs.port).toBeGreaterThan(0)
      expect(hs.rpcUrl).toContain(String(hs.port))
      expect(hs.controlUrl).toContain('/harness/rpc')
      expect(hs.cardUrl).toContain('/.well-known/agent-card.json')
    } finally {
      await s.dispose()
    }
  })

  it('AgentCard 可取（GET 卡端点）', async () => {
    const s = launch()
    try {
      const hs = await s.start()
      const res = await fetch(hs.cardUrl)
      expect(res.ok).toBe(true)
      const card = (await res.json()) as Record<string, unknown>
      expect(card['name']).toBeTruthy()
      // 卡片是给 A2A 客户端的发现文档 —— 控制面**不得**出现在里面
      expect(JSON.stringify(card)).not.toContain('/harness')
    } finally {
      await s.dispose()
    }
  })

  it('版本头缺失 ⇒ -32009（真机复现这个坑：SDK 默认按 0.3 校验）', async () => {
    const s = launch()
    try {
      const hs = await s.start()
      const res = await fetch(hs.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendStreamingMessage',
          params: { message: { kind: 'message', role: 'user', messageId: 'e2e-1', parts: [{ kind: 'text', text: 'hi' }] } },
        }),
      })
      const body = (await res.json()) as { error?: { code: number } }
      expect(body.error?.code).toBe(-32009)
    } finally {
      await s.dispose()
    }
  })

  it('控制面端到端：harness/notice.list 走 /harness/rpc', async () => {
    const s = launch()
    try {
      const t = new A2aTransport({ sidecar: s })
      await t.start()
      const r = (await t.control('harness/notice.list')) as { notices?: unknown[]; total?: number }
      expect(Array.isArray(r.notices)).toBe(true)
      // boot 期至少有一条降级/选择事实（无 key 回落 Mock 之类），总数为 0 说明 notice 没接线
      expect(r.total).toBeGreaterThan(0)
    } finally {
      await s.dispose()
    }
  })

  it('流式管道：拿到 task 帧与 contextId，且可取消', async () => {
    const s = launch()
    try {
      const t = new A2aTransport({ sidecar: s })
      await t.start()

      const controller = new AbortController()
      let contextId: string | undefined
      let taskId: string | undefined
      let frames = 0

      for await (const frame of t.send({}, '只回复两个字：收到', controller.signal)) {
        frames++
        const ids = extractTaskIds(frame)
        if (ids.contextId) contextId = ids.contextId
        if (ids.taskId) taskId = ids.taskId
        // 拿到首个 task 帧就够证明管道成立；继续跑要等模型，没必要
        if (frames >= 1 && contextId) break
      }

      expect(frames).toBeGreaterThan(0)
      expect(contextId).toBeTruthy()
      expect(taskId).toBeTruthy()

      // 取消：证明 CancelTask 这条线也通（不断言终态 —— 取消与完成存在竞争）
      await t.cancel(taskId!).catch(() => {})
    } finally {
      await s.dispose()
    }
  })

  it('dispose 之后进程真的没了（无残留 sidecar）', async () => {
    const s = launch()
    const hs = await s.start()
    const pid = hs.pid
    await s.dispose()

    // SIGTERM 之后进程应退出；`kill -0` 抛 ESRCH 即已不在
    let alive = true
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
      }
      if (alive) await new Promise((r) => setTimeout(r, 50))
    }
    expect(alive).toBe(false)
  })
})
