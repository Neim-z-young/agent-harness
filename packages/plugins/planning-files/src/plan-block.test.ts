import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PLAN_BLOCK_BEGIN,
  PLAN_BLOCK_END,
  buildPlanBlock,
  planSignature,
  resolveInjectedBlock,
  type PlanInjectMode,
} from './plan-block'
import { attestPlan, ensurePlanFiles, parsePlan, resolvePlanDir, writePlanFile, type AttestationVerdict } from './plan-files'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'plan-block-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const MD = [
  '# 任务计划',
  '',
  '## Goal',
  '',
  '把 A 做成 B',
  '',
  '## Phase 1: 调研',
  '- [x] 取证',
  '- [ ] 写结论',
  '',
  '## Phase 2: 实现',
  '- [ ] 主改动',
].join('\n')

function ok(): AttestationVerdict {
  return { status: 'ok', approved: 'a'.repeat(64), current: 'a'.repeat(64) }
}
function option(mode: PlanInjectMode = 'smart', maxChars?: number): { mode: PlanInjectMode; planPath: string; maxChars?: number } {
  return maxChars === undefined ? { mode, planPath: '.planning/task_plan.md' } : { mode, planPath: '.planning/task_plan.md', maxChars }
}

describe('buildPlanBlock：格式', () => {
  it('smart：目标 / 当前阶段 / 下一步 / 完成度 / 认证，且被 BEGIN-END 包住', () => {
    const text = buildPlanBlock({ parsed: parsePlan(MD), verdict: ok(), options: option() })!
    const lines = text.split('\n')
    expect(lines[0]).toBe(PLAN_BLOCK_BEGIN)
    expect(lines[lines.length - 1]).toBe(PLAN_BLOCK_END)
    expect(text).toContain('计划: .planning/task_plan.md')
    expect(text).toContain('目标: 把 A 做成 B')
    expect(text).toContain('当前阶段: Phase 1: 调研（进行中 1/2）')
    expect(text).toContain('下一步: 写结论')
    expect(text).toContain('完成度: 1/3')
    expect(text).toContain('（已认证）')
  })

  it('smart 不含阶段明细（省 token 的落点）', () => {
    const text = buildPlanBlock({ parsed: parsePlan(MD), verdict: ok(), options: option('smart') })!
    expect(text).not.toContain('阶段明细')
    expect(text).not.toContain('主改动')
  })

  it('full 含阶段明细，且只列未完成项', () => {
    const text = buildPlanBlock({ parsed: parsePlan(MD), verdict: ok(), options: option('full') })!
    expect(text).toContain('阶段明细')
    expect(text).toContain('Phase 2: 实现（0/1）')
    expect(text).toContain('- [ ] 主改动')
    expect(text).not.toContain('- [ ] 取证') // 已完成的不重复列
  })

  it('未认证 ⇒ missing 文案（不是 TAMPERED）', () => {
    const verdict: AttestationVerdict = { status: 'missing', current: 'b'.repeat(64) }
    const text = buildPlanBlock({ parsed: parsePlan(MD), verdict, options: option() })!
    expect(text).toContain('未认证')
    expect(text).not.toContain('TAMPERED')
    expect(text).toContain('目标:')
  })

  it('mismatch ⇒ 只注入告警行，不含计划正文', () => {
    const verdict: AttestationVerdict = { status: 'mismatch', approved: 'a'.repeat(64), current: 'c'.repeat(64) }
    const text = buildPlanBlock({ parsed: parsePlan(MD), verdict, options: option() })!
    expect(text).toContain('[PLAN TAMPERED]')
    expect(text).not.toContain('目标:')
    expect(text).not.toContain('下一步: 写结论')
    expect(text).toContain('/plan-attest')
  })

  it('全部完成 ⇒ 当前阶段行变为"无（全部完成）"', () => {
    const parsed = parsePlan('## Phase 1: x\n- [x] a\n')
    const text = buildPlanBlock({ parsed, verdict: ok(), options: option() })!
    expect(text).toContain('当前阶段: 无（全部完成 1/1）')
    expect(text).not.toContain('下一步:')
  })

  it('无条目 ⇒ 完成度行明示"尚未填写"，不假装 100%', () => {
    const parsed = parsePlan('# T\n\n## Goal\n\n做点事\n')
    const text = buildPlanBlock({ parsed, verdict: ok(), options: option() })!
    expect(text).toContain('完成度: 0/0（task_plan.md 尚未填写条目）')
  })

  it('超长目标被截断（不把整段糊进上下文）', () => {
    const long = '很长的目标'.repeat(60)
    const parsed = parsePlan(`## Goal\n\n${long}\n\n## Phase 1: a\n- [ ] x\n`)
    const text = buildPlanBlock({ parsed, verdict: ok(), options: option() })!
    const goalLine = text.split('\n').find((l) => l.startsWith('目标: '))!
    expect(goalLine.length).toBeLessThanOrEqual('目标: '.length + 201)
    expect(goalLine.endsWith('…')).toBe(true)
  })

  it('maxChars 极小 ⇒ 降级到最小块；小到放不下 ⇒ 返回 undefined（不注入半截）', () => {
    const parsed = parsePlan(MD)
    const minimal = buildPlanBlock({ parsed, verdict: ok(), options: option('smart', 120) })!
    expect(minimal).toContain(PLAN_BLOCK_BEGIN)
    expect(minimal).not.toContain('目标: ')
    expect(minimal).toContain('当前阶段:')
    expect(buildPlanBlock({ parsed, verdict: ok(), options: option('smart', 20) })).toBeUndefined()
  })

  it('full 超预算时退回 smart 形态（不返回半截明细）', () => {
    const text = buildPlanBlock({ parsed: parsePlan(MD), verdict: ok(), options: option('full', 160) })!
    expect(text).toContain(PLAN_BLOCK_BEGIN)
    expect(text).not.toContain('阶段明细')
  })
})

describe('planSignature / resolveInjectedBlock：逐字稳定（D8）', () => {
  it('签名随文件变化而变化', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    const s1 = planSignature(root)
    writePlanFile(root, 'task_plan.md', '# 改过\n')
    expect(planSignature(root)).not.toBe(s1)
  })

  it('签名稳定：同样的文件状态连取两次一致', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    expect(planSignature(root)).toBe(planSignature(root))
  })

  it('mtime 变化（内容同尺寸）也会改签名 —— 漏检窗口只有"同毫秒同尺寸"', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    const before = planSignature(root)
    const p = join(root, 'findings.md')
    const future = new Date(Date.now() + 5000)
    utimesSync(p, future, future)
    expect(planSignature(root)).not.toBe(before)
  })

  it('签名不变 ⇒ 复用上轮文本且 reused=true（不重新组装）', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    const cache = {}
    let builds = 0
    const build = (o: Parameters<typeof buildPlanBlock>[0]['options']): string | undefined => {
      builds++
      return buildPlanBlock({ parsed: parsePlan(MD), verdict: ok(), options: o })
    }
    const first = resolveInjectedBlock(cache, root, option(), build)
    const second = resolveInjectedBlock(cache, root, option(), build)
    expect(builds).toBe(1)
    expect(second.reused).toBe(true)
    expect(second.text).toBe(first.text)
  })

  it('文件变化 ⇒ 重新组装且文本更新', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    const cache = {}
    const build = (o: Parameters<typeof buildPlanBlock>[0]['options']): string | undefined =>
      buildPlanBlock({ parsed: parsePlan(MD), verdict: ok(), options: o })
    const first = resolveInjectedBlock(cache, root, option(), build)
    writePlanFile(root, 'progress.md', '# 新日志\n- 走了一步\n')
    const second = resolveInjectedBlock(cache, root, option(), build)
    expect(second.reused).toBe(false)
    expect(second.text).toBe(first.text) // 计划本体没变 ⇒ 文本本来就该一样
  })

  it('attest 变化（只是新增 .attest.json）→ 重启后仍能给出 ok 块', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    writePlanFile(root, 'task_plan.md', MD)
    attestPlan(root)
    const built = buildPlanBlock({ parsed: parsePlan(MD), verdict: ok(), options: option() })!
    expect(built).toContain('（已认证）')
  })

  it('build 返回 undefined ⇒ 缓存里不留陈旧块（下一轮不会复用上上轮文本）', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    const cache = { sig: 'stale', block: '陈旧文本' }
    let mode: 'ok' | 'none' = 'ok'
    const build = (o: Parameters<typeof buildPlanBlock>[0]['options']): string | undefined =>
      mode === 'none' ? undefined : buildPlanBlock({ parsed: parsePlan(MD), verdict: ok(), options: o })
    expect(resolveInjectedBlock(cache, root, option(), build).text).toBeDefined()
    mode = 'none'
    writePlanFile(root, 'task_plan.md', '# 触发签名变化\n')
    const r = resolveInjectedBlock(cache, root, option(), build)
    expect(r.text).toBeUndefined()
    expect(cache.block).toBeUndefined()
  })
})
