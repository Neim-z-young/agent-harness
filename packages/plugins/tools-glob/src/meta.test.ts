import { describe, expect, it } from 'bun:test'
import { GLOB_TOOL_META } from './meta'

describe('tools-glob 静态元信息（多级加载 L1）', () => {
  it('覆盖 glob，只读且权限键 read', () => {
    const [m] = GLOB_TOOL_META
    expect(m.id).toBe('glob')
    expect(m.description?.length).toBeGreaterThan(0)
    expect(m.isReadOnly).toBe(true)
    expect(m.isConcurrencySafe).toBe(true)
    expect(m.permissionKey).toBe('read')
  })
})