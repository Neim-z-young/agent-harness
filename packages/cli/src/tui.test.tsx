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
  applyBackgroundTaskSnapshot,
  bgTaskRow,
  splitBgTasks,
  messageText,
  roleToKind,
  messagesToBlocks,
  toSessionRows,
  sessionRowText,
  computeTuiStats,
  formatDuration,
  latestAssistantText,
  emptyUsage,
  recordCall,
  recordTool,
  recordTaskDone,
  uncachedInput,
  modelUsageRow,
  toolUsageRow,
  agentUsageRow,
  hourLabel,
  hourlyRow,
  sparkline,
  HELP_LINES,
  buildWelcomeBanner,
  WELCOME_BANNER,
  selectionTextFrom,
  approvalLine,
  __KEYLOG,
  __resetKeyLog,
  type SessionRow,
  type ChatBlock,
  type TuiReplExit,
} from './tui'
import { createRoot } from '@opentui/react'
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing'
import type { Harness } from '@harness/core'
import type { Message, Session } from '@harness/session'
import type { BackgroundTaskViewLike } from '@harness/plugin'

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
// 后台任务快照（模块 A：TUI 侧栏实时面板纯函数）
// ------------------------------------------------------------------------

describe('后台任务快照', () => {
  const T = (partial: Partial<BackgroundTaskViewLike>): BackgroundTaskViewLike =>
    ({ taskId: 'tsk', status: 'running', agentName: 'researcher', ...partial })

  it('applyBackgroundTaskSnapshot 以最新全量为准（浅拷贝，不原地改）', () => {
    const prev = [T({ taskId: 'a', status: 'running' })]
    const next = [
      T({ taskId: 'a', status: 'completed', result: 'done', durationMs: 42 }),
      T({ taskId: 'b', status: 'failed', error: { message: 'boom' } }),
    ]
    const out = applyBackgroundTaskSnapshot(prev, next)
    expect(out).toEqual(next)
    expect(out).not.toBe(prev)
  })

  it('bgTaskRow：图标 + agentName；长 taskId 截断为 8 位', () => {
    const row = bgTaskRow(T({ taskId: 'task-very-long-my-task-id', status: 'completed', result: 'hello world' }))
    expect(row).toContain('✅')
    expect(row).toContain('task-ver…')
    expect(row).toContain('researcher')
    expect(row).toContain('hello world')
  })

  it('bgTaskRow：running 带进度步数；failed 用 ❌', () => {
    expect(bgTaskRow(T({ taskId: 'x', status: 'running', progress: [{ toolName: 'read_file', toolUseId: 'u', toolStatus: 'running', summary: 'reading' }] }))).toContain('1步')
    expect(bgTaskRow(T({ taskId: 'y', status: 'failed' }))).toContain('❌')
  })

  it('splitBgTasks：pending+running 归 running，completed/failed 归 finished', () => {
    const { running, finished } = splitBgTasks([
      T({ taskId: 'p', status: 'pending' }),
      T({ taskId: 'r', status: 'running' }),
      T({ taskId: 'c', status: 'completed' }),
      T({ taskId: 'f', status: 'failed' }),
    ])
    expect(running.map((t) => t.taskId).sort()).toEqual(['p', 'r'])
    expect(finished.map((t) => t.taskId).sort()).toEqual(['c', 'f'])
  })
})

describe('会话历史渲染（模块 B）', () => {
  const m = (role: Message['role'], text: string): Message =>
    ({ id: 'm', role, createdAt: 0, parts: [{ type: 'text', text }] })

  it('messageText 拼接 text part，追加 reasoning', () => {
    const msg: Message = {
      id: 'm', role: 'assistant', createdAt: 0,
      parts: [
        { type: 'text', text: '你好' },
        { type: 'reasoning', text: '思考' },
        { type: 'tool', toolUseId: 'u', toolId: 't', input: {} },
      ],
    }
    expect(messageText(msg)).toBe('你好\n💭思考')
  })

  it('roleToKind：user/assistant/tool 各归其类，其余 system', () => {
    expect(roleToKind('user')).toBe('user')
    expect(roleToKind('assistant')).toBe('assistant')
    expect(roleToKind('tool')).toBe('tool')
    expect(roleToKind('system')).toBe('system')
  })

  it('messagesToBlocks：各角色成块、跳过空消息、ID 连续递增', () => {
    const cs = messagesToBlocks([
      m('user', '问'),
      m('assistant', '答'),
      m('tool', '🔧  t1 args'),
      m('system', ''),
      m('assistant', ''),
    ])
    expect(cs.blocks.map((b) => b.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(cs.nextId).toBe(4)
  })

  it('toSessionRows：title 缺失用 id 兜底', () => {
    const rows = toSessionRows([
      { id: 'a', updatedAt: 10, messageCount: 2 },
      { id: 'b', title: '会话B', updatedAt: 20, messageCount: 3 },
    ])
    expect(rows[0].title).toBe('a')
    expect(rows[1].title).toBe('会话B')
  })

  it('sessionRowText：消息数 + 时间缩写，长标题截断', () => {
    const r: SessionRow = { id: 'x', title: '这是一个非常长的会话标题超过十六个字', messageCount: 5, updatedAt: 0 }
    expect(sessionRowText(r, 3_600_000)).toContain('5条')
    expect(sessionRowText(r, 3_600_000)).toContain('1h')
    expect(sessionRowText(r, 3_600_000)).toContain('…')
  })
})

describe('统计面板 / 复制辅助 / 帮助面板（模块 D）', () => {
  const b = (kind: ChatBlock['kind'], text: string): ChatBlock => ({ id: 0, kind, text })

  it('computeTuiStats：按角色计数 + charset + token 估算（/4）', () => {
    const s = computeTuiStats(
      [b('user', 'abc'), b('assistant', '你好世界'), b('thinking', 't'), b('tool', 'x')],
      [
        { taskId: 't1', status: 'running' } as BackgroundTaskViewLike,
        { taskId: 't2', status: 'completed' } as BackgroundTaskViewLike,
      ],
      65000,
    )
    expect(s.users).toBe(1)
    expect(s.assistants).toBe(1)
    expect(s.thinking).toBe(1)
    expect(s.tools).toBe(1)
    // 3 + 4 + 1 + 1 = 9 字符
    expect(s.chars).toBe(9)
    expect(s.tokens).toBe(2) // round(9/4)
    expect(s.tasksRunning).toBe(1)
    expect(s.tasksDone).toBe(1)
    expect(s.elapsedMs).toBe(65000)
  })

  it('computeTuiStats：整合实际用量（usage）按多维归并字段', () => {
    let u = recordCall(emptyUsage(), { model: 'gpt-4o', input: 100, output: 20, cacheRead: 10, ts: 1_700_000_000_000 })
    u = recordCall(u, { model: 'gpt-4o', input: 50, output: 10, ts: 1_700_000_000_000 })
    u = recordCall(u, { model: 'deepseek', agentId: 'sub', input: 200, output: 30, ts: 1_700_003_600_000 })
    u = recordTool(u, 'readFile', { input: 100, output: 20 })
    u = recordTool(u, 'readFile')
    u = recordTool(u, 'shell', { isError: true })
    const s = computeTuiStats([b('user', 'q')], [], 1000, u)
    const us = s.usage
    expect(us.llmCalls).toBe(3)
    expect(us.inputTokens).toBe(350)
    expect(us.outputTokens).toBe(60)
    expect(us.cacheReadTokens).toBe(10)
    expect(us.models).toEqual([
      { model: 'gpt-4o', calls: 2, inputTokens: 150, outputTokens: 30, cacheRead: 10, cacheWrite: 0 },
      { model: 'deepseek', calls: 1, inputTokens: 200, outputTokens: 30, cacheRead: 0, cacheWrite: 0 },
    ])
    // 工具归并：首个工具归入紧随 LLM 用量 100/20，失败只计错误
    expect(us.tools).toEqual([
      { tool: 'readFile', count: 2, errors: 0, inputTokens: 100, outputTokens: 20 },
      { tool: 'shell', count: 0, errors: 1, inputTokens: 0, outputTokens: 0 },
    ])
    // agent 维度：root 与 sub 各自归并（deepseek 属于 sub）
    expect(us.agents).toEqual([
      { agentId: 'root', calls: 2, inputTokens: 150, outputTokens: 30, tasksDone: 0 },
      { agentId: 'sub', calls: 1, inputTokens: 200, outputTokens: 30, tasksDone: 0 },
    ])
    // 小时时序：两个不同小时桶，升序
    expect(us.hourly).toHaveLength(2)
    expect(us.hourly[0].calls + us.hourly[1].calls).toBe(3)
    expect(us.hourly[0].hour).toBeLessThan(us.hourly[1].hour)
  })

  it('recordCall：按模型归并调用与用量，缺省模型回退 unknown，含缓存与agent', () => {
    let u = recordCall(emptyUsage(), { model: 'm1', input: 10, output: 2, cacheRead: 3 })
    u = recordCall(u, { model: 'm1', input: 5, output: 3 })
    u = recordCall(u, { input: 7, output: 1 })
    expect(u.llmCalls).toBe(3)
    expect(u.inputTokens).toBe(22)
    expect(u.outputTokens).toBe(6)
    expect(u.cacheReadTokens).toBe(3)
    expect(u.models).toEqual([
      { model: 'm1', calls: 2, inputTokens: 15, outputTokens: 5, cacheRead: 3, cacheWrite: 0 },
      { model: 'unknown', calls: 1, inputTokens: 7, outputTokens: 1, cacheRead: 0, cacheWrite: 0 },
    ])
    // 缺省用量默认 0，不影响累计
    expect(recordCall(emptyUsage(), { model: 'm2' }).models[0]).toEqual(
      { model: 'm2', calls: 1, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
    )
  })

  it('recordTool：失败不计调用次数、只计错误；同名归并；token归并仅成功时', () => {
    let u = emptyUsage()
    u = recordTool(u, 'readFile', { input: 100, output: 20 })
    u = recordTool(u, 'readFile', { isError: true })
    u = recordTool(u, 'shell', { isError: true, input: 999, output: 999 })
    expect(u.tools).toEqual([
      { tool: 'readFile', count: 1, errors: 1, inputTokens: 100, outputTokens: 20 },
      { tool: 'shell', count: 0, errors: 1, inputTokens: 0, outputTokens: 0 },
    ])
    expect(recordTool(emptyUsage(), '').tools[0].tool).toBe('tool')
  })

  it('recordTaskDone / uncachedInput：agent任务完成计数与未命中缓存计算', () => {
    let u = recordCall(emptyUsage(), { model: 'm', input: 100, cacheRead: 30, cacheWrite: 20 })
    u = recordTaskDone(u, 'root')
    expect(u.agents[0].tasksDone).toBe(1)
    expect(uncachedInput(u)).toBe(50) // 100 - 30 - 20
    u = recordCall(u, { model: 'm', input: 10, cacheRead: 10 })
    expect(uncachedInput(u)).toBe(50) // 110 - 40 - 20
  })

  it('modelUsageRow / toolUsageRow / agentUsageRow / hourlyRow：格式化统计行', () => {
    expect(modelUsageRow({ model: 'gpt-4o', calls: 2, inputTokens: 150, outputTokens: 30, cacheRead: 10, cacheWrite: 0 }))
      .toBe('gpt-4o ×2 · ⚡10/w0 in150/out30')
    expect(modelUsageRow({ model: 'deepseek', calls: 1, inputTokens: 200, outputTokens: 30, cacheRead: 0, cacheWrite: 0 }))
      .toBe('deepseek ×1 · in200/out30')
    expect(toolUsageRow({ tool: 'readFile', count: 3, errors: 0, inputTokens: 0, outputTokens: 0 })).toBe('readFile ×3')
    expect(toolUsageRow({ tool: 'shell', count: 1, errors: 2, inputTokens: 90, outputTokens: 30 }))
      .toBe('shell ×1 (2❌) · 90/30')
    expect(agentUsageRow({ agentId: 'sub', calls: 4, inputTokens: 400, outputTokens: 100, tasksDone: 2 }))
      .toBe('sub ×4 ✓2 · 400/100')
    expect(hourLabel(1_700_003_700_000)).toMatch(/^\d{2}:00$/)
    expect(sparkline(50, 100, 4)).toBe('██░░')
  })

  it('formatDuration：秒 / 分秒 / 时分 各格式', () => {
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration(3 * 60_000 + 5_000)).toBe('3m5s')
    expect(formatDuration(65 * 60_000)).toBe('1h05m')
    expect(formatDuration(0)).toBe('0s')
  })

  it('latestAssistantText：取最近的 assistant 块', () => {
    expect(latestAssistantText([b('user', 'q'), b('assistant', '旧的'), b('tool', 'x'), b('assistant', '新的')])).toBe('新的')
    expect(latestAssistantText([b('user', 'q')])).toBe('')
    expect(latestAssistantText([])).toBe('')
  })

  it('HELP_LINES：包含核心快捷键（帮助/复制/退出/面板）', () => {
    const text = HELP_LINES.map((l) => l.key).join(' ')
    expect(text).toContain('Ctrl-/')
    expect(text).toContain('Ctrl-Y')
    expect(text).toContain('Ctrl-C')
    expect(text).toContain('Ctrl-B')
  })

  it('buildWelcomeBanner：5 行字标，每行宽度可控且含全部字母行', () => {
    const rows = buildWelcomeBanner()
    expect(rows.length).toBe(5)
    for (const r of rows) {
      expect(r.length).toBeGreaterThan(0)
      expect(r.length).toBeLessThanOrEqual(60)
    }
    // H/A/R/N/E/R/N/E/S/S… 逐行应出现字模竖笔画与横杠，能拼出全部行
    expect(rows[2]).toContain('HHHHH') // 第 4 行（'H' 中横）
    expect(rows[4]).toContain('EEEEE') // 第 5 行（'E' 底横）
    expect(WELCOME_BANNER).toContain('HHHHH')
  })

  it('selectionTextFrom：无 renderer/无选区返回空串，有选区返回文本', () => {
    expect(selectionTextFrom(null)).toBe('')
    expect(selectionTextFrom(undefined)).toBe('')
    expect(selectionTextFrom({})).toBe('')
    expect(selectionTextFrom({ getSelection: () => null })).toBe('')
    expect(selectionTextFrom({ getSelection: () => ({ getSelectedText: () => '' }) })).toBe('')
    expect(
      selectionTextFrom({ getSelection: () => ({ getSelectedText: () => '选中的文字' }) }),
    ).toBe('选中的文字')
  })
})

// ------------------------------------------------------------------------
// TuiApp 渲染 / 状态集成（OpenTUI createTestRenderer）
// ------------------------------------------------------------------------

interface TuiFixture {
  setup: TestRendererSetup
  exit: Promise<TuiReplExit>
  cleanup: () => Promise<void>
}

const activeFixtures: Array<() => Promise<void>> = []

async function mountTui(
  extra: {
    responses?: Array<{ match: string | RegExp; response: string; toolCalls?: Array<{ toolUseId: string; toolId: string; input: unknown }> }>
    openFile?: (path: string, line?: number) => void
    model?: string
    permissionMode?: 'allow-all' | 'ask' | 'deny-all'
  } = {},
): Promise<TuiFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-tui-test-'))
  const app = new HarnessApp({
    cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
    model: extra.model,
    permissionMode: extra.permissionMode ?? 'allow-all',
    mockProviderConfig: {
      defaultResponse: '你好，我是 TUI 助手。',
      responses: extra.responses ?? [],
    },
  })
  const { harness, session } = await app.boot()
  const setup = await createTestRenderer({ width: 80, height: 24, useMouse: true })
  const root = createRoot(setup.renderer)
  let resolveExit!: (r: TuiReplExit) => void
  const exit = new Promise<TuiReplExit>((r) => { resolveExit = r })
  root.render(<TuiApp options={{ app, harness, session, provider: 'mock', model: extra.model, openFile: extra.openFile }} onExit={resolveExit} />)

  // 首次渲染后被动 effect（useKeyboard / 后台任务订阅 / 会话列表刷新等）异步 flush，
  // 先 pump 一拍并等待，确保后续交互测试按键时各钩子已注册（消除竞态）。
  await settleEffects(setup)

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

/** 挂载后 pump 若干拍 + 短延，确保 React 被动 effect（useKeyboard 订阅等）已 flush。 */
async function settleEffects(setup: TestRendererSetup): Promise<void> {
  for (let i = 0; i < 15; i++) {
    await pumpOnce(setup)
    await new Promise((r) => setTimeout(r, 2))
  }
}

/** Meta+Enter 提交（多行输入下 Enter 为换行，提交需按 Meta/⌘+Enter） */
function pressMetaEnter(setup: TestRendererSetup): void {
  setup.mockInput.pressEnter({ meta: true })
}

async function waitFrame(setup: TestRendererSetup, predicate: (frame: string) => boolean, maxPasses = 600): Promise<string> {
  let frame = ''
  for (let i = 0; i < maxPasses; i++) {
    await pumpOnce(setup)
    frame = setup.captureCharFrame()
    if (predicate(frame)) return frame
    await new Promise((r) => setTimeout(r, 3))
  }
  throw new Error('waitFrame 超时，最后一帧:\n' + JSON.stringify(frame.slice(0, 2000)) + '\nKEYLOG=' + JSON.stringify(__KEYLOG))
}

/** 在整宽字符帧中定位首个目标子串的 0-based 单元格坐标（行整宽填充空格，故 indexOf 即列位） */
function locateChar(frame: string, needle: string): { x: number; y: number } | null {
  const lines = frame.split('\n')
  for (let y = 0; y < lines.length; y++) {
    const x = lines[y].indexOf(needle)
    if (x >= 0) return { x, y }
  }
  return null
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

/** 取最后一帧最底部的输入行（空输入显示占位 ❯；有内容时显示值本身） */
function inputLine(setup: TestRendererSetup): string {
  const lines = setup.captureCharFrame().split('\n').map((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]) return lines[i]!
  }
  return ''
}

/**
 * 发送一条消息（含输入历史回看所需的真实事件间隙）。多行输入下 Enter 为换行、提交改用
 * Meta+Enter（pressMetaEnter）。本辅助在 typeText 后先 pump 若干拍让键入值提交（防同一同步帧
 * 内 setState 批处理跳帧），再按提交键，最后等待用户回显 + 输入框清空。
 */
async function sendMessageWithGap(setup: TestRendererSetup, text: string): Promise<void> {
  setup.mockInput.typeText(text)
  for (let i = 0; i < 12; i++) { await pumpOnce(setup); await new Promise((r) => setTimeout(r, 5)) }
  pressMetaEnter(setup)
  await waitFrame(setup, (fr) => fr.includes('❯ ' + text) && fr.trimEnd().endsWith('❯'))
  for (let i = 0; i < 6; i++) await pumpOnce(setup)
}

describe('TuiApp 集成（mock provider）', () => {
  it('初始：状态栏 + 侧栏「会话上下文」渲染', async () => {
    const f = await mountTui()
    const frame = await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
    expect(frame).toContain('mock')
    await f.cleanup()
  })

  it('欢迎页：会话开始前展示字标与引导，首条消息后消失', async () => {
    const f = await mountTui()
    // 初始（仅 system 块）→ 展示欢迎页（字标 + 引导 + provider）
    const frame = await waitFrame(f.setup, (fr) => fr.includes('welcome to agent-harness'))
    expect(frame).toContain('HARNESS'.charAt(0))       // 字标首字母 'H'
    expect(frame).toContain('交互式会话')
    expect(frame).toContain('provider=mock')
    expect(frame).toContain('输入问题开始对话')
    // 首条消息后欢迎页被对话块替换
    await f.setup.mockInput.typeText('hello')
    pressMetaEnter(f.setup)
    await waitFrame(f.setup, (fr) => fr.includes('你好，我是 TUI 助手。'))
    await waitFrame(f.setup, (fr) => !fr.includes('welcome to agent-harness'))
    await f.cleanup()
  })

  it('命令输入回显为 user 块，并触发欢迎页切换', async () => {
    const f = await mountTui()
    // 初始欢迎页
    await waitFrame(f.setup, (fr) => fr.includes('welcome to agent-harness'))
    // 执行命令：应回显命令并让欢迎页消失（命令算作新会话活动）
    await f.setup.mockInput.typeText('/stats')
    pressMetaEnter(f.setup)
    await waitFrame(f.setup, (fr) => fr.includes('/stats'))
    await waitFrame(f.setup, (fr) => !fr.includes('welcome to agent-harness'))
    // 命令输出（stats 文本）也进入聊天区
    await waitFrame(f.setup, (fr) => fr.includes('LLM 调用'))
    await f.cleanup()
  })

  it('命令菜单：/ 前缀过滤展开后，Enter 选中首个候选提交', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    f.setup.mockInput.typeText('/stats')
    // pump 若干拍，确保 React state flush 出 cmdMenuOpen，命令菜单在 Enter 前已展开
    for (let i = 0; i < 15; i++) { await pumpOnce(f.setup); await new Promise((r) => setTimeout(r, 4)) }
    // 普通 Enter（菜单内确认）→ 提交首个候选命令
    f.setup.mockInput.pressEnter()
    await waitFrame(f.setup, (fr) => !fr.includes('welcome to agent-harness'))
    await waitFrame(f.setup, (fr) => fr.includes('LLM 调用'))
    await f.cleanup()
  })

  it('配置的 model 初始展示在状态栏/侧栏', async () => {
    const f = await mountTui({ model: 'claude-3-5-sonnet' })
    const frame = await waitFrame(f.setup, (fr) => fr.includes('model=claude-3-5-sonnet'))
    expect(frame).toContain('model=claude-3-5-sonnet')
    expect(frame).toContain('claude-3-5-sonnet')
    await f.cleanup()
  })

  it('输入 hello + Meta+Enter → echo 并以 markdown 流式渲染', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('hello')
    pressMetaEnter(f.setup)
    // 用户回显（user 块：❯ hello）
    await waitFrame(f.setup, (frame) => frame.includes('❯') && frame.includes('hello'))
    // assistant 正文经 onEvent → markdown 渲染
    await waitFrame(f.setup, (frame) => frame.includes('你好，我是 TUI 助手。'))
    await f.cleanup()
  })

  it('多行输入：Enter 插入换行而非提交，Meta+Enter 提交整段', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    // 第一行 + Enter（换行）+ 第二行 —— Enter 应插入换行而不是提交
    f.setup.mockInput.typeText('第一行')
    f.setup.mockInput.pressEnter() // newline
    f.setup.mockInput.typeText('第二行')
    // 等待若干拍，确认尚未触发提交（无 assistant 回复、欢迎页仍在）
    await new Promise((r) => setTimeout(r, 40))
    for (let i = 0; i < 8; i++) await pumpOnce(f.setup)
    expect(f.setup.captureCharFrame()).not.toContain('你好，我是 TUI 助手。')
    // Meta+Enter 提交整段多行内容
    pressMetaEnter(f.setup)
    await waitFrame(f.setup, (fr) => fr.includes('第一行') && fr.includes('第二行'))
    await waitFrame(f.setup, (fr) => fr.includes('你好，我是 TUI 助手。'))
    // 提交后输入框清空
    await waitFrame(f.setup, (fr) => fr.trimEnd().endsWith('❯'))
    await f.cleanup()
  })

  it('粘贴换行文本保留为输入缓冲，Meta+Enter 提交', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    // 粘贴三行文本：换行应被完整保留（不被当作提交键）
    await f.setup.mockInput.pasteBracketedText('行一\n行二\n行三')
    await new Promise((r) => setTimeout(r, 30))
    for (let i = 0; i < 6; i++) await pumpOnce(f.setup)
    expect(f.setup.captureCharFrame()).not.toContain('你好，我是 TUI 助手。')
    // Meta+Enter 提交多行文本
    pressMetaEnter(f.setup)
    await waitFrame(f.setup, (fr) => fr.includes('行一') && fr.includes('行二'))
    await waitFrame(f.setup, (fr) => fr.includes('行三') && fr.includes('你好，我是 TUI 助手。'))
    await f.cleanup()
  })

  it('Ctrl-B 切换侧栏面板', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    __resetKeyLog()
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
    pressMetaEnter(f.setup)
    expect(await waitExit(f)).toBe('exit')
    await f.cleanup()
  })

  it('Ctrl-/ 弹出帮助面板，任意键关闭', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    f.setup.mockInput.pressKey('/', { ctrl: true })
    // 帮助面板 overlay 出现
    await waitFrame(f.setup, (frame) => frame.includes('打开/关闭帮助面板'))
    // 任意键关闭（Esc）
    f.setup.mockInput.pressEscape()
    await waitFrame(f.setup, (frame) => !frame.includes('打开/关闭帮助面板'))
    await f.cleanup()
  })

  it('权限审批模态：ask 模式工具调用触发弹窗，y 允许后继续', async () => {
    const f = await mountTui({
      permissionMode: 'ask',
      responses: [{ match: 'hi', response: '', toolCalls: [{ toolUseId: 'b1', toolId: 'bash', input: { command: 'echo ok' } }] }],
    })
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    // 输入触发 mock 返回工具调用 → 权限引擎 ask → 审批模态
    f.setup.mockInput.pressKeys(['h', 'i'])
    pressMetaEnter(f.setup)
    await waitFrame(f.setup, (frame) => frame.includes('权限审批'))
    // 按 y 允许单次
    f.setup.mockInput.pressKey('y')
    await waitFrame(f.setup, (frame) => !frame.includes('权限审批') && frame.includes('stdout'))
    await f.cleanup()
  })

  it('权限审批模态：n 拒绝后工具被拒，会话正常收尾', async () => {
    const f = await mountTui({
      permissionMode: 'ask',
      responses: [{ match: 'hi', response: '', toolCalls: [{ toolUseId: 'b1', toolId: 'bash', input: { command: 'rm -rf /' } }] }],
    })
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    f.setup.mockInput.pressKeys(['h', 'i'])
    pressMetaEnter(f.setup)
    await waitFrame(f.setup, (frame) => frame.includes('权限审批'))
    f.setup.mockInput.pressKey('n')
    await waitFrame(f.setup, (frame) => !frame.includes('权限审批') && frame.includes('权限被拒绝'))
    await f.cleanup()
  })

  it('approvalLine 提炼权限问题主行', () => {
    expect(approvalLine('\n⚠️ 权限请求 [bash] /etc/passwd\n  操作: allow / deny ... ')).toBe('⚠️ 权限请求 [bash] /etc/passwd')
    expect(approvalLine('  权限请求 [write] src/x.ts  ')).toBe('权限请求 [write] src/x.ts')
    expect(approvalLine('xx')).toBe('xx')
  })

  it('侧栏统计面板：消息数 + token 估算 + 任务 + 用时', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    // 侧栏改图标 tab：主菜单按 ▶ 循环切换（context→sessions→tasks→files→stats）
    for (let i = 0; i < 4; i++) f.setup.mockInput.pressArrow('right')
    await waitFrame(f.setup, (frame) => frame.includes('统计') && frame.includes('字符') && frame.includes('tok'))
    // 发送一条回复后，统计随块更新（assistant 块 + 用户块）
    await f.setup.mockInput.typeText('统计测试')
    pressMetaEnter(f.setup)
    await waitFrame(f.setup, (frame) => frame.includes('你好，我是 TUI 助手。'))
    await waitFrame(f.setup, (frame) => frame.includes('消息') && frame.includes('1u'))
    await f.cleanup()
  })

  it('鼠标点击消息「复制」按钮 → 变「✓ 已复制」（onMouseUp 触发 clipboard 写入）', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('复制测试')
    pressMetaEnter(f.setup)
    // 用户回显 + assistant 回复各生成一个「⧉ 复制」按钮
    await waitFrame(f.setup, (frame) => frame.includes('你好，我是 TUI 助手。'))
    const frame = await waitFrame(f.setup, (fr) => fr.includes('⧉ 复制'))
    const pos = locateChar(frame, '⧉ 复制')
    expect(pos).not.toBeNull()
    // 点击该按钮单元格坐标（0-based），触发 onMouseUp 复制并临时高亮
    await f.setup.mockMouse.click(pos!.x, pos!.y)
    await waitFrame(f.setup, (fr) => fr.includes('✓ 已复制'))
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
    pressMetaEnter(f.setup)
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
    pressMetaEnter(f.setup)
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
// TuiApp 输入历史导航（↑ 回看 / ↓ 前进 / 底部 ↓ 退出）
// ------------------------------------------------------------------------

describe('TuiApp 输入历史导航', () => {
  it('连续 ↑ 逐级回看最近→更早，↓ 前进，底部 ↓ 退出回看', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
    // 发送 3 条消息（每条之间等待输入清空，模拟真实用户）
    for (const t of ['first message', 'second message', 'third message']) {
      await sendMessageWithGap(f.setup, t)
    }
    // 输入框应已清空（不含任何历史消息）
    expect(inputLine(f.setup)).toBe('❯')

    // ↑ 第 1 次 → 最近一条（third）
    f.setup.mockInput.pressArrow('up')
    await waitFrame(f.setup, (fr) => fr.trimEnd().endsWith('third message'))
    expect(inputLine(f.setup)).toBe('third message')

    // ↑ 第 2 次 → second
    f.setup.mockInput.pressArrow('up')
    await waitFrame(f.setup, (fr) => fr.trimEnd().endsWith('second message'))
    expect(inputLine(f.setup)).toBe('second message')

    // ↑ 第 3 次 → first（最旧）
    f.setup.mockInput.pressArrow('up')
    await waitFrame(f.setup, (fr) => fr.trimEnd().endsWith('first message'))
    expect(inputLine(f.setup)).toBe('first message')

    // ↑ 第 4 次 → 仍是最旧
    f.setup.mockInput.pressArrow('up')
    await new Promise((r) => setTimeout(r, 30))
    for (let i = 0; i < 6; i++) await pumpOnce(f.setup)
    expect(inputLine(f.setup)).toBe('first message')

    // ↓ 第 1 次 → second
    f.setup.mockInput.pressArrow('down')
    await waitFrame(f.setup, (fr) => fr.trimEnd().endsWith('second message'))
    expect(inputLine(f.setup)).toBe('second message')

    // ↓ 第 2 次 → third
    f.setup.mockInput.pressArrow('down')
    await waitFrame(f.setup, (fr) => fr.trimEnd().endsWith('third message'))
    expect(inputLine(f.setup)).toBe('third message')

    // ↓ 第 3 次（底部）→ 退出回看，输入框清空
    f.setup.mockInput.pressArrow('down')
    await waitFrame(f.setup, (fr) => fr.trimEnd().endsWith('❯'))
    expect(inputLine(f.setup)).toBe('❯')

    await f.cleanup()
  })

  it('历史回看不被 / 命令菜单劫持：连续 ↑ 遍历 / 命令与其前一条', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
    await sendMessageWithGap(f.setup, 'hello world') // 普通消息
    f.setup.mockInput.typeText('/stats')             // / 命令（同时是命令菜单候选）
    pressMetaEnter(f.setup)
    await waitFrame(f.setup, (fr) => fr.includes('/stats'))
    for (let i = 0; i < 6; i++) await pumpOnce(f.setup)

    // ↑ 第 1 次 → 最近一条（/stats）
    f.setup.mockInput.pressArrow('up')
    await waitFrame(f.setup, (fr) => fr.trimEnd().endsWith('/stats'))
    expect(inputLine(f.setup)).toBe('/stats')

    // ↑ 第 2 次 → 应继续回看历史（hello world），而不是被 /stats 命令菜单「卡住」
    f.setup.mockInput.pressArrow('up')
    await waitFrame(f.setup, (fr) => fr.trimEnd().endsWith('hello world'))
    expect(inputLine(f.setup)).toBe('hello world')

    await f.cleanup()
  })

  it('/history：提交后在聊天区列出输入历史，且不入历史栈', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
    await sendMessageWithGap(f.setup, 'first message')
    await sendMessageWithGap(f.setup, 'second message')

    f.setup.mockInput.typeText('/history')
    for (let i = 0; i < 12; i++) { await pumpOnce(f.setup); await new Promise((r) => setTimeout(r, 5)) }
    pressMetaEnter(f.setup)
    await waitFrame(f.setup, (fr) => fr.includes('输入历史'))
    const frame = inputLine(f.setup)
    expect(frame).toBe('❯') // 输入框已清空且未后续提交为消息

    await f.cleanup()
  })

  it('/history：输入 /h 前缀时出现在命令菜单候选中', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
    f.setup.mockInput.typeText('/h')
    for (let i = 0; i < 15; i++) { await pumpOnce(f.setup); await new Promise((r) => setTimeout(r, 4)) }
    // 命令菜单应包含 /history 候选
    await waitFrame(f.setup, (fr) => fr.includes('/history'))
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