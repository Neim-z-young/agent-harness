import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'

import { resolvePath, realpathBestEffort, isWithinRoot, isWithinCwd } from './index'

// ===== 工具 =====

/** 建一个临时目录（返回**真实路径** —— macOS 上 /var 是 /private/var 的链接，两处口径要对齐） */
function mkTmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** 递归收集 `packages` 下的 .ts 源文件（跳过 node_modules / dist） */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) collectSources(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

// ===== resolvePath：纯字符串，不碰文件系统 =====

describe('resolvePath', () => {
  it('相对路径按 cwd 解析；绝对路径原样归一', () => {
    expect(resolvePath('a.txt', '/tmp/x')).toBe('/tmp/x/a.txt')
    expect(resolvePath('/abs/a.txt', '/tmp/x')).toBe('/abs/a.txt')
  })

  it('折叠 `..` 与 `.`，不做 realpath', () => {
    expect(resolvePath('../a', '/tmp/x/y')).toBe('/tmp/x/a')
    expect(resolvePath('./a', '/tmp/x')).toBe('/tmp/x/a')
    // 不碰文件系统：这个路径根本不存在，也不会抛
    expect(resolvePath('/nope/never/here.txt', '/tmp')).toBe('/nope/never/here.txt')
  })

  it('保留符号链接（realpath 的活由 isWithinCwd 干）', () => {
    const dir = mkTmp('fsg-rp-')
    try {
      writeFileSync(join(dir, 'real.txt'), 'x')
      symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'))
      expect(resolvePath('link.txt', dir)).toBe(join(dir, 'link.txt'))
      expect(resolvePath('link.txt', dir)).not.toBe(join(dir, 'real.txt'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ===== realpathBestEffort =====

describe('realpathBestEffort', () => {
  it('已存在的路径 ⇒ 真实路径（跟随符号链接）', () => {
    const dir = mkTmp('fsg-rb-')
    const outside = mkTmp('fsg-rb-out-')
    try {
      symlinkSync(outside, join(dir, 'secret'))
      expect(realpathBestEffort(join(dir, 'secret'))).toBe(outside)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('不存在的路径 ⇒ 上溯到最近存在的祖先再拼回剩余段', () => {
    const dir = mkTmp('fsg-rb2-')
    try {
      expect(realpathBestEffort(join(dir, 'a', 'b', 'new.txt'))).toBe(join(dir, 'a', 'b', 'new.txt'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★祖先里有符号链接时，剩余段拼在**真实**祖先下（逃逸就是这么被揪出来的）', () => {
    const dir = mkTmp('fsg-rb3-')
    const outside = mkTmp('fsg-rb3-out-')
    try {
      symlinkSync(outside, join(dir, 'secret'))
      expect(realpathBestEffort(join(dir, 'secret', 'new.txt'))).toBe(join(outside, 'new.txt'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

// ===== isWithinRoot：纯字符串口径 =====

describe('isWithinRoot', () => {
  it('根自身 / 子路径 ⇒ true', () => {
    expect(isWithinRoot('/a/b', '/a/b')).toBe(true)
    expect(isWithinRoot('/a/b/c', '/a/b')).toBe(true)
  })

  it('父目录 / 兄弟前缀目录 ⇒ false', () => {
    expect(isWithinRoot('/a', '/a/b')).toBe(false)
    expect(isWithinRoot('/a/bc', '/a/b')).toBe(false) // 前缀相同但不是子孙
    expect(isWithinRoot('/a/b/../c', '/a/b')).toBe(false)
  })

  it('`..` 只认整段：`..foo` 是普通目录名，算在里面', () => {
    expect(isWithinRoot('/a/b/..foo/f', '/a/b')).toBe(true)
  })
})

// ===== isWithinCwd：P0-4 的核心 =====

describe('isWithinCwd', () => {
  it('cwd 内 / cwd 自身 / cwd 外', () => {
    const dir = mkTmp('fsg-w-')
    try {
      mkdirSync(join(dir, 'sub'))
      expect(isWithinCwd(dir, dir)).toBe(true)
      expect(isWithinCwd(join(dir, 'sub', 'f.txt'), dir)).toBe(true)
      expect(isWithinCwd(dirname(dir), dir)).toBe(false)
      expect(isWithinCwd(join(dir, '..', 'elsewhere'), dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('还不存在的新文件（写入路径）也在内', () => {
    const dir = mkTmp('fsg-w2-')
    try {
      expect(isWithinCwd(join(dir, 'a', 'b', 'new.txt'), dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★符号链接指向界外 ⇒ false（改造前这里会**通过**）', () => {
    const dir = mkTmp('fsg-w3-')
    const outside = mkTmp('fsg-w3-out-')
    try {
      writeFileSync(join(outside, 'passwd'), 'root:x:0:0')
      symlinkSync(outside, join(dir, 'secret'))
      // ① 目标存在（读路径）
      expect(isWithinCwd(join(dir, 'secret', 'passwd'), dir)).toBe(false)
      // ② 目标不存在（写路径）：上溯到链接本身，仍要判界外
      expect(isWithinCwd(join(dir, 'secret', 'new.txt'), dir)).toBe(false)
      // ③ 中间目录整条都是链接
      expect(isWithinCwd(join(dir, 'secret', 'a', 'b.txt'), dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('符号链接指向界内 ⇒ true（不能把合法链接一起误杀）', () => {
    const dir = mkTmp('fsg-w4-')
    try {
      mkdirSync(join(dir, 'real'))
      symlinkSync(join(dir, 'real'), join(dir, 'alias'))
      expect(isWithinCwd(join(dir, 'alias', 'f.txt'), dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cwd 自身经符号链接（macOS /var → /private/var）⇒ 两侧都取真实路径，不误判', () => {
    const dir = mkTmp('fsg-w5-')
    try {
      // 故意用**未解析**的 tmpdir 形态当 cwd（macOS 上就是 /var/folders/... vs /private/var/...）
      const unrealCwd = join(tmpdir(), dir.slice(dir.lastIndexOf(sep) + 1))
      writeFileSync(join(dir, 'f.txt'), 'x')
      expect(isWithinCwd(join(unrealCwd, 'f.txt'), unrealCwd)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ===== P3-1：唯一一份（重复实现守卫）=====

describe('P3-1 守卫：resolvePath / isWithinCwd 全仓只有这一份', () => {
  it('packages 下不再有第二处定义（再抄一份就变红）', () => {
    const repoRoot = join(import.meta.dir, '..', '..', '..')
    const dup = /^(?:export\s+)?function\s+(?:resolvePath|isWithinCwd)\s*\(/m
    const hits: string[] = []
    for (const f of collectSources(join(repoRoot, 'packages'))) {
      if (f === join(import.meta.dir, 'index.ts')) continue // 本体
      if (dup.test(readFileSync(f, 'utf8'))) hits.push(f.slice(repoRoot.length + 1))
    }
    expect(hits).toEqual([])
  })
})
