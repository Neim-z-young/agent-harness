/**
 * @harness/a2a-server —— A2A（Agent2Agent）服务端宿主
 *
 * 定位（`docs/external-integration-plan.md` §3.2 / AGENTS.md「业务能力一律通过插件注入」）：
 * **宿主 / 适配器层**，与 `@harness/cli` 同级，不是业务能力插件。只做装配与协议翻译，
 * 不内置任何业务决策、不绕过权限、不直接调工具 —— 全部能力经 `@harness/host` 的既有公共面
 * 与插件机制进入。
 *
 * 协议口径**一律取自 SDK 常量**（`AGENT_CARD_PATH` / `A2A_PROTOCOL_VERSION` / `A2A_VERSION_HEADER`
 * / `TaskState`），不照抄网上示例：A2A v0.3 → v1.0 是 breaking 变更（方法名、枚举名、Part 结构
 * 都改过），而大量现成示例仍是 v0.3 写法。
 */

// 1. 纯映射层（协议翻译，无 IO）
export {
  TEXT_MEDIA_TYPE,
  ANSWER_ARTIFACT_NAME,
  DEFAULT_CHUNK_CHARS,
  PERMISSION_ANSWERS,
  StreamAdapter,
  buildPermissionMetadata,
  buildPermissionQuestion,
  dataPart,
  extractText,
  isTerminalState,
  localId,
  messageOf,
  parsePermissionAnswer,
  stateFromName,
  stateName,
  taskStatus,
  textPart,
} from './mapping'
export type { A2aEmission } from './mapping'

// 2. AgentCard 生成
export {
  BEARER_SCHEME_NAME,
  JSONRPC_BINDING,
  buildAgentCard,
  cardToJSON,
  selectExposedAgents,
  skillOf,
} from './card'
export type { BuildAgentCardOptions } from './card'
// 卡路由路径（协议常量，取自 SDK）—— 消费方（CLI / 文档）不必直接依赖 SDK
export { AGENT_CARD_PATH } from '@a2a-js/sdk'

// 3. 认证与调用方隔离（plan §3.5）
export { CallerRegistry, LOCAL_CALLER, callerKey, extractBearer, verifyBearer } from './auth'

// 4. 结构化错误
export {
  A2aServerError,
  ConcurrentTaskError,
  ContextForbiddenError,
  DuplicateMessageError,
  TooManyTasksError,
  UnauthorizedError,
} from './errors'
export type { A2aErrorCode } from './errors'

// 5. 挂起表（远程权限的核心机制，plan §3.4）
export { DEFAULT_SUSPEND_TTL_MS, SuspendTable } from './suspend'
export type { PendingAsk, SuspendOutcome, SuspendResult, SuspendTableOptions } from './suspend'

// 6. AgentExecutor（harness 流 → A2A 任务生命周期）
export { HarnessAgentExecutor } from './executor'
export type { A2aLogger, HarnessAgentExecutorOptions } from './executor'

// 7. 服务端宿主（HTTP + SSE，挂 Bun.serve）
export {
  DEFAULT_A2A_HOSTNAME,
  DEFAULT_A2A_PORT,
  DEFAULT_JSONRPC_PATH,
  DEFAULT_MAX_CONCURRENT_TASKS,
  createA2aServer,
} from './server'
export type { A2aServer, A2aServerOptions } from './server'
