import { describe, expect, it } from 'bun:test'
import { BUILTIN_TOOL_META, builtinToolMetas, toolMetaSource } from './meta'

describe('tools-builtin 静态元信息（多级加载 L1）', () => {
  it('登记表覆盖全部内置原语工具', () => {
    expect(Object.keys(BUILTIN_TOOL_META).sort()).toEqual(['bash', 'edit_file', 'read_file', 'write_file'])
  })

  it('每条元信息含非空 id 与描述', () => {
    for (const m of builtinToolMetas) {
      expect(m.id.length).toBeGreaterThan(0)
      expect(m.description?.length).toBeGreaterThan(0)
    }
  })

  it('builtinToolMetas 与登记表一致（长度稳定，便于一次性登记）', () => {
    expect(builtinToolMetas.length).toBe(Object.keys(BUILTIN_TOOL_META).length)
    expect(new Set(builtinToolMetas.map((m) => m.id)).size).toBe(builtinToolMetas.length)
  })

  it('为只读/破坏性/权限键声明静态安全字段', () => {
    const bash = BUILTIN_TOOL_META['bash']!
    expect(bash.isReadOnly).toBe(false)
    expect(bash.isDestructive).toBe(true)
    expect(bash.permissionKey).toBe('bash')

    const read = BUILTIN_TOOL_META['read_file']!
    expect(read.isReadOnly).toBe(true)
    expect(read.permissionKey).toBe('read')
  })

  it('toolMetaSource 实现 ToolMetaSource 抽象契约，list() 与元信息一致', () => {
    expect(toolMetaSource.id).toBe('tools-builtin')
    expect(toolMetaSource.list()).toEqual(builtinToolMetas)
  })
})