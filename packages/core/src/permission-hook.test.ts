/**
 * `core.permission.check` 的接线守卫（不 import CLI）。
 *
 * 背景：该 hook 此前**只声明、从未触发** —— `resolvePermission` 只走
 * `engine.check()` →（必要时）`engine.ask()`，从不 trigger。后果是 herdr 插件里
 * "等待用户决策 → 侧栏上报 blocked" 整段逻辑**静默失效**：hook 在、接线不在，
 * 靠注释与类型都守不住（类型只保证名字对，不保证有人调）。
 *
 * 这里把四件事钉成测试：
 * 1. ask 决策（真会弹窗）触发一次，载荷带 toolKey / patterns / input，且 hook 看到 behavior='ask'；
 * 2. hook 在 `engine.ask()` **之前**触发 —— 插件把 behavior 改成 allow 时 ask 一次都不发生
 *    （这是消费方能分辨"真弹窗"与"规则已记住"的前提）；
 * 3. 插件改写的 `updatedInput` 会被采纳（工具真的收到改写后的入参）；
 * 4. 无需询问（check 直接 allow/deny）时同样触发，但 behavior 不是 ask。
 */
import { describe, it, expect } from 'bun:test'
import { createHarness, AgentDefinition, ChatProvider, ChatCompletionOutput, PermissionEngine } from './index'
import { defineTool, Schema, Tool } from './index'
import type { AgentPlugin, Hooks } from './index'

// ===== helpers =====

/** 带权限声明的工具：permission.key = 'write'，patterns 取 input.path */
function makeWriteTool(onCall?: (input: { path: string }) => void): Tool<{ path: string }, { got: string }> {
  const schema: Schema<{ path: string }> = {
    parse: (v) => v as { path: string },
    safeParse: (v) => ({ success: true, data: v as { path: string } }),
  }
  return defineTool({
    id: 'write',
    description: '写入文件（测试用）',
    inputSchema: schema,
    isReadOnly: () => false,
    permission: { key: 'write', extractPatterns: (input) => [input.path] },
    async call(input) {
      onCall?.(input)
      return { ok: true, output: { got: input.path } }
    },
  })
}

/** 记录 ask 次数的权限引擎；check 的返回由参数固定 */
function makeEngine(check: 'allow' | 'deny' | 'ask') {
  const stat = { asks: 0 }
  const engine: PermissionEngine = {
    async check() {
      return { behavior: check }
    },
    async ask() {
      stat.asks += 1
      return { behavior: 'allow' }
    },
    updateRules() {},
    getRules() {
      return {}
    },
  }
  return { engine, stat }
}

function mockToolCallProvider(): ChatProvider {
  return {
    id: 'mock',
    async complete(): Promise<ChatCompletionOutput> {
      return {
        content: '',
        model: 'mock-v1',
        tokenUsage: { input: 1, output: 1 },
        toolCalls: [{ toolUseId: 'tu_1', toolId: 'write', input: { path: '/x/y' } }],
      }
    },
  }
}

const agent: AgentDefinition = {
  id: 'default',
  name: '测试 Agent',
  description: 'permission hook 用',
  mode: 'primary',
  tools: ['*'],
  permission: { '*': 'allow' },
  promptFragments: ['test'],
}

/** 跑一次工具调用，返回插件记录到的 hook 载荷与工具实际入参 */
async function runOnce(opts: {
  check: 'allow' | 'deny' | 'ask'
  hook?: Hooks['core.permission.check']
}) {
  const seen: Array<{ toolKey: string; patterns: string[]; input: unknown; behaviorAtHook: string }> = []
  const called: Array<{ path: string }> = []
  const plugin: AgentPlugin = {
    id: 'p-perm',
    version: '1',
    name: 'Permission Hook',
    async install() {
      return {
        'core.tool.pool.assemble'(_i, pool: any) {
          pool.add(makeWriteTool((input) => called.push(input)))
        },
        'core.permission.check': async (req, decision) => {
          seen.push({
            toolKey: req.toolKey,
            patterns: req.patterns,
            input: req.input,
            behaviorAtHook: decision.behavior,
          })
          await opts.hook?.(req, decision)
        },
      } as Hooks
    },
  }

  const { engine, stat } = makeEngine(opts.check)
  const h = await createHarness({
    chatProvider: mockToolCallProvider(),
    permission: engine,
    agents: [agent],
    internalPlugins: [plugin],
  })
  const sess = await h.session.create()
  // maxSteps: 1 —— mock provider 每次都返回同一个 toolCall，放开会一路跑到 doom-loop 拦截
  const reply = await h.agent.query({ sessionId: sess.id, message: '写文件', maxSteps: 1 })
  await h.stop()

  const toolPart = reply.parts.find((p: any) => p.type === 'tool') as any
  return { seen, called, stat, toolPart }
}

// ===== 用例 =====

describe('core.permission.check 接线（引擎层）', () => {
  it("ask 决策触发一次，载荷是全量请求且 hook 看到 behavior='ask'", async () => {
    const { seen, stat } = await runOnce({ check: 'ask' })
    expect(seen).toHaveLength(1)
    expect(seen[0].toolKey).toBe('write')
    expect(seen[0].patterns).toEqual(['/x/y'])
    expect(seen[0].input).toEqual({ path: '/x/y' })
    // 关键：hook 时刻 behavior 仍可能是 ask（消费方据此分辨"真会弹窗"）
    expect(seen[0].behaviorAtHook).toBe('ask')
    expect(stat.asks).toBe(1)
  })

  it('hook 在 engine.ask() 之前触发：插槽改成 allow 后 ask 一次都不发生', async () => {
    const { seen, stat, called, toolPart } = await runOnce({
      check: 'ask',
      hook: (_req, decision) => {
        decision.behavior = 'allow'
      },
    })
    expect(seen).toHaveLength(1)
    expect(stat.asks).toBe(0)
    expect(called).toEqual([{ path: '/x/y' }])
    expect((toolPart.result as any).got).toBe('/x/y')
  })

  it('插件改写的 updatedInput 会被采纳（工具收到改写后的入参）', async () => {
    const { called } = await runOnce({
      check: 'ask',
      hook: (_req, decision) => {
        decision.behavior = 'allow'
        decision.updatedInput = { path: '/rewritten' }
      },
    })
    expect(called).toEqual([{ path: '/rewritten' }])
  })

  it('无需询问（check=allow）时同样触发，但 behavior 不是 ask', async () => {
    const { seen, stat } = await runOnce({ check: 'allow' })
    expect(seen).toHaveLength(1)
    expect(seen[0].behaviorAtHook).toBe('allow')
    expect(stat.asks).toBe(0)
  })

  it('deny 决策下不触发 ask，hook 仍能观察到 deny', async () => {
    const { seen, stat, toolPart } = await runOnce({ check: 'deny' })
    expect(seen).toHaveLength(1)
    expect(seen[0].behaviorAtHook).toBe('deny')
    expect(stat.asks).toBe(0)
    expect(toolPart.isError).toBe(true)
  })
})
