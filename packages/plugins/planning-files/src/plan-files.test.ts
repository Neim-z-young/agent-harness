import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ACTIVE_PLAN_FILE_NAME,
  ATTEST_FILE_NAME,
  PLAN_DIR_NAME,
  PLAN_FILE_NAMES,
  attestPlan,
  detectProgressRegression,
  displayPlanPath,
  ensurePlanFiles,
  hashPlan,
  isValidPlanSlug,
  listPlans,
  parsePlan,
  planFileStatus,
  planInitialized,
  readActivePlan,
  readAttestation,
  readPlanFiles,
  renderPlanList,
  renderPlanSummary,
  replaceGoal,
  resolvePlanDir,
  resolvePlanRoot,
  setActivePlan,
  shortHash,
  unfinishedPhases,
  verifyAttestation,
  writePlanFile,
} from './plan-files'

/** 1/2 完成的计划（进度快照测试的基准） */
const PLAN_ONE_OF_TWO = '## Phase 1: a\n- [x] x\n- [ ] y\n'

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
    // ⚠️ 两侧都先 `resolve`：实现把 cwd 解析成**平台绝对路径**（Windows 上 `/tmp/x` ⇒ `D:\tmp\x`）
    // ⇒ 期望值必须走同一套解析（同 workspace.test.ts 的说明）。派生一律 `join`。
    const root = resolve('/tmp/x')
    expect(resolvePlanDir(root)).toBe(join(root, '.planning'))
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
    const root = resolve('/tmp/x')
    expect(displayPlanPath(root, join(root, '.planning', 'task_plan.md'))).toBe(join('.planning', 'task_plan.md'))
    const outside = resolve('/other/a.md')
    expect(displayPlanPath(root, outside)).toBe(outside)
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

describe('多计划：listPlans（阶段四）', () => {
  it('目录不存在 ⇒ 空列表（不抛）', () => {
    expect(listPlans(resolvePlanDir(tmp()))).toEqual([])
  })

  it('空 .planning/ ⇒ 空列表（不要把"没有任何计划"渲染成一条 0/0）', () => {
    const dir = resolvePlanDir(tmp())
    mkdirSync(dir, { recursive: true })
    expect(listPlans(dir)).toEqual([])
  })

  it('默认计划已初始化 ⇒ 一条「（默认）」且 active', () => {
    const dir = resolvePlanDir(tmp())
    writePlanFile(dir, 'task_plan.md', PLAN_ONE_OF_TWO)
    const list = listPlans(dir)
    expect(list).toHaveLength(1)
    expect(list[0]!.label).toBe('（默认）')
    expect(list[0]!.slug).toBeUndefined()
    expect(list[0]!.active).toBe(true)
    expect(list[0]!.initialized).toBe(true)
    expect(list[0]!.doneCount).toBe(1)
    expect(list[0]!.totalCount).toBe(2)
  })

  it('子目录计划被列出；.active_plan 指向它时只有它 active', () => {
    const dir = resolvePlanDir(tmp())
    writePlanFile(dir, 'task_plan.md', PLAN_ONE_OF_TWO)
    writePlanFile(join(dir, 'task-b'), 'task_plan.md', '## Phase 1: b\n- [ ] x\n')
    setActivePlan(dir, 'task-b')
    const list = listPlans(dir)
    expect(list.map((l) => l.label)).toEqual(['（默认）', 'task-b'])
    expect(list[0]!.active).toBe(false)
    expect(list[1]!.active).toBe(true)
    expect(list[1]!.totalCount).toBe(1)
  })

  it('非目录 / 非法 slug 名不进列表；顺序强制确定（根在前、slug 升序）', () => {
    const dir = resolvePlanDir(tmp())
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'not-a-plan.md'), 'x', 'utf8') // 文件，跳过
    mkdirSync(join(dir, 'zeta'), { recursive: true })
    mkdirSync(join(dir, 'alpha'), { recursive: true })
    mkdirSync(join(dir, 'bad slug'), { recursive: true }) // 含空格 ⇒ 非法
    const list = listPlans(dir)
    expect(list.map((l) => l.label)).toEqual(['alpha', 'zeta'])
    expect(list[1]!.initialized).toBe(false)
    expect(list[1]!.doneCount).toBe(0)
  })

  it('renderPlanList：▶ 标活动；空列表给可执行提示', () => {
    expect(renderPlanList([])).toContain('尚无任何计划')
    const dir = resolvePlanDir(tmp())
    writePlanFile(dir, 'task_plan.md', PLAN_ONE_OF_TWO)
    writePlanFile(join(dir, 'task-b'), 'task_plan.md', '## Phase 1: b\n- [x] x\n')
    setActivePlan(dir, 'task-b')
    const rendered = renderPlanList(listPlans(dir))
    expect(rendered).toContain('  （默认）（1/2）')
    expect(rendered).toContain('▶ task-b（1/1）')
  })
})

describe('进度快照与回退检测（阶段四：并行写守卫降级版）', () => {
  it('attest 记下当时的已完成条目数，verdict 带出来', () => {
    const root = resolvePlanDir(tmp())
    writePlanFile(root, 'task_plan.md', PLAN_ONE_OF_TWO)
    const rec = attestPlan(root)
    expect(rec.checked).toBe(1)
    expect(readAttestation(root)?.checked).toBe(1)
    expect(verifyAttestation(root).approvedChecked).toBe(1)
  })

  it('旧记录（没有 checked 字段）读作未知，**不当成**下降了', () => {
    const root = resolvePlanDir(tmp())
    writePlanFile(root, 'task_plan.md', PLAN_ONE_OF_TWO)
    writeFileSync(join(root, ATTEST_FILE_NAME), JSON.stringify({ hash: hashPlan(root), at: 0 }), 'utf8')
    const v = verifyAttestation(root)
    expect(v.status).toBe('ok')
    expect(v.approvedChecked).toBeUndefined()
    expect(detectProgressRegression(parsePlan(PLAN_ONE_OF_TWO), v)).toBeUndefined()
  })

  it('完成数下降 ⇒ 报回退（含少掉的条数）；持平 / 上升 / 未认证 ⇒ 不报', () => {
    const root = resolvePlanDir(tmp())
    writePlanFile(root, 'task_plan.md', PLAN_ONE_OF_TWO)
    const v = verifyAttestation(root) // 未认证
    expect(detectProgressRegression(parsePlan(PLAN_ONE_OF_TWO), v)).toBeUndefined()

    attestPlan(root) // 快照 = 1
    expect(detectProgressRegression(parsePlan(PLAN_ONE_OF_TWO), verifyAttestation(root))).toBeUndefined()

    const reg = detectProgressRegression(parsePlan('## Phase 1: a\n- [ ] x\n- [ ] y\n'), verifyAttestation(root))
    expect(reg).toEqual({ approvedChecked: 1, currentChecked: 0, dropped: 1 })

    const up = detectProgressRegression(parsePlan('## Phase 1: a\n- [x] x\n- [x] y\n'), verifyAttestation(root))
    expect(up).toBeUndefined()
  })

  it('unfinishedPhases：只算"有条目且没做完"的阶段（空阶段不算）', () => {
    const parsed = parsePlan(
      ['## Phase 1: done', '- [x] a', '', '## Phase 2: doing', '- [ ] b', '', '## Phase 3: empty', ''].join('\n'),
    )
    expect(unfinishedPhases(parsed).map((p) => p.index)).toEqual([2])
  })
})
