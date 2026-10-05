/**
 * `lmtools.ts`（P3-D 扩展侧形状与流程）的纯单测 —— 不碰 vscode、不起 sidecar。
 *
 * 这里钉的是四件事：**名字怎么起**、**坏条目怎么丢（且要报出来）**、
 * **approve 什么时候才带**（本文件最重要的一组）、**结果怎么渲染成模型读得懂的文本**。
 */
import { describe, expect, it } from 'bun:test'
import {
  ApprovalLedger,
  confirmationFor,
  LM_TOOL_PREFIX,
  lmToolNameOf,
  parseToolList,
  planToolCall,
  renderToolOutcome,
  sanitizeToolName,
  type LmToolSpec,
} from './lmtools'

/** 造一条线上描述符（缺省值取"最常见的那一种"） */
function wire(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    description: `${name} 的说明`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    readOnly: false,
    requiresConfirmation: true,
    ...over,
  }
}

const SPEC: LmToolSpec = {
  harnessName: 'read_file',
  lmName: 'harness_read_file',
  description: '读取本地文件内容。',
  readOnly: true,
  requiresConfirmation: true,
}

describe('LM 工具命名（全局命名空间，必须带前缀）', () => {
  it('原名直出加前缀', () => {
    expect(lmToolNameOf('read_file')).toBe('harness_read_file')
    expect(LM_TOOL_PREFIX).toBe('harness_')
  })

  it('净化：非 [A-Za-z0-9_-] 一律换成下划线，并去掉首尾下划线', () => {
    // MCP 客户端插件注册进来的工具名由**用户配置的 server 名**参与拼装，出现空格/冒号不奇怪
    expect(sanitizeToolName('mcp__my server__do:it')).toBe('mcp__my_server__do_it')
    expect(sanitizeToolName('  tool  ')).toBe('tool')
    expect(sanitizeToolName('...')).toBe('')
  })

  it('净化后没有可用字符 ⇒ 返回空串（调用方会丢弃，不会注册出 `harness_`）', () => {
    expect(lmToolNameOf('中文名')).toBe('harness_')
    expect(sanitizeToolName('中文名')).toBe('')
  })
})

describe('parseToolList：解析与 Fail-Closed 丢弃', () => {
  it('认 `{ tools: [...] }`（控制面契约形状）', () => {
    const r = parseToolList({ tools: [wire('read_file', { readOnly: true }), wire('bash')] })
    expect(r.listed).toBe(2)
    expect(r.skipped).toEqual([])
    expect(r.specs.map((s) => s.lmName)).toEqual(['harness_bash', 'harness_read_file'])
  })

  it('也认裸数组（出参形状演进时不会静默变空）', () => {
    expect(parseToolList([wire('a_tool')]).specs).toHaveLength(1)
  })

  it('认不出的形状 ⇒ 空清单且不抛（`listed` 为 0，可与"非空但全丢"区分）', () => {
    expect(parseToolList(null)).toEqual({ specs: [], listed: 0, skipped: [] })
    expect(parseToolList({ tools: 'nope' })).toEqual({ specs: [], listed: 0, skipped: [] })
    expect(parseToolList(undefined)).toEqual({ specs: [], listed: 0, skipped: [] })
  })

  it('布尔字段只认字面 true（缺字段 / 给字符串 / 给 1 都算 false）', () => {
    const r = parseToolList([
      wire('a'),
      { name: 'b', description: 'b', readOnly: 'true', requiresConfirmation: 1 },
    ])
    const a = r.specs.find((s) => s.harnessName === 'a')!
    expect(a.readOnly).toBe(false)
    expect(a.requiresConfirmation).toBe(true)
    const b = r.specs.find((s) => s.harnessName === 'b')!
    expect(b.readOnly).toBe(false)
    expect(b.requiresConfirmation).toBe(false)
  })

  it('缺 name / 非对象 ⇒ 丢弃并**记清原因**（不静默）', () => {
    const r = parseToolList([wire('ok_tool'), { description: '没有名字' }, null, 'x'])
    expect(r.specs.map((s) => s.harnessName)).toEqual(['ok_tool'])
    expect(r.listed).toBe(4)
    expect(r.skipped).toEqual(['（缺 name）', '（不是对象）', '（不是对象）'])
  })

  it('净化后同名 ⇒ 只留先出现的，后一条记进 skipped（不覆盖、不静默）', () => {
    const r = parseToolList([wire('a b'), wire('a:b')])
    expect(r.specs.map((s) => s.lmName)).toEqual(['harness_a_b'])
    expect(r.skipped[0]).toContain('归一化后同名')
    expect(r.skipped[0]).toContain('a:b')
  })

  it('描述缺失 / 非字符串 ⇒ 空串（工具不能因为"没描述"就消失）', () => {
    const r = parseToolList([{ name: 't', description: 42 }])
    expect(r.specs[0]!.description).toBe('')
  })

  it('顺序按原名稳定排序（客户端 diff 不会误判"工具集变了"）', () => {
    const r = parseToolList([wire('zeta'), wire('alpha'), wire('mid')])
    expect(r.specs.map((s) => s.harnessName)).toEqual(['alpha', 'mid', 'zeta'])
  })
})

// ========================================================================
// approve 的判据（本文件最重要的一组）
// ========================================================================

describe('审批台账：只有"确实弹过框"的调用才带 approve', () => {
  it('没弹过框（第三方扩展直接 lm.invokeTool）⇒ **不带 approve**', () => {
    const ledger = new ApprovalLedger()
    const p = planToolCall('s_1', { ...SPEC, harnessName: 'bash', lmName: 'harness_bash' }, { command: 'rm -rf /' }, ledger)
    // 这是 Fail-Closed 的核心：`lm.invokeTool` 是公开 API，任何扩展都能绕过 prepareInvocation
    expect('approve' in p).toBe(false)
    expect(p).toEqual({ sessionId: 's_1', name: 'bash', input: { command: 'rm -rf /' } })
  })

  it('弹过框（prepareInvocation 记了一笔）⇒ 带 approve，且**只生效一次**', () => {
    const ledger = new ApprovalLedger()
    ledger.note('harness_bash', { command: 'ls' })
    const first = planToolCall('s_1', { ...SPEC, harnessName: 'bash', lmName: 'harness_bash' }, { command: 'ls' }, ledger)
    expect(first.approve).toBe(true)
    // 第二笔同样的调用没有对应的询问 ⇒ 不带（"一次确认只对一次调用有效"）
    const second = planToolCall('s_1', { ...SPEC, harnessName: 'bash', lmName: 'harness_bash' }, { command: 'ls' }, ledger)
    expect('approve' in second).toBe(false)
  })

  it('入参不同 ⇒ 不共用那一笔记录（带指纹的意义）', () => {
    const ledger = new ApprovalLedger()
    ledger.note('harness_bash', { command: 'ls' })
    const other = planToolCall('s_1', { ...SPEC, harnessName: 'bash', lmName: 'harness_bash' }, { command: 'rm -rf /' }, ledger)
    expect('approve' in other).toBe(false)
  })

  it('并发两次询问不会被一次调用吃掉（用计数而不是布尔）', () => {
    const ledger = new ApprovalLedger()
    ledger.note('harness_bash', { c: 1 })
    ledger.note('harness_bash', { c: 1 })
    const spec = { ...SPEC, harnessName: 'bash', lmName: 'harness_bash' }
    expect(planToolCall('s', spec, { c: 1 }, ledger).approve).toBe(true)
    expect(planToolCall('s', spec, { c: 1 }, ledger).approve).toBe(true)
    expect(planToolCall('s', spec, { c: 1 }, ledger).approve).toBeUndefined()
  })

  it('台账满了 ⇒ 不再记录（宁可漏批，也不淘汰旧的变成有效凭证）', () => {
    const ledger = new ApprovalLedger(1)
    ledger.note('harness_a', { i: 0 })
    ledger.note('harness_b', { i: 0 })
    expect(ledger.size).toBe(1)
    expect(ledger.consume('harness_b', { i: 0 })).toBe(false)
    expect(ledger.consume('harness_a', { i: 0 })).toBe(true)
  })

  it('序列化不了的入参（循环引用）不抛错：退化成按工具名匹配', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const ledger = new ApprovalLedger()
    expect(() => ledger.note('harness_x', cyclic)).not.toThrow()
    expect(ledger.consume('harness_x', cyclic)).toBe(true)
  })

  it('clear() 之后旧凭证失效（sidecar 重启后不该继续生效）', () => {
    const ledger = new ApprovalLedger()
    ledger.note('harness_bash', { c: 1 })
    ledger.clear()
    expect(ledger.size).toBe(0)
    expect(ledger.consume('harness_bash', { c: 1 })).toBe(false)
  })

  it('记录有 TTL：很久以前那次（可能是试探性 prepare）不再作为凭证', () => {
    let clock = 1_000_000
    const ledger = new ApprovalLedger(64, () => clock)
    ledger.note('harness_bash', { c: 1 })
    expect(ledger.consume('harness_bash', { c: 1 })).toBe(true)

    // 用户点开确认框思考了 9 分钟才点 Continue ⇒ 仍然算（TTL 上界要容得下人的反应时间）
    ledger.note('harness_bash', { c: 2 })
    clock += 9 * 60 * 1000
    expect(ledger.consume('harness_bash', { c: 2 })).toBe(true)

    // 隔了一小时才来的调用 ⇒ 不认（那多半是试探性调用留下的记录）
    ledger.note('harness_bash', { c: 3 })
    clock += 60 * 60 * 1000
    expect(ledger.consume('harness_bash', { c: 3 })).toBe(false)
  })

  it('approve 之外，params 传的是**原名**（sidecar 不认识 `harness_` 前缀）', () => {
    const p = planToolCall('s_x', SPEC, {}, new ApprovalLedger())
    expect(p.name).toBe('read_file')
    expect(p.sessionId).toBe('s_x')
  })
})

describe('确认框文案', () => {
  it('标题带工具原名；正文含描述、入参与"仅本次有效"的声明', () => {
    const c = confirmationFor(SPEC, { path: 'src/index.ts' })
    expect(c.title).toBe('运行 harness 工具 read_file？')
    expect(c.message).toContain('读取本地文件内容。')
    expect(c.message).toContain('"path": "src/index.ts"')
    // 用户不该以为点一次 Continue 就永久放行（§14.5：没有 always-allow）
    expect(c.message).toContain('本次调用')
    expect(c.message).toContain('不会因此写入本地规则')
  })

  it('入参过长 ⇒ 截断并说清截断了', () => {
    const c = confirmationFor(SPEC, { blob: 'x'.repeat(5000) })
    expect(c.message).toContain('已截断')
    expect(c.message.length).toBeLessThan(3000)
  })

  it('入参序列化不了也不抛', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(() => confirmationFor(SPEC, cyclic)).not.toThrow()
  })
})

describe('结果渲染：模型要能读回上下文并据此改', () => {
  it('成功 + 字符串出参 ⇒ 直出', () => {
    expect(renderToolOutcome({ ok: true, output: '文件内容' }, 'harness_read_file')).toBe('文件内容')
  })

  it('成功 + 对象出参 ⇒ JSON 缩进（可读）', () => {
    expect(renderToolOutcome({ ok: true, output: { a: 1 } }, 'harness_x')).toBe('{\n  "a": 1\n}')
  })

  it('成功但没有 output ⇒ 明确写"(无输出)"，不是空串', () => {
    expect(renderToolOutcome({ ok: true }, 'harness_x')).toBe('(无输出)')
  })

  it('权限被拒 ⇒ 说清是"用户没批准"并**明确劝阻原样重试**', () => {
    const t = renderToolOutcome(
      { ok: false, error: { message: '权限被拒绝：bash', code: 'PERMISSION_DENIED' } },
      'harness_bash',
    )
    expect(t).toContain('执行失败：权限被拒绝：bash（code PERMISSION_DENIED）')
    expect(t).toContain('不要原样重试')
  })

  it('其它工具级失败 ⇒ 指向"调入参后重试"，且不叫"请求失败"', () => {
    const t = renderToolOutcome({ ok: false, error: { message: '入参不合 schema' } }, 'harness_x')
    expect(t).toContain('工具级失败')
    expect(t).toContain('不是传输错误')
    expect(t).toContain('调整入参')
  })

  it('失败但连 message 都没有 ⇒ 兜底文案，且不伪造 code', () => {
    const t = renderToolOutcome({ ok: false }, 'harness_x')
    expect(t).toContain('工具执行失败')
    expect(t).not.toContain('code')
  })

  it('返回根本不是对象 ⇒ 也返回文本（不抛，抛出去等于把"为什么"藏起来）', () => {
    expect(renderToolOutcome('nope', 'harness_x')).toContain('无法解析的结果')
    expect(renderToolOutcome(null, 'harness_x')).toContain('无法解析的结果')
  })

  it('超长出参 ⇒ 截断并报原长（静默截断会让模型以为看到了全部）', () => {
    const t = renderToolOutcome({ ok: true, output: 'y'.repeat(30_000) }, 'harness_x')
    expect(t).toContain('已截断：原长 30000 字符')
    expect(t.length).toBeLessThan(20_200)
  })
})
