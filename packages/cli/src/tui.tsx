/**
 * @harness/cli - TUI 模式（OpenTUI 渲染层）
 *
 * 基于 @opentui/core + @opentui/react（Bun 原生，Zig 渲染核心）实现全屏 TUI：
 * - TuiApp：React 组件树（状态栏 + 日志区 scrollbox 自动滚动 + 底部 input）
 * - startTuiRepl：真实终端入口（createCliRenderer + createRoot）
 * - 会话内核复用 createProcessLine（与 REPL 同一套流式渲染 / /命令 / 插件 hook）
 * - 测试用 @opentui/core/testing 的 createTestRenderer + mockInput 模拟按键
 *
 * 相比自研 ANSI 渲染：布局/焦点/滚动/键盘解码全部交给 OpenTUI（Yoga flexbox + Zig
 * 渲染核心），并直接获得 <code>/<markdown> 语法高亮组件等后续扩展能力。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createCliRenderer, createTextAttributes, type CliRenderer } from '@opentui/core'
import { createRoot, useKeyboard } from '@opentui/react'
import { createProcessLine } from './index'
import type { HarnessApp } from './index'
import type { Harness } from '@harness/core'
import type { Session } from '@harness/session'

// ------------------------------------------------------------------------
// 类型
// ------------------------------------------------------------------------

export interface TuiReplOptions {
  app: HarnessApp
  harness: Harness
  session: Session
  /** 收到普通用户输入时回调（REPL 回显前触发） */
  onLine?: (line: string) => Promise<void> | void
}

export type TuiReplExit = 'exit'

/** 日志区最多保留行数 */
const MAX_LOG_LINES = 500

// ------------------------------------------------------------------------
// 日志追加（流式 token 连续拼接当前行；纯函数，可单测）
// ------------------------------------------------------------------------

export function appendLog(logs: string[], text: string, maxLines = MAX_LOG_LINES): string[] {
  const parts = text.split('\n')
  const next = logs.slice()
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (i === 0) {
      if (next.length === 0) next.push(p)
      else next[next.length - 1] += p
    } else {
      next.push(p)
    }
  }
  return next.length > maxLines ? next.slice(-maxLines) : next
}

// ------------------------------------------------------------------------
// TuiApp：OpenTUI React 组件树
// ------------------------------------------------------------------------

export function TuiApp({ options, onExit }: { options: TuiReplOptions; onExit: (r: TuiReplExit) => void }) {
  // 初始状态直接在 useState 初始化：若用 mount effect 设置欢迎语，会覆盖
  // 已在 effect 之前开始处理的用户回复（processLine 于渲染期同步初始化，submit 可先于 effect）。
  const [logs, setLogs] = useState<string[]>(['输入问题开始对话；输入 /help 查看特殊命令；Ctrl-C 或 /exit 退出。', ''])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState(
    `Harness TUI (session=${options.session.id}, agent=${options.session.agentId ?? 'default'})`,
  )

  // 会话处理内核（与 REPL 共用）：流式渲染、/ 命令、插件 hook。
  // 渲染期同步初始化（createProcessLine 是纯工厂），避免 submit 先于 effect 执行时 ref 为 null。
  const processLineRef = useRef<((raw: string) => Promise<'continue' | 'exit'>) | null>(null)
  const exitRef = useRef(false)
  if (processLineRef.current === null) {
    processLineRef.current = createProcessLine({
      app: options.app,
      harness: options.harness,
      session: options.session,
      out: (s) => setLogs((prev) => appendLog(prev, s)),
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

  // 提交输入行
  const submit = useCallback((value: string) => {
    if (exitRef.current) return
    setInput('')
    if (value.trim()) {
      pendingLines.current.push(value)
      void drain()
    }
  }, [drain])

  // 全局快捷键：Ctrl-C 退出
  useKeyboard((key) => {
    if (key.name === 'c' && key.ctrl) finish('exit')
  })

  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <box style={{ border: true }}>
        <text attributes={createTextAttributes({ bold: true })}>{status}</text>
      </box>
      {/* ScrollBox 原生粘底滚动：日志追加时自动滚到底部（避免手动 scrollTop 竞态） */}
      <scrollbox stickyScroll stickyStart="bottom" style={{ flexGrow: 1, border: true, padding: 1 }}>
        {logs.map((l, i) => (
          <text key={i} wrapMode="word">{l === '' ? '\u00A0' : l}</text>
        ))}
      </scrollbox>
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
 * - TuiApp 组件树渲染：状态栏 + 日志区 + 底部输入行
 * - 输入提交 → createProcessLine（与 REPL 共用会话内核）→ 流式输出回流日志区
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
