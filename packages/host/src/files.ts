/**
 * 文件引用提取与磁盘目录树（纯函数，P2-v2 自 @harness/cli 的 tui.tsx 上移）。
 *
 * 为什么要在这里：`/tree` 要给 VSCode 扩展用（`harness/tree.get` 控制方法 →
 * `stream.filetree`），sidecar 不能反向依赖 CLI —— 与 `/stats` 装配函数上移
 * `@harness/usage` 同一条纪律（docs/vscode-integration-design.md §6.3）。
 *
 * 依赖面：node:fs（只读 readdir/stat）、node:path、node:os。不做任何写入。
 */

import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// ------------------------------------------------------------------------
// 文件引用提取
// ------------------------------------------------------------------------

const FILE_REF_RE =
  /(?:\b(?:src|packages|docs|lib|app|api|scripts|test|tests|build)\b(?:\/[\w.\-]+)+|(?:~\/)?\/?(?:[\w.\-]+\/)+[\w.\-]+\.[A-Za-z]{1,6})(?::\d+(?::\d+)?)?/g

/** 从文本中提取「类文件路径」引用（含可选的 :行[:列] 后缀），按出现顺序去重 */
export function findFileReferences(text: string): Array<{ path: string; start: number; end: number }> {
  const out: Array<{ path: string; start: number; end: number }> = []
  const re = new RegExp(FILE_REF_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const path = m[0]
    if (!out.some((o) => o.path === path)) out.push({ path, start: m.index, end: m.index + path.length })
    if (re.lastIndex === m.index) re.lastIndex++
  }
  return out
}

/** 归一化引用为去重键：去掉 :行[:列] 后缀，避免同文件不同行号重复展示 */
export function fileRefBase(ref: string): string {
  return ref.replace(/:\d+(?::\d+)?$/, '')
}

/**
 * 归集一组文本里的文件引用（按基础路径去重、限量；保留首次出现的原始形态）。
 *
 * CLI 的 `collectFileReferences`（TUI blocks 版）与 sidecar 的 `harness/tree.get`
 * （会话消息版）都走这里 —— 去重/限量口径只有一份。
 */
export function collectFileRefsFromTexts(texts: readonly string[], max = 8): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const text of texts) {
    for (const f of findFileReferences(text)) {
      const base = fileRefBase(f.path)
      if (!seen.has(base)) {
        seen.add(base)
        out.push(f.path)
        if (out.length >= max) return out
      }
    }
  }
  return out
}

// ------------------------------------------------------------------------
// 路径缩写与解析
// ------------------------------------------------------------------------

/**
 * 把路径分隔符统一折成 `/`（**纯函数，导出以便单测**）。
 *
 * 用途：`abbrevFileRef` 这类**单行展示**函数要跨平台产出同一形态（`~/x`、`./src/a`），
 * 而 Windows 的 `homedir()` / `cwd` 都是反斜杠 —— 直接 `startsWith(home + '/')` **永远不命中**
 * （本仓 `displayPlanPath` 是同一个 bug）。⚠️ 别写 `split(sep).join('/')`：那在 macOS 上恒等，
 * **本机永远测不出 Windows 分支**。
 */
export function toPosix(p: string): string {
  return p.replaceAll('\\', '/')
}

/**
 * 缩写：外层文件引用路径为"可读且保留目录层级"的单行形态。
 * 优先相对化到主目录（`~/...`）再相对化到工作目录；仍超宽时对中间目录做省略
 * （`dir1/…/name.ext`），文件名与最近一级目录始终保留。
 *
 * 输出**恒用 `/`**（展示用途）；比较前先把两侧都折成 `/`，否则 Windows 上两条相对化
 * 分支都不会命中（`homedir()` 给 `C:\Users\x`，而这里比的是 `${home}/`）。
 *
 * @param base 工作目录基准（缺省 process.cwd()）。调用方应传**启动时解析出的工作目录**，
 *   否则以 `--cwd` 启动时 `./` 前缀会指向进程启动目录而非实际工作目录。
 */
export function abbrevFileRef(path: string, maxLen = 40, base?: string): string {
  if (!path) return path
  const p = toPosix(path)
  const home = toPosix(homedir())
  const rels: string[] = []
  // 主目录相对化（`~/...`）
  if (p === home) return '~'
  if (p.startsWith(home + '/')) rels.push('~' + p.slice(home.length))
  else if (p.startsWith('~/')) rels.push(p)
  // 工作目录相对化（`./...`），与主目录相对化并存、取较短者
  try {
    const cwd = toPosix(base ?? process.cwd())
    if (p === cwd) rels.push('.')
    else if (p.startsWith(cwd + '/')) rels.push('.' + p.slice(cwd.length))
    else if (p.startsWith('./')) rels.push(p)
  } catch { /* cwd 不可用则忽略 */ }
  // 相对化不了 ⇒ **原样返回**（不改既有语义；也避免把 Windows 的 `C:\x` 悄悄变成 `C:/x`）
  const rel = rels.length ? rels.sort((a, b) => a.length - b.length)[0]! : path
  if (rel.length <= maxLen) return rel
  // 超宽：保留目录前段 + 文件名末段，中间折叠，严格控制在 maxLen 内
  // （折叠前先归一成 `/` 分段，否则 Windows 的反斜杠路径会被当成"一整段"）
  const segs = toPosix(rel).split('/')
  const leaf = segs.pop() ?? rel
  const head = segs.shift() ?? ''
  let headFull = head
  for (const s of segs) {
    const candidate = (headFull ? headFull + '/' : '') + s
    // 折叠标记 `…/`(2) + 文件名(leaf) 需完整落在 maxLen 内
    if (candidate.length + 2 + leaf.length > maxLen) break
    headFull = candidate
  }
  const collapsed = `${headFull}/…/${leaf}`
  return collapsed.length <= maxLen ? collapsed : `…/${leaf}`
}

/**
 * 解析编辑器目标路径（双基准）：`~`/`~/` 开头 → 主目录；其余 → 基于工作目录。
 *
 * @param base 相对路径的基准目录，缺省 `process.cwd()`。调用方应传**启动时解析出的
 *   工作目录**（`--cwd` 可能不等于进程启动目录），否则相对路径会落到错误的目录。
 * 返回规范化的绝对路径，供编辑器打开与回读统一使用。
 */
export function resolveEditPath(path: string, base: string = process.cwd()): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(2))
  if (path.startsWith('~')) return join(homedir(), path.slice(1))
  return resolve(base, path)
}

// ------------------------------------------------------------------------
// 文件引用目录树（/tree 命令打印磁盘树 + 对话引用 * 标记）
// ------------------------------------------------------------------------

export interface FileRefTreeNode {
  /** 节点唯一键：root:{absPath} | 目录/文件的 absPath */
  key: string
  /** 根→路径缩写（./ | ~/...）；目录/文件→basename */
  name: string
  kind: 'root' | 'dir' | 'file'
  /** 绝对路径 */
  absPath: string
  /** 文件叶：被对话引用过（打印时以 * 标记） */
  marked?: boolean
  children: FileRefTreeNode[]
}

export interface DiskTreeOptions {
  /** 最大目录深度（根=0；默认 3） */
  maxDepth?: number
  /** 最大节点数（超出截断；默认 100） */
  maxNodes?: number
  /** 排除的 basename（目录与文件；默认 .git / node_modules / .DS_Store） */
  exclude?: string[]
  /** 工作目录基准（引用相对路径解析 + 根节点缩短用；缺省 process.cwd()） */
  cwd?: string
}

/**
 * 扫描磁盘构建「根 → 目录 → 文件」树（纯函数，/tree 命令用）。
 * - 目录在前、同级按字母序（类 `tree` 命令习惯）；
 * - 排除噪声（.git / node_modules 等），限制深度与节点数，超出置 truncated；
 * - 对话引用过的文件（abs 命中，含相对 root 解析）以 marked 标记。
 */
export function buildDiskFileTree(
  root: string,
  refs: string[],
  opts: DiskTreeOptions = {},
): { nodes: FileRefTreeNode[]; truncated: boolean } {
  const maxDepth = opts.maxDepth ?? 3
  const maxNodes = opts.maxNodes ?? 100
  const exclude = new Set(opts.exclude ?? ['.git', 'node_modules', '.DS_Store'])
  const baseCwd = opts.cwd ?? process.cwd()
  // 引用 → 绝对路径集合：cwd 基准 + 相对 root 基准双解析，覆盖 ~/绝对/相对三种形态
  const marked = new Set<string>()
  for (const ref of refs) {
    const base = fileRefBase(ref)
    marked.add(resolveEditPath(base, baseCwd))
    marked.add(resolve(root, base))
  }
  let count = 0
  let truncated = false
  const rootNode: FileRefTreeNode = {
    key: `root:${root}`,
    name: abbrevFileRef(root, 60, baseCwd),
    kind: 'root',
    absPath: root,
    children: [],
  }
  const scan = (dirAbs: string, node: FileRefTreeNode, depth: number): void => {
    if (truncated || depth >= maxDepth) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dirAbs, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1
      const bd = b.isDirectory() ? 0 : 1
      return ad - bd || a.name.localeCompare(b.name)
    })
    for (const e of entries) {
      if (exclude.has(e.name)) continue
      if (count >= maxNodes) { truncated = true; return }
      const childAbs = join(dirAbs, e.name)
      if (e.isDirectory()) {
        count++
        const child: FileRefTreeNode = { key: childAbs, name: e.name, kind: 'dir', absPath: childAbs, children: [] }
        node.children.push(child)
        scan(childAbs, child, depth + 1)
      } else if (e.isFile()) {
        count++
        node.children.push({ key: childAbs, name: e.name, kind: 'file', absPath: childAbs, marked: marked.has(childAbs), children: [] })
      }
      // 符号链接 / 特殊文件：忽略，避免循环与噪音
    }
  }
  scan(root, rootNode, 0)
  return { nodes: [rootNode], truncated }
}

/** 树中是否有被引用标记的节点 */
export function anyMarked(nodes: FileRefTreeNode[]): boolean {
  return nodes.some((n) => n.marked || anyMarked(n.children))
}

/**
 * 把森林渲染为树形文本（根不带分支线，目录带 `/`，被引用文件带 `*`）。
 */
export function renderFileRefTree(tree: FileRefTreeNode[]): string {
  const lines: string[] = []
  const walk = (nodes: FileRefTreeNode[], prefix: string) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const last = i === nodes.length - 1
      const branch = last ? '└─ ' : '├─ '
      const label = n.kind === 'file' ? n.name + (n.marked ? '*' : '') : n.name + (n.kind === 'dir' ? '/' : '')
      lines.push(prefix + branch + label)
      if (n.children.length > 0) walk(n.children, prefix + (last ? '   ' : '│  '))
    }
  }
  for (const root of tree) {
    lines.push(root.name)
    if (root.children.length > 0) walk(root.children, '')
  }
  return lines.join('\n')
}
