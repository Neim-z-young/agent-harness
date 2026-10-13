/**
 * @harness/code-intel 单测
 *
 * 覆盖：CodeIntelIndex（符号提取 函数/类/接口/枚举/变量/导入 + exported + 签名、mtime/size 缓存）、
 * code_symbols / code_reference / code_definition 三工具（文件/目录/越界/不支持类型/找不到符号）、
 * createCodeIntelPlugin 装配注入、meta 元信息一致性。
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
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

    // 内容变更 → 重新索引。⚠️ v1 → v2 是**等长**改写（原注释写"size 变"是错的），能否被判定
    // 为"变了"全靠 mtime 推进 —— 而 **Windows 的文件时间戳粒度约 15.6ms**，紧挨的两次写入
    // 可能拿到同一个戳 ⇒ 偶发"改了却没重新索引"（CI 实测）。这里显式把 mtime 推后，让
    // "戳变了 ⇒ 必须重新索引"这一条**确定性**成立（本用例要证的是缓存判据，不是时钟精度）。
    writeFileSync(file, 'export function v2() {}\n')
    const later = new Date(Date.now() + 2000)
    utimesSync(file, later, later)
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

describe('多语言导航（tree-sitter: Go/Python/Rust）', () => {
  it('Python 符号提取：函数/类/变量/导入 + 位置', async () => {
    const file = join(dir, 'app.py')
    writeFileSync(
      file,
      `import os\nimport json as js\n\nUSE = 5\nconst_val = USE + 1\n\ndef helper(a, b):\n    return a + b\n\nclass Point:\n    def __init__(self, x, y):\n        self.x = x\n`,
    )
    const index = new CodeIntelIndex()
    const symbols = await index.symbols(file, dir)
    const names = symbols.map((s) => `${s.kind}:${s.name}`)
    expect(names).toContain('import:os')
    expect(names).toContain('import:json as js') // 带别名时 name 字段含 `json as js`
    expect(names).toContain('variable:USE')
    expect(names).toContain('variable:const_val')
    expect(names).toContain('function:helper')
    expect(names).toContain('class:Point')

    const helper = symbols.find((s) => s.name === 'helper')!
    expect(helper.line).toBe(7)
    expect(helper.file).toBe(file)
    expect(helper.relativePath).toBe('app.py')
  })

  it('Python 名字命中型引用：跨调用点收集，排除声明处', async () => {
    writeFileSync(join(dir, 'app.py'), `def helper(a):\n    return a\n\nUSE = helper(1) + helper(2)\n`)
    const index = new CodeIntelIndex()
    await index.load(join(dir, 'app.py'), dir)
    const refs = index.allReferences('helper')
    expect(refs.length).toBe(2)
    for (const r of refs) {
      expect(r.name).toBe('helper')
      expect(r.relativePath).toBe('app.py')
    }
  })

  it('Go 符号提取：函数/方法/struct/interface/变量/导入', async () => {
    const file = join(dir, 'main.go')
    writeFileSync(
      file,
      `package main\n\nimport (\n\t"fmt"\n\t"example.com/x"\n)\n\nconst Max = 100\nvar count = 0\n\ntype Point struct {\n\tX int\n}\n\ntype Shape interface {\n\tArea() float64\n}\n\nfunc NewPoint(x, y int) *Point {\n\treturn &Point{x, y}\n}\n\nfunc (p *Point) Move(dx int) {\n\tp.X += dx\n}\n`,
    )
    const index = new CodeIntelIndex()
    const symbols = await index.symbols(file, dir)
    const names = symbols.map((s) => `${s.kind}:${s.name}`)
    expect(names).toContain('variable:Max')
    expect(names).toContain('variable:count')
    expect(names).toContain('class:Point')   // struct_type → class
    expect(names).toContain('interface:Shape')
    expect(names).toContain('function:NewPoint')
    expect(names).toContain('function:Move') // method_declaration → function
    // import_spec 取别名或裸串
    expect(names).toContain('import:fmt')
  })

  it('Rust 符号提取：fn/struct/trait/enum/const + 引用', async () => {
    const file = join(dir, 'lib.rs')
    writeFileSync(
      file,
      `const MAX: usize = 100;\n\nstruct Point {\n    x: i32,\n}\n\ntrait Draw {\n    fn render(&self);\n}\n\nenum Color {\n    Red,\n}\n\nfn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\nfn call() -> i32 {\n    let r = add(1, 2);\n    r + MAX as i32\n}\n`,
    )
    const index = new CodeIntelIndex()
    const symbols = await index.symbols(file, dir)
    const names = symbols.map((s) => `${s.kind}:${s.name}`)
    expect(names).toContain('variable:MAX')  // const_item → variable
    expect(names).toContain('class:Point')   // struct_item → class
    expect(names).toContain('interface:Draw') // trait_item → interface
    expect(names).toContain('enum:Color')
    expect(names).toContain('function:add')

    // 引用：add 被 call 引用（非声明处）
    await index.load(file, dir)
    const refs = index.allReferences('add')
    expect(refs.some((r) => r.context.includes('add(1, 2)'))).toBe(true)
  })

  it('目录聚合：babel(.ts) 与 tree-sitter(.py/.go) 符号合并', async () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function tsFn() {}\n')
    writeFileSync(join(dir, 'src', 'b.py'), 'def pyFn():\n    return 1\n')
    writeFileSync(join(dir, 'src', 'c.go'), 'package p\n\nfunc goFn() {}\n')
    const index = new CodeIntelIndex()
    const symbols = await index.symbols(join(dir, 'src'), dir)
    const names = symbols.map((s) => s.name)
    expect(names).toContain('tsFn')
    expect(names).toContain('pyFn')
    expect(names).toContain('goFn')
  })

  it('编辑隔离：对 .py 文件 rename 报 SYMBOL_NOT_FOUND，不落盘、不崩溃', async () => {
    const f = join(dir, 'app.py')
    writeFileSync(f, 'def helper(a):\n    return a\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'helper', to: 'h2', path: 'app.py' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    // tree-sitter 语言不支持语义编辑 → 找不到 babel 声明
    expect(res.error!.code).toBe('SYMBOL_NOT_FOUND')
    expect(require('node:fs').readFileSync(f, 'utf-8')).toContain('def helper')
  })

  it('Java 符号提取：class/interface/enum/record/方法/构造器/字段/局部变量/导入', async () => {
    const file = join(dir, 'Main.java')
    writeFileSync(
      file,
      `import java.util.List;
import static java.lang.Math.max;

public class Main {
  private int count = 0;

  public Main(int c) { this.count = c; }

  public int add(int a, int b) {
    int total = a + b;
    return total + max(a, b);
  }
}

interface Shape { double area(); }
enum Color { RED, BLUE }
record Point(int x, int y) {}
`,
    )
    const index = new CodeIntelIndex()
    const symbols = await index.symbols(file, dir)
    const names = symbols.map((s) => `${s.kind}:${s.name}`)
    expect(names).toContain('import:List')
    expect(names).toContain('import:max')   // static 导入取末段
    expect(names).toContain('class:Main')
    expect(names).toContain('function:Main') // 构造器 → function
    expect(names).toContain('function:add')
    expect(names).toContain('variable:count') // 字段
    expect(names).toContain('variable:total') // 局部变量
    expect(names).toContain('interface:Shape')
    expect(names).toContain('enum:Color')
    expect(names).toContain('class:Point')   // record → class

    const add = symbols.find((s) => s.name === 'add')!
    expect(add.line).toBe(9)
    expect(add.file).toBe(file)
    expect(add.relativePath).toBe('Main.java')
  })

  it('Java 引用：类型标识符与方法调用（含声明处排除）', async () => {
    writeFileSync(
      join(dir, 'Main.java'),
      `import java.util.List;
public class Main {
  private List<String> items;
  public void fill(List<String> xs) {
    this.items = xs;
    items.add(xs.get(0));
  }
}
`,
    )
    const index = new CodeIntelIndex()
    await index.load(join(dir, 'Main.java'), dir)
    const refs = index.allReferences('items')
    // 声明处(items 字段)排除；this.items、items.add 处命中
    expect(refs.some((r) => r.context.includes('this.items'))).toBe(true)
    expect(refs.some((r) => r.context.includes('items.add'))).toBe(true)
  })

  it('目录聚合：babel(.ts) 与 tree-sitter(.py/.go/.java) 符号合并', async () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function tsFn() {}\n')
    writeFileSync(join(dir, 'src', 'b.py'), 'def pyFn():\n    return 1\n')
    writeFileSync(join(dir, 'src', 'c.go'), 'package p\n\nfunc goFn() {}\n')
    writeFileSync(join(dir, 'src', 'd.java'), 'public class J { public void javaFn() {} }\n')
    const index = new CodeIntelIndex()
    const symbols = await index.symbols(join(dir, 'src'), dir)
    const names = symbols.map((s) => s.name)
    expect(names).toContain('tsFn')
    expect(names).toContain('pyFn')
    expect(names).toContain('goFn')
    expect(names).toContain('javaFn')
  })

  it('相邻产物复制优先 + node_modules 回退（import.meta.url 相对定位）', async () => {
    const { readFileSync, rmSync } = require('node:fs')
    const { resolve } = require('node:path')
    const { readGrammarBytes } = await import('./multi')
    const nodeModPath = resolve(__dirname, '..', 'node_modules/tree-sitter-go/tree-sitter-go.wasm')
    const collocated = join(__dirname, 'tree-sitter-go.wasm') // 与 multi.ts 同目录，即 import.meta.url 解析位
    try {
      // 无相邻复制时：回退 node_modules 磁盘读取
      let bytes = readGrammarBytes('.go')
      expect(bytes).toBeInstanceOf(Uint8Array)
      if (!bytes) throw new Error('expected bytes from fallback')
      expect(new Uint8Array(bytes).byteLength).toBe(new Uint8Array(readFileSync(nodeModPath)).byteLength)
      // 放置相邻复制文件后：命中该分支（内容以相邻文件为准，覆盖 node_modules 版本）
      writeFileSync(collocated, readFileSync(nodeModPath))
      bytes = readGrammarBytes('.go')
      expect(bytes).toBeInstanceOf(Uint8Array)
      if (!bytes) throw new Error('expected bytes from collocated')
      expect(new Uint8Array(bytes)).toEqual(new Uint8Array(readFileSync(collocated)))
    } finally {
      rmSync(collocated, { force: true })
    }
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

  it('★经符号链接逃逸 ⇒ PATH_OUTSIDE_CWD（P0-4：字符串判定会放行）', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'harness-codeintel-out-'))
    try {
      writeFileSync(join(outside, 'linked-out.ts'), 'export const x = 1\n')
      symlinkSync(outside, join(dir, 'up'))
      const res = await codeSymbolsTool(new CodeIntelIndex()).call!({ path: 'up' }, ctx)
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.error!.code).toBe('PATH_OUTSIDE_CWD')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
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
    const out = res.output!
    if (out.mode !== 'rename') throw new Error('expected rename')
    expect(out.validated).toBe(true)
    // a.ts 声明 1 + b.ts import 源名 1 + b.ts 引用 1（注释/字符串/obj.x 被隔离排除）= 3
    expect(out.total).toBe(3)
    expect(out.files.length).toBe(2)

    // 声明与引用、import 源名已改
    expect(read('a.ts')).toContain('export function calc(x: number)')
    expect(read('b.ts')).toContain(`import { calc } from './a'`)
    expect(read('b.ts')).toContain('const result = calc(21)')
    // 隔离性：注释、字符串、obj.x 属性访问不被触碰
    expect(read('a.ts')).toContain('// compute 帮助函数')
    expect(read('a.ts')).toContain(`const msg = 'compute'`)
    expect(read('b.ts')).toContain('obj.compute = 1')
  })

  it('Java 语义 rename：字段声明 + 引用位点同步，注释/字符串隔离，中文字符偏移换算正确，重解析校验通过', async () => {
    const file = join(dir, 'Counter.java')
    writeFileSync(
      file,
      `public class Counter {
  private int count = 0;
  public void inc() {
    // 计数器自增 count 变量
    this.count = count + 1;
  }
  public int get() { return count; }
}
`,
    )
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'count', to: 'total' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'rename') throw new Error('expected rename')
    expect(out.validated).toBe(true)
    // 声明 1（private int count）+ 引用 3（this.count / count+1 / return count）= 4。
    // 注释中的 count 非标识符 token，被 CST 排除。
    expect(out.total).toBe(4)
    expect(out.files.length).toBe(1)
    const rel = 'Counter.java'
    expect(read(rel)).toContain('private int total = 0')
    expect(read(rel)).toContain('this.total = total + 1')
    expect(read(rel)).toContain('return total')
    // 隔离性：注释中的 count 不被触碰
    expect(read(rel)).toContain('// 计数器自增 count 变量')
  })

  it('Java 语义 rename：类名跨文件同步（import 说明符 + 类型引用），结构校验走 verifyJavaSource', async () => {
    mkdirSync(join(dir, 'util'))
    writeFileSync(
      join(dir, 'util', 'Shape.java'),
      `package util;
public class Shape {
  public Shape() {}
}
`,
    )
    writeFileSync(
      join(dir, 'Main.java'),
      `import util.Shape;

public class Main {
  Shape s = new Shape();
  public Shape build() { return new Shape(); }
}
`,
    )
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'Shape', to: 'Circle' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'rename') throw new Error('expected rename')
    expect(out.validated).toBe(true)
    // 声明文件 class Shape(decl) 1；Main.java：import 说明符 Shape 1 + 类型引用/构造/返回 数处
    expect(out.files.length).toBe(2)
    expect(read(join('util', 'Shape.java'))).toContain('public class Circle')
    expect(read('Main.java')).toContain('import util.Circle')
    expect(read('Main.java')).toContain('Circle s = new Circle()')
    expect(read('Main.java')).toContain('public Circle build() { return new Circle(); }')
  })

  it('Java 反向 import 跨目录：scope 内声明 + scope 外 import 方（importRoot 内）一并改名，包名匹配', async () => {
    mkdirSync(join(dir, 'app'))
    mkdirSync(join(dir, 'consumer'))
    mkdirSync(join(dir, 'other'))
    writeFileSync(
      join(dir, 'app', 'Shape.java'),
      `package app;
public class Shape {
  public Shape() {}
}
`,
    )
    writeFileSync(
      join(dir, 'consumer', 'Main.java'),
      `package consumer;

import app.Shape;

public class Main {
  Shape s = new Shape();
  public Shape build(Shape x) { return x; }
}
`,
    )
    // 无关第三方：仅用全限定名引用（无 import 绑定），不在 scope 内，不应被拉入
    writeFileSync(
      join(dir, 'other', 'Other.java'),
      `package other;
public class Other {
  app.Shape q;
}
`,
    )
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'Shape', to: 'Circle', path: 'app', resolveImporters: true },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'rename') throw new Error('expected rename')
    expect(out.validated).toBe(true)
    expect(out.resolveImporters).toBe(true)
    // 声明方（app/Shape.java）+ scope 外 import 方（consumer/Main.java）共 2 个文件
    expect(out.files.length).toBe(2)
    expect(out.importers?.length).toBe(1)
    expect(out.importers![0]!.relativePath).toBe('consumer' + require('node:path').sep + 'Main.java')
    // 声明方：类名 + 构造器
    expect(read(join('app', 'Shape.java'))).toContain('public class Circle')
    expect(read(join('app', 'Shape.java'))).toContain('public Circle() {}')
    // import 方：import 说明符 + 类型/构造引用全改
    expect(read(join('consumer', 'Main.java'))).toContain('import app.Circle;')
    expect(read(join('consumer', 'Main.java'))).toContain('Circle s = new Circle()')
    expect(read(join('consumer', 'Main.java'))).toContain('public Circle build(Circle x)')
    // 未走反向拉入的第三方（用全限定 app.Shape 而非 import 绑定）不被改动
    expect(read(join('other', 'Other.java'))).toContain('app.Shape q')
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

  it('scope 子目录白名单：仅编辑 scope 指定子目录内的命中', async () => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'a.ts'), 'export function calc() {}\n')
    writeFileSync(join(dir, 'sub', 'b.ts'), 'export function calc() {}\ncalc()\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'calc', to: 'calc2', path: '.', scope: 'sub' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'rename') throw new Error('expected rename')
    expect(out.scope).toBe('sub')
    // 仅 sub/b.ts 被改（声明 + 引用 = 2），a.ts 保持原样
    expect(out.files.length).toBe(1)
    expect(out.files[0]!.relativePath).toBe('sub' + require('node:path').sep + 'b.ts')
    expect(out.total).toBe(2)
    expect(read('a.ts')).toContain('export function calc()')
    expect(read(join('sub', 'b.ts'))).toContain('export function calc2()')
    expect(read(join('sub', 'b.ts'))).toContain('calc2()')
  })

  it('scope 无命中报 SYMBOL_NOT_FOUND，不落盘', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function calc() {}\n')
    writeFileSync(join(dir, 'other.ts'), 'export function calc() {}\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'calc', to: 'calc2', path: '.', scope: 'nodir' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('SYMBOL_NOT_FOUND')
    expect(read('a.ts')).toContain('export function calc()')
    expect(read('other.ts')).toContain('export function calc()')
  })

  it('scope 指向越界路径报 PATH_OUTSIDE_CWD', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function calc() {}\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'calc', to: 'x', path: '.', scope: '/etc' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('PATH_OUTSIDE_CWD')
  })

  it('resolveImporters 跨目录反向 import：外部导入方一并改名', async () => {
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function compute(x: number) { return x * 2 }\n')
    writeFileSync(join(dir, 'lib', 'use.ts'), "import { compute } from '../src/a'\nconst r = compute(21)\n")
    // path='src' 只覆盖 src 下文件，lib/use.ts 靠 resolveImporters 反向拉入
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'compute', to: 'calc', path: 'src', resolveImporters: true },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'rename') throw new Error('expected rename')
    expect(out.resolveImporters).toBe(true)
    expect(out.importers!.length).toBe(1)
    expect(out.importers![0]!.relativePath).toBe('lib' + require('node:path').sep + 'use.ts')
    // 声明 + 外部 import 源名 + 外部引用 = 3
    expect(out.total).toBe(3)
    expect(out.files.length).toBe(2)
    expect(read(join('src', 'a.ts'))).toContain('export function calc(')
    expect(read(join('lib', 'use.ts'))).toContain(`import { calc } from '../src/a'`)
    expect(read(join('lib', 'use.ts'))).toContain('const r = calc(21)')
  })

  it('resolveImporters 缺省（false）不越界：外部导入方不被改动', async () => {
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function compute() {}\n')
    writeFileSync(join(dir, 'lib', 'use.ts'), "import { compute } from '../src/a'\n")
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'compute', to: 'calc', path: 'src' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'rename') throw new Error('expected rename')
    expect(out.importers).toBeUndefined()
    expect(out.files.length).toBe(1)
    expect(read(join('lib', 'use.ts'))).toContain(`import { compute } from '../src/a'`)
  })

  it('resolveImporters 捕获再导出 export { compute } from ...', async () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function compute() {}\n')
    writeFileSync(join(dir, 'index.ts'), "export { compute } from './src/a'\n")
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'compute', to: 'calc', path: 'src', resolveImporters: true },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'rename') throw new Error('expected rename')
    expect(out.importers!.length).toBe(1)
    expect(read(join('index.ts'))).toContain(`export { calc } from './src/a'`)
  })

  it('importRoot 收紧：不含外部导入方时不反向拉入', async () => {
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function compute() {}\n')
    writeFileSync(join(dir, 'lib', 'use.ts'), "import { compute } from '../src/a'\n")
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'compute', to: 'calc', path: 'src', resolveImporters: true, importRoot: 'src' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'rename') throw new Error('expected rename')
    expect(out.importers!.length).toBe(0)
    expect(out.files.length).toBe(1)
    expect(read(join('lib', 'use.ts'))).toContain(`import { compute } from '../src/a'`)
  })

  it('importRoot 越界报 PATH_OUTSIDE_CWD', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function compute() {}\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'rename', symbol: 'compute', to: 'x', path: '.', resolveImporters: true, importRoot: '/etc' },
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

describe('code_semantic_edit replace_node 模式', () => {
  const read = (p: string) => require('node:fs').readFileSync(join(dir, p), 'utf-8')

  it('按行列范围吸附节点并替换落盘', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export const LEGACY = 1\nconst x = LEGACY + 1\n')
    // range：第 2 行 `const x = LEGACY + 1` 的整行（1 行 1 列 → 行尾）
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_node', path: 'a.ts', startLine: 2, startColumn: 1, endLine: 2, endColumn: 0, replacement: 'export function used() { return LEGACY }\n' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'replace_node') throw new Error('expected replace_node')
    expect(out.validated).toBe(true)
    expect(out.node.type).toBe('VariableDeclaration')
    expect(read('a.ts')).toContain('export function used() { return LEGACY }')
    expect(read('a.ts')).toContain('export const LEGACY = 1') // 第 1 行保留
  })

  it('dryRun 不落盘，返回预览与节点范围', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const y = 2\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_node', path: 'a.ts', startLine: 1, startColumn: 1, endLine: 1, endColumn: 0, replacement: 'const z = 3\n', dryRun: true },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'replace_node') throw new Error('expected replace_node')
    expect(out.dryRun).toBe(true)
    expect(out.validated).toBe(true)
    expect(out.preview).toContain('const z = 3') // 预览为替换后内容
    expect(read('a.ts')).toContain('const y = 2') // 未落盘
    expect(out.node.relation).toBeDefined()
    expect(out.node.startColumn).toBe(1)
  })

  it('精确选中表达式节点替换（relation=exact）', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const r = add(1, 2) * 10\n')
    // 精确覆盖 `add(1, 2)`：起始列 11，含 9 字符 → 结束列（不含）20
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_node', path: 'a.ts', startLine: 1, startColumn: 11, endLine: 1, endColumn: 20, replacement: 'sub(5, 5)' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'replace_node') throw new Error('expected replace_node')
    expect(out.node.relation).toBe('exact')
    expect(out.node.type).toBe('CallExpression')
    expect(read('a.ts')).toBe('const r = sub(5, 5) * 10\n')
  })

  it('范围越界报 INVALID_RANGE', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const y = 1\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_node', path: 'a.ts', startLine: 5, startColumn: 1, endLine: 5, endColumn: 20, replacement: 'x' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('INVALID_RANGE')
  })

  it('单行内圈选吸附到最小包含节点（含内层节点 hasInner）', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const total = helper(a) + helper(b)\n')
    // 覆盖整行但不对齐节点边界 → 吸附到单个最小包含节点，绝不扩散到 Program
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_node', path: 'a.ts', startLine: 1, startColumn: 1, endLine: 1, endColumn: 0, replacement: 'const total = 0\n' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'replace_node') throw new Error('expected replace_node')
    expect(out.node.type).not.toBe('Program') // 吸附到语句/声明，而非整个文件
    expect(out.node.relation).toBe('exact') // 整行范围恰好=该声明节点（不含结尾换行）
    expect(read('a.ts')).toBe('const total = 0\n')
  })

  it('替换后结构校验失败整体放弃（EDIT_INVALID_STRUCTURE）', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const v = () => expr\n')
    // 选中 CallExpression/箭头函数体区域并替换成非法 token
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_node', path: 'a.ts', startLine: 1, startColumn: 12, endLine: 1, endColumn: 21, replacement: '@@invalid@@' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('EDIT_INVALID_STRUCTURE')
  })

  it('路径越界报 PATH_OUTSIDE_CWD', async () => {
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_node', path: '/etc/passwd', startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, replacement: 'x' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('PATH_OUTSIDE_CWD')
  })
})

describe('code_semantic_edit replace_subtree 模式', () => {
  const read = (p: string) => require('node:fs').readFileSync(join(dir, p), 'utf-8')

  it('按成员链选择器替换全部匹配子表达式并落盘', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const h0 = config.server.host\nconst h1 = config.server.host * 2\nconfig.server.host = 9\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_subtree', path: 'a.ts', selector: 'config.server.host', replacement: 'config.host' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'replace_subtree') throw new Error('expected replace_subtree')
    expect(out.total).toBe(3)
    const outText = read('a.ts')
    expect(outText).toContain('const h0 = config.host')
    expect(outText).toContain('const h1 = config.host * 2')
    expect(outText).toContain('config.host = 9')
  })

  it('只匹配 topmost：更长链里的子链不误伤', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = a.b\nconst y = a.b.c\nconst z = a.b.c.d\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_subtree', path: 'a.ts', selector: 'a.b', replacement: 'm.n' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'replace_subtree') throw new Error('expected replace_subtree')
    expect(out.total).toBe(1) // 仅独立的 a.b
    const outText = read('a.ts')
    expect(outText).toContain('const x = m.n')
    expect(outText).toContain('const y = a.b.c')
    expect(outText).toContain('const z = a.b.c.d')
  })

  it('dryRun 不落盘，返回匹配列表与替换后预览', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const v = cfg.host\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_subtree', path: 'a.ts', selector: 'cfg.host', replacement: 'env.HOST', dryRun: true },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'replace_subtree') throw new Error('expected replace_subtree')
    expect(out.dryRun).toBe(true)
    expect(out.files.length).toBe(1)
    expect(out.files[0]!.matches.length).toBe(1)
    expect(out.files[0]!.matches[0]!.text).toBe('cfg.host')
    expect(out.files[0]!.preview).toContain('env.HOST')
    expect(read('a.ts')).toContain('cfg.host') // 未落盘
  })

  it('path 为目录时批量替换所有匹配文件并落盘', async () => {
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'more'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'const h0 = config.server.host\n')
    writeFileSync(join(dir, 'src', 'b.ts'), 'const h1 = config.server.host * 2\n')
    writeFileSync(join(dir, 'more', 'c.ts'), 'const other = something.else\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_subtree', path: '.', selector: 'config.server.host', replacement: 'config.host' },
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = res.output!
    if (out.mode !== 'replace_subtree') throw new Error('expected replace_subtree')
    expect(out.total).toBe(2)
    expect(out.files.length).toBe(2)
    expect(read(join('src', 'a.ts'))).toContain('config.host')
    expect(read(join('src', 'b.ts'))).toContain('config.host * 2')
    expect(read(join('more', 'c.ts'))).toContain('something.else') // 不匹配文件不受影响
  })

  it('目录内无任何匹配报 SUBTREE_NOT_FOUND', async () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'const v = other.path\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_subtree', path: '.', selector: 'cfg.host', replacement: 'x' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('SUBTREE_NOT_FOUND')
    expect(read(join('src', 'a.ts'))).toContain('other.path')
  })

  it('目录根不存在报 PATH_NOT_FOUND', async () => {
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_subtree', path: 'no-such-dir', selector: 'a.b', replacement: 'x' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('PATH_NOT_FOUND')
  })

  it('非法选择器报 INVALID_SELECTOR（含下标）', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const v = arr[0]\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_subtree', path: 'a.ts', selector: 'arr[0]', replacement: 'x' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('INVALID_SELECTOR')
  })

  it('未找到子表达式报 SUBTREE_NOT_FOUND', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const v = other.path\n')
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_subtree', path: 'a.ts', selector: 'cfg.host', replacement: 'x' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('SUBTREE_NOT_FOUND')
  })

  it('路径越界报 PATH_OUTSIDE_CWD', async () => {
    const res = await codeSemanticEditTool(new CodeIntelIndex()).call!(
      { mode: 'replace_subtree', path: '/etc/passwd', selector: 'x.y', replacement: '1' },
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('PATH_OUTSIDE_CWD')
  })
})

describe('createCodeIntelPlugin', () => {
  it('装配为纯 MCP server（对齐 computer-use，不直装 harness 工具）', async () => {
    const plugin = createCodeIntelPlugin() as AgentPlugin
    expect(plugin.id).toBe('code-intel')
    expect(plugin.dependsOn).toContain('mcp.server-registry')

    const hooks = await plugin.install({ log: { info() {}, warn() {}, error() {}, debug() {} } } as any)
    // 纯 MCP 装配：不产生 core.tool.pool.assemble 直装工具，能力只在 mcp-server-registry 连接后以 mcp__code-intel__* 暴露
    expect((hooks as any)['core.tool.pool.assemble']).toBeUndefined()
  })

  it('支持忽略目录/文件数上限配置透传', () => {
    const index = new CodeIntelIndex({ ignoreDirs: ['vendor'], maxFiles: 10, maxDepth: 3 })
    expect(index.ignoreDirs).toContain('vendor')
    expect(index.maxFiles).toBe(10)
    expect(index.maxDepth).toBe(3)
  })
})

describe('meta 元信息', () => {
  it('code-intel 四个 MCP 工具均有静态元信息（mcp__code-intel__ 前缀，只读/可写、并发安全、权限键齐全）', () => {
    const ids = CODE_INTEL_TOOL_META.map((m) => m.id).sort()
    expect(ids).toEqual([
      'mcp__code-intel__code_definition',
      'mcp__code-intel__code_reference',
      'mcp__code-intel__code_semantic_edit',
      'mcp__code-intel__code_symbols',
    ])
    for (const m of CODE_INTEL_TOOL_META) {
      expect(m.id.startsWith('mcp__code-intel__')).toBe(true)
      expect(m.description.length).toBeGreaterThan(0)
    }
    const readTools = CODE_INTEL_TOOL_META.filter((m) => m.id !== 'mcp__code-intel__code_semantic_edit')
    for (const m of readTools) {
      expect(m.isReadOnly).toBe(true)
      expect(m.isConcurrencySafe).toBe(true)
      expect(m.permissionKey).toBe('read')
    }
    const edit = CODE_INTEL_TOOL_META.find((m) => m.id === 'mcp__code-intel__code_semantic_edit')!
    expect(edit.isReadOnly).toBe(false)
    expect(edit.isConcurrencySafe).toBe(false)
    expect(edit.permissionKey).toBe('edit')
  })
})
