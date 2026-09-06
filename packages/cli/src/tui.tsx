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
import { spawn } from 'node:child_process'
import { createCliRenderer, createTextAttributes, SyntaxStyle, RGBA, type CliRenderer, type TextareaRenderable } from '@opentui/core'
import { createRoot, useKeyboard, useAppContext } from '@opentui/react'
import { createProcessLine, listReplCommands } from './index'
import type { HarnessApp } from './index'
import type { AgentStreamEvent, Harness } from '@harness/core'
import type { Message, Session } from '@harness/session'
import type { BackgroundTaskViewLike } from '@harness/plugin'
import { subagentCapability } from '@harness/subagent'
import {
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
  USAGE_STATS_KEY,
  type UsageStats,
} from './usage-stats'

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
}

export type TuiReplExit = 'exit'

/** 侧栏面板宽度（单元格） */
const SIDEBAR_WIDTH = 26
/** 侧栏最多展示的文件引用条数 */
const MAX_FILE_REFS = 8

// ------------------------------------------------------------------------
// 模块 D：帮助面板内容（Ctrl-/ 或 ? 弹出；/help 查看命令列表并在 REPL 层列出）
// ------------------------------------------------------------------------
/** 帮助面板行：{ key: 键位, desc: 说明 } */
export const HELP_LINES: Array<{ key: string; desc: string }> = [
  { key: 'Ctrl-C', desc: '退出 TUI' },
  { key: 'Ctrl-B', desc: '切换右侧面板' },
  { key: 'Ctrl-/ 或 ?', desc: '打开/关闭帮助面板' },
  { key: 'Ctrl-Y', desc: '复制鼠标选中的文字；无选区则复制最近回复' },
  { key: 'Tab', desc: '进入文件引用/会话列表' },
  { key: '↑ / ↓', desc: '命令菜单或历史中选取' },
  { key: '◀ / ▶', desc: '侧栏模块切换（输入为空时）' },
  { key: 'Enter', desc: '输入框内换行；列表/菜单中确认选中' },
  { key: 'Alt/Meta+Enter', desc: '提交输入' },
  { key: 'Esc', desc: '关闭菜单或帮助' },
  { key: '/help', desc: '查看特殊命令' },
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

export type ChatBlockKind = 'system' | 'user' | 'thinking' | 'assistant' | 'tool'

export interface ChatBlock {
  id: number
  kind: ChatBlockKind
  /** 渲染内容：assistant 为 markdown；thinking 为推理文本；其余为控制台文本 */
  text: string
  /** assistant/thinking 流式进行中（尚未 done） */
  streaming?: boolean
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
  if (t.startsWith('🧑')) return { kind: 'user', text: t.replace(/^\S+\s*/, '').trim() }
  if (t.startsWith('💭')) return { kind: 'thinking', text: t.replace(/^\S+\s*/, '').trim() }
  if (t.startsWith('🤖')) return { kind: 'assistant', text: t.replace(/^\S+\s*/, '').trim() }
  if (t.startsWith('🔧') || t.startsWith('✅') || t.startsWith('❌')) return { kind: 'tool', text: t }
  if (t.startsWith('⏱️')) return { kind: 'system', text: t }
  return { kind: 'system', text: t }
}

/** 追加一段控制台文本（按 \n 拆行归类为新块；空行忽略） */
export function pushConsole(state: ChatState, text: string): ChatState {
  let s = state
  for (const raw of text.split('\n')) {
    const line = raw
    if (!line.trim()) continue
    const { kind, text: body } = classifyConsoleLine(line)
    s = { ...s, blocks: [...s.blocks, { id: s.nextId, kind, text: body }], nextId: s.nextId + 1 }
  }
  return s
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

// ------------------------------------------------------------------------
// 文件引用提取（纯函数可单测）
// ------------------------------------------------------------------------

const FILE_REF_RE =
  /(?:\b(?:src|packages|docs|lib|app|api|scripts|test|tests|build)\b(?:\/[\w.\-]+)+|\/?[\w.\-]+\/[\w.\-]+\.[A-Za-z]{1,6})(?::\d+(?::\d+)?)?/g

/** 从文本中提取「类文件路径」引用（含可选的 :行[:列] 后缀），按出现顺序去重 */
export function findFileReferences(text: string): Array<{ path: string; start: number; end: number }> {
  const out: Array<{ path: string; start: number; end: number }> = []
  const re = new RegExp(FILE_REF_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const path = m[0]
    if (!out.some((o) => o.path === path)) out.push({ path, start: m.index, end: m.index + path.length })
    if (re.lastIndex === m.index) re.lastIndex++
  }
  return out
}

/** 汇总所有块中的文件引用（按基础路径去重、限量；保留首次出现的原始形态） */
export function collectFileReferences(state: ChatState, max = MAX_FILE_REFS): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const b of state.blocks) {
    for (const f of findFileReferences(b.text)) {
      // 归一化：去掉 :行[:列] 后缀后按同文件去重，避免同文件不同行号重复展示
      const base = f.path.replace(/:\d+(?::\d+)?$/, '')
      if (!seen.has(base)) {
        seen.add(base)
        out.push(f.path)
        if (out.length >= max) return out
      }
    }
  }
  return out
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
// 还原为指定字体的块，重新展示历史对话。text / reasoning part 拼为正文，
// 空消息、工具调用 part 跳过。

/** 提取一条消息的纯文本（text part 拼接 + reasoning 追加，工具/文件/图片跳过） */
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

/** 把会话历史转成 ChatState：user/assistant/tool 各成一个块，跳过空消息 */
export function messagesToBlocks(messages: Message[]): ChatState {
  const blocks: ChatBlock[] = []
  let nextId = 1
  for (const m of messages) {
    const text = messageText(m)
    if (!text.trim()) continue
    blocks.push({ id: nextId, kind: roleToKind(m.role), text })
    nextId++
  }
  return { blocks, nextId, thinkingIdx: -1, assistantIdx: -1 }
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

/** 会话开始前的主对话区欢迎页组件（替换初始欢迎 system 块的可视化呈现） */
export function WelcomePanel({ provider, model }: { provider: string; model?: string }) {
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
  // 初始状态直接在 useState 初始化：若用 mount effect 设置欢迎语，会覆盖
  // 已在 effect 之前开始处理的用户回复（processLine 于渲染期同步初始化，submit 可先于 effect）。
  const [state, setState] = useState<ChatState>(() =>
    initialChatWithWelcome('输入问题开始对话；输入 /help 查看特殊命令；Ctrl-C 或 /exit 退出。'),
  )
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState<string | undefined>(options.model)
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
  const setComposer = useCallback((value: string) => { textareaRef.current?.setText(value ?? '') }, [])
  // 模块 D：帮助面板 + 统计面板 —— helpOpen 时输入框让出焦点（modal）
  const [helpOpen, setHelpOpen] = useState(false)
  // 模块 E：命令审批模态 —— 权限引擎 ask() 触发时弹出，等待 allow/deny/always/never
  const [approvalQ, setApprovalQ] = useState<string | null>(null)
  const approvalResolveRef = useRef<((ans: string) => void) | null>(null)
  // 鼠标复制（模块 D3）：正在展示「✓ 已复制」提示的块 id（临时高亮，配合 onMouseUp 复制）
  const [copiedId, setCopiedId] = useState<number | null>(null)
  // 统计面板计时起点：组件挂载时刻
  const startTimeRef = useRef(Date.now())
  // 实际用量累积器（onEvent 驱动）：LLM 调用 token / 模型 / 工具粒度
  const [usage, setUsage] = useState<UsageStats>(emptyUsage())
  // 模块 4：侧栏各模块改为顶部图标 tab + 左右切换（每次仅展示一个面板）
  const [sidebarTab, setSidebarTab] = useState<SidebarTabId>('context')
  // 工具token归并状态：暂存本轮 LLM 用量，仅归并到紧随的第一个工具
  const pendingToolAttrRef = useRef<{ input: number; output: number } | null>(null)
  const toolAttributedRef = useRef(false)
  // 选区复制（模块 D4）：读全局 renderer，Ctrl-Y 优先复制鼠标选中的文字
  const { renderer } = useAppContext()
  // 会话开始前（仅剩 system 块）展示欢迎页；发起首条消息后切换为对话块列表
  const hasChat = state.blocks.some((b) => b.kind !== 'system')

  // 会话处理内核（与 REPL 共用）：结构化 onEvent 驱动 markdown 流，out 归类控制台文本。
  // onEvent 增量被缓冲并按宏任务批合并提交，避免高频 chunk 逐次全量重解析 markdown。
  const processLineRef = useRef<((raw: string) => Promise<'continue' | 'exit'>) | null>(null)
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
      onEvent: (ev) => {
        // 轻量副作用立即处理（不触渲染重解析）
        if (ev.type === 'done') {
          setBusy(false)
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
        }
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
      // 把新会话历史还原为对话块刷新聊天区；空会话则回落初始欢迎态。
      setSession: (s) => {
        options.session = s
        setState(messagesToBlocks(s.messages))
      },
    })
  }

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

  // 模块 4：会话级持久化统计 —— 用量变化时写入 session.meta[usageStats] 并防抖落盘。
  // 这样切换/恢复会话后，/stats 与 /stats-export 都能从 meta 读到历史累计。
  const saveUsageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const sess = options.session
    if (!sess) return
    sess.meta = { ...(sess.meta ?? {}), [USAGE_STATS_KEY]: usage }
    if (saveUsageTimerRef.current) clearTimeout(saveUsageTimerRef.current)
    saveUsageTimerRef.current = setTimeout(() => {
      void options.app.sessionStore.save(sess).catch(() => { /* 落盘失败静默 */ })
    }, 800)
    return () => { if (saveUsageTimerRef.current) clearTimeout(saveUsageTimerRef.current) }
  }, [usage, options.session, options.app])

  // 模块 C：加载 / 命令补全候选（内置 REPL 命令 + 插件注册命令）
  useEffect(() => {
    void listReplCommands(options.harness).then(setAllCommands).catch(() => { /* 忽略加载失败 */ })
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
  const submitRef = useRef(submit)
  submitRef.current = submit
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
    if (key.ctrl && key.name === 'c') return finish('exit')
    __KEYLOG.push(`${key.name}:${key.ctrl ? 'C' : ''}`)
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
    // 模块 C：/ 命令菜单 —— 输入以 / 开头且有候选时，↑/↓ 选中、Tab 补全、Enter 提交、Esc 关闭
    if (!listMode && cmdMenuOpen) {
      const last = cmdCandidates.length - 1
      if (key.name === 'up') { key.preventDefault(); setCmdSel((s) => Math.max(0, s - 1)); return true }
      if (key.name === 'down') { key.preventDefault(); setCmdSel((s) => Math.min(last, s + 1)); return true }
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
      // 仅拦截普通 Enter 选中命令；Meta+Enter 放行提交正文
      if (key.name === 'return' && !key.meta) {
        key.preventDefault()
        const c = cmdCandidates[Math.min(Math.max(cmdSel, 0), last)]
        submitRef.current(c.command)
        return true
      }
      // 其余按键（含继续键入以收窄过滤、Meta+Enter）不 preventDefault，交由聚焦 textarea
      // 处理后回落到末尾微任务同步 input —— 保证命令菜单过滤器随键入实时更新。
    }
    // 模块 C：输入历史 —— 无命令菜单时，↑ 回看 / ↓ 前进；回看值覆盖当前 composer（输入任意字符即取消回看）
    if (!listMode && !cmdMenuOpen && history.length > 0) {
      if (key.name === 'up') {
        const cur = histIdxRef.current
        const i = cur === -1 ? history.length - 1 : Math.max(0, cur - 1)
        key.preventDefault()
        setComposer(history[i] ?? '')
        setInput(history[i] ?? '')
        setHistIdxSync(i) // ref 同步更新，连按/自动重复也能逐级回看
        return true
      }
      if (key.name === 'down') {
        const cur = histIdxRef.current
        // 回看中 ↓ 前进一条；已到最近一条（cur + 1 >= history.length）时退出回看（恢复当前输入）
        const i = cur === -1 || cur + 1 >= history.length ? -1 : cur + 1
        const r = i >= 0 && i < history.length ? history[i]! : ''
        key.preventDefault()
        setComposer(r); setInput(r); setHistIdxSync(i)
        return true
      }
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
  const statusText =
    `${busy ? '●' : '○'} ${provider} | agent=${options.session.agentId ?? 'default'}` +
    ` | model=${model ?? '-'} | [^B]面板·[^/]帮助·[^Y]复制·[^C]退出${hint}`
  // 后台任务分组（模块 A）：进行中置顶、已结束收尾，各自限量
  const { running: bgRunning, finished: bgFinished } = splitBgTasks(bgTasks)
  // 模块 D：统计面板 —— 由对话块 + 后台任务实时归并（elapsed 用挂载起点）
  const stats = computeTuiStats(state.blocks, bgTasks, Date.now() - startTimeRef.current, usage)

  const renderBlock = (b: ChatBlock) => {
    // 对话消息（用户/助手/工具且非空）在正文下加一行鼠标「复制」按钮 —— 工具/报错信息也可复制
    const copyable = (b.kind === 'user' || b.kind === 'assistant' || b.kind === 'tool') && b.text.trim().length > 0
    if (copyable) {
      return (
        <box key={b.id} flexDirection="column">
          {renderBlockBody(b)}
          <text
            attributes={createTextAttributes(copiedId === b.id ? { reverse: true, bold: true } : { dim: true, underline: true })}
            onMouseUp={(e) => { e.preventDefault(); setCopiedId(b.id); copyTextToClipboard(b.text) }}
          >
            {copiedId === b.id ? '✓ 已复制' : '⧉ 复制'}
          </text>
        </box>
      )
    }
    return renderBlockBody(b)
  }

  const renderBlockBody = (b: ChatBlock) => {
    switch (b.kind) {
      case 'assistant':
        return (
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
          <text key={b.id} attributes={createTextAttributes({ bold: true })} wrapMode="word">
            ❯ {b.text}
          </text>
        )
      case 'thinking':
        return (
          <text key={b.id} attributes={createTextAttributes({ italic: true, dim: true })} wrapMode="word">
            💭 {b.text}
          </text>
        )
      case 'tool':
        return (
          <text key={b.id} attributes={createTextAttributes({ dim: true })} wrapMode="word">
            {b.text}
          </text>
        )
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
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      {/* 顶部状态栏 */}
      <box style={{ border: true }}>
        <text attributes={createTextAttributes({ bold: true })}>{statusText}</text>
      </box>

      {/* 主区域：对话 + 侧栏面板 */}
      <box flexDirection="row" style={{ flexGrow: 1 }}>
        {/* ScrollBox 原生粘底滚动：日志追加时自动滚到底部（避免手动 scrollTop 竞态） */}
        <scrollbox stickyScroll stickyStart="bottom" style={{ flexGrow: 1, border: true, padding: 1 }}>
          {hasChat ? state.blocks.map(renderBlock) : <WelcomePanel provider={provider} model={model} />}
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
            <scrollbox style={{ flexGrow: 1, width: SIDEBAR_WIDTH }}>
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
                        {fileMode && options.openFile ? (active ? '▸' : ' ') : ''}{p}
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
                  <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
                    LLM {stats.usage.llmCalls}次 · in{stats.usage.inputTokens}/out{stats.usage.outputTokens}
                  </text>
                  {(stats.usage.cacheReadTokens > 0 || stats.usage.cacheWriteTokens > 0) && (
                    <text attributes={createTextAttributes({ dim: true })} wrapMode="word">
                      缓存⚡{stats.usage.cacheReadTokens} · 未命中{uncachedInput(stats.usage)}
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
                <text attributes={createTextAttributes({ dim: true })} wrapMode="word">{l.desc}</text>
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
        <textarea
          ref={textareaRef}
          focused={!listMode}
          onSubmit={() => submit(readComposer())}
          placeholder="❯ "
        />
      </box>
    </box>
  )
}

// ------------------------------------------------------------------------
// startTuiRepl：真实终端入口 + 默认 openFile
// ------------------------------------------------------------------------

/** 用本机编辑器在后台打开文件（不阻塞 TUI）。优先 $EDITOR/$VISUAL，回退 macOS `open`。 */
function openInEditor(path: string, line?: number): void {
  const editor = process.env.EDITOR || process.env.VISUAL
  const target = line != null && line > 1 ? `${path}:${line}` : path
  const argv = editor ? [...editor.split(/\s+/).filter(Boolean), target] : ['open', target]
  try {
    spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' }).unref()
  } catch { /* 打开失败静默忽略 */ }
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
  const renderer: CliRenderer = await createCliRenderer({ useMouse: true })
  const root = createRoot(renderer)
  // 未显式提供 openFile 时，用本机编辑器打开文件引用
  const opts: TuiReplOptions = options.openFile ? options : { ...options, openFile: openInEditor }
  try {
    return await new Promise<TuiReplExit>((resolve) => {
      root.render(<TuiApp options={opts} onExit={resolve} />)
    })
  } finally {
    try { root.unmount() } catch { /* 忽略清理错误 */ }
    try { renderer.destroy() } catch { /* 忽略清理错误 */ }
  }
}