import { describe, expect, it } from 'bun:test'
import { CLI_ENTRY_RELPATH, resolveLaunchOptions, SIDECAR_BINARY_RELPATH } from './launch'

const WS = '/repo'
const BINARY = `${WS}/${SIDECAR_BINARY_RELPATH}`
const ENTRY = `${WS}/${CLI_ENTRY_RELPATH}`

function input(over: Partial<Parameters<typeof resolveLaunchOptions>[0]> = {}) {
  return {
    cwd: WS,
    bun: '/opt/homebrew/bin/bun',
    exists: (p: string) => p === BINARY || p === ENTRY,
    ...over,
  }
}

describe('resolveLaunchOptions：优先级', () => {
  it('编译二进制优先于 TS 入口（自包含、不依赖 bun 在 PATH）', () => {
    const r = resolveLaunchOptions(input())
    expect(r.cliPath).toBe(BINARY)
    expect(r.runner).toBeUndefined()
  })

  it('1) 显式 sidecarPath 最高优先，且不给 runner', () => {
    const r = resolveLaunchOptions(input({ sidecarPath: '/opt/harness-a2a' }))
    expect(r.cliPath).toBe('/opt/harness-a2a')
    expect(r.runner).toBeUndefined()
  })

  it('1b) sidecarPath 填了 .ts 入口也兼容（自动配 bun）', () => {
    const r = resolveLaunchOptions(input({ sidecarPath: '/x/cli.ts' }))
    expect(r.runner).toBe('/opt/homebrew/bin/bun')
  })

  it('2) 其次 cliPath；.ts 才配 runner', () => {
    expect(resolveLaunchOptions(input({ cliPath: '/x/cli.ts' })).runner).toBe('/opt/homebrew/bin/bun')
    expect(resolveLaunchOptions(input({ cliPath: '/x/cli.js' })).runner).toBeUndefined()
  })

  it('3) 没有二进制才回落 TS 入口 + bun', () => {
    const r = resolveLaunchOptions(input({ exists: (p) => p === ENTRY }))
    expect(r.cliPath).toBe(ENTRY)
    expect(r.runner).toBe('/opt/homebrew/bin/bun')
  })

  it('4) 都没有 → PATH 上的 harness（不给 runner）', () => {
    const r = resolveLaunchOptions(input({ exists: () => false }))
    expect(r.cliPath).toBe('harness')
    expect(r.runner).toBeUndefined()
  })

  it('空白配置当成没配（trim）', () => {
    const r = resolveLaunchOptions(input({ sidecarPath: '   ' }))
    expect(r.cliPath).toBe(BINARY)
  })

  it('token 空串不传、非空透传', () => {
    expect(resolveLaunchOptions(input({ token: '' })).token).toBeUndefined()
    expect(resolveLaunchOptions(input({ token: ' t ' })).token).toBe('t')
  })

  it('cwd 原样透传（harness 的工作目录）', () => {
    expect(resolveLaunchOptions(input({ cwd: '/other' })).cwd).toBe('/other')
  })
})

describe('resolveLaunchOptions：bun 缺失（A3 分发下的主要失败模式）', () => {
  it('没 bun 时**跳过** TS 入口路线（自动探测不选一条跑不起来的路线）', () => {
    const r = resolveLaunchOptions(input({ bun: undefined, exists: (p) => p === ENTRY }))
    expect(r.cliPath).toBe('harness')
    expect(r.notes.some((n) => n.includes('没找到 bun'))).toBe(true)
  })

  it('编译二进制不依赖 bun：无 bun 也走二进制，且不产出噪声', () => {
    const r = resolveLaunchOptions(input({ bun: undefined }))
    expect(r.cliPath).toBe(BINARY)
    expect(r.runner).toBeUndefined()
    expect(r.notes).toEqual([])
  })

  it('显式配置的 .ts 入口照用，但把"多半会失败"和补救办法说清楚', () => {
    const r = resolveLaunchOptions(input({ bun: '', sidecarPath: '/x/cli.ts' }))
    expect(r.cliPath).toBe('/x/cli.ts')
    expect(r.runner).toBeUndefined()
    expect(r.notes[0]).toContain('harness.sidecarPath')
    expect(r.notes[0]).toContain('harness.bunPath')
  })

  it('bun 是空白串当没找到（配置被清空后的常见形态）', () => {
    const r = resolveLaunchOptions(input({ bun: '   ', exists: (p) => p === ENTRY }))
    expect(r.cliPath).toBe('harness')
  })

  it('回落到 PATH harness 时记一条 note（这条最可能失败）', () => {
    const r = resolveLaunchOptions(input({ bun: undefined, exists: () => false }))
    expect(r.notes.some((n) => n.includes('PATH 上的 harness'))).toBe(true)
  })

  it('正常路径下 notes 为空（排障信息不制造噪声）', () => {
    expect(resolveLaunchOptions(input({ exists: (p) => p === ENTRY })).notes).toEqual([])
    expect(resolveLaunchOptions(input()).notes).toEqual([])
  })
})
