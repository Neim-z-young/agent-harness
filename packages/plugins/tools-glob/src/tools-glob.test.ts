import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  globTool,
  globTools,
  createToolsGlobPlugin,
} from './index'
import type { ToolContext } from '@harness/tool'

let dir: string
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-glob-test-'))
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

describe('globTool', () => {
  it('基本通配符匹配 *.ts', async () => {
    writeFileSync(join(dir, 'a.ts'), '')
    writeFileSync(join(dir, 'b.ts'), '')
    writeFileSync(join(dir, 'c.md'), '')
    writeFileSync(join(dir, 'd.tsx'), '')

    const res = await globTool.call!({ pattern: '*.ts' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(2)
    expect(res.output!.entries.map((e) => e.relativePath).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('** 递归深层匹配', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'root.ts'), '')
    writeFileSync(join(dir, 'src', 'index.ts'), '')
    writeFileSync(join(dir, 'src', 'lib', 'util.ts'), '')
    writeFileSync(join(dir, 'README.md'), '')

    const res = await globTool.call!({ pattern: '**/*.ts' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const rels = res.output!.entries.map((e) => e.relativePath).sort()
    expect(rels).toEqual(['root.ts', 'src/index.ts', 'src/lib/util.ts'])
  })

  it('! 前缀排除模式', async () => {
    writeFileSync(join(dir, 'keep.ts'), '')
    writeFileSync(join(dir, 'skip.test.ts'), '')
    writeFileSync(join(dir, 'main.ts'), '')

    const res = await globTool.call!({ pattern: ['**/*.ts', '!**/*.test.ts'] } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const rels = res.output!.entries.map((e) => e.relativePath).sort()
    expect(rels).toEqual(['keep.ts', 'main.ts'])
  })

  it('exclude 参数便捷字段', async () => {
    writeFileSync(join(dir, 'a.ts'), '')
    writeFileSync(join(dir, 'a.spec.ts'), '')

    const res = await globTool.call!({
      pattern: '*.ts',
      exclude: ['*.spec.ts'],
    } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.entries.map((e) => e.relativePath)).toEqual(['a.ts'])
  })

  it('文件大小过滤', async () => {
    writeFileSync(join(dir, 'small.ts'), 'x'.repeat(100))
    writeFileSync(join(dir, 'big.ts'), 'x'.repeat(2000))

    const res = await globTool.call!({
      pattern: '*.ts',
      minSizeBytes: 1000,
    } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(1)
    expect(res.output!.entries[0].relativePath).toBe('big.ts')

    const res2 = await globTool.call!({
      pattern: '*.ts',
      maxSizeBytes: 500,
    } as any, ctx)
    expect(res2.ok).toBe(true)
    if (!res2.ok) return
    expect(res2.output!.count).toBe(1)
    expect(res2.output!.entries[0].relativePath).toBe('small.ts')
  })

  it('默认忽略隐藏文件 + includeHidden=true 可启用', async () => {
    writeFileSync(join(dir, '.env'), '')
    writeFileSync(join(dir, 'a.ts'), '')

    const r1 = await globTool.call!({ pattern: '*' } as any, ctx)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.output!.entries.map((e) => e.name)).not.toContain('.env')

    const r2 = await globTool.call!({ pattern: '*', includeHidden: true } as any, ctx)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.output!.entries.some((e) => e.name === '.env')).toBe(true)
  })

  it('路径超出 cwd 被拒绝', async () => {
    const res = await globTool.call!({ pattern: '*.ts', path: '/etc' } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('PATH_OUTSIDE_CWD')
  })

  it('非目录路径返回错误', async () => {
    writeFileSync(join(dir, 'a.ts'), '')
    const res = await globTool.call!({ pattern: '*.ts', path: 'a.ts' } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('NOT_A_DIR')
  })
})

describe('插件集成', () => {
  it('globTools 导出包含 glob', () => {
    expect(globTools.map((t) => t.id)).toEqual(['glob'])
  })
  it('createToolsGlobPlugin id', () => {
    expect(createToolsGlobPlugin().id).toBe('tools.glob')
  })
})
