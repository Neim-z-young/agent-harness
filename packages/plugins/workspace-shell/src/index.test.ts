import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveWorkspace } from '@harness/workspace'
import type { CliCommandInput, Hooks } from '@harness/plugin'
import { renderWorkspace, createWorkspacePlugin, resolveOpenTarget, type OpenDir } from './index'

function makeWs(): { ws: ReturnType<typeof resolveWorkspace>; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'ws-shell-'))
  return { ws: resolveWorkspace({ cwd: root, dataDir: join(root, '.harness') }), root }
}
const cleanup = (r: string) => rmSync(r, { recursive: true, force: true })

function cmdInput(
  partial: { command?: string; arg?: string; workspace?: unknown; raw?: string } = {},
): CliCommandInput & {
  workspace?: unknown
} {
  const command = partial.command ?? 'workspace'
  // 模拟 cli 实际行为：arg 由整行 split(/\s+/,2) 取第二 token（如 'open'），完整参数在 raw。
  const arg = partial.arg ?? ''
  const full = `${command} ${arg}`.trim()
  const input: CliCommandInput & { workspace?: unknown } = {
    raw: partial.raw ?? full,
    command,
    arg: full.split(/\s+/, 2)[1] ?? '',
    sessionId: 's1',
    result: undefined,
    out: () => {},
    workspace: partial.workspace,
  }
  return input
}

/** install(ctx) 需要 PluginContext，测试中用宽化签名获取 hooks 对象 */
async function hooksOf(p: ReturnType<typeof createWorkspacePlugin>): Promise<NonNullable<Hooks>> {
  return (await (p.install as (ctx?: unknown) => Promise<Hooks | void>)(undefined))!
}

describe('renderWorkspace', () => {
  it('包含两级布局与数据文件路径，✓ 标记已存在路径', () => {
    const { ws, root } = makeWs()
    try {
      mkdirSync(ws.user.plugins, { recursive: true })
      writeFileSync(ws.files.config, '{}')
      const text = renderWorkspace(ws)
      expect(text).toContain(ws.cwd)
      expect(text).toContain(ws.dataDir)
      expect(text).toContain(ws.user.plugins)
      expect(text).toContain(`✓${ws.user.plugins}`)   // 已建 → ✓
      expect(text).toContain(`✓${ws.files.config}`)   // 已建 config
      expect(text).toContain(ws.project.skills)       // 项目级路径展示（未建也列出）
      expect(text).toContain('user → project')         // 覆盖顺序说明
      expect(text).toContain(ws.files.permissions)
      expect(text).toContain(ws.files.secretKey)
    } finally { cleanup(root) }
  })

  it('自定义标题', () => {
    const { ws, root } = makeWs()
    try {
      expect(renderWorkspace(ws, '我的工作区')).toContain('我的工作区')
    } finally { cleanup(root) }
  })
})

describe('createWorkspacePlugin · cli.command 处理', () => {
  it('命中 workspace 时输出渲染并设 result=continue（workspace 由 cli 注入 input）', async () => {
    const { ws, root } = makeWs()
    try {
      const hooks = await hooksOf(createWorkspacePlugin())
      const out: string[] = []
      const input = cmdInput({ workspace: ws })
      input.out = (s) => void out.push(s)
      await hooks['cli.command']!(input)
      expect(input.result).toBe('continue')
      expect(out.join('')).toContain(ws.cwd)
    } finally { cleanup(root) }
  })

  it('workspace 未注入 input 时回退 opts.workspace', async () => {
    const { ws, root } = makeWs()
    try {
      const hooks = await hooksOf(createWorkspacePlugin({ workspace: ws }))
      const out: string[] = []
      const input = cmdInput()
      input.out = (s) => void out.push(s)
      await hooks['cli.command']!(input)
      expect(input.result).toBe('continue')
      expect(out.join('')).toContain(ws.dataDir)
    } finally { cleanup(root) }
  })

  it('两者皆无 → 提示未注入且设 result=continue', async () => {
    const hooks = await hooksOf(createWorkspacePlugin())
    const out: string[] = []
    const input = cmdInput()
    input.out = (s) => void out.push(s)
    await hooks['cli.command']!(input)
    expect(input.result).toBe('continue')
    expect(out.join('')).toContain('工作区未注入')
  })

  it('未命中其他命令时不设 result（留给别的插件）', async () => {
    const { ws, root } = makeWs()
    try {
      const hooks = await hooksOf(createWorkspacePlugin({ workspace: ws }))
      const input = cmdInput({ command: 'tools' })
      await hooks['cli.command']!(input)
      expect(input.result).toBeUndefined()
    } finally { cleanup(root) }
  })
})

describe('resolveOpenTarget', () => {
  it('缺省 target → dataDir；别名 user/data → dataDir', () => {
    const { ws, root } = makeWs()
    try {
      expect(resolveOpenTarget(ws)).toEqual({ path: ws.dataDir })
      expect(resolveOpenTarget(ws, 'user')).toEqual({ path: ws.dataDir })
      expect(resolveOpenTarget(ws, 'data')).toEqual({ path: ws.dataDir })
    } finally { cleanup(root) }
  })

  it('cwd / project 别名映射到对应根目录', () => {
    const { ws, root } = makeWs()
    try {
      expect(resolveOpenTarget(ws, 'cwd')).toEqual({ path: ws.cwd })
      expect(resolveOpenTarget(ws, 'project')).toEqual({ path: ws.project.root })
    } finally { cleanup(root) }
  })

  it('普通路径：相对 cwd resolve，存在则返回、不存在返回 error', () => {
    const { ws, root } = makeWs()
    try {
      mkdirSync(join(root, 'sub'), { recursive: true })
      const p = join(root, 'sub')
      expect(resolveOpenTarget(ws, 'sub')).toEqual({ path: p })
      const miss = join(root, 'nope')
      expect('error' in resolveOpenTarget(ws, 'nope')).toBe(true)
      const r = resolveOpenTarget(ws, 'nope')
      expect(r && 'error' in r ? (r as { error: string }).error : '').toContain(miss)
    } finally { cleanup(root) }
  })
})

describe('createWorkspacePlugin · /workspace open 子命令', () => {
  it('open 缺省目标打开 dataDir，并设 result=continue', async () => {
    const { ws, root } = makeWs()
    try {
      const opened: string[] = []
      const fakeOpen: OpenDir = (p) => { opened.push(p); return { ok: true } }
      const hooks = await hooksOf(createWorkspacePlugin({ open: fakeOpen }))
      const out: string[] = []
      const input = cmdInput({ arg: 'open' })
      input.workspace = ws
      input.out = (s) => void out.push(s)
      await hooks['cli.command']!(input)
      expect(opened).toEqual([ws.dataDir])
      expect(out.join('')).toContain('已打开目录')
      expect(input.result).toBe('continue')
    } finally { cleanup(root) }
  })

  it('open cwd / project 打开对应目录', async () => {
    const { ws, root } = makeWs()
    try {
      const opened: string[] = []
      const hooks = await hooksOf(createWorkspacePlugin({ open: (p) => { opened.push(p); return { ok: true } } }))
      await hooks['cli.command']!(cmdInput({ arg: 'open cwd', workspace: ws }))
      await hooks['cli.command']!(cmdInput({ arg: 'open project', workspace: ws }))
      expect(opened).toEqual([ws.cwd, ws.project.root])
    } finally { cleanup(root) }
  })

  it('回归：cli 截断 arg 为第二 token（open），完整目标从 raw 解析 → cwd 打开工作目录而非 dataDir', async () => {
    const { ws, root } = makeWs()
    try {
      const opened: string[] = []
      const hooks = await hooksOf(createWorkspacePlugin({ open: (p) => { opened.push(p); return { ok: true } } }))
      // cli 注入 arg='open'、raw='workspace open cwd'
      const input = cmdInput({ arg: 'open cwd', workspace: ws })
      expect(input.arg).toBe('open') // 断言 arg 确实被截断
      await hooks['cli.command']!(input)
      expect(opened).toEqual([ws.cwd]) // 应解析出 cwd，而非落到 dataDir
    } finally { cleanup(root) }
  })

  it('open 目录不存在 → 报错且不调用 open', async () => {
    const { ws, root } = makeWs()
    try {
      const opened: string[] = []
      const hooks = await hooksOf(createWorkspacePlugin({ open: (p) => { opened.push(p); return { ok: true } } }))
      const out: string[] = []
      const input = cmdInput({ arg: 'open nope' })
      input.workspace = ws
      input.out = (s) => void out.push(s)
      await hooks['cli.command']!(input)
      expect(opened).toEqual([])
      expect(out.join('')).toContain('目录不存在')
    } finally { cleanup(root) }
  })

  it('open 打不开 → 输出失败信息', async () => {
    const { ws, root } = makeWs()
    try {
      const hooks = await hooksOf(createWorkspacePlugin({ open: () => ({ ok: false, error: 'boom' }) }))
      const out: string[] = []
      const input = cmdInput({ arg: 'open' })
      input.workspace = ws
      input.out = (s) => void out.push(s)
      await hooks['cli.command']!(input)
      expect(out.join('')).toContain('打开失败')
      expect(input.result).toBe('continue')
    } finally { cleanup(root) }
  })

  it('help 输出用法说明', async () => {
    const { ws, root } = makeWs()
    try {
      const hooks = await hooksOf(createWorkspacePlugin())
      const out: string[] = []
      const input = cmdInput({ arg: 'help' })
      input.workspace = ws
      input.out = (s) => void out.push(s)
      await hooks['cli.command']!(input)
      expect(out.join('')).toContain('用法')
      expect(out.join('')).toContain('/workspace open')
    } finally { cleanup(root) }
  })
})

describe('createWorkspacePlugin · cli.commands 注册', () => {
  it('注册 /workspace 命令定义', async () => {
    const { ws, root } = makeWs()
    try {
      const hooks = await hooksOf(createWorkspacePlugin({ workspace: ws }))
      const cmds: Array<{ command: string; description: string; usage?: string }> = []
      await hooks['cli.commands']!({ commands: cmds })
      expect(cmds.some((c) => c.command === 'workspace')).toBe(true)
    } finally { cleanup(root) }
  })
})

describe('createWorkspacePlugin 元数据', () => {
  it('暴露稳定 id', () => {
    expect(createWorkspacePlugin().id).toBe('workspace-shell')
  })
})