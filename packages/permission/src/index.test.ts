import { describe, it, expect } from 'bun:test'
import { matchGlob } from './index'

/**
 * `@harness/permission` 的测试（此前该包**零测试文件** —— 除了让 `bun test` 在该包报
 * "No tests found!" 从而把根 `bun run test` 的退出码恒定为 1 之外，更实际的问题是：
 * `matchGlob` 是**路径级 allow/deny 判定的基础**，判错的方向可能是"该拒的没拒"。
 *
 * 三处消费方（都靠它做决定）：
 * - `core` 的权限规则匹配（allow / deny / ask 的路径级规则）
 * - `skill` 的 `paths` 条件触发（技能按操作的文件命中）
 * - `subagent` 的 agent 白/黑名单规则
 */

describe('matchGlob：结构语义', () => {
  it('精确模式只匹配自身（^...$ 锚定，不做子串匹配）', () => {
    expect(matchGlob('src/main.ts', 'src/main.ts')).toBe(true)
    expect(matchGlob('src/main.ts', 'xsrc/main.ts')).toBe(false)
    expect(matchGlob('src/main.ts', 'src/main.tsx')).toBe(false)
  })

  it('`*` 只匹配单层，不跨 `/`', () => {
    expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/*.ts', 'src/a/b.ts')).toBe(false)
    expect(matchGlob('src/*.ts', 'a.ts')).toBe(false)
  })

  it('`**` 匹配任意层级', () => {
    expect(matchGlob('src/**', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/**', 'src/a/b/c.ts')).toBe(true)
    expect(matchGlob('src/**', 'other/a.ts')).toBe(false)
  })

  it('`?` 匹配单个非 `/` 字符', () => {
    expect(matchGlob('src/?.ts', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/?.ts', 'src/ab.ts')).toBe(false)
    expect(matchGlob('?.ts', 'a/b.ts')).toBe(false)
  })

  it('大小写敏感', () => {
    expect(matchGlob('SRC/*.ts', 'src/a.ts')).toBe(false)
  })

  it('空模式只匹配空串（不意外命中一切）', () => {
    expect(matchGlob('', '')).toBe(true)
    expect(matchGlob('', 'anything')).toBe(false)
  })
})

describe('matchGlob：正则元字符必须被转义（否则权限规则会被意外放大）', () => {
  it('`.` 是字面量，不是任意字符', () => {
    expect(matchGlob('a.b', 'a.b')).toBe(true)
    expect(matchGlob('a.b', 'axb')).toBe(false)
  })

  it('`[]` `()` `+` `{}` `|` `^` `$` `\\` 都按字面量处理', () => {
    expect(matchGlob('file[1].ts', 'file[1].ts')).toBe(true)
    expect(matchGlob('file[1].ts', 'file1.ts')).toBe(false)
    expect(matchGlob('a+b.ts', 'a+b.ts')).toBe(true)
    expect(matchGlob('a+b.ts', 'aab.ts')).toBe(false)
    expect(matchGlob('a(b).ts', 'a(b).ts')).toBe(true)
    expect(matchGlob('a|b.ts', 'a|b.ts')).toBe(true)
    expect(matchGlob('a{2}.ts', 'a{2}.ts')).toBe(true)
    expect(matchGlob('a^b.ts', 'a^b.ts')).toBe(true)
    expect(matchGlob('a$b.ts', 'a$b.ts')).toBe(true)
  })
})

describe('matchGlob：`**/` 必须匹配根级文件（回归）', () => {
  // 修正前 `**/x` 展开成 `.*\/x`，要求**至少一层目录** ⇒ 根级文件全部漏判。
  // 对 allow 规则是"少放行"（恼人），对 deny 规则是"**该拒的没拒**"（不安全方向）。
  it('`**/*.ts` 同时命中根级与深层文件（此前漏掉根级）', () => {
    expect(matchGlob('**/*.ts', 'a.ts')).toBe(true)
    expect(matchGlob('**/*.ts', 'src/deep/a.ts')).toBe(true)
  })

  it('`src/**/*.ts` 命中 `src/a.ts`（一层）与 `src/x/y.ts`（多层）', () => {
    expect(matchGlob('src/**/*.ts', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/**/*.ts', 'src/x/y.ts')).toBe(true)
  })

  it('deny 规则不再漏根级敏感文件（安全方向）', () => {
    expect(matchGlob('**/secrets*', 'secrets.txt')).toBe(true)
    expect(matchGlob('**/secrets*', 'config/secrets.yaml')).toBe(true)
    expect(matchGlob('**/.env*', '.env')).toBe(true)
    expect(matchGlob('**/.env*', 'a/b/.env.local')).toBe(true)
  })

  it('已知差异（刻意保留）：`src/**` 不匹配 `src` 自身', () => {
    // 标准 glob（minimatch）里 `src/**` 也匹配目录本身。要支持得写成 `src/**` → `src(?:/.*)?`，
    // 但那会让 `src/**` 与 `src/**/` 两套写法产生分歧；当前语义"`**` 至少吃掉一层"更好解释。
    expect(matchGlob('src/**', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/**', 'src')).toBe(false)
  })
})
