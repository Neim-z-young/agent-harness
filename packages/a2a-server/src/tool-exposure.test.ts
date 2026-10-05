/**
 * 工具暴露面（P3-D，设计稿 §14）纯函数用例。
 *
 * 这一层刻意没有 Host / HTTP / vscode ⇒ 描述符形状、只读判定、排序、结果归一
 * 全部在这里钉死；"接到真实 Host 上跑通"留给 `control.test.ts`。
 */
import { describe, expect, it } from 'bun:test'
import { defineTool } from '@harness/core'
import { fromJsonSchema } from '@harness/tool'
import type { Tool } from '@harness/tool'
import { listToolDescriptors, toToolCallOutcome, toToolDescriptor } from './tool-exposure'

/** 造一个最小工具：`readOnly` / `permission` 按需给，schema 按 `withJsonSchema` 决定走直出还是兜底 */
function makeTool(
  id: string,
  opts: { readOnly?: boolean | (() => boolean); permission?: boolean; withJsonSchema?: boolean } = {},
): Tool {
  const ro = opts.readOnly
  return defineTool({
    id,
    description: `${id} 的描述`,
    inputSchema: opts.withJsonSchema
      ? fromJsonSchema<{ path: string }>({
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        })
      : ({ parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true as const, data: v }) } as never),
    ...(ro === undefined ? {} : { isReadOnly: typeof ro === 'function' ? (ro as () => boolean) : () => ro }),
    ...(opts.permission ? { permission: { key: id, extractPatterns: () => [] } } : {}),
    async call() {
      return { ok: true as const, output: `${id}:ok` }
    },
  })
}

describe('工具暴露面：描述符', () => {
  it('名字/描述/schema 直出，不加任何前缀（前缀是客户端的命名空间问题）', () => {
    const d = toToolDescriptor(makeTool('read_file', { readOnly: true, withJsonSchema: true }))
    expect(d.name).toBe('read_file')
    expect(d.description).toBe('read_file 的描述')
    expect(d.inputSchema).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })
  })

  it('没有 __jsonSchema 的工具回退成空对象 schema（而不是 undefined）', () => {
    const d = toToolDescriptor(makeTool('legacy_tool'))
    expect(d.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  it('只读判定 Fail-Closed：未声明 ⇒ false', () => {
    expect(toToolDescriptor(makeTool('x')).readOnly).toBe(false)
  })

  it('只读判定 Fail-Closed：**求值抛错 ⇒ false**（isReadOnly 不带入参调用，读入参的实现会炸）', () => {
    const boom = makeTool('boom', {
      readOnly: () => {
        throw new Error('读入参炸了')
      },
    })
    expect(toToolDescriptor(boom).readOnly).toBe(false)
  })

  it('只读判定：显式 true 才为 true', () => {
    expect(toToolDescriptor(makeTool('r', { readOnly: true })).readOnly).toBe(true)
  })

  it('requiresConfirmation 与**权限链启动条件**同判据：只看是否声明 permission', () => {
    expect(toToolDescriptor(makeTool('w', { permission: true })).requiresConfirmation).toBe(true)
    // 只读但声明了 permission（真实存在：`read_file` 的 permission.key = 'read'）**照样要确认**——
    // 权限链的启动条件与只读无关（`tool/src/index.ts:1338`），默认规则 `{ '*': 'ask' }` 下它确实会问。
    // 这里若跟着 readOnly 一起放宽，调用方就不会弹框、不带 approve ⇒ 调用被静默拒绝。
    expect(toToolDescriptor(makeTool('r', { permission: true, readOnly: true })).requiresConfirmation).toBe(true)
    // 没声明 permission ⇒ 权限链压根不启动，也就无从确认（这条是真的不需要弹）
    expect(toToolDescriptor(makeTool('w2')).requiresConfirmation).toBe(false)
    expect(toToolDescriptor(makeTool('r2', { readOnly: true })).requiresConfirmation).toBe(false)
  })

  it('列表按名字排序 —— 顺序稳定，客户端 diff 不会误判"工具集变了"', () => {
    const list = listToolDescriptors([makeTool('zeta'), makeTool('alpha'), makeTool('mid')])
    expect(list.map((t) => t.name)).toEqual(['alpha', 'mid', 'zeta'])
  })
})

describe('工具暴露面：结果归一', () => {
  it('成功：带出 output 与 durationMs', () => {
    expect(toToolCallOutcome({ ok: true, output: 'hi', meta: { durationMs: 12 } })).toEqual({
      ok: true,
      output: 'hi',
      durationMs: 12,
    })
  })

  it('成功但没有 meta.durationMs：**不出现该键**（不是 durationMs: undefined）', () => {
    const out = toToolCallOutcome({ ok: true, output: 'hi' })
    expect(out).toEqual({ ok: true, output: 'hi' })
    expect('durationMs' in out).toBe(false)
  })

  it('失败：带出 message 与 code（权限拒绝的 code 由 normalizeToolError 给）', () => {
    expect(toToolCallOutcome({ ok: false, error: { message: '权限被拒绝：…', code: 'PERMISSION_DENIED' } })).toEqual({
      ok: false,
      error: { message: '权限被拒绝：…', code: 'PERMISSION_DENIED' },
    })
  })

  it('失败但没有 message/code：给出兜底文案，且不伪造 code', () => {
    const out = toToolCallOutcome({ ok: false })
    expect(out).toEqual({ ok: false, error: { message: '工具执行失败' } })
    expect('code' in (out.error ?? {})).toBe(false)
  })
})
