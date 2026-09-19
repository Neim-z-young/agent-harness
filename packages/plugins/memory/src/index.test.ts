import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliCommandInput, Hooks, PluginContext, PluginWorkspaceView } from '@harness/plugin'
import {
  MEMORY_INDEX_MAX_LINES,
  MemoryReader,
  createMemoryPlugin,
  readCapped,
  renderMemorySection,
  resolveMemoryPaths,
} from './index'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-plugin-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ws(over: Partial<PluginWorkspaceView> = {}): PluginWorkspaceView {
  const root = dir
  return {
    cwd: join(root, 'proj'),
    dataDir: join(root, 'store'),
    user: {
      root: join(root, 'store'),
      plugins: '',
      skills: '',
      agents: '',
      memory: join(root, 'store', 'memory'),
    },
    project: {
      root: join(root, 'proj', '.harness'),
      plugins: '',
      skills: '',
      agents: '',
      memory: join(root, 'proj', '.harness', 'memory'),
    },
    ...over,
  }
}

function ctxWith(workspace?: PluginWorkspaceView): PluginContext {
  const noop = () => undefined
  return {
    bus: { publish: async () => undefined, subscribe: () => () => undefined } as never,
    config: { get: () => undefined, set: noop },
    log: { info: noop, warn: noop, error: noop, debug: noop },
    ...(workspace ? { workspace } : {}),
  }
}

async function install(over: Partial<Parameters<typeof createMemoryPlugin>[0]> = {}) {
  const plugin = createMemoryPlugin({ workspace: ws(), ...over })
  const hooks = ((await plugin.install(ctxWith())) ?? {}) as Hooks
  return { plugin, hooks }
}

describe('readCapped', () => {
  it('文件不存在 → exists=false 且不抛错', () => {
    const r = readCapped(join(dir, 'nope.md'))
    expect(r.exists).toBe(false)
    expect(r.text).toBe('')
  })

  it('正常读取：保留全文、不标记截断', () => {
    const p = join(dir, 'a.md')
    writeFileSync(p, '第一行\n第二行')
    const r = readCapped(p)
    expect(r.exists).toBe(true)
    expect(r.text).toBe('第一行\n第二行')
    expect(r.truncated).toBe(false)
    expect(r.totalLines).toBe(2)
  })

  it('行数超限 → 截断并给出原因（不静默丢弃）', () => {
    const p = join(dir, 'b.md')
    writeFileSync(p, Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n'))
    const r = readCapped(p, { maxLines: 3 })
    expect(r.text.split('\n')).toHaveLength(3)
    expect(r.truncated).toBe(true)
    expect(r.truncatedBy).toBe('lines')
    expect(r.totalLines).toBe(10)
  })

  it('字节超限 → 截断（先到先算）', () => {
    const p = join(dir, 'c.md')
    writeFileSync(p, 'x'.repeat(1000))
    const r = readCapped(p, { maxLines: 1000, maxBytes: 100 })
    expect(Buffer.byteLength(r.text, 'utf-8')).toBeLessThanOrEqual(100)
    expect(r.truncated).toBe(true)
    expect(r.truncatedBy).toBe('bytes')
  })

  it('默认上限与 Claude Code 的 auto memory 一致（200 行 / 25KB）', () => {
    expect(MEMORY_INDEX_MAX_LINES).toBe(200)
  })
})

describe('renderMemorySection', () => {
  const mk = (label: string, exists: boolean, text = '') => ({
    label,
    read: { path: `/p/${label}`, exists, text, totalLines: text ? text.split('\n').length : 0, truncated: false },
  })

  it('全部不存在 → 空串（不注入噪声）', () => {
    expect(renderMemorySection([mk('a', false), mk('b', false)])).toBe('')
  })

  it('存在则包在 <memory> 段里，并要求"不要复述"', () => {
    const s = renderMemorySection([mk('用户长期记忆', true, '喜欢 pnpm')])
    expect(s.startsWith('<memory>')).toBe(true)
    expect(s.endsWith('</memory>')).toBe(true)
    expect(s).toContain('喜欢 pnpm')
    expect(s).toContain('不要向用户复述')
  })

  it('截断时在片段里显式标注（避免"写了却读不到"）', () => {
    const s = renderMemorySection([
      {
        label: '用户长期记忆',
        read: { path: '/p/x', exists: true, text: 'a\nb', totalLines: 999, truncated: true, truncatedBy: 'lines' },
      },
    ])
    expect(s).toContain('行数上限被截断')
    expect(s).toContain('999')
  })
})

describe('resolveMemoryPaths', () => {
  it('四个路径：两级索引 + 两级项目指令', () => {
    const p = resolveMemoryPaths(ws())
    expect(p.user.index).toBe(join(dir, 'store', 'memory', 'MEMORY.md'))
    expect(p.project.index).toBe(join(dir, 'proj', '.harness', 'memory', 'MEMORY.md'))
    expect(p.user.instruction).toBe(join(dir, 'store', 'AGENTS.md'))
    expect(p.project.instruction).toBe(join(dir, 'proj', 'AGENTS.md'))
  })
})

describe('MemoryReader 缓存', () => {
  it('文件未变则复用（不影响前缀缓存的前提：同内容 ⇒ 同渲染）', () => {
    const p = join(dir, 'm.md')
    writeFileSync(p, 'v1')
    let reads = 0
    const r = new MemoryReader()
    const spy = new MemoryReader()
    // 用真实文件验证 mtime 缓存：同一路径连续读，第二次应命中缓存
    const a = r.read(p)
    const b = r.read(p)
    expect(a.text).toBe('v1')
    expect(b).toBe(a) // 同一对象 ⇒ 命中缓存
    void reads
    void spy
  })

  it('文件被修改后缓存失效（外部编辑能读到新内容）', async () => {
    const p = join(dir, 'n.md')
    writeFileSync(p, 'v1')
    const r = new MemoryReader()
    expect(r.read(p).text).toBe('v1')
    await new Promise((res) => setTimeout(res, 8))
    writeFileSync(p, 'v2-changed')
    expect(r.read(p).text).toBe('v2-changed')
  })
})

describe('插件装配与注入', () => {
  it('主 Agent：索引存在时注入 <memory> 段', async () => {
    const w = ws()
    mkdirSync(w.user.memory, { recursive: true })
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '用户偏好：始终用中文回答')
    const { hooks } = await install()
    const parts: string[] = []
    await hooks['prompt.system.transform']!({ agentId: 'default', sessionId: 's' }, parts)
    expect(parts.join('\n')).toContain('<memory>')
    expect(parts.join('\n')).toContain('始终用中文回答')
  })

  it('子 Agent：不注入（决策 B6：主会话记忆不进入 subagent，对齐 Claude Code）', async () => {
    const w = ws()
    mkdirSync(w.user.memory, { recursive: true })
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '不该出现在子 Agent 里')
    const { hooks } = await install()
    const parts: string[] = []
    await hooks['prompt.system.transform']!(
      { agentId: 'sub', sessionId: 's', agentMode: 'subagent' },
      parts,
    )
    expect(parts).toEqual([])
  })

  it('四个文件都不存在 → 完全不注入（零噪声）', async () => {
    const { hooks } = await install()
    const parts: string[] = []
    await hooks['prompt.system.transform']!({ agentId: 'default', sessionId: 's' }, parts)
    expect(parts).toEqual([])
  })

  it('无 workspace 视图 → 返回空 Hooks（宁可不做，也不靠猜路径）', async () => {
    const plugin = createMemoryPlugin()
    const hooks = await plugin.install(ctxWith())
    expect(hooks && Object.keys(hooks).length).toBe(0)
  })

  it('disableInjection：只留命令，不注入（对照实验用）', async () => {
    const w = ws()
    mkdirSync(w.user.memory, { recursive: true })
    writeFileSync(join(w.user.memory, 'MEMORY.md'), 'x')
    const { hooks } = await install({ disableInjection: true })
    const parts: string[] = []
    await hooks['prompt.system.transform']!({ agentId: 'default', sessionId: 's' }, parts)
    expect(parts).toEqual([])
  })
})

describe('/memory 命令', () => {
  function cmdInput(arg: string): CliCommandInput & { lines: string[] } {
    const lines: string[] = []
    return {
      raw: `memory ${arg}`,
      command: 'memory',
      arg,
      out: (s) => lines.push(s),
      sessionId: 's',
      lines,
    }
  }

  it('注册到 cli.commands', async () => {
    const { hooks } = await install()
    const commands: Array<{ command: string }> = []
    hooks['cli.commands']!({ commands } as never)
    expect(commands.map((c) => c.command)).toContain('memory')
  })

  it('list：列出各文件存在情况与路径', async () => {
    const w = ws()
    mkdirSync(w.project.memory, { recursive: true })
    writeFileSync(join(w.project.memory, 'MEMORY.md'), '项目事实')
    const { hooks } = await install()
    const input = cmdInput('')
    hooks['cli.command']!(input)
    const text = input.lines.join('')
    expect(input.result).toBe('continue')
    expect(text).toContain('项目长期记忆')
    expect(text).toContain('项目事实'.length > 0 ? join(w.project.memory, 'MEMORY.md') : '')
    expect(text).not.toContain('项目事实') // list 只给概要，不复述内容
  })

  it('show user：输出内容；不存在时明确提示', async () => {
    const w = ws()
    mkdirSync(w.user.memory, { recursive: true })
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '偏好：中文')
    const { hooks } = await install()
    const a = cmdInput('show user')
    hooks['cli.command']!(a)
    expect(a.lines.join('')).toContain('偏好：中文')

    const b = cmdInput('show project')
    hooks['cli.command']!(b)
    expect(b.lines.join('')).toContain('文件不存在')
  })

  it('path：打印四个路径（排障用）', async () => {
    const { hooks } = await install()
    const input = cmdInput('path')
    hooks['cli.command']!(input)
    const text = input.lines.join('')
    expect(text).toContain('项目指令')
    expect(text).toContain('AGENTS.md')
    expect(text).toContain('MEMORY.md')
  })

  it('其它命令不拦截（command 不匹配时不动 result）', async () => {
    const { hooks } = await install()
    const input: CliCommandInput = { ...cmdInput('x'), command: 'other' }
    hooks['cli.command']!(input)
    expect(input.result).toBeUndefined()
  })
})
