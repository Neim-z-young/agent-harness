/**
 * @harness/snapshot 单测
 *
 * 覆盖：capture（hash 稳定性 / 变更后新 hash）、files、diff、restore（选择性 /
 * 删除不存在文件 / 越界防护）、checkout 整仓恢复、preview 零副作用、大文件跳过、
 * disabled 语义。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createSnapshotService,
  FileSnapshotService,
  GitSnapshotService,
  SnapshotError,
  type SnapshotService,
} from './index'

const tempDirs: string[] = []

/** 构造 worktree + 独立快照仓库/文件存储目录（避免写入默认的 ~/.harness/...） */
async function makeEnv(): Promise<{ worktree: string; gitDir: string; dataDir: string }> {
  const worktree = await mkdtemp(path.join(tmpdir(), 'harness-snapshot-wt-'))
  const gitDir = await mkdtemp(path.join(tmpdir(), 'harness-snapshot-git-'))
  const dataDir = await mkdtemp(path.join(tmpdir(), 'harness-snapshot-data-'))
  tempDirs.push(worktree, gitDir, dataDir)
  return { worktree, gitDir, dataDir }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SnapshotService', () => {
  test('capture 返回 tree hash，内容不变时 hash 稳定', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir })

    await writeFile(path.join(worktree, 'a.txt'), 'hello\n')
    const first = await svc.capture()
    const second = await svc.capture()

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).toMatch(/^[0-9a-f]{40}$/)
    expect(first).toBe(second)
  })

  test('文件修改后再次 capture 返回新 hash', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir })

    await writeFile(path.join(worktree, 'a.txt'), 'hello\n')
    const from = await svc.capture()
    await writeFile(path.join(worktree, 'a.txt'), 'hello world\n')
    const to = await svc.capture()

    expect(from).toBeDefined()
    expect(to).toBeDefined()
    expect(to).not.toBe(from)
  })

  test('files 列出两个快照间的变更文件', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir })

    await writeFile(path.join(worktree, 'a.txt'), 'hello\n')
    await writeFile(path.join(worktree, 'stable.txt'), 'stable\n')
    const from = await svc.capture()
    await writeFile(path.join(worktree, 'a.txt'), 'hello world\n')
    await writeFile(path.join(worktree, 'b.txt'), 'new\n')
    const to = await svc.capture()

    const changed = await svc.files(from!, to!)
    expect(changed).toContain('a.txt')
    expect(changed).toContain('b.txt')
    expect(changed).not.toContain('stable.txt')
  })

  test('diff 返回结构化 FileDiff（added/modified 的 status、统计与 patch）', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir })

    await writeFile(path.join(worktree, 'a.txt'), 'one\ntwo\nthree\n')
    const from = await svc.capture()
    await writeFile(path.join(worktree, 'a.txt'), 'one\ntwo changed\nthree\nfour\n')
    await writeFile(path.join(worktree, 'b.txt'), 'brand new\n')
    const to = await svc.capture()

    const diffs = await svc.diff(from!, to!)

    const a = diffs.find((d) => d.path === 'a.txt')
    expect(a).toBeDefined()
    expect(a!.status).toBe('modified')
    expect(a!.additions).toBe(2) // "+two changed" + "+four"
    expect(a!.deletions).toBe(1) // "-two"
    expect(a!.patch).toContain('@@')
    expect(a!.patch).toContain('two changed')

    const b = diffs.find((d) => d.path === 'b.txt')
    expect(b).toBeDefined()
    expect(b!.status).toBe('added')
    expect(b!.additions).toBe(1)
    expect(b!.patch).toContain('brand new')
  })

  test('restore 选择性恢复：改回旧版本、找回被删文件、不动其它文件', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir })

    await writeFile(path.join(worktree, 'a.txt'), 'original a\n')
    await writeFile(path.join(worktree, 'gone.txt'), 'will be deleted\n')
    const from = await svc.capture()

    await writeFile(path.join(worktree, 'a.txt'), 'changed a\n')
    await rm(path.join(worktree, 'gone.txt'))
    await writeFile(path.join(worktree, 'untouched.txt'), 'keep me\n')

    await svc.restore(new Map([
      ['a.txt', from!],
      ['gone.txt', from!],
    ]))

    expect(await readFile(path.join(worktree, 'a.txt'), 'utf-8')).toBe('original a\n')
    expect(await readFile(path.join(worktree, 'gone.txt'), 'utf-8')).toBe('will be deleted\n')
    expect(await readFile(path.join(worktree, 'untouched.txt'), 'utf-8')).toBe('keep me\n')
  })

  test('restore 删除目标树中不存在的文件', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir })

    await writeFile(path.join(worktree, 'a.txt'), 'hello\n')
    const from = await svc.capture()
    await writeFile(path.join(worktree, 'temp.txt'), 'transient\n')

    await svc.restore(new Map([['temp.txt', from!]]))

    // temp.txt 不在 from 树中 → 被删除；a.txt 不受影响
    expect(readFile(path.join(worktree, 'temp.txt'), 'utf-8')).rejects.toThrow()
    expect(await readFile(path.join(worktree, 'a.txt'), 'utf-8')).toBe('hello\n')
  })

  test('restore 拒绝越界路径', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir })

    await writeFile(path.join(worktree, 'a.txt'), 'hello\n')
    const from = await svc.capture()

    await expect(
      svc.restore(new Map([['../escape.txt', from!]])),
    ).rejects.toBeInstanceOf(SnapshotError)
  })

  test('checkout 整仓恢复（快照外的新文件保留）', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir })

    await writeFile(path.join(worktree, 'a.txt'), 'v1\n')
    const from = await svc.capture()

    await writeFile(path.join(worktree, 'a.txt'), 'v2 changed\n')
    await writeFile(path.join(worktree, 'new.txt'), 'new file\n')

    await svc.checkout(from!)

    expect(await readFile(path.join(worktree, 'a.txt'), 'utf-8')).toBe('v1\n')
    // checkout 语义：只恢复快照内文件，快照外的文件保留（对齐 OpenCode）
    expect(await readFile(path.join(worktree, 'new.txt'), 'utf-8')).toBe('new file\n')
  })

  test('preview 零副作用：不修改工作目录，返回回滚 diff', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir })

    await writeFile(path.join(worktree, 'a.txt'), 'v1 content\n')
    const from = await svc.capture()

    await writeFile(path.join(worktree, 'a.txt'), 'v2 content\n')
    await writeFile(path.join(worktree, 'b.txt'), 'new\n')

    const diffs = await svc.preview(new Map([['a.txt', from!]]))

    // 工作目录未被修改
    expect(await readFile(path.join(worktree, 'a.txt'), 'utf-8')).toBe('v2 content\n')
    expect(await readFile(path.join(worktree, 'b.txt'), 'utf-8')).toBe('new\n')
    // preview 产出的 diff 描述"回滚 a.txt 到 from"的变化
    const a = diffs.find((d) => d.path === 'a.txt')
    expect(a).toBeDefined()
    expect(a!.patch).toContain('v1 content')
  })

  test('超过 maximumUntrackedFileBytes 的未跟踪文件被跳过快照', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({
      worktree,
      gitDirectory: gitDir,
      maximumUntrackedFileBytes: 8,
    })

    await writeFile(path.join(worktree, 'a.txt'), 'hello\n')
    const from = await svc.capture()
    await writeFile(path.join(worktree, 'big.bin'), 'x'.repeat(1024))
    await writeFile(path.join(worktree, 'small.txt'), 'tiny\n')
    const to = await svc.capture()

    const changed = await svc.files(from!, to!)
    expect(changed).toContain('small.txt')
    expect(changed).not.toContain('big.bin')
  })

  test('enabled=false 时 capture 返回 undefined，restore 抛错', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir, enabled: false })

    await writeFile(path.join(worktree, 'a.txt'), 'hello\n')
    expect(await svc.capture()).toBeUndefined()
    await expect(svc.restore(new Map())).rejects.toBeInstanceOf(SnapshotError)
  })
})

describe('§10.4 GitSnapshotService 增强（gc + 上限淘汰）', () => {
  test('list 返回快照历史（最新在前，含 ts）；旧版字符串注册表自动迁移', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir })
    await writeFile(path.join(worktree, 'a.txt'), 'v1\n')
    const id1 = (await svc.capture())!
    await writeFile(path.join(worktree, 'a.txt'), 'v2\n')
    const id2 = (await svc.capture())!

    const list = await svc.list()
    expect(list.map((s) => s.id)).toEqual([id2, id1]) // 最新在前
    expect(list[0]!.timestamp).toBeTypeOf('number')

    // 兼容旧格式：把注册表改回纯字符串数组，list 不抛错且给出 unknown 时间
    const idsPath = path.join(gitDir, 'snapshot-ids.json')
    await writeFile(idsPath, JSON.stringify([id2, id1]), 'utf-8')
    const migrated = await svc.list()
    expect(migrated.map((s) => s.id)).toEqual([id1, id2])
    expect(migrated[0]!.timestamp).toBeUndefined()
  })

  test('maxSnapshots 淘汰注册表最旧快照 ID', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir, maxSnapshots: 2 })

    for (let i = 0; i < 4; i++) {
      await writeFile(path.join(worktree, 'a.txt'), `v${i}\n`)
      expect(await svc.capture()).toBeDefined()
    }
    const ids = JSON.parse(await readFile(path.join(gitDir, 'snapshot-ids.json'), 'utf-8')) as string[]
    expect(ids.length).toBeLessThanOrEqual(2)
  })

  test('gcEvery=1 时自动 git gc 不破坏 capture（无嵌套锁死锁）', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir, gcEvery: 1 })

    await writeFile(path.join(worktree, 'a.txt'), 'v1\n')
    const s1 = await svc.capture()
    const s2 = await svc.capture()
    expect(s1).toBeDefined()
    expect(s2).toBeDefined()
    expect(await svc.files(s1!, s2!)).toEqual([])
  })

  test('git gc 公共方法可直接调用且不抛错', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir })

    await writeFile(path.join(worktree, 'a.txt'), 'v1\n')
    await svc.capture()
    await expect(svc.gc?.()).resolves.toBeUndefined()
  })
})

describe('FileSnapshotService（§10.4 非 git fallback）', () => {
  test('list 返回快照链（最新在前，含 ts）', async () => {
    const { worktree, dataDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, dataDir, backend: 'file' })
    await writeFile(path.join(worktree, 'a.txt'), 'v1\n')
    const id1 = (await svc.capture())!
    await writeFile(path.join(worktree, 'a.txt'), 'v2\n')
    const id2 = (await svc.capture())!

    const list = await svc.list()
    expect(list.map((s) => s.id)).toEqual([id2, id1]) // 最新在前
    expect(list[0]!.timestamp).toBeTypeOf('number')
  })

  test('capture/files/diff/restore 全流程', async () => {
    const { worktree, dataDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, dataDir, backend: 'file' })

    await writeFile(path.join(worktree, 'a.txt'), 'one\ntwo\nthree\n')
    const from = await svc.capture()
    expect(from).toMatch(/^fs-\d+$/)

    await writeFile(path.join(worktree, 'a.txt'), 'one\ntwo changed\nthree\nfour\n')
    await writeFile(path.join(worktree, 'b.txt'), 'brand new\n')
    const to = await svc.capture()
    expect(to).not.toBe(from)

    const changed = await svc.files(from!, to!)
    expect(changed).toContain('a.txt')
    expect(changed).toContain('b.txt')

    const diffs = await svc.diff(from!, to!)
    const a = diffs.find((d) => d.path === 'a.txt')
    expect(a).toBeDefined()
    expect(a!.status).toBe('modified')
    expect(a!.additions).toBe(2)
    expect(a!.deletions).toBe(1)
    expect(a!.patch).toContain('@@')
    expect(a!.patch).toContain('two changed')
    const b = diffs.find((d) => d.path === 'b.txt')
    expect(b!.status).toBe('added')
    expect(b!.additions).toBe(1)

    // restore：改回旧版本
    await svc.restore(new Map([['a.txt', from!]]))
    expect(await readFile(path.join(worktree, 'a.txt'), 'utf-8')).toBe('one\ntwo\nthree\n')
  })

  test('restore 删除目标快照中不存在的文件 + 越界防护', async () => {
    const { worktree, dataDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, dataDir, backend: 'file' })

    await writeFile(path.join(worktree, 'a.txt'), 'hello\n')
    const from = await svc.capture()
    await writeFile(path.join(worktree, 'temp.txt'), 'transient\n')

    await svc.restore(new Map([['temp.txt', from!]]))
    expect(readFile(path.join(worktree, 'temp.txt'), 'utf-8')).rejects.toThrow()
    expect(await readFile(path.join(worktree, 'a.txt'), 'utf-8')).toBe('hello\n')

    await expect(
      svc.restore(new Map([['../escape.txt', from!]])),
    ).rejects.toBeInstanceOf(SnapshotError)
  })

  test('preview 零副作用 + checkout 整仓恢复', async () => {
    const { worktree, dataDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, dataDir, backend: 'file' })

    await writeFile(path.join(worktree, 'a.txt'), 'v1 content\n')
    const from = await svc.capture()

    await writeFile(path.join(worktree, 'a.txt'), 'v2 content\n')
    await writeFile(path.join(worktree, 'b.txt'), 'new\n')

    // preview：不修改工作目录，diff 描述回滚到 from 的变化
    const diffs = await svc.preview(new Map([['a.txt', from!]]))
    expect(await readFile(path.join(worktree, 'a.txt'), 'utf-8')).toBe('v2 content\n')
    expect(await readFile(path.join(worktree, 'b.txt'), 'utf-8')).toBe('new\n')
    const a = diffs.find((d) => d.path === 'a.txt')
    expect(a).toBeDefined()
    expect(a!.patch).toContain('v1 content')

    // checkout：整仓恢复（快照外的新文件保留）
    await svc.checkout(from!)
    expect(await readFile(path.join(worktree, 'a.txt'), 'utf-8')).toBe('v1 content\n')
    expect(await readFile(path.join(worktree, 'b.txt'), 'utf-8')).toBe('new\n')
  })

  test('未变化的文件复用上一备份（增量快照）', async () => {
    const { worktree, dataDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, dataDir, backend: 'file' })

    await writeFile(path.join(worktree, 'a.txt'), 'hello\n')
    await writeFile(path.join(worktree, 'stable.txt'), 'stable\n')
    const s1 = await svc.capture()
    const s2 = await svc.capture()

    // 内容无变化 → 两快照间无变更文件（增量快照复用备份，不产生新备份 I/O）
    expect(s2).not.toBe(s1)
    expect(await svc.files(s1!, s2!)).toEqual([])
    await writeFile(path.join(worktree, 'a.txt'), 'hello world\n')
    const s3 = await svc.capture()
    expect(await svc.files(s1!, s3!)).toContain('a.txt')
    expect(await svc.files(s1!, s3!)).not.toContain('stable.txt')
  })

  test('超出 maxSnapshots 淘汰最旧快照（最旧快照不可再引用）', async () => {
    const { worktree, dataDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, dataDir, backend: 'file', maxSnapshots: 2 })

    await writeFile(path.join(worktree, 'a.txt'), 'v1\n')
    const s1 = await svc.capture()
    await writeFile(path.join(worktree, 'a.txt'), 'v2\n')
    const s2 = await svc.capture()
    await writeFile(path.join(worktree, 'a.txt'), 'v3\n')
    const s3 = await svc.capture()

    // s1 已被淘汰 → files 引用抛错；s2/s3 仍可用
    await expect(svc.files(s1!, s3!)).rejects.toThrow(/not found/)
    expect(await svc.files(s2!, s3!)).toContain('a.txt')
  })

  test('gc 清理无引用备份（仅被淘汰快照引用的备份被删除）', async () => {
    const { worktree, dataDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, dataDir, backend: 'file', maxSnapshots: 2 })

    await writeFile(path.join(worktree, 'a.txt'), 'v1\n')
    const s1 = await svc.capture()
    await writeFile(path.join(worktree, 'a.txt'), 'v2\n')
    const s2 = await svc.capture()
    await writeFile(path.join(worktree, 'a.txt'), 'v3\n')
    const s3 = await svc.capture()
    expect(s1).toBeDefined()
    expect(s2).toBeDefined()
    expect(s3).toBeDefined()

    await svc.gc?.()

    // s2/s3 仍可用（其备份未被误删）
    expect(await svc.files(s2!, s3!)).toContain('a.txt')
  })

  test('.gitignore 语义过滤快照范围（check-ignore 简化）', async () => {
    const { worktree, dataDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, dataDir, backend: 'file' })

    await writeFile(path.join(worktree, '.gitignore'), 'dist/\n*.log\n')
    await mkdir(path.join(worktree, 'dist'), { recursive: true })
    await writeFile(path.join(worktree, 'dist/bundle.js'), 'bundled\n')
    await writeFile(path.join(worktree, 'debug.log'), 'log\n')
    await writeFile(path.join(worktree, 'src.ts'), 'code\n')

    const s1 = await svc.capture()
    await writeFile(path.join(worktree, 'src.ts'), 'code v2\n')
    const s2 = await svc.capture()

    const changed = await svc.files(s1!, s2!)
    expect(changed).toContain('src.ts')
    expect(changed).not.toContain('dist/bundle.js')
    expect(changed).not.toContain('debug.log')
  })

  test('enabled=false 语义与 git 后端一致', async () => {
    const { worktree, dataDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, dataDir, backend: 'file', enabled: false })

    await writeFile(path.join(worktree, 'a.txt'), 'hello\n')
    expect(await svc.capture()).toBeUndefined()
    await expect(svc.restore(new Map())).rejects.toBeInstanceOf(SnapshotError)
  })
})

describe('createSnapshotService 工厂（§10.4 auto 探测）', () => {
  test('backend=git 显式选择返回 GitSnapshotService', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, gitDirectory: gitDir, backend: 'git' })
    expect(svc).toBeInstanceOf(GitSnapshotService)
  })

  test('backend=file 显式选择返回 FileSnapshotService', async () => {
    const { worktree, dataDir } = await makeEnv()
    const svc = createSnapshotService({ worktree, dataDir, backend: 'file' })
    expect(svc).toBeInstanceOf(FileSnapshotService)
  })

  test('backend=auto 返回实现了 SnapshotService 接口的服务', async () => {
    const { worktree, gitDir } = await makeEnv()
    const svc: SnapshotService = createSnapshotService({ worktree, gitDirectory: gitDir })

    await writeFile(path.join(worktree, 'a.txt'), 'hello\n')
    const id = await svc.capture()
    expect(id).toBeDefined()
    expect(await svc.files(id!, id!)).toEqual([])
  })
})
