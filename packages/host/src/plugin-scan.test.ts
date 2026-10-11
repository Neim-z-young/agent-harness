/**
 * P1-5：插件代码静态扫描的**纯函数**测试。
 *
 * 装配集成（warn / refuse 两态）在 `load-plugin-dirs.test.ts` —— 分工与
 * `isolation` / `tools-builtin` 那两组一致：这里钉判定，那边钉"装到装配路径上了"。
 */
import { describe, it, expect } from 'bun:test'
import { PLUGIN_CODE_RULES, formatPluginScanFindings, scanPluginCode } from './index'

describe('scanPluginCode（P1-5）', () => {
  it('六类调用各自命中，且给出**行号**（给不出位置的告警等于没报）', () => {
    const src = [
      `import { spawn } from 'node:child_process'`, // 1
      `const x = process.env.SECRET`, // 2
      `export const plugins = []`, // 3
      `eval('1')`, // 4
      `await fetch('https://example.com')`, // 5
      `process.exit(1)`, // 6
    ].join('\n')
    const f = scanPluginCode(src)
    expect(f.map((x) => x.rule)).toEqual(['child-process', 'env', 'eval', 'network', 'process-exit'])
    expect(f.map((x) => x.line)).toEqual([1, 2, 4, 5, 6])
  })

  it('写文件单独一类（含 mkdir/rm/rename，不只 writeFile*）', () => {
    const rules = scanPluginCode(`rmSync('/etc/x')\nmkdir('/tmp/y')`).map((f) => f.rule)
    expect(rules).toEqual(['fs-write', 'fs-write'])
  })

  it('★注释行不算命中（把"文档里写了 spawn"当命中会最快毁掉这类告警的可信度）', () => {
    const src = [
      `// 这个插件不会 spawn 子进程`,
      `/* eval 是危险的，所以我们不用 */`,
      ` * process.env 在这里只是提到`,
    ].join('\n')
    expect(scanPluginCode(src)).toEqual([])
  })

  it('干净代码零命中', () => {
    expect(scanPluginCode(`export const plugins = [{ id: 'a' }]`)).toEqual([])
  })

  it('每条规则都说得清"它动得了什么"（说不出就别进表 == 别产噪声）', () => {
    for (const r of PLUGIN_CODE_RULES) {
      expect(r.label.length).toBeGreaterThan(4)
      expect(r.pattern).toBeInstanceOf(RegExp)
    }
  })

  it('多处命中逐条列出（不合并、不截断）', () => {
    const f = scanPluginCode(`spawn('a')\nspawn('b')\nspawn('c')`)
    expect(f).toHaveLength(3)
    expect(formatPluginScanFindings('/p/x.ts', f)[0]).toBe(`/p/x.ts:1 [child-process] ${PLUGIN_CODE_RULES[0]!.label} —— spawn(`)
  })
})
