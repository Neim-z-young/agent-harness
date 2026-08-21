import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listDirTool,
  grepFileTool,
  editFileTool,
} from './index'
import type { ToolContext } from '@harness/tool'

let dir: string
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-tools-test-'))
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

describe('listDirTool', () => {
  it('列出目录内容（默认不递归、不显示隐藏文件）', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello')
    writeFileSync(join(dir, 'b.ts'), 'world')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, '.hidden'), 'secret')

    const res = await listDirTool.call!({ path: '.' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const names = res.output!.entries.map((e) => e.name)
    expect(names).toContain('a.txt')
    expect(names).toContain('b.ts')
    expect(names).toContain('sub')
    expect(names).not.toContain('.hidden')
    expect(res.output!.count).toBe(3)
  })

  it('递归列出（recursive=true）', async () => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'c.txt'), 'nested')
    writeFileSync(join(dir, 'root.txt'), 'root')

    const res = await listDirTool.call!({ path: '.', recursive: true } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBeGreaterThanOrEqual(3)
    const relPaths = res.output!.entries.map((e) => e.relativePath)
    expect(relPaths).toContain('root.txt')
    expect(relPaths).toContain('sub/c.txt')
  })

  it('显示隐藏文件（showHidden=true）', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET=xxx')
    writeFileSync(join(dir, 'a.txt'), 'hello')

    const res = await listDirTool.call!({ path: '.', showHidden: true } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const names = res.output!.entries.map((e) => e.name)
    expect(names).toContain('.env')
  })

  it('路径不存在返回错误', async () => {
    const res = await listDirTool.call!({ path: 'not-exist' } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('DIR_NOT_FOUND')
  })

  it('路径是文件返回错误', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello')
    const res = await listDirTool.call!({ path: 'a.txt' } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('NOT_A_DIR')
  })

  it('安全声明：isReadOnly=true, isConcurrencySafe=true', () => {
    expect(listDirTool.isReadOnly?.()).toBe(true)
    expect(listDirTool.isConcurrencySafe?.()).toBe(true)
  })
})

describe('grepFileTool', () => {
  it('在单个文件中搜索', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello world\nfoo bar\nhello again')

    const res = await grepFileTool.call!({ pattern: 'hello', path: 'a.txt' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(2)
    expect(res.output!.matches[0].line).toBe(1)
    expect(res.output!.matches[1].line).toBe(3)
    expect(res.output!.filesSearched).toBe(1)
  })

  it('在目录中递归搜索 + glob 过滤', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1\nexport const y = 2')
    writeFileSync(join(dir, 'b.md'), '# export\nexport const z = 3')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'c.ts'), 'export const w = 4')

    const res = await grepFileTool.call!({
      pattern: 'export',
      path: '.',
      include: '*.ts',
    } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBeGreaterThanOrEqual(3)
    expect(res.output!.filesSearched).toBeGreaterThanOrEqual(2)
    const relPaths = res.output!.matches.map((m) => m.relativePath)
    expect(relPaths.some((p) => p.includes('a.ts'))).toBe(true)
    expect(relPaths.some((p) => p.includes('c.ts'))).toBe(true)
    expect(relPaths.some((p) => p.includes('b.md'))).toBe(false)
  })

  it('大小写不敏感搜索', async () => {
    writeFileSync(join(dir, 'a.txt'), 'Hello\nHELLO\nhello')

    const res = await grepFileTool.call!({
      pattern: 'hello',
      path: 'a.txt',
      caseSensitive: false,
    } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(3)
  })

  it('使用正则表达式搜索', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1\nconst y = 2\nconst z = 3')

    const res = await grepFileTool.call!({
      pattern: 'const (\\w+)',
      path: 'a.ts',
    } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(3)
    expect(res.output!.matches[0].match).toBe('x')
    expect(res.output!.matches[1].match).toBe('y')
  })

  it('无匹配时返回空列表', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello world')

    const res = await grepFileTool.call!({ pattern: 'nope', path: 'a.txt' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(0)
    expect(res.output!.matches).toEqual([])
  })

  it('无效正则返回错误', async () => {
    const res = await grepFileTool.call!({ pattern: '[invalid', path: '.' } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('INVALID_REGEX')
  })
})

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
