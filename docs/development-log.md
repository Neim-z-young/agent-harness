# Agent Harness 开发日志

## 2026-08-28（续 28）：惰性 Provider 展示元信息 — help/config check 未加载插件即可列出

### 背景

Provider 已惰性加载（续 26 / 续 27），但 help 只静态硬编码示例、`/model?` 只列运行时已配置 id；依赖 Provider 模块 import 才能展示的类型清单在 help 场景出现缺口。用户要求：help 里列出可支持的 provider 时，即使插件未完全加载，也应能展示，且人机交互友好（附描述/默认模型/用法，调用时再自动加载）。

### 改动

1. **抽象层 `@harness/plugin` 增加展示元信息通道**（[plugin/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugin/src/index.ts)）
   - 新增 `ProviderTypeMeta`：`type/description/defaultModel/requiresApiKey/builtin/usage`。
   - `ProviderTypeRegistry.register(factory, meta?)` 可附带登记元信息；新增 `meta(type)` 与 `listMeta()`（未登记 meta 的类型也返回仅含 type 的占位，保证清单完整）。
   - 元信息在 register 时同步写入，**不调用 createPlugin、不 import 任何 Provider 模块**。
2. **cli 内置元信息表 + 惰性注册同步登记**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）
   - 新增 `BUILTIN_PROVIDER_META`（anthropic/openai/gemini/glm/qwen/mock 的描述、默认模型、是否需 key、用法示例），`registerBuiltinProviderType` 注册惰性工厂的同时登记该元信息。
   - 新增 `formatProviderTypeList(registry, includeUsage)` 与 `buildProviderTypesSection(registry)`：从 listMeta 生成友好清单（`[内置]`/`[插件]` 标注、需 key 提示、默认模型、`/model` 用法），纯元信息驱动、零模块加载。
3. **接线展示**：`main` 的 `help` 分支追加 `buildProviderTypesSection`（同步登记内置元信息即可展示）；`config config check` 在概览后追加含外部插件的完整清单（`buildCheckRegistry` 已加载 plugins）。
4. 测试：`@harness/plugin` 增加 registry meta/listMeta（含占位）用例；cli 增加"同步注册后 listMeta 即可列出、无需加载模块"与 `formatProviderTypeList`/`buildProviderTypesSection` 输出用例。

### 验证

- 全 28 包 typecheck 通过；`@harness/plugin` 38 例、`@harness/cli` 116 例全绿。
- 惰性语义不变：`resolve(type).createPlugin` 仍按需 dynamic import；列表展示仅读元信息，不触发 Provider 模块加载。

## 2026-08-28（续 27）：抽象层扩至运行时能力（subagent / swarm），消除 cli 对业务插件的依赖倒置残留

### 背景

续 26 已把 Provider 依赖倒置消除。cli 仍残留对两个业务插件的直连：`attachBackgroundTaskPanel` 直接 `import { BackgroundTaskMonitor }` 自 `@harness/subagent`，`runTeammateCli` 直接 `import { createSwarmManagers/startTeammateLoop/TeammateTaskState/… }` 自 `@harness/swarm`。经与用户确认：「组合根直连内置插件」作为干净架构常态基线被接受，但该处残留按「完整抽象：swarm+subagent」推进。因此抽象层持续下垫：cli 业务逻辑只经抽象接口交互，具体能力对象由插件包导出并在组合根装配。

### 改动

1. **抽象契约落位 `@harness/plugin`**（[plugin/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugin/src/index.ts)）新增「运行时能力服务契约」，全部取最小结构契约，抽象层不反向依赖具体插件：
   - `BackgroundProgressLike` / `BackgroundTaskViewLike` / `BackgroundTaskListenerLike` / `BackgroundTaskMonitorLike`：后台任务监控的最小结构视图（与 subagent `BackgroundTaskProgress/View/Listener/Monitor` 结构兼容）。
   - `SubagentCapability`（`createMonitor({ bus, parentSessionIds? })`）。
   - `SwarmLoopDeps` / `SwarmLoopHandle`（`isDone/stop`）/ `SwarmCapability`（`sanitizeName/formatAgentId/startTeammateLoop`）。
2. **subagent 插件实现抽象并导出能力**（[subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）：新增 `subagentCapability: SubagentCapability`，内部 `new BackgroundTaskMonitor(options)`。
3. **swarm 插件实现抽象并导出能力**（[swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：新增 `swarmCapability: SwarmCapability`，`startTeammateLoop(deps)` 内部完成 `createSwarmManagers`、teammate 状态构建与循环封装，并把底层 `TeammateLoopHandle` 适配为抽象 `SwarmLoopHandle`（`isDone = !running`）。
4. **cli 只消费抽象层**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：
   - 删除对 `BackgroundTaskMonitor`/`BackgroundTaskView`/`createSwarmManagers`/`startTeammateLoop`/`TeammateTaskState`/`TeammateTickDeps` 等具体实现类型的直接引用；cli 业务函数不再 import 这些类型。
   - `attachBackgroundTaskPanel` 改经 `subagentCapability.createMonitor(...)`，打印状态映射改用抽象 `BackgroundTaskViewLike['status']`。
   - `runTeammateCli` 改经 `swarmCapability.sanitizeName/formatAgentId/startTeammateLoop`，等待收尾改用 `loop.isDone()` 而非读取具体 `state.status`。
   - 组合根仅导入具体插件导出的能力对象（`subagentCapability` / `swarmCapability`），属「组合根直连内置插件」基线内。
5. 附带修复 `@harness/plugin` 的 `plugin.test.ts` 两处既有类型错误：`resolveProviderTypeFactory` 用例的 `createPlugin` 返回体补齐 AgentPlugin 最小桩，因抽象契约已把返回类型收紧为 `AgentPlugin | undefined`。

### 验证

- 全量 28 包 typecheck 通过
- `@harness/plugin` 37 例、`@harness/subagent` 93 例（新增 capability 1 例）、`@harness/swarm` 65 例（新增 capability 2 例）、`@harness/cli` 114 例均全绿
- 注：根目录 `bun test` 扫描未装依赖的 `reference/` 私有目录产生的既有失败与本改动无关

## 2026-08-28（续 26）：Provider 抽象层，消除 core/cli 对具体 Provider 的依赖倒置

### 背景

续 20 已用 `ProviderTypeRegistry` 替代硬编码 `type` 枚举，但抽象契约仍定义在 cli 内部（cli 自建 `ProviderTypeFactory`/`ProviderTypeRegistry`、`registerBuiltinProviderTypes` 逐个 `import()` 具体 `provider-*` 包并做各自的配置映射）。这仍是**高层（core/cli）直接依赖低层具体 Provider 实现**，违背依赖倒置。要求：建立一层抽象层，core 和 cli 只使用抽象层接口，插件（Provider 包）实现抽象层，core 只经抽象层交互。

### 改动

1. **抽象层落位 `@harness/plugin`**（[plugin/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugin/src/index.ts)）：
   - 新增 `ProviderConfig`（含 `[key: string]: unknown` 透传）契约；
   - 新增 `ProviderTypeFactory`（`type` + 可异步的 `createPlugin`）契约；
   - 新增 `ProviderTypeRegistry`（`register/resolve/list/clear`）注册表；
   - 新增 `resolveProviderTypeFactory(mod)`：统一从插件模块导出识别三种工厂形态（`providerTypeFactory` / `providerType`+`createProviderPlugin` / `default` 包装）。
2. **6 个 Provider 包实现抽象层**（`provider-*`）：
   - 各包新增导出 `providerTypeFactory`，`createPlugin(config: ProviderConfig)` 在**包内部**完成「`ProviderConfig` → 该 Provider 配置结构」的映射（`model`→`defaultModel`、`id`→`providerId` 等），把原本散落在 cli 的逐类型映射下沉到实现方。
3. **cli 只消费抽象层**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：
   - 删除 cli 本地重复的 `ProviderTypeFactory` 接口、`ProviderTypeRegistry` 类、`ProviderConfig` 接口，改用 `@harness/plugin` 导入；
   - 删除对 `@harness/provider-openai/gemini/glm/qwen` 的具体配置类型导入；
   - `registerBuiltinProviderTypes` 重写为**通用惰性登记**：只登记「`type` → 模块 specifier」，`createPlugin` 时 `lazyImport()` + `resolveProviderTypeFactory()` 解析出实现方工厂并委托，**不再含任何具体 Provider 配置结构/工厂的硬编码映射**，仍保持惰性加载不影响启动速度。
   - `registerBuiltinProviderTypes` 签名收敛为单参数 `(registry)`，两处调用点与 cli 测试同步更新。

### 验证

- 全量 26 包 typecheck 通过
- `@harness/plugin` 37 例全绿（新增：`ProviderTypeRegistry`、`resolveProviderTypeFactory` 三种形态 + 无契约回退 5 例）
- `@harness/cli` 114 例全绿（新增：内置 6 个 `provider-*` 包装 `providerTypeFactory` 契约逐包校验 1 例）
- 6 个 `provider-*` 包各自用例全绿
- 注：根目录 `bun test` 会扫描未装依赖的 `reference/` 私有目录产生大量既有失败（含 `tools-builtin`/`Ctrl-B` 环境性 flaky），与本次改动无关；本改动未触碰这些文件

## 2026-08-28（续 25）：内置插件统一注册 + 惰性加载

### 背景

内置 Provider 模块（anthropic/openai/gemini/glm/qwen/mock）与 `tools-builtin` 此前在 cli 顶部**静态 import**，进程一启动就全部求值，既不"支持加载"（无法与外部插件统一管理/装卸），也拖慢启动。要求：**随应用打包的内部插件也要支持加载**，且**插件加载支持惰性加载**，尽量不影响启动速度。

### 改动

1. **内置 Provider 类型惰性化**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：
   - `registerBuiltinProviderTypes` 改为登记「`type` → 惰性 `createPlugin`」，`createPlugin` 内部经 `lazyImport()` 在真正按 `config.type` 解析 Provider 时才 `import()` 对应模块；`type` 名仍在启动时登记（供配置校验）。
   - `ProviderTypeFactory.createPlugin` 返回值放宽为 `AgentPlugin | undefined | Promise<AgentPlugin | undefined>`，`buildProviderPlugin` 改为异步；`mock`/`anthropic` 兜底改用 `lazyMockProvider()`/`lazyAnthropicProvider()`。
   - 顶部仅保留 `import type`（配置类型），移除运行时静态 import。
2. **内置通用插件统一注册表**（新增 `BuiltinPluginRegistry` / `getBuiltinRegistry` / `BuiltinGeneralPlugin`）：登记「id + 描述 + source=`builtin` + 惰性 `load()`」，`tools-builtin` 经此惰性加载（boot 时才 import），与外部插件目录 `loadPluginDirs` 并列，满足"内部插件也要支持加载"。
3. **启动速度**：`harness --help` / `--check-config` 不再加载任何 Provider 模块；repl 也只在真正用到对应 type 时加载所需 Provider，未用到的 anthropic/gemini/glm/qwen 不会加载。

### 验证

- cli 113 用例全绿（新增：内置 Provider 惰性解析、BuiltinPluginRegistry 惰性加载 2 例）；全量 26 包 typecheck 通过
- 注：`Ctrl-B 切换侧栏` TUI 用例为既有偶发 flaky（原代码上复现），与本次改动无关

## 2026-08-28（续 24）：消除 CLI 对业务插件的依赖倒置

### 背景

项目约束强调"插件化、所有插件可插拔、不与项目本身耦合"。续 23 中电脑控制实现把 `mcp-server-registry` 与 `computer-use` 硬编码进 CLI，属高层（CLI）直接依赖低层具体插件，违背依赖倒置原则，本次修正。

### 改动

1. **移除 CLI 硬编码依赖**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：
   - 删除 `import { createMcpServerRegistryPlugin } from '@harness/mcp-server-registry'`、`import { createComputerUsePlugin } from '@harness/computer-use'`
   - 删除 `providerPlugins.push(createMcpServerRegistryPlugin()); providerPlugins.push(createComputerUsePlugin())`
   - 移除 cli/package.json 中 `@harness/computer-use`、`@harness/mcp-server-registry` 依赖
2. **改为项目级可插拔插件**（[.harness/plugins/mcp.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/.harness/plugins/mcp.ts)）：经既有 `loadPluginDirs`（user `~/.harness/plugins` → project `.harness/plugins`）加载，`export const plugins = [createMcpServerRegistryPlugin(), createComputerUsePlugin()]`；删除该文件即可停用，无需改动 CLI/core
3. **消除误报警告**（cli/src/index.ts `registerProviderTypeFactory`）：已导出通用 AgentPlugin 的模块直接返回，不再打印"未导出 Provider 工厂，已忽略"的误导日志

### 验证

- `loadPluginDirs` 实际加载 `.harness/plugins/mcp.ts` → 得到 `mcp.server-registry`、`computer-use` 两个插件，无警告
- cli 111 用例全绿；全量 26 包 typecheck 通过

## 2026-08-28（续 23）：电脑控制 MCP server 插件 + MCP Server Registry

### 背景

用户希望基于 `reference/电脑控制mcp 功能.md` 实现一个「电脑控制」MCP server 插件：插件加载时自动启动并注册到 MCP，连接统一由 mcp-client 管理。为避免与 core 集成，注册机制采用独立的 `mcp-server-registry` 插件：所有 mcp server 相关插件都依赖它去启动，提高复用度。后端选「真实 macOS 自动化」（osascript）。

### 实现

**1. `@harness/mcp-server-registry`（[mcp-server-registry/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/mcp-server-registry/src/index.ts)）**

- `McpServerRegistry`：`register / unregister / has / list / clear`，支持两条注册路径：
  - `config`：外部 server（stdio/http/sse），用 `@harness/mcp-client` 的 `defaultTransportFactory` 拉起
  - `createTransport`：进程内 / 自定义启动器，返回 `@harness/mcp-client` 的 `McpTransport`
- `registerMcpServer() / unregisterMcpServer() / listRegisteredMcpServers()`：模块级默认注册表
- `createMcpServerRegistryPlugin()`：在 `harness.start` 连接所有已注册 server（`McpClient` + `connect`）、`tool.pool.assemble` 暴露 `convertMcpToolToHarnessTool` 转出的工具、提供 `/mcp [servers | tools]` 命令、unload 时断开

**2. `@harness/computer-use`（[computer-use/src/mac.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/computer-use/src/mac.ts) + [server.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/computer-use/src/server.ts) + [index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/computer-use/src/index.ts)）**

- `ComputerUseBackend`：通过 `/usr/bin/osascript`（System Events）+ `/usr/sbin/screencapture` 实现 11 种电脑操作（check_permissions / list_apps / get_app_state / click / scroll / drag / type_text / press_key / perform_action / set_value / select_text），执行器可注入（测试 mock）
- `ComputerUseMcpServer`：进程内 MCP JSON-RPC server（initialize / tools/list / tools/call），把后端方法映射为 MCP 工具，工具 schema 对齐参考文档
- `createComputerUseServerTransport()`：把进程内 server 包装为 `McpTransport`，供 registry 连接
- `createComputerUsePlugin()`：`dependsOn ['mcp.server-registry']`，`install` 时 `registerMcpServer` 注册进程内 server，`harness.init` 时经 `output.harness.skillManager.register` 注册一个 `loadedFrom: 'plugin'` 的「Computer Use」操作指南技能

**3. 装配（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）**

- CLI 默认安装 `createMcpServerRegistryPlugin()` + `createComputerUsePlugin()`，实现「注册 → harness.start 自动启动进程内 server 并通过 mcp-client 连接 → 工具进工具池」

### 验证

- mcp-server-registry 4 用例：注册表 CRUD、harness.start 连接 + assemble 暴露工具 + 工具可调用（pass-through）、`/mcp servers|tools`、config 缺失 command 不阻塞其余
- computer-use 9 用例：JSON-RPC initialize / tools/list（11 工具）/ tools/call 分发与报错 / 通知无响应 / 未知方法 / transport 对接 McpClient 连通性 / 插件注册 server + 注册 plugin 来源 Skill
- cli 111 用例全绿（接入新插件后无回归）；全部 26 包 typecheck 通过

## 2026-08-28（续 22）：插件 / 技能管理（enable / disable / reload + 技能来源标注）

### 背景

续 21 统一 `plugins` 目录后可加载各种插件，但缺少对插件与技能的运行时管理能力，也无法从插件注册技能、标注技能的加载来源。本次补齐「插件管理 + 技能管理 + 插件来源技能 + 来源标注」闭环。

### 实现

**1. 技能来源标注（[packages/skill/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.ts)）**

- `SkillSource` 增加 `'plugin'`（插件注册来源），与 `bundled / user / project / mcp` 并列为五来源
- 新增 `formatSkillSource(source)`：五来源的中文标注（内置 / 用户 / 项目 / MCP / 插件），供 `/skills` 界面展示

**2. SkillManager 管理能力（同文件）**

- 接口与实现新增 `disable(id)`、`enable(id)`、`isDisabled(id)`
  - `disable`：从可用列表移除，缓存到 `disabled`（enable 可恢复），重复禁用幂等返回 `false`
  - `enable`：从禁用缓存恢复；未在缓存中则回落到 `reload`（从来源文件重载，等价新增技能启用）
  - `reload` 保持原启用/禁用状态：禁用技能重载后仍不可见，启用技能重载后仍可见

**3. core 暴露 skillManager（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）**

- `Harness` 接口与实现新增 `readonly skillManager?: SkillManager`；插件可在 `harness.init` hook 中通过 `output.harness.skillManager.register(...)` 注册 `plugin` 来源的技能

**4. CLI 管理命令（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）**

- `HarnessApp` 新增 `pluginRegistry`（boot 时登记「可管理」插件对象：Provider / 插件目录 / extraPlugins，排除 `toolsBuiltin` 与 `core.*`）
- 插件管理 API：`pluginInfos()`、`disablePlugin()`（unload）、`enablePlugin()`（按登记对象重装）、`reloadPlugin()`（hotReload）
- 技能管理 API：`skillInfos()`（含 `sourceLabel` 中文标注）、`disableSkill()`、`enableSkill()`、`reloadSkill()`
- REPL 新增 `/plugins` 与 `/skills` 命令（`enable | disable | reload` + 列表），并加入 `REPL_COMMANDS`（`/help` 可见）

### 验证

- skill 包新增 `formatSkillSource`、disable/enable/reload 状态保持与禁用心得等用例；skill 29 用例全绿
- cli 新增 `/plugins`、`/skills` 命令（列表/禁用/启用/未知来源/help）等用例；cli 72 用例全绿
- core / plugin 61 用例全绿；全部 26 包 typecheck 通过

## 2026-08-27（续 21）：统一 plugins 插件目录（支持各类插件）

### 背景

续 20 的 `provider-plugins` 专用目录只承担「Provider 类型工厂」一种插件约定，无法承载通用 AgentPlugin（Hooks 生命周期插件），且目录命名与「插件」的通用语义不符。用户要求统一为 `plugins` 文件夹，在一个目录里支持加载各种插件类型。

### 实现（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

1. **目录统一**：`~/.harness/provider-plugins` / `.harness/provider-plugins` → `~/.harness/plugins` / `.harness/plugins`（user → project，后加载覆盖）
2. **`loadPluginDirs(registry, dirs, log?)`** 取代 `loadProviderPluginDirs`，返回 `PluginLoadResult { plugins }`；一个模块可同时导出两类插件：
   - **通用 AgentPlugin**（Hooks 插件）：`default` / `plugin` / `plugins` 三种形态（含一层 default 包装）；按插件 `id` 去重，project 覆盖 user，最终随 `internalPlugins` 安装进 Harness
   - **Provider 类型工厂**（扩展 `config.type`）：`providerTypeFactory` 或 `providerType`+`createProviderPlugin`，注册进 `ProviderTypeRegistry`
3. **校验/自检联动**：`buildCheckRegistry` 与 boot 均改用 `loadPluginDirs`；未知 type 报错与帮助文案改指 `plugins` 目录
4. 坏模块（既无 AgentPlugin 也无 Provider 工厂）忽略并告警，不静默、不崩溃

### 验证

- CLI 测试重构为 64 个：新增 `providerTypeFactory` 形态、通用 AgentPlugin（default/plugin/plugins）、通用插件按 id 去重（project 覆盖 user）等用例
- cli 64 用例全绿，cli typecheck 通过

## 2026-08-27（续 17）：模型配置及切换

### 背景

模型缺失统一的配置入口与运行时切换能力：此前只能通过 Provider 插件传入（anthropic 的 `defaultModel` 或 Agent 定义 `model.modelId`），命令行/会话运行时无法便捷查看与切换模型。本次补齐「配置 → 运行时切换 → 状态展示」闭环。

### 实现（[index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts) / [tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）

1. **配置来源统一（优先级：CLI > config.json > 环境变量）**
   - `ConfigStore`（dataDir/config.json）：读写 `agentId / provider / model / anthropicApiKey`，缺文件/坏 JSON 幂等返回空
   - `resolveConfig`：main() 里把 CLI 参数与 config 合并（CLI 优先），代理/mock 测试注入不受影响
2. **CLI `-m, --model <modelId>`**：写入默认 Agent 定义 `model.modelId`（运行时 llmIn 取 `agent.model.modelId`），并作为 provider 的 `defaultModel` 兜底
3. **运行时 `/model` 命令**：`/model` 查看当前模型；`/model <modelId>` 更新当前 Agent 的 model 并持久化 config.json（影响下次 send）；列入 `/help` 与 REPL_COMMANDS
4. **TUI 状态展示**：`TuiReplOptions.model` 传入后，状态栏/侧栏初始即显示配置模型（此前要到首轮 done 才显示实际命中模型）
5. **boot() provider 合并**：anthropic 分支可按 config.json 的 `anthropicApiKey` 直接提供 key（显式配置 > config > 环境变量）

### 验证

- cli 74 用例全绿（新增 `--model` 解析、ConfigStore 往返/坏 JSON、resolveConfig 优先级、REPL `/model` 查看+切换+落盘、TUI 状态栏初始模型展示共 8 个），cli typecheck 通过

## 2026-08-27（续 20）：Provider 类型插件化（去掉硬编码 type 枚举）

### 背景

`ProviderConfig.type` 之前是硬编码枚举（anthropic/openai/gemini/glm/qwen/mock），CLI 内部 switch 分发，新增 Provider 类型必须改 CLI 代码——违背系统插件化理念。本次改为注册表 + 多级插件目录加载。

### 实现（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

1. **`ProviderConfig.type` 开放为任意字符串**：内置类型只是「已注册」的默认项，不再是枚举限制
2. **`ProviderTypeRegistry`**：`type → createPlugin(config)` 工厂注册表，`resolve/list` 动态解析（替代硬编码 switch）
   - `registerBuiltinProviderTypes(registry, options)`：内置 openai/anthropic/gemini/glm/qwen/mock 以注册方式装配（anthropic 仍捕获 options 兜底 key）
   - `HarnessApp.providerTypes` 公开注册表，第三方可在 boot 前注入自定义 type
3. **外部插件多级加载**：`loadProviderPluginDirs` 扫描 `~/.harness/provider-plugins`（user）→ `<project>/.harness/provider-plugins`（project，后加载覆盖）
   - 插件模块约定导出 `providerType: string` + `createProviderPlugin(config): AgentPlugin`（或 `providerTypeFactory` / default 同构）
   - 缺声明/加载失败 → 告警跳过（不静默、不崩溃）
4. **校验动态化**：`validateProviderConfigs(providers, defaultId, knownTypes)` 已知类型由注册表提供，未知 type 报错时列出已注册类型并提示 provider-plugins 扩展方式
5. **自检联动**：`--check-config` / `config check` 通过 `buildCheckRegistry` 加载外部插件后再校验

### 验证

- 新增测试：ProviderTypeRegistry（register/resolve/list/覆盖）、内置 6 类型齐全、loadProviderPluginDirs（约定加载/多级覆盖/坏文件告警）、校验按注册表动态、自定义 type 经注册表装配并参与分发
- cli 101 用例全绿，cli typecheck 通过；真实冒烟：`.harness/provider-plugins` 放 my-gw 插件 → `--check-config` 识别 `type=my-gw` 并校验通过

## 2026-08-27（续 19）：多 Provider 配置健壮性增强

### 背景

续 18 的多 Provider 支持存在静默失败路径（重复 id 静默覆盖、未知 type 静默丢弃、默认 provider 缺失误导提示），apiKey 只能明文落盘。用户确认增强：启动显式校验、apiKey 环境变量引用 + 加密存储、配置自检命令。

### 实现

1. **显式校验（boot 一次性报错）**（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）
   - `validateProviderConfigs`：重复 id / 未知 type / 默认 provider 未定义（非内置 mock/anthropic）→ 收集全部问题
   - `ConfigValidationError`：boot 时输出所有问题后抛错，不再静默跳过或误导提示
2. **密钥加密存储**：`SecretCipher`（AES-256-GCM）
   - 主密钥：`HARNESS_CONFIG_KEY` 环境变量（sha256 派生）→ `<data-dir>/.config-key` 文件（首次自动生成，chmod 600）
   - 格式 `enc:v1:<iv>:<tag>:<ct>`（base64），明文不落盘
   - `resolveSecret`：`${ENV_VAR}` 环境变量引用 / `enc:v1:` 解密 / 明文透传；未设置变量或解密失败报 ConfigValidationError
3. **config 子命令**：`harness config set-key <providerId> <apiKey>` 加密写入；`get-key <providerId>` 解密查看；`check` 校验 + 概览
4. **自检命令**：`--check-config`（等价 `config check`）打印 Provider/模型概览（apiKey 状态脱敏展示：已配置 / 已加密 / env(名称) / 未配置）+ 校验，REPL 新增 `/config`
5. **接入 GLM / Qwen 预设 Provider**（[packages/plugins/provider-glm](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/provider-glm/src/index.ts) / [provider-qwen](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/provider-qwen/src/index.ts)）
   - CLI `ProviderConfig.type` 支持 `glm` / `qwen`：预设 baseUrl/apiPath/默认模型（GLM=bigmodel，Qwen=dashscope），apiKey 环境变量 ZHIPU_API_KEY / DASHSCOPE_API_KEY
   - 插件 providerId 可覆盖、插件 id 随 providerId 派生（同 openai 多实例不冲突）
6. **parseCliArgs**：`config` 子命令（arg=子命令，rest=剩余非选项参数）+ `--check-config`

### 验证

- 新增测试：SecretCipher 往返/主密钥优先级、resolveSecret（env 展开/未设置报错/解密）、validateProviderConfigs（重复/未知/默认缺失）、buildConfigOverview 脱敏、boot 显式报错（一次性输出）、glm/qwen 注册分发、${ENV} boot 展开、main config set-key/get-key/check、--check-config 通过与报错
- cli 94 用例全绿，glm/qwen/cli 三包 typecheck 通过；真实 CLI 冒烟：check 概览、set-key 加密落盘、get-key 还原、错误配置一次性报错且退出码 1

## 2026-08-27（续 18）：多 Provider 自由切换（自定义模型配置）

### 背景

用户确认「自定义模型配置」期望的能力范围 = 多 Provider 自由切换：config.json 定义多个 provider（anthropic / openai / glm / qwen / gemini + 任意 OpenAI 兼容端点如 Ollama / DeepSeek），每个含 baseUrl / apiKey / model，`-m` / `/model` 可跨 Provider 任意切换。

### 实现

1. **core：ChatProvider 注册表**（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）
   - `chatProviders: Map<providerId, ChatProvider>`：`_setChatProvider` 按 `p.id` 入表
   - `resolveChatProvider(providerId)`：命中注册表 → 该 Provider；否则回退默认（context 记的 `chat.provider` / `chatProvider`）
   - AgentRuntime 调用点改为 `this.deps.chatProvider(llmIn.providerId)`，`provider.complete({ providerId, modelId, ... })` 动态分发
2. **CLI：providers 多配置 + 规格解析**
   - `HarnessConfig.providers: ProviderConfig[]`（config.json），`ProviderConfig = { id, type, baseUrl?, apiKey?, model?, apiPath?, maxTokens?, timeoutMs? }`
   - `parseModelSpec` / `formatModel`：`provider/modelId` 规格解析与格式化
   - `HarnessApp.boot()` 动态安装：非默认 Provider 先注册，默认 Provider 最后注册作兜底；`buildProviderPlugin()` 按 type 构造 openai / anthropic / gemini / mock 插件，openai 可对接任意兼容端点（DeepSeek / Ollama / GLM 等）
3. **修复 PluginDuplicateIdError**（[packages/plugins/provider-openai/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/provider-openai/src/index.ts)）
   - openai 插件 id 由写死的 `provider.openai` 改为随 `config.providerId` 派生（`provider.{providerId}`），使多个 OpenAI 兼容 Provider 不冲突
4. **`-m, --model <provider/model>`**：CLI 解析 `provider/model` 绑定 Agent 的 `providerId + modelId`，同时作为默认 Provider 的 `defaultModel` 兜底
5. **`/model` 支持跨 Provider**：`/model openai/gpt-4o` 校验 provider 是否注册 → 更新 Agent 并持久化（provider + model）到 config.json；`/model` / `/model ?` 展示已注册 Provider 列表
6. **listProviders()**：汇总 config.providers 显式 id + 默认 provider（供状态栏 / /model 展示）

### 验证

- 新增核心测试：多 Provider 按 `agent.model.providerId` 分发 / 回退默认 / 未知 id 回退默认
- 新增 CLI 测试：`parseModelSpec` / `formatModel`、`-m provider/model` 绑定、`setModel` 跨 Provider 切换 + 落盘、多 Provider 注册按 id 分发
- 修复 openai 插件重复注册冲突 + 测试绑定丢失 `this` 的问题；cli 78 用例全绿，core 29 用例全绿，core / cli / provider-openai 三包 typecheck 通过

## 2026-08-27（续 16）：文件引用跳转验证 + Markdown 长文本流式性能优化

### 背景

续 15 已实现 Claude Code 风格界面能力：Markdown 流式渲染、代码块高亮、多面板侧栏、文件引用提取、状态栏扩展。本次一起推进两块收尾工作：

1. **文件引用跳转，从「能提取」到「可操作」的验证**：此前只做了引用提取与侧栏渲染，未验证「Tab 进入列表 → 上下键选中 → Enter 打开」这一导航链路在组件层面真正可达、且 `openFile(path, line)` 被以正确解析参数调用
2. **Markdown 长文本流式性能**：assistant 正文流式时文本不断向同一块追加，旧实现 `collectFileReferences(state)` 每次 state 变化都对全部块文本做 O(总文本) 正则重扫，随回复增长代价递增

### 实现（[tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx) / [tui.test.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.test.tsx)）

1. **增量文件引用索引 FileRefIndex**：从「每块记录已扫描长度」出发，`indexFileReferences(index, blockId, text)` 只对新增尾部（回看 `REF_SCAN_OVERLAP=64` 窗口以捕获跨增量边界的路径）增量扫描并归一化去重，使单批成本从 O(总文本) 降到 O(增量)。`TuiApp` 侧栏改为对该索引做只增 append（useMemo + ref），而非每次全量重算
2. **导航集成测试补全**：`mountTui` 扩展支持注入 `responses` 与 `openFile` spy；新增用例验证——Tab 进入列表出现 `▸` 选中标记、Esc 退出列表、未 Enter 不触发打开；以及下移选中第二项后 Enter 以 `{path, line}` 正确调用 openFile
3. **FileRefIndex 纯函数单测**：空索引、文本未增长同引用短路、增量尾部识别、跨边界回看窗口捕获、同文件不同行号归并
4. **导航语义修正**：非列表模式下 Tab 进入、列表模式下非导航键均 `return true`（preventDefault 语义），避免列表模式按键误键入输入框

### 验证

- cli 66 用例全绿（含 2 个新导航集成 + 5 个 FileRefIndex 单测），全仓 26 包 typecheck 通过
- 导航链路：mock 回复 `改动 src/foo.ts:12 与 src/bar.ts:3` → Tab → down → Enter → `openFile('src/bar.ts', 3)` 被调用，:行号解析正确

## 2026-08-26（续 15）：TUI 渲染层迁移 OpenTUI（Bun 原生 Zig 渲染核心）

### 背景

自研 ANSI TUI（续 13）满足基础需求，但要做到 Claude Code / opencode 级别的功能齐全（代码高亮、Markdown 渲染、多面板布局、鼠标支持、选区复制等），自研成本过高。对比主流 TUI 方案后选定 **@opentui/core + @opentui/react**：

- **ink**：react-reconciler 方案，但终端重建需 ink 自己的渲染管线，对 Bun 支持一般，且零依赖风格冲突
- **OpenTUI**：Bun 原生（Zig 渲染核心 + Yoga flexbox 布局），`@opentui/react` 提供 React 组件树（box/text/input/scrollbox），自带 `<code>`/`<markdown>` 语法高亮等扩展能力；官方提供 `createTestRenderer` 测试方案，可直接 mock 按键断言帧内容

### 实现（[tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）

1. **t1 渲染层重写**：`KeyDecoder`/`TuiScreen` 自研 ANSI 全部移除，替换为 `TuiApp` React 组件（状态栏 + scrollbox 日志区自动滚动 + 底部 input 行）；`startTuiRepl` 改为 `createCliRenderer()` + `createRoot(renderer).render(<TuiApp/>)`；**会话内核 `createProcessLine` 原样保留**，TUI 与 REPL 依然共用同一套处理逻辑
2. **t2 三处真实 bug 修复**：
   - `processLineRef` 改为渲染期同步初始化（`createProcessLine` 是纯工厂），避免 Enter 提交早于 mount effect 执行时 ref 为 null
   - `<input onSubmit>` 不再读 React 状态闭包（快速输入时状态滞后于输入框内部文本），改用事件携带的 `currentValue`
   - **mount effect 覆盖竞态（pty 冒烟暴露）**：初始欢迎语/状态栏若用 `useEffect` 设置，而 processLine 已同步初始化，用户首个输入可在 effect 前被处理——回复内容先 append 进 logs，随后 effect 的 `setLogs([...欢迎语...])` 整体覆盖丢弃。修复：logs/status 直接用 `useState` 初始值，删除 mount effect
3. **t3 工程适配**：cli 新增依赖 `@opentui/core` / `@opentui/react` / `react`；tsconfig 配置 `jsx: react-jsx` + `jsxImportSource: @opentui/react`；文件名 `tui.ts` → `tui.tsx`、`tui.test.ts` → `tui.test.tsx`
4. **t4 测试重写**：旧 21 用例（KeyDecoder/TuiScreen/scriptedKeys）替换为 `@opentui/core/testing` 的 `createTestRenderer` + `mockInput` 驱动 `TuiApp`（10 用例：appendLog 4 / 集成 4 / --tui 2）；测试渲染器需手动 pump `renderer.loop()` 产出帧（waitForFrame 不驱动循环）

### 验证

- cli 38 用例全绿（含 TuiApp 输入提交流式渲染 / Ctrl-C / /exit 集成），全仓 25 包 typecheck 通过
- python pty 真实终端冒烟：`🧑 hi` 回显 → `🤖 (Mock Provider) 你好，我是测试助手。` 流式渲染 → `⏱️` 计时行 → 状态栏 session/agent 显示；注意 OpenTUI 增量渲染对变化单元格逐格写 ANSI 色码，字节流子串匹配需按单字符断言
- 保留能力：`harness repl --tui` 全屏交互、与 REPL 共用 /命令与插件 hook、自动续轮注入

## 2026-08-26（续 14）：TUI 输入修复——真实终端无法输入字符

### 现象

`harness repl --tui` 启动后界面正常渲染，但键盘输入无反应（字符不显示、回车不提交）。

### 根因（[tui.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.ts)）

两个叠加 bug：

1. **drainQueue busy 标志竞态（致命）**：`draining = (async () => {...})()` 中，async IIFE 同步完成时 `finally { draining = null }` 先执行，随后赋值把已 resolve 的 promise 写回 `draining`。真实终端下字符块与回车块是两次独立 data 事件——字符块的 drainQueue 同步完成后 `draining` 仍非空，回车块调用 drainQueue 被 `if (draining) return` 拦截，**提交的行永不处理**。修复：改用 promise 链（`queueTail = queueTail.then(...)`）串行处理，天然不丢行。
2. **按键不触发重绘**：handleKeys 仅在 Enter 提交时 scheduleRender，char/退格/方向键修改 screen.input 后屏幕不刷新，用户看不到输入的字符。修复：每次按键后统一 scheduleRender。

### 排查过程

- expect（pty）复现不稳定（bun 冷启动慢 + `~/.harness` 写入 EPERM 干扰）→ 用 python `pty.fork()` 复现真实终端输入
- 逐级 stderr 调试定位：`TUI-DATA`（data 事件收到 hi ✓）→ `TUI-KEY`（char 插入 screen.input ✓）→ `TUI-DRAINQ-CALL`（enter 时 `draining=true` 拦截 ✗）

### 验证

- python pty 全流程：`🧑 hi` 回显 → `🤖 (Mock Provider) 你好，我是测试助手。` 流式渲染 → 退出序列收尾
- 新增回归测试「输入与回车分块到达（真实模式时序）也能提交处理」（修复前必失败）
- cli 50 用例全绿（+1），全仓 26 包 typecheck 通过

## 2026-08-26（续 13）：TUI 形态落地——自研 ANSI 渲染（预留迁移）

### 方案决策

- **自研 ANSI TUI**（放弃现成库：ink 依赖 react-reconciler 与零依赖风格冲突、blessed 已停维护带 CVE、clack 满足不了多面板需求）
- **渲染层严格隔离**：TUI 与 REPL 共用同一套会话处理内核（`createProcessLine`），渲染/输入层独立成模块，未来若需求膨胀（鼠标、富布局）可低成本迁移 ink

### 实现（[packages/cli/src](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src)）

1. **t1 重构**：`startReplCore` 的 `processLine` 提取为可复用工厂 `createProcessLine({ app, harness, session, out, onLine?, setSession? })`（[index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）——流式事件渲染、`/` 命令、插件 cli.command hook、`AUTO_CONTINUE_LINE` 全部共用；REPL 与 TUI 同一内核
2. **t2 新建 `tui.ts`**：
   - `KeyDecoder`：raw-mode 键盘字节流 → KeyEvent（箭头/Enter/Backspace/Ctrl-C/Tab/Home/End/Delete；跨块转义序列缓冲）
   - `TuiScreen`：alt-screen 全屏渲染（状态栏 + 日志区自动滚动 + 底部输入行 + 光标定位 CSI）；`append` 流式拼接当前行
   - `startTuiRepl`：非阻塞输入循环，Enter 提交 → createProcessLine 处理 → 输出回流日志区；`drainQueue` 共享 promise 防并发；退出前 flushRender 保证退出序列收尾
3. **t3 CLI 入口**：`harness --tui` 进入 TUI 模式（parseCliArgs 新增 tui 标志 + main 分支 + HELP_TEXT）
4. **t4 测试**：`tui.test.ts` 21 用例（KeyDecoder 10 / TuiScreen 5 / startTuiRepl 4 / --tui 2），cli 28 用例保持全绿

### 修复

- KeyDecoder `\x1b[n~`（Delete）解码：`fin==='~'` 分支不可达，统一到未知 CSI 路径解析
- startTuiRepl 脚本模式并发 drain：`void drainQueue()` 与 `await drainQueue()` 竞争导致提前返回丢流式输出 → 共享进行中 promise
- TuiScreen.append 把流式 token 当独立行 → 改为追加当前行（换行才分行）

### 状态

- cli 49 用例全绿（+21），全仓 26 包 typecheck 通过
- 边界：本次不做鼠标交互、富文本布局（预留迁移口的边界条件）

## 2026-08-26（续 12）：Swarm 待办收尾——tmux/iTerm2 进程后端 + send_message 路由统一

对照架构 §9.4「Swarm 后续待办」，实现最后 2 项（8、10），Swarm 待办 10 项全部完成：

### 1. tmux/iTerm2 进程后端（out-of-process teammate）

- swarm 新增 `spawnTerminalTeammate`（[packages/plugins/swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：
  - tmux：`new-session -d`（已存在则 `new-window`）→ `send-keys` 注入 CLI 启动命令 → paneId 写入 `TeamMember.tmuxPaneId`
  - iTerm2：osascript 创建窗口 + `write text` 启动命令，返回 window id
  - 命令执行器可注入（`run`），默认 `spawn` 收集 stdout，纯逻辑可测试
- CLI 新增 `teammate` 子命令（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：`harness teammate --team <t> --name <n> --agent <a>`——复用 HarnessApp.boot + `startTeammateLoop` 持续轮询 mailbox/认领任务，直到 shutdown 退出
- `spawnTeammate` 统一分流：backend = in-process | tmux | iterm2

### 2. send_message 路由统一

- coordinator `send_message` 双路由（[packages/plugins/coordinator/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/coordinator/src/index.ts)）：
  - **mailbox 路由**（team + to）：单播到成员 inbox；`to='*'` 广播到团队全部成员
  - **本地续跑路由**（taskId）：原 worker 子会话续跑语义不变
- mailbox 经插件选项依赖注入（`SendMailbox` 鸭子接口，不硬依赖 swarm），未注入时 mailbox 路由返回 `MAILBOX_NOT_CONFIGURED`；无目标返回 `INVALID_TARGET`

### 验证与提交

- 测试：swarm 63 用例全绿（+3：tmux 命令序列/iTerm2 osascript/spawn 分流）、coordinator 29（+4：单播/广播/未配置/无目标）、cli 28（+1：teammate 参数解析）
- 全仓 26 包 typecheck 通过
- 文档：架构 §9.4 Swarm 待办 10 项全部 ✅

## 2026-08-26（续 11）：Swarm 待办 7、9 项落地（plan approval + team file 字段补全）

对照架构 §9.4「Swarm 后续待办」，实现第 7、9 项（[packages/plugins/swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：

### 1. plan approval 自动批准 + permissionMode 继承

- helper：`createPlanApprovalRequest`（plan 内容 + 期望 permissionMode）、`createPlanApprovalResponse`（approved + leader permissionMode）
- teammate 侧：`requestPlanApproval`（写 plan_approval_request 到 leader inbox + 挂起回调）、`processMailboxPlanApprovalResponse`（命中 requestId 配对 resolve，返回 approved + 继承的 permissionMode）
- leader 侧：`processMailboxPlanApprovalRequests` 自动批准 plan_approval_request 并回写响应，携带 leader 当前 permissionMode（宿主传入）供 teammate 继承
- `runTeammateTick` 每轮先处理 plan_approval_response 配对（与权限响应并列）

### 2. team file 字段补全 + setLeaderTeamName

- `TeamMember` 增 joinedAt / tmuxPaneId / cwd / subscriptions；lead 与新增成员自动记录 joinedAt（同名覆盖保留原值）
- `TeamFile` 增 leaderTeamName + `TeamManager.setLeaderTeamName`（多后端共享任务池定位；out-of-process teammate 通过它找到归属团队目录）

### 验证与提交

- 测试：swarm 60 用例全绿（+5：字段补全 1 + setLeaderTeamName 1 + plan approval 3）
- 全仓 26 包 typecheck 通过
- 文档：架构 §9.4 第 7、9 项标记 ✅（tmux/iTerm2 后端、send_message 路由统一 留待办）

## 2026-08-26（续 10）：Swarm 待办 4-6 项落地（poller 优先级 + task 依赖锁 + idle_notification）

对照架构 §9.4「Swarm 后续待办」，实现第 4-6 项（[packages/plugins/swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：

### 1. inbox poller 优先级 + 投递后才 markRead

- `sortMessagesByPriority`：shutdown（request/approved/rejected）最高（防 peer 消息饿死）→ lead 消息 > peer 消息，同级稳定排序保持 FIFO
- `attachInboxPoller` 与 `runTeammateTick` 共用排序；**投递成功后才 markRead**——onMessage/query 失败的消息保持未读，下轮重试（防丢消息）
- `runTeammateTick` 新增中断守卫：消息循环中状态被置 shutdown（如 approve_shutdown 触发关停）时不再认领任务

### 2. task 依赖（blockedBy）与认领锁

- `SwarmTask.blockedBy?: string[]`（task_create 工具可选输入）：依赖任务全部 completed 才可认领，指向不存在的任务视为未解决
- `claim` 在 `withLock` 内 busy-check（状态 + 依赖双重校验，文件锁防 TOCTOU）
- `tryClaimNextTask` 跳过依赖未解决/已被并发认领的任务，认领下一个可认领任务

### 3. idle_notification（每轮结束上报）

- `createIdleNotification` helper（idleReason: available/interrupted/failed + summary）
- `runTeammateTick` 每轮结束向 leader 发 idle_notification：无任务 → available；结果异常 → failed；消息循环中途被关停 → interrupted（且不再认领任务）

### 验证与提交

- 测试：swarm 55 用例全绿（+10：优先级排序 2 + poller 重试 1 + blockedBy 3 + 空闲通知 3 + createIdleNotification 1）
- 全仓 26 包 typecheck 通过
- 文档：架构 §9.4 第 4-6 项标记 ✅（plan approval / tmux 后端 / team file 字段 / send_message 路由统一 留待办）

## 2026-08-26（续 9）：Swarm 待办前三项落地（mailbox 协议 + 权限双轨 + shutdown 模型决策）

对照架构 §9.4「Swarm 后续待办」，实现前 3 项（[packages/plugins/swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：

### 1. mailbox 协作协议类型扩展

- `MailboxMessageType` 扩至 15 种：message + permission_request/response + sandbox_* + plan_approval_* + shutdown_request/approved/rejected + idle_notification + task_assignment + team_permission_update + mode_set_request + task_notification
- `isStructuredProtocolMessage` 路由：结构化协议消息与普通 message 区分（poller/tick 按此路由，避免被当普通 LLM 上下文吞掉）
- 协议 helper 构造函数：`generateRequestId`（前缀+自增序列）、`createPermissionRequest/Response`（requestId/replyTo + data.allow/forever）、`createShutdownRequest/Decision`（shutdown_request → approved/rejected）
- `SendTeammateMessageInput.type` 同步扩展（shutdown_request/shutdown_approved/shutdown_rejected/idle_notification）

### 2. 权限 mailbox 双轨 fallback

- `requestSwarmPermission`：有 leader 桥走 confirm queue（workerBadge）；无桥且提供 mailbox/team/leaderName 时降级 mailbox——`sendPermissionRequestViaMailbox` 写 permission_request 到 leader inbox + `registerPermissionCallback` 挂起回调；leader 写回 permission_response 后由 `processMailboxPermissionResponse` 命中 requestId 配对 resolve（data.allow/forever）；双轨皆无 fail-closed 拒绝
- `runTeammateTick` 每轮最先处理挂起的权限响应，再读普通消息
- 新增 `unregisterLeaderConfirmQueue`（对称清理，测试复位全局状态）

### 3. shutdown 模型决策

- `runTeammateTick` 对 `shutdown_request` 不直接关停：注入 query（含 requestId）由模型调用 `approve_shutdown`/`reject_shutdown` 工具决策（对齐 Claude Code approveShutdown）
- `createShutdownDecisionTool('approved'|'rejected')`：回发 shutdown_approved/shutdown_rejected（replyTo=requestId）；approve 时通过 onDecision 回调触发关停
- 插件注入：approve 工具按 memberName 查 teammateRegistry，命中则 abort + 状态置 shutdown；reject 仅回发响应

### 验证与提交

- 测试：swarm 45 用例全绿（+11：协议 helper 5 + 权限 fallback 3 + shutdown 工具 3），插件注入清单更新为 11 个工具
- 全仓 26 包 typecheck 通过
- 文档：架构 §9.4 前三项标记 ✅（inbox poller 优先级 / task 依赖锁 / idle_notification / plan approval / tmux 后端 / team file 字段 / send_message 路由统一 留待办）

## 2026-08-24（续 8）：写锁设计修正（声明级 → 文件级）+ Swarm 待办记录

### 1. FileWriteArbiter：文件级写锁（替代派工声明级仲裁）

**问题（用户反馈）**：初版 `CoordinatorFileArbiter` 只在 subagent 工具调用时触发，且按 `targetFiles`/`writesTo` 在**派工时**整组阻塞——agent 实际写哪些文件执行前并不确定，声明级锁会误伤不相关 worker，且锁持有到 worker 生命周期过长。

**修正**（[packages/plugins/coordinator/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/coordinator/src/index.ts)）：
- 重命名为 `FileWriteArbiter`：按 canonical 路径跨 session 互斥（per-path FIFO 等待队列），同 session 内天然串行直接放行
- 锁持有 = **单次写工具调用**：`tool.pre.execute` 对 `write_file`/`edit_file`（从输入 `path` 提取目标）执行前 `acquireWrite`、finally `releaseWrite`；subagent 派工不再做任何声明级阻塞（仅保留 forceAsync）
- `SubagentToolInput.targetFiles` / `AgentDefinition.writesTo` 保留为提示性声明，不参与仲裁；bash 无法可靠解析写入路径，不纳入（与 Claude Code 一致靠 prompt 纪律兜底）
- 测试：coordinator 25 用例全绿（FileWriteArbiter 6 + 插件集成 5：跨 session 阻塞/并行/顺序释放/非写工具不拦截/开关）

### 2. Swarm 待实现功能记录（对照 Claude Code 源码调研）

已记录到架构文档 §9.4「Swarm 后续待办」10 项：mailbox 协议类型扩展（permission/sandbox/plan_approval/idle_notification 等 + isStructuredProtocolMessage 路由）、权限 mailbox 双轨 fallback、shutdown 模型决策（approveShutdown 工具）、inbox poller 优先级 + 投递后 markRead、task blockedBy 依赖 + claim 文件锁防 TOCTOU、idle_notification、plan approval 自动批准 + permissionMode 继承、tmux/iTerm2 后端、team file 字段补全 + setLeaderTeamName、send_message 路由统一（resume + mailbox + broadcast）

## 2026-08-24（续 7）：targetFiles 写入源 + in-process teammate 完整执行循环

### 1. targetFiles 写入源修复（Coordinator 串行化真实生效）

- **问题**：`SubagentToolInput.targetFiles` 是可选字段，但 `makeSchema` 不透传 LLM 可见 schema、工具描述未提及、coordinator 只读不填——**无任何写入来源**，仲裁器实际不会触发
- **修复**：`AgentDefinition` 新增 `writesTo?: string[]`（[packages/agent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/agent/src/index.ts)，frontmatter `writesTo:` 解析）；coordinator `tool.pre.execute` 在调用未显式传 `targetFiles` 时，自动从被派 Agent 定义 `writesTo` 填充（显式传参优先）
- 测试：agent 23 用例（+2 writesTo 解析）、coordinator 30 用例（+1 定义回退仲裁）

### 2. in-process teammate 完整执行循环（@harness/swarm）

对齐 Claude Code `spawnInProcessTeammate` + `inProcessRunner` teammateLoop + `tryClaimNextTask`：

- **`spawnInProcessTeammate`**：加入/创建团队（新建时 lead=自身）→ 创建独立子 session → 注册（默认全局 `teammateRegistry` 单例，可注入隔离实例）→ 带初始 prompt 立即执行一轮（AsyncLocalStorage 身份上下文）
- **`runTeammateTick`**（单轮执行体）：① mailbox 未读消息——普通消息作为 query 输入、回复写回发送者、标记已读；shutdown 类型消息触发 abort + 状态置 shutdown；② `tryClaimNextTask`——认领 available 任务 → query 执行 → 更新任务 completed/failed + 向 leader 发 task_notification（replyTo=taskId）
- **`startTeammateLoop`**：周期驱动 tick（intervalMs 可配），stop()/shutdown 消息停止
- 修复：spawn 时团队新建后 teammate 未入队（补 addMember）
- 测试：swarm 34 用例全绿（+6：tick 消息处理/任务完成/任务失败/shutdown + spawn 注册/loop 自动执行）

### 验证与提交

- 全仓 26 包 typecheck 通过；agent 23 + coordinator 30 + swarm 34 测试全绿
- 文档：架构 §9.4 Coordinator 补 writesTo 自动填充说明、Swarm in-process 完整循环 ✅（tmux/iTerm2 后端留待办）

## 2026-08-24（续 6）：Coordinator 写操作串行化 + Swarm Plugin（@harness/swarm）

### 1. Coordinator 写操作按文件集串行化（§9.4 收官）

- `SubagentToolInput` 新增 `targetFiles?: string[]`（worker 派工时声明要写的文件/目录，调度元数据，subagent 工具本身不消费）
- `CoordinatorFileArbiter`（[packages/plugins/coordinator/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/coordinator/src/index.ts)）：`pathsOverlap` 前缀匹配冲突检测（相同/目录子路径/祖先后代）+ FIFO 等待队列
- `tool.pre.execute` 拦截 subagent 调用：冲突派工 `await acquire(toolUseId, targetFiles)` 阻塞；后台任务由 subagent.completed/failed 事件（按 toolUseId）释放声明，同步任务在 next() 返回时 finally 释放
- `createCoordinatorPlugin({ serializeWrites: true })` 默认开启，仅对声明了 targetFiles 的调用生效；forceAsync 与仲裁合并到同一 preHook
- 测试：coordinator 29 用例全绿（新增 pathsOverlap 6 + arbiter 5 + 串行化集成 5）

### 2. Swarm Plugin 新包 `@harness/swarm`（§9.4 Swarm 项核心落地）

参考 Claude Code swarm（teammateMailbox / TeamCreateTool / TaskCreateTool / TaskStopTool / leaderPermissionBridge / spawnInProcess），存储根 `~/.harness/teams/`：

- **TeamManager**：team file 持久化（`{name}/team.json`，name/description/lead/members，同名成员覆盖），create/get/list/addMember/delete，create 时初始化 inboxes/
- **TeammateMailbox**：`{name}/inboxes/{agent}.json` 文件收件箱，`withLock`（原子 'wx' 锁文件 + EEXIST 重试 + 超时）串行化并发写；readUnread/markMessageAsReadByRef/countUnread
- **TaskListPlane**：`{name}/tasks.json` 共享任务池，状态机 available → in_progress → completed/failed/cancelled（生命周期校验 + claim 冲突检测 + stop 统一 kill switch）
- **LeaderPermissionBridge**：module-level `registerLeaderConfirmQueue`（CLI/REPL 注册 leader 确认入口）+ `requestPermissionThroughLeader`（teammate ask 权限带 workerBadge 回流 leader；无桥 fail-closed 拒绝）
- **InboxPoller**：`attachInboxPoller` 周期轮询未读消息回调宿主（纯逻辑 + 手动 pollOnce，可独立测试）
- **in-process teammate 基础**：`TeammateRegistry` + `withTeammateIdentity`（AsyncLocalStorage 身份隔离）+ `formatAgentId`（{name}@{team}）；完整执行循环 + tmux/iTerm2 后端列后续
- **工具**（tool.pool.assemble 注入全部 Agent）：team_create/team_delete/team_status、send_teammate_message（mailbox 路由，避免与 coordinator send_message 冲突）、task_create/list/claim/update/stop
- 测试：swarm 28 用例全绿（sanitizeName 2 + TeamManager 5 + Mailbox 4 + TaskList 5 + PermissionBridge 2 + Poller 2 + teammate 2 + 工具 5 + 插件 1）
- 踩坑：`withLock` 首版 catch 吞掉 ENOENT（父目录不存在）→ 无限重试锁超时；修复为 withLock 内先 mkdir 父目录 + 仅 EEXIST 重试

### 验证与提交

- 全仓 26 包 typecheck 通过；coordinator 29 + swarm 28 + subagent 92 测试全绿
- 文档：架构 §9.4 Coordinator 全部 ✅、Swarm 核心 ✅（完整执行循环/tmux 后端留待办）；development-log 续 6

## 2026-08-24（续 5）：§10.4 双后端 + 存储治理（快照 fallback / gc / 上限）

### 重构 `@harness/snapshot` 为双后端（[packages/snapshot/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/snapshot/src/index.ts)）

实现 §10.4 全部 4 项边界外增强：

- **`SnapshotService` 从 class 改为 interface**，`GitSnapshotService`（默认，OpenCode git tree 方案）+ 新增 `FileSnapshotService`（Claude Code fileHistory 文件副本方案）双实现
- **工厂 auto 探测**：`createSnapshotService({ backend: 'auto'|'git'|'file' })`；auto 用 `resolveGitBin()`（依次查 PATH / `/usr/bin/git` / `/opt/homebrew/bin/git`，带缓存）探测 git，不可用自动降级 file 后端；`runGit` 同步改用解析出的 git 二进制（修复终端 PATH 异常下 git 不可用）
- **FileSnapshotService**（不依赖 git）：
  - 存储：`~/.harness/file-snapshots/{worktree-hash}/`（`backups/{sha256_16}@v{n}` + `snapshots.json` 快照链，ID `fs-{seq}`）
  - **三级变更检测**（对齐 `checkOriginFileChanged`）：`FileBackupMeta` 记录 `backup/version/mode/size/mtime`；stat（mode/size/mtime）一致直接复用；变化再内容级兜底，一致仍复用（增量快照）；不同才 `copyFile` 新备份
  - `restore`/`checkout` 幂等：目标备份 null → `rm`（对齐 applySnapshot unlink 分支），否则 `copyFile` + `chmod` 恢复权限
  - diff 用简化行 diff（前缀/后缀公共行 + 中间区贪心对齐，识别"插入在中间"的公共行），unified patch + 增删统计
  - `gc()`：清理快照链不再引用的 `@v{n}` 备份
- **check-ignore**：git 后端 `--exclude-standard` 隐式复用用户 .gitignore；file 后端惰性读根 `.gitignore`（简化 matcher：`*`/`**`/`?`/目录 `/` 结尾/`!` 取反/`#` 注释）+ 跳过 `.git` 与 worktree 内 dataDir
- **git gc + 上限**：`GitSnapshotService` 新增 `snapshot-ids.json` 注册表（`maxSnapshots` 默认 100 淘汰最旧）+ `gc()`/`gcUnlocked()`（`git gc --prune=7.days`），capture 每 `gcEvery` 次（默认 50）自动 gc

### 踩坑修复

| 问题 | 原因 | 修复 |
|---|---|---|
| 自动 gc 时 capture 返回 undefined（快照丢失） | `recordSnapshotId` 内调 `this.gc()`，与外层 capture 的 `mutex.run('tree')` 同 key 嵌套死锁 | 抽 `gcUnlocked()` 无锁内部方法，公共 `gc()` 加锁、锁内路径直调无锁版 |
| file 后端每次 capture 都新建备份（增量快照失效） | `FileBackupMeta` 未存 size/mtime，`info.size === prev.size` 恒 false | 补 `size`/`mtime` 字段，三级检测 stat 级对齐 |
| file 后端 diff 统计偏差（公共行 'three' 被算作 -/+） | 简单前后缀匹配在"插入在中间"时失准 | 中间区贪心对齐：对 a 剩余行在 b 剩余区间顺序查首个匹配 |
| tsc 报 `number \| bigint` / `Dirent` 泛型错误 | `Awaited<ReturnType<typeof stat>>` 解析为联合类型 | 显式 `import type { Stats, Dirent }` |

### 测试与验证

- snapshot 包 **25 用例全绿**（原 11 + git 后端 gc/上限 3 + file 后端 8 + 工厂 3）；`typecheck` 通过
- 全仓 25 包 typecheck 通过；core/revert/cli 既有用例无回归
- 注：`@harness/tools-builtin`（bash 工具）与 `@harness/permission`/`@harness/session`（无测试文件）失败为既有环境问题（终端 PATH 缺 `/bin` 导致 `spawn('bash')` ENOENT），与本次改动无关

### 文档

- [docs/agent-harness-architecture.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/agent-harness-architecture.md) §10.4 由「后续增强（边界外）」更新为「双后端 + 存储治理（✅ 已实现）」，4 项 ☐ 全部改为 ✅

## 2026-08-24（续 4）：CLI /revert 命令（文件快照回滚交互）

### 接入 `@harness/cli`（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

实现 §10.3 第 5 条：CLI `/revert` 命令闭环（capture 挂消息 → stage 回滚 → clear/commit）：

- `HarnessAppOptions` 新增 `snapshot?: boolean`（默认 false）：开启时创建 `SnapshotService`（基于 resolve 后的 cwd）注入 `createHarness.snapshot`（自动挂载 meta.snapshot），并启用 `/revert` 命令
- `/revert` 子命令：`stage <messageID>`（回滚 + 逐文件 diff 展示，patch 截断 400 字符）/ `clear`（撤销）/ `commit`（接受）/ `status` / `help`；未启用快照时提示；异常经 try/catch 打印"回滚失败"不崩溃
- `/help` 列表新增 `/revert`；`REPL_COMMANDS` 注册
- cli 新增依赖 `@harness/snapshot`、`@harness/revert`
- 测试：cli 新增 6 用例（未启用提示 / help / status / stage 错误路径 / 未知子命令 / help 列表），27 用例全绿；全仓 typecheck 通过

## 2026-08-24（续 3）：core 自动 capture 挂载（AgentRuntimeImpl.query / queryStream）

### 接入 `@harness/core`（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）

实现 §10.3 第 1 条：AgentRuntime 每轮自动快照并挂载到消息：

- `AgentHarnessOptions` 新增可选 `snapshot?: () => SnapshotService`（@harness/snapshot 工厂），`createHarness` 透传给 `AgentRuntimeImpl`
- `AgentRuntimeImpl` 新增 `captureForMessage(sessionId)`：每轮 LLM 调用后、工具执行前 `capture()`，`files` = 相对上一轮快照的变更文件（按 sessionId 维护 `lastSnapshots`，首轮为空）；capture 失败 best-effort（返回 undefined 不中断推理）
- `query()` / `queryStream()` 生成的 assistant 消息挂 `meta.snapshot = { start, files }`（对齐 OpenCode `message.snapshot`），供 `@harness/revert` 的 `collectSnapshotMap` 收集回滚目标
- 未注入 snapshot 工厂则不启用（向后兼容，现有调用不受影响）
- core 新增依赖 `@harness/snapshot`（workspace:*）
- 测试：core 新增 5 用例（query/queryStream 挂载、第二轮 files 计算、未注入不挂载、capture 失败 best-effort），27 用例全绿；全仓 typecheck 通过

## 2026-08-24（续 2）：Revert 三态 + Bus 事件（`@harness/revert`）

### 新包 `@harness/revert`（[packages/revert](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/revert/src/index.ts)）

实现 §10.3 会话级文件回滚三态（对齐 OpenCode `SessionRevert.stage/clear/commit`）：

- **`SessionRevert.stage({ sessionId, messageID, snapshotMap? })`**：定位边界消息 → `collectSnapshotMap` 收集其后 assistant 消息的快照引用（或显式 `snapshotMap`）→ `SnapshotService.restore` 选择性回滚 → `diff(original → 回滚后)` 生成回滚 diff → 保存 `session.meta.revert`（RevertState）→ 发布 `snapshot.revert.staged`；重复 stage 沿用首次 original
- **`clear(sessionId)`**：按 RevertState 恢复回滚前原始快照（撤销回滚）→ 发布 `snapshot.revert.cleared`；**`commit(sessionId)`**：接受回滚 → 清除状态 → 发布 `snapshot.revert.committed`
- **消息快照引用约定**（对齐 OpenCode `message.snapshot`）：`message.meta.snapshot = { start, files }`，提供 `attachSnapshotToMessage()` / `collectSnapshotMap()` 辅助
- **Bus 事件**：`RevertEvents.staged/cleared/committed`（域 `snapshot.revert.*`）
- 自定义错误 `RevertError(operation, message, cause)`
- 测试：10 用例全绿（stage 回滚 + 事件 / snapshotMap 覆盖 / 错误路径 / clear 撤销 / commit 接受 / 重复 stage 沿用 original / 挂载与收集辅助）；typecheck 通过
- 后续待办：AgentRuntime query 开始时自动 capture + attachSnapshotToMessage（core 集成）

## 2026-08-24（续）：Snapshot 调研 + `@harness/snapshot` 包骨架

### 调研：OpenCode / Claude Code 快照与回滚方案

- `reference/` 更新：新增 `opencode-dev/`（OpenCode **完整真实源码 v2**），`claude-code-analysis-main` 补充《快照与回滚.md / 快照与回滚2.md》深度分析文档
- **OpenCode v2**（`packages/core/snapshot.ts` + `git.ts`）：独立 git 仓库 + `git write-tree` 内容寻址；`capture`（diff-files + ls-files → add --sparse → write-tree）、`preview`（临时 GIT_INDEX_FILE 零副作用）、`restore`（ls-tree 判定 → checkout / rm）、`checkout`（read-tree + checkout-index）；消息内嵌 `snapshot.start`，`SessionRevert.stage/clear/commit` 三态
- **Claude Code**（fileHistory.ts）：文件副本方案，`{sha256_16}@v{n}` 备份 + 快照链（上限 100）；编辑前 trackEdit + 回合结束 makeSnapshot；三级变更检测（stat/mtime/内容）；`fileHistoryRewind` → applySnapshot（unlink/restoreBackup/skip 幂等）
- **结论**：本项目采用 OpenCode git tree 方案（去重、复用 git 语义、可预览），Claude Code 文件副本保留为非 git fallback

### 新包 `@harness/snapshot`（[packages/snapshot](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/snapshot/src/index.ts)）

- `SnapshotService`：`capture / files / diff / preview / restore / checkout`，快照仓库 `~/.harness/snapshots/{worktree-hash}`（独立于用户 .git）
- `GitRepo`（--git-dir/--work-tree 显式指定）+ `KeyedMutex`（按仓库串行化写操作）+ `SnapshotError`
- 安全边界：restore 路径逃逸校验；>2MB untracked 跳过；capture best-effort
- 踩坑修复：① diff/preview 内嵌套调用同 key 互斥锁 → 死锁超时，抽取 `filesUnlocked`/`diffUnlocked`；② preview 未刷新 index → 基准树过期，先 `refresh('.')` 再 write-tree
- 测试：11 用例全部通过（hash 稳定性 / files / diff / restore / checkout / preview 零副作用 / 大文件跳过 / disabled），typecheck 通过

### 文档

- [docs/agent-harness-architecture.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/agent-harness-architecture.md) 新增 §10「文件历史与回滚」（选型对比 / 包设计 / 集成路线 / 后续增强）

## 2026-08-24：Subagent 后台展示层完善 + Coordinator 插件

### 今日完成

#### 1. P0-1/P0-2：Prompt 决策指导 + Agent 级后台声明

- `SubagentTool` 描述增强：前台/后台决策规则 + "Don't sleep/poll/peek" 反模式；清理 `task_status` 工具残留文案
- `AgentDefinition` 新增 `background?: boolean`（[packages/agent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/agent/src/index.ts)），`agentFromMarkdown` 支持 frontmatter 解析；后台判定并入 `agentDef.background`

#### 2. P1-4：前端事件驱动展示

- `@harness/subagent` 新增 UI 无关 `BackgroundTaskMonitor`（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）：订阅 subagent.started/completed/failed 维护任务快照
- `@harness/cli` 新增 `attachBackgroundTaskPanel`（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：任务状态实时打印，`startRepl` 自动挂载

#### 3. P1-5：进度推送

- 新增 `subagent.progress` Bus 事件（toolName/toolStatus/summary/timestamp）
- 后台执行改用 `agent.queryStream` 遍历工具调用事件发布进度；Monitor 任务视图新增 `progress[]`；CLI 面板增量打印

#### 4. Coordinator 插件（新包 `@harness/coordinator`）

**新包**：[packages/plugins/coordinator](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/coordinator/src/index.ts)，`dependsOn: ['subagent']`，把主 Agent 变成 orchestrator：

- **Coordinator 身份**：`AgentDefinition.mode === 'coordinator'` 时通过 `prompt.system.transform` 注入 `COORDINATOR_SYSTEM_PROMPT`（四阶段 Research→Synthesis→Implementation→Verification + 派工规则 + 反模式）
- **Barrier 自动集齐**：`CoordinatorBarrierTracker` 跟踪 per-session 后台任务，全部完成/失败后发布 `coordinator.barrier.completed` 事件；CLI `attachAutoContinue` 订阅后注入 `<continue/>` 自动触发下一轮 query（解决"多调研→等齐→自动汇总"）
- **forceAsync**：插件选项或 `HARNESS_FORCE_ASYNC=true`，`tool.pre.execute` 拦截 subagent 调用强制后台化（原 P2-6）
- **send_message 工具**：续跑已有 taskId（延续 worker 会话上下文），仅注入 mode=coordinator 的 Agent；running 中拒绝、TASK_NOT_FOUND 兜底

#### 5. 测试

- coordinator 14 用例：BarrierTracker 单测 / send_message / prompt 注入 / forceAsync / 事件发布
- cli 新增自动续轮 attachAutoContinue 2 用例；全仓 typecheck 通过

## 2026-08-23（续 6）：Subagent run_in_background + 并行执行

### 今日完成

为 Subagent 插件添加后台异步执行和并行子 Agent 调度能力，让主 Agent 能派出多个子 Agent 同时执行任务，提升复杂任务的并行吞吐。参考 Claude Code 的 `forkSubagent.ts` + `LocalAgentTask` 和 OpenCode 的异步任务模型。

#### 1. BackgroundTaskRegistry — 后台任务生命周期管理

**新增类 `BackgroundTaskRegistry`**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

- 状态机：`pending → running → completed | failed`（每状态对应时间戳 `createdAt` / `startedAt` / `completedAt`）
- `register(input)`：分配 `task-{时间戳36进制}-{计数36进制}` 形式 taskId，状态初始为 `pending`
- `start(taskId)`：切换为 `running`，记录 `startedAt`
- `complete(taskId, result)`：切换为 `completed`，若未显式传 `durationMs` 则用 `completedAt - startedAt` 自动计算
- `fail(taskId, error)`：切换为 `failed`，记录 `errorCode` / `errorMessage`
- `wait(taskId, timeoutMs)`：阻塞等待任务结束，内部用 `resolvers` 队列 + `AbortController` 实现超时，已完成任务立即返回
- `list(filter?)`：支持按 `status` 和 `parentSessionId` 过滤
- `cancel(taskId)`：触发 `AbortController.abort()`，返回是否取消成功
- `clear(filter?)`：清理已完成/失败任务

#### 2. SubagentTool — runInBackground 模式

**`SubagentTool` 扩展 `runInBackground` 参数**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

- 输入 schema 新增 `runInBackground?: boolean`（默认 false，保持同步调用语义）
- `runInBackground=true` 时：
  1. `registry.register()` 注册任务 → 返回 taskId
  2. `registry.start(taskId)` 切换 running
  3. `void (async () => { ... })()` 异步执行子 Agent query，主 Agent 不阻塞
  4. 完成后 `registry.complete/fail(taskId, ...)` 更新状态
  5. 立即返回 `{ ok: true, output: { sessionId, taskId, background: true, message: '后台任务已启动...' } }`
- 异步块内复用同步路径的完整逻辑：超时控制（AbortController + 120s 默认）、工具调用摘要、临时文件输出、Bus 事件发布
- Bus 事件（`subagent.started/completed/failed`）新增 `taskId` 和 `background` 字段，支持后台任务跟踪

#### 3. TaskStatusTool — 后台任务查询

**新增工具 `task_status`**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

- 输入：`{ taskId: string, wait?: boolean, timeoutMs?: number }`
- `wait=false`（默认）：立即返回任务当前状态（pending/running/completed/failed）
- `wait=true`：阻塞等待任务结束或超时（默认 30s），底层调用 `registry.wait(taskId, timeoutMs)`
- 错误码：`TASK_NOT_FOUND`（taskId 不存在）、`REGISTRY_NOT_READY`（registry 未初始化）、`TASK_WAIT_TIMEOUT`（等待超时）
- `isReadOnly: true`（查询操作不影响状态）

#### 4. /tasks CLI 命令

**新增 `/tasks` 命令**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

- 用法：`/tasks [running|completed|failed]`
- 无参数：列出所有后台任务（最多显示 50 条）
- 带状态参数：按状态过滤
- 每条任务显示：taskId、agentId、agentName、status、durationMs、prompt 预览（前 60 字符）
- 无子 Agent 配置时也注册此命令（只要有 harness 引用）

#### 5. 并行子 Agent 执行

`runInBackground=true` 的并行性由异步执行块 `void (async () => {})()` 保证，**不依赖 `partitionToolCalls`**。

- `SubagentTool.isConcurrencySafe` 保持 `() => false`：子 Agent 可能修改共享状态（如文件），即使后台模式也不做并行调度承诺
- `partitionToolCalls` 会将多个 subagent 调用分到各自的串行批次，但每个批次只是注册任务 + 启动异步块 + 立即返回 taskId，几乎不耗时
- 真正的子 Agent 执行在各自异步块中并行运行，不受 `partitionToolCalls` 影响
- 多个写操作 Agent 操作同一文件的冲突由 agent 配置/worktree 隔离负责，不在工具调度层解决

#### 6. 测试

**@harness/subagent 新增 2 个测试套件共 17 个用例**（[packages/plugins/subagent/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.test.ts)）

- `BackgroundTaskRegistry`（8 用例）：register/start/complete/fail/wait/list/cancel/clear 全链路 + 并发任务独立性
- `SubagentTool runInBackground`（9 用例）：立即返回 taskId、子 Agent 失败时状态变 failed、TaskStatusTool 查询/等待/超时/不存在/无 registry、并行 3 个 background subagent 独立完成
- 更新 4 个已有测试断言：`tool.pool.assemble` 注入 2 工具、`/subagents` 注册 2 命令、无子 Agent 时仍注册 `/tasks`、`uninstall` 后 2 工具均不可用

#### 7. 验证

- `@harness/subagent` 单元测试：83 pass / 0 fail（272 assertions）
- 全量 typecheck：22 个包全部通过
- 无回归：原有 66 个测试保持通过

## 2026-08-23（续 5）：Skill / Agent 多级加载修复

### 今日完成

修复 Skill Layer 和 Agent 加载中"承诺多级、实际只有 project 一级"的问题，落地 user 级 + project 级两层加载，实现 project 覆盖 user 的优先级策略。

#### 问题回顾

Skill 代码注释宣称三来源合并（bundled/user/project/mcp）+ 优先级覆盖，实际实现：
- `SkillManagerImpl.load(dir)` 把目录路径硬编码为 `source: 'project'`
- CLI 只配置 `skillDirs: ['.harness/skills']` 单一目录
- core 遍历 skillDirs 不区分来源

Agent 加载存在同样问题：CLI 只配置 `agentDirs: ['.harness/agents']` 单一目录。

#### 1. 模块修复

**@harness/skill — `load()` 接口增加 sourceTag 参数**（[packages/skill/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.ts)）

- 接口签名：`load(source: SkillSource | string, sourceTag?: SkillSource = 'project')`
- 当 `source` 为目录路径时，用 `sourceTag` 标记来源（user/project/mcp）
- `skillFromMarkdown` 调用时传入 tag，MCP 来源强制 `allowEmbedShell=false`
- 同 ID 后加载覆盖先加载（map.set 覆盖语义）
- 注释更新：MCP 来源建议通过 register() 注册从 MCP Server 拉取的 Skill

**@harness/core — `skillDirs` / `agentDirs` 接口扩展**（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）

- `skillDirs?: Array<string | { dir: string; source?: SkillSource }>`（兼容字符串和对象形式）
- `agentDirs?: Array<string | { dir: string; source?: 'user' | 'project' }>`（同上）
- Skill 加载逻辑（init() 中）：从 entry 提取 `dirPath` + `sourceTag`，调用 `this.skillManager.load(resolvedDir, sourceTag)`
- Agent 加载逻辑（构造函数中）：从 entry 提取 `dirPath`，按数组顺序遍历（同 ID 后加载覆盖先加载）
- 顶部 import 补 `type SkillSource`

**@harness/cli — 默认配置两级加载**（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

- `agentDirs: [{ dir: '~/.harness/agents', source: 'user' }, '.harness/agents']`
- `skillDirs: [{ dir: '~/.harness/skills', source: 'user' }, '.harness/skills']`
- user 在前、project 在后，project 覆盖 user

#### 2. 测试

**@harness/skill 新增 3 个测试用例**（[packages/skill/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.test.ts)）

- `多级加载：user → project 顺序，project 覆盖 user（同 ID 后加载覆盖先加载）`：同 ID 在 user/project 两级目录分别定义，验证 `loadedFrom === 'project'` 且 content 是 project 版本
- `sourceTag 缺省为 project`：调用 `mgr.load(tmpDir)` 不传 sourceTag，验证 `loadedFrom === 'project'`
- `sourceTag: user 不影响 allowEmbedShell（默认 true）`：验证 user 来源不被强制禁用 shell embed（只有 mcp 来源才强制禁用）

#### 3. 验证

- @harness/skill：21/21 测试通过（67 assertions）
- @harness/core：22/22 测试通过（86 assertions）
- @harness/cli：16/16 测试通过（52 assertions）
- 全部 22 个包 typecheck 通过，无回归

#### 4. 设计决策

- **API 兼容性**：`skillDirs`/`agentDirs` 同时支持字符串和 `{dir, source}` 对象形式，旧用法（字符串数组）默认按 project 处理
- **多级覆盖靠加载顺序**：core 按数组顺序遍历，user 目录在前、project 目录在后，依赖 `register()`/`skills.set()` 的覆盖语义，不需要显式优先级比较
- **MCP 来源不走文件目录**：MCP 来源的 Skill 一般从 MCP Server 拉取，建议通过插件用 `register()` 注册
- **Agent 不加 loadedFrom 字段**：Agent 没有来源相关的安全策略差异（不像 Skill 有 `allowEmbedShell` 安全切断），多级覆盖靠加载顺序保证即可

---

## 2026-08-23（续 4）：Skill Layer 实现

### 今日完成

实现双轨制 Skill Layer：Skill = 知识（Markdown 正文）+ Tool = 功能（代码执行），支持从文件系统加载 Markdown 格式的 Skill 定义，通过 paths 条件触发和 Agent 白名单控制注入到 system prompt。

#### 1. 模块开发

**@harness/skill — 双轨技能系统**（[packages/skill/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.ts)）

新建包，实现完整 Skill 系统：

- **Skill 接口**：id / name / description / loadedFrom / paths / userInvocable / agentBind / content / embeds / allowEmbedShell / allowedTools / model / effort
- **SkillSource 类型**：`bundled` | `user` | `project` | `mcp`（MCP 来源强制 `allowEmbedShell=false`，防 RCE）
- **SkillManager 接口**：`all() / get(id) / load(source) / matchByPath(path) / filterByAgent(agentId) / reload(id)`
- **SkillManagerImpl 实现**：
  - `load(dir)` 支持两种目录结构：`skills/skill-name/SKILL.md`（目录形式，Claude Code 风格）和 `skills/skill-name.md`（单文件形式）
  - `matchByPath(filePath)` 遍历所有 Skill，检查 paths glob 匹配
  - `filterByAgent(agentId)` 按 agentBind 过滤可用技能
  - `reload(id)` 从原始来源目录热重载
  - 同 ID 优先级：project > user > bundled > mcp（后加载覆盖先加载）
- **skillFromMarkdown** 解析函数：
  - 解析 frontmatter（简化 YAML 解析器，无外部依赖）+ body
  - `id` 优先取 `frontmatter.id`，最后 `fallbackId`（目录名）
  - `name` 优先取 `frontmatter.name`，最后 `fallbackId`
  - 提取内嵌资源：`!\`cmd\`` → shell embed，`{{var}}` → variable embed
  - MCP 来源强制 `allowEmbedShell=false`
- **formatSkillForPrompt** 格式化函数：`# Skill: ${name}` + `> ${description}` + Markdown 正文

**@harness/core — SkillManager 集成 + 注入 Hook**（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）

- `HarnessOptions` 新增 `skillDirs?: string[]` 配置项
- `HarnessImpl` 新增 `skillManager?: SkillManager` 字段（构造函数中实例化，避免构造函数 await）
- `init()` 方法中：
  1. 从 `skillDirs` 异步加载 SKILL.md（构造函数不能 await，延迟到 init）
  2. 仅当有 Skill 加载成功时才注册 `core.skill-injection` 插件（避免空 Hook）
  3. 插件实现 `prompt.system.transform` Hook：读取 `agent.skills` 白名单，注入对应 Skill 到 system prompt
- 新增 `core.skill-injection` 内置插件：`id: 'core.skill-injection'`，`version: '0.1.0'`，install() 返回 Hooks

**@harness/cli — 默认配置 skillDirs**（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

- `createHarness` 调用默认配置 `skillDirs: ['.harness/skills']`，支持从项目目录加载 Skill

#### 2. 测试

**@harness/skill 单元测试**（[packages/skill/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.test.ts)）

18 个测试用例，62 个断言，全部通过：

- `skillFromMarkdown`：完整 frontmatter + body、无 name 用 fallbackId、无 frontmatter 用默认值、MCP 来源强制禁用 shell embed、非 MCP 来源默认允许、userInvocable: false、agentBind 绑定、内嵌资源提取
- `SkillManagerImpl`：register+get+all、filterByAgent（无/有 agentBind）、matchByPath glob 匹配、load 目录形式、load 单文件形式、load 不存在目录、reload 热重载
- `formatSkillForPrompt`：带描述格式化、无描述省略描述行

#### 3. 关键设计决策

- **双轨制**：Skill = 知识（Markdown），Tool = 功能（代码执行），分离关注点
- **三来源合并**：bundled / user / project / mcp，同 ID 后加载覆盖先加载
- **MCP 安全切断**：MCP 来源强制 `allowEmbedShell=false`，防 RCE（同 Claude Code 安全策略）
- **paths 条件触发**：glob 匹配文件路径自动注入上下文（参考 Claude Code loadSkillsDir）
- **Agent 白名单**：`agent.skills` 字段控制哪些 Skill 注入到该 Agent 的 system prompt
- **id 与 name 分离**：id 来自目录名或显式 `frontmatter.id`，name 是显示名（与 Claude Code 一致）

#### 4. 验证

- @harness/skill：18/18 测试通过（62 assertions）
- @harness/core：22/22 测试通过（86 assertions）
- @harness/agent：19/19 测试通过（42 assertions）
- 全部 22 个包 typecheck 通过，无回归

---

## 2026-08-23（续 3）：Subagent 工具调用摘要

### 今日完成

在 Subagent Bus 事件推送完成后，实现工具调用摘要功能：当子 Agent 最终回复过长时，自动截断文本 + 附加工具调用列表，避免上下文膨胀。

#### 1. 模块开发

**@harness/subagent — 工具调用摘要**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

新增 4 个 helper 函数 + 2 个输出字段 + 1 个配置项：

- `summarizeToolInput(toolId, input)` — 按 toolId 提取关键信息（read_file→path, bash→command, glob→pattern, grep_file→pattern, web_fetch→url, 默认→第一个字符串值）
- `truncateStr(s, maxLen)` — 截断字符串加 `...` 后缀
- `countToolCalls(messages)` — 统计子 session 中所有 `type: 'tool'` part 数量
- `summarizeResult(messages, finalText, maxResultLength)` — 超过阈值时生成摘要 = 截断文本(500字) + 工具调用列表 + 截断提示

新增配置和字段：
- `SubagentPluginOptions.maxResultLength`（缺省 2000 字符）
- `SubagentToolOutput.summarized`（布尔，标记是否被摘要）
- `SubagentToolOutput.toolCallCount`（子 Agent 内部工具调用次数）
- `renderResult` 输出也包含 `summarized` 和 `toolCallCount`

摘要格式示例：
```
这是子 Agent 的前 500 字回复...

[工具调用摘要（3 次调用）]
- read_file: /src/foo.ts
- bash: npm test
- bash: false [错误]

[完整回复 3000 字符已截断为摘要]
```

#### 2. 测试

- 8 个新增单元测试（[packages/plugins/subagent/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.test.ts) 工具调用摘要测试块）
- 覆盖：短结果不摘要 / 长结果摘要+工具调用列表 / 错误工具标记 / maxResultLength 可配置 / 无工具调用仅截断文本 / renderResult 新字段 / summarizeToolInput 按类型提取 / bash 长命令截断到 80 字符
- **subagent 包：41 pass / 0 fail / 154 assertions**
- 全量 typecheck：22 个包全绿

## 2026-08-23（续 2）：Subagent 实时进度推送（Bus 事件）

### 今日完成

在 Subagent 基础插件（独立 session + 递归白名单 + description/model/sessionId/parentId）完成后，实现 Subagent Bus 事件推送功能，让父 Agent / CLI / TUI 能实时感知子 Agent 执行进度。

#### 1. 模块开发

**@harness/subagent — Bus 事件推送**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

定义 3 个类型安全的 Bus 事件（`SubagentEvents`）：
- `subagent.started` — 子 Agent 开始执行（agentId, agentName, subSessionId, parentSessionId, parentAgentId, parentMessageId, toolUseId, prompt, description, isContinuation, startedAt）
- `subagent.completed` — 子 Agent 完成（agentId, subSessionId, parentSessionId, toolUseId, replyPreview, messageCount, durationMs）
- `subagent.failed` — 子 Agent 失败（agentId?, subSessionId?, parentSessionId, toolUseId, code, message, durationMs）

关键设计：
- `HarnessLike` 接口扩展 `bus?: Bus`，在 `harness.start` hook 中自动获取（`HarnessImpl.bus` 是 public 字段）
- `call()` 方法在 6 个关键节点发布事件：HARNESS_NOT_READY / AGENT_NOT_FOUND / INVALID_AGENT_MODE / SESSION_NOT_FOUND / SESSION_CREATE_FAILED / SUBAGENT_FAILED → `failed`；session 创建后 → `started`；成功 → `completed`
- `publishFailed` 闭包封装避免重复代码，`bus.publish().catch()` 确保事件发布失败不影响主流程
- 长 prompt 截断到 500 字符，长 reply 截断到 200 字符（均加 `...` 后缀）
- 增强 harness 健壮性检查：`!harness || !harness.agent || !harness.session` 统一返回 HARNESS_NOT_READY

#### 2. 测试

- 10 个新增单元测试（[packages/plugins/subagent/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.test.ts) Bus 事件测试块）
- 覆盖：成功执行 started+completed / 续接 session isContinuation=true / Agent 未注册 failed / Harness 未就绪 failed / 超时 started+failed / 无 bus 正常工作 / 长 reply 截断 / 长 prompt 截断 / SUBAGENT_FAILED 含 subSessionId
- **subagent 包：33 pass / 0 fail / 122 assertions**
- 全量 typecheck：22 个包全绿

## 2026-08-22（续）：会话管理增强 + CLI 扩展 + MCP Client 插件

### 今日完成

在 Phase 4 会话 Compaction 之后，连续推进三项 P1/P2 交付：会话管理增强（标题/搜索/导出）、插件化 CLI 命令扩展（`cli.commands` / `cli.command` Hook）、MCP Client 插件（stdio + HTTP/SSE transport + resources/prompts 发现 + Bearer 鉴权）。**18 个包 typecheck 全绿，43 个新增单元测试全通过（@harness/mcp-client 34 + core/cli 新增 9）**。

#### 1. 模块开发

| # | 提交 | 模块 / 变更 | 能力 | 测试数 |
|---|---|---|---|---|
| 1 | `33974b1` | `@harness/core` `DefaultSessionManager` 会话增强 | ① `generateTitle()`：规则化标题生成（首条用户消息前 60 字符 + 工具调用密度提示 + 长文本截断标记）② `search(keyword)`：关键词检索（标题 + 消息文本 + 工具名 + 工具输入）③ `exportMarkdown(sessionId)`：渲染完整对话为 Markdown（系统记忆 + 用户/助手轮次 + 工具调用 codeblock + 元数据尾部） | 6 |
| 2 | `33974b1` | `@harness/cli` 新增斜杠命令 | `/search <keyword>` 调用 `session.search` 列出匹配会话；`/export [path]` 导出当前会话 Markdown 到文件或 stdout | — |
| 3 | `195c12f` | `@harness/plugin` Hooks 扩展 | 新增 `cli.commands(input)` Hook（插件注册可用斜杠命令到 `/help`）+ `cli.command(input)` Hook（插件处理自定义斜杠命令，可输出文本、控制 result: continue/exit） | 3 |
| 4 | `195c12f` | `@harness/cli` 插件命令分发 | REPL 解析未知 `/xxx` 时依次调用插件的 `cli.command` Hook；`/help` 列出插件注册的命令 | — |
| 5 | `82acf8e` | `@harness/mcp-client`（新包 v0.1.0） | MCP Client 插件首版：`McpClient`（JSON-RPC 2.0 over stdio，initialize/tools/list/tools/call）、`StdioTransport`（spawn 子进程 + 行分隔 JSON 收发）、`convertMcpToolToHarnessTool`（MCP 工具 → Harness Tool，Fail-Closed 默认值）、`createMcpClientPlugin`（harness.start 连接 + tool.pool.assemble 注入 + `/mcp` CLI 命令） | 9 |
| 6 | `139c00c` | `@harness/mcp-client` v0.2.0 增强 | ① `HttpTransport`：Streamable HTTP（MCP 2025-03-26），POST JSON-RPC，响应支持 JSON / SSE 流，自动缓存并回传 `Mcp-Session-Id` ② `SseTransport`：旧版 HTTP+SSE，GET 建立 SSE 流接收 `endpoint` 事件，POST 到该端点 ③ `defaultTransportFactory`：根据 `config.transport` 选择 ④ `McpClient` 扩展：缓存 `serverCapabilities`/`serverInfo`/`protocolVersion`；新增 `listResources`/`readResource`/`subscribeResource`/`listPrompts`/`getPrompt`；`onNotification` 接收 `resources/listChanged` 等通知 ⑤ `McpAuthConfig`：bearerToken / authorizationHeader / 自定义 headers ⑥ `/mcp` 子命令扩展：servers/tools/resources/read \<uri\>/prompts/prompt \<name\> ⑦ `autoInjectResources`：可选把资源 text 注入到 `prompt.system.transform` | 25 |

#### 2. 关键技术决策

- **标题生成不依赖 LLM**：规则化提取首条用户消息前 60 字符 + 工具调用密度提示，可离线、可重复、无费用，作为默认策略。后续可通过 hook 注入 LLM 生成版本。
- **搜索覆盖多维度**：标题 + 消息文本 + 工具名 + 工具输入四维匹配，单条命中即返回，避免漏检。
- **Markdown 导出格式约定**：系统记忆 → 用户/助手轮次（含工具调用 codeblock）→ 元数据尾部（会话 ID、消息数、压缩统计），可直接作为文档归档。
- **CLI 扩展用 Hook 而非硬编码**：插件通过 `cli.commands` 声明命令、`cli.command` 处理命令，CLI 层只做分发，保持开放-封闭原则。
- **MCP Transport 三态抽象**：`McpTransport` 接口统一 stdio/http/sse 三种传输，`send` 返回 `void | Promise<void>` 兼容同步/异步 transport；`defaultTransportFactory` 根据配置字段选择，缺省按 command/url 推断。
- **capabilities 驱动的方法可用性**：`McpClient.listTools/listResources/listPrompts` 先检查 `serverCapabilities` 对应字段，未声明时返回空数组（不调用 server），避免无效请求。
- **Bearer 鉴权分层**：`authorizationHeader` 优先级高于 `bearerToken`，便于用户直接传入完整 Authorization 头（如 OAuth2 流程外层拿到的 token）。
- **autoInjectResources 可选注入**：默认不注入资源到 system prompt（避免污染上下文），通过 `'all'` 或 `string[]` 策略显式启用，注入通过 `prompt.system.transform` hook 完成。
- **OAuth2 PKCE 暂不实现**：完整 OAuth2 授权码 + PKCE 流程需要独立 OAuth client 模块和回调服务器，复杂度高且与 MCP 协议本身解耦。当前提供静态 Bearer Token 注入，足以对接大多数 MCP Server。

#### 3. 遇到的问题与修复

| 问题 | 原因 | 修复 |
|---|---|---|
| 标题生成测试"长文本截断"用例失败 | 测试用例文本长度不足 60 字符 | 扩展测试用例文本长度，确保超过 60 字符触发截断逻辑 |
| `cli.command` Hook 测试 `cliInput` 类型错误 | 缺少 `result` 可选属性 | 显式定义 `cliInput` 类型，包含 `result?: 'continue' \| 'exit'` |
| MCP Client 旧测试 `listTools` 返回空 | 扩展后 `listTools` 依赖 `capabilities.tools`，旧测试 mock initialize 响应未声明 capabilities | 补充 mock 响应 `capabilities: { tools: {} }` |
| MCP Client `listPrompts` 请求悬挂超时 | autoInject 测试 mock 未注册 `prompts/list`，但 capabilities 声明了 prompts | 补注册 `prompts/list` 返回空数组 |
| `defaultTransportFactory` stdio 测试 spawn ENOENT | 受限测试环境 PATH 缺 `/bin`，`echo` 找不到 | 改用绝对路径 `/bin/echo` |
| HTTP transport SSE 流解析遗漏最后一段 | `lastIndexOf('\n\n')` 未 flush 残留 buffer | 循环结束后补 flush `buf + '\n\n'` |

#### 4. 代码统计

```
18 个 packages / typecheck 全绿 / 新增 43 个测试
当前 MCP Client 能力：
  - stdio transport（子进程 JSON-RPC）
  - http transport（Streamable HTTP，JSON/SSE 响应，Mcp-Session-Id 会话）
  - sse transport（旧版 HTTP+SSE，endpoint 事件）
  - resources/list + resources/read + subscribe
  - prompts/list + prompts/get
  - Bearer Token 鉴权
  - /mcp 子命令：servers / tools / resources / read / prompts / prompt
  - autoInjectResources 注入 system prompt
对外 API：
  - createMcpClientPlugin({ servers, transportFactory?, autoInjectResources? })
  - McpClient.connect/listTools/callTool/listResources/readResource/listPrompts/getPrompt
  - defaultTransportFactory(config)
```

---

## 2026-08-23：会话 Compaction（三级压缩 + 系统记忆注入）

### 今日完成

完成 Phase 4 的会话压缩能力：三种压缩策略（prune / summary / agent）、按阈值自动触发 `compactIfNeeded`、压缩后摘要作为长期系统记忆注入到 Agent system prompt；CLI 暴露 `/compact` 斜杠命令、resume/repl/run 启动时自动 compactIfNeeded。

**17 个包 typecheck 全绿（0 error）；与 compaction 相关 4 个新增单元测试全部通过**。

#### 1. 模块开发

| # | 模块 / 变更 | 能力点 | 测试数 |
|---|---|---|---|
| 1 | `@harness/session` Session.meta schema 扩展 | 导出 `CompactionMeta`（压缩统计：count/lastStrategy/totalPrunedMessages 等）+ `CompactMemory`（摘要文本+轮次+记忆起点）+ `COMPACT_META_KEY` / `COMPACT_MEMORY_KEY` 约定；扩展 `CompactOptions`（`strategy` / `thresholdTokens` / `keepRecentMessages` / `summaryMaxChars` / `tokensPerMessage`）；`SessionManager` 接口新增 `compact(…, options?)` / `compactIfNeeded(…)` / `getCompactionInfo(…)` | — |
| 2 | `@harness/core` `DefaultSessionManager` compaction 实现 | 三级策略：`prune`（只截断、保留最近 K 条）/ `summary`（规则摘要：角色分布+首末用户要点+助手节选+工具调用统计，无需 LLM）/ `agent`（复用 AgentRuntime.query 生成摘要，缺失时自动 fallback 到 summary）；多轮合并：把"前一轮 CompactMemory.summaryText"作为上下文附加在新摘要前方，跨压缩轮次保留长期记忆；统计写入 `Session.meta` | — |
| 3 | `@harness/core` `AgentRuntimeImpl` 系统记忆注入 | 新增 `appendCompactionMemory()` helper，在构建 system prompt（`query()` 与流式 `buildContext()` 两处）时把压缩记忆作为独立 system part 追加（在 `prompt.system.transform` hook 之前，允许插件二次改写） | — |
| 4 | `@harness/cli` 命令 + 自动压缩 | 新增 `/compact [prune|summary|agent|auto]` 命令，打印压缩后 meta+memory 摘要；在 `repl / resume / run` 进入交互前调用一次 `compactIfNeeded`，命中阈值时提示压缩结果 | — |
| 5 | `@harness/core` `core.test.ts` Session Compaction 测试块 | 4 个关键验证：① summary 策略长度+meta/memory 统计 ② prune 策略不产生新摘要 ③ compactIfNeeded 阈值触发/no-op ④ system prompt 注入 memory 片段包含压缩标题、轮次与摘要正文 | 4 |

#### 2. 关键技术决策

- **Compaction 不直接压缩 system prompt**：我们的 system prompt 在 AgentRuntime 内动态拼合 agent.promptFragments 与 compaction memory，不写入 session.messages。压缩算法只处理 session.messages（约定不含 system 消息），避免重复拼接。
- **多轮摘要累积而非覆盖**：新一轮压缩时把"旧 CompactMemory.summaryText"作为"更早记忆"段落加在新摘要前方，避免 LLM 丢失更早语义；同时 `round` 单调递增，system memory 注入时会展示轮次。
- **默认阈值（8000 tokens × 500/msg）偏保守**：`compactIfNeeded` 默认使用 8000 tokens 触发（估算 = `messages.length × tokensPerMessage`，默认每条 500），与 keepRecentMessages=6（最近 3 轮）保证短对话永远不触发。
- **agent 策略采用 fail-closed fallback**：`agent` 策略优先走 AgentRuntime.query 调 LLM 生成摘要；若缺少 ChatProvider/AgentRuntime 或调用出错，不抛异常给业务，静默回落到 ruleBasedSummary，保证 compaction 永远可用。
- **summary 策略做确定性、无 LLM 依赖**：规则摘要按"首末用户要点 + 助手节选 + 工具调用统计 + 前压缩轮次提示"组合，可离线、可重复、无费用，作为默认策略。
- **CompactOptions 设计为单源**：`compact()` 的第二参数 `strategy` 与第三参数 `options.strategy` 等价，`strategy` 显式参数优先，便于 CLI 直接传策略、也便于程序化代码通过 CompactOptions 调用。

#### 3. 遇到的问题与修复

| 问题 | 原因 | 修复 |
|---|---|---|
| 测试最初 `h.session.update(id, fn)` 报错 `update` 不存在于 `SessionManager` 接口 | `@harness/session` 暴露的是细粒度的 `updateMessage / addMessage / updatePart`，没有整 session mutate 入口 | 改用 helper `fillMessages(h, sessionId, rounds)` 循环调用 `h.session.addMessage` 注入消息 |
| core typecheck：`SessionManager` import 类型中缺 `CompactOptions / CompactionMeta / CompactMemory / COMPACT_META_KEY / COMPACT_MEMORY_KEY` | 新增类型未同步进 import | 在 `import type` 块补齐，并 `import { COMPACT_META_KEY as COMPACT_META_KEY_VAL, COMPACT_MEMORY_KEY as COMPACT_MEMORY_KEY_VAL }` 引入运行时常量，避免同文件类型/值混合引用问题 |
| 无 test 文件的包（permission/agent/skill/session）`bun test` 返回 exit code 1 | 这些包只有 `scripts.test="bun test"`，默认 bun 找不到 *.test.ts 返回 1 | 暂不在本次修（属 monorepo 历史脚本问题，与 compaction 无关）；逐个包验证 core、cli、builtin/plugin 均 0 fail |

#### 4. 代码统计

```
17 个 packages / typecheck 全绿 / 新增 compaction 单测 4 个 / 核心断言数：
  - 压缩长度：summary 20→6、prune 16→4
  - 统计：count=1 / lastMessagesBefore / totalPrunedMessages / round
  - 注入：system prompt 含"会话压缩记忆"与摘要前缀匹配
会话 compaction 能力对外 API：
  - SessionManager.compact(sessionId, strategy?, options?)
  - SessionManager.compactIfNeeded(sessionId, options?) => boolean
  - SessionManager.getCompactionInfo(sessionId) => { meta?, memory? }
CLI 斜杠命令：
  - /compact [prune|summary|agent]
  - /compact auto (或 ifneeded) = compactIfNeeded
```

---

## 2026-08-21：流式输出 + Provider 扩展 + 工具插件化拆分

### 今日完成

在 Phase 3 基础上完成三项交付：流式输出打通全链路、新增 OpenAI Provider、按"原语才内置"原则拆分工具包。**14 个包 typecheck 全绿，215 个单元测试全通过（595 断言）**。

#### 1. 模块开发

| # | 提交 | 模块 / 变更 | 能力 | 测试数 |
|---|---|---|---|---|
| 1 | `fb9c3ae` | `@harness/core` 流式输出 | `ChatStreamChunk` + `AgentStreamEvent` 类型；`ChatProvider.stream?()` 可选方法；`AgentRuntime.queryStream()` 边流式边处理工具调用；`SessionManager.promptStream()`；CLI REPL / `run` 子命令逐 token 打印 | — |
| 2 | `fb9c3ae` | `@harness/provider-anthropic` 流式 | `AnthropicChatProvider.stream()`：解析 SSE（`message_start` / `content_block_delta` / `message_delta`），yield `text_delta` / `tool_use_start` / `tool_use_delta` / `tool_use_stop` / `done` | 4 |
| 3 | `fb9c3ae` | `@harness/provider-mock` 流式 | `MockChatProvider.stream()`：逐 token 模拟输出，供无网络环境测试流式链路 | — |
| 4 | `ddc5db3` | `@harness/tools-builtin` 新增工具 | `list_dir`（目录列举：递归/隐藏文件/类型/大小）、`grep_file`（正则检索：glob 过滤/大小写/递归）、`edit_file`（精确替换：`oldString`→`newString`，`replaceAll`/多行/多重匹配校验） | 16 |
| 5 | `4d39c29` | `@harness/provider-openai`（新包） | OpenAI Chat Completions 对接：Bearer auth、Part→messages 序列化（`tool_calls` 数组 / `role:tool` 带 `tool_call_id` / `image_url` data: URI）、Tool Schema 导出、`complete()` 非流式 + `stream()` 流式（SSE `data:[DONE]` 终止、tool_calls 按 index 累积 arguments 增量） | 17 |
| 6 | `e65543d` | 工具插件化拆分 | `@harness/tools-builtin` 瘦身为 4 个原语（v0.3.0）；`list_dir`/`grep_file` 抽到新包 `@harness/tools-search`（v0.1.0，自包含 helper + `toolsSearchPlugin` 工厂） | 14 |

#### 2. 关键技术决策

- **流式类型分层**：`ChatStreamChunk`（Provider 层，纯 LLM 输出）与 `AgentStreamEvent`（Agent 层，含工具执行结果）解耦，让 Provider 不感知工具执行
- **OpenAI 与 Anthropic 序列化差异**：Anthropic 用 `tool_use`/`tool_result` block；OpenAI 用 assistant.tool_calls 数组 + 独立 `role:tool` 消息（带 `tool_call_id` 关联），两条序列化路径分别实现
- **工具流式增量累积**：OpenAI 的 `tool_calls` 按帧增量（首帧带 id+name，后续只带 arguments 片段），用 `Map<index, state>` 累积并按帧 yield `tool_use_delta`
- **"原语才内置"判定原则**：内置仅留不可替代、不可组合替代、非场景化的工具。`read_file`/`write_file`/`edit_file`/`bash` 是文件 I/O + Shell 原语；`list_dir`/`grep_file` 属搜索导航场景（`bash ls/grep` 可替代），抽为独立插件
- **插件包自包含**：`@harness/tools-search` 自带 `resolvePath`/`isWithinCwd`/`makeSchema`/`globMatch` helper，不反向依赖 `@harness/tools-builtin`，保持插件可独立装卸
- **配置三级来源一致**：OpenAI Provider 沿用 `直接传入 > ctx.config.get('provider.openai') > 环境变量 OPENAI_API_KEY/OPENAI_BASE_URL` 优先级，与 Anthropic Provider 对齐

#### 3. 遇到的问题与修复

| 问题 | 原因 | 修复 |
|---|---|---|
| `new-tools.test.ts` 类型错误 `res.output` 可能 undefined | 测试直接访问 `res.output.count` 未做空断言 | 统一加非空断言 `res.output!.count`（仅在 `res.ok===true` 分支） |
| `ToolContext` 缺 `toolUseId` 字段 | 测试 ctx 构造遗漏该必填字段 | 补 `toolUseId: 'tu1'` |
| 旧测试断言 `builtinTools` 6 个工具 | 拆分后 builtin 仅 4 个、search 2 个 | 更新断言为 `['bash','edit_file','read_file','write_file']`，search 包独立断言 `['grep_file','list_dir']` |
| Anthropic stream 测试 mock fetch 类型不匹配 | mock 返回类型与全局 `fetch` 签名冲突 | mock 函数返回类型改 `any` |
| 拆分后 `readdir`/`join`/`globMatch` 成为 tools-builtin 死代码 | 仅被迁出的 list_dir/grep_file 使用 | 清理 imports 与 helper，迁入 tools-search |

#### 4. 代码统计

```
14 个 packages / 215 个测试 / 595 个 expect（较 08-16 +6 包 +45 测试）
当前工具分布：
  - @harness/tools-builtin（v0.3.0）：read_file / write_file / bash / edit_file（4 原语）
  - @harness/tools-search（v0.1.0）：list_dir / grep_file（搜索类）
当前 Provider 分布：
  - @harness/provider-anthropic（complete + stream）
  - @harness/provider-openai（complete + stream）
  - @harness/provider-mock（complete + stream，测试用）
```

---

## 2026-08-22：工具插件化持续扩展（glob/web/media 三场景包）

### 今日完成

延续"原语内置，场景按插件接入"的拆分原则，新增三个场景工具包。**17 个包 typecheck 全绿，248 个单元测试全通过（690 断言，较 08-21 +33 测试）**。

#### 1. 模块开发

| # | 模块（新包） | 工具 | 核心能力 | 测试数 |
|---|---|---|---|---|
| 1 | `@harness/tools-glob` v0.1.0 | `glob` | 多模式 `**` / `*` / `?` 通配符；`!` 取反 + `exclude` 便捷字段；隐藏文件默认跳过；文件大小 min/max 过滤；最大深度限制；结果上限截断；cwd 边界保护 | 9 |
| 2 | `@harness/tools-web` v0.1.0 | `web_fetch` | HTTP(S) 抓取，支持 GET/POST/PUT/PATCH/DELETE；自定义 headers / body（对象自动 JSON 序列化）；三种返回格式 `text` / `json` / `base64`（data: URI）；follow redirects / maxBytes 截断 / timeoutMs + AbortSignal；SSRF 防护（默认拦截 10.x / 172.16-31 / 192.168 / 127.x / fc/fd / localhost*.local）；`allowPrivateNetwork` 显式放行 | 14 |
| 3 | `@harness/tools-media` v0.1.0 | `view_image` | 本地图片读取转 base64 data URI + 尺寸解析（PNG/JPEG/GIF/BMP/WebP 魔数识别，含 PNG/GIF/BMP 宽高、JPEG SOF0 段遍历）；maxBytes + strictSize 模式（过大报错 or 仅回元数据）；cwd 路径边界保护 | 10 |

三包均按 `tools-search` 模板统一：
- 自包含 helper（resolvePath / isWithinCwd / makeSchema / 场景专用 helper），不反向依赖 `tools-builtin`
- `defineTool` + Fail-Closed 安全声明（`isReadOnly`/`isDestructive`/`isConcurrencySafe`），`permission.key` 按场景分配（`read`/`network`）
- `createXxxPlugin({ toolIds })` 工厂 + 默认导出 `toolsXxxPlugin` 常量
- 通过 `tool.pool.assemble` Hook 注入 `ToolRegistry`

#### 2. 关键技术决策

- **三插件均 `isConcurrencySafe=true` 声明**：glob 纯读、web_fetch 请求幂等、view_image 只读，可并行执行（Fail-Closed 需显式声明）
- **web_fetch 权限键用 `network`（非 `read`/`write`）**：网络访问是独立能力维度，与本地文件的读写权限体系分离，可被 permission 引擎单独管控
- **SSRF 默认 fail-closed，白名单开启**：私有 IP / localhost / .local / 169.254 link-local 全部拦截，仅当调用方显式 `allowPrivateNetwork=true` 才放行——与 fail-closed 哲学一致
- **view_image 尺寸解析零依赖**：纯字节判断 PNG IHDR/JPEG SOF0/GIF6/7/BMP DIB 头，不引入 sharp/jimp 等本地图像库
- **已 abort signal 同步快速路径**：web_fetch 在进入 await fetch 前同步检查 `inner.signal.aborted`，避免 mock fetch 不监听 signal 时悬挂
- **glob 正则按段构建**：`**` 段末尾位置写 `.*`（匹配任何内容到结尾）、非末尾写 `(?:.*/)?`（包含段间 `/`），其它段单独转义后拼接，避免双重 `/` 问题

#### 3. 遇到的问题与修复

| 问题 | 原因 | 修复 |
|---|---|---|
| glob `**/*.ts` 匹配空（递归、排除两个用例失败） | `globToRegex` 用 join('/') 把 `(?:.*/)?` 与下段之间插入了额外 `/`，导致必须存在 `/` 才能匹配（根层漏掉） | 改为按段逐段拼接：非末尾 `**` → `(?:.*/)?`（自带末尾 `/`）、非末尾普通段 → `escaped` + `/` |
| `readFile(path, null, { length: 32 })` 三参数 TS 错误 | Node `fs/promises.readFile` 仅接受 `(path, options?)` 两参数，无 `length` 选项 | 改用 `open(path, 'r') → fh.read({ buffer, length: 32 }) → fh.close()` 三步 |
| `mkdirSync(join('src', { recursive: true }))` 类型错误 | 把 mkdirSync options 当 join 第三参数传入了（括号错位） | 修正括号：`mkdirSync(join('src'), { recursive: true })` |
| `error.detail` TS 类型不匹配（`JSON_PARSE_ERROR` 中） | Tool `ToolError` 结构仅 `{ message, code?, cause? }`，无 `detail` | 把原始字节片段拼接到 `message` 字符串中，移除非法 `detail` 字段 |
| web_fetch AbortSignal 测试 5s 超时挂死 | 最初 mock fetch 返回永不 settle Promise，inner.signal abort 也无法让 hanging fetch 解挂 | 改写：1) 已 abort 用例改用"提前 abort signal + fetch 前同步检查快速失败"；2) timeout 用例 mock fetch 监听 init.signal 的 abort 事件，收到后 reject AbortError，settle Promise |

#### 4. 代码统计

```
17 个 packages / 248 个测试 / 690 个 expect（较 08-21 +3 包 +33 测试）

场景工具插件（按 tools-search 模板）：
  - @harness/tools-search   v0.1.0 list_dir / grep_file（搜索导航）
  - @harness/tools-glob     v0.1.0 glob（模式匹配）
  - @harness/tools-web      v0.1.0 web_fetch（网络抓取 + SSRF 防护）
  - @harness/tools-media    v0.1.0 view_image（多模态图像 base64 + 尺寸）
```

---

## 2026-08-16：Phase 1 ~ Phase 3 核心交付

### 今日完成

从架构设计到可运行的 CLI，一天内完成了 8 个模块的开发、测试与推送，共 **170 个单元测试全绿、12 个包 typecheck 0 error**。

#### 1. 架构设计

- 产出 [agent-harness-architecture.md](./agent-harness-architecture.md)
- 融合 Claude Code（6 层严格解耦 + Tool 运行时协议 + Fail-Closed 安全策略）与 OpenCode（Plugin Hooks 管道 + Bus 类型安全事件总线 + 4 级路径权限匹配）两者的优点
- 明确 4 阶段里程碑、12 项关键设计决策、与两个参考架构的 11 维对比

#### 2. 模块开发（按交付顺序）

| # | 模块 | 能力 | 测试数 | PR |
|---|---|---|---|---|
| 1 | `@harness/bus` | 类型安全 Pub/Sub 事件总线：`BusEvent.define` + `InMemoryBus` + 全局订阅 | 24 | #1 |
| 2 | `@harness/tool` | Tool 协议（10+ 属性 + Fail-Closed）+ `ToolRegistry` 注册中心 + `ToolPipeline` 7 步生命周期 + 拓扑排序 | 32 | #1 |
| 3 | `@harness/plugin` | `PluginManager` 三级加载（Internal/Builtin/User）+ Kahn 拓扑排序 + 12 个 Hook 管道 + 热重载 | 32 | #1 |
| 4 | `@harness/core` | `HarnessImpl` 生命周期编排 + 能力模块访问器（tools/agent/session/permission/bus/chat）+ `AgentRuntimeImpl` 主循环 + `DefaultToolPool` + `DefaultSessionManager` | 13 | #2 |
| 5 | `@harness/provider-mock` | `MockChatProvider`：可配置默认响应 / 关键词匹配 / tool call 模拟 / 调用记录 | 12 | #2 |
| 6 | `@harness/tools-builtin` | `read_file` / `write_file` / `bash` 三个内置工具插件 | 32 | #3 |
| 7 | `@harness/provider-anthropic` | Anthropic Messages API 对接：Part→Block 序列化、Tool Schema 两级导出、fetch+超时+AbortSignal、配置三级来源 | 12 | #4 |
| 8 | `@harness/cli` | 命令行入口：REPL + 会话持久化 + 权限交互 + 多子命令（repl/run/resume/list-sessions） | 13 | #5 |

#### 3. 关键技术决策

- **TypeScript + Bun**：原生 TS、零配置运行、fast test runner
- **Monorepo**：`packages/*` + `packages/plugins/*`，workspace 协议，tsconfig path mapping
- **Fail-Closed 安全策略**：所有新工具默认不可并发、非只读，需显式声明能力边界
- **Hooks 管道而非继承**：12 个 Hook 点（`harness.init` / `tool.pre.execute` / `permission.check` 等）让插件介入生命周期
- **Provider 自动 fallback**：CLI 检测到无 `ANTHROPIC_API_KEY` 时自动切到 Mock Provider 并打印提示
- **零外部依赖**：参数解析、glob 匹配、readline 交互全部内置实现，不引入 minimist / picomatch / inquirer

#### 4. 遇到的问题与修复

| 问题 | 原因 | 修复 |
|---|---|---|
| Hook 触发顺序断言错误 | Bad 插件先注册但 Good 插件 Hook 仍执行 | 修正测试断言，确认 Good 插件 Hook 未被执行 |
| logger 错误日志字符串不匹配 | 实际日志带 `[plugin:X]` 前缀 | 调整测试断言匹配实际日志 |
| `loadBuiltin` 重复 ID 测试未注入 dynamicImport | 走到真实 Bun import 失败 | 测试注入 custom dynamicImport 模拟加载 |
| `ToolRegistry` 重复注册 echo | 第二次 query 重复注册工具 | `DefaultToolPool.add/addAll` 已存在时静默跳过 |
| 多行命令测试失败 | `echo "a\nb\nc"` 未正确解释换行 | 改用 `printf "a\nb\nc\n" \| grep b` |
| `tool_result` block 多余 `is_error` 字段 | Anthropic API 不接受非错误时的 `is_error` | 仅 `isError=true` 时写入 `is_error` |
| CLI 短选项 `-s=foo` 解析失败 | 未处理短选项 `=` 形式 | 重写 parseCliArgs 短选项分支 |
| 权限永久 allow/deny 判断失效 | `toLowerCase()` 把大写 A/D 变成 a/d 命中单次分支 | 先判断永久（`answer === 'A'`），再判断单次 |

#### 5. 代码统计

```
8 个 packages / 12 个 tsconfig / 170 个测试 / 449 个 expect
5 个 Draft PR（#1 ~ #5）
```

---

### 下一步计划

#### Phase 4：实用化与扩展

| 优先级 | 方向 | 说明 | 状态 |
|---|---|---|---|
| ~~**P0**~~ | ~~更多内置工具~~ | ~~`list_dir` / `grep_file` / `edit_file`~~ | ✅ 完成（08-21，edit_file 留 builtin，list_dir/grep_file 抽 tools-search） |
| ~~**P0**~~ | ~~流式输出~~ | ~~Provider `stream: true` + REPL 逐 token~~ | ✅ 完成（08-21，core/anthropic/mock 三端 stream） |
| ~~**P1**~~ | ~~`@harness/provider-openai`~~ | ~~GPT-4o 适配，统一 ChatProvider~~ | ✅ 完成（08-21，complete + stream） |
| ~~**P0**~~ | ~~工具持续插件化~~ | ~~tools-web / tools-glob / tools-media 三场景拆包~~ | ✅ 完成（08-22，三新包 +33 测试） |
| **P1** | 会话管理增强 | 标题自动生成、关键词搜索、导出 Markdown、Compaction（长会话摘要压缩） | ⬜ 待办 |
| **P1** | 插件化 CLI 扩展 | 插件可往 CLI 注册自己的子命令 / `/xxx` 斜杠命令 | ⬜ 待办 |
| **P2** | MCP Client 插件 | 对接 Model Context Protocol，支持 local stdio + remote SSE MCP Server | ⬜ 待办 |
| **P2** | Subagent 插件 | `AgentTool` + `runAgent()`，支持子 Agent 嵌套调用 | ⬜ 待办 |
| **P2** | Skill Layer | Markdown 技能 + paths 条件触发 + 三来源发现（bundled/user/project） | ⬜ 待办 |
| **P3** | TUI 形态 | 基于终端 UI 的富交互（类似 Claude Code TUI） | ⬜ 待办 |
| **P3** | Swarm 协作 | Team + Mailbox + Task List + 权限桥接（多 Agent 协作） | ⬜ 待办 |

#### 近期优先推进顺序

1. ~~**流式输出**~~ — ✅ 已完成
2. ~~**`edit_file` + `list_dir` + `grep_file`**~~ — ✅ 已完成（含工具插件化拆分）
3. ~~**`@harness/tools-web` / `tools-glob` / `tools-media`**~~ — ✅ 已完成（三场景包 33 测试）
4. ~~**会话 Compaction**~~ — ✅ 已完成（三级压缩 + 系统记忆注入）
5. ~~**`@harness/provider-openai`**~~ — ✅ 已完成
6. ~~**会话管理增强**~~ — ✅ 已完成（标题生成 + 关键词搜索 + Markdown 导出）
7. ~~**插件化 CLI 扩展**~~ — ✅ 已完成（cli.commands / cli.command Hook）
8. ~~**MCP Client 插件**~~ — ✅ 已完成（stdio + HTTP/SSE transport + resources/prompts + Bearer 鉴权）

#### 剩余待办

| 优先级 | 能力 | 说明 | 状态 |
|---|---|---|---|
| **P2** | ~~Subagent 实时进度推送（Bus 事件）~~ | ~~子 Agent 执行过程中通过 Bus 发布进度事件（工具调用开始/结束、中间文本），父 Agent / CLI 可订阅展示~~ ✅ 完成（08-23，3 个事件：started/completed/failed + 10 个单元测试） | ✅ |
| **P2** | ~~Subagent 工具调用摘要~~ | ~~子 Agent 内部工具调用链过长时生成摘要后返回父 Agent，避免上下文膨胀~~ ✅ 完成（08-23，summarizeResult + 8 个单元测试） | ✅ |
| **P2** | 基于 caller.permission 过滤 Agent | 根据调用者（父 Agent / 用户）的权限动态过滤可用子 Agent 列表，权限不足的子 Agent 不在 `/subagents` 列出 | 待做 |
| **P2** | 配置文件加载 Agent | 从配置文件（如 `.harness/agents.yaml` 或 `harness.config.ts`）加载 Agent 定义，支持运行时动态注册子 Agent | 待做 |
| **P2** | Skill Layer | Markdown 技能 + paths 条件触发 + 三来源发现（bundled/user/project） | 待做 |
| ~~**P2**~~ | ~~Provider 补全~~ | ~~Gemini / 通义 / 智谱 等多模型适配~~ ✅ 完成（08-23，Gemini 独立实现 + Qwen/GLM 复用 OpenAIChatProvider） | ✅ |
| **P3** | Subagent run_in_background | 子 Agent 后台异步执行，父 Agent 不阻塞等待，通过 Bus 事件或轮询获取结果 | 待做 |
| **P3** | Subagent git worktree 隔离 | 子 Agent 在独立 git worktree 中执行，避免与父 Agent 工作区冲突 | 待做 |
| **P3** | Swarm teammate | Team + Mailbox + Task List + 权限桥接（多 Agent 协作） | 待做 |
| **P3** | ~~TUI 形态~~ | ~~基于终端 UI 的富交互（类似 Claude Code TUI）~~ ✅ 完成（08-26，自研 ANSI alt-screen：`--tui` + 日志滚动 + 输入行 + 21 测试） | ✅ |
| **P3** | OAuth2 PKCE | 完整 OAuth2 授权码流程（回调服务器 + token 刷新），用于对接 OAuth2-protected MCP Server | 待做 |
