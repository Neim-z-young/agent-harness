/**
 * 前缀区段级归因 + 尾部动态块渲染（纯函数单测）。
 *
 * 这两件事解决的是同一个问题的两面：
 *   - **归因**：system 区（请求位置 0）一变，其后整个历史在前缀缓存里失效 —— 需要能点名到段；
 *   - **规避**：会变的内容根本不该放前缀 —— 挪到尾部动态区（`user` 角色、不落库）。
 *
 * 端到端行为（真引擎 + ACP 插件 + mock provider 的位置对照实验）见
 * `packages/cli/src/cache-attribution.test.ts`。
 */

import { describe, it, expect } from 'bun:test'
import {
  buildSystemStabilityReport,
  renderDynamicBlock,
  systemSnapshotOf,
} from './index'

const snap = (parts: string[], at = 1000) => systemSnapshotOf(parts, at)

describe('buildSystemStabilityReport：段级归因', () => {
  it('无变化 ⇒ null（不制造"每轮都变了"的噪音）', () => {
    expect(buildSystemStabilityReport(snap(['A', 'B']), snap(['A', 'B'], 2000))).toBeNull()
  })

  it('**同长度**内容变化也能判出（只比长度或只比 id 的实现会漏）', () => {
    // 真实场景：`memory:3 条` → `memory:4 条`、`v1` → `v2` —— 字符数完全一样。
    // provider 按**字节**命中缓存，所以这是真失效；判据必须是内容指纹。
    const before = 'PROBE_R2'
    const after = 'PROBE_R3'
    expect(after).toHaveLength(before.length) // 前提：两份长度确实一样
    const r = buildSystemStabilityReport(snap(['base', before]), snap(['base', after], 2000))!
    expect(r.changedParts).toEqual([1])
    expect(r.addedParts).toEqual([])
    expect(r.removedParts).toEqual([])
    expect(r.details[0]).toContain('第 2 段变化')
    expect(r.details[0]).toContain(`${before.length} → ${after.length}`)
  })

  it('新增段与移除段分开报（不是笼统的"变了"）', () => {
    const r = buildSystemStabilityReport(snap(['base']), snap(['base', '新增的记忆段', '又一个'], 2000))!
    expect(r.addedParts).toEqual([1, 2])
    expect(r.changedParts).toEqual([])
    expect(r.details[0]).toContain('第 2 段新增')
    expect(r.details[0]).toContain('新增的记忆段')

    const r2 = buildSystemStabilityReport(snap(['base', 'a', 'b']), snap(['base'], 3000))!
    expect(r2.removedParts).toEqual([1, 2])
    expect(r2.details[0]).toContain('第 2 段移除')
  })

  it('多段同时变化时逐段列出（system 区是多插件往同一数组 push 拼的）', () => {
    const r = buildSystemStabilityReport(
      snap(['base', 'memory:3 条', 'roster: reader'],
      ), snap(['base', 'memory:4 条', 'roster: reader, reviewer'], 2000))!
    expect(r.changedParts).toEqual([1, 2])
    expect(r.details).toHaveLength(2)
    expect(r.parts).toBe(3)
    expect(r.prevParts).toBe(3)
    expect(r.prevAt).toBe(1000)
    expect(r.at).toBe(2000)
  })

  it('首行预览给**新旧两份**：既说清变了多少，也指认变成哪一段（谁 push 的）', () => {
    const long = `=== 会话压缩记忆（已被截断/压缩的对话历史摘要）===\n${'x'.repeat(5000)}`
    const r = buildSystemStabilityReport(snap([long]), snap(['换个内容'], 2000))!
    expect(r.details[0]).toContain('=== 会话压缩记忆')
    expect(r.details[0]).toContain('→ 「换个内容」')
    expect(r.details[0]).toContain(`${long.length} → 4`)
    // 预览必须截断，不能把整段塞进日志（真实段落动辄几千字符）
    expect(r.details[0]!.length).toBeLessThan(220)
  })

  it('只改了段内后文（首行相同）时预览只留一份，不制造噪音', () => {
    const head = '# MCP Resources\n'
    const r = buildSystemStabilityReport(
      snap([`${head}uri:a`]), snap([`${head}uri:b`], 2000),
    )!
    expect(r.details[0]).toContain('# MCP Resources')
    expect(r.details[0]!.match(/# MCP Resources/g)).toHaveLength(1)
  })

  it('前导空行的段也能取到有意义的首行（预览跳过空行）', () => {
    const r = buildSystemStabilityReport(snap(['']), snap(['\n\n# MCP Resources\n内容'], 2000))!
    expect(r.details[0]).toContain('# MCP Resources')
  })
})

describe('renderDynamicBlock：尾部动态块', () => {
  it('带标记包裹多个片段（不加标记模型会把它当成用户发言）', () => {
    const text = renderDynamicBlock(['记忆更新了', '# MCP Resources\nx'])
    expect(text.startsWith('<host-context')).toBe(true)
    expect(text.endsWith('</host-context>')).toBe(true)
    expect(text).toContain('记忆更新了')
    expect(text).toContain('# MCP Resources')
    expect(text).toContain('非用户发言')
  })
})
