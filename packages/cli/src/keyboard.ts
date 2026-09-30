/**
 * 终端键盘能力探测（Kitty keyboard protocol）。
 *
 * 背景：OpenTUI 0.5.8 在 `createCliRenderer` 时默认推送 Kitty 键盘协议 flags
 * （disambiguate + alternateKeys，经 native 层写 `CSI = 3;1u`），并在解析侧默认开启
 * CSI-u 序列解析。支持的终端（kitty / ghostty / WezTerm…）能上报 Shift+Enter 等
 * 修饰键组合；不支持的终端忽略未知 CSI 自然降级 legacy（此时修饰键信息丢失）。
 *
 * 本模块只做**探测与文案分级**，不改变协议开关本身——TUI 始终显式开启协议
 * （见 tui.tsx startTuiRepl），这里负责告诉用户"你的终端能不能吃修饰键"。
 *
 * 判据（env 均可注入以便单测）：
 * - Kitty：`KITTY_WINDOW_ID` / `TERM` 含 `xterm-kitty`
 * - Ghostty：`GHOSTTY_RESOURCES_DIR` / `TERM` 含 `ghostty` / `TERM_PROGRAM=ghostty`
 * - WezTerm：`WEZTERM_EXECUTABLE` / `TERM_PROGRAM=WezTerm`
 * - iTerm2：`TERM_PROGRAM=iTerm.app`（支持 CSI-u 但需用户在设置里手动开启 → partial）
 * - 其余（Terminal.app / tmux 直连 / vscode 终端等）→ legacy
 */

export type KeyboardProtocolLevel = 'full' | 'partial' | 'legacy'

export interface KeyboardProtocolSupport {
  /** full：修饰键开箱即用；partial：需用户开启设置；legacy：不上报修饰键 */
  level: KeyboardProtocolLevel
  /** 终端名（帮助面板展示用） */
  label: string
  /** partial 级时告诉用户去哪里开 */
  hint?: string
}

const ITERM_CSI_U_HINT =
  '需开启 Settings → Profiles → Keys → General → "Report modifiers using CSI u"'

/** 探测当前终端的键盘协议支持等级（纯函数，env 可注入） */
export function detectKeyboardProtocol(
  env: Record<string, string | undefined> = process.env,
): KeyboardProtocolSupport {
  const term = env.TERM ?? ''
  const termProgram = env.TERM_PROGRAM ?? ''

  if (env.KITTY_WINDOW_ID !== undefined || term.includes('xterm-kitty')) {
    return { level: 'full', label: 'Kitty' }
  }
  if (env.GHOSTTY_RESOURCES_DIR !== undefined || term.includes('ghostty') || termProgram === 'ghostty') {
    return { level: 'full', label: 'Ghostty' }
  }
  if (env.WEZTERM_EXECUTABLE !== undefined || termProgram === 'WezTerm') {
    return { level: 'full', label: 'WezTerm' }
  }
  if (termProgram === 'iTerm.app') {
    return { level: 'partial', label: 'iTerm2', hint: ITERM_CSI_U_HINT }
  }
  return { level: 'legacy', label: termProgram || term || 'unknown terminal' }
}

/**
 * 帮助面板「Shift+Enter」行的文案，按探测等级分级。
 *
 * 为什么不写成常量：帮助文案是用户判断"这个键能不能用"的唯一入口，
 * 固定写死"需终端上报 Shift"在支持的终端上是噪音、在不支持的终端上不够直白
 * （用户不知道该用 `\` + Enter 兜底）。分级后才各说各话。
 */
export function shiftEnterHelpLine(support: KeyboardProtocolSupport): string {
  if (support.level === 'full') {
    return `输入框内换行（${support.label} 已启用 Kitty 键盘协议，修饰键可用）`
  }
  if (support.level === 'partial') {
    return `输入框内换行（${support.label}：${support.hint}）`
  }
  return '输入框内换行（当前终端不上报修饰键；请用行尾反斜杠 \\ + Enter 兜底）'
}
