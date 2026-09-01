import { describe, expect, it } from 'bun:test'
import { COMPUTER_USE_TOOL_META } from './meta'

describe('computer-use 静态元信息（多级加载 L1）', () => {
  it('覆盖全部 MCP 工具，id 前缀 mcp__computer-use__', () => {
    const names = ['check_permissions', 'list_apps', 'get_app_state', 'click', 'scroll', 'drag', 'type_text', 'press_key', 'perform_action', 'set_value', 'select_text']
    expect(COMPUTER_USE_TOOL_META.map((m) => m.id)).toEqual(names.map((n) => `mcp__computer-use__${n}`))
  })

  it('每条元信息含非空 id 与描述', () => {
    for (const m of COMPUTER_USE_TOOL_META) {
      expect(m.id.length).toBeGreaterThan(0)
      expect(m.description?.length).toBeGreaterThan(0)
    }
  })

  it('读取类为只读，交互类为可写且非并发；id 唯一', () => {
    const byId = new Map(COMPUTER_USE_TOOL_META.map((m) => [m.id, m]))
    expect(byId.size).toBe(COMPUTER_USE_TOOL_META.length)
    // 只读：纯查询
    for (const m of COMPUTER_USE_TOOL_META.filter((m) => m.permissionKey === 'read')) expect(m.isReadOnly).toBe(true)
    for (const m of COMPUTER_USE_TOOL_META.filter((m) => m.permissionKey === 'write')) expect(m.isReadOnly).toBe(false)
    // MCP 工具一律非并发安全（与 convertMcpToolToHarnessTool 的保守声明一致）
    for (const m of COMPUTER_USE_TOOL_META) expect(m.isConcurrencySafe).toBe(false)
  })
})