/**
 * @harness/cli - TUI 模式测试（KeyDecoder / TuiScreen / startTuiRepl）
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessApp, parseCliArgs } from './index'
import { KeyDecoder, TuiScreen, startTuiRepl } from './tui'

// ------------------------------------------------------------------------
// KeyDecoder：raw-mode 键盘字节流解码
// ------------------------------------------------------------------------

describe('KeyDecoder 键盘解码', () => {
  it('单字节可打印字符 → char', () => {
    const d = new KeyDecoder()
    expect(d.push('a')).toEqual([{ type: 'char', char: 'a' }])
    expect(d.push('hi')).toEqual([{ type: 'char', char: 'h' }, { type: 'char', char: 'i' }])
  })

  it('CR / LF → enter', () => {
    const d = new KeyDecoder()
    expect(d.push('\r')).toEqual([{ type: 'enter' }])
    expect(d.push('\n')).toEqual([{ type: 'enter' }])
  })

  it('DEL / BS → backspace', () => {
    const d = new KeyDecoder()
    expect(d.push('\x7f')).toEqual([{ type: 'backspace' }])
    expect(d.push('\x08')).toEqual([{ type: 'backspace' }])
  })

  it('Ctrl-C → ctrl-c；Tab → tab', () => {
    const d = new KeyDecoder()
    expect(d.push('\x03')).toEqual([{ type: 'ctrl-c' }])
    expect(d.push('\x09')).toEqual([{ type: 'tab' }])
  })

  it('箭头序列 → up/down/right/left', () => {
    const d = new KeyDecoder()
    expect(d.push('\x1b[A')).toEqual([{ type: 'up' }])
    expect(d.push('\x1b[B')).toEqual([{ type: 'down' }])
    expect(d.push('\x1b[C')).toEqual([{ type: 'right' }])
    expect(d.push('\x1b[D')).toEqual([{ type: 'left' }])
  })

  it('Home / End / Delete 序列', () => {
    const d = new KeyDecoder()
    expect(d.push('\x1b[H')).toEqual([{ type: 'home' }])
    expect(d.push('\x1b[F')).toEqual([{ type: 'end' }])
    expect(d.push('\x1b[3~')).toEqual([{ type: 'delete' }])
  })

  it('跨块转义序列：ESC 与剩余字节分开到达', () => {
    const d = new KeyDecoder()
    expect(d.push('\x1b')).toEqual([]) // 等待更多
    expect(d.pending).toBe('\x1b')
    expect(d.push('[A')).toEqual([{ type: 'up' }])
    expect(d.pending).toBe('')
  })

  it('独立 ESC 后跟普通字符 → escape + char', () => {
    const d = new KeyDecoder()
    expect(d.push('\x1b')).toEqual([])
    expect(d.push('x')).toEqual([{ type: 'escape' }, { type: 'char', char: 'x' }])
  })

  it('未知 CSI 序列整体消费为 unknown（含参数）', () => {
    const d = new KeyDecoder()
    expect(d.push('\x1b[20~')).toEqual([{ type: 'unknown', seq: '\x1b[20~' }])
    expect(d.pending).toBe('')
  })

  it('混合输入：文本 + Enter + 箭头', () => {
    const d = new KeyDecoder()
    expect(d.push('hi\r\x1b[A')).toEqual([
      { type: 'char', char: 'h' },
      { type: 'char', char: 'i' },
      { type: 'enter' },
      { type: 'up' },
    ])
  })
})

// ------------------------------------------------------------------------
// TuiScreen：全屏渲染层
// ------------------------------------------------------------------------

describe('TuiScreen 渲染', () => {
  const W = 40
  const H = 10

  it('构造：可注入尺寸；append 按 \n 拆行', () => {
    const s = new TuiScreen({ width: W, height: H })
    expect(s.width).toBe(W)
    expect(s.height).toBe(H)
    s.append('a\nb\nc')
    expect(s.logs).toEqual(['a', 'b', 'c'])
  })

  it('handleKey：char 插入光标处、backspace 删光标前', () => {
    const s = new TuiScreen({ width: W, height: H })
    s.handleKey({ type: 'char', char: 'h' })
    s.handleKey({ type: 'char', char: 'i' })
    expect(s.input).toBe('hi')
    expect(s.cursor).toBe(2)
    // 左移再插入 → 'hxi'
    s.handleKey({ type: 'left' })
    s.handleKey({ type: 'char', char: 'x' })
    expect(s.input).toBe('hxi')
    // backspace 删光标前 → 'hi'（'hxi' 光标在 'x' 与 'i' 之间，删 'x' 后 cursor=1）
    s.handleKey({ type: 'backspace' })
    expect(s.input).toBe('hi')
    expect(s.cursor).toBe(1)
  })

  it('handleKey：home/end 移动光标，enter 提交并清空输入', () => {
    const s = new TuiScreen({ width: W, height: H })
    s.handleKey({ type: 'char', char: 'a' })
    s.handleKey({ type: 'char', char: 'b' })
    s.handleKey({ type: 'home' })
    expect(s.cursor).toBe(0)
    s.handleKey({ type: 'end' })
    expect(s.cursor).toBe(2)
    const line = s.handleKey({ type: 'enter' })
    expect(line).toBe('ab')
    expect(s.input).toBe('')
    expect(s.cursor).toBe(0)
  })

  it('render：状态栏 + 日志自动滚动（仅最近 h-3 行）+ 输入行 + 光标定位', () => {
    const s = new TuiScreen({ width: W, height: H })
    s.status = 'STATUS'
    s.append('l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8')
    s.input = 'ab'
    s.cursor = 2
    const out = s.render()
    // 清屏 + 状态栏 + 空行分隔
    expect(out).toStartWith('\x1b[2J\x1b[HSTATUS\r\n\r\n')
    // 可见日志 = 最后 7 行（h-3=7）：l2..l8
    expect(out).toContain('l2\r\n')
    expect(out).toContain('l8\r\n')
    expect(out).not.toContain('l1\r\n')
    // 输入行 + 光标定位（PROMPT '❯ ' 长度 2 + cursor 2 → 列 1+2+2=5）
    expect(out).toContain('\x1b[10;1H\x1b[K❯ ab')
    expect(out).toContain('\x1b[10;5H')
  })

  it('render：超宽行截断，输入行溢出时光标列封顶', () => {
    const s = new TuiScreen({ width: 8, height: 5 })
    s.append('abcdefghijklmnop')
    s.input = '1234567890'
    s.cursor = 10
    const out = s.render()
    // 日志行截断为 7 字符 + …
    expect(out).toContain('abcdefg…')
    // 输入行 '❯ 1234567890' 截断为 '❯ 12345…'；光标列封顶到宽度 8
    expect(out).toContain('\x1b[5;8H')
  })
})

// ------------------------------------------------------------------------
// startTuiRepl 集成（脚本模式，mock provider）
// ------------------------------------------------------------------------

describe('startTuiRepl 集成（mock provider）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-tui-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function makeApp(stdout: { write: (s: string) => void }, extra: { responses?: Array<{ match: RegExp; response: string }> } = {}) {
    return new HarnessApp({
      cwd: dir, dataDir: join(dir, '.harness'), agentId: 'default', provider: 'mock',
      permissionMode: 'allow-all', stdout,
      mockProviderConfig: {
        defaultResponse: '你好，我是 TUI 助手。',
        responses: extra.responses ?? [],
      },
    })
  }

  it('脚本模式：输入回车提交 → mock 回复流式渲染进日志区', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = makeApp(stdout)
    const { harness, session } = await app.boot()
    const r = await startTuiRepl({
      app, harness, session, stdout,
      width: 40, height: 10,
      scriptedKeys: ['hello\r'],
    })
    expect(r).toBe('scripted-done')
    const out = chunks.join('')
    // 进入 alt-screen + 隐藏光标
    expect(out).toContain('\x1b[?1049h')
    // 状态栏
    expect(out).toContain('Harness TUI')
    // 用户输入回显（processLine 输出 🧑）
    expect(out).toContain('hello')
    // mock 回复流式渲染（🤖 前缀 + 文本）
    expect(out).toContain('🤖')
    expect(out).toContain('你好，我是 TUI 助手。')
    // 退出时恢复光标 + 离开 alt-screen
    expect(out).toEndWith('\x1b[?25h\x1b[?1049l')
    await app.shutdown()
  })

  it('Ctrl-C → exit', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = makeApp(stdout)
    const { harness, session } = await app.boot()
    const r = await startTuiRepl({
      app, harness, session, stdout,
      width: 40, height: 10,
      scriptedKeys: ['abc', '\x03'],
    })
    expect(r).toBe('exit')
    await app.shutdown()
  })

  it('/exit 命令 → exit（与 REPL 共用 createProcessLine）', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = makeApp(stdout)
    const { harness, session } = await app.boot()
    const r = await startTuiRepl({
      app, harness, session, stdout,
      width: 40, height: 10,
      scriptedKeys: ['/exit\r'],
    })
    expect(r).toBe('exit')
    // 退出序列（恢复光标 + 离开 alt-screen）在输出末尾
    expect(chunks.join('')).toEndWith('\x1b[?25h\x1b[?1049l')
    await app.shutdown()
  })

  it('左移补字 + End 到末尾继续输入后再提交', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = makeApp(stdout, {
      responses: [{ match: /hello world/, response: '收到' }],
    })
    const { harness, session } = await app.boot()
    // 'helo' → 左移 → 插入 'l' → 'hello' → End 移到末尾 → 空格 + world → Enter
    const r = await startTuiRepl({
      app, harness, session, stdout,
      width: 40, height: 10,
      scriptedKeys: ['helo\x1b[Dl\x1b[F world\r'],
    })
    expect(r).toBe('scripted-done')
    const out = chunks.join('')
    expect(out).toContain('hello world')
    expect(out).toContain('收到')
    await app.shutdown()
  })

  it('输入与回车分块到达（真实模式时序）也能提交处理', async () => {
    const chunks: string[] = []
    const stdout = { write: (s: string) => { chunks.push(s) } }
    const app = makeApp(stdout)
    const { harness, session } = await app.boot()
    // 复现真实终端：字符块与回车块是两次独立 data 事件。
    // 修复前 drainQueue 的 busy 标志在字符块同步完成后仍非空，回车块提交的行永不处理。
    const r = await startTuiRepl({
      app, harness, session, stdout,
      width: 40, height: 10,
      scriptedKeys: ['hi', '\r'],
    })
    expect(r).toBe('scripted-done')
    const out = chunks.join('')
    expect(out).toContain('🧑  hi')
    expect(out).toContain('你好，我是 TUI 助手。')
    await app.shutdown()
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
