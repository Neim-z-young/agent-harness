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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
  compactBlockText,
  expandCompactBlocks,
  loadOlderBlocks,
  HISTORY_PAGE,
  toSessionRows,
  sessionRowText,
  computeTuiStats,
  cacheUsageLine,
  SELECTION_BLINK_A,
  SELECTION_BLINK_B,
  SELECTION_BLINK_MS,
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
  countGraphemes,
  approvalLine,
  __KEYLOG,
  __resetKeyLog,
  resolveEditPath,
  buildEditorCommand,
  abbrevFileRef,
  buildDiskFileTree,
  renderFileRefTree,
  type FileRefTreeNode,
  type SessionRow,
  type ChatBlock,
  type TuiReplExit,
} from './tui'
import { createRoot } from '@opentui/react'
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing'
import type { Harness } from '@harness/core'
import type { CompactionBlock, Message, Session } from '@harness/session'
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
  it('连续命令输出（system 行）合并为单个块，复制按钮只在末尾出现一次', () => {
    // 模拟 /switch ? 逐行 out：已注册 Agent： /  default  -  Harness Agent
    let s = pushConsole(initialChatState, '已注册 Agent：')
    s = pushConsole(s, ' default  -  Harness Agent')
    expect(s.blocks).toHaveLength(1)
    expect(s.blocks[0].kind).toBe('system')
    // 行首单个空格被 classifyConsoleLine 剥掉（对齐 console 缩进惯例）
    expect(s.blocks[0].text).toBe('已注册 Agent：\ndefault  -  Harness Agent')
    expect(s.nextId).toBe(2)
  })
  it('欢迎块（id 0）不与首条输出合并', () => {
    const s = pushConsole(initialChatWithWelcome('欢迎语'), '已注册 Agent：')
    expect(s.blocks.map((b) => b.kind)).toEqual(['system', 'system'])
    expect(s.blocks[0].text).toBe('欢迎语')
    expect(s.blocks[1].text).toBe('已注册 Agent：')
  })
  it('连续 tool 行合并为单个块；user 行不合并', () => {
    let s = pushConsole(initialChatState, '🔧  bash ls')
    s = pushConsole(s, '✅  bash 完成')
    expect(s.blocks).toHaveLength(1)
    expect(s.blocks[0].text).toBe('🔧  bash ls\n✅  bash 完成')
    s = pushConsole(s, '🧑  第二条消息')
    expect(s.blocks).toHaveLength(2)
    expect(s.blocks[1].kind).toBe('user')
  })
  it('tool 块跨 thinking 合并：一次应答多步工具调用归为单块，复制按钮只在末尾一次', () => {
    let s = pushConsole(initialChatState, '🔧  list_dir {...}')
    s = pushConsole(s, '✅  → entries')
    s = pushConsole(s, '💭  我 stuck 了，重试')
    s = pushConsole(s, '🔧  list_dir {}')
    s = pushConsole(s, '✅  → entries2')
    s = pushConsole(s, '🔧  bash {}')
    s = pushConsole(s, '✅  → out')
    // tool 行跨 thinking 与前一 tool 块合并成一个块；thinking 独立保留
    expect(s.blocks.filter((b) => b.kind === 'tool')).toHaveLength(1)
    expect(s.blocks.map((b) => b.kind)).toEqual(['tool', 'thinking'])
    expect(s.blocks[0].text).toBe('🔧  list_dir {...}\n✅  → entries\n🔧  list_dir {}\n✅  → entries2\n🔧  bash {}\n✅  → out')
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
  it('`~/` 开头路径保留 ~ 前缀（不吞成 /path）', () => {
    const refs = findFileReferences('编辑 ~/.harness/config.json 与 ~/src/rel.ts')
    expect(refs.map((r) => r.path)).toEqual(['~/.harness/config.json', '~/src/rel.ts'])
  })
  it('绝对路径整体作为引用保留（不误切成 /.harness/... 残片）', () => {
    const refs = findFileReferences('/Users/oyoungy/Documents/project/XiaoZhi-new/.harness/config.json')
    expect(refs.map((r) => r.path)).toEqual(['/Users/oyoungy/Documents/project/XiaoZhi-new/.harness/config.json'])
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

describe('阶段四·按需渲染（压缩块提示行 + 分页）', () => {
  const msg = (id: string, role: Message['role'], text: string): Message =>
    ({ id, role, createdAt: 0, parts: [{ type: 'text', text }] })
  const block = (id: string, extra?: Partial<CompactionBlock>): CompactionBlock => ({
    id,
    topic: 't',
    summary: '机密摘要XYZ',
    startId: 's',
    endId: 'e',
    at: 1,
    ...extra,
  })

  it('compactBlockText：来源 acp/通用区分，不渲染 summary 全文', () => {
    const t1 = compactBlockText(block('b1', { source: 'acp' }))
    expect(t1).toContain('ACP 折叠')
    expect(t1).toContain('点击展开原文')
    expect(t1).not.toContain('机密摘要XYZ') // 只显示字数计量，不渲染摘要内容
    const t2 = compactBlockText(block('b2', { topic: undefined }))
    expect(t2).toContain('会话压缩')
  })

  it('messagesToBlocks：带 blocks → 首部 compact 提示块（at 升序）', () => {
    const cs = messagesToBlocks(
      [msg('m2', 'user', '新'), msg('m3', 'assistant', '答')],
      [block('b2', { at: 2 }), block('b1', { at: 1 })],
    )
    expect(cs.blocks.map((b) => b.kind)).toEqual(['compact', 'compact', 'user', 'assistant'])
    expect(cs.blocks[0].blockId).toBe('b1')
    expect(cs.blocks[1].blockId).toBe('b2')
    expect(cs.nextId).toBe(5)
  })

  it('messagesToBlocks：无 blocks 时行为与旧版一致（零变化）', () => {
    const cs = messagesToBlocks([msg('m1', 'user', '问')])
    expect(cs.blocks.map((b) => b.kind)).toEqual(['user'])
  })

  it('messagesToBlocks：超长 messages 只渲染最近一页 + loadmore 提示', () => {
    const many: Message[] = []
    for (let i = 0; i < HISTORY_PAGE + 5; i++) many.push(msg(`m${i}`, i % 2 ? 'assistant' : 'user', `msg${i}`))
    const cs = messagesToBlocks(many, undefined, HISTORY_PAGE)
    expect(cs.blocks[0].kind).toBe('loadmore')
    expect(cs.blocks[0].text).toContain('5 条')
    expect(cs.blocks.filter((b) => b.kind === 'loadmore').length).toBe(1)
    expect(cs.blocks.filter((b) => b.kind !== 'loadmore').length).toBe(HISTORY_PAGE)
  })

  it('expandCompactBlocks：命中块替换为原文块，nextId 递增，空原文/未命中不变', () => {
    const base = messagesToBlocks(
      [msg('m2', 'user', '新')],
      [block('b1', { source: 'acp' })],
    )
    const expanded = expandCompactBlocks(base, 'b1', [msg('o1', 'user', '原文一'), msg('o2', 'assistant', '原文二'), msg('o3', 'tool', '')])
    expect(expanded.blocks.map((b) => b.kind)).toEqual(['user', 'assistant', 'user'])
    expect(expanded.blocks[0].msgId).toBe('o1')
    expect(expanded.nextId).toBe(base.nextId + 2) // 空消息跳过
    // 未命中：原样
    expect(expandCompactBlocks(base, 'nope', [msg('x', 'user', 'x')])).toBe(base)
    // 原文全空：原样
    expect(expandCompactBlocks(base, 'b1', [msg('x', 'tool', '')])).toBe(base)
  })

  it('loadOlderBlocks：插入更早页到提示之后；加载到底移除提示', () => {
    const many: Message[] = []
    for (let i = 0; i < 250; i++) many.push(msg(`m${i}`, i % 2 ? 'assistant' : 'user', `msg${i}`))
    // 首屏：可见最近 100 条（m150..m249），loadmore 提示"更早 150 条"
    const base = messagesToBlocks(many, undefined, HISTORY_PAGE)
    expect(base.blocks[0].kind).toBe('loadmore')
    // 第一页：模拟 handleLoadMore 取 [50,150) 100 条 → 还有 50 条更早，提示保留
    const page1 = loadOlderBlocks(base, many.slice(50, 150), HISTORY_PAGE)
    expect(page1.blocks[0].kind).toBe('loadmore')
    expect(page1.blocks.filter((b) => b.msgId === 'm50').length).toBe(1)
    // 第二页：取 [0,50) 50 条 → 到底，移除提示
    const page2 = loadOlderBlocks(page1, many.slice(0, 50), HISTORY_PAGE)
    expect(page2.blocks.filter((b) => b.kind === 'loadmore').length).toBe(0)
    expect(page2.blocks.filter((b) => b.msgId).length).toBe(250)
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
    // 工具归并：首个工具归入紧随 LLM 用量 100/20；每次调用都计 count，失败另计 errors（口径修正）
    expect(us.tools).toEqual([
      { tool: 'readFile', count: 2, errors: 0, inputTokens: 100, outputTokens: 20 },
      { tool: 'shell', count: 1, errors: 1, inputTokens: 0, outputTokens: 0 },
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

  it('recordTool：每次调用都计 count、失败另计 errors；同名归并；token 归并仅成功时', () => {
    // 口径修正（真机 s_1789916436883_ra6w1）：旧实现 `count: isError ? 0 : 1` 会让
    // 只失败过的工具呈现「调用 0 次 / 错误 1 次」的自相矛盾数（该会话的 team_status 即如此）。
    let u = emptyUsage()
    u = recordTool(u, 'readFile', { input: 100, output: 20 })
    u = recordTool(u, 'readFile', { isError: true })
    u = recordTool(u, 'shell', { isError: true, input: 999, output: 999 })
    expect(u.tools).toEqual([
      { tool: 'readFile', count: 2, errors: 1, inputTokens: 100, outputTokens: 20 },
      { tool: 'shell', count: 1, errors: 1, inputTokens: 0, outputTokens: 0 },
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

  it('countGraphemes：按字素簇计数（UTF-16 length 会把 emoji 算成 2）', () => {
    expect(countGraphemes('')).toBe(0)
    expect(countGraphemes('abc')).toBe(3)
    expect(countGraphemes('中文')).toBe(2)
    // 关键回归：非 BMP 字符在 UTF-16 里占 2 个码元，但用户只选了「一个字符」
    expect('🙂'.length).toBe(2)
    expect(countGraphemes('🙂')).toBe(1)
    expect(countGraphemes('a🙂中')).toBe(3)
    // 与 UTF-16 口径的差值就是显示 bug 的大小
    expect(countGraphemes('🙂🙂')).toBeLessThan('🙂🙂'.length)
  })
})

// ------------------------------------------------------------------------
// TuiApp 渲染 / 状态集成（OpenTUI createTestRenderer）
// ------------------------------------------------------------------------

interface TuiFixture {
  setup: TestRendererSetup
  exit: Promise<TuiReplExit>
  cleanup: () => Promise<void>
  app: HarnessApp
  /** 当前会话（TuiApp 收到的是可变 options 对象，/new、/resume 会回写 session 字段） */
  currentSession: () => { id: string; agentId?: string; meta?: Record<string, unknown>; messages: unknown[] }
}

const activeFixtures: Array<() => Promise<void>> = []

async function mountTui(
  extra: {
    responses?: Array<{ match: string | RegExp; response: string; toolCalls?: Array<{ toolUseId: string; toolId: string; input: unknown }>; reasoning?: string; once?: boolean }>
    openFile?: (path: string, line?: number) => void
    model?: string
    permissionMode?: 'allow-all' | 'ask' | 'deny-all'
    /**
     * 开启 Kitty keyboard protocol。传统终端里 Shift+Enter 与 Enter 都发 CR(0x0D)，
     * 修饰信息无法表达；只有开启该协议（或 modifyOtherKeys）才能区分。
     * 需要验证 Shift 修饰键的用例必须开启，否则按键会被当作裸 Enter。
     */
    kittyKeyboard?: boolean
    /**
     * 先造一个「上次会话」再启动，用于验证「启动即自动恢复」的提示与状态展示。
     * - `true`：会话与本次同 cwd → 应自动恢复（历史 + 说明一起给出）
     * - `'other-cwd'`：会话落在另一个工作目录 → 不该恢复，但要说明「为什么没接着上次」
     */
    resume?: boolean | 'other-cwd'
    /** 渲染器尺寸（缺省 80×24）。侧栏滚动条这类**溢出才有**的行为需要更矮的窗口来触发 */
    size?: { width: number; height: number }
    /**
     * 挂载前预置 N 个会话（同样的 dataDir）。
     * 侧栏「会话」tab 的滚动条只在列表溢出时出现 —— 真机上要攒够会话才看得到，
     * 测试里必须能一次造出来。
     */
    seedSessions?: number
    /** mock provider 上报的 token 用量（带 cacheRead 才能让统计 tab 的缓存行出现） */
    tokenUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  } = {},
): Promise<TuiFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-tui-test-'))
  const extraDirs: string[] = []
  const mkApp = (cwd = dir) => new HarnessApp({
    cwd, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
    model: extra.model,
    permissionMode: extra.permissionMode ?? 'allow-all',
    mockProviderConfig: {
      defaultResponse: '你好，我是 TUI 助手。',
      responses: extra.responses ?? [],
      ...(extra.tokenUsage ? { tokenUsage: extra.tokenUsage } : {}),
    },
  })
  if (extra.resume) {
    // 模拟「上次用完正常退出」：另一个 app 实例造会话 + 一条消息并落盘，随后第二次 boot 应自动恢复。
    // sessions 目录是全局共享的，所以 'other-cwd' 只换 cwd、dataDir 仍指向同一处。
    const seedDir = extra.resume === 'other-cwd' ? mkdtempSync(join(tmpdir(), 'harness-tui-other-')) : dir
    if (seedDir !== dir) extraDirs.push(seedDir)
    const seed = mkApp(seedDir)
    const first = await seed.boot()
    await first.harness.session.addMessage(first.session.id, {
      id: 'seed1', role: 'user', parts: [{ type: 'text', text: '上次的提问' }], createdAt: 1,
    })
    await seed.sessionStore.save((await first.harness.session.get(first.session.id))!)
    await seed.shutdown()
  }
  if (extra.seedSessions) {
    const seed = mkApp()
    const first = await seed.boot()
    for (let i = 0; i < extra.seedSessions; i++) {
      const s = await first.harness.session.create({ title: `预置会话 ${i}` })
      await seed.sessionStore.save((await first.harness.session.get(s.id))!)
    }
    await seed.shutdown()
  }
  const app = mkApp()
  const { harness, session } = await app.boot()
  const setup = await createTestRenderer({
    width: extra.size?.width ?? 80,
    height: extra.size?.height ?? 24,
    useMouse: true,
    ...(extra.kittyKeyboard ? { kittyKeyboard: true } : {}),
  })
  const root = createRoot(setup.renderer)
  let resolveExit!: (r: TuiReplExit) => void
  const exit = new Promise<TuiReplExit>((r) => { resolveExit = r })
  const tuiOptions = { app, harness, session, provider: 'mock', model: extra.model, openFile: extra.openFile }
  root.render(<TuiApp options={tuiOptions} onExit={resolveExit} />)

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
    for (const d of extraDirs) rmSync(d, { recursive: true, force: true })
  }
  activeFixtures.push(cleanup)
  return { setup, exit, cleanup, app, currentSession: () => tuiOptions.session }
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

/** 提交输入：Enter（当前约定 Enter 提交；换行用 Shift+Enter 或 `\`+Enter） */
function pressSubmit(setup: TestRendererSetup): void {
  setup.mockInput.pressEnter()
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
 * 发送一条消息（含输入历史回看所需的真实事件间隙）。提交键为 Enter（pressSubmit）。
 * 本辅助在 typeText 后先 pump 若干拍让键入值提交（防同一同步帧内 setState 批处理跳帧），
 * 再按提交键，最后等待用户回显 + 输入框清空。
 */
async function sendMessageWithGap(setup: TestRendererSetup, text: string): Promise<void> {
  setup.mockInput.typeText(text)
  for (let i = 0; i < 12; i++) { await pumpOnce(setup); await new Promise((r) => setTimeout(r, 5)) }
  pressSubmit(setup)
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
    pressSubmit(f.setup)
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
    pressSubmit(f.setup)
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

  it('Shift+Enter 换行（需终端上报 Shift，如 Kitty 协议）：不被当作提交', async () => {
    // 传统终端下 Shift+Enter 与 Enter 同为 CR(0x0D)，无修饰信息；开启 kitty 协议才能区分。
    // 能区分时 Shift+Enter = 换行，提交仍是 Enter。
    const f = await mountTui({ kittyKeyboard: true })
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('第一行')
    f.setup.mockInput.pressEnter({ shift: true })
    // 等待若干拍：若被误当作提交，会出现 assistant 回复
    await new Promise((r) => setTimeout(r, 40))
    for (let i = 0; i < 8; i++) await pumpOnce(f.setup)
    expect(f.setup.captureCharFrame()).not.toContain('你好，我是 TUI 助手。')
    // 继续键入第二行后 Enter 提交整段
    await f.setup.mockInput.typeText('第二行')
    pressSubmit(f.setup)
    await waitFrame(f.setup, (fr) => fr.includes('第一行') && fr.includes('第二行'))
    await waitFrame(f.setup, (fr) => fr.includes('你好，我是 TUI 助手。'))
    await f.cleanup()
  })

  it('Ctrl+J（linefeed）提交：兼容把 Enter 上报为 LF 的终端', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('ctrlj-submit')
    f.setup.mockInput.pressKey('LINEFEED')
    await waitFrame(f.setup, (fr) => fr.includes('ctrlj-submit'))
    await waitFrame(f.setup, (fr) => fr.includes('你好，我是 TUI 助手。'))
    await f.cleanup()
  })

  it('命令菜单展开时 Shift+Enter 不被菜单拦截（换行而非选中候选）', async () => {
    const f = await mountTui({ kittyKeyboard: true })
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    // 输入不完整的命令前缀，让菜单展开且首个候选为 /stats
    f.setup.mockInput.typeText('/sta')
    for (let i = 0; i < 15; i++) { await pumpOnce(f.setup); await new Promise((r) => setTimeout(r, 4)) }
    // Shift+Enter 应放行给输入框换行，而不是被菜单拦截选中 '/stats'
    f.setup.mockInput.pressEnter({ shift: true })
    await waitFrame(f.setup, (fr) => fr.includes('/sta'))
    await new Promise((r) => setTimeout(r, 40))
    for (let i = 0; i < 8; i++) await pumpOnce(f.setup)
    const frame = f.setup.captureCharFrame()
    // 未执行候选命令 /stats（其输出含「LLM 调用」）
    expect(frame).not.toContain('LLM 调用')
    // 输入未清空（未被当作提交）：换行后 /sta 仍在输入框
    expect(frame).toContain('/sta')
    await f.cleanup()
  })

  it('配置的 model 初始展示在状态栏/侧栏', async () => {
    const f = await mountTui({ model: 'claude-3-5-sonnet' })
    const frame = await waitFrame(f.setup, (fr) => fr.includes('model=claude-3-5-sonnet'))
    expect(frame).toContain('model=claude-3-5-sonnet')
    expect(frame).toContain('claude-3-5-sonnet')
    await f.cleanup()
  })

  it('启动即自动恢复上次会话：历史铺进聊天区 + 说明与出口', async () => {
    const f = await mountTui({ resume: true })
    // 自动恢复 = 接着上次：上次的历史必须可见，否则「恢复」只恢复了 id，用户仍是空屏
    await waitFrame(f.setup, (fr) => fr.includes('上次的提问'))
    // 自动恢复的说明进入聊天区（否则用户会以为「一进来就有历史」是 bug）
    const frame = await waitFrame(f.setup, (fr) => fr.includes('已自动恢复上次会话'))
    expect(frame).toContain('/new 开新会话')
    expect(frame).toContain('--no-resume')
    // 恢复的是磁盘上那个会话（不是新建的），且已带历史
    expect(f.app.sessionRestore.source).toBe('auto')
    expect(f.currentSession().messages.length).toBe(1)
    await f.cleanup()
  })

  it('上次会话属于其它工作目录：不恢复，但欢迎页给出原因与出口', async () => {
    const f = await mountTui({ resume: 'other-cwd' })
    // 不恢复（来源为 new），所以走欢迎页；提示必须由欢迎页渲染，否则会被欢迎页整体替换掉
    const frame = await waitFrame(f.setup, (fr) => fr.includes('未自动恢复会话'))
    expect(frame).toContain('它属于其它工作目录')
    expect(frame).toContain('/resume')
    expect(f.app.sessionRestore.source).toBe('new')
    expect(f.app.sessionRestore.skipped?.reason).toBe('other-cwd')
    expect(f.currentSession().messages.length).toBe(0)
    await f.cleanup()
  })

  it('/model 只改本会话：状态栏立即刷新（不必等下一次回复的 done 事件）', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (fr) => fr.includes('model=-'))
    f.setup.mockInput.typeText('/model claude-3-7-sonnet')
    for (let i = 0; i < 8; i++) await pumpOnce(f.setup)
    pressSubmit(f.setup)
    const frame = await waitFrame(f.setup, (fr) => fr.includes('model=claude-3-7-sonnet'))
    expect(frame).toContain('仅本会话')
    // 会话级覆盖：Agent 定义与 config.json 都没被改
    expect(f.app.sessionModelOverride(f.currentSession())).toEqual({ modelId: 'claude-3-7-sonnet' })
    await f.cleanup()
  })

  it('输入 hello + Enter → echo 并以 markdown 流式渲染', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('hello')
    pressSubmit(f.setup)
    // 用户回显（user 块：❯ hello）
    await waitFrame(f.setup, (frame) => frame.includes('❯') && frame.includes('hello'))
    // assistant 正文经 onEvent → markdown 渲染
    await waitFrame(f.setup, (frame) => frame.includes('你好，我是 TUI 助手。'))
    await f.cleanup()
  })

  it('多行输入：行尾 `\\`+Enter 换行（不依赖修饰键），Enter 提交整段', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    // 行尾打反斜杠再回车 → 换行（并去掉转义反斜杠），不应提交
    f.setup.mockInput.typeText('第一行\\')
    f.setup.mockInput.pressEnter()
    // 等待若干拍，确认尚未触发提交（无 assistant 回复）
    await new Promise((r) => setTimeout(r, 40))
    for (let i = 0; i < 8; i++) await pumpOnce(f.setup)
    expect(f.setup.captureCharFrame()).not.toContain('你好，我是 TUI 助手。')
    f.setup.mockInput.typeText('第二行')
    for (let i = 0; i < 8; i++) await pumpOnce(f.setup)
    // 换行只插一次（preventDefault 已拦住 textarea 默认换行）：输入区两行相邻、无空行
    const inputLines = f.setup.captureCharFrame().split('\n')
    const c1 = inputLines.findIndex((l) => l.includes('第一行'))
    const c2 = inputLines.findIndex((l) => l.includes('第二行'))
    expect(c1).toBeGreaterThanOrEqual(0)
    expect(c2).toBe(c1 + 1)
    // Enter 提交整段多行内容
    pressSubmit(f.setup)
    await waitFrame(f.setup, (fr) => fr.includes('第一行') && fr.includes('第二行'))
    // 转义反斜杠已被消费，不应出现在正文里
    expect(f.setup.captureCharFrame()).not.toContain('第一行\\')
    await waitFrame(f.setup, (fr) => fr.includes('你好，我是 TUI 助手。'))
    // 提交后输入框清空
    await waitFrame(f.setup, (fr) => fr.trimEnd().endsWith('❯'))
    await f.cleanup()
  })

  it('粘贴换行文本保留为输入缓冲，Enter 提交', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    // 粘贴三行文本：换行应被完整保留（不被当作提交键）
    await f.setup.mockInput.pasteBracketedText('行一\n行二\n行三')
    await new Promise((r) => setTimeout(r, 30))
    for (let i = 0; i < 6; i++) await pumpOnce(f.setup)
    expect(f.setup.captureCharFrame()).not.toContain('你好，我是 TUI 助手。')
    // Enter 提交多行文本
    pressSubmit(f.setup)
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
    pressSubmit(f.setup)
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
      responses: [
        // 第一步：要求调用工具（引擎自主多步的第一步）
        { match: 'hi', once: true, response: '', toolCalls: [{ toolUseId: 'b1', toolId: 'bash', input: { command: 'echo ok' } }] },
        // 第二步：看到工具结果后给出文本结论。
        // 不加这条的话 mock 会一直要求调同一个工具，测试会陷在反复弹审批里。
        { match: 'hi', response: '已完成' },
      ],
    })
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    // 输入触发 mock 返回工具调用 → 权限引擎 ask → 审批模态
    f.setup.mockInput.pressKeys(['h', 'i'])
    pressSubmit(f.setup)
    await waitFrame(f.setup, (frame) => frame.includes('权限审批'))
    // 按 y 允许单次
    f.setup.mockInput.pressKey('y')
    await waitFrame(f.setup, (frame) => !frame.includes('权限审批') && frame.includes('stdout'))
    await f.cleanup()
  })

  it('权限审批模态：n 拒绝后工具被拒，会话正常收尾', async () => {
    const f = await mountTui({
      permissionMode: 'ask',
      responses: [
        // 同上一用例：先要求调工具，被拒后由第二步给出文本收尾
        { match: 'hi', once: true, response: '', toolCalls: [{ toolUseId: 'b1', toolId: 'bash', input: { command: 'rm -rf /' } }] },
        { match: 'hi', response: '已改用更安全的做法' },
      ],
    })
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    f.setup.mockInput.pressKeys(['h', 'i'])
    pressSubmit(f.setup)
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
    pressSubmit(f.setup)
    await waitFrame(f.setup, (frame) => frame.includes('你好，我是 TUI 助手。'))
    await waitFrame(f.setup, (frame) => frame.includes('消息') && frame.includes('1u'))
    await f.cleanup()
  })

  it('统计面板含上下文占用（本会话 + 自动压缩阈值）', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    for (let i = 0; i < 4; i++) f.setup.mockInput.pressArrow('right')
    // ContextOccupancyLine 异步渲染（configStore.load + session.estimateTokens），轮询等待
    await waitFrame(f.setup, (frame) => frame.includes('上下文占用') && frame.includes('自动压缩阈值'))
    await f.cleanup()
  })

  it('空闲时不显示「■ 终止」按钮（仅运行中展示）', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await settleEffects(f.setup)
    expect(f.setup.captureCharFrame()).not.toContain('■ 终止')
    await f.cleanup()
  })

  it('鼠标点击消息「复制」按钮 → 变「✓ 已复制」（onMouseUp 触发 clipboard 写入）', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('复制测试')
    pressSubmit(f.setup)
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

  it('鼠标点击消息块 → 整块高亮选中（▌已选中），再点取消', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('选块测试')
    pressSubmit(f.setup)
    // 等待 assistant 回复，点击其文本区域（非复制按钮）
    const frame = await waitFrame(f.setup, (fr) => fr.includes('你好，我是 TUI 助手。'))
    const pos = locateChar(frame, '你好，我是 TUI 助手。')
    expect(pos).not.toBeNull()
    // 第一次点击：整块选中高亮
    await f.setup.mockMouse.click(pos!.x, pos!.y)
    await waitFrame(f.setup, (fr) => fr.includes('▌已选中'))
    // 再次点击同位置：取消选中
    await f.setup.mockMouse.click(pos!.x, pos!.y)
    await waitFrame(f.setup, (fr) => !fr.includes('▌已选中'))
    await f.cleanup()
  })

  it('鼠标拖选文本 → 输入行显示「⧉ 复制 N 字符 ✕」，点击 ✕ 清除（isActive 过滤回弹）', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('拖选测试')
    pressSubmit(f.setup)
    const frame = await waitFrame(f.setup, (fr) => fr.includes('你好，我是 TUI 助手。'))
    const start = locateChar(frame, '你好')
    expect(start).not.toBeNull()
    // 从"你好"拖到"助手"：Zig 端产生选区并派发 selection 事件 → 输入行显示已选字符数
    await f.setup.mockMouse.drag(start!.x, start!.y, start!.x + 4, start!.y)
    const withSel = await waitFrame(f.setup, (fr) => /⧉ 复制 \d+ 字符 ✕/.test(fr))
    // chip 必须长在**输入行**上（正文块里也有「⧉ 复制」，不能用整帧判断）
    expect(inputLine(f.setup)).toContain('✕')
    // 点击 ✕ 清除选区 → 输入行指示消失（不能因 clearSelection 后的事件回弹）。
    // ⚠️ chip 是**单个 text、按点击 x 分派**：点末尾 ✕ 才是清除，点其余位置是复制 ——
    // 这条用例就是那个分派的回归闸门。
    const clearPos = locateChar(withSel, '✕')
    expect(clearPos).not.toBeNull()
    await f.setup.mockMouse.click(clearPos!.x, clearPos!.y)
    await waitFrame(f.setup, () => !inputLine(f.setup).includes('✕'))
    await f.cleanup()
  })

  it('鼠标点击消息区后键盘输入仍直接生效（焦点自动回到输入框）', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('消息区点击')
    pressSubmit(f.setup)
    const frame = await waitFrame(f.setup, (fr) => fr.includes('你好，我是 TUI 助手。'))
    // 点击 assistant 消息文本（非输入框区域）：OpenTUI autoFocus 会把焦点从 textarea 抢走
    const pos = locateChar(frame, '你好，我是 TUI 助手。')
    expect(pos).not.toBeNull()
    await f.setup.mockMouse.click(pos!.x, pos!.y)
    // 点击后无需重新点击输入框，直接敲字符即进入输入框
    await f.setup.mockInput.typeText('abc')
    await waitFrame(f.setup, () => inputLine(f.setup).includes('abc'))
    await f.cleanup()
  })

  it('thinking 长推理默认折叠成标题行，点击展开显示完整正文，再点击收起', async () => {
    const sentence = '我先分析用户意图，再规划工具调用顺序，最后综合结果给出结论。'
    const longReasoning = sentence.repeat(8) // 240 字符 > 160，触发折叠
    const tail = longReasoning.slice(150, 180) // 第 6 句片段，不会出现在 52 字符折叠预览里
    const f = await mountTui({
      responses: [{ match: /折叠/, response: '最终回答', reasoning: longReasoning }],
    })
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    f.setup.mockInput.typeText('折叠测试')
    pressSubmit(f.setup)
    // 流式结束（done）后默认折叠：▸ 标题行带摘要预览，正文隐藏（预览只有前 52 字符，不含第 6 句）
    const folded = await waitFrame(f.setup, (frame) => frame.includes('▸ 💭 推理') && frame.includes('最终回答'))
    expect(folded).not.toContain(tail)
    // 点击标题行 → 展开：▾ 标题（流式早已结束，▾ 只可能是展开态）
    const pos = locateChar(folded, '▸ 💭 推理')
    expect(pos).not.toBeNull()
    await f.setup.mockMouse.click(pos!.x, pos!.y)
    await waitFrame(f.setup, (frame) => frame.includes('▾ 💭 推理') && !frame.includes('▸ 💭 推理') && frame.includes('最终回答'))
    // 再点击 → 收起回折叠态
    const expanded = await waitFrame(f.setup, (frame) => frame.includes('▾ 💭 推理') && !frame.includes('▸ 💭 推理') && frame.includes('最终回答'))
    const pos2 = locateChar(expanded, '▾ 💭 推理')
    expect(pos2).not.toBeNull()
    await f.setup.mockMouse.click(pos2!.x, pos2!.y)
    await waitFrame(f.setup, (frame) => frame.includes('▸ 💭 推理'))
    await f.cleanup()
  })

  it('thinking 短推理不折叠，直接显示 ▾ 标题 + 完整正文', async () => {
    const f = await mountTui({
      responses: [{ match: /短/, response: '回答', reasoning: '简单想想就回答' }],
    })
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    f.setup.mockInput.typeText('短推理')
    pressSubmit(f.setup)
    const frame = await waitFrame(f.setup, (fr) => fr.includes('▾ 💭 推理') && fr.includes('简单想想就回答'))
    expect(frame).not.toContain('▸ 💭 推理')
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
    pressSubmit(f.setup)
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
    pressSubmit(f.setup)
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
    pressSubmit(f.setup)
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
    pressSubmit(f.setup)
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

describe('buildDiskFileTree / renderFileRefTree（/tree 命令纯函数）', () => {
  it('扫描磁盘：目录在前字母序、排除噪声、引用标记、深度限制', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-tree-'))
    try {
      mkdirSync(join(dir, 'docs'), { recursive: true })
      mkdirSync(join(dir, 'packages', 'cli', 'src'), { recursive: true })
      mkdirSync(join(dir, '.git'), { recursive: true })
      mkdirSync(join(dir, 'node_modules'), { recursive: true })
      writeFileSync(join(dir, 'docs', 'mcp.md'), '')
      writeFileSync(join(dir, 'packages', 'cli', 'src', 'tui.tsx'), '')
      writeFileSync(join(dir, '.git', 'HEAD'), '')
      writeFileSync(join(dir, 'node_modules', 'x'), '')
      writeFileSync(join(dir, 'README.md'), '')

      const { nodes, truncated } = buildDiskFileTree(dir, ['README.md'])
      expect(truncated).toBe(false)
      const root = nodes[0]
      expect(root.name).toBe(abbrevFileRef(dir, 60))
      // 目录在前、字母序
      expect(root.children.map((c) => c.name)).toEqual(['docs', 'packages', 'README.md'])
      // 排除噪声
      expect(root.children.map((c) => c.name)).not.toContain('.git')
      expect(root.children.map((c) => c.name)).not.toContain('node_modules')
      // 引用标记
      const readme = root.children.find((c) => c.name === 'README.md')!
      expect(readme.marked).toBe(true)
      // 深度：默认 3 层目录 → 可见到 src，但 src 内文件不再下钻
      const pkg = root.children.find((c) => c.name === 'packages')!
      expect(pkg.children.map((c) => c.name)).toEqual(['cli'])
      const cli = pkg.children[0]!
      expect(cli.children.map((c) => c.name)).toEqual(['src'])
      expect(cli.children[0]!.children).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maxDepth 限制下钻层数', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-tree-'))
    try {
      mkdirSync(join(dir, 'a', 'b', 'c'), { recursive: true })
      writeFileSync(join(dir, 'a', 'b', 'c', 'f.txt'), '')
      const { nodes } = buildDiskFileTree(dir, [], { maxDepth: 2 })
      const a = nodes[0].children[0]!
      expect(a.name).toBe('a')
      expect(a.children.map((c) => c.name)).toEqual(['b'])
      expect(a.children[0]!.children).toEqual([]) // c 在深度 2 之外
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maxNodes 截断：超出上限置 truncated 并停止收集', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-tree-'))
    try {
      for (let i = 0; i < 6; i++) writeFileSync(join(dir, `f${i}.txt`), '')
      const { nodes, truncated } = buildDiskFileTree(dir, [], { maxNodes: 4 })
      expect(truncated).toBe(true)
      expect(nodes[0].children).toHaveLength(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('renderFileRefTree：目录带 /，被引用文件带 *，根无分支线', () => {
    const tree: FileRefTreeNode[] = [{
      key: 'root:/x', name: './', kind: 'root', absPath: '/x', children: [
        { key: '/x/docs', name: 'docs', kind: 'dir', absPath: '/x/docs', children: [
          { key: '/x/docs/mcp.md', name: 'mcp.md', kind: 'file', absPath: '/x/docs/mcp.md', marked: true, children: [] },
          { key: '/x/docs/other.ts', name: 'other.ts', kind: 'file', absPath: '/x/docs/other.ts', children: [] },
        ] },
      ],
    }]
    expect(renderFileRefTree(tree)).toBe([
      './',
      '└─ docs/',
      '   ├─ mcp.md*',
      '   └─ other.ts',
    ].join('\n'))
  })
})

describe('TuiApp /tree 磁盘目录树命令', () => {
  it('/tree <dir>：打印磁盘树，对话引用过的文件带 * 标记，且不入历史栈', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-tui-tree-'))
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'a.ts'), '')
      writeFileSync(join(dir, 'docs.md'), '')
      const f = await mountTui({
        responses: [
          { match: /列出/, response: '相关文件：src/a.ts:1 和 docs.md' },
        ],
      })
      await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
      await sendMessageWithGap(f.setup, '列出文件')
      await waitFrame(f.setup, (fr) => fr.includes('docs.md'))

      f.setup.mockInput.typeText('/tree ' + dir)
      for (let i = 0; i < 12; i++) { await pumpOnce(f.setup); await new Promise((r) => setTimeout(r, 5)) }
      pressSubmit(f.setup)
      await waitFrame(f.setup, (fr) => fr.includes('文件树（'))
      await waitFrame(f.setup, (fr) => fr.includes('src/') && fr.includes('a.ts*'))
      await waitFrame(f.setup, (fr) => fr.includes('* = 对话中引用过的文件'))
      expect(inputLine(f.setup)).toBe('❯') // 输入框已清空，命令未回显为消息
      await f.cleanup()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('/tree <path>：目录不存在时提示', async () => {
    const f = await mountTui()
    await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
    await sendMessageWithGap(f.setup, 'hello') // 让欢迎页消失
    await waitFrame(f.setup, (fr) => fr.includes('你好，我是 TUI 助手。'))
    f.setup.mockInput.typeText('/tree /no/such/dir')
    for (let i = 0; i < 12; i++) { await pumpOnce(f.setup); await new Promise((r) => setTimeout(r, 5)) }
    pressSubmit(f.setup)
    await waitFrame(f.setup, (fr) => fr.includes('目录不存在：/no/such/dir'))
    await f.cleanup()
  })
})

describe('TuiApp /edit 外部编辑器命令', () => {
  it('resolveEditPath：~ 展开到主目录、相对路径基于 cwd', () => {
    const home = require('node:os').homedir()
    expect(resolveEditPath('~/x/y.ts')).toBe(join(home, 'x/y.ts'))
    expect(resolveEditPath('~/.harness/p.json')).toBe(join(home, '.harness/p.json'))
    expect(resolveEditPath('relative/z.ts')).toBe(join(process.cwd(), 'relative/z.ts'))
    expect(resolveEditPath('/abs/a.ts')).toBe('/abs/a.ts')
  })

  // 工作目录是**启动参数**决定的（-c/--cwd），缺省才是进程启动目录：
  // TUI 里所有相对路径都必须以它为基准，不能硬用 process.cwd()。
  it('resolveEditPath：显式 base（启动工作目录）优先于 process.cwd()', () => {
    const workdir = '/tmp/harness-workdir-base'
    expect(resolveEditPath('relative/z.ts', workdir)).toBe(join(workdir, 'relative/z.ts'))
    expect(resolveEditPath('a/b.ts', workdir)).not.toContain(process.cwd())
    // 绝对路径与 ~ 不受 base 影响
    expect(resolveEditPath('/abs/a.ts', workdir)).toBe('/abs/a.ts')
    expect(resolveEditPath('~/x.ts', workdir)).toBe(join(require('node:os').homedir(), 'x.ts'))
  })

  it('abbrevFileRef：~ 相对化 + 超宽中间省略保留目录与文件名', () => {
    const home = require('node:os').homedir()
    expect(abbrevFileRef(join(home, 'x/a.ts'))).toBe('~/x/a.ts')
    expect(abbrevFileRef(join(process.cwd(), 'src/a.ts'))).toBe('./src/a.ts')
    expect(abbrevFileRef('x/a.ts')).toBe('x/a.ts')
    const long = '/Users/oyoungy/Documents/project/XiaoZhi-new/very-long-dir-name/src/nested/engine.ts'
    const out = abbrevFileRef(long, 30)
    expect(out.length).toBeLessThanOrEqual(30)
    expect(out.endsWith('engine.ts')).toBe(true)
    expect(out).toContain('…')
  })

  it('abbrevFileRef：显式 base 时按该目录做 `./` 相对化', () => {
    const workdir = '/tmp/harness-workdir-base'
    expect(abbrevFileRef(join(workdir, 'src/a.ts'), 40, workdir)).toBe('./src/a.ts')
    expect(abbrevFileRef(workdir, 40, workdir)).toBe('.')
    // 不在 base 下的路径原样保留（不会被错误地挂上 ./）
    expect(abbrevFileRef('/other/place/a.ts', 40, workdir)).toBe('/other/place/a.ts')
  })

  it('buildDiskFileTree：根节点按 base 相对化，引用按 base 解析后打标', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'harness-tree-base-'))
    try {
      mkdirSync(join(workdir, 'src'), { recursive: true })
      writeFileSync(join(workdir, 'src/app.ts'), 'x', 'utf8')
      const { nodes } = buildDiskFileTree(workdir, ['src/app.ts'], { cwd: workdir })
      expect(nodes[0].name).toBe('.')  // 根 = 工作目录本身
      const src = nodes[0].children.find((c) => c.name === 'src')
      expect(src?.children.some((c) => c.name === 'app.ts' && c.marked)).toBe(true)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('buildEditorCommand 用 $EDITOR + 独立 +行号，绝不拼 path:line', () => {
    const prev = process.env.EDITOR
    process.env.EDITOR = 'vim'
    try {
      const argv = buildEditorCommand('~/x/a.ts', 12)
      expect(argv.join(' ')).not.toContain('a.ts:12')
      expect(argv[argv.length - 1]).toBe(join(require('node:os').homedir(), 'x/a.ts'))
      expect(argv).toContain('+12')
    } finally {
      if (prev === undefined) delete process.env.EDITOR; else process.env.EDITOR = prev
    }
  })

  it('/e 前缀出现 /edit 候选；无参数提交提示用法', async () => {
    const f = await mountTui({ openFile: () => {} })
    await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
    f.setup.mockInput.typeText('/e')
    for (let i = 0; i < 15; i++) { await pumpOnce(f.setup); await new Promise((r) => setTimeout(r, 4)) }
    await waitFrame(f.setup, (fr) => fr.includes('/edit'))
    // 提交 /edit （无参数）→ 提示用法
    for (let i = 0; i < 6; i++) { await pumpOnce(f.setup); await new Promise((r) => setTimeout(r, 4)) }
    pressSubmit(f.setup)
    await waitFrame(f.setup, (fr) => fr.includes('/edit <file[:line]>'))
    await f.cleanup()
  })

  it('提交 /edit <file>:<line> 调用 openFile，回读尾部注入聊天区', async () => {
    const opened: Array<[string, number | undefined]> = []
    const f = await mountTui({ openFile: (p, l) => { opened.push([p, l]) } })
    // 相对路径的基准是**启动时解析出的工作目录**（`-c/--cwd` 传入值，未传才是进程启动目录），
    // 所以文件必须真的建在 fixture 的工作目录下 —— 这也是本用例要锁住的行为：
    // 若基准退回 process.cwd()，回读就会落到别处、命中不到这个文件。
    const tmpName = `__tui_edit_cmd_${Date.now()}`
    const dirUnderCwd = join(f.app.workspace.cwd, tmpName)
    mkdirSync(dirUnderCwd, { recursive: true })
    writeFileSync(join(dirUnderCwd, 'edit.ts'), 'head\n---\ntail2\ntail3\n', 'utf8')
    const ref = `${tmpName}/edit.ts:2`

    try {
      await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
      f.setup.mockInput.typeText('/edit ' + ref)
      for (let i = 0; i < 8; i++) { await pumpOnce(f.setup); await new Promise((r) => setTimeout(r, 4)) }
      pressSubmit(f.setup)
      await waitFrame(f.setup, (fr) => fr.includes('打开 ' + tmpName + '/edit.ts'))
      // openFile 已用相对 path + 行号调用
      expect(opened).toEqual([[`${tmpName}/edit.ts`, 2]])
      // 回读展示文件尾部（最新 8 行内包含 tail2）
      await waitFrame(f.setup, (fr) => fr.includes('tail2'))
      expect(f.setup.captureCharFrame()).toContain('已编辑')
    } finally {
      rmSync(dirUnderCwd, { recursive: true, force: true })
      await f.cleanup()
    }
  })
})

// ------------------------------------------------------------------------
// /tree：根目录取「启动时解析出的工作目录」，不是进程启动目录
// ------------------------------------------------------------------------

describe('TuiApp /tree 与工作目录', () => {
  it('/tree 无参数 → 以启动工作目录为根（不是进程启动目录）', async () => {
    const f = await mountTui({ responses: [{ match: /hi/, response: 'READY-SIGNAL' }] })
    // fixture 的工作目录是临时目录，而进程启动目录是仓库根 —— 两者必然不同，
    // 所以根节点只需相对化到「工作目录本身」= `.`；若退回 process.cwd() 就会显示仓库路径。
    expect(f.app.workspace.cwd).not.toBe(process.cwd())
    try {
      await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
      // 先发一句：只剩 system 块时聊天区由欢迎页顶替，/tree 这类系统输出看不见
      await f.setup.mockInput.typeText('hi')
      pressSubmit(f.setup)
      await waitFrame(f.setup, (fr) => fr.includes('READY-SIGNAL'))

      f.setup.mockInput.typeText('/tree')
      for (let i = 0; i < 8; i++) { await pumpOnce(f.setup); await new Promise((r) => setTimeout(r, 4)) }
      pressSubmit(f.setup)
      const frame = await waitFrame(f.setup, (fr) => fr.includes('文件树（.'))
      expect(frame).toContain('文件树（.）')
    } finally {
      await f.cleanup()
    }
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
// ------------------------------------------------------------------------
// 侧栏滚动条 / 缓存命中率 / 鼠标选区闪烁与可点击复制（模块 D5）
// ------------------------------------------------------------------------

/** 取某行的 spans（captureSpans 的便捷包装） */
function setupSpans(setup: TestRendererSetup, y: number) {
  return setup.captureSpans().lines[y]?.spans ?? []
}

/** 在整帧里找所有滑块字形（排除边框字符 '│'，它每行都有） */
function findBlockGlyphs(frame: string): Array<{ x: number; y: number; g: string }> {
  const GLYPHS = ['▀', '▄', '█', '▐', '▌', '░', '▒', '▓']
  const out: Array<{ x: number; y: number; g: string }> = []
  frame.split('\n').forEach((line, y) => {
    for (const g of GLYPHS) {
      let x = line.indexOf(g)
      while (x >= 0) { out.push({ x, y, g }); x = line.indexOf(g, x + 1) }
    }
  })
  return out
}

describe('侧栏 tab 滚动条', () => {
  it('会话列表溢出时，滑块出现在侧栏**内部**（修前被父容器裁掉）', async () => {
    // 矮窗口 + 一批会话 ⇒ 会话 tab 必然溢出
    const f = await mountTui({ size: { width: 80, height: 14 }, seedSessions: 14 })
    await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
    // 输入为空且非列表模式时，◀/▶ 循环切侧栏 tab（context → sessions）
    f.setup.mockInput.pressKey('ARROW_RIGHT')
    const frame = await waitFrame(f.setup, (fr) => fr.includes('预置会话'))

    // 侧栏占最右 26 列（含边框）；滑块必须落在其内部才能看见
    const inSidebar = findBlockGlyphs(frame).filter((h) => h.x >= 80 - 26)
    expect(inSidebar.length).toBeGreaterThan(0)

    // 交叉验证：滑块必须在侧栏**右边界以内**（x < 79）。修前 scrollbox 比容器宽 2 列，
    // 滚动条被推到边框之外 ⇒ 这里会失败。
    expect(inSidebar.every((h) => h.x < 79)).toBe(true)

    // 滑块还得是**看得见**的颜色：默认滑块近黑（RGBA 37,37,39），深色背景下等于隐身。
    // 用 captureSpans 查滑块所在单元格的前/背景，必须命中 SIDEBAR_SCROLLBAR_OPTIONS 的颜色。
    const want = (() => {
      const n = parseInt('#8b93a1'.slice(1), 16)
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
        .map((v) => v.toFixed(3)).join(',')
    })()
    const keyOf = (c: { r: number; g: number; b: number }): string =>
      [c.r, c.g, c.b].map((v) => v.toFixed(3)).join(',')
    let thumbColored = false
    for (const hit of inSidebar) {
      let x = 0
      for (const sp of setupSpans(f.setup, hit.y)) {
        if (x === hit.x && (keyOf(sp.fg) === want || keyOf(sp.bg) === want)) thumbColored = true
        x += sp.width
      }
    }
    expect(thumbColored).toBe(true)
    await f.cleanup()
  })
})

describe('统计 tab：缓存命中率', () => {
  it('cacheUsageLine：命中率按 cacheHitRate 口径（一位小数），零输入不产生 NaN', () => {
    expect(cacheUsageLine({ ...emptyUsage(), inputTokens: 1000, cacheReadTokens: 840 }))
      .toBe('缓存⚡840 · 未命中160 · 命中率84%')
    expect(cacheUsageLine({ ...emptyUsage(), inputTokens: 1000, cacheReadTokens: 845 }))
      .toBe('缓存⚡845 · 未命中155 · 命中率84.5%')
    // 零输入 / NaN：必须是 0%，不能是 NaN%
    expect(cacheUsageLine(emptyUsage())).toContain('命中率0%')
    expect(cacheUsageLine({ ...emptyUsage(), inputTokens: Number.NaN, cacheReadTokens: Number.NaN }))
      .toContain('命中率0%')
  })

  it('真实渲染：跑到 stats tab 能看见「命中率」一行', async () => {
    const f = await mountTui({ tokenUsage: { input: 1000, output: 20, cacheRead: 840 }, size: { width: 100, height: 24 } })
    await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
    await f.setup.mockInput.typeText('hi')
    pressSubmit(f.setup)
    await waitFrame(f.setup, (fr) => fr.includes('你好，我是 TUI 助手。'))
    // context → sessions → tasks → files → stats
    for (let i = 0; i < 4; i++) f.setup.mockInput.pressKey('ARROW_RIGHT')
    const frame = await waitFrame(f.setup, (fr) => fr.includes('命中率'))
    expect(frame).toContain('缓存⚡840')
    expect(frame).toContain('命中率84%')
    await f.cleanup()
  })
})

describe('鼠标选区：闪烁 + 可点击复制', () => {
  /**
   * `captureSpans()` 的 bg 分量是 **0~1 浮点**（不是 0~255）—— 直接拿 hex 去比永远不相等。
   * 用同一个 toFixed(3) 口径归一，颜色常量改了测试也不会失效。
   */
  const rgbKey = (hex: string): string => {
    const n = parseInt(hex.slice(1), 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
      .map((v) => v.toFixed(3))
      .join(',')
  }
  const keyOf = (c: { r: number; g: number; b: number }): string =>
    [c.r, c.g, c.b].map((v) => v.toFixed(3)).join(',')

  /** 取某行 [x 起点, 背景色 key] 列表 */
  function lineBgs(setup: TestRendererSetup, y: number): Array<{ x: number; rgb: string }> {
    let x = 0
    return (setup.captureSpans().lines[y]?.spans ?? []).map((sp) => {
      const row = { x, rgb: keyOf(sp.bg) }
      x += sp.width
      return row
    })
  }

  it('拖选后出现可点击的「⧉ 复制」，且选中文字高亮在 A/B 两套配色间交替', async () => {
    const f = await mountTui({ responses: [{ match: /选我/, response: '可以拖选的测试文本在这一行。' }] })
    await waitFrame(f.setup, (fr) => fr.includes('会话上下文'))
    await f.setup.mockInput.typeText('选我')
    pressSubmit(f.setup)
    const frame = await waitFrame(f.setup, (fr) => fr.includes('可以拖选的测试文本'))
    // 在**用户消息行**（纯 text 块）上拖选：`❯ 选我`
    const pos = locateChar(frame, '❯ 选我')
    expect(pos).not.toBeNull()
    const selX = pos!.x + 2

    await f.setup.mockMouse.drag(selX, pos!.y, selX + 1, pos!.y)
    await settleEffects(f.setup)
    // ⚠️ 行号会**位移**：拖选的 mouseUp 会冒泡选中整块，块上方插入「▌已选中」标记行，
    // 正文整体下移一行 —— 必须重新定位，否则采样的是别的行（踩过）。
    const selY = locateChar(f.setup.captureCharFrame(), '❯ 选我')!.y

    // 1) 输入行出现**可点击**的复制按钮（修前整条 chip 只能"点一下清除选区"，没有复制入口）
    const chip = await waitFrame(f.setup, (fr) => /⧉ 复制 \d+ 字符/.test(fr))
    const n = Number(/⧉ 复制 (\d+) 字符/.exec(chip)![1])
    expect(n).toBeGreaterThan(0)

    // 2) 闪烁：采样选中行，背景应在 A/B 两套之间切换（内核读 selectionBg/selectionFg）
    const A = rgbKey(SELECTION_BLINK_A.bg)
    const B = rgbKey(SELECTION_BLINK_B.bg)
    const seen = new Set<string>()
    for (let i = 0; i < 20 && seen.size < 2; i++) {
      for (const { x, rgb } of lineBgs(f.setup, selY)) {
        if (x >= selX && x <= selX + 1 && (rgb === A || rgb === B)) seen.add(rgb)
      }
      await new Promise((r) => setTimeout(r, 80))
      await pumpOnce(f.setup)
    }
    expect(seen.has(A)).toBe(true)
    expect(seen.has(B)).toBe(true)

    // 3) 点击复制按钮 ⇒ 出现「✓ 已复制」反馈，且**不清掉选区**
    //
    // ⚠️ 必须按「带数量」的特征定位**输入行的 chip**：正文块里也有一个「⧉ 复制」按钮，
    // `locateChar(frame, '⧉ 复制')` 会命中上面那个（踩过：结果点成块的复制，还把选区弄丢了）。
    const chipBtn = (() => {
      const lines = f.setup.captureCharFrame().split('\n')
      for (let y = 0; y < lines.length; y++) {
        const m = /⧉ 复制 \d+ 字符/.exec(lines[y])
        if (m) return { x: m.index, y }
      }
      return null
    })()
    expect(chipBtn).not.toBeNull()
    await f.setup.mockMouse.click(chipBtn!.x + 2, chipBtn!.y)
    const after = await waitFrame(f.setup, (fr) => fr.includes('✓ 已复制'))
    expect(after).toContain(`✓ 已复制 ${n} 字符`)

    // 4) 复制提示会自动收起（没有 ✕ 子按钮：同一行两个相邻 text 的命中测试不可靠，实测点不中）
    await waitFrame(f.setup, (fr) => !fr.includes('✓ 已复制'), 1200)
    await f.cleanup()
  }, 20_000)

  it('拖选 assistant（markdown）块 ⇒ 块顶部出现「选区已选中此块」闪烁标记（整块响应式高亮）', async () => {
    const f = await mountTui({ responses: [{ match: /拖我/, response: '这是要被选中的 assistant 文本，用来验证整块的选区响应。' }] })
    await waitFrame(f.setup, (frame) => frame.includes('会话上下文'))
    await f.setup.mockInput.typeText('拖我')
    pressSubmit(f.setup)
    const frame = await waitFrame(f.setup, (fr) => fr.includes('这是要被选中的 assistant 文本'))
    // 在 assistant（markdown）文本上拖选 —— 这是 markdown 块，内核无法改其选区配色，
    // 修复目标是：应用层沿 selectedRenderables 父链定位到块、给块加闪烁标记。
    const pos = locateChar(frame, '这是要被选中的')
    expect(pos).not.toBeNull()
    const selX = pos!.x + 2
    await f.setup.mockMouse.drag(selX, pos!.y, selX + 1, pos!.y)
    // 拖选 mouseUp 会冒泡选中整块、正文下移 → 以 chip 出现 + 块标记为准
    await waitFrame(f.setup, (fr) => /⧉ 复制 \d+ 字符/.test(fr))
    await waitFrame(f.setup, (fr) => fr.includes('选区已选中此块'))
    await f.cleanup()
  }, 20_000)
})
