/**
 * @harness/subagent - worktree 工具模块测试
 *
 * 用临时 git 仓库（git init + 初始提交）验证：
 * - gitTopLevel / isGitRepo 真/假
 * - createWorktree 幂等 + .git 元数据 + listWorktrees 可见
 * - getWorktreeDiff 有改动/无改动
 * - removeWorktree 目录消失且幂等
 * - ensureWorktreeIgnored 幂等
 * - runGit 失败归一化为 GitCommandError
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  runGit,
  gitTopLevel,
  isGitRepo,
  worktreeDirFor,
  ensureWorktreeIgnored,
  createWorktree,
  getWorktreeDiff,
  removeWorktree,
  listWorktrees,
  canonicalGitPath,
  isUnderDir,
  GitCommandError,
} from './worktree'

let repo: string
let worktree: string

/** 初始化临时 git 仓库，并产生一个基线提交 */
async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'wt-test-'))
  await runGit(dir, ['init', '-q'])
  await runGit(dir, ['config', 'user.email', 'test@example.com'])
  await runGit(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'readme.md'), '# repo\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'base'])
  // git 输出的是真实路径（macOS /tmp→/private/tmp 会 //var 规范化），统一用 realpath 对齐。
  // ⚠️ 还要再套一层 **产品同一个** `canonicalGitPath`：Windows 上 realpathSync 不展开 8.3 短名
  // （`RUNNER~1`），而 git 给的是长名（`runneradmin`）+ **正斜杠** —— 期望值必须与 gitTopLevel
  // 的返回值走同一套口径，否则右边永远对不上。POSIX 上这层基本是恒等（只做绝对化）。
  return canonicalGitPath(realpathSync(dir))
}

beforeAll(async () => {
  repo = await initRepo()
  worktree = await createWorktree({ base: repo, token: 's_abc123' })
})

afterAll(() => {
  // 清理 git 元数据，避免注册表残留指向已删除目录
  try { rmSync(worktree, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(repo, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('gitTopLevel / isGitRepo', () => {
  it('git 仓库返回仓库根', async () => {
    expect(await gitTopLevel(repo)).toBe(repo)
  })
  it('子目录也能定位到仓库根', async () => {
    mkdirSync(join(repo, 'src'), { recursive: true })
    expect(await gitTopLevel(join(repo, 'src'))).toBe(repo)
  })
  it('非 git 目录返回 null', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'wt-plain-'))
    expect(await gitTopLevel(plain)).toBeNull()
  })
  it('isGitRepo 便捷判断', async () => {
    expect(await isGitRepo(repo)).toBe(true)
    const plain = mkdtempSync(join(tmpdir(), 'wt-plain2-'))
    expect(await isGitRepo(plain)).toBe(false)
  })
})

describe('worktreeDirFor', () => {
  it('按约定拼路径并清洗 token', () => {
    expect(worktreeDirFor(repo, 's_abc-1.2')).toBe(join(repo, '.harness', 'worktrees', 's_abc-1.2'))
    expect(worktreeDirFor(repo, '../evil')).toBe(join(repo, '.harness', 'worktrees', '.._evil'))
  })
})

describe('createWorktree', () => {
  it('创建独立目录，含可用的 .git 元数据', () => {
    expect(existsSync(worktree)).toBe(true)
    expect(existsSync(join(worktree, 'readme.md'))).toBe(true)
  })
  it('幂等：重复创建复用同一目录', async () => {
    const again = await createWorktree({ base: repo, token: 's_abc123' })
    expect(again).toBe(worktree)
  })
  it('建目录时同时落好忽略规则（否则 worktree 会被 git add -A 误收）', async () => {
    const fresh = await initRepo()
    await createWorktree({ base: fresh, token: 's_ignore_me' })
    const ignoreFile = join(fresh, '.harness', '.gitignore')
    expect(existsSync(ignoreFile)).toBe(true)
    expect(readFileSync(ignoreFile, 'utf-8')).toContain('worktrees/')
    // 忽略规则生效：显式展开 untracked 也看不到 worktree 目录
    const status = await runGit(fresh, ['status', '--short', '--untracked-files=all'])
    expect(status.stdout.split('\n').some((l) => l.includes('.harness/worktrees'))).toBe(false)
    rmSync(fresh, { recursive: true, force: true })
  })
  it('listWorktrees 能看到创建的 worktree（含主工作区）', async () => {
    const all = await listWorktrees(repo)
    const paths = all.map((w) => w.path)
    expect(paths).toContain(repo)
    expect(paths).toContain(worktree)
    const wt = all.find((w) => w.path === worktree)
    expect(wt?.head).toBeTruthy()
  })
})

describe('getWorktreeDiff', () => {
  it('有改动时返回摘要 + patch，无改动时 hasChanges=false', async () => {
    // 初始无改动
    const clean = await getWorktreeDiff({ base: repo, dir: worktree })
    expect(clean.hasChanges).toBe(false)

    // 在 worktree 内改跟踪文件
    writeFileSync(join(worktree, 'readme.md'), '# repo\n# added\n')
    const dirty = await getWorktreeDiff({ base: repo, dir: worktree })
    expect(dirty.hasChanges).toBe(true)
    expect(dirty.summary).toContain('readme.md')
    expect(dirty.summary).toContain('1 file changed')
    // diff 行含 + 新增
    const lines = dirty.patch.split('\n')
    expect(lines.some((l) => l.startsWith('+') && l.includes('added'))).toBe(true)
  })
})

describe('ensureWorktreeIgnored', () => {
  it('幂等写入 .harness/.gitignore 含 worktrees/', () => {
    ensureWorktreeIgnored(repo)
    const p = join(repo, '.harness', '.gitignore')
    expect(existsSync(p)).toBe(true)
    const c1 = readFileSync(p, 'utf-8')
    expect(c1).toContain('worktrees/')
    // 幂等：再次调用不重复
    ensureWorktreeIgnored(repo)
    const c2 = readFileSync(p, 'utf-8')
    expect(c1).toBe(c2)
    expect(c2.split('worktrees/').length - 1).toBe(1)
  })
})

describe('removeWorktree', () => {
  it('移除后目录消失且幂等', async () => {
    const temp = await createWorktree({ base: repo, token: 's_remove_me' })
    expect(existsSync(temp)).toBe(true)
    await removeWorktree({ base: repo, dir: temp })
    expect(existsSync(temp)).toBe(false)
    // 二次移除不抛错
    await removeWorktree({ base: repo, dir: temp })
  })
})

describe('runGit', () => {
  it('失败归一化为 GitCommandError', async () => {
    await expect(runGit(repo, ['status', '--bogus-flag-does-not-exist']))
      .rejects.toBeInstanceOf(GitCommandError)
  })
})
describe('isUnderDir：worktree 归属判定（跨平台，不能靠字符串前缀）', () => {
  const base = join('/tmp', 'wt-base')

  it('★ 不能用 `join(base,…) + "/"` 做前缀：win32 上 join 产出 `\\` 而后拼的是 `/`，永远不命中', () => {
    // 旧实现形态复现：前缀尾部是 `/`，candidate 的分隔符是 `\\`（win32 join 产物）
    // ⇒ startsWith 恒 false ⇒ 续接从不复用 worktree。isUnderDir 用 relative 判定，不受分隔符影响。
    const candidate = `${base}${sep}harness-wt`
    expect(isUnderDir(base, candidate)).toBe(true)
  })

  it('界内（含相等）⇒ true；界外 ⇒ false', () => {
    expect(isUnderDir(base, base)).toBe(true)
    expect(isUnderDir(base, join(base, 's_1'))).toBe(true)
    expect(isUnderDir(base, join(base, 's_1', 'x.md'))).toBe(true)
    expect(isUnderDir(base, join(base, '..', 'elsewhere'))).toBe(false)
    expect(isUnderDir(base, '/totally/other')).toBe(false)
  })

  it('★ `..` 开头的**合法文件名**不算越界（整段为 `..` 才算）', () => {
    expect(isUnderDir(base, join(base, '..hidden'))).toBe(true)
    expect(isUnderDir(base, join(base, '..foo', 'bar.md'))).toBe(true)
  })

  it('candidate 缺省/空串 ⇒ false（不误判成界内）', () => {
    expect(isUnderDir(base, undefined)).toBe(false)
    expect(isUnderDir(base, '')).toBe(false)
  })
})
