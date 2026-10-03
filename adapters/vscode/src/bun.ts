/**
 * bun 可执行文件的发现（纯模块：**不 import vscode、不 spawn、不读 fs**）。
 *
 * ## 为什么这件事值得单独一个文件 + 一套测试
 * A3 分发方案把"能不能找到 bun"从边角问题变成了**首要可用性问题**：扩展包不再
 * 自带 60MB 的 Bun runtime，而是复用用户机器上的 bun。而 macOS 上 **GUI 启动的
 * VSCode 继承不到 login shell 的 PATH**（launchd 给的 PATH 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`）—— 裸 `bun` 在那种环境里必然找不到。
 *
 * 旧版 `findBun()`（已被本模块取代）有个静默缺陷：候选表第一项是裸 `bun`，
 * 逻辑上"不含 `/` 就直接 return"，于是后面所有绝对路径兜底**永远不会被执行** ——
 * 症状正是"开发机上好好的、GUI 启动的 VSCode 里 spawn 不到 bun"。
 *
 * ## 发现顺序（先精确后宽泛，命中即止）
 * 1. `harness.bunPath`（显式配置）—— 配了但不存在**不静默回落**，由调用方提示
 * 2. `BUN_INSTALL/bin/bun`（bun 官方安装器会设这个环境变量）
 * 3. PATH 里逐个目录找（GUI 环境的 PATH 很短、通常扫不中，但不能跳过）
 * 4. 已知安装位置（homebrew / 官方安装器 / asdf / mise / volta / 项目本地）
 *
 * ## 为什么不做 login shell 探测
 * `$SHELL -ilc 'command -v bun'` 是 GUI 应用的经典兜底，但它要么阻塞激活
 * （同步 `execFileSync`，用户 rc 慢就是几秒）、要么把整条解析链改成异步。
 * 已知安装位置 + 显式配置的覆盖面已经够；不做，理由留档（设计稿 §13.4）。
 */

import { posix, win32 } from 'node:path'

export type BunSource = 'config' | 'env' | 'path' | 'well-known' | 'missing'

export interface BunProbeInput {
  readonly platform: NodeJS.Platform
  readonly env: Record<string, string | undefined>
  /** 用户主目录（`HOME`；Windows 上由调用方折算） */
  readonly home: string
  /** 工作区根：用于找项目本地的 `node_modules/.bin/bun` */
  readonly cwd: string
  /** 配置 `harness.bunPath` */
  readonly configured?: string
  /** 存在性判断（注入：单测可控，真环境用 `fs.existsSync`） */
  readonly exists: (path: string) => boolean
}

export interface BunResolution {
  /** 可执行文件路径（绝对路径或裸命令名）；找不到时 `undefined` */
  readonly path: string | undefined
  readonly source: BunSource
  /** 探过但不存在的位置（排障用） */
  readonly tried: readonly string[]
  /**
   * 显式配置的路径不存在。
   *
   * 单独给一个字段而不是塞一句 note：**配了却无效**必须让用户看见（"改了配置
   * 行为没变"是最难查的一类问题），而调用方要据此弹不同的提示。
   */
  readonly configInvalid: boolean
}

/** Windows 上是 `bun.exe` */
export function bunBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'bun.exe' : 'bun'
}

/** 按目标平台拼路径（Windows 的分隔符与盘符不能靠手写 '/' 拼） */
function joinPath(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts)
}

/**
 * 已知安装位置，按命中概率排序。
 *
 * 只列**能写出出处**的位置 —— 不猜路径（猜错的路径会在排障时误导人，
 * 比"没找到"更糟）。
 */
export function wellKnownBunPaths(input: Pick<BunProbeInput, 'platform' | 'home' | 'cwd'>): string[] {
  const { platform, home, cwd } = input
  const name = bunBinaryName(platform)
  const join = (...parts: string[]) => joinPath(platform, ...parts)
  if (platform === 'win32') {
    // Windows 上官方安装器落在 %USERPROFILE%\.bun\bin；其余交给 PATH
    return [join(home, '.bun', 'bin', name), join(cwd, 'node_modules', '.bin', name)]
  }
  return [
    join('/opt/homebrew/bin', name), // macOS Apple Silicon（Homebrew）
    join('/usr/local/bin', name), // macOS Intel（Homebrew）/ 手动安装
    join(home, '.bun', 'bin', name), // 官方安装器：curl -fsSL https://bun.sh/install | bash
    join(home, '.local', 'bin', name),
    join(home, '.volta', 'bin', name),
    join(home, '.asdf', 'shims', name),
    join(home, '.local', 'share', 'mise', 'shims', name),
    join('/usr', 'bin', name),
    join(cwd, 'node_modules', '.bin', name), // 项目本地
  ]
}

function autoDiscover(
  input: BunProbeInput,
  name: string,
  tried: string[],
): { path: string | undefined; source: BunSource } {
  // BUN_INSTALL：官方安装器写进 shell profile 的环境变量。GUI 环境未必有，
  // 但一旦有就是最准的一条。
  const install = (input.env['BUN_INSTALL'] ?? '').trim()
  if (install !== '') {
    const p = joinPath(input.platform, install, 'bin', name)
    if (input.exists(p)) return { path: p, source: 'env' }
    tried.push(p)
  }

  // PATH 扫描：逐个目录判定，而不是把裸名交给 spawn 的 PATH 查找 ——
  // 我们要能回答"它到底在哪儿"，因为这条链路的失败模式全是"环境不一样"。
  const raw = input.env['PATH'] ?? ''
  const dirs = raw.split(input.platform === 'win32' ? ';' : ':')
  let scanned = 0
  for (const dir of dirs) {
    const d = dir.trim()
    if (d === '') continue
    scanned++
    const p = joinPath(input.platform, d, name)
    if (input.exists(p)) return { path: p, source: 'path' }
  }
  // 只记一条汇总，不把几十个目录铺进 tried —— 那会让真正有用的行被淹没
  if (scanned > 0) tried.push(`PATH（${scanned} 个目录）`)

  for (const p of wellKnownBunPaths(input)) {
    if (input.exists(p)) return { path: p, source: 'well-known' }
    tried.push(p)
  }

  return { path: undefined, source: 'missing' }
}

/**
 * 解析 bun 位置。纯函数：同输入必同输出。
 *
 * 显式配置了**绝对路径却不存在**时：仍返回自动发现的结果，但 `configInvalid=true` ——
 * 既不让扩展停摆，也不假装无事发生。
 */
export function resolveBun(input: BunProbeInput): BunResolution {
  const name = bunBinaryName(input.platform)
  const tried: string[] = []
  const cfg = (input.configured ?? '').trim()

  if (cfg !== '') {
    // 裸命令名（不含分隔符）当成"交给 PATH 解析"：写 `bun` 是合法意图，
    // 只是扩展侧无法验证，不算配置失效。
    if (!cfg.includes('/') && !cfg.includes('\\')) {
      return { path: cfg, source: 'config', tried, configInvalid: false }
    }
    if (input.exists(cfg)) return { path: cfg, source: 'config', tried, configInvalid: false }
    tried.push(cfg)
    const auto = autoDiscover(input, name, tried)
    return { path: auto.path, source: auto.source, tried, configInvalid: true }
  }

  const auto = autoDiscover(input, name, tried)
  return { path: auto.path, source: auto.source, tried, configInvalid: false }
}

/** 人读的一行摘要（写进输出通道 / 状态提示） */
export function describeBun(res: BunResolution): string {
  if (res.path === undefined) {
    return `未找到 bun（来源：missing；探过 ${res.tried.length} 处）`
  }
  const where = res.source === 'config' ? 'harness.bunPath' : res.source
  return `${res.path}（来源：${where}${res.configInvalid ? '；注意：配置的路径不存在，已回落' : ''}）`
}
