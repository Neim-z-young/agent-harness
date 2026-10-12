/**
 * 行尾风格与 BOM（P1-4）
 *
 * ## 为什么单独一个模块
 * 三处工具（`read_file` / `write_file` / `edit_file`）都要对同一份事实给同一个答案：
 * **这个文件是什么行尾、有没有 BOM**。改造前的状态是"各管一摊"：
 * - `edit_file` 已经会把 old/new 归一后再匹配（CRLF 文件不会因模型传 `\n` 而匹配失败）——
 *   但那行 `content.includes('\r\n') ? '\r\n' : '\n'` 是**就地写死**的，既没有 mixed 的概念，
 *   也没有第二处消费它；
 * - `write_file` **完全不看**目标文件风格：覆盖一个 CRLF 文件时，模型给 LF ⇒ 整文件变 LF
 *   （git diff 全红，而"改一行"的实际改动被淹没）；
 * - `read_file` **不报告**风格，于是"我给的 old_string 会不会匹配"只能靠模型猜。
 *
 * ## 三条口径
 * 1. **检测**：{@link detectEol} 数 `\r\n` 与裸 `\n` 的个数，两者都 > 0 ⇒ `'mixed'`
 *    （`'\r\n'` 里的 `\n` **不重复计数** —— 否则 CRLF 文件会被数成 mixed）。
 * 2. **匹配容忍、写回保持**：`edit_file` 把两侧都归一到 LF 再找（`normalizeEol`），
 *    写回时按**文件**的风格（{@link applyEol}）。这条是"用户给的是 LF、文件是 CRLF"仍能编辑的关键。
 * 3. **BOM 如实报告 + 写回保留**：BOM 是文件**字节**的一部分，不是内容 —— 展示时剥掉
 *    （否则模型会把它当首行的内容），写回时保留（否则一次编辑就把文件编码变了）。
 *
 * ⚠️ 只处理 UTF-8 / UTF-8 BOM：UTF-16/32 的 BOM 只**识别并报告**，不尝试转换
 * （`readFile(path,'utf-8')` 读 UTF-16 会把内容读成乱码 —— 那是另一个问题，不在本模块范围）。
 */

/** 行尾风格（`none` = 文件里没有任何换行） */
export type EolStyle = 'lf' | 'crlf' | 'mixed' | 'none'

/** 文件编码标记（只识别，不转换） */
export type BomKind = 'none' | 'utf-8' | 'utf-16le' | 'utf-16be' | 'utf-32'

/** UTF-8 BOM（唯一一种我们会在写回时保留的） */
export const UTF8_BOM = '\uFEFF'

/**
 * 检测行尾风格。
 *
 * ⚠️ 计数的写法是**关键**：先把 `\r\n` 摘掉再数 `\n`，否则 CRLF 文件里每个换行
 * 都被数两次（`\r\n` 含一个 `\n`）⇒ 恒判 mixed。
 */
export function detectEol(text: string): EolStyle {
  if (text === '') return 'none'
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lfOnly = (text.match(/\n/g) ?? []).length - crlf // 裸 `\n`
  const crOnly = (text.match(/\r(?!\n)/g) ?? []).length // 老 Mac 风格，罕见但会混进来
  const kinds = [crlf > 0, lfOnly > 0, crOnly > 0].filter(Boolean).length
  if (kinds === 0) return 'none'
  if (kinds > 1) return 'mixed'
  // 裸 `\r`（老 Mac 风格）归 CR 家族：写回时用 `\r\n`。
  // ⚠️ 与改造前不同 —— 改造前对裸 CR 文件用 `includes('\r\n')` 判 ⇒ 走 LF 分支，等于把 CR 拉成 LF。
  // 两条路都在改写这个文件，这里选语义正确的那一侧（"它是 CR 风格"）。
  return crlf > 0 || crOnly > 0 ? 'crlf' : 'lf'
}

/**
 * 该文件**写回时应该用**的行尾。
 *
 * - `'crlf'` ⇒ `\r\n`；`'lf'` / `'none'` ⇒ `\n`；
 * - **`'mixed'` ⇒ 按 `\r\n`**：与 `edit_file` 改造前的判据（`includes('\r\n')`）**逐位等价**，
 *   既有行为不变。mixed 文件本来就无法用单一风格描述，这里只保证"不会把它拉成纯 LF"
 *   （那会让 diff 从"改一行"变成"整文件改动"）。
 */
export function preferredEol(eol: EolStyle): '\n' | '\r\n' {
  return eol === 'crlf' || eol === 'mixed' ? '\r\n' : '\n'
}

/** 归一到 LF（`\r\n` → `\n` 与裸 `\r` → `\n`）—— 匹配两侧都用它 */
export function normalizeEol(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

/**
 * 把 `text` 的整体行尾转成 `eol`（先归一到 LF 再统一替换，避免 `\r\r\n` 这种叠字）。
 * `eol === '\n'` 时是**恒等**（LF 文件逐位不变）。
 */
export function applyEol(text: string, eol: '\n' | '\r\n'): string {
  if (eol === '\n') return text
  return normalizeEol(text).replaceAll('\n', '\r\n')
}

/** 从**字节**识别 BOM（读文件时用；字符串里只剩 UTF-8 BOM 可见） */
export function detectBom(buf: Uint8Array | string): BomKind {
  if (typeof buf === 'string') return buf.startsWith(UTF8_BOM) ? 'utf-8' : 'none'
  const b = buf
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8'
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xfe && b[2] === 0x00 && b[3] === 0x00) return 'utf-32'
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return 'utf-16le'
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return 'utf-16be'
  return 'none'
}

/** 去掉字符串开头的 UTF-8 BOM（展示用；写回时见 {@link withBom}） */
export function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text
}

/** 按需把 BOM 加回字符串开头（`keep === false` 时是恒等） */
export function withBom(text: string, keep: boolean): string {
  if (!keep) return stripBom(text)
  return text.startsWith(UTF8_BOM) ? text : UTF8_BOM + text
}

/** 一次把"该怎么写回"算出来：目标风格 + 是否保留 BOM */
export function planWrite(content: string, style: { eol: EolStyle; bom: BomKind }): string {
  return withBom(applyEol(content, preferredEol(style.eol)), style.bom === 'utf-8')
}
