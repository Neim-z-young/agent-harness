/**
 * 用量统计累积器 —— 实现已迁至 `@harness/usage`（引擎层与所有宿主共用同一套口径）。
 *
 * 这里保留**薄再导出**：CLI 内部（tui / usage-today / index）与既有测试长期从
 * `./usage-stats` 取用。迁包的目的不是改导入路径，而是**让引擎层也能累加**——
 * 在此之前只有 TUI 会写 `meta.usageStats`，于是子 agent 会话与 headless 宿主的
 * 用量完全不可见（真机：6 个子会话约 1.5M 输入 token 不入账）。
 *
 * 新代码请直接 `import { … } from '@harness/usage'`。
 */
export * from '@harness/usage'
