import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  UTF8_BOM,
  applyEol,
  detectBom,
  detectEol,
  normalizeEol,
  planWrite,
  preferredEol,
  stripBom,
  withBom,
} from './line-endings'
import { editFileTool, readFileTool, writeFileTool } from './index'
import type { ToolContext } from '@harness/tool'

// 自建目录（**不蹭** tools-builtin.test.ts 的 `.tmp-test`：那边有 afterEach 清理，
// 蹭过来会得到"文件莫名消失"的假失败 —— 这条在 P1-3 的真机 e2e 上踩过一次）。
let DIR = ''
beforeAll(() => { DIR = mkdtempSync(join(tmpdir(), 'eol-')) })
afterAll(() => { rmSync(DIR, { recursive: true, force: true }) })

function ctx(): ToolContext {
  return {
    sessionId: 's1', agentId: 'a', messageId: 'm', toolUseId: 't',
    signal: new AbortController().signal, variables: {}, cwd: DIR,
  }
}

const read = (name: string): string => readFileSync(join(DIR, name), 'utf-8')

// ===== 纯函数 =====

describe('P1-4 detectEol', () => {
  it('四种形态', () => {
    expect(detectEol('a\nb\n')).toBe('lf')
    expect(detectEol('a\r\nb\r\n')).toBe('crlf')
    expect(detectEol('a\r\nb\n')).toBe('mixed')
    expect(detectEol('no newline')).toBe('none')
    expect(detectEol('')).toBe('none')
  })

  it('★CRLF **不重复计数**（`\\r\\n` 里的 `\\n` 若被算成"裸 LF"，CRLF 文件会恒判 mixed）', () => {
    expect(detectEol('a\r\nb\r\nc\r\n')).toBe('crlf')
    expect(detectEol('x\r\ny\nz\r\nw\n')).toBe('mixed')
  })

  it('单独 CR（老 Mac 风格）归 CR 家族；与 LF 混用算 mixed', () => {
    expect(detectEol('a\rb\r')).toBe('crlf')
    expect(detectEol('a\rb\nc\r')).toBe('mixed')
  })
})

describe('P1-4 preferredEol / 转换', () => {
  it('crlf / mixed ⇒ `\\r\\n`；lf / none ⇒ `\\n`', () => {
    expect(preferredEol('crlf')).toBe('\r\n')
    expect(preferredEol('mixed')).toBe('\r\n') // 与改造前 `includes('\r\n')` 判据逐位等价
    expect(preferredEol('lf')).toBe('\n')
    expect(preferredEol('none')).toBe('\n')
  })

  it('★LF 文件恒等（`applyEol` 对 `\\n` 不做任何改动 ⇒ 既有行为逐位不变）', () => {
    const s = 'a\nb\n'
    expect(applyEol(s, '\n')).toBe(s)
    expect(applyEol(s, '\r\n')).toBe('a\r\nb\r\n')
  })

  it('normalizeEol 把 CRLF 与裸 CR 都归一到 LF', () => {
    expect(normalizeEol('a\r\nb\rc\n')).toBe('a\nb\nc\n')
  })

  it('★反复转换不叠字（`\\r\\r\\n` 这种）', () => {
    expect(applyEol('a\r\nb', '\r\n')).toBe('a\r\nb')
    expect(applyEol(normalizeEol('a\r\nb'), '\r\n')).toBe('a\r\nb')
  })
})

describe('P1-4 BOM', () => {
  it('按字节识别四种 BOM（`utf-8` 是唯一会写回保留的）', () => {
    expect(detectBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('utf-8')
    expect(detectBom(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe('utf-16le')
    expect(detectBom(new Uint8Array([0xfe, 0xff, 0x41, 0x00]))).toBe('utf-16be')
    expect(detectBom(new Uint8Array([0xff, 0xfe, 0x00, 0x00]))).toBe('utf-32')
    expect(detectBom(new Uint8Array([0x41]))).toBe('none')
  })

  it('字符串层只认 UTF-8 BOM', () => {
    expect(detectBom(`${UTF8_BOM}hi`)).toBe('utf-8')
    expect(detectBom('hi')).toBe('none')
  })

  it('stripBom / withBom 是一对逆操作', () => {
    expect(stripBom(`${UTF8_BOM}hi`)).toBe('hi')
    expect(withBom('hi', true)).toBe(`${UTF8_BOM}hi`)
    expect(withBom('hi', false)).toBe('hi')
    // 已经有就不重复加
    expect(withBom(`${UTF8_BOM}hi`, true)).toBe(`${UTF8_BOM}hi`)
  })

  it('planWrite 一次算完"该写成什么"', () => {
    expect(planWrite('a\nb\n', { eol: 'crlf', bom: 'utf-8' })).toBe(`${UTF8_BOM}a\r\nb\r\n`)
    expect(planWrite('a\nb\n', { eol: 'lf', bom: 'none' })).toBe('a\nb\n')
  })
})

// ===== 工具层（真文件）=====

describe('P1-4 read_file：如实报告行尾与 BOM，行号不因 CRLF 偏移', () => {
  it('★LF 与 CRLF 同内容的 `totalLines` / `linesRead` 一致（CRLF 不会多出或吞掉行）', async () => {
    writeFileSync(join(DIR, 'r-lf.txt'), 'a\nb\nc\n')
    writeFileSync(join(DIR, 'r-crlf.txt'), 'a\r\nb\r\nc\r\n')
    const lf = (await readFileTool.call!({ path: 'r-lf.txt' } as never, ctx())) as { output: { totalLines: number; linesRead: number[]; lineEnding: string } }
    const crlf = (await readFileTool.call!({ path: 'r-crlf.txt' } as never, ctx())) as { output: { totalLines: number; linesRead: number[]; lineEnding: string } }
    expect(lf.output.totalLines).toBe(crlf.output.totalLines)
    expect(lf.output.linesRead).toEqual(crlf.output.linesRead)
    expect(lf.output.lineEnding).toBe('lf')
    expect(crlf.output.lineEnding).toBe('crlf')
  })

  it('★带 BOM 的文件：`bom` 如实报，`content` **剥掉** BOM（否则模型会把它当首行内容）', async () => {
    writeFileSync(join(DIR, 'r-bom.txt'), `${UTF8_BOM}hello\nworld\n`)
    const r = (await readFileTool.call!({ path: 'r-bom.txt' } as never, ctx())) as { output: { bom: string; content: string; totalLines: number } }
    expect(r.output.bom).toBe('utf-8')
    expect(r.output.content.startsWith('hello')).toBe(true)
    expect(r.output.content).not.toContain(UTF8_BOM)
    // 行数不受 BOM 影响（BOM 不产生换行）
    expect(r.output.totalLines).toBe(3)
  })

  it('混合行尾如实报 mixed', async () => {
    writeFileSync(join(DIR, 'r-mixed.txt'), 'a\nb\r\nc\n')
    const r = (await readFileTool.call!({ path: 'r-mixed.txt' } as never, ctx())) as { output: { lineEnding: string } }
    expect(r.output.lineEnding).toBe('mixed')
  })
})

describe('P1-4 write_file：按目标既有风格写回', () => {
  it('★覆盖 CRLF 文件 ⇒ 仍写 CRLF（模型给 LF 也不会把整文件的行尾换掉）', async () => {
    writeFileSync(join(DIR, 'w-crlf.txt'), 'one\r\ntwo\r\n')
    const w = (await writeFileTool.call!({ path: 'w-crlf.txt', content: 'one\nTWO\n' } as never, ctx())) as { output: { lineEnding: string } }
    expect(w.output.lineEnding).toBe('crlf')
    expect(read('w-crlf.txt')).toBe('one\r\nTWO\r\n')
  })

  it('★覆盖 LF 文件 ⇒ 逐位等于 content（既有行为不变）', async () => {
    writeFileSync(join(DIR, 'w-lf.txt'), 'one\ntwo\n')
    await writeFileTool.call!({ path: 'w-lf.txt', content: 'one\nTWO\n' } as never, ctx())
    expect(read('w-lf.txt')).toBe('one\nTWO\n')
  })

  it('★保留目标原有的 BOM', async () => {
    writeFileSync(join(DIR, 'w-bom.txt'), `${UTF8_BOM}k\n`)
    await writeFileTool.call!({ path: 'w-bom.txt', content: 'v\n' } as never, ctx())
    expect(read('w-bom.txt')).toBe(`${UTF8_BOM}v\n`)
  })

  it('新建文件 ⇒ content 原样（不额外加换行、不加 BOM）', async () => {
    await writeFileTool.call!({ path: 'w-new.txt', content: 'x\ny\n' } as never, ctx())
    expect(read('w-new.txt')).toBe('x\ny\n')
  })

  it('append 到 CRLF 文件 ⇒ 追加段也用 CRLF（不会追加出混合行尾）', async () => {
    writeFileSync(join(DIR, 'w-app.txt'), 'a\r\nb\r\n')
    await writeFileTool.call!({ path: 'w-app.txt', content: 'c\n', mode: 'append' } as never, ctx())
    expect(read('w-app.txt')).toBe('a\r\nb\r\nc\r\n')
  })
})

describe('P1-4 edit_file：匹配容忍、写回保持、BOM 不丢', () => {
  it('★CRLF 文件 + LF 的 old_string ⇒ 匹配成功，且写回仍是 CRLF（钉住既有容忍行为）', async () => {
    writeFileSync(join(DIR, 'e-crlf.txt'), 'alpha\r\nbeta\r\ngamma\r\n')
    const r = (await editFileTool.call!({ path: 'e-crlf.txt', oldString: 'beta\ngamma', newString: 'BETA\nGAMMA' } as never, ctx())) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(read('e-crlf.txt')).toBe('alpha\r\nBETA\r\nGAMMA\r\n')
  })

  it('★带 BOM 的文件：能改首行，且写回保留 BOM', async () => {
    writeFileSync(join(DIR, 'e-bom.txt'), `${UTF8_BOM}first\nsecond\n`)
    const r = (await editFileTool.call!({ path: 'e-bom.txt', oldString: 'first', newString: 'FIRST' } as never, ctx())) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(read('e-bom.txt')).toBe(`${UTF8_BOM}FIRST\nsecond\n`)
  })

  it('★old_string 自带 BOM 也能匹配（模型可能从旧版 read_file 里复制出来的形态）', async () => {
    writeFileSync(join(DIR, 'e-bom2.txt'), `${UTF8_BOM}first\nsecond\n`)
    const r = (await editFileTool.call!({ path: 'e-bom2.txt', oldString: `${UTF8_BOM}first`, newString: 'FIRST' } as never, ctx())) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(read('e-bom2.txt')).toBe(`${UTF8_BOM}FIRST\nsecond\n`)
  })

  it('★LF 文件 ⇒ 逐位不变（不引入任何行尾改写）', async () => {
    writeFileSync(join(DIR, 'e-lf.txt'), 'a\nb\nc\n')
    await editFileTool.call!({ path: 'e-lf.txt', oldString: 'b', newString: 'B' } as never, ctx())
    expect(read('e-lf.txt')).toBe('a\nB\nc\n')
  })

  it('mixed 文件按 CRLF 处理（与改造前的 includes-CRLF 判据一致）', async () => {
    writeFileSync(join(DIR, 'e-mixed.txt'), 'a\r\nb\nc\r\n')
    const r = (await editFileTool.call!({ path: 'e-mixed.txt', oldString: 'b', newString: 'B' } as never, ctx())) as { ok: boolean }
    expect(r.ok).toBe(true)
    // 无换行的单 token 替换 ⇒ 内容只多一个 B，风格不动
    expect(read('e-mixed.txt')).toBe('a\r\nB\nc\r\n')
  })
})
