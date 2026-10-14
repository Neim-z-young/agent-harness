/**
 * SSE 解帧器 —— 把网络字节流切成"完整事件"。
 *
 * 为什么自己写（而不是用 SDK 的 `parseSseStream`）：SDK 那个要 `Response.body` +
 * `TextDecoderStream`，绑死在 fetch 上；这里要能在单测里喂字符串，也要能在
 * extension host 的 Node 运行时里跑。解帧本身只是"按空行切块 + 取字段"，没多少代码。
 *
 * **线上格式取自实测**（`harness a2a` 真起服务抓的帧，见 `docs/vscode-integration-design.md` §9）：
 *
 * ```
 * data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 * event: error
 * data: {"jsonrpc":"2.0","id":1,"error":{...}}
 *
 * ```
 *
 * 即：普通帧**没有** `event:` 行（SSE 默认 `message`），错误帧有 `event: error`，
 * 一律以 `\n\n` 结尾。这是 SDK `formatSSEEvent` / `formatSSEErrorEvent` 的实际输出。
 */

/** 一个完整的 SSE 事件 */
export interface SseFrame {
  /** 事件名；缺省为 `message` */
  readonly event: string
  /** `data:` 字段解析后的值。坏 JSON 会抛 `SseParseError`（不静默跳过） */
  readonly data: unknown
}

/** 帧内 JSON 解析失败 */
export class SseParseError extends Error {
  constructor(
    message: string,
    /** 原始 data 文本，便于定位 */
    readonly raw: string,
  ) {
    super(message)
    this.name = 'SseParseError'
  }
}

/**
 * 增量解帧器。
 *
 * 网络分块与帧边界**不对齐**（一帧可能被切成多次 `push`），故必须持有残留缓冲。
 */
export class SseDecoder {
  private buffer = ''

  /** 追加一段文本，返回**本次**切出的完整帧（可能是 0 个或多个） */
  push(chunk: string): SseFrame[] {
    // CRLF 归一：SSE 允许 `\r\n`（也允许**裸 `\r`** 作行尾），统一成 `\n` 后边界判断只需认一种。
    //
    // ⚠️ 必须**归一整段缓冲**，而不是"只归一这一块"：`\r\n` 会被 TCP 切在两次 push 之间
    //（前一块以 `\r` 结尾、后一块以 `\n` 开头）。只在块内 replace 会漏掉它 ⇒ 残留的 `\r` 让
    // `...\n\r\n` 认不出 `\n\n` 边界 ⇒ **该帧被吞掉**（实测：整帧 CRLF、按 `\r|\n` 切块 ⇒ 0 帧）；
    // 若后面还有帧，两帧会被并成一块、`data:` 变成两行 ⇒ `JSON.parse` 抛错、整轮失败。
    // 归一化是**幂等**的（折过之后缓冲里不再有 `\r`），重复扫残余缓冲的代价可以忽略。
    this.buffer = (this.buffer + chunk).replace(/\r\n?/g, '\n')

    const out: SseFrame[] = []
    let idx = this.buffer.indexOf('\n\n')
    while (idx !== -1) {
      const block = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      const frame = parseBlock(block)
      if (frame) out.push(frame)
      idx = this.buffer.indexOf('\n\n')
    }
    return out
  }

  /** 流结束时调用：把没等到空行结尾的残留块也交出来（或报出"半帧"） */
  flush(): SseFrame[] {
    const rest = this.buffer
    this.buffer = ''
    if (rest.trim() === '') return []
    const frame = parseBlock(rest)
    return frame ? [frame] : []
  }
}

/** 解析一个块（不含结尾空行） */
function parseBlock(block: string): SseFrame | undefined {
  let event = 'message'
  const dataLines: string[] = []

  for (const rawLine of block.split('\n')) {
    const line = rawLine
    // 注释行（心跳）：以冒号开头，必须忽略，否则会被当成字段
    if (line.startsWith(':')) continue
    if (line === '') continue

    const colon = line.indexOf(':')
    if (colon === -1) continue
    const field = line.slice(0, colon)
    // SSE 规范：冒号后**一个**空格是可选的，要剥掉
    let value = line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
    // 其余字段（id / retry）本通道不用，忽略
  }

  if (dataLines.length === 0) return undefined

  const raw = dataLines.join('\n')
  // 空 `data:`（`data:` 后没有内容）**不产出帧**，也不该被当成坏 JSON：
  // 它是合法的 SSE 事件、语义上"这一帧没有载荷"（对端/中间层当保活帧发），而不是"帧被损坏"。
  // 不加这条 ⇒ `JSON.parse('')` 抛 SseParseError ⇒ 一条心跳就把**整轮**判成解析失败并结束。
  //（与上面那条一致：真正坏掉的 JSON 仍照抛，不静默跳过。）
  if (raw === '') return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    // 一个坏帧不该被静默跳过 —— 那是"客户端看起来卡住了但没人报错"的来源。
    throw new SseParseError(`SSE 帧内 JSON 解析失败: ${(e as Error).message}`, raw)
  }
  return { event, data: parsed }
}
