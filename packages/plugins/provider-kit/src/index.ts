/**
 * `@harness/provider-kit` —— Provider 的**跨协议公共底座**。
 *
 * 边界（刻意很窄）：只放「各协议都完全一样」的两件事 —— SSE 分帧与请求时限/取消桥。
 * **不放**任何协议细节（请求体构造、事件名、字段映射、用量归一），那些是 Anthropic
 * 的 `content_block_delta` 与 Gemini 的 `candidate.parts` 之间**真实**的差异，
 * 强行抽象会把两家都变成一堆 `if (provider === ...)`。
 */
export { SseDecoder, type SseFrame } from './sse'
export { RequestDeadline, STREAM_TOTAL_TIMEOUT_FACTOR } from './deadline'
