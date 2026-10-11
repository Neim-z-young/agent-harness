/**
 * @harness/tools-search - 搜索类工具插件
 *
 * 提供：
 * - list_dir：列出目录内容（支持递归、隐藏文件）
 * - grep_file：在文件/目录中搜索文本（正则、glob 过滤）
 *
 * 通过 core.tool.pool.assemble Hook 注入到 Harness 工具池。
 *
 * @example
 * import { createHarness } from '@harness/core'
 * import { toolsSearchPlugin } from '@harness/tools-search'
 *
 * const h = await createHarness({
 *   internalPlugins: [toolsSearchPlugin],
 *   agents: [{ id: 'default', name: 'Agent', mode: 'primary', tools: ['*'], permission: { '*': 'allow' }, promptFragments: [] }],
 * })
 */

import { defineTool, Tool, ToolResult, ToolContext, fromJsonSchema } from '@harness/tool'
import type { AgentPlugin, Hooks } from '@harness/plugin'

// 路径边界收敛到 @harness/fs-guard（P0-4/P0-5/P3-1；原来是本包自带的**纯字符串**判定）
import { resolvePath, isWithinCwd } from '@harness/fs-guard'
import { join } from 'node:path'
import { stat, readFile, readdir } from 'node:fs/promises'

/** glob 匹配（* → 任意字符，? → 单个字符） */
function globMatch(pattern: string, name: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${regexStr}$`).test(name)
}

// ========================================================================
// 1. list_dir 工具
// ========================================================================

export interface ListDirInput {
  path?: string
  recursive?: boolean
  showHidden?: boolean
  maxDepth?: number
}

export interface DirEntry {
  name: string
  type: 'file' | 'dir' | 'symlink'
  size?: number
  relativePath: string
}

export interface ListDirOutput {
  path: string
  entries: DirEntry[]
  count: number
  truncated: boolean
}

const MAX_DIR_ENTRIES = 500

export const listDirTool = defineTool<ListDirInput, ListDirOutput>({
  id: 'list_dir',
  description: '列出目录内容。支持递归、隐藏文件显示。返回文件名、类型和大小。',
  inputSchema: fromJsonSchema<ListDirInput>({
    type: 'object',
    properties: {
      path: { type: 'string', description: '要列出的目录（相对 cwd 或绝对路径，默认 "."）' },
      recursive: { type: 'boolean', description: '是否递归列出子目录' },
      showHidden: { type: 'boolean', description: '是否包含隐藏文件（默认 false）' },
      maxDepth: { type: 'number', description: '递归时的最大深度' },
    },
    additionalProperties: false,
  }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permission: {
    key: 'read',
    extractPatterns: (input) => [input.path ?? '.'],
  },
  async call(input, ctx): Promise<ToolResult<ListDirOutput>> {
    const relPath = input.path ?? '.'
    const absPath = resolvePath(relPath, ctx.cwd)

    if (!isWithinCwd(absPath, ctx.cwd)) {
      return {
        ok: false,
        error: { message: `路径 "${relPath}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' },
      }
    }

    try {
      const stats = await stat(absPath)
      if (!stats.isDirectory()) {
        return {
          ok: false,
          error: { message: `"${relPath}" 不是目录`, code: 'NOT_A_DIR' },
        }
      }

      const showHidden = input.showHidden ?? false
      const recursive = input.recursive ?? false
      const maxDepth = Math.min(input.maxDepth ?? 3, 5)
      const entries: DirEntry[] = []
      let truncated = false

      async function scanDir(dirPath: string, relBase: string, depth: number): Promise<void> {
        if (truncated) return
        if (depth > maxDepth) return

        const items = await readdir(dirPath, { withFileTypes: true })
        const sorted = items.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1
          if (!a.isDirectory() && b.isDirectory()) return 1
          return a.name.localeCompare(b.name)
        })

        for (const item of sorted) {
          if (!showHidden && item.name.startsWith('.')) continue
          if (entries.length >= MAX_DIR_ENTRIES) { truncated = true; return }

          const itemRel = relBase ? `${relBase}/${item.name}` : item.name
          let type: DirEntry['type'] = 'file'
          let size: number | undefined

          try {
            if (item.isSymbolicLink()) {
              type = 'symlink'
              const realStat = await stat(join(dirPath, item.name))
              if (realStat.isFile()) { type = 'file'; size = realStat.size }
              else if (realStat.isDirectory()) type = 'dir'
            } else if (item.isDirectory()) {
              type = 'dir'
            } else {
              type = 'file'
              const s = await stat(join(dirPath, item.name))
              size = s.size
            }
          } catch {
            // stat 失败时保守处理
          }

          entries.push({ name: item.name, type, size, relativePath: itemRel })

          if (recursive && type === 'dir' && depth < maxDepth) {
            await scanDir(join(dirPath, item.name), itemRel, depth + 1)
          }
        }
      }

      await scanDir(absPath, '', 0)

      return {
        ok: true,
        output: {
          path: absPath,
          entries,
          count: entries.length,
          truncated,
        },
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { ok: false, error: { message: `目录不存在: ${relPath}`, code: 'DIR_NOT_FOUND' } }
      }
      return { ok: false, error: { message: err.message ?? String(err), code: 'LIST_DIR_ERROR' } }
    }
  },
})

// ========================================================================
// 2. grep_file 工具
// ========================================================================

export interface GrepFileInput {
  pattern: string
  path?: string
  recursive?: boolean
  caseSensitive?: boolean
  include?: string
  maxResults?: number
  /** 按**纯文本**搜索（不编译正则）。默认 false = 先按正则解释，编译失败自动退化为字面量。 */
  literal?: boolean
}

export interface GrepMatch {
  filePath: string
  relativePath: string
  line: number
  content: string
  match: string
}

export interface GrepFileOutput {
  pattern: string
  path: string
  matches: GrepMatch[]
  count: number
  filesSearched: number
  truncated: boolean
  /** 本次实际使用的解释口径；`regex`（默认）时省略，不占上下文 */
  mode?: 'literal'
  /** 模式被自动**重新解释**时的说明（正则编译失败 ⇒ 已退化为字面量），必须回给模型 */
  notify?: string
}

const MAX_GREP_FILES = 200

/** 把任意文本转义成"只匹配它自己"的正则源（字面量搜索用） */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const grepFileTool = defineTool<GrepFileInput, GrepFileOutput>({
  id: 'grep_file',
  description:
    '在文件或目录中搜索文本。pattern 默认按**正则**解释；编译失败会自动退化为字面量搜索并在结果里注明。' +
    '要搜纯文本（如 `](`、`![`、`.*` 这类符号）请显式传 literal:true。支持 glob 过滤、大小写、递归。',
  inputSchema: fromJsonSchema<GrepFileInput>({
    type: 'object',
    properties: {
      // ⚠️ 这条描述曾经写的是「要搜索的文本（字面量）」，与实现（按正则编译）矛盾 ——
      // 模型信了描述、传 `](` `![` 这类 Markdown 片段，真机实测该工具 113 次调用里 43 次
      // 以 INVALID_REGEX 告终（38%），并把子 Agent 拖到 120s 硬超时。描述即契约，别写反。
      pattern: { type: 'string', description: '搜索模式：默认按正则解释；literal:true 时按纯文本' },
      path: { type: 'string', description: '搜索根目录或文件（默认 "."）' },
      recursive: { type: 'boolean', description: '是否递归子目录（默认 true）' },
      // 实现是 `caseSensitive === false ? 'gi' : 'g'` ⇒ 缺省=区分大小写。原描述写「默认 false」是反的。
      caseSensitive: { type: 'boolean', description: '是否区分大小写（默认 true = 区分；传 false 则忽略大小写）' },
      include: { type: 'string', description: '文件名过滤 glob（如 "*.ts"）' },
      maxResults: { type: 'number', description: '最大匹配数' },
      literal: { type: 'boolean', description: '按纯文本搜索，不做正则解释（默认 false）' },
    },
    required: ['pattern'],
    additionalProperties: false,
  }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permission: {
    key: 'read',
    extractPatterns: (input) => [input.path ?? '.'],
  },
  async call(input, ctx): Promise<ToolResult<GrepFileOutput>> {
    const relPath = input.path ?? '.'
    const absPath = resolvePath(relPath, ctx.cwd)

    if (!isWithinCwd(absPath, ctx.cwd)) {
      return {
        ok: false,
        error: { message: `路径 "${relPath}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' },
      }
    }

    try {
      // pattern 的解释口径 —— 这里曾是全仓失败率最高的工具问题。
      // 过去：schema 写「字面量」、实现按正则编译，且编译失败**硬报错**。模型要搜 Markdown 链接
      // 语法（`](` / `![` / `../`）时必失败，43/113 = 38%，重试风暴还把子 Agent 拖到硬超时。
      // 现在：literal=true 直接纯文本；否则先试正则，**编译失败自动退化为字面量**，
      // 并在输出里用 notify 说清"我改了什么" —— 不静默改口径，也不为可恢复的输入让整轮报废。
      const literal = input.literal === true
      const flags = input.caseSensitive === false ? 'gi' : 'g'
      let regex: RegExp
      let literalFallback: string | undefined
      if (literal) {
        regex = new RegExp(escapeRegExp(input.pattern), flags)
      } else {
        try {
          regex = new RegExp(input.pattern, flags)
        } catch (e: any) {
          literalFallback = e?.message ?? String(e)
          regex = new RegExp(escapeRegExp(input.pattern), flags)
        }
      }

      const recursive = input.recursive ?? true
      const includeGlob = input.include ?? '*'
      const maxResults = input.maxResults ?? 100
      const matches: GrepMatch[] = []
      let filesSearched = 0
      let truncated = false

      async function searchFile(filePath: string, relFilePath: string): Promise<void> {
        if (truncated) return
        filesSearched++
        if (filesSearched > MAX_GREP_FILES) { truncated = true; return }

        try {
          const content = await readFile(filePath, 'utf-8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) { truncated = true; return }
            regex.lastIndex = 0
            const m = regex.exec(lines[i])
            if (m) {
              matches.push({
                filePath,
                relativePath: relFilePath,
                line: i + 1,
                content: lines[i],
                match: m[1] ?? m[0],
              })
            }
          }
        } catch {
          // 跳过无法读取的文件
        }
      }

      async function scanDir(dirPath: string, relBase: string): Promise<void> {
        if (truncated) return
        const items = await readdir(dirPath, { withFileTypes: true })
        for (const item of items) {
          if (truncated) return
          if (item.name.startsWith('.') && !includeGlob.startsWith('.')) continue

          const itemAbs = join(dirPath, item.name)
          const itemRel = relBase ? `${relBase}/${item.name}` : item.name

          if (item.isDirectory()) {
            if (recursive) await scanDir(itemAbs, itemRel)
          } else if (item.isFile()) {
            if (globMatch(includeGlob, item.name)) {
              await searchFile(itemAbs, itemRel)
            }
          }
        }
      }

      const stats = await stat(absPath)
      if (stats.isFile()) {
        await searchFile(absPath, relPath)
      } else if (stats.isDirectory()) {
        await scanDir(absPath, '')
      } else {
        return { ok: false, error: { message: `路径不是文件或目录: ${relPath}`, code: 'INVALID_PATH' } }
      }

      return {
        ok: true,
        output: {
          pattern: input.pattern,
          path: absPath,
          matches,
          count: matches.length,
          filesSearched,
          truncated,
          ...(literal
            ? { mode: 'literal' as const }
            : literalFallback
              ? {
                  mode: 'literal' as const,
                  notify:
                    `pattern 不是合法正则（${literalFallback}），已按**字面量**搜索 "${input.pattern}"。` +
                    `若你要的是正则，请修正后重试；若本意就是纯文本，下次传 literal:true。`,
                }
              : {}),
        },
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { ok: false, error: { message: `路径不存在: ${relPath}`, code: 'PATH_NOT_FOUND' } }
      }
      return { ok: false, error: { message: err.message ?? String(err), code: 'GREP_ERROR' } }
    }
  },
})

// ========================================================================
// 3. AgentPlugin 入口
// ========================================================================

export const searchTools: Tool[] = [listDirTool, grepFileTool]

/**
 * 搜索工具插件
 *
 * 通过 core.tool.pool.assemble Hook 注入 list_dir / grep_file。
 *
 * @param options.toolIds 可选：只注入指定 ID 的工具（默认全部）
 */
export function createToolsSearchPlugin(options?: {
  toolIds?: string[]
}): AgentPlugin {
  const toolIds = options?.toolIds
  const tools = toolIds
    ? searchTools.filter((t) => toolIds.includes(t.id))
    : searchTools

  return {
    id: 'tools.search',
    version: '0.1.0',
    name: '搜索工具',
    description: '提供 list_dir / grep_file 搜索类工具',
    async install(ctx) {
      ctx.log.info('搜索工具插件已加载', { tools: tools.map((t) => t.id) })
      return {
        async 'core.tool.pool.assemble'(_input, pool) {
          for (const tool of tools) {
            ;(pool as { add: (t: unknown) => void }).add(tool)
          }
        },
      } as Hooks
    },
  }
}

/** 默认导出：注入 list_dir + grep_file 的插件常量 */
export const toolsSearchPlugin: AgentPlugin = createToolsSearchPlugin()
