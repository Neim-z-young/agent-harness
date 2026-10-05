/**
 * 工具映射测试：`ToolRegistry → MCP 描述`、排除规则、名字反查、结果映射。
 */
import { describe, expect, it } from 'bun:test'
import { type Schema, ToolRegistry, defineTool, withJsonSchema } from '@harness/tool'
import {
  buildToolIndex,
  exposureName,
  isExcludedByDefault,
  jsonSchemaOf,
  listExposedTools,
  toMcpCallResult,
  toMcpToolDescriptor,
} from './tools'

function createSchema<T>(validator: (v: unknown) => T): Schema<T> {
  return {
    parse: (v) => validator(v),
    safeParse: (v) => {
      try {
        return { success: true, data: validator(v) }
      } catch (err) {
        return { success: false, error: err }
      }
    },
  }
}

const passthrough = (): Schema<Record<string, unknown>> =>
  createSchema<Record<string, unknown>>((v) => v as Record<string, unknown>)

function makeTool(id: string, extra: Record<string, unknown> = {}) {
  return defineTool({
    id,
    description: `${id} 的描述`,
    inputSchema: withJsonSchema(passthrough(), {
      type: 'object',
      properties: { path: { type: 'string', description: '路径' } },
      required: ['path'],
      additionalProperties: false,
    }),
    async call() {
      return { ok: true, output: 'done' }
    },
    ...extra,
  })
}

describe('toMcpToolDescriptor：Tool → MCP 描述', () => {
  it('名字直出（默认不加前缀）、描述原样透传', () => {
    const d = toMcpToolDescriptor(makeTool('read_file'))
    expect(d.name).toBe('read_file')
    expect(d.description).toBe('read_file 的描述')
  })

  it('inputSchema 直出 __jsonSchema，不重新推导（参数名/必填项都不丢）', () => {
    const d = toMcpToolDescriptor(makeTool('read_file'))
    expect(d.inputSchema).toEqual({
      type: 'object',
      properties: { path: { type: 'string', description: '路径' } },
      required: ['path'],
      additionalProperties: false,
    })
  })

  it('annotations Fail-Closed：未声明安全字段 ⇒ 都报 false（可能写、可能破坏）', () => {
    const d = toMcpToolDescriptor(makeTool('x'))
    expect(d.annotations).toEqual({ readOnlyHint: false, destructiveHint: false })
  })

  it('显式声明的安全字段透传（无入参调用）', () => {
    const d = toMcpToolDescriptor(makeTool('read_file', { isReadOnly: () => true, isDestructive: () => false }))
    expect(d.annotations?.readOnlyHint).toBe(true)
    expect(d.annotations?.destructiveHint).toBe(false)
  })

  it('prefix 生效且只作用于名字', () => {
    expect(toMcpToolDescriptor(makeTool('bash'), { prefix: 'h_' }).name).toBe('h_bash')
    expect(exposureName(makeTool('bash'), '')).toBe('bash')
  })
})

describe('暴露范围：排除集', () => {
  const registry = new ToolRegistry()
  registry.register(makeTool('read_file', { isReadOnly: () => true }))
  registry.register(makeTool('ask_user_question', { requiresUserInteraction: true }))
  registry.register(makeTool('mcp__other__tool'))
  registry.register(makeTool('write_file', { isDestructive: () => true }))

  it('内置排除规则：requiresUserInteraction 与 mcp__ 前缀', () => {
    expect(isExcludedByDefault(makeTool('ask_user_question', { requiresUserInteraction: true }))).toBe(true)
    expect(isExcludedByDefault(makeTool('mcp__x__y'))).toBe(true)
    expect(isExcludedByDefault(makeTool('read_file'))).toBe(false)
  })

  it('listExposedTools 只留可暴露的（顺序保持注册顺序）', () => {
    expect(listExposedTools(registry).map((t) => t.id)).toEqual(['read_file', 'write_file'])
  })

  it('自定义 exclude 与内置规则取或', () => {
    const kept = listExposedTools(registry, { exclude: (t) => t.id === 'write_file' })
    expect(kept.map((t) => t.id)).toEqual(['read_file'])
  })

  it('jsonSchemaOf 对未注入 schema 的工具给空对象 schema（不是 undefined）', () => {
    const bare = defineTool({
      id: 'bare',
      description: 'b',
      inputSchema: createSchema<unknown>((v) => v),
      async call() {
        return { ok: true, output: null }
      },
    })
    expect(jsonSchemaOf(bare)).toEqual({ type: 'object', properties: {} })
  })
})

describe('buildToolIndex：描述列表与名字反查同源', () => {
  const registry = new ToolRegistry()
  registry.register(makeTool('read_file', { isReadOnly: () => true }))
  registry.register(makeTool('mcp__other__tool'))

  it('byName 与 descriptors 一一对应（过滤规则只跑一次）', () => {
    const idx = buildToolIndex(registry, { prefix: 'p_' })
    expect(idx.descriptors.map((d) => d.name)).toEqual(['p_read_file'])
    expect([...idx.byName.keys()]).toEqual(['p_read_file'])
    expect(idx.byName.get('p_read_file')?.id).toBe('read_file')
    // 被排除的工具不在任何一侧
    expect(idx.byName.has('p_mcp__other__tool')).toBe(false)
    expect(idx.descriptors.some((d) => d.name.includes('mcp__'))).toBe(false)
  })
})

describe('toMcpCallResult：ToolResult → MCP 结果', () => {
  it('字符串 output 直接用，不加引号', () => {
    expect(toMcpCallResult({ ok: true, output: 'hello' })).toEqual({
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    })
  })

  it('对象 output 序列化', () => {
    const r = toMcpCallResult({ ok: true, output: { a: 1 } })
    expect(r.content[0]!.text).toContain('"a": 1')
    expect(r.isError).toBe(false)
  })

  it('output 为 undefined 时给 null 而不是字符串 "undefined"', () => {
    expect(toMcpCallResult({ ok: true }).content[0]!.text).toBe('null')
  })

  it('error 带 code 时前缀出来；无 error 时给兜底文案', () => {
    const withCode = toMcpCallResult({ ok: false, error: { message: '拒绝', code: 'PERMISSION_DENIED' } })
    expect(withCode.isError).toBe(true)
    expect(withCode.content[0]!.text).toBe('[PERMISSION_DENIED] 拒绝')

    expect(toMcpCallResult({ ok: false }).content[0]!.text).toBe('工具执行失败')
  })
})
