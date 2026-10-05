import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACTIVE_PLAN_FILE_NAME,
  ATTEST_FILE_NAME,
  PLAN_DIR_NAME,
  PLAN_FILE_NAMES,
  attestPlan,
  displayPlanPath,
  ensurePlanFiles,
  hashPlan,
  isValidPlanSlug,
  parsePlan,
  planFileStatus,
  planInitialized,
  readActivePlan,
  readAttestation,
  readPlanFiles,
  renderPlanSummary,
  replaceGoal,
  resolvePlanDir,
  resolvePlanRoot,
  setActivePlan,
  shortHash,
  verifyAttestation,
  writePlanFile,
} from './plan-files'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'plan-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('parsePlan：Phase + 复选框', () => {
  const md = [
    '# 任务计划',
    '',
    '## Goal',
    '',
    '把 X 做成 Y（可判定）',
    '',
    '## Phase 1: 调研',
    '',
    '- [x] 收集证据',
    '- [ ] 写结论',
    '',
    '## Phase 2: 实现',
    '',
    '- [ ] 主改动',
    '- [ ] 单测',
    '',
  ].join('\n')

  it('阶段、条目、完成度', () => {
    const p = parsePlan(md)
    expect(p.goal).toBe('把 X 做成 Y（可判定）')
    expect(p.phases.map((x) => x.index)).toEqual([1, 2])
    expect(p.phases[0]!.title).toBe('调研')
    expect(p.phases[0]!.doneCount).toBe(1)
    expect(p.phases[0]!.totalCount).toBe(2)
    expect(p.doneCount).toBe(1)
    expect(p.totalCount).toBe(4)
    expect(p.complete).toBe(false)
  })

  it('activePhase = 第一个还有未完成项的阶段；nextStep = 它里面第一条未完成', () => {
    const p = parsePlan(md)
    expect(p.activePhase?.index).toBe(1)
    expect(p.nextStep).toBe('写结论')
  })

  it('全完成 ⇒ complete 且无 activePhase', () => {
    const p = parsePlan('## Phase 1: x\n\n- [x] a\n- [X] b\n')
    expect(p.complete).toBe(true)
    expect(p.activePhase).toBeUndefined()
    expect(p.nextStep).toBeUndefined()
  })

  it('无条目 ⇒ 不算完成（complete=false），避免"空计划=已完成"', () => {
    const p = parsePlan('## Goal\n\n做点什么\n')
    expect(p.totalCount).toBe(0)
    expect(p.complete).toBe(false)
  })

  it('Goal 缺失时退化为首条非空非标题行', () => {
    const p = parsePlan('# T\n\n就是这句话\n\n## Phase 1: a\n- [ ] x\n')
    expect(p.goal).toBe('就是这句话')
  })

  it('Phase 之前的复选框归入 index 0，不丢数据', () => {
    const p = parsePlan('- [ ] 前置条目\n\n## Phase 1: a\n- [ ] x\n')
    expect(p.phases[0]!.index).toBe(0)
    expect(p.phases[0]!.items[0]!.text).toBe('前置条目')
  })

  it('行号可指位（1 起）', () => {
    const p = parsePlan('## Phase 1: a\n- [ ] first\n- [x] second\n')
    expect(p.phases[0]!.items.map((i) => i.line)).toEqual([2, 3])
  })

  it('其它标题（非 Phase）不产生新阶段，其下条目归入最近的 Phase（不丢、不重排）', () => {
    const p = parsePlan('## Phase 1: a\n- [ ] x\n\n## 备注\n\n- [ ] y\n')
    expect(p.phases).toHaveLength(1)
    expect(p.phases[0]!.items.map((i) => i.text)).toEqual(['x', 'y'])
  })

  it('Phase 之前的非 Phase 标题下条目归入 index 0（不排到 Phase 之后）', () => {
    const p = parsePlan('## 准备\n\n- [ ] pre\n\n## Phase 1: a\n- [ ] x\n')
    expect(p.phases.map((x) => x.index)).toEqual([0, 1])
    expect(p.phases[0]!.items[0]!.text).toBe('pre')
  })
})

describe('resolvePlanDir / slug 校验 / .active_plan', () => {
  it('目录 = cwd/.planning', () => {
    expect(resolvePlanDir('/tmp/x')).toBe('/tmp/x/.planning')
  })

  it('slug 校验：拒绝穿越与分隔符', () => {
    expect(isValidPlanSlug('2026-10-05-foo')).toBe(true)
    expect(isValidPlanSlug('..')).toBe(false)
    expect(isValidPlanSlug('a/b')).toBe(false)
    expect(isValidPlanSlug('a\\b')).toBe(false)
    expect(isValidPlanSlug('')).toBe(false)
  })

  it('setActivePlan / readActivePlan / resolvePlanRoot', () => {
    const d = tmp()
    const planDir = resolvePlanDir(d)
    expect(resolvePlanRoot(planDir)).toBe(planDir)
    setActivePlan(planDir, 'task-a')
    expect(readActivePlan(planDir)).toBe('task-a')
    expect(resolvePlanRoot(planDir)).toBe(join(planDir, 'task-a'))
    setActivePlan(planDir, '')
    expect(readActivePlan(planDir)).toBeUndefined()
    expect(resolvePlanRoot(planDir)).toBe(planDir)
  })

  it('非法 slug 写指针时抛错（不静默）', () => {
    const d = tmp()
    expect(() => setActivePlan(resolvePlanDir(d), '../evil')).toThrow(/非法计划名/)
  })

  it('指针文件内容是穿越路径时读作"无指针"', () => {
    const d = tmp()
    const planDir = resolvePlanDir(d)
    mkdirSync(planDir, { recursive: true })
    writeFileSync(join(planDir, ACTIVE_PLAN_FILE_NAME), '../../etc\n', 'utf8')
    expect(readActivePlan(planDir)).toBeUndefined()
    expect(resolvePlanRoot(planDir)).toBe(planDir)
  })
})

describe('ensurePlanFiles：幂等', () => {
  it('首次创建三文件，内容 = 模板', () => {
    const root = resolvePlanDir(tmp())
    const r = ensurePlanFiles(root)
    expect(r.created).toEqual([...PLAN_FILE_NAMES])
    expect(r.existed).toEqual([])
    expect(readPlanFiles(root)['task_plan.md']).toContain('## Goal')
    expect(planInitialized(root)).toBe(true)
  })

  it('二次调用：全部 existed，且不改动内容（绝不覆盖）', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    writePlanFile(root, 'task_plan.md', '# 被我改过\n')
    const r = ensurePlanFiles(root)
    expect(r.created).toEqual([])
    expect(r.existed).toEqual([...PLAN_FILE_NAMES])
    expect(readFileSync(join(root, 'task_plan.md'), 'utf8')).toBe('# 被我改过\n')
  })

  it('force: true 才覆盖', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    writePlanFile(root, 'task_plan.md', '# 改过\n')
    const r = ensurePlanFiles(root, { force: true })
    expect(r.created).toContain('task_plan.md')
    expect(readFileSync(join(root, 'task_plan.md'), 'utf8')).toContain('## Goal')
  })

  it('readPlanFiles 对缺失文件返回空串（不抛）', () => {
    const root = resolvePlanDir(tmp())
    const files = readPlanFiles(root)
    expect(files['task_plan.md']).toBe('')
    expect(Object.keys(files)).toEqual([...PLAN_FILE_NAMES])
  })

  it('planFileStatus 报告存在性 / 大小 / mtime', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    const st = planFileStatus(root)
    expect(st.map((s) => s.name)).toEqual([...PLAN_FILE_NAMES])
    expect(st.every((s) => s.exists && s.bytes > 0 && s.mtimeMs > 0)).toBe(true)
  })

  it('原子写不留临时文件', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    attestPlan(root)
    const shell = planFileStatus(root).map((s) => s.name)
    expect(shell).toEqual([...PLAN_FILE_NAMES])
    expect(readFileSync(join(root, 'task_plan.md'), 'utf8')).not.toBe('')
  })
})

describe('attestation：approved hash 锁', () => {
  it('未认证 ⇒ missing（不当作篡改）', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    expect(verifyAttestation(root).status).toBe('missing')
  })

  it('认证后未改动 ⇒ ok', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    const rec = attestPlan(root, 1234)
    expect(rec.hash).toBe(hashPlan(root))
    expect(rec.at).toBe(1234)
    expect(readAttestation(root)?.hash).toBe(rec.hash)
    expect(verifyAttestation(root).status).toBe('ok')
  })

  it('认证后改动 ⇒ mismatch（并在 verdict 里同时给出两侧哈希）', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    const rec = attestPlan(root)
    writePlanFile(root, 'task_plan.md', '# 被外部改过\n')
    const v = verifyAttestation(root)
    expect(v.status).toBe('mismatch')
    expect(v.approved).toBe(rec.hash)
    expect(v.current).not.toBe(rec.hash)
  })

  it('只是加了 findings/progress ⇒ 不影响认证（只锁 task_plan.md）', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    attestPlan(root)
    writePlanFile(root, 'findings.md', '# 笔记\n')
    expect(verifyAttestation(root).status).toBe('ok')
  })

  it('认证文件损坏 ⇒ 读作未认证（missing）', () => {
    const root = resolvePlanDir(tmp())
    ensurePlanFiles(root)
    writeFileSync(join(root, ATTEST_FILE_NAME), '{ not json', 'utf8')
    expect(readAttestation(root)).toBeUndefined()
    expect(verifyAttestation(root).status).toBe('missing')
  })
})

describe('展示工具', () => {
  it('shortHash 截断 + 前缀', () => {
    expect(shortHash('abcdef0123456789')).toBe('sha256:abcdef01…')
  })

  it('displayPlanPath：根下给相对路径，根外原样', () => {
    expect(displayPlanPath('/tmp/x', '/tmp/x/.planning/task_plan.md')).toBe('.planning/task_plan.md')
    expect(displayPlanPath('/tmp/x', '/other/a.md')).toBe('/other/a.md')
  })

  it('renderPlanSummary 列出阶段与完成度', () => {
    const p = parsePlan('## Phase 1: 调研\n- [x] a\n- [ ] b\n')
    const s = renderPlanSummary(p)
    expect(s).toContain('完成度：1/2')
    expect(s).toContain('Phase 1: 调研（1/2）')
    expect(s).toContain('下一步：b')
  })

  it('renderPlanSummary 对空计划给出可执行提示（不是空白）', () => {
    const s = renderPlanSummary(parsePlan('# 只有标题\n'))
    expect(s).toContain('还没有任何')
  })

  it('renderPlanSummary 带出目标（人读摘要有 goal，注入块才有 Goal 原文）', () => {
    const s = renderPlanSummary(parsePlan('## Goal\n\n把 X 做成 Y\n\n## Phase 1: a\n- [ ] b\n'))
    expect(s.split('\n')[0]).toBe('目标：把 X 做成 Y')
  })

  it('replaceGoal：替换已有 Goal 段首行 / 无该段时插入新段', () => {
    const md = '# T\n\n## Goal\n\n旧目标\n\n## Phase 1: a\n- [ ] b\n'
    const replaced = replaceGoal(md, '新目标')
    expect(replaced).toContain('新目标')
    expect(replaced).not.toContain('旧目标')
    expect(replaced).toContain('- [ ] b') // 其它内容一字不动

    const inserted = replaceGoal('# T\n\n## Phase 1: a\n- [ ] b\n', '插入的目标')
    expect(inserted).toContain('## Goal')
    expect(inserted).toContain('插入的目标')
    expect(inserted.indexOf('## Goal')).toBeLessThan(inserted.indexOf('## Phase 1'))
  })

  it('replaceGoal：Goal 段为空（只有标题）时也能写入', () => {
    const md = '# T\n\n## Goal\n\n## Phase 1: a\n- [ ] b\n'
    const s = replaceGoal(md, '目标乙')
    expect(s).toContain('目标乙')
    expect(s).toContain('- [ ] b')
  })

  it('PLAN_DIR_NAME 是 .planning', () => {
    expect(PLAN_DIR_NAME).toBe('.planning')
  })
})
