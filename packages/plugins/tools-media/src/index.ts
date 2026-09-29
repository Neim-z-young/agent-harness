/**
 * @harness/tools-media - 媒体类工具插件
 *
 * 提供：
 * - view_image：读取本地图像文件，返回 data:mime;base64 URL 与格式信息，供多模态 LLM 识别
 *
 * 支持格式：PNG / JPEG / GIF / WebP / BMP（通过魔数识别，不依赖额外图像库）
 *
 * 通过 core.tool.pool.assemble Hook 注入到 Harness 工具池。
 */

import { defineTool, fromJsonSchema, Tool, ToolResult, ToolContext } from '@harness/tool'
import type { AgentPlugin, Hooks } from '@harness/plugin'

import { resolve, isAbsolute, relative } from 'node:path'
import { readFile, stat, open } from 'node:fs/promises'

// ===== 共享 helper =====

function resolvePath(inputPath: string, cwd: string): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath)
}

function isWithinCwd(filePath: string, cwd: string): boolean {
  const rel = relative(cwd, filePath)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** 从文件头识别 MIME 类型（已知格式） */
function detectMimeAndDim(buf: Uint8Array): { mime: string; width?: number; height?: number } {
  // PNG: 89 50 4E 47 0D 0A 1A 0A；宽高在 4 字节偏移 16 起（big-endian 32bit）
  if (buf.length >= 24
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    const w = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19]
    const h = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23]
    return { mime: 'image/png', width: w >>> 0, height: h >>> 0 }
  }

  // JPEG: FF D8 FF ... FF D9
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    // 寻找 SOF0 (C0) / SOF2 (C2) 段取宽高
    let i = 2
    while (i < buf.length - 1) {
      if (buf[i] !== 0xFF) { i++; continue }
      const marker = buf[i + 1]
      if ((marker === 0xC0 || marker === 0xC2) && i + 8 < buf.length) {
        // SOF 段：长度(2) + precision(1) + height(2) + width(2)
        const h = (buf[i + 5] << 8) | buf[i + 6]
        const w = (buf[i + 7] << 8) | buf[i + 8]
        return { mime: 'image/jpeg', width: w, height: h }
      }
      // 段长度（跳过段头 4 字节 + 段长度 2 字节指示的长度）
      if (i + 3 < buf.length) {
        const segLen = (buf[i + 2] << 8) | buf[i + 3]
        i += 2 + segLen
      } else break
    }
    return { mime: 'image/jpeg' }
  }

  // GIF: 47 49 46 38 39 61 / 37 61；宽高 6-7, 8-9（little-endian）
  if (buf.length >= 10
    && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
    && (buf[4] === 0x39 || buf[4] === 0x37) && buf[5] === 0x61) {
    const w = buf[6] | (buf[7] << 8)
    const h = buf[8] | (buf[9] << 8)
    return { mime: 'image/gif', width: w, height: h }
  }

  // WebP: RIFF ???? WEBP VP8.... 宽高在 VP8L/VP8 头里（简化：只识别 mime，不解析尺寸）
  if (buf.length >= 12
    && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return { mime: 'image/webp' }
  }

  // BMP: 42 4D
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D) {
    if (buf.length >= 26) {
      const w = buf[18] | (buf[19] << 8) | (buf[20] << 16) | (buf[21] << 24)
      const h = buf[22] | (buf[23] << 8) | (buf[24] << 16) | (buf[25] << 24)
      return { mime: 'image/bmp', width: w >>> 0, height: h >>> 0 }
    }
    return { mime: 'image/bmp' }
  }

  return { mime: 'application/octet-stream' }
}

// ========================================================================
// 1. view_image 工具
// ========================================================================

export interface ViewImageInput {
  /** 图像路径（相对 cwd 或绝对路径） */
  path: string
  /** 最大字节（默认 8MB，超出则返回非 base64 仅元数据） */
  maxBytes?: number
  /** 是否在超出大小时拒绝（true → 错误；false → 只返回元数据不含 base64）。默认 false */
  strictSize?: boolean
}

export interface ViewImageOutput {
  /** 原路径 */
  path: string
  /** 绝对路径 */
  absolutePath: string
  /** 识别出的 MIME 类型 */
  mimeType: string
  /** 文件字节数 */
  sizeBytes: number
  /** 图像宽（若解析得到） */
  width?: number
  /** 图像高（若解析得到） */
  height?: number
  /** base64 data URI：data:<mime>;base64,...。若过大且 strictSize=false 可能缺失 */
  dataUri?: string
}

const DEFAULT_MAX_IMG_BYTES = 8 * 1024 * 1024

export const viewImageTool = defineTool<ViewImageInput, ViewImageOutput>({
  id: 'view_image',
  description: '读取本地图像文件，返回 base64 data URI 与尺寸/格式信息，供多模态 LLM 识别。支持 PNG/JPEG/GIF/WebP/BMP 自动识别。',
  inputSchema: fromJsonSchema<ViewImageInput>({
    type: 'object',
    properties: {
      path: { type: 'string', description: '图像路径（相对 cwd 或绝对路径）' },
      maxBytes: { type: 'number', description: '最大字节数（默认 8MB，超出则只返回元数据不含 base64）' },
      strictSize: { type: 'boolean', description: 'true = 超出 maxBytes 直接报错；false = 降级为仅元数据（默认）' },
    },
    required: ['path'],
    additionalProperties: false,
  }),
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  permission: {
    key: 'read',
    extractPatterns: (input) => [input.path],
  },
  async call(input, ctx): Promise<ToolResult<ViewImageOutput>> {
    const absPath = resolvePath(input.path, ctx.cwd)

    if (!isWithinCwd(absPath, ctx.cwd)) {
      return { ok: false, error: { message: `路径 "${input.path}" 超出工作目录范围`, code: 'PATH_OUTSIDE_CWD' } }
    }

    try {
      const st = await stat(absPath)
      if (!st.isFile()) {
        return { ok: false, error: { message: `"${input.path}" 不是文件`, code: 'NOT_A_FILE' } }
      }

      const maxBytes = Math.min(input.maxBytes ?? DEFAULT_MAX_IMG_BYTES, 20 * 1024 * 1024)
      if (st.size > maxBytes) {
        if (input.strictSize) {
          return {
            ok: false,
            error: { message: `图像 ${input.path} 超过大小限制 ${st.size} > ${maxBytes} 字节`, code: 'IMAGE_TOO_LARGE' },
          }
        }
        // 只读 32 字节用于识别格式/尺寸
        const fh = await open(absPath, 'r')
        const buf = new Uint8Array(32)
        const { bytesRead } = await fh.read({ buffer: buf, length: 32, position: 0 })
        await fh.close()
        const peek = bytesRead === 32 ? buf : buf.slice(0, bytesRead)
        const detected = detectMimeAndDim(peek)
        return {
          ok: true,
          output: {
            path: input.path,
            absolutePath: absPath,
            mimeType: detected.mime,
            sizeBytes: st.size,
            width: detected.width,
            height: detected.height,
          },
        }
      }

      const buf = await readFile(absPath) as unknown as Uint8Array
      const detected = detectMimeAndDim(buf)

      let b64: string
      if (typeof Buffer !== 'undefined') {
        b64 = Buffer.from(buf).toString('base64')
      } else {
        b64 = btoa(String.fromCharCode(...Array.from(buf)))
      }
      const dataUri = `data:${detected.mime};base64,${b64}`

      return {
        ok: true,
        output: {
          path: input.path,
          absolutePath: absPath,
          mimeType: detected.mime,
          sizeBytes: st.size,
          width: detected.width,
          height: detected.height,
          dataUri,
        },
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { ok: false, error: { message: `文件不存在: ${input.path}`, code: 'FILE_NOT_FOUND' } }
      }
      return { ok: false, error: { message: err.message ?? String(err), code: 'VIEW_IMAGE_ERROR' } }
    }
  },
})

// ========================================================================
// 2. AgentPlugin 入口
// ========================================================================

export const mediaTools: Tool[] = [viewImageTool]

export function createToolsMediaPlugin(options?: {
  toolIds?: string[]
}): AgentPlugin {
  const toolIds = options?.toolIds
  const tools = toolIds ? mediaTools.filter((t) => toolIds.includes(t.id)) : mediaTools

  return {
    id: 'tools.media',
    version: '0.1.0',
    name: '媒体工具',
    description: '提供 view_image 多模态图像读取工具',
    async install(ctx) {
      ctx.log.info('媒体工具插件已加载', { tools: tools.map((t) => t.id) })
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

export const toolsMediaPlugin: AgentPlugin = createToolsMediaPlugin()
