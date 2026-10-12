/**
 * 跨方言命令身份、只读集与结构门（P1-1 / P1-2 / P1-3）
 *
 * ## 这个文件解决什么
 * `allowlist`（`bash` 工具）与 `DEFAULT_READONLY_COMMANDS`（`bash_ro`）都是**按 POSIX 命令名**
 * 写的。在 PowerShell / CMD 上，同一个能力换了个名字（`ls` → `Get-ChildItem` / `dir`），
 * 于是改造前的做法只能"整片禁用"（P1-1 / P1-2 的原文）。这里把"名字"与"能力"的关系显式化：
 * **一张等价表 + 一条翻译规则**，把白名单条目翻译到目标方言，再拿首命令名去比。
 *
 * ## 五条纪律（写在这里，因为它们是"协作式只读"的边界说明）
 * 1. **翻译只用于判定**：绝不用翻译结果去改写要下发给 shell 的命令文本 —— 改写了就不再是
 *    用户/模型给的那条命令，审计与复现都会对不上（用例钉住：`runBash` 收到的命令 == 原文）。
 * 2. **只映射语义确实等价的**（`ls` ↔ `dir` ↔ `Get-ChildItem` 都是"列目录"）。语义不等价的一律
 *    不映射 —— 未命中映射 ⇒ 该条目在目标方言下**不匹配** ⇒ 拒绝（fail-closed）。
 * 3. **只映射只读类命令**：`rm` / `cp` / `mv` 这些**写操作不映射**。理由不是"名字不对"，而是
 *    `rm -rf` 与 `Remove-Item -Recurse -Force` 的风险面并不一样，把"允许 rm"自动放大成
 *    "允许 Remove-Item 全参数形态"是超出用户原意的授权。要放行写得显式（`allowlist: ['Remove-Item']`
 *    —— 原名在 PS 下逐字匹配）。
 * 4. **PS / CMD 的命令名比较大小写不敏感**（`get-childitem` 与 `Get-ChildItem` 是同一条；
 *    CMD 内部命令同理）⇒ 判定必须折叠，否则 `DIR` 会被当成未知命令而误拒。
 *    反之 **bash 侧保持大小写敏感**（`LS` 与 `ls` 是两个东西）。
 * 5. **这里全是手写判定**：与 `checkReadOnlyCommand` 同属"协作式只读"，挡的是"顺手写一下"，
 *    不是恶意绕过。真正的边界仍由 permission 引擎与宿主沙箱（L2/L3）负责。
 *
 * ## 与 P1-3 的关系：**PS / CMD 的只读保证弱于 bash**
 * bash 侧有第二道门 —— tree-sitter 语法树复核（`checkReadOnlyByAst`）。PS / CMD **没有**解析器
 * （也不打算引入），所以只有这里的手写结构门。结构门因此必须承担更多，具体多挡了四类：
 * - **PS 脚本块 `{ }`**：`Where-Object { Remove-Item x }` 是合法 PS **并且真的会执行** ——
 *   脚本块让"白名单内的 cmdlet"能执行任意代码（与 POSIX 侧刻意排除 `xargs` 同理）；
 * - **PS 调用运算符 `&`**：`& $cmd` / `& 'C:\\x.exe'` 是间接执行，不可审计；
 * - **PS here-string `@"…"@`**：内容不可廉价解析（且可被 `Invoke-Expression` 消费）；
 * - **.NET 写静态调用**：`[System.IO.File]::WriteAllText(...)` 完全绕过 cmdlet 白名单。
 * ⚠️ **这一切未在真机 PowerShell / CMD 上验证**（本机 macOS 无 `pwsh` / `cmd.exe`）。
 * 这里保证的是**判定算法的正确性**（纯函数、逐条用例）；真机行为留给 Windows CI 与真机复核。
 */

import type { ShellDialect } from './shell-quoting'

/**
 * 跨方言等价命令表（**只列只读类**，见纪律 3）。
 *
 * `powershell` 一列写**规范 cmdlet 名 + 常见内建别名**（都小写；比较前会再折叠一次）：
 * 别名是 PS 自带的（`gci` / `gc` / `sls`…），用户敲 `ls` 在 PS 里也是别名。
 * `cmd` 一列写 CMD 的**内部命令或同名可执行**；空数组＝该方言下没有等价物
 * （⇒ 条目不匹配 ⇒ 拒绝）。
 */
export interface CrossDialectCommand {
  /** POSIX（bash）里的命令名 */
  posix: string
  /** PowerShell 下语义等价的命令名（规范 cmdlet + 内建别名） */
  powershell: string[]
  /** CMD 下的等价命令名（内部命令优先） */
  cmd: string[]
}

export const CROSS_DIALECT_COMMANDS: readonly CrossDialectCommand[] = [
  { posix: 'ls', powershell: ['get-childitem', 'gci', 'dir', 'ls'], cmd: ['dir'] },
  { posix: 'cat', powershell: ['get-content', 'gc', 'cat', 'type'], cmd: ['type'] },
  { posix: 'grep', powershell: ['select-string', 'sls'], cmd: ['findstr'] },
  { posix: 'sort', powershell: ['sort-object', 'sort'], cmd: ['sort'] },
  { posix: 'uniq', powershell: ['get-unique', 'gu'], cmd: [] },
  { posix: 'wc', powershell: ['measure-object', 'measure'], cmd: [] },
  { posix: 'echo', powershell: ['write-output', 'write', 'echo'], cmd: ['echo'] },
  { posix: 'which', powershell: ['get-command', 'gcm'], cmd: ['where'] },
  { posix: 'stat', powershell: ['get-item', 'gi'], cmd: [] },
  { posix: 'date', powershell: ['get-date'], cmd: [] },
  { posix: 'pwd', powershell: ['get-location', 'gl', 'pwd'], cmd: [] },
  { posix: 'readlink', powershell: ['resolve-path', 'rvpa'], cmd: [] },
  { posix: 'realpath', powershell: ['resolve-path', 'rvpa'], cmd: [] },
  { posix: 'basename', powershell: ['split-path'], cmd: [] },
  { posix: 'dirname', powershell: ['split-path'], cmd: [] },
]

/**
 * 按方言折叠命令名。**bash 不折叠**（大小写敏感），PS / CMD 折叠（见纪律 4）。
 */
export function normalizeCommandName(name: string, dialect: ShellDialect): string {
  const base = String(name ?? '').trim()
  return dialect === 'bash' ? base : base.toLowerCase()
}

/**
 * 把一条白名单条目翻译成**目标方言下可接受的命令名集合**。
 *
 * 未命中等价表 ⇒ 返回 `[条目本身]`：这样用户显式写方言名（`allowlist: ['Get-ChildItem']`）
 * 仍然逐字生效，而 POSIX 名在 PS/CMD 下自然匹配不上（fail-closed，见纪律 2）。
 */
export function allowlistNamesFor(entry: string, dialect: ShellDialect): string[] {
  const norm = normalizeCommandName(entry, dialect)
  if (!norm) return []
  if (dialect === 'bash') return [norm]
  // ⚠️ 这里比的是**条目（已归一）**与表里的 posix 名 —— 反过来比（`normalizeCommandName(e.posix, dialect) === e.posix`）
  // 恒真，会让查找永远命中第一条（实测踩过：`cat` 被翻译成 `ls` 的等价集）。
  const eq = CROSS_DIALECT_COMMANDS.find((e) => e.posix === norm)
  // 条目不是表里的 posix 名 ⇒ 视为**方言专有写法**（`Get-ChildItem` / `dir` / `git`）⇒ 逐字用
  if (!eq) return [norm]
  const names = dialect === 'powershell' ? [...eq.powershell] : [...eq.cmd]
  // 该方言没有等价物（如 `uniq` / `wc` 在 CMD 下）⇒ 退回原名（它自然不会匹配任何真实命令 ⇒ fail-closed）
  return names.length ? names : [norm]
}

/**
 * 首命令名是否被白名单放行（**翻译只用于判定**，见纪律 1）。
 *
 * 两侧都过 {@link normalizeCommandName}：白名单条目与命令名在同一方言下比较，
 * 于是 `allowlist: ['ls']` 在 PS 下能认 `Get-ChildItem` / `dir`，在 CMD 下能认 `dir`。
 */
export function isCommandAllowed(
  commandName: string,
  allowlist: readonly string[],
  dialect: ShellDialect,
): boolean {
  const cmd = normalizeCommandName(commandName, dialect)
  if (!cmd) return false
  return allowlist.some((a) => allowlistNamesFor(a, dialect).includes(cmd))
}

// ============================================================================
// P1-2：各方言的只读命令集
// ============================================================================

/**
 * PowerShell 只读命令集（**规范 cmdlet 名 + 内建别名**，小写）。
 *
 * 收录判据：**只读取、只计算、只展示**，且**不带能执行代码的参数**。
 * 刻意排除（都在"看起来只读"的边缘）：
 * - `ForEach-Object` / `Where-Object` / `Measure-Command` / `Invoke-*` / `Start-*` / `New-Object` /
 *   `Add-Type`：参数是**脚本块或表达式**，能执行任意代码（`ForEach-Object { Remove-Item x }`
 *   等价于 POSIX 的 `xargs`）—— 与 `DEFAULT_READONLY_COMMANDS` 排除 `xargs` 同一条理由；
 * - `Set-*` / `Remove-*` / `New-*` / `Clear-*` / `Out-File` / `Tee-Object` / `Export-*`：
 *   写文件或改状态；
 * - `Get-Credential` / `Get-Clipboard`：会弹窗或读剪贴板（后者可能含凭据）。
 * ⚠️ 脚本块本身另有一条结构门（`{`）兜底 —— 即使某个 cmdlet 漏进白名单，
 * `{ }` 也会被单独拦下（两道门取交集）。
 */
export const POWERSHELL_READONLY_COMMANDS: readonly string[] = [
  // 读取 / 列举
  'get-childitem', 'gci', 'dir', 'ls', 'get-content', 'gc', 'cat', 'type', 'get-item', 'gi',
  'get-itemproperty', 'gp', 'get-acl', 'get-filehash', 'get-member', 'gm',
  // 搜索 / 过滤 / 汇总（**参数形式**，不接受脚本块 —— 结构门拦 `{`）
  'select-string', 'sls', 'select-object', 'select', 'sort-object', 'sort', 'group-object', 'group',
  'compare-object', 'compare', 'get-unique', 'gu', 'measure-object', 'measure',
  'where', 'where-object',
  // 路径 / 转换（纯计算）
  'test-path', 'resolve-path', 'rvpa', 'split-path', 'join-path', 'convertfrom-json', 'convertfrom-csv',
  'convertto-json', 'convertto-csv',
  // 展示
  'format-table', 'ft', 'format-list', 'fl', 'format-wide', 'fw', 'format-custom', 'out-string',
  'write-output', 'write', 'write-host', 'echo',
  // 环境 / 元信息（只读）
  'get-location', 'gl', 'pwd', 'get-date', 'get-command', 'gcm', 'get-help', 'help', 'man',
  'get-history', 'h', 'get-variable', 'gv', 'get-host', 'get-culture', 'get-process', 'ps',
  'get-service', 'gsv', 'get-module', 'gmo', 'get-psprovider', 'get-alias', 'gal', 'get-uptime',
  'get-computerinfo', 'get-ciminstance', 'gcim', 'get-wmiobject',
]

/**
 * CMD 只读命令集（内部命令优先）。
 *
 * 排除的理由都在"看起来只读"的边缘：
 * - `sort /o <file>` 会写文件 ⇒ 命令本身收进来，但**参数级禁区**另有 `/o` 一条；
 * - `date` / `time` 不带参数是**询问修改**（会改系统时间）⇒ **不收**；
 * - `attrib` / `chkdsk` / `label` / `vol` 带参数会改属性/盘 ⇒ **不收**；
 * - `set` 不带参数列变量、带参数就设变量 ⇒ **不收**（只读模式下没有它需要的场景）；
 * - `for` / `if` / `call` / `start` / `cmd` / `powershell` / `wmic` / `reg` / `sc` / `net`：
 *   间接执行或改状态 ⇒ **不收**（其中 `for` 是 CMD 版的 `xargs`）。
 */
export const CMD_READONLY_COMMANDS: readonly string[] = [
  'dir', 'type', 'find', 'findstr', 'more', 'sort', 'fc', 'comp', 'where', 'tree',
  'echo', 'ver', 'whoami', 'hostname', 'path', 'tasklist', 'netstat', 'ipconfig', 'systeminfo',
  'getmac', 'arp', 'route', 'nslookup', 'ping',
]

/** 按方言取只读命令集（`bash` ⇒ 沿用 {@link DEFAULT_READONLY_COMMANDS} 的调用方默认值） */
export function readonlyCommandsFor(
  dialect: ShellDialect,
  bashDefault: readonly string[],
): readonly string[] {
  if (dialect === 'powershell') return POWERSHELL_READONLY_COMMANDS
  if (dialect === 'cmd') return CMD_READONLY_COMMANDS
  return bashDefault
}

// ============================================================================
// P1-2 / P1-3：方言专属结构门
// ============================================================================

/** 结构门命中项（`code` 与 `checkReadOnlyCommand` 的错误码同族） */
export interface StructureHit {
  code: string
  why: string
}

/**
 * PowerShell 专属结构门（**在去引号投影上检查**，除非另有说明）。
 *
 * 为什么每条都要有：见文件头"PS / CMD 的只读保证弱于 bash"一节。要点是
 * **白名单只管"命令名"，管不到"参数里的可执行片段"** —— 脚本块、调用运算符、
 * here-string、.NET 静态调用这四类都是"命令名看着没问题、实际能执行/能写"的形态。
 */
export const PS_STRUCTURE_PATTERNS: ReadonlyArray<{ re: RegExp; code: string; why: string }> = [
  {
    re: /\{/,
    code: 'SANDBOX_RO_PS_SCRIPTBLOCK',
    why: '脚本块（{ }）能执行任意命令：`Where-Object { Remove-Item x }` 是合法 PowerShell 且**真的会执行**；'
      + '需要过滤请用参数形式（如 `Get-ChildItem -Filter *.txt`）',
  },
  {
    re: /@['"]/,
    code: 'SANDBOX_RO_PS_HERESTRING',
    why: 'here-string（@"…"@ / @\'…\'@）内容不可廉价解析，且可被 Invoke-Expression 消费',
  },
  {
    // 调用运算符 `&`：**允许前面有空白**（`Get-Item x & 'C:\tmp\evil.exe'` 是最常见的写法），
    // 只排除"前一个非空白字符是 `<` `>` `|` `&`"（那些是重定向与复合运算符）与"后面紧跟 `&` / `>`"
    // （`&&` / `2>&1` / `&>`）。⚠️ 早先写成 `[^<>&\s]&` 要求 `&` **紧邻**非空白字符，
    // 于是带空格的那条漏判（变体测试没有覆盖到"空格 + 调用运算符"这一形态）。
    re: /(?:^|[^<>&|])\s*&(?![&>])/,
    code: 'SANDBOX_RO_PS_INVOKE',
    why: '调用运算符 `&`（`& $cmd` / `& \'C:\\x.exe\'`）是间接执行，不可审计',
  },
  {
    // .NET 静态**写**调用：`[System.IO.File]::WriteAllText(...)` 完全绕过 cmdlet 白名单。
    // ⚠️ 刻意只列写/删动词 —— `[math]::Round()` / `[string]::Join()` 这类纯计算必须放行
    //    （全禁 `::` 会把 PS 里最常见的格式化写法一起挡掉）。
    re: /\]::(?:Write|Append|Create|Delete|Move|Copy|Set|Replace|OpenWrite)\w*\s*\(/i,
    code: 'SANDBOX_RO_PS_DOTNET',
    why: '.NET 静态写调用（如 [System.IO.File]::WriteAllText(…)）绕过 cmdlet 白名单',
  },
]

/**
 * CMD 专属结构门。数量刻意比 PS 少 —— CMD 没有脚本块、没有调用运算符，
 * 真正的执行通道（`for` / `call` / `start` / `cmd` / `powershell`）**都不在只读集里**，
 * 由首命令判定兜住。这里只补一条 CMD 特有的间接执行形态：`%VAR%` 展开。
 * ⚠️ 只挡**已知可执行的系统变量**（`%COMSPEC%` 是"命令解释器路径"，`%PATHEXT%` 等不是可执行）；
 * `echo %PATH%` 这类常见只读用法**故意放行** —— 全禁会大面积误伤。
 */
export const CMD_STRUCTURE_PATTERNS: ReadonlyArray<{ re: RegExp; code: string; why: string }> = [
  {
    re: /%comspec%|%systemroot%\\system32\\cmd(?:\.exe)?/i,
    code: 'SANDBOX_RO_CMD_EXEC',
    why: '%COMSPEC% 展开可以起一个命令解释器（`%COMSPEC% /c …`），是间接执行',
  },
]

/** 按方言取结构门（`bash` ⇒ 空数组：bash 侧的门写在 `index.ts` 里，且另有 AST 复核） */
export function dialectStructurePatterns(
  dialect: ShellDialect,
): ReadonlyArray<{ re: RegExp; code: string; why: string }> {
  if (dialect === 'powershell') return PS_STRUCTURE_PATTERNS
  if (dialect === 'cmd') return CMD_STRUCTURE_PATTERNS
  return []
}

/**
 * 支持**语法树复核**的方言（P1-3 的显式化）。
 *
 * 只有 bash：`analyzeBashCommand` 走的是 tree-sitter-bash。PS / CMD 明确不做 AST 复核
 * —— 引一个 PS 解析器（或把 CMD 的语法写成树）成本远高于收益，而结构门 + 白名单能把
 * "顺手写一下"挡住（这是只读哨兵的目标）。**代价如实写在这里：PS / CMD 的只读判定
 * 弱于 bash，第二道门不存在。** 用例钉住这条常量，避免以后有人以为"所有方言都有 AST 门"。
 */
export const AST_REVIEW_DIALECTS: readonly ShellDialect[] = ['bash']

/**
 * PS / CMD 下的**文本级**敏感路径扫描（P1-3 的代价补偿）。
 *
 * bash 侧用语法树取"真参数"（`findSensitiveReadPath(operands)`）。PS / CMD 没有 AST，
 * 退而求其次：从**去引号投影**里挑出"看起来像路径"的 token，再套同一份敏感表。
 *
 * ⚠️ 这是**保守近似**：会把 `Select-String -Pattern '.env'` 这类参数值当成路径而**误拒**
 * （`-Pattern` 的值不是路径）。取"宁可误拒、不可漏放"：漏放意味着 `Get-Content .env`
 * 在 PS 上读走凭据，而误拒只让模型换个写法。
 */
export function tokenLikePaths(command: string, dialect: ShellDialect): string[] {
  const out: string[] = []
  for (const raw of command.split(/[\s,;|]+/)) {
    const tok = raw.replace(/^[([{'"]+/, '').replace(/[)\]},'"]+$/, '')
    if (!tok) continue
    // CMD 的单字母开关（`/s` / `/b` / `/q`）含 `/` 但**不是路径** —— 不排除会把 `dir /s /b` 判成有路径
    if (/^\/[A-Za-z?]$/.test(tok)) continue
    // 含分隔符的，或**点文件**（`.env` / `.ssh` / `id_rsa.pub` 里的 `.` 形态）。
    // ⚠️ 点文件判据是 `^\.[^.]`（点开头且第二个字符不是点）：`.env` 命中 —— 早先写成
    // "除首字符外还要有 `.`" 会把 `.env` 这个最常见的凭据名漏掉（实测踩过）；`..` / `.` 不命中。
    const looksPath = /[\\/]/.test(tok) || /^\.[^.]/.test(tok)
    if (looksPath) out.push(tok)
  }
  return out
}
