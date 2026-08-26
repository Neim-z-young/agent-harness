/**
 * @harness/cli - TUI 模式测试（OpenTUI React 渲染层）
 *
 * 用 @opentui/core/testing 的 createTestRenderer + mockInput 模拟按键，
 * 直接渲染 <TuiApp> 组件树（不依赖真实 tty）：
 * - appendLog：日志追加纯函数
 * - TuiApp：输入提交 → createProcessLine → mock 回复流式渲染；Ctrl-C / /exit 退出
 * - parseCliArgs --tui
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessApp, parseCliArgs } from './index'
import { appendLog, TuiApp, type TuiReplExit } from './tui'
import { createRoot } from '@opentui/react'
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing'
import type { Harness } from '@harness/core'
import type { Session } from '@harness/session'

// ------------------------------------------------------------------------
// appendLog：日志追加纯函数
// ------------------------------------------------------------------------

describe('appendLog 日志追加', () => {
  it('首行直接入栈；后续文本拼接最后一行', () => {
    expect(appendLog([], 'a')).toEqual(['a'])
    expect(appendLog(['a'], 'b')).toEqual(['ab'])
  })

  it('\n 拆分多行', () => {
    expect(appendLog([], 'a\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('超过 maxLines 只保留最近 N 行', () => {
    expect(appendLog([], '1\n2\n3\n4', 3)).toEqual(['2', '3', '4'])
  })

  it('不修改原数组', () => {
    const prev = ['x']
    const next = appendLog(prev, 'y')
    expect(prev).toEqual(['x'])
    expect(next).toEqual(['xy'])
  })
})

// ------------------------------------------------------------------------
// TuiApp 集成（mock provider + OpenTUI 测试渲染器）
// ------------------------------------------------------------------------

interface TuiFixture {
  setup: TestRendererSetup
  exit: Promise<TuiReplExit>
  cleanup: () => Promise<void>
}

const activeFixtures: Array<() => Promise<void>> = []

async function mountTui(extra: { responses?: Array<{ match: RegExp; response: string }> } = {}): Promise<TuiFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-tui-test-'))
  const app = new HarnessApp({
    cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
    permissionMode: 'allow-all',
    mockProviderConfig: {
      defaultResponse: '你好，我是 TUI 助手。',
      responses: extra.responses ?? [],
    },
  })
  const { harness, session } = await app.boot()
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const root = createRoot(setup.renderer)
  let resolveExit!: (r: TuiReplExit) => void
  const exit = new Promise<TuiReplExit>((r) => { resolveExit = r })
  root.render(<TuiApp options={{ app, harness, session }} onExit={resolveExit} />)

  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    root.unmount()
    setup.renderer.destroy()
    await app.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
  activeFixtures.push(cleanup)
  return { setup, exit, cleanup }
}

afterEach(async () => {
  while (activeFixtures.length > 0) await activeFixtures.pop()!()
})

// 测试渲染器不会自动跑渲染循环：每次 pump 执行 renderer.loop() 产出新帧，
// 驱动 React 提交 → 键盘事件处理 → createProcessLine 流式回调回流。
async function pumpOnce(setup: TestRendererSetup): Promise<void> {
  try { await setup.renderOnce() } catch { /* 无调度工作时 loop 可能直接返回 */ }
}

async function waitFrame(setup: TestRendererSetup, predicate: (frame: string) => boolean, maxPasses = 600): Promise<string> {
  let frame = ''
  for (let i = 0; i < maxPasses; i++) {
    await pumpOnce(setup)
    frame = setup.captureCharFrame()
    if (predicate(frame)) return frame
    await new Promise((r) => setTimeout(r, 3))
  }
  throw new Error('waitFrame 超时，最后一帧:\n' + JSON.stringify(frame))
}

async function waitExit(f: TuiFixture, maxPasses = 600): Promise<TuiReplExit> {
  const pending = Symbol('pending')
  for (let i = 0; i < maxPasses; i++) {
    await pumpOnce(f.setup)
    const r = await Promise.race([f.exit, new Promise<typeof pending>((res) => setTimeout(() => res(pending), 0))])
    if (r !== pending) return r
    await new Promise((res) => setTimeout(res, 5))
  }
  throw new Error('exit 超时')
}

describe('TuiApp 集成（mock provider）', () => {
  it('输入 hello + Enter → 回显 + mock 回复流式渲染进日志区', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('Harness TUI'))
    await f.setup.mockInput.typeText('hello')
    f.setup.mockInput.pressEnter()
    // 用户输入回显（processLine 输出 🧑 前缀）
    await waitFrame(f.setup, (frame) => frame.includes('🧑') && frame.includes('hello'))
    // mock 回复流式渲染（🤖 前缀 + 文本）
    await waitFrame(f.setup, (frame) => frame.includes('🤖') && frame.includes('你好，我是 TUI 助手。'))
    await f.cleanup()
  })

  it('Ctrl-C → exit', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('Harness TUI'))
    f.setup.mockInput.pressCtrlC()
    expect(await waitExit(f)).toBe('exit')
    await f.cleanup()
  })

  it('/exit 命令 → exit（与 REPL 共用 createProcessLine）', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('Harness TUI'))
    await f.setup.mockInput.typeText('/exit')
    f.setup.mockInput.pressEnter()
    expect(await waitExit(f)).toBe('exit')
    await f.cleanup()
  })

  it('输入与回车分块到达（真实模式时序）也能提交处理', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('Harness TUI'))
    await f.setup.mockInput.typeText('hi')
    f.setup.mockInput.pressEnter()
    await waitFrame(f.setup, (frame) => frame.includes('🧑') && frame.includes('hi'))
    await waitFrame(f.setup, (frame) => frame.includes('🤖') && frame.includes('你好，我是 TUI 助手。'))
    await f.cleanup()
  })
})

// ------------------------------------------------------------------------
// parseCliArgs --tui
// ------------------------------------------------------------------------

describe('parseCliArgs --tui', () => {
  it('repl --tui 解析为 tui: true', () => {
    const args = parseCliArgs(['repl', '--tui'])
    expect(args.command).toBe('repl')
    expect(args.tui).toBe(true)
  })

  it('无 --tui 时默认 undefined', () => {
    const args = parseCliArgs(['repl'])
    expect(args.tui).toBeUndefined()
  })
})
