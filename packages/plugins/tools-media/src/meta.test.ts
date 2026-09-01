import { describe, expect, it } from 'bun:test'
import { MEDIA_TOOL_META } from './meta'

describe('tools-media 静态元信息（多级加载 L1）', () => {
  it('覆盖 view_image，只读且权限键 read', () => {
    const [m] = MEDIA_TOOL_META
    expect(m.id).toBe('view_image')
    expect(m.description?.length).toBeGreaterThan(0)
    expect(m.isReadOnly).toBe(true)
    expect(m.isConcurrencySafe).toBe(true)
    expect(m.permissionKey).toBe('read')
  })
})