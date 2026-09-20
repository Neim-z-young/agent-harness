/**
 * @harness/skill-forge —— 技能锻造（Skill Forge）F1 / F2
 *
 * 定位：把「这次会话里跑通的流程」固化成一个可复用的 Skill（SKILL.md），
 * 让它下次能被 `paths` / `description` 命中自动注入，或被 `/skill-name` 主动调用。
 *
 * 设计取舍（来自 docs/memory-and-skill-forge-plan.md §4）：
 * 1. **人工确认是硬环节** —— 自动生成的技能一旦错了会被反复执行，成本远高于确认成本。
 *    所以命令是两段式：`/skill-forge <name>` 出草稿 → `/skill-forge --confirm <name>` 落盘。
 *    （CLI 的 CliCommandInput 只有 out 没有 stdin，两段式是唯一不阻塞 REPL 的确认方式。）
 * 2. **默认写 user 级**（`--project` 才写项目级）—— 项目级会随 git 共享，个人流程不该默认进仓库。
 * 3. **生成的技能 `allowEmbedShell=false`** —— 不能让模型给自己生成带 !\`cmd\` 的可执行技能
 *    （等于自我授权的 RCE 通道）。落盘由 `@harness/skill` 的 `SkillManager.save()` 强制。
 * 4. **只提示不自动写**（F3 才做隐式检测）；去重命中时提示"更新已有"而不是新建（F2）。
 *
 * 轨迹来源刻意用**引擎层**的 `core.tool.post.execute`，而不是 `cli.agent.stream`
 * —— 后者是 UI 消费层（只有走 CLI 的宿主才触发），靠它采集会在内嵌/ACP 宿主下静默失效
 * （与 memory 插件 §3.7⑦ 踩过的坑同源）。
 */

import type { AgentPlugin, Hooks, PluginContext, CliCommandInput } from '@harness/plugin'
import type { Skill, SkillSource, SkillManager } from '@harness/skill'

// ===== 轨迹记录 =====

/** 一条工具执行记录（轨迹的最小单元） */
export interface TraceEntry {
  toolId: string
  /** 入参摘要（截断后的单行） */
  inputSummary: string
  ok: boolean
  /** 失败原因（ok=false 时） */
  error?: string
}

/**
 * 会话级工具轨迹记录器（有界，防内存膨胀）。
 *
 * 只保留最近 N 条 × 最近 M 个会话；超出按 FIFO 丢弃最旧的会话。
 */
export class TraceRecorder {
  private sessions = new Map<string, TraceEntry[]>()
  private order: string[] = []

  constructor(
    private readonly opts: { maxEntries?: number; maxSessions?: number } = {},
  ) {}

  private get maxEntries(): number {
    return this.opts.maxEntries ?? 200
  }
  private get maxSessions(): number {
    return this.opts.maxSessions ?? 8
  }

  record(sessionId: string, entry: TraceEntry): void {
    if (!sessionId) return
    let list = this.sessions.get(sessionId)
    if (!list) {
      // 会话数上限：按插入顺序 FIFO 淘汰最早记录的会话（够用且可预测；
      // 真正的 LRU 需要每次读都重排，收益不抵复杂度）
      while (this.order.length >= this.maxSessions) {
        const oldest = this.order.shift()
        if (oldest) this.sessions.delete(oldest)
      }
      list = []
      this.sessions.set(sessionId, list)
      this.order.push(sessionId)
    }
    list.push(entry)
    if (list.length > this.maxEntries) list.splice(0, list.length - this.maxEntries)
  }

  list(sessionId: string): TraceEntry[] {
    return this.sessions.get(sessionId) ?? []
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      this.sessions.delete(sessionId)
      this.order = this.order.filter((s) => s !== sessionId)
      return
    }
    this.sessions.clear()
    this.order = []
  }
}

// ===== 草稿 =====

export interface SkillDraft {
  /** 技能 id（同时是目录名：a-z0-9-_） */
  id: string
  name: string
  /** 「何时用」—— 这是唯一的检索信号，比正文更重要 */
  description: string
  /** paths 条件触发（改这些文件时自动注入） */
  paths?: string[]
  steps: string[]
  pitfalls: string[]
  acceptance: string[]
}

/** 入参摘要：只留关键 key，截断，避免把整份文件内容写进技能 */
export function summarizeInput(input: unknown, max = 120): string {
  if (input == null) return '{}'
  let text: string
  if (typeof input === 'string') text = input
  else if (typeof input === 'object') {
    try {
      text = Object.entries(input as Record<string, unknown>)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`)
        .join(' ')
    } catch {
      text = String(input)
    }
  } else text = String(input)
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 折叠重复周期：A,B,A,B,A,B ⇒ A,B。
 *
 * 只认**完整**周期（长度能整除且每一项都对应相等），宁可少折叠也不把真实的多步流程压扁；
 * 找不到就原样返回。
 */
export function collapseCycle(entries: TraceEntry[]): TraceEntry[] {
  const n = entries.length
  if (n < 4) return entries
  const same = (a: TraceEntry, b: TraceEntry) =>
    a.toolId === b.toolId && a.ok === b.ok && a.inputSummary === b.inputSummary
  for (let k = 1; k <= Math.floor(n / 2); k += 1) {
    if (n % k !== 0) continue
    let ok = true
    for (let i = k; i < n; i += 1) {
      if (!same(entries[i]!, entries[i % k]!)) { ok = false; break }
    }
    if (ok) return entries.slice(0, k)
  }
  return entries
}

/**
 * 从工具轨迹生成技能草稿（**确定性**，不调用 LLM）。
 *
 * 刻意不接 LLM：锻造的输入是"刚刚跑通的路径"，照实记录即可；让模型再编一遍反而会
 * 引入幻觉步骤。步骤上限默认 12（超过说明这段轨迹不适合固化成一个技能）。
 */
export function draftFromTrace(
  name: string,
  trace: TraceEntry[],
  opts: { description?: string; maxSteps?: number } = {},
): SkillDraft {
  const maxSteps = opts.maxSteps ?? 12
  // 连续重复的同一调用合并成一条（模型常把同一工具连调多次）
  const collapsed: TraceEntry[] = []
  for (const e of trace) {
    const prev = collapsed[collapsed.length - 1]
    if (prev && prev.toolId === e.toolId && prev.ok === e.ok && prev.inputSummary === e.inputSummary) continue
    collapsed.push(e)
  }
  // 再折叠重复**周期**：A,B,A,B,A,B 只留一个 A,B —— 真机里模型常把同一小循环跑两遍
  // （本次 e2e 实测：list_dir → read_file 整轮重复），照抄进技能只会让步骤翻倍。
  const cycled = collapseCycle(collapsed)
  // 按「工具 + 入参」全局去重（保序）：真机里模型会把同一小循环跑多遍，且中途可能给某个
  // 参数加个开关（本次实测：read_file 时有时带 showLineNumbers）⇒ 完整周期折叠识别不出来，
  // 但"同工具同入参"的步骤本来就是同一步，保留一条即可。只去重完全相同的，不丢真实步骤。
  const seen = new Set<string>()
  const unique = cycled.filter((e) => {
    const key = `${e.toolId}|${e.inputSummary}|${e.ok}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const steps = unique
    .slice(0, maxSteps)
    .map((e, i) => `${i + 1}. 调用 \`${e.toolId}\`${e.inputSummary && e.inputSummary !== '{}' ? `（${e.inputSummary}）` : ''}`)
  const pitfalls = unique
    .filter((e) => !e.ok)
    .slice(0, 8)
    .map((e) => `- \`${e.toolId}\` 曾失败：${e.error ?? '未知原因'}`)
  const last = unique[unique.length - 1] ?? cycled[cycled.length - 1]
  const acceptance = [
    last ? `- 末步 \`${last.toolId}\` 成功返回（与本次一致）` : '- 流程可完整跑通',
    '- 关键结论/产物与本次一致（技能里记录的是路径，不是一次性结果）',
  ]
  return {
    id: name,
    name,
    description:
      opts.description?.trim() ||
      `当需要用同样的步骤完成同类任务时使用（由会话轨迹锻造：${cycled.map((e) => e.toolId).slice(0, 5).join(' → ') || '无轨迹'}）`,
    steps: steps.length ? steps : ['- （本次会话没有可记录的工具调用，请手工补充步骤）'],
    pitfalls,
    acceptance,
  }
}

/** 草稿 → 展示文本（人工确认时打印给用户的就是这份） */
export function renderDraft(draft: SkillDraft): string {
  const lines: string[] = []
  lines.push(`技能草稿：${draft.id}`)
  lines.push(`  何时用（description）：${draft.description}`)
  lines.push('')
  lines.push('## 步骤')
  for (const s of draft.steps) lines.push(s)
  if (draft.pitfalls.length) {
    lines.push('')
    lines.push('## 坑')
    for (const p of draft.pitfalls) lines.push(p)
  }
  lines.push('')
  lines.push('## 验收')
  for (const a of draft.acceptance) lines.push(a)
  return lines.join('\n')
}

/** 草稿 → Skill 对象（正文按模板拼装；allowEmbedShell 恒 false 见文件头 §3） */
export function draftToSkill(draft: SkillDraft, source: SkillSource = 'user'): Skill {
  const body: string[] = []
  body.push('## 步骤')
  body.push('')
  for (const s of draft.steps) body.push(s)
  body.push('')
  if (draft.pitfalls.length) {
    body.push('## 坑')
    body.push('')
    for (const p of draft.pitfalls) body.push(p)
    body.push('')
  }
  body.push('## 验收')
  body.push('')
  for (const a of draft.acceptance) body.push(a)
  return {
    id: draft.id,
    name: draft.name,
    description: draft.description,
    loadedFrom: source,
    content: body.join('\n'),
    userInvocable: true,
    // 见文件头 §3：锻造出来的技能不允许内嵌 shell
    allowEmbedShell: false,
    ...(draft.paths?.length ? { paths: draft.paths } : {}),
  }
}

/** 落盘前校验（模板契约：frontmatter 必填 + 长度上限） */
export function validateDraft(draft: SkillDraft): { ok: boolean; message: string } {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(draft.id)) {
    return { ok: false, message: `技能 id 非法（只允许 a-z0-9-_，1~64 字符）：${draft.id}` }
  }
  if (!draft.description.trim()) return { ok: false, message: 'description（何时用）不能为空' }
  if (draft.description.length > 300) return { ok: false, message: 'description 超过 300 字符（它是唯一检索信号，请压缩）' }
  const text = renderDraft(draft)
  if (text.length > 12_000) return { ok: false, message: `草稿过长（${text.length} 字符 > 12000），请拆成多个技能` }
  if (!draft.steps.length) return { ok: false, message: '步骤为空' }
  return { ok: true, message: 'ok' }
}

// ===== 去重（F2） =====

/** 分词：英文按词、中文按字（够用的近似，不去引分词库） */
function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  const s = text.toLowerCase()
  for (const m of s.matchAll(/[a-z0-9_]+/g)) if (m[0].length > 1) out.add(m[0])
  for (const ch of s) if (/[\u4e00-\u9fa5]/.test(ch)) out.add(ch)
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / (a.size + b.size - inter)
}

/**
 * 与已有技能做描述相似度比对：命中则提示"更新已有技能"而不是新建。
 * 阈值默认 0.5（描述都很短，太高会漏、太低会误报）。
 */
export function findSimilarSkill(
  draft: SkillDraft,
  existing: Skill[],
  threshold = 0.5,
): { skill: Skill; score: number } | undefined {
  const target = tokenize(`${draft.name} ${draft.description}`)
  let best: { skill: Skill; score: number } | undefined
  for (const s of existing) {
    if (s.id === draft.id) return { skill: s, score: 1 }
    const score = jaccard(target, tokenize(`${s.name} ${s.description}`))
    if (score >= threshold && (!best || score > best.score)) best = { skill: s, score }
  }
  return best
}

// ===== 插件 =====

export interface SkillForgePluginOptions {
  /** 默认落盘作用域（默认 user：项目级会随 git 共享） */
  scope?: 'user' | 'project'
  /** 治理：技能数量上限（默认 50），超出拒绝新建并提示先整理 */
  maxSkills?: number
  /** 草稿步骤上限（默认 12） */
  maxSteps?: number
  /** 注入 workspace（测试用；运行时走 ctx.workspace） */
  workspace?: { user: { skills: string }; project: { skills: string } }
  /** 注入 skillManager（测试用） */
  skillManager?: SkillManager
}

/** 解析命令行：取出 flag 与位置参数（`--desc "何时用"` 支持双引号） */
export function parseArgs(
  arg: string,
): { flags: Set<string>; positional: string[]; desc?: string } {
  const flags = new Set<string>()
  const positional: string[] = []
  let desc: string | undefined
  const tokens = arg.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!.replace(/^"|"$/g, '')
    if (t === '--desc') {
      desc = (tokens[i + 1] ?? '').replace(/^"|"$/g, '')
      i += 1
      continue
    }
    if (t.startsWith('-')) flags.add(t)
    else positional.push(t)
  }
  return { flags, positional, ...(desc ? { desc } : {}) }
}

/**
 * 创建技能锻造插件。
 *
 * 命令：`/skill-forge <name> [--project] [--desc "何时用"]` 出草稿；
 *       `/skill-forge --confirm <name> [--project] [--overwrite]` 落盘并当轮生效；
 *       另有 `list` / `path` / `disable <id>`。
 */
export function createSkillForgePlugin(options: SkillForgePluginOptions = {}): AgentPlugin {
  const recorder = new TraceRecorder()
  /** 待确认草稿：key = `${scope}:${id}` */
  const pending = new Map<string, { draft: SkillDraft; at: number }>()
  let manager: SkillManager | undefined = options.skillManager
  let ws = options.workspace

  const scopeOf = (flags: Set<string>): 'user' | 'project' =>
    flags.has('--project') ? 'project' : (options.scope ?? 'user')

  const ensureDirs = async (): Promise<void> => {
    if (!manager || !ws) return
    // 幂等：已加载过的目录再 load 只是一次重读；未加载过（目录可能还不存在）则登记，
    // 这样 save() 才找得到"该往哪写"
    try {
      await manager.load(ws.user.skills, 'user')
      await manager.load(ws.project.skills, 'project')
    } catch {
      /* 目录不可读时不阻断命令 */
    }
  }

  const insert = {
    // 引擎层信号：任何宿主都会触发（见文件头说明）。
    // Hooks 里这两个参数声明为 unknown（避免 plugin 包反向依赖 tool 包），
    // 运行时实际是 ToolPostHookContext{tool,input,ctx} 与 ToolResult —— 这里按契约取形状。
    'core.tool.post.execute'(hctx: unknown, result: unknown) {
      const h = hctx as { tool?: { id?: string }; input?: unknown; ctx?: { sessionId?: string } } | undefined
      const r = result as { ok?: boolean; error?: { message?: string } } | undefined
      recorder.record(h?.ctx?.sessionId ?? '', {
        toolId: h?.tool?.id ?? 'unknown',
        inputSummary: summarizeInput(h?.input),
        ok: r?.ok !== false,
        ...(r?.ok === false ? { error: r?.error?.message } : {}),
      })
    },
  }

  return {
    id: 'skill-forge',
    version: '0.1.0',
    name: 'Skill Forge',
    description:
      '技能锻造：从会话工具轨迹生成技能草稿，人工确认后落盘为 SKILL.md 并当轮生效（/skill-forge）',

    async install(ctx: PluginContext): Promise<Hooks | void> {
      ws = options.workspace ?? ctx.workspace

      const hooks: Record<string, unknown> = { ...insert }

      hooks['core.harness.init'] = (_input: unknown, output: unknown) => {
        const h = (output as { harness?: { skillManager?: SkillManager } } | undefined)?.harness
        if (h?.skillManager) manager = h.skillManager
        void ensureDirs()
      }

      hooks['cli.commands'] = (input: { commands: Array<{ command: string; description: string; usage: string }> }) => {
        input.commands.push({
          command: 'skill-forge',
          description: '技能锻造：把本次跑通的流程固化为技能（草稿 → 确认 → 落盘）',
          usage: '/skill-forge <name> [--project] [--desc "何时用"] · --confirm <name> · list · path · disable <id>',
        })
      }

      hooks['cli.command'] = (input: CliCommandInput) => {
        if (input.command !== 'skill-forge') return
        input.result = 'continue'
        const out = input.out
        const { flags, positional, desc } = parseArgs(input.arg ?? '')

        // ---- path：打印两级技能目录 ----
        if (positional[0] === 'path') {
          out(
            `技能目录\n` +
              `  用户级  ${ws?.user.skills ?? '(未知)'}\n` +
              `  项目级  ${ws?.project.skills ?? '(未知)'}\n`,
          )
          return
        }

        // ---- list：已有技能 + 治理上限 ----
        if (positional[0] === 'list') {
          if (!manager) { out('未获得 skillManager（技能系统未装配）\n'); return }
          const all = manager.all()
          const max = options.maxSkills ?? 50
          out(
            `\n技能清单（${all.length} 个 / 上限 ${max}）\n` +
              all
                .slice(0, 50)
                .map((s) => `  ${s.id.padEnd(28)} [${s.loadedFrom}] ${s.description.slice(0, 60)}`)
                .join('\n') +
              (all.length ? '\n' : '  （空）\n') +
              (pending.size ? `  待确认草稿：${Array.from(pending.keys()).join('、')}\n` : ''),
          )
          return
        }

        // ---- disable <id>：治理用禁用而非删除 ----
        if (positional[0] === 'disable') {
          const id = positional[1]
          if (!id) { out('用法：/skill-forge disable <id>\n'); return }
          if (!manager) { out('未获得 skillManager（技能系统未装配）\n'); return }
          out(manager.disable(id) ? `✅ 已禁用技能 ${id}（未删除文件，可用 /skills enable 恢复）\n` : `⚠️  未找到技能 ${id}\n`)
          return
        }

        const name = positional[0]
        if (!name) {
          out(
            '用法：\n' +
              '  /skill-forge <name> [--project] [--desc "何时用"]   生成草稿（仅展示，不落盘）\n' +
              '  /skill-forge --confirm <name> [--project] [--overwrite]   确认落盘并当轮生效\n' +
              '  /skill-forge list | path | disable <id>\n',
          )
          return
        }
        if (!manager) { out('未获得 skillManager（技能系统未装配）\n'); return }

        const scope = scopeOf(flags)
        const key = `${scope}:${name}`

        // ---- 确认落盘 ----
        if (flags.has('--confirm') || flags.has('-y')) {
          const held = pending.get(key)
          if (!held) { out(`⚠️  没有待确认的草稿 ${key}，请先运行 /skill-forge ${name}${scope === 'project' ? ' --project' : ''}\n`); return }
          const check = validateDraft(held.draft)
          if (!check.ok) { out(`⚠️  草稿未通过校验：${check.message}\n`); return }
          const limit = options.maxSkills ?? 50
          if (manager.all().length >= limit && !flags.has('--overwrite')) {
            out(`⚠️  技能数已达上限 ${limit}（治理）：请先整理或禁用不用的技能\n`)
            return
          }
          void (async () => {
            await ensureDirs()
            const res = await manager!.save(draftToSkill(held.draft, scope), {
              scope,
              ...(flags.has('--overwrite') ? { overwrite: true } : {}),
            })
            if (res.ok) {
              pending.delete(key)
              out(`✅ ${res.message}\n   调用方式：/${name}（或命中 paths 时自动注入）\n`)
            } else {
              out(`⚠️  ${res.message}\n`)
            }
          })()
          return
        }

        // ---- 生成草稿（不落盘）----
        const trace = recorder.list(input.sessionId ?? '')
        const draft = draftFromTrace(name, trace, {
          ...(desc ? { description: desc } : {}),
          ...(options.maxSteps != null ? { maxSteps: options.maxSteps } : {}),
        })
        pending.set(key, { draft, at: Date.now() })
        const similar = findSimilarSkill(draft, manager.all())
        out(
          `\n${renderDraft(draft)}\n\n` +
            `落盘位置：${scope === 'project' ? ws?.project.skills : ws?.user.skills ?? '(未知)'}/${name}/SKILL.md` +
            `（${scope} 级${scope === 'project' ? '，会随 git 共享' : ''}）\n` +
            (similar
              ? `⚠️  与已有技能 ${similar.skill.id} 相似（${similar.score.toFixed(2)}）：建议改为更新它，或换个更具体的名字\n`
              : '') +
            `确认无误后执行：/skill-forge --confirm ${name}${scope === 'project' ? ' --project' : ''}\n` +
            `（可加 --overwrite 覆盖同名；${trace.length} 条轨迹参与生成）\n`,
        )
      }

      return hooks as Hooks
    },
  }
}
