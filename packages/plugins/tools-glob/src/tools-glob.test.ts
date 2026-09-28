import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  globTool,
  globTools,
  createToolsGlobPlugin,
} from './index'
import type { ToolContext } from '@harness/tool'

let dir: string
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-glob-test-'))
  ctx = {
    cwd: dir,
    sessionId: 's1',
    agentId: 'default',
    messageId: 'm1',
    toolUseId: 'tu1',
    signal: new AbortController().signal,
    variables: {},
    requestPermission: async () => ({ behavior: 'allow' } as any),
  }
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('globTool', () => {
  it('基本通配符匹配 *.ts', async () => {
    writeFileSync(join(dir, 'a.ts'), '')
    writeFileSync(join(dir, 'b.ts'), '')
    writeFileSync(join(dir, 'c.md'), '')
    writeFileSync(join(dir, 'd.tsx'), '')

    const res = await globTool.call!({ pattern: '*.ts' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(2)
    expect(res.output!.entries.map((e) => e.relativePath).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('** 递归深层匹配', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'root.ts'), '')
    writeFileSync(join(dir, 'src', 'index.ts'), '')
    writeFileSync(join(dir, 'src', 'lib', 'util.ts'), '')
    writeFileSync(join(dir, 'README.md'), '')

    const res = await globTool.call!({ pattern: '**/*.ts' } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const rels = res.output!.entries.map((e) => e.relativePath).sort()
    expect(rels).toEqual(['root.ts', 'src/index.ts', 'src/lib/util.ts'])
  })

  it('! 前缀排除模式', async () => {
    writeFileSync(join(dir, 'keep.ts'), '')
    writeFileSync(join(dir, 'skip.test.ts'), '')
    writeFileSync(join(dir, 'main.ts'), '')

    const res = await globTool.call!({ pattern: ['**/*.ts', '!**/*.test.ts'] } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const rels = res.output!.entries.map((e) => e.relativePath).sort()
    expect(rels).toEqual(['keep.ts', 'main.ts'])
  })

  it('exclude 参数便捷字段', async () => {
    writeFileSync(join(dir, 'a.ts'), '')
    writeFileSync(join(dir, 'a.spec.ts'), '')

    const res = await globTool.call!({
      pattern: '*.ts',
      exclude: ['*.spec.ts'],
    } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.entries.map((e) => e.relativePath)).toEqual(['a.ts'])
  })

  it('文件大小过滤', async () => {
    writeFileSync(join(dir, 'small.ts'), 'x'.repeat(100))
    writeFileSync(join(dir, 'big.ts'), 'x'.repeat(2000))

    const res = await globTool.call!({
      pattern: '*.ts',
      minSizeBytes: 1000,
    } as any, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.output!.count).toBe(1)
    expect(res.output!.entries[0].relativePath).toBe('big.ts')

    const res2 = await globTool.call!({
      pattern: '*.ts',
      maxSizeBytes: 500,
    } as any, ctx)
    expect(res2.ok).toBe(true)
    if (!res2.ok) return
    expect(res2.output!.count).toBe(1)
    expect(res2.output!.entries[0].relativePath).toBe('small.ts')
  })

  it('默认忽略隐藏文件 + includeHidden=true 可启用', async () => {
    writeFileSync(join(dir, '.env'), '')
    writeFileSync(join(dir, 'a.ts'), '')

    const r1 = await globTool.call!({ pattern: '*' } as any, ctx)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.output!.entries.map((e) => e.name)).not.toContain('.env')

    const r2 = await globTool.call!({ pattern: '*', includeHidden: true } as any, ctx)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.output!.entries.some((e) => e.name === '.env')).toBe(true)
  })

  it('路径超出 cwd 被拒绝', async () => {
    const res = await globTool.call!({ pattern: '*.ts', path: '/etc' } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('PATH_OUTSIDE_CWD')
  })

  it('非目录路径返回错误', async () => {
    writeFileSync(join(dir, 'a.ts'), '')
    const res = await globTool.call!({ pattern: '*.ts', path: 'a.ts' } as any, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error!.code).toBe('NOT_A_DIR')
  })

  /**
   * 真机教训（会话 `s_1790592617954_axqkk`）：`pattern` 在 schema 里是 required，但内置工具的
   * Step 1 是 no-op ⇒ 运行期收不到任何校验。模型丢参数时旧实现走 `if (!pat) continue`
   * 静默跳过 → `includes` 为空 → 兜底成全匹配 ⇒ 一次扫回 215,562 字符（约 1,937 个文件）。
   * 这三条断言是"拒绝静默降级"的守卫：任何形态的空 pattern 都必须**明确报错**，
   * 让模型走「入参自愈」补参数，而不是拿到一份全仓清单。
   */
  it('pattern 缺失 / 全为空 ⇒ 拒绝退化成全仓遍历（GLOB_PATTERN_MISSING）', async () => {
    writeFileSync(join(dir, 'a.ts'), '')
    writeFileSync(join(dir, 'b.ts'), '')

    const cases: Array<{ label: string; input: unknown }> = [
      { label: '完全缺失', input: {} },
      { label: '空串', input: { pattern: '' } },
      { label: '纯空白', input: { pattern: '   ' } },
      { label: '数组全空', input: { pattern: ['', '  '] } },
      { label: '非法类型', input: { pattern: {} } },
    ]
    for (const c of cases) {
      const res = await globTool.call!(c.input as any, ctx)
      expect(res.ok, c.label).toBe(false)
      if (res.ok) continue
      expect(res.error!.code, c.label).toBe('GLOB_PATTERN_MISSING')
    }
  })

  it('全是排除项时兜底仍可用，但规模被压制（FALLBACK 上限 + 输出字符预算）', async () => {
    // 300 个 .txt + 300 个 .md + 1 个 .keep：够触发 FALLBACK_MAX_RESULTS(200) 与字符预算(20_000) 两道闸
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(dir, 'f' + String(i).padStart(3, '0') + '.txt'), '')
      writeFileSync(join(dir, 'g' + String(i).padStart(3, '0') + '.md'), '')
    }
    writeFileSync(join(dir, 'only.keep'), '')

    // ① 正向 pattern：字符预算生效 —— 命中 300 条但只回传预算内的部分
    const byPattern = await globTool.call!({ pattern: '*.txt' } as any, ctx)
    expect(byPattern.ok).toBe(true)
    if (!byPattern.ok) return
    expect(byPattern.output!.filesScanned).toBe(601)
    expect(byPattern.output!.count).toBeLessThan(300)
    expect(byPattern.output!.count).toBeGreaterThan(0)
    expect(byPattern.output!.truncated).toBe(true)
    // 体积对比真机：旧实现这条会吐回 21 万字符级别
    expect(JSON.stringify(byPattern.output).length).toBeLessThan(40_000)

    // ② 全排除项：兜底成全匹配语义正确（"除这些之外的全部"，此处命中 301）。
    //    两道闸取严：FALLBACK_MAX_RESULTS(200) 与字符预算(20_000) 谁先撞谁生效 ——
    //    本例每条约 150 字符 ⇒ 字符预算先撞（131 条）。断言写成上界契约（≤200 且 < 命中数），
    //    这样无论哪道闸生效都成立；体积本身由上面 ① 的断言直接守着。
    const byExclude = await globTool.call!({ pattern: ['!*.txt'] } as any, ctx)
    expect(byExclude.ok).toBe(true)
    if (!byExclude.ok) return
    expect(byExclude.output!.count).toBeLessThanOrEqual(200)
    expect(byExclude.output!.count).toBeLessThan(301)   // 命中 301 ⇒ 确实被压制
    expect(byExclude.output!.truncated).toBe(true)
  })
})

describe('插件集成', () => {
  it('globTools 导出包含 glob', () => {
    expect(globTools.map((t) => t.id)).toEqual(['glob'])
  })
  it('createToolsGlobPlugin id', () => {
    expect(createToolsGlobPlugin().id).toBe('tools.glob')
  })
})
