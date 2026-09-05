/**
 * code-intel 多语言引擎（web-tree-sitter）
 *
 * 双后端导航：TS/JS 走 babel（语义级，见 index.ts）；此处为 Go / Python / Rust 提供
 * code_symbols / code_reference / code_definition 所需的结构化信息。
 *
 * 设计约束（见 docs/codeintel-plugin.md）：
 * - tree-sitter 是通用 CST，不具备 babel 的作用域绑定 / 语义引用解析。故这里的
 *   code_reference 为**名字命中型（非语义）**：对声明符号名做 token 匹配（排除声明自身节点）。
 *   babel 语义引用不受影响（仅 TS/JS 走 babel）。
 * - 语义编辑（rename/replace_*）不扩到非 JS 语言。
 *
 * WASM 定位注意：运行时依赖 node_modules 相对路径（createRequire 解析语法 wasm；
 * web-tree-sitter 的 tree-sitter.wasm 经 ESM 内部 new URL(import.meta.url) 解析）。
 *
 * 单二进制打包（内联字节）：bun 1.3.14 无法经导入查询内联二进制，特提供**环境变量注入**——
 * 构建打包时把某语言 wasm 转 base64 写入其对应 env（见 `ENV_B64`），运行时优先进 `Language.load(bytes)`
 * （Uint8Array），无需 node_modules 落盘；未注入则回退磁盘 `createRequire.resolve` 读取（dev/测试路径）。
 */

import { createRequire } from 'node:module'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import type { Node, Parser as TSParser } from 'web-tree-sitter'
import type { CodeSymbol, SymbolKind, CodeReference } from './index'

/** 多语言导航支持的扩展名 */
export const MULTI_EXT = new Set(['.go', '.py', '.rs'])

interface MultiResult {
  symbols: CodeSymbol[]
  references: Map<string, CodeReference[]>
}

const req = createRequire(import.meta.url)

const GRAMMAR = {
  '.go': 'tree-sitter-go/tree-sitter-go.wasm',
  '.py': 'tree-sitter-python/tree-sitter-python.wasm',
  '.rs': 'tree-sitter-rust/tree-sitter-rust.wasm',
} as const

/** 各语言内联字节注入的环境变量（值 = 该语言 wasm 的 base64；单二进制打包时注入） */
const ENV_B64 = {
  '.go': 'HARNESS_GRAMMAR_B64_GO',
  '.py': 'HARNESS_GRAMMAR_B64_PY',
  '.rs': 'HARNESS_GRAMMAR_B64_RS',
} as const

/**
 * 读取某语言语法字节（Uint8Array，供 `Language.load(bytes)`）：
 * 1) 优先取对应 env 的内联 base64（单二进制打包/无 node_modules 场景）；
 * 2) 回退从 node_modules 磁盘读取（dev/测试路径）。
 * 均失败返回 null（由上层降级为「不支持」）。
 */
export function readGrammarBytes(ext: string): Uint8Array | null {
  const slug = ext as keyof typeof GRAMMAR
  if (!GRAMMAR[slug]) return null
  // 1) env 内联字节
  const envKey = ENV_B64[slug]
  const b64 = process.env[envKey]
  if (b64) {
    try {
      return Uint8Array.from(Buffer.from(b64, 'base64'))
    } catch {
      // base64 非法 → 落到磁盘回退
    }
  }
  // 2) 磁盘回退
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

const TOKEN_TYPES: Record<string, Set<string>> = {
  '.py': new Set(['identifier']),
  '.go': new Set(['identifier', 'type_identifier', 'field_identifier', 'package_identifier']),
  '.rs': new Set(['identifier', 'type_identifier', 'field_identifier']),
}

const SYMBOL_EXTRACTOR: Record<string, (root: Node) => Decl[]> = {
  '.py': pythonSymbols,
  '.go': goSymbols,
  '.rs': rustSymbols,
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