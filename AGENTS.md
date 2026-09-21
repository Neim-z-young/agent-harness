# Agent 项目规范（agent-harness）

本项目是一个基于 **TypeScript + Bun** 的插件化 Agent Harness 框架（monorepo）。本文件供 AI Agent 在开发时遵循，避免偏离既有约定。

## 1. 仓库结构与命名

- Monorepo，工作空间：`packages/*` 与 `packages/plugins/*`（见根 `package.json` 的 `workspaces`）

- 核心模块命名 `@harness/[module-name]`；插件模块放在 `packages/plugins/[name]`，命名 `@harness/[name]`

- 每个模块必须包含：

  - `src/index.ts`（公共 API 通过 `index.ts` 以清晰接口导出）

  - `src/index.test.ts`（单元测试，尽量覆盖完整）

  - `package.json`、`tsconfig.json`（extends 根 `tsconfig.json`，`outDir: ./dist`，`include: ["src"]`）

- 新包必须同步在根 `tsconfig.json` 的 `paths` 与相关 `package.json` 的 `dependencies` 注册，然后 `bun install`

## 2. 运行命令（本机 bun 在 `/opt/homebrew/bin/bun`）

- 安装依赖：`bun install`

- 单包测试：`cd packages/<pkg> && bun test`

- 单包类型检查：`cd packages/<pkg> && bun run typecheck`

- 全量类型检查：`bun run typecheck`

- 全量测试：`bun test`（或 `bun --filter=* run test`）

- TypeScript 严格模式（`strict: true`）、`target ESNext`、`moduleResolution: bundler`

> 注意：本机 shell `PATH` 异常，运行 bun/git 建议用绝对路径 `/opt/homebrew/bin/bun`、`/usr/bin/git`。

## 3. 分层与依赖方向

开发按依赖顺序推进：**bus → tool → plugin → core → cli/插件包**。

- `@harness/bus`：事件总线

- `@harness/tool`：工具（Tool/ToolResult/Schema/ToolContext）基座，`defineTool`

- `@harness/plugin`：插件体系（`AgentPlugin`、`Hooks`、`PluginManager`）

- `@harness/core`：`createHarness` / `Harness`，组装 agent/session/tool/permission/skill

- 插件包：provider-\* / tools-\* / mcp-client / mcp-server-registry / computer-use 等

## 4. 硬性约束

- **插件化设计**：本项目是插件化项目，所有功能都应以插件形式实现，可插拔、可独立装卸，**不与项目本身（core/CLI 主逻辑）耦合在一起**；core 只提供生命周期、钩子与扩展机制，业务能力一律通过插件注入（如工具、Provider、MCP server、技能）

- `reference/` 目录必须从 Git 排除（不可入库）

- GitHub 仓库必须为 **private**

- 架构/开发文档放在 `docs/`（`agent-harness-architecture.md`、`development-log.md`）

- Agent 与会话消费需要加载的技能/插件目录须支持两级：user（`~/.harness/...`）与 project（`.harness/...`，项目级覆盖用户级）

- MCP server 相关新增插件一律依赖 `@harness/mcp-server-registry` 启动并复用 `@harness/mcp-client` 连接，**不要集成进 core**

- Agent 插件类型不做硬编码，使用注册表/机制（如 `ProviderTypeRegistry`）；Provider 插件 id 由 `providerId` 派生（`provider.{providerId}`），避免同一类型多实例冲突

- 插件与技能均须支持管理（enable / disable / reload），技能标注来源（内置/用户/项目/MCP/插件）

- Provider 配置 API key 支持三种格式：明文、环境变量引用 `${ENV_VAR}`、AES-256-GCM 加密值 `enc:v1:`

- 模型配置来源优先级：**CLI > config.json > 环境变量**

- 权限走「check → ask」两步判定：`resolvePermission` 统一入口，仅 `ask` 时调用引擎 `ask()`；工具执行统一走 `safeExecuteTool` 兜底，把异常归一化为失败 `ToolResult` 反馈给 LLM 而不是中断 agent 流；`ask()` 之前会触发 `core.permission.check`（插件可改写决策，也是"等待用户决策"类上报的唯一入口）

- **Hook 命名规范：`层.域.动作`**（如 `core.tool.pre.execute`、`cli.agent.stream`）。首段锁定**触发层**：`core.` = 引擎层（任何宿主都有：CLI / 库内嵌 / ACP 宿主），`cli.` = CLI 宿主层（只有走 CLI 的宿主才有）。判层判据：**"没有 UI 的宿主里这条还会触发吗？"**。新增 hook 必须二选一，不得只写域（历史事故：`agent.stream` 由 CLI 触发，引擎终态曾塞进同一个名字 ⇒ 消费方分不清来源、按轮计数翻倍）。与总线事件（`harness.started` / `tool.enabled`…）是两套命名空间：事件走 `core.bus` 发布订阅，hook 走 `plugin.trigger`；方法名不受约束（`harness.start()` 是方法，hook 是 `core.harness.start`）

- 宿主需要按序取用 hook 回调时用 `PluginManager.listHooks(name)`（公开只读），**不要** `(plugin as any).hooks.listFor(...)` 去摸私有字段

- `doom-loop` 重复调用守卫是**硬中断，不经权限引擎**（同一工具+同一入参连续 3 次，或连续 3 步整步签名相同）：它是"已经在空转"的资源保护，不是"能不能执行"的权限问题。曾走 `permission.ask()` ⇒ 被 `--permission allow-all`（或已记住的 allow 规则）完全架空（实测 25 步空转 21 秒零拦截）。命中即记 `code: 'DOOM_LOOP'` 的失败 ToolResult 并终止本轮，不再续轮。另：该守卫**不挂 `core.permission.check` hook**——它不走权限路径了，且放行后工具仍会走 pipeline，挂 hook 会让消费方双报

- 权限拒绝判定用错误名 `err.name === 'ToolPermissionDeniedError'`，避免依赖类绑定

- CLI 权限引擎（`CliPermissionEngine`）持久化规则到 `dataDir/permissions.json`，交互模式 `allow-all | ask | deny-all`，提供 `/permission` 命令

- `/tools` 工具管理命令由插件 `@harness/tools-manager` 提供（`cli.command` hook）：Agent 白名单启停经 cli 注入的 `setAgentTools` 持久化到 config.json 的 `agents[].tools`，`--global` 启停走运行时 `harness.tools`，本地缓存被卸载 Tool 以便恢复

- 插件要持久化 config.json 时不直接自持读写，优先经 cli 注入的 `setAgentTools` / `CliCommandInput` 扩展字段（`agentId`/`harness`），保持解耦

- 内置插件/工具采用**多级加载**：L1 静态元信息（`tools-builtin/src/meta.ts` 的 `BUILTIN_TOOL_META`、`tools-search/glob/web/media` 各自的 `meta.ts`，纯数据、不 import 各自 index.ts）经 `@harness/tools-builtin/meta` 等 `./meta` 子路径提前登记到 cli 的 `BuiltinToolRegistry`（`getBuiltinToolRegistry()` 一次性 `registerAll` 覆盖全部随应用打包工具插件）；L2 运行时模块仍经 `BuiltinPluginRegistry.load()` 惰性/后台加载。`CliCommandInput` 注入 `toolMeta?: ToolMetaLookup`，工具管理命令据此在运行时未加载时也能展示描述/别名/安全声明/权限键，并输出 `ID | 元信息(描述) | 权限键 | 状态`（状态=启用/禁用·已加载/仅元信息·安全声明）对齐表格；boot 末尾 `scheduleBuiltinPreload()` 后台静默预加载（fire-and-forget，`Promise.allSettled`，失败仅 `[WARN]`，`backgroundPreload:false` 可关闭）

- bash 工具走沙箱工厂 `createBashTool(config)`：危险命令检测（前置硬性拒绝、回退也不可豁免）/ cwd 限制 / 命令白名单 / env 隔离；`fallbackToHost` 开启时非破坏性命令沙箱失败可提升宿主 bash 重跑并标 `viaHost`，回退前经权限确认（`requireHostApproval`，复用 bash key，pattern 前缀 `host:`，ask 模式下再次询问）

- bash 工具 `ok` 语义：执行成功即 `ok:true`，命令结果由 `exitCode` 反映；仅 spawn 失败/AbortSignal 中断时 `ok:false`

- 工作区两级目录：user `~/.harness` 与 project `<cwd>/.harness`，project 覆盖 user；`dataDir = args.dataDir ?? ~/.harness` 承载 `config.json`/`permissions.json`/`sessions/`/`.config-key`/快照数据

- 文档索引：架构 `docs/agent-harness-architecture.md`、开发日志 `docs/development-log.md`、工作区模块 `docs/workspace-management.md`、代码情报插件规划 `docs/codeintel-plugin.md`、MCP 服务使用 `docs/mcp-services.md`、ACP 压缩配置参考 `docs/acp-context-config.md`

## 5. 工程约定

- 自定义错误类定义在各模块（`*Error`），不抛裸字符串

- 工具拆分：内置原语（文件读写 + Shell，`tools-builtin`/`tools-search`）与场景化业务插件分离

- 插件采用统一模式：自包含 helper + `createXxxPlugin` 工厂 + `core.tool.pool.assemble` Hook 注入；一个插件模块可同时导出 AgentPlugin（`default`/`plugin`/`plugins`）与 Provider 类型工厂（`providerTypeFactory`/`providerType`+`createProviderPlugin`）

- 插件注册技能：在 `core.harness.init` hook 里用 `harness.skillManager.register(skill)`，`loadedFrom: 'plugin'`

- TUI 使用 OpenTUI（@opentui/core + @opentui/react），保留会话内核 `createProcessLine`，仅替换渲染层

- 会话压缩阈值基于模型上下文窗口百分比动态计算（默认保留 30000 token 后窗口的 80%）

- **工具必须带参数 JSON schema**：`withJsonSchema(schema, {...})`（或 MCP 服务端 inputSchema 透传）——这是 provider 生成 tools 载荷时模型认识参数的**唯一**渠道（openai/anthropic/gemini 都读 `inputSchema.__jsonSchema`），缺失即退化为空对象 schema，模型只能空参瞎猜并原地空转（实测 25 步）。新工具不写 schema 视为缺陷

- **schema 声明必填 ≠ 运行时校验**：schema 只影响模型"看不看得懂"，缺参的保护必须在工具 `call` 入口自己做。反例（真机会话实测）：`bash {}` 被送进 shell 得到 `bash: undefined: command not found`；`task_create {}` 在 `sanitizeName` 里抛 `name.trim` 的 TypeError；`task_list {}` 静默返回 `[]`（无法与"真的没任务"区分）。凡必填参数一律在入口挡下并返回 `{ ok:false, error:{ code:'XXX_REQUIRED' } }` 形式的结构化错误

- **文件工具的边界语义（刻意不对称，别再摇摆）**：`read_file` / `write_file` / `edit_file` 只在**工作目录内**工作（`PATH_OUTSIDE_CWD`），这是"防误触 + 防越权写"的作用域约定；`bash` **不做读取面限制**（它的 cwd 受限、危险命令有黑名单，但读什么路径不拦）——bash 本就被权限系统与危险模式单独把关。真机实测过模型会绕过：read_file 被拒后立刻改用 `bash cat <绝对路径>` 读同一文件（3 次里成功 2 次）。这是**已知且接受**的行为，不要在提示词里引导"用 bash 绕过"，也不要把 read_file 的拒绝文案写成绕过指引；若将来要把 cwd 变成硬安全边界，须同时收紧 bash 的读取面（属架构级改动，需先拍板）

- 与外部工具/服务对接协议时（herdr 这类终端/服务集成）**以真机为准**：官方文档没写清的边界必须实测确认后再实现。已知的三个坑都在文档之外且**静默失效**（读代码看不出来）：① 上报用过 `--seq` 后，`release-agent` 也必须带一个更高的 `--seq`，否则被 Herdr 当旧序号丢弃；② 序号水位线按 (pane, source) 存、**跨进程不重置**，新进程从 1 起算的前 N 条上报会被静默丢弃（故序号基线取微秒级时钟）；③ `process.once('exit')` **覆盖不到信号退出**（SIGTERM/SIGHUP 直接终止进程，而"关 pane"就是 SIGHUP），信号类退出必须单独挂监听，且不能抢 SIGINT（REPL/TUI 用它表示"中断当前查询"）。详见 `docs/development-log.md` 续 158

## 6. 安全与协作

- 子代理工具调用 `isConcurrencySafe` 必须为 `false`，防止并发写冲突

- 后台任务完成自动以 `<task-notification>` user-role 注入父会话

- `.harness` 目录统一为 `plugins`（多种插件类型都放这里）、`agents`、`skills`

## 7. 提交流程

- **每次工作结束自动 git 提交**（用户要求）

- 提交信息风格：`feat(scope): 中文描述`，多用 heredoc 构造多行 message

- 不要 `git add -A`，按文件名精确暂存；不上传 `.env` 等敏感文件

## 8. 沟通

- 与用户沟通使用中文

- 交付后更新 `docs/development-log.md`（按"续 N"编号）与相关架构文档

