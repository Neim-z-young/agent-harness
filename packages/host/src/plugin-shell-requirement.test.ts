/**
 * 插件包的跨平台约定守卫（P3-4）
 *
 * ## 为什么要有这个守卫
 * `bash` / `bash_ro` 这类工具**必须有 POSIX shell**才能给完整语义（P1-2 之后，无 bash 时它们会
 * 退到 PowerShell / CMD 的只读集，覆盖弱于 bash）。这个事实以前只存在于**人的记忆**里 ——
 * 于是"新插件包用了 shell、却没人知道它在无 bash 的平台上会残"这种事会反复发生，
 * 而**发现它的人只能是 Windows 用户**（开发机是 macOS，永远看不到）。
 *
 * ## 约定
 * `packages/plugins/<name>/package.json` 里声明：
 * ```json
 * "harness": { "shellRequirement": "posix" }
 * ```
 * 缺省（不写）＝ `'none'` —— 即"本包不依赖 POSIX shell 语义"。
 *
 * ## 判据（双向，两个方向都要红）
 * 1. **用了却没声明**：源码（非测试、非注释行）里出现 `getShell(` / `resolveShell(` ⇒ 必须声明 `'posix'`。
 *    这条防的是"新包悄悄依赖 shell"。
 * 2. **声明了却没用**：声明 `'posix'` 但源码里找不到 shell 调用 ⇒ 报。这条防的是**声明腐烂**
 *    （包改成不依赖 shell 了、声明还留着，于是后来看声明的人被误导）。
 *
 * ⚠️ 判据是**文本扫描**（"用了 shell"这件事静态可判），所以刻意：
 * - 跳过 `*.test.ts`（测试里出现这些名字是常态）；
 * - 跳过以 `*` / `//` / `/*` 开头的行（注释里提到函数名不算使用 —— `shell-quoting.ts` 的注释
 *   就提到过 `resolveShell`，实测会误命中）。
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const PLUGINS_DIR = join(REPO_ROOT, 'packages', 'plugins')

/** 插件包目录（只取含 package.json 的一级子目录） */
function pluginDirs(): string[] {
  return readdirSync(PLUGINS_DIR)
    .map((n) => join(PLUGINS_DIR, n))
    .filter((d) => {
      try {
        return statSync(join(d, 'package.json')).isFile()
      } catch {
        return false
      }
    })
}

/** 递归收集 `.ts` 源码（跳过测试与 dist / node_modules） */
function sources(dir: string, out: string[] = []): string[] {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of names) {
    if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (n.endsWith('.ts') && !n.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const SHELL_CALL = /\b(?:getShell|resolveShell)\s*\(/

/** 该包是否**真的**调用 shell 解析（跳过注释行） */
function usesShellResolving(pkgDir: string): boolean {
  for (const f of sources(join(pkgDir, 'src'))) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim()
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue
      if (SHELL_CALL.test(line)) return true
    }
  }
  return false
}

/** 读取 package.json 的 `harness.shellRequirement`（缺省 `'none'`） */
function declaredRequirement(pkgDir: string): string {
  const raw = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    harness?: { shellRequirement?: string }
  }
  return raw.harness?.shellRequirement ?? 'none'
}

describe('P3-4 插件包的 shell 依赖声明（双向守卫）', () => {
  it('★用了 shell 解析却**没声明** ⇒ 红（新包悄悄依赖 POSIX shell 的防线）', () => {
    const offenders: string[] = []
    for (const d of pluginDirs()) {
      if (usesShellResolving(d) && declaredRequirement(d) !== 'posix') {
        offenders.push(`${d.slice(REPO_ROOT.length + 1)}（源码调用了 getShell/resolveShell）`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('★声明了 `posix` 却**没用** ⇒ 红（防声明腐烂，别让后来看声明的人被误导）', () => {
    const stale: string[] = []
    for (const d of pluginDirs()) {
      if (declaredRequirement(d) === 'posix' && !usesShellResolving(d)) {
        stale.push(d.slice(REPO_ROOT.length + 1))
      }
    }
    expect(stale).toEqual([])
  })

  it('取值只能是 `posix` / `none`（写错值等于没声明）', () => {
    const bad: string[] = []
    for (const d of pluginDirs()) {
      const v = declaredRequirement(d)
      if (v !== 'posix' && v !== 'none') bad.push(`${d.slice(REPO_ROOT.length + 1)}: ${v}`)
    }
    expect(bad).toEqual([])
  })

  it('控制组：`@harness/tools-builtin` 确实声明了 `posix`（否则上面两条断言是空转）', () => {
    // 没有这条的话，"两个方向都为空"这种退化解也能全绿 —— 钉子在这里。
    expect(declaredRequirement(join(PLUGINS_DIR, 'tools-builtin'))).toBe('posix')
    expect(usesShellResolving(join(PLUGINS_DIR, 'tools-builtin'))).toBe(true)
  })
})
