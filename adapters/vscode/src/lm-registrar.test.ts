/**
 * `lm-registrar.ts`（LM 工具注册台账）纯单测 —— 注入 `list` / `register` / `log`，
 * 不起 sidecar、不碰 `vscode`。
 *
 * 钉的是**次序**与**失败面**：取清单失败不能把旧的清掉、单个注册失败不能拖垮整池、
 * 全量替换要把旧的撤干净（否则留下"已从注册表消失但还注册着"的僵尸工具）。
 */
import { describe, expect, it } from 'bun:test'
import { ToolRegistrar, type DisposableLike } from './lm-registrar'
import type { LmToolSpec } from './lmtools'

/** 一个假 `lm.registerTool`：记账注册过的名字与撤销次数 */
function makeRegister(log: string[], onRegister?: (spec: LmToolSpec) => void) {
  const live = new Set<string>()
  const state = { disposed: 0 }
  const register = (lmName: string, spec: LmToolSpec): DisposableLike => {
    onRegister?.(spec)
    log.push(`+${lmName}`)
    live.add(lmName)
    return {
      dispose() {
        log.push(`-${lmName}`)
        state.disposed += 1
        live.delete(lmName)
      },
    }
  }
  return { register, live, state }
}

const tool = (name: string): Record<string, unknown> => ({
  name,
  description: `${name} 说明`,
  inputSchema: { type: 'object', properties: {} },
  readOnly: false,
  requiresConfirmation: true,
})

describe('ToolRegistrar：全量刷新', () => {
  it('取清单 → 注册；返回计数正确', async () => {
    const log: string[] = []
    const { register, live } = makeRegister(log)
    const r = new ToolRegistrar({ list: async () => ({ tools: [tool('read_file'), tool('bash')] }), register })

    const res = await r.refresh()
    expect(res).toEqual({ registered: 2, skipped: [], listed: 2, undeclared: [] })
    expect(r.names).toEqual(['harness_bash', 'harness_read_file'])
    expect([...live].sort()).toEqual(['harness_bash', 'harness_read_file'])
  })

  it('二次刷新**先撤旧的再装新的**（不留僵尸工具）', async () => {
    const log: string[] = []
    const { register, live } = makeRegister(log)
    let list: unknown = { tools: [tool('a_tool'), tool('b_tool')] }
    const r = new ToolRegistrar({ list: async () => list, register })

    await r.refresh()
    log.length = 0
    list = { tools: [tool('b_tool')] }
    await r.refresh()

    // 撤销全部两个旧的，再装一个新的；结束态只剩 b（a 已从注册表消失 ⇒ 也必须撤销）
    expect(log.filter((l) => l.startsWith('-')).sort()).toEqual(['-harness_a_tool', '-harness_b_tool'])
    expect(log.filter((l) => l.startsWith('+'))).toEqual(['+harness_b_tool'])
    expect([...live]).toEqual(['harness_b_tool'])
    expect(r.names).toEqual(['harness_b_tool'])
  })

  it('**取清单抛错 ⇒ 原样抛出，且完全不动已有注册**（静默清空是最坏结果）', async () => {
    const log: string[] = []
    const { register, live, state } = makeRegister(log)
    let boom = false
    const r = new ToolRegistrar({
      list: async () => {
        if (boom) throw new Error('sidecar 掉了')
        return { tools: [tool('a_tool')] }
      },
      register,
    })

    await r.refresh()
    boom = true
    await expect(r.refresh()).rejects.toThrow('sidecar 掉了')
    expect([...live]).toEqual(['harness_a_tool'])
    expect(state.disposed).toBe(0)
    expect(r.names).toEqual(['harness_a_tool'])
  })

  it('单个注册失败 ⇒ 不中断整批，且失败**记进 skipped**', async () => {
    const log: string[] = []
    const { register } = makeRegister(log, (spec) => {
      if (spec.harnessName === 'bad_name') throw new Error('工具名非法')
    })
    const r = new ToolRegistrar({ list: async () => ({ tools: [tool('bad_name'), tool('good_tool')] }), register })

    const res = await r.refresh()
    expect(res.registered).toBe(1)
    expect(res.skipped).toHaveLength(1)
    expect(res.skipped[0]).toContain('harness_bad_name')
    expect(res.skipped[0]).toContain('工具名非法')
    expect(r.names).toEqual(['harness_good_tool'])
  })

  it('解析层丢掉的条目与注册层失败**合并报出**', async () => {
    const { register } = makeRegister([])
    const r = new ToolRegistrar({
      list: async () => ({ tools: [tool('ok_tool'), { description: '没名字' }] }),
      register,
    })
    const res = await r.refresh()
    expect(res.listed).toBe(2)
    expect(res.registered).toBe(1)
    expect(res.skipped).toEqual(['（缺 name）'])
  })

  it('空清单 ⇒ 撤掉旧的、不留任何注册（工具池变空是**结果**，不是失败）', async () => {
    const { register, live } = makeRegister([])
    let list: unknown = { tools: [tool('a_tool')] }
    const r = new ToolRegistrar({ list: async () => list, register })
    await r.refresh()
    list = { tools: [] }
    const res = await r.refresh()
    expect(res).toEqual({ registered: 0, skipped: [], listed: 0, undeclared: [] })
    expect(live.size).toBe(0)
  })

  it('清单非空但一条都没解析出来 ⇒ 打一条显眼的警示（不能像"空清单"那样静默）', async () => {
    const lines: string[] = []
    const { register } = makeRegister([])
    const r = new ToolRegistrar({
      list: async () => ({ tools: [{ name: 42 }, null] }),
      register,
      log: (m) => lines.push(m),
    })
    await r.refresh()
    expect(lines.some((l) => l.includes('⚠️') && l.includes('全部解析失败'))).toBe(true)
  })

  it('空清单不发警示（那是正常状态）', async () => {
    const lines: string[] = []
    const { register } = makeRegister([])
    const r = new ToolRegistrar({ list: async () => ({ tools: [] }), register, log: (m) => lines.push(m) })
    await r.refresh()
    expect(lines.some((l) => l.includes('⚠️'))).toBe(false)
  })

  it('撤旧时 dispose 抛错不影响装新的（只多一个僵尸，不该连累新的一批）', async () => {
    const { register } = makeRegister([])
    let n = 0
    const flaky = (lmName: string, spec: LmToolSpec): DisposableLike => {
      const d = register(lmName, spec)
      n += 1
      return n === 1 ? { dispose: () => { throw new Error('撤不掉') } } : d
    }
    let list: unknown = { tools: [tool('a_tool')] }
    const r = new ToolRegistrar({ list: async () => list, register: flaky })
    await r.refresh()
    list = { tools: [tool('b_tool')] }
    const res = await r.refresh()
    expect(res.registered).toBe(1)
    expect(r.names).toEqual(['harness_b_tool'])
  })

  it('dispose() 撤掉全部并清空状态（重复调用安全）', async () => {
    const { register, live } = makeRegister([])
    const r = new ToolRegistrar({ list: async () => ({ tools: [tool('a_tool'), tool('b_tool')] }), register })
    await r.refresh()
    r.dispose()
    expect(live.size).toBe(0)
    expect(r.names).toEqual([])
    expect(() => r.dispose()).not.toThrow()
  })
})

/**
 * 第 4 条纪律（真机实测）：`lm.registerTool` 只接受在 `contributes.languageModelTools` 里
 * **声明过**的名字，而拒绝是**同步 fire-and-forget**（不回到扩展宿主）⇒ 必须在注册侧设界。
 *
 * 这一组钉的是"界设在注册**之前**"：未声明的**连 `register` 都不该调** —— 调了就会在主进程
 * 刷 error，而我们的台账还会把它记成成功（真机 22 条，"注册 32/32" 是谎报）。
 */
describe('ToolRegistrar：贡献点声明界', () => {
  /** 工具池：2 个默认装配里的 + 1 个只在真实环境里有的（optIn 插件 / 个人 MCP 的形态） */
  const pool = ['read_file', 'bash', 'task_list']
  const all = { tools: pool.map(tool) }

  it('只注册声明过的；未声明的**不调用 register**，且**不算失败**（进 undeclared 而非 skipped）', async () => {
    const log: string[] = []
    const { register, live } = makeRegister(log)
    const r = new ToolRegistrar({
      list: async () => all,
      register,
      declared: () => new Set(['harness_bash', 'harness_read_file']),
    })

    const res = await r.refresh()
    expect(res.registered).toBe(2)
    expect(res.skipped).toEqual([])
    expect(res.undeclared).toEqual(['harness_task_list'])
    expect(log.filter((l) => l.startsWith('+'))).toEqual(['+harness_bash', '+harness_read_file'])
    expect([...live].sort()).toEqual(['harness_bash', 'harness_read_file'])
  })

  it('不注入 declared ⇒ 老行为逐位不变（全部尝试注册）', async () => {
    const { register, live } = makeRegister([])
    const r = new ToolRegistrar({ list: async () => all, register })

    const res = await r.refresh()
    expect(res).toEqual({ registered: 3, skipped: [], listed: 3, undeclared: [] })
    expect(live.size).toBe(3)
  })

  it('声明集合变小 ⇒ 原先注册的**被撤掉**（声明界也走全量替换，不留僵尸）', async () => {
    const log: string[] = []
    const { register, live } = makeRegister(log)
    let declared = new Set(['harness_bash', 'harness_read_file'])
    const r = new ToolRegistrar({ list: async () => all, register, declared: () => declared })

    await r.refresh()
    log.length = 0
    declared = new Set(['harness_bash'])
    const res = await r.refresh()

    expect(res.registered).toBe(1)
    expect(res.undeclared).toEqual(['harness_read_file', 'harness_task_list'])
    expect(log.filter((l) => l.startsWith('-')).sort()).toEqual(['-harness_bash', '-harness_read_file'])
    expect([...live]).toEqual(['harness_bash'])
  })

  it('声明集合为空 ⇒ 一个都不注册，且打**显眼**警示（清单丢了 / 生成没跑）', async () => {
    const lines: string[] = []
    const { register, live } = makeRegister([])
    const r = new ToolRegistrar({
      list: async () => all,
      register,
      declared: () => new Set(),
      log: (m) => lines.push(m),
    })

    const res = await r.refresh()
    expect(res.registered).toBe(0)
    expect(res.undeclared).toHaveLength(3)
    expect(live.size).toBe(0)
    expect(lines.some((l) => l.includes('⚠️') && l.includes('languageModelTools'))).toBe(true)
  })

  it('未声明的走**一行汇总**、不走「跳过：」逐条（否则真失败会被常态条目淹掉）', async () => {
    const lines: string[] = []
    const { register } = makeRegister([])
    const r = new ToolRegistrar({
      list: async () => all,
      register,
      declared: () => new Set(['harness_bash']),
      log: (m) => lines.push(m),
    })

    await r.refresh()
    expect(lines.some((l) => l.includes('跳过：'))).toBe(false)
    expect(
      lines.some((l) => l.includes('未声明') && l.includes('harness_read_file') && l.includes('harness_task_list')),
    ).toBe(true)
    expect(lines.some((l) => l.includes('注册 1/3 个工具（另 2 个未在贡献点声明，已跳过）'))).toBe(true)
  })
})
