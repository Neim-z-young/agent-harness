/**
 * @harness/ui-widget 测试
 *
 * 1. ui_widget 工具：schema 校验（非法 widgetType 拒绝、非对象 props 拒绝）、执行语义
 * 2. 渲染器：各组件 render / renderText 输出断言 + 未知类型兜底
 * 3. widgetFromToolResult：tool part result → widget 声明解析
 */
import { describe, expect, it } from 'bun:test'
import {
  WIDGET_RENDERERS,
  WIDGET_TYPES,
  buildUiWidgetTool,
  createUiWidgetPlugin,
  renderWidget,
  renderWidgetText,
  widgetFromToolResult,
} from './index'

describe('ui_widget 工具', () => {
  const tool = buildUiWidgetTool()

  it('schema 声明 widgetType 枚举 + props 对象，只读且并发安全', () => {
    // fromJsonSchema 的模型可读声明存于 __jsonSchema（provider 生成 tools 载荷的唯一来源）
    const json = (tool.inputSchema as { __jsonSchema: { properties: Record<string, { enum?: string[]; type?: string }> } }).__jsonSchema
    expect(json.properties.widgetType.enum).toEqual([...WIDGET_TYPES])
    expect(json.properties.props.type).toBe('object')
    expect(tool.isReadOnly?.({} as never)).toBe(true)
    expect(tool.isConcurrencySafe?.({} as never)).toBe(true)
  })

  it('合法声明：校验通过并回传结构化输出', async () => {
    const res = await tool.call({ widgetType: 'table', props: { columns: [{ key: 'a', title: 'A' }], rows: [] } }, {} as never)
    expect(res.ok).toBe(true)
    expect(res.output).toEqual({ widgetType: 'table', props: { columns: [{ key: 'a', title: 'A' }], rows: [] } })
  })

  it('未知 widgetType：拒绝并给出可用集合', async () => {
    const res = await tool.call({ widgetType: 'nope', props: {} }, {} as never)
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('UNKNOWN_WIDGET_TYPE')
    expect(res.error?.message).toInclude('nope')
  })
})

describe('渲染器注册表', () => {
  it('注册表含 M2 首批 6 个组件，每个都有 render + renderText', () => {
    expect(Object.keys(WIDGET_RENDERERS).sort()).toEqual([...WIDGET_TYPES].sort())
    for (const t of WIDGET_TYPES) {
      const r = WIDGET_RENDERERS[t]!
      expect(typeof r.render).toBe('function')
      expect(typeof r.renderText).toBe('function')
    }
  })

  it('key-value：多行渲染 + 单行摘要', () => {
    const props = { title: '订单', rows: [{ key: 'id', value: 'o1' }, { key: 'amount', value: 19.9 }] }
    expect(renderWidget('key-value', props)).toBe('▌ 订单\n  id: o1\n  amount: 19.9')
    expect(renderWidgetText('key-value', props)).toBe('[KV 订单] id=o1, amount=19.9')
  })

  it('table：列对齐 + 表头/分隔线', () => {
    const props = {
      title: '商品',
      columns: [{ key: 'name', title: '名称' }, { key: 'price', title: '价格' }],
      rows: [{ name: 'apple', price: 3.5 }, { name: 'x', price: 1 }],
    }
    const out = renderWidget('table', props)
    expect(out).toInclude('▌ 商品')
    expect(out).toInclude('名称')
    expect(out).toInclude('apple')
    expect(renderWidgetText('table', props)).toBe('[Table] 名称|价格 · 2 行')
  })

  it('metric-cards：label + 数值 + 单位', () => {
    const props = { metrics: [{ label: 'pass@1', value: 0.75, unit: '%' }, { label: 'turns', value: 12.5 }] }
    expect(renderWidget('metric-cards', props)).toBe('  pass@1: 0.75 %\n  turns: 12.5')
    expect(renderWidgetText('metric-cards', props)).toBe('[Metrics] pass@1=0.75%, turns=12.5')
  })

  it('chart：braille 柱状 + 峰值标注', () => {
    const props = { title: '成本', data: [1, 4, 2, 8] }
    const out = renderWidget('chart', props)
    expect(out).toInclude('▌ 成本')
    expect(out).toInclude('max=8')
    expect(renderWidgetText('chart', props)).toBe('[Chart 成本] 4 点 · 峰值 8')
  })

  it('timeline：状态标记 + 树状连接', () => {
    const props = {
      title: '决策',
      steps: [{ label: '查库存', status: 'done' }, { label: '改订单', status: 'failed' }],
    }
    const out = renderWidget('timeline', props)
    expect(out).toInclude('✅ 查库存')
    expect(out).toInclude('❌ 改订单')
    expect(renderWidgetText('timeline', props)).toBe('[Timeline] 2 步 · 有失败')
  })

  it('decision-card：风险标签 + 参数表格 + 历史（键位图例由宿主渲染）', () => {
    const props = {
      tool: 'bash',
      riskLevel: 'high',
      summary: '权限请求 [bash] rm -rf /tmp/x',
      inputRows: [{ key: 'command', value: 'rm -rf /tmp/x' }],
      historyCount: 2,
    }
    const out = renderWidget('decision-card', props)
    expect(out).toInclude('🔴')
    expect(out).toInclude('高风险')
    expect(out).toInclude('权限请求 [bash] rm -rf /tmp/x')
    expect(out).toInclude('command: rm -rf /tmp/x')
    expect(out).toInclude('已执行 2 次')
    // 键位图例**不属于卡片**：卡片只描述"这次决策是什么"，"怎么应答"由宿主渲染
    // （TUI 审批模态在卡片下方统一输出一行）。卡片此前自带一份 ⇒ 与宿主那份重复成两行。
    expect(out).not.toInclude('[y] 允许')
    expect(renderWidgetText('decision-card', props)).toBe('[决策卡] bash · high风险 · 已执行2次')
  })
  it('decision-card：首次执行提示 + 中风险默认标签', () => {
    const out = renderWidget('decision-card', { tool: 'custom', riskLevel: 'medium', inputRows: [] })
    expect(out).toInclude('🟡')
    expect(out).toInclude('首次执行')
    expect(renderWidgetText('decision-card', { tool: 'custom', riskLevel: 'medium' })).toBe('[决策卡] custom · medium风险')
  })

  it('diff：hunks 与 before/after 两种形态', () => {
    const h = { file: 'a.ts', hunks: [{ oldStart: 1, newStart: 1, lines: ['- x', '+ y'] }] }
    expect(renderWidget('diff', h)).toInclude('@@ -1 +1 @@')
    expect(renderWidget('diff', h)).toInclude('- x')
    const ba = { file: 'b.ts', before: 'a\nb', after: 'a\nc' }
    const out2 = renderWidget('diff', ba)
    expect(out2).toInclude('- b')
    expect(out2).toInclude('+ c')
    expect(renderWidgetText('diff', ba)).toBe('[Diff b.ts] 2 行变更')
  })

  it('未知 widgetType：render 给 JSON 摘要、renderText 给 `[Widget: x]`', () => {
    expect(renderWidget('nope', { a: 1 })).toBe('[Widget: nope]\n{\n  "a": 1\n}')
    expect(renderWidgetText('nope', {})).toBe('[Widget: nope]')
  })
})

describe('widgetFromToolResult', () => {
  it('ui_widget 工具结果 → widget 声明', () => {
    expect(widgetFromToolResult('ui_widget', { widgetType: 'table', props: { columns: [] } })).toEqual({
      widgetType: 'table',
      props: { columns: [] },
    })
  })
  it('非 ui_widget / 畸形结果 → undefined', () => {
    expect(widgetFromToolResult('bash', { widgetType: 'table' })).toBeUndefined()
    expect(widgetFromToolResult('ui_widget', 'nope')).toBeUndefined()
    expect(widgetFromToolResult('ui_widget', null)).toBeUndefined()
    expect(widgetFromToolResult('ui_widget', { props: {} })).toBeUndefined()
    // props 非对象时兜底为空对象，widgetType 合法即通过
    expect(widgetFromToolResult('ui_widget', { widgetType: 'chart', props: 'x' })).toEqual({
      widgetType: 'chart',
      props: {},
    })
  })
})

describe('createUiWidgetPlugin', () => {
  it('install 注入 ui_widget 工具', async () => {
    const plugin = createUiWidgetPlugin()
    expect(plugin.id).toBe('ui-widget')
    let added: Array<{ id: string }> = []
    const hooks = (await plugin.install({} as never)) as Record<string, unknown>
    const assemble = hooks['core.tool.pool.assemble'] as (input: unknown, pool: { addAll: (t: unknown[]) => void }) => void
    assemble(undefined, { addAll: (t) => (added = t as Array<{ id: string }>) })
    expect(added.map((t) => t.id)).toEqual(['ui_widget'])
  })
})
