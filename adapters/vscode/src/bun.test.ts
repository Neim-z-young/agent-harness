import { describe, expect, it } from 'bun:test'
import { bunBinaryName, describeBun, resolveBun, wellKnownBunPaths, type BunProbeInput } from './bun'

/** 默认：deps 齐全但"哪儿都没有 bun" */
function probe(over: Partial<BunProbeInput> = {}) {
  return resolveBun({
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    home: '/Users/u',
    cwd: '/repo',
    exists: () => false,
    ...over,
  })
}

describe('resolveBun：发现顺序', () => {
  it('1) 显式配置的绝对路径存在 ⇒ 最高优先，且不看 PATH', () => {
    const r = probe({
      configured: '/custom/bun',
      exists: (p) => p === '/custom/bun' || p === '/usr/bin/bun',
    })
    expect(r.path).toBe('/custom/bun')
    expect(r.source).toBe('config')
    expect(r.configInvalid).toBe(false)
  })

  it('1b) 配置了裸命令名（不含分隔符）⇒ 当成交给 PATH 解析，不算失效', () => {
    const r = probe({ configured: 'bun' })
    expect(r.path).toBe('bun')
    expect(r.source).toBe('config')
    expect(r.configInvalid).toBe(false)
  })

  it('1c) 配置了绝对路径但不存在 ⇒ 回落自动发现，且 configInvalid 为真（不静默）', () => {
    const r = probe({ configured: '/typo/bun', exists: (p) => p === '/usr/bin/bun' })
    expect(r.path).toBe('/usr/bin/bun')
    expect(r.configInvalid).toBe(true)
    expect(r.tried).toContain('/typo/bun')
  })

  it('1d) 配置项空白 ⇒ 等同没配', () => {
    const r = probe({ configured: '   ', exists: (p) => p === '/usr/bin/bun' })
    expect(r.path).toBe('/usr/bin/bun')
    expect(r.source).toBe('path')
    expect(r.configInvalid).toBe(false)
  })

  it('2) BUN_INSTALL 优先于 PATH 与已知位置', () => {
    const r = probe({
      env: { PATH: '/usr/bin', BUN_INSTALL: '/opt/bun' },
      exists: (p) => p === '/opt/bun/bin/bun' || p === '/usr/bin/bun',
    })
    expect(r.path).toBe('/opt/bun/bin/bun')
    expect(r.source).toBe('env')
  })

  it('3) PATH 命中', () => {
    const r = probe({ exists: (p) => p === '/bin/bun' })
    expect(r.path).toBe('/bin/bun')
    expect(r.source).toBe('path')
  })

  it('GUI 场景：PATH 里没有 bun 时靠已知安装位置兜底（旧 findBun 正是在这里失效）', () => {
    // launchd 给 GUI 应用的 PATH 就这么短；homebrew 装在 /opt/homebrew/bin
    const r = probe({
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      exists: (p) => p === '/opt/homebrew/bin/bun',
    })
    expect(r.path).toBe('/opt/homebrew/bin/bun')
    expect(r.source).toBe('well-known')
  })

  it('项目本地的 node_modules/.bin/bun 也算已知位置', () => {
    const r = probe({ exists: (p) => p === '/repo/node_modules/.bin/bun' })
    expect(r.path).toBe('/repo/node_modules/.bin/bun')
    expect(r.source).toBe('well-known')
  })

  it('四处都没有 ⇒ missing，且 tried 记录探过的位置', () => {
    const r = probe()
    expect(r.path).toBeUndefined()
    expect(r.source).toBe('missing')
    expect(r.configInvalid).toBe(false)
    expect(r.tried).toContain('/Users/u/.bun/bin/bun')
    expect(r.tried).toContain('/opt/homebrew/bin/bun')
  })

  it('tried 不为 PATH 的每个目录各记一条（否则排障输出会被淹没）', () => {
    const many = Array.from({ length: 40 }, (_, i) => `/p/${i}`).join(':')
    const r = probe({ env: { PATH: many } })
    expect(r.tried).toContain('PATH（40 个目录）')
    expect(r.tried.some((t) => t.startsWith('/p/'))).toBe(false)
  })
})

describe('resolveBun：平台差异', () => {
  it('Windows 用 bun.exe、分号分隔 PATH、%USERPROFILE%\\.bun\\bin', () => {
    const r = probe({
      platform: 'win32',
      env: { PATH: 'C:\\Windows;C:\\tools' },
      home: 'C:/Users/u',
      exists: (p) => p === 'C:\\Users\\u\\.bun\\bin\\bun.exe',
    })
    expect(r.path).toBe('C:\\Users\\u\\.bun\\bin\\bun.exe')
    expect(r.source).toBe('well-known')
  })

  it('Windows 的 PATH 命中用 bun.exe，且按 ; 切分', () => {
    const r = probe({
      platform: 'win32',
      env: { PATH: 'C:\\Windows;C:\\tools' },
      home: 'C:/Users/u',
      exists: (p) => p === 'C:\\tools\\bun.exe',
    })
    expect(r.path).toBe('C:\\tools\\bun.exe')
    expect(r.source).toBe('path')
  })

  it('二进制名按平台给', () => {
    expect(bunBinaryName('win32')).toBe('bun.exe')
    expect(bunBinaryName('darwin')).toBe('bun')
    expect(bunBinaryName('linux')).toBe('bun')
  })

  it('well-known 不含编不出处的位置（Windows 只有官方安装器 + 项目本地）', () => {
    const win = wellKnownBunPaths({ platform: 'win32', home: 'C:/Users/u', cwd: 'C:/repo' })
    expect(win).toEqual(['C:\\Users\\u\\.bun\\bin\\bun.exe', 'C:\\repo\\node_modules\\.bin\\bun.exe'])
  })
})

describe('describeBun：人读摘要', () => {
  it('找到了就说清出处', () => {
    const r = probe({ exists: (p) => p === '/opt/homebrew/bin/bun' })
    expect(describeBun(r)).toBe('/opt/homebrew/bin/bun（来源：well-known）')
  })

  it('配置来源显示成配置项名', () => {
    const r = probe({ configured: '/custom/bun', exists: (p) => p === '/custom/bun' })
    expect(describeBun(r)).toContain('harness.bunPath')
  })

  it('配置失效要写在摘要里（回落了但别瞒着）', () => {
    const r = probe({ configured: '/typo/bun', exists: (p) => p === '/bin/bun' })
    expect(describeBun(r)).toContain('/bin/bun')
    expect(describeBun(r)).toContain('配置的路径不存在')
  })

  it('没找到时给出"探过多少处"', () => {
    expect(describeBun(probe())).toContain('未找到 bun')
  })
})
