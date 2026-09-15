import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveWorkspace } from './index'
import { LAST_SESSION_FILE, SessionPointerStore } from './storage'

// 「哪个工作目录恢复哪条会话」由指针文件的**位置**决定：文件在 <cwd>/.harness/ 里，
// 所以不同目录各自一份，不依赖对 cwd 字符串做比对（符号链接 / 相对路径都影响不到）。

describe('项目级「上次会话」指针', () => {
  let dir: string
  let store: SessionPointerStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-pointer-'))
    store = new SessionPointerStore(resolveWorkspace({ cwd: dir, dataDir: join(dir, 'data') }))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('写在当前工作目录下：<cwd>/.harness/last-session.json', async () => {
    expect(store.path()).toBe(join(dir, '.harness', LAST_SESSION_FILE))
    await store.write('s_abc')
    expect(existsSync(join(dir, '.harness', LAST_SESSION_FILE))).toBe(true)
    // 不能落在 dataDir 里 —— 那是全局共享的，等于又回到「靠字符串比对猜该恢复哪条」
    expect(existsSync(join(dir, 'data', LAST_SESSION_FILE))).toBe(false)
  })

  it('写入后可读回，savedAt 只是给人看的', async () => {
    await store.write('s_abc')
    const got = await store.read()
    expect(got?.sessionId).toBe('s_abc')
    expect(typeof got?.savedAt).toBe('number')
  })

  it('缺失 / 坏文件 / 空 id 一律按「没有记录」返回 undefined（调用方退回兜底）', async () => {
    expect(await store.read()).toBeUndefined()
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(store.path(), '{ not json')
    expect(await store.read()).toBeUndefined()
    writeFileSync(store.path(), JSON.stringify({ sessionId: '   ' }))
    expect(await store.read()).toBeUndefined()
    writeFileSync(store.path(), JSON.stringify({}))
    expect(await store.read()).toBeUndefined()
  })

  it('id 两端空格被去掉；空 id 不写文件', async () => {
    await store.write('  s_x  ')
    expect((await store.read())?.sessionId).toBe('s_x')
    const before = readFileSync(store.path(), 'utf-8')
    await store.write('   ')
    expect(readFileSync(store.path(), 'utf-8')).toBe(before)
  })

  it('写指针时顺手把文件加进 <cwd>/.harness/.gitignore，且不覆盖已有条目', async () => {
    const ignore = join(dir, '.harness', '.gitignore')
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(ignore, 'worktrees/\n')
    await store.write('s_abc')
    expect(readFileSync(ignore, 'utf-8')).toBe(`worktrees/\n${LAST_SESSION_FILE}\n`)
    // 重复写不叠加
    await store.write('s_def')
    expect(readFileSync(ignore, 'utf-8')).toBe(`worktrees/\n${LAST_SESSION_FILE}\n`)
  })

  it('clear 删除指针且幂等', async () => {
    await store.write('s_abc')
    await store.clear()
    expect(existsSync(store.path())).toBe(false)
    await store.clear()
    expect(existsSync(store.path())).toBe(false)
  })

  it('不同工作目录各自一份指针，互不覆盖', async () => {
    const other = join(dir, 'other')
    mkdirSync(other, { recursive: true })
    const otherStore = new SessionPointerStore(resolveWorkspace({ cwd: other, dataDir: join(dir, 'data') }))
    await store.write('s_a')
    await otherStore.write('s_b')
    expect((await store.read())?.sessionId).toBe('s_a')
    expect((await otherStore.read())?.sessionId).toBe('s_b')
  })
})
