/**
 * 端到端（**全离线、零 token、确定性**）：用 mock provider 驱动**真实引擎 + 真实 acp-context 插件**，
 * 验证前缀缓存归因（`cacheMissReason` / `prefixChangedKind` / `cacheDropTokens` / `idleMs` /
 * `calibration`）能按预期分类。
 *
 * 回答的是「缓存归因能不能不靠真机验」。**能** —— 因为判据是两层、且两层都可本地编排：
 *   - **前缀差异**：来自真实 prompt 的内容指纹 ⇒ 由探针插件按轮次制造
 *     「系统区变化 / 中段改写 / 删消息」三种形态；
 *   - **命中量台阶**：来自 provider 上报的 `cacheRead` ⇒ 由 `MockChatProvider.usageSequence` 逐轮给。
 *
 * 反过来说清**mock 验不了什么**（别把这条测试当全验）：
 *   1. 系数**取值**（`tokenCalibrationScale = 1.33`）只能真机测——mock 的 input 是编的；
 *   2. provider 的**真实缓存行为**（什么时候真的过期/逐出、前缀多长才命中）无法模拟；
 *   3. 历史会话那两处断崖的真实成因，仍需要下一次真机复现来点名。
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createHarness,
  defineTool,
  type AgentDefinition,
  type Message,
} from '@harness/core'
import { MockChatProvider } from '@harness/provider-mock'
import { createAcpContextPlugin } from '@harness/acp-context'
import type { AgentPlugin, Hooks } from '@harness/plugin'

/** 一轮要制造的 prompt 形态 */
type ProbeRound = 'plain' | 'system-change' | 'mutate-mid' | 'delete-mid'

/**
 * 探针插件：按轮次改动待发消息，精确复现四种 prompt 形态。
 *
 * 为什么用 `core.prompt.system.transform` 而不是直接改 system 消息：
 * 系统区由 core 在 `_buildStepMessages` 里拼装（记忆/roster/skill 都从这里注入），
 * 从这里改最贴近"某个插件在中途改了系统区"这一真实成因。
 */
function attributionProbe(plan: ProbeRound[]): AgentPlugin {
  let step = 0
  /** 从第几轮起往系统区塞标记；0 = 本 plan 不需要该系统区变化 */
  const sysFrom = plan.indexOf('system-change') + 1
  const mutateFrom = plan.indexOf('mutate-mid') + 1
  const deleteFrom = plan.indexOf('delete-mid') + 1
  /** 被改写的那条消息的**原始** id（用它做稳定锚点，避免每轮改到不同消息） */
  let origUserId: string | undefined
  /** 已删除消息的 id 集合 */
  const deletedIds = new Set<string>()

  return {
    id: 'attribution-probe',
    version: '0.0.0',
    name: 'attribution-probe',
    description: '测试探针：按轮次制造系统区变化 / 中段改写 / 删消息',
    async install() {
      return {
        'core.prompt.system.transform': (_input, parts) => {
          step++
          // 只在指定轮次**引入一次**标记，此后保持不变 —— 否则后续轮次也会被染成 system-changed
          if (sysFrom > 0 && step >= sysFrom) parts.push('PROBE_SYSTEM_MARK_V2')
        },
        'core.session.preModel': (_input, rawMessages) => {
          const list = rawMessages as Message[]

          // ⚠️ 关键：改动必须**持久化**。core 每轮都从会话本体重建 messages，
          // 只改一轮的话下一轮就被还原 ⇒ 会看到"前缀又变了一次"的假象。
          // 所以这里每轮都重新施加同样的改动（幂等）。

          // ① 改写：锚定同一条消息（首条 user），每轮都改回同一个最终形态
          if (mutateFrom > 0 && step >= mutateFrom) {
            if (origUserId === undefined) origUserId = list.find((m) => m.role === 'user')?.id
            if (origUserId !== undefined) {
              const i = list.findIndex((m) => m.id === origUserId || m.id === `${origUserId}_mut`)
              if (i >= 0) {
                // 换 id + 换正文：ACP 的「逐 id 对齐」因此失效 ⇒ 真的全量重渲染 ⇒ 前缀字节改变
                list.splice(i, 1, {
                  ...list[i]!,
                  id: `${origUserId}_mut`,
                  parts: [{ type: 'text', text: '被就地改写的中段历史消息' }],
                })
              }
            }
          }

          // ② 删除：先施加已记录的删除，再在触发轮登记本次要删的 id
          const applyDeletes = (): void => {
            for (let i = list.length - 1; i >= 0; i--) if (deletedIds.has(list[i]!.id)) list.splice(i, 1)
          }
          if (deletedIds.size > 0) applyDeletes()
          if (deleteFrom > 0 && step === deleteFrom) {
            // 删**一批**（≥ 本轮新增的 2 条），让 prompt 净变短 —— 只删 1 条而历史每轮 +2
            // 的话整体仍在变长，那就不是"截断"而是"改写"，分类上本就该是 mutated。
            // 保留最后一条（本轮请求的 user），不要把它删掉。
            const rest = list.filter((m) => m.role !== 'system')
            const n = Math.max(0, Math.min(6, rest.length - 1))
            for (const m of rest.slice(0, n)) deletedIds.add(m.id)
            applyDeletes()
          }
        },
      } as Hooks
    },
  }
}

const agent: AgentDefinition = {
  id: 'default',
  name: 'AttributionAgent',
  description: '缓存归因端到端测试',
  mode: 'primary',
  tools: [],
  permission: { '*': 'allow' },
  promptFragments: ['你是归因测试 Agent。'],
}

const tinyTool = defineTool({
  id: 'probe_tool',
  description: '占位工具（让工具载荷非空，以覆盖 localInputEstimate 的工具那一项）',
  inputSchema: {
    parse: (v: unknown) => v as { x?: string },
    safeParse: (v: unknown) => ({ success: true as const, data: v as { x?: string } }),
  },
  isReadOnly: () => true,
  async call() {
    return { ok: true as const, output: 'ok' }
  },
})

function rowsOf(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.kind === 'providerCache')
}

/**
 * 位置对照探针：把**逐轮都会变**的同一份内容，注到 system 区或尾部动态区。
 *
 * 这是"插件插标记"问题的对照实验 —— 两边注入的内容、轮次、变化幅度完全相同，
 * **唯一变量是位置**，因此结论没有别的解释空间。
 */
function placementProbe(placement: 'system' | 'tail'): AgentPlugin {
  let round = 0
  return {
    id: `placement-probe-${placement}`,
    version: '0.0.0',
    name: `placement-probe-${placement}`,
    description: '按轮次把逐轮变化的内容注到指定位置',
    async install() {
      return {
        // 轮次计数挂在 system 侧（它先执行且每 query 必被触发），保证两条路径取到同一个 round
        'core.prompt.system.transform': (_input, parts) => {
          round++
          if (placement === 'system') parts.push(`PROBE_VOLATILE_R${round}`)
        },
        'core.prompt.dynamic.transform': (_input, parts) => {
          if (placement === 'tail') parts.push(`PROBE_VOLATILE_R${round}`)
        },
      } as Hooks
    },
  }
}

/** 取该次 provider 调用里**第一条 system 消息**的正文 = core 的前缀区 */
function systemTextOf(m: MockChatProvider, i: number): string {
  const msgs = m.calls[i]!.messages
  const sys = msgs.find((x) => x.role === 'system')
  return (sys?.parts ?? [])
    .map((p) => (p as { type?: string; text?: string }).text ?? '')
    .join('\n')
}

describe('端到端：易变内容放 system vs 放尾部（"插件插标记"的对照实验）', () => {
  async function runPlacement(placement: 'system' | 'tail') {
    const dir = mkdtempSync(join(tmpdir(), `place-${placement}-`))
    const telPath = join(dir, 's.telemetry.jsonl')
    const mock = new MockChatProvider({
      defaultResponse: '好的。',
      // system 档：R3 要制造一次真实降幅，归因为 system-changed 才有意义
      // tail 档：命中量只涨不跌 ⇒ 只要前缀没被改坏，reason 就必须是 none
      usageSequence:
        placement === 'system'
          ? [
              { input: 5000, output: 5, cacheRead: 4000 },
              { input: 6000, output: 5, cacheRead: 5000 },
              { input: 6000, output: 5, cacheRead: 4000 },
            ]
          : [
              { input: 5000, output: 5, cacheRead: 4000 },
              { input: 6000, output: 5, cacheRead: 5800 },
              { input: 6000, output: 5, cacheRead: 5900 },
            ],
    })
    const h = await createHarness({
      cwd: join(dir, 'work'),
      agents: [agent],
      defaultAgentId: 'default',
      chatProvider: mock,
      tokenCalibration: 'auto',
      internalPlugins: [
        placementProbe(placement),
        createAcpContextPlugin({ modelContextLimit: 20000, telemetryPathBuilder: () => telPath }),
      ],
    })
    h.tools.register(tinyTool)
    try {
      const sess = await h.session.create()
      for (let i = 1; i <= 3; i++) {
        for await (const _ of h.session.promptStream(sess.id, `第 ${i} 轮`)) { /* drain */ }
      }
      await new Promise((r) => setTimeout(r, 700)) // 等 writer 的 500ms debounce
      // 顺带取回**持久层**的消息：用于验证尾部动态块是"发送时拼接"，不落库
      const stored = (await h.session.get(sess.id))?.messages ?? []
      return { rows: rowsOf(telPath), mock, dir, stored }
    } finally {
      await h.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('放在 system 区：前缀整段失效，且归因**点名**到具体段（第 2 段）', async () => {
    const { rows, mock } = await runPlacement('system')

    // 内容确实每轮不同（否则下面的断言就是空跑）
    expect(systemTextOf(mock, 0)).toContain('PROBE_VOLATILE_R1')
    expect(systemTextOf(mock, 1)).toContain('PROBE_VOLATILE_R2')
    expect(systemTextOf(mock, 2)).toContain('PROBE_VOLATILE_R3')
    expect(systemTextOf(mock, 0)).not.toBe(systemTextOf(mock, 1))

    expect(rows.map((r) => r.cacheMissReason)).toEqual(['first-request', 'none', 'system-changed'])
    // 系统区在位置 0 ⇒ 它一变，稳定前缀长度归零（= 后面的整段历史都要重算）
    expect(rows[2]!.prefixStableMessages).toBe(0)
    // 点名：agent.promptFragments 是第 1 段，探针推的是第 2 段（index 1）
    expect(rows[2]!.systemChangedParts).toEqual([1])
    // 归因说的是"相对**上一轮**"的变化：R3 的基线是 R2
    const detail = (rows[2]!.systemChangedDetail as string[])[0]!
    expect(detail).toContain('第 2 段变化')
    expect(detail).toContain('PROBE_VOLATILE_R2')
    // 顺带钉住"同长度也会被判出来"：R2→R3 的标记只差一个数字、字符数相同，
    // 只比长度（或只比 message id）的实现会漏掉它 —— 而 provider 按字节命中，这是真失效
    expect(detail).toContain('17 → 17')
    // R1 首轮无基线；R2 相对 R1 虽也变了，但命中量没跌 ⇒ reason 为 none
    expect(rows[0]!.systemChangedParts).toBeNull()
    expect(rows[2]!.cacheDropTokens).toBe(1000)
  })

  it('放在尾部动态区：内容同样每轮变，但前缀**逐字未变** ⇒ reason 恒为 none', async () => {
    const { rows, mock, stored } = await runPlacement('tail')

    // 内容确实每轮不同，而且确实进了请求（放尾部 ≠ 没注入）
    const lastOf = (i: number) => JSON.stringify(mock.calls[i]!.messages.at(-1) ?? {})
    expect(lastOf(0)).toContain('PROBE_VOLATILE_R1')
    expect(lastOf(1)).toContain('PROBE_VOLATILE_R2')
    expect(lastOf(2)).toContain('PROBE_VOLATILE_R3')

    // 而前缀区三份请求**逐字相同** —— 这就是收益的全部来源
    expect(systemTextOf(mock, 0)).toBe(systemTextOf(mock, 1))
    expect(systemTextOf(mock, 1)).toBe(systemTextOf(mock, 2))
    expect(systemTextOf(mock, 0)).not.toContain('PROBE_VOLATILE')

    // 归因侧：没有 system 变化，就不该报 system-changed
    expect(rows.map((r) => r.cacheMissReason)).toEqual(['first-request', 'none', 'none'])
    expect(rows.map((r) => r.systemChangedParts)).toEqual([null, null, null])
    // 前缀完好：稳定前缀长度随历史递增（没有被裁到 0）
    expect(rows[2]!.prefixStableMessages as number).toBeGreaterThan(rows[1]!.prefixStableMessages as number)

    // 且**不落库**：尾部块是发送时拼接的临时内容，每轮重算 —— 落库就会变成下一轮的
    // 中段脏数据（既污染历史，又制造本可避免的前缀改写）
    const storedText = JSON.stringify(stored)
    expect(storedText).not.toContain('PROBE_VOLATILE')
    expect(storedText).not.toContain('host-context')
  })
})

describe('端到端：前缀缓存归因（mock provider + 真实引擎）', () => {
  it('四种 prompt 形态各自归到正确的 cacheMissReason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attrib-e2e-'))
    const telPath = join(dir, 's.telemetry.jsonl')
    const workDir = join(dir, 'work')
    // 6 轮：R2 纯追加不塌陷；R3 系统区变；R4 中段改写；R5 删中段；R6 前缀完好但命中量掉
    const plan: ProbeRound[] = ['plain', 'plain', 'system-change', 'mutate-mid', 'delete-mid', 'plain']
    const mock = new MockChatProvider({
      defaultResponse: '好的。',
      // 逐轮 cacheRead：R2 上涨（无降幅），R3 起单调下降 ⇒ 每个"有意思的轮"都有降幅可归因
      usageSequence: [
        { input: 5000, output: 5, cacheRead: 4000 },
        { input: 6000, output: 5, cacheRead: 5800 },
        { input: 6000, output: 5, cacheRead: 5000 },
        { input: 6000, output: 5, cacheRead: 4000 },
        { input: 6000, output: 5, cacheRead: 3000 },
        { input: 6000, output: 5, cacheRead: 2000 },
      ],
    })
    const h = await createHarness({
      cwd: workDir,
      agents: [agent],
      defaultAgentId: 'default',
      chatProvider: mock,
      tokenCalibration: 'auto',
      internalPlugins: [
        // 探针必须排在 acp-context **之前**：它要先改消息，acp-context 才看得到被改后的内容
        attributionProbe(plan),
        createAcpContextPlugin({ modelContextLimit: 20000, telemetryPathBuilder: () => telPath }),
      ],
    })
    h.tools.register(tinyTool)

    try {
      const sess = await h.session.create()
      for (let i = 1; i <= plan.length; i++) {
        for await (const _ of h.session.promptStream(sess.id, `第 ${i} 轮`)) { /* drain */ }
        // 在第 5 与第 6 轮之间留出真实间隔 ⇒ 最后一轮的 idleMs 必须 > 0
        if (i === plan.length - 1) await new Promise((r) => setTimeout(r, 40))
      }

      // writer 有 500ms debounce：等一拍再读（与既有遥测测试同一约定）
      await new Promise((r) => setTimeout(r, 700))
      expect(existsSync(telPath)).toBe(true)

      const rows = rowsOf(telPath)
      expect(rows).toHaveLength(plan.length)

      // —— 归因结论 ——
      expect(rows.map((r) => r.cacheMissReason)).toEqual([
        'first-request',   // R1 首次
        'none',            // R2 纯追加且命中量上涨
        'system-changed',  // R3 系统区被引入标记
        'prefix-mutated',  // R4 中段被就地改写
        'prefix-shrunk',   // R5 中段被删
        'idle-expiry',     // R6 前缀完好（仅追加）但命中量下降
      ])

      // —— 形态与降幅（交叉验证，别只看 reason 一个字段）——
      expect(rows.map((r) => r.prefixChangedKind)).toEqual([
        null, 'appended', 'mutated', 'mutated', 'shrunk', 'appended',
      ])
      expect(rows.map((r) => r.cacheDropTokens)).toEqual([0, 0, 800, 1000, 1000, 1000])
      // 系统区就在 index 0：它一变，稳定前缀长度必须是 0
      expect(rows[2]!.prefixStableMessages).toBe(0)
      expect(rows[1]!.prefixStableMessages).toBeGreaterThan(0)

      // —— idleMs：R1 为 null（无上轮），末轮因真实等待而 > 0 ——
      expect(rows[0]!.idleMs).toBeNull()
      expect(rows[5]!.idleMs as number).toBeGreaterThan(0)

      // —— 口径字段自洽：calibration = provider 输入 ÷ **整包**本地估算 ——
      // 这条同时钉住"分母必须是整包（历史 + system + 工具）、不是历史"这个曾经的错误：
      // 若分母退回 requestTok，这里立刻算不平。
      const scriptedInputs = [5000, 6000, 6000, 6000, 6000, 6000]
      rows.forEach((r, i) => {
        const localFull = (r.requestTok as number) + (r.overheadTok as number)
        expect(r.overheadTok as number).toBeGreaterThan(0) // system + 工具载荷 > 0
        expect(Math.abs((r.calibration as number) - scriptedInputs[i]! / localFull)).toBeLessThan(1e-6)
      })
    } finally {
      await h.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
