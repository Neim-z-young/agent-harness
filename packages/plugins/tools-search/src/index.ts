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

import { defineTool, Tool, ToolResult, Schema, ToolContext } from '@harness/tool'
import type { AgentPlugin, Hooks } from '@harness/plugin'

import { resolve, isAbsolute, relative, join } from 'node:path'
import { stat, readFile, readdir } from 'node:fs/promises'

// ===== 共享 helper（自包含，避免跨包依赖）=====

function resolvePath(inputPath: string, cwd: string): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath)
}

function isWithinCwd(filePath: string, cwd: string): boolean {
  const rel = relative(cwd, filePath)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

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
  inputSchema: makeSchema<ListDirInput>(),
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
}

const MAX_GREP_FILES = 200

export const grepFileTool = defineTool<GrepFileInput, GrepFileOutput>({
  id: 'grep_file',
  description: '在文件或目录中搜索文本模式（正则表达式）。支持 glob 文件过滤、大小写敏感、递归搜索。',
  inputSchema: makeSchema<GrepFileInput>(),
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
      let regex: RegExp
      try {
        regex = new RegExp(input.pattern, input.caseSensitive === false ? 'gi' : 'g')
      } catch (e: any) {
        return { ok: false, error: { message: `正则表达式无效: ${e.message}`, code: 'INVALID_REGEX' } }
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
