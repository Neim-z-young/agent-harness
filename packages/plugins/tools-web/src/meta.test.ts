import { describe, expect, it } from 'bun:test'
import { WEB_TOOL_META } from './meta'

describe('tools-web 静态元信息（多级加载 L1）', () => {
  it('覆盖 web_fetch，网络权限键且非只读', () => {
    const [m] = WEB_TOOL_META
    expect(m.id).toBe('web_fetch')
    expect(m.description?.length).toBeGreaterThan(0)
    expect(m.isReadOnly).toBe(false)
    expect(m.isDestructive).toBe(false)
    expect(m.permissionKey).toBe('network')
  })
})