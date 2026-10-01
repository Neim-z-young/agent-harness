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
