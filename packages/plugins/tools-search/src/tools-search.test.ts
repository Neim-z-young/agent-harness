import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listDirTool,
  grepFileTool,
  createGrepFileTool,
  searchTools,
  createToolsSearchPlugin,
} from './index'
import { DENIAL_HOW_PREFIX } from '@harness/isolation'
import type { ToolContext } from '@harness/tool'

let dir: string
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-search-test-'))
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

  it('非法正则自动退化为字面量搜索，并在输出里说明（不再硬报错）', async () => {
    // 真机事故：模型要搜 Markdown 图片语法 `![`，被当正则编译必失败（未闭合字符类）。
    // 现在必须"能出结果 + 说明改了口径"，既不静默也不让整轮报废。
    writeFileSync(join(dir, 'a.md'), 'see ![x](y.png)\nsee ![z](w.png)\nplain')

    const res = await grepFileTool.call!({ pattern: '![', path: 'a.md' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(2)
    expect(res.output!.mode).toBe('literal')
    expect(res.output!.notify).toContain('字面量')
  })

  it('literal:true 时不解释元字符，且输出标注 mode=literal', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a.c\naXc\nabc')

    const asRegex = await grepFileTool.call!({ pattern: 'a.c', path: 'a.txt' } as any, ctx)
    expect(asRegex.ok).toBe(true)
    if (!asRegex.ok) return
    expect(asRegex.output!.count).toBe(3) // 正则：`.` 匹配任意字符
    expect(asRegex.output!.mode).toBeUndefined()

    const asLiteral = await grepFileTool.call!({ pattern: 'a.c', path: 'a.txt', literal: true } as any, ctx)
    expect(asLiteral.ok).toBe(true)
    if (!asLiteral.ok) return
    expect(asLiteral.output!.count).toBe(1) // 字面量：只命中真正的 "a.c"
    expect(asLiteral.output!.mode).toBe('literal')
    expect(asLiteral.output!.notify).toBeUndefined() // 显式 literal 不是"退化"，无需说明
  })

  it('默认区分大小写（与 schema 声明一致）', async () => {
    writeFileSync(join(dir, 'a.txt'), 'Hello\nhello')

    const res = await grepFileTool.call!({ pattern: 'hello', path: 'a.txt' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(1)
  })
})

describe('路径边界（P0-4/P0-5/P3-1：realpath 版 + 与全仓唯一一份）', () => {
  it('绝对路径越界 ⇒ PATH_OUTSIDE_CWD', async () => {
    const a = await listDirTool.call!({ path: '/etc' } as any, ctx)
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error!.code).toBe('PATH_OUTSIDE_CWD')
    const b = await grepFileTool.call!({ pattern: 'x', path: '/etc/hosts' } as any, ctx)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.error!.code).toBe('PATH_OUTSIDE_CWD')
  })

  it('★经符号链接逃逸 ⇒ 被拒（字符串判定会放行，realpath 判定挡住）', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'harness-search-out-'))
    try {
      writeFileSync(join(outside, 'linked-out.txt'), 'SEARCH_ME')
      symlinkSync(outside, join(dir, 'up'))
      const a = await listDirTool.call!({ path: 'up' } as any, ctx)
      expect(a.ok).toBe(false)
      if (!a.ok) expect(a.error!.code).toBe('PATH_OUTSIDE_CWD')
      const b = await grepFileTool.call!({ pattern: 'SEARCH_ME', path: 'up/linked-out.txt' } as any, ctx)
      expect(b.ok).toBe(false)
      if (!b.ok) expect(b.error!.code).toBe('PATH_OUTSIDE_CWD')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})


describe('读侧敏感文件默认拒绝（P0-3）', () => {
  it('grep_file 直接指到 .env ⇒ 拒绝', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    const res = await grepFileTool.call!({ pattern: 'SECRET', path: '.env' } as any, ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error!.code).toBe('SANDBOX_READ_DENIED')
  })

  it('P2-2：两条拒绝都带「怎么改」（与 tools-builtin 同一份口径）', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    const denied = await grepFileTool.call!({ pattern: 'SECRET', path: '.env' } as any, ctx)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error!.message).toContain(DENIAL_HOW_PREFIX)

    const outside = await grepFileTool.call!({ pattern: 'x', path: '/etc/hosts' } as any, ctx)
    expect(outside.ok).toBe(false)
    if (!outside.ok) expect(outside.error!.message).toContain(DENIAL_HOW_PREFIX)
  })

  it('★递归遍历时跳过敏感文件（只查入参路径挡不住"顺带读到"）', async () => {
    // `id_rsa` 不是点开头 ⇒ 会被正常遍历到，因此能证明是**敏感清单**在拦，而不是"点文件本来就不搜"
    writeFileSync(join(dir, 'id_rsa'), 'NEEDLE here')
    writeFileSync(join(dir, 'a.ts'), 'const NEEDLE = 1')
    const res = await grepFileTool.call!({ pattern: 'NEEDLE', path: '.' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.matches.map((m) => m.relativePath)).toEqual(['a.ts'])
    // 普通文件仍在正常命中
    expect(res.output!.count).toBe(1)
  })

  it('readDeny:false ⇒ 关闭这道闸', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    const tool = createGrepFileTool({ readDeny: false })
    const res = await tool.call!({ pattern: 'SECRET', path: '.env' } as any, ctx)
    expect(res.ok).toBe(true)
  })
})

describe('插件集成', () => {
  it('searchTools 导出包含两个工具', () => {
    expect(searchTools.map((t) => t.id).sort()).toEqual(['grep_file', 'list_dir'])
  })

  it('createToolsSearchPlugin({ toolIds }) 只注入指定工具', () => {
    const plugin = createToolsSearchPlugin({ toolIds: ['list_dir'] })
    expect(plugin.id).toBe('tools.search')
  })
})
