/**
 * @harness/cli - TUI 模式（自研 ANSI 渲染，无外部依赖）
 *
 * 三个可测构件：
 * - KeyDecoder：raw-mode 键盘字节流 → KeyEvent（箭头/Enter/Backspace/Ctrl-C 等）
 * - TuiScreen：alt-screen 全屏渲染（状态栏 + 日志区自动滚动 + 底部输入行）
 * - startTuiRepl：非阻塞输入循环，复用 createProcessLine 作为会话处理内核
 *
 * 渲染层与内核严格解耦：未来若需求膨胀（鼠标、富布局），可整体替换渲染层
 * 迁移现成 TUI 库（如 ink），会话处理逻辑零改动。
 */

import { createProcessLine, attachAutoContinue } from './index'
import type { HarnessApp } from './index'
import type { Harness } from '@harness/core'
import type { Session } from '@harness/session'

// ------------------------------------------------------------------------
// 1. ANSI 基础序列
// ------------------------------------------------------------------------

const ESC = '\x1b'
const CSI = `${ESC}[`

/** 进入 alt-screen（切换前不丢主屏内容） */
const ENTER_ALT_SCREEN = `${CSI}?1049h`
/** 退出 alt-screen（恢复主屏） */
const LEAVE_ALT_SCREEN = `${CSI}?1049l`
/** 隐藏 / 显示光标 */
const HIDE_CURSOR = `${CSI}?25l`
const SHOW_CURSOR = `${CSI}?25h`
/** 清屏 + 光标归位（1,1） */
const CLEAR_SCREEN = `${CSI}2J${CSI}H`
/** 清当前行 */
const CLEAR_LINE = `${CSI}K`
/** 光标定位（1-based） */
function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`
}

// ------------------------------------------------------------------------
// 2. 键盘解码
// ------------------------------------------------------------------------

export type KeyEvent =
  | { type: 'char'; char: string }
  | { type: 'enter' }
  | { type: 'backspace' }
  | { type: 'ctrl-c' }
  | { type: 'tab' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'delete' }
  | { type: 'escape' }
  | { type: 'unknown'; seq: string }

/**
 * raw-mode 键盘字节流解码器。
 *
 * 累积输入块，逐条解码为 KeyEvent；转义序列（如 `\x1b[A` 上箭头）可能
 * 跨块到达，解码器内部维护缓冲，字节不足时等待下一块。
 */
export class KeyDecoder {
  private buf = ''

  /** 喂入一块输入（utf8 字符串），返回本次可解码出的按键列表 */
  push(chunk: string): KeyEvent[] {
    this.buf += chunk
    const keys: KeyEvent[] = []
    for (;;) {
      const k = this.tryDecode()
      if (k === null) break
      keys.push(k)
    }
    return keys
  }

  /** 当前未消费的缓冲（测试可断言不完整序列被保留） */
  get pending(): string {
    return this.buf
  }

  private tryDecode(): KeyEvent | null {
    const b = this.buf
    if (b.length === 0) return null
    const c = b[0]

    // 非 ESC 前缀：单字节解码
    if (c !== ESC) {
      if (c === '\r' || c === '\n') { this.buf = b.slice(1); return { type: 'enter' } }
      if (c === '\x7f' || c === '\x08') { this.buf = b.slice(1); return { type: 'backspace' } }
      if (c === '\x03') { this.buf = b.slice(1); return { type: 'ctrl-c' } }
      if (c === '\x09') { this.buf = b.slice(1); return { type: 'tab' } }
      if (c < ' ') { this.buf = b.slice(1); return { type: 'unknown', seq: c } } // 其他 C0 控制键
      this.buf = b.slice(1)
      return { type: 'char', char: c }
    }

    // ESC 前缀：转义序列
    if (b.length === 1) return null // 只有 ESC，等待后续字节
    if (b[1] === '[') {
      // CSI 序列
      if (b.length < 3) return null
      const fin = b[2]
      const singleMap: Record<string, KeyEvent> = {
        A: { type: 'up' },
        B: { type: 'down' },
        C: { type: 'right' },
        D: { type: 'left' },
        H: { type: 'home' },
        F: { type: 'end' },
        Z: { type: 'tab' },
      }
      if (singleMap[fin]) {
        this.buf = b.slice(3)
        return singleMap[fin]
      }
      // 未知 CSI：跳过中间字节（0x30-0x3F）找最终字节（0x40-0x7E），未到则等待
      let i = 2
      for (; i < b.length; i++) {
        const code = b.charCodeAt(i)
        if (code >= 0x40 && code <= 0x7e) break
      }
      if (i >= b.length) return null
      const seq = b.slice(0, i + 1)
      this.buf = b.slice(i + 1)
      // ESC [ n ~ 形式（如 \x1b[3~ Delete）统一在最终字节为 ~ 时解析
      if (b[i] === '~') {
        const m = seq.match(/^\x1b\[(\d+)~$/)
        if (m && m[1] === '3') return { type: 'delete' }
      }
      return { type: 'unknown', seq }
    }
    if (b[1] === 'O') {
      // SS3 序列（\x1bOP 等 F1-F4 / 应用模式箭头）：整体消费
      if (b.length < 3) return null
      const seq = b.slice(0, 3)
      this.buf = b.slice(3)
      return { type: 'unknown', seq }
    }
    // 独立 ESC 后跟普通字符：视为 Escape 键
    this.buf = b.slice(1)
    return { type: 'escape' }
  }
}

// ------------------------------------------------------------------------
// 3. 屏幕模型与渲染
// ------------------------------------------------------------------------

export interface TuiScreenOptions {
  /** 终端宽度（列数）；默认 process.stdout.columns ?? 80 */
  width?: number
  /** 终端高度（行数）；默认 process.stdout.rows ?? 24 */
  height?: number
}

const PROMPT = '❯ '

/** 按显示宽度截断（超出补省略号）；中文按 UTF-16 长度近似 */
function truncate(s: string, width: number): string {
  if (s.length <= width) return s
  return s.slice(0, Math.max(0, width - 1)) + '…'
}

/**
 * TUI 全屏渲染层（纯内存模型 + render 生成 ANSI 序列，可测）。
 *
 * 布局（height 行）：
 *   行 1：状态栏
 *   行 2：空行分隔
 *   行 3..h-1：日志区（自动滚动，只显示最近 h-3 行）
 *   行 h：输入行（❯ 提示 + 光标定位）
 */
export class TuiScreen {
  readonly width: number
  readonly height: number
  /** 日志行（append 追加，render 时取末尾可见行） */
  logs: string[] = []
  /** 当前输入行内容 */
  input = ''
  /** 光标在输入行内的位置 */
  cursor = 0
  /** 状态栏文本（行 1） */
  status = ''

  constructor(options: TuiScreenOptions = {}) {
    this.width = options.width ?? (process.stdout.columns || 80)
    this.height = options.height ?? (process.stdout.rows || 24)
  }

  /**
   * 追加日志文本。无换行符的片段追加到当前行末尾（流式 token 连续拼接），
   * 含 \n 时按行拆分（换行前的内容结束当前行，其后内容开启新行）。
   * 防无限增长：仅保留最近 2000 行。
   */
  append(text: string): void {
    const parts = text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      if (i === 0) {
        if (this.logs.length === 0) {
          this.logs.push(p)
        } else {
          this.logs[this.logs.length - 1] += p
        }
      } else {
        this.logs.push(p)
      }
    }
    if (this.logs.length > 2000) this.logs = this.logs.slice(-2000)
  }

  /**
   * 处理一个按键；若为 Enter 返回提交的输入行（并清空输入），否则返回 null。
   * Ctrl-C 等退出类按键由 startTuiRepl 层处理，本方法忽略。
   */
  handleKey(ev: KeyEvent): string | null {
    switch (ev.type) {
      case 'char': {
        this.input = this.input.slice(0, this.cursor) + ev.char + this.input.slice(this.cursor)
        this.cursor++
        return null
      }
      case 'enter': {
        const line = this.input
        this.input = ''
        this.cursor = 0
        return line
      }
      case 'backspace': {
        if (this.cursor > 0) {
          this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor)
          this.cursor--
        }
        return null
      }
      case 'delete': {
        if (this.cursor < this.input.length) {
          this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1)
        }
        return null
      }
      case 'left': this.cursor = Math.max(0, this.cursor - 1); return null
      case 'right': this.cursor = Math.min(this.input.length, this.cursor + 1); return null
      case 'home': this.cursor = 0; return null
      case 'end': this.cursor = this.input.length; return null
      default: return null
    }
  }

  /**
   * 渲染整屏：清屏 + 状态栏 + 日志区 + 输入行 + 光标定位。
   * 返回完整 ANSI 重绘序列（纯字符串，测试可直接断言）。
   */
  render(): string {
    const w = this.width
    const h = this.height
    const statusLine = truncate(this.status || 'Harness TUI', w)
    // 日志可见行数：h - 3（状态栏 1 + 空行 1 + 输入行 1）
    const maxLogLines = Math.max(1, h - 3)
    const visibleLogs = this.logs.slice(-maxLogLines)
    const inputDisplay = truncate(PROMPT + this.input, w)
    const inputRow = h
    // 光标列：输入行行首 + prompt 宽度 + cursor（1-based）
    const cursorCol = Math.min(1 + PROMPT.length + this.cursor, w)

    const parts: string[] = []
    parts.push(CLEAR_SCREEN)
    parts.push(statusLine)
    parts.push('\r\n\r\n')
    for (const ln of visibleLogs) {
      parts.push(truncate(ln, w))
      parts.push('\r\n')
    }
    // 跳到输入行行首，清行后写输入，再定位光标
    parts.push(moveTo(inputRow, 1))
    parts.push(CLEAR_LINE)
    parts.push(inputDisplay)
    parts.push(moveTo(inputRow, cursorCol))
    return parts.join('')
  }
}

// ------------------------------------------------------------------------
// 4. TUI REPL
// ------------------------------------------------------------------------

export interface TuiReplOptions {
  app: HarnessApp
  harness: Harness
  session: Session
  stdout?: NodeJS.WritableStream | { write: (s: string) => void }
  stdin?: NodeJS.ReadableStream
  /** 终端尺寸覆盖（测试注入） */
  width?: number
  height?: number
  /** 测试注入：模拟 raw 键盘输入块（原始字节序列）；提供后不读真实 stdin */
  scriptedKeys?: string[]
  onLine?: (line: string) => Promise<void> | void
}

export type TuiReplExit = 'exit' | 'eof' | 'scripted-done'

/**
 * 启动 TUI REPL（alt-screen 全屏交互）。
 *
 * - raw-mode 非阻塞输入循环：KeyDecoder 解码 → TuiScreen 更新 → Enter 提交
 * - 提交的输入行交给 createProcessLine（与 REPL 共用同一会话处理内核），
 *   流式输出写入日志区自动滚动
 * - Ctrl-C / /exit 退出；Coordinator 自动续轮注入 `<continue/>` 触发下一轮
 * - 提供 scriptedKeys 时进入脚本模式（不读真实 stdin），用于测试/流水线
 */
export async function startTuiRepl(options: TuiReplOptions): Promise<TuiReplExit> {
  const out = (s: string) => (options.stdout ?? process.stdout).write(s)
  const screen = new TuiScreen({ width: options.width, height: options.height })
  const decoder = new KeyDecoder()

  // 会话处理内核（与 REPL 共用）
  const processLine = createProcessLine({
    app: options.app,
    harness: options.harness,
    session: options.session,
    out: (s) => { screen.append(s); scheduleRender() },
    onLine: options.onLine,
    setSession: (s) => { options.session = s },
  })

  // 渲染节流：同一宏任务内的多次变更合并为一次重绘
  let renderScheduled = false
  function scheduleRender(): void {
    if (renderScheduled) return
    renderScheduled = true
    queueMicrotask(() => {
      if (!renderScheduled) return
      renderScheduled = false
      out(screen.render())
    })
  }
  /** 同步 flush 待定渲染（退出前调用，保证退出序列写在屏幕重绘之后） */
  function flushRender(): void {
    if (!renderScheduled) return
    renderScheduled = false
    out(screen.render())
  }

  // 退出管理
  let exitSignal = false
  let resolveDone!: (r: TuiReplExit) => void
  const done = new Promise<TuiReplExit>((r) => { resolveDone = r })
  const detachers: Array<() => void> = []
  function finish(reason: TuiReplExit): void {
    if (exitSignal) return
    exitSignal = true
    while (detachers.length > 0) {
      try { detachers.pop()!() } catch { /* 忽略清理错误 */ }
    }
    flushRender()
    out(SHOW_CURSOR + LEAVE_ALT_SCREEN)
    resolveDone(reason)
  }

  // 输入队列：用户 Enter 提交 + 自动续轮注入。
  // 用 promise 链保证串行处理且不丢行——不能用"busy 标志"：async 函数同步
  // 完成时标志会被赋回的 resolved promise 覆盖，导致后续提交的行永不处理。
  const pendingLines: string[] = []
  let queueTail: Promise<void> = Promise.resolve()
  function drainQueue(): Promise<void> {
    queueTail = queueTail.then(async () => {
      if (exitSignal) return
      while (pendingLines.length > 0 && !exitSignal) {
        const line = pendingLines.shift()!
        const r = await processLine(line)
        if (r === 'exit') { finish('exit'); return }
        scheduleRender()
      }
    })
    return queueTail
  }

  function handleKeys(keys: KeyEvent[]): void {
    for (const ev of keys) {
      if (exitSignal) return
      if (ev.type === 'ctrl-c') { finish('exit'); return }
      const line = screen.handleKey(ev)
      if (line !== null && line.trim()) pendingLines.push(line)
      // 任何改变屏幕状态的按键（输入/退格/光标移动）都触发重绘
      scheduleRender()
    }
    if (!exitSignal) void drainQueue()
  }

  // 初始界面
  screen.status = `Harness TUI (session=${options.session.id}, agent=${options.session.agentId ?? 'default'})`
  screen.append('输入问题开始对话；输入 /help 查看特殊命令；Ctrl-C 或 /exit 退出。\n\n')

  // Coordinator 自动续轮：barrier 完成后注入 <continue/> 触发下一轮
  detachers.push(attachAutoContinue(options.harness, (line) => {
    if (exitSignal) return
    pendingLines.push(line)
    void drainQueue()
  }))

  // 脚本模式（测试）：按块喂入按键，逐块等待处理完成
  if (options.scriptedKeys) {
    out(ENTER_ALT_SCREEN + HIDE_CURSOR)
    scheduleRender()
    for (const chunk of options.scriptedKeys) {
      if (exitSignal) break
      handleKeys(decoder.push(chunk))
      await drainQueue()
    }
    if (!exitSignal) finish('scripted-done')
    return done
  }

  // 真实模式：raw-mode 非阻塞输入循环
  // bun 的 ReadableStream.on 重载在严格类型下不兼容，用最小鸭子接口
  const stdin = (options.stdin ?? process.stdin) as unknown as {
    on(event: string, listener: (...args: any[]) => void): unknown
    removeListener(event: string, listener: (...args: any[]) => void): unknown
    setRawMode?: (on: boolean) => unknown
  }
  try {
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true)
  } catch { /* 非 TTY 时忽略 */ }

  const onData = (...args: any[]): void => {
    const chunk = args[0] as Buffer | string
    handleKeys(decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
  }
  const onEnd = (): void => finish('eof')
  stdin.on('data', onData)
  stdin.on('end', onEnd)
  detachers.push(() => {
    stdin.removeListener('data', onData)
    stdin.removeListener('end', onEnd)
    try { if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false) } catch { /* 忽略 */ }
  })

  out(ENTER_ALT_SCREEN + HIDE_CURSOR)
  scheduleRender()
  return done
}
