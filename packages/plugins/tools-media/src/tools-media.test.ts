import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  viewImageTool,
  mediaTools,
  createToolsMediaPlugin,
} from './index'
import type { ToolContext } from '@harness/tool'

let dir: string
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-media-test-'))
  ctx = {
    cwd: dir,
    sessionId: 's1',
    agentId: 'default',
    messageId: 'm1',
    toolUseId: 'tu1',
    signal: new AbortController().signal,
    variables: {},
    requestPermission: async () => ({ behavior: 'allow' } as any),
  }
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// 最小合法 PNG (1x1 RGBA)，base64 编码
// 签名 8 字节 + IHDR (25 字节) + IDAT（带数据）+ IEND
// 生成：
//   signature: 89 50 4E 47 0D 0A 1A 0A
//   IHDR: length=13 49 48 44 52, width=2 BE, height=2 BE, bit_depth=8, color_type=6(RGBA), ..., crc
//   IDAT: 若干压缩像素
//   IEND: 空数据块
const MINI_PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR len=13
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, // w=2, h=2
  0x08, 0x06, 0x00, 0x00, 0x00,                     // 8-bit RGBA
  0x72, 0xB7, 0x87, 0x56,                           // crc32
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND
  0xAE, 0x42, 0x60, 0x82,                           // IEND crc
])

// 最小合法 JPEG：SOI + JFIF APP0 + DQT（空） + SOF0 + SOS + 压缩数据 + EOI
// 这里写一个合法的最小结构：SOI FFD8 + APP0（JFIF）+ 一段简化的 SOF0(S0 C0 15bit)+ EOI FFD9
// 重点：让魔数 FF D8 FF 通过、包含 SOF0 取出宽=8 高=8
function makeMiniJpeg(width: number, height: number): Uint8Array {
  const b: number[] = []
  // SOI
  b.push(0xFF, 0xD8)
  // APP0 JFIF
  const app0: number[] = [0xFF, 0xE0, 0x00, 0x10,
    0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00]
  for (const x of app0) b.push(x)
  // SOF0: marker=FFC0, length=11, precision=8, height=H (2B), width=W (2B), components=3 ...
  const sof0: number[] = [0xFF, 0xC0, 0x00, 0x0B,
    0x08,
    (height >> 8) & 0xFF, height & 0xFF,
    (width >> 8) & 0xFF, width & 0xFF,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]
  // 上面写的 length 是 0x00 0x0B 但实际给的是 16 字节，应该是 L = 8+3*3 = 17？简化：实际写 length=0x0011 (17字节)
  sof0[2] = 0x00; sof0[3] = 0x11
  for (const x of sof0) b.push(x)
  // SOS
  const sos: number[] = [0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xD2, 0xCF, 0x20]
  for (const x of sos) b.push(x)
  // EOI
  b.push(0xFF, 0xD9)
  return Uint8Array.from(b)
}

describe('viewImageTool', () => {
  it('读取 PNG：识别 mime、尺寸、base64', async () => {
    const p = join(dir, 'mini.png')
    writeFileSync(p, MINI_PNG_BYTES)

    const res = await viewImageTool.call!({ path: 'mini.png' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.mimeType).toBe('image/png')
    expect(res.output!.width).toBe(2)
    expect(res.output!.height).toBe(2)
    expect(res.output!.sizeBytes).toBe(MINI_PNG_BYTES.length)
    expect(res.output!.dataUri).toMatch(/^data:image\/png;base64,/)
    expect(res.output!.absolutePath).toBe(p)
  })

  it('读取 JPEG：识别尺寸', async () => {
    const bytes = makeMiniJpeg(8, 8)
    const p = join(dir, 'pic.jpg')
    writeFileSync(p, bytes)

    const res = await viewImageTool.call!({ path: 'pic.jpg' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.mimeType).toBe('image/jpeg')
    expect(res.output!.width).toBe(8)
    expect(res.output!.height).toBe(8)
  })

  it('非文件路径返回错误', async () => {
    const res = await viewImageTool.call!({ path: '.' } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('NOT_A_FILE')
  })

  it('路径不存在返回错误', async () => {
    const res = await viewImageTool.call!({ path: 'missing.png' } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('FILE_NOT_FOUND')
  })

  it('路径超出 cwd 被拒绝', async () => {
    const res = await viewImageTool.call!({ path: '/etc/hosts' } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('PATH_OUTSIDE_CWD')
  })

  it('超过大小：strictSize=true → 错误；strictSize=false → 只返回元数据（不包含 base64）', async () => {
    const bytes = new Uint8Array(MINI_PNG_BYTES)
    const p = join(dir, 'big.png')
    writeFileSync(p, bytes)

    const r1 = await viewImageTool.call!({
      path: 'big.png',
      maxBytes: 10,
      strictSize: true,
    } as any, ctx)
    expect(r1.ok).toBe(false); if (r1.ok) return
    expect(r1.error!.code).toBe('IMAGE_TOO_LARGE')

    const r2 = await viewImageTool.call!({
      path: 'big.png',
      maxBytes: 10,
      strictSize: false,
    } as any, ctx)
    expect(r2.ok).toBe(true); if (!r2.ok) return
    expect(r2.output!.mimeType).toBe('image/png')
    expect(r2.output!.width).toBe(2)
    expect(r2.output!.height).toBe(2)
    expect(r2.output!.dataUri).toBeUndefined()
  })

  it('未知格式：回落到 application/octet-stream', async () => {
    const bytes = Uint8Array.from([0x01, 0x02, 0x03, 0x04])
    writeFileSync(join(dir, 'unknown.bin'), bytes)

    const res = await viewImageTool.call!({ path: 'unknown.bin' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.mimeType).toBe('application/octet-stream')
    expect(res.output!.width).toBeUndefined()
    expect(res.output!.dataUri).toMatch(/^data:application\/octet-stream;base64,/)
  })
})

describe('插件集成', () => {
  it('mediaTools 导出包含 view_image', () => {
    expect(mediaTools.map((t) => t.id)).toEqual(['view_image'])
  })
  it('createToolsMediaPlugin id', () => {
    expect(createToolsMediaPlugin().id).toBe('tools.media')
  })
})
