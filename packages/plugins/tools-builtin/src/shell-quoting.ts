/**
 * Shell **引号方言**解析（P0-4）。
 *
 * 起因：判定层（`stripQuoted` / `splitSegments` / `extractFirstCommand`）此前只认 POSIX 的
 * `"` / `'` 两字符配对。而 PowerShell 的引号规则**不一样**，于是"去掉引号后的结构投影"
 * 在 PS 上不准 ⇒ 结构性检查（重定向 / 进程替换 / heredoc）可能**漏判**：
 *
 * | 形态 | bash | PowerShell | CMD |
 * |---|---|---|---|
 * | 单引号 | `'…'` 字面，无转义 | `'…'`，`''` 转义（`'it''s'` 是一个字符串） | **不是引号** |
 * | 双引号 | `"…"`，`\` 转义 | `"…"`，`` ` `` 转义（`` "a`"b" ``） | `"…"`，无转义 |
 * | here-string | heredoc `<<EOF`（另算） | `@"…"@` / `@'…'@`（**可跨行**） | 无 |
 *
 * ## 一条安全取舍：未闭合引号按"裸露"处理
 * 找不到闭合引号时**不产生区间**（后续照常扫描、分隔符照常生效）。
 * 另一条路是把余下全部当作字符串内容 —— 那会让 `curl x " ; rm -rf /` 这种**故意不闭合**
 * 的写法把分隔符吞掉，段级 deny 与只读判定一起漏判。取前者：宁可多切一段，不可少切一段。
 *
 * ## 未真机验证的部分（如实标注）
 * 本机（macOS）**没有 `pwsh` / `powershell`**，PowerShell 那一列是按官方语法文档实现的，
 * **没有跑过真 PowerShell**。所以：判据只钉"我们的投影算法"（纯函数），
 * 不声称"已验证 PS 行为"；真机接入 PS 时应先补一次端到端复核。
 * （CMD 的 `^` 转义同理：保守不处理，记在下面的 `case 'cmd'` 里。）
 */

/** 方言（与 `resolveShell()` 的 `family` 同源，故意用两个名字，免得两处含义漂移） */
export type ShellDialect = 'bash' | 'powershell' | 'cmd'

/** 一段引号区间（**含引号字符本身**，闭区间语义用 `end` 表示最后一个字符的下标） */
export interface QuotedSpan {
  start: number
  /** 最后一个字符的下标（含）；here-string 时含 `"@` 里的 `@` */
  end: number
  kind: 'single' | 'double'
  /** 是否 here-string（`@"…"@` / `@'…'@`，可跨行） */
  here: boolean
}

/**
 * 扫描出全部引号区间。返回按 `start` 升序、互不重叠。
 *
 * 找不到闭合的引号**不产生区间**（见文件头"安全取舍"）。
 */
export function scanQuotedSpans(command: string, dialect: ShellDialect = 'bash'): QuotedSpan[] {
  const spans: QuotedSpan[] = []
  const n = command.length
  let i = 0
  while (i < n) {
    const ch = command[i]
    // PowerShell here-string：`@"` / `@'` 起，行首的 `"@` / `'@` 止（可跨行）
    if (dialect === 'powershell' && ch === '@' && (command[i + 1] === '"' || command[i + 1] === "'")) {
      const q = command[i + 1]!
      const close = findHereStringClose(command, i + 2, q)
      if (close >= 0) {
        spans.push({ start: i, end: close + 1, kind: q === '"' ? 'double' : 'single', here: true })
        i = close + 2
        continue
      }
      i += 2 // 未闭合 ⇒ 不产生区间，按裸露继续
      continue
    }
    if (ch === '"') {
      const close = scanDoubleQuoted(command, i, dialect)
      if (close >= 0) {
        spans.push({ start: i, end: close, kind: 'double', here: false })
        i = close + 1
        continue
      }
      i++
      continue
    }
    if (ch === "'" && dialect !== 'cmd') {
      // CMD 里单引号没有特殊含义（`echo 'a b'` 的引号会被原样传给命令）
      const close = scanSingleQuoted(command, i, dialect)
      if (close >= 0) {
        spans.push({ start: i, end: close, kind: 'single', here: false })
        i = close + 1
        continue
      }
      i++
      continue
    }
    i++
  }
  return spans
}

/** 双引号：返回闭合引号下标；找不到 ⇒ -1 */
function scanDoubleQuoted(command: string, start: number, dialect: ShellDialect): number {
  for (let i = start + 1; i < command.length; i++) {
    const ch = command[i]!
    if (ch === '"') {
      // PowerShell 的 `""` 在双引号内也用作字面引号（`"say ""hi"""`）—— 保守处理成"内容"
      if (dialect === 'powershell' && command[i + 1] === '"') { i++; continue }
      return i
    }
    // 转义：bash 用 `\`，PowerShell 用反引号 —— 被转义的字符（含 `"`）不结束字符串
    if (dialect === 'bash' && ch === '\\') { i++; continue }
    if (dialect === 'powershell' && ch === '`') { i++; continue }
    // CMD：只能用 `^` 转义，且 `^"` 的语义随命令而异 —— 保守**不处理**（宁可按裸露继续扫）
  }
  return -1
}

/** 单引号：返回闭合引号下标；找不到 ⇒ -1 */
function scanSingleQuoted(command: string, start: number, dialect: ShellDialect): number {
  for (let i = start + 1; i < command.length; i++) {
    if (command[i] !== "'") continue
    // bash：单引号内一切字面，`'` 就是结束。
    // PowerShell：`''` 是**转义的字面单引号**，不结束字符串。
    if (dialect === 'powershell' && command[i + 1] === "'") { i++; continue }
    return i
  }
  return -1
}

/** here-string 结束标记：**行首**的 `"@` / `'@`（PowerShell 要求）；返回 `"` 的下标，找不到 ⇒ -1 */
function findHereStringClose(command: string, from: number, q: string): number {
  for (let i = from; i < command.length; i++) {
    const atLineStart = i === 0 || command[i - 1] === '\n'
    if (atLineStart && command[i] === q && command[i + 1] === '@') return i
  }
  return -1
}

/**
 * 把引号区间替换成占位符（`""`），得到"只含 shell 结构"的投影。
 *
 * 占位符用两个字符而不是空串：段级切分与首命令提取都靠**位置**判断
 * （`python3 -c "a;b"` 与 `python3 -c ""` 的段结构必须一致）。
 */
export function projectWithoutQuoted(command: string, dialect: ShellDialect = 'bash'): string {
  const spans = scanQuotedSpans(command, dialect)
  if (spans.length === 0) return command
  let out = ''
  let cursor = 0
  for (const sp of spans) {
    out += command.slice(cursor, sp.start) + '""'
    cursor = sp.end + 1
  }
  return out + command.slice(cursor)
}

/** 预计算"每个下标是否落在引号区间内（含引号字符）"，供逐字符消费者使用 */
export function buildQuotedMask(command: string, spans: QuotedSpan[]): boolean[] {
  const mask = new Array<boolean>(command.length).fill(false)
  for (const sp of spans) {
    for (let i = sp.start; i <= sp.end && i < mask.length; i++) mask[i] = true
  }
  return mask
}
