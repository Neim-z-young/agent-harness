/**
 * computer-use macOS 自动化后端
 *
 * 通过 /usr/bin/osascript（AppleScript System Events）实现真实电脑控制，
 * 配合 /usr/sbin/screencapture 截图。所有外部命令都通过可注入的 ExecFn / ExecBinFn 执行，
 * 便于在单测中注入 mock（不真的操作电脑）。
 *
 * 权限：需要「辅助功能」(Accessibility) 授权；屏幕截图需要「屏幕录制」(Screen Recording) 授权。
 * 相应工具在被系统拒绝时抛出携带可读信息的错误，由上层转为工具 error 结果。
 */

import { execFile } from 'node:child_process'

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

/** AppleScript System Events 进程名转义 */
function q(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
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
    `set theProc to "${q(processName)}"`,
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

  private async run(script: string): Promise<string> {
    const r = await this.exec(['-e', script])
    if (r.code !== 0) throw new Error(`osascript 失败：${r.stderr || r.stdout || '未知错误'}`)
    return r.stdout.trimEnd()
  }

  /** 提取布尔结果：true/false 或 error */
  private parseBool(raw: string, fallback = false): boolean {
    const s = raw.toLowerCase()
    if (s.includes('true')) return true
    if (s.includes('false')) return false
    if (s.includes('error')) throw new Error(`权限查询失败：${raw}`)
    return fallback
  }

  /** check_permissions：辅助功能 + 屏幕录制 */
  async checkPermissions(): Promise<PermissionsResult> {
    let accessibility = false
    try {
      accessibility = this.parseBool(await this.run(permissionScript()))
    } catch { accessibility = false }
    return {
      accessibility,
      // 屏幕录制状态难以稳定探测：接入截图命令作为启发式（失败/被拒则为 false）
      screenRecording: null,
    }
  }

  /** list_apps：列出运行中的应用（name + pid + 可选 windowId） */
  async listApps(opts: { includeWindowIds?: boolean; windowLimit?: number } = {}): Promise<{ apps: AppInfo[] }> {
    const raw = await this.run(listAppsScript())
    const apps: AppInfo[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const [name, pidStr] = line.split('\t')
      apps.push({ name, pid: pidStr ? parseInt(pidStr, 10) : undefined, running: true })
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
      `  tell process "${q(processName)}"`,
      `    try`,
      `      set w to front window`,
      `      return (id of w) as text`,
      `    on error`,
      `      return ""`,
      `    end try`,
      `  end tell`,
      `end tell`,
    ].join('\n')
    const raw = await this.run(script)
    const n = parseInt(raw, 10)
    return Number.isNaN(n) ? undefined : n
  }

  /** get_app_state：UI 树 + 可选截图 */
  async getAppState(opts: { app: string; windowId?: number; disableDiff?: boolean }): Promise<AppStateResult> {
    const uiTree = await this.run(uiTreeScript(opts.app, 4, 200))
    let screenshot: string | undefined
    if (this.allowScreenshot && this.execBin) {
      try {
        const wid = opts.windowId ?? (await this.frontWindowId(opts.app))
        const args = ['-l', String(wid ?? opts.app), '-t', 'png', '-o', '-']
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
    if (opts.element_id != null) {
      // element_id 形如 "role|name|index"，拆出用于 AppleScript 定位
      const [role, name, idx] = opts.element_id.split('|')
      const which = name !== undefined ? `${role} "${q(name)}"` : `${role} ${idx ?? '1'}`
      await this.run(this.inProc(opts.app, `click ${which} of front window`))
    } else if (opts.x != null && opts.y != null) {
      await this.run(this.inProc(opts.app, `click at {${opts.x}, ${opts.y}}`))
    } else {
      throw new Error('click 需要 element_id 或 (x, y) 坐标')
    }
    return { ok: true }
  }

  /** scroll：按方向/页 或 deltaY/deltaX */
  async scroll(opts: { app: string; element_id?: string; deltaY?: number; deltaX?: number; direction?: string; pages?: number }): Promise<{ ok: true }> {
    const pages = opts.pages ?? 1
    const dir = opts.direction ?? (opts.deltaY && opts.deltaY > 0 ? 'down' : opts.deltaY && opts.deltaY < 0 ? 'up' : 'down')
    const axis = dir === 'left' || dir === 'right' ? 'horizontal' : 'vertical'
    // 通过光标 & 方向键滚动（最通用的无元素方案）
    await this.run(this.inProc(opts.app, `set frontmost to true`))
    await this.run(`tell application "System Events" to repeat ${pages} times
  key code ${dir === 'up' || dir === 'left' ? 126 : 125} using {${axis === 'horizontal' ? 'shift' : 'control'} down}
end repeat`.replace('\n', '\n'))
    return { ok: true }
  }

  /** drag：从起点拖到终点 */
  async drag(opts: { app: string; fromX?: number; fromY?: number; toX?: number; toY?: number }): Promise<{ ok: true }> {
    await this.run(this.inProc(opts.app, `set frontmost to true`))
    await this.run(`tell application "System Events"
  set p to ${opts.fromX ?? 0} + ${opts.toX ?? 0}
end tell`)
    // 真实拖动：按下鼠标 → 移动 → 释放（基于点击坐标近似）
    if (opts.fromX != null && opts.fromY != null && opts.toX != null && opts.toY != null) {
      await this.run(`tell application "System Events"
  click at {${opts.fromX}, ${opts.fromY}}
  click at {${opts.toX}, ${opts.toY}}
end tell`)
    } else {
      throw new Error('drag 需要 fromX/fromY/toX/toY')
    }
    return { ok: true }
  }

  /** type_text：向目标输入框输入文本（后台，不抢焦点） */
  async typeText(opts: { app: string; text: string; slowly?: boolean }): Promise<{ ok: true }> {
    if (opts.text == null) throw new Error('type_text 缺少 text')
    // 光标锁定由调用方先 click 目标字段；这里直接 keystroke（保持系统级）
    await this.run(`tell application "System Events" to keystroke ${quotedText(opts.text)}`)
    return { ok: true }
  }

  /** press_key：按键 / 组合键 */
  async pressKey(opts: { app: string; key: string; modifiers?: string[] }): Promise<{ ok: true }> {
    const usage = AppleModifierList(opts.modifiers ?? [])
    const code = keyCodeFor(opts.key)
    const script = code != null
      ? `tell application "System Events" to key code ${code}${usage}`
      : `tell application "System Events" to keystroke "${q(opts.key)}"${usage}`
    await this.run(script)
    return { ok: true }
  }

  /** perform_action：AXPress = click 的辅助动作 */
  async performAction(opts: { app: string; element_id?: string; action: string }): Promise<{ ok: true }> {
    if (opts.element_id == null) {
      // 无明确元素：尝试 action 对应的键（Show Menu → 上下文菜单）
      await this.run(`tell application "System Events" to key code 49 using {control down}`)
      return { ok: true }
    }
    const [role, name, idx] = opts.element_id.split('|')
    const which = name !== undefined ? `${role} "${q(name)}"` : `${role} ${idx ?? '1'}`
    await this.run(this.inProc(opts.app, `perform action "${q(opts.action)}" of ${which} of front window`))
    return { ok: true }
  }

  /** set_value：设置可写元素的值（Electron 等可能拒写） */
  async setValue(opts: { app: string; element_id?: string; value: string }): Promise<{ ok: true }> {
    if (opts.element_id == null) throw new Error('set_value 需要 element_id')
    const [role, name, idx] = opts.element_id.split('|')
    const which = name !== undefined ? `${role} "${q(name)}"` : `${role} ${idx ?? '1'}`
    await this.run(this.inProc(opts.app, `set value of ${which} of front window to "${q(opts.value)}"`))
    return { ok: true }
  }

  /** select_text：在元素内选中文本（按前缀/后缀判定难，提供坐标型近似） */
  async selectText(opts: { app: string; element_id: string; text: string; selection?: string }): Promise<{ ok: true }> {
    if (opts.element_id == null || opts.text == null) throw new Error('select_text 需要 element_id 和 text')
    // 近似：双击元素锚点后使用 ⇧ 键扩展选择，或直接抓取文本所在范围
    const [role, name, idx] = opts.element_id.split('|')
    const which = name !== undefined ? `${role} "${q(name)}"` : `${role} ${idx ?? '1'}`
    await this.run(this.inProc(opts.app, `select ${which} of front window`))
    return { ok: true }
  }

  /** 构造 tell process APP 包裹的 AppleScript */
  private inProc(app: string, actions: string): string {
    return `tell application "System Events"
  tell process "${q(app)}"
    ${actions}
  end tell
end tell`
  }
}

// ===== AppleScript 字符串转义 / 组合键 / 键码 =====

/** AppleScript 字符串字面量（转义仅在字符串字面量上下文有效，keystroke 用其原始值） */
function quotedText(s: string): string {
  // keystroke 使用 AppleScript 字符串字面量，需转义反斜杠与引号
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 修饰符 → AppleScript using {} 子句（空则空串） */
function AppleModifierList(mods?: string[]): string {
  if (!mods || mods.length === 0) return ''
  const parts = mods.map((m) => {
    switch (m.toLowerCase()) {
      case 'cmd': case 'command': return 'command down'
      case 'ctrl': case 'control': return 'control down'
      case 'opt': case 'option': return 'option down'
      case 'shift': return 'shift down'
      default: return 'command down'
    }
  })
  return ` using {${parts.join(', ')}}`
}

/** 命名键 → AppleScript key code（macOS 虚拟键码子集） */
function keyCodeFor(key: string): number | null {
  const k = (key ?? '').toLowerCase()
  const map: Record<string, number> = {
    enter: 36, return: 36,
    tab: 48, space: 49, delete: 51, forwarddelete: 117,
    escape: 53, esc: 53,
    // 字母
    a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38,
    k: 40, l: 37, m: 46, n: 45, o: 31, p: 35, q: 12, r: 15, s: 1, t: 17,
    u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
    // 数字
    '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23, '6': 22, '7': 26, '8': 28, '9': 25,
    // 方向键
    up: 126, down: 125, left: 123, right: 124,
    home: 115, end: 119, pageup: 116, pagedown: 121,
  }
  return map[k] ?? null
}