/**
 * 当日（跨会话）用量归集 —— 实现已上移 `@harness/usage`（P2-v1）。
 *
 * 上移原因：sidecar（@harness/a2a-server）的 `harness/stats.get` 也要归集当日用量，
 * 而它不能反向依赖 CLI；`collectTodayUsage` 本身只依赖 @harness/usage 的纯函数，
 * 没有留在 CLI 的理由。这里保留**薄再导出**以维持既有导入面（index / tui / 测试）。
 *
 * 新代码请直接 `import { collectTodayUsage } from '@harness/usage'`。
 */
export { collectTodayUsage, type UsageStoreLike, type UsageSessionLike } from '@harness/usage'
