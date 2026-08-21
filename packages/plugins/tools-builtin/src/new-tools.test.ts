import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { editFileTool } from './index'
import type { ToolContext } from '@harness/tool'

let dir: string
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-edit-test-'))
  ctx = {
    cwd: dir,
    sessionId: 's1',
    agentId: 'default',
    messageId: 'm1',
    toolUseId: 'tu1',
    signal: new AbortController().signal,
    variables: {},
    requestPermission: async () => ({ behavior: 'allow' } as any),
  }
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('editFileTool', () => {
  it('精确替换单处匹配', async () => {
    const content = 'line1\nold text\nline3'
    writeFileSync(join(dir, 'a.txt'), content)

    const res = await editFileTool.call!({
      path: 'a.txt',
      oldString: 'old text',
      newString: 'new text',
    } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.replacements).toBe(1)
    const after = await import('node:fs/promises').then((m) => m.readFile(join(dir, 'a.txt'), 'utf-8'))
    expect(after).toBe('line1\nnew text\nline3')
  })

  it('多行替换', async () => {
    writeFileSync(join(dir, 'a.txt'), 'function foo() {\n  return 1\n}\n')

    const res = await editFileTool.call!({
      path: 'a.txt',
      oldString: 'function foo() {\n  return 1\n}',
      newString: 'function foo() {\n  return 2\n}',
    } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.replacements).toBe(1)
    const after = await import('node:fs/promises').then((m) => m.readFile(join(dir, 'a.txt'), 'utf-8'))
    expect(after).toContain('return 2')
    expect(after).not.toContain('return 1')
  })

  it('replaceAll=true 替换所有匹配', async () => {
    writeFileSync(join(dir, 'a.txt'), 'foo bar foo baz foo')

    const res = await editFileTool.call!({
      path: 'a.txt',
      oldString: 'foo',
      newString: 'qux',
      replaceAll: true,
    } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.replacements).toBe(3)
    const after = await import('node:fs/promises').then((m) => m.readFile(join(dir, 'a.txt'), 'utf-8'))
    expect(after).toBe('qux bar qux baz qux')
  })

  it('多处匹配但未设 replaceAll → 返回 MULTIPLE_MATCHES 错误', async () => {
    writeFileSync(join(dir, 'a.txt'), 'foo bar foo baz')

    const res = await editFileTool.call!({
      path: 'a.txt',
      oldString: 'foo',
      newString: 'qux',
    } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('MULTIPLE_MATCHES')
  })

  it('未找到匹配返回错误', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello world')

    const res = await editFileTool.call!({
      path: 'a.txt',
      oldString: 'not-exist',
      newString: 'something',
    } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('NOT_FOUND')
  })

  it('oldString === newString → 返回 NO_CHANGE 错误', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello')

    const res = await editFileTool.call!({
      path: 'a.txt',
      oldString: 'hello',
      newString: 'hello',
    } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('NO_CHANGE')
  })

  it('安全声明：isReadOnly=false, isDestructive=false', () => {
    expect(editFileTool.isReadOnly?.()).toBe(false)
    expect(editFileTool.isDestructive?.()).toBe(false)
    expect(editFileTool.isConcurrencySafe?.()).toBe(false)
  })
})
