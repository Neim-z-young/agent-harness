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

import { defineTool, Tool, ToolResult, Schema, ToolContext, formatToolWhitelist, READONLY_TOOLS_SENTINEL } from '@harness/tool'
import type { AgentPlugin, Hooks, CliCommandInput, SubagentCapability } from '@harness/plugin'
import type { AgentDefinition, AgentPermissionConfig } from '@harness/agent'
import type { AgentRuntime, SessionManager } from '@harness/core'
import type { Message } from '@harness/session'
import { BusEvent, type Bus } from '@harness/bus'
import { matchGlob } from '@harness/permission'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorktree, getWorktreeDiff, gitTopLevel, listWorktrees, removeWorktree } from './worktree'
// SubagentTool 提示词文本（prompts/*.txt，import 加载，参考 opencode）
import subagentToolDescription from './prompts/subagent-tool-description.txt'
import subagentToolDocumentation from './prompts/subagent-tool-documentation.txt'

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
    /** 后台任务 ID（runInBackground=true 时有值） */
    taskId?: string
    /** 是否为后台执行 */
    background?: boolean
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
    /** 后台任务 ID（runInBackground=true 时有值） */
    taskId?: string
    /** 是否为后台执行 */
    background?: boolean
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
    /** 后台任务 ID（runInBackground=true 时有值） */
    taskId?: string
    /** 是否为后台执行 */
    background?: boolean
  }>('subagent.failed'),

  /**
   * 子 Agent 工具调用进度事件（P1-5）。
   * 后台任务执行期间，每次工具调用开始/完成时发布，前端实时展示进度。
   */
  progress: BusEvent.define<{
    /** 后台任务 ID */
    taskId: string
    /** 子 Agent ID */
    agentId: string
    /** 父 session ID */
    parentSessionId: string
    /** 工具调用 ID */
    toolUseId: string
    /** 工具 ID（如 read_file / bash） */
    toolName: string
    /** 工具执行状态 */
    toolStatus: 'running' | 'completed' | 'failed'
    /** 进度摘要（工具输入/结果预览） */
    summary: string
    /** 进度时间戳 */
    timestamp: number
  }>('subagent.progress'),
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
  /**
   * 是否在后台运行（fire-and-forget）：
   * - true：立即返回 taskId 和子 sessionId，不等待子 Agent 执行完成
   * - 不传 / false：同步等待子 Agent 完成（默认）
   *
   * 后台任务执行完成后：
   * 1. 通过 Bus 事件 subagent.completed / subagent.failed 推送（带 taskId）
   * 2. 自动向父会话注入 <task-notification> 通知，下一轮推理开始时可见
   * 3. 用户可通过 CLI /tasks 命令查看任务列表
   *
   * 参考 Claude Code fork subagent 的 task-notification 模型：
   * 工具立即返回 "Background task started"，结果通过事件通知。
   */
  runInBackground?: boolean
  /**
   * 该 worker 预计写入的文件/目录（项目相对路径）。
   * 调度元数据：Coordinator 插件据此做"写操作按文件集串行化"（冲突的派工延迟到前序
   * worker 完成后再执行，避免多个 worker 并发改同一批文件）。subagent 工具本身不消费。
   */
  targetFiles?: string[]
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
  /** 相对基线 HEAD 的完整 diff 补丁临时文件路径（worktree 隔离启用且子 Agent 有改动时有值） */
  diffPath?: string
  /** 后台任务 ID（runInBackground=true 时有值） */
  taskId?: string
  /** 是否为后台模式（runInBackground=true 时为 true） */
  background?: boolean
}

/** createSubagentPlugin 的配置 */
export interface SubagentPluginOptions {
  /**
   * 启动时**由本插件**注册的子 Agent 定义列表。
   *
   * 注意这不是「全部可调用的子 Agent」：md 定义的子 Agent 走 agentDirs 直接注册进
   * AgentRuntime，不经过本插件。要枚举真正可调用的子 Agent 请查注册表
   * （见 `registrySubagents`），`/subagents` 命令与 subagent 工具都以注册表为准。
   */
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
  /** 全局工具工作目录（core 传入 HarnessImpl.cwd；子 Agent 判 git worktree 用） */
  cwd?: string
  /** 工具注册表（可选）：把只读哨兵白名单解析成实际工具 id，供 /subagents 展示 */
  tools?: { filterByWhitelist(whitelist: string[] | ['*']): Array<{ id: string }> }
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
/** createSubagentTool 可选的 worktree 隔离依赖（由插件在 harness.start 时注入） */
export interface WorktreeHooks {
  /** 解析/创建子 Agent 隔离 worktree 目录（未启用返回 undefined） */
  resolve: (existingCwd?: string) => Promise<string | undefined>
  /** 把 worktree diff 摘要并入结果文本，返回完整 patch 文件路径 */
  attachDiff: (
    result: Readonly<{ text: string }>,
    worktreeDir: string | undefined,
  ) => Promise<{ text: string; diffPath?: string }>
}

/** 创建 SubagentTool（导出便于单独使用或测试） */
export function createSubagentTool(
  getHarness: () => HarnessLike | undefined,
  timeoutMs: number,
  cleanupSession: boolean,
  maxResultLength: number = 2000,
  maxResultLines: number = 500,
  directive?: string,
  getRegistry?: () => BackgroundTaskRegistry | undefined,
  worktree?: WorktreeHooks,
): Tool<SubagentToolInput, SubagentToolOutput> {
  return defineTool<SubagentToolInput, SubagentToolOutput>({
    id: 'subagent',
    aliases: ['agent', 'run_agent', 'task'],
    description: subagentToolDescription.trim(),
    documentation: subagentToolDocumentation.trim(),
    searchHint: 'subagent agent task delegate spawn worker background async',

    // Fail-Closed 安全声明
    isReadOnly: () => false,          // 子 Agent 可能执行写操作
    // 子 Agent 可能修改共享状态（如文件），即使 runInBackground=true 也保持串行调度。
    // 后台并行性由 runInBackground 机制保证（异步执行块），不依赖 partitionToolCalls。
    // 多个写操作 Agent 操作同一文件的冲突由 agent 配置/worktree 隔离负责。
    isConcurrencySafe: () => false,
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
        // 续接：若非隔离 worktree 目录则保持该 session 原执行目录（不强行迁移）
        await worktree?.resolve(existing.cwd)
      } else {
        // 创建新子 session（隔离上下文，关联父 session 便于审计追溯）
        try {
          const title = input.description
            ?? (input.prompt.length > 60 ? input.prompt.slice(0, 60) + '...' : input.prompt)
          const wcwd = await worktree?.resolve(undefined)
          const subSession = await session.create({
            title,
            parentId: ctx.sessionId,
            cwd: wcwd,
            meta: wcwd ? { worktreeDir: wcwd } : undefined,
          })
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

      // ===== 后台模式分流（runInBackground=true 或 Agent 定义 background=true）=====
      // 参考 Claude Code fork subagent 的 task-notification 模型：
      // 工具立即返回 taskId 和 "Background task started" 提示，子 Agent 在后台异步执行。
      // 执行完成后通过 Bus 事件 + enqueueNotification 自动通知父 Agent（task_status 工具已移除）。
      const shouldRunInBackground = input.runInBackground === true || agentDef.background === true
      const registry = getRegistry?.()
      if (shouldRunInBackground && registry) {
        // 1. 注册后台任务，获取 taskId
        const taskId = registry.register({
          agentId: input.agentId,
          agentName: agentDef.name,
          subSessionId,
          parentSessionId: ctx.sessionId,
          parentAgentId: ctx.agentId,
          prompt: input.prompt,
          description: input.description,
        })
        const controller = new AbortController()
        // 把 controller 存到 task 上，便于后续 cancel()
        const task = registry.get(taskId)
        if (task) task.controller = controller
        registry.start(taskId)

        // 2. 发布 started 事件（带 taskId）
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
            taskId,
            background: true,
          }).catch(() => { /* Bus 发布失败不影响主流程 */ })
        }

        // 3. 异步执行子 Agent（不 await，fire-and-forget）
        //    执行完成后更新 task 状态 + publish completed/failed 事件
        //    使用 queryStream：遍历工具调用事件，实时发布 subagent.progress（P1-5）
        const effectivePromptBg = directive ? `${directive}\n\n${input.prompt}` : input.prompt
        const timerBg = setTimeout(() => controller.abort(), timeoutMs)
        void (async () => {
          try {
            const timeoutPromise = new Promise<never>((_resolve, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error(`后台子 Agent 执行超时（${timeoutMs}ms）`))
              })
            })

            // 进度发布辅助（工具调用开始/完成/失败 → subagent.progress 事件）
            const publishProgress = (
              toolStatus: 'running' | 'completed' | 'failed',
              toolUseId: string,
              toolName: string,
              summary: string,
            ) => {
              if (!bus) return
              bus.publish(SubagentEvents.progress, {
                taskId,
                agentId: input.agentId,
                parentSessionId: ctx.sessionId,
                toolUseId,
                toolName,
                toolStatus,
                summary,
                timestamp: Date.now(),
              }).catch(() => { /* Bus 发布失败不影响主流程 */ })
            }

            // 遍历 queryStream：yield tool_call_start / tool_call_result / done
            const execPromise = (async () => {
              let finalMessage: Message | undefined
              const stream = agent.queryStream({
                sessionId: subSessionId,
                agentId: input.agentId,
                message: effectivePromptBg,
                model: input.model,
              })
              for await (const ev of stream) {
                if (ev.type === 'tool_call_start') {
                  const detail = summarizeToolInput(ev.toolId ?? '', ev.input)
                  publishProgress('running', ev.toolUseId ?? '', ev.toolId ?? '', detail)
                } else if (ev.type === 'tool_call_result') {
                  const preview = typeof ev.result === 'string'
                    ? ev.result.slice(0, 120)
                    : JSON.stringify(ev.result ?? '').slice(0, 120)
                  publishProgress(
                    ev.isError ? 'failed' : 'completed',
                    ev.toolUseId ?? '',
                    ev.toolId ?? '',
                    preview || (ev.isError ? '执行失败' : '完成'),
                  )
                } else if (ev.type === 'done') {
                  finalMessage = ev.message
                }
              }
              return finalMessage
            })()
            const finalMessage = await Promise.race([execPromise, timeoutPromise])

            // 提取结果 + 生成摘要
            const subSession = await session.get(subSessionId)
            const messages = subSession?.messages ?? (finalMessage ? [finalMessage] : [])
            const finalText = extractFinalAssistantText(messages) || '(子 Agent 无文本回复)'
            const toolCallCount = countToolCalls(messages)
            const { text: resultText, summarized, outputPath } = summarizeResult(
              messages,
              finalText,
              maxResultLength,
              maxResultLines,
              undefined,
            )
            // 附加 worktree diff 摘要 + 完整 patch（会话级隔离目录）
            const { text: resultTextBg, diffPath } = await (
              worktree?.attachDiff({ text: resultText }, subSession?.cwd)
              ?? Promise.resolve<{ text: string; diffPath?: string }>({ text: resultText })
            )

            // 更新 task 为 completed
            registry.complete(taskId, {
              result: resultTextBg,
              summarized,
              messageCount: messages.length,
              toolCallCount,
              outputPath,
              diffPath,
              durationMs: Date.now() - startTime,
            })

            // publish completed 事件（带 taskId）
            if (bus) {
              bus.publish(SubagentEvents.completed, {
                agentId: input.agentId,
                subSessionId,
                parentSessionId: ctx.sessionId,
                toolUseId: ctx.toolUseId,
                replyPreview: resultTextBg.length > 200 ? resultTextBg.slice(0, 200) + '...' : resultTextBg,
                messageCount: messages.length,
                durationMs: Date.now() - startTime,
                taskId,
                background: true,
              }).catch(() => { /* ignore */ })
            }

            // 自动向父 session 注入 task-notification 通知（去重）
            const task = registry.get(taskId)
            if (task && !task.notified) {
              task.notified = true
              const notification = formatTaskNotification({
                taskId,
                status: 'completed',
                agentName: input.agentId,
                description: input.description,
                result: resultTextBg,
                outputPath,
                diffPath,
                durationMs: Date.now() - startTime,
                messageCount: messages.length,
                toolCallCount,
              })
              session.enqueueNotification(ctx.sessionId, notification)
            }
          } catch (err) {
            const errMsg = `后台子 Agent 执行失败：${(err as Error)?.message ?? err}`
            const failDurationMs = Date.now() - startTime
            // 更新 task 为 failed
            registry.fail(taskId, {
              code: 'SUBAGENT_FAILED',
              message: errMsg,
              durationMs: failDurationMs,
            })
            // publish failed 事件（带 taskId）
            if (bus) {
              bus.publish(SubagentEvents.failed, {
                agentId: input.agentId,
                subSessionId,
                parentSessionId: ctx.sessionId,
                toolUseId: ctx.toolUseId,
                code: 'SUBAGENT_FAILED',
                message: errMsg,
                durationMs: failDurationMs,
                taskId,
                background: true,
              }).catch(() => { /* ignore */ })
            }

            // 自动向父 session 注入 task-notification 通知（去重）
            const task = registry.get(taskId)
            if (task && !task.notified) {
              task.notified = true
              const notification = formatTaskNotification({
                taskId,
                status: 'failed',
                agentName: input.agentId,
                description: input.description,
                error: errMsg,
                durationMs: failDurationMs,
              })
              session.enqueueNotification(ctx.sessionId, notification)
            }
          } finally {
            clearTimeout(timerBg)
          }
        })()

        // 4. 立即返回 taskId（不等待子 Agent 完成）
        return {
          ok: true,
          output: {
            sessionId: subSessionId,
            taskId,
            background: true,
            message: `后台任务已启动（taskId: ${taskId}）。子 Agent 在后台异步执行，执行完成后自动向本会话注入 <task-notification> 通知，无需主动查询。`,
            messageCount: 0,
            summarized: false,
            toolCallCount: 0,
          },
        }
      }

      // ===== 同步模式（默认）=====
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

        // 附加 worktree 相对基线 HEAD 的 diff 摘要（会话级隔离目录）+ 完整 patch 路径
        const { text: finalResultText, diffPath } = await (
          worktree?.attachDiff({ text: resultText }, subSession?.cwd)
          ?? Promise.resolve<{ text: string; diffPath?: string }>({ text: resultText })
        )

        // 发布 subagent.completed 事件
        if (bus) {
          bus.publish(SubagentEvents.completed, {
            agentId: input.agentId,
            subSessionId,
            parentSessionId: ctx.sessionId,
            toolUseId: ctx.toolUseId,
            replyPreview: finalResultText.length > 200 ? finalResultText.slice(0, 200) + '...' : finalResultText,
            messageCount: messages.length,
            durationMs: Date.now() - startTime,
          }).catch(() => { /* Bus 发布失败不影响主流程 */ })
        }

        return {
          ok: true,
          output: {
            sessionId: subSessionId,
            message: finalResultText,
            messageCount: messages.length,
            summarized,
            toolCallCount,
            outputPath,
            diffPath,
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
      runInBackground: input.runInBackground,
    }),
    renderResult: (result) => {
      if (!result.ok || !result.output) return undefined
      return {
        sessionId: result.output.sessionId,
        taskId: result.output.taskId,
        background: result.output.background,
        preview: result.output.message.length > 200
          ? result.output.message.slice(0, 200) + '...'
          : result.output.message,
        summarized: result.output.summarized,
        toolCallCount: result.output.toolCallCount,
        outputPath: result.output.outputPath,
        diffPath: result.output.diffPath,
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
  /** 后台任务注册表（生命周期与插件实例一致） */
  const registry = new BackgroundTaskRegistry()

  /** git 仓库根（worktree 隔离启用时为非空；null=非 git 回退） */
  let baseCwd: string | null = null
  /** worktree 隔离是否启用（harness.cwd 是 git 仓库时） */
  let worktreeEnabled = false

  /**
   * 权威来源：AgentRuntime 注册表里所有 `mode === 'subagent'` 的 Agent。
   *
   * 为什么不能只看本插件的 `subagents` 配置数组：md 定义的子 Agent 经 `agentDirs`
   * 被 core 直接注册进 AgentRuntime，**不经过本插件**。只列插件数组会漏掉它们，
   * 让人误以为「只有配在插件里的那一个能调用」。
   *
   * 口径必须与 subagent 工具一致 —— 工具是用 `agent.get(agentId)` + `mode` 校验
   * 解析目标的（见 createSubagentTool），同样只认注册表、不认插件数组。
   *
   * @returns 注册表里的子 Agent；harness 尚未就绪（如单测未触发 harness.start）时
   *          返回 undefined，由调用方回退到插件配置数组。
   */
  const registrySubagents = (): AgentDefinition[] | undefined => {
    const list = harness?.agent?.list?.()
    if (!Array.isArray(list)) return undefined
    return list.filter((a) => a.mode === 'subagent')
  }

  /** 本插件自己配置的子 Agent（用于标注来源 / harness 未就绪时兜底） */
  const ownSubagents = (): AgentDefinition[] => subagents.filter((a) => a.mode === 'subagent')

  /**
   * 为子 Agent 解析/创建隔离 worktree 目录。
   * - 未启用 → undefined。
   * - 续接：existingCwd 已在 worktree 下则复用，否则 undefined（保持原执行目录）。
   * - 新建：createWorktree；失败降级返回 undefined（不影响子 Agent 运行）。
   */
  const resolveWorktree = async (existingCwd?: string): Promise<string | undefined> => {
    if (!worktreeEnabled || !baseCwd) return undefined
    const prefix = join(baseCwd, '.harness', 'worktrees') + '/'
    if (existingCwd) {
      if (existingCwd.startsWith(prefix)) return existingCwd
      return undefined
    }
    try {
      const token = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      return await createWorktree({ base: baseCwd, token })
    } catch (err) {
      console.warn('[subagent] 创建子 Agent worktree 失败，降级为无隔离执行', {
        base: baseCwd,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  /**
   * 把 worktree 相对基线 HEAD 的 diff 摘要并入结果文本，并把完整 patch 写入临时文件。
   * 有变更才追加；任何 getWorktreeDiff 失败均返回原样，不中断子 Agent。
   */
  const attachWorktreeDiff = async (
    result: Readonly<{ text: string }>,
    worktreeDir: string | undefined,
  ): Promise<{ text: string; diffPath?: string }> => {
    if (!worktreeEnabled || !baseCwd || !worktreeDir) return { text: result.text }
    let diff: { summary: string; patch: string; hasChanges: boolean }
    try {
      diff = await getWorktreeDiff({ base: baseCwd, dir: worktreeDir })
    } catch {
      return { text: result.text }
    }
    if (!diff.hasChanges || !diff.summary) return { text: result.text }
    const diffPath = join(tmpdir(), `subagent-diff-${Date.now()}.patch`)
    try { writeFileSync(diffPath, diff.patch, 'utf-8') } catch { /* 写失败不阻塞 */ }
    const text = `${result.text}\n\n## Git Diff 摘要（相对基线 HEAD，目录 ${worktreeDir}）\n${diff.summary}`
    return { text, diffPath }
  }

  return {
    id: 'subagent',
    version: '0.2.0',
    name: 'Subagent',
    description: `Subagent 插件：派出子 Agent 执行独立任务（${subagents.length} 个子 Agent 已注册，支持 runInBackground）`,

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
        () => registry,
        { resolve: resolveWorktree, attachDiff: attachWorktreeDiff },
      )


      return {
        async 'harness.start'(input) {
          const h = (input as { harness: HarnessLike }).harness
          if (!h?.agent || !h?.session) {
            ctx.log.error('Subagent 插件：harness.start 未提供 agent/session 引用')
            return
          }
          harness = h

          // 检测 git worktree 隔离启用条件：harness 工作目录是 git 仓库
          try {
            baseCwd = h.cwd ? await gitTopLevel(h.cwd) : null
            worktreeEnabled = baseCwd !== null
          } catch {
            baseCwd = null
            worktreeEnabled = false
          }

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
          // 注册条件也以注册表为准：插件自己没配、但 md 定义里有子 Agent 时，命令同样可用
          const available = registrySubagents() ?? ownSubagents()
          if (available.length > 0) {
            input.commands.push({
              command: 'subagents',
              description: '列出可调用的子 Agent（读 AgentRuntime 注册表）',
              usage: '/subagents',
            })
          }
          // /tasks 命令：列出后台任务（用户直接在 CLI 查看）
          input.commands.push({
            command: 'tasks',
            description: '列出后台子 Agent 任务（runInBackground=true 派出的任务）',
            usage: '/tasks [running|completed|failed]',
          })
          // /worktrees 命令：管理子 Agent 隔离 worktree（仅 git 仓库启用时）
          if (worktreeEnabled) {
            input.commands.push({
              command: 'worktrees',
              description: '管理子 Agent 隔离 worktree（list | remove <dir> | remove-all），默认保留便于续接/调试',
              usage: '/worktrees [list|remove <dir>|remove-all]',
            })
          }
        },

        async 'cli.command'(input) {
          // ===== /subagents 命令 =====
          if (input.command === 'subagents') {
            // 注册表优先（与 subagent 工具同一口径）；harness 未就绪时回退插件配置数组
            const fromRegistry = registrySubagents()
            const registered = fromRegistry ?? ownSubagents()
            const own = new Set(subagents.map((a) => a.id))
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
                  const whitelist: string[] = Array.isArray(a.tools) ? (a.tools as string[]) : ['*']
                  // 哨兵白名单（md 未声明 tools 时的只读兜底）解析出实际工具 id ——
                  // 只写「只读工具」四个字，用户仍然不知道它到底能用什么。
                  const resolved = whitelist.includes(READONLY_TOOLS_SENTINEL)
                    ? harness?.tools?.filterByWhitelist(whitelist).map((t) => t.id)
                    : undefined
                  const tools = formatToolWhitelist(whitelist) + (resolved ? ` = ${resolved.join(', ') || '（当前无只读工具）'}` : '')
                  // 标注来源：让「配置在插件里」与「md 定义进来的」一眼可分
                  const origin = fromRegistry ? `  [${own.has(a.id) ? '插件配置' : 'agent 定义'}]` : ''
                  input.out(`  ${a.id}  -  ${a.name}${origin}\n`)
                  input.out(`    描述：${a.description || '（未提供）'}\n`)
                  input.out(`    工具：${tools}\n`)
                  if (a.model?.modelId) input.out(`    模型：${a.model.modelId}\n`)
                }
              }
            }
            input.result = 'continue'
            return
          }

          // ===== /tasks 命令：列出后台子 Agent 任务 =====
          if (input.command === 'tasks') {
            // 解析可选参数：running / completed / failed
            const arg = (input.arg ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
            const statusFilter: BackgroundTaskStatus | undefined =
              arg === 'running' ? 'running'
              : arg === 'completed' ? 'completed'
              : arg === 'failed' ? 'failed'
              : arg === 'pending' ? 'pending'
              : undefined

            const all = registry.list({
              status: statusFilter,
              parentSessionId: input.sessionId,
            })

            if (all.length === 0) {
              const filterHint = statusFilter ? `（${statusFilter}）` : ''
              input.out(`（无后台任务${filterHint}）\n`)
            } else {
              input.out(`后台任务 ${all.length} 个${statusFilter ? `（${statusFilter}）` : ''}：\n`)
              for (const t of all) {
                const ageMs = Date.now() - t.createdAt
                const ageStr = ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60_000)}m`
                const statusIcon = t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : t.status === 'running' ? '⏵' : '○'
                input.out(`  ${statusIcon} ${t.taskId}  -  ${t.agentName}（${t.status}, ${ageStr}）\n`)
                if (t.description) input.out(`    描述：${t.description}\n`)
                if (t.result) {
                  const preview = t.result.length > 80 ? t.result.slice(0, 80) + '...' : t.result
                  input.out(`    结果：${preview}\n`)
                }
                if (t.errorMessage) {
                  const preview = t.errorMessage.length > 80 ? t.errorMessage.slice(0, 80) + '...' : t.errorMessage
                  input.out(`    错误：${preview}\n`)
                }
                if (t.durationMs !== undefined) input.out(`    耗时：${t.durationMs}ms\n`)
              }
              input.out('\n')
              input.out('提示：任务完成后系统自动通知父 Agent，无需主动查询。\n')
            }
            input.result = 'continue'
            return
          }

          // ===== /worktrees 命令：管理子 Agent 隔离 worktree =====
          if (input.command === 'worktrees') {
            if (!worktreeEnabled || !baseCwd) {
              input.out('（尚未启用 worktree 隔离：当前工作目录不是 git 仓库）\n')
            } else {
              const arg = (input.arg ?? '').trim()
              if (arg === 'remove-all') {
                const all = await listWorktrees(baseCwd)
                let removed = 0
                for (const wt of all) {
                  if (wt.path !== baseCwd) {
                    try { await removeWorktree({ base: baseCwd, dir: wt.path }); removed += 1 } catch { /* ignore */ }
                  }
                }
                input.out(`已移除 ${removed} 个隔离 worktree（主工作区保留）\n`)
              } else if (arg.startsWith('remove ')) {
                const dir = arg.slice('remove '.length).trim()
                if (!dir) {
                  input.out('用法：/worktrees remove <dir>\n')
                } else {
                  try {
                    await removeWorktree({ base: baseCwd, dir })
                    input.out(`已移除 worktree：${dir}\n`)
                  } catch {
                    input.out(`移除失败：${dir}（可能不存在或正在使用）\n`)
                  }
                }
              } else {
                const all = await listWorktrees(baseCwd)
                input.out(`Worktrees（共 ${all.length} 个）：\n`)
                for (const wt of all) {
                  const marker = wt.path === baseCwd ? '（主工作区）' : ''
                  input.out(`  ${wt.path}${marker}  HEAD=${(wt.head ?? '').slice(0, 12)}\n`)
                }
                if (all.length > 1) {
                  input.out('\n提示：子 Agent 隔离 worktree 默认保留（便于续接/调试）。\n')
                  input.out('可用 /worktrees remove <dir> 或 /worktrees remove-all 回收。\n')
                }
              }
            }
            input.result = 'continue'
            return
          }
        },
      } as Hooks
    },

    async uninstall() {
      harness = undefined
    },
  }
}

// ===== BackgroundTaskRegistry（后台任务注册表）=====

/**
 * 格式化 task-notification 通知消息（注入父 session，供大模型在后续 turn 感知任务完成）。
 * 参考 Claude Code 的 enqueueAgentNotification + `<task-notification>` XML 格式。
 */
export function formatTaskNotification(input: {
  taskId: string
  status: 'completed' | 'failed'
  agentName: string
  description?: string
  result?: string
  error?: string
  outputPath?: string
  diffPath?: string
  durationMs: number
  messageCount?: number
  toolCallCount?: number
}): string {
  const label = input.description || input.agentName
  const summary = input.status === 'completed'
    ? `Agent "${label}" completed`
    : `Agent "${label}" failed: ${input.error ?? 'Unknown error'}`
  const resultSection = input.result ? `\n<result>${input.result}</result>` : ''
  const outputPathSection = input.outputPath
    ? `\n<output-file>${input.outputPath}</output-file>`
    : ''
  const diffPathSection = input.diffPath
    ? `\n<diff-file>${input.diffPath}</diff-file>`
    : ''
  const usageSection = `\n<usage><duration-ms>${input.durationMs}</duration-ms>${
    input.messageCount !== undefined ? `<message-count>${input.messageCount}</message-count>` : ''
  }${
    input.toolCallCount !== undefined ? `<tool-call-count>${input.toolCallCount}</tool-call-count>` : ''
  }</usage>`
  return `<task-notification>
<task-id>${input.taskId}</task-id>
<status>${input.status}</status>
<summary>${summary}</summary>${resultSection}${outputPathSection}${diffPathSection}${usageSection}
</task-notification>`
}


/**
 * 后台任务状态
 * - pending：已创建但未开始执行
 * - running：正在执行中
 * - completed：成功完成（结果可用）
 * - failed：执行失败
 */
export type BackgroundTaskStatus = 'pending' | 'running' | 'completed' | 'failed'

/**
 * 后台任务记录
 */
export interface BackgroundTask {
  /** 任务 ID（唯一） */
  taskId: string
  /** 子 Agent ID */
  agentId: string
  /** 子 Agent 名称 */
  agentName: string
  /** 子 session ID（独立隔离上下文） */
  subSessionId: string
  /** 父 session ID */
  parentSessionId: string
  /** 父 Agent ID */
  parentAgentId?: string
  /** 任务描述 */
  prompt: string
  /** 简短描述 */
  description?: string
  /** 任务状态 */
  status: BackgroundTaskStatus
  /** 创建时间戳 */
  createdAt: number
  /** 开始执行时间戳 */
  startedAt?: number
  /** 完成/失败时间戳 */
  completedAt?: number
  /** 执行耗时（ms，完成/失败后才有） */
  durationMs?: number
  /** 子 Agent 最终回复文本（完成时才有，超过阈值时为摘要） */
  result?: string
  /** 错误码（失败时才有） */
  errorCode?: string
  /** 错误消息（失败时才有） */
  errorMessage?: string
  /** 回复是否被摘要截断 */
  summarized?: boolean
  /** 子 session 消息总数 */
  messageCount?: number
  /** 子 Agent 内部工具调用次数 */
  toolCallCount?: number
  /** 完整输出的临时文件路径 */
  outputPath?: string
  /** 相对基线 HEAD 的完整 diff 补丁临时文件路径（worktree 隔离启用且有改动时有值） */
  diffPath?: string
  /** 用于取消后台任务的 AbortController */
  controller?: AbortController
  /** 完成通知是否已注入父 session（去重，防止重复注入） */
  notified?: boolean
}

/**
 * 后台任务注册表
 *
 * 管理 runInBackground=true 模式创建的子 Agent 后台任务：
 * - 注册（pending → running）
 * - 查询（get / list）
 * - 等待（wait，可选超时）
 * - 取消（cancel，通过 AbortController.abort 中断 query）
 * - 完成/失败回调（complete / fail）
 *
 * 任务结果保留在内存中，直到显式 clear 或进程退出。
 * 适用于 CLI /tasks 命令展示任务列表。
 */
export class BackgroundTaskRegistry {
  private tasks = new Map<string, BackgroundTask>()
  private resolvers = new Map<string, Array<(task: BackgroundTask) => void>>()
  private counter = 0

  /**
   * 注册新任务，返回 taskId
   */
  register(input: Omit<BackgroundTask, 'taskId' | 'status' | 'createdAt'>): string {
    this.counter += 1
    const taskId = `task-${Date.now().toString(36)}-${this.counter.toString(36)}`
    const task: BackgroundTask = {
      ...input,
      taskId,
      status: 'pending',
      createdAt: Date.now(),
    }
    this.tasks.set(taskId, task)
    return taskId
  }

  /**
   * 标记任务为 running（开始执行）
   */
  start(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.status = 'running'
    task.startedAt = Date.now()
  }

  /**
   * 标记任务为 completed，存储结果，触发所有 wait 的 resolver
   */
  complete(taskId: string, result: Partial<Pick<BackgroundTask,
    'result' | 'summarized' | 'messageCount' | 'toolCallCount' | 'outputPath' | 'diffPath' | 'durationMs'
  >>): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.status = 'completed'
    task.completedAt = Date.now()
    Object.assign(task, result)
    if (!task.durationMs && task.startedAt) {
      task.durationMs = task.completedAt - task.startedAt
    }
    this.notifyResolvers(taskId, task)
  }

  /**
   * 标记任务为 failed，存储错误信息，触发所有 wait 的 resolver
   */
  fail(taskId: string, error: { code: string; message: string; durationMs?: number }): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.status = 'failed'
    task.completedAt = Date.now()
    task.errorCode = error.code
    task.errorMessage = error.message
    if (error.durationMs !== undefined) {
      task.durationMs = error.durationMs
    } else if (task.startedAt) {
      task.durationMs = task.completedAt - task.startedAt
    }
    this.notifyResolvers(taskId, task)
  }

  /**
   * 查询任务（不等待）
   */
  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * 列出所有后台任务（可选过滤状态）
   */
  list(filter?: { status?: BackgroundTaskStatus; parentSessionId?: string }): BackgroundTask[] {
    const all = Array.from(this.tasks.values())
    return all.filter((t) => {
      if (filter?.status && t.status !== filter.status) return false
      if (filter?.parentSessionId && t.parentSessionId !== filter.parentSessionId) return false
      return true
    }).sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 等待任务完成/失败（阻塞直到结果或超时）
   * 已完成/失败的任务立即返回。
   *
   * @param taskId 任务 ID
   * @param timeoutMs 超时（ms），缺省 0 表示无限等待
   * @returns 任务记录，或超时返回 undefined
   */
  async wait(taskId: string, timeoutMs: number = 0): Promise<BackgroundTask | undefined> {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    if (task.status === 'completed' || task.status === 'failed') return task

    return new Promise<BackgroundTask | undefined>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // 超时：从 resolvers 中移除当前 resolver，避免内存泄漏
          const arr = this.resolvers.get(taskId) ?? []
          this.resolvers.set(taskId, arr.filter((r) => r !== resolver))
          resolve(undefined)
        }, timeoutMs)
      }

      const resolver = (t: BackgroundTask) => {
        if (timer) clearTimeout(timer)
        resolve(t)
      }
      const arr = this.resolvers.get(taskId) ?? []
      arr.push(resolver)
      this.resolvers.set(taskId, arr)
    })
  }

  /**
   * 取消任务（通过 AbortController 中断 agent.query）
   * 仅 running 状态有效；pending/completed/failed 无效。
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running' || !task.controller) return false
    task.controller.abort()
    return true
  }

  /**
   * 清理已完成/失败的任务（释放内存）
   */
  clear(filter?: { status?: 'completed' | 'failed' }): number {
    const all = Array.from(this.tasks.entries())
    let removed = 0
    for (const [id, t] of all) {
      if (t.status === 'completed' || t.status === 'failed') {
        if (!filter || t.status === filter.status) {
          this.tasks.delete(id)
          this.resolvers.delete(id)
          removed += 1
        }
      }
    }
    return removed
  }

  /** 触发所有 wait 的 resolver */
  private notifyResolvers(taskId: string, task: BackgroundTask): void {
    const arr = this.resolvers.get(taskId) ?? []
    this.resolvers.delete(taskId)
    for (const resolve of arr) resolve(task)
  }
}

// ===== 后台任务展示 Monitor（P1-4 前端事件驱动展示）=====

/** 后台任务展示视图（UI 无关，供 CLI REPL / Web UI 渲染） */
export interface BackgroundTaskView {
  /** 后台任务 ID */
  taskId: string
  /** 子 Agent ID */
  agentId: string
  /** 子 Agent 名称 */
  agentName: string
  /** 父 session ID（任务发起方会话） */
  parentSessionId: string
  /** 父 Agent ID（任务发起方） */
  parentAgentId?: string
  /** 任务描述（完整 prompt） */
  prompt: string
  /** 简短描述（UI 展示用） */
  description?: string
  /** 任务状态 */
  status: 'running' | 'completed' | 'failed'
  /** 开始时间戳 */
  startedAt: number
  /** 结束时间戳（completed/failed 时有值） */
  finishedAt?: number
  /** 执行耗时（ms，completed/failed 时有值） */
  durationMs?: number
  /** 结果预览（completed 时，replyPreview） */
  result?: string
  /** 错误信息（failed 时） */
  error?: { code: string; message: string }
  /** 子 session 消息总数（completed 时） */
  messageCount?: number
  /** 工具调用进度列表（P1-5：最新在前） */
  progress?: BackgroundTaskProgress[]
}

/** 单条工具调用进度（P1-5） */
export interface BackgroundTaskProgress {
  /** 工具调用 ID */
  toolUseId: string
  /** 工具 ID */
  toolName: string
  /** 工具执行状态 */
  toolStatus: 'running' | 'completed' | 'failed'
  /** 进度摘要（工具输入/结果预览） */
  summary: string
  /** 进度时间戳 */
  timestamp: number
}

export interface BackgroundTaskMonitorOptions {
  /** Bus 实例（订阅 subagent.started/completed/failed） */
  bus: Bus
  /** 仅展示这些父 session 派发的任务；不传则展示所有 */
  parentSessionIds?: string[]
  /** 仅展示后台任务（background=true 的事件）；默认 true */
  backgroundOnly?: boolean
}

/** 任务变更订阅回调（每次快照变化时触发） */
export type BackgroundTaskListener = (tasks: readonly BackgroundTaskView[]) => void

/**
 * 后台任务事件驱动 Monitor（P1-4）。
 *
 * 订阅 subagent.started / completed / failed Bus 事件，维护后台任务的
 * 展示状态快照（running → completed/failed），前端（CLI REPL / 未来 Web UI）
 * 通过 subscribe() 自动渲染，无需大模型主动调用查询工具、无需执行 /tasks。
 *
 * UI 无关：只维护状态 + 广播变更，不依赖任何渲染框架。
 *
 * @example
 * const monitor = new BackgroundTaskMonitor({ bus })
 * monitor.subscribe((tasks) => renderPanel(tasks))
 * // 完成后释放
 * monitor.dispose()
 */
export class BackgroundTaskMonitor {
  private readonly tasks = new Map<string, BackgroundTaskView>()
  private readonly listeners = new Set<BackgroundTaskListener>()
  private readonly unsubscribers: Array<() => void> = []
  private readonly backgroundOnly: boolean
  private readonly parentSessionIds?: string[]

  constructor(options: BackgroundTaskMonitorOptions) {
    this.backgroundOnly = options.backgroundOnly ?? true
    this.parentSessionIds = options.parentSessionIds
    const { bus } = options
    const interested = (parentSessionId: string) =>
      !this.parentSessionIds || this.parentSessionIds.length === 0
      || this.parentSessionIds.includes(parentSessionId)

    this.unsubscribers.push(
      bus.subscribe(SubagentEvents.started, ({ payload }) => {
        if (!this.accept(payload.background)) return
        if (!interested(payload.parentSessionId)) return
        if (!payload.taskId) return
        this.tasks.set(payload.taskId, {
          taskId: payload.taskId,
          agentId: payload.agentId,
          agentName: payload.agentName,
          parentSessionId: payload.parentSessionId,
          parentAgentId: payload.parentAgentId,
          prompt: payload.prompt,
          description: payload.description,
          status: 'running',
          startedAt: payload.startedAt,
        })
        this.emit()
      }),
      bus.subscribe(SubagentEvents.completed, ({ payload }) => {
        if (!this.accept(payload.background)) return
        if (!interested(payload.parentSessionId)) return
        if (!payload.taskId) return
        const t = this.tasks.get(payload.taskId)
        if (!t) return
        t.status = 'completed'
        t.finishedAt = Date.now()
        t.durationMs = payload.durationMs
        t.result = payload.replyPreview
        t.messageCount = payload.messageCount
        this.emit()
      }),
      bus.subscribe(SubagentEvents.failed, ({ payload }) => {
        if (!this.accept(payload.background)) return
        if (!interested(payload.parentSessionId)) return
        if (!payload.taskId) return
        const t = this.tasks.get(payload.taskId)
        if (!t) return
        t.status = 'failed'
        t.finishedAt = Date.now()
        t.durationMs = payload.durationMs
        t.error = { code: payload.code, message: payload.message }
        this.emit()
      }),
      // P1-5：工具调用进度 → 追加到对应任务（最新在前）
      bus.subscribe(SubagentEvents.progress, ({ payload }) => {
        if (!interested(payload.parentSessionId)) return
        const t = this.tasks.get(payload.taskId)
        if (!t) return
        const entry: BackgroundTaskProgress = {
          toolUseId: payload.toolUseId,
          toolName: payload.toolName,
          toolStatus: payload.toolStatus,
          summary: payload.summary,
          timestamp: payload.timestamp,
        }
        // 同一 toolUseId 的旧条目（running）被新条目（completed/failed）覆盖
        const others = (t.progress ?? []).filter((p) => p.toolUseId !== entry.toolUseId)
        t.progress = [entry, ...others]
        this.emit()
      }),
    )
  }

  /** 是否纳入展示（后台任务过滤） */
  private accept(background?: boolean): boolean {
    if (!this.backgroundOnly) return true
    return background === true
  }

  /** 当前任务快照（按开始时间升序） */
  getTasks(): readonly BackgroundTaskView[] {
    return Array.from(this.tasks.values()).sort((a, b) => a.startedAt - b.startedAt)
  }

  /** 获取单个任务视图 */
  get(taskId: string): BackgroundTaskView | undefined {
    return this.tasks.get(taskId)
  }

  /** 订阅任务快照变更（返回取消订阅函数） */
  subscribe(listener: BackgroundTaskListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 取消全部 Bus 订阅并清空监听器 */
  dispose(): void {
    for (const off of this.unsubscribers) off()
    this.unsubscribers.length = 0
    this.listeners.clear()
  }

  private emit(): void {
    const snapshot = this.getTasks()
    for (const listener of this.listeners) {
      try { listener(snapshot) } catch { /* 单个监听器错误不影响其他 */ }
    }
  }
}

/** 创建后台任务 Monitor（便捷工厂） */
export function createBackgroundTaskMonitor(options: BackgroundTaskMonitorOptions): BackgroundTaskMonitor {
  return new BackgroundTaskMonitor(options)
}



// ===== 便捷导出 =====

/** 默认导出（无子 Agent 配置，需要通过 harness.start 后外部注册） */
export const subagentPlugin = createSubagentPlugin()

// ===== 运行时能力（抽象层契约）=====
// cli 等宿主只经 @harness/plugin 的 SubagentCapability 抽象接口交互，不依赖具体实现类型。

/** subagent 插件能力：创建后台任务监控器（实现 @harness/plugin.SubagentCapability） */
export const subagentCapability: SubagentCapability = {
  createMonitor: (options) => new BackgroundTaskMonitor(options),
}
