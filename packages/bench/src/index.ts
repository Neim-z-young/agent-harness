/**
 * @harness/bench —— Benchmark 跑分框架（τ-bench / τ³-bench retail 域起步）
 *
 * 三块适配（方案定稿 2026-10-09）：
 * 1. 域 API 工具桥接：`createRetailPlugin` 经 `core.tool.pool.assemble` 注入 16 个 retail 工具
 * 2. user simulator 外层循环：独立模型调用（`UserSimulator`），不进 agent 主循环
 * 3. judge：环境数据库终态校验（gold 回放 vs 轨迹回放 deepEqual），轨迹从 session.messages 导出
 *
 * 指标：官方 pass^k + 自有成本/延迟/步数（从运行结果聚合）。
 * CLI：`bun packages/bench/src/cli.ts --model <id> --user-model <id> [...]`
 */
export * from './types'
export { loadRetailDb, loadRetailTasks, loadRetailSplit, loadRetailPolicy, loadUserSimGuidelines, loadTasksBySplit } from './data'
export {
  createRetailPlugin,
  buildRetailHarnessTools,
  executeRetailTool,
  evalMathExpression,
  round2,
  RETAIL_TOOL_NAMES,
  MUTATES_STATE_TOOLS,
} from './retail/tools'
export { judgeTask, deepEqualWithDiff, type JudgeResult } from './judge'
export { UserSimulator, detectTermination, STOP, TRANSFER, OUT_OF_SCOPE } from './user-sim'
export { runTask, createRetailAgentDef, buildRetailAgentPrompt, buildUserSimProvider, INITIAL_GREETING, type TaskRunOptions, type ProviderOpts } from './runner'
export { summarize, renderReport, writeResults, type BenchSummary, type TaskSummary } from './metrics'
