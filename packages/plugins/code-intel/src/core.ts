/**
 * @harness/code-intel 索引核心（与 harness 解耦）
 *
 * 本模块**不 import** `@harness/tool` / `@harness/plugin`，仅依赖解析器与 node 原语，
 * 可被任意消费方复用（Harness Tool 适配层 `tools.ts`、进程内 MCP server `server.ts`、
 * 或外部独立进程）。目录协议（Compression 不可用；参数字段用自约束的本地结构）。
 *
 * 能力：AST 符号索引（babel TS/JS + tree-sitter Go/Python/Rust/Java）与结构感知编辑引擎
 * （rename / replace_node / replace_subtree），全部以 `CoreResult<T>` 返回成功/失败，编辑
 * 落盘前内存重解析校验结构。
 */

import { parse, type ParserPlugin } from '@babel/parser'
import traverse, { type NodePath } from '@babel/traverse'
import * as t from '@babel/types'
import { stat, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { collectJavaRenameSites, extractMulti, MULTI_EXT, verifyJavaSource } from './multi'

// ===== 数据类型 =====

export type SymbolKind = 'function' | 'class' | 'variable' | 'interface' | 'type' | 'enum' | 'import'

/** 一个代码符号（声明） */
export interface CodeSymbol {
  name: string
  kind: SymbolKind
  /** 绝对路径 */
  file: string
  /** 相对索引根路径（如 cwd）的路径 */
  relativePath: string
  /** 1-based 行 */
  line: number
  /** 1-based 列 */
  column: number
  endLine?: number
  /** 是否经 export 导出 */
  exported?: boolean
  /** 人读签名（函数 `name(params)` / 类 `class Name`） */
  signature?: string
}

/** 一个符号引用（使用处） */
export interface CodeReference {
  name: string
  file: string
  relativePath: string
  line: number
  column: number
  /** 所在行上下文（截断） */
  context: string
}

/** 一个符号定义（go-to-definition 结果，即声明） */
export interface CodeDefinition {
  name: string
  kind: SymbolKind
  file: string
  relativePath: string
  line: number
  column: number
  signature?: string
}

/** 单个已索引文件 */
export interface IndexedFile {
  path: string
  relativePath: string
  symbols: CodeSymbol[]
  references: Map<string, CodeReference[]>
}

/** createCodeIntelPlugin / CodeIntelIndex 入参 */
export interface CodeIntelOptions {
  /** 忽略目录名（默认 .git/node_modules/dist 等） */
  ignoreDirs?: string[]
  /** 单次目录索引最大文件数（默认 500） */
  maxFiles?: number
  /** 目录递归最大深度（默认 8） */
  maxDepth?: number
}

/** 核心结果：成功输出 / 失败（code + message，与 Harness ToolResult 同构，便于适配层直传） */
export type CoreResult<T> =
  | { ok: true; output: T }
  | { ok: false; error: { code: string; message: string } }

export function ok<T>(output: T): CoreResult<T> {
  return { ok: true, output }
}
/** 失败：首个参数为人读 message，第二个为错误 code（对齐 tools.ts 的 ToolResult.error 结构） */
export function fail<T = never>(message: string, code: string): CoreResult<T> {
  return { ok: false, error: { code, message } }
}

/** 编辑/查询所需的最小上下文（仅 cwd，host 无关） */
export interface CoreContext {
  cwd: string
}

// ===== 解析（babel）=====

const BABEL_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])
/** 全部支持扩展名：babel（TS/JS）+ tree-sitter 多语言 */
const SUPPORTED_EXT = new Set([...BABEL_EXT, ...MULTI_EXT])

/** 尽力解析：主配置失败时回退更宽松配置，仍失败返回 null（该文件跳过，不中断索引） */
function tryParse(content: string, file: string): t.File | null {
  const ext = extname(file).toLowerCase()
  const isTS = ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts'
  const needsJsx = ext === '.tsx' || ext === '.jsx'
  const base = {
    sourceType: 'module' as const,
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
  }
  const common: ParserPlugin[] = [
    'decorators-legacy',
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'topLevelAwait',
    'dynamicImport',
    'importAttributes',
    'explicitResourceManagement',
  ]
  const attempts: ParserPlugin[][] = []
  const jsxPlugin: ParserPlugin[] = needsJsx ? ['jsx'] : []
  if (isTS) attempts.push([...common, 'typescript', ...jsxPlugin])
  else attempts.push([...common, ...jsxPlugin])
  // 回退：TS 加 jsx（泛型误判宽容）、纯 JS 加 typescript 语法兼容
  attempts.push([...common, 'typescript', 'jsx'])
  for (const plugins of attempts) {
    try {
      return parse(content, { ...base, plugins })
    } catch {
      // 继续尝试下一个配置
    }
  }
  return null
}

function isExported(path: NodePath | undefined): boolean {
  let p: NodePath | null = path?.parentPath ?? null
  for (let i = 0; p && i < 3; i++) {
    if (t.isExportNamedDeclaration(p.node) || t.isExportDefaultDeclaration(p.node)) return true
    p = p.parentPath
  }
  return false
}

function paramName(node: t.Node | undefined | null): string {
  if (!node) return ''
  if (t.isIdentifier(node)) return node.name
  if (t.isAssignmentPattern(node)) return paramName(node.left)
  if (t.isRestElement(node)) return '...' + paramName(node.argument)
  return ''
}

function nodeSignature(name: string, node: t.Node): string | undefined {
  if ('params' in node && Array.isArray((node as { params?: unknown[] }).params)) {
    const params = (node as { params: t.Node[] }).params.map((p) => paramName(p)).filter(Boolean)
    return `${name}(${params.join(', ')})`
  }
  if (t.isClassDeclaration(node)) return `class ${name}`
  return undefined
}

function extractSymbols(ast: t.File, filePath: string, relativePath: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = []
  const add = (name: string, kind: SymbolKind, node: t.Node, exported: boolean): void => {
    if (!name) return
    const start = (node as { loc?: { start?: { line?: number; column?: number } } }).loc?.start
    const end = (node as { loc?: { end?: { line?: number } } }).loc?.end
    symbols.push({
      name,
      kind,
      file: filePath,
      relativePath,
      line: start?.line ?? 0,
      column: (start?.column ?? 0) + 1,
      endLine: end?.line,
      exported,
      signature: nodeSignature(name, node),
    })
  }

  traverse(ast, {
    FunctionDeclaration(path) {
      add(path.node.id?.name ?? '', 'function', path.node, isExported(path))
    },
    ClassDeclaration(path) {
      add(path.node.id?.name ?? '', 'class', path.node, isExported(path))
    },
    TSInterfaceDeclaration(path) {
      add(path.node.id.name, 'interface', path.node, isExported(path))
    },
    TSTypeAliasDeclaration(path) {
      add(path.node.id.name, 'type', path.node, isExported(path))
    },
    TSEnumDeclaration(path) {
      add(path.node.id.name, 'enum', path.node, isExported(path))
    },
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return
      add(path.node.id.name, 'variable', path.node, isExported(path))
    },
    ImportDeclaration(path) {
      for (const spec of path.node.specifiers) {
        if (t.isImportSpecifier(spec)) {
          const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value
          add(imported, 'import', spec, false)
        } else if (t.isImportDefaultSpecifier(spec)) add(spec.local.name, 'import', spec, false)
        else if (t.isImportNamespaceSpecifier(spec)) add(spec.local.name, 'import', spec, false)
      }
    },
  })
  return symbols
}

function extractReferences(
  ast: t.File,
  filePath: string,
  relativePath: string,
  source: string,
): Map<string, CodeReference[]> {
  const refs = new Map<string, CodeReference[]>()
  const lines = source.split('\n')
  traverse(ast, {
    ReferencedIdentifier(path) {
      const name = path.node.name
      const start = path.node.loc?.start
      if (!start) return
      const ref: CodeReference = {
        name,
        file: filePath,
        relativePath,
        line: start.line,
        column: start.column + 1,
        context: (lines[start.line - 1] ?? '').trim().slice(0, 120),
      }
      const arr = refs.get(name) ?? []
      arr.push(ref)
      refs.set(name, arr)
    },
  })
  return refs
}

// ===== 结构感知编辑（rename / replace_node / replace_subtree 通用位点）=====

/** 一个可重命名的 AST 标识符位点（精确 token 范围，保证隔离性：绝不触碰子串/属性） */
export interface RenameSite {
  /** 字符偏移（含） */
  start: number
  /** 字符偏移（不含） */
  end: number
  /** 角色：声明 / 引用 / 导入源名 */
  role: 'decl' | 'ref' | 'imported'
  /** 1-based 行 */
  line: number
}

/** 字符偏移 → 1-based 行（lineStarts 为每行起始偏移，含第 0 行 0） */
function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function buildLineStarts(content: string): number[] {
  const starts = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** 行末偏移（不含该行结尾换行符）。starts[i]=第 i+1 行起始；line1Based=1..total */
function lineEndExclusive(content: string, starts: number[], line1Based: number): number {
  const total = starts.length
  const idx = Math.min(Math.max(line1Based, 1), total)
  const nextStart = starts[idx] // 下一行起始；末行时为 undefined
  if (nextStart !== undefined) return nextStart - 1
  // 末行：若以换行结尾则去掉该换行，否则就是文件末尾
  return content.endsWith('\n') ? content.length - 1 : content.length
}

/** 行列（1-based line，1-based column）→ 字符偏移；endColumn 0=endLine 行末（不含换行符） */
function rangeToOffsets(
  content: string,
  starts: number[],
  sl: number,
  sc: number,
  el: number,
  ec: number | undefined,
): { start: number; end: number } {
  const lineStart = (l: number): number => starts[Math.min(Math.max(l - 1, 0), starts.length - 1)] ?? 0
  const start = lineStart(sl) + Math.max(sc - 1, 0)
  const end = ec && ec > 0 ? lineStart(el) + (ec - 1) : lineEndExclusive(content, starts, el)
  return { start, end }
}

type RangedNode = t.Node & { start: number; end: number }

/**
 * 找完全包含字符范围 [start,end] 的最小 AST 子树节点。
 * - 精确命中节点边界 → relation 'exact'；
 * - 否则吸附到最小包含节点 → relation 'absorbed'（hasInner 提示圈选是否过大）。
 */
function findContainingNode(
  ast: t.File,
  start: number,
  end: number,
): { node: RangedNode; relation: 'exact' | 'absorbed'; hasInner: boolean } | undefined {
  let best: RangedNode | undefined
  let bestSpan = Infinity
  let exact: RangedNode | undefined
  let hasInner = false
  traverse(ast, {
    enter(p) {
      const raw = p.node as unknown
      if (typeof (raw as RangedNode).start !== 'number' || typeof (raw as RangedNode).end !== 'number') return
      const node = raw as RangedNode
      if (node.start === node.end) return
      if (node.start <= start && end <= node.end) {
        if (node.start === start && node.end === end) {
          exact = node
          return
        }
        const span = node.end - node.start
        if (span < bestSpan) {
          bestSpan = span
          best = node
        }
      } else if (start <= node.start && node.end <= end) {
        hasInner = true
      }
    },
  })
  if (exact) return { node: exact, relation: 'exact', hasInner: true }
  if (best) return { node: best, relation: 'absorbed', hasInner }
  return undefined
}

/** 把节点还原成成员链文本（`a.b.c`）；非纯成员链/含下标则返回 undefined */
function memberChainText(node: t.Node): string | undefined {
  const parts: string[] = []
  let cur: t.Node = node
  while (true) {
    if (t.isIdentifier(cur)) {
      parts.unshift(cur.name)
      break
    }
    if (t.isMemberExpression(cur) || t.isOptionalMemberExpression(cur)) {
      if (cur.computed) {
        if (t.isStringLiteral(cur.property)) parts.unshift(cur.property.value)
        else return undefined
      } else if (t.isIdentifier(cur.property)) {
        parts.unshift(cur.property.name)
      } else return undefined
      cur = cur.object
      continue
    }
    return undefined
  }
  return parts.join('.')
}

/** 节点是否属于成员访问链（MemberExpression / OptionalMemberExpression） */
function isMemberLike(n: t.Node | null | undefined): boolean {
  if (!n) return false
  return t.isMemberExpression(n) || t.isOptionalMemberExpression(n)
}

/**
 * 收集文件的完整成员链子表达式（`chainText === selector`）：
 * - 仅匹配"topmost"：作为更长成员链 object 的节点不单独匹配，避免 `a.b` 误伤 `a.b.c` 里的 `a.b`；
 * - 排除祖先仍是同一链的子节点（避开 `.property`/`.object` 标识符）。
 */
function collectSubtreeMatches(ast: t.File, selector: string): RangedNode[] {
  const out: RangedNode[] = []
  traverse(ast, {
    enter(p) {
      const raw = p.node as unknown
      if (typeof (raw as RangedNode).start !== 'number' || typeof (raw as RangedNode).end !== 'number') return
      const node = raw as RangedNode
      if (node.start === node.end) return
      if (memberChainText(node) !== selector) return
      const parent = p.parentPath?.node
      // 该节点是更长的成员链的 object → 不是 topmost 匹配（由外层节点整体处理）
      if (isMemberLike(parent) && (parent as { object: unknown }).object === node) return
      out.push(node)
    },
  })
  return out
}

/** 成员链选择器：`a` / `a.b` / `a.b.c`（不含下标） */
const SELECTOR_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/

/**
 * 收集符号重命名位点：
 * - 声明标识符（函数/类/变量/接口/类型/枚举 + import 本地绑定）
 * - import 源名（`import { X as Y }` 的 X；未别名时与本地绑定同范围，按范围去重）
 * - 引用标识符（ReferencedIdentifier，含 export 说明符本地名、对象简写）
 */
function collectRenameSites(ast: t.File, content: string, name: string): RenameSite[] {
  const lineStarts = buildLineStarts(content)
  const sites = new Map<string, RenameSite>()
  const add = (start: number, end: number, role: RenameSite['role']): void => {
    const key = `${start}:${end}`
    if (!sites.has(key)) sites.set(key, { start, end, role, line: offsetToLine(lineStarts, start) })
  }
  const addDecl = (id: t.Identifier | null | undefined): void => {
    if (id && id.name === name) add(id.start!, id.end!, 'decl')
  }

  traverse(ast, {
    FunctionDeclaration(path) {
      addDecl(path.node.id)
    },
    ClassDeclaration(path) {
      addDecl(path.node.id)
    },
    TSInterfaceDeclaration(path) {
      addDecl(path.node.id)
    },
    TSTypeAliasDeclaration(path) {
      addDecl(path.node.id)
    },
    TSEnumDeclaration(path) {
      addDecl(path.node.id)
    },
    VariableDeclarator(path) {
      if (t.isIdentifier(path.node.id)) addDecl(path.node.id)
    },
    ImportSpecifier(path) {
      addDecl(path.node.local)
      const imported = path.node.imported
      if (t.isIdentifier(imported) && imported.name === name) {
        add(imported.start!, imported.end!, 'imported')
      }
    },
    ImportDefaultSpecifier(path) {
      addDecl(path.node.local)
    },
    ImportNamespaceSpecifier(path) {
      addDecl(path.node.local)
    },
    ExportSpecifier(path) {
      if (t.isIdentifier(path.node.local) && path.node.local.name === name) {
        add(path.node.local.start!, path.node.local.end!, 'ref')
      }
    },
    ReferencedIdentifier(path) {
      if (path.node.name === name) add(path.node.start!, path.node.end!, 'ref')
    },
  })
  return [...sites.values()].sort((a, b) => a.start - b.start)
}

// ===== 共享 helper（自包含，避免跨包依赖）=====

function resolvePath(inputPath: string, cwd: string): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath)
}

/** 文件/目录是否在 cwd 范围内 */
export function isWithinCwd(filePath: string, cwd: string): boolean {
  const rel = relative(cwd, filePath)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && (statSync(p)?.isFile() ?? false)
  } catch {
    return false
  }
}

/**
 * 把 import 说明符解析为本地绝对文件路径。
 * 仅处理相对说明符（`./`、`../`）：补齐扩展名、再试 index 文件；裸包/路径别名/未命中返回 null。
 */
function resolveModuleFile(spec: string, importerDir: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null
  const base = resolve(importerDir, spec)
  if (isFile(base)) return base
  for (const ex of SUPPORTED_EXT) {
    const candidate = base + ex
    if (isFile(candidate)) return candidate
  }
  for (const ex of SUPPORTED_EXT) {
    const candidate = join(base, 'index' + ex)
    if (isFile(candidate)) return candidate
  }
  return null
}

/** 结果中返回的最多条目数（防止 LLM 上下文爆炸） */
export const MAX_RESULTS = 200

interface CachedFile {
  stat: { mtimeMs: number; size: number }
  data: IndexedFile
}

/** 内存内符号索引：按需增量 + mtime/size 缓存失效 */
export class CodeIntelIndex {
  readonly ignoreDirs: string[]
  readonly maxFiles: number
  readonly maxDepth: number
  private readonly cache = new Map<string, CachedFile>()

  constructor(opts: CodeIntelOptions = {}) {
    this.ignoreDirs = opts.ignoreDirs ?? ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.harness']
    this.maxFiles = opts.maxFiles ?? 500
    this.maxDepth = opts.maxDepth ?? 8
  }

  /** 索引单个文件；不支持类型/解析失败/读失败返回 undefined（best-effort） */
  async indexFile(absPath: string, relBase: string): Promise<IndexedFile | undefined> {
    const ext = extname(absPath).toLowerCase()
    if (!SUPPORTED_EXT.has(ext)) return undefined
    try {
      const st = await stat(absPath)
      if (!st.isFile()) return undefined
      const cached = this.cache.get(absPath)
      if (cached && cached.stat.mtimeMs === st.mtimeMs && cached.stat.size === st.size) {
        return cached.data
      }
      const content = await readFile(absPath, 'utf-8')
      const relativePath = relative(relBase, absPath)
      let symbols: CodeSymbol[] = []
      let references: Map<string, CodeReference[]> = new Map()
      if (BABEL_EXT.has(ext)) {
        const ast = tryParse(content, absPath)
        if (!ast) return undefined
        symbols = extractSymbols(ast, absPath, relativePath)
        references = extractReferences(ast, absPath, relativePath, content)
      } else if (MULTI_EXT.has(ext)) {
        // tree-sitter 后端：Go/Python/Rust/Java 导航（名字命中型引用）；失败降级为「不支持」，不中断
        const multiResult = await extractMulti(content, absPath, relativePath, ext)
        if (!multiResult) return undefined
        symbols = multiResult.symbols
        references = multiResult.references
      }
      const data: IndexedFile = {
        path: absPath,
        relativePath,
        symbols,
        references,
      }
      this.cache.set(absPath, { stat: { mtimeMs: st.mtimeMs, size: st.size }, data })
      return data
    } catch {
      return undefined
    }
  }

  /** 递归索引目录（尊重忽略目录/深度/文件数上限） */
  async indexDir(absDir: string, relBase: string): Promise<IndexedFile[]> {
    const out: IndexedFile[] = []
    let count = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (count >= this.maxFiles || depth > this.maxDepth) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (count >= this.maxFiles) return
        if (e.isDirectory()) {
          if (this.ignoreDirs.includes(e.name) || e.name.startsWith('.')) continue
          await walk(join(dir, e.name), depth + 1)
        } else if (e.isFile()) {
          const f = await this.indexFile(join(dir, e.name), relBase)
          if (f) {
            out.push(f)
            count++
          }
        }
      }
    }
    await walk(absDir, 0)
    return out
  }

  /** 索引目标（文件或目录），返回 `{ files, isDir }` */
  async load(target: string, relBase: string): Promise<{ files: IndexedFile[]; isDir: boolean }> {
    let st
    try {
      st = await stat(target)
    } catch {
      return { files: [], isDir: false }
    }
    if (st.isFile()) {
      const f = await this.indexFile(target, relBase)
      return { files: f ? [f] : [], isDir: false }
    }
    if (st.isDirectory()) {
      const files = await this.indexDir(target, relBase)
      return { files, isDir: true }
    }
    return { files: [], isDir: false }
  }

  /** 列出文件/目录符号（按文件、行排序） */
  async symbols(target: string, relBase: string): Promise<CodeSymbol[]> {
    const { files } = await this.load(target, relBase)
    return files
      .flatMap((f) => f.symbols)
      .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))
  }

  /** 全缓存中某符号的引用（跨文件；index 目标后再查可获得目录级结果） */
  allReferences(name: string): CodeReference[] {
    const out: CodeReference[] = []
    for (const { data } of this.cache.values()) {
      const refs = data.references.get(name)
      if (refs) out.push(...refs)
    }
    return out
  }

  /** 全缓存中某符号的定义（声明；不含 import 绑定） */
  allDefinitions(name: string): CodeDefinition[] {
    const out: CodeDefinition[] = []
    for (const { data } of this.cache.values()) {
      for (const s of data.symbols) {
        if (s.name === name && s.kind !== 'import') {
          out.push({
            name: s.name,
            kind: s.kind,
            file: s.file,
            relativePath: s.relativePath,
            line: s.line,
            column: s.column,
            signature: s.signature,
          })
        }
      }
    }
    return out
  }

  /** 使某文件的索引缓存失效（内容变更后调用，强制下次重新解析） */
  invalidate(absPath: string): void {
    this.cache.delete(absPath)
  }

  /** 收集目标范围内某符号的精确重命名位点（AST 标识符 token，逐文件） */
  async collectRenameSitesFromScope(
    target: string,
    relBase: string,
    name: string,
  ): Promise<Map<string, RenameSite[]>> {
    const { files } = await this.load(target, relBase)
    const byFile = new Map<string, RenameSite[]>()
    for (const f of files) {
      const content = await readFile(f.path, 'utf-8')
      if (extname(f.path).toLowerCase() === '.java') {
        const sites = await collectJavaRenameSites(content, name)
        if (sites.length) byFile.set(f.path, sites)
        continue
      }
      const ast = tryParse(content, f.path)
      if (!ast) continue
      const sites = collectRenameSites(ast, content, name)
      if (sites.length) byFile.set(f.path, sites)
    }
    return byFile
  }

  /** 收集目标范围内所有匹配 `selector` 的成员链子表达式（topmost，逐文件） */
  async collectSubtreeFromScope(
    target: string,
    relBase: string,
    selector: string,
  ): Promise<Map<string, RangedNode[]>> {
    const { files } = await this.load(target, relBase)
    const byFile = new Map<string, RangedNode[]>()
    for (const f of files) {
      const content = await readFile(f.path, 'utf-8')
      const ast = tryParse(content, f.path)
      if (!ast) continue
      const matches = collectSubtreeMatches(ast, selector)
      if (matches.length) byFile.set(f.path, matches)
    }
    return byFile
  }

  /**
   * 跨目录反向 import 查找：在 reverseRoot 内扫描所有「import { symbol } / export { symbol } from <相对说明符>」
   * 指向 declaringFiles 中任一模块文件的外部导入方，返回这些导入方的 rename 位点。已传入 skip 集合忽略。
   */
  async reverseImporters(
    reverseRoot: string,
    relBase: string,
    symbol: string,
    declaringFiles: Set<string>,
    skip: Set<string>,
  ): Promise<Map<string, RenameSite[]>> {
    const { files } = await this.load(reverseRoot, relBase)
    const out = new Map<string, RenameSite[]>()
    for (const f of files) {
      if (skip.has(f.path)) continue
      const content = await readFile(f.path, 'utf-8')
      const ast = tryParse(content, f.path)
      if (!ast) continue
      let hitDeclaring = false
      const importerDir = dirname(f.path)
      traverse(ast, {
        ImportDeclaration(path) {
          const source = path.node.source.value
          const target = resolveModuleFile(source, importerDir)
          if (!target) return
          for (const spec of path.node.specifiers) {
            if (!t.isImportSpecifier(spec)) continue
            const imported = spec.imported
            if (t.isIdentifier(imported) && imported.name === symbol && declaringFiles.has(target)) hitDeclaring = true
          }
        },
        ExportNamedDeclaration(path) {
          if (!path.node.source) return
          const source = path.node.source.value
          const target = resolveModuleFile(source, importerDir)
          if (!target || !declaringFiles.has(target)) return
          for (const spec of path.node.specifiers) {
            if (t.isExportSpecifier(spec) && t.isIdentifier(spec.local) && spec.local.name === symbol) hitDeclaring = true
          }
        },
      })
      if (!hitDeclaring) continue
      const sites = collectRenameSites(ast, content, symbol)
      if (sites.length) out.set(f.path, sites)
    }
    return out
  }
}

// ===== 编辑引擎：按类型复用工具参数的联合输入/输出（仅描述，不含 harness 依赖）=====

/** rename：符号重命名输入 */
export interface CodeSemanticEditRenameInput {
  mode: 'rename'
  /** 要重命名的符号名 */
  symbol: string
  /** 新符号名（须为合法标识符） */
  to: string
  /** 扫描根目录/文件（缺省当前工作目录） */
  path?: string
  /** 作用域限定：在已扫描的根 path 下，仅编辑该子目录/文件内的命中 */
  scope?: string
  /** 跨目录反向 import 查找（importRoot 内凡 import { symbol } 指向本 scope 声明模块的外部导入方一并改名） */
  resolveImporters?: boolean
  /** 反向 import 查找的扫描根（缺省 cwd） */
  importRoot?: string
  /** 仅预览（返回计划位点，不落盘）；默认 false */
  dryRun?: boolean
}

/** replace_node：按 AST 节点范围替换 */
export interface CodeSemanticEditReplaceNodeInput {
  mode: 'replace_node'
  path: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn?: number
  replacement: string
  dryRun?: boolean
}

/** replace_subtree：按成员链路径定位子表达式并替换 */
export interface CodeSemanticEditReplaceSubtreeInput {
  mode: 'replace_subtree'
  path: string
  selector: string
  replacement: string
  dryRun?: boolean
}

export type CodeSemanticEditInput =
  | CodeSemanticEditRenameInput
  | CodeSemanticEditReplaceNodeInput
  | CodeSemanticEditReplaceSubtreeInput

/** rename：单个文件的重命名结果 */
export interface RenameEditFile {
  file: string
  relativePath: string
  count: number
  sites: RenameSite[]
}
/** rename：反向 import 查找拉入的外部导入方 */
export interface RenameImporter {
  file: string
  relativePath: string
}
/** rename：输出 */
export interface CodeSemanticEditRenameOutput {
  mode: 'rename'
  symbol: string
  to: string
  path: string
  scope?: string
  resolveImporters?: boolean
  importRoot?: string
  importers?: RenameImporter[]
  dryRun: boolean
  validated: boolean
  total: number
  files: RenameEditFile[]
}
/** replace_node：被吸附替换的 AST 节点 */
export interface CodeSemanticEditNode {
  relation: 'exact' | 'absorbed'
  type: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  hasInner: boolean
}
/** replace_node：输出 */
export interface CodeSemanticEditReplaceNodeOutput {
  mode: 'replace_node'
  path: string
  node: CodeSemanticEditNode
  offsetStart: number
  offsetEnd: number
  replacement: string
  dryRun: boolean
  validated: boolean
  preview: string
}
/** replace_subtree：单个匹配位置 */
export interface CodeSemanticEditSubtreeMatch {
  line: number
  column: number
  text: string
}
/** replace_subtree：单个文件的替换结果 */
export interface CodeSemanticEditSubtreeFileResult {
  path: string
  relativePath: string
  count: number
  matches: CodeSemanticEditSubtreeMatch[]
  preview: string
}
/** replace_subtree：输出 */
export interface CodeSemanticEditReplaceSubtreeOutput {
  mode: 'replace_subtree'
  path: string
  selector: string
  replacement: string
  dryRun: boolean
  validated: boolean
  total: number
  files: CodeSemanticEditSubtreeFileResult[]
}

export type CodeSemanticEditOutput =
  | CodeSemanticEditRenameOutput
  | CodeSemanticEditReplaceNodeOutput
  | CodeSemanticEditReplaceSubtreeOutput

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** 作用域白名单过滤：仅保留位于 scope 子目录/文件内的命中。scope 相对扫描根解析；不存在作用域时原样返回 */
function filterByScope(
  byFile: Map<string, RenameSite[]>,
  root: string,
  scope: string | undefined,
  cwd: string,
): Map<string, RenameSite[]> | { error: string } {
  if (!scope) return byFile
  const scopeAbs = resolvePath(scope, root)
  if (!isWithinCwd(scopeAbs, cwd)) {
    return { error: `路径 "${scope}" 超出工作目录范围` }
  }
  const prefix = scopeAbs + sep
  const filtered = new Map<string, RenameSite[]>()
  for (const [file, sites] of byFile) {
    if (file === scopeAbs || file.startsWith(prefix)) filtered.set(file, sites)
  }
  return filtered
}

/** code_semantic_edit 核心：按 mode 分发（rename / replace_node / replace_subtree） */
export async function execSemanticEdit(
  index: CodeIntelIndex,
  input: CodeSemanticEditInput,
  ctx: CoreContext,
): Promise<CoreResult<CodeSemanticEditOutput>> {
  if (input.mode === 'rename') return execRename(index, input, ctx)
  if (input.mode === 'replace_node') return execReplaceNode(index, input, ctx)
  if (input.mode === 'replace_subtree') return execReplaceSubtree(index, input, ctx)
  return fail(`不支持的编辑模式: ${String((input as { mode?: string }).mode)}`, 'UNSUPPORTED_MODE')
}

async function execRename(
  index: CodeIntelIndex,
  input: CodeSemanticEditRenameInput,
  ctx: CoreContext,
): Promise<CoreResult<CodeSemanticEditRenameOutput>> {
  if (!IDENTIFIER_RE.test(input.to)) {
    return fail(`新符号名 "${input.to}" 不是合法标识符`, 'INVALID_IDENTIFIER')
  }
  if (input.symbol === input.to) {
    return fail('新符号名与旧符号名相同', 'NO_OP')
  }
  const absPath = resolvePath(input.path ?? '.', ctx.cwd)
  if (!isWithinCwd(absPath, ctx.cwd)) {
    return fail(`路径 "${input.path ?? '.'}" 超出工作目录范围`, 'PATH_OUTSIDE_CWD')
  }
  try {
    const collected = await index.collectRenameSitesFromScope(absPath, ctx.cwd, input.symbol)
    const scoped = filterByScope(collected, absPath, input.scope, ctx.cwd)
    if ('error' in scoped) {
      return fail(scoped.error, 'PATH_OUTSIDE_CWD')
    }
    const byFile = scoped
    if (byFile.size === 0) {
      return fail(
        input.scope
          ? `作用域 "${input.scope}" 内未找到符号 "${input.symbol}"`
          : `未找到符号 "${input.symbol}"（请先确认名称与作用域）`,
        'SYMBOL_NOT_FOUND',
      )
    }
    const importers: RenameImporter[] = []
    const importsResolved = !!input.resolveImporters
    if (importsResolved) {
      const importRoot = input.importRoot ? resolvePath(input.importRoot, ctx.cwd) : ctx.cwd
      if (!isWithinCwd(importRoot, ctx.cwd)) {
        return fail(`路径 "${input.importRoot}" 超出工作目录范围`, 'PATH_OUTSIDE_CWD')
      }
      const declaringFiles = new Set<string>()
      for (const file of byFile.keys()) {
        const indexed = await index.load(file, ctx.cwd)
        for (const f of indexed.files) {
          if (f.symbols.some((s) => s.name === input.symbol && s.kind !== 'import')) declaringFiles.add(f.path)
        }
      }
      if (declaringFiles.size > 0) {
        const extras = await index.reverseImporters(importRoot, ctx.cwd, input.symbol, declaringFiles, new Set(byFile.keys()))
        for (const [file, sites] of extras) {
          if (!byFile.has(file)) {
            byFile.set(file, sites)
            importers.push({ file, relativePath: relative(ctx.cwd, file) })
          }
        }
      }
    }
    // 编辑前校验：全部文件先在内存中变换 + 重解析，任一失败整体放弃（不落盘）
    const planned: Array<{ file: string; content: string; sites: RenameSite[] }> = []
    for (const [file, sites] of byFile) {
      const original = await readFile(file, 'utf-8')
      let out = original
      for (let i = sites.length - 1; i >= 0; i--) {
        const s = sites[i]
        out = out.slice(0, s.start) + input.to + out.slice(s.end)
      }
      if (extname(file).toLowerCase() === '.java') {
        if (!(await verifyJavaSource(out))) {
          return fail(
            `重命名后 "${relative(ctx.cwd, file)}" 结构校验失败，已放弃（未落盘）`,
            'EDIT_INVALID_STRUCTURE',
          )
        }
      } else if (!tryParse(out, file)) {
        return fail(
          `重命名后 "${relative(ctx.cwd, file)}" 结构校验失败，已放弃（未落盘）`,
          'EDIT_INVALID_STRUCTURE',
        )
      }
      planned.push({ file, content: out, sites })
    }
    const files: RenameEditFile[] = planned.map((p) => ({
      file: p.file,
      relativePath: relative(ctx.cwd, p.file),
      count: p.sites.length,
      sites: p.sites,
    }))
    const output: CodeSemanticEditRenameOutput = {
      mode: 'rename',
      symbol: input.symbol,
      to: input.to,
      path: absPath,
      scope: input.scope,
      resolveImporters: importsResolved,
      importRoot: importsResolved ? (input.importRoot ?? ctx.cwd) : undefined,
      importers: importsResolved ? importers : undefined,
      dryRun: input.dryRun ?? false,
      validated: true,
      total: planned.reduce((n, p) => n + p.sites.length, 0),
      files,
    }
    if (input.dryRun) return ok(output)
    for (const p of planned) {
      await writeFile(p.file, p.content)
      index.invalidate(p.file)
    }
    return ok(output)
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return fail(`路径不存在: ${input.path ?? '.'}`, 'PATH_NOT_FOUND')
    }
    return fail(err.message ?? String(err), 'CODE_INTEL_ERROR')
  }
}

async function execReplaceNode(
  index: CodeIntelIndex,
  input: CodeSemanticEditReplaceNodeInput,
  ctx: CoreContext,
): Promise<CoreResult<CodeSemanticEditReplaceNodeOutput>> {
  const absPath = resolvePath(input.path, ctx.cwd)
  if (!isWithinCwd(absPath, ctx.cwd)) {
    return fail(`路径 "${input.path}" 超出工作目录范围`, 'PATH_OUTSIDE_CWD')
  }
  try {
    const content = await readFile(absPath, 'utf-8')
    const ast = tryParse(content, absPath)
    if (!ast) {
      return fail(`无法解析文件 ${relative(ctx.cwd, absPath)}（AST 解析失败）`, 'PARSE_ERROR')
    }
    const starts = buildLineStarts(content)
    const { start, end } = rangeToOffsets(content, starts, input.startLine, input.startColumn, input.endLine, input.endColumn)
    if (start < 0 || end < start || end > content.length) {
      return fail('范围无效或越界（end 需 >= start 且不超文件长度）', 'INVALID_RANGE')
    }
    const hit = findContainingNode(ast, start, end)
    if (!hit) {
      return fail('范围内未找到可替换的 AST 节点', 'NODE_NOT_FOUND')
    }
    // 整行圈选（endColumn=0）时，顺带消费紧随节点的行结尾换行符，避免替换后残留空行
    let consumedEnd = hit.node.end
    const wholeLine = !(input.endColumn && input.endColumn > 0)
    if (wholeLine && content[consumedEnd] === '\n') consumedEnd++
    const out = content.slice(0, hit.node.start) + input.replacement + content.slice(consumedEnd)
    if (!tryParse(out, absPath)) {
      return fail('替换后结构校验失败，已放弃（未落盘）', 'EDIT_INVALID_STRUCTURE')
    }
    const nStart = hit.node.start
    const nEnd = hit.node.end
    const sl = offsetToLine(starts, nStart)
    const el = offsetToLine(starts, Math.max(nEnd - 1, 0))
    const output: CodeSemanticEditReplaceNodeOutput = {
      mode: 'replace_node',
      path: absPath,
      node: {
        relation: hit.relation,
        type: hit.node.type,
        startLine: sl,
        startColumn: nStart - starts[sl - 1] + 1,
        endLine: el,
        endColumn: nEnd - starts[el - 1] + 1,
        hasInner: hit.hasInner,
      },
      offsetStart: nStart,
      offsetEnd: consumedEnd,
      replacement: input.replacement,
      dryRun: input.dryRun ?? false,
      validated: true,
      preview: out,
    }
    if (input.dryRun) return ok(output)
    await writeFile(absPath, out)
    index.invalidate(absPath)
    return ok(output)
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return fail(`路径不存在: ${input.path}`, 'PATH_NOT_FOUND')
    }
    return fail(err.message ?? String(err), 'CODE_INTEL_ERROR')
  }
}

async function execReplaceSubtree(
  index: CodeIntelIndex,
  input: CodeSemanticEditReplaceSubtreeInput,
  ctx: CoreContext,
): Promise<CoreResult<CodeSemanticEditReplaceSubtreeOutput>> {
  const absPath = resolvePath(input.path, ctx.cwd)
  if (!isWithinCwd(absPath, ctx.cwd)) {
    return fail(`路径 "${input.path}" 超出工作目录范围`, 'PATH_OUTSIDE_CWD')
  }
  const selector = input.selector.trim()
  if (!SELECTOR_RE.test(selector)) {
    return fail(`选择器 "${input.selector}" 不是合法成员链（期望如 config.server.host）`, 'INVALID_SELECTOR')
  }
  try {
    let rootExists = false
    try {
      const st = await stat(absPath)
      rootExists = st.isFile() || st.isDirectory()
    } catch {
      rootExists = false
    }
    if (!rootExists) {
      return fail(`路径不存在: ${input.path}`, 'PATH_NOT_FOUND')
    }
    const byFile = await index.collectSubtreeFromScope(absPath, ctx.cwd, selector)
    if (byFile.size === 0) {
      return fail(`未找到子表达式 "${selector}"`, 'SUBTREE_NOT_FOUND')
    }
    const planned: Array<{ file: string; original: string; content: string; matches: RangedNode[] }> = []
    for (const [file, matches] of byFile) {
      const original = await readFile(file, 'utf-8')
      let out = original
      for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i]
        out = out.slice(0, m.start) + input.replacement + out.slice(m.end)
      }
      if (!tryParse(out, file)) {
        return fail(
          `替换后 "${relative(ctx.cwd, file)}" 结构校验失败，已放弃（未落盘）`,
          'EDIT_INVALID_STRUCTURE',
        )
      }
      planned.push({ file, original, content: out, matches })
    }
    const files: CodeSemanticEditSubtreeFileResult[] = planned.map((p) => {
      const starts = buildLineStarts(p.original)
      const matches = p.matches.map((m) => {
        const line = offsetToLine(starts, m.start)
        return {
          line,
          column: m.start - starts[line - 1] + 1,
          text: p.original.slice(m.start, m.end),
        }
      })
      return {
        path: p.file,
        relativePath: relative(ctx.cwd, p.file),
        count: p.matches.length,
        matches,
        preview: p.content,
      }
    })
    const output: CodeSemanticEditReplaceSubtreeOutput = {
      mode: 'replace_subtree',
      path: absPath,
      selector,
      replacement: input.replacement,
      dryRun: input.dryRun ?? false,
      validated: true,
      total: planned.reduce((n, p) => n + p.matches.length, 0),
      files,
    }
    if (input.dryRun) return ok(output)
    for (const p of planned) {
      await writeFile(p.file, p.content)
      index.invalidate(p.file)
    }
    return ok(output)
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return fail(`路径不存在: ${input.path}`, 'PATH_NOT_FOUND')
    }
    return fail(err.message ?? String(err), 'CODE_INTEL_ERROR')
  }
}