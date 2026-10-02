/**
 * 侧栏面板的 view-model（**纯模块，不 import vscode**）。
 *
 * 为什么单独抽一层：面板的数据全部来自**跨进程**的控制面与 A2A，形状不可信
 * （字段可能缺、类型可能是字符串、服务端升级后可能多字段）。把"归一 + 排序 +
 * 降级"收在纯函数里，就能脱离 VSCode 单测 —— 与 `commands.ts` / `launch.ts`
 * 同一套路（设计稿 §12.3）。
 *
 * ## 三条硬纪律（设计稿 §12.2）
 * 1. **不新增面板专用控制方法**：只用已有的 `harness/*`；
 * 2. **后台任务走 A2A 的 `ListTasks`**，不落进控制面；
 * 3. **文案只有宿主一份**：统计/通知/文件树一律直显 sidecar 回传的 text，
 *    这里不写第二套渲染器（设计稿 §11「两套界面文案漂移」的对策）。
 *
 * ## 分区独立降级
 * 任一分区取不到 ⇒ 该分区空 + `warnings` 里写明原因，**不整块变灰**
 * （设计稿 §8「降级事实可见」的同一口径）。
 */

/** 面板刷新一次最多呈现的文件引用条数（防大仓库把 webview 消息撑爆） */
export const MAX_REF_ITEMS = 60

// ========================================================================
// 1. view-model 契约（`postMessage` 的 payload，扩展与 webview 唯一契约）
// ========================================================================

/** 面板连的是哪个 sidecar（防止"看的不是我以为的那个进程"） */
export interface PanelEndpoint {
  readonly pid: number
  readonly port: number
  readonly auth: string
  readonly permissionMode: string
  readonly cwd: string
}

export interface PanelSessionItem {
  readonly id: string
  /** 展示标题；无标题时用 id 短码（不显示"null"） */
  readonly title: string
  readonly subtitle: string
  readonly messageCount: number
  readonly updatedText: string
  readonly badges: readonly string[]
  readonly isCurrent: boolean
  readonly isPointer: boolean
  readonly isCwd: boolean
}

export interface PanelSessionSection {
  readonly cwd: string
  readonly current: string | null
  readonly items: readonly PanelSessionItem[]
}

export interface PanelTaskItem {
  readonly id: string
  readonly contextId: string
  /** 原始状态（如 `TASK_STATE_WORKING`） */
  readonly state: string
  /** 人读状态（去掉 `TASK_STATE_` 前缀并小写化） */
  readonly stateText: string
}

export interface PanelRefItem {
  readonly path: string
  readonly name: string
}

export interface PanelRefSection {
  readonly root: string
  readonly items: readonly PanelRefItem[]
  /** 服务端是否截断过目录树 */
  readonly truncated: boolean
  /** 截断前的总引用数（用于"还有 N 条未显示"） */
  readonly total: number
}

export interface PanelStatsSection {
  /** 整页文本（CLI `/stats` 同一段输出） */
  readonly text: string
  readonly rollupText: string
  readonly occupancyText: string
}

export interface PanelNoticeItem {
  readonly level: string
  readonly code: string
  readonly text: string
}

export interface PanelState {
  /** sidecar 是否连上：false 时前端只显示错误与重试 */
  readonly ready: boolean
  readonly loading: boolean
  readonly endpoint?: PanelEndpoint
  readonly sessions: PanelSessionSection
  readonly tasks: readonly PanelTaskItem[]
  readonly refs: PanelRefSection
  readonly stats?: PanelStatsSection
  readonly notices: readonly PanelNoticeItem[]
  /** 分区级降级说明（"为什么这一块是空的"） */
  readonly warnings: readonly string[]
  readonly refreshedText: string
}

/**
 * 面板的数据来源：**每个分区一个槽位**，成功放 payload、失败放原因。
 *
 * 用 `unknown` 而不是精确类型：这是跨进程边界，形状不可信，
 * 类型断言留到归一函数内部去做（归一失败 ⇒ 该分区降级，不抛）。
 */
export interface PanelSources {
  readonly endpoint?: unknown
  readonly sessionList?: unknown
  readonly sessionListError?: string
  readonly stats?: unknown
  readonly statsError?: string
  readonly tree?: unknown
  readonly treeError?: string
  readonly notices?: unknown
  readonly noticesError?: string
  readonly tasks?: unknown
  readonly tasksError?: string
  /** "刷新中"标记（面板自己发起的刷新） */
  readonly loading?: boolean
}

// ========================================================================
// 2. 面板动作（webview → 宿主；纯规划，执行在 panel.ts）
// ========================================================================

export type PanelAction =
  | { readonly kind: 'refresh' }
  /** 调控制面；`refresh` = 打完是否重拉面板 */
  | {
      readonly kind: 'control'
      readonly method: string
      readonly params?: Record<string, unknown>
      readonly refresh: boolean
      readonly label: string
    }
  /** 用 VSCode 打开某文件（Uri 构造在 panel.ts —— 纯模块不碰 vscode） */
  | { readonly kind: 'open-file'; readonly path: string }
  /** 执行扩展已有命令 */
  | { readonly kind: 'command'; readonly id: string; readonly refresh: boolean }
  /** 认不出来：带 reason 记日志，不静默丢 */
  | { readonly kind: 'noop'; readonly reason: string }

/** `/compact` 的可选模式（与控制面同一套词汇，故意写死而不是透传） */
const COMPACT_MODES = ['auto', 'prune', 'summary', 'agent'] as const

/** `/stats-export` 的格式（同上） */
const EXPORT_FORMATS = ['markdown', 'json'] as const

/**
 * webview 消息 → 动作描述。
 *
 * 与 `planCommand` 同源思路：**解析与执行分开**，于是"点一下按钮会发生什么"可单测。
 */
export function planPanelAction(msg: unknown): PanelAction {
  if (typeof msg !== 'object' || msg === null) return { kind: 'noop', reason: '消息不是对象' }
  const o = msg as Record<string, unknown>
  const type = typeof o['type'] === 'string' ? o['type'] : ''

  switch (type) {
    case 'refresh':
      return { kind: 'refresh' }
    case 'new':
      return { kind: 'control', method: 'harness/session.new', params: {}, refresh: true, label: '新建会话' }
    case 'save':
      return { kind: 'control', method: 'harness/session.save', params: {}, refresh: true, label: '保存会话' }
    case 'resume': {
      const id = typeof o['id'] === 'string' ? o['id'].trim() : ''
      if (id === '') return { kind: 'noop', reason: 'resume 缺 id' }
      return { kind: 'control', method: 'harness/session.resume', params: { id }, refresh: true, label: '恢复会话' }
    }
    case 'compact': {
      const raw = typeof o['mode'] === 'string' ? o['mode'].trim() : ''
      if (raw !== '' && !(COMPACT_MODES as readonly string[]).includes(raw)) {
        return { kind: 'noop', reason: `compact 模式非法：${raw}` }
      }
      return {
        kind: 'control',
        method: 'harness/compact',
        params: raw === '' ? {} : { mode: raw },
        refresh: true,
        label: '压缩上下文',
      }
    }
    case 'stats-export': {
      const raw = typeof o['format'] === 'string' ? o['format'].trim() : ''
      if (raw !== '' && !(EXPORT_FORMATS as readonly string[]).includes(raw)) {
        return { kind: 'noop', reason: `导出格式非法：${raw}` }
      }
      return {
        kind: 'control',
        method: 'harness/stats.export',
        params: raw === '' ? {} : { format: raw },
        refresh: false,
        label: '导出统计',
      }
    }
    case 'open': {
      const path = typeof o['path'] === 'string' ? o['path'].trim() : ''
      if (path === '') return { kind: 'noop', reason: 'open 缺 path' }
      return { kind: 'open-file', path }
    }
    case 'show-status':
      return { kind: 'command', id: 'harness.showStatus', refresh: false }
    default:
      return { kind: 'noop', reason: `未知消息类型：${type === '' ? '(空)' : type}` }
  }
}

/** 动作 → 一行日志（面板操作要能在输出通道里追到） */
export function describePanelAction(action: PanelAction): string {
  switch (action.kind) {
    case 'refresh':
      return 'refresh'
    case 'control':
      return `control ${action.method}${action.params ? ` ${JSON.stringify(action.params)}` : ''}`
    case 'open-file':
      return `open-file ${action.path}`
    case 'command':
      return `command ${action.id}`
    case 'noop':
      return `noop(${action.reason})`
  }
}

// ========================================================================
// 3. 归一（unknown → view-model）
// ========================================================================

function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

function asArray(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : []
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** `2026-10-02 21:43` 这种定长格式（本地时区；前端不再二次格式化） */
export function formatTimestamp(ts: number | undefined): string {
  if (ts === undefined) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 会话 id 的短码（无标题会话用它当标题，避免满屏 uuid） */
export function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-3)}`
}

export function normalizeEndpoint(raw: unknown): PanelEndpoint | undefined {
  const o = asObject(raw)
  if (!o) return undefined
  const port = num(o['port'])
  if (port === undefined) return undefined
  return {
    pid: num(o['pid']) ?? 0,
    port,
    auth: str(o['auth'], 'anonymous'),
    permissionMode: str(o['permissionMode'], 'unknown'),
    cwd: str(o['cwd']),
  }
}

/**
 * `harness/session.list` → 会话分区。
 *
 * 排序刻意按"用户此刻最可能想点的"排：**当前** → **项目指针** → **本目录** →
 * 更新时间倒序。store 的自然顺序是创建顺序，直接显示会把当前会话埋在中间。
 */
export function normalizeSessions(raw: unknown): PanelSessionSection {
  const o = asObject(raw)
  if (!o) return { cwd: '', current: null, items: [] }

  const items = asArray(o['sessions']).map((s): PanelSessionItem | undefined => {
    const e = asObject(s)
    if (!e) return undefined
    const id = str(e['id'])
    if (id === '') return undefined
    const title = str(e['title']).trim()
    const isCurrent = e['isCurrent'] === true
    const isPointer = e['isPointer'] === true
    const isCwd = e['isCwd'] === true
    const messageCount = num(e['messageCount']) ?? 0
    const agentId = str(e['agentId']).trim()
    const badges = [
      ...(isCurrent ? ['当前'] : []),
      ...(isPointer ? ['项目指针'] : []),
      ...(isCwd ? ['本目录'] : []),
    ]
    return {
      id,
      title: title === '' ? `（无标题 ${shortId(id)}）` : title,
      subtitle: [agentId === '' ? '' : `agent ${agentId}`, `${messageCount} 条消息`].filter((x) => x !== '').join(' · '),
      messageCount,
      updatedText: formatTimestamp(num(e['updatedAt'])),
      badges,
      isCurrent,
      isPointer,
      isCwd,
    }
  }).filter((x): x is PanelSessionItem => x !== undefined)

  items.sort((a, b) => rank(a) - rank(b) || compareUpdated(a, b))

  return { cwd: str(o['cwd']), current: str(o['current']) || null, items }
}

/** 排序权重：当前 > 项目指针 > 本目录 > 其余 */
function rank(s: PanelSessionItem): number {
  if (s.isCurrent) return 0
  if (s.isPointer) return 1
  if (s.isCwd) return 2
  return 3
}

function compareUpdated(a: PanelSessionItem, b: PanelSessionItem): number {
  // 归一后只有字符串可比，但字符串是 `YYYY-MM-DD HH:mm` ⇒ 字典序 == 时间序
  if (a.updatedText === b.updatedText) return 0
  return a.updatedText < b.updatedText ? 1 : -1
}

/**
 * A2A `ListTasks` → 任务分区。
 *
 * `TASK_STATE_WORKING` 这种全大写枚举直接给人看太吵，剥前缀后小写；
 * 剥不动就原样显示（宁可丑，不可编造状态名）。
 */
export function normalizeTasks(raw: unknown): readonly PanelTaskItem[] {
  const o = asObject(raw)
  if (!o) return []
  return asArray(o['tasks']).map((t): PanelTaskItem | undefined => {
    const e = asObject(t)
    if (!e) return undefined
    const id = str(e['id'])
    if (id === '') return undefined
    const status = asObject(e['status'])
    const state = str(status?.['state']).trim()
    return {
      id,
      contextId: str(e['contextId']),
      state,
      stateText: humanizeTaskState(state),
    }
  }).filter((x): x is PanelTaskItem => x !== undefined)
}

export function humanizeTaskState(state: string): string {
  if (state === '') return '未知'
  const stripped = state.startsWith('TASK_STATE_') ? state.slice('TASK_STATE_'.length) : state
  return stripped.toLowerCase().replace(/_/g, '-')
}

/**
 * `harness/tree.get` → 文件引用分区。
 *
 * 取 `refs`（对话里引用过的路径）而不是整棵 `nodes`：面板要的是"最近碰过哪些文件"，
 * 不是目录树（目录树在 Chat 里由 `/tree` 的 `stream.filetree` 呈现，设计稿 §6.4）。
 */
export function normalizeRefs(raw: unknown): PanelRefSection {
  const o = asObject(raw)
  if (!o) return { root: '', items: [], truncated: false, total: 0 }
  const all = asArray(o['refs']).map((r) => str(r).trim()).filter((r) => r !== '')
  const items = all.slice(0, MAX_REF_ITEMS).map((path): PanelRefItem => {
    const cleaned = path.replace(/:\d+(?::\d+)?$/, '')
    const seg = cleaned.split('/')
    return { path: cleaned, name: seg[seg.length - 1] ?? cleaned }
  })
  return {
    root: str(o['root']),
    items,
    truncated: o['truncated'] === true || all.length > MAX_REF_ITEMS,
    total: all.length,
  }
}

export function normalizeStats(raw: unknown): PanelStatsSection | undefined {
  const o = asObject(raw)
  if (!o) return undefined
  const text = str(o['text'])
  if (text === '') return undefined
  return { text, rollupText: str(o['rollupText']), occupancyText: str(o['occupancyText']) }
}

/** `harness/notice.list` → 通知分区（宿主的"降级事实"，常驻可见） */
export function normalizeNotices(raw: unknown): readonly PanelNoticeItem[] {
  const o = asObject(raw)
  if (!o) return []
  return asArray(o['notices']).map((n): PanelNoticeItem | undefined => {
    const e = asObject(n)
    if (!e) return undefined
    const text = str(e['text']).trim()
    if (text === '') return undefined
    return { level: str(e['level'], 'notice'), code: str(e['code']), text }
  }).filter((x): x is PanelNoticeItem => x !== undefined)
}

// ========================================================================
// 4. 组装
// ========================================================================

const SECTION_LABELS: Record<string, string> = {
  sessionList: '会话',
  stats: '统计',
  tree: '文件引用',
  notices: '通知',
  tasks: '后台任务',
}

/** 空态（还没连上 / 还没拉过） */
export const EMPTY_PANEL_STATE: PanelState = {
  ready: false,
  loading: false,
  sessions: { cwd: '', current: null, items: [] },
  tasks: [],
  refs: { root: '', items: [], truncated: false, total: 0 },
  notices: [],
  warnings: [],
  refreshedText: '',
}

/**
 * 把各分区的成败组装成一份 `PanelState`。
 *
 * 降级口径（这是本函数存在的理由）：**分区独立** —— 一个分区失败只写一条 warning，
 * 其余照常呈现。整块变灰会让用户分不清"没有"和"取不到"。
 */
export function buildPanelState(src: PanelSources, now: number = Date.now()): PanelState {
  const warnings: string[] = []
  const note = (key: keyof typeof SECTION_LABELS, reason: string | undefined) => {
    if (reason !== undefined && reason !== '') warnings.push(`${SECTION_LABELS[key]}分区不可用：${reason}`)
  }

  const endpoint = normalizeEndpoint(src.endpoint)
  const ready = endpoint !== undefined

  const sessions = normalizeSessions(src.sessionList)
  note('sessionList', src.sessionListError)
  const stats = normalizeStats(src.stats)
  if (src.stats === undefined) note('stats', src.statsError)
  const refs = normalizeRefs(src.tree)
  note('tree', src.treeError)
  const notices = normalizeNotices(src.notices)
  note('notices', src.noticesError)
  const tasks = normalizeTasks(src.tasks)
  note('tasks', src.tasksError)

  if (!ready) warnings.unshift('sidecar 未连接（点“刷新”重试）')

  return {
    ready,
    loading: src.loading === true,
    ...(endpoint ? { endpoint } : {}),
    sessions,
    tasks,
    refs,
    ...(stats ? { stats } : {}),
    notices,
    warnings,
    refreshedText: formatTimestamp(now),
  }
}
