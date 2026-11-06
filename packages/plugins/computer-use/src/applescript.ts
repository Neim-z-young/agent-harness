/**
 * computer-use 的 AppleScript 纯逻辑层（无副作用、可单测）
 *
 * 抽出来的原因：mac.ts 里"转义 / element_id 解析 / 结果解析 / 键码"这四件事既无法脱离
 * osascript 测试，又在多个方法里各写一遍（转义两遍、element_id 解析四遍），
 * 既重复又无法验证。这里收敛成纯函数，mac.ts 只负责"拼脚本 + 调执行器"。
 *
 * 边界口径（有意从严）：
 * - 插入到 AppleScript 字面量的文本一律先过 `escapeAppleScriptText`：反斜杠与双引号转义，
 *   控制字符（含换行）折叠为空格 —— AppleScript 字符串字面量不接受裸换行，
 *   不处理就会出现"脚本被注入/直接语法错"而不是"报个可读的错"。
 * - 数值（坐标、页数、pid）一律走 `assertFiniteInt` / `parsePid`：NaN、Infinity、
 *   非整数、越界全部拒绝，避免把 `NaN` 或未校验值插进脚本。
 * - 未知修饰符不再静默降级为 command —— 误触发 ⌘Q / ⌘W 这一类破坏性快捷键的代价比报错高。
 */

/** UI 元素引用：element_id 形如 `role|name|index` */
export interface ElementRef {
  role: string
  name?: string
  index: number
}

/** list_apps 的一行解析结果（pid 非数字时为 undefined，而不是 NaN） */
export interface AppListEntry {
  name: string
  pid?: number
}

// ===== 文本转义（唯一口径） =====

/**
 * 转义为 AppleScript 字符串字面量内部可用的文本。
 * - `\` → `\\`，`"` → `\"`
 * - 控制字符（\r \n \t 及其它 C0）折叠为空格：AppleScript 字面量不接受裸换行
 */
export function escapeAppleScriptText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
}

/** 包成 AppleScript 字符串字面量（含两侧引号） */
export function quoteAppleScriptString(s: string): string {
  return `"${escapeAppleScriptText(s)}"`
}

// ===== element_id 解析（唯一口径） =====

/**
 * 解析 `role|name|index`。
 * - 缺 name（`button||3` 或 `button`）时按 index 定位，而不是拼出 `button ""`
 * - index 缺省 1；非正整数报错
 * - role 为空报错
 */
export function parseElementRef(id: string): ElementRef {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('element_id 不能为空（期望 role|name|index）')
  }
  const parts = id.split('|')
  const role = (parts[0] ?? '').trim()
  if (!role) throw new Error(`element_id 缺少 role：${id}（期望 role|name|index）`)
  const rawName = (parts[1] ?? '').trim()
  const rawIndex = (parts[2] ?? '').trim()
  const index = rawIndex === '' ? 1 : assertFiniteInt(rawIndex, 'element_id 的 index', { min: 1 })
  return rawName === '' ? { role, index } : { role, name: rawName, index }
}

/** 把 ElementRef 还原成 AppleScript 定位子句（如 `button "OK"` / `button 3`） */
export function elementRefClause(ref: ElementRef): string {
  return ref.name === undefined ? `${ref.role} ${ref.index}` : `${ref.role} ${quoteAppleScriptString(ref.name)}`
}

// ===== 数值校验 =====

/**
 * 断言有限整数（接受 number 或纯数字字符串）。
 * 用于坐标 / 页数 / index 等会被插进 AppleScript 的位置：不校验就等于把任意值拼进脚本。
 */
export function assertFiniteInt(
  value: unknown,
  label: string,
  opts: { min?: number; max?: number } = {},
): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${label} 必须是整数，收到 ${JSON.stringify(value) ?? String(value)}`)
  }
  const { min, max } = opts
  if (min !== undefined && n < min) throw new Error(`${label} 不能小于 ${min}，收到 ${n}`)
  if (max !== undefined && n > max) throw new Error(`${label} 不能大于 ${max}，收到 ${n}`)
  return n
}

/** 解析 pid 文本：非数字 / NaN → undefined（不把 NaN 泄漏到输出） */
export function parsePid(raw: string | undefined): number | undefined {
  if (raw == null) return undefined
  const s = raw.trim()
  if (s === '') return undefined
  if (!/^\d+$/.test(s)) return undefined
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : undefined
}

// ===== 结果解析 =====

/** 解析 list_apps 的原始输出（每行 `name<TAB>pid`） */
export function parseAppList(raw: string): AppListEntry[] {
  const out: AppListEntry[] = []
  for (const line of (raw ?? '').split('\n')) {
    if (!line.trim()) continue
    const [name, pidStr] = line.split('\t')
    out.push({ name: (name ?? '').trim(), pid: parsePid(pidStr) })
  }
  return out
}

/**
 * 解析 osascript 布尔结果。
 * 与旧实现的差别：先判 error 再判 true/false —— 旧实现里含 "true" 的报错文本会被当成 true。
 */
export function parseBoolResult(raw: string, fallback = false): boolean {
  const s = (raw ?? '').trim().toLowerCase()
  if (s === 'true') return true
  if (s === 'false') return false
  if (s.includes('error')) throw new Error(`权限查询失败：${raw}`)
  if (s.startsWith('true')) return true
  if (s.startsWith('false')) return false
  return fallback
}

// ===== 键码与修饰符 =====

/** 命名键 → AppleScript key code（macOS 虚拟键码子集）；未知返回 null（走 keystroke 兜底） */
export function keyCodeFor(key: string): number | null {
  const k = (key ?? '').trim().toLowerCase()
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

const MODIFIER_MAP: Record<string, string> = {
  cmd: 'command down',
  command: 'command down',
  ctrl: 'control down',
  control: 'control down',
  opt: 'option down',
  option: 'option down',
  alt: 'option down',
  shift: 'shift down',
}

/** 修饰符 → AppleScript ` using {...}` 子句（无修饰符返回空串）；未知修饰符报错而非静默降级 */
export function modifierClause(mods: readonly string[] | undefined): string {
  if (!mods || mods.length === 0) return ''
  const parts = mods.map((m) => {
    const key = String(m ?? '').trim().toLowerCase()
    const mapped = MODIFIER_MAP[key]
    if (!mapped) {
      throw new Error(`不支持的修饰符 ${JSON.stringify(m)}，可用：${Object.keys(MODIFIER_MAP).join(' / ')}`)
    }
    return mapped
  })
  return ` using {${[...new Set(parts)].join(', ')}}`
}

/** 滚动方向 → 键码（126/125 上下；左右走 123/124） */
export function scrollKeyCode(direction: 'up' | 'down' | 'left' | 'right'): number {
  switch (direction) {
    case 'up': return 126
    case 'down': return 125
    case 'left': return 123
    case 'right': return 124
  }
}

/**
 * 归一化滚动方向：direction 优先，其次 deltaY / deltaX 的符号。
 * 旧实现完全忽略 deltaX，水平滚动只能靠显式 direction。
 */
export function resolveScrollDirection(opts: {
  direction?: string
  deltaY?: number
  deltaX?: number
}): 'up' | 'down' | 'left' | 'right' {
  const d = (opts.direction ?? '').trim().toLowerCase()
  if (d === 'up' || d === 'down' || d === 'left' || d === 'right') return d
  if (d !== '') throw new Error(`不支持的滚动方向 ${JSON.stringify(opts.direction)}，可用：up / down / left / right`)
  const dy = typeof opts.deltaY === 'number' && Number.isFinite(opts.deltaY) ? opts.deltaY : 0
  const dx = typeof opts.deltaX === 'number' && Number.isFinite(opts.deltaX) ? opts.deltaX : 0
  if (Math.abs(dx) > Math.abs(dy) && dx !== 0) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'up' : 'down'
}
