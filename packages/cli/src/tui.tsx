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
 *  - 文件引用：findFileReferences 从文本中提取路径，侧栏「文件引用」展示
 *  - 多面板：主对话区 + 右侧会话上下文面板（Ctrl-B 切换）
 *  - 状态栏扩展：provider / agent / model / 忙碌指示 / 快捷键提示
 *
 * 会话内核复用 createProcessLine。TUI 传入：
 *  - `out`：只收非结构化输出（用户回显 / 工具行 / 命令输出 / 计时），归类为块
 *  - `onEvent`：收 <thinking>/<assistant> 结构化增量，做流式 markdown / 推理块
 * 测试用 @opentui/core/testing 的 createTestRenderer + mockInput 模拟按键。
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { createCliRenderer, createTextAttributes, SyntaxStyle, RGBA, type CliRenderer } from '@opentui/core'
import { createRoot, useKeyboard } from '@opentui/react'
import { createProcessLine } from './index'
import type { HarnessApp } from './index'
import type { AgentStreamEvent, Harness } from '@harness/core'
import type { Session } from '@harness/session'

// ------------------------------------------------------------------------
// 类型
// ------------------------------------------------------------------------

export interface TuiReplOptions {
  app: HarnessApp
  harness: Harness
  session: Session
  /** provider 名称（状态栏展示；未传时显示 auto） */
  provider?: string
  /** 收到普通用户输入时回调（REPL 回显前触发） */
  onLine?: (line: string) => Promise<void> | void
}

export type TuiReplExit = 'exit'

/** 侧栏面板宽度（单元格） */
const SIDEBAR_WIDTH = 26
/** 侧栏最多展示的文件引用条数 */
const MAX_FILE_REFS = 8

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
// TuiApp：OpenTUI React 组件树（状态栏 + 主对话 + 侧栏面板 + 输入）
// ------------------------------------------------------------------------

export function TuiApp({ options, onExit }: { options: TuiReplOptions; onExit: (r: TuiReplExit) => void }) {
  // 初始状态直接在 useState 初始化：若用 mount effect 设置欢迎语，会覆盖
  // 已在 effect 之前开始处理的用户回复（processLine 于渲染期同步初始化，submit 可先于 effect）。
  const [state, setState] = useState<ChatState>(() =>
    initialChatWithWelcome('输入问题开始对话；输入 /help 查看特殊命令；Ctrl-C 或 /exit 退出。'),
  )
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState<string | undefined>(undefined)
  const [showSidebar, setShowSidebar] = useState(true)

  // 会话处理内核（与 REPL 共用）：结构化 onEvent 驱动 markdown 流，out 归类控制台文本
  const processLineRef = useRef<((raw: string) => Promise<'continue' | 'exit'>) | null>(null)
  const exitRef = useRef(false)
  if (processLineRef.current === null) {
    processLineRef.current = createProcessLine({
      app: options.app,
      harness: options.harness,
      session: options.session,
      out: (s) => setState((prev) => pushConsole(prev, s)),
      onEvent: (ev) => {
        setState((prev) => applyStreamEvent(prev, ev))
        if (ev.type === 'done') {
          setBusy(false)
          setModel(ev.message?.meta?.model)
        } else if (ev.type === 'text_delta' || ev.type === 'reasoning_delta' || ev.type === 'tool_call_start') {
          setBusy(true)
        }
      },
      onLine: options.onLine,
      setSession: (s) => { options.session = s },
    })
  }

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
    setInput('')
    if (value.trim()) {
      pendingLines.current.push(value)
      void drain()
    }
  }, [drain])

  // 全局快捷键：Ctrl-C 退出、Ctrl-B 切换侧栏
  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') finish('exit')
    else if (key.ctrl && key.name === 'b') setShowSidebar((v) => !v)
  })

  // 侧栏文件引用（随块内容变化重算）
  const fileRefs = useMemo(() => collectFileReferences(state), [state])

  const provider = options.provider ?? 'auto'
  const statusText =
    `${busy ? '●' : '○'} ${provider} | agent=${options.session.agentId ?? 'default'}` +
    ` | model=${model ?? '-'} | session=${options.session.id} | [^B]面板 [^C]退出`

  const renderBlock = (b: ChatBlock) => {
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
          {state.blocks.map(renderBlock)}
        </scrollbox>
        {showSidebar && (
          <box flexDirection="column" style={{ width: SIDEBAR_WIDTH, border: true, padding: 1, flexShrink: 0 }}>
            <text attributes={createTextAttributes({ bold: true })}>会话上下文</text>
            <text attributes={createTextAttributes({ dim: true })} wrapMode="word">session={options.session.id}</text>
            <text attributes={createTextAttributes({ dim: true })} wrapMode="word">消息数={options.session.messages.length}</text>
            <text attributes={createTextAttributes({ dim: true })} wrapMode="word">agent={options.session.agentId ?? 'default'}</text>
            <text attributes={createTextAttributes({ dim: true })} wrapMode="word">provider={provider}</text>
            <text attributes={createTextAttributes({ dim: true })} wrapMode="word">model={model ?? '-'}</text>
            <text attributes={createTextAttributes({ dim: true })}>文件引用</text>
            {fileRefs.length === 0
              ? <text attributes={createTextAttributes({ dim: true })}>（无）</text>
              : fileRefs.map((p, i) => (
                  <text key={i} attributes={createTextAttributes({ dim: true, underline: true })} wrapMode="word"
                    width={SIDEBAR_WIDTH - 4}>
                    {p}
                  </text>
                ))}
          </box>
        )}
      </box>

      {/* 底部输入 */}
      <input
        focused
        value={input}
        onInput={setInput}
        onSubmit={(value: unknown) => submit(String(value))}
        placeholder="❯ "
      />
    </box>
  )
}

// ------------------------------------------------------------------------
// startTuiRepl：真实终端入口
// ------------------------------------------------------------------------

/**
 * 启动 TUI REPL（OpenTUI alt-screen 全屏交互）。
 *
 * - createCliRenderer 接管终端（raw-mode 输入 + 增量渲染）
 * - TuiApp 组件树渲染：状态栏 + 主对话（markdown）+ 侧栏面板 + 底部输入行
 * - 输入提交 → createProcessLine（与 REPL 共用会话内核）→ onEvent 流式 markdown
 * - Ctrl-C / /exit 退出；Coordinator 自动续轮注入 `<continue/>` 触发下一轮
 */
export async function startTuiRepl(options: TuiReplOptions): Promise<TuiReplExit> {
  const renderer: CliRenderer = await createCliRenderer()
  const root = createRoot(renderer)
  try {
    return await new Promise<TuiReplExit>((resolve) => {
      root.render(<TuiApp options={options} onExit={resolve} />)
    })
  } finally {
    try { root.unmount() } catch { /* 忽略清理错误 */ }
    try { renderer.destroy() } catch { /* 忽略清理错误 */ }
  }
}