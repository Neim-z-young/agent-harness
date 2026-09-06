/**
 * code-intel 多语言引擎（web-tree-sitter）
 *
 * 双后端导航：TS/JS 走 babel（语义级，见 index.ts）；此处为 Go / Python / Rust / Java 提供
 * code_symbols / code_reference / code_definition 所需的结构化信息。
 *
 * 设计约束（见 docs/codeintel-plugin.md）：
 * - tree-sitter 是通用 CST，不具备 babel 的作用域绑定 / 语义引用解析。故这里的
 *   code_reference 为**名字命中型（非语义）**：对声明符号名做 token 匹配（排除声明自身节点）。
 *   babel 语义引用不受影响（仅 TS/JS 走 babel）。
 * - 语义编辑：TS/JS 走 babel（rename/replace_*）。Java 例外——本模块提供 token 级
 *   **语义 rename**（`collectJavaRenameSites`）：基于 CST 精确收集声明 + 引用标识符 token 位点
 *   （排除注释/字符串/字面量），rename 后经 `verifyJavaSource` 重解析校验结构。
 *   注：引用为「同名标识符 token」级别（未做 JDK/重载作用域绑定），与名字命中型引用同级。
 *
 * WASM 定位注意：运行时依赖 node_modules 相对路径（createRequire 解析语法 wasm；
 * web-tree-sitter 的 tree-sitter.wasm 经 ESM 内部 new URL(import.meta.url) 解析）。
 *
 * 单二进制打包（import.meta.url 相对定位 + 显式复制）：参考 web-tree-sitter 自身加载
 * `tree-sitter.wasm` 的做法（ESM 内 `new URL(import.meta.url)`）。构建脚本
 * `scripts/copy-grammars.mts` 把三个语法 wasm 复制到产物目录（dist/），运行时 `new URL(file, import.meta.url)`
 * 相对模块位置解析即可命中，无需 node_modules 落盘；未命中再回退 `createRequire.resolve`（dev/测试路径）。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Node, Parser as TSParser } from 'web-tree-sitter'
import type { CodeSymbol, SymbolKind, CodeReference } from './index'

/** 多语言导航支持的扩展名 */
export const MULTI_EXT = new Set(['.go', '.py', '.rs', '.java'])

interface MultiResult {
  symbols: CodeSymbol[]
  references: Map<string, CodeReference[]>
}

const req = createRequire(import.meta.url)

const GRAMMAR = {
  '.go': 'tree-sitter-go/tree-sitter-go.wasm',
  '.py': 'tree-sitter-python/tree-sitter-python.wasm',
  '.rs': 'tree-sitter-rust/tree-sitter-rust.wasm',
  '.java': 'tree-sitter-java/tree-sitter-java.wasm',
} as const

/** 定位于本模块同目录的语法 wasm 文件名（构建脚本复制产物，见 `scripts/copy-grammars.mts`） */
const WASM_FILE = {
  '.go': 'tree-sitter-go.wasm',
  '.py': 'tree-sitter-python.wasm',
  '.rs': 'tree-sitter-rust.wasm',
  '.java': 'tree-sitter-java.wasm',
} as const

/** 文档：与多语言引擎取同一模块目录，供构建脚本/测试推导复制位置 */
export const GRAMMAR_SRC = GRAMMAR

/**
 * 读取某语言语法字节（Uint8Array，供 `Language.load(bytes)`）：
 * 1) 相邻产物复制：`new URL(WASM_FILE[ext], import.meta.url)` 相对模块定位（对齐 web-tree-sitter 自身做法）。
 *    构建产物目录（dist/）旁即复制好的 wasm，命中即用；
 * 2) 回退 node_modules 磁盘读取（dev/测试路径）。
 * 均失败返回 null（由上层降级为「不支持」）。
 */
export function readGrammarBytes(ext: string): Uint8Array | null {
  const slug = ext as keyof typeof GRAMMAR
  if (!GRAMMAR[slug]) return null
  // 1) 产物相邻复制
  try {
    const collocated = fileURLToPath(new URL(WASM_FILE[slug], import.meta.url))
    if (existsSync(collocated)) return readFileSync(collocated)
  } catch {
    // new URL / 转换失败 → 落到磁盘回退
  }
  // 2) 磁盘回退（dev/测试）
  try {
    const wasmPath = req.resolve(GRAMMAR[slug])
    return readFileSync(wasmPath)
  } catch {
    return null
  }
}

// ===== 惰性单例：Parser.init + 语法 wasm 加载（每个语言一个 Parser，缓存 Language）=====

let initPromise: Promise<TSParser | null> | null = null
let parserInst: TSParser | null = null
const languages = new Map<string, { type: 'loading'; p: Promise<unknown> } | { type: 'ok'; lang: unknown }>()

/** 初始化并返回共享 Parser（失败返回 null，由上层降级为「不支持」，不中断索引） */
export function getMultiParser(): Promise<TSParser | null> {
  if (!initPromise) initPromise = init()
  return initPromise
}

async function init(): Promise<TSParser | null> {
  try {
    const { Parser } = await import('web-tree-sitter')
    await (await import('web-tree-sitter')).Parser.init()
    parserInst = new Parser()
    // 预加载三个语法（失败仅当前语言不可用，不整包失败）
    await Promise.all(
      Object.entries(GRAMMAR).map(([ext]) =>
        languageFor(ext).catch(() => null),
      ),
    )
    return parserInst
  } catch {
    return null
  }
}

async function languageFor(ext: string): Promise<unknown | null> {
  if (!GRAMMAR[ext as keyof typeof GRAMMAR]) return null
  const entry = languages.get(ext)
  if (entry && entry.type === 'ok') return entry.lang
  if (entry && entry.type === 'loading') {
    try {
      await entry.p
    } catch {
      return null
    }
    const done = languages.get(ext)
    return done && done.type === 'ok' ? done.lang : null
  }
  let resolve: (v: unknown) => void
  const p = new Promise<unknown>((r) => {
    resolve = r
  })
  languages.set(ext, { type: 'loading', p })
  try {
    const { Language } = await import('web-tree-sitter')
    const bytes = readGrammarBytes(ext)
    if (!bytes) throw new Error(`no grammar bytes for ${ext}`)
    // 注入 Uint8Array 由 web-tree-sitter 实例化，兼容内联字节 / 磁盘读取两种来源
    const lang = await Language.load(bytes)
    languages.set(ext, { type: 'ok', lang })
    resolve!(lang)
    return lang
  } catch (err) {
    languages.delete(ext)
    resolve!(null)
    throw err
  }
}

/** 对某语言解析源码，返回根节点；失败返回 null */
async function parseRoot(content: string, ext: string): Promise<Node | null> {
  const parser = await getMultiParser()
  if (!parser) return null
  const lang = await languageFor(ext).catch(() => null)
  if (!lang) return null
  try {
    parser.setLanguage(lang as never)
    const tree = parser.parse(content)
    return tree ? tree.rootNode : null
  } catch {
    return null
  }
}

// ===== 符号提取（per-language）=====

type Decl = { name: string; kind: SymbolKind; node: Node }

function walkAll(root: Node, cb: (n: Node) => void): void {
  cb(root)
  for (const c of root.namedChildren) walkAll(c, cb)
}

/** 节点的某个直接命名子节点类型是否存在 */
function hasChildOfType(n: Node, type: string): boolean {
  return n.namedChildren.some((c) => c.type === type)
}

/** 取 name 字段名 */
function nameOf(n: Node): string {
  const f = n.childForFieldName('name')
  return f && f.text ? f.text : ''
}

function nameNodeRaw(n: Node): Node | null {
  return n.childForFieldName('name')
}

/** 去掉字符串字面量首尾引号 */
function bareLiteral(text: string): string {
  return text.replace(/^['"]/, '').replace(/['"]$/, '')
}

function pythonSymbols(root: Node): Decl[] {
  const out: Decl[] = []
  walkAll(root, (n) => {
    switch (n.type) {
      case 'function_definition':
      case 'async_function_definition':
      case 'class_definition': {
        const name = nameOf(n)
        if (name) out.push({ name, kind: n.type === 'class_definition' ? 'class' : 'function', node: n })
        break
      }
      case 'import_statement':
      case 'import_from_statement': {
        const name = nameOf(n)
        if (name) out.push({ name, kind: 'import', node: n })
        break
      }
      case 'assignment':
      case 'augmented_assignment': {
        // 形如 `USE = ...` / `USE += ...`；取左目标标识符作为变量符号，排除 self/cls
        const target = n.namedChildren[0]
        if (target && target.type === 'identifier' && target.text && target.text !== 'self' && target.text !== 'cls') {
          out.push({ name: target.text, kind: 'variable', node: target })
        }
        break
      }
    }
  })
  return out
}

function goSymbols(root: Node): Decl[] {
  const out: Decl[] = []
  walkAll(root, (n) => {
    switch (n.type) {
      case 'function_declaration':
      case 'method_declaration':
      case 'method_spec': {
        const name = nameOf(n)
        if (name) out.push({ name, kind: 'function', node: n })
        break
      }
      case 'type_spec': {
        const name = nameOf(n)
        if (!name) break
        const kind: SymbolKind = hasChildOfType(n, 'struct_type')
          ? 'class'
          : hasChildOfType(n, 'interface_type')
            ? 'interface'
            : 'type'
        out.push({ name, kind, node: n })
        break
      }
      case 'const_spec':
      case 'var_spec': {
        const name = nameOf(n)
        if (name) out.push({ name, kind: 'variable', node: n })
        break
      }
      case 'import_spec': {
        const alias = n.namedChildren.find((c) => c.type === 'package_identifier')
        const str = n.namedChildren.find((c) => c.type === 'interpreted_string_literal')
        if (alias) out.push({ name: alias.text, kind: 'import', node: alias })
        else if (str) out.push({ name: bareLiteral(str.text), kind: 'import', node: str })
        break
      }
    }
  })
  return out
}

function rustSymbols(root: Node): Decl[] {
  const KIND_BY_TYPE: Record<string, SymbolKind> = {
    function_item: 'function',
    struct_item: 'class',
    enum_item: 'enum',
    trait_item: 'interface',
    type_item: 'type',
    const_item: 'variable',
    static_item: 'variable',
  }
  const out: Decl[] = []
  walkAll(root, (n) => {
    if (n.type === 'use_declaration') {
      const name = nameOf(n)
      if (name) out.push({ name: name.split('::').pop() ?? name, kind: 'import', node: n })
      return
    }
    const kind = KIND_BY_TYPE[n.type]
    if (kind) {
      const name = nameOf(n)
      if (name) out.push({ name, kind, node: n })
    }
  })
  return out
}

function javaSymbols(root: Node): Decl[] {
  const out: Decl[] = []
  walkAll(root, (n) => {
    switch (n.type) {
      case 'class_declaration':
      case 'record_declaration': {
        const name = nameOf(n)
        if (name) out.push({ name, kind: 'class', node: n })
        break
      }
      case 'interface_declaration':
      case 'annotation_type_declaration': {
        const name = nameOf(n)
        if (name) out.push({ name, kind: 'interface', node: n })
        break
      }
      case 'enum_declaration': {
        const name = nameOf(n)
        if (name) out.push({ name, kind: 'enum', node: n })
        break
      }
      case 'method_declaration':
      case 'constructor_declaration': {
        const name = nameOf(n)
        if (name) out.push({ name, kind: 'function', node: n })
        break
      }
      case 'import_declaration': {
        // `import java.util.List;` → 取 scoped_identifier 最末段 identifier（含 static 导入）
        const scoped = n.namedChildren.find(
          (c) => c.type === 'scoped_identifier' || c.type === 'identifier',
        )
        if (scoped) {
          let last = scoped
          while (last.type === 'scoped_identifier') {
            const tail = last.namedChildren[last.namedChildren.length - 1]
            if (!tail) break
            last = tail
          }
          const name = last.text
          if (name) out.push({ name, kind: 'import', node: last })
        }
        break
      }
      case 'field_declaration':
      case 'local_variable_declaration': {
        // 字段/局部变量可有多个 declarator，每个有 name 字段
        for (const c of n.namedChildren) {
          if (c.type === 'variable_declarator') {
            const name = nameOf(c)
            if (name) out.push({ name, kind: 'variable', node: c })
          }
        }
        break
      }
    }
  })
  return out
}

const TOKEN_TYPES: Record<string, Set<string>> = {
  '.py': new Set(['identifier']),
  '.go': new Set(['identifier', 'type_identifier', 'field_identifier', 'package_identifier']),
  '.rs': new Set(['identifier', 'type_identifier', 'field_identifier']),
  '.java': new Set(['identifier', 'type_identifier']),
}

const SYMBOL_EXTRACTOR: Record<string, (root: Node) => Decl[]> = {
  '.py': pythonSymbols,
  '.go': goSymbols,
  '.rs': rustSymbols,
  '.java': javaSymbols,
}

// ===== 对外入口 =====

/**
 * 用 tree-sitter 提取某非 JS 文件的符号与引用。
 * 返回 null 表示解析失败或语言不支持（上层跳过该文件，不中断索引）。
 */
export async function extractMulti(
  content: string,
  filePath: string,
  relativePath: string,
  ext: string,
): Promise<MultiResult | null> {
  const root = await parseRoot(content, ext)
  if (!root) return null
  const decls = SYMBOL_EXTRACTOR[ext]?.(root) ?? []
  const contextLines = content.split('\n')

  const symbols: CodeSymbol[] = decls.map((d) => {
    const sp = d.node.startPosition
    return {
      name: d.name,
      kind: d.kind,
      file: filePath,
      relativePath,
      line: sp.row + 1,
      column: sp.column + 1,
      endLine: d.node.endPosition.row + 1,
    }
  })

  // 名字命中型引用：token 文本命中某声明符号名，且非该符号自身的声明 name 节点
  const declaredRanges = new Set<string>()
  const symbolNames = new Set<string>()
  for (const d of decls) {
    symbolNames.add(d.name)
    const nameNode = nameNodeRaw(d.node) ?? (d.kind === 'variable' ? d.node : null)
    if (nameNode) declaredRanges.add(`${nameNode.startIndex}:${nameNode.endIndex}`)
  }
  const refs = new Map<string, CodeReference[]>()
  const tokenTypes = TOKEN_TYPES[ext]
  if (tokenTypes) {
    walkAll(root, (n) => {
      if (!tokenTypes.has(n.type)) return
      const text = n.text
      if (!text || !symbolNames.has(text)) return
      if (declaredRanges.has(`${n.startIndex}:${n.endIndex}`)) return
      const line = n.startPosition.row
      const ref: CodeReference = {
        name: text,
        file: filePath,
        relativePath,
        line: line + 1,
        column: n.startPosition.column + 1,
        context: (contextLines[line] ?? '').trim().slice(0, 120),
      }
      const arr = refs.get(text)
      if (arr) arr.push(ref)
      else refs.set(text, [ref])
    })
  }

  return { symbols, references: refs }
}

// ===== Java 语义编辑（rename）：token 级位点 + 结构校验 =====

/**
 * Java 中「拥有 name 字段」的声明节点类型：
 * - 类型声明（class/record/interface/annotation_type/enum）：`name` → type_identifier
 * - 方法/构造器：`name` → identifier
 * - 变量声明符（字段/局部变量）：`variable_declarator.name` → identifier
 */
const JAVA_DECL_KINDS = new Set([
  'class_declaration',
  'record_declaration',
  'interface_declaration',
  'annotation_type_declaration',
  'enum_declaration',
  'method_declaration',
  'constructor_declaration',
  'variable_declarator',
])

/** Java 引用 token 类型：标识符 / 类型标识符 / 字段访问标识符（含 import 说明符尾部 token） */
const JAVA_REF_TOKENS = new Set(['identifier', 'type_identifier', 'field_identifier'])

export interface JavaRenameSite {
  /** JS 字符偏移（含） */
  start: number
  /** JS 字符偏移（不含） */
  end: number
  /** 声明（精确 name token）| 引用（同名标识符 token） */
  role: 'decl' | 'ref'
  /** 1-based 行 */
  line: number
}

/** JavaScript 语义编辑（rename）：token 级位点 + 结构校验 ===== */

/** Java 一个文件的包名与显式 import 列表（供跨目录反向 import 解析） */
export interface JavaModuleInfo {
  /** `package a.b;` 的完整限定名；缺省包为 '' */
  pkg: string
  /** import 说明符的完整限定名列表（如 `java.util.List`、`util.Shape`；含 static 导入） */
  imports: string[]
}

/**
 * 解析 Java 文件的包名与 import 限定名列表。返回 null 表示解析失败或语言不支持。
 * 反向 import 查找时用它判断某个外部文件的 `import a.b.Symbol` 是否指向本包声明的符号。
 */
export async function collectJavaModuleInfo(content: string): Promise<JavaModuleInfo | null> {
  const root = await parseRoot(content, '.java')
  if (!root) return null
  let pkg = ''
  const imports: string[] = []
  walkAll(root, (n) => {
    if (n.type === 'package_declaration') {
      // `package a.b;` → scoped_identifier 命名子节点即为完整限定名
      const scoped = n.namedChildren.find(
        (c) => c.type === 'scoped_identifier' || c.type === 'identifier',
      )
      if (scoped) pkg = scoped.text
    } else if (n.type === 'import_declaration') {
      const scoped = n.namedChildren.find(
        (c) => c.type === 'scoped_identifier' || c.type === 'identifier',
      )
      if (scoped) imports.push(scoped.text)
    }
  })
  return { pkg: pkg || '', imports }
}

/** tree-sitter 起始/结束偏移即为 JS 字符索引（web-tree-sitter 已把 UTF-8 字节偏移换算为字符索引），可直接用于 slice/替换 */

/**
 * 收集 Java 文件中与 `name` 同名的**标识符 token 语义位点**（CST token 精确范围，排除注释/字符串/字面量）。
 * 声明位点取其 name 字段（声明名），其余（含 import 说明符、引用、字段访问）归为引用。
 * 返回空数组表示解析失败或语言不支持。
 */
export async function collectJavaRenameSites(content: string, name: string): Promise<JavaRenameSite[]> {
  const root = await parseRoot(content, '.java')
  if (!root) return []

  // 1) 收集该符号的声明 name token（精确）
  const declared = new Set<string>()
  walkAll(root, (n) => {
    if (!JAVA_DECL_KINDS.has(n.type)) return
    const nameNode = n.childForFieldName('name')
    if (nameNode && nameNode.text === name) {
      declared.add(`${nameNode.startIndex}:${nameNode.endIndex}`)
    }
  })

  // 2) 收集同名标识符 token：声明 token → decl，其余 → ref
  const sites: JavaRenameSite[] = []
  walkAll(root, (n) => {
    if (!JAVA_REF_TOKENS.has(n.type)) return
    const text = n.text
    if (!text || text !== name) return
    const s = n.startIndex
    const e = n.endIndex
    sites.push({
      start: s,
      end: e,
      role: declared.has(`${s}:${e}`) ? 'decl' : 'ref',
      line: n.startPosition.row + 1,
    })
  })
  return sites
}

/** Java 重解析结构校验：无语法 ERROR 节点返回 true */
export async function verifyJavaSource(content: string): Promise<boolean> {
  const root = await parseRoot(content, '.java')
  return root ? !root.hasError : false
}