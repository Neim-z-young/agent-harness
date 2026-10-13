/**
 * `writeFileAtomic` 的单测（2026-10-13）
 *
 * ## 为什么单独一个文件
 * 原有的"原子写"散在 `storage.ts` / `compaction-store.ts` 里各写一遍，没有直接用例；
 * 而它的**失败模式恰恰只在 Windows 上出现**（并发 `Promise.all` 写同一目标 ⇒ `rename` `EPERM`），
 * 开发机（macOS）跑不出来。所以这里至少把**可在任何平台验证**的两件事钉住：
 *
 * 1. `isRetryableRenameError` 的判据 —— 只认 `EPERM` / `EBUSY` / `EACCES`，别的错误**立刻抛出**
 *    （不能把"真的写不进去"也吞掉变成重试）。
 * 2. `writeFileAtomic` 的正常路径：内容写对、**不留 tmp 残渣**、覆盖写。
 *
 * ⚠️ 重试**循环本身**（真 `EPERM` 后重试成功）只能在 Windows 上观测 —— 那是 CI 的职责；
 * 本文件能证的是"判据对不对 + 正常路径没坏"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRetryableRenameError, writeFileAtomic } from './atomic-write'

describe('isRetryableRenameError：只认"瞬时"错误码', () => {
  it('★EPERM / EBUSY / EACCES ⇒ 可重试（Windows 上并发 rename 的典型返回）', () => {
    expect(isRetryableRenameError(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(true)
    expect(isRetryableRenameError(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe(true)
    expect(isRetryableRenameError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(true)
  })

  it('★其它错误 / 没有 code ⇒ 不重试（把真问题吞成重试会更难查）', () => {
    expect(isRetryableRenameError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false)
    expect(isRetryableRenameError(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe(false)
    expect(isRetryableRenameError(new Error('plain'))).toBe(false)
    expect(isRetryableRenameError(null)).toBe(false)
    expect(isRetryableRenameError(undefined)).toBe(false)
    expect(isRetryableRenameError('EPERM')).toBe(false) // 字符串错误值不算（要有 .code）
  })
})

describe('writeFileAtomic：正常路径', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atomic-w-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('写入内容正确，且**不留** `.tmp` 残渣', async () => {
    const p = join(dir, 'a.json')
    await writeFileAtomic(p, '{"v":1}')
    expect(readFileSync(p, 'utf8')).toBe('{"v":1}')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('覆盖写：旧内容被整体替换（不是追加、也不是半截）', async () => {
    const p = join(dir, 'b.json')
    await writeFileAtomic(p, 'first-longer-content')
    await writeFileAtomic(p, 'second')
    expect(readFileSync(p, 'utf8')).toBe('second')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('★并发写同一目标不抛错：末态是**某一次**的完整内容（不撕裂）', async () => {
    // 这条在 macOS/Linux 上本来也过；它挡的是"把 tmp 名写死成同进程同目标共用一个"那类回归
    // （原 `compaction-store` 就是 `${p}.${process.pid}.tmp` —— 并发时两个调用会互相踩）
    const p = join(dir, 'c.json')
    const payloads = Array.from({ length: 8 }, (_, i) => `{"i":${i},${'x'.repeat(50)}}`)
    await Promise.all(payloads.map((c) => writeFileAtomic(p, c)))
    const got = readFileSync(p, 'utf8')
    expect(payloads).toContain(got)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
