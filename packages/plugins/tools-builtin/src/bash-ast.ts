/**
 * bash 命令 AST 分析（tree-sitter-bash via web-tree-sitter）。
 *
 * 动机（2026-09-30 调研，见 docs/research-bash-ast-and-kitty-keyboard.md）：
 * 主 bash 工具的危险命令检测是对**原始字符串**跑正则 —— 引号/转义/变量展开/命令替换
 * 都能让破坏性命令在字面上隐形（`"r"m -rf /`、`R=rm; $R -rf /`、`rm$IFS-rf$IFS/`…）。
 * 本模块把命令解析成语法树后产出**结构化事实**：
 *
 * 1. 所有 command 节点（含命令替换体 / 进程替换体内的**嵌套**命令）的解码字面量 ——
 *    引号与反斜杠转义已还原，`"r"m` → `rm`，正则在归一化文本上重新可见；
 * 2. 命令名是否含展开（`$R` / `$( )` / 反引号）—— 间接执行，字面量不可信；
 * 3. 重定向目标（含 fd 与操作符）的解码字面量。
 *
 * 安全定位：这是**判定输入的辅助证据**，不是沙箱。解析失败（`ok: false`）或 wasm
 * 不可用（返回 null）时，调用方必须回落原有字符串检测 —— 绝不因 AST 层缺失而放行。
 *
 * 范围（v1 刻意不做）：
 * - **不下钻 function_definition 函数体**：函数体命令在定义时不执行，下钻会让
 *   `f() { echo "rm -rf /"; }` 这类合法定义误触黑名单；
 * - 不解释 heredoc 体（是数据不是命令；原文正则仍覆盖其文本）；
 * - 不做变量求值（无法安全做到，展开一律按"不可见"处理，由调用方 fail-closed）。
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Node as TSNode, Parser as TSParser } from 'web-tree-sitter'

/** 命令名/参数中的展开占位符（U+FFFD：非字母数字、非路径分隔、非空白，正则不会误匹配） */
export const OPAQUE = '\uFFFD'

/** 一条命令（含嵌套在命令替换/进程替换体内的） */
export interface BashAstCommand {
  /** 解码后的命令名（引号/转义已还原）；含展开或无法解码 → null */
  name: string | null
  /** 命令名是否含展开（$VAR / $( ) / 反引号）—— 间接执行，字面量不可信 */
  nameOpaque: boolean
  /**
   * 命令名的展开是否**仅**为路径解析惯用法（`$(which x)` / `$(command -v x)` /
   * `$(type -P x)`，内部全字面量、无其它展开）。此时虽然 nameOpaque=true，
   * 但替换体本身已被审计无害 —— 调用方可据此放行（输出是可执行路径，语义明确）。
   */
  namePathResolution?: boolean
  /** 参数（解码失败 → text 为 null，raw 保留原文） */
  args: Array<{ text: string | null; raw: string }>
  /** 是否位于命令替换/进程替换体内（本次不直接执行，但其输出可能被求值） */
  nested: boolean
  /** 节点原文 */
  raw: string
}

/** 一次重定向 */
export interface BashAstRedirect {
  /** 文件描述符（`2>/dev/null` 的 "2"）；无 fd → null */
  fd: string | null
  /** 操作符：> >> &> >& <>& 等 */
  op: string
  /** 解码后的目标；含展开 → null */
  target: string | null
  nested: boolean
}

/** 一条命令的结构化事实 */
export interface BashCommandFacts {
  /** 语法树无错误。false 时调用方必须只用原有字符串检测 */
  ok: boolean
  /** 按出现顺序排列的全部命令（含嵌套） */
  commands: BashAstCommand[]
  /** 全部重定向（含嵌套上下文中的） */
  redirects: BashAstRedirect[]
  hasCommandSubstitution: boolean
  hasProcessSubstitution: boolean
  hasHeredoc: boolean
  /**
   * 归一化命令行：全部命令解码后按序拼接（`; ` 分隔），展开处替换为 {@link OPAQUE}。
   * 用于在**解码后**的文本上重跑危险正则，抓引号/转义混淆。
   */
  normalized: string
}

const req = createRequire(import.meta.url)

// ===== wasm 语法惰性单例（失败返回 null，调用方降级，不中断工具执行） =====

let parserPromise: Promise<TSParser | null> | null = null

async function getParser(): Promise<TSParser | null> {
  if (!parserPromise) parserPromise = initParser()
  return parserPromise
}

async function initParser(): Promise<TSParser | null> {
  try {
    const { Parser, Language } = await import('web-tree-sitter')
    await Parser.init()
    const bytes = readFileSync(req.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
    const lang = await Language.load(bytes)
    const parser = new Parser()
    parser.setLanguage(lang as never)
    return parser
  } catch {
    return null
  }
}

// ===== 字面量解码 =====

/** 这些节点的出现意味着所在 word 的字面量不可静态确定 */
const OPAQUE_NODE_TYPES = new Set([
  'simple_expansion', // $VAR / ${VAR}
  'string_expansion', // $"…"
  'command_substitution', // $( ) / ` `
  'process_substitution', // <( ) / >( )
  'arithmetic_expansion', // $(( ))
  'expansion', // ${…} 变体（各 grammar 版本命名差异）
  'binary_expansion', // ${a:-b} 等
])

/** 子树里是否出现任何展开节点 */
function containsExpansion(node: TSNode): boolean {
  if (OPAQUE_NODE_TYPES.has(node.type)) return true
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    if (c && containsExpansion(c)) return true
  }
  return false
}

/**
 * 把 word 位置的节点解码成**运行期字面量**。
 * 返回 null = 含展开/无法静态确定（不是"空串"）。
 */
function decodeWord(node: TSNode | null): string | null {
  if (!node) return null
  switch (node.type) {
    case 'word':
      // 词内反斜杠转义还原：`\rm` → `rm`、`\→`？只做字符级去反斜杠（bash 语义：非特殊字符前的 \ 即字符本身）
      return node.text.replace(/\\(.)/gs, '$1')
    case 'number':
      return node.text
    case 'raw_string':
      return node.text.length >= 2 ? node.text.slice(1, -1) : ''
    case 'ansi_c_string': {
      // $'…'：先解常见控制转义（\n \t \r），其余转义去反斜杠取字符本身
      if (node.text.length < 3) return ''
      return node.text
        .slice(2, -1)
        .replace(/\\([ntr])/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\r'))
        .replace(/\\(.)/gs, '$1')
    }
    case 'string': {
      // 双引号串：拼接 string_content；内部转义按 bash 双引号语义还原少数几个，其余原样
      let out = ''
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i)
        if (!c) continue
        if (c.type === 'string_content') out += c.text
        else if (c.type === 'escape_sequence') {
          const raw = c.text
          out += raw.length >= 2 && ['\\', '"', '$', '`'].includes(raw[1]!) ? raw.slice(1) : raw
        }
      }
      return out
    }
    case 'concatenation': {
      // "r"m / rm$IFS：拼接各部分；任一部分含展开 → 整体不可信
      let out = ''
      for (let i = 0; i < node.childCount; i++) {
        const part = decodeWord(node.child(i))
        if (part === null) return null
        out += part
      }
      return out
    }
    default:
      if (OPAQUE_NODE_TYPES.has(node.type)) return null
      if (node.childCount === 0) return node.text
      return null
  }
}

// ===== 树遍历与事实收集 =====

const REDIRECT_TYPES = new Set(['file_redirect', 'heredoc_redirect', 'herestring_redirect'])
/** 不下钻：函数体命令定义时不执行（见模块 doc） */
const SKIP_SUBTREE_TYPES = new Set(['function_definition'])

function collect(node: TSNode, nested: boolean, facts: Omit<BashCommandFacts, 'ok' | 'normalized'>): void {
  if (SKIP_SUBTREE_TYPES.has(node.type)) return
  if (node.type === 'command') {
    buildCommand(node, nested, facts)
  } else if (node.type === 'heredoc_redirect') {
    facts.hasHeredoc = true
    facts.redirects.push(buildRedirect(node, nested))
  } else if (REDIRECT_TYPES.has(node.type)) {
    facts.redirects.push(buildRedirect(node, nested))
  } else if (node.type === 'command_substitution') {
    facts.hasCommandSubstitution = true
  } else if (node.type === 'process_substitution') {
    facts.hasProcessSubstitution = true
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    // 命令替换/进程替换体内是"嵌套"上下文：其命令不直接执行，输出可能再被求值
    const childNested = nested
      || node.type === 'command_substitution'
      || node.type === 'process_substitution'
    if (c) collect(c, childNested, facts)
  }
}

function buildCommand(
  node: TSNode,
  nested: boolean,
  facts: Omit<BashCommandFacts, 'ok' | 'normalized'>,
): void {
  const args: BashAstCommand['args'] = []
  let name: string | null = null
  let nameOpaque = false
  let namePathResolution: boolean | undefined
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    if (!c) continue
    if (c.type === 'command_name') {
      // command_name 内是 word / concatenation / simple_expansion…
      const inner = c.childCount === 1 ? c.child(0) : c
      if (containsExpansion(c)) {
        nameOpaque = true
        name = null
        // 放行例外：展开仅为 `$(which x)` 类路径解析惯用法（见 isPathResolutionName）
        if (isPathResolutionName(c)) namePathResolution = true
      } else {
        name = decodeWord(inner)
        if (name === null) nameOpaque = true
      }
      continue
    }
    if (REDIRECT_TYPES.has(c.type)) {
      // 重定向直接挂在 command 下的形态（无 redirected_statement 包裹时）
      facts.redirects.push(buildRedirect(c, nested))
      continue
    }
    if (c.type === 'comment') continue
    const decoded = decodeWord(c)
    args.push({ text: decoded, raw: c.text })
  }
  facts.commands.push({ name, nameOpaque, namePathResolution, args, nested, raw: node.text })
}

/**
 * 命令名是否**仅**由「路径解析惯用法」构成：
 * `$(which x)` / `$(command -v x)` / `$(type -P x)`，其中 x 为纯字面量，
 * 且除这些替换体外无任何其它展开（simple_expansion / 进程替换 / 算术展开等）。
 *
 * 为什么单列这个白名单：命令名位置的替换体**输出**会成为被执行的程序，审计替换体
 * 内的命令文字不足以审计输出（`$(echo rm)` 的替换体无害、输出致命）。但 `which` /
 * `command -v` / `type -P` 的输出语义固定为「可执行文件的路径」，是脚本里解析
 * 绝对路径的标准写法（`$(which docker) ps`）—— 刻意放行这一个口子，其余
 * 命令名展开依旧 fail-closed。
 */
const PATH_RESOLVERS = new Set(['which', 'type', 'command'])

function isPathResolutionName(cmdNameNode: TSNode): boolean {
  let sawSubstitution = false
  const visit = (n: TSNode): boolean => {
    if (OPAQUE_NODE_TYPES.has(n.type) && n.type !== 'command_substitution') return false
    if (n.type === 'command_substitution') {
      sawSubstitution = true
      // 替换体内必须恰好是一条 path-resolver 命令，且参数全字面量、无嵌套替换
      const commands = collectInnerCommands(n)
      if (commands.length !== 1) return false
      const inner = commands[0]!
      if (!PATH_RESOLVERS.has(inner.name)) return false
      // `command -v x` / `type -P x`：校验旗标；`which x` 无旗标要求
      const flag = inner.args.find((a) => a.text !== null && a.text.startsWith('-'))
      if (inner.name === 'command' && flag?.text !== '-v') return false
      if (inner.name === 'type' && flag?.text !== '-P') return false
      // 全部参数（含旗标）必须可解码为字面量，且无嵌套替换
      return inner.args.every((a) => a.text !== null)
        && !inner.raw.includes('$(') && !inner.raw.includes('`')
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i)
      if (c && !visit(c)) return false
    }
    return true
  }
  if (!visit(cmdNameNode)) return false
  return sawSubstitution
}

/** 收集某个节点子树内的全部 command 节点（不跳过函数体 —— 此处子树极小） */
function collectInnerCommands(root: TSNode): Array<{ name: string; args: Array<{ text: string | null }> ; raw: string }> {
  const out: Array<{ name: string; args: Array<{ text: string | null }>; raw: string }> = []
  const walk = (n: TSNode): void => {
    if (n.type === 'command') {
      let name = ''
      const args: Array<{ text: string | null }> = []
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i)
        if (!c) continue
        if (c.type === 'command_name') {
          const inner = c.childCount === 1 ? c.child(0) : c
          name = containsExpansion(c) ? '' : decodeWord(inner) ?? ''
          continue
        }
        if (REDIRECT_TYPES.has(c.type) || c.type === 'comment') continue
        args.push({ text: decodeWord(c) })
      }
      out.push({ name, args, raw: n.text })
      return
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i)
      if (c) walk(c)
    }
  }
  walk(root)
  return out
}

function buildRedirect(node: TSNode, nested: boolean): BashAstRedirect {
  let fd: string | null = null
  let op = ''
  let target: string | null = null
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    if (!c) continue
    if (c.type === 'file_descriptor') fd = c.text
    else if (['>', '>>', '&>', '>&', '<>&', '<', '&<', '>&1', '>|'].includes(c.type) || c.type.startsWith('>') || c.type.startsWith('<')) {
      op = c.text || c.type
    } else if (c.type === 'heredoc_start') op = '<<'
    else if (c.type === 'herestring_start') op = '<<<'
    else if (c.type !== 'heredoc_body' && c.type !== 'heredoc_end') {
      // 目标 word / string / process_substitution…
      target = containsExpansion(c) ? null : decodeWord(c)
    }
  }
  if (node.type === 'heredoc_redirect' && !op) op = '<<'
  if (node.type === 'herestring_redirect' && !op) op = '<<<'
  return { fd, op, target, nested }
}

/**
 * 解析一条 bash 命令并产出结构化事实。
 *
 * - 解析成功：返回 `{ ok: true, … }`；
 * - 语法有错（`rootNode.hasError`）：返回 `{ ok: false, …已收集部分… }` —— 调用方对
 *   `ok: false` 只应使用原有字符串检测；
 * - wasm 加载失败（极端环境）：返回 null —— 同样回落字符串检测。
 *
 * 该函数为幂等纯分析（不改全局状态），wasm Parser 为模块级单例。
 */
export async function analyzeBashCommand(command: string): Promise<BashCommandFacts | null> {
  const parser = await getParser()
  if (!parser) return null
  const tree = parser.parse(command)
  if (!tree) return null
  const collected: Omit<BashCommandFacts, 'ok' | 'normalized'> = {
    commands: [],
    redirects: [],
    hasCommandSubstitution: false,
    hasProcessSubstitution: false,
    hasHeredoc: false,
  }
  collect(tree.rootNode, false, collected)
  const ok = !tree.rootNode.hasError
  return { ok, ...collected, normalized: normalize(collected) }
}

/** 归一化：全部命令解码拼接，展开处用 {@link OPAQUE} 占位；重定向以 `fd>op target` 形态追加 */
function normalize(facts: Omit<BashCommandFacts, 'ok' | 'normalized'>): string {
  const lines: string[] = []
  for (const cmd of facts.commands) {
    const parts = [cmd.name ?? (cmd.nameOpaque ? OPAQUE : cmd.raw)]
    for (const a of cmd.args) parts.push(a.text ?? OPAQUE)
    lines.push(parts.join(' '))
  }
  for (const r of facts.redirects) {
    const fdPart = r.fd ? `${r.fd}` : ''
    lines.push(`${fdPart}${r.op} ${r.target ?? OPAQUE}`)
  }
  return lines.join('; ')
}
