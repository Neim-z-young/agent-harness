/**
 * 「用什么跑 sidecar」的解析（纯模块，**不 import vscode**）。
 *
 * 为什么单独一个文件：`extension.ts` 里那版混着 `vscode.workspace.getConfiguration`，
 * 只能在真扩展里跑；抽成纯函数后优先级顺序可单测（顺序错了就是"本机好好的、别人那里
 * spawn 不到"这类最难查的问题）。
 *
 * ## 进程边界（设计稿 §3.1）
 * harness 是 **Bun**、extension host 是 **Node** —— 这条边界躲不掉，只是「跑什么」有别：
 *   1. **编译好的单文件二进制**（P3-A）：自包含，不依赖 bun 在 PATH、不依赖仓库
 *      node_modules，冷启动最快；
 *   2. 仓库里的 TS 入口 + bun：开发态（改代码即生效），但要能找到 bun；
 *   3. PATH 上的 `harness`：兜底。
 *
 * ## 分发策略是 A3：扩展**不带**二进制
 * 所以路径 2 是发布态的主力，**"能不能找到 bun"就是这个扩展的可用性本身**。
 * 探测在 `bun.ts`（同样纯模块、单独一套测试），这里只消费它的结果：
 * `bun === undefined` 表示没找到 —— 此时**不能**选一条跑不起来的路线（见下）。
 *
 * ## 优先级
 * 显式配置 > 工作区内的编译二进制 > 工作区内的 TS 入口（配 bun）> PATH 上的 `harness`。
 *
 * 显式配置**两条**（`harness.sidecarPath` 二进制 / `harness.cliPath` 入口）并存而不是合并成
 * 一条：两者 runner 规则不同（`.ts` 才要 bun），合成一条就得靠后缀猜，出错了更难解释。
 */

/** 本仓布局下 `build:sidecar` 的产出路径（相对工作区根） */
export const SIDECAR_BINARY_RELPATH = 'packages/cli/dist/harness-a2a'

/** 本仓布局下 CLI 的 TS 入口（相对工作区根） */
export const CLI_ENTRY_RELPATH = 'packages/cli/src/index.ts'

export interface LaunchInput {
  /** 工作区根目录（harness 的 cwd） */
  readonly cwd: string
  /** 配置 `harness.sidecarPath`：显式指定的可执行文件（通常是编译二进制） */
  readonly sidecarPath?: string
  /** 配置 `harness.cliPath`：显式指定的 CLI 入口（`.ts` 需配 bun） */
  readonly cliPath?: string
  /** Bearer token；留空则匿名 */
  readonly token?: string
  /**
   * bun 可执行文件路径（`bun.ts` 的 `resolveBun` 产出）。
   *
   * `undefined` = 没找到。纯模块不自己做 PATH 探测 —— 探测各归各的文件，
   * 这里只消费结论。
   */
  readonly bun: string | undefined
  /** 存在性判断（注入：单测里可控，真环境用 `fs.existsSync`） */
  readonly exists: (path: string) => boolean
}

export interface LaunchOptions {
  readonly cliPath: string
  /** 用什么跑 `.ts` 入口；可执行文件本身则留空 */
  readonly runner?: string
  readonly cwd: string
  readonly token?: string
  /**
   * 降级说明（人读）：为什么没走某条路线。
   *
   * 存在的理由：A3 下"找不到 bun"是**最可能的失败**，而它的表现往往只是
   * 一句 spawn ENOENT。把决策链路写进输出通道，等于把排查成本从"猜环境"
   * 降到"看一眼"。
   */
  readonly notes: readonly string[]
}

function trim(v: string | undefined): string {
  return (v ?? '').trim()
}

/** 非空的 token 才传（空串会让 CLI 以为要匿名却带了个空值） */
function tokenOf(input: LaunchInput): string | undefined {
  const t = trim(input.token)
  return t === '' ? undefined : t
}

/**
 * `.ts` 目标要配 bun。
 *
 * 显式配置**照用不误**（尊重用户的选择），但把"没有 bun"说清楚 ——
 * 静默换一条别的路线，比失败更难查。
 */
function runnerFor(target: string, bun: string, notes: string[], what: string): string | undefined {
  if (!target.endsWith('.ts')) return undefined
  if (bun !== '') return bun
  notes.push(`${what} 指向 .ts 入口，但没找到 bun ⇒ 将直接执行（多半失败）：装上 bun，或用 harness.bunPath 指定`)
  return undefined
}

/**
 * 解析启动方式。
 *
 * 纯函数：同输入必同输出，可单测。
 */
export function resolveLaunchOptions(input: LaunchInput): LaunchOptions {
  const cwd = input.cwd
  const token = tokenOf(input)
  const notes: string[] = []
  const bun = trim(input.bun)

  // 1) 显式给了二进制 / 可执行：`.ts` 才需要 bun（有人会把入口也填到这里，兼容）
  const sidecar = trim(input.sidecarPath)
  if (sidecar !== '') {
    return { cliPath: sidecar, runner: runnerFor(sidecar, bun, notes, 'harness.sidecarPath'), cwd, token, notes }
  }

  // 2) 显式给了 CLI 入口
  const cli = trim(input.cliPath)
  if (cli !== '') {
    return { cliPath: cli, runner: runnerFor(cli, bun, notes, 'harness.cliPath'), cwd, token, notes }
  }

  // 3) 工作区里的编译二进制（`bun run build:sidecar` 产出；P3-A 起最优先的自动选择）
  const binary = `${cwd}/${SIDECAR_BINARY_RELPATH}`
  if (input.exists(binary)) return { cliPath: binary, cwd, token, notes }

  // 4) 工作区里的 TS 入口（开发态：改代码即生效）—— **要 bun 才成立**
  const entry = `${cwd}/${CLI_ENTRY_RELPATH}`
  if (input.exists(entry)) {
    if (bun !== '') return { cliPath: entry, runner: bun, cwd, token, notes }
    // 自动探测不该选一条跑不起来的路线：记下来，继续往下落
    notes.push(`工作区有 ${CLI_ENTRY_RELPATH}，但没找到 bun ⇒ 跳过该路线（装上 bun，或用 harness.bunPath 指定）`)
  }

  // 5) 兜底：PATH 上的 harness
  notes.push('回落到 PATH 上的 harness（扩展包自身不带 sidecar）')
  return { cliPath: 'harness', cwd, token, notes }
}
