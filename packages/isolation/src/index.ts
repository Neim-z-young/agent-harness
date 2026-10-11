/**
 * `@harness/isolation` —— 沙箱**隔离档位**与**网络出口策略**的零依赖落点（P1-4 / P1-2 / P3-2）
 *
 * ## 为什么单独一个包
 * 两件事都需要**跨包共用同一份口径**：
 * - 档位判定（`resolveIsolation`）被 `@harness/host`（装配期决定 notice/拒绝启动）与
 *   `@harness/tools-builtin`（执行期标注 `BashOutput.isolation`）共用；
 * - 网络目标判定（`isPrivateHost` / `isBlockedNetTarget`）被 `tools-builtin`（bash 出网门）
 *   与 `tools-web`（SSRF 防护）共用 —— 两者原来各写一份 `isPrivateIp`，正是"修一处漏一处"。
 *
 * 与 `@harness/fs-guard` 同样的定位：**零依赖叶子包**（只 `node:path`），谁都能引，
 * 不需要任何一方认识 harness 的其它部分。
 *
 * ## 档位口径（与 `docs/sandbox-isolation-plan.md` §2 的表一致）
 * | 档 | 内容 |
 * |---|---|
 * | L0 | 策略层：危险表 + AST 门 + 白名单 + 权限引擎 + 段级 deny + 审计 |
 * | L1 | 进程层：资源上限 + 超时杀进程树 + env 默认拒绝 |
 * | L2 | 文件系统/网络**绑定**：OS 原语把可写区真的限制在声明目录内 + 网络策略 |
 * | L3 | 平台层：容器 / microVM / 远程 executor |
 *
 * ⚠️ **L2/L3 尚未接线**（P1-3 是"新模块"）。所以 {@link probeIsolation} 即便探测到
 * `sandbox-exec` / `bwrap` 存在，`maxLevel` 也**只报 L1**，并在 `reasons` 里写明
 * "原语可用但未接线"。这是本方案最容易悄悄退化成"看起来隔离了"的地方，纪律是
 * **不模拟**（拿不到就显式降级，见 §2 纪律 2）。
 */

import { existsSync } from 'node:fs'
import { basename } from 'node:path'

// ============================================================================
// 一、档位（P1-4 / P3-2）
// ============================================================================

/** 隔离档位（由低到高） */
export type IsolationLevel = 'L0' | 'L1' | 'L2' | 'L3'

/** 全部档位，由低到高（`levelRank` 的下标即等级） */
export const ISOLATION_LEVELS: readonly IsolationLevel[] = ['L0', 'L1', 'L2', 'L3']

/** 档位高低（用于 `>=` 比较；未知值按最低处理 —— fail-closed 的反面是"别抬高预期"） */
export function levelRank(level: IsolationLevel): number {
  const i = ISOLATION_LEVELS.indexOf(level)
  return i < 0 ? 0 : i
}

/**
 * 该档位是否**真的**把文件系统限住了（L2 起）。
 *
 * 单列一个函数而不是让每个调用点各写一次 `levelRank(x) >= 2`：`BashOutput.isolation.fsBound`
 * 是给模型看的（"我现在能不能写界外"），口径只能有一份 —— 改 L2 的定义时漏改一处，
 * 模型就会照着错的边界行事。
 */
export function isOsBound(level: IsolationLevel): boolean {
  return levelRank(level) >= levelRank('L2')
}

/** 本机可用的 OS 级原语（探测结果，不代表已接线） */
export interface IsolationPrimitives {
  /** macOS：`/usr/bin/sandbox-exec` */
  sandboxExec: boolean
  /** Linux：`bwrap`（bubblewrap） */
  bwrap: boolean
  /** Linux：Landlock LSM（内核 ≥ 5.13；*无法*用一次命令行探测，按平台与内核版本判断） */
  landlock: boolean
}

/** 探测结果 */
export interface IsolationProbe {
  /** 探测所用平台（注入项，便于纯函数单测） */
  platform: string
  /** 可用原语 */
  primitives: IsolationPrimitives
  /**
   * **本机实际能达到**的档位。
   *
   * 注意与 `primitives` 的区别：有 `sandbox-exec` ≠ 达到 L2（还要有一条把它套到每次
   * bash 执行上的接线，即 P1-3）。所以 P1-3 落地前这里恒为 `'L1'`。
   */
  maxLevel: IsolationLevel
  /** 为什么达不到更高档（人读；逐条对应一个具体缺口） */
  reasons: string[]
}

/** `probeIsolation` 的可注入依赖（纯函数单测用；真机走默认值） */
export interface IsolationProbeDeps {
  /** 覆盖平台（默认 `process.platform`） */
  platform?: string
  /** 覆盖"文件/命令是否存在"的判定（默认 `existsSync`） */
  exists?: (pathOrCommand: string) => boolean
  /**
   * OS 绑定**是否已接线**（P1-3 的产物）。
   *
   * 单列一个开关而不是让调用方猜：即使 P1-3 落地，也要由它显式声明"这条路真的通"，
   * 否则探测到原语就自动升档 —— 那正是"不模拟"纪律要防的形态。
   */
  osBinding?: boolean
}

/** 默认存在性判定（`existsSync`；只用于探测原语，不参与任何路径判定） */
function defaultExists(p: string): boolean {
  return existsSync(p)
}

/**
 * 探测本机可用的隔离原语，并给出**实际**能达到的档位（P3-2）。
 *
 * 与 `resolveShell()` 同范式：依赖全部可注入 ⇒ 三平台行为（darwin/linux/win32）都能在
 * 单测里断言，不需要真机。
 */
export function probeIsolation(deps: IsolationProbeDeps = {}): IsolationProbe {
  const platform = deps.platform ?? process.platform
  const exists = deps.exists ?? defaultExists

  const primitives: IsolationPrimitives = {
    sandboxExec: platform === 'darwin' && exists('/usr/bin/sandbox-exec'),
    bwrap: platform === 'linux' && exists('/usr/bin/bwrap'),
    landlock: false, // 命令行无从探测：Landlock 是 LSM，没有"可执行文件"可查
  }

  const osBinding = deps.osBinding === true
  if (osBinding) {
    return { platform, primitives, maxLevel: 'L2', reasons: ['OS 级绑定已接线（fs 分域白名单生效）'] }
  }

  const reasons: string[] = []
  if (platform === 'darwin') {
    reasons.push(primitives.sandboxExec
      ? '本机有 sandbox-exec，但尚未接线（P1-3）：可写区未被 OS 真正限制'
      : '本机没有 sandbox-exec，无法做 OS 级只读绑定')
  } else if (platform === 'linux') {
    reasons.push(primitives.bwrap ? '本机有 bwrap，但尚未接线（P1-3）' : '本机没有 bwrap，无法做 OS 级只读绑定')
  } else {
    reasons.push(`平台 ${platform} 暂无已接线的 OS 隔离原语`)
  }
  return { platform, primitives, maxLevel: 'L1', reasons }
}

/** 档位解析结果 */
export interface IsolationResolution {
  /** 实际生效档位（= `min(required, probe.maxLevel)`，但 `met=false` 时由调用方决定是否继续跑） */
  level: IsolationLevel
  /** 要求的档位下限 */
  required: IsolationLevel
  /** 是否达到要求 */
  met: boolean
  /** 是否发生了降级（`required > level`） */
  downgraded: boolean
  /** 缺口说明（人读；达标时为空） */
  reasons: string[]
}

/**
 * 把「要求档位」与「本机实际能给的档位」折成结论（P1-4）。
 *
 * 刻意**只给结论、不决定后果**：`onUnmet` 是 `warn`（告警继续）还是 `refuse`
 * （拒绝启动）属于宿主策略，不塞进这里 —— 否则同一个函数在 host 与插件里会被要求
 * 表现得不一样，又变成两套口径。
 */
export function resolveIsolation(opts: {
  /** 要求的档位下限（缺省 `'L0'` = 不要求） */
  required?: IsolationLevel
  probe?: IsolationProbe
} = {}): IsolationResolution {
  const probe = opts.probe ?? probeIsolation()
  const required = opts.required ?? 'L0'
  const achieved = levelRank(probe.maxLevel) >= levelRank(required)
  return {
    level: achieved ? probe.maxLevel : probe.maxLevel, // 实际档位恒为本机上限
    required,
    met: achieved,
    downgraded: !achieved,
    reasons: achieved ? [] : probe.reasons,
  }
}

/** 一行式档位描述（notice / `BashOutput` / 日志共用同一份文案口径） */
export function formatIsolationLine(r: IsolationResolution): string {
  if (r.met) return `隔离档位 ${r.level}（要求 ${r.required}，已达标）`
  return `隔离档位 ${r.level}，**未达到要求的 ${r.required}**：${r.reasons.join('；')}`
}

// ============================================================================
// 二、网络出口策略（P1-2）
// ============================================================================

/** 网络出口策略三态 */
export type NetPolicy = 'open' | 'allowlist' | 'deny'

/** 网络策略配置（config.json → sandbox） */
export interface NetPolicyConfig {
  /** `open`（默认，与改造前逐位一致）/ `allowlist`（只放行 `netAllow` 内的目标）/ `deny`（全拒） */
  net?: NetPolicy
  /** `allowlist` 模式的目标白名单（host 或域名；子域自动覆盖） */
  netAllow?: string[]
}

/** 解析后的网络策略 */
export interface ResolvedNetPolicy {
  mode: NetPolicy
  allow: string[]
}

/** 解析网络策略配置（非法值回落到 `open`，不抛 —— 装配期由 `checkSandboxConfig` 说话） */
export function resolveNetPolicy(cfg: NetPolicyConfig = {}): ResolvedNetPolicy {
  const mode: NetPolicy = cfg.net === 'allowlist' || cfg.net === 'deny' ? cfg.net : 'open'
  return { mode, allow: (cfg.netAllow ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean) }
}

/**
 * 出网命令表（L0 静态门）。
 *
 * ⚠️ **这是一道策略门，不是内核边界**：任何"能起进程/能执行脚本"的命令都能绕过它
 * （`python3 -c "import urllib..."`、`node -e ...`、自定义二进制）。文档 §2 纪律 2 的
 * 口径照旧：L0 挡得住**常见出口**，真正的保证要 L2/L3。所以这里只列"名字即意图"的命令，
 * 不做脚本内容分析 —— 假装能分析只会给人虚假信心。
 *
 * ## 刻意**不在**表内的两类（都是有意选择，不是遗漏）
 * - **本地/远端双用途**：`git`（`status` 本地、`clone` 出网）、`docker`、`kubectl`……
 *   整名拉黑会把日常本地操作一起挡掉 —— deny 模式直接不可用。
 * - **解释器与包管理器**：`node` / `python3` / `npm` / `pip` / `cargo`……它们的目标写在
 *   配置或代码里，静态提不出来；且与 `node -e` 同类 —— 列进去只会造成"以为挡住了"。
 *   这类通道的答案是 L2/L3（网络命名空间 / 出网代理），不是加一个名字。
 */
export const NETWORK_COMMANDS: readonly string[] = [
  'curl', 'wget', 'wget2',
  'nc', 'ncat', 'netcat', 'socat', 'telnet', 'tftp',
  'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'lftp',
  'dig', 'nslookup', 'host', 'ping', 'ping6', 'traceroute', 'tracepath',
  'openssl', // `openssl s_client -connect host:443` 是条常用外联通道
]

/**
 * 云元数据端点（硬拒清单）。
 *
 * 为什么单列：它们**不是"互联网上的某台主机"**，而是"把你的实例凭据交出来"的接口
 * （AWS/GCP/Azure/阿里云的 IMDS）。把 `169.254.169.254` 当成普通目标放进白名单，
 * 等于把"允许出网"悄悄变成"允许窃取本机凭据"。
 */
export const METADATA_HOSTS: readonly string[] = [
  '169.254.169.254',        // AWS / Azure / OpenStack IMDS
  '169.254.170.2',          // AWS ECS task metadata
  '100.100.100.200',        // 阿里云
  'fd00:ec2::254',          // AWS IMDS (IPv6)
  'metadata.google.internal',
  'metadata.goog',
]

/** 是否云元数据端点（大小写不敏感；`[]` 包裹的 IPv6 也认） */
export function isMetadataHost(host: string): boolean {
  const h = normalizeHost(host)
  if (!h) return false
  return METADATA_HOSTS.some((m) => h === normalizeHost(m))
}

/**
 * 是否私有 / 本机地址（SSRF 判定）。
 *
 * 从 `tools-web` 的 `isPrivateIp` **收敛**过来（行为逐字保留）：RFC1918、环回、
 * link-local（含 `169.254.*`）、IPv6 ULA（`fc`/`fd`）、`0.0.0.0`/`::`，以及
 * `localhost` / `*.local` / `*.localhost`。
 */
export function isPrivateHost(host: string): boolean {
  const h = normalizeHost(host)
  if (!h) return false
  if (isIpLike(h)) {
    if (h === '127.0.0.1' || h === '::1') return true
    if (h.startsWith('10.')) return true
    if (h.startsWith('192.168.')) return true
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
    if (h.startsWith('169.254.')) return true
    if (h.startsWith('127.')) return true
    if (h.startsWith('fd') || h.startsWith('fc')) return true
    if (h === '0.0.0.0' || h === '::') return true
    return false
  }
  if (h === 'localhost') return true
  if (h.endsWith('.local')) return true
  if (h.endsWith('.localhost')) return true
  return false
}

/** `allowlist` 模式下**硬拒**（即使写进 `netAllow` 也不放行）的目标 */
export function isBlockedNetTarget(host: string): boolean {
  return isMetadataHost(host) || isPrivateHost(host)
}

/**
 * 目标 host 是否被白名单覆盖。
 *
 * 语义：**精确相等**，或白名单项是它的**父域**（`github.com` 覆盖 `api.github.com`）。
 * 刻意不做 `endsWith` 裸匹配 —— `evil-github.com` 会以 `github.com` 结尾，
 * 那是域名白名单最经典的绕过（同"子串匹配"在白名单上的老病）。
 */
export function hostMatchesAllow(host: string, allow: readonly string[]): boolean {
  const h = normalizeHost(host)
  if (!h) return false
  for (const raw of allow) {
    const a = normalizeHost(raw)
    if (!a) continue
    if (h === a) return true
    if (h.endsWith(`.${a}`)) return true
  }
  return false
}

/** 归一化 host：小写、去 `[]`、去 IPv6 的字面量括号 */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
}

/** 是否是"像 IP"的形态（含点分十进制 / 冒号分隔的 IPv6），用于分流判定 */
function isIpLike(h: string): boolean {
  if (h.includes(':')) return true
  return /^[0-9.]+$/.test(h)
}

/**
 * 从一个命令参数里提取网络目标 host；不是网络目标则返回 `undefined`。
 *
 * 覆盖四种常见形态（都在"已知是出网命令的参数"这一前提下解释，故可以写得比较宽）：
 * 1. 完整 URL：`https://example.com/x` ⇒ `example.com`；
 * 2. `user@host:path`（scp / rsync / git over ssh）⇒ `host`；
 * 3. `host:port` ⇒ `host`；
 * 4. 裸域名 / 裸 IP：`example.com`、`1.2.3.4`。
 *
 * 不做的：DNS 解析（离线、且在 L0 也不该产生副作用）、`-x proxy:port` 这类选项语义
 * （参数解释属各命令自己的语法，硬猜会误伤）。
 */
export function extractNetHost(token: string): string | undefined {
  const t = token.trim()
  if (!t || t.startsWith('-')) return undefined
  // 1) URL
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) {
    try {
      const u = new URL(t)
      return u.hostname ? normalizeHost(u.hostname) : undefined
    } catch {
      return undefined
    }
  }
  // 2) user@host:path（注意 mailto 已被上面的 URL 分支接住；这里是 scp/rsync 形态）
  const at = t.lastIndexOf('@')
  if (at >= 0) {
    const rest = t.slice(at + 1)
    const host = rest.split(':')[0]?.split('/')[0] ?? ''
    return host ? normalizeHost(host) : undefined
  }
  // 3) host:port —— 冒号后必须是纯数字端口，否则当普通文本（避免 `a:b` 误判）
  const m = /^([A-Za-z0-9._-]+):(\d+)$/.exec(t)
  if (m) return normalizeHost(m[1]!)
  // 4) 裸域名 / 裸 IP
  if (/^[A-Za-z0-9._-]+$/.test(t) && (t.includes('.') || t === 'localhost')) {
    return normalizeHost(t)
  }
  return undefined
}

/** 网络策略判定输入 */
export interface NetScanInput {
  /**
   * 命令名列表（AST 可得时给）。
   * `null` 项是"命令名含展开、字面量不可信"（见 `BashAstCommand.name`）—— 一并当作
   * **未知出网命令**处理：`deny` 下拒绝（fail-closed）。
   */
  commands?: Array<string | null>
  /** 全部参数字面量（AST 可得时给；`null` 项已被调用方过滤） */
  args?: string[]
  /** 原始命令文本（AST **不可得**时的兜底扫描） */
  raw?: string
  /** AST 是否可用（决定 `raw` 兜底是否启用） */
  astAvailable: boolean
}

/** 网络策略判定结论 */
export interface NetVerdict {
  ok: boolean
  /**
   * 拒绝原因（`ok=true` 时为空）—— **已是完整可投递的文案**（含 why 与 how 两段，
   * 由 {@link formatDenial} 拼成），调用方直接展示即可，不要再自己拼一遍。
   */
  reason?: string
  /** 命中的出网命令 */
  commands: string[]
  /** 提取到的目标 host */
  targets: string[]
  /** 为什么被拒（P2-2；与 `reason` 同源，供调用方按段重组） */
  why?: string
  /** 怎么改（P2-2；同上） */
  how?: string
}

/** `raw` 兜底：按词扫描出网命令名（AST 不可用时用；只认词边界，不猜语义） */
function scanNetworkCommandsInText(raw: string): string[] {
  const found: string[] = []
  for (const c of NETWORK_COMMANDS) {
    if (new RegExp(`(^|[^\\w./-])${c}([^\\w-]|$)`).test(raw)) found.push(c)
  }
  return found
}

/** `raw` 兜底：按 URL 形态扫目标 host（AST 不可用时用） */
function scanTargetsInText(raw: string): string[] {
  const out: string[] = []
  const re = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`|;]+/g
  for (const m of raw.match(re) ?? []) {
    const h = extractNetHost(m)
    if (h) out.push(h)
  }
  return out
}

/**
 * 判定一条命令是否违反网络出口策略（P1-2）。
 *
 * 三态语义：
 * - `open`：不判定（直接 `ok`）；
 * - `deny`：出现任何出网命令 ⇒ 拒绝；AST 不可用 ⇒ 文本兜底；两者都拿不到就把
 *   `commands` 留空但**仍视为通过**（宁可不误伤 —— 真正的边界要 L2/L3，见 `NETWORK_COMMANDS` 说明）；
 * - `allowlist`：① 命中出网命令但**提不出任何目标** ⇒ 拒绝（fail-closed：无法核验的目标
 *   不算"在白名单里"）；② 任一目标不在白名单 ⇒ 拒绝；③ 任一目标是元数据/私有地址 ⇒
 *   **硬拒**（即使写进白名单）。
 */
export function assessNetAccess(input: NetScanInput, policy: ResolvedNetPolicy): NetVerdict {
  if (policy.mode === 'open') return { ok: true, commands: [], targets: [] }

  let cmds: string[] = []
  let targets: string[] = []
  if (input.astAvailable) {
    cmds = (input.commands ?? []).map((c) => (c === null ? '' : c)).filter(Boolean).map((c) => basename(c))
    const unknownName = (input.commands ?? []).some((c) => c === null)
    targets = (input.args ?? []).map((a) => extractNetHost(a)).filter((h): h is string => !!h)
    if (unknownName) cmds.push('<展开的命令名>')
  } else {
    cmds = scanNetworkCommandsInText(input.raw ?? '')
    targets = scanTargetsInText(input.raw ?? '')
  }

  const netCmds = cmds.filter((c) => c === '<展开的命令名>' || NETWORK_COMMANDS.includes(c))

  if (policy.mode === 'deny') {
    if (netCmds.length === 0) return { ok: true, commands: [], targets: [] }
    const why = `网络出口策略为 deny：命令包含出网程序 ${netCmds.join(' / ')}。`
    const how = '如需放行，请在 config.json → sandbox.net 改为 open，或用 allowlist 精确放行目标。'
    return { ok: false, commands: netCmds, targets, reason: formatDenial({ why, how }), why, how }
  }

  // allowlist
  if (netCmds.length === 0) return { ok: true, commands: [], targets: [] }
  if (targets.length === 0) {
    const why = `网络出口策略为 allowlist，但无法从命令里确定目标主机（${netCmds.join(' / ')}）——无法核验的目标不算已授权。`
    const how = '请把目标写清（或改用可提取 URL 的命令），或在 config.json → sandbox.net 下调策略。'
    return { ok: false, commands: netCmds, targets, reason: formatDenial({ why, how }), why, how }
  }
  const blocked = targets.filter((h) => isBlockedNetTarget(h))
  if (blocked.length) {
    const why = `网络出口策略拒绝访问元数据/私有地址：${[...new Set(blocked)].join(' / ')}`
      + '（云元数据端点与内网地址即使在 netAllow 里也一律不放行）。'
    const how = '换掉目标地址；这类地址不受 netAllow 影响，只能由 L2/L3 的 OS 级边界另行约束。'
    return { ok: false, commands: netCmds, targets, reason: formatDenial({ why, how }), why, how }
  }
  const notAllowed = targets.filter((h) => !hostMatchesAllow(h, policy.allow))
  if (notAllowed.length) {
    const why = `网络出口策略 allowlist 拒绝未授权目标：${[...new Set(notAllowed)].join(' / ')}`
      + `（当前白名单：${policy.allow.length ? policy.allow.join(' / ') : '空'}）。`
    const how = '如需放行，请加进 config.json → sandbox.netAllow。'
    return { ok: false, commands: netCmds, targets, reason: formatDenial({ why, how }), why, how }
  }
  return { ok: true, commands: netCmds, targets }
}

// ============================================================================
// 三、拒绝文案（P2-2：每条拒绝都要「为什么 + 怎么改」）
// ============================================================================

/**
 * 「怎么改」段的**唯一前缀**（P2-2）。
 *
 * 单列一个常量而不是各处自己写「怎么改：」：它是**可自动判的验收口径** —— 回归守卫
 * 断言每条隔离拒绝消息含这个串，于是"只说被拒、不说怎么办"的文案会直接变红。
 * 历史教训（本仓既有）：文案指向给不出所需信息的工具 ⇒ 模型空转。
 */
export const DENIAL_HOW_PREFIX = '怎么改'

/** 拒绝文案的三段（what 必填，why / how 缺省时整段省略 —— 不给空头衔） */
export interface DenialParts {
  /** 被拒的是什么（含具体命令 / 路径 / 大小，别只写类别） */
  what?: string
  /** 为什么被拒（判定依据：哪条规则、哪个策略、命中了什么） */
  why?: string
  /** 怎么改（可执行：改哪个配置键、换哪个工具、走哪条审批通道） */
  how?: string
}

/**
 * 拼拒绝文案：`what｜为什么：why｜怎么改：how`。
 *
 * 统一在一个函数里的理由与 `formatIsolationLine` 相同：**口径只能有一份**。
 * 各工具自己拼的结果必然是有的说原因、有的给办法、有的只有一句"已拒绝"——
 * 而模型读到"已拒绝"就只能再撞一次墙（P2-2 正是要治这个）。
 */
export function formatDenial(p: DenialParts): string {
  const parts: string[] = []
  if (p.what) parts.push(p.what)
  if (p.why) parts.push(`为什么：${p.why}`)
  if (p.how) parts.push(`${DENIAL_HOW_PREFIX}：${p.how}`)
  return parts.join('｜')
}
