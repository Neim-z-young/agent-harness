/**
 * @harness/tools-glob - Glob 搜索工具插件
 *
 * 提供：
 * - glob：按模式（可多个）递归搜索匹配文件，支持排除/大小/时间过滤
 *
 * 通过 core.tool.pool.assemble Hook 注入到 Harness 工具池。
 *
 * @example
 * import { createHarness } from '@harness/core'
 * import { toolsGlobPlugin } from '@harness/tools-glob'
 *
 * const h = await createHarness({
 *   internalPlugins: [toolsGlobPlugin],
 *   agents: [{ id: 'default', name: 'Agent', mode: 'primary', tools: ['*'], permission: { '*': 'allow' }, promptFragments: [] }],
 * })
 */

import { defineTool, Tool, ToolResult, Schema, ToolContext } from '@harness/tool'
import type { AgentPlugin, Hooks } from '@harness/plugin'

import { resolve, isAbsolute, relative, join } from 'node:path'
import { stat, readdir } from 'node:fs/promises'

// ===== 共享 helper（自包含）=====

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

/**
 * glob 转 RegExp（支持 ** / * / ?）。
 * - **：匹配 0+ 个路径段（含中间的 / 分隔），可出现在任何位置
 * - * ：单层内任意字符（不含 /）
 * - ? ：单个非 / 字符
 */
function globToRegex(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/')
  const parts = p.split('/')
  let s = ''
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    const isLast = i === parts.length - 1
    if (seg === '**') {
      // **/xxx 或 a/**/b → (?:.*/)? （包含段间的/），最后一段的 ** 特殊处理成 .*
      s += isLast ? '.*' : '(?:.*/)?'
    } else {
      const escaped = seg
        .replace(/[.+^${}()|\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
      s += escaped
      if (!isLast) s += '/'
    }
  }
  return new RegExp('^' + s + '$')
}

// ========================================================================
// 1. glob 工具
// ========================================================================

export interface GlobInput {
  /** 一个或多个匹配模式（如 "*.ts"、["src/**\/*.ts", "!src/dist/**"]）。以 "!" 开头表示排除 */
  pattern: string | string[]
  /** 搜索根目录（相对 cwd 或绝对路径，默认 "."） */
  path?: string
  /** 最大结果数量（默认 500） */
  maxResults?: number
  /** 是否包含隐藏文件（默认 false） */
  includeHidden?: boolean
  /** 排除模式数组（便捷字段，等同在 pattern 里用 ! 前缀） */
  exclude?: string[]
  /** 最小文件大小（字节） */
  minSizeBytes?: number
  /** 最大文件大小（字节） */
  maxSizeBytes?: number
  /** 最大递归深度（默认 10） */
  maxDepth?: number
}

export interface GlobEntry {
  /** 基础文件名（不含路径） */
  name: string
  /** 相对于输入路径的相对路径（正斜杠） */
  relativePath: string
  /** 绝对路径 */
  absolutePath: string
  /** 文件大小（字节） */
  sizeBytes: number
  /** 修改时间（ms since epoch） */
  mtimeMs: number
  /** 条目类型 */
  type: 'file' | 'dir' | 'symlink'
}

export interface GlobOutput {
  pattern: string[]
  root: string
  entries: GlobEntry[]
  count: number
  filesScanned: number
  truncated: boolean
}

const MAX_GLOB_RESULTS = 5000

export const globTool = defineTool<GlobInput, GlobOutput>({
  id: 'glob',
  description: '按模式（glob，支持 **/*/? 通配符，! 取反）递归搜索文件，支持排除、大小过滤、深度限制。',
  inputSchema: makeSchema<GlobInput>(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permission: {
    key: 'read',
    extractPatterns: (input) => [input.path ?? '.'],
  },
  async call(input, ctx): Promise<ToolResult<GlobOutput>> {
    const relRoot = input.path ?? '.'
    const absRoot = resolvePath(relRoot, ctx.cwd)

    if (!isWithinCwd(absRoot, ctx.cwd)) {
      return {
        ok: false,
        error: { message: `路径 "${relRoot}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' },
      }
    }

    // 解析 include / exclude patterns
    const rawPatterns = Array.isArray(input.pattern) ? input.pattern : [input.pattern]
    const includes: RegExp[] = []
    const excludes: RegExp[] = []
    for (const pat of rawPatterns) {
      if (!pat) continue
      if (pat.startsWith('!')) excludes.push(globToRegex(pat.slice(1)))
      else includes.push(globToRegex(pat))
    }
    if (input.exclude) {
      for (const ex of input.exclude) {
        if (ex) excludes.push(globToRegex(ex.startsWith('!') ? ex.slice(1) : ex))
      }
    }
    if (includes.length === 0) includes.push(globToRegex('**/*'))

    const maxResults = Math.min(input.maxResults ?? MAX_GLOB_RESULTS, MAX_GLOB_RESULTS)
    const includeHidden = input.includeHidden ?? false
    const maxDepth = Math.min(input.maxDepth ?? 10, 20)
    const minSize = input.minSizeBytes
    const maxSize = input.maxSizeBytes

    const entries: GlobEntry[] = []
    let filesScanned = 0
    let truncated = false

    async function scan(dirPath: string, depth: number): Promise<void> {
      if (truncated) return
      if (depth > maxDepth) return

      const items = await readdir(dirPath, { withFileTypes: true })
      for (const item of items) {
        if (truncated) return
        if (!includeHidden && item.name.startsWith('.')) continue

        const abs = join(dirPath, item.name)
        const rel = relative(absRoot, abs).replace(/\\/g, '/')
        if (!rel || rel === '.') continue

        try {
          let kind: GlobEntry['type'] = 'file'
          let s = await stat(abs)
          if (item.isSymbolicLink()) kind = 'symlink'
          else if (s.isDirectory()) kind = 'dir'
          else kind = 'file'

          if (kind === 'file') {
            filesScanned++
            // 过滤
            if (minSize !== undefined && s.size < minSize) continue
            if (maxSize !== undefined && s.size > maxSize) continue
            const passInclude = includes.length === 0 || includes.some((r) => r.test(rel) || r.test(item.name))
            const passExclude = excludes.length === 0 || !excludes.some((r) => r.test(rel) || r.test(item.name))
            if (passInclude && passExclude) {
              if (entries.length >= maxResults) { truncated = true; return }
              entries.push({
                name: item.name,
                relativePath: rel,
                absolutePath: abs,
                sizeBytes: s.size,
                mtimeMs: s.mtimeMs,
                type: kind,
              })
            }
          }
          if (kind === 'dir') {
            await scan(abs, depth + 1)
          }
        } catch {
          // 跳过无法 stat/read 的条目
        }
      }
    }

    try {
      const rootStats = await stat(absRoot)
      if (!rootStats.isDirectory()) {
        return { ok: false, error: { message: `"${relRoot}" 不是目录`, code: 'NOT_A_DIR' } }
      }
      await scan(absRoot, 0)
      return {
        ok: true,
        output: {
          pattern: rawPatterns,
          root: absRoot,
          entries: entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
          count: entries.length,
          filesScanned,
          truncated,
        },
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { ok: false, error: { message: `目录不存在: ${relRoot}`, code: 'DIR_NOT_FOUND' } }
      }
      return { ok: false, error: { message: err.message ?? String(err), code: 'GLOB_ERROR' } }
    }
  },
})

// ========================================================================
// 2. AgentPlugin 入口
// ========================================================================

export const globTools: Tool[] = [globTool]

export function createToolsGlobPlugin(options?: {
  toolIds?: string[]
}): AgentPlugin {
  const toolIds = options?.toolIds
  const tools = toolIds ? globTools.filter((t) => toolIds.includes(t.id)) : globTools

  return {
    id: 'tools.glob',
    version: '0.1.0',
    name: 'Glob 搜索工具',
    description: '提供 glob 搜索工具（按模式匹配查找文件）',
    async install(ctx) {
      ctx.log.info('Glob 工具插件已加载', { tools: tools.map((t) => t.id) })
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

export const toolsGlobPlugin: AgentPlugin = createToolsGlobPlugin()
