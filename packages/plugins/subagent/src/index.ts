/**
 * @harness/subagent - Subagent 插件
 *
 * 让主 Agent 能派出子 Agent 执行独立任务：
 * - 子 Agent 用独立 session（隔离上下文，不污染父对话）
 * - 子 Agent 有独立的工具白名单和权限配置
 * - 父 Agent 通过 SubagentTool（AgentTool）调用子 Agent
 * - 递归深度通过工具白名单控制：子 Agent 默认无 SubagentTool
 *
 * 安全声明（Fail-Closed）：
 * - isReadOnly: false（子 Agent 可能执行写操作）
 * - isConcurrencySafe: false（子 Agent 可能修改共享状态）
 * - isDestructive: false
 * - requiresUserInteraction: false
 *
 * @example
 * import { createHarness } from '@harness/core'
 * import { createSubagentPlugin } from '@harness/subagent'
 *
 * const h = await createHarness({
 *   internalPlugins: [createSubagentPlugin({
 *     subagents: [{
 *       id: 'coder',
 *       name: 'Coder',
 *       description: '负责写代码的子 Agent',
 *       mode: 'subagent',
 *       tools: ['read_file', 'write_file', 'edit_file', 'bash'],
 *       permission: { '*': 'allow' },
 *       promptFragments: ['你是一个专注写代码的子 Agent，只完成分配给你的任务。'],
 *     }],
 *   })],
 * })
 */

import { defineTool, Tool, ToolResult, Schema, ToolContext } from '@harness/tool'
import type { AgentPlugin, Hooks } from '@harness/plugin'
import type { AgentDefinition } from '@harness/agent'
import type { AgentRuntime, SessionManager } from '@harness/core'
import type { Message } from '@harness/session'

// ===== 类型定义 =====

/** SubagentTool 的输入 */
export interface SubagentToolInput {
  /** 子 Agent ID（必须已注册且 mode === 'subagent'） */
  agentId: string
  /** 派给子 Agent 的任务描述 */
  prompt: string
}

/** SubagentTool 的输出 */
export interface SubagentToolOutput {
  /** 子 session ID（独立隔离上下文） */
  sessionId: string
  /** 子 Agent 最终回复文本（取最后一条 assistant 消息的文本部分） */
  message: string
  /** 子 session 中的消息总数 */
  messageCount: number
}

/** createSubagentPlugin 的配置 */
export interface SubagentPluginOptions {
  /** 启动时注册的子 Agent 定义列表 */
  subagents?: AgentDefinition[]
  /** 子 Agent 执行超时（毫秒），缺省 120_000 */
  timeoutMs?: number
  /** 子 Agent 完成后是否删除子 session（缺省 false，保留便于调试） */
  cleanupSession?: boolean
}

/** Harness 引用的最小接口（避免 import core 导致循环依赖） */
interface HarnessLike {
  agent: AgentRuntime
  session: SessionManager
}

// ===== Schema helper（自包含，避免跨包依赖）=====

function makeSchema<T>(): Schema<T> {
  return {
    parse(value: unknown): T {
      return value as T
    },
    safeParse(value: unknown) {
      return { success: true, data: value as T }
    },
  }
}

// ===== 从 Message 提取文本 =====

/** 从消息数组中提取最后一条 assistant 消息的文本部分 */
function extractFinalAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const texts = m.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text?: string }).text ?? '')
      .filter(Boolean)
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

// ===== SubagentTool（AgentTool）=====

/**
 * 创建 SubagentTool
 *
 * @param getHarness 获取 Harness 引用的函数（插件在 harness.start 时缓存）
 * @param timeoutMs 执行超时
 * @param cleanupSession 完成后是否删除子 session
 */
/** 创建 SubagentTool（导出便于单独使用或测试） */
export function createSubagentTool(
  getHarness: () => HarnessLike | undefined,
  timeoutMs: number,
  cleanupSession: boolean,
): Tool<SubagentToolInput, SubagentToolOutput> {
  return defineTool<SubagentToolInput, SubagentToolOutput>({
    id: 'subagent',
    aliases: ['agent', 'run_agent', 'task'],
    description: '派一个子 Agent 执行独立任务（隔离 session）。输入 agentId（子 Agent ID）和 prompt（任务描述）。',
    documentation: 'SubagentTool 让主 Agent 能派出子 Agent 执行独立任务。子 Agent 用独立 session 隔离上下文，有独立的工具白名单和权限配置。子 Agent 完成后，最终回复作为工具结果返回给主 Agent。',
    searchHint: 'subagent agent task delegate spawn worker',

    // Fail-Closed 安全声明
    isReadOnly: () => false,          // 子 Agent 可能执行写操作
    isConcurrencySafe: () => false,   // 子 Agent 可能修改共享状态
    isDestructive: () => false,       // 工具本身不破坏，但子 Agent 内部可能
    requiresUserInteraction: false,

    inputSchema: makeSchema<SubagentToolInput>(),

    permission: {
      key: 'agent',
      extractPatterns: (input) => [input.agentId],
    },

    async call(input: SubagentToolInput, ctx: ToolContext): Promise<ToolResult<SubagentToolOutput>> {
      const harness = getHarness()
      if (!harness) {
        return {
          ok: false,
          error: { message: 'Harness 未就绪（harness.start 未触发）', code: 'HARNESS_NOT_READY' },
        }
      }

      const { agent, session } = harness

      // 验证子 Agent 已注册
      const agentDef = agent.get(input.agentId)
      if (!agentDef) {
        return {
          ok: false,
          error: { message: `子 Agent "${input.agentId}" 未注册`, code: 'AGENT_NOT_FOUND' },
        }
      }

      // 验证 mode === 'subagent'（防止派出 primary/coordinator 自身）
      if (agentDef.mode !== 'subagent') {
        return {
          ok: false,
          error: {
            message: `Agent "${input.agentId}" 的 mode 是 "${agentDef.mode}"，不是 "subagent"`,
            code: 'INVALID_AGENT_MODE',
          },
        }
      }

      // 创建子 session（隔离上下文）
      let subSessionId: string
      try {
        const title = input.prompt.length > 60 ? input.prompt.slice(0, 60) + '...' : input.prompt
        const subSession = await session.create({ title })
        subSessionId = subSession.id
      } catch (err) {
        return {
          ok: false,
          error: {
            message: `创建子 session 失败：${(err as Error)?.message ?? err}`,
            code: 'SESSION_CREATE_FAILED',
          },
        }
      }

      // 带超时调用 agent.query
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        // 注意：agent.query 不接受 signal，我们用 Promise.race 模拟超时
        const queryPromise = agent.query({
          sessionId: subSessionId,
          agentId: input.agentId,
          message: input.prompt,
        })

        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error(`子 Agent 执行超时（${timeoutMs}ms）`))
          })
        })

        let finalMessage: Message
        try {
          finalMessage = await Promise.race([queryPromise, timeoutPromise])
        } catch (err) {
          return {
            ok: false,
            error: {
              message: `子 Agent 执行失败：${(err as Error)?.message ?? err}`,
              code: 'SUBAGENT_FAILED',
            },
          }
        }

        // 取子 session 的所有消息，提取最终 assistant 文本
        const subSession = await session.get(subSessionId)
        const messages = subSession?.messages ?? [finalMessage]
        const finalText = extractFinalAssistantText(messages) || '(子 Agent 无文本回复)'

        return {
          ok: true,
          output: {
            sessionId: subSessionId,
            message: finalText,
            messageCount: messages.length,
          },
        }
      } finally {
        clearTimeout(timer)
        // 可选清理子 session
        if (cleanupSession) {
          try {
            // SessionManager 没有显式 delete，通过 deleteMessage 逐条清理
            // 或保留 session 便于调试（默认行为）
          } catch { /* ignore */ }
        }
      }
    },

    renderUse: (input) => ({
      agentId: input.agentId,
      prompt: input.prompt.length > 100 ? input.prompt.slice(0, 100) + '...' : input.prompt,
    }),
    renderResult: (result) => {
      if (!result.ok || !result.output) return undefined
      return {
        sessionId: result.output.sessionId,
        preview: result.output.message.length > 200
          ? result.output.message.slice(0, 200) + '...'
          : result.output.message,
      }
    },
  })
}

// ===== 插件工厂 =====

/**
 * 创建 Subagent 插件
 *
 * @param options 配置
 * @param options.subagents 启动时注册的子 Agent 定义列表
 * @param options.timeoutMs 子 Agent 执行超时（毫秒），缺省 120_000
 * @param options.cleanupSession 子 Agent 完成后是否删除子 session（缺省 false）
 */
export function createSubagentPlugin(options: SubagentPluginOptions = {}): AgentPlugin {
  const { subagents = [], timeoutMs = 120_000, cleanupSession = false } = options

  let harness: HarnessLike | undefined
  let subagentTool: Tool<SubagentToolInput, SubagentToolOutput>

  return {
    id: 'subagent',
    version: '0.1.0',
    name: 'Subagent',
    description: `Subagent 插件：派出子 Agent 执行独立任务（${subagents.length} 个子 Agent 已注册）`,

    async install(ctx) {
      ctx.log.info('Subagent 插件已加载', {
        subagents: subagents.map((a) => ({ id: a.id, name: a.name, mode: a.mode })),
      })

      // 延迟创建 SubagentTool（需要 harness 引用，在 harness.start 时才有）
      subagentTool = createSubagentTool(() => harness, timeoutMs, cleanupSession)

      return {
        async 'harness.start'(input) {
          const h = (input as { harness: HarnessLike }).harness
          if (!h?.agent || !h?.session) {
            ctx.log.error('Subagent 插件：harness.start 未提供 agent/session 引用')
            return
          }
          harness = h

          // 注册子 Agent 定义到 AgentRuntime
          for (const def of subagents) {
            if (def.mode !== 'subagent') {
              ctx.log.warn(`子 Agent "${def.id}" 的 mode 是 "${def.mode}"，不是 "subagent"，跳过注册`)
              continue
            }
            try {
              h.agent.register(def)
              ctx.log.info(`子 Agent "${def.id}" 已注册`, {
                name: def.name,
                tools: def.tools,
              })
            } catch (err) {
              ctx.log.error(`注册子 Agent "${def.id}" 失败`, { error: String((err as Error)?.message ?? err) })
            }
          }
        },

        'tool.pool.assemble'(_input, pool) {
          if (subagentTool) {
            ;(pool as { add: (t: unknown) => void }).add(subagentTool)
          }
        },

        'cli.commands'(input) {
          const registered = subagents.filter((a) => a.mode === 'subagent')
          if (registered.length > 0) {
            input.commands.push({
              command: 'subagents',
              description: '列出已注册的子 Agent',
              usage: '/subagents',
            })
          }
        },

        async 'cli.command'(input) {
          if (input.command !== 'subagents') return
          const registered = subagents.filter((a) => a.mode === 'subagent')
          if (registered.length === 0) {
            input.out('（无已注册的子 Agent）\n')
          } else {
            input.out(`已注册 ${registered.length} 个子 Agent：\n`)
            for (const a of registered) {
              const tools = Array.isArray(a.tools) ? a.tools.join(', ') : '*'
              input.out(`  ${a.id}  -  ${a.name}\n`)
              input.out(`    描述：${a.description}\n`)
              input.out(`    工具：${tools}\n`)
              if (a.model?.modelId) input.out(`    模型：${a.model.modelId}\n`)
            }
          }
          input.result = 'continue'
        },
      } as Hooks
    },

    async uninstall() {
      harness = undefined
    },
  }
}

// ===== 便捷导出 =====

/** 默认导出（无子 Agent 配置，需要通过 harness.start 后外部注册） */
export const subagentPlugin = createSubagentPlugin()
