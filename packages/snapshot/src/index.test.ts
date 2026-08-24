/**
 * @harness/snapshot 单测
 *
 * 覆盖：capture（hash 稳定性 / 变更后新 hash）、files、diff、restore（选择性 /
 * 删除不存在文件 / 越界防护）、checkout 整仓恢复、preview 零副作用、大文件跳过、
 * disabled 语义。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSnapshotService, SnapshotError } from './index'

const tempDirs: string[] = []

/** 构造 worktree + 独立快照仓库目录（避免写入默认的 ~/.harness/snapshots） */
async function makeEnv(): Promise<{ worktree: string; gitDir: string }> {
  const worktree = await mkdtemp(path.join(tmpdir(), 'harness-snapshot-wt-'))
  const gitDir = await mkdtemp(path.join(tmpdir(), 'harness-snapshot-git-'))
  tempDirs.push(worktree, gitDir)
  return { worktree, gitDir }
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
