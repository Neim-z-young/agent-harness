import { describe, expect, it } from 'bun:test'
import { SEARCH_TOOL_META, toolMetaSource } from './meta'

describe('tools-search 静态元信息（多级加载 L1）', () => {
  it('覆盖 list_dir / grep_file，描述与权限键非空且只读', () => {
    const ids = new Set(SEARCH_TOOL_META.map((m) => m.id))
    expect(ids.has('list_dir') && ids.has('grep_file')).toBe(true)
    for (const m of SEARCH_TOOL_META) {
      expect(m.description?.length).toBeGreaterThan(0)
      expect(m.permissionKey).toBe('read')
      expect(m.isReadOnly).toBe(true)
    }
  })

  it('toolMetaSource 实现 ToolMetaSource 抽象契约，list() 与元信息一致', () => {
    expect(toolMetaSource.id).toBe('tools-search')
    expect(toolMetaSource.list()).toEqual(SEARCH_TOOL_META)
  })
})