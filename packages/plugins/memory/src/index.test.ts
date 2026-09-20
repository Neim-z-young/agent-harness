import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliCommandInput, Hooks, PluginContext, PluginWorkspaceView } from '@harness/plugin'
import {
  MEMORY_INDEX_MAX_LINES,
  MemoryPublisher,
  MemoryReader,
  MemoryStore,
  buildReflectionHint,
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
    await hooks['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's' }, parts)
    expect(parts.join('\n')).toContain('<memory>')
    expect(parts.join('\n')).toContain('始终用中文回答')
  })

  it('子 Agent：不注入（决策 B6：主会话记忆不进入 subagent，对齐 Claude Code）', async () => {
    const w = ws()
    mkdirSync(w.user.memory, { recursive: true })
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '不该出现在子 Agent 里')
    const { hooks } = await install()
    const parts: string[] = []
    await hooks['core.prompt.system.transform']!(
      { agentId: 'sub', sessionId: 's', agentMode: 'subagent' },
      parts,
    )
    expect(parts).toEqual([])
  })

  it('四个文件都不存在 → 完全不注入（零噪声）', async () => {
    const { hooks } = await install()
    const parts: string[] = []
    await hooks['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's' }, parts)
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
    await hooks['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's' }, parts)
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
    await hooks['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's' }, parts)
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
    await hooks['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's' }, parts)
    expect(parts.join('\n')).toContain('外部改写的内容')
  })
})

// ===== M3：分级注入（§3.7）=====

describe('MemoryPublisher（分级发布）', () => {
  it('首次注入 ⇒ 立即发布（否则永远不注入）', () => {
    const p = new MemoryPublisher()
    expect(p.onInject('A')).toBe('A')
    expect(p.state().published).toBe(true)
  })

  it('内容有变 ⇒ 攒批：继续注入旧内容，标记 dirty', () => {
    const p = new MemoryPublisher({ flushAfterTurns: 5 })
    p.onInject('A')
    expect(p.onInject('B')).toBe('A') // 仍注入旧内容
    expect(p.state().dirty).toBe(true)
    expect(p.state().dirtyTurns).toBe(0)
  })

  it('flush（压缩发生）⇒ 下次注入发布最新内容', () => {
    const p = new MemoryPublisher({ flushAfterTurns: 5 })
    p.onInject('A')
    p.onInject('B')
    p.flush()
    expect(p.onInject('B')).toBe('B')
    expect(p.state().dirty).toBe(false)
  })

  it('兜底：攒够轮数仍无压缩 ⇒ 放行（防止永远等不到压缩）', () => {
    const p = new MemoryPublisher({ flushAfterTurns: 3 })
    p.onInject('A')
    p.onInject('B')
    p.onTurnEnd()
    p.onTurnEnd()
    expect(p.onInject('B')).toBe('A') // 还差一轮
    p.onTurnEnd()
    expect(p.onInject('B')).toBe('B') // 第 3 轮后放行
  })

  it('flushAfterTurns=0 ⇒ 关闭攒批（任何变更立即生效，等价 M2 行为）', () => {
    const p = new MemoryPublisher({ flushAfterTurns: 0 })
    p.onInject('A')
    expect(p.onInject('B')).toBe('B')
  })

  it('内容回退到已发布状态 ⇒ 不再算 dirty（避免无意义攒批）', () => {
    const p = new MemoryPublisher({ flushAfterTurns: 3 })
    p.onInject('A')
    p.onInject('B')
    expect(p.state().dirty).toBe(true)
    p.onInject('A') // 又变回来了（例如撤销了编辑）
    p.onTurnEnd()
    expect(p.state().dirtyTurns).toBe(0)
    expect(p.onInject('A')).toBe('A')
  })
})

describe('buildReflectionHint', () => {
  it('含目标文件路径与写入格式，并要求"只在真有内容时写"', () => {
    const h = buildReflectionHint('/home/u/.harness/memory/MEMORY.md')
    expect(h).toContain('/home/u/.harness/memory/MEMORY.md')
    expect(h).toContain('- ')
    expect(h).toContain('只在确有值得记的内容时写')
  })
})

describe('插件级：flush 三源与一次性提示', () => {
  async function hooksOf(over: Record<string, unknown> = {}) {
    const w = ws()
    const { hooks } = await install({ flushAfterTurns: 5, ...over })
    return { hooks, w }
  }
  const sys = { agentId: 'default', sessionId: 's' }
  const inject = async (hooks: Hooks) => {
    const parts: string[] = []
    await hooks['core.prompt.system.transform']!(sys, parts)
    return parts.join('\n')
  }

  it('外部改动（直接改文件）默认攒批：注入仍是旧内容', async () => {
    const { hooks, w } = await hooksOf()
    const { hooks: h2 } = await install() // 独立实例，避免互相干扰
    void h2
    hooks['cli.command']!({ raw: 'memory add', command: 'memory', arg: 'add 初始内容', out: () => {}, sessionId: 's' })
    expect(await inject(hooks)).toContain('初始内容')

    // 模拟外部编辑（不经命令 ⇒ 不 flush）
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '- 外部改写\n')
    expect(await inject(hooks)).toContain('初始内容') // 仍未发布
    expect(await inject(hooks)).not.toContain('外部改写')
  })

  it('ACP 压缩（引擎层 core.tool.post.execute compress）⇒ flush + 一次性沉淀提示', async () => {
    const { hooks, w } = await hooksOf()
    hooks['cli.command']!({ raw: 'memory add', command: 'memory', arg: 'add 初始', out: () => {}, sessionId: 's' })
    await inject(hooks)
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '- 压缩前的改动\n')

    // 引擎层信号（任何宿主都有）：compress 工具执行成功。不再依赖 UI 层的 cli.agent.stream。
    hooks['core.tool.post.execute']!({ tool: { id: 'compress' }, input: {}, ctx: { sessionId: 's' } }, { ok: true })
    const first = await inject(hooks)
    expect(first).toContain('压缩前的改动')       // 已发布
    expect(first).toContain('<memory-hint>')       // 提示出现
    const second = await inject(hooks)
    expect(second).toContain('压缩前的改动')
    expect(second).not.toContain('<memory-hint>')  // 一次性
  })

  it('ACP 压缩失败不 flush（压缩没成，窗口还没腾出来）', async () => {
    const { hooks, w } = await hooksOf()
    hooks['cli.command']!({ raw: 'memory add', command: 'memory', arg: 'add 初始', out: () => {}, sessionId: 's' })
    await inject(hooks)
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '- 压缩前的改动\n')

    hooks['core.tool.post.execute']!({ tool: { id: 'compress' }, input: {}, ctx: { sessionId: 's' } }, { ok: false, error: { message: 'x' } })
    expect(await inject(hooks)).not.toContain('压缩前的改动') // 未发布
  })

  it('非 compress 工具不触发 flush', async () => {
    const { hooks, w } = await hooksOf()
    hooks['cli.command']!({ raw: 'memory add', command: 'memory', arg: 'add 初始', out: () => {}, sessionId: 's' })
    await inject(hooks)
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '- 压缩前的改动\n')

    hooks['core.tool.post.execute']!({ tool: { id: 'bash' }, input: {}, ctx: { sessionId: 's' } }, { ok: true })
    expect(await inject(hooks)).not.toContain('压缩前的改动')
  })

  it('session compaction（core.session.compacting）也触发 flush', async () => {
    const { hooks, w } = await hooksOf()
    hooks['cli.command']!({ raw: 'memory add', command: 'memory', arg: 'add 初始', out: () => {}, sessionId: 's' })
    await inject(hooks)
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '- session 压缩时的改动\n')

    hooks['core.session.compacting']!({ agentId: 'd', sessionId: 's' } as never, {} as never)
    expect(await inject(hooks)).toContain('session 压缩时的改动')
  })

  it('兜底：攒够轮数（core.agent.turn.end）后发布，即使从未压缩', async () => {
    const { hooks, w } = await hooksOf({ flushAfterTurns: 2 })
    hooks['cli.command']!({ raw: 'memory add', command: 'memory', arg: 'add 初始', out: () => {}, sessionId: 's' })
    await inject(hooks)
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '- 攒批的改动\n')

    expect(await inject(hooks)).toContain('初始')
    // 引擎层的整轮终态（不是 cli.agent.stream —— 那条只在有 UI 消费层的宿主里才有）
    hooks['core.agent.turn.end']!({ agentId: 'default', mode: 'primary', sessionId: 's', step: 1 })
    hooks['core.agent.turn.end']!({ agentId: 'default', mode: 'primary', sessionId: 's', step: 1 })
    expect(await inject(hooks)).toContain('攒批的改动')
  })

  it('命令写入是例外：立即生效，不参与攒批', async () => {
    const { hooks } = await hooksOf()
    hooks['cli.command']!({ raw: 'memory add', command: 'memory', arg: 'add 第一条', out: () => {}, sessionId: 's' })
    hooks['cli.command']!({ raw: 'memory add', command: 'memory', arg: 'add 第二条', out: () => {}, sessionId: 's' })
    expect(await inject(hooks)).toContain('第二条')
  })
})

// ===== M3 补充：默认轮数 / 快照语义 / 主会话过滤 =====

describe('默认攒批轮数与快照语义', () => {
  it('flushAfterTurns 默认 15（单位是「轮」= 一次用户输入跑完，不是一次模型调用）', () => {
    expect(new MemoryPublisher().state().flushAfterTurns).toBe(15)
  })

  it('注入段声明"这是快照"，并指向文件供 read 自证（治"我写了却没生效"的误判）', () => {
    const f = join(dir, 'MEMORY.md')
    writeFileSync(f, '- 一条事实\n')
    const section = renderMemorySection([{ label: '用户长期记忆', read: readCapped(f) }])
    expect(section).toContain('快照')
    expect(section).toContain('read')
    expect(section).toContain(f)
  })

  it('截断时要求先合并/删除，而不只是"去读全文"（治"只追加不清理"）', () => {
    const f = join(dir, 'MEMORY.md')
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => `- L${i}`).join('\n'))
    const section = renderMemorySection([{ label: '用户长期记忆', read: readCapped(f, { maxLines: 3 }) }])
    expect(section).toContain('不会被加载')
    expect(section).toContain('合并或删除')
    expect(section).toContain('原 10 行')
  })

  it('沉淀提示要求先 read 防重复（system 里那份是快照，可能还没包含刚写的内容）', () => {
    const h = buildReflectionHint('/x/MEMORY.md')
    expect(h).toContain('先用 read 看一眼该文件')
    expect(h).toContain('避免重复追加')
  })
})

describe('turn_end 计数只认主会话', () => {
  const sys = { agentId: 'default', sessionId: 's' }
  async function installAt(over: Record<string, unknown> = {}) {
    return await install({ flushAfterTurns: 2, ...over })
  }
  const inject = async (hooks: Hooks) => {
    const parts: string[] = []
    await hooks['core.prompt.system.transform']!(sys, parts)
    return parts.join('\n')
  }
  const endTurn = (hooks: Hooks, sessionId?: string, mode = 'primary') => {
    // 引擎层通道：core.agent.turn.end（不是 cli.agent.stream 的 turn_end —— 那条只存在于有 UI 的宿主）
    hooks['core.agent.turn.end']!({
      agentId: 'default',
      mode,
      step: 1,
      ...(sessionId ? { sessionId } : {}),
    })
  }

  it('别的会话（teammate / 子 Agent）的轮不计入，主会话的轮才计入', async () => {
    const w = ws()
    const { hooks } = await installAt()
    hooks['cli.command']!({ raw: 'memory add', command: 'memory', arg: 'add 初始', out: () => {}, sessionId: 's' })
    expect(await inject(hooks)).toContain('初始')

    writeFileSync(join(w.user.memory, 'MEMORY.md'), '- 改动\n')
    endTurn(hooks, 'teammate-1') // 两次都不该计数
    endTurn(hooks, 'teammate-1')
    expect(await inject(hooks)).toContain('初始') // 仍是旧快照

    endTurn(hooks, 's')
    endTurn(hooks, 's') // 主会话满 2 轮 ⇒ 兜底放行
    expect(await inject(hooks)).toContain('改动')
  })

  it('信号缺 sessionId 时按"无法归因"照常计数（不把兜底变成死代码）', async () => {
    const w = ws()
    const { hooks } = await installAt()
    hooks['cli.command']!({ raw: 'memory add', command: 'memory', arg: 'add 初始', out: () => {}, sessionId: 's' })
    await inject(hooks)
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '- 改动\n')
    // 变更要先被某次注入"发现"（dirty 只在注入时算出）——真实链路里就是下一轮开头那一次
    expect(await inject(hooks)).toContain('初始')

    endTurn(hooks) // 不带 sessionId
    endTurn(hooks)
    expect(await inject(hooks)).toContain('改动')
  })

  it('等长改写也能读到新内容：缓存戳必须到纳秒（毫秒级会把同尺寸的改写误判成"没变"）', () => {
    const f = join(dir, 'stamp.md')
    const r = new MemoryReader()
    writeFileSync(f, 'aaaa\n')
    expect(r.read(f).text).toBe('aaaa\n')
    for (const v of ['bbbb', 'cccc', 'dddd']) {
      writeFileSync(f, `${v}\n`) // 与上一版**等长**：只看 size 分辨不出来
      expect(r.read(f).text).toBe(`${v}\n`)
    }
  })
})

describe('轮次计数的来源必须是引擎层（core.agent.turn.end）', () => {
  const sys = { agentId: 'default', sessionId: 's' }
  const inject = async (hooks: Hooks) => {
    const parts: string[] = []
    await hooks['core.prompt.system.transform']!(sys, parts)
    return parts.join('\n')
  }
  const endTurn = (hooks: Hooks, mode = 'primary', sessionId: string | undefined = 's') => {
    hooks['core.agent.turn.end']!({ agentId: 'default', mode, step: 1, ...(sessionId ? { sessionId } : {}) })
  }

  it('不再订阅 UI 通道（cli.agent.stream）—— 信号全部来自引擎层，内嵌宿主下不失效', async () => {
    const w = ws()
    const { hooks } = await install({ flushAfterTurns: 2 })
    // 早先 ACP 压缩走 cli.agent.stream（UI 层），内嵌宿主收不到 ⇒ 已全部改引擎层
    expect(hooks['cli.agent.stream']).toBeUndefined()
    expect(typeof hooks['core.tool.post.execute']).toBe('function')

    hooks['cli.command']!({ raw: 'memory add', command: 'memory', arg: 'add 初始', out: () => {}, sessionId: 's' })
    await inject(hooks)
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '- 改动\n')
    expect(await inject(hooks)).toContain('初始') // 先被"发现"（dirty）

    endTurn(hooks)
    endTurn(hooks)
    expect(await inject(hooks)).toContain('改动') // 引擎层两次即放行
  })

  it('子 Agent 的轮不计入（mode=subagent 直接跳过）', async () => {
    const w = ws()
    const { hooks } = await install({ flushAfterTurns: 2 })
    hooks['cli.command']!({ raw: 'memory add', command: 'memory', arg: 'add 初始', out: () => {}, sessionId: 's' })
    await inject(hooks)
    writeFileSync(join(w.user.memory, 'MEMORY.md'), '- 改动\n')
    expect(await inject(hooks)).toContain('初始')

    endTurn(hooks, 'subagent')
    endTurn(hooks, 'subagent')
    expect(await inject(hooks)).toContain('初始') // 子 Agent 的轮不算用户的轮

    endTurn(hooks)
    endTurn(hooks)
    expect(await inject(hooks)).toContain('改动')
  })
})
