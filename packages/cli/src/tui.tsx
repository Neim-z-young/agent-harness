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
import { readFile } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCliRenderer, createTextAttributes, SyntaxStyle, RGBA, type CliRenderer, type TextareaRenderable } from '@opentui/core'
import { createRoot, useKeyboard, useAppContext } from '@opentui/react'
import { createProcessLine, listReplCommands } from './index'
import type { HarnessApp } from './index'
import type { AgentStreamEvent, Harness } from '@harness/core'
import type { CompactionBlock, HistoryLoadRange, Message, Session } from '@harness/session'
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
  /**
   * 阶段四·按需渲染：惰性加载会话原文（压缩块展开 / 更早分页）。
   * 未传则压缩块只显示提示、点击不展开（/history 兜底全量）。
   */
  loadHistory?: (sessionId: string, range?: HistoryLoadRange) => Promise<Message[]>
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
  if (t.startsWith('🧑')) return { kind: 'user', text: t.replace(/^\S+\s*/, '').trim() }
  if (t.startsWith('💭')) return { kind: 'thinking', text: t.replace(/^\S+\s*/, '').trim() }
  if (t.startsWith('🤖')) return { kind: 'assistant', text: t.replace(/^\S+\s*/, '').trim() }
  if (t.startsWith('🔧') || t.startsWith('✅') || t.startsWith('❌')) return { kind: 'tool', text: t }
  if (t.startsWith('⏱️')) return { kind: 'system', text: t }
  return { kind: 'system', text: t }
}

/** 追加一段控制台文本（按 \n 拆行归类为新块；空行忽略）。
 *  相邻同类块合并为一个块（命令/工具输出多行 → 单块，复制按钮只在末尾出现一次；
 *  欢迎块 id 0 不参与合并，避免首条输出污染静态欢迎文本）。 */
export function pushConsole(state: ChatState, text: string): ChatState {
  let s = state
  for (const raw of text.split('\n')) {
    const line = raw
    if (!line.trim()) continue
    const { kind, text: body } = classifyConsoleLine(line)
    // 仅合并 system（命令输出）/ tool（工具输出）类相邻块；user/thinking/assistant 各自独立
    const last = s.blocks[s.blocks.length - 1]
    if (last && last.id !== 0 && last.kind === kind && (kind === 'system' || kind === 'tool') && !last.streaming) {
      const blocks = s.blocks.slice()
      blocks[blocks.length - 1] = { ...last, text: last.text + '\n' + body }
      s = { ...s, blocks }
    } else {
      s = { ...s, blocks: [...s.blocks, { id: s.nextId, kind, text: body }], nextId: s.nextId + 1 }
    }
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
  /(?:\b(?:src|packages|docs|lib|app|api|scripts|test|tests|build)\b(?:\/[\w.\-]+)+|(?:~\/)?\/?(?:[\w.\-]+\/)+[\w.\-]+\.[A-Za-z]{1,6})(?::\d+(?::\d+)?)?/g

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
// 文件引用目录树（/tree 命令打印磁盘树 + 对话引用 * 标记）
// ------------------------------------------------------------------------

export interface FileRefTreeNode {
  /** 节点唯一键：root:{absPath} | 目录/文件的 absPath */
  key: string
  /** 根→路径缩写（./ | ~/...）；目录/文件→basename */
  name: string
  kind: 'root' | 'dir' | 'file'
  /** 绝对路径 */
  absPath: string
  /** 文件叶：被对话引用过（打印时以 * 标记） */
  marked?: boolean
  children: FileRefTreeNode[]
}

export interface DiskTreeOptions {
  /** 最大目录深度（根=0；默认 3） */
  maxDepth?: number
  /** 最大节点数（超出截断；默认 100） */
  maxNodes?: number
  /** 排除的 basename（目录与文件；默认 .git / node_modules / .DS_Store） */
  exclude?: string[]
}

/**
 * 扫描磁盘构建「根 → 目录 → 文件」树（纯函数，/tree 命令用）。
 * - 目录在前、同级按字母序（类 `tree` 命令习惯）；
 * - 排除噪声（.git / node_modules 等），限制深度与节点数，超出置 truncated；
 * - 对话引用过的文件（abs 命中，含相对 root 解析）以 marked 标记。
 */
export function buildDiskFileTree(
  root: string,
  refs: string[],
  opts: DiskTreeOptions = {},
): { nodes: FileRefTreeNode[]; truncated: boolean } {
  const maxDepth = opts.maxDepth ?? 3
  const maxNodes = opts.maxNodes ?? 100
  const exclude = new Set(opts.exclude ?? ['.git', 'node_modules', '.DS_Store'])
  // 引用 → 绝对路径集合：cwd 基准 + 相对 root 基准双解析，覆盖 ~/绝对/相对三种形态
  const marked = new Set<string>()
  for (const ref of refs) {
    const base = ref.replace(/:\d+(?::\d+)?$/, '')
    marked.add(resolveEditPath(base))
    marked.add(resolve(root, base))
  }
  let count = 0
  let truncated = false
  const rootNode: FileRefTreeNode = {
    key: `root:${root}`,
    name: abbrevFileRef(root, 60),
    kind: 'root',
    absPath: root,
    children: [],
  }
  const scan = (dirAbs: string, node: FileRefTreeNode, depth: number): void => {
    if (truncated || depth >= maxDepth) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dirAbs, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1
      const bd = b.isDirectory() ? 0 : 1
      return ad - bd || a.name.localeCompare(b.name)
    })
    for (const e of entries) {
      if (exclude.has(e.name)) continue
      if (count >= maxNodes) { truncated = true; return }
      const childAbs = join(dirAbs, e.name)
      if (e.isDirectory()) {
        count++
        const child: FileRefTreeNode = { key: childAbs, name: e.name, kind: 'dir', absPath: childAbs, children: [] }
        node.children.push(child)
        scan(childAbs, child, depth + 1)
      } else if (e.isFile()) {
        count++
        node.children.push({ key: childAbs, name: e.name, kind: 'file', absPath: childAbs, marked: marked.has(childAbs), children: [] })
      }
      // 符号链接 / 特殊文件：忽略，避免循环与噪音
    }
  }
  scan(root, rootNode, 0)
  return { nodes: [rootNode], truncated }
}

/** 树中是否有被引用标记的节点 */
function anyMarked(nodes: FileRefTreeNode[]): boolean {
  return nodes.some((n) => n.marked || anyMarked(n.children))
}

/**
 * 把森林渲染为树形文本（根不带分支线，目录带 `/`，被引用文件带 `*`）。
 */
export function renderFileRefTree(tree: FileRefTreeNode[]): string {
  const lines: string[] = []
  const walk = (nodes: FileRefTreeNode[], prefix: string) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const last = i === nodes.length - 1
      const branch = last ? '└─ ' : '├─ '
      const label = n.kind === 'file' ? n.name + (n.marked ? '*' : '') : n.name + (n.kind === 'dir' ? '/' : '')
      lines.push(prefix + branch + label)
      if (n.children.length > 0) walk(n.children, prefix + (last ? '   ' : '│  '))
    }
  }
  for (const root of tree) {
    lines.push(root.name)
    if (root.children.length > 0) walk(root.children, '')
  }
  return lines.join('\n')
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

/** 阶段四·按需渲染：单页渲染的历史消息条数上限（超出显示"更早省略"提示块） */
export const HISTORY_PAGE = 100

/** 把一条消息转成对话块（消息转块的公共入口；空消息返回 undefined） */
function messageToBlock(m: Message, id: number): ChatBlock | undefined {
  const text = messageText(m)
  if (!text.trim()) return undefined
  return { id, kind: roleToKind(m.role), text, msgId: m.id }
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

  if (blocks && blocks.length > 0) {
    for (const b of [...blocks].sort((x, y) => x.at - y.at)) {
      push({ id: nextId, kind: 'compact', text: compactBlockText(b), blockId: b.id })
    }
  }

  let visible = messages
  if (messages.length > page) {
    visible = messages.slice(messages.length - page)
    const hidden = messages.length - page
    push({ id: nextId, kind: 'loadmore', text: `▲ 更早 ${hidden} 条消息已省略（点击加载更多）` })
  }

  for (const m of visible) push(messageToBlock(m, nextId))

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
    const b = messageToBlock(m, nextId)
    if (b) {
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
    const b = messageToBlock(m, nextId)
    if (b) {
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
  // 统计面板计时起点：组件挂载时刻
  const startTimeRef = useRef(Date.now())
  // 阶段四·按需渲染：会话全量消息引用 + 当前可见最旧消息下标（loadmore 分页用）。
  // setSession 时快照；会话继续增长时下标略有偏差（顶部旧段边缘可接受）。
  const allMessagesRef = useRef<Message[]>(options.session.messages)
  const earliestVisibleIdxRef = useRef(Math.max(0, options.session.messages.length - HISTORY_PAGE))
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
      // 把新会话历史还原为对话块刷新聊天区（阶段四：压缩块 → 提示行 + 超长分页）；
      // 空会话则回落初始欢迎态。
      setSession: (s) => {
        options.session = s
        allMessagesRef.current = s.messages
        earliestVisibleIdxRef.current = Math.max(0, s.messages.length - HISTORY_PAGE)
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
        const root = arg ? resolveEditPath(arg) : process.cwd()
        setState((prev) => {
          let isDir = false
          try { isDir = statSync(root).isDirectory() } catch { isDir = false }
          if (!isDir) {
            return { ...prev, blocks: [...prev.blocks, { id: prev.nextId, kind: 'system', text: `目录不存在：${root}` }], nextId: prev.nextId + 1 }
          }
          const refs = collectFileReferences(prev, Number.MAX_SAFE_INTEGER)
          const { nodes, truncated } = buildDiskFileTree(root, refs)
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
          const abs = resolveEditPath(parsed.path)
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
    // 对话消息（用户/助手/工具/命令输出，非空）在正文下加一行鼠标「复制」按钮 —— 工具/报错/命令结果也可复制
    const copyable =
      (b.kind === 'user' || b.kind === 'assistant' || b.kind === 'tool' || b.kind === 'system') &&
      b.text.trim().length > 0
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
                        {fileMode && options.openFile ? (active ? '▸' : ' ') : ''}{abbrevFileRef(p, SIDEBAR_WIDTH - 6)}
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

/**
 * 缩写：外层文件引用路径为"可读且保留目录层级"的单行形态。
 * 优先相对化到主目录（`~/...`）再相对化到 cwd；仍超宽时对中间目录做省略
 * （`dir1/…/name.ext`），文件名与最近一级目录始终保留。
 */
export function abbrevFileRef(path: string, maxLen = 40): string {
  if (!path) return path
  const home = homedir()
  const rels: string[] = []
  // 主目录相对化（`~/...`）
  if (path === home) return '~'
  if (path.startsWith(home + '/')) rels.push(path === home ? '~' : '~' + path.slice(home.length))
  else if (path.startsWith('~/')) rels.push(path)
  // cwd 相对化（`./...`），与主目录相对化并存、取较短者
  try {
    const cwd = process.cwd()
    if (path === cwd) rels.push('.')
    else if (path.startsWith(cwd + '/')) rels.push('.' + path.slice(cwd.length))
    else if (path.startsWith('./')) rels.push(path)
  } catch { /* cwd 不可用则忽略 */ }
  const rel = rels.length ? rels.sort((a, b) => a.length - b.length)[0] : path
  if (rel.length <= maxLen) return rel
  // 超宽：保留目录前段 + 文件名末段，中间折叠，严格控制在 maxLen 内
  const segs = rel.split('/')
  const leaf = segs.pop() ?? rel
  const head = segs.shift() ?? ''
  let headFull = head
  for (const s of segs) {
    const candidate = (headFull ? headFull + '/' : '') + s
    // 折叠标记 `…/`(2) + 文件名(leaf) 需完整落在 maxLen 内
    if (candidate.length + 2 + leaf.length > maxLen) break
    headFull = candidate
  }
  const base = `${headFull}/…/${leaf}`
  return base.length <= maxLen ? base : `…/${leaf}`
}

/**
 * 解析编辑器目标路径（双基准）：`~`/`~/` 开头 → 主目录；其余 → 基于（run 时）cwd。
 * 返回规范化的绝对路径，供编辑器打开与回读统一使用。
 */
export function resolveEditPath(path: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(2))
  if (path.startsWith('~')) return join(homedir(), path.slice(1))
  return resolve(path)
}

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
function buildEditorArgv(path: string, line?: number): string[] {
  const abs = resolveEditPath(path)
  const cmd = pickEditor()
  if (!cmd) return [abs] // 无可用编辑器时退化：仅返回文件路径（调用方决定如何处理）
  return [...cmd, ...(line != null && line > 1 ? [`+${line}`] : []), abs]
}

/**
 * 用本机编辑器打开文件。返回需前台运行的命令 argv（纯函数），由调用方决定如何执行
 * （TUI 下先 suspend 再前台 spawn inherit，避免 alt-screen 下后台 spawn 令编辑器拿不到
 * 前台焦点而"打不开"）。
 */
export function buildEditorCommand(path: string, line?: number): string[] {
  return buildEditorArgv(path, line)
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
  // 未显式提供 openFile 时，用本机编辑器在前台打开文件引用。
  // 关键：先 suspend() 释放终端 raw-mode 并退出 alt-screen，前台 spawn inherit 运行
  // 编辑器（用户能真正看到并交互），等待其退出后 resume() 回到 TUI。
  const opts: TuiReplOptions = options.openFile ? options : {
    ...options,
    openFile: async (path, line) => {
      const argv = buildEditorCommand(path, line)
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