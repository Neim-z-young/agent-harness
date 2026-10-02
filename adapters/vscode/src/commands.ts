/**
 * 斜杠命令 → 控制通道：**参数解析与渲染的纯模块**（设计稿 §6.4）。
 *
 * 分层纪律（与 `map/render.ts` 同一条）：本文件**不 import `vscode`**，
 * 解析与渲染都可脱离 VSCode 单测；`participant.ts` 只做接线。
 *
 * ## 「输入词汇」住在这里
 * 控制面收的是**结构化入参**（`{ providerId, modelId }`，见 `control.ts` 文件头）；
 * `/model hy3`、`/permission bash=deny` 这类**人类词法**的歧义消解就在本模块完成 ——
 * sidecar 只做"把话说清楚的一次翻译"，扩展端负责把人说的话翻译成结构。
 *
 * 两段协议（get → 消解 → set）目前有两条：
 * - `/model <spec>`：`harness/model.get` 带回 configured 清单（序号 / 实例 id）；
 * - `/resume <序号>`：`harness/session.list` 带回会话清单（序号 → sessionId）。
 * `/new` `/resume` 成功后**必须换绑 TurnState 的 contextId**（= sessionId），
 * 否则下一轮还在跟旧会话说话 —— 参与者按 `CommandPlan.affectsContext` 处理。
 */

// ========================================================================
// 计划：命令 → 控制调用
// ========================================================================

/** 一次控制通道调用 */
export interface ControlCall {
  readonly method: string
  readonly params: Record<string, unknown>
}

/**
 * 命令的执行计划。
 *
 * 大多数命令是单次 `call`；两段协议（`model-resolve` / `session-resolve`）由参与者
 * 编排 —— 纯模块不碰传输。`affectsContext` 标出会**更换 harness 会话**的命令：
 * 参与者执行成功后要把返回的 sessionId 写进 TurnState.contextId、清掉 taskId。
 */
export type CommandPlan =
  | { readonly kind: 'call'; readonly call: ControlCall; readonly affectsContext?: boolean }
  | { readonly kind: 'model-resolve'; readonly spec: string }
  | { readonly kind: 'session-resolve'; readonly spec: string }
  | { readonly kind: 'local'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string }

/** 参与者声明的斜杠命令（package.json 的 `chatParticipants.commands` 与此一一对应） */
export const SLASH_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'compact', description: '压缩当前会话上下文（可选：ifneeded / prune / summary / agent）' },
  { name: 'stats', description: '用量统计与上下文占用' },
  { name: 'stats-export', description: '导出统计报告到文件（可选 json；路径见回复中的引用）' },
  { name: 'agent', description: '查看或切换当前 Agent（/agent <id>）' },
  { name: 'model', description: '查看或切换模型（/model <序号 | provider/model | reset>）' },
  { name: 'permission', description: '查看或设置权限（/permission <mode | key=behavior | reset>）' },
  { name: 'skills', description: '查看或管理技能（/skills <enable | disable | reload> <id>）' },
  { name: 'sessions', description: '列出全部持久化会话' },
  { name: 'new', description: '新建会话（沿用当前 Agent 与模型设置）' },
  { name: 'resume', description: '恢复会话（/resume <序号 | 会话id>）' },
  { name: 'save', description: '立即保存当前会话' },
  { name: 'tree', description: '目录树，* 标记对话引用过的文件（/tree [路径]）' },
  { name: 'history', description: '输入历史说明（Chat 视图自带历史）' },
  { name: 'help', description: '查看可用命令' },
]

const COMPACT_STRATEGIES = ['ifneeded', 'prune', 'summary', 'agent'] as const
const PERMISSION_MODES = ['allow-all', 'ask', 'deny-all'] as const
const PERMISSION_BEHAVIORS = ['allow', 'deny', 'ask'] as const
const SKILL_OPS = ['enable', 'disable', 'reload'] as const

/**
 * 把 `/command <args>` 翻成执行计划。
 *
 * `args` 是 Chat 视图里的剩余文本。**VSCode 各版本对 `request.prompt` 的切分行为不一**
 * （有的把命令名也留在 prompt 里），这里统一剥掉前导的 `/command` 再解析 ——
 * 别假设，把它洗成确定形状。
 */
export function planCommand(command: string, args: string): CommandPlan {
  // 剥前导 "/command"（若宿主把整行都塞进 prompt）
  const rest = args.replace(new RegExp(`^\\s*/?${command}\\b`, 'i'), '').trim()

  switch (command) {
    case 'compact': {
      if (rest === '') return call('harness/compact', {})
      const strategy = rest === 'auto' ? 'ifneeded' : rest
      if (!(COMPACT_STRATEGIES as readonly string[]).includes(strategy)) {
        return unknown(`用法：/compact [${COMPACT_STRATEGIES.join(' | ')}]（缺省 ifneeded，即按阈值判断）`)
      }
      return call('harness/compact', { strategy })
    }

    case 'stats':
      if (rest !== '') return unknown('用法：/stats（无参数）')
      return call('harness/stats.get', {})

    case 'stats-export': {
      // /stats-export [json] —— 导出文件落在 sidecar 工作目录（控制面固定行为）
      if (rest === '') return call('harness/stats.export', {})
      if (rest === 'json' || rest === '--json') return call('harness/stats.export', { format: 'json' })
      return unknown('用法：/stats-export [json]（文件写到工作目录，路径见回复）')
    }

    case 'agent': {
      if (rest === '') return call('harness/agent.list', {})
      return call('harness/agent.set', { agentId: rest })
    }

    case 'model': {
      if (rest === '') return call('harness/model.get', {})
      if (rest === 'reset') return call('harness/model.set', { reset: true })
      return { kind: 'model-resolve', spec: rest }
    }

    case 'permission': {
      if (rest === '') return call('harness/permission.get', {})
      if (rest === 'reset') return call('harness/permission.set', { reset: true })
      if ((PERMISSION_MODES as readonly string[]).includes(rest)) {
        return call('harness/permission.set', { mode: rest })
      }
      const eq = rest.indexOf('=')
      if (eq > 0) {
        const key = rest.slice(0, eq).trim()
        const behavior = rest.slice(eq + 1).trim()
        if (!key || !(PERMISSION_BEHAVIORS as readonly string[]).includes(behavior)) {
          return unknown(`用法：/permission <${PERMISSION_MODES.join(' | ')}> 或 <工具键>=<${PERMISSION_BEHAVIORS.join(' | ')}> 或 reset`)
        }
        return call('harness/permission.set', { key, behavior })
      }
      return unknown(`用法：/permission（查看）｜ /permission <${PERMISSION_MODES.join(' | ')}>｜ /permission <工具键>=<${PERMISSION_BEHAVIORS.join(' | ')}>｜ /permission reset`)
    }

    case 'skills': {
      if (rest === '') return call('harness/skill.list', {})
      const m = /^(\S+)\s+(\S+)$/.exec(rest)
      if (m && (SKILL_OPS as readonly string[]).includes(m[1] ?? '')) {
        return call('harness/skill.set', { op: m[1], id: m[2] ?? '' })
      }
      return unknown(`用法：/skills（查看）｜ /skills <${SKILL_OPS.join(' | ')}> <id>`)
    }

    case 'sessions':
      if (rest !== '') return unknown('用法：/sessions（无参数）')
      return call('harness/session.list', {})

    case 'new':
      if (rest !== '') return unknown('用法：/new（无参数；沿用当前 Agent 与模型设置）')
      return call('harness/session.new', {})

    case 'resume': {
      if (rest === '') return call('harness/session.list', {})
      return { kind: 'session-resolve', spec: rest }
    }

    case 'save':
      if (rest !== '') return unknown('用法：/save（无参数）')
      return call('harness/session.save', {})

    case 'tree':
      return call('harness/tree.get', rest === '' ? {} : { root: rest })

    case 'history':
      return {
        kind: 'local',
        message:
          'Chat 视图自带输入历史（输入框 **上/下方向键**，或历史面板）；harness 侧不另存一份，避免两边口径不一致。',
      }

    case 'help':
      return { kind: 'local', message: renderCommandHelp() }

    default:
      return unknown(`未知命令 /${command}`)
  }
}

function call(method: string, params: Record<string, unknown>): CommandPlan {
  return { kind: 'call', call: { method, params } }
}
function unknown(message: string): CommandPlan {
  return { kind: 'unknown', message }
}

// ========================================================================
// 两段协议的消解（输入词汇，扩展端独有）
// ========================================================================

/** `harness/model.get` 出参里的 configured 条目（扩展端只认这几个字段） */
export interface ConfiguredProvider {
  readonly index: number
  readonly id: string
  readonly model: string | null
}

/**
 * 把 `/model <spec>` 的自由文本解析成结构化入参（与 CLI 同一套词法）：
 *
 * - `2` → configured 清单里的序号（`/model` 无参展示的编号）；
 * - `provider/model` → 两段显式给出；
 * - 裸名 → 先按 model id 在清单里**精确**匹配（命中即带上 provider），
 *   匹配不上就当纯 modelId 传给 sidecar（由它判断可不可用）。
 */
export function resolveModelSpec(
  spec: string,
  configured: readonly ConfiguredProvider[],
): { providerId?: string; modelId?: string } | string {
  const s = spec.trim()
  if (s === '') return '模型名不能为空'

  // 序号
  if (/^\d+$/.test(s)) {
    const idx = Number(s)
    const hit = configured.find((c) => c.index === idx)
    if (!hit) return `序号 ${idx} 不在可选清单里（用 /model 查看）`
    return hit.model ? { providerId: hit.id, modelId: hit.model } : { providerId: hit.id }
  }

  // provider/model
  const slash = s.indexOf('/')
  if (slash > 0) {
    return { providerId: s.slice(0, slash), modelId: s.slice(slash + 1) }
  }

  // 裸名：清单里精确匹配 model id
  const hit = configured.find((c) => c.model === s)
  if (hit) return { providerId: hit.id, modelId: s }
  return { modelId: s }
}

/** `harness/session.list` 出参里的会话条目（扩展端只认这几个字段） */
export interface SessionListEntry {
  readonly index: number
  readonly id: string
  readonly title: string | null
  /** 更新时间（epoch ms）；sidecar 端回传 */
  readonly updatedAt?: number
  readonly messageCount?: number
  /** sidecar 标出的「本目录上次会话」 */
  readonly current?: boolean
}

/**
 * 把 `/resume <spec>` 的自由文本解析成 sessionId：
 * 序号 → 清单命中（不存在则报错文案）；其余整串当 sessionId 交给 sidecar 判断。
 */
export function resolveSessionSpec(
  spec: string,
  sessions: readonly SessionListEntry[],
): { id: string } | string {
  const s = spec.trim()
  if (s === '') return '会话 id 不能为空'
  if (/^\d+$/.test(s)) {
    const idx = Number(s)
    const hit = sessions.find((c) => c.index === idx)
    if (!hit) return `序号 ${idx} 不在会话清单里（用 /sessions 查看）`
    return { id: hit.id }
  }
  return { id: s }
}

// ========================================================================
// 渲染：控制结果 → markdown
// ========================================================================

/**
 * 把控制通道的出参渲染成 markdown。
 *
 * ⚠️ 文案纪律（设计稿 §11）：整页文本（stats / tree）来自**服务端渲染**的 `text` 字段，
 * 这里不抄第二份渲染器；其余命令按结构化字段排版。形状对不上时退化为
 * JSON 代码块 —— 宁可原始，不可编造。
 */
export function renderControlResult(command: string, result: unknown): string {
  switch (command) {
    case 'stats': {
      const r = result as { text?: unknown }
      if (typeof r?.text === 'string' && r.text.trim() !== '') {
        return `### /stats\n\n\`\`\`\n${r.text.trimEnd()}\n\`\`\``
      }
      break // 形状不对 → 走兜底
    }

    case 'agent': {
      const r = result as {
        current?: unknown
        agents?: Array<{ id?: unknown; name?: unknown; description?: unknown; model?: unknown; current?: unknown }>
      }
      if (Array.isArray(r?.agents)) {
        const rows = r.agents
          .map((a) => `| ${a.current ? '✅' : ''} | \`${str(a.id)}\` | ${str(a.name)}${a.description ? ` —— ${str(a.description)}` : ''} | ${str(a.model) || '—'} |`)
          .join('\n')
        return `### /agent（当前：\`${str(r.current)}\`）\n\n| 使用中 | id | 名称 | 模型 |\n|---|---|---|---|\n${rows}\n\n_用 \`/agent <id>\` 切换（只改本会话）。_`
      }
      break
    }

    case 'model': {
      const r = result as {
        current?: unknown
        source?: unknown
        override?: unknown
        agentModel?: unknown
        endpoint?: { providerId?: unknown; modelId?: unknown }
        configured?: ConfiguredProvider[]
        ok?: unknown
        scope?: unknown
        cleared?: unknown
        warning?: unknown
      }
      if (r?.endpoint !== undefined && r.current !== undefined) {
        const src = r.source === 'session' ? '本会话覆盖' : 'Agent 绑定'
        const lines = [
          `### /model`,
          ``,
          `- 当前：**${str(r.current)}**（来源：${src}）`,
          `- Agent 绑定：${str(r.agentModel) || '—'}`,
          `- 实际端点：\`${str(r.endpoint.providerId)} / ${str(r.endpoint.modelId)}\``,
        ]
        if (Array.isArray(r.configured) && r.configured.length > 0) {
          lines.push(``, `可切换清单（\`/model <序号>\` 或 \`/model provider/model\`，\`/model reset\` 清除会话覆盖）：`, ``)
          for (const c of r.configured) lines.push(`${c.index}. \`${c.id}\`${c.model ? ` → \`${c.model}\`` : ''}`)
        }
        return lines.join('\n')
      }
      if (r?.ok !== undefined) {
        // model.set 的出参
        const cleared = r.cleared === true ? '（已清除会话覆盖）' : ''
        const warn = typeof r.warning === 'string' && r.warning !== '' ? `\n\n> ⚠️ ${r.warning}` : ''
        return `### /model\n\n✅ 已切换（作用域：${str(r.scope)}）${cleared}\n当前：**${str(r.current)}**${warn}`
      }
      break
    }

    case 'permission': {
      const r = result as { mode?: unknown; rules?: unknown; ok?: unknown }
      if (r?.mode !== undefined && r.rules !== undefined) {
        const head = r.ok !== undefined ? '### /permission\n\n✅ 已更新。' : '### /permission'
        const rules = r.rules as Record<string, unknown>
        const entries = Object.entries(rules ?? {})
        const body = entries.length
          ? `\n\n| 工具键 | 行为 |\n|---|---|\n${entries.map(([k, v]) => `| \`${k}\` | ${str(v)} |`).join('\n')}`
          : '\n\n（无规则，全部按模式处理）'
        return `${head}\n\n模式：**${str(r.mode)}**${body}`
      }
      break
    }

    case 'skills': {
      if (Array.isArray(result)) {
        const rows = (result as Array<{ id?: unknown; name?: unknown; sourceLabel?: unknown; enabled?: unknown }>)
          .map((s) => `| ${s.enabled ? '✅' : '⛔'} | \`${str(s.id)}\` | ${str(s.name)} | ${str(s.sourceLabel)} |`)
          .join('\n')
        return `### /skills\n\n| 状态 | id | 名称 | 来源 |\n|---|---|---|---|\n${rows}\n\n_用 \`/skills enable|disable|reload <id>\` 管理。_`
      }
      const r = result as { ok?: unknown; message?: unknown; op?: unknown; id?: unknown }
      if (r?.ok !== undefined) {
        return `### /skills\n\n${r.ok ? '✅' : '❌'} ${str(r.message) || `${str(r.op)} ${str(r.id)}`}`
      }
      break
    }

    case 'compact': {
      const r = result as {
        did?: unknown
        strategy?: unknown
        info?: {
          count?: unknown
          totalPrunedMessages?: unknown
          lastMessagesBefore?: unknown
          lastMessagesAfter?: unknown
          round?: unknown
          summaryPreview?: unknown
        }
      }
      if (r?.info !== undefined) {
        const i = r.info
        const lines = [
          `### /compact（策略：${str(r.strategy)}）`,
          ``,
          r.did ? '✅ 已执行压缩。' : '本会话未达到压缩阈值，未执行。',
          ``,
          `- 累计压缩：${num(i.count)} 次 / 累计裁剪 ${num(i.totalPrunedMessages)} 条`,
          `- 上一轮：前 ${num(i.lastMessagesBefore)} 条 → 后 ${num(i.lastMessagesAfter)} 条（摘要轮次 ${num(i.round)}）`,
        ]
        if (typeof i.summaryPreview === 'string' && i.summaryPreview !== '') {
          lines.push(``, `> 摘要预览：${i.summaryPreview}`)
        }
        return lines.join('\n')
      }
      break
    }

    case 'sessions': {
      if (Array.isArray(result)) {
        const rows = (result as SessionListEntry[])
          .map((s) => {
            const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '—'
            const mark = s.current ? ' ← 本目录上次' : ''
            return `| ${s.index} | \`${str(s.id)}\` | ${str(s.title) || '(untitled)'} | ${num(s.messageCount)} | ${when}${mark} |`
          })
          .join('\n')
        return `### /sessions\n\n| 序号 | id | 标题 | 消息 | 更新时间 |\n|---|---|---|---|---|\n${rows}\n\n_用 \`/resume <序号 | id>\` 恢复。_`
      }
      break
    }

    case 'new': {
      const r = result as { sessionId?: unknown; agentId?: unknown; model?: unknown; carriedModelOverride?: unknown }
      if (r?.sessionId !== undefined) {
        const carry = r.carriedModelOverride === true ? '（模型覆盖已沿用）' : ''
        return `### /new\n\n✅ 已新建会话 \`${str(r.sessionId)}\`\n\n- Agent：\`${str(r.agentId)}\`${carry}\n- 模型：${str(r.model) || '（Provider 默认）'}\n\n_后续消息将进入新会话。_`
      }
      break
    }

    case 'resume': {
      const r = result as { sessionId?: unknown; title?: unknown; agentId?: unknown; messageCount?: unknown; model?: unknown }
      if (r?.sessionId !== undefined) {
        return `### /resume\n\n✅ 已恢复会话 \`${str(r.sessionId)}\`${r.title ? `（${str(r.title)}）` : ''}\n\n- Agent：\`${str(r.agentId)}\`\n- 消息数：${num(r.messageCount)}\n- 模型：${str(r.model) || '（Provider 默认）'}\n\n_后续消息将接在该会话上。_`
      }
      break
    }

    case 'save': {
      const r = result as { ok?: unknown; id?: unknown; messageCount?: unknown }
      if (r?.ok !== undefined) {
        return `### /save\n\n✅ 已保存会话 \`${str(r.id)}\`（${num(r.messageCount)} 条消息）`
      }
      break
    }

    case 'stats-export': {
      const r = result as { ok?: unknown; path?: unknown; format?: unknown; bytes?: unknown }
      if (r?.path !== undefined) {
        return `### /stats-export\n\n✅ 已导出（${str(r.format)}，${num(r.bytes)} 字节）→ 路径见回复引用。`
      }
      break
    }

    default:
      break
  }

  // 兜底：形状没认出来就原样 JSON（宁可原始，不可编造）
  return `### /${command}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``
}

/** 斜杠命令的用法提示（未知计划 / 解析失败时展示） */
export function renderCommandHelp(): string {
  return (
    '可用命令：\n\n' +
    SLASH_COMMANDS.map((c) => `- **/${c.name}** —— ${c.description}`).join('\n')
  )
}

// ========================================================================
// 启动自检（设计稿 §8）
// ========================================================================

/**
 * 把 `harness/notice.list { level: 'warn' }` 的文案渲染成首轮提示。
 *
 * 这条让"在 IDE 里拿到 mock 回答却毫无信号"变成不可能 —— sidecar 的降级事实
 * （如"未配置 API key，回落到 Mock"）必须在 Chat 里露脸。文案本身来自
 * `renderNotice`（宿主侧唯一实现），这里只排版。
 */
export function renderWarnNotices(texts: readonly string[]): string {
  if (texts.length === 0) return ''
  const lines = texts.map((t) => `- ⚠️ ${t}`)
  return `**sidecar 启动自检**（\`harness/notice.list\`，本轮后不再重复）：\n\n${lines.join('\n')}\n\n---\n\n`
}

// ---- 小工具 ---------------------------------------------------------------

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}
function num(v: unknown): string {
  return typeof v === 'number' ? v.toLocaleString() : v === null || v === undefined ? '—' : String(v)
}
