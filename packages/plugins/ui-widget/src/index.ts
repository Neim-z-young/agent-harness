/**
 * @harness/ui-widget —— 生成式 UI（M2）
 *
 * 声明式 widget 声明的注册表 + `ui_widget` 工具通道（方案定稿 2026-10-10）。
 *
 * 架构位置：
 * - `WIDGET_RENDERERS`：widgetType → 渲染器（宿主无关的纯文本渲染，TUI 与 headless 共用）。
 *   每个渲染器有两个出口：`render`（完整渲染，TUI widget 块正文）与
 *   `renderText`（单行摘要，REPL/headless 降级）。
 * - `ui_widget` 工具：模型产出结构化 UI 声明的唯一通道。工具参数 schema 即白名单
 *   （widgetType 枚举 + props 对象），经 `core.tool.pool.assemble` 注入 —— 与 tool
 *   pipeline / 权限 / 审计（M3 决策卡片）全打通。
 * - 落 session 的形态：`WidgetPart { type:'widget', widgetType, props }`（@harness/session）。
 *   模型路径的声明以 tool part 的 result 落盘，渲染层把 `ui_widget` 工具结果视作 widget；
 *   宿主路径直接追加 WidgetPart。两者在渲染端汇入同一注册表。
 */
import { defineTool, type AgentPlugin, type Hooks, type Tool } from '@harness/core'
import { fromJsonSchema } from '@harness/tool'

// ===== 渲染器注册表 =====

/** 渲染器契约：render 完整渲染，renderText 单行摘要（headless/REPL 降级） */
export interface WidgetRenderer<P = Record<string, unknown>> {
  /** 完整渲染（多行纯文本，TUI widget 块正文） */
  render(props: P): string
  /** 单行摘要（REPL/headless / provider 降级） */
  renderText(props: P): string
}

/** 未知 widgetType 的兜底渲染（render 与 renderText 一致：结构化摘要） */
function unknownWidget(type: string, props: Record<string, unknown>): string {
  return `[Widget: ${type}]\n${JSON.stringify(props, null, 2)}`
}

/** 数字格式化：千分位 + 2 位小数（货币/度量），NaN 兜底 '-' */
function fmt(n: unknown): string {
  if (typeof n !== 'number' || Number.isNaN(n)) return String(n ?? '-')
  const rounded = Math.round(n * 100) / 100
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** 布尔/状态打标：简单映射避免裸 true/false */
function badge(v: unknown): string {
  if (v === true) return '✓'
  if (v === false) return '✗'
  return String(v ?? '-')
}

// ===== 组件集（M2 首批，按 M3 决策卡片 / M4 面板消费倒排） =====

/** key-value：`{ rows: [{ key, value }] }` —— 参数表格/信息摘要的基础 */
export interface KeyValueWidget {
  title?: string
  rows: Array<{ key: string; value: unknown }>
}

/** table：`{ columns: [{ key, title }], rows: [{[key]: value}] }` */
export interface TableWidget {
  title?: string
  columns: Array<{ key: string; title: string }>
  rows: Array<Record<string, unknown>>
}

/** metric-cards：`{ metrics: [{ label, value, unit? }] }` */
export interface MetricCardsWidget {
  metrics: Array<{ label: string; value: unknown; unit?: string }>
}

/** chart：`{ title?, data: number[], labels?: string[] }` —— braille 柱状图 */
export interface ChartWidget {
  title?: string
  data: number[]
  labels?: string[]
}

/** timeline：`{ steps: [{ label, status?, detail? }] }` —— 决策时间线/任务步骤 */
export interface TimelineWidget {
  title?: string
  steps: Array<{ label: string; status?: 'done' | 'active' | 'pending' | 'failed' | string; detail?: string }>
}

/** diff：`{ file?, before?, after?, hunks? }` —— 简化 unified diff 渲染 */
export interface DiffWidget {
  file?: string
  before?: string
  after?: string
  hunks?: Array<{ oldStart: number; newStart: number; lines: string[] }>
}

/** decision-card：`{ tool, patterns?, riskLevel, inputRows?, historyCount?, summary? }` —— M3 决策卡片 */
export interface DecisionCardWidget {
  /** 工具权限键（如 bash / write_file） */
  tool: string
  /** 命中模式（路径/命令） */
  patterns?: string[]
  /** 风险等级（low / medium / high） */
  riskLevel: 'low' | 'medium' | 'high'
  /** 参数表格行（渲染 key-value 区） */
  inputRows?: Array<{ key: string; value: unknown }>
  /** 同类操作历史统计（本会话内同一工具已执行次数） */
  historyCount?: number
  /** 一句话摘要（如 `权限请求 [bash] rm -rf /tmp/x`） */
  summary?: string
}

export const WIDGET_TYPES = ['key-value', 'table', 'metric-cards', 'chart', 'timeline', 'diff', 'decision-card'] as const
export type WidgetType = (typeof WIDGET_TYPES)[number]

/** 渲染注册表：widgetType → 渲染器（新增组件在此登记） */
export const WIDGET_RENDERERS: Record<string, WidgetRenderer> = {
  'key-value': {
    render(props) {
      const w = props as unknown as KeyValueWidget
      const rows = (w.rows ?? []).map((r) => `  ${r.key}: ${fmt(r.value)}`)
      return [w.title ? `▌ ${w.title}` : '', ...rows].filter(Boolean).join('\n')
    },
    renderText(props) {
      const w = props as unknown as KeyValueWidget
      const rows = (w.rows ?? []).slice(0, 4).map((r) => `${r.key}=${fmt(r.value)}`).join(', ')
      return `[KV${w.title ? ` ${w.title}` : ''}] ${rows}${(w.rows?.length ?? 0) > 4 ? ' …' : ''}`
    },
  },

  table: {
    render(props) {
      const w = props as unknown as TableWidget
      const cols = w.columns ?? []
      const rows = w.rows ?? []
      if (cols.length === 0) return '(empty table)'
      const widths = cols.map((c) =>
        Math.max(c.title.length, ...rows.map((r) => fmt(r[c.key]).length)),
      )
      const line = (cells: string[]): string => '│ ' + cells.map((c, i) => c.padEnd(widths[i]!)).join(' │ ') + ' │'
      const sep = '├' + widths.map((w2) => '─'.repeat(w2 + 2)).join('┼') + '┤'
      const head = line(cols.map((c) => c.title))
      const body = rows.map((r) => line(cols.map((c) => fmt(r[c.key]))))
      return [w.title ? `▌ ${w.title}` : '', head, sep, ...body].filter(Boolean).join('\n')
    },
    renderText(props) {
      const w = props as unknown as TableWidget
      const rows = w.rows ?? []
      return `[Table] ${(w.columns ?? []).map((c) => c.title).join('|')} · ${rows.length} 行`
    },
  },

  'metric-cards': {
    render(props) {
      const w = props as unknown as MetricCardsWidget
      return (w.metrics ?? []).map((m) => `  ${m.label}: ${fmt(m.value)}${m.unit ? ` ${m.unit}` : ''}`).join('\n')
    },
    renderText(props) {
      const w = props as unknown as MetricCardsWidget
      return `[Metrics] ${(w.metrics ?? []).slice(0, 3).map((m) => `${m.label}=${fmt(m.value)}${m.unit ?? ''}`).join(', ')}`
    },
  },

  chart: {
    render(props) {
      const w = props as unknown as ChartWidget
      const data = w.data ?? []
      if (data.length === 0) return '(empty chart)'
      const max = Math.max(...data, 1)
      const width = Math.max(8, Math.min(40, data.length))
      const step = Math.max(1, Math.ceil(data.length / width))
      const buckets: number[] = []
      for (let i = 0; i < data.length; i += step) {
        const slice = data.slice(i, i + step)
        buckets.push(slice.reduce((s, v) => s + v, 0) / slice.length)
      }
      // 每桶高度 4 格（▁▂▃▄▅▆▇█ 8 级，取 4 级保持紧凑）
      const bars = buckets.map((v) => {
        const h = Math.round((v / max) * 4)
        return ['▁', '▂', '▄', '▆', '█'][h] ?? '▁'
      })
      const head = w.title ? `▌ ${w.title}` : ''
      const scale = `  max=${fmt(max)}`
      return [head, '  ' + bars.join(''), scale].filter(Boolean).join('\n')
    },
    renderText(props) {
      const w = props as unknown as ChartWidget
      const data = w.data ?? []
      return `[Chart${w.title ? ` ${w.title}` : ''}] ${data.length} 点 · 峰值 ${fmt(Math.max(...data, 0))}`
    },
  },

  timeline: {
    render(props) {
      const w = props as unknown as TimelineWidget
      const mark = (s?: string): string => {
        if (s === 'done') return '✅'
        if (s === 'active') return '▶'
        if (s === 'failed') return '❌'
        if (s === 'pending') return '○'
        return '·'
      }
      const lines = (w.steps ?? []).map((st, i) => {
        const prefix = i === (w.steps?.length ?? 0) - 1 ? '└' : '│'
        return `${prefix} ${mark(st.status)} ${st.label}${st.detail ? ` — ${st.detail}` : ''}`
      })
      return [w.title ? `▌ ${w.title}` : '', ...lines].filter(Boolean).join('\n')
    },
    renderText(props) {
      const w = props as unknown as TimelineWidget
      const steps = w.steps ?? []
      return `[Timeline] ${steps.length} 步${steps.find((s) => s.status === 'failed') ? ' · 有失败' : ''}`
    },
  },

  'decision-card': {
    render(props) {
      const w = props as unknown as DecisionCardWidget
      const riskLabel: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险' }
      const riskMark: Record<string, string> = { low: '🟢', medium: '🟡', high: '🔴' }
      const mark = riskMark[w.riskLevel] ?? '⚪'
      const label = riskLabel[w.riskLevel] ?? w.riskLevel
      const head = `  ${mark} 风险：${label} · ${w.summary ?? `权限请求 [${w.tool}]`}`
      const rows = (w.inputRows ?? []).map((r) => `    ${r.key}: ${fmt(r.value)}`)
      const hist =
        typeof w.historyCount === 'number' && w.historyCount > 0
          ? `  本次会话同类操作已执行 ${w.historyCount} 次`
          : '  本次会话首次执行该操作'
      // 键位图例**不在这里输出**：它是"宿主怎么应答这次询问"，属于宿主职责。
      // TUI 的审批模态会在卡片下方统一渲染一行（回退到纯文本时也一样），
      // 此前两端各写一份 ⇒ 真机同一行出现两次（卡片尾部一次 + 模态底部一次）。
      return [head, ...rows, hist].join('\n')
    },
    renderText(props) {
      const w = props as unknown as DecisionCardWidget
      return `[决策卡] ${w.tool} · ${w.riskLevel}风险${w.historyCount ? ` · 已执行${w.historyCount}次` : ''}`
    },
  },

  diff: {
    render(props) {
      const w = props as unknown as DiffWidget
      const head = w.file ? `── ${w.file}` : ''
      const hunks = w.hunks ?? []
      if (hunks.length > 0) {
        const body = hunks
          .map((h) => `@@ -${h.oldStart} +${h.newStart} @@\n${h.lines.join('\n')}`)
          .join('\n')
        return [head, body].filter(Boolean).join('\n')
      }
      const before = (w.before ?? '').split('\n')
      const after = (w.after ?? '').split('\n')
      const n = Math.max(before.length, after.length)
      const sideBySide: string[] = []
      for (let i = 0; i < n; i++) {
        const a = before[i]
        const b = after[i]
        if (a === b) sideBySide.push(`  ${a ?? ''}`)
        else if (a === undefined) sideBySide.push(`+ ${b ?? ''}`)
        else if (b === undefined) sideBySide.push(`- ${a ?? ''}`)
        else {
          sideBySide.push(`- ${a}`)
          sideBySide.push(`+ ${b}`)
        }
      }
      return [head, ...sideBySide].filter(Boolean).join('\n')
    },
    renderText(props) {
      const w = props as unknown as DiffWidget
      const h = w.hunks ?? []
      const n = h.reduce((s, x) => s + x.lines.length, 0) + (w.before ? 1 : 0) + (w.after ? 1 : 0)
      return `[Diff${w.file ? ` ${w.file}` : ''}] ${n} 行变更`
    },
  },
}

/** 渲染一个 widget 声明（完整渲染；未知类型兜底 JSON 摘要） */
export function renderWidget(type: string, props: Record<string, unknown>): string {
  const r = WIDGET_RENDERERS[type]
  return r ? r.render(props) : unknownWidget(type, props)
}

/** 渲染单行摘要（REPL/headless 降级；未知类型兜底 `[Widget: <type>]`） */
export function renderWidgetText(type: string, props: Record<string, unknown>): string {
  const r = WIDGET_RENDERERS[type]
  return r ? r.renderText(props) : `[Widget: ${type}]`
}

// ===== ui_widget 工具 =====

/** 工具入参：widgetType 白名单枚举 + props 自由对象 */
export interface UiWidgetInput {
  widgetType: string
  props: Record<string, unknown>
}

/**
 * 构造 `ui_widget` 工具。
 *
 * - inputSchema 即白名单：widgetType 限定注册表内组件，props 限定为 JSON 对象
 *   （fromJsonSchema 运行期硬校验，模型塞非对象/未注册类型直接拒绝）。
 * - call 无副作用（isReadOnly/isConcurrencySafe），只校验并回传结构化声明。
 */
export function buildUiWidgetTool(): Tool<UiWidgetInput, { widgetType: string; props: Record<string, unknown> }> {
  return defineTool({
    id: 'ui_widget',
    description:
      'Emit a structured UI widget declaration for the current output. ' +
      'Use it to present data as a rendered component (table / key-value / metric-cards / chart / timeline / diff) ' +
      'instead of plain text. Pick the widgetType that fits the data and pass the data as props.',
    documentation: [
      'ui_widget emits a structured UI declaration (WidgetPart) rendered by the host.',
      '',
      'widgetType must be one of:',
      ...WIDGET_TYPES.map((t) => `- ${t}`),
      '',
      'Each widgetType expects specific props (all values JSON-serializable):',
      '- key-value: { title?, rows: [{ key, value }] }',
      '- table: { title?, columns: [{ key, title }], rows: [{[key]: value}] }',
      '- metric-cards: { metrics: [{ label, value, unit? }] }',
      '- chart: { title?, data: number[], labels?: string[] }',
      '- timeline: { title?, steps: [{ label, status?: done|active|pending|failed, detail? }] }',
      '- diff: { file?, before?, after? } or { file?, hunks: [{ oldStart, newStart, lines }] }',
      '',
      'Prefer a widget over a text dump when the data has structure (tables, metrics, timelines, diffs).',
    ].join('\n'),
    inputSchema: fromJsonSchema<UiWidgetInput>({
      type: 'object',
      properties: {
        widgetType: {
          type: 'string',
          enum: [...WIDGET_TYPES],
          description: 'The widget component type (must be one of the registered set).',
        },
        props: {
          type: 'object',
          description: 'JSON-serializable data consumed by the renderer. Shape depends on widgetType.',
        },
      },
      required: ['widgetType', 'props'],
    }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input) {
      const props = input.props ?? {}
      // 双保险：schema 已硬校验，这里再兜一层（直调 / 非 schema 路径）
      if (!WIDGET_RENDERERS[input.widgetType]) {
        return {
          ok: false,
          error: {
            message: `Unknown widgetType: ${input.widgetType}. Available: ${WIDGET_TYPES.join(', ')}`,
            code: 'UNKNOWN_WIDGET_TYPE',
          },
        }
      }
      return { ok: true, output: { widgetType: input.widgetType, props } }
    },
  })
}

/** 把 `ui_widget` 工具结果（tool part 的 result）解析为 widget 声明；非 ui_widget 返回 undefined */
export function widgetFromToolResult(
  toolId: string | undefined,
  result: unknown,
): { widgetType: string; props: Record<string, unknown> } | undefined {
  if (toolId !== 'ui_widget') return undefined
  const r = result as { widgetType?: unknown; props?: unknown } | null | undefined
  if (!r || typeof r !== 'object' || typeof r.widgetType !== 'string') return undefined
  const props = r.props && typeof r.props === 'object' ? (r.props as Record<string, unknown>) : {}
  return { widgetType: r.widgetType, props }
}

// ===== 插件工厂 =====

/** 把 `ui_widget` 工具经 `core.tool.pool.assemble` 注入 harness 工具池 */
export function createUiWidgetPlugin(): AgentPlugin {
  const tools: Tool[] = [buildUiWidgetTool()]
  return {
    id: 'ui-widget',
    version: '0.1.0',
    name: 'ui-widget',
    description: '生成式 UI：ui_widget 工具 + WidgetPart 渲染注册表',
    async install(): Promise<Hooks> {
      return {
        'core.tool.pool.assemble': (_input, pool) => {
          pool.addAll(tools)
        },
      } as Hooks
    },
  }
}
