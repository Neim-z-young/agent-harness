/**
 * SSE 帧解码（Server-Sent Events）—— 各 Provider 共用**同一份**分帧口径。
 *
 * 为什么必须共用：此前 anthropic / gemini / openai 三家各写了一遍「按空行切帧 + 取 data:
 * 前缀」，三份实现各自漏了不同的边界：
 *   - 只按 `\n\n` 切 ⇒ 上游用 **CRLF**（`\r\n\r\n`）时一帧都切不出来：SSE 事件永远等不到
 *     空行分隔，整条流在「无任何 delta」的状态下静默跑完，最后只 yield 一个 `done`。
 *     这种失败**不会报错**，用户只看到「模型什么都没说」。
 *   - 按行状态机（`event:` / `data:` / 空行派发）若把状态放在**单次 `reader.read()` 的
 *     作用域内**，一个事件被 TCP 切成两块时后半块就丢掉前半块的状态 ⇒ 该事件整帧丢失。
 *   - 多行 `data:`（SSE 规范允许，用 `\n` 连接）在三份实现里都被「后一行覆盖前一行」。
 *
 * 本解码器是**纯状态机**：`push(chunk)` 进、帧数组出，与 fetch / TextDecoder 无关，
 * 因此可以在任意平台、不启服务的前提下逐条单测（见 sse.test.ts）。
 */
export interface SseFrame {
  /** `event:` 字段；上游没写则不含该键（多数网关只发 `data:`） */
  event?: string
  /** `data:` 负载；多行按 SSE 规范以 `\n` 连接 */
  data: string
}

/** 行分隔符：CRLF 优先，其次 LF，最后裸 CR（老式 Mac / 部分网关） */
const LINE_BREAK = /\r\n|\n|\r/

export class SseDecoder {
  private buffer = ''
  private event: string | undefined
  private data: string[] = []

  /**
   * 喂入一块（**已解码的**）文本，返回本次能完整切出的帧。
   *
   * 调用方负责把 `Uint8Array` 经 `TextDecoder({ stream: true })` 转成文本 —— 解码职责
   * 不放进本类，否则「字符跨 chunk 截断」的修补会散落在每个 provider 里。
   */
  push(chunk: string): SseFrame[] {
    if (!chunk) return []
    this.buffer += chunk
    const frames: SseFrame[] = []
    for (;;) {
      const match = LINE_BREAK.exec(this.buffer)
      if (!match) break
      // 末尾孤立的 `\r`：可能是下一块 `\n` 的前半，等它到齐再断行，
      // 否则会把 `\r\n` 拆成两个空行（凭空多切一帧）。
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break
      const line = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.#consumeLine(line, frames)
    }
    return frames
  }

  /**
   * 流结束时调用：把**没有尾随空行**的残留帧交出来。
   *
   * 上游正常会在最后一帧后补空行，但自建网关常常「发完就关」⇒ 最后一条
   * `data:` 留在 buffer 里。不 flush 的后果是丢掉最后一帧（Gemini 的 usage 帧、
   * Anthropic 的 message_delta 都可能正好是最后一条）。
   */
  flush(): SseFrame[] {
    const frames: SseFrame[] = []
    if (this.buffer.length > 0) {
      const rest = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer
      this.buffer = ''
      this.#consumeLine(rest, frames)
    }
    this.#dispatch(frames)
    return frames
  }

  #consumeLine(line: string, frames: SseFrame[]): void {
    if (line === '') {
      this.#dispatch(frames)
      return
    }
    // `:` 开头是注释（心跳常用 `: keep-alive`），整行忽略
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    // 规范：字段名后允许有**一个**前导空格
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'event':
        this.event = value
        break
      case 'data':
        this.data.push(value)
        break
      default:
        // `id:` / `retry:` 本仓不用（无断线重连语义），静默忽略
        break
    }
  }

  #dispatch(frames: SseFrame[]): void {
    if (this.data.length === 0) {
      this.event = undefined
      return
    }
    const frame: SseFrame = { data: this.data.join('\n') }
    if (this.event) frame.event = this.event
    frames.push(frame)
    this.event = undefined
    this.data = []
  }
}
