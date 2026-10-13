/**
 * 仓库脚本的**跨平台守卫**（2026-10-13）
 *
 * ## 为什么需要（一次真实的 CI 事故）
 * 根 `package.json` 的 `dev` / `build` / `test` / `typecheck` 原来写的是
 * `bun --filter=* run <script>`。这个写法在**开发机（macOS + bash）上完全正常**，
 * 因为 POSIX shell 对**无匹配的 glob 保留原样**（`--filter=*` 逐字传给 bun）。
 *
 * 但它在两类环境里直接报错：
 * - **Windows**：`bun run <script>` 由 **Bun Shell** 执行（不是 bash），Bun Shell 对无匹配的
 *   glob **报错** ⇒ `bun: no matches found: --filter=*` ⇒ 四个脚本**全部起不来**；
 * - **zsh**：同样是"无匹配即报错"的语义 ⇒ 直接在终端里敲 `bun --filter=* run typecheck` 也炸。
 *
 * 后果很具体：CI 的 `windows-latest` job 卡在 `typecheck` 这一步、**测试根本没跑到**
 * —— 而 Windows 恰恰是唯一能给出 PS/CMD 行为证据的平台。
 *
 * ## 判据（双向）
 * 1. 根 `package.json` 与**所有 workspace 包**的 `scripts` 值里，**不得出现未加引号的 `*`**
 *    （去掉单/双引号包裹的片段后再找 `*`）。要匹配全部包请写 `--filter '*'`（带引号）
 *    或 `bun run --workspaces <script>`（无 glob 字符）。
 * 2. **控制组钉子**：断言根 `package.json` 确实还有 `dev` / `build` / `test` / `typecheck`
 *    四个脚本、且都用 `--filter` 做包选择 —— 否则"扫描集合为空"这种退化解也能永远绿
 *    （与 `plugin-shell-requirement.test.ts` 的控制组同一纪律）。
 *
 * ⚠️ 守卫能抓的是"**未加引号的 glob**"这一类；它**不能**证明脚本在 Windows 上真能跑通
 * （那需要真机 / CI）。它挡的是"改一行脚本就把 Windows 整条链路打掉"这种静默回归。
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

interface ScriptFinding {
  file: string
  name: string
  value: string
}

/** 去掉单引号与双引号包裹的片段（引号内的 `*` 不会被 shell 展开，属合法写法） */
function stripQuoted(value: string): string {
  return value.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
}

/** 收集仓库里所有 package.json 的 scripts 路径 */
function allPackageJson(): string[] {
  const out = [join(REPO_ROOT, 'package.json')]
  for (const base of [join(REPO_ROOT, 'packages'), join(REPO_ROOT, 'packages', 'plugins')]) {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      out.push(join(base, entry.name, 'package.json'))
    }
  }
  return out
}

function scriptsOf(file: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, unknown> }
  const scripts = pkg.scripts ?? {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(scripts)) if (typeof v === 'string') out[k] = v
  return out
}

/** 全仓脚本里**未加引号的 `*`** —— shell 展开在 Windows（Bun Shell）与 zsh 上会因无匹配而报错 */
function unquotedGlobScripts(): ScriptFinding[] {
  const hits: ScriptFinding[] = []
  for (const file of allPackageJson()) {
    let scripts: Record<string, string>
    try {
      scripts = scriptsOf(file)
    } catch {
      continue // 极少数包可能没有可解析的 package.json，不因此让守卫红
    }
    for (const [name, value] of Object.entries(scripts)) {
      if (stripQuoted(value).includes('*')) {
        hits.push({ file: file.slice(REPO_ROOT.length + 1), name, value })
      }
    }
  }
  return hits
}

describe('根脚本不得依赖 shell glob 展开', () => {
  it('★全仓 scripts 里没有未加引号的 `*`（Windows 的 Bun Shell 会因无匹配而报错）', () => {
    expect(unquotedGlobScripts()).toEqual([])
  })

  it('★控制组：根有 dev/build/test/typecheck 四个脚本且都用 --filter 选包', () => {
    const root = scriptsOf(join(REPO_ROOT, 'package.json'))
    for (const name of ['dev', 'build', 'test', 'typecheck']) {
      expect(root[name]).toBeTruthy() // 名字还在（防"扫描集合为空"型退化）
      expect(root[name]!).toContain('--filter')
      // 引号必须是单引号或双引号 —— `--filter=*` 那种"贴在一起"的写法没有引号保护
      expect(root[name]!).toMatch(/--filter\s+(['"])\*\1/)
    }
  })

  it('反向自查：守卫能抓到 `--filter=*`（否则它就是空转）', () => {
    // 直接喂给判据函数的等价逻辑：未加引号的写法必须被判为命中
    expect(stripQuoted("bun --filter=* run typecheck").includes('*')).toBe(true)
    // 带引号的合法写法不得命中
    expect(stripQuoted("bun run --filter '*' typecheck").includes('*')).toBe(false)
    expect(stripQuoted('bun run --filter "*" typecheck').includes('*')).toBe(false)
  })
})
