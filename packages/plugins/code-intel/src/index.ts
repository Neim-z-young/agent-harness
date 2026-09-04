/**
 * @harness/code-intel - 代码情报插件
 *
 * 基于 AST 的结构化符号索引，提供代码定位与结构感知导航工具：
 * - code_symbols：列出文件/目录的符号（函数/类/变量/接口/类型/枚举/导入）
 * - code_reference：查找某符号的引用（usages，跨文件）
 * - code_definition：符号 go-to-definition（返回声明位置）
 *
 * 技术选型（对齐 docs/codeintel-plugin.md §3）：纯 TS/JS 域先用 @babel/parser + @babel/traverse
 * 落地（纯 JS、同步、可单测）；多语言 grammar 可后续换 web-tree-sitter，不改工具/插件契约。
 *
 * 索引策略（对齐规划 §3）：v1 内存内 + 按需增量——索引目标文件/目录（含忽略目录、文件数上限），
 * 不做持久化全文索引；缓存按 mtime+size 失效。
 *
 * 通过 tool.pool.assemble Hook 注入工具，不与 core/CLI 耦合（插件化约束）。
 *
 * @example
 * import { createHarness } from '@harness/core'
 * import { codeIntelPlugin } from '@harness/code-intel'
 *
 * const h = await createHarness({
 *   internalPlugins: [codeIntelPlugin],
 *   agents: [{ id: 'default', name: 'Agent', mode: 'primary', tools: ['*'], permission: { '*': 'allow' }, promptFragments: [] }],
 * })
 */

import { parse, type ParserPlugin } from '@babel/parser'
import traverse, { type NodePath } from '@babel/traverse'
import * as t from '@babel/types'
import { defineTool, Schema, Tool, ToolContext, ToolResult } from '@harness/tool'
import type { AgentPlugin, Hooks } from '@harness/plugin'

import { stat, readFile, readdir, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

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

// ===== 索引核心 =====

const SUPPORTED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])

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

// ===== 结构感知编辑（v2）：符号重命名 =====

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

/**
 * 收集符号重命名位点：
 * - 声明标识符（函数/类/变量/接口/类型/枚举 + import 本地绑定）
 * - import 源名（`import { X as Y }` 的 X；未别名时与本地绑定同范围，按范围去重）
 * - 引用标识符（ReferencedIdentifier，含 export 说明符本地名、对象简写）
 *
 * 仅替换精确的 AST 标识符 token 范围——字符串/注释里的同名文本、`obj.x` 属性访问一律不触碰，
 * 这是"编辑前校验隔离性"的结构保证。
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
      const ast = tryParse(content, absPath)
      if (!ast) return undefined
      const relativePath = relative(relBase, absPath)
      const data: IndexedFile = {
        path: absPath,
        relativePath,
        symbols: extractSymbols(ast, absPath, relativePath),
        references: extractReferences(ast, absPath, relativePath, content),
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
      const ast = tryParse(content, f.path)
      if (!ast) continue
      const sites = collectRenameSites(ast, content, name)
      if (sites.length) byFile.set(f.path, sites)
    }
    return byFile
  }
}

// ===== 共享 helper（自包含，避免跨包依赖）=====

function makeSchema<T>(): Schema<T> {
  return {
    parse(value: unknown): T {
      return value as T
    },
    safeParse(value: unknown) {
      return { success: true, data: value as T }
    },
  }
}

function resolvePath(inputPath: string, cwd: string): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath)
}

function isWithinCwd(filePath: string, cwd: string): boolean {
  const rel = relative(cwd, filePath)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** 结果中返回的最多条目数（防止 LLM 上下文爆炸） */
const MAX_RESULTS = 200

// ========================================================================
// 1. code_symbols 工具
// ========================================================================

export interface CodeSymbolsInput {
  /** 文件或目录路径（缺省当前工作目录） */
  path?: string
}

export interface CodeSymbolsOutput {
  path: string
  count: number
  symbols: CodeSymbol[]
  truncated: boolean
}

export const codeSymbolsTool = (index: CodeIntelIndex): Tool<CodeSymbolsInput, CodeSymbolsOutput> =>
  defineTool<CodeSymbolsInput, CodeSymbolsOutput>({
    id: 'code_symbols',
    description: '列出文件或目录中的代码符号（函数/类/变量/接口/类型/枚举/导入）。基于 AST 解析，支持 TS/TSX/JS/JSX，返回符号名、类型、位置与签名。',
    inputSchema: makeSchema<CodeSymbolsInput>(),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permission: {
      key: 'read',
      extractPatterns: (input) => [input.path ?? '.'],
    },
    async call(input, ctx): Promise<ToolResult<CodeSymbolsOutput>> {
      const absPath = resolvePath(input.path ?? '.', ctx.cwd)
      if (!isWithinCwd(absPath, ctx.cwd)) {
        return { ok: false, error: { message: `路径 "${input.path ?? '.'}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' } }
      }
      try {
        const symbols = await index.symbols(absPath, ctx.cwd)
        const truncated = symbols.length > MAX_RESULTS
        return {
          ok: true,
          output: {
            path: absPath,
            count: symbols.length,
            symbols: symbols.slice(0, MAX_RESULTS),
            truncated,
          },
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { ok: false, error: { message: `路径不存在: ${input.path ?? '.'}`, code: 'PATH_NOT_FOUND' } }
        }
        return { ok: false, error: { message: err.message ?? String(err), code: 'CODE_INTEL_ERROR' } }
      }
    },
  })

// ========================================================================
// 2. code_reference 工具
// ========================================================================

export interface CodeReferenceInput {
  /** 符号名 */
  symbol: string
  /** 扫描根目录/文件（缺省当前工作目录） */
  path?: string
}

export interface CodeReferenceOutput {
  symbol: string
  path: string
  count: number
  references: CodeReference[]
  truncated: boolean
}

export const codeReferenceTool = (index: CodeIntelIndex): Tool<CodeReferenceInput, CodeReferenceOutput> =>
  defineTool<CodeReferenceInput, CodeReferenceOutput>({
    id: 'code_reference',
    description: '查找某符号在代码中的引用（usages，含跨文件）。先索引目标目录（AST 解析），再返回所有使用位置（行/列 + 上下文）。',
    inputSchema: makeSchema<CodeReferenceInput>(),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permission: {
      key: 'read',
      extractPatterns: (input) => [input.path ?? '.'],
    },
    async call(input, ctx): Promise<ToolResult<CodeReferenceOutput>> {
      const absPath = resolvePath(input.path ?? '.', ctx.cwd)
      if (!isWithinCwd(absPath, ctx.cwd)) {
        return { ok: false, error: { message: `路径 "${input.path ?? '.'}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' } }
      }
      try {
        await index.load(absPath, ctx.cwd)
        const references = index.allReferences(input.symbol)
        const truncated = references.length > MAX_RESULTS
        return {
          ok: true,
          output: {
            symbol: input.symbol,
            path: absPath,
            count: references.length,
            references: references.slice(0, MAX_RESULTS),
            truncated,
          },
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { ok: false, error: { message: `路径不存在: ${input.path ?? '.'}`, code: 'PATH_NOT_FOUND' } }
        }
        return { ok: false, error: { message: err.message ?? String(err), code: 'CODE_INTEL_ERROR' } }
      }
    },
  })

// ========================================================================
// 3. code_definition 工具
// ========================================================================

export interface CodeDefinitionInput {
  /** 符号名 */
  symbol: string
  /** 扫描根目录/文件（缺省当前工作目录） */
  path?: string
}

export interface CodeDefinitionOutput {
  symbol: string
  path: string
  count: number
  definitions: CodeDefinition[]
}

export const codeDefinitionTool = (index: CodeIntelIndex): Tool<CodeDefinitionInput, CodeDefinitionOutput> =>
  defineTool<CodeDefinitionInput, CodeDefinitionOutput>({
    id: 'code_definition',
    description: '符号 go-to-definition：返回符号的声明位置（文件/行/列/类型/签名）。先索引目标目录（AST 解析），再定位声明。',
    inputSchema: makeSchema<CodeDefinitionInput>(),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permission: {
      key: 'read',
      extractPatterns: (input) => [input.path ?? '.'],
    },
    async call(input, ctx): Promise<ToolResult<CodeDefinitionOutput>> {
      const absPath = resolvePath(input.path ?? '.', ctx.cwd)
      if (!isWithinCwd(absPath, ctx.cwd)) {
        return { ok: false, error: { message: `路径 "${input.path ?? '.'}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' } }
      }
      try {
        await index.load(absPath, ctx.cwd)
        const definitions = index.allDefinitions(input.symbol)
        return {
          ok: true,
          output: {
            symbol: input.symbol,
            path: absPath,
            count: definitions.length,
            definitions: definitions.slice(0, MAX_RESULTS),
          },
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { ok: false, error: { message: `路径不存在: ${input.path ?? '.'}`, code: 'PATH_NOT_FOUND' } }
        }
        return { ok: false, error: { message: err.message ?? String(err), code: 'CODE_INTEL_ERROR' } }
      }
    },
  })

// ========================================================================
// 4. code_semantic_edit 工具（v2，结构感知编辑）
// ========================================================================

/** rename：符号重命名输入 */
export interface CodeSemanticEditRenameInput {
  mode: 'rename'
  /** 要重命名的符号名 */
  symbol: string
  /** 新符号名（须为合法标识符） */
  to: string
  /** 扫描根目录/文件（缺省当前工作目录） */
  path?: string
  /** 仅预览（返回计划位点，不落盘）；默认 false */
  dryRun?: boolean
}

/** replace_node：按 AST 节点范围替换。行/列为 1-based（对齐 CodeSymbol.line/column 约定；列=该行第 1 个字符为 1） */
export interface CodeSemanticEditReplaceNodeInput {
  mode: 'replace_node'
  /** 目标文件（必填；节点替换作用于单文件） */
  path: string
  /** 替换起始行（1-based） */
  startLine: number
  /** 替换起始列（1-based） */
  startColumn: number
  /** 替换结束行（1-based） */
  endLine: number
  /** 替换结束列（1-based）；0 表示到 endLine 行尾 */
  endColumn?: number
  /** 替换文本（可为空串=删除该节点） */
  replacement: string
  /** 仅预览（返回吸附节点与预览，不落盘）；默认 false */
  dryRun?: boolean
}

/** code_semantic_edit 输入（按 mode 区分的联合） */
export type CodeSemanticEditInput = CodeSemanticEditRenameInput | CodeSemanticEditReplaceNodeInput

/** rename：单个文件的重命名结果 */
export interface RenameEditFile {
  file: string
  relativePath: string
  /** 该文件中替换的标识符数 */
  count: number
  sites: RenameSite[]
}

/** rename：输出 */
export interface CodeSemanticEditRenameOutput {
  mode: 'rename'
  symbol: string
  to: string
  path: string
  dryRun: boolean
  /** 已通过"编辑前校验隔离性"：全部文件内存中变换后重解析通过 */
  validated: boolean
  total: number
  files: RenameEditFile[]
}

/** replace_node：被吸附替换的 AST 节点 */
export interface CodeSemanticEditNode {
  /** 状态：exact=完全匹配 / absorbed=节点吸附（用户范围未精确对齐节点边界） */
  relation: 'exact' | 'absorbed'
  /** Babel 节点类型，如 VariableDeclaration / ExpressionStatement */
  type: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  /** 是否范围内仍有更小已含节点（提示：圈选过大吸附到父层） */
  hasInner: boolean
}

/** replace_node：输出 */
export interface CodeSemanticEditReplaceNodeOutput {
  mode: 'replace_node'
  path: string
  node: CodeSemanticEditNode
  /** 字符偏移范围（含/不含，绝对路径文件） */
  offsetStart: number
  offsetEnd: number
  replacement: string
  dryRun: boolean
  /** 替换后该文件结构重解析校验通过 */
  validated: boolean
  /** 替换后的文件内容预览 */
  preview: string
}

/** code_semantic_edit 输出（按 mode 区分的联合） */
export type CodeSemanticEditOutput = CodeSemanticEditRenameOutput | CodeSemanticEditReplaceNodeOutput

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * 结构感知编辑（v2）：按 mode 分发 rename / replace_node。
 *
 * 写操作：isReadOnly=false、isConcurrencySafe=false、permission.key='edit'。
 *
 * 隔离性保证（"编辑前校验隔离性"）：任一模式都在落盘前先在内存完成变换并重解析校验结构完整性，
 * 任一文件失败则整体放弃、不落盘；dryRun 可预览。
 */
export const codeSemanticEditTool = (index: CodeIntelIndex): Tool<CodeSemanticEditInput, CodeSemanticEditOutput> =>
  defineTool<CodeSemanticEditInput, CodeSemanticEditOutput>({
    id: 'code_semantic_edit',
    description: '结构感知编辑：rename（符号重命名，只改精确 AST 标识符位点，字符串与 obj.x 属性不触碰）/ replace_node（按 AST 节点范围替换，圈选自动吸附到节点）。落盘前重解析校验结构，dryRun 预览。',
    inputSchema: makeSchema<CodeSemanticEditInput>(),
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    permission: {
      key: 'edit',
      extractPatterns: (input) => [input.path ?? '.'],
    },
    async call(input, ctx): Promise<ToolResult<CodeSemanticEditOutput>> {
      if (input.mode === 'rename') return execRename(index, input, ctx)
      if (input.mode === 'replace_node') return execReplaceNode(index, input, ctx)
      return {
        ok: false,
        error: { message: `不支持的编辑模式: ${String((input as { mode?: string }).mode)}`, code: 'UNSUPPORTED_MODE' },
      }
    },
  })

// ===== rename（符号重命名）=====

async function execRename(
  index: CodeIntelIndex,
  input: CodeSemanticEditRenameInput,
  ctx: ToolContext,
): Promise<ToolResult<CodeSemanticEditRenameOutput>> {
  if (!IDENTIFIER_RE.test(input.to)) {
    return { ok: false, error: { message: `新符号名 "${input.to}" 不是合法标识符`, code: 'INVALID_IDENTIFIER' } }
  }
  if (input.symbol === input.to) {
    return { ok: false, error: { message: '新符号名与旧符号名相同', code: 'NO_OP' } }
  }
  const absPath = resolvePath(input.path ?? '.', ctx.cwd)
  if (!isWithinCwd(absPath, ctx.cwd)) {
    return { ok: false, error: { message: `路径 "${input.path ?? '.'}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' } }
  }
  try {
    const byFile = await index.collectRenameSitesFromScope(absPath, ctx.cwd, input.symbol)
    if (byFile.size === 0) {
      return { ok: false, error: { message: `未找到符号 "${input.symbol}"（请先确认名称与作用域）`, code: 'SYMBOL_NOT_FOUND' } }
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
      if (!tryParse(out, file)) {
        return {
          ok: false,
          error: {
            message: `重命名后 "${relative(ctx.cwd, file)}" 结构校验失败，已放弃（未落盘）`,
            code: 'EDIT_INVALID_STRUCTURE',
          },
        }
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
      dryRun: input.dryRun ?? false,
      validated: true,
      total: planned.reduce((n, p) => n + p.sites.length, 0),
      files,
    }
    if (input.dryRun) return { ok: true, output }
    for (const p of planned) {
      await writeFile(p.file, p.content)
      index.invalidate(p.file)
    }
    return { ok: true, output }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { ok: false, error: { message: `路径不存在: ${input.path ?? '.'}`, code: 'PATH_NOT_FOUND' } }
    }
    return { ok: false, error: { message: err.message ?? String(err), code: 'CODE_INTEL_ERROR' } }
  }
}

// ===== replace_node（按 AST 节点范围替换）=====

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

async function execReplaceNode(
  index: CodeIntelIndex,
  input: CodeSemanticEditReplaceNodeInput,
  ctx: ToolContext,
): Promise<ToolResult<CodeSemanticEditReplaceNodeOutput>> {
  const absPath = resolvePath(input.path, ctx.cwd)
  if (!isWithinCwd(absPath, ctx.cwd)) {
    return { ok: false, error: { message: `路径 "${input.path}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' } }
  }
  try {
    const content = await readFile(absPath, 'utf-8')
    const ast = tryParse(content, absPath)
    if (!ast) {
      return { ok: false, error: { message: `无法解析文件 ${relative(ctx.cwd, absPath)}（AST 解析失败）`, code: 'PARSE_ERROR' } }
    }
    const starts = buildLineStarts(content)
    const { start, end } = rangeToOffsets(content, starts, input.startLine, input.startColumn, input.endLine, input.endColumn)
    if (start < 0 || end < start || end > content.length) {
      return { ok: false, error: { message: '范围无效或越界（end 需 >= start 且不超文件长度）', code: 'INVALID_RANGE' } }
    }
    const hit = findContainingNode(ast, start, end)
    if (!hit) {
      return { ok: false, error: { message: '范围内未找到可替换的 AST 节点', code: 'NODE_NOT_FOUND' } }
    }
    // 整行圈选（endColumn=0）时，顺带消费紧随节点的行结尾换行符，避免替换后残留空行
    let consumedEnd = hit.node.end
    const wholeLine = !(input.endColumn && input.endColumn > 0)
    if (wholeLine && content[consumedEnd] === '\n') consumedEnd++
    const out = content.slice(0, hit.node.start) + input.replacement + content.slice(consumedEnd)
    if (!tryParse(out, absPath)) {
      return { ok: false, error: { message: '替换后结构校验失败，已放弃（未落盘）', code: 'EDIT_INVALID_STRUCTURE' } }
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
    if (input.dryRun) return { ok: true, output }
    await writeFile(absPath, out)
    index.invalidate(absPath)
    return { ok: true, output }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { ok: false, error: { message: `路径不存在: ${input.path}`, code: 'PATH_NOT_FOUND' } }
    }
    return { ok: false, error: { message: err.message ?? String(err), code: 'CODE_INTEL_ERROR' } }
  }
}

// ========================================================================
// 5. AgentPlugin 入口
// ========================================================================

/**
 * 代码情报插件
 *
 * 通过 tool.pool.assemble 注入 code_symbols / code_reference / code_definition。
 *
 * @param options.ignoreDirs 忽略目录名
 * @param options.maxFiles 单次目录索引最大文件数
 * @param options.maxDepth 目录递归最大深度
 */
export function createCodeIntelPlugin(options: CodeIntelOptions = {}): AgentPlugin {
  const index = new CodeIntelIndex(options)
  const tools: Tool[] = [
    codeSymbolsTool(index),
    codeReferenceTool(index),
    codeDefinitionTool(index),
    codeSemanticEditTool(index),
  ]

  return {
    id: 'code-intel',
    version: '0.3.0',
    name: '代码情报',
    description: '代码情报插件：code_symbols / code_reference / code_definition / code_semantic_edit(rename|replace_node)（AST 符号索引与结构感知编辑）',
    async install(ctx) {
      ctx.log.info('code-intel 插件已加载', { tools: tools.map((t) => t.id) })
      return {
        async 'tool.pool.assemble'(_input, pool) {
          for (const tool of tools) {
            ;(pool as { add: (t: unknown) => void }).add(tool)
          }
        },
      } as Hooks
    },
  }
}

/** 默认导出：注入三个代码情报工具的插件常量 */
export const codeIntelPlugin: AgentPlugin = createCodeIntelPlugin()

export default codeIntelPlugin
