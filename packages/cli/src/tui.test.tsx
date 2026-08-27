/**
 * @harness/cli - TUI 模式测试（OpenTUI React 渲染层）
 *
 * 用 @opentui/core/testing 的 createTestRenderer + mockInput 模拟按键，
 * 直接渲染 <TuiApp> 组件树（不依赖真实 tty）：
 * - classifyConsoleLine / pushConsole / applyStreamEvent / findFileReferences：结构化块纯函数
 * - TuiApp：输入提交 → createProcessLine（onEvent）→ mock 回复以 markdown 流式渲染；
 *   Ctrl-B 切换侧栏；Ctrl-C / /exit 退出
 * - parseCliArgs --tui
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessApp, parseCliArgs } from './index'
import {
  classifyConsoleLine,
  pushConsole,
  applyStreamEvent,
  findFileReferences,
  collectFileReferences,
  createFileRefIndex,
  indexFileReferences,
  initialChatState,
  initialChatWithWelcome,
  TuiApp,
  type TuiReplExit,
} from './tui'
import { createRoot } from '@opentui/react'
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing'
import type { Harness } from '@harness/core'
import type { Session } from '@harness/session'

// ------------------------------------------------------------------------
// 结构化块纯函数
// ------------------------------------------------------------------------

describe('classifyConsoleLine 控制台行归类', () => {
  it('🧑 开头 → user，去掉前缀', () => {
    expect(classifyConsoleLine('🧑  hello')).toEqual({ kind: 'user', text: 'hello' })
  })
  it('💭 开头 → thinking，去掉前缀', () => {
    expect(classifyConsoleLine('💭  思考中')).toEqual({ kind: 'thinking', text: '思考中' })
  })
  it('🤖 开头 → assistant，去掉前缀', () => {
    expect(classifyConsoleLine('🤖  你好')).toEqual({ kind: 'assistant', text: '你好' })
  })
  it('🔧 / ✅ / ❌ 开头 → tool，保留原文', () => {
    expect(classifyConsoleLine('🔧  t1 {"a":1}...').kind).toBe('tool')
    expect(classifyConsoleLine('✅  → ok').kind).toBe('tool')
    expect(classifyConsoleLine('❌  → err').kind).toBe('tool')
  })
  it('⏱️ 开头 / 其他 → system', () => {
    expect(classifyConsoleLine('⏱️  12ms | agent=default').kind).toBe('system')
    expect(classifyConsoleLine('普通提示').kind).toBe('system')
  })
  it('空串 / 空格 / 行首单空格 → system', () => {
    expect(classifyConsoleLine('')).toEqual({ kind: 'system', text: '' })
    expect(classifyConsoleLine('  ')).toEqual({ kind: 'system', text: ' ' })
    expect(classifyConsoleLine(' hello')).toEqual({ kind: 'system', text: 'hello' })
  })
  it('前缀后无空格仍按前缀归类（正文可后续展开）', () => {
    expect(classifyConsoleLine('🤖你好').kind).toBe('assistant')
    expect(classifyConsoleLine('🔧t1 args').kind).toBe('tool')
  })
})

describe('pushConsole 追加控制台文本', () => {
  it('按 \\n 拆行归类为新块，跳过空行', () => {
    const s = pushConsole(initialChatState, '\n🧑  hi\n\n🔧  t1 x...\n')
    expect(s.blocks.map((b) => b.kind)).toEqual(['user', 'tool'])
    expect(s.blocks[0].text).toBe('hi')
    expect(s.blocks[1].text).toBe('🔧  t1 x...')
  })
  it('不修改原数组', () => {
    const prev = initialChatState
    const next = pushConsole(prev, 'hello')
    expect(prev.blocks).toHaveLength(0)
    expect(next.blocks).toHaveLength(1)
  })
  it('仅空行/空白不产生块，末尾换行不追加空块', () => {
    expect(pushConsole(initialChatState, '\n  \n\n').blocks).toHaveLength(0)
    expect(pushConsole(initialChatState, 'a\n').blocks).toHaveLength(1)
  })
  it('多前缀混排各行各自成块，ID 连续递增', () => {
    const s = pushConsole(initialChatState, '🤖  你好\n⏱️  3ms\n💭  想想')
    expect(s.blocks.map((b) => b.kind)).toEqual(['assistant', 'system', 'thinking'])
    expect(s.nextId).toBe(4)
  })
})

describe('applyStreamEvent 结构化流', () => {
  it('text_delta 累积成流式 assistant 块', () => {
    let s = initialChatState
    s = applyStreamEvent(s, { type: 'text_delta', text: '你好' })
    s = applyStreamEvent(s, { type: 'text_delta', text: '，世界' })
    expect(s.blocks).toHaveLength(1)
    expect(s.blocks[0].kind).toBe('assistant')
    expect(s.blocks[0].text).toBe('你好，世界')
    expect(s.blocks[0].streaming).toBe(true)
  })
  it('reasoning_delta 生成 thinking 块', () => {
    const s = applyStreamEvent(initialChatState, { type: 'reasoning_delta', text: '我先想想' })
    expect(s.blocks[0].kind).toBe('thinking')
    expect(s.blocks[0].text).toBe('我先想想')
  })
  it('done 收尾：流式标记清除、下标归位', () => {
    let s = applyStreamEvent(initialChatState, { type: 'text_delta', text: 'a' })
    expect(s.blocks[0].streaming).toBe(true)
    s = applyStreamEvent(s, { type: 'done', message: undefined })
    expect(s.blocks[0].streaming).toBe(false)
    expect(s.assistantIdx).toBe(-1)
    // 新一轮 text_delta 生成新块
    const s2 = applyStreamEvent(s, { type: 'text_delta', text: 'b' })
    expect(s2.blocks).toHaveLength(2)
    expect(s2.assistantIdx).toBe(1)
  })
  it('done 无流式块时无操作，保持原状态引用', () => {
    const s = initialChatState
    expect(applyStreamEvent(s, { type: 'done', message: undefined })).toBe(s)
  })
  it('未知事件类型原样返回，不崩溃', () => {
    const s = initialChatState
    expect(applyStreamEvent(s, { type: 'tool_call_start', toolId: 't1', input: {} } as never)).toBe(s)
  })
  it('reasoning 与 text 交错各自成块，done 一并收尾，新一轮续接', () => {
    let s = applyStreamEvent(initialChatState, { type: 'reasoning_delta', text: '想' })
    s = applyStreamEvent(s, { type: 'text_delta', text: '答' })
    expect(s.blocks.map((b) => b.kind)).toEqual(['thinking', 'assistant'])
    expect(s.blocks.every((b) => b.streaming)).toBe(true)
    s = applyStreamEvent(s, { type: 'done', message: undefined })
    expect(s.blocks.every((b) => b.streaming)).toBe(false)
    const s2 = applyStreamEvent(s, { type: 'reasoning_delta', text: '再想' })
    expect(s2.blocks.map((b) => [b.kind, b.text])).toEqual([
      ['thinking', '想'],
      ['assistant', '答'],
      ['thinking', '再想'],
    ])
  })
})

describe('findFileReferences / collectFileReferences', () => {
  it('提取 packages/cli/src/tui.tsx:12 这样的路径引用', () => {
    const refs = findFileReferences('见 packages/cli/src/tui.tsx:12 与 src/utils/parse.ts:1:2')
    expect(refs.map((r) => r.path)).toEqual(['packages/cli/src/tui.tsx:12', 'src/utils/parse.ts:1:2'])
  })
  it('缺失后缀/非路径不误报，去重', () => {
    const refs = findFileReferences('x docs/readme.md y docs/readme.md')
    expect(refs).toEqual([{ path: 'docs/readme.md', start: 2, end: 16 }])
  })
  it('collectFileReferences 汇总各块并限量', () => {
    let state = initialChatState
    state = pushConsole(state, '见 src/a.ts 和 src/b.ts')
    const byBlock = { ...state, blocks: [...state.blocks, { id: 99, kind: 'tool' as const, text: 'src/a.ts:2 src/c.ts:3' }] }
    expect(collectFileReferences(byBlock)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts:3'])
  })
  it('含 - _ . 的扩展名路径识别；行区间 :10-20 仅保留起始行', () => {
    expect(findFileReferences('交割 lib/util.helper.mts 见 src/a.ts:10-20').map((r) => r.path))
      .toEqual(['lib/util.helper.mts', 'src/a.ts:10'])
  })
  it('邮箱/端口号/纯目录不误报', () => {
    expect(findFileReferences('联系 app@example.com 或 localhost:3000 或 src')).toEqual([])
  })
  it('同文件不同行号跨块归并，保留首次出现的原始形态', () => {
    let s = pushConsole(initialChatState, '见 src/x.ts:5')
    const s2 = pushConsole(s, '再提 src/x.ts:10 与 src/x.ts:5')
    expect(collectFileReferences(s2)).toEqual(['src/x.ts:5'])
  })
  it('无引用时返回空数组；尊重自定义 max 限量', () => {
    expect(collectFileReferences(initialChatState)).toEqual([])
    let s = pushConsole(initialChatState, 'src/a.ts src/b.ts src/c.ts')
    expect(collectFileReferences(s, 2)).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('FileRefIndex 增量文件引用索引', () => {
  it('空索引初始为空', () => {
    expect(createFileRefIndex().ordered).toEqual([])
  })
  it('文本未增长时原样返回同一引用', () => {
    const idx = createFileRefIndex()
    const after = indexFileReferences(idx, 1, 'src/a.ts')
    expect(after.ordered).toEqual(['src/a.ts'])
    // 同长文本再入 → 返回同一引用，不重复扫描
    expect(indexFileReferences(after, 1, 'src/a.ts')).toBe(after)
  })
  it('追加增量仅扫描新增尾部，累积去重', () => {
    let idx = createFileRefIndex()
    // 第一次：整段扫描，得到 src/a.ts
    idx = indexFileReferences(idx, 1, '改动 src/a.ts 后继续')
    expect(idx.ordered).toEqual(['src/a.ts'])
    // 追加内容含第二个路径 → 增量扫描尾部识别 src/b.ts
    idx = indexFileReferences(idx, 1, '改动 src/a.ts 后继续 并让 src/b.ts:3 更新')
    expect(idx.ordered).toEqual(['src/a.ts', 'src/b.ts:3'])
  })
  it('跨增量拼接的路径也能被完整捕获（回看窗口）', () => {
    let idx = createFileRefIndex()
    // 前缀部分跨过增量边界，靠 REF_SCAN_OVERLAP 回看完整捕获
    const first = '这是一段很长的铺垫文本。'.repeat(8) // 足够长使增量边界落在路径前部之外
    idx = indexFileReferences(idx, 1, first + '见 ')
    idx = indexFileReferences(idx, 1, first + '见 src/c.ts')
    expect(idx.ordered).toContain('src/c.ts')
  })
  it('同文件不同行号归并，保留首次形态；限量 max', () => {
    let idx = createFileRefIndex()
    idx = indexFileReferences(idx, 1, 'src/x.ts:5')
    idx = indexFileReferences(idx, 2, 'src/x.ts:9 与 src/y.ts')
    expect(idx.ordered).toEqual(['src/x.ts:5', 'src/y.ts'])
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

async function mountTui(
  extra: {
    responses?: Array<{ match: string | RegExp; response: string }>
    openFile?: (path: string, line?: number) => void
  } = {},
): Promise<TuiFixture> {
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
  root.render(<TuiApp options={{ app, harness, session, provider: 'mock', openFile: extra.openFile }} onExit={resolveExit} />)

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
  throw new Error('waitFrame 超时，最后一帧:\n' + JSON.stringify(frame.slice(0, 400)))
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
  it('初始：状态栏 + 侧栏「会话上下文」渲染', async () => {
    const f = await mountTui()
    const frame = await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
    expect(frame).toContain('mock')
    await f.cleanup()
  })

  it('输入 hello + Enter → echo + mock 回复以 markdown 流式渲染', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('hello')
    f.setup.mockInput.pressEnter()
    // 用户回显（user 块：❯ hello）
    await waitFrame(f.setup, (frame) => frame.includes('❯') && frame.includes('hello'))
    // assistant 正文经 onEvent → markdown 渲染
    await waitFrame(f.setup, (frame) => frame.includes('你好，我是 TUI 助手。'))
    await f.cleanup()
  })

  it('Ctrl-B 切换侧栏面板', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    f.setup.mockInput.pressKey('b', { ctrl: true })
    // 侧栏隐藏后「会话上下文」标题消失
    await waitFrame(f.setup, (frame) => !frame.includes('会话上下文'))
    await f.cleanup()
  })

  it('Ctrl-C → exit', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    f.setup.mockInput.pressCtrlC()
    expect(await waitExit(f)).toBe('exit')
    await f.cleanup()
  })

  it('/exit 命令 → exit（与 REPL 共用 createProcessLine）', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('/exit')
    f.setup.mockInput.pressEnter()
    expect(await waitExit(f)).toBe('exit')
    await f.cleanup()
  })
})

describe('TuiApp 文件引用导航（Tab / 上下键选中 / Enter 打开）', () => {
  it('Tab 进入引用列表，Esc 返回输入，期间不触发打开', async () => {
    const opened: Array<{ path: string; line?: number }> = []
    const f = await mountTui({
      responses: [{ match: /file/, response: '见 src/foo.ts:12 与 docs/readme.md' }],
      openFile: (path, line) => opened.push({ path, line }),
    })
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('file')
    f.setup.mockInput.pressEnter()
    // 回复流入 → 侧栏出现文件引用
    await waitFrame(f.setup, (frame) => frame.includes('src/foo.ts:12'))

    // Tab 进入引用列表
    f.setup.mockInput.pressTab()
    await waitFrame(f.setup, (frame) => frame.includes('▸'))

    // Esc 返回输入，列表模式退出
    f.setup.mockInput.pressEscape()
    await waitFrame(f.setup, (frame) => !frame.includes('▸'))

    expect(opened).toEqual([]) // 未按 Enter，不触发打开
    await f.cleanup()
  })

  it('Tab 进入后按方向键下移选中、Enter 打开并解析 :行号', async () => {
    const opened: Array<{ path: string; line?: number }> = []
    const f = await mountTui({
      responses: [{ match: /bar/, response: '改动 src/foo.ts:12 与 src/bar.ts:3' }],
      openFile: (path, line) => opened.push({ path, line }),
    })
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('bar')
    f.setup.mockInput.pressEnter()
    await waitFrame(f.setup, (frame) => frame.includes('src/foo.ts:12'))

    // Tab 进入并等待 fileMode 生效（否则方向键会落入非列表分支）
    f.setup.mockInput.pressTab()
    await waitFrame(f.setup, (frame) => frame.includes('▸'))

    // 下移一次选中第二项 src/bar.ts:3
    f.setup.mockInput.pressArrow('down')
    await new Promise((r) => setTimeout(r, 10))
    // 打开选中项 → 退出列表模式
    f.setup.mockInput.pressEnter()
    await waitFrame(f.setup, (frame) => !frame.includes('▸'))

    expect(opened).toContainEqual({ path: 'src/bar.ts', line: 3 })
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