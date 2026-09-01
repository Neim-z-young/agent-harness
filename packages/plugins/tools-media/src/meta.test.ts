import { describe, expect, it } from 'bun:test'
import { MEDIA_TOOL_META, toolMetaSource } from './meta'

describe('tools-media 静态元信息（多级加载 L1）', () => {
  it('覆盖 view_image，只读且权限键 read', () => {
    const [m] = MEDIA_TOOL_META
    expect(m.id).toBe('view_image')
    expect(m.description?.length).toBeGreaterThan(0)
    expect(m.isReadOnly).toBe(true)
    expect(m.isConcurrencySafe).toBe(true)
    expect(m.permissionKey).toBe('read')
  })

  it('toolMetaSource 实现 ToolMetaSource 抽象契约，list() 与元信息一致', () => {
    expect(toolMetaSource.id).toBe('tools-media')
    expect(toolMetaSource.list()).toEqual(MEDIA_TOOL_META)
  })
})