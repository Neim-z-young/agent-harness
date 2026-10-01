/**
 * 扩展侧的类型面：sidecar 握手、传输接口、以及"渲染算子"。
 *
 * 分层纪律：本文件**不 import `vscode`**。
 * 参与者（`participant.ts`）是唯一把算子翻成 `ChatResponseStream` 调用的地方，
 * 这样映射逻辑可以脱离 VSCode 单测。
 */

// ========================================================================
// 1. sidecar 握手
// ========================================================================

/**
 * `harness a2a --json` 的第一行 stdout（**契约化**，带 `v` 字段可演进）。
 *
 * 实测一份（见设计稿 §9）：
 * ```json
 * {"v":1,"pid":82400,"port":65184,"protocolVersion":"1.0",
 *  "rpcUrl":"http://127.0.0.1:65184/a2a",
 *  "cardUrl":"http://127.0.0.1:65184/.well-known/agent-card.json",
 *  "controlUrl":"http://127.0.0.1:65184/harness/rpc",
 *  "auth":"anonymous","permissionMode":"ask","cwd":"..."}
 * ```
 */
export interface SidecarHandshake {
  /** 握手契约版本；不认识就该报错而不是硬解析 */
  readonly v: number
  readonly pid: number
  readonly port: number
  readonly protocolVersion: string
  readonly rpcUrl: string
  readonly cardUrl: string
  readonly controlUrl: string
  readonly auth: 'anonymous' | 'bearer'
  readonly permissionMode: 'allow-all' | 'ask' | 'deny-all'
  readonly cwd: string
}

/** 握手契约的当前版本；收到更高的 `v` 时拒绝（避免按旧字段硬解析） */
export const HANDSHAKE_VERSION = 1

// ========================================================================
// 2. 传输接口（设计稿 §2.5）
// ========================================================================

/** 一次流式发送的结果元信息 */
export interface SendResult {
  /** 任务 id（`CancelTask` 用） */
  readonly taskId: string
  /** 会话 id —— 就是 A2A 的 `contextId`，跨轮续接靠它 */
  readonly contextId: string
}

/**
 * 扩展侧唯一的传输面。
 *
 * 案 A（A2A HTTP+SSE）与将来的案 B（stdio）各一个实现，参与者只认这个接口 ——
 * 这样换传输是"加一个实现"而不是"改一遍"。
 */
export interface HarnessTransport {
  /** 起 sidecar 并拿到端点 */
  start(): Promise<SidecarHandshake>
  /**
   * 流式发送一条用户消息。
   *
   * 产出的是 **A2A `StreamResponse` 的线上 JSON**（`{task}` / `{message}` /
   * `{statusUpdate}` / `{artifactUpdate}` 之一），不是 harness 的 `AgentStreamEvent` ——
   * 跨进程之后拿到的只能是协议表示，这点映射层必须按它写（设计稿 §5 已按此订正）。
   */
  send(
    ctx: { contextId?: string; taskId?: string },
    text: string,
    signal: AbortSignal,
  ): AsyncIterable<unknown>
  cancel(taskId: string): Promise<void>
  /** 控制通道（设计稿 §6）：斜杠命令走这里，不走 A2A */
  control(method: string, params?: unknown): Promise<unknown>
  dispose(): Promise<void>
}

// ========================================================================
// 3. 渲染算子
// ========================================================================

/**
 * A2A 事件 → 渲染算子的产物。
 *
 * 稳定版 `ChatResponseStream` **只有 7 个方法**（markdown / anchor / button /
 * filetree / progress / reference / push；`thinkingProgress` 等在 proposed），
 * 所以推理块、工具块、警示一律用 markdown / progress 拼 —— 算子刻意只留
 * "稳定版能表达"的这几种，不定义渲染不出来的东西。
 */
export type RenderOp =
  /** 正文增量（markdown） */
  | { readonly kind: 'text'; readonly text: string }
  /** 进度提示（工具调用 / 步骤 / 闸门心跳） */
  | { readonly kind: 'progress'; readonly text: string }
  /** 权限待决：参与者据此弹四态对话框 */
  | {
      readonly kind: 'permission'
      readonly tool: string
      readonly patterns: readonly string[]
      readonly options: readonly string[]
      readonly question: string
    }
  /** 终态 */
  | { readonly kind: 'done'; readonly state: string; readonly text?: string }
  /** 错误（协议错误 / 传输错误都归一到这里） */
  | { readonly kind: 'error'; readonly code: number; readonly message: string }
  /** 静默帧（已处理但不产生可见输出） */
  | { readonly kind: 'noop' }
