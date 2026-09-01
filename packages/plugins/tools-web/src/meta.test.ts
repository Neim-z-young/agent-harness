import { describe, expect, it } from 'bun:test'
import { WEB_TOOL_META, toolMetaSource } from './meta'

describe('tools-web 静态元信息（多级加载 L1）', () => {
  it('覆盖 web_fetch，网络权限键且非只读', () => {
    const [m] = WEB_TOOL_META
    expect(m.id).toBe('web_fetch')
    expect(m.description?.length).toBeGreaterThan(0)
    expect(m.isReadOnly).toBe(false)
    expect(m.isDestructive).toBe(false)
    expect(m.permissionKey).toBe('network')
  })

  it('toolMetaSource 实现 ToolMetaSource 抽象契约，list() 与元信息一致', () => {
    expect(toolMetaSource.id).toBe('tools-web')
    expect(toolMetaSource.list()).toEqual(WEB_TOOL_META)
  })
})