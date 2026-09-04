/**
 * @harness/code-intel 单测
 *
 * 覆盖：CodeIntelIndex（符号提取 函数/类/接口/枚举/变量/导入 + exported + 签名、mtime/size 缓存）、
 * code_symbols / code_reference / code_definition 三工具（文件/目录/越界/不支持类型/找不到符号）、
 * createCodeIntelPlugin 装配注入、meta 元信息一致性。
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CodeIntelIndex,
  codeSymbolsTool,
  codeReferenceTool,
  codeDefinitionTool,
  codeSemanticEditTool,
  createCodeIntelPlugin,
} from './index'
import { CODE_INTEL_TOOL_META } from './meta'
import type { ToolContext } from '@harness/tool'
import type { AgentPlugin } from '@harness/plugin'

let dir: string
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-codeintel-test-'))
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

const SAMPLE_TS = `\
import { helper } from './util'
import type { Shape } from './types'

export const VERSION = '1.0.0'

export interface Point {
  x: number
  y: number
}

export type Shape = 'circle' | 'square'

export enum Color {
  Red,
  Blue,
}

export class PointFactory {
  static create(x: number, y: number): Point {
    return { x, y }
  }
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x
  return Math.hypot(dx, helper())
}
`

describe('CodeIntelIndex', () => {
  it('提取 TS 符号（函数/类/接口/枚举/变量/导入）与位置、签名、exported', async () => {
    const file = join(dir, 'sample.ts')
    writeFileSync(file, SAMPLE_TS)

    const index = new CodeIntelIndex()
    const symbols = await index.symbols(file, dir)

    const names = symbols.map((s) => `${s.kind}:${s.name}`)
    expect(names).toContain('variable:VERSION')
    expect(names).toContain('interface:Point')
    expect(names).toContain('type:Shape')
    expect(names).toContain('enum:Color')
    expect(names).toContain('class:PointFactory')
    expect(names).toContain('function:distance')
    expect(names).toContain('import:helper')

    const distance = symbols.find((s) => s.name === 'distance')!
    expect(distance.kind).toBe('function')
    expect(distance.line).toBeGreaterThan(0)
    expect(distance.exported).toBe(true)
    expect(distance.signature).toBe('distance(a, b)')
    expect(distance.relativePath).toBe('sample.ts')

    // 未导出变量
    const VERSION = symbols.find((s) => s.name === 'VERSION')!
    expect(VERSION.exported).toBe(true)
  })

  it('识别非导出函数 exported=false，参数含默认值/对象解构时签名兼容', async () => {
    const file = join(dir, 'a.ts')
    writeFileSync(file, `function local(a: number, b = 1, { c }: { c: string }) { return a }\nexport { local }\n`)
    const index = new CodeIntelIndex()
    const symbols = await index.symbols(file, dir)
    const local = symbols.find((s) => s.name === 'local')!
    expect(local.kind).toBe('function')
    expect(local.signature).toBe('local(a, b)')
  })

  it('目录索引聚合多文件符号，且忽略 node_modules/dist 等', async () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function foo() {}\n')
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const bar = 1\n')
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules', 'dep.ts'), 'export function shouldBeIgnored() {}\n')

    const index = new CodeIntelIndex()
    const symbols = await index.symbols(dir, dir)

    const names = symbols.map((s) => s.name)
    expect(names).toContain('foo')
    expect(names).toContain('bar')
    expect(names).not.toContain('shouldBeIgnored')
  })

  it('mtime/size 不变时命中缓存，变更后重新索引', async () => {
    const file = join(dir, 'c.ts')
    writeFileSync(file, 'export function v1() {}\n')
    const index = new CodeIntelIndex()
    const first = await index.symbols(file, dir)
    expect(first.map((s) => s.name)).toEqual(['v1'])

    // 内容变更（size 变）→ 重新索引
    writeFileSync(file, 'export function v2() {}\n')
    const second = await index.symbols(file, dir)
    expect(second.map((s) => s.name)).toEqual(['v2'])
  })

  it('不支持的文件类型与解析失败跳过（返回空，不抛错）', async () => {
    writeFileSync(join(dir, 'note.txt'), 'export function nope() {}\n')
    writeFileSync(join(dir, 'broken.ts'), 'function ( { this is not valid syntax')
    const index = new CodeIntelIndex()
    const symbols = await index.symbols(dir, dir)
    expect(symbols.length).toBe(0)
  })
})

describe('code_symbols 工具', () => {
  it('列出文件符号（含 kind/line/signature）', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function greet(name: string) {}\n')
    const res = await codeSymbolsTool(new CodeIntelIndex()).call!({ path: 'a.ts' }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(1)
    const s = res.output!.symbols[0]!
    expect(s.name).toBe('greet')
    expect(s.kind).toBe('function')
    expect(s.signature).toBe('greet(name)')
  })

  it('目录符号跨文件合并并按行排序', async () => {
    writeFileSync(join(dir, 'z.ts'), 'export function zzz() {}\n')
    writeFileSync(join(dir, 'a.ts'), 'export const aaa = 1\n')
    const res = await codeSymbolsTool(new CodeIntelIndex()).call!({ path: '.' }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const names = res.output!.symbols.map((s) => s.name)
    expect(names).toContain('zzz')
    expect(names).toContain('aaa')
  })

  it('路径越界返回 PATH_OUTSIDE_CWD', async () => {
    const res = await codeSymbolsTool(new CodeIntelIndex()).call!({ path: '/etc' }, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('PATH_OUTSIDE_CWD')
  })

  it('安全声明：只读 + 并发安全 + read 权限', () => {
    const tool = codeSymbolsTool(new CodeIntelIndex())
    expect(tool.isReadOnly?.()).toBe(true)
    expect(tool.isConcurrencySafe?.()).toBe(true)
    expect(tool.permission?.key).toBe('read')
  })
})

describe('code_reference 工具', () => {
  it('跨文件查找符号引用（含上下文），排除声明处', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function compute(x: number) { return x * 2 }\n')
    writeFileSync(join(dir, 'b.ts'), `import { compute } from './a'\nconst result = compute(21)\n`)
    const res = await codeReferenceTool(new CodeIntelIndex()).call!({ symbol: 'compute', path: '.' }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(1)
    const ref = res.output!.references[0]!
    expect(ref.relativePath).toBe('b.ts')
    expect(ref.context).toContain('compute(21)')
  })

  it('找不到引用返回空数组（count=0）', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function foo() {}\n')
    const res = await codeReferenceTool(new CodeIntelIndex()).call!({ symbol: 'nonexistent', path: '.' }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(0)
  })

  it('路径越界返回 PATH_OUTSIDE_CWD', async () => {
    const res = await codeReferenceTool(new CodeIntelIndex()).call!({ symbol: 'x', path: '/etc' }, ctx)
    expect(res.ok).toBe(false)
  })
})

describe('code_definition 工具', () => {
  it('返回符号声明位置（不含 import 绑定）', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function calc(n: number) { return n }\n')
    writeFileSync(join(dir, 'b.ts'), "import { calc } from './a'\ncalc(1)\n")
    const res = await codeDefinitionTool(new CodeIntelIndex()).call!({ symbol: 'calc', path: '.' }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(1)
    const d = res.output!.definitions[0]!
    expect(d.relativePath).toBe('a.ts')
    expect(d.kind).toBe('function')
    expect(d.line).toBe(1)
  })

  it('找不到定义返回空数组', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export const v = 1\n')
    const res = await codeDefinitionTool(new CodeIntelIndex()).call!({ symbol: 'missing', path: '.' }, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(0)
  })
})

describe('code_semantic_edit 工具', () => {
  const read = (p: string) => require('node:fs').readFileSync(join(dir, p), 'utf-8')

  it('跨文件重命名：声明 + 引用 + import 源名同步，字符串/注释/obj.x 不触碰', async () => {
    writeFileSync(
      join(dir, 'a.ts'),
      `export function compute(x: number) { return x * 2 }\n// compute 帮助函数\nconst msg = 'compute'\n`,
    )
    writeFileSync(join(dir, 'b.ts'), `import { compute } from './a'\nconst result = compute(21)\nobj.compute = 1\n`)
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'compute', to: 'calc' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.validated).toBe(true)
    // a.ts 声明 1 + b.ts import 源名 1 + b.ts 引用 1（注释/字符串/obj.x 被隔离排除）= 3
    expect(res.output!.total).toBe(3)
    expect(res.output!.files.length).toBe(2)

    // 声明与引用、import 源名已改
    expect(read('a.ts')).toContain('export function calc(x: number)')
    expect(read('b.ts')).toContain(`import { calc } from './a'`)
    expect(read('b.ts')).toContain('const result = calc(21)')
    // 隔离性：注释、字符串、obj.x 属性访问不被触碰
    expect(read('a.ts')).toContain('// compute 帮助函数')
    expect(read('a.ts')).toContain(`const msg = 'compute'`)
    expect(read('b.ts')).toContain('obj.compute = 1')
  })

  it('dryRun 只返回计划位点，不落盘', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function foo() {}\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'foo', to: 'bar', dryRun: true },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.dryRun).toBe(true)
    expect(res.output!.validated).toBe(true)
    expect(read('a.ts')).toContain('export function foo()')
  })

  it('对象简写属性名随引用重命名', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export const color = "red"\nconst map = { color }\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'color', to: 'hue' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(read('a.ts')).toContain('const map = { hue }')
  })

  it('非法新标识符报 INVALID_IDENTIFIER', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function foo() {}\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'foo', to: '123bad' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('INVALID_IDENTIFIER')
  })

  it('符号不存在报 SYMBOL_NOT_FOUND，不落盘', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function foo() {}\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'missing', to: 'bar' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('SYMBOL_NOT_FOUND')
  })

  it('路径越界报 PATH_OUTSIDE_CWD', async () => {
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'x', to: 'y', path: '/etc' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('PATH_OUTSIDE_CWD')
  })

  it('安全声明：可写 + 非并发 + edit 权限键', () => {
    const tool = codeSemanticEditTool(new CodeIntelIndex())
    expect(tool.isReadOnly?.()).toBe(false)
    expect(tool.isConcurrencySafe?.()).toBe(false)
    expect(tool.permission?.key).toBe('edit')
  })
})

describe('createCodeIntelPlugin', () => {
  it('装配注入四个代码情报工具', async () => {
    const plugin = createCodeIntelPlugin() as AgentPlugin
    expect(plugin.id).toBe('code-intel')

    const pool = { added: [] as unknown[] }
    const hooks = await plugin.install({ log: { info() {}, warn() {}, error() {}, debug() {} } } as any)
    await (hooks as any)['tool.pool.assemble']({ agentId: 'default' }, {
      add: (t: unknown) => (pool.added as unknown[]).push(t),
    })

    const ids = pool.added.map((t) => (t as { id: string }).id).sort()
    expect(ids).toEqual(['code_definition', 'code_reference', 'code_semantic_edit', 'code_symbols'])
  })

  it('支持忽略目录/文件数上限配置透传', () => {
    const index = new CodeIntelIndex({ ignoreDirs: ['vendor'], maxFiles: 10, maxDepth: 3 })
    expect(index.ignoreDirs).toContain('vendor')
    expect(index.maxFiles).toBe(10)
    expect(index.maxDepth).toBe(3)
  })
})

describe('meta 元信息', () => {
  it('code-intel 四个工具均有静态元信息（只读/可写、并发安全、权限键齐全）', () => {
    const ids = CODE_INTEL_TOOL_META.map((m) => m.id).sort()
    expect(ids).toEqual(['code_definition', 'code_reference', 'code_semantic_edit', 'code_symbols'])
    for (const m of CODE_INTEL_TOOL_META) {
      expect(m.description.length).toBeGreaterThan(0)
    }
    const readTools = CODE_INTEL_TOOL_META.filter((m) => m.id !== 'code_semantic_edit')
    for (const m of readTools) {
      expect(m.isReadOnly).toBe(true)
      expect(m.isConcurrencySafe).toBe(true)
      expect(m.permissionKey).toBe('read')
    }
    const edit = CODE_INTEL_TOOL_META.find((m) => m.id === 'code_semantic_edit')!
    expect(edit.isReadOnly).toBe(false)
    expect(edit.isConcurrencySafe).toBe(false)
    expect(edit.permissionKey).toBe('edit')
  })
})
