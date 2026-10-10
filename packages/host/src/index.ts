/**
 * @harness/host —— 宿主装配层
 *
 * 目标（`docs/external-integration-plan.md` §6 P0）：CLI / TUI / headless 与将来的
 * A2A server、VSCode 扩展**共用同一份装配**，避免"两份装配必然分叉"。
 * 本包只做装配与注入，不内置业务决策、不绕过权限、不直接调工具。
 *
 * ## 搬迁进度：P0 原清单实测分三档（不是"六个符号一次搬完"）
 *
 * | 档 | 符号 | 闭包情况 | 状态 |
 * |---|---|---|---|
 * | **A** | `loadPluginDirs` + `PluginLoadResult` + `probeAgentPlugin` + `collectAgentPlugins` + `registerProviderTypeFactory` | **自足**：只依赖 `@harness/plugin` 的类型与 `@harness/workspace` 的 `MultiDirLoader`/`normalizeDirs`。且这是 A2A 宿主**必需**的能力（要能加载用户插件） | ✅ 已搬（§1） |
 * | **C** | `registerBuiltinProviderTypes` + `BuiltinPluginRegistry` / `getBuiltinRegistry` / `unknownBuiltinPluginIds` / `resolveBuiltinPlugins` + `BuiltinToolRegistry` / `getBuiltinToolRegistry` / `preloadBuiltinToolMetas` | **闭包自足**，但要连 `lazyImport` 一起搬（它是内置插件的统一惰性加载入口）。原清单漏了 `BuiltinToolRegistry` / `getBuiltinToolRegistry` / `unknownBuiltinPluginIds` / `registerBuiltinProviderTypes` —— 是闭包带出来的 | ✅ 已搬（§2） |
 * | **B** | `buildProviderWindowTable` + `resolveContextWindowTokens` + `normalizeProviderConfigs`（连同 `parseModelSpec` / `formatModel` / `sanitizeProviderId` / `ResolvedProviderConfig` / `ProviderConfigIssue` / `isUsableWindow`） | 连着 cli 的配置归一化层。**裁剪点**：不搬 `HarnessConfig`（那份配置模型有二十来段，窗口链只读两段），改用 `ProviderWindowConfigSource` 窄类型 —— 见 §3 开头 | ✅ 已搬（§3） |
 *
 * ⇒ 采用分步搬迁而非一次大 commit：每一步都要求 `cli.test.ts` 逐字通过（它直接 `import`
 * 这些符号，搬走必须保持导出面不变），用小步换定位成本。
 *
 * 剩余（P0 收尾）：`HarnessApp.boot` 主体 → `createHost({...})`，以及 boot 内 16 处
 * `stdout.write` 的三级分级 + 接管 SDK 的 console（P0.5 spike 结论）。
 *
 * ## ⚠️ 本包不"自带"内置插件
 * §2 的注册表引用了一批 `@harness/*` specifier（provider-* / tools-* / 编排类），但**只在运行期**
 * `import()` 它们；本包只提供登记与解析逻辑。因此：
 *   - TS 侧不需要这些包（specifier 是 `string`，不是 import 语句）；
 *   - 运行期由消费方的依赖树解析 ⇒ 已把它们列入本包 `dependencies` 作为**可机读的契约**；
 *   - `bun build --compile` 打包时需按该清单显式收入口（`import(变量)` 无法被静态分析）。
 */

export { lazyImport } from './lazy'

// ========================================================================
// 1. 装配原语：外部插件目录加载 + 内置注册表（A 档 / C 档）
// ========================================================================
// 实现单独成文件（`./plugins.ts`）—— 理由见该文件头：叶子模块不得反向 import barrel，
// 而 `./host.ts` 的 HarnessHost 正需要这里的装配原语。index.ts 只做转出，消费方取值口径不变。
export {
  collectAgentPlugins,
  registerProviderTypeFactory,
  loadPluginDirs,
  registerBuiltinProviderTypes,
  BuiltinPluginRegistry,
  getBuiltinRegistry,
  unknownBuiltinPluginIds,
  resolveBuiltinPlugins,
  BuiltinToolRegistry,
  getBuiltinToolRegistry,
  preloadBuiltinToolMetas,
} from './plugins'
export type { PluginLoadResult, BuiltinGeneralPlugin } from './plugins'


// ========================================================================
// 3. 配置归一化与上下文窗口推导
// ========================================================================
// 已单独成文件（`./provider.ts`）。这里只做转出，保持消费方一律 `from '@harness/host'` 取值。
export {
  parseModelSpec,
  formatModel,
  sanitizeProviderId,
  normalizeProviderConfigs,
  isUsableWindow,
  resolveContextWindowTokens,
  buildProviderWindowTable,
} from './provider'
export type {
  ProviderConfigIssue,
  ResolvedProviderConfig,
  ProviderWindowConfigSource,
  ProviderWindowTableView,
} from './provider'

// ========================================================================
// 4. 配置模型与配置层语义检查（P0 收尾 S2 第一步：自 @harness/cli 上移）
// ========================================================================
// `HarnessConfig` 与各段检查器（compression / compaction / memory / telemetry）、ACP 档位翻译、
// Provider 校验和配置概览。它们此前住在 `@harness/cli`，但 `boot()` 直接依赖 —— 而 host 不能再
// 反向 import cli。单独成文件（`./config.ts`），与上面的纯推导分开：那一节是"分母从哪来"，
// 这一节是"配置写了什么、生效了没有"。
export * from './files'
export * from './config'


// ========================================================================
// 4. 装配期诊断通道（P0 收尾 · S1）
// ========================================================================
// `HostNotice` / `renderNotice` / `installConsoleCapture` 单独成文件（`./notice.ts`）：
// 它们是**装配期的输出面**，与 §2 的注册表、§3 的纯函数推导没有共同闭包，混在一起会让
// "这一节在讲什么"变模糊。这里只做转出，便于消费方一律 `from '@harness/host'` 取。
export {
  NOTICE_LEVEL,
  makeNotice,
  renderNotice,
  installConsoleCapture,
} from './notice'
export type {
  HostNotice,
  NoticeCode,
  NoticeData,
  NoticeLevel,
  NoticePayloads,
  NoticeSink,
  NoticeVariant,
} from './notice'

// ========================================================================
// 5. 权限接缝（P0 收尾 S2 第二步）
// ========================================================================
// 四态答复 + 交互引擎。上移的理由是**语义只能有一份**：今天「先判永久 → 写回规则 → 再判单次」
// 只写在 cli 的 CliPermissionEngine 里，A2A / VSCode 各起一份就是同一安全边界的第二套写法。
export {
  InteractivePermissionEngine,
  buildPermissionPrompt,
  assessRisk,
  stateHashOf,
} from './permission'
export type {
  PermissionAnswer,
  PermissionAskInput,
  PermissionAsker,
  PermissionMode,
  PermissionPrompt,
  PermissionStoreFile,
  RiskLevel,
  HumanDecisionEvent,
} from './permission'

// ========================================================================
// 6. 宿主装配主体（P0 收尾 S2 第三步：自 @harness/cli 上移）
// ========================================================================
// `HarnessHost`（装配实现，≈1150 行）+ `HostOptions` / `SessionRestoreInfo` / `createHost`。
// 单独成文件（`./host.ts`）—— 它要用 §1 的装配原语，而叶子模块不得反向 import 本 barrel。
export { HarnessHost, createHost, HOST_NOTICE_LIMIT } from './host'
export type { Host, HostOptions, BuiltinWarmupResult, SessionRestoreInfo } from './host'
