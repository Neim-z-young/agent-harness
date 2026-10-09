/**
 * τ³-bench runner —— 每任务一个 HarnessHost 实例（进程内 SDK 驱动，方案定稿：
 * 直接引用功能包，不走 spawn CLI —— `harness run` 仅支持单轮一次性执行，无法承载
 * user simulator 多轮外层循环）
 *
 * 半双工循环（对齐官方 Orchestrator.step 的 AGENT→USER / USER→AGENT 路径）：
 * 1. 固定初始问候（官方 orchestrator.py 默认消息）
 * 2. user simulator 响应 agent 文本 → 客户消息（或终止 token）
 * 3. host.send() 驱动 agent 主循环（工具调用在 harness 引擎内完成，不进外层）
 * 4. 每轮从 session.messages 提取新增 ToolCallPart（judge 回放的原料）
 * 5. 终止：STOP/TRANSFER/OUT-OF-SCOPE、maxTurns、agent 空回复（官方 communication error）
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessHost } from '@harness/host'
import type { AgentDefinition, ChatProvider } from '@harness/core'
import type { Message, Session } from '@harness/session'
import { judgeTask } from './judge'
import { createRetailPlugin } from './retail/tools'
import { loadRetailPolicy } from './data'
import { UserSimulator } from './user-sim'
import type { RetailDB, TauTask, TaskRunResult, TerminationReason, ToolInvocation, TurnRecord } from './types'

/** 官方 orchestrator.py 的固定初始问候 */
export const INITIAL_GREETING = 'Hi! How can I help you today?'

/** 官方 agent system prompt 模板（llm_agent.py AGENT_INSTRUCTION + SYSTEM_PROMPT） */
export function buildRetailAgentPrompt(): string {
  const agentInstruction = [
    'You are a customer service agent that helps the user according to the <policy> provided below.',
    'In each turn you can either:',
    '- Send a message to the user.',
    '- Make a tool call.',
    'You cannot do both at the same time.',
    '',
    'Try to be helpful and always follow the policy. Always make sure you generate valid JSON only.',
  ].join('\n')
  return [
    '<instructions>',
    agentInstruction,
    '</instructions>',
    '<policy>',
    loadRetailPolicy(),
    '</policy>',
  ].join('\n')
}

/** bench 的 retail agent 定义：systemPrompt 完整覆盖（纯客服 prompt，不带 harness 默认提示词） */
export function createRetailAgentDef(maxSteps: number): AgentDefinition {
  return {
    id: 'tau-retail-agent',
    name: 'Retail Agent',
    description: 'tau-bench retail domain customer service agent',
    mode: 'primary',
    tools: [
      'calculate',
      'cancel_pending_order',
      'exchange_delivered_order_items',
      'find_user_id_by_name_zip',
      'find_user_id_by_email',
      'get_order_details',
      'get_product_details',
      'get_item_details',
      'get_user_details',
      'list_all_product_types',
      'modify_pending_order_address',
      'modify_pending_order_items',
      'modify_pending_order_payment',
      'modify_user_address',
      'return_delivered_order_items',
      'transfer_to_human_agents',
    ],
    permission: { '*': 'allow' },
    systemPrompt: buildRetailAgentPrompt(),
    maxSteps,
  }
}

// ===== user simulator 的 provider 构造（独立模型调用，不经 host） =====

export interface ProviderOpts {
  apiKey?: string
  baseUrl?: string
  apiPath?: string
}

/**
 * 按 type 构造 user simulator 的 ChatProvider（直接实例化，不走插件装置 ——
 * 插件的 provider getter 惰性创建，install() 前访问会抛错；user sim 独立调用
 * 不需要 harness 的注册机制）。
 * openai 系覆盖所有 OpenAI 兼容端点；mock 供测试。
 */
export async function buildUserSimProvider(
  type: string,
  opts: ProviderOpts,
  model: string,
): Promise<ChatProvider> {
  if (type === 'mock') {
    const { MockChatProvider } = await import('@harness/provider-mock')
    return new MockChatProvider({ defaultResponse: '(mock)' })
  }
  if (type === 'anthropic') {
    const { AnthropicChatProvider } = await import('@harness/provider-anthropic')
    return new AnthropicChatProvider({ ...opts, defaultModel: model })
  }
  // openai / glm / qwen / deepseek 等 OpenAI 兼容系
  const { OpenAIChatProvider } = await import('@harness/provider-openai')
  return new OpenAIChatProvider({ ...opts, defaultModel: model })
}

// ===== 轨迹提取 =====

function assistantText(msg: Message | undefined): string {
  if (!msg) return ''
  return msg.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('')
    .trim()
}

/** 从 session.messages 里收集第 fromIndex（不含）之后新增的工具调用 */
function extractNewInvocations(sess: Session, fromIndex: number): { invocations: ToolInvocation[]; nextIndex: number } {
  const invocations: ToolInvocation[] = []
  let i = fromIndex
  for (; i < sess.messages.length; i++) {
    const m = sess.messages[i]!
    if (m.role !== 'assistant') continue
    for (const part of m.parts) {
      if (part.type === 'tool') {
        const tc = part as { toolId: string; input: unknown; isError?: boolean }
        invocations.push({
          toolId: tc.toolId,
          input: (tc.input as Record<string, unknown>) ?? {},
          isError: tc.isError === true,
        })
      }
    }
  }
  return { invocations, nextIndex: i }
}

// ===== 单任务运行 =====

export interface TaskRunOptions {
  task: TauTask
  sampleIndex: number
  /** 会话与配置的持久化根目录（每任务独立子目录，支持并发互不干扰） */
  runRootDir: string
  /** agent 模型（ProviderConfig 形式，走 HarnessHost providers） */
  agentProvider: {
    id: string
    type: string
    model: string
    opts: ProviderOpts
  }
  /** user simulator 模型 */
  userProvider: {
    type: string
    model: string
    opts: ProviderOpts
  }
  maxTurns: number
  maxSteps: number
  /** 任务级初始 DB（调用方持有；runner 内深拷贝演进，判分后返回最终态供调试） */
  initialDb: RetailDB
}

export async function runTask(opts: TaskRunOptions): Promise<TaskRunResult> {
  const { task, sampleIndex } = opts
  const startedAt = Date.now()
  const runDir = join(opts.runRootDir, `task-${task.id}-s${sampleIndex}`)
  await mkdir(runDir, { recursive: true })

  // 任务级 DB 深拷贝：agent 会话期间所有域工具操作这一份
  const taskDb = structuredClone(opts.initialDb)

  const host = new HarnessHost({
    cwd: runDir,
    dataDir: runDir,
    agentId: 'tau-retail-agent',
    provider: opts.agentProvider.id,
    model: opts.agentProvider.model,
    providers: [
      {
        id: opts.agentProvider.id,
        type: opts.agentProvider.type,
        apiKey: opts.agentProvider.opts.apiKey,
        baseUrl: opts.agentProvider.opts.baseUrl,
        apiPath: opts.agentProvider.opts.apiPath,
        model: opts.agentProvider.model,
      },
    ],
    agents: [createRetailAgentDef(opts.maxSteps)],
    extraPlugins: [createRetailPlugin(taskDb)],
    permissionMode: 'allow-all',
    autoResume: false,
  })

  const turns: TurnRecord[] = []
  const allInvocations: ToolInvocation[] = []
  let terminated: TerminationReason = 'max_turns'
  let errorMsg: string | undefined

  try {
    const { harness, session } = await host.boot()
    const sessionId = session.id

    const userProvider = await buildUserSimProvider(
      opts.userProvider.type,
      opts.userProvider.opts,
      opts.userProvider.model,
    )
    const userSim = new UserSimulator({
      provider: userProvider,
      providerId: opts.userProvider.type,
      modelId: opts.userProvider.model,
      task,
    })

    let processedIndex = session.messages.length
    let agentText = INITIAL_GREETING

    for (let turn = 0; turn < opts.maxTurns; turn++) {
      // ── user 轮：模拟客户响应 agent 文本 ──
      const turnStart = Date.now()
      const { text: userText, termination } = await userSim.respondTo(agentText)
      if (termination) {
        terminated =
          termination === 'stop' ? 'user_stop'
          : termination === 'transfer' ? 'user_transfer'
          : 'user_out_of_scope'
        turns.push({ role: 'user', text: userText, toolCalls: [], latencyMs: Date.now() - turnStart })
        break
      }

      // ── agent 轮：harness 主循环（工具调用在引擎内完成）──
      const agentStart = Date.now()
      const assistantMsg = await host.send(sessionId, userText)
      const sess = await harness.session.get(sessionId)
      const { invocations, nextIndex } = extractNewInvocations(sess!, processedIndex)
      processedIndex = nextIndex
      allInvocations.push(...invocations)

      agentText = assistantText(assistantMsg)
      turns.push({ role: 'assistant', text: agentText, toolCalls: invocations, latencyMs: Date.now() - agentStart })
      turns.push({ role: 'user', text: userText, toolCalls: [], latencyMs: Date.now() - turnStart })

      if (!agentText) {
        // 官方 communication error：agent 空回复无法推进对话
        terminated = 'error'
        errorMsg = `agent 空回复（turn ${turn + 1}）`
        break
      }
    }

    // ── 用量（agent 侧）──
    const usage = await harness.usage.get(sessionId).catch(() => undefined)

    // ── judge：DB 终态校验（轨迹回放 vs gold 回放）──
    const judge = await judgeTask(task, allInvocations)

    return {
      taskId: task.id,
      sampleIndex,
      sessionId,
      terminated,
      turns: turns.length,
      trajectory: turns,
      dbMatch: judge.dbMatch,
      reward: judge.reward,
      rewardBasis: judge.rewardBasis,
      usage: {
        llmCalls: usage?.llmCalls ?? 0,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
      },
      userSimUsage: { ...userSim.usage },
      latencyMs: Date.now() - startedAt,
      error: errorMsg,
    }
  } catch (err) {
    return {
      taskId: task.id,
      sampleIndex,
      sessionId: '',
      terminated: 'error',
      turns: turns.length,
      trajectory: turns,
      dbMatch: false,
      reward: 0,
      usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      userSimUsage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
