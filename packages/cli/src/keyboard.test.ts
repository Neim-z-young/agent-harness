import { describe, expect, it } from 'bun:test'
import { detectKeyboardProtocol, shiftEnterHelpLine } from './keyboard'

/**
 * 键盘协议能力探测（Kitty keyboard protocol）。
 *
 * 判据全部来自 env，逐个终端环境验证；文案分级函数与探测等级耦合，
 * 改 level 语义时这里会先红。
 */
describe('detectKeyboardProtocol', () => {
  it('Kitty：KITTY_WINDOW_ID 或 TERM=xterm-kitty → full', () => {
    expect(detectKeyboardProtocol({ KITTY_WINDOW_ID: '1' }).level).toBe('full')
    expect(detectKeyboardProtocol({ KITTY_WINDOW_ID: '1' }).label).toBe('Kitty')
    expect(detectKeyboardProtocol({ TERM: 'xterm-kitty' }).level).toBe('full')
  })

  it('Ghostty：三种判据任一命中 → full', () => {
    expect(detectKeyboardProtocol({ GHOSTTY_RESOURCES_DIR: '/x' }).level).toBe('full')
    expect(detectKeyboardProtocol({ TERM: 'xterm-ghostty' }).label).toBe('Ghostty')
    expect(detectKeyboardProtocol({ TERM_PROGRAM: 'ghostty' }).level).toBe('full')
  })

  it('WezTerm：env 或 TERM_PROGRAM → full', () => {
    expect(detectKeyboardProtocol({ WEZTERM_EXECUTABLE: '/x/wezterm' }).level).toBe('full')
    expect(detectKeyboardProtocol({ TERM_PROGRAM: 'WezTerm' }).label).toBe('WezTerm')
  })

  it('iTerm2：partial，带开启指引', () => {
    const s = detectKeyboardProtocol({ TERM_PROGRAM: 'iTerm.app' })
    expect(s.level).toBe('partial')
    expect(s.label).toBe('iTerm2')
    expect(s.hint).toInclude('CSI u')
  })

  it('其余终端 → legacy（Terminal.app / tmux / vscode）', () => {
    expect(detectKeyboardProtocol({ TERM_PROGRAM: 'Apple_Terminal' }).level).toBe('legacy')
    expect(detectKeyboardProtocol({ TERM_PROGRAM: 'tmux', TERM: 'screen-256color' }).level).toBe('legacy')
    expect(detectKeyboardProtocol({ TERM_PROGRAM: 'vscode' }).level).toBe('legacy')
  })

  it('空 env → legacy', () => {
    expect(detectKeyboardProtocol({}).level).toBe('legacy')
  })
})

describe('shiftEnterHelpLine：文案按等级分级', () => {
  it('full：报终端名，说修饰键可用', () => {
    const line = shiftEnterHelpLine({ level: 'full', label: 'Kitty' })
    expect(line).toInclude('Kitty')
    expect(line).toInclude('Kitty 键盘协议')
  })

  it('partial：给出开启指引', () => {
    const line = shiftEnterHelpLine({
      level: 'partial',
      label: 'iTerm2',
      hint: '需开启 CSI u',
    })
    expect(line).toInclude('iTerm2')
    expect(line).toInclude('CSI u')
  })

  it('legacy：指路 \\ + Enter 兜底', () => {
    const line = shiftEnterHelpLine({ level: 'legacy', label: 'Apple_Terminal' })
    expect(line).toInclude('\\ + Enter')
  })
})
