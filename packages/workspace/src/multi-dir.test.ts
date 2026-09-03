import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MultiDirLoader, normalizeDirs, dirsFromPair } from './multi-dir'

function makeTree(prefix: string): { user: string; project: string } {
  const base = mkdtempSync(join(tmpdir(), `harness-mddir-${prefix}-`))
  const user = join(base, 'user')
  const project = join(base, 'project')
  mkdirSync(join(user, 'plugins'), { recursive: true })
  mkdirSync(join(project, 'plugins'), { recursive: true })
  // user 有三个文件，project 有同名覆盖 + 一个独有
  writeFileSync(join(user, 'plugins', 'a-plugin.ts'), 'export const a = 1')
  writeFileSync(join(user, 'plugins', 'shared.ts'), '// user shared')
  writeFileSync(join(user, 'plugins', 'only-user.ts'), '// user only')
  writeFileSync(join(project, 'plugins', 'shared.ts'), '// project shared')
  writeFileSync(join(project, 'plugins', 'only-project.ts'), '// project only')
  return { user: join(user, 'plugins'), project: join(project, 'plugins') }
}
const cleanup = (dirs: { user: string; project: string }) => rmSync(join(dirs.user, '..'), { recursive: true, force: true })

describe('normalizeDirs / dirsFromPair', () => {
  it('字符串按缺省 source=user 归一', () => {
    expect(normalizeDirs(['/a', { dir: '/b', source: 'project' }])).toEqual([
      { dir: '/a', source: 'user' },
      { dir: '/b', source: 'project' },
    ])
  })
  it('自定义缺省 source', () => {
    expect(normalizeDirs(['/a'], 'project')).toEqual([{ dir: '/a', source: 'project' }])
  })
  it('dirsFromPair 映射为 user→project 两级', () => {
    expect(dirsFromPair(['/u/plugins', '/p/plugins'])).toEqual([
      { dir: '/u/plugins', source: 'user' },
      { dir: '/p/plugins', source: 'project' },
    ])
  })
})

describe('MultiDirLoader.scan 枚举 + 来源标注 + 覆盖顺序', () => {
  it('按 dirs 顺序展平全部项，标注来源与原绝对路径', () => {
    const t = makeTree('scan')
    try {
      const items = new MultiDirLoader(dirsFromPair([t.user, t.project])).scan()
      const byP = Object.fromEntries(items.map((it) => [it.name, it]))
      expect(byP['a-plugin.ts'].source).toBe('user')
      expect(byP['a-plugin.ts'].full).toBe(join(t.user, 'a-plugin.ts'))
      expect(byP['shared.ts'].source).toBe('project') // 同名后覆盖先（project 覆盖 user）
      expect(byP['only-user.ts'].source).toBe('user')
      expect(byP['only-project.ts'].source).toBe('project')
      expect(items.length).toBe(5)
    } finally { cleanup(t) }
  })

  it('filter.name 只枚举满足谓词的项（如插件扩展名）', () => {
    const t = makeTree('filter')
    try {
      writeFileSync(join(t.user, 'note.txt'), 'skip me')
      const items = new MultiDirLoader(dirsFromPair([t.user, t.project]))
        .scan({ name: (n) => /\.(ts|js|mjs)$/.test(n) })
      expect(items.every((it) => it.name.endsWith('.ts'))).toBe(true)
      expect(items.some((it) => it.name === 'note.txt')).toBe(false)
    } finally { cleanup(t) }
  })

  it('目录缺失 → 跳过不抛错（空目录行为）', () => {
    const t = makeTree('missing')
    try {
      const items = new MultiDirLoader([
        { dir: join(t.user, 'not-exist'), source: 'user' },
        { dir: t.project, source: 'project' },
      ]).scan()
      expect(items.every((it) => it.source === 'project')).toBe(true)
    } finally { cleanup(t) }
  })

  it('kind 标注 + kind 过滤（仅文件 / 仅目录）', () => {
    const t = makeTree('kind')
    try {
      mkdirSync(join(t.user, 'nested'), { recursive: true })
      const all = new MultiDirLoader(dirsFromPair([t.user, t.project])).scan()
      expect(all.find((it) => it.name === 'nested')?.kind).toBe('dir')
      expect(all.find((it) => it.name === 'a-plugin.ts')?.kind).toBe('file')
      // 仅文件
      const files = new MultiDirLoader(dirsFromPair([t.user, t.project])).scan({ kind: 'file' })
      expect(files.some((it) => it.name === 'nested')).toBe(false)
      // 仅目录
      const dirs = new MultiDirLoader(dirsFromPair([t.user, t.project])).scan({ kind: 'dir' })
      expect(dirs.every((it) => it.kind === 'dir')).toBe(true)
      expect(dirs.some((it) => it.name === 'nested')).toBe(true)
    } finally { cleanup(t) }
  })
})

describe('MultiDirLoader.collect 后覆盖先去重', () => {
  it('同名（key 相同）时 project 覆盖 user；返回顺序为覆盖后集合', async () => {
    const t = makeTree('collect')
    try {
      const list = await new MultiDirLoader(dirsFromPair([t.user, t.project])).collect(
        (item) => Promise.resolve({ key: item.name, source: item.source } as { key: string; source: string }),
        (v) => v.key,
        { name: (n) => n.endsWith('.ts') },
      )
      const byK = Object.fromEntries(list.map((v) => [v.key, v]))
      // shared 被 project 覆盖
      expect(byK['shared.ts'].source).toBe('project')
      expect(byK['only-user.ts'].source).toBe('user')
      expect(byK['only-project.ts'].source).toBe('project')
      expect(byK['a-plugin.ts'].source).toBe('user')
      expect(list.length).toBe(4) // shared 去重后只剩一份
    } finally { cleanup(t) }
  })

  it('parse 返回 undefined 的项被忽略（容错）', async () => {
    const t = makeTree('collect-skip')
    try {
      const list = await new MultiDirLoader([{ dir: t.user, source: 'user' }]).collect(
        (item) => Promise.resolve(item.name === 'shared.ts' ? undefined : { key: item.name, ok: true } as any),
        (v) => v.key,
      )
      expect(list.some((v) => v.key === 'shared.ts')).toBe(false)
      expect(list.some((v) => v.key === 'a-plugin.ts')).toBe(true)
    } finally { cleanup(t) }
  })
})