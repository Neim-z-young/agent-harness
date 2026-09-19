import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliCommandInput, Hooks, PluginContext, PluginWorkspaceView } from '@harness/plugin'
import {
  MEMORY_INDEX_MAX_LINES,
  MemoryReader,
  MemoryStore,
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

  it('list：列出条目（带序号）与文件状态', async () => {
    const w = ws()
    mkdirSync(w.project.memory, { recursive: true })
    writeFileSync(join(w.project.memory, 'MEMORY.md'), '- 项目事实A\n- 项目事实B\n')
    const { hooks } = await install()
    const input = cmdInput('')
    hooks['cli.command']!(input)
    const text = input.lines.join('')
    expect(input.result).toBe('continue')
    expect(text).toContain('项目长期记忆')
    expect(text).toContain('项目事实A')
    expect(text).toMatch(/1\.\s*项目事实A/)
    expect(text).toMatch(/2\.\s*项目事实B/)
    // 条目数与预算一起给出（写入前自查手上有多少额度）
    expect(text).toContain('2 条')
    expect(text).toContain('上限')
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

// ===== M2：写入内核（校验 / 去重 / 原子写）=====

describe('MemoryStore', () => {
  const storePath = () => join(dir, 'memory', 'MEMORY.md')

  it('add：追加并返回序号；文件不存在时按需创建目录', () => {
    const st = new MemoryStore(storePath())
    const r = st.add('偏好：中文回答')
    expect(r.ok).toBe(true)
    expect(r.index).toBe(1)
    expect(existsSync(storePath())).toBe(true)
    expect(st.entries().map((e) => e.text)).toEqual(['偏好：中文回答'])
  })

  it('add：空白归一化后重复 ⇒ duplicate，不重复写入', () => {
    const st = new MemoryStore(storePath())
    st.add('偏好：中文回答')
    const again = st.add('  偏好：中文回答  ')
    expect(again.ok).toBe(false)
    expect(again.reason).toBe('duplicate')
    expect(st.entries()).toHaveLength(1)
  })

  it('add：超限 ⇒ 拒绝且**不落盘**（避免"写了却读不到"的静默失效）', () => {
    const st = new MemoryStore(storePath(), { maxLines: 3, maxBytes: 10_000 })
    expect(st.add('a').ok).toBe(true)
    expect(st.add('b').ok).toBe(true)
    const before = readFileSync(storePath(), 'utf-8')
    const over = st.add('c')
    expect(over.ok).toBe(false)
    expect(over.reason).toBe('over-limit')
    expect(over.message).toContain('超过上限')
    expect(readFileSync(storePath(), 'utf-8')).toBe(before) // 文件未被触碰
  })

  it('remove：按 1-based 序号删除', () => {
    const st = new MemoryStore(storePath())
    st.add('第一条')
    st.add('第二条')
    st.add('第三条')
    const r = st.remove('2')
    expect(r.ok).toBe(true)
    expect(st.entries().map((e) => e.text)).toEqual(['第一条', '第三条'])
  })

  it('remove：按文本删除；找不到时明确报错', () => {
    const st = new MemoryStore(storePath())
    st.add('要删掉的')
    st.add('保留的')
    expect(st.remove('要删掉的').ok).toBe(true)
    expect(st.entries().map((e) => e.text)).toEqual(['保留的'])
    const miss = st.remove('不存在的')
    expect(miss.ok).toBe(false)
    expect(miss.reason).toBe('not-found')
  })

  it('写入是原子的：不留下临时文件', () => {
    const st = new MemoryStore(storePath())
    st.add('x')
    st.remove('1')
    const files = readdirSync(join(dir, 'memory'))
    expect(files.filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('budget：给出当前用量与上限（供写入前自查）', () => {
    const st = new MemoryStore(storePath(), { maxLines: 50, maxBytes: 999 })
    st.add('一条')
    const b = st.budget()
    expect(b.maxLines).toBe(50)
    expect(b.maxBytes).toBe(999)
    expect(b.lines).toBeGreaterThan(0)
  })
})

describe('/memory 写入命令', () => {
  function cmdInput(arg: string): CliCommandInput & { lines: string[] } {
    const lines: string[] = []
    return { raw: `memory ${arg}`, command: 'memory', arg, out: (s) => lines.push(s), sessionId: 's', lines }
  }

  it('add 默认写 user 级（项目级会随 git 共享，须显式指定）', async () => {
    const w = ws()
    const { hooks } = await install()
    const input = cmdInput('add 偏好：用中文')
    hooks['cli.command']!(input)
    expect(input.lines.join('')).toContain('用户长期记忆')
    expect(existsSync(join(w.user.memory, 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(w.project.memory, 'MEMORY.md'))).toBe(false)
  })

  it('add project：写入项目级', async () => {
    const w = ws()
    const { hooks } = await install()
    hooks['cli.command']!(cmdInput('add project 项目事实：ACP 参数见 docs'))
    expect(readFileSync(join(w.project.memory, 'MEMORY.md'), 'utf-8')).toContain('ACP 参数见 docs')
  })

  it('add 超限时提示"未写入"，且不产生半截文件', async () => {
    const w = ws()
    mkdirSync(w.user.memory, { recursive: true })
    writeFileSync(join(w.user.memory, 'MEMORY.md'), Array.from({ length: 3 }, (_, i) => `- L${i}`).join('\n'))
    const { hooks } = await install({ maxLines: 3 })
    const input = cmdInput('add 再来一条')
    hooks['cli.command']!(input)
    expect(input.lines.join('')).toContain('未写入')
    expect(readFileSync(join(w.user.memory, 'MEMORY.md'), 'utf-8')).not.toContain('再来一条')
  })

  it('rm 删除后立即可被下一轮注入读到（写入必须清缓存）', async () => {
    const w = ws()
    const { hooks } = await install()
    hooks['cli.command']!(cmdInput('add 会被删掉的'))
    hooks['cli.command']!(cmdInput('add 保留的'))
    hooks['cli.command']!(cmdInput('rm 会被删掉的'))

    const parts: string[] = []
    await hooks['prompt.system.transform']!({ agentId: 'default', sessionId: 's' }, parts)
    const injected = parts.join('\n')
    expect(injected).toContain('保留的')
    expect(injected).not.toContain('会被删掉的')
    void w
  })

  it('reload：清缓存后读到外部修改（防"改了没生效"的困惑）', async () => {
    const w = ws()
    const { hooks } = await install()
    hooks['cli.command']!(cmdInput('add 原始内容'))
    // 模拟外部编辑（人直接改文件）
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '- 外部改写的内容\n')
    const input = cmdInput('reload')
    hooks['cli.command']!(input)
    expect(input.lines.join('')).toContain('已清空记忆缓存')
    const parts: string[] = []
    await hooks['prompt.system.transform']!({ agentId: 'default', sessionId: 's' }, parts)
    expect(parts.join('\n')).toContain('外部改写的内容')
  })
})
