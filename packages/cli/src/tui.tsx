/**
 * @harness/cli - TUI 模式（OpenTUI 渲染层）
 *
 * 基于 @opentui/core + @opentui/react（Bun 原生，Zig 渲染核心）实现全屏 TUI。
 * 相对自研 ANSI 渲染：布局/焦点/滚动/键盘解码全部交给 OpenTUI（Yoga flexbox + Zig
 * 渲染核心），并直接获得 <markdown>/<code> 等富文本与语法高亮组件。
 *
 * 界面能力（Claude Code 风格）：
 *  - Markdown 渲染：assistant 正文用 <markdown> 流式渲染（标题/加粗/列表/表格/代码块）
 *  - 代码块高亮：<markdown> 内嵌 fenced code 由 OpenTUI Tree-sitter 语法着色
 *  - 文件引用：findFileReferences 从文本中提取路径，侧栏「文件引用」展示；
 *    Tab 进入引用列表，上下键选中，Enter 经 openFile 打开（带行号）
 *  - 多面板：主对话区 + 右侧会话上下文面板（Ctrl-B 切换）
 *  - 状态栏扩展：provider / agent / model / 忙碌指示 / 快捷键提示
 *  - 流式性能：onEvent 的增量事件按宏任务批合并再提交，避免高频 chunk 逐次全量重解析 markdown
 *
 * 会话内核复用 createProcessLine。TUI 传入：
 *  - `out`：只收非结构化输出（用户回显 / 工具行 / 命令输出 / 计时），归类为块
 *  - `onEvent`：收 <thinking>/<assistant> 结构化增量，做流式 markdown / 推理块
 * 测试用 @opentui/core/testing 的 createTestRenderer + mockInput 模拟按键。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  formatAgentPhase,
  initialAgentStatus,
  isAgentBusy,
  reduceAgentStatus,
  type AgentIdentity,
  type AgentStatus,
} from './agent-status'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCliRenderer, createTextAttributes, SyntaxStyle, RGBA, type CliRenderer, type TextareaRenderable } from '@opentui/core'
import { createRoot, useKeyboard, useAppContext } from '@opentui/react'
import { createProcessLine, attachAutoContinue, listReplCommands, describeSessionRestore, buildCompactionOptions, resolveCompactionWindow, renderContextOccupancy, formatToolInput, formatToolResult, TOOL_CONT_MARK } from './index'
import type { HarnessApp } from './index'
import type { AgentStreamEvent, Harness } from '@harness/core'
import type { CompactionBlock, CompactOptions, HistoryLoadRange, Message, Session } from '@harness/session'
import type { BackgroundTaskViewLike } from '@harness/plugin'
import { subagentCapability } from '@harness/subagent'
import { findFileReferences, collectFileRefsFromTexts, resolveEditPath, buildDiskFileTree, renderFileRefTree, anyMarked, abbrevFileRef } from '@harness/host'
import { detectKeyboardProtocol, shiftEnterHelpLine } from './keyboard'
import {
  emptyUsage,
  recordCall,
  recordTool,
  recordTaskDone,
  uncachedInput,
  cacheHitRate,
  modelUsageRow,
  toolUsageRow,
  agentUsageRow,
  hourLabel,
  hourlyRow,
  sparkline,
  USAGE_STATS_KEY,
  hydrateUsage,
  isBlankUsage,
  todayUsageLine,
  usageFromMeta,
  type UsageStats,
} from './usage-stats'
import { collectTodayUsage } from './usage-today'

// ------------------------------------------------------------------------
// 类型
// ------------------------------------------------------------------------

/** 测试观测：记录到达全局键盘 handler 的键（仅调试用） */
export const __KEYLOG: string[] = []
/** 仅供测试重置 */
export function __resetKeyLog(): void {
  __KEYLOG.length = 0
}

export interface TuiReplOptions {
  app: HarnessApp
  harness: Harness
  session: Session
  /** provider 名称（状态栏展示；未传时显示 auto） */
  provider?: string
  /** 默认模型 ID（状态栏/侧栏初始展示；发送完成后以实际命中的模型刷新） */
  model?: string
  /** 侧栏文件引用跳转：按 Enter 打开指定（含可选行号）文件。未传则禁用该项交互。 */
  openFile?: (path: string, line?: number) => Promise<void> | void
  /** 收到普通用户输入时回调（REPL 回显前触发） */
  onLine?: (line: string) => Promise<void> | void
  /**
   * 阶段四·按需渲染：惰性加载会话原文（压缩块展开 / 更早分页）。
   * 未传则压缩块只显示提示、点击不展开（/history 兜底全量）。
   */
  loadHistory?: (sessionId: string, range?: HistoryLoadRange) => Promise<Message[]>
}

export type TuiReplExit = 'exit'

/** 侧栏面板宽度（单元格） */
const SIDEBAR_WIDTH = 26

/**
 * 侧栏滚动条配色。
 *
 * 为什么必须显式给：OpenTUI 的滑块默认色是 `RGBA(37,37,39)`（近黑），在深色背景上**等于看不见**
 * —— 用户会以为"这个面板不能滚"。这里只改滑块色，轨道保持透明（不抢注意力）。
 */
const SIDEBAR_SCROLLBAR_OPTIONS = { trackOptions: { foregroundColor: '#8b93a1' } } as const

/** 选区闪烁周期（ms）。450ms 接近终端光标闪烁节奏：够显眼又不晃眼 */
export const SELECTION_BLINK_MS = 450
/** 选区闪烁的两套配色（A 亮黄底黑字 / B 暗灰底浅字，交替即"闪"） */
export const SELECTION_BLINK_A = { bg: '#d7a521', fg: '#1a1f29' } as const
export const SELECTION_BLINK_B = { bg: '#3a4150', fg: '#e6e9ef' } as const
/** 侧栏最多展示的文件引用条数 */
const MAX_FILE_REFS = 8

// ------------------------------------------------------------------------
// 模块 D：帮助面板内容（Ctrl-/ 或 ? 弹出；/help 查看命令列表并在 REPL 层列出）
// ------------------------------------------------------------------------
/** 终端键盘协议能力（模块级探测一次：CLI 是单进程单终端，env 不会中途变） */
const keyboardSupport = detectKeyboardProtocol()

/** 帮助面板行：{ key: 键位, desc: 说明 } */
export const HELP_LINES: Array<{ key: string; desc: string }> = [  { key: 'Ctrl-C', desc: '退出 TUI' },
  { key: 'Ctrl-B', desc: '切换右侧面板' },
  { key: 'Ctrl-/ 或 ?', desc: '打开/关闭帮助面板' },
  { key: 'Ctrl-Y', desc: '复制鼠标选中的文字；无选区则复制最近回复' },
  { key: 'Tab', desc: '进入文件引用/会话列表' },
  { key: '↑ / ↓', desc: '命令菜单或历史中选取' },
  { key: '◀ / ▶', desc: '侧栏模块切换（输入为空时）' },
  { key: 'Enter', desc: '提交输入；列表/菜单中确认选中' },
  { key: '\\ + Enter', desc: '输入框内换行（最可靠：行尾打反斜杠再回车，不依赖终端修饰键）' },
  // Shift+Enter 行的 desc 渲染时按终端能力分级（见下方 helpLines），这里保留兜底文案占位
  { key: 'Shift+Enter', desc: '输入框内换行（需终端上报 Shift，如 Kitty 键盘协议）' },
  { key: 'Ctrl+J', desc: '提交输入（同 Enter；兼容把 Enter 上报为 LF 的终端）' },
  { key: 'Esc', desc: '关闭菜单或帮助' },
  { key: '/help', desc: '查看特殊命令' },
  { key: '/agent, /model', desc: '切换本会话的 Agent / 模型（只影响当前会话）' },
]

// ------------------------------------------------------------------------
// 模块 4：侧栏图标 tab（每次展示一个面板，点击图标切换）
// ------------------------------------------------------------------------
export type SidebarTabId = 'context' | 'sessions' | 'tasks' | 'files' | 'stats'

export const SIDEBAR_TABS: Array<{ id: SidebarTabId; icon: string; label: string }> = [
  { id: 'context', icon: '⌂', label: '会话上下文' },
  { id: 'sessions', icon: '💬', label: '会话' },
  { id: 'tasks', icon: '⚙', label: '任务' },
  { id: 'files', icon: '🔗', label: '文件' },
  { id: 'stats', icon: '📊', label: '统计' },
]

/** 侧栏 tab 索引（供 ◀/▶ 循环切换） */
export function nextSidebarTab(current: SidebarTabId, delta: 1 | -1): SidebarTabId {
  const i = SIDEBAR_TABS.findIndex((t) => t.id === current)
  const n = SIDEBAR_TABS.length
  return SIDEBAR_TABS[(((i < 0 ? 0 : i) + delta) % n + n) % n].id
}

// ------------------------------------------------------------------------
// 结构化块模型（纯函数可单测）
// ------------------------------------------------------------------------

export type ChatBlockKind = 'system' | 'user' | 'thinking' | 'assistant' | 'tool' | 'compact' | 'loadmore'

export interface ChatBlock {
  id: number
  kind: ChatBlockKind
  /** 渲染内容：assistant 为 markdown；thinking 为推理文本；其余为控制台文本 */
  text: string
  /** assistant/thinking 流式进行中（尚未 done） */
  streaming?: boolean
  /** 关联原始消息 id（展开/分页插入的原文块；防重复） */
  msgId?: string
  /** 关联压缩块 id（kind==='compact'，展开时经 loader 取回该块原文） */
  blockId?: string
  /** 压缩块展开进行中 */
  loading?: boolean
}

export interface ChatState {
  blocks: ChatBlock[]
  nextId: number
  /** 当前流式 thinking 块下标（-1 无） */
  thinkingIdx: number
  /** 当前流式 assistant 块下标（-1 无） */
  assistantIdx: number
}

export const initialChatState: ChatState = { blocks: [], nextId: 1, thinkingIdx: -1, assistantIdx: -1 }

/** 带欢迎语的初始状态 */
export function initialChatWithWelcome(welcome: string): ChatState {
  return { blocks: [{ id: 0, kind: 'system', text: welcome }], nextId: 1, thinkingIdx: -1, assistantIdx: -1 }
}

/** 单行控制台文本 → 块类型与净化后的内容 */
export function classifyConsoleLine(line: string): { kind: ChatBlockKind; text: string } {
  const t = line.replace(/^\u0020/, '') // 去掉行首单个空格
  // 多行工具结果的续行（见 index.ts 的 TOOL_CONT_MARK）：归回 tool 块并**剥掉标记**，
  // 标记只在传输层存在 —— 落到块文本里的必须是干净的原文（复制出去的也一样）。
  if (t.startsWith(TOOL_CONT_MARK)) return { kind: 'tool', text: t.slice(TOOL_CONT_MARK.length) }
  if (t.startsWith('🧑')) return { kind: 'user', text: t.replace(/^\S+\s*/, '').trim() }
  if (t.startsWith('💭')) return { kind: 'thinking', text: t.replace(/^\S+\s*/, '').trim() }
  if (t.startsWith('🤖')) return { kind: 'assistant', text: t.replace(/^\S+\s*/, '').trim() }
  if (t.startsWith('🔧') || t.startsWith('✅') || t.startsWith('❌')) return { kind: 'tool', text: t }
  if (t.startsWith('⏱️')) return { kind: 'system', text: t }
  return { kind: 'system', text: t }
}

/** 追加一段控制台文本（按 \n 拆行归类为新块；空行忽略）。
 *  system（命令输出）/ tool（工具输出）类块向前**跳过 thinking 块**与上一个同类块合并，
 *  使一次 agent 应答的多步工具调用（中间夹推理/自述）归并为单块 —— 复制按钮只在整段末尾出现一次；
 *  user/thinking/assistant 各自独立；欢迎块 id 0 不参与合并，避免首条输出污染静态欢迎文本。 */
export function pushConsole(state: ChatState, text: string): ChatState {
  let s = state
  for (const raw of text.split('\n')) {
    const line = raw
    if (!line.trim()) continue
    const { kind, text: body } = classifyConsoleLine(line)
    if (kind === 'system' || kind === 'tool') {
      // 可合并：从末尾向前跳过一个或多个 thinking 块，落到最近的 system/tool 块
      let i = s.blocks.length - 1
      while (i >= 0 && s.blocks[i].kind === 'thinking') i--
      const last = i >= 0 ? s.blocks[i] : undefined
      if (last && last.id !== 0 && last.kind === kind && !last.streaming) {
        const blocks = s.blocks.slice()
        blocks[i] = { ...last, text: last.text + '\n' + body }
        s = { ...s, blocks }
        continue
      }
    }
    s = { ...s, blocks: [...s.blocks, { id: s.nextId, kind, text: body }], nextId: s.nextId + 1 }
  }
  return s
}

// ------------------------------------------------------------------------
// 工具块的「首尾窗口」（只收渲染，不动块文本）
// ------------------------------------------------------------------------
// 为什么窗口必须加在**渲染层**、而不是回到 `formatToolResult` 里截断：
//  1. `pushConsole` 会把一次应答里的所有 tool 行**合并成一个块**，块文本即全文 —— 「复制全文」
//     才有全文可取。（在传输层截断的话，全文到此就没了。）
//  2. 传输层截断**没法只截某一条工具的结果**：合并块里有多条工具，按块截会把中间几条的
//     `🔧 工具名 {入参}` 行整段切掉 —— 那正是这次要修的毛病。真机 80×24 帧实测：拿掉截断后
//     `bash {command:"seq 1 3000"}` 的结果把 🔧 行挤出视口，对话框里"看不到工具调用了"。
//
// 所以按「工具调用段落」（🔧 行起、到下一条 🔧 行前）分段，每段只留首尾。**两个预算都要**，
// 因为它们各自堵一种灌屏方式（实测都是真机踩到的）：
//   · 行数预算：挡「很多短行」—— `bash {command:"seq 1 3000"}` 是 3000 行 6 字符；
//   · 字符预算：挡「少数超长行」—— 工具返回对象的 JSON 是**单行**，16000 字符在 80 列终端
//     折成 ~13 行，只限行数等于没限（首版就栽在这里：行窗口生效了，🔧 仍被挤出画面）；
//   · 单行预算：挡「一条 JSON 单行入参」—— `write_file` 的 content 能到几十 KB。
export const TOOL_VIEW_HEAD_LINES = 6
export const TOOL_VIEW_TAIL_LINES = 4
export const TOOL_VIEW_HEAD_CHARS = 260
export const TOOL_VIEW_TAIL_CHARS = 220
/** 单行渲染上限（首尾各取一半，中间插省略标记） */
export const TOOL_VIEW_LINE_MAX_CHARS = 200

export interface ToolView {
  /** 渲染用的行（含省略提示行） */
  lines: string[]
  /** 是否发生过省略（决定复制按钮要不要明示"全文"） */
  truncated: boolean
  /** 块文本的完整字符数 */
  fullChars: number
}

/** 工具调用行前缀（`createProcessLine` 的 `🔧  <id> <入参>`） */
const TOOL_CALL_PREFIX = '🔧'

/** 单行首尾窗口：JSON 单行入参/结果能长到几十 KB，不切同样会灌满一屏 */
function clipToolLine(line: string): string {
  if (line.length <= TOOL_VIEW_LINE_MAX_CHARS) return line
  const half = Math.floor((TOOL_VIEW_LINE_MAX_CHARS - 20) / 2)
  return `${line.slice(0, half)} …（本行省略 ${line.length - half * 2} 字符）… ${line.slice(-half)}`
}

/** 按「工具调用段落」切分：每条以 🔧 行起、到下一条 🔧 行为止（结果里的 🔧 至多多切一段，无害） */
function splitToolSegments(lines: string[]): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.startsWith(TOOL_CALL_PREFIX) && current.length > 0) {
      segments.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/** 行数与字符数双预算地取一段（head 从头取、tail 从尾取） */
function takeWithinBudget(lines: string[], maxLines: number, maxChars: number): string[] {
  const taken: string[] = []
  let used = 0
  for (let i = 0; i < lines.length && taken.length < maxLines; i++) {
    const cost = lines[i]!.length + 1
    if (used + cost > maxChars) break
    taken.push(lines[i]!)
    used += cost
  }
  return taken
}

/**
 * 工具块文本 → 渲染行（首尾窗口）。**块文本本身不变**，完整内容仍可用「复制全文」取走。
 * 每条工具调用独立成段：一段再长也不会把下一段的 `🔧` 行挤掉。
 */
export function windowToolText(text: string): ToolView {
  const out: string[] = []
  let truncated = false
  for (const segment of splitToolSegments(text.split('\n'))) {
    const clipped = segment.map(clipToolLine)
    if (clipped.some((l, i) => l !== segment[i])) truncated = true
    const head = takeWithinBudget(clipped, TOOL_VIEW_HEAD_LINES, TOOL_VIEW_HEAD_CHARS)
    const reversed = [...clipped].reverse()
    const tail = takeWithinBudget(reversed, TOOL_VIEW_TAIL_LINES, TOOL_VIEW_TAIL_CHARS).reverse()
    if (head.length + tail.length >= clipped.length) {
      out.push(...clipped)
      continue
    }
    truncated = true
    const elided = clipped.slice(head.length, clipped.length - tail.length)
    const elidedChars = elided.reduce((n, l) => n + l.length + 1, 0)
    out.push(...head, `… 已省略 ${elided.length} 行 / ${elidedChars} 字符（完整内容用「复制全文」取）`, ...tail)
  }
  return { lines: out, truncated, fullChars: text.length }
}

/** 处理结构化流事件：reasoning→thinking 块、text→assistant 块、done→收尾 */
export function applyStreamEvent(state: ChatState, ev: AgentStreamEvent): ChatState {
  switch (ev.type) {
    case 'reasoning_delta':
      return upsertStreamBlock(state, 'thinking', ev.text ?? '')
    case 'text_delta':
      return upsertStreamBlock(state, 'assistant', ev.text ?? '')
    case 'done':
      return finalizeStream(state)
    default:
      return state
  }
}

function upsertStreamBlock(state: ChatState, kind: 'thinking' | 'assistant', text: string): ChatState {
  const idxKey = kind === 'assistant' ? 'assistantIdx' : 'thinkingIdx'
  const idx = state[idxKey]
  if (idx === -1) {
    const block: ChatBlock = { id: state.nextId, kind, text, streaming: true }
    return {
      ...state,
      blocks: [...state.blocks, block],
      nextId: state.nextId + 1,
      [idxKey]: state.blocks.length,
    }
  }
  const blocks = state.blocks.slice()
  blocks[idx] = { ...blocks[idx], text: blocks[idx].text + text }
  return { ...state, blocks }
}

function finalizeStream(state: ChatState): ChatState {
  // 无流式块时原样返回，避免 done 触发无谓重渲染
  if (state.assistantIdx === -1 && state.thinkingIdx === -1) return state
  const blocks = state.blocks.slice()
  if (state.assistantIdx !== -1) blocks[state.assistantIdx] = { ...blocks[state.assistantIdx], streaming: false }
  if (state.thinkingIdx !== -1) blocks[state.thinkingIdx] = { ...blocks[state.thinkingIdx], streaming: false }
  return { ...state, blocks, assistantIdx: -1, thinkingIdx: -1 }
}

/** 汇总所有块中的文件引用（按基础路径去重、限量；保留首次出现的原始形态） */
export function collectFileReferences(state: ChatState, max = MAX_FILE_REFS): string[] {
  return collectFileRefsFromTexts(state.blocks.map((b) => b.text), max)
}


export interface ParsedFileRef {
  path: string
  line?: number
  column?: number
}

/** 解析「路径[:行[:列]]」引用 → 路径与可选行/列号（供打开文件时定位光标） */
export function parseFileRef(ref: string): ParsedFileRef {
  const m = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(ref)
  if (!m) return { path: ref }
  return {
    path: m[1],
    line: m[2] ? Number(m[2]) : undefined,
    column: m[3] ? Number(m[3]) : undefined,
  }
}

// ------------------------------------------------------------------------
// 增量文件引用索引（长文本流式性能）
// ------------------------------------------------------------------------
// 背景：assistant 正文用 <markdown> 流式渲染时会不断向同一块追加增量文本。
// 若每次都是统一调用 collectFileReferences(state) 全量重扫所有块的文本，长回复下
// 每次 text_delta 批提交都会对 O(总文本) 重新跑一遍正则，代价随回复增长而递增。
// FileRefIndex 改为「逐块记录已扫描的长度」，只对新增尾部增量扫描并归一化去重，
// 使单批成本降至 O(增量)，而不是 O(总量)。纯函数、可单测。

/** 跨块边界向前回看窗口：即便是新增尾部将某个路径从中间切开，也能捕获完整路径前缀 */
const REF_SCAN_OVERLAP = 64

export interface FileRefIndex {
  /** blockId → 已扫描到的字符长度（之前已扫描过的部分不会重复扫描） */
  scanned: Map<number, number>
  /** 去重后的有序展示列表（按基础路径去重，保留首次出现的原始形态，限量 max 条） */
  ordered: string[]
  /** 已收录的基础路径集合（不含 :行[:列] 后缀），用于跨块/跨次归并 */
  seen: Set<string>
  /** 展示列表上限 */
  max: number
}

export function createFileRefIndex(max = MAX_FILE_REFS): FileRefIndex {
  return { scanned: new Map(), ordered: [], seen: new Set(), max }
}

/**
 * 将块文本的引用增量并入索引。同一块文本若在前次基础上增长，只扫描新增尾部
 * （回看 REF_SCAN_OVERLAP 窗口以捕获跨界路径），已收录路径自动去重。
 * 返回新索引（不可变 append）；若文本未增长则原样返回。
 */
export function indexFileReferences(index: FileRefIndex, blockId: number, text: string): FileRefIndex {
  const prevLen = index.scanned.get(blockId) ?? 0
  if (text.length <= prevLen) return index
  // 只对新增尾部扫描；从 prevLen 前回看一小段，保证跨边界的路径前缀不丢
  const sliceStart = Math.max(0, prevLen - REF_SCAN_OVERLAP)
  const slice = text.slice(sliceStart)
  let { ordered, seen, max } = index
  for (const f of findFileReferences(slice)) {
    const base = f.path.replace(/:\d+(?::\d+)?$/, '')
    if (seen.has(base)) continue
    seen.add(base)
    ordered = ordered.concat(f.path)
    if (ordered.length >= max) break
  }
  // 无论是否有新增引用，都要把本块已扫描长度推进到当前文本长度，
  // 否则下一次增量会在同一段文本上重复扫描。
  const scanned = index.scanned.set(blockId, text.length)
  return { scanned, ordered, seen, max }
}

/** 将一批流事件按顺序 apply，合并为一次 state 提交（供流式增量批处理） */
export function batchReduceStream(state: ChatState, events: AgentStreamEvent[]): ChatState {
  return events.reduce(applyStreamEvent, state)
}

// ------------------------------------------------------------------------
// 后台任务快照（模块 A：TUI 侧栏实时面板）
// ------------------------------------------------------------------------
// 架构 §8.1 点3「前端事件驱动展示」在 TUI 侧闭环：侧栏订阅 subagent 插件
// 的 BackgroundTaskMonitor（与 REPL attachBackgroundTaskPanel 同源，但不打印
// stdout，而是渲染为 React state 的实时面板）。status 图标 / 缩写 taskId / 行
// 文本为纯函数，可单测。

/** 后台任务在侧栏的单节展示上限（running + finished 各限几个） */
const MAX_RUNNING_BG = 3
const MAX_FINISHED_BG = 3

/**
 * 归并一次后台任务快照：monitor 每次回调携带全量最新任务（含已完成的存档），
 * 直接以最新全量为准做浅拷贝归一化（trading 稳定 vs 归并叠加，优先取全量最新）。
 */
export function applyBackgroundTaskSnapshot(
  _prev: readonly BackgroundTaskViewLike[],
  tasks: readonly BackgroundTaskViewLike[],
): BackgroundTaskViewLike[] {
  return [...tasks]
}

/** 后台任务状态图标 */
export const BG_STATUS_ICON: Record<BackgroundTaskViewLike['status'], string> = {
  pending: '○', running: '⏳', completed: '✅', failed: '❌',
}

/** 一行后台任务摘要（侧栏展示长文本会 wrap，故缩写 taskId） */
export function bgTaskRow(t: BackgroundTaskViewLike): string {
  const icon = BG_STATUS_ICON[t.status] ?? '·'
  const name = t.agentName ?? t.agentId ?? 'agent'
  const id = t.taskId.length > 10 ? `${t.taskId.slice(0, 8)}…` : t.taskId
  const progress = t.status === 'running' && t.progress?.length ? ` ${t.progress.length}步` : ''
  const result = t.status === 'completed' && t.result ? ` ~ ${t.result.slice(0, 18)}` : ''
  return `${icon} ${id} ${name}${progress}${result}`
}

/** 把快照分成「进行中」与「已结束」两组（渲染分别限量，进行中优先置顶） */
export function splitBgTasks(tasks: readonly BackgroundTaskViewLike[]): {
  running: BackgroundTaskViewLike[]
  finished: BackgroundTaskViewLike[]
} {
  const running: BackgroundTaskViewLike[] = []
  const finished: BackgroundTaskViewLike[] = []
  for (const t of tasks) (t.status === 'running' || t.status === 'pending' ? running : finished).push(t)
  return { running, finished }
}

// ------------------------------------------------------------------------
// 会话历史渲染（模块 B：会话切换时把消息历史转成对话块）
// ------------------------------------------------------------------------
// 切换会话（/resume）后，TuiApp 用 setSession 回调把新会话的 messages
// 还原为对话块，重新展示历史对话。text / reasoning part 拼为正文，
// **tool part 还原成工具块**（`toolPartLines`）—— 少了后者，恢复出来的会话只剩
// 「提问 + 结论」，中间干了什么全不见：一个 40 步的任务恢复后看起来像一气呵成，
// 而实时跑同一条任务时工具输出是看得见的。同一份历史，两条通道看到的东西不该不同。

/** 提取一条消息的正文文本（text part 拼接 + reasoning 追加，工具/文件/图片跳过） */
export function messageText(msg: Message): string {
  let out = ''
  for (const p of msg.parts) {
    if (p.type === 'text' && (p as { text?: string }).text) out += (p as { text?: string }).text
    else if (p.type === 'reasoning' && (p as { text?: string }).text) out += '\n💭' + (p as { text?: string }).text
  }
  return out
}

/** 按角色推导对话块类型 */
export function roleToKind(role: Message['role']): ChatBlockKind {
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  if (role === 'tool') return 'tool'
  return 'system'
}

/**
 * 工具 part → 回显行。形状与实时输出**逐字一致**：`createProcessLine` 打的是
 * `🔧  <id> <完整入参>` / `✅|❌  → <完整结果>`，`windowToolText` 又按 `🔧` 分段做首尾窗口 ——
 * 形状一致，历史块与实时块才共用同一套渲染（首行加粗 + `│ `/`└ ` 树状缩进）与同一套窗口化。
 * 序列化复用 `formatToolInput/formatToolResult`（REPL/TUI 实时通道用的就是它们），
 * 所以历史里看到的入参与结果，与当时实时看到的是同一份文本。
 */
export function toolPartLines(p: {
  toolId?: string
  input?: unknown
  result?: unknown
  isError?: boolean
}): string[] {
  const lines = [`🔧  ${p.toolId ?? 'tool'} ${formatToolInput(p.input)}`]
  // 无 result ⇒ 这一步没跑完就落盘了（被中断 / 崩在工具里）：只留「调用了什么」，
  // 不补一个空的结果行假装它跑过。
  if (p.result !== undefined) lines.push(`${p.isError ? '❌' : '✅'}  → ${formatToolResult(p.result)}`)
  return lines
}

/** 阶段四·按需渲染：单页渲染的历史消息条数上限（超出显示"更早省略"提示块） */
export const HISTORY_PAGE = 100


/**
 * 一条消息 → 对话块。**可能是多个**：一条 assistant 消息里既可能有序正文、也可能有工具调用
 * （真机会话实测：`parts` 就是 `[reasoning, tool, tool, ...]` 这样的序列），
 * 按 part 出现顺序切成「正文块 + 工具块」。全空 part 不产出块。
 *
 * 为什么正文与工具要分成**不同 kind 的块**：正文走 markdown 渲染，工具行走等宽树状渲染，
 * 混一个块里要么工具行被 markdown 吃掉缩进、要么正文被当成控制台文本（不解析 markdown）。
 *
 * 多块带来的 id 递增由调用方负责（`idStart` 起顺排），保证与 `pushConsole` 追加的实时块不撞 id。
 */
function messageToBlocks(m: Message, idStart: number): ChatBlock[] {
  const out: ChatBlock[] = []
  let nextId = idStart
  const textKind = roleToKind(m.role)
  let text = ''
  let tools: string[] = []
  const flushText = (): void => {
    if (!text.trim()) {
      text = ''
      return
    }
    out.push({ id: nextId++, kind: textKind, text, msgId: m.id })
    text = ''
  }
  const flushTools = (): void => {
    if (tools.length === 0) return
    out.push({ id: nextId++, kind: 'tool', text: tools.join('\n'), msgId: m.id })
    tools = []
  }
  for (const p of m.parts) {
    const t = (p as { text?: string }).text
    // 正文与工具交替出现时按出现顺序切开：`flushTools()` 保证工具块不被后一段正文"吞掉"
    if (p.type === 'text' && t) {
      flushTools()
      text += t
    } else if (p.type === 'reasoning' && t) {
      flushTools()
      text += '\n💭' + t
    } else if (p.type === 'tool') {
      flushText()
      tools.push(...toolPartLines(p as { toolId?: string; input?: unknown; result?: unknown; isError?: boolean }))
    }
  }
  flushText()
  flushTools()
  return out
}

/** 压缩块 → 提示行文本（只展示元信息，不渲染 summary 内容，符合"仅提示自动压缩过"） */
export function compactBlockText(b: CompactionBlock): string {
  const topic = b.topic ? `[${b.topic}] ` : ''
  const source = b.source === 'acp' ? 'ACP 折叠' : '会话压缩'
  return `📦 已自动压缩历史 · ${topic}${source}（${b.summary.length} 字摘要，点击展开原文）`
}

/**
 * 阶段四·按需渲染：把会话历史转成 ChatState。
 * - `blocks`（压缩块）按 at 升序渲染为 compact 提示块，置于最前（时间上早于近期消息）；
 *   为空则不产生任何块（回归零变化）。
 * - `messages` 超过 `page` 条时只渲染末尾 `page` 条，并在最前插入 loadmore 提示块
 *   （未压缩超长会话的首屏可控；更早内容点击加载）。
 */
export function messagesToBlocks(
  messages: Message[],
  blocks?: CompactionBlock[],
  page = HISTORY_PAGE,
): ChatState {
  const out: ChatBlock[] = []
  let nextId = 1

  const push = (b: ChatBlock | undefined): void => {
    if (b) {
      out.push(b)
      nextId++
    }
  }

  /** 一条消息可能产出多个块（正文 + 工具），id 从 `nextId` 起顺排 */
  const pushMsg = (m: Message): void => {
    for (const b of messageToBlocks(m, nextId)) {
      out.push(b)
      nextId++
    }
  }

  if (blocks && blocks.length > 0) {
    for (const b of [...blocks].sort((x, y) => (x.at ?? 0) - (y.at ?? 0))) {
      push({ id: nextId, kind: 'compact', text: compactBlockText(b), blockId: b.id })
    }
  }

  let visible = messages
  if (messages.length > page) {
    visible = messages.slice(messages.length - page)
    const hidden = messages.length - page
    push({ id: nextId, kind: 'loadmore', text: `▲ 更早 ${hidden} 条消息已省略（点击加载更多）` })
  }

  for (const m of visible) pushMsg(m)

  return { blocks: out, nextId, thinkingIdx: -1, assistantIdx: -1 }
}

/**
 * 阶段四·按需渲染：把某压缩块的原文展开到提示块位置（替换该 compact 块）。
 * 未命中 blockId 时原样返回 state；originals 中的空消息跳过。
 */
export function expandCompactBlocks(state: ChatState, blockId: string, originals: Message[]): ChatState {
  const idx = state.blocks.findIndex((b) => b.kind === 'compact' && b.blockId === blockId)
  if (idx < 0) return state
  const inserted: ChatBlock[] = []
  let nextId = state.nextId
  for (const m of originals) {
    for (const b of messageToBlocks(m, nextId)) {
      inserted.push(b)
      nextId++
    }
  }
  if (inserted.length === 0) return state
  const blocks = state.blocks.slice()
  blocks.splice(idx, 1, ...inserted)
  return { ...state, blocks, nextId }
}

/**
 * 阶段四·按需渲染：把更早一页原文插入 loadmore 提示块之后。
 * 若 `older` 已覆盖全部隐藏消息（长度 < page 或调用方判定），则移除 loadmore 块。
 */
export function loadOlderBlocks(state: ChatState, older: Message[], page = HISTORY_PAGE): ChatState {
  const idx = state.blocks.findIndex((b) => b.kind === 'loadmore')
  if (idx < 0) return state
  const inserted: ChatBlock[] = []
  let nextId = state.nextId
  for (const m of older) {
    for (const b of messageToBlocks(m, nextId)) {
      inserted.push(b)
      nextId++
    }
  }
  const blocks = state.blocks.slice()
  if (older.length < page) {
    // 已加载到底：移除省略提示，插入全部
    blocks.splice(idx, 1, ...inserted)
  } else {
    // 还有更早：提示块保持在最前，原文插其后
    blocks.splice(idx + 1, 0, ...inserted)
  }
  return { ...state, blocks, nextId }
}

/** 侧栏会话列表行（来自 store.list） */
export interface SessionRow {
  id: string
  title: string
  messageCount: number
  updatedAt: number
}

/** 把 store.list 结果转成侧栏展示行（标题缺失用会话 id 兜底） */
export function toSessionRows(
  items: Array<{ id: string; title?: string; updatedAt: number; messageCount: number }>,
): SessionRow[] {
  return items.map((s) => ({ id: s.id, title: s.title || s.id, messageCount: s.messageCount, updatedAt: s.updatedAt }))
}

/** 一行会话摘要（侧栏展示，标题/时间缩写） */
export function sessionRowText(r: SessionRow, now: number): string {
  const when = now - r.updatedAt
  const ago =
    when < 60_000 ? `${Math.floor(when / 1000)}s`
      : when < 3_600_000 ? `${Math.floor(when / 60_000)}m`
        : when < 86_400_000 ? `${Math.floor(when / 3_600_000)}h`
          : `${Math.floor(when / 86_400_000)}d`
  return `${r.messageCount}条 ${ago} ${r.title.length > 16 ? r.title.slice(0, 15) + '…' : r.title}`
}

// ------------------------------------------------------------------------
// 统计面板（模块 D2）：侧栏「统计」块 —— 会话消息/字符/token/任务/用时
// ------------------------------------------------------------------------
// 纯函数便于单测。token 估算沿用压缩阈值口径（字符数 / 4）。
// 用量累积（UsageStats / recordCall / recordTool …）见 ./usage-stats.ts，这里 re-export 保持既有出口。

export type {
  UsageStats,
  ModelUsage,
  ToolUsage,
  AgentUsage,
  HourlyUsage,
  CallRecord,
  ToolRecord,
} from './usage-stats'
export {
  emptyUsage,
  recordCall,
  recordTool,
  recordTaskDone,
  uncachedInput,
  cacheHitRate,
  modelUsageRow,
  toolUsageRow,
  agentUsageRow,
  hourLabel,
  hourlyRow,
  sparkline,
  USAGE_STATS_KEY,
  usageFromMeta,
  usageFromMessages,
  renderStatsText,
  exportStatsJson,
  exportStatsMarkdown,
  dayStart,
  usageSince,
  todayUsage,
  mergeUsage,
  sumUsage,
  hydrateUsage,
  isBlankUsage,
  todayUsageLine,
} from './usage-stats'

export interface TuiStats {
  /** 各角色块计数 */
  users: number
  assistants: number
  thinking: number
  tools: number
  /** 全部块字符数 */
  chars: number
  /** 本地 token 估算 = chars / 4 */
  tokens: number
  /** 后台任务进行中 / 已结束 */
  tasksRunning: number
  tasksDone: number
  /** 会话已运行毫秒 */
  elapsedMs: number
  /** 完整用量累积器（会话级，含模型/tools/agents/hourly/缓存明细） */
  usage: UsageStats
}

/** 从对话块 + 后台任务归并出侧栏统计指标；usage 为事件累积的实际用量（可缺省） */
export function computeTuiStats(
  blocks: readonly ChatBlock[],
  bgTasks: readonly BackgroundTaskViewLike[],
  elapsedMs: number,
  usage: UsageStats = emptyUsage(),
): TuiStats {
  let users = 0
  let assistants = 0
  let thinking = 0
  let tools = 0
  let chars = 0
  for (const b of blocks) {
    chars += b.text.length
    if (b.kind === 'user') users++
    else if (b.kind === 'assistant') assistants++
    else if (b.kind === 'thinking') thinking++
    else if (b.kind === 'tool') tools++
  }
  let tasksRunning = 0
  let tasksDone = 0
  for (const t of bgTasks) (t.status === 'running' || t.status === 'pending' ? tasksRunning++ : tasksDone++)
  return {
    users, assistants, thinking, tools, chars, tokens: Math.round(chars / 4), tasksRunning, tasksDone, elapsedMs,
    usage,
  }
}

/**
 * 缓存用量一行：命中量 / 未命中量 / **命中率**。
 *
 * 命中率是这三项里唯一需要"算"的（前两个是原始计数），也是判断缓存到底有没有在起作用的关键
 * 一眼 —— 此前侧栏只给绝对量，用户得自己拿计算器除。口径集中走 `cacheHitRate()`：它已把
 * 非法值/零输入一律归 0，绝不让 `NaN%` 漏到界面。
 */
export function cacheUsageLine(u: UsageStats): string {
  return `缓存⚡${u.cacheReadTokens} · 未命中${uncachedInput(u)} · 命中率${cacheHitRate(u)}%`
}

/** 转友好时长：<60s → "12s"；<60m → "3m12s"；否则 "1h05m" */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

// ------------------------------------------------------------------------
// 复制辅助（模块 D1）：把文本写入系统剪贴板（macOS pbcopy，不依赖 OpenTUI 选区）
// ------------------------------------------------------------------------

/** 取最近的 assistant 块纯文本（用于 /copy 快捷键与 /copy 命令） */
export function latestAssistantText(blocks: readonly ChatBlock[]): string {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === 'assistant') return blocks[i].text
  }
  return ''
}

/** 复制到系统剪贴板（macOS pbcopy）。失败静默（不打断 TUI 交互） */
export function copyTextToClipboard(text: string): void {
  if (!text) return
  let child
  try {
    child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
  } catch { /* pbcopy 不可用（如非 macOS）静默忽略 */ return }
  // pbcopy 缺失时 ENOENT 以异步 error 事件抛出，必须挂处理，否则成为未捕获异常中断交互
  child.on('error', () => { /* 剪贴板命令失败静默忽略 */ })
  if (child.stdin) {
    child.stdin.write(text)
    child.stdin.end()
  }
}

/**
 * 读出当前活动选区文本（OpenTUI 鼠标拖拽选区）。无 renderer / 无选区 / 空选取
 * 均返回空串。结构性类型，仅依赖 getSelection().getSelectedText() 形状，便于单测。
 */
export function selectionTextFrom(
  renderer: { getSelection?: () => { getSelectedText?: () => string } | null } | null | undefined,
): string {
  return renderer?.getSelection?.()?.getSelectedText?.() ?? ''
}

/**
 * 字素簇计数（给「已选 N 字符」用）。
 *
 * 为什么不用 `String.length`：那是 UTF-16 码元数 —— 任何非 BMP 字符（emoji、部分罕见汉字）
 * 都算 **2**，选一个 🙂 会显示「已选 2 字符」（真机显示过）。
 * `Intl.Segmenter` 按用户感知的字素簇切分（ZWJ 序列如家庭 emoji 尽量算 1）；
 * 运行时不支持 / 构造抛错时降级为按码点（`Array.from`）—— 对代理对已经是正确值，
 * 仍比码元数准，且不会抛。
 */
export function countGraphemes(text: string): number {
  if (!text) return 0
  const Seg = (Intl as unknown as {
    Segmenter?: new (locale?: string, opts?: { granularity: string }) => {
      segment(s: string): Iterable<unknown>
    }
  }).Segmenter
  if (typeof Seg === 'function') {
    try {
      return [...new Seg('zh', { granularity: 'grapheme' }).segment(text)].length
    } catch {
      // 交给下面的码点计数
    }
  }
  return Array.from(text).length
}

// ------------------------------------------------------------------------
// 主题：markdown / 代码高亮配色（GitHub Dark 系）
// ------------------------------------------------------------------------

const markdownStyle = SyntaxStyle.fromStyles({
  'markup.heading': { fg: RGBA.fromHex('#58A6FF'), bold: true },
  'markup.bold': { fg: RGBA.fromHex('#FF7B72'), bold: true },
  'markup.italic': { fg: RGBA.fromHex('#79C0FF'), italic: true },
  'markup.raw': { fg: RGBA.fromHex('#A5D6FF') },
  'markup.list': { fg: RGBA.fromHex('#E6EDF3') },
  'markup.quote': { fg: RGBA.fromHex('#8B949E'), italic: true },
  'markup.link': { fg: RGBA.fromHex('#58A6FF'), underline: true },
  keyword: { fg: RGBA.fromHex('#FF7B72'), bold: true },
  string: { fg: RGBA.fromHex('#A5D6FF') },
  comment: { fg: RGBA.fromHex('#8B949E'), italic: true },
  number: { fg: RGBA.fromHex('#79C0FF') },
  boolean: { fg: RGBA.fromHex('#79C0FF') },
  function: { fg: RGBA.fromHex('#D2A8FF') },
  type: { fg: RGBA.fromHex('#FFA657') },
  operator: { fg: RGBA.fromHex('#FF7B72') },
  variable: { fg: RGBA.fromHex('#E6EDF3') },
  default: { fg: RGBA.fromHex('#E6EDF3') },
})

// ------------------------------------------------------------------------
// 欢迎页：ASCII 字标 + 启动信息 + 快捷键提示（会话开始前展示在主对话区）
// ------------------------------------------------------------------------

// 5×5 字模，"HARNESS" 逐字母横向拼接（字母间 2 空格），供欢迎页 Banner 展示。
const HARNESS_LETTERS: Record<string, string[]> = {
  H: ['H   H', 'H   H', 'HHHHH', 'H   H', 'H   H'],
  A: [' AAA ', 'A   A', 'AAAAA', 'A   A', 'A   A'],
  R: ['RRRR ', 'R   R', 'RRRR ', 'R R  ', 'R  RR'],
  N: ['N   N', 'NN  N', 'N N N', 'N  NN', 'N   N'],
  E: ['EEEEE', 'E    ', 'EEE  ', 'E    ', 'EEEEE'],
  S: [' SSS ', 'S    ', ' SSS ', '    S', ' SSS '],
}

/** 拼接 "HARNESS" 字标，返回若干行最大宽度 ≤60 的分串（行间用 2 空格分隔字母） */
export function buildWelcomeBanner(word = 'HARNESS'): string[] {
  const letters = [...word].map((c) => HARNESS_LETTERS[c] ?? HARNESS_LETTERS.H)
  const rows: string[] = []
  for (let r = 0; r < 5; r++) rows.push(letters.map((l) => l[r]).join('  '))
  return rows
}

/** 欢迎页 ASCII 字标（多行字符串，供整块渲染/测试） */
export const WELCOME_BANNER = buildWelcomeBanner().join('\n')

/**
 * 会话开始前的主对话区欢迎页组件（替换初始欢迎 system 块的可视化呈现）。
 *
 * `notice`：「本次启动如何决定当前会话」的一句话说明（自动恢复了哪个会话 /
 * 为什么没恢复）。有历史时不走欢迎页（历史直接铺进聊天区，提示随对话流给出），
 * 只有「无历史的空会话」才由这里补一句，否则这句提示会被欢迎页吞掉、用户看不到。
 */
export function WelcomePanel({ provider, model, notice }: { provider: string; model?: string; notice?: string }) {
  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <text attributes={createTextAttributes({ reverse: true, bold: true })}>
        welcome to agent-harness
      </text>
      {WELCOME_BANNER.split('\n').map((line, i) => (
        <text key={i} attributes={createTextAttributes({ bold: true })}>{line || '\u00A0'}</text>
      ))}
      <text attributes={createTextAttributes({ dim: true })}>{'\u00A0'}</text>
      <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
        交互式会话 · provider={provider} · model={model ?? '-'}
      </text>
      <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
        {HELP_LINES.map((l) => l.key).join(' · ')}
      </text>
      <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
        直接输入问题开始对话；输入 /help 查看特殊命令；Ctrl-C 或 /exit 退出。
      </text>
      {notice ? (
        <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
          {notice}
        </text>
      ) : null}
    </box>
  )
}

// ------------------------------------------------------------------------
// TuiApp：OpenTUI React 组件树（状态栏 + 主对话 + 侧栏面板 + 输入）
// ------------------------------------------------------------------------

/**
 * 从权限询问的原始文本中提炼一行展示文案（去掉行内选项后缀/首尾空白）。
 * 权限引擎 ask() 的问题形如：`⚠️ 权限请求 [bash] /etc/passwd\n  操作: allow / deny ...`。
 * 这里取含「权限请求」的主行，供审批模态简洁展示。
 */
export function approvalLine(q: string): string {
  const lines = String(q)
    .replace(/\n+$/, '')
    .split('\n')
    .map((s) => s.replace(/^\s+/, '').replace(/\s+$/, ''))
    .filter(Boolean)
  return lines.find((l) => l.includes('权限请求')) ?? lines[0] ?? q
}

export function TuiApp({ options, onExit }: { options: TuiReplOptions; onExit: (r: TuiReplExit) => void }) {
  // 工作目录取**启动时解析出的**（`-c/--cwd` 传入值，未传才是进程启动目录）。
  // TUI 里凡是「相对路径基准 / 文件树根」都必须用它，不能用 process.cwd() —— 后者
  // 是进程启动目录，`--cwd` 指定了别处时会把文件树/相对路径解析到错误的目录。
  const workdir = options.app.workspace.cwd
  // 「本次启动如何决定当前会话」的说明（与 REPL 同一套文案）：自动恢复了哪个会话、
  // 或为什么没恢复。只在挂载时算一次；会话被 /new、/resume 切换后即失效并清空。
  const [restoreNotice, setRestoreNotice] = useState(() => describeSessionRestore(options.app.sessionRestore))
  // boot 是否恢复了已有会话（auto 自动恢复 / explicit 显式 -s），且确实带着历史。
  // 有历史时聊天区直接铺历史（与 /resume 的表现一致）——「接着上次」的意义就在于看得见上次。
  const bootSession = options.session
  const restoredWithHistory = options.app.sessionRestore.source !== 'new' && bootSession.messages.length > 0
  // 初始状态直接在 useState 初始化：若用 mount effect 设置欢迎语，会覆盖
  // 已在 effect 之前开始处理的用户回复（processLine 于渲染期同步初始化，submit 可先于 effect）。
  const [state, setState] = useState<ChatState>(() => {
    // 有历史 → 还原对话块；无历史 → 回落欢迎页
    let s = restoredWithHistory
      ? messagesToBlocks(bootSession.messages, bootSession.blocks)
      : initialChatWithWelcome('输入问题开始对话；输入 /help 查看特殊命令；Ctrl-C 或 /exit 退出。')
    // 提示归属：有历史时随对话流追加在最末（scrollbox 粘底，用户一眼能看到）；
    // 无历史时欢迎页会整体替换块列表，改由 <WelcomePanel notice> 渲染，避免被吞掉。
    if (restoredWithHistory && restoreNotice) s = pushConsole(s, restoreNotice)
    return s
  })
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // 初始模型取「本会话实际会用的」：会话级覆盖 > Agent 定义 > 启动参数，避免 -s 恢复带旧模型时显示串台
  const [model, setModel] = useState<string | undefined>(() => options.app.resolveSessionModel(options.session) ?? options.model)
  const [showSidebar, setShowSidebar] = useState(true)
  // 后台任务实时面板（模块 A）：由 subagent 监控器回调驱动，直接渲染到侧栏
  const [bgTasks, setBgTasks] = useState<BackgroundTaskViewLike[]>([])
  // 侧栏文件引用导航：fileMode 时输入框让出焦点，↑/↓ 移动选中，Enter 打开
  const [fileMode, setFileMode] = useState(false)
  const [sel, setSel] = useState(0)
  // 模块 B：侧栏会话列表 —— sessionMode 时输入框让出焦点，↑/↓ 选中、Enter 恢复
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [sessionMode, setSessionMode] = useState(false)
  const [sessionSel, setSessionSel] = useState(0)
  // 会话分发互斥：任一列表模式激活时输入框让出焦点
  const listMode = fileMode || sessionMode
  // 模块 C：/命令菜单补全 + 输入历史
  const [allCommands, setAllCommands] = useState<Array<{ command: string; description: string }>>([])
  const [cmdSel, setCmdSel] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1) // -1 表示不在回看历史
  // history 的 ref 镜像：/history 命令需在 submit 回调（依赖 [] 闭包）里同步读取当前历史
  const historyRef = useRef<string[]>([])
  useEffect(() => { historyRef.current = history }, [history])
  // 历史导航索引的同步真源（ref 镜像）：React 状态是异步提交的，连按/自动重复 ↑ 时若读
  // state 会拿到上一次渲染的旧值（始终 -1），导致每次都跳到最近一条。ref 同步更新，
  // 保证连续按键逐级回看；state 仅用于渲染输入框 value。
  const histIdxRef = useRef(-1)
  const setHistIdxSync = useCallback((i: number) => {
    histIdxRef.current = i
    setHistIdx(i)
  }, [])
  // 模块 C：底部输入改为多行 <textarea>。react <textarea> 无受控 value / onInput，故用 ref
  // 直接读写底层 TextareaRenderable 的 plainText / setText（单实例，无 remount，避免 buffer 损坏）。
  const textareaRef = useRef<TextareaRenderable | null>(null)
  const readComposer = useCallback((): string => textareaRef.current?.plainText ?? '', [])
  // 注意：底层 setText 会「完全重置缓冲状态」，把插入点放回 (0,0)。若只 setText，Tab 补全 /
  // 历史回看后光标会滞留在文本开头，导致后续键入被「前置」到命令开头（多行缓冲时更明显）。
  // 故这里在写回后调用 gotoBufferEnd() 把光标重新定位到文本末尾，恢复「行尾继续键入」的直觉。
  const setComposer = useCallback((value: string) => {
    const t = textareaRef.current
    t?.setText(value ?? '')
    t?.gotoBufferEnd()
  }, [])
  // 模块 D：帮助面板 + 统计面板 —— helpOpen 时输入框让出焦点（modal）
  const [helpOpen, setHelpOpen] = useState(false)
  // 模块 E：命令审批模态 —— 权限引擎 ask() 触发时弹出，等待 allow/deny/always/never
  const [approvalQ, setApprovalQ] = useState<string | null>(null)
  const approvalResolveRef = useRef<((ans: string) => void) | null>(null)
  // 鼠标复制（模块 D3）：正在展示「✓ 已复制」提示的块 id（临时高亮，配合 onMouseUp 复制）
  const [copiedId, setCopiedId] = useState<number | null>(null)
  /**
   * 工具块渲染窗口（见 `windowToolText`）的缓存：窗口化是 O(文本长度) 的，而流式期间每次
   * text_delta 都会重渲染所有块 —— 大结果块逐帧重算是真开销。按块 id 存，用**字符串同一性**
   * 判失效：React 对未变的块复用同一个字符串引用，所以命中的比较是 O(1)（先比引用）。
   */
  const toolViewCacheRef = useRef(new Map<number, { text: string; view: ToolView }>())
  // 鼠标选块：点击消息块整体高亮选中（再点取消）—— 复制/折叠等内部按钮的点击也会连带选中该块
  const [selectedBlockId, setSelectedBlockId] = useState<number | null>(null)
  // thinking 折叠：用户显式展开过的 thinking 块 id（default 长推理折叠成一行标题，点击开关）
  const [collapsedThinking, setCollapsedThinking] = useState<Set<number>>(new Set())
  const toggleThinking = useCallback((id: number) => {
    setCollapsedThinking((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])
  // 统计面板计时起点：组件挂载时刻
  const startTimeRef = useRef(Date.now())
  // 阶段四·按需渲染：会话全量消息引用 + 当前可见最旧消息下标（loadmore 分页用）。
  // setSession 时快照；会话继续增长时下标略有偏差（顶部旧段边缘可接受）。
  const allMessagesRef = useRef<Message[]>(options.session.messages)
  const earliestVisibleIdxRef = useRef(Math.max(0, options.session.messages.length - HISTORY_PAGE))
  // 实际用量累积器（onEvent 驱动）：LLM 调用 token / 模型 / 工具粒度。
  // 初值从会话水合（meta 持久化的累积器优先，否则由消息历史重建），
  // 保证重连 / resume 后立刻看到重连前累计的用量，而不是从 0 开始。
  const [usage, setUsage] = useState<UsageStats>(() => hydrateUsage(options.session))
  // 当日（跨会话）用量：从持久化的会话文件归集当天小时桶，重连后仍能看到当天累计
  const [todayTotals, setTodayTotals] = useState<UsageStats | null>(null)
  // 模块 4：侧栏各模块改为顶部图标 tab + 左右切换（每次仅展示一个面板）
  const [sidebarTab, setSidebarTab] = useState<SidebarTabId>('context')
  // 统计面板「上下文占用」：窗口/阈值取与 /compact、/stats 同一套推导（config 加载一次即可）
  const [ctxOccOpts, setCtxOccOpts] = useState<CompactOptions | undefined>(undefined)
  // 分母**按会话端点解析**（本会话 + 各子会话各自一份）。闭包只捕获 config，会话对象在渲染时
  // 由 renderContextOccupancy 回源取最新一份 —— 因此会话内 /model 切模型不必重建这个闭包。
  const [ctxWindowFor, setCtxWindowFor] = useState<((s: Session | undefined) => number) | undefined>(undefined)
  useEffect(() => {
    options.app.configStore
      .load()
      .then((cfg) => {
        const def = cfg.provider ?? 'anthropic'
        setCtxOccOpts(buildCompactionOptions(cfg, def))
        setCtxWindowFor(() => (s: Session | undefined) =>
          resolveCompactionWindow(cfg, def, options.app.resolveSessionEndpoint(s)))
      })
      .catch(() => {})
  }, [options.app])
  // 运行中强制终止（点击「■ 终止」按钮 / Ctrl-C 共用）：abort 当前查询，已完成的步骤保留
  const abortCurrent = useCallback(() => {
    const ctl = abortCtlRef.current.current
    if (ctl) {
      ctl.abort()
      setState((prev) => pushConsole(prev, '\n⏹️  已请求中断，正在停止…（已完成的步骤会保留）\n'))
    }
  }, [])
  // 工具token归并状态：暂存本轮 LLM 用量，仅归并到紧随的第一个工具
  const pendingToolAttrRef = useRef<{ input: number; output: number } | null>(null)
  const toolAttributedRef = useRef(false)

  /**
   * 用量对账（轮末）：把显示值换成**引擎层**的权威值。
   *
   * 轮内仍由流事件增量累加（保证 token 数字实时跳动），轮末以引擎为准 ——
   * 引擎是唯一写入方（core 每步折叠一次并写 meta），显示值与落盘值因此不会各说各话。
   * 历史上"重连后用量数字变了"正是两者分叉的症状。
   */
  const syncUsageFromEngine = useCallback(() => {
    const sid = options.session?.id
    const usageApi = options.harness?.usage
    if (!sid || !usageApi) return
    void usageApi
      .get(sid)
      .then((u) => {
        // 期间可能已切会话：只在对账目标仍是当前会话时提交
        if (options.session?.id === sid) setUsage(u)
      })
      .catch(() => { /* 读数失败保持轮内增量值（不影响对话） */ })
  }, [options.session, options.harness])
  // 选区复制（模块 D4）：读全局 renderer，Ctrl-Y 优先复制鼠标选中的文字
  const { renderer } = useAppContext()
  // 鼠标拖选（选区）高亮：订阅渲染器 selection 事件，有选区时在输入行显示「已选 N 字符 · ✕」。
  // 选区本身的着色由 Zig 内核负责（默认反转），这里给一个明确的"选没选中"文字指示 + 一键清除。
  // 必须放在 useAppContext 之后（renderer 声明在前一行）。
  const [selChars, setSelChars] = useState(0)
  useEffect(() => {
    const onSel = () => {
      const sel = renderer?.getSelection?.()
      // isActive 过滤：clearSelection() 后 Zig 可能仍把旧 Selection 留在缓存里并发一次事件，
      // 若只看 getSelectedText 会把「已清除」回弹成「已选 N 字符」（实测踩坑）。
      // 计数用字素簇而非 UTF-16 码元：`.length` 会把一个 emoji 算成 2。
      const text = sel?.isActive ? sel.getSelectedText() : ''
      const n = countGraphemes(text)
      setSelChars(n)
      // 只在**出现新选区**时复位复制反馈。
      // 不能在 n===0 时也复位：点 chip 的 mousedown 会先清掉选区并触发一次 n=0 的事件，
      // 那会把刚设好的「✓ 已复制」立刻抹掉（chip 随即消失，用户看着像"点了没反应"）。
      if (n > 0) {
        selSnapshotRef.current = { text, chars: n }
        setSelCopied(false)
      }
      // 选区覆盖块定位（整块响应式高亮）：沿被选中 renderable 的父链找 `blk_<id>` 容器。
      if (!sel?.isActive) { setSelBlockIds(new Set()); selRenderablesRef.current = []; return }
      const ids = new Set<number>()
      for (const rb of sel.selectedRenderables) {
        let node: { id: string; parent: unknown } | null = rb
        while (node) {
          if (node.id.startsWith('blk_')) {
            const blockNum = Number(node.id.slice(4))
            if (Number.isInteger(blockNum)) ids.add(blockNum)
            break
          }
          node = node.parent as { id: string; parent: unknown } | null
        }
      }
      setSelBlockIds(ids)
      // 存下**被选中的 renderable 本体**（含 markdown 内部的 CodeRenderable），供闪烁时直接上色。
      selRenderablesRef.current = sel.selectedRenderables.slice() as unknown as Array<Record<string, unknown>>
    }
    renderer?.on?.('selection', onSel)
    return () => { renderer?.off?.('selection', onSel) }
  }, [renderer])
  /**
   * 选区**闪烁**（模块 D5）：有选区时，选中文字的高亮每 `SELECTION_BLINK_MS` 在两套配色间切换。
   *
   * 为什么需要：拖选后的高亮由渲染内核负责、默认只是"反显"，在一屏彩色 markdown 里很容易和
   * 语法高亮混淆 —— 选完不知道到底选上没有（用户反馈）。
   *
   * 实现抓手是 `selectionBg` / `selectionFg`：OpenTUI 没有暴露"选区样式"API，但
   * `TextBufferRenderable` 的这两个属性就是内核读选区配色的入口（见该类型定义）。
   * 属性只定义**调色板**，具体哪几个字被染色仍由内核按选区范围决定 —— 所以这里把 props
   * 挂在所有可选中的正文元素上，未选中的文字不受影响。
   * 只在有选区时开定时器，清掉选区即停（不留后台定时器）。
   */
  const [selBlink, setSelBlink] = useState(false)
  useEffect(() => {
    if (selChars <= 0) {
      setSelBlink(false)
      return
    }
    const t = setInterval(() => setSelBlink((v) => !v), SELECTION_BLINK_MS)
    return () => clearInterval(t)
  }, [selChars])
  /** 选区配色（无选区时给空对象：不覆盖内核默认，避免影响非选区渲染） */
  const selStyleProps =
    selChars > 0
      ? {
          selectionBg: selBlink ? SELECTION_BLINK_A.bg : SELECTION_BLINK_B.bg,
          selectionFg: selBlink ? SELECTION_BLINK_A.fg : SELECTION_BLINK_B.fg,
        }
      : {}
  /** 点过「⧉ 复制」后的即时反馈（下一个选区/清除时复位） */
  const [selCopied, setSelCopied] = useState(false)
  /**
   * 被选中的 renderable 本体（selection 事件的 `selectedRenderables` 快照）。
   *
   * 为什么还要命令式上色：`<markdown>` 的 `MarkdownOptions`（@opentui/core 0.5.8）没有
   * `selectionBg/selectionFg` 字段，声明式 props 挂不上去。但实测 markdown 内部承载正文的
   * `CodeRenderable`（id 形如 `markdown-1-block-0`）就是 `TextBufferRenderable` 的子类，
   * **直接给它的 `selectionBg` 赋值立刻生效**（真机探针：强制 A/B/A，屏上底色随之切换）。
   * 而这些 renderable 本来就在 `selectedRenderables` 里，无需遍历渲染树。
   * 清掉选区时随 `selBlockIds` 一起清空（避免持有已卸载节点）。
   */
  const selRenderablesRef = useRef<Array<Record<string, unknown>>>([])
  /** 有选区时，把当前闪烁配色**直接写进**被选中的 renderable（覆盖 markdown 那部分） */
  useEffect(() => {
    if (selChars <= 0) return
    const bg = selBlink ? SELECTION_BLINK_A.bg : SELECTION_BLINK_B.bg
    const fg = selBlink ? SELECTION_BLINK_A.fg : SELECTION_BLINK_B.fg
    for (const rb of selRenderablesRef.current) {
      if (!rb || !('selectionBg' in rb)) continue
      try {
        rb.selectionBg = bg
        rb.selectionFg = fg
      } catch { /* 选区已随块卸载：忽略 */ }
    }
  }, [selChars, selBlink])
  /**
   * 选区覆盖到的消息块 id 集合（整块响应式高亮）。
   * 由 selection 事件的 `selectedRenderables` 沿 parent 向上定位到 `blk_<id>` 容器。
   * 选区覆盖某块 ⇒ 该块整体闪烁高亮 —— 对 markdown 块也生效（markdown 内部被选中的
   * buffer 的父链可上溯到我们的块容器，续 192 的"markdown 无法改选区配色"由此绕过）。
   */
  const [selBlockIds, setSelBlockIds] = useState<ReadonlySet<number>>(new Set())
  /**
   * 选区**快照**（文本 + 字素数）。
   *
   * 为什么必须存快照而不能点击时现取：点 chip 的 mousedown 会让渲染内核**先清掉选区**
   * （mouse down 即开始一次新选区），`onMouseUp` 随后很可能落在已经卸载的节点上 —— 表现就是
   * "点了复制没反应"。快照在 selection 事件里更新，与点击时序无关。
   */
  const selSnapshotRef = useRef<{ text: string; chars: number }>({ text: '', chars: 0 })
  /** mousedown + mouseup 双触发的去重时间戳（同一指示器派发顺序随实现而变，不能只挂一个） */
  const lastSelCopyAtRef = useRef(0)
  /** 「✓ 已复制」的自动收起时长：复制后若选区已被清掉，chip 自行消失（无需 ✕ 按钮） */
  const COPIED_NOTICE_MS = 2500
  useEffect(() => {
    if (!selCopied || selChars > 0) return
    const t = setTimeout(() => setSelCopied(false), COPIED_NOTICE_MS)
    return () => clearTimeout(t)
  }, [selCopied, selChars])

  /**
   * 选区 chip 的文案。
   *
   * 刻意做成**单个 `<text>`**（而不是"复制按钮 + ✕ 按钮"两个相邻元素）：实测同一行里两个相邻
   * `<text>` 的命中测试不可靠 —— 点 ✕ 会被判到复制按钮上（copy 连触发 4 次、✕ 处理器一次没进），
   * 于是"想清除选区的点击"变成了"又复制一次"。单个元素内按点击 **x** 分派就没有这个问题，
   * 同时保住了原有契约（点末尾 ✕ = 清除选区）。
   */
  const selectionChipLabel = selCopied
    ? `✓ 已复制 ${selSnapshotRef.current.chars || selChars} 字符`
    : `⧉ 复制 ${selChars} 字符 ✕`

  /** chip 点击分派：落在末尾 ✕ 上 ⇒ 清除选区；其余位置 ⇒ 复制 */
  const onSelectionChipMouse = (e: {
    x?: number
    currentTarget?: { screenX?: number } | null
    preventDefault: () => void
  }) => {
    e.preventDefault()
    const xAt = selectionChipLabel.indexOf('✕')
    const localX =
      typeof e.x === 'number' && typeof e.currentTarget?.screenX === 'number'
        ? e.x - e.currentTarget.screenX
        : -1
    if (xAt >= 0 && localX >= xAt) {
      clearSelectionState()
      return
    }
    copyCurrentSelection(e)
  }

  /** 点 chip 的复制：内容取自快照（点击时选区可能已被 mousedown 清掉） */
  const copyCurrentSelection = (e: { preventDefault(): void }) => {
    e.preventDefault()
    const now = Date.now()
    if (now - lastSelCopyAtRef.current < 300) return // mousedown/mouseup 双触发去重
    const snap = selSnapshotRef.current
    const text = snap.text || selectionTextFrom(renderer)
    if (!text) return
    lastSelCopyAtRef.current = now
    copyTextToClipboard(text)
    setSelCopied(true)
  }
  /** 清掉选区就复位快照，避免"再点一次复制"复制到上一次的旧文本 */
  const clearSelectionState = () => {
    renderer?.clearSelection?.()
    setSelChars(0)
    setSelCopied(false)
    selSnapshotRef.current = { text: '', chars: 0 }
  }

  // 会话开始前（仅剩 system 块）展示欢迎页；发起首条消息后切换为对话块列表
  const hasChat = state.blocks.some((b) => b.kind !== 'system')

  // 会话处理内核（与 REPL 共用）：结构化 onEvent 驱动 markdown 流，out 归类控制台文本。
  // onEvent 增量被缓冲并按宏任务批合并提交，避免高频 chunk 逐次全量重解析 markdown。
  const processLineRef = useRef<((raw: string) => Promise<'continue' | 'exit'>) | null>(null)
  /**
   * 中断句柄：`createProcessLine` 在执行查询期间写入当前 `AbortController`，结束后清空。
   * Ctrl-C 据此区分「执行中 ⇒ 中断本次查询」与「空闲 ⇒ 退出」。
   */
  // ---- Agent 状态显示 ----
  // 静态身份（id/name/mode）来自 AgentDefinition；运行态（phase/step/tool）由事件流归约。
  const agentIdentity = useMemo<AgentIdentity>(() => {
    const id = options.session.agentId ?? 'default'
    const def = options.harness.agent?.get?.(id)
    return {
      agentId: id,
      ...(def?.name ? { agentName: def.name } : {}),
      ...(def?.mode ? { mode: def.mode } : {}),
    }
  }, [options.session.agentId, options.harness])
  const [agentStatus, setAgentStatus] = useState<AgentStatus>(() => initialAgentStatus(agentIdentity))

  const abortCtlRef = useRef<{ current: AbortController | null }>({ current: null })
  const exitRef = useRef(false)
  const pendingEvsRef = useRef<AgentStreamEvent[]>([])
  const flushScheduledRef = useRef(false)
  if (processLineRef.current === null) {
    // 模块 E：注入 TUI 命令审批模态 —— 替换默认 readline 行内提问。
    // 询问由权限引擎 ask() 触发（含工具键与路径），此处把问题投递到 React 模态并挂起，
    // 由全局按键（Y/N/Shift-Y/Shift-N）回填答案；每次仅一个待决审批。
    options.app.permission.setAskPrompt((q) => {
      return new Promise<string>((resolve) => {
        approvalResolveRef.current = resolve
        setApprovalQ(typeof q === 'string' && q.length ? q : '权限请求')
      })
    })
    processLineRef.current = createProcessLine({
      app: options.app,
      harness: options.harness,
      session: options.session,
      out: (s) => setState((prev) => pushConsole(prev, s)),
      activeAbort: abortCtlRef.current,
      onEvent: (ev) => {
        // 轻量副作用立即处理（不触渲染重解析）
        if (ev.type === 'done') {
          // 注意：A 方案下 done 是「一步结束」，引擎可能还在跑下一步 ⇒ 这里**不**置 busy=false
          // （否则多步时 UI 会在仍在推理时显示空闲）。改由 turn_end 统一收尾。
          const msg = ev.message
          setModel(msg?.meta?.model)
          // 记录一次 LLM 调用与 API 实际返回的 token 用量（含缓存命中/写入），
          // 按模型 / agent / 小时归并；本轮 LLM 用量暂存，归并到紧随的下一个工具。
          const m = msg?.meta
          pendingToolAttrRef.current = {
            input: m?.tokenUsage?.input ?? 0,
            output: m?.tokenUsage?.output ?? 0,
          }
          toolAttributedRef.current = false
          setUsage((prev) => recordCall(prev, {
            model: m?.model,
            agentId: msg?.agentId,
            input: m?.tokenUsage?.input,
            output: m?.tokenUsage?.output,
            cacheRead: m?.tokenUsage?.cacheRead,
            cacheWrite: m?.tokenUsage?.cacheWrite,
          }))
        } else if (ev.type === 'tool_call_result') {
          // 每次工具/技能完成累计一次调用（含失败标记 + 本轮紧随 LLM 用量的归并，仅首次）
          const tool = ev.toolId ?? ev.toolUseId ?? 'tool'
          const attr = pendingToolAttrRef.current
          if (!toolAttributedRef.current && attr) {
            toolAttributedRef.current = true
            setUsage((prev) => recordTool(prev, tool, { isError: ev.isError, input: attr.input, output: attr.output }))
          } else {
            setUsage((prev) => recordTool(prev, tool, { isError: ev.isError }))
          }
          // 一次 agent 任务：subagent 派生工具成功完成 = 一个子任务结束（agent 维度 tasksDone）
          if (tool === 'subagent' && !ev.isError) {
            setUsage((prev) => recordTaskDone(prev, (ev as { agentId?: string }).agentId))
          }
        } else if (ev.type === 'text_delta' || ev.type === 'reasoning_delta' || ev.type === 'tool_call_start') {
          setBusy(true)
        } else if (ev.type === 'turn_end') {
          // 整轮结束（所有 step 跑完）—— 这里才是真正该收 busy 的时机
          setBusy(false)
          // 用量对账：轮内由流事件增量显示（响应快），轮末以**引擎层**的值为准
          // （引擎每步折叠一次并写 meta，子 agent / headless 走同一条路）。
          syncUsageFromEngine()
        }
        // 状态归约（纯函数）：供状态栏显示「第几步 / 在跑哪个工具 / 是否被中断」
        setAgentStatus((prev) => reduceAgentStatus(prev, ev))
        // 渲染状态：缓冲批量提交
        pendingEvsRef.current.push(ev)
        if (flushScheduledRef.current) return
        flushScheduledRef.current = true
        setTimeout(() => {
          flushScheduledRef.current = false
          const batch = pendingEvsRef.current
          pendingEvsRef.current = []
          if (batch.length > 0) setState((prev) => batchReduceStream(prev, batch))
        }, 0)
      },
      onLine: options.onLine,
      // 模块 B：会话切换（/resume /new 等）后换绑外层会话指针，并用 messagesToBlocks
      // 把新会话历史还原为对话块刷新聊天区（阶段四：压缩块 → 提示行 + 超长分页）；
      // 空会话则回落初始欢迎态。
      setSession: (s) => {
        options.session = s
        allMessagesRef.current = s.messages
        earliestVisibleIdxRef.current = Math.max(0, s.messages.length - HISTORY_PAGE)
        // 启动提示只描述「本次启动」的会话决策；用户主动切了会话就不再适用
        setRestoreNotice('')
        setState(messagesToBlocks(s.messages, s.blocks))
      },
    })
  }

  // 阶段四·按需渲染：压缩块展开中置 loading 态（提示行显示 ⏳）
  const markCompactLoading = useCallback((blockId: number, loading: boolean) => {
    setState((prev) => {
      const idx = prev.blocks.findIndex((b) => b.id === blockId)
      if (idx < 0) return prev
      const blocks = prev.blocks.slice()
      blocks[idx] = { ...blocks[idx], loading }
      return { ...prev, blocks }
    })
  }, [])

  // 引擎运行时告警（缓存失效 / 用量折叠失败等）改道 console 块，而非直写 stdout：
  // OpenTUI 接管 stdout 做布局，直写会混进渲染字符流把 UI 排错位（用户反馈）。
  // 挂 sink 后 warn/error 走应用层渲染；headless/REPL 不挂 sink，行为不变。
  useEffect(() => {
    const sink = (level: 'warn' | 'error', msg: string, meta?: unknown) => {
      const metaPart = meta !== undefined ? ` ${JSON.stringify(meta)}` : ''
      setState((prev) => pushConsole(prev, `[${level.toUpperCase()}] ${msg}${metaPart}`))
    }
    options.app.setLogSink(sink)
    return () => options.app.setLogSink(undefined)
  }, [options.app])

  // 阶段四·按需渲染：点击压缩提示行 → 经 loader 取回该块原文，替换提示块
  const handleExpandCompact = async (chatBlockId: number, compactBlockId: string): Promise<void> => {
    const load = options.loadHistory
    if (!load) return
    markCompactLoading(chatBlockId, true)
    try {
      const originals = await load(options.session.id, { blockIds: [compactBlockId] })
      setState((prev) => expandCompactBlocks(prev, compactBlockId, originals))
    } catch {
      // 加载失败：提示块保持，复位 loading（/history 兜底全量）
      markCompactLoading(chatBlockId, false)
    }
  }

  // 阶段四·按需渲染：点击"更早省略"提示 → 从内存向前取一页插入
  const handleLoadMore = useCallback((): void => {
    const all = allMessagesRef.current
    if (!all.length) return
    const start = Math.max(0, earliestVisibleIdxRef.current - HISTORY_PAGE)
    const older = all.slice(start, earliestVisibleIdxRef.current)
    earliestVisibleIdxRef.current = start
    setState((prev) => loadOlderBlocks(prev, older))
  }, [])

  // 模块 A：后台任务实时面板 —— 订阅 subagent 监控器，状态并入侧栏
  useEffect(() => {
    const monitor = subagentCapability.createMonitor({ bus: options.harness.bus })
    const off = monitor.subscribe((tasks) => setBgTasks((prev) => applyBackgroundTaskSnapshot(prev, tasks)))
    return () => { off(); monitor.dispose() }
  }, [options.harness])

  // 模块 B：加载持久化会话列表（进入 session 模式与启动时各取一次）
  const refreshSessions = useCallback(async () => {
    try {
      const list = await options.app.sessionStore.list()
      setSessions(toSessionRows(list))
    } catch { /* 读取失败保持空列表 */ }
  }, [options.app])
  useEffect(() => { void refreshSessions() }, [refreshSessions])

  // 模块 4：会话级用量展示 —— **只读**，不再写 `session.meta[usageStats]`。
  //
  // 写入权已交给引擎（core 每步折叠一次，见 `UsageAccessor`）：只有引擎写，才能覆盖
  // headless / REPL 宿主与**子 agent 会话**（真机：6 个子会话约 1.5M 输入 token 此前完全不入账，
  // 会话面板只看到总额的 42%）。宿主自己也写会与引擎分叉，而分叉的症状正是历史上那条
  // 「重连后历史用量被清零」—— 当时靠 `shouldPersistUsage` 打补丁挡住；现在没有第二个写入方，
  // 这个补丁连同它的防抖落盘一起退场。
  const hydratedSessionRef = useRef<string | undefined>(options.session?.id)
  useEffect(() => {
    const sess = options.session
    if (!sess) return
    // 切换 / 恢复会话时重新水合：新会话的用量不应沿用上一个会话。
    // 优先读 meta（引擎写的），meta 为空时由 hydrateUsage 从消息重建。
    if (hydratedSessionRef.current !== sess.id) {
      hydratedSessionRef.current = sess.id
      setUsage(hydrateUsage(sess))
    }
  }, [options.session])

  // 当日用量归集（跨会话）：每次 LLM 调用后重算。只读持久化文件、不写回，
  // 因此重连后当天此前产生的用量依然可见（不依赖内存态）。
  // 防抖 800ms：LLM 调用与会话更新都很频繁，避免每次都全量扫描会话文件
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void collectTodayUsage(options.app.sessionStore, options.session)
        .then((t) => { if (!cancelled) setTodayTotals(t) })
        .catch(() => { /* 归集失败不影响主流程 */ })
    }, 800)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [usage.llmCalls, options.session, options.app])

  // 模块 C：加载 / 命令补全候选（内置 REPL 命令 + 插件注册命令 + TUI 专属 /edit）
  useEffect(() => {
    void listReplCommands(options.harness)
      .then((cmds) => setAllCommands([
        ...cmds,
        { command: '/edit', description: '挂起 TUI 用外部编辑器打开文件（/edit <file[:line]>）' },
        { command: '/tree', description: '打印磁盘目录树，* 标记对话引用过的文件（/tree [path]）' },
      ]))
      .catch(() => { /* 忽略加载失败 */ })
  }, [options.harness])

  const finish = useCallback((reason: TuiReplExit) => {
    if (exitRef.current) return
    exitRef.current = true
    onExit(reason)
  }, [onExit])

  // 输入队列：Enter 提交 + 自动续轮注入，promise 链串行处理（不丢行）
  const pendingLines = useRef<string[]>([])
  const queueTail = useRef<Promise<void>>(Promise.resolve())
  const drain = useCallback(() => {
    queueTail.current = queueTail.current.then(async () => {
      while (pendingLines.current.length > 0 && !exitRef.current) {
        const line = pendingLines.current.shift()!
        const r = await processLineRef.current!(line)
        // 兜底收 busy：正常路径由 turn_end 事件收尾，这里防止事件流异常（如抛错）时
        // spinner 永久转下去。
        setBusy(false)
        // /agent、/model、/resume、/new 会改变本会话的 agent / 模型，但它们不产生 done 事件，
        // 状态栏不会自动刷新 —— 这里按命令名主动对齐。普通提问仍由 done 事件用「实际返回的模型」刷新（更真实）。
        if (/^\/(agent|switch|model|resume|new)\b/.test(line.trim())) {
          setModel(options.app.resolveSessionModel(options.session))
        }
        if (r === 'exit') { finish('exit'); return }
      }
    })
  }, [finish])

  const submit = useCallback((value: string) => {
    if (exitRef.current) return
    const v = value.trim()
    setComposer('') // 清空多行 textarea buffer（替代原先依赖 value prop / onInput 的置空）
    setInput('')
    setHistIdxSync(-1)
    if (v) {
      // /history：在聊天区展示输入历史（不入历史栈、不进会话内核）
      if (v === '/history') {
        const h = historyRef.current
        const body = h.length
          ? `输入历史（${h.length}）：\n${h.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}`
          : '（暂无输入历史）'
        setState((prev) => ({
          ...prev,
          blocks: [...prev.blocks, { id: prev.nextId, kind: 'assistant', text: body }],
          nextId: prev.nextId + 1,
        }))
        return
      }
      // /tree [path]：扫描磁盘打印目录树，对话引用过的文件带 * 标记（不入历史栈、不进会话内核）
      if (v.startsWith('/tree')) {
        const arg = v.replace(/^\/tree\s*/, '').trim()
        // 无参数时以工作目录为根（`--cwd` 指定别处时不能退化成进程启动目录）
        const root = arg ? resolveEditPath(arg, workdir) : workdir
        setState((prev) => {
          let isDir = false
          try { isDir = statSync(root).isDirectory() } catch { isDir = false }
          if (!isDir) {
            return { ...prev, blocks: [...prev.blocks, { id: prev.nextId, kind: 'system', text: `目录不存在：${root}` }], nextId: prev.nextId + 1 }
          }
          const refs = collectFileReferences(prev, Number.MAX_SAFE_INTEGER)
          const { nodes, truncated } = buildDiskFileTree(root, refs, { cwd: workdir })
          const lines = [`文件树（${nodes[0].name}）${truncated ? '（截断）' : ''}：`, renderFileRefTree(nodes)]
          if (anyMarked(nodes)) lines.push('', '* = 对话中引用过的文件')
          return { ...prev, blocks: [...prev.blocks, { id: prev.nextId, kind: 'system', text: lines.join('\n') }], nextId: prev.nextId + 1 }
        })
        return
      }
      // /edit [file[:line]]：挂起 TUI 前台打开外部编辑器，退出后回读文件内容注入会话
      if (v.startsWith('/edit')) {
        const arg = v.replace(/^\/edit\s*/, '').trim()
        const open = openFileRef.current
        if (!arg || !open) {
          setState((prev) => ({
            ...prev,
            blocks: [...prev.blocks, {
              id: prev.nextId, kind: 'system',
              text: arg ? '/edit 不可用：当前未启用文件打开' : '用法：/edit <file[:line]>',
            }],
            nextId: prev.nextId + 1,
          }))
          return
        }
        const parsed = parseFileRef(arg)
        setState((prev) => ({
          ...prev,
          blocks: [...prev.blocks, { id: prev.nextId, kind: 'system', text: `打开 ${parsed.path}${parsed.line ? `:${parsed.line}` : ''}（退出编辑器后回读）` }],
          nextId: prev.nextId + 1,
        }))
        const openPromise = open(parsed.path, parsed.line)
        void (openPromise ? Promise.resolve(openPromise) : Promise.resolve()).then(async () => {
          // 编辑结束回读磁盘（与编辑器打开用同一绝对路径基准解析），仅当文件可读时注入摘要
          const abs = resolveEditPath(parsed.path, workdir)
          let content = ''
          try { content = await readFile(abs, 'utf8') } catch { /* 文件不可读则不回读 */ }
          if (!content) return
          const tail = content.trimEnd().split('\n').slice(-8)
          setState((prev) => ({
            ...prev,
            blocks: [...prev.blocks, {
              id: prev.nextId, kind: 'assistant',
              text: `已编辑 ${abs}，最新尾部：\n${tail.map((l) => `  ${l}`).join('\n')}`,
            }],
            nextId: prev.nextId + 1,
          }))
        })
        return
      }
      // 模块 C：提交成功后入栈输入历史（去重相邻、限长，最新的在后）
      setHistory((prev) => {
        const trimmed = prev.filter((h) => h !== v).slice(-99)
        return [...trimmed, v]
      })
      pendingLines.current.push(v)
      void drain()
    }
  }, [drain, setHistIdxSync, setComposer])

  // 模块 C：/ 命令补全候选 —— 输入以 / 开头时，按前缀过滤命令菜单
  const cmdCandidates = useMemo(() => {
    if (!input.startsWith('/')) return []
    return allCommands.filter((c) => c.command.startsWith(input))
  }, [input, allCommands])
  const cmdMenuOpen = cmdCandidates.length > 0

  // 全局快捷键：Ctrl-C 退出、Ctrl-B 切换侧栏；列表模式 Tab 进入、↑/↓ 选中、Enter 触发、Esc 返回。
  // 两个列表互斥：优先会话模式；退出文件引用 Tab。useKeyboard 底层用 useEffectEvent 包裹，回调闭包每次渲染刷新。
  const openFileRef = useRef(options.openFile)
  openFileRef.current = options.openFile
  const submitRef = useRef(submit)
  submitRef.current = submit

  /**
   * Coordinator 自动续轮：后台子 Agent 完成（全部完成 = barrier / 还剩其它 = worker）时，
   * 注入一行 `<continue/>` 走 TUI 自己的 pendingLines → drain → createProcessLine，
   * 让 drainNotifications 把结果送进对话（用户零操作）。
   *
   * ⚠️ 这条此前**只在 REPL（readline）分支挂过**，TUI 完全没有订阅 ⇒ 后台结果就绪后
   * **无人取用**，一直滞留到用户自己敲下一句话才送达。真机 s_1790592617954_axqkk：
   * barrier 在 +527s 完成，通知到 +2816s 才随用户敲「结果有了吗」进入对话 ——
   * 中间 38 分钟界面停在等待中、毫无动静。
   *
   * TUI 与 REPL 共用同一个 `createProcessLine`（内含 `<continue/>` 的空转判定与退避 peek），
   * 所以这里只需补上**事件源**，内核一行都不用改。
   * 重复注入无害：processLine 对 `<continue/>` 会先 peek 待处理通知，读到空就跳过该轮。
   */
  useEffect(() => {
    return attachAutoContinue(options.harness, (line) => {
      pendingLines.current.push(line)
      void drain()
    })
  }, [options.harness, drain])

  useKeyboard((key) => {
    // 模块 D：帮助面板 modal —— 任意键关闭（Esc/Ctrl-/ 均可，回车等同）
    if (helpOpen) {
      setHelpOpen(false)
      return true
    }
    // 模块 E：命令审批模态 —— 审批期间吞掉所有按键，仅响应审批选项
    if (approvalQ !== null) {
      const submitApproval = (ans: string) => {
        approvalResolveRef.current?.(ans)
        approvalResolveRef.current = null
        setApprovalQ(null)
      }
      if (key.name === 'y') submitApproval('allow')             // 本次允许
      else if (key.name === 'n' || key.name === 'escape') submitApproval('deny') // 本次拒绝 / Esc=拒绝
      else if (key.shift && key.name === 'y') submitApproval('always')           // 始终允许
      else if (key.shift && key.name === 'n') submitApproval('never')            // 始终拒绝
      return true // 其余按键在审批中一律吞掉
    }
    if (key.ctrl && key.name === 'c') {
      // 执行中 ⇒ 中断本次查询（引擎在步边界与每个工具执行前响应，已完成的部分保留）；
      // 空闲 ⇒ 退出。与 REPL 的 SIGINT 语义一致。
      const ctl = abortCtlRef.current.current
      if (ctl) {
        ctl.abort()
        setState((prev) => pushConsole(prev, '\n⏹️  已请求中断，正在停止…（已完成的步骤会保留）\n'))
        return true
      }
      return finish('exit')
    }
    // 诊断：连修饰键一起记录。此前只记 name/ctrl，导致「Shift+Enter 的修饰信息到底有没有
    // 送达应用」在日志里无从判断（实测结论见开发日志续 125）。
    __KEYLOG.push(`${key.name}${key.ctrl ? ':C' : ''}${key.shift ? ':S' : ''}${key.meta ? ':M' : ''}`)
    if (key.ctrl && key.name === 'b') return setShowSidebar((v) => !v)
    // 模块 D：帮助面板开关。Ctrl+/ 与 Ctrl+_ 均发 0x1F（OpenTUI 解码为 name '_'）;
    // 部分终端将 Ctrl+/ 上报为 '?'。三者等效触发。
    if (key.ctrl && (key.name === '/' || key.name === '_' || key.name === '?')) { setHelpOpen(true); return true }
    // 模块 D：复制 —— 有选区先复制选区，否则复制最近 assistant 块（Ctrl-y）
    if (key.ctrl && key.name === 'y') {
      const sel = selectionTextFrom(renderer)
      const t = sel.trim() ? sel : latestAssistantText(state.blocks)
      if (t) {
        copyTextToClipboard(t)
        if (sel.trim()) renderer?.clearSelection?.()
      }
      return true
    }
    const refs = fileRefs
    const openFile = options.openFile
    // 模块 C：/ 命令菜单（Tab 补全、Enter 提交、Esc 关闭）+ 输入历史（↑/↓ 回看）。
    // ↑/↓ 存在同键冲突：回看出的历史若以 / 开头会同时命中命令菜单。优先级规则：
    //   - 正在回看（histIdx >= 0）：↑/↓ 继续回看，不被命令菜单劫持；
    //   - 否则命令菜单开启：↑/↓ 选择候选；否则：↑ 开始回看历史。
    const inHistoryRecall = histIdxRef.current >= 0
    if (!listMode && (key.name === 'up' || key.name === 'down')) {
      if (inHistoryRecall || !cmdMenuOpen) {
        // —— 输入历史 ↑/↓ ——
        if (history.length > 0) {
          if (key.name === 'up') {
            const cur = histIdxRef.current
            const i = cur === -1 ? history.length - 1 : Math.max(0, cur - 1)
            key.preventDefault()
            setComposer(history[i] ?? '')
            setInput(history[i] ?? '')
            setHistIdxSync(i)
            return true
          }
          if (key.name === 'down') {
            const cur = histIdxRef.current
            const i = cur === -1 || cur + 1 >= history.length ? -1 : cur + 1
            const r = i >= 0 && i < history.length ? history[i]! : ''
            key.preventDefault()
            setComposer(r); setInput(r); setHistIdxSync(i)
            return true
          }
        }
      }
      if (!inHistoryRecall && cmdMenuOpen) {
        // —— 命令菜单候选 ↑/↓ 选择 ——
        const last = cmdCandidates.length - 1
        if (key.name === 'up') { key.preventDefault(); setCmdSel((s) => Math.max(0, s - 1)); return true }
        if (key.name === 'down') { key.preventDefault(); setCmdSel((s) => Math.min(last, s + 1)); return true }
      }
    }
    // —— 命令菜单 Tab 补全 / Esc 关闭 / Enter 提交 ——
    if (!listMode && cmdMenuOpen) {
      const last = cmdCandidates.length - 1
      if (key.name === 'tab') {
        key.preventDefault()
        const c = cmdCandidates[Math.min(Math.max(cmdSel, 0), last)]
        const filled = c.command + (c.command.endsWith(' ') ? '' : ' ')
        setComposer(filled); setInput(filled); setCmdSel(0); return true
      }
      if (key.name === 'escape') {
        key.preventDefault()
        const head = input.split(/\s+/)[0] ?? ''
        setComposer(head); setInput(head); setCmdSel(0); return true
      }
      // 仅拦截「无修饰」的 Enter 选中候选命令；Meta/Shift+Enter 放行（走文末提交键分支）
      if (key.name === 'return' && !key.meta && !key.shift) {
        key.preventDefault()
        const c = cmdCandidates[Math.min(Math.max(cmdSel, 0), last)]
        submitRef.current(c.command)
        return true
      }
      // 其余按键（含继续键入以收窄过滤、Meta+Enter）不 preventDefault，交由聚焦 textarea
      // 处理后回落到末尾微任务同步 input —— 保证命令菜单过滤器随键入实时更新。
    }
    // 模块 4：侧栏 tab 切换 —— 输入为空、非列表模式时，◀/▶ 循环切换侧栏模块
    if (!listMode && !cmdMenuOpen && input === '' && showSidebar) {
      if (key.name === 'left') { setSidebarTab((t) => nextSidebarTab(t, -1)); return }
      if (key.name === 'right') { setSidebarTab((t) => nextSidebarTab(t, 1)); return }
    }
    // 会话列表模式：↑/↓ 移动、Enter 恢复、Tab/Esc 返回输入
    if (sessionMode && sessions.length > 0) {
      if (key.name === 'tab' || key.name === 'escape') { setSessionMode(false); return }
      if (key.name === 'up') { setSessionSel((s) => Math.max(0, s - 1)); return }
      if (key.name === 'down') { setSessionSel((s) => Math.min(sessions.length - 1, s + 1)); return }
      if (key.name === 'return') {
        const s = sessions[Math.min(Math.max(sessionSel, 0), sessions.length - 1)]
        setSessionMode(false)
        void refreshSessions()
        submitRef.current(`/resume ${s.id}`)
        return
      }
      return true
    }
    // 文件列表模式：↑/↓ 移动、Enter 打开、Tab 切换到会话列表、Esc 返回输入
    if (fileMode && refs.length > 0 && openFile) {
      if (key.name === 'escape') { setFileMode(false); return }
      if (key.name === 'tab') {
        if (sessions.length > 0) { setFileMode(false); setSessionSel(0); setSessionMode(true); setSidebarTab('sessions'); return }
        setFileMode(false); return
      }
      if (key.name === 'up') { setSel((s) => Math.max(0, s - 1)); return }
      if (key.name === 'down') { setSel((s) => Math.min(refs.length - 1, s + 1)); return }
      if (key.name === 'return') {
        const ref = refs[Math.min(Math.max(sel, 0), refs.length - 1)]
        const parsed = parseFileRef(ref)
        void openFile(parsed.path, parsed.line)
        setFileMode(false)
        return
      }
      return true // 列表模式吞掉其余按键（preventDefault），避免误键入输入框
    }
    // —— 提交键 ——
    // 实测结论（herdr 终端复用器，见开发日志续 125）：只有 Enter 的原生 CR(0x0D) 能送达到
    // 应用，Option+Enter / Shift+Enter / Ctrl+J 的修饰信息全部丢失（一律降级为裸 CR），
    // LF(0x0A) 同样送不进来。故提交键只能是 Enter 本身：
    //   Enter / LF(Ctrl+J) → 提交（一并接受 LF：部分终端/复用器把 Enter 上报成 LF）
    //   Shift+Enter        → 换行（仅终端上报修饰键时；传统终端下等同 Enter=提交）
    //   `\` + Enter        → 换行（去掉行尾转义反斜杠；不依赖修饰键，任何终端可用）
    // 为什么不给 textarea 传 keyBindings：@opentui/react 不透传该 prop（传了被静默丢弃），
    // 自定义提交键只能在全局处理器里直接调用 textarea.submit() 触发 onSubmit。
    if (!listMode && (key.name === 'return' || key.name === 'linefeed')) {
      key.preventDefault()
      const ta = textareaRef.current
      // Shift+Enter：能区分修饰键的终端（Kitty 协议）保留「换行」直觉
      if (key.name === 'return' && key.shift) {
        ta?.newLine()
        setInput(readComposer())
        setHistIdxSync(-1)
        return true
      }
      // `\` + Enter：通用换行兜底（仅认行尾反斜杠，键入场景光标即在末尾）
      const text = readComposer()
      if (key.name === 'return' && ta && text.endsWith('\\')) {
        const next = `${text.slice(0, -1)}\n`
        setComposer(next)
        setInput(next)
        setHistIdxSync(-1)
        return true
      }
      ta?.submit()
      return true
    }
    // 非列表模式：Tab 进入优先的列表（文件引用优先，其次会话）—— 同时切到对应侧栏 tab
    if (!listMode && key.name === 'tab') {
      if (refs.length > 0 && openFile) { setSel(0); setFileMode(true); setSidebarTab('files'); return true }
      if (sessions.length > 0) { setSessionSel(0); setSessionMode(true); setSidebarTab('sessions'); return true }
    }
    // 多行输入状态同步：<textarea> 为非受控组件，键入不触发 React 受控 value，但 `input` state
    // 被命令菜单过滤 / 历史 / 侧栏切换依赖。全局 keyHandler 先于聚焦组件处理按键，此刻 textarea
    // 尚未写入本次字符，故用微任务等聚焦组件同步处理完后，再读取 ref 的最新 composer 回填 input，
    // 并退出历史回看态（histIdx → -1）。命令菜单 / 历史/列表模式各分支已 return，不会落到此处。
    queueMicrotask(() => {
      setInput(readComposer())
      setHistIdxSync(-1)
    })
  })

  // 侧栏文件引用：增量索引。流式时每个块的文本不断追加，若每次统一重扫全部
  // 块会 O(总文本) 递增；这里对每个块只扫描一次新增尾部，成本 O(增量)。
  const fileRefIdxRef = useRef<FileRefIndex>(createFileRefIndex())
  const fileRefs = useMemo(() => {
    let idx = fileRefIdxRef.current
    for (const b of state.blocks) idx = indexFileReferences(idx, b.id, b.text)
    fileRefIdxRef.current = idx
    return idx.ordered
  }, [state])

  const provider = options.provider ?? 'auto'
  const hint = options.openFile && fileRefs.length > 0 ? ' ·[Tab]引用' : ''
  // 状态栏行需在 ≤80 列内（测试 renderer 固定 80 宽）；session 已在侧栏展示，故不在此重复。
  //
  // 宽度预算靠「忙时让位」解决：**忙时隐藏快捷键提示**（此时也用不上），把这几列让给
  // 状态文本；闲时再显示快捷键。于是任何时候总长都不超过原来的最长形态。
  const busyNow = isAgentBusy(agentStatus) || busy
  const statusLabel = busyNow
    ? formatAgentPhase(agentStatus) + (agentStatus.step ? `·${agentStatus.step}步` : '')
    : ''
  const tail = busyNow ? statusLabel : `[^B]面板·[^/]帮助·[^Y]复制·[^C]退出${hint}`
  const statusText =
    `${busyNow ? '●' : '○'} ${provider} | agent=${agentStatus.agentId ?? 'default'}` +
    ` | model=${model ?? '-'}` +
    (tail ? ` | ${tail}` : '')
  // 后台任务分组（模块 A）：进行中置顶、已结束收尾，各自限量
  const { running: bgRunning, finished: bgFinished } = splitBgTasks(bgTasks)
  // 模块 D：统计面板 —— 由对话块 + 后台任务实时归并（elapsed 用挂载起点）
  const stats = computeTuiStats(state.blocks, bgTasks, Date.now() - startTimeRef.current, usage)

  /** 命中缓存则复用（见上面 `toolViewCacheRef`），未命中重算一次并写回 */
  const toolViewOf = (b: ChatBlock): ToolView => {
    const cache = toolViewCacheRef.current
    const hit = cache.get(b.id)
    if (hit && hit.text === b.text) return hit.view
    const view = windowToolText(b.text)
    cache.set(b.id, { text: b.text, view })
    return view
  }

  const renderBlock = (b: ChatBlock) => {
    // 对话消息（用户/助手/工具，非空）在正文下加一行鼠标「复制」按钮 —— 工具输出也可复制。
    // system 块（耗时行 / 元信息 / `tool` 占位等）不显示复制按钮，避免一次应答裂成多个「⧉ 复制」。
    const copyable =
      (b.kind === 'user' || b.kind === 'assistant' || b.kind === 'tool') &&
      b.text.trim().length > 0
    // 工具块按首尾窗口渲染；被省略时复制按钮必须**明示是全文**（否则用户以为拿到的是可见那段）
    const view = b.kind === 'tool' ? toolViewOf(b) : undefined
    // 鼠标选块：用户/助手/工具/推理 均可点选，选中整块高亮（边框 + 标记行）。
    // 内部按钮（复制/折叠/展开）的点击会冒泡连带选中该块，行为一致、可接受。
    const selectable = copyable || b.kind === 'thinking'
    const selected = selectedBlockId === b.id
    // 选区覆盖块（整块响应式高亮）：拖选落在该块 ⇒ 块顶部闪烁标记（对 markdown 也生效，
    // 且与用户/工具块的 selectionBg 闪烁不同源、互不干扰）。`blk_<id>` 供 selection 事件沿父链定位。
    const inSelection = selectable && selBlockIds.has(b.id)
    const body = renderBlockBody(b, view)
    if (!selectable) return body
    return (
      <box
        key={b.id}
        id={`blk_${b.id}`}
        flexDirection="column"
        style={selected ? { border: true } : {}}
        onMouseUp={() => setSelectedBlockId(selected ? null : b.id)}
      >
        {(selected || inSelection) && (
          <text
            attributes={createTextAttributes(
              /*
                ⚠️ `reverse` 不能写成 `inSelection && selBlink ? true : selected`：拖选结束的
                mouseUp 会冒泡到块容器（`onMouseUp` ⇒ `setSelectedBlockId`）⇒ `selected` 恒为
                true ⇒ 两个分支都算出 `reverse: true` ⇒ 标记行恒定反显、**永远不闪**（真机探针实测
                `attributes` 恒为 33 = BOLD|INVERSE，8 次采样零变化）。判据必须是「是否在选区里」，
                「是否被点选」只作为非选区态的兜底。
              */
              inSelection ? { bold: true, reverse: selBlink } : { bold: true, reverse: selected },
            )}
          >
            {inSelection ? '⏳ 选区已选中此块 · 再次拖选可复制 / [Ctrl-Y] 复制文字' : '▌已选中 · 再次点击取消'}
          </text>
        )}
        {body}
        {copyable && (
          <text
            attributes={createTextAttributes(copiedId === b.id ? { reverse: true, bold: true } : { bold: true, underline: true })}
            onMouseUp={(e) => { e.preventDefault(); setCopiedId(b.id); copyTextToClipboard(b.text) }}
          >
            {/* 窗口化时按钮**改名**而不是再加一个：可见内容本来就能拖选 + Ctrl-Y 复制，
                两个按钮里必有一个是垃圾；而这一个必须让人知道拿到的是**全文**。 */}
            {copiedId === b.id
              ? '✓ 已复制'
              : view?.truncated ? `⧉ 复制全文（${view.fullChars} 字符）` : '⧉ 复制'}
          </text>
        )}
      </box>
    )
  }

  const renderBlockBody = (b: ChatBlock, view?: ToolView) => {
    switch (b.kind) {
      case 'assistant':
        return (
          /*
            ⚠️ 这里**刻意不挂** selStyleProps：`MarkdownOptions`（@opentui/core 0.5.8）没有
            selectionBg/selectionFg 字段，挂了也不生效（实测：助手 markdown 块的选区底色恒为
            内核默认的浅色，不随 props 变）—— 与其留一个"看起来在用"的死 prop，不如
            把限制写清楚。用户/工具/思考块是纯 text，那几处挂了、也确实生效（有测试守着）。
            markdown 的选区上色改走**命令式通道**：`selRenderablesRef` + 上面那个 effect 直接
            给内部 `CodeRenderable` 赋 `selectionBg/selectionFg`（真机实测立刻生效、可闪烁）。
            上游若给 MarkdownOptions 补上这两个字段，把 {...selStyleProps} 加回来即可。
          */
          <markdown
            key={b.id}
            content={b.text}
            syntaxStyle={markdownStyle}
            streaming={!!b.streaming}
            conceal
          />
        )
      case 'user':
        return (
          <text key={b.id} attributes={createTextAttributes({ bold: true })} wrapMode="word" {...selStyleProps}>
            ❯ {b.text}
          </text>
        )
      case 'thinking': {
        // 可折叠推理：标题行始终可点。默认长推理（> 160 字符）折叠成一行标题（带摘要预览），
        // 避免占屏；显式展开过的块保持展开。流式中 ├ 体正常显示。
        const collapsed =
          !collapsedThinking.has(b.id) && !b.streaming && b.text.length > 160
        const onClick = (e: { preventDefault(): void }) => {
          e.preventDefault()
          toggleThinking(b.id)
        }
        const header = collapsed
          ? `▸ 💭 推理 · ${b.text.trim().replace(/\s+/g, ' ').slice(0, 52)}…`
          : '▾ 💭 推理'
        return (
          <box key={b.id} flexDirection="column">
            <text
              attributes={createTextAttributes({
                italic: true,
                dim: true,
                underline: collapsed || !b.streaming,
              })}
              onMouseUp={onClick}
              wrapMode="word"
            >
              {header}
            </text>
            {!collapsed && (
              <text attributes={createTextAttributes({ italic: true, dim: true })} wrapMode="word" {...selStyleProps}>
                {b.text}
              </text>
            )}
          </box>
        )
      }
      case 'tool': {
        // 树状工具输出：首行（工具调用）加粗，结果行前加竖线缩进，视觉上与 system 命令输出区分。
        // 行数按「工具调用段落」首尾窗口收窄（见 windowToolText）：一条长结果不再把 🔧 行挤出视口。
        const lines = (view ?? windowToolText(b.text)).lines
        const first = lines[0] ?? ''
        const body = lines.length > 1
          ? lines.slice(1).map((l, i) => `${i === lines.length - 2 ? '└ ' : '│ '}${l}`).join('\n')
          : ''
        return (
          <box key={b.id} flexDirection="column">
            <text attributes={createTextAttributes({ bold: true, dim: true })} wrapMode="word" {...selStyleProps}>{first}</text>
            {body && <text attributes={createTextAttributes({ dim: true })} wrapMode="word" {...selStyleProps}>{body}</text>}
          </box>
        )
      }
      case 'compact': {
        // 阶段四：压缩块提示行（不渲染内容），点击经 loader 惰性展开原文
        const onExpand = b.blockId
          ? (e: { preventDefault(): void }) => {
              e.preventDefault()
              void handleExpandCompact(b.id, b.blockId!)
            }
          : undefined
        return (
          <text
            key={b.id}
            attributes={createTextAttributes({ dim: true, underline: !!onExpand })}
            wrapMode="word"
            onMouseUp={onExpand}
          >
            {b.loading ? `⏳ ${b.text.replace(/（点击展开原文）$/, '')}（加载中…）` : b.text}
          </text>
        )
      }
      case 'loadmore': {
        return (
          <text
            key={b.id}
            attributes={createTextAttributes({ dim: true, underline: true })}
            wrapMode="word"
            onMouseUp={(e) => { e.preventDefault(); void handleLoadMore() }}
          >
            {b.text}
          </text>
        )
      }
      case 'system':
      default:
        return (
          <text key={b.id} attributes={createTextAttributes({ dim: true })} wrapMode="word">
            {b.text || '\u00A0'}
          </text>
        )
    }
  }

  return (
    <box
      flexDirection="column"
      style={{ flexGrow: 1 }}
      onMouseDown={(e) => {
        // 鼠标点击任意处后把焦点还给输入框：OpenTUI 渲染器对 left-down 默认执行
        // autoFocus（从命中元素向上找第一个 focusable 并 focus），点击消息区等文本
        // 会把焦点从 textarea 抢走，此后键盘输入失效、需重新点击输入框。
        // 这里在点击冒泡阶段 preventDefault 掉 autoFocus 并显式 focus 回输入框（幂等）。
        // 拖选文本（startSelection）发生在 dispatchMouseEvent 之前，不受 preventDefault 影响；
        // 复制按钮/折叠标题等 onMouseUp 交互照常触发。
        // 列表模式（Tab 导航）/ 帮助 / 审批模态让出键盘，不抢焦点。
        if (!listMode && !helpOpen && approvalQ === null) {
          e.preventDefault()
          textareaRef.current?.focus()
        }
      }}
    >
      {/* 顶部状态栏 */}
      <box style={{ border: true }}>
        <text attributes={createTextAttributes({ bold: true })}>{statusText}</text>
      </box>

      {/* 主区域：对话 + 侧栏面板 */}
      <box flexDirection="row" style={{ flexGrow: 1 }}>
        {/* ScrollBox 原生粘底滚动：日志追加时自动滚到底部（避免手动 scrollTop 竞态） */}
        <scrollbox stickyScroll stickyStart="bottom" style={{ flexGrow: 1, border: true, padding: 1 }}>
          {hasChat ? state.blocks.map(renderBlock) : <WelcomePanel provider={provider} model={model} notice={restoreNotice || undefined} />}
        </scrollbox>
        {showSidebar && (
          <box flexDirection="column" style={{ width: SIDEBAR_WIDTH, border: true, flexShrink: 0 }}>
            {/* 模块 4：顶部图标 tab 行 —— 点击图标切换，仅展示一个面板 */}
            <box flexDirection="row" style={{ width: SIDEBAR_WIDTH, flexShrink: 0 }}>
              {SIDEBAR_TABS.map((t) => {
                const active = sidebarTab === t.id
                return (
                  <box key={t.id} style={{ flexShrink: 0 }}>
                    <text
                      width={5}
                      attributes={createTextAttributes(active ? { reverse: true, bold: true } : { dim: true })}
                      onMouseUp={(e) => { e.preventDefault(); setSidebarTab(t.id) }}
                    >
                      {t.icon}
                    </text>
                  </box>
                )
              })}
            </box>
            <text attributes={createTextAttributes({ bold: true, dim: sidebarTab !== 'stats' })} style={{ flexShrink: 0 }}>
              {SIDEBAR_TABS.find((t) => t.id === sidebarTab)?.label ?? sidebarTab}
            </text>
            {/*
              宽度必须是 '100%' 而不是 SIDEBAR_WIDTH：外层 box 的 width 含**边框**（26 里 2 列是
              左右边框），内部可用宽度只有 24。写 26 会让 scrollbox 比容器宽 2 列，位于其右边缘的
              垂直滚动条因此被父容器裁掉 —— 表现为"面板没有滚动条、内容还溢出边框"。
              另显式给滚动条配色：默认滑块近黑，深色背景下看不见（见 SIDEBAR_SCROLLBAR_OPTIONS）。
            */}
            <scrollbox
              style={{ flexGrow: 1, width: '100%' }}
              verticalScrollbarOptions={SIDEBAR_SCROLLBAR_OPTIONS}
            >
              {/* 面板：会话上下文 */}
              {sidebarTab === 'context' && (
                <>
                  <text attributes={createTextAttributes({ dim: true })} wrapMode="word">session={options.session.id}</text>
                  <text attributes={createTextAttributes({ dim: true })} wrapMode="word">消息数={options.session.messages.length}</text>
                  <text attributes={createTextAttributes({ dim: true })} wrapMode="word">agent={options.session.agentId ?? 'default'}</text>
                  <text attributes={createTextAttributes({ dim: true })} wrapMode="word">provider={provider}</text>
                  <text attributes={createTextAttributes({ dim: true })} wrapMode="word">model={model ?? '-'}</text>
                </>
              )}
              {/* 面板：会话列表 */}
              {sidebarTab === 'sessions' && (sessions.length === 0
                ? <text attributes={createTextAttributes({ dim: true })}>（无）</text>
                : sessions.map((s, i) => {
                    const active = sessionMode && i === sessionSel
                    const attrs = active
                      ? createTextAttributes({ reverse: true, bold: true })
                      : createTextAttributes({ dim: true, bold: s.id === options.session.id })
                    return (
                      <text key={s.id} attributes={attrs} wrapMode="word" width={SIDEBAR_WIDTH - 4}>
                        {sessionMode ? (active ? '▸ ' : '  ') : ''}{sessionRowText(s, Date.now())}
                      </text>
                    )
                  }))}
              {/* 面板：后台任务 */}
              {sidebarTab === 'tasks' && (bgTasks.length === 0
                ? <text attributes={createTextAttributes({ dim: true })}>（无）</text>
                : [...bgRunning.slice(0, MAX_RUNNING_BG), ...bgFinished.slice(0, MAX_FINISHED_BG)].map((t) => (
                    <text
                      key={t.taskId}
                      attributes={createTextAttributes({
                        dim: t.status !== 'running',
                        reverse: t.status === 'running',
                      })}
                      wrapMode="word"
                      width={SIDEBAR_WIDTH - 4}
                    >
                      {bgTaskRow(t)}
                    </text>
                  )))}
              {/* 面板：文件引用 */}
              {sidebarTab === 'files' && (fileRefs.length === 0
                ? <text attributes={createTextAttributes({ dim: true })}>（无）</text>
                : fileRefs.map((p, i) => {
                    const active = fileMode && options.openFile != null && i === sel
                    const attrs = active
                      ? createTextAttributes({ reverse: true, bold: true })
                      : createTextAttributes({ dim: true, underline: true })
                    return (
                      <text key={p} attributes={attrs} wrapMode="word" width={SIDEBAR_WIDTH - 4}>
                        {fileMode && options.openFile ? (active ? '▸' : ' ') : ''}{abbrevFileRef(p, SIDEBAR_WIDTH - 6, workdir)}
                      </text>
                    )
                  }))}
              {/* 面板：统计 —— 本地估算 + 实际 API 用量 + 模型/工具/token/缓存/小时时序 */}
              {sidebarTab === 'stats' && (
                <>
                  <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
                    消息 {stats.users}u/{stats.assistants}a {stats.thinking}t/{stats.tools}T
                  </text>
                  <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
                    字符 {stats.chars} · ~{stats.tokens} tok
                  </text>
                  <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
                    任务 {stats.tasksRunning}进行/{stats.tasksDone}完成 · {formatDuration(stats.elapsedMs)}
                  </text>
                  {todayTotals && !isBlankUsage(todayTotals) && (
                    <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
                      {todayUsageLine(todayTotals)}（全部会话）
                    </text>
                  )}
                  <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
                    LLM {stats.usage.llmCalls}次 · in{stats.usage.inputTokens}/out{stats.usage.outputTokens}
                  </text>
                  {(stats.usage.cacheReadTokens > 0 || stats.usage.cacheWriteTokens > 0) && (
                    <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
                      {cacheUsageLine(stats.usage)}
                    </text>
                  )}
                  {stats.usage.models.length > 0 && (
                    <>
                      <text attributes={createTextAttributes({ bold: true })}>模型</text>
                      {stats.usage.models.map((m) => (
                        <text key={m.model} attributes={createTextAttributes({ dim: true })} wrapMode="word">
                          {modelUsageRow(m)}
                        </text>
                      ))}
                    </>
                  )}
                  {stats.usage.agents.length > 0 && (
                    <>
                      <text attributes={createTextAttributes({ bold: true })}>agent/任务</text>
                      {stats.usage.agents.map((a) => (
                        <text key={a.agentId} attributes={createTextAttributes({ dim: true })} wrapMode="word">
                          {agentUsageRow(a)}
                        </text>
                      ))}
                    </>
                  )}
                  {stats.usage.tools.length > 0 && (
                    <>
                      <text attributes={createTextAttributes({ bold: true })}>工具</text>
                      {stats.usage.tools.map((t) => (
                        <text key={t.tool} attributes={createTextAttributes({ dim: true })} wrapMode="word">
                          {toolUsageRow(t)}
                        </text>
                      ))}
                    </>
                  )}
                  {stats.usage.hourly.length > 1 && (
                    <>
                      <text attributes={createTextAttributes({ bold: true })}>小时时序</text>
                      {stats.usage.hourly.map((h) => (
                        <text key={h.hour} attributes={createTextAttributes({ dim: true })} wrapMode="word">
                          {hourlyRow(h, Math.max(...stats.usage.hourly.map((x) => x.inputTokens + x.outputTokens), 1))}
                        </text>
                      ))}
                    </>
                  )}
                  {/* 上下文占用（本会话 + 子会话）：与 /stats、/compact 同一套窗口/阈值推导 */}
                  <ContextOccupancyLine harness={options.harness} sessionId={options.session.id} compactOpts={ctxOccOpts} resolveWindow={ctxWindowFor} />
                  <text attributes={createTextAttributes({ dim: true })} wrapMode="word">── /stats 详情 · /stats-export 报告 ──</text>
                </>
              )}
            </scrollbox>
          </box>
        )}
      </box>

      {/* 底部输入：列表模式让出焦点（由 useKeyboard 接管上下/回车） */}
      <box flexDirection="column" style={{ flexShrink: 0 }}>
        {/* 模块 D：帮助面板 overlay —— modal，输入框让出焦点，任意键关闭 */}
        {helpOpen && (
          <box style={{ border: true, padding: 1, maxHeight: 12 }}>
            {HELP_LINES.map((l) => (
              <box flexDirection="row" key={l.key} minHeight={1}>
                <box width={20}>
                  <text attributes={createTextAttributes({ dim: true })}>{l.key}</text>
                </box>
                <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
                  {l.key === 'Shift+Enter' ? shiftEnterHelpLine(keyboardSupport) : l.desc}
                </text>
              </box>
            ))}
          </box>
        )}
        {/* 模块 E：命令审批模态 —— 权限询问弹出，Y=允许 N=拒绝 Shift-Y=始终允许 Shift-N=始终拒绝 */}
        {approvalQ !== null && (
          <box style={{ border: true, padding: 1 }}>
            <text attributes={createTextAttributes({ bold: true, reverse: true })}>
              {' 权限审批 '.padEnd(22)}
            </text>
            <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
              {approvalLine(approvalQ)}
            </text>
            <text wrapMode="word">  [y] 允许    [n] 拒绝    [Shift-y] 始终允许    [Shift-n] 始终拒绝</text>
          </box>
        )}
        {/* 模块 C：/ 命令补全菜单弹层（出现在输入框上方，随输入前缀过滤） */}
        {!listMode && cmdMenuOpen && cmdCandidates.length > 0 && (
          <box style={{ border: true, maxHeight: 8 }}>
            {cmdCandidates.slice(0, 8).map((c, i) => {
              const active = i === Math.min(Math.max(cmdSel, 0), cmdCandidates.length - 1)
              const attrs = active
                ? createTextAttributes({ reverse: true, bold: true })
                : createTextAttributes({ dim: true })
              return (
                <text key={c.command} attributes={attrs} wrapMode="word">
                  {c.command}{c.description ? `  —  ${c.description}` : ''}
                </text>
              )
            })}
          </box>
        )}
        {/* 底部输入行：运行中显示「■ 终止」按钮（点击 abort 当前查询，同 Ctrl-C 语义）；
            有拖选选区时显示「已选 N 字符 · ✕」（点击清除选区，Ctrl-Y 复制） */}
        <box flexDirection="row">
          {busyNow && (
            <text
              attributes={createTextAttributes({ bold: true, reverse: true })}
              onMouseUp={(e) => { e.preventDefault(); abortCurrent() }}
            >
              ■ 终止
            </text>
          )}
          {(selChars > 0 || selCopied) && (
            <text
              attributes={createTextAttributes(
                // 有选区时按钮本身跟着闪（与选中文字同一节奏）：即使选中的是 markdown 块
                // （那类块的选区配色改不了），用户也能从按钮的闪动确知"已经选中了"
                selCopied ? { bold: true, reverse: true } : { bold: true, underline: true, reverse: selBlink },
              )}
              onMouseDown={onSelectionChipMouse}
              onMouseUp={onSelectionChipMouse}
            >
              {selectionChipLabel}
            </text>
          )}
          <textarea
            ref={textareaRef}
            focused={!listMode}
            onSubmit={() => submit(readComposer())}
            placeholder="❯ "
            style={{ flexGrow: 1 }}
          />
        </box>
      </box>
    </box>
  )
}

// ------------------------------------------------------------------------
// startTuiRepl：真实终端入口 + 默认 openFile
// ------------------------------------------------------------------------

// abbrevFileRef / resolveEditPath / findFileReferences / buildDiskFileTree 等
// 文件引用与目录树纯函数已上移 @harness/host（P2-v2：sidecar 的 harness/tree.get
// 也要用，CLI 不能成为唯一定义处）；这里再导出以维持本模块的既有导入面。
export {
  findFileReferences,
  collectFileRefsFromTexts,
  fileRefBase,
  abbrevFileRef,
  resolveEditPath,
  buildDiskFileTree,
  renderFileRefTree,
  anyMarked,
} from '@harness/host'
export type { FileRefTreeNode, DiskTreeOptions } from '@harness/host'

/**
 * 选择前台编辑器命令。优先 $EDITOR/$VISUAL；缺失时回退到交互式终端编辑器
 * （vim → nano）。不做 macOS `open` 兜底——`open` 立即返回、在 alt-screen TUI 下
 * 会让编辑器在 GUI 异步打开而终端瞬间被 resume 遮回，用户看不到编辑器界面。
 */
function pickEditor(): string[] | null {
  const env = process.env.EDITOR || process.env.VISUAL
  if (env && env.trim()) return env.split(/\s+/).filter(Boolean)
  // 探测常见交互式终端编辑器（存在于 $PATH 即用）
  const candidates = ['vim', 'nvim', 'nano']
  return candidates.find((c) => isExecutableInPath(c)) ? [candidates.find((c) => isExecutableInPath(c))!] : null
}

/** 判断可执行文件是否存在于 $PATH（用于编辑器探测，用 `which` 最可靠）。 */
function isExecutableInPath(name: string): boolean {
  try {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const r = spawnSync('which', [name], { stdio: 'ignore' })
    return !r.error && r.status === 0
  } catch { return false }
}

/** 构造编辑器启动参数：编辑器命令 + 独立 `+<line>`（绝不拼 `path:line`）。 */
function buildEditorArgv(path: string, line?: number, base?: string): string[] {
  const abs = resolveEditPath(path, base)
  const cmd = pickEditor()
  if (!cmd) return [abs] // 无可用编辑器时退化：仅返回文件路径（调用方决定如何处理）
  return [...cmd, ...(line != null && line > 1 ? [`+${line}`] : []), abs]
}

/**
 * 用本机编辑器打开文件。返回需前台运行的命令 argv（纯函数），由调用方决定如何执行
 * （TUI 下先 suspend 再前台 spawn inherit，避免 alt-screen 下后台 spawn 令编辑器拿不到
 * 前台焦点而"打不开"）。
 *
 * @param base 相对路径基准（缺省 process.cwd()）；TUI 应传启动时解析出的工作目录
 */
export function buildEditorCommand(path: string, line?: number, base?: string): string[] {
  return buildEditorArgv(path, line, base)
}

/**
 * 统计面板「上下文占用」行：本会话 + 各子会话占用率（复用 /stats 的 renderContextOccupancy，
 * 窗口/阈值取 buildCompactionOptions 同一套推导，分母则按各会话自身端点解析）。每 3s 刷新一次
 * （执行中占用会变化）。
 */
function ContextOccupancyLine(props: {
  harness: Harness
  sessionId: string
  compactOpts?: CompactOptions
  /** 会话 → 该会话实际该用的窗口（见 resolveCompactionWindow）；不传则退回单一窗口 */
  resolveWindow?: (s: Session | undefined) => number
}) {
  const [text, setText] = useState('')
  useEffect(() => {
    if (!props.compactOpts) return
    let alive = true
    const refresh = () => {
      // renderContextOccupancy 已上移 @harness/usage，其 resolveWindow 形参是结构化最小视图；
      // 本组件的闭包按真实 Session 解析窗口 —— 在边界上显式收窄一次。
      renderContextOccupancy(
        props.harness,
        { id: props.sessionId } as never,
        props.compactOpts!,
        props.resolveWindow
          ? (s) => props.resolveWindow!((s ?? undefined) as Session | undefined)
          : undefined,
      )
        .then((t) => { if (alive) setText(t.trim()) })
        .catch(() => {})
    }
    refresh()
    const iv = setInterval(refresh, 3000)
    return () => { alive = false; clearInterval(iv) }
  }, [props.compactOpts, props.sessionId, props.resolveWindow])
  if (!text) return null
  return <text attributes={createTextAttributes({ dim: true })} wrapMode="word">{text}</text>
}

/**
 * 启动 TUI REPL（OpenTUI alt-screen 全屏交互）。
 *
 * - createCliRenderer 接管终端（raw-mode 输入 + 增量渲染）
 * - TuiApp 组件树渲染：状态栏 + 主对话（markdown）+ 侧栏面板 + 底部输入行
 * - 输入提交 → createProcessLine（与 REPL 共用会话内核）→ onEvent 流式 markdown
 * - 侧栏文件引用：Tab 进入 → 上下键选中 → Enter 用本机编辑器打开（默认 openFile）
 * - Ctrl-C / /exit 退出；Coordinator 自动续轮注入 `<continue/>` 触发下一轮
 */
export async function startTuiRepl(options: TuiReplOptions): Promise<TuiReplExit> {
  // useMouse：启用 SGR 鼠标协议，支持消息复制按钮点击
  // useKittyKeyboard：显式声明开启 Kitty 键盘协议（disambiguate 修 ESC 歧义 + alternateKeys 跨键盘布局）。
  // 2026-09-30 起不再依赖 OpenTUI 的默认值（升级改默认时这里是唯一保险）；
  // 不支持的终端忽略未知 CSI 自然降级 legacy，能力探测与帮助文案见 keyboard.ts。
  const renderer: CliRenderer = await createCliRenderer({
    useMouse: true,
    useKittyKeyboard: { disambiguate: true, alternateKeys: true },
  })
  const root = createRoot(renderer)
  // 未显式提供 openFile 时，用本机编辑器在前台打开文件引用。
  // 关键：先 suspend() 释放终端 raw-mode 并退出 alt-screen，前台 spawn inherit 运行
  // 编辑器（用户能真正看到并交互），等待其退出后 resume() 回到 TUI。
  const opts: TuiReplOptions = options.openFile ? options : {
    ...options,
    openFile: async (path, line) => {
      // 相对路径按**启动时解析出的工作目录**解析（不是进程启动目录）：
      // `--cwd X` 启动时，侧栏引用/`/edit` 的相对路径必须落在 X 下。
      const argv = buildEditorCommand(path, line, options.app.workspace.cwd)
      // 无可用编辑器时 argv 退化为 [abs]（单路径，不可 spawn），此时直接返回、不做挂起
      if (argv.length < 2) return
      try {
        renderer.suspend()
        await new Promise<void>((res, rej) => {
          const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' })
          child.on('exit', () => res())
          child.on('error', rej)
        })
      } finally {
        renderer.resume()
      }
    },
  }
  try {
    return await new Promise<TuiReplExit>((resolve) => {
      root.render(<TuiApp options={opts} onExit={resolve} />)
    })
  } finally {
    try { root.unmount() } catch { /* 忽略清理错误 */ }
    try { renderer.destroy() } catch { /* 忽略清理错误 */ }
  }
}