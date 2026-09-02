import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveWorkspace } from '@harness/workspace'
import type { CliCommandInput, Hooks } from '@harness/plugin'
import { renderWorkspace, createWorkspacePlugin } from './index'

function makeWs(): { ws: ReturnType<typeof resolveWorkspace>; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'ws-shell-'))
  return { ws: resolveWorkspace({ cwd: root, dataDir: join(root, '.harness') }), root }
}
const cleanup = (r: string) => rmSync(r, { recursive: true, force: true })

function cmdInput(partial: { command?: string; workspace?: unknown } = {}): CliCommandInput {
  const input: CliCommandInput & { workspace?: unknown } = {
    raw: partial.command ?? 'workspace',
    command: partial.command ?? 'workspace',
    arg: '',
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