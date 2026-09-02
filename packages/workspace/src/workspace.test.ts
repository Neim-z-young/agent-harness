import { describe, it, expect } from 'bun:test'
import { join } from 'node:path'
import { resolveWorkspace, level, dataFiles, defaultUserDir } from './index'

const TMP = '/tmp/ws-mod'

describe('resolveWorkspace（工作区定位与解析）', () => {
  it('给定 cwd 与 dataDir：返回两级目录 + 数据文件路径，全部绝对路径', () => {
    const cwd = `${TMP}/proj-a`
    const dataDir = `${TMP}/store`
    const ws = resolveWorkspace({ cwd, dataDir })

    // 根
    expect(ws.cwd).toBe(cwd)
    expect(ws.dataDir).toBe(dataDir)

    // 用户级（dataDir）
    expect(ws.user.root).toBe(dataDir)
    expect(ws.user.plugins).toBe(join(dataDir, 'plugins'))
    expect(ws.user.skills).toBe(join(dataDir, 'skills'))
    expect(ws.user.agents).toBe(join(dataDir, 'agents'))

    // 项目级（<cwd>/.harness）
    const proj = join(cwd, '.harness')
    expect(ws.project.root).toBe(proj)
    expect(ws.project.plugins).toBe(join(proj, 'plugins'))
    expect(ws.project.skills).toBe(join(proj, 'skills'))
    expect(ws.project.agents).toBe(join(proj, 'agents'))

    // 数据文件
    expect(ws.files.config).toBe(join(dataDir, 'config.json'))
    expect(ws.files.permissions).toBe(join(dataDir, 'permissions.json'))
    expect(ws.files.sessions).toBe(join(dataDir, 'sessions'))
    expect(ws.files.secretKey).toBe(join(dataDir, '.config-key'))
    expect(ws.files.snapshots).toBe(join(dataDir, 'snapshots'))
    expect(ws.files.fileSnapshots).toBe(join(dataDir, 'file-snapshots'))
    expect(ws.files.backups).toBe(join(dataDir, 'backups'))
    expect(ws.files.teams).toBe(join(dataDir, 'teams'))
  })

  it('两级扫描：user 在前、project 在后（后者覆盖）', () => {
    const ws = resolveWorkspace({ cwd: `${TMP}/proj-b`, dataDir: `${TMP}/store-b` })
    expect(ws.loadDirs.plugins).toEqual([ws.user.plugins, ws.project.plugins])
    expect(ws.loadDirs.skills).toEqual([ws.user.skills, ws.project.skills])
    expect(ws.loadDirs.agents).toEqual([ws.user.agents, ws.project.agents])
  })

  it('dataDir 缺省为 ~/.harness（defaultUserDir）', () => {
    const ws = resolveWorkspace({ cwd: `${TMP}/proj-c` })
    expect(ws.dataDir).toBe(defaultUserDir())
    expect(ws.user.root).toBe(defaultUserDir())
  })

  it('默认情况下 dataDir 与项目级目录指向同一根（cwd/.harness 独立）', () => {
    const ws = resolveWorkspace({ cwd: `${TMP}/proj-d`, dataDir: `${TMP}/store-d` })
    // 项目级目录与用户级 dataDir 相互独立（不同根），避免覆盖污染
    expect(ws.project.root).not.toBe(ws.dataDir)
    expect(ws.project.root).toBe(join(ws.cwd, '.harness'))
  })

  it('helpers：level / dataFiles / defaultUserDir', () => {
    const root = `${TMP}/helper`
    const lv = level(root)
    expect(lv).toEqual({
      root,
      plugins: join(root, 'plugins'),
      skills: join(root, 'skills'),
      agents: join(root, 'agents'),
    })
    const files = dataFiles(root)
    expect(files.config).toBe(join(root, 'config.json'))
    expect(files.secretKey).toBe(join(root, '.config-key'))
    expect(defaultUserDir()).toContain('.harness')
  })
})