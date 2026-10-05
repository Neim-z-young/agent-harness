/**
 * `@harness/planning-files` —— 文件化持久规划插件
 *
 * 把上游 [planning-with-files](https://github.com/OthmanAdi/planning-with-files) 的
 * 「三文件持久化规划」搬成本仓的插件形态：**计划放磁盘（`.planning/`），每轮经
 * `core.session.preModel` 注入到消息尾部**，跨会话 / 压缩 / 崩溃存活。
 *
 * ## 三条设计约束（都有理由，别顺手改）
 *
 * 1. **注入走 tail、不落历史**（设计稿 D1）。`preModel` 里往 messages 尾部 push 一条
 *    user 消息，**不调 `input.save()`** —— 本轮请求用完即弃。历史前缀因此纹丝不动，
 *    每轮只为「计划块 + 新消息」付 prefill。
 * 2. **注入文本逐字稳定**（D8）。签名（三文件 size+mtime）不变就复用上轮文本，
 *    否则「计划块 → 新消息」这段每轮失配，尾部注入省下的缓存又赔回去。
 * 3. **改计划不 attest ⇒ 注入被拒**（D4）。纯工具模式下拦不住写盘，能做的是"区分已批准
 *    改动与未批准改动"：不匹配时只注入 `[PLAN TAMPERED]` 告警行、**不注入计划正文**。
 *    这是纪律，不是安全机制 —— 目的是逼出"改完重新认证"这个动作。
 *
 * ## 与设计稿的一处有意偏离
 * 设计稿的阶段二列了 `core.session.compacting`（压缩前把 progress 尾部 flush 到盘）。
 * **本实现不注册该 hook**：上游要它是因为它在内存里攒了 progress 缓冲条目，不 flush 会随
 * 压缩丢掉；而本插件的三文件**始终直接在盘上**（模型用 `write_file` 写），每轮又都注入计划块
 * ⇒ 压缩既不会丢文件、也不会让模型失去计划可见性，flush 无事可做。写空转 hook 只会
 * 制造"看起来对齐了上游"的假象。
 *
 * ## 阶段四（增强）四项落在哪
 * | 项 | 落点 | 说明 |
 * |---|---|---|
 * | parallel-write guard | `plan-files.ts#detectProgressRegression` | 认证时记进度快照，完成项数下降才报（降级版，不是文件锁） |
 * | 多计划 | `plan-files.ts#listPlans` + `/plan list` `/plan use` | `.active_plan` 完整支持 + 切到不存在的名字时用模板建起来 |
 * | catchup | `catchup.ts` + `/plan-catchup` | 显式触发、marker 幂等，读 `dataDir/sessions/<sid>.json` |
 * | gated 提示 | `plan-block.ts#gatedLine` | 注入块多一行"未完成阶段 N 个（…），勿提前宣布完成" |
 *
 * @example
 * // config.json → plugins: ["planning-files"]
 * createHarness({ internalPlugins: [createPlanningFilesPlugin()] })
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentPlugin, CliCommandInput, CliCommandsInput, Hooks } from '@harness/plugin'
import { buildCatchup, hasCatchup, readSessionFile } from './catchup'
import { buildPlanBlock, resolveInjectedBlock, type InjectCache, type PlanInjectMode } from './plan-block'
import {
  ATTEST_FILE_NAME,
  attestPlan,
  detectProgressRegression,
  displayPlanPath,
  ensurePlanFiles,
  hashPlan,
  listPlans,
  parsePlan,
  planFileStatus,
  planInitialized,
  readActivePlan,
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
import skillContent from './prompts/planning-files-skill.txt'

export * from './plan-files'
export * from './plan-block'
export * from './catchup'

/** 插件选项 */
export interface PlanningFilesPluginOptions {
  /** 项目根（缺省取 `ctx.workspace.cwd`，再缺省 `process.cwd()`） */
  cwd?: string
  /** 计划目录绝对路径（缺省 `<cwd>/.planning`） */
  planDir?: string
  /**
   * 数据根（缺省取 `ctx.workspace.dataDir`）—— 只被 `/plan-catchup` 用来定位会话文件
   * （`<dataDir>/sessions/<sessionId>.json`）。故意不做"从 cwd 猜"的兜底：
   * 猜错只会读到别的项目的会话，比明确报"找不到"更糟。
   */
  dataDir?: string
  /** 注入模式：`smart`（默认，只给目标/当前阶段/下一步/完成度）| `full`（附阶段明细） */
  mode?: PlanInjectMode
  /** 注入块字符预算（缺省 1200） */
  maxChars?: number
  /** `false` ⇒ 只保留命令与 skill，不做注入 */
  inject?: boolean
  /** `true` ⇒ 子会话也注入（默认只在主会话注入 —— 子 agent 不该各自背一份计划） */
  includeSubagents?: boolean
}

/** `/plan` 的子动作（只在命令名后的**首个** token 上识别） */
export type PlanSubcommand = 'use' | 'list' | 'catchup'

export interface PlanArgs {
  flags: string[]
  use?: string
  text: string
  sub?: PlanSubcommand
}

const PLAN_SUBCOMMANDS: readonly PlanSubcommand[] = ['use', 'list', 'catchup']

/**
 * 把命令行里的 `""` / `''` 认成空串。
 *
 * 命令层拿到的是**原始行**（没有 shell 拆词），所以 `/plan use ""` 里的引号会原样进来。
 * 不做这一步，`""` 就成了一个"名字是两个引号的计划"——非法 slug，直接抛错。
 * 顺带修掉了既有的一处空转：文档里一直写着 `--use ""` 可清除指针，但因为同样的原因，
 * 它实际从来没生效过（会被当成非法 slug 拒绝）。
 */
function unquote(token: string): string {
  return token === '""' || token === "''" ? '' : token
}

/**
 * 命令入参解析（`--flag` / `--use <slug>` / 子动作 / 其余文本）。
 *
 * 子动作**只认首个 token**：`/plan use task-b` 是切换计划，而 `/plan 把 use 命令做完`
 * 里的 `use` 只是普通词 —— 若在整个 token 流里扫关键字，第二句会被解析成切换，把
 * 用户的目标文本吃掉。这个边界必须有，且是"位置"而不是"内容"决定的。
 */
export function parsePlanArgs(raw: string): PlanArgs {
  const tokens = raw.trim().split(/\s+/).slice(1)
  let sub: PlanSubcommand | undefined
  const first = tokens[0]
  if (first !== undefined && (PLAN_SUBCOMMANDS as readonly string[]).includes(first)) {
    sub = tokens.shift() as PlanSubcommand
  }
  const flags: string[] = []
  const textParts: string[] = []
  let use: string | undefined
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? ''
    if (t === '--use' || t === '-u') {
      const v = tokens[++i]
      if (v !== undefined) use = unquote(v)
      continue
    }
    if (t.startsWith('--')) {
      flags.push(t.slice(2))
      continue
    }
    textParts.push(t)
  }
  // `/plan use <slug>`：子动作形式的目标名（flags 已被摘走，剩下的首 token 就是 slug）
  if (sub === 'use' && use === undefined && textParts.length > 0) use = unquote(textParts.shift() as string)
  const out: PlanArgs = { flags, text: textParts.join(' ') }
  if (use !== undefined) out.use = use
  if (sub !== undefined) out.sub = sub
  return out
}

const HELP = [
  '用法：',
  '  /plan [目标]        初始化三文件（.planning/）并展示；有目标时写入 Goal',
  '  /plan --force       用模板覆盖已有三文件（**会丢内容**）',
  '  /plan list          列出所有计划（▶ 标记当前活动计划）',
  '  /plan use <名>      切换多计划；`/plan use ""` 回落到默认计划；无参则只展示',
  '  /plan-status        阶段 / 完成度 / 下一步 / 认证 / 进度回退',
  '  /plan-attest        锁定当前 task_plan.md 的哈希（--clear 清除）',
  '  /plan-doctor        自检（文件 / 解析 / 认证 / 注入 / 多计划）',
  '  /plan-catchup       把本会话历史汇总进 progress.md（显式触发、幂等）',
  '  /plan-complete      完成度与收尾提示',
].join('\n')

/**
 * 切换活动计划（`/plan use <名>` 与 `/plan --use <名>` 共用）。
 *
 * 切到一个**还不存在**的计划名时顺手用模板把它建起来，而不是报"没有这个计划"：
 * 多计划的用法就是"开一条并行任务线"，先建后填才是顺手的顺序；反过来要求用户
 * 先手动建目录再切换，只会让人放弃用多计划。建了什么、建了几个都写在输出里，
 * 不做静默副作用。
 */
function applyActivePlan(planDir: string, cwd: string, slug: string): string {
  if (slug === '') {
    setActivePlan(planDir, '')
    return `已回落到默认计划（${displayPlanPath(cwd, planDir)} 根）。\n`
  }
  setActivePlan(planDir, slug) // 非法 slug 在此抛错 ⇒ 命令层兜住并输出原因
  const root = join(planDir, slug)
  const r = ensurePlanFiles(root)
  const parsed = parsePlan(readPlanFiles(root)['task_plan.md'])
  const how = r.created.length === 0 ? '已存在' : r.existed.length === 0 ? '新建' : '补齐'
  return `已切换到计划 ${slug}（${how} ${r.created.length} 个文件，${parsed.doneCount}/${parsed.totalCount} 条完成）。\n`
}

/**
 * 创建 planning-files 插件。
 *
 * 依赖注入刻意留了两个口子（`planDir` / `cwd`）：宿主不一定是 CLI（A2A server、
 * 编辑器扩展、单测），而 `ctx.workspace` 在非 CLI 宿主下可能缺省 —— 缺省时回退
 * `process.cwd()`，同时允许调用方显式指定，避免"猜路径"。
 */
export function createPlanningFilesPlugin(options: PlanningFilesPluginOptions = {}): AgentPlugin {
  /** 注入块缓存（签名 → 文本）。每插件实例一份 —— 与服务端的会话无关，纯文本复用 */
  const cache: InjectCache = {}
  let resolvedCwd = options.cwd ?? ''
  let planDir = options.planDir ?? ''
  let dataDir = options.dataDir ?? ''
  let warnEmitted = false

  const ensurePaths = (ctx: { workspace?: { cwd: string; dataDir?: string } }): void => {
    if (resolvedCwd === '') resolvedCwd = options.cwd ?? ctx.workspace?.cwd ?? process.cwd()
    if (planDir === '') planDir = options.planDir ?? resolvePlanDir(resolvedCwd)
    // dataDir 没有"猜"的兜底：拿不到就是拿不到，/plan-catchup 会明确报"无法定位会话文件"
    if (dataDir === '') dataDir = options.dataDir ?? ctx.workspace?.dataDir ?? ''
  }

  const injectEnabled = options.inject !== false
  const mode: PlanInjectMode = options.mode ?? 'smart'
  const maxChars = options.maxChars

  return {
    id: 'planning-files',
    version: '0.1.0',
    name: 'Planning Files',
    description: '文件化持久规划：计划放 .planning/ 三文件，每轮尾部注入（跨会话/压缩/崩溃存活）',

    async install(ctx) {
      ensurePaths(ctx)

      return {
        // ---- 每轮注入（tail、不落历史） ----
        'core.session.preModel'(input, rawMessages) {
          if (!injectEnabled) return
          // 子 agent 不注入：一个 plan 是"这条任务线"的，不是每个侦察兵的
          if (options.includeSubagents !== true && input.parentSessionId !== undefined) return
          try {
            const root = resolvePlanRoot(planDir)
            if (!planInitialized(root)) return
            const planPath = displayPlanPath(resolvedCwd, `${root}/task_plan.md`)
            const blockOptions = { mode, planPath, ...(maxChars === undefined ? {} : { maxChars }) }
            const resolved = resolveInjectedBlock(cache, root, blockOptions, (opts) => {
              const files = readPlanFiles(root)
              return buildPlanBlock({ parsed: parsePlan(files['task_plan.md']), verdict: verifyAttestation(root), options: opts })
            })
            if (resolved.text === undefined) return
            ;(rawMessages as Array<Record<string, unknown>>).push({
              id: `plan_${input.sessionId}_${Date.now()}`,
              role: 'user',
              parts: [{ type: 'text', text: resolved.text }],
              createdAt: Date.now(),
            })
          } catch (e) {
            // 注入路径不该让整轮失败：降级为"不注入"并只警告一次
            if (!warnEmitted) {
              warnEmitted = true
              ctx.log.warn(`planning-files 注入失败（本会话后续不再重复告警）：${e instanceof Error ? e.message : String(e)}`)
            }
          }
        },

        // ---- 命令 ----
        'cli.commands'(input: CliCommandsInput) {
          input.commands.push(
            { command: 'plan', description: '初始化/展示文件化计划（.planning/ 三文件）', usage: '/plan [目标] [--force] | /plan list | /plan use <名>' },
            { command: 'plan-status', description: '计划阶段 / 完成度 / 下一步 / 认证', usage: '/plan-status' },
            { command: 'plan-attest', description: '锁定计划哈希（改动计划后必须重新认证）', usage: '/plan-attest [--clear]' },
            { command: 'plan-doctor', description: '计划自检（文件 / 解析 / 认证 / 注入 / 多计划）', usage: '/plan-doctor' },
            { command: 'plan-catchup', description: '把本会话历史汇总进 progress.md（幂等）', usage: '/plan-catchup' },
            { command: 'plan-complete', description: '计划完成度与收尾提示', usage: '/plan-complete' },
          )
        },

        async 'cli.command'(input: CliCommandInput) {
          if (!input.command.startsWith('plan')) return
          const out = input.out
          const args = parsePlanArgs(input.raw)
          try {
            switch (input.command) {
              case 'plan': {
                if (args.sub === 'list') {
                  out(`${renderPlanList(listPlans(planDir))}\n`)
                  break
                }
                if (args.sub === 'use' && args.use === undefined) {
                  // 无参只展示、不改状态：误敲 `/plan use` 不该把活动计划清掉
                  out(`当前活动计划：${readActivePlan(planDir) ?? '（默认）'}\n\n${renderPlanList(listPlans(planDir))}\n`)
                  out('切换：/plan use <名>；回落默认：/plan use ""\n')
                  break
                }
                if (args.use !== undefined) out(applyActivePlan(planDir, resolvedCwd, args.use))
                const root = resolvePlanRoot(planDir)
                const force = args.flags.includes('force')
                const r = ensurePlanFiles(root, { force })
                if (args.text !== '') {
                  // 只改 Goal 那一段，其它内容保留
                  writePlanFile(root, 'task_plan.md', replaceGoal(readPlanFiles(root)['task_plan.md'], args.text))
                }
                out(`计划目录：${displayPlanPath(resolvedCwd, root)}\n`)
                out(`新建 ${r.created.length} 个 / 已存在 ${r.existed.length} 个文件${force ? '（--force 覆盖）' : ''}\n\n`)
                out(`${renderPlanSummary(parsePlan(readPlanFiles(root)['task_plan.md']))}\n\n`)
                out('下一步：把阶段与条目填进 task_plan.md（write_file），**改完运行 /plan-attest**。\n')
                out(`建议把 ${displayPlanPath(resolvedCwd, planDir)}/ 加进 .gitignore（计划是本地状态，不是产物）。\n`)
                break
              }

              case 'plan-status': {
                const root = resolvePlanRoot(planDir)
                if (!planInitialized(root)) {
                  out(`尚无计划（${displayPlanPath(resolvedCwd, root)}/task_plan.md 不存在）。先运行 /plan <目标>。\n`)
                  break
                }
                const parsed = parsePlan(readPlanFiles(root)['task_plan.md'])
                out(`${renderPlanSummary(parsed)}\n\n`)
                if (readActivePlan(planDir) !== undefined) out(`活动计划：${readActivePlan(planDir)}（/plan list 看全部）\n`)
                const v = verifyAttestation(root)
                out(
                  v.status === 'ok'
                    ? `认证：${shortHash(v.approved ?? v.current)}（已认证）\n`
                    : v.status === 'missing'
                      ? '认证：未认证（运行 /plan-attest 锁定当前版本）\n'
                      : `认证：**不一致** —— 已认证 ${shortHash(v.approved ?? '')} / 当前 ${shortHash(v.current)}\n         下一轮注入将只给 [PLAN TAMPERED] 告警，计划正文不注入\n`,
                )
                const reg = detectProgressRegression(parsed, v)
                if (reg !== undefined) {
                  out(
                    `⚠️ 进度回退：已认证时 ${reg.approvedChecked} 条完成，现在只有 ${reg.currentChecked} 条（少 ${reg.dropped} 条）。\n` +
                      '         典型原因是并发会话各写各的、后写覆盖先写。核对无误后 /plan-attest 重新认证。\n',
                  )
                }
                const pending = unfinishedPhases(parsed)
                if (pending.length > 0) out(`未完成阶段：${pending.length} 个（${pending.map((p) => (p.index === 0 ? p.title : `Phase ${p.index}`)).join('、')}）\n`)
                break
              }

              case 'plan-attest': {
                const root = resolvePlanRoot(planDir)
                if (args.flags.includes('clear')) {
                  // 只删认证记录，**不碰计划文件**（--clear 不该有改内容的副作用）
                  mkdirSync(root, { recursive: true })
                  rmSync(join(root, ATTEST_FILE_NAME), { force: true })
                  out('已清除认证记录（计划将回到"未认证"状态）。\n')
                  break
                }
                if (!planInitialized(root)) {
                  out(`尚无计划可认证（${displayPlanPath(resolvedCwd, root)}/task_plan.md 不存在）。\n`)
                  break
                }
                const rec = attestPlan(root)
                out(`已认证：${shortHash(rec.hash)}  ← ${displayPlanPath(resolvedCwd, `${root}/task_plan.md`)}\n`)
                out('此后该文件被改动（而未经重新认证）时，注入块会变成 [PLAN TAMPERED] 且不含计划正文。\n')
                break
              }

              case 'plan-doctor': {
                const root = resolvePlanRoot(planDir)
                const status = planFileStatus(root)
                const lines: string[] = ['计划自检：']
                lines.push(`  项目根：${resolvedCwd}`)
                lines.push(`  计划目录：${displayPlanPath(resolvedCwd, root)}${readActivePlan(planDir) === undefined ? '' : `（活动计划 ${readActivePlan(planDir)}）`}`)
                for (const s of status) lines.push(`  ${s.exists ? '✅' : '❌'} ${s.name}${s.exists ? `（${s.bytes} 字节）` : ' —— 缺失，运行 /plan'}`)
                const md = readPlanFiles(root)['task_plan.md']
                const parsed = parsePlan(md)
                lines.push(`  解析：${parsed.totalCount > 0 ? `✅ ${parsed.phases.length} 个阶段 / ${parsed.totalCount} 条` : '⚠️ 没有条目（task_plan.md 还是模板）'}`)
                const v = verifyAttestation(root)
                lines.push(
                  `  认证：${v.status === 'ok' ? `✅ ${shortHash(v.approved ?? '')}` : v.status === 'missing' ? '⚠️ 未认证（/plan-attest）' : `❌ 不一致（已认证 ${shortHash(v.approved ?? '')} / 当前 ${shortHash(v.current)}）`}`,
                )
                lines.push(`  注入：${injectEnabled ? `✅ 开启（mode=${mode}${maxChars === undefined ? '' : `, maxChars=${maxChars}`}）` : '⏸ 已关闭（options.inject=false）'}`)
                lines.push(`  注入缓存：${cache.sig === undefined ? '（尚未构建）' : `sig=${cache.sig.slice(0, 8)}… / ${cache.block === undefined ? '无文本' : `${cache.block.length} 字符`}`}`)
                lines.push(`  内容哈希：${hashPlan(root).slice(0, 8)}…（task_plan.md）`)
                const all = listPlans(planDir)
                lines.push(`  多计划：${readActivePlan(planDir) === undefined ? '默认计划' : `活动 ${readActivePlan(planDir)}`}（共 ${all.length} 个，/plan list 查看）`)
                const reg = detectProgressRegression(parsed, v)
                lines.push(
                  `  进度守卫：${reg === undefined ? '✅ 无回退' : `⚠️ 回退 ${reg.dropped} 条（认证时 ${reg.approvedChecked} → 现在 ${reg.currentChecked}）`}`,
                )
                lines.push(
                  `  catchup：${hasCatchup(readPlanFiles(root)['progress.md'], input.sessionId) ? '✅ 本会话已汇总进 progress.md' : '（本会话尚未 /plan-catchup）'}`,
                )
                out(`${lines.join('\n')}\n`)
                break
              }

              case 'plan-catchup': {
                const root = resolvePlanRoot(planDir)
                if (!planInitialized(root)) {
                  out('尚无计划。先运行 /plan <目标>。\n')
                  break
                }
                const sessionId = input.sessionId
                const progressMd = readPlanFiles(root)['progress.md']
                if (hasCatchup(progressMd, sessionId)) {
                  out(`本会话（${sessionId}）已 catchup 过，跳过（progress.md 里有标记）。\n`)
                  break
                }
                if (dataDir === '') {
                  out('无法定位会话文件：宿主未提供 dataDir（可用 options.dataDir 显式指定）。\n')
                  break
                }
                const found = readSessionFile(dataDir, sessionId)
                if (found === undefined) {
                  out(`找不到会话文件（${displayPlanPath(resolvedCwd, join(dataDir, 'sessions', `${sessionId}.json`))}），无法汇总。\n`)
                  break
                }
                const caught = buildCatchup(progressMd, sessionId, found.file.messages ?? [], {
                  ...(found.file.title === undefined ? {} : { title: found.file.title }),
                  source: displayPlanPath(resolvedCwd, found.path),
                })
                if (caught.skipped) {
                  out('已有本会话的 catchup 记录，跳过。\n')
                  break
                }
                writePlanFile(root, 'progress.md', caught.md)
                out(`已把 ${caught.extract.turns.length} 轮汇总进 progress.md${caught.extract.dropped > 0 ? `（更早 ${caught.extract.dropped} 轮未收录）` : ''}。\n`)
                break
              }

              case 'plan-complete': {
                const root = resolvePlanRoot(planDir)
                if (!planInitialized(root)) {
                  out('尚无计划。先运行 /plan <目标>。\n')
                  break
                }
                const parsed = parsePlan(readPlanFiles(root)['task_plan.md'])
                if (parsed.totalCount === 0) {
                  out('计划里还没有条目（task_plan.md 尚未填写）。\n')
                  break
                }
                const pending = unfinishedPhases(parsed)
                out(`完成度：${parsed.doneCount}/${parsed.totalCount}（未完成阶段 ${pending.length} 个）\n`)
                if (parsed.complete) {
                  out('✅ 全部条目已完成 —— 可以收尾：确认验证做过（typecheck / test / 反向验证）后写 progress.md 收尾行。\n')
                } else {
                  out(`尚有 ${parsed.totalCount - parsed.doneCount} 条未完成（分布在 ${pending.length} 个阶段）：\n`)
                  for (const p of parsed.phases) {
                    for (const it of p.items) if (!it.done) out(`  - [ ] ${it.text}\n`)
                  }
                  out('未完成前不要宣称任务结束。\n')
                }
                break
              }

              default:
                out(`${HELP}\n`)
            }
          } catch (e) {
            out(`planning-files 命令失败：${e instanceof Error ? e.message : String(e)}\n`)
          }
        },

        // ---- Skill（plugin 来源：指导模型怎么维护三文件） ----
        'core.harness.init'(_input, output) {
          const harness = (output as { harness?: unknown }).harness as
            | { skillManager?: { register: (s: Record<string, unknown>) => void } }
            | undefined
          if (harness?.skillManager === undefined) return
          harness.skillManager.register({
            id: 'planning-files',
            name: 'Planning Files',
            description: '文件化持久规划：.planning/ 三文件（task_plan / findings / progress）的维护指南',
            loadedFrom: 'plugin',
            content: skillContent.trim(),
            userInvocable: true,
          })
        },
      } as Hooks
    },
  }
}

/** 默认导出（`plugins: ["planning-files"]` 与外部插件目录两种装配方式都能取到） */
export default createPlanningFilesPlugin
/** SKILL 正文（供测试与宿主检查注册内容） */
export { skillContent as planningFilesSkillContent }
