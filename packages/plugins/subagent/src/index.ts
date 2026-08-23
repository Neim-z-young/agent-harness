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
import type { AgentPlugin, Hooks, CliCommandInput } from '@harness/plugin'
import type { AgentDefinition, AgentPermissionConfig } from '@harness/agent'
import type { AgentRuntime, SessionManager } from '@harness/core'
import type { Message } from '@harness/session'
import { BusEvent, type Bus } from '@harness/bus'
import { matchGlob } from '@harness/permission'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ===== Subagent Bus 事件定义 =====

/**
 * 子 Agent 执行开始事件。
 * 在子 session 创建/续接后、agent.query 调用前发布。
 */
export const SubagentEvents = {
  started: BusEvent.define<{
    /** 子 Agent ID */
    agentId: string
    /** 子 Agent 名称 */
    agentName: string
    /** 子 session ID */
    subSessionId: string
    /** 父 session ID（调用方） */
    parentSessionId: string
    /** 父 Agent ID（调用方） */
    parentAgentId: string
    /** 父消息 ID（触发此工具调用的消息） */
    parentMessageId: string
    /** 工具调用 ID */
    toolUseId: string
    /** 任务描述 */
    prompt: string
    /** 简短描述（UI 展示用） */
    description?: string
    /** 是否续接已有子 session */
    isContinuation: boolean
    /** 开始时间戳 */
    startedAt: number
  }>('subagent.started'),

  completed: BusEvent.define<{
    /** 子 Agent ID */
    agentId: string
    /** 子 session ID */
    subSessionId: string
    /** 父 session ID */
    parentSessionId: string
    /** 工具调用 ID */
    toolUseId: string
    /** 子 Agent 最终回复文本（截断预览） */
    replyPreview: string
    /** 子 session 消息总数 */
    messageCount: number
    /** 执行耗时（ms） */
    durationMs: number
  }>('subagent.completed'),

  failed: BusEvent.define<{
    /** 子 Agent ID（可能为空，如果 Agent 未找到） */
    agentId?: string
    /** 子 session ID（可能为空，如果创建失败） */
    subSessionId?: string
    /** 父 session ID */
    parentSessionId: string
    /** 工具调用 ID */
    toolUseId: string
    /** 错误码 */
    code: string
    /** 错误消息 */
    message: string
    /** 执行耗时（ms） */
    durationMs: number
  }>('subagent.failed'),
} as const

// ===== 类型定义 =====

/** SubagentTool 的输入 */
export interface SubagentToolInput {
  /** 子 Agent ID（必须已注册且 mode === 'subagent'） */
  agentId: string
  /** 派给子 Agent 的任务描述 */
  prompt: string
  /** 3-5 词简短描述（用于 UI 展示和工具调用日志，类似 Claude Code 的 description 参数） */
  description?: string
  /** 模型覆盖（优先级高于子 Agent 定义中的 model；不传则用子 Agent 自身配置） */
  model?: { providerId?: string; modelId?: string; temperature?: number }
  /** 续接已有子 session（多轮子 Agent 对话）；不传则创建新 session */
  sessionId?: string
}

/** SubagentTool 的输出 */
export interface SubagentToolOutput {
  /** 子 session ID（独立隔离上下文） */
  sessionId: string
  /** 子 Agent 最终回复文本（超过阈值时为摘要） */
  message: string
  /** 子 session 中的消息总数 */
  messageCount: number
  /** 回复是否被摘要截断 */
  summarized: boolean
  /** 子 Agent 内部工具调用次数 */
  toolCallCount: number
  /** 完整输出的临时文件路径（summarized=true 时有值，父 Agent 可用 read_file/grep_file 探索） */
  outputPath?: string
}

/** createSubagentPlugin 的配置 */
export interface SubagentPluginOptions {
  /** 启动时注册的子 Agent 定义列表 */
  subagents?: AgentDefinition[]
  /** 子 Agent 执行超时（毫秒），缺省 120_000 */
  timeoutMs?: number
  /** 子 Agent 完成后是否删除子 session（缺省 false，保留便于调试） */
  cleanupSession?: boolean
  /** 返回给父 Agent 的最大结果长度（字符），超过则生成摘要。缺省 2000 */
  maxResultLength?: number
  /** 返回给父 Agent 的最大结果行数，超过则生成摘要。缺省 500（先于 maxResultLength 触发更精准） */
  maxResultLines?: number
  /** 注入子 Agent 的结构化输出指令（类似 Claude Code 的 fork directive），要求子 Agent 简洁结构化回复 */
  directive?: string
}

/** Harness 引用的最小接口（避免 import core 导致循环依赖） */
interface HarnessLike {
  agent: AgentRuntime
  session: SessionManager
  /** Bus 事件总线（用于发布子 Agent 进度事件） */
  bus?: Bus
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

// ===== 基于 caller.permission 过滤 Agent =====

/**
 * 判断子 Agent 是否被父 Agent 的权限配置拒绝。
 *
 * 参考 OpenCode task.ts 的 `PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny"` 逻辑。
 *
 * @harness 的 AgentPermissionConfig 结构兼容 @harness/permission 的 PermissionRuleset：
 * - 简写形式：`agent: 'allow' | 'deny' | 'ask'`（对所有子 Agent 生效）
 * - 详细形式：`agent: { allow: ['coder'], deny: ['admin'] }`（按 agentId glob 匹配）
 * - 未配置：fallback 到 `'*'` 全局规则
 *
 * 可见性判定：不被 deny 即可见（与 OpenCode 一致）。
 * allow / ask 只影响调用时的行为（直接放行 vs 询问），不影响可见性。
 *
 * @param agentId 子 Agent ID
 * @param callerPermission 父 Agent 的权限配置（AgentPermissionConfig）
 * @returns true 表示该子 Agent 被拒绝（不可见/不可调用）
 */
export function isAgentDenied(
  agentId: string,
  callerPermission?: AgentPermissionConfig,
): boolean {
  if (!callerPermission) return false

  // 优先用 'agent' 工具键的规则，fallback 到 '*' 全局规则
  const rule = callerPermission['agent'] ?? callerPermission['*']
  if (rule === undefined) return false

  if (typeof rule === 'string') {
    // 简写形式：'deny' 拒绝所有，'allow'/'ask' 放行所有
    return rule === 'deny'
  }

  // 详细形式（AgentPathRules）：检查 agentId 是否匹配 deny 列表中的 glob
  if (rule.deny && rule.deny.some((p) => matchGlob(p, agentId))) {
    return true
  }
  return false
}

/**
 * 根据父 Agent 的权限配置过滤可访问的子 Agent 列表。
 *
 * 参考 OpenCode task.ts 的 `accessibleAgents = agents.filter(...)` 逻辑。
 *
 * @param agents 所有已注册的子 Agent
 * @param callerPermission 父 Agent 的权限配置（AgentPermissionConfig）
 * @returns 过滤后的可访问子 Agent 列表（不被 deny 的）
 */
export function filterAccessibleAgents(
  agents: AgentDefinition[],
  callerPermission?: AgentPermissionConfig,
): AgentDefinition[] {
  if (!callerPermission) return agents
  return agents.filter((a) => !isAgentDenied(a.id, callerPermission))
}

// ===== 工具调用摘要 =====

/** 从工具输入中提取关键信息用于摘要（按 toolId 定制） */
function summarizeToolInput(toolId: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>

  switch (toolId) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return String(obj.path ?? obj.filepath ?? '')
    case 'bash':
    case 'shell':
      return truncateStr(String(obj.command ?? ''), 80)
    case 'list_dir':
      return String(obj.path ?? '')
    case 'glob':
      return String(obj.pattern ?? obj.path ?? '')
    case 'grep':
    case 'grep_file':
      return String(obj.pattern ?? '')
    case 'web_fetch':
    case 'web_search':
      return String(obj.url ?? obj.query ?? '')
    default: {
      // 通用：取第一个字符串值
      for (const v of Object.values(obj)) {
        if (typeof v === 'string') return truncateStr(v, 60)
      }
      return ''
    }
  }
}

/** 截断字符串（超过 maxLen 加 ... 后缀） */
function truncateStr(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s
}

/** 统计子 session 中的工具调用次数 */
function countToolCalls(messages: Message[]): number {
  let count = 0
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === 'tool') count++
    }
  }
  return count
}

/**
 * 当子 Agent 最终回复过长时生成摘要。
 *
 * 参考 OpenCode `tool/truncation.ts` 的设计：
 * - 双维度阈值（行数 + 字符数），任一超过即触发摘要
 * - head + tail 保留策略（前一半 + 后一半），比单一 head/tail 更能保留首尾信息
 * - 完整输出写入临时文件，返回 outputPath 供父 Agent 用 read_file/grep_file 探索
 * - 智能提示：根据父 Agent 是否拥有探索工具给出不同的后续操作建议
 *
 * 参考 Claude Code `AgentTool/forkSubagent.ts` 的 directive 设计：
 * - 工具调用列表格式参考 Claude Code 的结构化输出（Scope/Result/Key files）
 *
 * 摘要 = head 预览 + 工具调用列表 + tail 预览 + 截断提示（含完整文件路径）
 *
 * @param messages 子 session 的所有消息
 * @param finalText 子 Agent 最终回复文本
 * @param maxResultLength 最大结果长度（字符），超过则摘要
 * @param maxResultLines 最大结果行数，超过则摘要
 * @param callerToolIds 父 Agent 可用工具 ID 列表（用于智能提示）；不传则给出通用提示
 * @returns { text, summarized, outputPath } 摘要后的文本、是否被摘要、完整输出文件路径
 */
function summarizeResult(
  messages: Message[],
  finalText: string,
  maxResultLength: number,
  maxResultLines: number,
  callerToolIds?: string[],
): { text: string; summarized: boolean; outputPath?: string } {
  const lines = finalText.split('\n')
  const totalLines = lines.length
  const totalChars = finalText.length

  // 双维度阈值：行数或字符数任一超过即触发
  const shouldSummarize = totalLines > maxResultLines || totalChars > maxResultLength
  if (!shouldSummarize) {
    return { text: finalText, summarized: false }
  }

  // 提取所有工具调用
  const toolCalls: Array<{ toolId: string; inputPreview: string; isError: boolean }> = []
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== 'tool') continue
      const tcp = part as { toolId: string; input?: unknown; isError?: boolean }
      toolCalls.push({
        toolId: tcp.toolId,
        inputPreview: summarizeToolInput(tcp.toolId, tcp.input),
        isError: tcp.isError ?? false,
      })
    }
  }

  // head + tail 保留策略：
  // - 行数超阈值时：按行做 head + tail（前 N/2 行 + 后 N/2 行）
  // - 行数不超但字符数超时：按字符做 head + tail（前一半字符 + 后一半字符）
  const headCount = Math.floor(maxResultLines / 2)
  const tailCount = Math.ceil(maxResultLines / 2)
  let preview: string
  if (totalLines > maxResultLines) {
    // 行级 head + tail
    const headLines = lines.slice(0, headCount)
    const tailLines = totalLines > tailCount ? lines.slice(-tailCount) : []
    const previewLines = headLines.length + tailLines.length < totalLines
      ? [...headLines, '...', ...tailLines]
      : lines
    preview = previewLines.join('\n')
  } else {
    // 字符级 head + tail（行数少但单行很长，如 minified 代码）
    const halfLen = Math.floor(maxResultLength / 2)
    const head = finalText.slice(0, halfLen)
    const tail = totalChars > halfLen ? finalText.slice(-halfLen) : ''
    preview = head.length + tail.length < totalChars
      ? `${head}\n...\n${tail}`
      : finalText
  }

  // 完整输出写入临时文件
  const outputPath = join(tmpdir(), `subagent-output-${Date.now()}.txt`)
  try {
    writeFileSync(outputPath, finalText, 'utf-8')
  } catch {
    // 写文件失败不影响主流程，outputPath 仍返回但文件可能不存在
  }

  // 智能提示：根据父 Agent 可用工具给出不同的后续操作建议
  // 参考 OpenCode 的 hasTaskTool 逻辑
  const hasReadFile = callerToolIds?.includes('read_file') ?? false
  const hasGrepFile = callerToolIds?.includes('grep_file') ?? false
  const hasSubagent = callerToolIds?.includes('subagent') ?? false
  const hint = hasReadFile || hasGrepFile
    ? `完整输出已保存至：${outputPath}（共 ${totalLines} 行 / ${totalChars} 字符）。可使用 read_file 或 grep_file 工具查看。${hasSubagent ? ' 或再次调用 subagent 工具委派 explore agent 处理。' : ''}`
    : `完整输出已保存至：${outputPath}（共 ${totalLines} 行 / ${totalChars} 字符）。${hasSubagent ? '可再次调用 subagent 工具委派 explore agent 处理。' : '请考虑拆分任务。'}`

  // 构建摘要
  const out: string[] = [preview]

  if (toolCalls.length > 0) {
    out.push('')
    out.push(`[工具调用摘要（${toolCalls.length} 次）]`)
    for (const tc of toolCalls) {
      const errFlag = tc.isError ? ' [错误]' : ''
      const inputPart = tc.inputPreview ? `: ${tc.inputPreview}` : ''
      out.push(`- ${tc.toolId}${inputPart}${errFlag}`)
    }
  }

  out.push('')
  out.push(`[完整回复 ${totalLines} 行 / ${totalChars} 字符已截断为摘要]`)
  out.push(hint)

  return { text: out.join('\n'), summarized: true, outputPath }
}

// ===== SubagentTool（AgentTool）=====

/**
 * 创建 SubagentTool
 *
 * @param getHarness 获取 Harness 引用的函数（插件在 harness.start 时缓存）
 * @param timeoutMs 执行超时
 * @param cleanupSession 完成后是否删除子 session
 * @param maxResultLength 返回给父 Agent 的最大结果长度（字符），超过则生成摘要。缺省 2000
 * @param maxResultLines 返回给父 Agent 的最大结果行数，超过则生成摘要。缺省 500
 * @param directive 注入子 Agent 的结构化输出指令（类似 Claude Code 的 fork directive），
 *                  要求子 Agent 简洁结构化回复；不传则不注入
 */
/** 创建 SubagentTool（导出便于单独使用或测试） */
export function createSubagentTool(
  getHarness: () => HarnessLike | undefined,
  timeoutMs: number,
  cleanupSession: boolean,
  maxResultLength: number = 2000,
  maxResultLines: number = 500,
  directive?: string,
): Tool<SubagentToolInput, SubagentToolOutput> {
  return defineTool<SubagentToolInput, SubagentToolOutput>({
    id: 'subagent',
    aliases: ['agent', 'run_agent', 'task'],
    description: '派一个子 Agent 执行独立任务（隔离 session）。输入：agentId（子 Agent ID）、prompt（任务描述）、description（3-5 词简短描述，可选）、model（模型覆盖，可选）、sessionId（续接已有子 session，可选）。',
    documentation: 'SubagentTool 让主 Agent 能派出子 Agent 执行独立任务。子 Agent 用独立 session 隔离上下文，有独立的工具白名单和权限配置。可选通过 model 参数覆盖子 Agent 的模型配置，通过 sessionId 参数续接已有子 session 实现多轮对话。子 Agent 完成后，最终回复作为工具结果返回给主 Agent。',
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
      const startTime = Date.now()
      const harness = getHarness()
      const bus = harness?.bus

      /** 发布 failed 事件（封装避免重复代码） */
      const publishFailed = (code: string, message: string, agentId?: string, subSessionId?: string) => {
        if (!bus) return
        bus.publish(SubagentEvents.failed, {
          agentId,
          subSessionId,
          parentSessionId: ctx.sessionId,
          toolUseId: ctx.toolUseId,
          code,
          message,
          durationMs: Date.now() - startTime,
        }).catch(() => { /* Bus 发布失败不影响主流程 */ })
      }

      if (!harness || !harness.agent || !harness.session) {
        publishFailed('HARNESS_NOT_READY', 'Harness 未就绪（harness.start 未触发或 agent/session 缺失）')
        return {
          ok: false,
          error: { message: 'Harness 未就绪（harness.start 未触发）', code: 'HARNESS_NOT_READY' },
        }
      }

      const { agent, session } = harness

      // 验证子 Agent 已注册
      const agentDef = agent.get(input.agentId)
      if (!agentDef) {
        publishFailed('AGENT_NOT_FOUND', `子 Agent "${input.agentId}" 未注册`, input.agentId)
        return {
          ok: false,
          error: { message: `子 Agent "${input.agentId}" 未注册`, code: 'AGENT_NOT_FOUND' },
        }
      }

      // 验证 mode === 'subagent'（防止派出 primary/coordinator 自身）
      if (agentDef.mode !== 'subagent') {
        publishFailed('INVALID_AGENT_MODE', `Agent "${input.agentId}" 的 mode 是 "${agentDef.mode}"`, input.agentId)
        return {
          ok: false,
          error: {
            message: `Agent "${input.agentId}" 的 mode 是 "${agentDef.mode}"，不是 "subagent"`,
            code: 'INVALID_AGENT_MODE',
          },
        }
      }

      // 基于 caller.permission 验证调用权限（元信息层友好错误码）
      // 注意：ToolPipeline 已通过 PermissionEngine.check() 做了权限检查，
      // 这里是元信息层的二次验证，提供更友好的错误码和 Bus 事件
      const callerAgent = ctx.agentId ? agent.get(ctx.agentId) : undefined
      if (callerAgent && isAgentDenied(input.agentId, callerAgent.permission)) {
        publishFailed(
          'PERMISSION_DENIED',
          `Agent "${ctx.agentId}" 无权调用子 Agent "${input.agentId}"（被 permission.agent.deny 拒绝）`,
          input.agentId,
        )
        return {
          ok: false,
          error: {
            message: `无权调用子 Agent "${input.agentId}"（被父 Agent permission 配置拒绝）`,
            code: 'PERMISSION_DENIED',
          },
        }
      }

      // 子 session：input.sessionId 有值则续接（多轮子 Agent 对话），无值则创建新 session
      let subSessionId: string
      let isContinuation = false
      if (input.sessionId) {
        // 续接已有子 session
        const existing = await session.get(input.sessionId)
        if (!existing) {
          publishFailed('SESSION_NOT_FOUND', `子 session "${input.sessionId}" 不存在`, input.agentId, input.sessionId)
          return {
            ok: false,
            error: { message: `子 session "${input.sessionId}" 不存在`, code: 'SESSION_NOT_FOUND' },
          }
        }
        subSessionId = input.sessionId
        isContinuation = true
      } else {
        // 创建新子 session（隔离上下文，关联父 session 便于审计追溯）
        try {
          const title = input.description
            ?? (input.prompt.length > 60 ? input.prompt.slice(0, 60) + '...' : input.prompt)
          const subSession = await session.create({ title, parentId: ctx.sessionId })
          subSessionId = subSession.id
        } catch (err) {
          publishFailed('SESSION_CREATE_FAILED', `创建子 session 失败：${(err as Error)?.message ?? err}`, input.agentId)
          return {
            ok: false,
            error: {
              message: `创建子 session 失败：${(err as Error)?.message ?? err}`,
              code: 'SESSION_CREATE_FAILED',
            },
          }
        }
      }

      // 发布 subagent.started 事件
      if (bus) {
        bus.publish(SubagentEvents.started, {
          agentId: input.agentId,
          agentName: agentDef.name,
          subSessionId,
          parentSessionId: ctx.sessionId,
          parentAgentId: ctx.agentId,
          parentMessageId: ctx.messageId,
          toolUseId: ctx.toolUseId,
          prompt: input.prompt.length > 500 ? input.prompt.slice(0, 500) + '...' : input.prompt,
          description: input.description,
          isContinuation,
          startedAt: startTime,
        }).catch(() => { /* Bus 发布失败不影响主流程 */ })
      }

      // 带超时调用 agent.query（传入 model 覆盖 + directive 前置注入）
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      // directive 注入：将 directive 前置到 prompt（参考 Claude Code forkSubagent.ts 的 buildChildMessage）
      // directive 用于约束子 Agent 的输出格式（如 Scope/Result/Key files/Files changed）
      const effectivePrompt = directive ? `${directive}\n\n${input.prompt}` : input.prompt

      try {
        // 注意：agent.query 不接受 signal，我们用 Promise.race 模拟超时
        const queryPromise = agent.query({
          sessionId: subSessionId,
          agentId: input.agentId,
          message: effectivePrompt,
          model: input.model,
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
          const errMsg = `子 Agent 执行失败：${(err as Error)?.message ?? err}`
          publishFailed('SUBAGENT_FAILED', errMsg, input.agentId, subSessionId)
          return {
            ok: false,
            error: {
              message: errMsg,
              code: 'SUBAGENT_FAILED',
            },
          }
        }

        // 取子 session 的所有消息，提取最终 assistant 文本
        const subSession = await session.get(subSessionId)
        const messages = subSession?.messages ?? [finalMessage]
        const finalText = extractFinalAssistantText(messages) || '(子 Agent 无文本回复)'
        const toolCallCount = countToolCalls(messages)

        // 超长结果生成摘要，避免上下文膨胀
        // 从 ctx.variables 中读取 callerToolIds（由 ToolRunner 注入，用于智能提示）
        const callerToolIds = Array.isArray(ctx.variables?.callerToolIds)
          ? ctx.variables.callerToolIds as string[]
          : undefined
        const { text: resultText, summarized, outputPath } = summarizeResult(
          messages,
          finalText,
          maxResultLength,
          maxResultLines,
          callerToolIds,
        )

        // 发布 subagent.completed 事件
        if (bus) {
          bus.publish(SubagentEvents.completed, {
            agentId: input.agentId,
            subSessionId,
            parentSessionId: ctx.sessionId,
            toolUseId: ctx.toolUseId,
            replyPreview: resultText.length > 200 ? resultText.slice(0, 200) + '...' : resultText,
            messageCount: messages.length,
            durationMs: Date.now() - startTime,
          }).catch(() => { /* Bus 发布失败不影响主流程 */ })
        }

        return {
          ok: true,
          output: {
            sessionId: subSessionId,
            message: resultText,
            messageCount: messages.length,
            summarized,
            toolCallCount,
            outputPath,
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
      description: input.description,
      prompt: input.prompt.length > 100 ? input.prompt.slice(0, 100) + '...' : input.prompt,
      model: input.model?.modelId,
      sessionId: input.sessionId,
    }),
    renderResult: (result) => {
      if (!result.ok || !result.output) return undefined
      return {
        sessionId: result.output.sessionId,
        preview: result.output.message.length > 200
          ? result.output.message.slice(0, 200) + '...'
          : result.output.message,
        summarized: result.output.summarized,
        toolCallCount: result.output.toolCallCount,
        outputPath: result.output.outputPath,
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
 * @param options.maxResultLength 返回给父 Agent 的最大结果长度（字符），超过则生成摘要。缺省 2000
 * @param options.maxResultLines 返回给父 Agent 的最大结果行数，超过则生成摘要。缺省 500
 * @param options.directive 注入子 Agent 的结构化输出指令（类似 Claude Code 的 fork directive）
 */
export function createSubagentPlugin(options: SubagentPluginOptions = {}): AgentPlugin {
  const {
    subagents = [],
    timeoutMs = 120_000,
    cleanupSession = false,
    maxResultLength = 2000,
    maxResultLines = 500,
    directive,
  } = options

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
      subagentTool = createSubagentTool(
        () => harness,
        timeoutMs,
        cleanupSession,
        maxResultLength,
        maxResultLines,
        directive,
      )

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
            // 基于 caller.permission 过滤可见子 Agent（参考 OpenCode accessibleAgents 逻辑）
            // 从 sessionId 获取 session，再从 session.agentId 获取父 Agent 定义
            let accessible = registered
            if (harness?.session) {
              try {
                const session = await harness.session.get(input.sessionId)
                const callerAgentId = session?.agentId
                if (callerAgentId && harness.agent) {
                  const callerAgent = harness.agent.get(callerAgentId)
                  if (callerAgent) {
                    accessible = filterAccessibleAgents(registered, callerAgent.permission)
                  }
                }
              } catch { /* session 不存在或读取失败，列出全部 */ }
            }

            if (accessible.length === 0) {
              input.out('（当前 Agent 无权调用任何子 Agent）\n')
            } else {
              const hiddenCount = registered.length - accessible.length
              const hint = hiddenCount > 0 ? `（${hiddenCount} 个被权限过滤隐藏）` : ''
              input.out(`可调用 ${accessible.length} 个子 Agent${hint}：\n`)
              for (const a of accessible) {
                const tools = Array.isArray(a.tools) ? a.tools.join(', ') : '*'
                input.out(`  ${a.id}  -  ${a.name}\n`)
                input.out(`    描述：${a.description}\n`)
                input.out(`    工具：${tools}\n`)
                if (a.model?.modelId) input.out(`    模型：${a.model.modelId}\n`)
              }
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
