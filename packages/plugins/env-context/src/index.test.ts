/**
 * @harness/env-context 单元测试。
 *
 * 环境事实（os / git / 时钟）全部经 options 注入 ⇒ 断言不依赖真机；
 * 仅 readGitInfo 的两条真机用例走临时目录（非 git 目录 / 最小 git 仓库）。
 */

import { describe, it, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentPlugin, Hooks } from '@harness/plugin'
import {
  collectStaticEnv,
  createEnvContextPlugin,
  detectShellForDisplay,
  formatLocalNow,
  readGitInfo,
  renderEnvSection,
  renderIsolationLine,
  renderNowSection,
} from './index'
import type { GitInfo, StaticEnvInfo } from './index'

/** 取插件的 hooks（install 的 ctx 只用到 workspace，其余字段最小化 cast） */
async function hooksOf(
  plugin: AgentPlugin,
  ctx?: { workspace?: { cwd: string } },
): Promise<Hooks> {
  const h = await plugin.install((ctx ?? {}) as never)
  if (!h) throw new Error('install 未返回 hooks')
  return h
}

const FIXTURE: StaticEnvInfo = {
  platform: 'darwin',
  arch: 'arm64',
  release: '23.0.0',
  user: 'oyoung',
  hostname: 'Mac',
  shell: '/bin/zsh',
}

describe('renderEnvSection：静态环境段（前缀区）', () => {
  it('全量事实 + cwd 渲染成 <env> 列表', () => {
    const s = renderEnvSection(FIXTURE, '/w/repo')
    expect(s).toStartWith('<env>')
    expect(s).toEndWith('</env>')
    expect(s).toInclude('- 系统: darwin 23.0.0（arm64）')
    expect(s).toInclude('- 用户: oyoung@Mac')
    expect(s).toInclude('- Shell: /bin/zsh')
    expect(s).toInclude('- 工作目录: /w/repo')
  })

  it('事实残缺时逐行省略，不输出空行占位', () => {
    const s = renderEnvSection({ platform: 'linux' }, undefined)
    expect(s).toInclude('- 系统: linux')
    expect(s).not.toInclude('用户:')
    expect(s).not.toInclude('Shell:')
    expect(s).not.toInclude('工作目录:')
  })

  it('带隔离摘要时并排渲染「隔离」行（与 Shell 行同段，进前缀缓存）', () => {
    const s = renderEnvSection(FIXTURE, '/w/repo', { level: 'L1', fsBound: false, netPolicy: 'allowlist' })
    expect(s).toInclude('- Shell: /bin/zsh')
    expect(s).toInclude('- 隔离: L1（进程层）｜可写区仅策略判定（非 OS 级）｜出网 allowlist')
  })

  it('一条事实都没有时返回空串（调用方据此不 push）', () => {
    expect(renderEnvSection({}, undefined)).toBe('')
  })
})

describe('renderIsolationLine：档位自述（P2-1）', () => {
  it('L1（默认实际档位）写明「仅策略判定」，不让人误以为是 OS 边界', () => {
    const line = renderIsolationLine({ level: 'L1', fsBound: false, netPolicy: 'open' })
    expect(line).toInclude('- 隔离: L1')
    expect(line).toInclude('进程层')
    expect(line).toInclude('仅策略判定')
    expect(line).toInclude('出网 open')
  })

  it('L2 且 fsBound ⇒ 写明可写区已由 OS 限定（同一函数，口径只有一份）', () => {
    const line = renderIsolationLine({ level: 'L2', fsBound: true, netPolicy: 'deny' })
    expect(line).toInclude('已由 OS 限定')
    expect(line).toInclude('出网 deny')
  })

  it('未知档位不静默省略（「不知道」要看得出来，不能退化成没这行）', () => {
    expect(renderIsolationLine({ level: 'L9' })).toInclude('未知档位')
  })
})

describe('formatLocalNow / renderNowSection：易变段（尾部动态区）', () => {
  it('本地时间含日期 / 时刻 / 周几 / 时区偏移', () => {
    const d = new Date(2026, 9, 9, 15, 49) // 2026-10-09 是周五
    const s = formatLocalNow(d)
    expect(s).toInclude('2026-10-09')
    expect(s).toInclude('15:49')
    expect(s).toInclude('（周五）')
    expect(s).toMatch(/GMT[+-]\d/)
  })

  it('有 git 时带分支与脏标记，干净 / 脏两种措辞', () => {
    const d = new Date(2026, 9, 9, 15, 49)
    const dirty: GitInfo = { branch: 'main', dirty: true }
    const clean: GitInfo = { branch: 'dev', dirty: false }
    expect(renderNowSection(d, dirty)).toInclude('Git: main（工作区有未提交改动）')
    expect(renderNowSection(d, clean)).toInclude('Git: dev（工作区干净）')
  })

  it('无 git 时只有时间行（宁缺毋滥）', () => {
    const s = renderNowSection(new Date(2026, 9, 9, 15, 49), undefined)
    expect(s).toInclude('当前时间')
    expect(s).not.toInclude('Git:')
  })
})

describe('createEnvContextPlugin：两条注入通道', () => {
  it('前缀：hook 入参 cwd 进「工作目录」行（权威口径）', async () => {
    const plugin = createEnvContextPlugin({ readStatic: () => FIXTURE })
    const hooks = await hooksOf(plugin)
    const parts: string[] = []
    await hooks['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's1', cwd: '/w/repo' }, parts)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toInclude('- 系统: darwin 23.0.0（arm64）')
    expect(parts[0]).toInclude('- 工作目录: /w/repo')
  })

  it('前缀：给了 isolation 才出现「隔离」行；不给则整行省略（宁缺毋滥，不猜档位）', async () => {
    const withIso = createEnvContextPlugin({ readStatic: () => FIXTURE, isolation: { level: 'L1', fsBound: false } })
    const parts1: string[] = []
    await (await hooksOf(withIso))['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's1', cwd: '/w' }, parts1)
    expect(parts1[0]).toInclude('- 隔离: L1')

    const noIso = createEnvContextPlugin({ readStatic: () => FIXTURE })
    const parts2: string[] = []
    await (await hooksOf(noIso))['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's1', cwd: '/w' }, parts2)
    expect(parts2[0]).not.toInclude('隔离')
  })

  it('前缀：cwd 缺失 + 子 Agent ⇒ 省略工作目录行（冻结值对 worktree 是错口径，不用）', async () => {
    const plugin = createEnvContextPlugin({ readStatic: () => FIXTURE })
    const hooks = await hooksOf(plugin, { workspace: { cwd: '/frozen' } })
    const parts: string[] = []
    await hooks['core.prompt.system.transform']!({ agentId: 'sub', sessionId: 's2', agentMode: 'subagent' }, parts)
    expect(parts[0]).not.toInclude('工作目录')
  })

  it('前缀：cwd 缺失 + 主会话 ⇒ 回落 install 期 workspace.cwd（该场景下两者一致）', async () => {
    const plugin = createEnvContextPlugin({ readStatic: () => FIXTURE })
    const hooks = await hooksOf(plugin, { workspace: { cwd: '/frozen' } })
    const parts: string[] = []
    await hooks['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's3' }, parts)
    expect(parts[0]).toInclude('- 工作目录: /frozen')
  })

  it('前缀：静态事实只收集一次（重复 hook 不重复调 os）', async () => {
    let calls = 0
    const plugin = createEnvContextPlugin({
      readStatic: () => { calls++; return FIXTURE },
    })
    const hooks = await hooksOf(plugin)
    await hooks['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's', cwd: '/w' }, [])
    await hooks['core.prompt.system.transform']!({ agentId: 'default', sessionId: 's', cwd: '/w' }, [])
    expect(calls).toBe(1)
  })

  it('尾部：注入时钟的时间 + readGit 的分支状态', async () => {
    const fixed = new Date(2026, 9, 9, 15, 49)
    const plugin = createEnvContextPlugin({
      now: () => fixed,
      readStatic: () => FIXTURE,
      readGit: async () => ({ branch: 'main', dirty: true }),
    })
    const hooks = await hooksOf(plugin)
    const parts: string[] = []
    await hooks['core.prompt.dynamic.transform']!({ agentId: 'default', sessionId: 's', cwd: '/w/repo' }, parts)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toInclude('当前时间: 2026-10-09 15:49')
    expect(parts[0]).toInclude('Git: main（工作区有未提交改动）')
  })

  it('尾部：readGit 抛错 / 返回 undefined ⇒ 省略 Git 行，不炸通道', async () => {
    const plugin = createEnvContextPlugin({
      now: () => new Date(2026, 9, 9, 15, 49),
      readGit: async () => { throw new Error('boom') },
    })
    const hooks = await hooksOf(plugin)
    const parts: string[] = []
    await hooks['core.prompt.dynamic.transform']!({ agentId: 'default', sessionId: 's', cwd: '/w' }, parts)
    expect(parts[0]).toInclude('当前时间')
    expect(parts[0]).not.toInclude('Git:')
  })

  it('尾部：includeGit=false 不调 readGit（子 Agent worktree 也可借此关闭）', async () => {
    let calls = 0
    const plugin = createEnvContextPlugin({
      includeGit: false,
      readGit: async () => { calls++; return { branch: 'x', dirty: false } },
    })
    const hooks = await hooksOf(plugin)
    const parts: string[] = []
    await hooks['core.prompt.dynamic.transform']!({ agentId: 'default', sessionId: 's', cwd: '/w' }, parts)
    expect(calls).toBe(0)
    expect(parts[0]).not.toInclude('Git:')
  })
})

describe('detectShellForDisplay：跨平台 shell 名称探测', () => {
  it('非 Windows 优先 process.env.SHELL，缺失回退 bash', () => {
    expect(detectShellForDisplay({ platform: 'darwin', env: { SHELL: '/bin/zsh' } as NodeJS.ProcessEnv })).toBe('/bin/zsh')
    expect(detectShellForDisplay({ platform: 'linux', env: {} as NodeJS.ProcessEnv })).toBe('bash')
  })

  it('Windows 优先 SHELL，其次 PATH 中的 bash.exe，再 PowerShell，最后 cmd', () => {
    expect(detectShellForDisplay({ platform: 'win32', env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv })).toBe('/bin/bash')

    const hasBash = (p: string) => p === 'C:\\Git\\bin\\bash.exe'
    expect(detectShellForDisplay({ platform: 'win32', pathSep: ';', dirSep: '\\', exists: hasBash, env: { PATH: 'C:\\Git\\bin' } as NodeJS.ProcessEnv })).toBe('bash.exe')

    const hasPwsh = (p: string) => p === 'C:\\pwsh.exe'
    expect(detectShellForDisplay({ platform: 'win32', pathSep: ';', dirSep: '\\', exists: hasPwsh, env: { PATH: 'C:\\' } as NodeJS.ProcessEnv })).toBe('pwsh.exe')

    expect(
      detectShellForDisplay({
        platform: 'win32',
        pathSep: ';',
        dirSep: '\\',
        exists: () => false,
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } as NodeJS.ProcessEnv,
      }),
    ).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})

describe('collectStaticEnv / readGitInfo：真机读取', () => {
  it('collectStaticEnv 至少给出 platform / arch（真机弱断言）', () => {
    const env = collectStaticEnv()
    expect(typeof env.platform).toBe('string')
    expect(env.platform!.length).toBeGreaterThan(0)
    expect(typeof env.arch).toBe('string')
    expect(env.arch!.length).toBeGreaterThan(0)
  })

  it('readGitInfo：非 git 目录返回 undefined（省略而非报错）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'envctx-nogit-'))
    expect(await readGitInfo(dir)).toBeUndefined()
  })

  it('readGitInfo：最小 git 仓库（无提交 + untracked ⇒ 脏；提交后 ⇒ 干净）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'envctx-git-'))
    execFileSync('git', ['-C', dir, 'init', '-q'])
    // 分支名不假设（init.defaultBranch 因机器而异），用 symbolic-ref 动态取
    const branch = execFileSync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']).toString().trim()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    // 「No commits yet on <branch>」头行 + untracked 文件 ⇒ 分支可解析、脏
    expect(await readGitInfo(dir)).toEqual({ branch, dirty: true })
    execFileSync('git', ['-C', dir, 'add', 'a.txt'])
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
    expect(await readGitInfo(dir)).toEqual({ branch, dirty: false })
  })
})
