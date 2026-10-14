import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'

import {
  resolvePath,
  realpathBestEffort,
  isWithinRoot,
  isWithinCwd,
  defaultPathDialect,
  isSensitiveReadPath,
  findSensitiveReadPath,
  lookupEnvCI,
} from './index'

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
  // ⚠️ 这几条**必须显式传 `'posix'`**：`resolvePath` 的缺省方言是**当前平台**
  //（P0-6 的口径：缺省＝平台 ⇒ 既有行为逐位不变），而这里的输入/期望都是 POSIX 字面量。
  // 不传的话，Windows 上 `resolvePath('../a', '/tmp/x/y')` 会按 win32 语义给出 `D:\tmp\x\a`
  // —— 测试会红，但**产品没错**（喂给它的本来就是平台相关的输入）。这正是 CI 首跑暴露的那一类。
  it('相对路径按 cwd 解析；绝对路径原样归一', () => {
    expect(resolvePath('a.txt', '/tmp/x', 'posix')).toBe('/tmp/x/a.txt')
    expect(resolvePath('/abs/a.txt', '/tmp/x', 'posix')).toBe('/abs/a.txt')
  })

  it('折叠 `..` 与 `.`，不做 realpath', () => {
    expect(resolvePath('../a', '/tmp/x/y', 'posix')).toBe('/tmp/x/a')
    expect(resolvePath('./a', '/tmp/x', 'posix')).toBe('/tmp/x/a')
    // 不碰文件系统：这个路径根本不存在，也不会抛
    expect(resolvePath('/nope/never/here.txt', '/tmp', 'posix')).toBe('/nope/never/here.txt')
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

// ===== P0-6：路径方言（UNC / 盘符 / 大小写）=====
//
// 这一组在 macOS / Linux 上跑，却要钉住 **Windows 的判定口径** —— 靠的是
// `dialect` 参数（消费 `node:path` 的 `win32` 那一套），而不是模拟文件系统。
// 每条"方言差异"都配一条**同串在 posix 下的相反结论**：只断言 win32 侧的话，
// 一个把两边都写死的实现也能全绿。

describe('P0-6 defaultPathDialect', () => {
  it('只有 win32 平台是 win32 方言（不传 dialect 时既有行为逐位不变）', () => {
    expect(defaultPathDialect('win32')).toBe('win32')
    expect(defaultPathDialect('darwin')).toBe('posix')
    expect(defaultPathDialect('linux')).toBe('posix')
    expect(defaultPathDialect()).toBe(process.platform === 'win32' ? 'win32' : 'posix')
  })
})

describe('P0-6 resolvePath：按方言解析', () => {
  it('win32：盘符与 UNC **都是绝对路径**（原样归一）', () => {
    expect(resolvePath('C:\\work\\a.txt', 'D:\\other', 'win32')).toBe('C:\\work\\a.txt')
    expect(resolvePath('\\\\srv\\share\\x', 'C:\\work', 'win32')).toBe('\\\\srv\\share\\x')
  })

  it('win32：相对路径按 cwd 解析；`..` 折叠到盘根为止', () => {
    expect(resolvePath('a.txt', 'C:\\work', 'win32')).toBe('C:\\work\\a.txt')
    expect(resolvePath('..\\..\\x', 'C:\\work\\sub', 'win32')).toBe('C:\\x')
  })

  it('★同一串在 posix 下是**相对路径**（反斜杠只是普通字符）—— 不能"看到反斜杠就当 Windows"', () => {
    expect(resolvePath('\\\\srv\\share\\x', '/tmp/work', 'posix')).toBe('/tmp/work/\\\\srv\\share\\x')
  })
})

describe('P0-6 isWithinRoot：UNC / 盘符 / 大小写', () => {
  it('UNC：share 自身与 share 内的子路径 ⇒ true', () => {
    expect(isWithinRoot('\\\\srv\\share', '\\\\srv\\share', 'win32')).toBe(true)
    expect(isWithinRoot('\\\\srv\\share\\a\\b', '\\\\srv\\share\\a', 'win32')).toBe(true)
  })

  it('★UNC：同 server 不同 share ⇒ false（`relative` 给 `..\\..\\s2\\b`）', () => {
    expect(isWithinRoot('\\\\srv\\s2\\b', '\\\\srv\\s1\\a', 'win32')).toBe(false)
  })

  it('★UNC：不同 server ⇒ false（`relative` 直接给绝对路径，走 isAbsolute 那一支）', () => {
    expect(isWithinRoot('\\\\other\\share\\b', '\\\\srv\\s1\\a', 'win32')).toBe(false)
  })

  it('★盘符不同 ⇒ false', () => {
    expect(isWithinRoot('D:\\x', 'C:\\work', 'win32')).toBe(false)
  })

  it('★大小写不敏感（Windows 默认语义，`node:path` 的 win32 已内建折叠）', () => {
    expect(isWithinRoot('C:\\Work\\a', 'c:\\work', 'win32')).toBe(true)
    expect(isWithinRoot('C:\\work', 'C:\\WORK', 'win32')).toBe(true)
  })

  it('★同一条在 posix 下必须相反（大小写是不同目录）—— 证明方言真被用上', () => {
    expect(isWithinRoot('/Work/a', '/work', 'posix')).toBe(false)
    expect(isWithinRoot('/work/A', '/work/a', 'posix')).toBe(false)
  })

  it('`..` 只认整段：win32 下 `..foo` 同样是普通目录名', () => {
    expect(isWithinRoot('C:\\work\\..foo\\f', 'C:\\work', 'win32')).toBe(true)
    expect(isWithinRoot('C:\\work\\..\\x', 'C:\\work', 'win32')).toBe(false)
  })

  it('兄弟前缀目录仍不算在内（win32 侧同样成立）', () => {
    expect(isWithinRoot('C:\\work-other\\a', 'C:\\work', 'win32')).toBe(false)
  })
})

describe('P0-6 isWithinCwd：注入 realpath ⇒ 纯函数，不必真机 Windows', () => {
  // 模拟"真实路径"：只做大小写折叠（Windows 上 `C:\Work` 与 `c:\work` 是同一处）
  const lower = (p: string): string => p.toLowerCase()
  // 模拟 macOS 上问 `C:\...`：必然 ENOENT ⇒ 上溯到盘根后退回字符串口径
  const enoent = (): string => { throw new Error('ENOENT') }

  it('UNC：cwd 内 ⇒ true', () => {
    const cwd = '\\\\srv\\share\\proj'
    expect(isWithinCwd('\\\\srv\\share\\proj\\a.txt', cwd, { dialect: 'win32', realpath: lower })).toBe(true)
    expect(isWithinCwd(cwd, cwd, { dialect: 'win32', realpath: lower })).toBe(true)
  })

  it('★UNC：跨 share / 跨 server ⇒ false（沙箱边界不会被 UNC 绕开）', () => {
    const cwd = '\\\\srv\\share\\proj'
    expect(isWithinCwd('\\\\srv\\share2\\a.txt', cwd, { dialect: 'win32', realpath: lower })).toBe(false)
    expect(isWithinCwd('\\\\other\\share\\proj\\a.txt', cwd, { dialect: 'win32', realpath: lower })).toBe(false)
  })

  it('★大小写经 realpath 归一后仍在 cwd 内（Windows 上这确实是同一个目录）', () => {
    expect(isWithinCwd('C:\\WORK\\A.TXT', 'c:\\work', { dialect: 'win32', realpath: lower })).toBe(true)
  })

  it('盘符不同 / 兄弟前缀 ⇒ false', () => {
    expect(isWithinCwd('D:\\work\\a', 'C:\\work', { dialect: 'win32', realpath: lower })).toBe(false)
    expect(isWithinCwd('C:\\work-other\\a', 'C:\\work', { dialect: 'win32', realpath: lower })).toBe(false)
  })

  it('realpath 全失败（路径还不存在）⇒ 仍按字符串口径判对，含向上越界', () => {
    expect(isWithinCwd('C:\\work\\a\\b\\new.txt', 'C:\\work', { dialect: 'win32', realpath: enoent })).toBe(true)
    expect(isWithinCwd('C:\\other\\x', 'C:\\work', { dialect: 'win32', realpath: enoent })).toBe(false)
  })

  it('★反面钉子：posix 下反斜杠不是分隔符 ⇒ `/tmp/work/\\srv\\share\\x` 是 cwd 内的字面文件名', () => {
    // 与上面 win32 那条对照：同一个 `\\srv\share\x`，当它是**绝对 UNC** 时判界外，
    // 当它是 posix 下"名字里带反斜杠的文件"时判界内 —— 结论完全由方言决定。
    expect(isWithinCwd('/tmp/work/\\\\srv\\share\\x', '/tmp/work', { dialect: 'posix', realpath: enoent })).toBe(true)
  })

  it('★契约：两侧都必须是**绝对路径**（相对路径会被 `resolve()` 拼到 process.cwd()，不是 cwd）', () => {
    // 这是既有行为（改造前就是 `resolve(p)`），不是本次引入的；写出来是因为它容易被误用 ——
    // 工具层的调用顺序是「先 resolvePath(input, cwd)、再 isWithinCwd(abs, cwd)」。
    expect(isWithinCwd('a.txt', '/tmp/work', { dialect: 'posix', realpath: enoent })).toBe(false)
  })

  it('方言缺省＝当前平台（两侧同一方言，不会一半 win32 一半 posix）', () => {
    const d = mkTmp('fsg-dia-')
    try {
      expect(isWithinCwd(join(d, 'a.txt'), d)).toBe(isWithinCwd(join(d, 'a.txt'), d, { dialect: defaultPathDialect() }))
    } finally {
      rmSync(d, { recursive: true, force: true })
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

// ===== P0-3：读侧敏感文件策略 =====

describe('isSensitiveReadPath', () => {
  const hit = (p: string) => expect(isSensitiveReadPath(p)).toBe(true)
  const miss = (p: string) => expect(isSensitiveReadPath(p)).toBe(false)

  it('凭据文件名命中（含子目录里的同名文件）', () => {
    hit('.env')
    hit('.env.local')
    hit('.env.production.local')
    hit('apps/web/.env')
    hit('.npmrc')
    hit('id_rsa')
    hit('id_ed25519')
    hit('deploy/client.key')
    hit('certs/server.pem')
    hit('permissions.json')
    hit('.harness/permissions.json')
    hit('.harness/.config-key')
    hit('credentials.json')
  })

  it('凭据目录段命中', () => {
    hit('.ssh/config')
    hit('.ssh/id_rsa')
    hit('.aws/credentials')
    hit('.gnupg/secring.gpg')
    hit('.kube/config')
    hit('.docker/config.json')
    hit('.config/gh/hosts.yml')
    hit('home/.aws/credentials')
  })

  it('★例外优先：公钥与裸模板不算敏感（否则模型连"该配哪些键"都看不到）', () => {
    miss('.env.example')
    miss('.env.sample')
    miss('.env.template')
    miss('apps/web/.env.example')
    miss('id_rsa.pub')
    miss('id_ed25519.pub')
  })

  it('普通文件不误伤', () => {
    miss('src/index.ts')
    miss('README.md')
    miss('env.ts')          // 不是点开头的 `.env`
    miss('docs/keys.md')
    miss('key.ts')
    miss('package.json')
    miss('src/ssh/client.ts')
    miss('.')
    miss('')
  })

  it('Windows 风格反斜杠也归一', () => {
    hit('.ssh\\config')
    hit('apps\\web\\.env')
  })

  it('自定义策略整体替换内置清单', () => {
    const custom = { names: ['secret.txt'], prefixes: [], suffixes: [], dirs: [], paths: [] }
    expect(isSensitiveReadPath('secret.txt', custom)).toBe(true)
    expect(isSensitiveReadPath('.env', custom)).toBe(false)
  })

  it('findSensitiveReadPath 指出第一个命中项', () => {
    expect(findSensitiveReadPath(['a.ts', '.env', 'b.ts'])).toBe('.env')
    expect(findSensitiveReadPath(['a.ts', 'b.ts'])).toBeUndefined()
  })
})

describe('lookupEnvCI：环境键名大小写不敏感（P2-2，唯一一份口径）', () => {
  it('★注入普通对象时 `Path` 能被 `PATH` 取到（Windows 键名形态）', () => {
    expect(lookupEnvCI({ Path: 'C:\\bin' } as NodeJS.ProcessEnv, 'PATH')).toBe('C:\\bin')
    expect(lookupEnvCI({ PATH: 'C:\\bin' } as NodeJS.ProcessEnv, 'PATH')).toBe('C:\\bin')
    expect(lookupEnvCI({ 'cOmSpEc': 'cmd.exe' } as NodeJS.ProcessEnv, 'ComSpec')).toBe('cmd.exe')
  })

  it('空值不挡路：空的 `PATH` 与有效的 `Path` 并存时取有效的那个（Windows 实录）', () => {
    expect(lookupEnvCI({ PATH: '', Path: 'C:\\real' } as NodeJS.ProcessEnv, 'PATH')).toBe('C:\\real')
  })

  it('都不命中 ⇒ 返回原键的值（undefined），不猜', () => {
    expect(lookupEnvCI({ SHELL: '/bin/zsh' } as NodeJS.ProcessEnv, 'PATH')).toBeUndefined()
  })
})
