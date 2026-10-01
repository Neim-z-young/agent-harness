/**
 * 仓库布局守卫：`adapters/` 必须保持**隔离**。
 *
 * 为什么需要守卫（而不是靠"大家都知道"）：`adapters/vscode` 带 `@types/vscode`
 * 与 webview 构建链，一旦被 workspace 收编就会污染主包的类型面与依赖树；
 * 而 root `tsconfig.include` 一旦扩到 `adapters/**`，`bun run typecheck` 会去
 * 检查一个没有 `vscode` 模块解析能力的配置。两件事都是"改一行配置就静默中招"。
 *
 * 隔离是**天然成立**的（workspaces 只含 packages 下的一层，tsconfig include 只含
 * packages 下各包的 src）—— 本文件的作用是把"天然"变成"被断言"。
 *
 * 注：注释里刻意不写 `packages/*` 后紧跟斜杠的写法 —— 那个字符序列会提前闭合块注释。
 */

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '../../..')

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO, rel), 'utf8')) as Record<string, unknown>
}

/** tsconfig 是带注释的 JSON，这里只取需要的两个字段做文本断言 */
function rootTsconfigText(): string {
  return readFileSync(join(REPO, 'tsconfig.json'), 'utf8')
}

describe('adapters/ 隔离守卫', () => {
  it('root package.json 的 workspaces 不含 adapters', () => {
    const ws = readJson('package.json')['workspaces']
    expect(Array.isArray(ws)).toBe(true)
    for (const pattern of ws as string[]) {
      expect(pattern.includes('adapters')).toBe(false)
    }
  })

  it('root tsconfig 的 include 不含 adapters', () => {
    const raw = rootTsconfigText()
    const m = /"include"\s*:\s*\[([^\]]*)\]/.exec(raw)
    expect(m).not.toBeNull()
    expect(m![1]).not.toContain('adapters')
  })

  it('adapters/vscode 不依赖任何 @harness/* —— 它是纯协议客户端', () => {
    const pkg = readJson('adapters/vscode/package.json')
    for (const field of ['dependencies', 'devDependencies'] as const) {
      const deps = pkg[field]
      if (!deps || typeof deps !== 'object') continue
      for (const name of Object.keys(deps as Record<string, string>)) {
        expect(name.startsWith('@harness/')).toBe(false)
      }
    }
  })

  it('adapters/vscode 的源码不 import @harness/*（跨包依赖只能走协议）', () => {
    // 源码树很小，直接递归读；命中即失败
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'out') continue
          walk(p)
        } else if (entry.name.endsWith('.ts')) {
          const src = readFileSync(p, 'utf8')
          if (/from\s+['"]@harness\//.test(src) || /import\(['"]@harness\//.test(src)) {
            offenders.push(p)
          }
        }
      }
    }
    walk(join(REPO, 'adapters/vscode/src'))
    expect(offenders).toEqual([])
  })

  it('扩展声明的 VSCode 引擎下限不低于 1.138（Chat Participant 稳定 API 的起点）', () => {
    const pkg = readJson('adapters/vscode/package.json')
    const engines = pkg['engines'] as Record<string, string> | undefined
    expect(engines?.['vscode']).toBeTruthy()
    const majorMinor = /(\d+)\.(\d+)/.exec(engines!['vscode']!)
    expect(majorMinor).not.toBeNull()
    const [major, minor] = [Number(majorMinor![1]), Number(majorMinor![2])]
    expect(major > 1 || (major === 1 && minor >= 138)).toBe(true)
  })
})
