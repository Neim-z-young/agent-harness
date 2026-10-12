/**
 * `@harness/fs-guard` —— 文件系统边界判定（**全仓唯一一份**）
 *
 * ## 为什么要单独一个包（P3-1）
 * `resolvePath` / `isWithinCwd` 这两个函数曾在 **6 个包各写一份**（`tools-builtin` /
 * `tools-glob` / `tools-search` / `tools-media` / `code-intel` / `subagent`）—— 安全边界
 * **修一处漏五处**，且语义已经开始漂移（有的只比字符串、有的比真实路径）。
 *
 * 不放进 `@harness/tool` 的原因：`code-intel` 的 `core.ts` / `server.ts` 刻意**不 import
 * `@harness/tool`**（它要能脱离 harness 单独跑），而它恰恰是副本之一。本包**零依赖**
 * （只有 `node:*`），谁都能引。
 *
 * ## P0-4：字符串判定守不住符号链接
 * 改造前是 `isWithinCwd = !relative(cwd, p).startsWith('..')` + `resolvePath = resolve`，
 * 全程不解析符号链接 ⇒ 工作目录里一条 `ln -s /etc secret` 就让 `secret/passwd` 的
 * `relative` 变成 `secret/passwd`（**判定通过**），而 `stat` / `open` 会跟着链接读到外部。
 * 现在两步都落到**真实路径**（`realpath`）上再比。
 *
 * ## 两条纪律
 * 1. `resolvePath` **不碰文件系统**（保持纯字符串），它产出的路径是真正拿去 `open` 的那个；
 *    边界判定则由 `isWithinCwd` 单独做 —— 两者分开，是为了让"写入一个还不存在的新文件"
 *    这条路径不被 realpath 的 ENOENT 影响。
 * 2. 目标不存在（新建文件）是常态 ⇒ 真实路径按**逐级上溯到最近存在的祖先**再拼回剩余段
 *    （`realpathBestEffort`）。cwd 自身也走同一函数 —— 否则 macOS 上 `/var` → `/private/var`
 *    这类合法链接会把"目录本身在链接下"误判成越界。
 *
 * ## 已知边界（有意不堵）
 * 目标路径上有一环是**悬空**符号链接（指向不存在的路径）时，`realpath` 抛 ENOENT ⇒ 我们
 * 把它当作"不存在的一段"拼回去，判定结果为"在 cwd 内"。此时后续 `open` **也会失败**
 * （ENOENT），所以不构成逃逸面。真要做符号链接级强隔离，是 L2（OS 级只读绑定）的事。
 *
 * ## P0-6：路径语义按**平台方言**解析（2026-10-12）
 * 改造前这里直接用 `node:path` 的**平台默认**函数（`resolve` / `relative` / `isAbsolute`…），
 * 也就是"跑在 Windows 上就是 win32 语义、跑在别处就是 posix 语义"，**两套语义的判定无法被
 * 单测钉住**（在 macOS 上写不出针对 UNC / 盘符的用例）。现在方言显式化：
 * {@link PathDialect} + 每函数一个可选 `dialect`（缺省＝当前平台 ⇒ 既有行为逐位不变），
 * 于是同一份用例能在两种语义下都跑一遍。
 *
 * 四条由实测（node 26 / Bun）确定的方言差异，它们正是 P0-6 要挡的东西：
 * 1. **UNC 是绝对路径**：`win32.isAbsolute('\\\\srv\\share\\x') === true`，而
 *    `posix.isAbsolute` 同串为 `false`（posix 上反斜杠是**普通字符**）⇒ 判定**必须**用
 *    运行平台的口径，**不能"看到反斜杠就当 Windows"**。
 * 2. **跨 share / 跨 server 不可相对**：`win32.relative('\\\\srv\\s1\\a', '\\\\other\\share\\b')`
 *    返回**绝对路径**（`\\\\other\\share\\b`）⇒ `isAbsolute(rel)` 那一支要判 `false`；
 *    而同 server 不同 share 返回 `..\\..\\s2\\b` ⇒ 由"以 `..\` 开头"那一支判 `false`。
 * 3. **盘符不同不可相对**：`win32.relative('C:\\work', 'D:\\x')` 返回 `D:\\x`（绝对）。
 * 4. **win32 的大小写折叠是 `node:path` 自己的行为**（`win32.relative('c:\\work','C:\\Work\\a')`
 *    ⇒ `'a'`）⇒ 本包**不需要**再折一次，折两次反而会把 posix 侧的语义带歪。
 *    （NTFS 可以按目录打开大小写敏感，这里取 Windows 的默认语义。）
 *
 * ⚠️ **未真机验证的部分**：Windows 的 `realpath` 还有 8.3 短名（`PROGRA~1`）、盘符大小写
 * 归一、UNC 的 `\\?\\` 前缀这些形态，本机（macOS）无法覆盖 —— 这里保证的是**纯字符串判定**的
 * 方言正确性，真机接入时应补端到端复核。
 */

import { posix, win32 } from 'node:path'
import { realpathSync } from 'node:fs'

/** `node:path` 的 posix / win32 两套实现同型（`PlatformPath` 不是它的导出名，得从 `posix` 取） */
type PathModule = typeof posix

/** 路径方言（与 `node:path` 的 `posix` / `win32` 一一对应） */
export type PathDialect = 'posix' | 'win32'

/** 按运行平台取缺省方言（`win32` 只对应 Windows 本体，不包含 Cygwin/MSYS 的 posix 形态） */
export function defaultPathDialect(platform: string = process.platform): PathDialect {
  return platform === 'win32' ? 'win32' : 'posix'
}

function pathFor(dialect: PathDialect): PathModule {
  return dialect === 'win32' ? win32 : posix
}

/** 判定函数的可选参数：方言 + 可注入的 realpath（后者让纯函数用例不必碰真机路径） */
export interface PathSemantics {
  /** 路径方言；缺省 `defaultPathDialect()` */
  dialect?: PathDialect
  /** 覆盖 `realpath`（缺省 `node:fs` 的 `realpathSync`） */
  realpath?: (p: string) => string
}

/**
 * 把路径解析为绝对路径（相对 `cwd`）。**纯字符串运算，不触碰文件系统**。
 *
 * 产出的是真正拿去 `open` / `stat` 的那个路径 —— 保留符号链接（不做 realpath），
 * 因为 realpath 对"还不存在的新文件"会抛错。边界判定交给 {@link isWithinCwd}。
 */
export function resolvePath(
  inputPath: string,
  cwd: string,
  dialect: PathDialect = defaultPathDialect(),
): string {
  const P = pathFor(dialect)
  return P.isAbsolute(inputPath) ? P.resolve(inputPath) : P.resolve(cwd, inputPath)
}

/**
 * 取路径的**真实位置**（跟随符号链接）；路径不存在时**逐级上溯到最近存在的祖先**，
 * 再把剩下的段拼回去。
 *
 * 逐级上溯是为"新建文件"服务的：`<cwd>/a/b.txt` 里的 `b.txt` 与 `a` 都可能还不存在，
 * 但最终落盘位置仍必须被判定为"在 `<cwd>` 内"。
 *
 * 到根都取不到真实路径（极端情况：根不可达）⇒ 退回 `resolve(p)` 的结果。
 */
export function realpathBestEffort(p: string, sem: PathSemantics = {}): string {
  const dialect = sem.dialect ?? defaultPathDialect()
  const P = pathFor(dialect)
  const real = sem.realpath ?? realpathSync
  // ⚠️ `resolve` 必须走方言（win32 下 `C:\work\a` 不能被当成相对路径拼到 `/Users/...` 后面）
  const abs = P.resolve(p)
  let cur = abs
  const rest: string[] = []
  for (;;) {
    try {
      const r = real(cur)
      return rest.length === 0 ? r : P.join(r, ...rest)
    } catch {
      /* `cur` 不存在 / 不可达 ⇒ 退到上一级再试 */
    }
    // win32 下 `dirname('C:\\')` / `dirname('\\\\srv\\share')` 都返回自身 ⇒ 终止条件同样成立
    const parent = P.dirname(cur)
    if (parent === cur) return abs // 到根了还是没有 ⇒ 退回 resolve 结果
    rest.unshift(P.basename(cur))
    cur = parent
  }
}

/**
 * 真实路径版的包含判定：`p === root` 或在 `root` 之下。**两个入参都应已是真实路径**
 * （由 {@link realpathBestEffort} 产出），本函数只看字符串。
 *
 * 边界细节（与改造前那 6 份副本的差别）：
 * - 兄弟目录不算在内：`root=/a/b` 时 `/a/bc` 落在外面（`relative` 给 `../bc`）；
 * - `..` 只认**整段**：`root=/a/b` 时 `/a/b/..foo` 是 `..foo` 段，**算在内部**
 *   （老实现用 `startsWith('..')`，会把 `..foo` 误判成越界 —— 一个只会误杀的假阳性）。
 */
export function isWithinRoot(
  p: string,
  root: string,
  dialect: PathDialect = defaultPathDialect(),
): boolean {
  const P = pathFor(dialect)
  const rel = P.relative(root, p)
  if (rel === '') return true // 就是根本身
  // 不同盘符 / 不同 UNC server / 不同 share（win32 下这些都给绝对路径）
  if (P.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${P.sep}`)
}

/**
 * `filePath` 是否**真实落在** `cwd` 内（含 `cwd` 本身）。
 *
 * 两侧都取真实路径 ⇒ 一条 `ln -s /etc secret` 之后 `secret/passwd` 会被判成**界外**，
 * 而不是像改造前那样"字符串看着在里头，`open` 却读了外面"。
 *
 * P0-6：方言与 `realpath` 都可注入（缺省＝当前平台 + 真 `realpathSync` ⇒ 既有行为逐位不变）。
 * ⚠️ 两侧**必须同一方言**：拿 win32 的路径去问 posix 的 `relative`，会把 `\\srv\share\x`
 * 当成 cwd 里的普通文件名而判"在内"（实测 `posix.resolve` 就是这么干的）。
 * ⚠️ 两侧还都必须是**绝对路径**（这是既有契约）：`realpathBestEffort` 内部是 `resolve(p)`，
 * 相对路径会被拼到 **`process.cwd()`** 而不是这里的 `cwd`。工具层的顺序是
 * 「先 `resolvePath(input, cwd)`、再 `isWithinCwd(abs, cwd)`」。
 */
export function isWithinCwd(filePath: string, cwd: string, sem: PathSemantics = {}): boolean {
  const dialect = sem.dialect ?? defaultPathDialect()
  return isWithinRoot(
    realpathBestEffort(filePath, { ...sem, dialect }),
    realpathBestEffort(cwd, { ...sem, dialect }),
    dialect,
  )
}

// ============================================================================
// 读侧敏感文件策略（P0-3）
// ============================================================================

/**
 * 读侧敏感文件策略（P0-3）。
 *
 * 为什么**不用 glob**：这里要表达的是"哪些名字属于凭据"，用五类显式规则比通配更可审计，
 * 也能把"公钥/模板不算敏感"这类**例外**写在一处（见 {@link NOT_SENSITIVE}）。
 * 通配版本最容易出的错是"顺手写成 `.env.*`，把 `.env.example` 一起挡掉"—— 那是误伤。
 *
 * 所有字段按**相对 cwd 的 POSIX 风格路径**匹配（`\` 会被归一成 `/`，前导 `./` 忽略）。
 */
export interface SensitiveReadPolicy {
  /** 文件名精确匹配（basename） */
  names: string[]
  /** 文件名前缀（如 `id_rsa` 覆盖 `id_rsa` / `id_rsa.pub` 之外的同族） */
  prefixes: string[]
  /** 文件名后缀（含点，如 `.pem`） */
  suffixes: string[]
  /** **目录**段：路径里除最后一段（文件名）以外的任一段命中即算（如 `.ssh` / `.aws`） */
  dirs: string[]
  /** 相对 cwd 的精确路径（如 `.docker/config.json`） */
  paths: string[]
}

/**
 * 明确**不敏感**的形态（先于其它规则判定，命中即放行）：
 * - `*.pub`：公钥，不是凭据；
 * - `.env.example` / `.env.sample` / `.env.template`：模板，按定义不含真凭据 —— 而模型经常
 *   需要读它来知道该配哪些键（`.env` 一旦被 `prefixes: ['.env']` 覆盖，这几个会被一起挡掉）。
 */
const NOT_SENSITIVE = {
  names: ['.env.example', '.env.sample', '.env.template'],
  suffixes: ['.pub'],
}

/**
 * 默认敏感读清单。**刻意"逐类列清楚"而不是扫全盘**：只覆盖"业界公认的凭据文件名"，
 * 不做内容嗅探（那会误伤普通配置）。
 */
export const DEFAULT_SENSITIVE_READ_POLICY: SensitiveReadPolicy = {
  // `permissions.json` 是权限规则本体、`.config-key` 是遥测里的匿名 user id 派生源
  names: ['.npmrc', '.netrc', '.pgpass', 'permissions.json', '.config-key', 'credentials.json'],
  // `.env` 前缀覆盖 `.env` / `.env.local` / `.env.production.local`；模板形态由 NOT_SENSITIVE 放行
  prefixes: ['.env', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'id_xmss'],
  suffixes: ['.pem', '.p12', '.pfx', '.p8', '.jks', '.keystore', '.key'],
  dirs: ['.ssh', '.aws', '.gnupg', '.kube'],
  paths: ['.docker/config.json', '.config/gh/hosts.yml'],
}

/**
 * `relPath`（相对 cwd）是否命中敏感读清单。
 *
 * 判据顺序：**例外优先**（公钥 / 模板）→ 精确路径 → 文件名（精确 / 前缀 / 后缀）→ 目录段。
 * 顺序不是随意的：`id_rsa.pub` 会同时命中 `prefixes: ['id_rsa']` 与例外 `.pub`，
 * 例外必须排前面，否则公钥被误杀。
 */
export function isSensitiveReadPath(
  relPath: string,
  policy: SensitiveReadPolicy = DEFAULT_SENSITIVE_READ_POLICY,
): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '')
  if (!norm || norm === '.') return false
  const segs = norm.split('/').filter((s) => s !== '' && s !== '.')
  const base = segs[segs.length - 1] ?? ''
  if (NOT_SENSITIVE.names.includes(base) || NOT_SENSITIVE.suffixes.some((s) => base.endsWith(s))) return false
  if (policy.paths.includes(norm)) return true
  if (policy.names.includes(base)) return true
  if (policy.prefixes.some((p) => base.startsWith(p))) return true
  if (policy.suffixes.some((s) => base.endsWith(s))) return true
  return segs.slice(0, -1).some((s) => policy.dirs.includes(s))
}

/** 在一组路径里找第一个命中项（便于报错信息指明"是哪个"；无命中返回 `undefined`）。 */
export function findSensitiveReadPath(
  relPaths: readonly string[],
  policy: SensitiveReadPolicy = DEFAULT_SENSITIVE_READ_POLICY,
): string | undefined {
  return relPaths.find((p) => isSensitiveReadPath(p, policy))
}

/** 配置侧形态：五类规则都可省（缺的按空数组归一，见 {@link resolveSensitiveReadPolicy}） */
export type SensitiveReadPolicyInput = Partial<SensitiveReadPolicy> | false

/**
 * 解析读侧策略配置（三个工具共用这一处口径）：
 * - `false` ⇒ **关闭**（返回 `undefined`，调用方跳过检查）；
 * - 缺省（`undefined`）⇒ 内置清单 {@link DEFAULT_SENSITIVE_READ_POLICY}；
 * - 对象 ⇒ **整体替换**内置清单（不做合并），**缺的类目按空数组归一** ——
 *   config.json 里少写一个字段不该把运行时直接炸掉（`undefined.includes` 会抛）。
 */
export function resolveSensitiveReadPolicy(
  cfg?: SensitiveReadPolicyInput,
): SensitiveReadPolicy | undefined {
  if (cfg === false) return undefined
  if (cfg === undefined) return DEFAULT_SENSITIVE_READ_POLICY
  return {
    names: cfg.names ?? [],
    prefixes: cfg.prefixes ?? [],
    suffixes: cfg.suffixes ?? [],
    dirs: cfg.dirs ?? [],
    paths: cfg.paths ?? [],
  }
}
