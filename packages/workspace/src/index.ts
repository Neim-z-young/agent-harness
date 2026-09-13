/**
 * @harness/workspace —— 工作区管理核心库
 *
 * 只负责「定位与解析 + 目录布局」，不含 Provider / 插件装配等业务逻辑。
 * 回答工作区管理的三个问题：数据放哪（dataDir）、从哪加载（两级）、谁覆盖谁（project 覆盖 user）。
 *
 * 使用原则：
 * - 一个工作区 = 一个 cwd + 一个 dataDir。
 * - `cwd` 决定项目级目录（<cwd>/.harness）；`dataDir` 决定用户级全局数据落盘位置（缺省 ~/.harness）。
 * - 两级加载：user（dataDir/…，全局共享）× project（<cwd>/.harness/…，按项目），project 覆盖 user。
 *
 * 本模块仅做路径解析，不读/写任何文件；存储与多级扫描由上层服务（storage 工厂 / MultiDirLoader）实现，
 * 均消费本模块导出的路径。
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export * from './storage'
export * from './compaction-store'
export * from './multi-dir'

/** 单级目录根：plugin / skill / agent 三组可插拔资源目录 */
export interface WorkspaceLevel {
  /** 该级根目录 */
  root: string
  /** 插件目录 */
  plugins: string
  /** 技能目录 */
  skills: string
  /** Agent 目录 */
  agents: string
}

/** dataDir 下的全局数据文件 / 目录路径（仅用户级存在） */
export interface WorkspaceDataFiles {
  /** 全局配置：config.json */
  config: string
  /** 权限规则：permissions.json */
  permissions: string
  /** 会话文件目录：sessions/ */
  sessions: string
  /** 主密钥文件：.config-key（AES-256-GCM，配合 HARNESS_CONFIG_KEY 环境变量） */
  secretKey: string
  /** git 快照仓库根目录：snapshots/{worktree-hash}（对齐 OpenCode data/snapshot） */
  snapshots: string
  /** 文件快照存储根目录：file-snapshots/{worktree-hash}（FileSnapshotService） */
  fileSnapshots: string
  /** 文件快照备份目录：backups/（FileSnapshotService 变更文件全量备份） */
  backups: string
  /** swarm 团队目录：teams/ */
  teams: string
}

/** 工作区整体布局（两级 + 用户级数据文件路径） */
export interface Workspace {
  /** 工作目录（已 resolve 为绝对路径） */
  cwd: string
  /** 用户级根目录（= dataDir，缺省 ~/.harness） */
  dataDir: string
  /** 用户级（dataDir）目录布局 */
  user: WorkspaceLevel
  /** 项目级（<cwd>/.harness）目录布局 */
  project: WorkspaceLevel
  /** dataDir 下全局数据文件 / 目录路径 */
  files: WorkspaceDataFiles
  /**
   * 两级扫描路径对（用于 MultiDirLoader）：user 在前、project 在后，同 ID/同名后者覆盖前者。
   * 以「目录对」形式给出，顺序即加载与覆盖顺序。
   */
  loadDirs: {
    plugins: [string, string]
    skills: [string, string]
    agents: [string, string]
  }
}

/** resolveWorkspace 入参 */
export interface ResolveWorkspaceOptions {
  /** 工作目录；缺省 process.cwd() */
  cwd?: string
  /** 用户级数据根；缺省 ~/.harness */
  dataDir?: string
}

/** 用户级默认根目录：~/.harness */
export function defaultUserDir(): string {
  return join(homedir(), '.harness')
}

/** 由根目录构造单级可插拔资源目录布局 */
export function level(root: string): WorkspaceLevel {
  return {
    root,
    plugins: join(root, 'plugins'),
    skills: join(root, 'skills'),
    agents: join(root, 'agents'),
  }
}

/** 由 dataDir 构造全局数据文件 / 目录路径 */
export function dataFiles(dataDir: string): WorkspaceDataFiles {
  return {
    config: join(dataDir, 'config.json'),
    permissions: join(dataDir, 'permissions.json'),
    sessions: join(dataDir, 'sessions'),
    secretKey: join(dataDir, '.config-key'),
    snapshots: join(dataDir, 'snapshots'),
    fileSnapshots: join(dataDir, 'file-snapshots'),
    backups: join(dataDir, 'backups'),
    teams: join(dataDir, 'teams'),
  }
}

/**
 * 解析工作区：给出 cwd 与 dataDir 后，返回两级目录布局与全局数据文件路径。
 * - `dataDir` 缺省为 ~/.harness；`cwd` 缺省为 process.cwd()，二者均 resolve 为绝对路径。
 * - 项目级目录固定为 `<cwd>/.harness`。
 */
export function resolveWorkspace(opts: ResolveWorkspaceOptions = {}): Workspace {
  const cwd = resolve(opts.cwd ?? process.cwd())
  const dataDir = resolve(opts.dataDir ?? defaultUserDir())
  const user = level(dataDir)
  const project = level(join(cwd, '.harness'))
  return {
    cwd,
    dataDir,
    user,
    project,
    files: dataFiles(dataDir),
    loadDirs: {
      plugins: [user.plugins, project.plugins],
      skills: [user.skills, project.skills],
      agents: [user.agents, project.agents],
    },
  }
}