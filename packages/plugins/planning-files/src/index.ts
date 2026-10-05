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
 * @example
 * // config.json → plugins: ["planning-files"]
 * createHarness({ internalPlugins: [createPlanningFilesPlugin()] })
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentPlugin, CliCommandInput, CliCommandsInput, Hooks } from '@harness/plugin'
import { buildPlanBlock, resolveInjectedBlock, type InjectCache, type PlanInjectMode } from './plan-block'
import {
  ATTEST_FILE_NAME,
  PLAN_FILE_NAMES,
  attestPlan,
  displayPlanPath,
  ensurePlanFiles,
  hashPlan,
  isValidPlanSlug,
  parsePlan,
  planFileStatus,
  planInitialized,
  readActivePlan,
  readAttestation,
  readPlanFiles,
  renderPlanSummary,
  replaceGoal,
  resolvePlanDir,
  resolvePlanRoot,
  setActivePlan,
  shortHash,
  verifyAttestation,
  writePlanFile,
} from './plan-files'
import skillContent from './prompts/planning-files-skill.txt'

export * from './plan-files'
export * from './plan-block'

/** 插件选项 */
export interface PlanningFilesPluginOptions {
  /** 项目根（缺省取 `ctx.workspace.cwd`，再缺省 `process.cwd()`） */
  cwd?: string
  /** 计划目录绝对路径（缺省 `<cwd>/.planning`） */
  planDir?: string
  /** 注入模式：`smart`（默认，只给目标/当前阶段/下一步/完成度）| `full`（附阶段明细） */
  mode?: PlanInjectMode
  /** 注入块字符预算（缺省 1200） */
  maxChars?: number
  /** `false` ⇒ 只保留命令与 skill，不做注入 */
  inject?: boolean
  /** `true` ⇒ 子会话也注入（默认只在主会话注入 —— 子 agent 不该各自背一份计划） */
  includeSubagents?: boolean
}

/** 命令入参解析（`--flag` / `--use <slug>` / 其余文本） */
export function parsePlanArgs(raw: string): { flags: string[]; use?: string; text: string } {
  const tokens = raw.trim().split(/\s+/).slice(1)
  const flags: string[] = []
  const textParts: string[] = []
  let use: string | undefined
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? ''
    if (t === '--use' || t === '-u') {
      use = tokens[++i]
      continue
    }
    if (t.startsWith('--')) {
      flags.push(t.slice(2))
      continue
    }
    textParts.push(t)
  }
  const out: { flags: string[]; use?: string; text: string } = { flags, text: textParts.join(' ') }
  if (use !== undefined) out.use = use
  return out
}

const HELP = [
  '用法：',
  '  /plan [目标]        初始化三文件（.planning/）并展示；有目标时写入 Goal',
  '  /plan --force       用模板覆盖已有三文件（**会丢内容**）',
  '  /plan --use <名>    切换多计划（写 .active_plan；`--use ""` 清除）',
  '  /plan-status        阶段 / 完成度 / 下一步',
  '  /plan-attest        锁定当前 task_plan.md 的哈希（--clear 清除）',
  '  /plan-doctor        自检（文件 / 解析 / 认证 / 注入）',
  '  /plan-complete      完成度与收尾提示',
].join('\n')

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
  let warnEmitted = false

  const ensurePaths = (ctx: { workspace?: { cwd: string } }): void => {
    if (resolvedCwd === '') resolvedCwd = options.cwd ?? ctx.workspace?.cwd ?? process.cwd()
    if (planDir === '') planDir = options.planDir ?? resolvePlanDir(resolvedCwd)
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
            { command: 'plan', description: '初始化/展示文件化计划（.planning/ 三文件）', usage: '/plan [目标] [--force] [--use <名>]' },
            { command: 'plan-status', description: '计划阶段 / 完成度 / 下一步', usage: '/plan-status' },
            { command: 'plan-attest', description: '锁定计划哈希（改动计划后必须重新认证）', usage: '/plan-attest [--clear]' },
            { command: 'plan-doctor', description: '计划自检（文件 / 解析 / 认证 / 注入）', usage: '/plan-doctor' },
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
                if (args.use !== undefined) {
                  setActivePlan(planDir, args.use)
                  out(`已切换活动计划：${args.use === '' ? '（回落到 .planning/ 根）' : args.use}\n`)
                }
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
                out(`${renderPlanSummary(parsePlan(readPlanFiles(root)['task_plan.md']))}\n\n`)
                const v = verifyAttestation(root)
                out(
                  v.status === 'ok'
                    ? `认证：${shortHash(v.approved ?? v.current)}（已认证）\n`
                    : v.status === 'missing'
                      ? '认证：未认证（运行 /plan-attest 锁定当前版本）\n'
                      : `认证：**不一致** —— 已认证 ${shortHash(v.approved ?? '')} / 当前 ${shortHash(v.current)}\n         下一轮注入将只给 [PLAN TAMPERED] 告警，计划正文不注入\n`,
                )
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
                out(`${lines.join('\n')}\n`)
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
                out(`完成度：${parsed.doneCount}/${parsed.totalCount}\n`)
                if (parsed.complete) {
                  out('✅ 全部条目已完成 —— 可以收尾：确认验证做过（typecheck / test / 反向验证）后写 progress.md 收尾行。\n')
                } else {
                  out(`尚有 ${parsed.totalCount - parsed.doneCount} 条未完成：\n`)
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
