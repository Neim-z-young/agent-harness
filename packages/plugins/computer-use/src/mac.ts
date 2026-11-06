/**
 * computer-use macOS 自动化后端
 *
 * 通过 /usr/bin/osascript（AppleScript System Events）实现真实电脑控制，
 * 配合 /usr/sbin/screencapture 截图。所有外部命令都通过可注入的 ExecFn / ExecBinFn 执行，
 * 便于在单测中注入 mock（不真的操作电脑）。
 *
 * 拼脚本与校验的纯逻辑都在 ./applescript.ts（唯一口径），本文件只负责"拼装 + 调用执行器"。
 *
 * 权限：需要「辅助功能」(Accessibility) 授权；屏幕截图需要「屏幕录制」(Screen Recording) 授权。
 * 相应工具在被系统拒绝时抛出携带可读信息的错误，由上层转为工具 error 结果。
 */

import { execFile } from 'node:child_process'
import {
  assertFiniteInt,
  elementRefClause,
  escapeAppleScriptText,
  modifierClause,
  parseAppList,
  parseBoolResult,
  parseElementRef,
  quoteAppleScriptString,
  resolveScrollDirection,
  scrollKeyCode,
  keyCodeFor,
} from './applescript'

// ===== 可注入执行器 =====

/** 文本命令执行器（osascript 等） */
export type ExecFn = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

/** 二进制命令执行器（screencapture 输出 PNG） */
export type ExecBinFn = (args: string[]) => Promise<{ code: number; stdout: Buffer; stderr: string }>

/** 默认 osascript 执行器 */
export function makeOsascriptExec(): ExecFn {
  return (args) =>
    new Promise((resolve) => {
      execFile('/usr/bin/osascript', args, (err, stdout, stderr) => {
        resolve({
          code: err ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      })
    })
}

/** 默认 screencapture 执行器（输出 PNG 二进制） */
export function makeScreencaptureExec(): ExecBinFn {
  return (args) =>
    new Promise((resolve) => {
      execFile('/usr/sbin/screencapture', args, { encoding: (null as unknown) as BufferEncoding }, (err, stdout, stderr) => {
        resolve({ code: err ? 1 : 0, stdout: stdout as unknown as Buffer, stderr: String(stderr ?? '') })
      })
    })
}

// ===== 工具输入/输出类型（对齐参考文档 schema）=====

export interface PermissionsResult {
  accessibility: boolean
  screenRecording: boolean | null
  /** 辅助功能查询失败的原因（成功 / 未失败时为 undefined）—— 失败不再静默成 false */
  accessibilityError?: string
}

export interface AppInfo {
  name: string
  pid?: number
  bundleId?: string
  running: boolean
  lastUsed?: number
  windowId?: number
}

export interface AppStateResult {
  /** UI 树（可空，截图失败或不需要时省略） */
  uiTree: string
  /** 截图 data URI（image-uri），可为空 */
  screenshot?: string
}

// ===== AppleScript 片段 =====

/** 校验辅助功能权限 */
function permissionScript(): string {
  return `tell application "System Events" to get UI elements enabled`
}

/** 列出前台运行（非后台）的应用 */
function listAppsScript(): string {
  // 返回由 `开头的行拼接：name<TAB>pid
  return [
    `set out to ""`,
    `tell application "System Events"`,
    `  set prcs to every process whose background only is false`,
    `  repeat with p in prcs`,
    `    set out to out & (name of p) & tab & (unix id of p) & linefeed`,
    `  end repeat`,
    `end tell`,
    `return out`,
  ].join('\n')
}

/** 递归 walking UI 树脚本（内嵌 handler，depth 上限 + 元素计数上限，输出带缩进的 ui_tree 行） */
function uiTreeScript(processName: string, depthLimit: number, elementLimit: number): string {
  return [
    `use scripting additions`,
    `set theProc to "${escapeAppleScriptText(processName)}"`,
    `set depthLimit to ${depthLimit}`,
    `set elemCap to ${elementLimit}`,
    `set out to ""`,
    `set cnt to 0`,
    `on fmt(e)`,
    `  try`,
    `    set r to role of e`,
    `  on error`,
    `    set r to "element"`,
    `  end try`,
    `  try`,
    `    set lab to (name of e as text)`,
    `  on error`,
    `    set lab to ""`,
    `  end try`,
    `  if lab is "" then`,
    `    try`,
    `      set lab to (description of e as text)`,
    `    on error`,
    `      set lab to ""`,
    `    end try`,
    `  end if`,
    `  try`,
    `    set vl to (value of e as text)`,
    `  on error`,
    `    set vl to ""`,
    `  end try`,
    `  try`,
    `    set fx to (position of e as text)`,
    `  on error`,
    `    set fx to ""`,
    `  end try`,
    `  try`,
    `    set sz to (size of e as text)`,
    `  on error`,
    `    set sz to ""`,
    `  end try`,
    `  return r & " \\"" & lab & "\\" val=" & vl & " pos=" & fx & " size=" & sz`,
    `end fmt`,
    `on walk(e, d)`,
    `  if cnt ≥ elemCap then return`,
    `  set cnt to cnt + 1`,
    `  set pad to ""`,
    `  repeat d times`,
    `    set pad to pad & "  "`,
    `  end repeat`,
    `  try`,
    `    set out to out & pad & (my fmt(e)) & " id=" & (cnt - 1) & linefeed`,
    `  end try`,
    `  if d < depthLimit then`,
    `    try`,
    `      set kids to UI elements of e`,
    `      repeat with k in kids`,
    `        my walk(k, d + 1)`,
    `      end repeat`,
    `    end try`,
    `  end if`,
    `end walk`,
    `script bijoux`,
    `  on run`,
    `    tell application "System Events"`,
    `      tell process theProc`,
    `        try`,
    `          set win to front window`,
    `          my walk(win, 0)`,
    `          return out`,
    `        on error errMsg`,
    `          return "ERROR " & errMsg`,
    `        end try`,
    `      end tell`,
    `    end tell`,
    `  end run`,
    `end script`,
    `run bijoux`,
  ].join('\n')
}

// ===== 后端 =====

export interface ComputerUseBackendOptions {
  /** 文本命令执行器（缺省 osascript） */
  exec?: ExecFn
  /** 二进制命令执行器（缺省 screencapture） */
  execBin?: ExecBinFn
  /** 是否允许截图（缺省 true；测试置 false 避免触碰真实截屏） */
  allowScreenshot?: boolean
}

/** 统一的后端错误：带操作名，便于从日志定位是哪一步失败 */
export class ComputerUseError extends Error {
  readonly op: string
  constructor(op: string, message: string) {
    super(`computer-use ${op} 失败：${message}`)
    this.name = 'ComputerUseError'
    this.op = op
  }
}

/** 目标应用名校验（所有面向具体 app 的操作都需要） */
function requireApp(app: unknown): string {
  if (typeof app !== 'string' || app.trim() === '') {
    throw new ComputerUseError('app', '缺少目标应用名（app）')
  }
  return app
}

/**
 * 电脑控制后端：每种工具一个方法，返回结构化结果或抛错。
 */
export class ComputerUseBackend {
  private readonly exec: ExecFn
  private readonly execBin?: ExecBinFn
  private readonly allowScreenshot: boolean

  constructor(options: ComputerUseBackendOptions = {}) {
    this.exec = options.exec ?? makeOsascriptExec()
    this.execBin = options.execBin ?? (options.allowScreenshot === false ? undefined : makeScreencaptureExec())
    this.allowScreenshot = options.allowScreenshot !== false
  }

  /** 执行一段脚本；失败时错误带操作名（ops：哪个工具/哪一步） */
  private async run(script: string, op: string): Promise<string> {
    const r = await this.exec(['-e', script])
    if (r.code !== 0) throw new ComputerUseError(op, r.stderr || r.stdout || '未知错误')
    return r.stdout.trimEnd()
  }

  /** check_permissions：辅助功能 + 屏幕录制 */
  async checkPermissions(): Promise<PermissionsResult> {
    let accessibility = false
    let accessibilityError: string | undefined
    try {
      accessibility = parseBoolResult(await this.run(permissionScript(), 'check_permissions'))
    } catch (err) {
      accessibility = false
      accessibilityError = (err as Error)?.message ?? String(err)
    }
    return {
      accessibility,
      // 屏幕录制状态难以稳定探测：接入截图命令作为启发式（失败/被拒则为 false）
      screenRecording: null,
      accessibilityError,
    }
  }

  /** list_apps：列出运行中的应用（name + pid + 可选 windowId） */
  async listApps(opts: { includeWindowIds?: boolean; windowLimit?: number } = {}): Promise<{ apps: AppInfo[] }> {
    const raw = await this.run(listAppsScript(), 'list_apps')
    let apps: AppInfo[] = parseAppList(raw).map((e) => ({ name: e.name, pid: e.pid, running: true }))
    const limit = opts.windowLimit
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
      apps = apps.slice(0, Math.floor(limit))
    }
    if (opts.includeWindowIds) {
      for (const a of apps) a.windowId = await this.frontWindowId(a.name)
    }
    return { apps }
  }

  /** 取某进程前窗口 id（用于 get_app_state / screenshot / 坐标归零） */
  async frontWindowId(processName: string): Promise<number | undefined> {
    const script = [
      `tell application "System Events"`,
      `  tell process "${escapeAppleScriptText(processName)}"`,
      `    try`,
      `      set w to front window`,
      `      return (id of w) as text`,
      `    on error`,
      `      return ""`,
      `    end try`,
      `  end tell`,
      `end tell`,
    ].join('\n')
    const raw = await this.run(script, 'front_window_id')
    const n = parsePidOrUndefined(raw)
    return n
  }

  /** get_app_state：UI 树 + 可选截图 */
  async getAppState(opts: { app: string; windowId?: number; disableDiff?: boolean }): Promise<AppStateResult> {
    const app = requireApp(opts.app)
    const uiTree = await this.run(uiTreeScript(app, 4, 200), 'get_app_state')
    let screenshot: string | undefined
    if (this.allowScreenshot && this.execBin) {
      try {
        const wid = opts.windowId ?? (await this.frontWindowId(app))
        const args = ['-l', String(wid ?? app), '-t', 'png', '-o', '-']
        const r = await this.execBin(args)
        if (r.code === 0 && r.stdout.length > 0) {
          screenshot = `data:image/png;base64,${r.stdout.toString('base64')}`
        }
      } catch { screenshot = undefined }
    }
    return { uiTree, screenshot }
  }

  /** click：按坐标或 element_id */
  async click(opts: { app: string; windowId?: number; x?: number; y?: number; element_id?: string; button?: string; clickCount?: number }): Promise<{ ok: true }> {
    const app = requireApp(opts.app)
    const button = (opts.button ?? 'left').toString().trim().toLowerCase()
    // 契约一致：schema 声称支持 right/middle，实现做不到就明确报错，而不是默默按左键点
    if (button !== 'left') {
      throw new ComputerUseError('click', `暂不支持 button=${button}（当前仅支持 left）`)
    }
    const clickCount = opts.clickCount == null ? 1 : assertFiniteInt(opts.clickCount, 'clickCount', { min: 1, max: 3 })

    if (opts.element_id != null) {
      const ref = parseElementRef(opts.element_id)
      const which = elementRefClause(ref)
      for (let i = 0; i < clickCount; i++) {
        await this.run(this.inProc(app, `click ${which} of front window`), 'click')
      }
    } else if (opts.x != null && opts.y != null) {
      const x = assertFiniteInt(opts.x, 'x 坐标')
      const y = assertFiniteInt(opts.y, 'y 坐标')
      for (let i = 0; i < clickCount; i++) {
        await this.run(this.inProc(app, `click at {${x}, ${y}}`), 'click')
      }
    } else {
      throw new ComputerUseError('click', '需要 element_id 或 (x, y) 坐标')
    }
    return { ok: true }
  }

  /** scroll：按方向/页 或 deltaY/deltaX */
  async scroll(opts: { app: string; element_id?: string; deltaY?: number; deltaX?: number; direction?: string; pages?: number }): Promise<{ ok: true }> {
    const app = requireApp(opts.app)
    const dir = resolveScrollDirection({ direction: opts.direction, deltaY: opts.deltaY, deltaX: opts.deltaX })
    const pages = opts.pages == null ? 1 : assertFiniteInt(opts.pages, '滚动页数', { min: 1, max: 50 })
    const axis = dir === 'left' || dir === 'right' ? 'shift' : 'control'
    await this.run(this.inProc(app, `set frontmost to true`), 'scroll')
    await this.run(
      `tell application "System Events" to repeat ${pages} times\n  key code ${scrollKeyCode(dir)} using {${axis} down}\nend repeat`,
      'scroll',
    )
    return { ok: true }
  }

  /**
   * drag：从起点拖到终点。
   *
   * 已知限制：System Events 没有 mouse down/up，真正的拖拽需要 cliclick / CGEvent（未做）。
   * 这里保持"按下起点 → 移动终点"的近似实现，但先校验再执行 —— 旧实现会先跑两段脚本、
   * 最后才抛"缺少坐标"，等于在报错前已经动过用户的界面。
   */
  async drag(opts: { app: string; fromX?: number; fromY?: number; toX?: number; toY?: number }): Promise<{ ok: true }> {
    const app = requireApp(opts.app)
    if (opts.fromX == null || opts.fromY == null || opts.toX == null || opts.toY == null) {
      throw new ComputerUseError('drag', '需要 fromX/fromY/toX/toY 四个坐标')
    }
    const fromX = assertFiniteInt(opts.fromX, 'fromX')
    const fromY = assertFiniteInt(opts.fromY, 'fromY')
    const toX = assertFiniteInt(opts.toX, 'toX')
    const toY = assertFiniteInt(opts.toY, 'toY')
    await this.run(this.inProc(app, `set frontmost to true`), 'drag')
    await this.run(
      `tell application "System Events"\n  click at {${fromX}, ${fromY}}\n  click at {${toX}, ${toY}}\nend tell`,
      'drag',
    )
    return { ok: true }
  }

  /** type_text：向目标输入框输入文本 */
  async typeText(opts: { app: string; text: string; slowly?: boolean }): Promise<{ ok: true }> {
    if (typeof opts.text !== 'string') {
      throw new ComputerUseError('type_text', '缺少 text（要输入的文本）')
    }
    // 光标锁定由调用方先 click 目标字段；这里直接 keystroke（保持系统级）
    await this.run(`tell application "System Events" to keystroke ${quoteAppleScriptString(opts.text)}`, 'type_text')
    return { ok: true }
  }

  /** press_key：按键 / 组合键 */
  async pressKey(opts: { app: string; key: string; modifiers?: string[] }): Promise<{ ok: true }> {
    const usage = modifierClause(opts.modifiers ?? [])
    if (typeof opts.key !== 'string' || opts.key.trim() === '') {
      throw new ComputerUseError('press_key', '缺少 key（按键名）')
    }
    const code = keyCodeFor(opts.key)
    const script = code != null
      ? `tell application "System Events" to key code ${code}${usage}`
      : `tell application "System Events" to keystroke ${quoteAppleScriptString(opts.key)}${usage}`
    await this.run(script, 'press_key')
    return { ok: true }
  }

  /** perform_action：AXPress = click 的辅助动作 */
  async performAction(opts: { app: string; element_id?: string; action: string }): Promise<{ ok: true }> {
    if (typeof opts.action !== 'string' || opts.action.trim() === '') {
      throw new ComputerUseError('perform_action', '缺少 action')
    }
    if (opts.element_id == null) {
      // 无明确元素：尝试 action 对应的键（Show Menu → 上下文菜单）
      await this.run(`tell application "System Events" to key code 49 using {control down}`, 'perform_action')
      return { ok: true }
    }
    const app = requireApp(opts.app)
    const ref = parseElementRef(opts.element_id)
    await this.run(
      this.inProc(app, `perform action ${quoteAppleScriptString(opts.action)} of ${elementRefClause(ref)} of front window`),
      'perform_action',
    )
    return { ok: true }
  }

  /** set_value：设置可写元素的值（Electron 等可能拒写） */
  async setValue(opts: { app: string; element_id?: string; value: string }): Promise<{ ok: true }> {
    if (opts.element_id == null) throw new ComputerUseError('set_value', '需要 element_id')
    if (typeof opts.value !== 'string') throw new ComputerUseError('set_value', '缺少 value')
    const app = requireApp(opts.app)
    const ref = parseElementRef(opts.element_id)
    await this.run(
      this.inProc(app, `set value of ${elementRefClause(ref)} of front window to ${quoteAppleScriptString(opts.value)}`),
      'set_value',
    )
    return { ok: true }
  }

  /** select_text：在元素内选中文本（按前缀/后缀判定难，提供坐标型近似） */
  async selectText(opts: { app: string; element_id: string; text: string; selection?: string }): Promise<{ ok: true }> {
    if (opts.element_id == null) throw new ComputerUseError('select_text', '需要 element_id')
    if (typeof opts.text !== 'string') throw new ComputerUseError('select_text', '需要 text')
    const app = requireApp(opts.app)
    const ref = parseElementRef(opts.element_id)
    await this.run(this.inProc(app, `select ${elementRefClause(ref)} of front window`), 'select_text')
    return { ok: true }
  }

  /** 构造 tell process APP 包裹的 AppleScript */
  private inProc(app: string, actions: string): string {
    return `tell application "System Events"
  tell process "${escapeAppleScriptText(app)}"
    ${actions}
  end tell
end tell`
  }
}

/** 窗口 id 文本 → number | undefined（空串 / 非数字 → undefined） */
function parsePidOrUndefined(raw: string): number | undefined {
  const s = (raw ?? '').trim()
  if (!/^\d+$/.test(s)) return undefined
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : undefined
}
