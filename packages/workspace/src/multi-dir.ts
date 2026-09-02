/**
 * @harness/workspace —— 多级目录加载器（收敛 cli/core 各自重写的「scan + 来源标注 + 覆盖」骨架）
 *
 * 定位：只负责「点击目录 + 来源标注」，不做文件内容解析。
 * 消费方（插件 import / Agent md / Skill SKILL.md / 泛化资源）在各资源模块内解析文件，
 * 覆盖语义（后加载覆盖先加载）由消费方经收集顺序保证：本模块枚举顺序即既有覆盖顺序（user → project）。
 *
 * 一改 cli（loadPluginDirs / 装配 agentDirs/skillDirs）与 core（agentDirs/skillDirs）里
 * `readdir + 来源(user/project) + join(dir, name)` 的手写重复；本模块不 import 任何业务。
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 目录来源标注（两级加载：user 全局 × project 项目，后者覆盖前者） */
export type DirSource = 'user' | 'project'

/** 目录条目：一个待扫描目录 + 其来源 */
export interface DirEntry {
  dir: string
  source: DirSource
}

/** 扫描出的一个文件/目录项（已带来源与绝对路径） */
export interface DirItem {
  /** 来源标注 */
  source: DirSource
  /** 文件名 / 目录名 */
  name: string
  /** 绝对路径（join(dir, name)） */
  full: string
}

/** scan 过滤条件（缺省不过滤，全枚举） */
export interface MultiDirFilter {
  /** 仅保留 name 满足谓词的项 */
  name?: (name: string) => boolean
}

/** 允许 source 可缺省的输入（字符串 → 缺省 source；对象 source 可省） */
export type DirEntryInput = string | { dir: string; source?: DirSource }

/**
 * 归一化目录列表：字符串 → `{ dir, source }`（缺省 source 取 defaultSource，默认 'user'），
 * 供显式构造 DirEntry[]。
 */
export function normalizeDirs(
  dirs: DirEntryInput[],
  defaultSource: DirSource = 'user',
): DirEntry[] {
  return dirs.map((e) => (typeof e === 'string' ? { dir: e, source: defaultSource } : { dir: e.dir, source: e.source ?? defaultSource }))
}

/** workspace.loadDirs 的两级目录对 → 可直接扫描的 DirEntry[] */
export function dirsFromPair(pair: [string, string]): DirEntry[] {
  return [
    { dir: pair[0], source: 'user' },
    { dir: pair[1], source: 'project' },
  ]
}

/**
 * 多级目录加载器：按构造给定的目录顺序（建议 user → project）枚举目录项并标注来源。
 *
 * - 只做「枚举 + 来源」，不解析文件内容、不做覆盖合并（覆盖顺序即枚举顺序）。
 * - 目录不存在 / 读取失败：跳过并继续（与既有 loadPluginDirs 空目录行为一致）。
 * - 使用 `readdirSync({ withFileTypes: true })`，目录项亦被枚举（供 skills 目录式 SKILL.md 等按需消费）。
 */
export class MultiDirLoader {
  constructor(readonly dirs: DirEntry[]) {}

  /** 是否存在待扫描目录 */
  get hasDirs(): boolean {
    return this.dirs.length > 0
  }

  /** 同步枚举全部目录项（按 dirs 顺序展平；缺省 source 已记录） */
  scan(filter?: MultiDirFilter): DirItem[] {
    const out: DirItem[] = []
    for (const { dir, source } of this.dirs) {
      let names: string[] | undefined
      try {
        names = readdirSync(dir, { withFileTypes: true }).map((d) => d.name)
      } catch {
        continue // 目录缺失 / 不可读 → 跳过，不阻塞整体
      }
      for (const name of names) {
        if (filter?.name && !filter.name(name)) continue
        out.push({ source, name, full: join(dir, name) })
      }
    }
    return out
  }

  /**
   * 枚举 + 收集去重：对每项 `parse` 得到值，按 `key` 作 Map 收集，
   * 后扫描的覆盖先扫描的（同 ID/同名覆盖），即 user 在前、project 在后 → project 覆盖 user。
   * `parse` 内的失败可自行 catch 返回 undefined（对应项自动被忽略）以保留容错语义。
   */
  async collect<T>(
    parse: (item: DirItem) => Promise<T | undefined>,
    key: (value: T) => string,
    filter?: MultiDirFilter,
  ): Promise<T[]> {
    const byKey = new Map<string, T>()
    for (const item of this.scan(filter)) {
      const value = await parse(item)
      if (value === undefined) continue
      byKey.set(key(value), value)
    }
    return [...byKey.values()]
  }
}