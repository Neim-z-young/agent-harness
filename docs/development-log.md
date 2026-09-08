# Agent Harness 开发日志

## 2026-09-09（续 89）TUI /tree 语义修正：磁盘真实文件树 + 对话引用 * 标记

### 问题

用户运行 `/tree` 发现输出与磁盘不一致：`~/.harness/` 打印了 `permissions.json`（对话提到过但磁盘不存在），而磁盘上真实存在的 `sessions/` 却没打印。根因：上一版 `/tree` 打印的是「对话引用树」（从对话文本捕捉路径），非磁盘真实结构。

### 决策

`/tree` 语义改为**磁盘真实文件树**，同时兼顾对话上下文：**对话中引用过的文件在树上以 `*` 标记**（两者结合）。交互式目录树仍留给图形页面。

### 改动（tui.tsx）

- 删除引用树纯函数 `buildFileRefTree`（语义废弃），新增 `buildDiskFileTree(root, refs, opts?)`：`readdirSync(withFileTypes)` 递归扫描，目录在前、同级字母序，排除 `.git`/`node_modules`/`.DS_Store`，`maxDepth`（默认 3）与 `maxNodes`（默认 100，超出置 truncated）；引用标记双基准解析（`resolveEditPath` cwd/~ 基准 + `resolve(root, base)` 相对 root 基准），文件 absPath 命中即 `marked`。
- `renderFileRefTree`：`marked` 文件带 `*`，目录带 `/`，根无分支线。
- `/tree [path]`：无参默认 `process.cwd()`，有参经 `resolveEditPath`（支持 `~`）；`statSync` 校验目录，非目录提示「目录不存在」；输出 `文件树（<root>）：` + 树 + 有标记时 `* = 对话中引用过的文件` 图例。不入历史栈、不进会话内核。

### 验证

- 新增用例：`buildDiskFileTree`（排序/排除/标记/深度/截断）、`renderFileRefTree`（`*` 渲染）、`/tree <dir>` 端到端（`a.ts*` 标记 + 图例 + 输入框清空）、目录不存在提示。
- `bun run typecheck` 通过；`bun test` 185 全绿，无回归。

## 2026-09-09（续 88）TUI 新增 /tree 命令打印文件引用目录树（交互树留给图形页面）

### 背景与决策

用户评估后调整方向：**交互式目录树（多根浏览、展开/折叠）不在 TUI 实现，留给图形页面**；TUI 侧栏维持扁平引用列表现状，仅新增 `/tree` 斜杠命令，把对话中已出现的文件引用汇总为「根 → 目录 → 文件」树打印到聊天区。调研（opencode 无侧栏树、Claude Code 为真实磁盘扫描树）确认「汇总已出现引用」是本项目独特能力。

### 改动

- **`tui.tsx`**：
  - 新增纯函数 `buildFileRefTree(refs, opts?)`：根自动推断（cwd→`./` 优先、主目录→`~/`、其余→`其他`，空根剪掉）；目录按相对根的路径逐级建立、`Map` 合并共享父目录；同文件（去 `:行[:列]`）去重保留首个行号；`cwd/home` 可注入便于测试。
  - 新增 `renderFileRefTree(tree)`：根不带分支线，目录带 `/`、文件带 `:行号`，`├─/└─/│` 分支线缩进。
  - `/tree` 命令（submit 拦截，仿 `/history`）：`collectFileReferences(prev, MAX_SAFE_INTEGER)` 全量收集（不受侧栏 8 条上限约束）→ 建树 → system 块打印；无引用提示「（暂无文件引用）」；不入历史栈、不进会话内核。
  - 命令菜单候选追加 `/tree`。
- **`index.ts`**：`REPL_COMMANDS` 追加 `/tree`。

### 验证

- 新增用例：`buildFileRefTree`（多根推断/空根剪除/共享父目录合并/同文件去重/空引用）、`renderFileRefTree`（精确树形文本）、`/tree` 端到端（mock 回复含引用 → 打印树 + 输入框清空；无引用空态）。
- `bun run typecheck` 通过；`bun test` 185 全绿，无回归。

## 2026-09-07（续 83）MCP 工具归属索引统一解析 + 代码注册 server 会话内启停

> 两件事：①把 tools-manager / mcp-server-registry 的 MCP 前缀反解统一到 `@harness/tool` 的 `parseMcpToolId` 语义之上，并用内存缓存的「server → 工具集」映射修正 server 名含 `__` 时的退化；②修复 `/mcp disable code-intel`（代码注册 server）无法禁用的问题。

### 改动

- **`@harness/tool`**：新增 `McpToolIndex`（内存索引：`server` → 完整工具 id 集，含 `index/unindex/serverOf/has/servers/entries`）与模块单例 `globalMcpToolIndex`；新增 `resolveMcpTool(id, index?)` —— 优先用索引精确反解（server 名可含 `__`），未登记时回退 `parseMcpToolId` 启发式切分。索引放在叶节点 `@harness/tool`，装配方与反解方共享同一实例，不引入新包依赖、不影响软件加载。
- **`mcp-server-registry`**：生成工具（`makeRuntime` / 新抽出的 `connectCodeServer`）时登记 `globalMcpToolIndex`，断开（`disconnectServer`）与 `uninstall` 反注册；`harness.start` 代码注册循环复用 `connectCodeServer`。
- **`mcp-server-registry` `/mcp` 命令**：`enable/disable <s>` 不再只允许托管 server —— 对代码注册 server（`reg.has` 命中）做**会话内启停**（无法落盘 config.json，重启后恢复连接）：disable 断开 client + `disabledCode` 标记 + assemble 跳过其工具；enable 经 `connectCodeServer` 重连。`serverList` 对代码注册项展示 `[启用]`/`[会话禁用]` 与连接态。**兼容嵌套写法** `/mcp servers enable|disable <s>`（把动作提升为主子命令归一化处理）。
- **`tools-manager`**：删除本地 `parseMcpTool`（首个 `__` 切分），改经 `mcpToolOf = (id) => resolveMcpTool(id, globalMcpToolIndex)`，server 名含 `__` 时归属/掩码写入总是精确。

### 验证

- tool 50 / mcp-server-registry 10 / tools-manager 13 / cli 169 用例全绿；全量 30 包 typecheck 通过。
- 新增用例：`McpToolIndex`+`resolveMcpTool`（server 含 `__` 精确反解、未登记回退、unindex、幂等重登记）、代码注册 server `/mcp disable/enable` 会话内往返（禁用后 assemble 空、启用后工具恢复）。

## 2026-09-08（续 87）修复 ↑/↓ 历史回看被命令菜单劫持 + 新增 /history

### 现象

上键只能回看一条历史命令：回看出的历史若以 `/` 开头（如 `/stats`、`/mcp ...`），会同时命中 `/` 命令菜单，第二次 ↑ 被命令菜单的「选候选」逻辑接管，历史不再继续回看。

### 根因

命令菜单与输入历史共用 ↑/↓ 且命令菜单分支在前：command menu 仅当输入以 `/` 开头且有候选时开启。回看产出的 `/` 前缀历史恰好满足 → 下一次 ↑ 落入菜单导航而不是历史。

### 改动（tui.tsx）

- ↑/↓ 处理重排为统一优先级：**正在回看（histIdx>=0）→ ↑/↓ 继续回看，不被命令菜单劫持**；否则命令菜单开启 → ↑/↓ 选候选；否则 → ↑ 开始回看。删除原冗余的 `!cmdMenuOpen && history` 旧分支。
- 新增 `/history` 命令（TUI 内拦截 submit，不进会话内核）：聊天区渲染 assistant 块展示输入历史（编号列表），不入历史栈、不触发外部处理。引入 `historyRef` 镜像，供依赖 `[]` 的 submit 闭包同步读取。

### 验证

新增 TUI 用例：连续 ↑ 遍历 `/stats` 与其前一条普通消息（不被菜单劫持）；`/history` 输出后又以 `❯` 回落。TUI 73 全绿、全量 typecheck 通过。

## 2026-09-08（续 86）修复 TUI Tab 补全/历史回看后光标跳回开头

### 现象与根因

Tab 补全命令、↑ 回看历史等场景后，输入框光标有时「回到开头」——后续键入被**前置**到命令开头（如 `/resume <sid>` 变成 `<sid>/resume`），多行缓冲时更明显。

根因：`setComposer` 底层走 `textarea.setText()`（Rust `editBufferSetText`），该调用会**完全重置缓冲状态并把插入点放回 (0,0)**，而此前代码没有在写回后重新定位光标。

### 改动

`tui.tsx` 的 `setComposer` 在 `setText` 后追加 `textareaRef.current?.gotoBufferEnd()`，把光标重新定位到文本末尾，恢复「补全/回看后继续在行尾键入」的直觉。该路径覆盖：Tab 补全、Esc 关闭命令菜单、历史回看（↑/↓）、提交后的清空。

### 验证

TUI 测试 71 pass（含输入历史导航、命令菜单、文件引用导航等），无回归。

## 2026-09-08（续 85）/plugins 装卸与 MCP server 联动 + 文档对齐

### 问题

1. `/plugins disable code-intel` 后 `/plugins` 列表里看不到该插件 → 用户无法重新启用（list 只显示已加载插件）。
2. 禁用插件后其注册的 MCP server 不断开、`mcp__code-intel__*` 工具不收敛 → 仍可被调用。
3. `docs/mcp-services.md` 遗留工作区未提交改动，把已废弃的 `/mcp tool` 子命令写回（倒退），与当前架构矛盾。

### 改动

- **manage-plugin**：list 合并「已加载」+「已登记未加载」（CLI 注入 `availablePlugins`，来自 `app.pluginRegistry`）——禁用后插件仍显示并标注 `[可管理·已禁用]`，可直接 `/plugins enable` 恢复。
- **mcp-server-registry**：`McpServerRegistration` 增加可选 `source`（来源插件 id）；插件维护 `serverSource: Map<server, 插件id>`；订阅 `plugin.unloaded` → 断开该插件注册的 server + 记入 `downTools`（assemble 收敛工具）+ 发 `mcpServerDisabled`；订阅 `plugin.loaded` → 重连并恢复装配（清 `downTools`）+ 发 `mcpServerEnabled`。
- **code-intel**：`registerMcpServer` 携带 `source: 'code-intel'`。
- **docs/mcp-services.md**：去掉 `/mcp tool` 残留；命令列表补 `/mcp servers enable|disable <s>` 嵌套写法；明确工具级启停统一走 `/tools`；补「随插件装卸」运行时机制（`source` 关联、卸载断开/重载重连）。

### 验证

- manage-plugin 8 / mcp-server-registry 11 / code-intel 73 / cli 169 全绿；全量 30 包 typecheck 通过。
- 新增用例：list 显示已禁用插件并可恢复；插件卸载 → 工具从池收敛、重载 → 重连恢复。

## 2026-09-07（续 84）修复 `/mcp disable` 后工具仍显示「启用」且残留可调用

`/tools` 状态矛盾（`启用·…·server已禁用`）的根因：禁用/移除 server 只跳过 `tool.pool.assemble` 的「新增」，而运行时 `ToolRegistry` 早已在启动时登记过这些工具；`DefaultToolPool.add` 只增不减，导致旧工具残留下线、仍可被 LLM 调用、`/tools` 仍判为「启用」。

### 改动

- **mcp-server-registry**：禁用标记 `disabledCode:Set` 升级为 `downTools:Map<server, string[]>`（server → 待移除工具 id）。`tool.pool.assemble` 先按 `downTools` 用 `pool.remove` 收敛注册表、再装配启用 server 的工具；`enable`/`disable`/`remove` 在断开前捕获该 server 的工具 id 记入 `downTools`，供下一次 assemble 移除。这样禁用/移除在运行时真正生效，而非仅「不再加入」。
- **CLI**：新增 `attachMcpReassemble(harness)`，订阅 `mcp.server.disabled/enabled/added/removed` 事件 → `harness.assembleTools()`，让禁用即时收敛（REPL 生命周期挂载/退订）。否则事件只是通知、注册表不会自动重组。
- **tools-manager**：`renderToolTable` 对来源 server 已禁用的 MCP 工具，把状态前缀 `启用` 改写为 `禁用`，消除与白名单判定的矛盾（作为残留期的显示安全网）。

### 验证

- mcp-server-registry 复用同一 pool 断言禁用后工具确实被移除、启用后恢复；tools-manager 13、cli 169、core/tool 等全绿；全量 30 包 typecheck 通过。

## 2026-09-07（续 82）Agent 级 MCP 配置能力（server 粒度白名单/黑名单）

> 让 Agent 在声明式配置里按 **MCP server 粒度** 控制可用 MCP，而不必在 `tools` 白名单里逐个列 `mcp__<server>__<tool>`。设计文档见 `.trae/documents/agent-mcp-config.md`。

### 改动

- **`@harness/tool`**：新增 `parseMcpToolId`（解析 `mcp__<server>__<tool>`，server 取首个 `__` 之前）与 `filterMcpTools`（按 server 白名单/黑名单对工具集收窄；白名单优先于黑名单、缺省透传、非 MCP 工具恒保留、server 名 trim）。作为 filterByWhitelist 之后的第二阶段。
- **`@harness/agent`**：`AgentDefinition` 新增可选 `mcpServers?`/`excludeMcpServers?`；`agentFromMarkdown` 增加 `parseStringArr` 支持内联数组/块级列表/裸逗号字符串；显式 `[]` 表示拒绝全部 MCP。
- **`@harness/core`**：`query` 与 `queryStream`(`_prepareQuery`) 两处统一接入 `filterMcpTools`，server 粒度过滤参与 allowedTools 组装，只影响模型可见/可调用工具集，不改 `/tools`/`/mcp` 命令语法。
- **`packages/cli`**：`cfg.agents[]` 类型扩为含 mcp 三字段；`applyConfigAgentTools` 更名为 `applyConfigAgentOverrides` 并合并三字段；修复 `setAgentTools` 整条覆盖会静默丢弃手写 mcp 声明的坑（保留原 entry mcp 字段）。
- **文档**：架构文档 agent 能力白名单补充 MCP server 粒度声明说明。

### 验证

- tool 44 / agent 27 / core 35 / cli 169 用例全绿；全量 typecheck 通过。
- 覆盖：parseMcpToolId（含 server 含 `__`）、filterMcpTools 全分支（缺省/白名单/空数组/黑名单/白优先黑/非 MCP/trim）、frontmatter 三种写法、config.json 合并与 setAgentTools mcp 字段保留、core 装配接线不破坏执行 + 缺省向后兼容。

## 2026-09-07（续 81）命令单一职责 + 事件跨层解耦

> 承接「MCP Server 配置化管理」。落实插件/服务/工具三类命令的单一职责，并以事件总线解耦上层命令对下层的副作用。设计文档见 `.trae/documents/command-srp-event-decoupling.md`。

### 改动

- **`@harness/core`**：导出 `LifecycleEvents` 事件常量（`plugin.*` / `mcp.*` / `tool.*`），供跨插件的类型安全发布/订阅。
- **新增 `@harness/manage-plugin`（`/plugins`）**：独立插件包负责插件生命周期（查看 / 启用 / 禁用 / 重载），成功时发布 `plugin.loaded/unloaded/updated`。从 `HarnessApp` 移除 `disablePlugin/enablePlugin/reloadPlugin`，改为注入 `manageablePlugin` / `pluginManageable` 能力。
- **`mcp-server-registry`（`/mcp`）**：删掉 `tool` 子命令，只管理 server 生命周期；`enable/disable/add/remove` 发布 `mcp.*` 事件；并在 `install` 订阅 `plugin.unloaded`，宿主插件卸载时自检清理孤儿 runtime。
- **`tools-manager`（`/tools`）**：统一工具启停唯一入口，支持 `mcp__<server>__<tool>` 前缀把掩码写入 `mcpServers[].tools`；发布 `tool.*` 事件；订阅 `mcp.server.disabled` 刷新清单、订阅 `plugin.*` 状态同步。
- **`packages/cli/src/index.ts`**：插件分发时 `arg` 由「仅第二个 token」修正为「命令名之外的完整剩余内容」（此前 `line.split(/\s+/,2)` 截断导致 `/plugins disable <id>`、`/mcp <sub> <json>` 等参数丢失）。
- **修复 `manage-plugin`**：`out(...) + '\n'` 因优先级错误生成 `undefined\n` 被丢弃，改为 `out(msg + '\n')`。

### 验证

- manage-plugin 7 用例、mcp-server-registry 9 用例、tools-manager 13 用例、code-intel 12 用例、mcp-client 55 用例、subagent 109 用例、cli 96 用例全绿；全量 30 包 typecheck 通过。
- 顺带修正 `cli.test.ts` 幂等往返用例：原测试用全新 app 二次 boot（boot 时 mock provider 已默认加载）导致 enable 永远命中「已是启用状态」，改为同一 app 内 disable→enable→重复 enable 验证「禁用后恢复 + 幂等」。

## 2026-09-07（续 80）MCP 服务文档 + /help 展示插件命令 usage

> 承接「MCP Server 配置化管理」。补齐 MCP 服务使用文档，并修复 `/help` 只打印插件命令 `description`、忽略注入的 `usage` 的问题。

### 改动

- **新增 `docs/mcp-services.md`**：MCP 服务使用文档——代码注册 vs config.json 托管两种装配方式、`McpServerEntry` 字段表、`/mcp` 命令全量用法（含 `enable/disable/tool/add/remove`）、运行时机制（`mcp.configure` 注入 → start 按 enabled 连接 → assemble 工具级过滤 → `setMcpServers` 持久化）、凭证安全（明文/`${ENV}`/`enc:v1:`/OAuth）、相关文档索引。
- **AGENTS.md**：文档索引补充 `docs/mcp-services.md`。
- **`packages/cli/src/index.ts` `/help`**：插件命令列表在 `/${command} + description` 后，若插件注册了 `usage` 则追加一行 `用法：<usage>`（如 `/mcp`、`/subagents`、`/worktrees`、`/tasks`、`/workspace` 等均受益）。

### 验证

- cli 96 用例全绿；全量 17 包 typecheck 通过。

## 2026-09-06（续 79）MCP Server 配置化管理：config.json 装配 + 服务器/工具两级启停

> 承接待办「OAuth2 PKCE / MCP OAuth 授权」之外的方向。此前 MCP Server 只能经 `.harness/plugins/mcp.ts` 代码显式装配，无法从配置文件新增外部 server，也没有运行时启停；`/plugins` 只管理整插件粒度、`/mcp` 只读展示。本交付：从 `config.json` 以 JSON 新增 MCP server（stdio/sse/http），并支持**服务器 + 工具两级**启用/禁用、**即时生效（免重启）**，状态持久化回 `config.json`。

### 配置模型

`HarnessConfig.mcpServers: McpServerEntry[]`；`McpServerEntry` 复用 `@harness/mcp-client` 的 `McpServerConfig` 字段 + `enabled`（服务器级）、`tools`（工具级，`{ 工具名: false }` 停用单个工具）。

```json
{ "mcpServers": [{ "name": "github", "transport": "stdio", "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } },
  { "name": "notes", "url": "...", "auth": { "bearerToken": "enc:v1:..." }, "tools": { "notes_search": false } }] }
```

### 改动清单

- **`packages/plugins/mcp-server-registry`（v0.2.0）**：
  - 新增 `McpServerEntry` / `McpCliStore` 类型导出；工厂内新增托管配置态 `managed: Map<name, ManagedEntry>`（含 server `enabled` + 工具级 `tools`）。
  - 新增自定义 Hook **`mcp.configure`**：注入 config.json 的 `mcpServers` 替换托管列表（仅配置态，start 时按 `enabled` 连接）。
  - `harness.start`：代码注册 server 照旧连接；托管条目只连接 `enabled` 的。
  - `tool.pool.assemble`：先按 server `enabled`（未连接自然不在 runtimes），再按工具 base 名过滤 `tools[name]===false`；每 query 组装 → 工具级即时生效。
  - `/mcp` 命令扩展：`servers`（含启停状态）/ `tools`（含工具级状态）/ `enable|disable <s>`（即时连接/断开）/ `tool <s> <t> on|off` / `add <json>` / `remove <s>`；每次变更经注入的 `setMcpServers` 持久化。
- **`packages/cli`**：`HarnessConfig` 加 `mcpServers?`；新增 `getMcpServers` / `setMcpServers`（configStore 读写）+ `applyMcpServers`（createHarness 后、start 前触发 `mcp.configure`）；`CliCommandInput` 注入 `mcpServers` / `setMcpServers`（对齐 `setAgentTools` 模式）；新增 `@harness/mcp-server-registry` 依赖。
- **配置装配**：`.harness/plugins/mcp.ts` 无需改动（配置经 `mcp.configure` Hook 注入）。

### 测试

- registry 包 8 用例（新增 4：configure 注入态展示 / 工具级启停持久化 / 服务器级启停持久化 / add+remove 持久化）；cli 96 用例（新增 getMcpServers/setMcpServers + boot 注入）。全量 17 包 typecheck 通过。

### 后续

- `/mcp` CLI 全量管理已落地；界面（TUI/Web）添加及管理可复用 `mcp.configure` Hook + `McpCliStore.save` 数据接口，core 无需改动，另行排期。

## 2026-09-06（续 78）Subagent git worktree 隔离：子代理独立工作区免写冲突

> 承接待办「Subagent git worktree 隔离」。为避免多个子代理并发写操作与父工作区冲突，为每个子会话在独立 git worktree 中执行，并把相对基线 HEAD 的 diff 摘要 + patch 回传给父会话 / 注入后台通知。

### 机制

- 利用 `git worktree add --detach --force <dir> HEAD` 为每个子代理创建一个从当前 HEAD 派生的独立工作目录，落点 `<repo>/.harness/worktrees/<token>`。
- worktree 之间文件系统级隔离，子代理的写操作互不冲突，也与父工作区隔离。
- 子代理完成时用 `git -C <worktree> diff HEAD --stat` + `diff HEAD` 生成变更摘要；非零改动才回传摘要文本并写临时 `.patch` 文件（返回 `diffPath`）。后台路径随 `<task-notification>` 注入 `<diff-file>` 标记。
- 非 git 仓库 / worktree 创建失败自动降级：回退无隔离执行（`session.cwd` undefined、无 diff 摘要），不中断子代理。

### 改动清单

- **`packages/core/src/index.ts`**：`ToolContext` 构造（同步 L1317、流式 L1520 区域）支持会话级 `cwd` 优先——`sess?.cwd ?? this.deps.cwd`；`Harness` 接口与 `HarnessImpl` 新增只读 `cwd`（= `options.cwd ?? process.cwd()`），供子代理判 `git worktree` 用。
- **新增 `packages/plugins/subagent/src/worktree.ts`**：自包含 git worktree 模块——`runGit`（错误归一化为 `GitCommandError`）、`gitTopLevel` / `isGitRepo`、`worktreeDirFor`（清洗 token）、`ensureWorktreeIgnored`（幂等写 `.harness/.gitignore` 含 `worktrees/`）、`createWorktree`（幂等）、`getWorktreeDiff`、`removeWorktree`、`listWorktrees`（解析 `--porcelain`）。
- **`packages/plugins/subagent/src/index.ts`**：`HarnessLike` 加只读 `cwd?`；模块级状态 `baseCwd` / `worktreeEnabled`；`resolveWorktree`（复用已有 worktree / 新建）；`attachWorktreeDiff`（生成 diff 摘要 + 写临时 patch）；同步 / 后台路径接入；`/worktrees` 命令支持 `list` / `remove <token>` / `remove-all`。
- **测试**：`worktree.ts` 单测 12 用例（gitTopLevel / createWorktree 幂等 / listWorktrees / getWorktreeDiff / ensureWorktreeIgnored / removeWorktree / GitCommandError）；`index.test.ts` 新增 4 集成用例（git 仓库隔离 + 续接复用 + diff 回传、非 git 回退、后台通知含 diffPath、`/worktrees` 命令）。subagent 包 109 用例全绿，全量 typecheck 通过。

### 待办

- `.harness/.gitignore` 已含 `worktrees/`，worktree 目录不入库。
- 子代理 worktree 生命周期内置管理：续接复用同一 worktree，任务完成不自动删除，可由 `/worktrees remove` 回收。

## 2026-09-06（续 77）TUI/REPL 多行输入：readline 单行 → OpenTUI <textarea>

> 承接续 76 标注的「TUI/REPL 多行输入」方向。把 cli TUI 底部输入从单行 `<input>` 升级为 OpenTUI `<textarea>` 多行编辑器：Enter 插入换行、Meta/⌘+Enter 提交，同时保留命令菜单 / 输入历史 / 文件引用导航等既有交互，并验证粘贴多行文本被完整保留。

### 实现（`packages/cli/src/tui.tsx`）

* **组件替换**：底部 `<input value+onInput>`（受控单行）→ `<textarea ref+onSubmit>`（非受控多行）。`<textarea>` 无受控 value/onInput，故用 `textareaRef` 直接读写底层 `TextareaRenderable` 的 `plainText` / `setText`（`readComposer` / `setComposer`，用回调稳定引用，单实例无 remount，避免 buffer 损坏）；`submit` 改用 `setComposer('')` 清空。默认键位：`return`→newline、`return`+meta→submit，天然满足"Enter 换行 / Meta+Enter 提交"。
* **输入状态同步（关键）**：`input` state 仍被命令菜单过滤 / 历史回看 / 侧栏切换依赖，但 `<textarea>` 不再有受控 value 回写。OpenTUI 的 `InternalKeyHandler` 保证全局 `useKeyboard` 先于聚焦组件处理按键，故在全局 handler 末尾用 `queueMicrotask` 等聚焦 textarea 写入本次字符后再读 composer 回填 `input`，并把 `histIdx → -1` 退出回看态。
* **命令菜单 / 历史按键冲突**：`↑/↓/Tab/Esc/Enter` 在命令菜单与历史分支统一加 `key.preventDefault()`（只有它是真正阻止聚焦组件处理的开关；`useKeyboard` 的返回值不生效），阻止 textarea 把 Enter 误当换行；删除命令菜单末尾无效的 `return true` 吞键——否则键入字符会被截断无法收窄菜单，改为让其回落末尾微任务正常同步 `input`，命令过滤器随键入实时更新。Meta+Enter 在菜单打开时也放行（提交正文而非菜单项）。
* **HELP_LINES**：登记 Enter=输入框内换行 / ⌘/Meta+Enter=提交。

### 测试与验证

* `tui.test.tsx`：新增 `pressMetaEnter` 辅助（`pressEnter({ meta: true })`），既有「键入后提交」类用例统一升级为 Meta+Enter；新增 3 条：① 命令输入（`/stats`/`/exit`）改 Meta+Enter 提交命令文本（不依赖菜单时序）；② 命令菜单 `/` 前缀展开后普通 Enter 选中首个候选提交；③ 多行输入 Enter 换行不提交、Meta+Enter 提交整段；④ 粘贴换行文本（`pasteBracketedText`）保留并提交。tui.test.tsx 71 用例全过，cli 全量 166 通过，全仓 typecheck 通过。

### 后记修复：Ctrl-? 帮助面板乱码 / 对齐 / 换行异常

* 新增的提交键位行含特殊字符 `⌘`（U+2318），多数终端字体渲染为豆腐块乱码；且 `l.key.padEnd(18)` 按 JS 字符数对齐，遇 `↑ ↓ ◀ ▶` 等非 ASCII 箭头（渲染列宽≠字符数）时各 key 行 desc 起始列错位 → 换行/对齐不对。
* 修复：键位文案 `⌘ / Meta+Enter` → `Alt/Meta+Enter`（纯 ASCII，消除乱码）；帮助面板渲染由 `padEnd` 拼接改两列固定宽度布局（key 列 `width:20` + desc 列 `wrapMode:"word"`），desc 起始列不再受 key 字符宽度影响。tui 71 用例全过。

## 2026-09-06（续 76）开发方向核实：同步 3 处「已实现但文档未同步」留痕

> 盘点剩余开发方向时发现历史日志中有「已实现但文档仍标待办」的遗漏，经代码核验后在本期同步标注。均为文档留痕，不改业务代码。

### 核实结论

* **快照自动集成（原「后续待办」）——已实现**：cli 启动时把 `snapshotService` 注入 AgentRuntime 的 snapshot factory（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1305)）；core `AgentRuntimeImpl.captureForMessage()` 在 `query`/`queryStream` 主循环开始时 `capture()` 并把 `{ start, files }` 挂到 assistant 消息 `meta.snapshot`（[core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)），`core.test.ts` 已有单测覆盖。
* **基于 caller.permission 过滤子 Agent —— 已实现**：subagent `isAgentDenied` / `filterAccessibleAgents` 已接入 `/subagents` 命令，按父 Agent 权限隐藏不可用子 Agent。
* **配置文件加载 Agent —— 已实现**：core 经 `agentDirs`（user → project）多级目录加载 Agent 定义并支持同名覆盖（`core.test.ts` 覆盖）。
* 以上三处本期在本文件同步为「已完成」，并在下方「剩余待办」表格对应行补 ✅。

### 真正 still-open 的方向（本期不实现）

* **OAuth2 PKCE／MCP OAuth 授权**：mcp-client 当前仅支持 `bearerToken`/自定义 Authorization header，无授权码流程/PKCE/token 刷新。
* **TUI/REPL 多行输入**：CLI 走 readline 单行 `'line'` 事件，无多行输入组件。
* **Subagent git worktree 隔离**：子代理在独立 git worktree 中执行以避免与父会话写冲突，目前仅注释提及、未实现。

## 2026-09-06（续 75）code-intel：语义编辑方向决策（搁置多语言扩展，保留导航）

> 调研 Serena（oraios/serena，MIT，~24k stars）后定方向。Serena 是标准 MCP 分发、以 LSP（pyright/gopls/jdtls/rust-analyzer 等 40+ 语言服务器）驱动**真作用域/类型感知**的语义能力，工具集（`find_symbol` / `find_referencing_symbols` / `rename_symbol` / `replace_symbol_body` / `safe_delete`）与本项目 `code_symbols` / `code_reference` / `code_definition` / `code_semantic_edit` 目标重叠。

### 结论：停止扩展，保留导航

* 本项目语义编辑基于本地 AST（babel + tree-sitter），tree-sitter 无作用域绑定，rename 为**同名 token 弱语义**，精度天然弱于 LSP；继续扩展到 Kotlin/PHP 需为每语言固化 descriptor + 补测试，只为达成弱于 LSP 的效果，性价比低。
* code-intel 的差异化不在语义编辑精度，而在**零外部依赖、wasm 全内嵌、可单二进制部署**的轻量能力；重型语义编辑场景可由外部标准 MCP（如 Serena）按需接入，符合插件化定位。
* 已提交的 Java 语义编辑（续 72/73/74）保留为**离线兜底**能力，不回退。
* 本次会话未提交的多语言 LanguageEditDriver 重构（`languages.ts`、`core.ts`/`multi.ts`/`index.test.ts`/`package.json`/`bun.lock` 的 Kotlin/PHP 扩展及探针）已全部 `git restore` 回滚到 `af7bae4`，新增文件删除，工作区干净（code-intel 73 用例全绿，typecheck 通过）。

### 后续可选方向

* 需重型语义能力时，把 Serena 作为可选 MCP 外部 server 接入 harness（标准 MCP，cheap），不内置复刻。

## 2026-09-06（续 75）mcp-client：OAuth2 PKCE 授权码 + token 加密持久化

> 承接续 74。为 `@harness/mcp-client` 的 HTTP/SSE transport 增加 OAuth2 PKCE 授权码流程：端点 well-known 自动发现 / 显式配置，access 过期自动 refresh，token 用 `@harness/workspace` 的 `SecretCipher`（AES-256-GCM）加密持久化到 `dataDir/oauth-tokens.json`。授权码交互形态：打印授权 URL → 浏览器授权 → 把回调 URL（或其中 code）粘贴回 REPL（不做本地回调服务器）。

### 实现

* **`src/oauth.ts`**（新增，纯逻辑 + 交互注入）：`discoverOAuthMetadata`（RFC 8414 well-known）、`generatePkce`/`createPkceChallenge`（base64url(SHA256)，verifier 定长 43 无 padding）、`exchangeAuthorizationCode`、`refreshOAuthToken`（均 `fetchImpl` 可注入）、`buildAuthorizationUrl`；`class OAuthFlow` 对外只暴露 `ensureAccessToken({refresh?})`——命中缓存/磁盘直接返回 → 过期用 refresh_token 刷新 → 再否则交互授权，`pending` 并发去重；`readCode`/`log` 可注入（缺省读 stdin 一行）。
* **`src/token-store.ts`**（新增）：`OAuthTokenStore` 用 `SecretCipher` 加解密 token 落盘到 `dataDir/oauth-tokens.json`，每 server 一项 `{ enc: 'enc:v1:...' }`；`serverKey = base64url(sha256(baseUrl))` 稳定不可逆；`load/save/clear/hasStored`。解密失败（密钥不符/篡改）抛错，由 OAuthFlow 捕获回落重授权。
* **`src/index.ts`**（改）：`McpAuthConfig` 增 `oauth?: McpOauthConfig`；`buildAuthHeaders` 改 **async** 并接收 `oauthResolver`（oauth 存在优先取动态 token，回落静态 bearerToken）；`HttpTransport`/`SseTransport` 增 `oauthResolver` 构造注入；Http 401/403 **强制 refresh 后重试一次**，再失败抛错，非 oauth 的 401 直接抛错；新增 `TransportFactoryContext{ dataDir?; fetchImpl?; readCode?; log? }`，`defaultTransportFactory(config, ctx?)` 装配 OAuthFlow；`createMcpClientPlugin` 透传 `dataDir`。
* **`mcp-server-registry`**（改）：`registerMcpServer` 支持单项 `dataDir?`，`createMcpServerRegistryPlugin` 增 `options.dataDir` 缺省，`defaultTransportFactory(item.config, { dataDir })` 透传；装配经 `.harness/plugins` 外部插件目录完成，cli 主逻辑不耦合。

### 测试与版本

* 新增 `oauth.test.ts`（16）+ `token-store.test.ts`（4）+ 补 `index.test.ts` 5 条（OAuth 头注入优先、401 刷新重试一次、重试仍拒抛错、非 oauth 401 抛错、factory 端到端 OAuth 装配+落盘）。修复一处逻辑 bug：`expires_in=0` 时原 `obtained_at && expires_in` 判成永不过期（误返回过期 token）——改 `!= null` 判定。mcp-client 55 用例全过，全量 typecheck 通过。mcp-client version 0.1.0 → 0.2.0。

## 2026-09-06（续 74）code-intel：Java 反向 import 跨目录解析

> 承接续 73。`code_semantic_edit` rename 的 `resolveImporters` 从仅覆盖 TS/JS 扩展到 Java：把 scope 外、但通过 `import <pkg>.<symbol>` 引用声明方符号的外部导入方一并纳入改名。

### 实现

* **`multi.ts`**：新增 `collectJavaModuleInfo(content)`——解析 Java 文件的 `package a.b;`（取 `scoped_identifier` 命名子节点，非 `name` 字段）与 `import a.b.Symbol;` 完整限定名列表（含 static 导入），供包名匹配。
* **`core.ts`**：`reverseImporters` 增加 Java 分支——预计算声明方（declaringFiles 中的 `.java` 文件）的包名集合；对每个外部导入方取它的 import 限定名，凡末段 == 符号且前缀 == 任一声明方包名，即用 `collectJavaRenameSites` 将整文件纳入（声明+引用全改）。仅全限定名引用（无 import 绑定）或非本包文件不误拉入。

### 测试与版本

* `index.test.ts` 新增 1 条：声明在 `app/Shape.java`（`package app`，类+构造），scope 设 `app`；scope 外 `consumer/Main.java` 经 `import app.Shape` 引用——`path:'app', resolveImporters:true` 后 `app/Shape.java` 类名/构造器与 `consumer/Main.java` 的 import 说明符/类型/构造引用全改，`importers` 记为 1；同根下仅「全限定名引用、无 import 绑定」的 `other/Other.java` 不被拉入。code-intel 包 73 用例全过，typecheck 通过。插件 version 0.13.0，meta 描述同步。

## 2026-09-06（续 73）code-intel：Java 语义 rename 接入结构编辑

> 承接续 72。把 Java 从「名字命中型引用」提升为「语义编辑位点」：`code_semantic_edit` 的 rename 现对 `.java` 走 CST 标识符 token 级实现（声明位点精确化 + 引用识别 + 重解析校验），对齐 TS/JS 的 babel 语义 rename。

### 实现

* **`core.ts`**：`CodeIntelIndex.collectRenameSitesFromScope` 按 `.java` 分派到 `collectJavaRenameSites`（其余走 babel `tryParse` + `collectRenameSites`）；`execRename` 落盘前校验分支——Java 文件用 `verifyJavaSource`（`!root.hasError`）而不是 `tryParse`，任一失败整体放弃（不落盘）。
* **`multi.ts`**：`collectJavaRenameSites` 收集同名声明/引用 token 位点——声明仅取拥有 `name` 字段的节点（class/record/interface/annotation_type/enum → type_identifier、method/constructor → identifier、variable_declarator → identifier），标记 `decl`；其余 `identifier`/`type_identifier`/`field_identifier` 同名 token（含 import 说明符、字段访问、类型引用、调用）归 `ref`。注释/字符串/字面量非 token 天然隔离。`verifyJavaSource` 重解析无 ERROR 节点即校验通过。
* **偏移修正（关键）**：web-tree-sitter 的 `startIndex/endIndex` 已把 UTF-8 字节偏移换算为 JS 字符索引（实测含中文注释时仍与 `content.slice` 精确对齐），位点可直接用于替换。此前为实现"字节→字符换算"而引入的 `jsIndexAt` 反而把已正确的字符索引当字节再换算一次，导致含非 ASCII 前文的 token 范围错位（出现 2 字符跨度等异常）——已删除，位点直接用 `n.startIndex/n.endIndex`。

### 测试与版本

* `index.test.ts` 新增 2 条：① 单文件字段重命名——声明 1 + 引用 3（`this.count`/`count+1`/`return count`）共 4 位点同步，注释中同名 token 不触碰、中文注释场景验证字符偏移换算正确、`validated=true`；② 类名跨文件——`util/Shape.java` 声明 + `Main.java` import 说明符与类型/构造引用同步改名。code-intel 包 72 用例全过（原 70 + 新增 2），typecheck 通过；全量 typecheck 通过。插件 version 0.12.0，meta 描述同步（rename TS/JS babel + Java tree-sitter 语义）。

## 2026-09-06（续 72）code-intel：进程内 MCP server 解耦

> 承接续 71。把 code-intel 从"直装 `@harness/tool` 工具"重构为「进程内 MCP server + 直装工具」双路径，核心逻辑与 harness 解耦：索引 / 符号 / 引用 / 定义 / 结构感知编辑引擎下沉到 `core.ts`（零 `@harness/tool` / `@harness/plugin` 依赖），MCP server 由 `@harness/mcp-server-registry` 进程内连接并暴露为 `mcp__code-intel__*` 工具，可独立部署 / 跨进程调用。

### 实现（src 拆分三件套）

* **`core.ts`**：从原 `index.ts` 拆出全部核心逻辑——`CodeIntelIndex`（按需增量 + mtime/size 缓存）、babel 符号/引用提取、tree-sitter 多语言导航入口、`execSemanticEdit`（rename / replace_node / replace_subtree 结构感知编辑引擎）。定义独立契约 `CoreResult` / `ok` / `fail` / `CoreContext`（仅 `cwd`）。
* **`server.ts`**：进程内 MCP JSON-RPC server（`CodeIntelMcpServer`）——`initialize` / `tools/list` / `tools/call`，四个工具入参支持可选 `cwd`、返回文本（便于 LLM 直接阅读）；`createCodeIntelServerTransport` 包装为 `@harness/mcp-client` 的 `McpTransport`（send 喂给 server、onMessage 回传、提前接收走队列）。
* **`tools.ts`**：薄适配层，把 `core.ts` 能力适配为 `@harness/tool` 的 Tool（同 id），保留只读/并发安全/权限键声明，供 REPL `/tools` 展示与既有测试兼容。
* **`index.ts`**：插件入口 `createCodeIntelPlugin` 装配方式对齐 computer-use（可插拔 / 独立装卸）——`install` 钩子内用 `registerMcpServer({ name, createTransport })` 注册进程内 server（同名覆盖、幂等）、`uninstall` 注销（`unregisterMcpServer`）；同时经 `tool.pool.assemble` 注入直装工具；`dependsOn: ['mcp.server-registry']`；重导出 core/tools/server 公共符号。

### 装配方式（.harness/plugins 纯 MCP，可插拔）

* `createCodeIntelPlugin` **改为纯 MCP server 装配**（对齐 computer-use）：install 只 `registerMcpServer`，**不再直装 harness 工具**（移除 `tool.pool.assemble`），工具统一由 registry 连接后以 `mcp__code-intel__*` 暴露；core 能力仍可经 `./tools` 薄适配程序化调用。
* **CLI 派发成 metaOnly**：cli 里 code-intel 内置项与 computer-use 同为 `metaOnly: true`（仅预登记 `mcp__code-intel__*` 元信息供 /tools 展示，不后台预加载实例化）。
* **`.harness/plugins/mcp.ts` 装配**：加入 `createCodeIntelPlugin()`（与 `createMcpServerRegistryPlugin` / `createComputerUsePlugin` 并列），删除该文件即停用；`meta.ts` 四个工具 id 加 `mcp__code-intel__` 前缀，description 对齐。
* 新增端到端用例：code-intel + registry 装配 → `harness.start` 连接 → `tool.pool.assemble` 暴露 4 个 `mcp__code-intel__*` 工具且无前缀直装工具不在池中。

### 测试与版本

* 新增 `server.test.ts` 用例：initialize、tools/list、tools/call 四工具、未知工具/方法走 JSON-RPC 错误码、rename dryRun 不落盘、transport 响应回传与队列，以及 3 条插件装配集成用例（install 后 registry 可见 code-intel 条目 + 纯 MCP 无直装工具；transport 经 `@harness/mcp-client` `McpClient.connect` + `listTools`=4 + `callTool` 可用；端到端 harness.start 连接暴露 `mcp__code-intel__*`）。修复 `fail(message, code)` 参数顺序、`resolvePathRelative` 未定义、测试同步等待异步 `tools/call` 响应三类问题。code-intel 包 70 用例全过、typecheck 通过；cli 95 用例全过。插件 version 0.11.0。

## 2026-09-06（续 71）code-intel：多语言导航新增 Java

> 承接续 70。为 tree-sitter 后端补 Java 支持，与 Go/Python/Rust 同一条链路（名字命中型引用，非语义编辑）。

### 实现（src/multi.ts + scripts/copy-grammars.mts）

* `MULTI_EXT` / `GRAMMAR` / `WASM_FILE` 增 `.java` → `tree-sitter-java`（依赖 `tree-sitter-java@^0.23.5`，wasm 已确认）。
* `javaSymbols` 提取器：class/record → class；interface/annotation_type → interface；enum → enum；method/constructor → function；字段/局部变量（`variable_declarator`，可多声明符）→ variable；import（`scoped_identifier` 最末段，含 `import static java.lang.Math.max` 取 `max`）→ import。
* `TOKEN_TYPES['.java'] = {identifier, type_identifier}`（经实探确认 Java 无 `field_identifier`，类型引用走 `type_identifier`）。
* `copy-grammars.mts` 增 Java wasm，构建时复制到 `dist/`。
* `index.ts` 的 `SUPPORTED_EXT = BABEL_EXT ∪ MULTI_EXT` 自动含 `.java`，无需改分派。

### 测试与版本

* 新增 3 用例：Java 符号提取（class/interface/enum/record/方法/构造器/字段/局部变量/导入，含 static 导入与行号）、Java 引用（类型标识符与方法调用、声明处排除）、目录聚合（babel .ts + tree-sitter .py/.go/.java 合并）。code-intel 58 用例全过、typecheck 通过。插件 version 0.10.0。

## 2026-09-06（续 70）code-intel：多语言 wasm 显式复制到产物（import.meta.url 相对定位）

> 更正续 69 实现。用户指定对齐 web-tree-sitter 自身做法：ESM 内 `new URL('tree-sitter.wasm', import.meta.url)` 相对模块目录定位，构建脚本把三个语法 wasm **显式复制**到产物目录，运行时 `Language.load(bytes)` 命中相邻文件即可、无需 node_modules 落盘。弃用续 69 的 env base64 注入方案。

### 相邻产物复制（src/multi.ts + scripts/copy-grammars.mts）

* `WASM_FILE`：`.go/.py/.rs` → `tree-sitter-{go,python,rust}.wasm` 文件名（定位于本模块同目录）。
* `readGrammarBytes(ext)` 来源优先级：
  1) **相邻产物**：`fileURLToPath(new URL(WASM_FILE[ext], import.meta.url))` 相对模块定位，命中即用（对齐 web-tree-sitter 自身）；
  2) **磁盘回退**：`createRequire.resolve` + `readFileSync`（dev/测试路径）。
* `languageFor` 保持 `Language.load(bytes)`（Uint8Array），同一 API 兼容两来源。
* 新增 `scripts/copy-grammars.mts`：`createRequire.resolve` 定位三个 node_modules 语法 wasm，`copyFileSync` 复制到 `dist/`（缺省出参 `process.argv[2]`），`build` 脚本前置执行。dist 已 gitignore。

### 测试与版本

* 用例改为「相邻产物复制优先 + node_modules 回退」：无相邻文件时回退校验字节长度、放置相邻文件后校验字节一致。工作区全量 452 用例全过、typecheck 通过。插件 version 0.9.0。

## 2026-09-06（续 69）code-intel：多语言 wasm 支持内联字节（适配单二进制打包）

> 承接续 68。解决「语法 wasm 依赖 node_modules 落盘文件、单二进制打包后路径失效」的问题。经实测 bun 1.3.14 无法经导入查询（`?arraybuffer`/`?raw`/import attribute）无损内联二进制，转用**环境变量注入**（方案3）：运行时优先进 `Language.load(bytes)` 用内联 Uint8Array，未注入则回退磁盘读取。

### 字节化加载（src/multi.ts）

* `readGrammarBytes(ext)`：返回语法 wasm 的 `Uint8Array`（供 `Language.load(bytes)`）。
  1) **env 内联**：读 `HARNESS_GRAMMAR_B64_GO/_PY/_RS`（各语言语法 wasm 的 base64）→ `Buffer.from(b64,'base64')` 解码；base64 非法则回退。
  2) **磁盘回退**：`createRequire.resolve` 定位 node_modules 语法 wasm + `readFileSync`（dev/测试路径）。
* `languageFor` 由 `Language.load(path)` 改为 `Language.load(bytes)`，同一 API 兼容内联/磁盘两来源。
* 单二进制打包用法：构建时把某语言 wasm 转 base64 写入对应 env 再跑 `bun build --compile`，运行时即无需 node_modules 落盘。

### 测试与版本

* 新增用例「env 内联字节注入」：注入 Go wasm base64，验证 `readGrammarBytes` 返回字节且完整索引链路可解析 `injectedFn`。code-intel 55 用例全过、typecheck 通过。插件 version 0.8.0。

## 2026-09-05（续 68）code-intel：换 web-tree-sitter 支持多语言导航

> 承接续 67。为 code_symbols / code_reference / code_definition 补上 Go / Python / Rust 多语言导航能力，采用**双后端**策略：TS/JS 保留 babel（语义引用），Go/Python/Rust 走 web-tree-sitter（名字命中型引用）。语义编辑（rename/replace_*）不扩到非 JS 语言。

### 多语言引擎（src/multi.ts）

* `getMultiParser()`：惰性单例 Parser + `Parser.init()`，预加载三语法 wasm；任一语言失败只降级该语言，不整包失败（返回 null 由上层跳过、不中断索引）。
* `GRAMMAR` 映射 `.go/.py/.rs` → 各 `tree-sitter-*` 包的 wasm，经 `createRequire.resolve` 定位。校验了包内 wasm 文件全部就位（`web-tree-sitter.wasm` / 三语言 `*.wasm`）。
* `extractMulti(content, filePath, relativePath, ext)`：`parser.parse`（返回值可为 null，取 `tree.rootNode`）→ 各语言提取器产出 `CodeSymbol[]` + 名字命中型 `CodeReference[]`。
  * **Python**（pythonSymbols）：函数/异步函数/类；import_statement / import_from_statement（name 字段，带别名时含 `json as js`）；assignment / augmented_assignment 的标识符左目标（排除 self/cls）→ variable。
  * **Go**（goSymbols）：function_declaration / method_declaration / method_spec → function；type_spec → struct_type 为 class / interface_type 为 interface / 其余 type；const_spec / var_spec → variable；import_spec 取别名或裸串。
  * **Rust**（rustSymbols）：function_item / struct_item / enum_item / trait_item / type_item / const_item / static_item 按 `KIND_BY_TYPE` 映射；use_declaration 取 `name` 末段 → import。
  * 引用为 token 文本命中 + 排除声明 name 节点的集合式匹配（tree-sitter 无作用域绑定，故非语义级；babel 语义引用不受影响）。

### 后端分派（src/index.ts）

* `SUPPORTED_EXT` = babel 扩展 ∪ `MULTI_EXT(.go/.py/.rs)`；`indexFile` 按扩展名分派到 babel（`BABEL_EXT`）或 tree-sitter（`extractMulti`），失败降级为「不支持」，不中断索引。

### 测试

* 新增「多语言导航（tree-sitter）」块 6 用例：Py 符号（函数/类/变量/导入 + 行号）、Py 名字命中型引用（排除声明处）、Go 符号（函数/方法/struct→class/interface/变量/导入）、Rust 符号（fn/struct/trait/enum/const + 引用）、目录聚合（babel(.ts)+Py+Go 合并）、编辑隔离（对 .py rename 报 SYMBOL_NOT_FOUND 且不落盘）。全仓 code-intel 54 用例全过、typecheck 通过。插件 version 0.7.0，meta 描述补多语言双后端标注。

## 2026-09-05（续 67）code-intel v2：rename 跨目录全局反向 import 解析

> 承接续 66。解决 import 反向查找：当符号定义在扫描根内、但被根之外的文件 `import { symbol } from '...'` 使用时，重新命名能同步外部导入方，避免改名字不一致。

### resolveImporters + importRoot

* `CodeSemanticEditRenameInput` 增 `resolveImporters?: boolean`（默认关，伪入开关）与 `importRoot?: string`（反向扫描根，缺省 ctx.cwd，可收紧）。
* `resolveModuleFile(spec, importerDir)`：仅相对说明符，补齐扩展名 / index 文件解析为本地绝对路径；裸包/别名/未命中返回 null。
* `CodeIntelIndex.reverseImporters(reverseRoot, relBase, symbol, declaringFiles, skip)`：在 reverseRoot 内枚举文件，遍历 `ImportDeclaration` / `ExportNamedDeclaration`（含 source），凡 import/再导出 `symbol` 且说明符解析命中 declaringFiles 中模块的文件 → 复用 `collectRenameSites` 收集改名位点。
* `execRename`：先经 scope 过滤，再据索引缓存 `symbols`（kind !== 'import'）判定真实声明模块（排除仅 import 的本地绑定），开启时反向拉入外部导入方并 merge 进 byFile；输出回显 `resolveImporters` / `importRoot` 与 `importers[]`。外部导入文件同样先内存变换 + tryParse 校验，任一失败整体放弃。

### 测试

* code-intel 扩至 48 用例全过（跨目录反向改名/缺省不越界/再导出/importRoot 收紧/importRoot 越界）；全仓 typecheck 通过。插件 version 0.6.0，meta/文档/开发日志同步。

## 2026-09-05（续 66）code-intel v2：rename 加 scope 限定 + replace_subtree 目录批量

> 承接续 65。补齐两处批量编辑能力：rename 子目录白名单限定（控制改名爆炸半径），replace_subtree 支持目录一键批量替换所有匹配文件。

### rename + scope（子目录白名单）

* 输入 `CodeSemanticEditRenameInput` 增 `scope?: string`：在已扫描的根 `path` 下，仅编辑该子目录/文件内的命中，相对根解析。
* `filterByScope`：`file === scopeAbs || file.startsWith(scopeAbs + sep)` 白名单过滤；越界报 `PATH_OUTSIDE_CWD`，scope 内无命中报 `SYMBOL_NOT_FOUND`（与 path 同语义）。输出回显 `scope`，permission `extractPatterns` 追加 scope。

### replace_subtree 目录批量

* `path` 语义扩展为「文件或目录」；`CodeIntelIndex` 新增 `collectSubtreeFromScope`（镜像 `collectRenameSitesFromScope`，成员链选择器内容定位天然可跨文件）。
* 输出重构为逐文件 `files[]`（`CodeSemanticEditSubtreeFileResult`：path/relativePath/count/matches/preview），顶层 `total` 为全部文件匹配总数。
* 隔离性：逐文件先内存变换 + `tryParse` 重解析，任一失败整体放弃；根路径不存在报 `PATH_NOT_FOUND`（区别于"存在但无匹配"的 `SUBTREE_NOT_FOUND`）；dryRun 只预览不落盘。

### 测试

* code-intel 扩至 43 用例全过（scope 白名单/无命中/越界、目录批量/无匹配/根不存在 + 原 dryRun 断言适配 `files[]`）；全仓 typecheck 通过。插件 version 0.5.0，meta/文档/开发日志同步。

## 2026-09-04（续 65）code-intel v2：code_semantic_edit 新增 replace_subtree（成员链子表达式替换）

> 承接续 64。在 replace_node（行列范围吸附节点）基础上，补第三种结构编辑模式：按成员链路径（`config.server.host`）精确定位并替换子表达式。

### replace_subtree

* 输入：单目标文件 + 成员链选择器（`selector`，如 `config.server.host`，仅标识符/字符串属性，含下标按非法拒绝）+ replacement（空串=删除该子表达式）+ dryRun。
* `memberChainText`：把 AST 节点还原成 `a.b.c` 文本（`MemberExpression`/`OptionalMemberExpression`/`Identifier`，computed 仅接受字符串字面量）。
* `collectSubtreeMatches`：遍历 AST 收集 `chainText === selector` 的**topmost**节点——排除作为更长成员链 object 的匹配，避免 `a.b.c` 里误伤 `a.b`。
* 从后向前替换每个精确 AST 范围，落盘前内存 `tryParse` 重解析校验结构（`EDIT_INVALID_STRUCTURE` 整体放弃）；dryRun 返回匹配列表（行/列/文本）与替换后预览；写盘后缓存失效。

### 测试

* code-intel 扩至 37 用例全过（全量替换/topmost 排除/dryRun/非法选择器/未找到/越界）；全仓 typecheck 通过。插件 version 0.4.0，meta 描述同步三种 edit 模式。

## 2026-09-04（续 64）code-intel v2：code_semantic_edit 新增 replace_node（按 AST 节点范围替换）

> 承接续 63。先把上轮遗留的 workspace-management.md 表格空白清理提交（纯格式），再实现 replace_node。

### `code_semantic_edit` 重构为 mode 分发的联合输入/输出

* 输入按 `mode` 联合：`CodeSemanticEditRenameInput | CodeSemanticEditReplaceNodeInput`，输出对应联合（Rename/ReplaceNode）。
* 工具 `call` 按 mode 分派到 `execRename` / `execReplaceNode`；写声明/安全声明保持一致（isReadOnly=false、isConcurrencySafe=false、permission.key='edit'）。

### replace_node

* 输入：目标文件 + 行列范围（1-based line/column，列=该行第 1 字符为 1；`endColumn 0`=行末不含换行）+ replacement + dryRun。
* `findContainingNode`：遍历 AST 找**完全包含**用户范围的最小节点（吸附）；精确命中节点边界→relation `exact`，否则 `absorbed`（`hasInner` 提示圈选过大）。
* 行列↔偏移用 `buildLineStarts` + `lineEndExclusive` 换算（末行带换行/不带换行两态）。
* 隔离性：仅替换 AST 节点精确范围；整行圈选顺带消费紧随节点的行尾换行（避免替换后残留空行）；落盘前内存重解析校验（`EDIT_INVALID_STRUCTURE` 整体放弃）；dryRun 返回吸附节点 + 替换后预览。写盘后缓存失效。

### 测试

* code-intel 扩至 31 用例全过；cli 163 全过；全仓 typecheck 通过。定位了两处真实的边界（末行换行换算、节点类型为 VariableDeclaration 而非 ExpressionStatement）并在实现/断言中修正。

## 2026-09-04（续 63）code-intel v2：code_semantic_edit 结构感知编辑（符号重命名）

> 承接续 62，落地 codeintel-plugin.md §4 的 v2 项：结构感知编辑。

### 新增 `code_semantic_edit` 工具（mode=rename）

* 仅替换**精确的 AST 标识符 token 范围**（声明 + 引用 + import 源名），字符串/注释中的同名文本与 `obj.x` 属性访问一律不触碰——"编辑前校验隔离性"的结构保证。
* 位点收集 `collectRenameSites`：函数/类/变量/接口/类型/枚举声明、import 本地绑定与源名（`import { X as Y }`）、export 说明符本地名、ReferencedIdentifier（含对象简写）；按字符范围去重、偏移转行号。
* **编辑前校验**：全部文件先在内存中完成变换并 `tryParse` 重解析，任一失败整体放弃、不落盘（`EDIT_INVALID_STRUCTURE`）；`dryRun` 预览计划位点；写盘后 `index.invalidate` 使缓存失效。
* 安全声明：`isReadOnly=false`、`isConcurrencySafe=false`、`permission.key='edit'`（对齐 tools-builtin 写工具约定）。
* `CodeIntelIndex` 新增 `collectRenameSitesFromScope`（复用目录发现）与 `invalidate`。

### 装配与元信息

* `createCodeIntelPlugin` 注入 4 个工具（version 0.2.0）；`meta.ts` 增 `code_semantic_edit`（只读=false/非并发/edit）；cli `BuiltinPluginRegistry` 描述同步。

### 测试

* code-intel 扩至 24 用例全过（跨文件重命名隔离性/dryRun/对象简写/非法标识符/符号不存在/越界/安全声明/meta）；cli 163 全过；全仓 typecheck 通过。烟测验证：`greet`→`salute` 三处（声明/import/引用）更新，`"greet"` 字符串与 `obj.greet` 未动。

## 2026-09-04（续 62）实现 code-intel 插件（`@harness/code-intel`）

> 落地 [codeintel-plugin.md](codeintel-plugin.md) 规划的 v1：代码情报（AST 符号索引）插件化。

### 技术选型

* 按规划 §3「纯 TS 域可退化为 @babel/parser 起步」选用 **`@babel/parser` + `@babel/traverse`**（纯 JS、同步、可单测），支持 TS/TSX/JS/JSX；多语言 web-tree-sitter 留作后续演进，不改工具/插件契约。
* 索引为**内存内 + 按需增量**：parse 目标文件/目录，缓存按 mtime+size 失效；解析失败多配置回退（TS 加 jsx、纯 JS 兼容 TS 语法），单文件失败跳过不中断目录索引。

### 新包 `packages/plugins/code-intel`

* `CodeIntelIndex`：`symbols`/`allReferences`/`allDefinitions` 查询；`ignoreDirs`（默认 .git/node_modules/dist 等）、`maxFiles`(500)、`maxDepth`(8) 可配。
* 三个只读工具（`isReadOnly`+`isConcurrencySafe`+`permission.key='read'`）：
  * `code_symbols`：列文件/目录符号（函数/类/变量/接口/类型/枚举/导入），含位置、签名、exported。
  * `code_reference`：查某符号引用（跨文件，行/列 + 上下文）。
  * `code_definition`：go-to-definition（声明位置，排除 import 绑定）。
* `meta.ts`（L1 静态元信息）自包含，供 `/tools` 提前展示。

### 装配

* 根 `tsconfig.json` 注册 `@harness/code-intel`（含 `/meta` 子路径）；cli `getBuiltinRegistry()` 登记 `code-intel`（惰性 load + metaSource），boot 后台预加载即开箱即用，烟测通过（注入三工具）。

### 测试

* code-intel 17 用例全过（符号提取/缓存/三工具/越界/插件装配/meta）；cli 163 用例全过（其中 1 例 `/snapshot status` 断言随续 60 输出变更同步更新）；全仓 typecheck 通过。

## 2026-09-03（续 61）文档：整理 /snapshot 命令清单与多工作区快照隔离说明

> 承接续 59/60，把快照命令与隔离设计沉淀进 [workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.3。

* §7.3.1：新增 `/snapshot` 命令清单表（查询/捕获/预览/回滚/维护五类 + 服务端方法映射），`status` 自省说明。
* §7.3.2：多工作区快照隔离——git/file 两后端存储目录默认按 `sha256(worktree)[0:16]` 派生，天然隔离；显式隔离走 `gitDirectory`/`dataDir`，将来跨工作区共享可加按 workspace 解析存储根的一层 provider，不改两后端。

纯文档，无代码变更；全仓 typecheck 不受影响。

## 2026-09-03（续 60）快照管理补全 preview/gc + status 增强（后端/启用/最新快照）

> 承接续 59。按用户需求补上 `preview`、`gc` 命令，并把 `status` 从「一句已启用」增强为展示后端与启用态、快照计数、最新快照。

### 服务层自省（@harness/snapshot）

* `SnapshotService` 接口新增只读自省字段：`backend: 'git' | 'file'`（工厂 auto 探测后两后端各自固定暴露）与 `enabled: boolean`。
* `GitSnapshotService.backend='git'`、`FileSnapshotService.backend='file'`；`enabled` 由 `private` 提升为 `readonly` 公开。

### 命令层（@harness/revert `createSnapshotPlugin`）

* `status` 增强：输出「状态（已/未启用）/ 后端 / 快照数 / 最新快照 ID / 捕获时间」，无快照给出捕获指引。
* 新增子命令：
  * `preview <to> <path...>`：零副作用回滚预览——从快照 `<to>` 恢复指定文件的 diff（不落盘，复用服务端 `preview`）。
  * `gc`：清理过期快照存储（git `git gc` / file 清理无引用备份）；后端不支持时提示。
* 帮助文本与 usage 同步补全。

### 测试

* snapshot 新增自省字段用例（两后端 + disabled 语义）。
* revert 新增 status 空快照、preview（含缺参 / diff 输出）、gc（含不支持回退）共 6 用例——revert 共 35、snapshot 共 28 用例全过；全仓 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.3

## 2026-09-03（续 59）快照管理命令扩展：list / diff / restore / checkout

> 承接续 57/58，按用户需求「增加更多快照管理命令和回滚命令，如快照列表、内容 diff」，把 `/snapshot` 从只读信息命令扩成完整管理工具。

### 服务层（@harness/snapshot）

* `SnapshotService` 接口新增 `list(): Promise<SnapshotInfo[]>`，返回快照历史（最新在前）。
* 新增 `SnapshotInfo` 类型（`id` + 可选 `timestamp`），两后端一致：
  * `GitSnapshotService.list()` 读 `snapshot-ids.json`，旧版纯字符串数组自动迁移（ts=unknown）。
  * `FileSnapshotService.list()` 读 `snapshots.json` 快照链。

### 命令层（@harness/revert `createSnapshotPlugin`）

* 新增子命令：
  * `list`：列出快照历史（最新在前，含本地化时间戳；无快照给出捕获指引）。
  * `diff <from> <to> [path]`：两快照间增量统计（新增/修改/删除 + 行数）；给 path 时附 unified 补丁。
  * `restore <to> <path...>`：从快照 `<to>` 选择性恢复指定文件（目标快照中不存在则删除）。
  * `checkout <to>`：整仓恢复到快照 `<to>`。
* 对齐助手补全 `/snapshot` 帮助文本与 usage（统一缩进对齐）。

### 测试

* revert 新增 list（含时间戳 / 空快照）、diff（摘要 + 补丁 / 缺参 / 无差异）、restore（恢复映射 / 缺参）、checkout（成功 / 缺参）等 8 用例——revert 共 30 用例全过。
* snapshot、cli 用例仍全过；全仓 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.3

## 2026-09-03（续 58）修复 config.json 快照配置未生效（兼容嵌套 harness.snapshot）

> 承接续 57。用户按帮助提示在 `~/.harness/config.json` 写了 `"harness": { "snapshot": true }` 但未生效——续 57 代码只读顶层 `cfg.snapshot`，而现有 config 为扁平结构，本身并无 `harness` 包裹层，是帮助文字给了嵌套写法示例导致的错配。

* `HarnessConfig` 增加 `harness?: { snapshot?: boolean }`（文档标注为兼容写法）。
* `main()` 快照解析改为 `args.snapshot ?? cfg.snapshot ?? cfg.harness?.snapshot ?? false`，兼容顶层与嵌套两种写法。
* 帮助文字与 `/snapshot` 未启用提示统一：顶层 `"snapshot": true` 为主，嵌套 `"harness": { "snapshot": true }` 亦可用。

`@harness/cli` 163 + `@harness/revert` 22 用例仍全过；全仓 typecheck 通过。

## 2026-09-03（续 57）快照功能开启 + `/snapshot` 信息命令（方案 A+B+C）

> 承接续 55/56 调研结论落地：A（CLI `--snapshot` flag）+ B（config.json `harness.snapshot` 持久化，优先级 CLI>config>默认 false）+ C（新增薄壳 `/snapshot` 命令）。

### 开启快照（@harness/cli）

* `CliArgs`/`parseCliArgs` 增加布尔 `--snapshot`；`HarnessConfig` 增加 `snapshot?: boolean`。
* `main()` 解析 `args.snapshot ?? cfg.snapshot ?? false` 传入 `HarnessApp({ snapshot })`，覆盖 repl / run / resume 路径。
* `HELP_TEXT` 增加 `--snapshot` 说明。

### `/snapshot` 薄壳命令（@harness/revert）

* 新增 `createSnapshotPlugin`（id=`snapshot-shell`）：`cli.commands` 注册 `/snapshot`；`cli.command` 处理 `status|capture [scope]|files <from> <to>|help`，只读/轻量操作。
* 依赖 cli 注入的 `input.snapshotService`；未启用时给出开启指引（`--snapshot` / config.json），不抛错。cli `providerPlugins.push(createSnapshotPlugin())` 并将其登记（同 revert-shell）。

### 测试与验证

* revert 新增 `createSnapshotPlugin` 7 用例（命令注册 / 未启用提示 / 缺省 status / capture / files·缺参 / 非 snapshot 不设 result / 稳定 id）——revert 共 22 用例全过。
* cli 新增 `--snapshot` 解析用例 + 4 条 `/snapshot` boot 集成用例（未启用提示 / status / files 缺参 / /help 包含）——cli 共 163 用例全过。全仓 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.3

## 2026-09-03（续 56）snapshot/revert 薄壳插件化：`createRevertPlugin`

> 承接续 55，落实 workspace-management §7.3「预创建 + 薄壳」模式同样适用于 snapshot 插件化。把内联在 cli 的 `/revert` 命令抽成 `@harness/revert` 包内的薄壳 AgentPlugin，快照服务由 cli 预创建后经 cmdInput 注入，消灭 cli 内联回滚逻辑。

### 实现（@harness/revert）

* 新增 `createRevertPlugin(opts?)` 薄壳插件（id=`revert-shell`）：
  * `cli.commands` 注册 `/revert` 命令定义（自动并入 `/help` 与 TUI 命令面板）。
  * `cli.command` 提供 `stage|clear|commit|status|help` 五子命令，复用同包 `createSessionRevert` 三态控制器。
  * 数据依赖全部来自 cli 注入：`input.snapshotService`（HarnessApp.snapshotService）+ `input.harness.session/bus`；未启用 snapshot 或未注入时给出提示不抛错。
  * 子命令/参数从完整 `input.raw` 解析（cli 注入的 arg 只含第二 token，同 workspace-shell 处理）。
* 新增 `@harness/plugin` 依赖。

### cli 接入

* `providerPlugins.push(createRevertPlugin())`（与 workspace-shell 并列）；cmdInput 注入 `snapshotService: app.snapshotService`。
* 删除内联 `case '/revert'` 块与已不再使用的 `createSessionRevert/RevertEvents/RevertState` import；`/help` 里硬编码的 `/revert` 行移除，改由 `cli.commands` 自动列出（避免重复）。

### 测试与验证

* revert 新增薄壳插件 5 用例（命令注册 / 未启用提示 / session·bus 未注入提示 / 非 revert 不设 result / 稳定 id）——revert 共 15 用例全过。
* cli 既有 6 条 `/revert` 集成用例经 boot+REPL 走插件路径仍全过（@harness/cli 158 用例全过）；全仓 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.3

## 2026-09-03（续 55）workspace-shell 扩展 `/workspace open` 子命令

> 承接续 54。给薄壳插件 `@harness/workspace-shell` 增加子命令，用于用系统文件管理器打开各工作区目录，仍保持薄壳（仅展示 + 打开，不解析资源）。

### 实现（@harness/workspace-shell）

* `resolveOpenTarget(ws, target?)`：纯函数，解析 `/workspace open [target]` 目标路径——
  * 缺省 / `user` / `data` → `dataDir`（用户级根 ~/.harness）
  * `cwd` → 工作目录；`project` → 项目级根（<cwd>/.harness）
  * 其他 → 相对 cwd resolve，存在返回路径、不存在返回 `{ error }`。
* `openInFileManager(path)`：跨平台打开目录（darwin `open` / win32 `explorer` / Linux `xdg-open`），spawn 失败返回 `{ ok:false, error }`；签名 `OpenDir` 可注入（`opts.open`），测试注 spy。
* `cli.command` handler 增加子命令解析：`open`（经 resolveOpenTarget → open，输出已打开/失败/目录不存在）、`help`（用法说明）；其余（含空）仍渲染布局。命令 `usage` 更新为 `/workspace [open [cwd|user|project|路径]]`。

### 测试与验证

* 新增 8 用例：resolveOpenTarget 三类（别名映射/相对路径/不存在）；open 子命令缺省目标、cwd/project、目录不存在、失败、help。
* workspace-shell 共 16 用例全过；全仓 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.1

## 2026-09-03（续 54）core 的 agents/skills 内部加载改用 MultiDirLoader（扫描逻辑收敛）

> 承接续 52/53。把 core 装配 agentDirs/skillDirs 时手写的 `readdir + 来源标注 + join` 骨架也收敛到 workspace 的 `MultiDirLoader`，消除 core 与 cli 的重复扫描逻辑。

### MultiDirLoader 扩展（@harness/workspace）

* `DirItem` 新增 `kind: 'file' | 'dir'` 字段（由 `readdirSync({withFileTypes:true})` 的 `Dirent.isDirectory()` 判定）。
* `MultiDirFilter` 新增 `kind?: 'file' | 'dir'` 过滤条件，支持「仅枚举文件/仅枚举目录」的消费方（如 agent 加载只处理 .md 文件）。

### core 接入

* **Agent 加载**：`agentLoader.scan({ kind: 'file', name: n => extname(n) === '.md' })` 枚举 .md 文件并逐项容错解析，替换手写 readdir 循环；来源仅用于日志（AgentDefinition 无 loadedFrom，覆盖由加载顺序保证）。
* **Skill 加载**：`normalizeDirs(skillDirs, 'project')` 归一（兼容 string / {dir,source} 对象），遍历 `skillLoader.dirs` 调 `skillManager.load(dir, source)`，每目录失败仅 warn 不阻塞。
* 删除 core 不再使用的 `existsSync`/`readdirSync` 相关手工枚举导入；`@harness/workspace` 依赖已在 package.json 注册。

### 测试与验证

* MultiDirLoader 新增 `kind 标注 + kind 过滤（仅文件/仅目录）` 用例（workspace 共 14 用例全过）。
* core 新增「多级目录加载」集成套件 2 例：agentDirs user→project 同名覆盖 + 仅 user 保留；skillDirs 目录式/单文件式加载 + 同名 project 覆盖（core 共 33 用例全过）。
* 全仓 20 包 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.4

## 2026-09-02（续 53）工作区管理（四）：薄壳插件 @harness/workspace-shell + /workspace 命令

> 承接续 52。落实规划文档 §7.1/§7.3：用薄壳 AgentPlugin 把「解析好的 Workspace 布局」以 /workspace 命令展示在 REPL，业务能力经插件注入，不与 cli 主逻辑耦合。

### 新增插件包 @harness/workspace-shell（packages/plugins/workspace-shell）

* `renderWorkspace(ws, title?)`：纯函数，把 Workspace 渲染为文本——cwd/dataDir、dataDir 数据文件（config/permissions/sessions/.config-key）、两级（user×project）各 plugins/skills/agents 路径，`✓` 标记已存在路径，并注明「user → project 后者覆盖前者」加载顺序。
* `createWorkspacePlugin(opts?)`：cli.commands 注册 /workspace；cli.command 命中则输出 renderWorkspace。数据来源优先级 `input.workspace`（cli 注入）→ `opts.workspace`（显式入参），两者皆无则提示「工作区未注入」（插件可独立安装/测试不炸）。处理完成设 `input.result='continue'`，未命中其他命令不设 result（fallthrough 交给别的插件）。
* 依赖 `@harness/plugin` + `@harness/workspace`。

### CLI 接入

* boot 装配：`providerPlugins.push(createWorkspacePlugin())`（与 tools-manager 并列，随应用打包的内置插件）。
* cmdInput 构造加注入 `workspace: app.workspace`（HarnessApp 已解析的 Workspace，见续 51），薄壳插件经 `input.workspace` 消费；类型由 cli 侧声明 `workspace: Workspace`。
* 根 tsconfig paths 与 cli dependencies 注册 `@harness/workspace-shell`。

### 测试与验证

* 新增插件 8 用例（workspace-shell）：render 输出与 ✓ 标记、命中/未命中/未注入分支、cli.commands 注册、id 稳定。
* cli 158 用例全过；全仓 20 包 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.1/§7.3

## 2026-09-02（续 52）工作区管理（三）：MultiDirLoader 通用多级目录加载器

> 承接续 51。落实规划文档 §7.4 的第一步——把 cli 与 core 各自重复手写的「readdir + 来源(user/project)标注 + join(dir,name)」多级扫描骨架收敛为 workspace 通用原语 `MultiDirLoader`，并让 cli 装配改走解析好的 workspace 路径（消灭 magic path）。

### 实现（@harness/workspace）

* 新建 `packages/workspace/src/multi-dir.ts`：
  * `DirSource = 'user' | 'project'`、`DirEntry{dir,source}`、`DirItem{source,name,full}`、`DirEntryInput`。
  * `normalizeDirs(dirs, defaultSource?)`：字符串 → `{dir,source}` 归一（缺省 source 可配，默认 user）。
  * `dirsFromPair([userDir, projectDir])`：`workspace.loadDirs` 目录对 → 两级 `DirEntry[]`。
  * `MultiDirLoader`：`scan({name?})` 同步枚举全部目录项并标注来源（目录缺失/不可读跳过，不阻塞）；`collect(parse, key, filter?)` 异步收集 + 按 key 去重（后扫描覆盖先扫描 → project 覆盖 user），`parse` 返回 undefined 忽略（容错）。
* `index.ts` 补 `export * from './multi-dir'`。

### core 修正：目录解析 `join → resolve`

* core 装配 agentDirs/skillDirs 用 `join(cwd, dirPath)` 解析——对**绝对路径会拼接在 cwd 下而错位**（`path.join('/a','/b') === '/a/b'`），导致 workspace 传入的绝对 user/project 目录不可达（并掩盖既有的 user 绝对目录 bug）。
* 改为 `resolve(cwd, dirPath)`：相对目录仍正确落在 cwd 下（行为不变），绝对目录正确原样命中。属严格修复，对齐「workflow dataDir 绝对化」诉求。

### 接入（cli）

* `loadPluginDirs` 内部改用 `MultiDirLoader(normalizeDirs(dirs)).scan(...)` 枚举（保留既有「按 id 去重 / 单模块容错 / Provider 类型注册」语义），删去手写 readdir 循环与不用的 `readdir` 导入。
* boot 装配外链插件 / agents / skills / buildCheckRegistry / teammate teamsDir：由 `join(home,'.harness','plugins')` 等硬编码改为 `this.workspace.user|project.{plugins,agents,skills}` 与 `app.workspace.files.teams`，`--data-dir` 覆盖真正生效；删去 cli 不再使用的 `homedir` 导入。

### 测试与验证

* 新增多级目录 8 条用例（multi-dir.test.ts）：normalize 缺省来源 / dirsFromPair / scan 枚举+来源标注+覆盖顺序 / filter.filter / 目录缺失跳过 / collect 去重覆盖 / parse undefined 忽略。workspace 共 13 用例全过。
* @harness/cli 158、@harness/core 31 用例全过；全仓 20 包 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.2/§7.4

## 2026-09-02（续 51）存储类工厂迁移：配置/会话/密钥存储消费 Workspace 路径

> 承接续 45 的 `resolveWorkspace`，落实「工作区管理（二）」：把 cli 里私有、硬编码 `join(dataDir, 'xxx')` 相对路径的 `ConfigStore` / `SessionFileStore` / `SecretCipher` / `ConfigValidationError` / `resolveSecret` 抽离到 `@harness/workspace`，改为消费 `Workspace` 解析出的路径（`ws.files.*`），消灭 magic path。

### 包形态（@harness/workspace）

* 新建 `packages/workspace/src/storage.ts`（仅「定位 + 读写」，不含业务装配），并加依赖 `@harness/session`（`Message` / `Session` 类型）；`index.ts` `export * from './storage'` 收敛导出。
* 导出（均构造于 `Workspace`）：
  * `ConfigValidationError`
  * `SessionFileStore`（`workspace.files.sessions`；`ensureDir/pathFor/toFile/save/load/list`）
  * `ConfigStore<T extends object>`（`workspace.files.config`；`load` 幂等返回空对象）
  * `SecretCipher`（`workspace.files.secretKey`；AES-256-GCM，主密钥来源 `HARNESS_CONFIG_KEY` 优先于 `.config-key`）
  * `resolveSecret(value, cipher)`（`${ENV_VAR}` 展开 / `enc:v1:` 解密 / 明文透传）

### 接入（cli）

* 移除本地 `ConfigStore` / `ConfigValidationError` / `SecretCipher` / `resolveSecret` 定义（`SessionFileStore` 同前已删），改为从 `@harness/workspace` 导入并**统一重导出**（`export { ... } from '@harness/workspace'`），对外含测试接口不变；同时删去 cli 侧不再使用的 `node:crypto` 导入。
* `HarnessApp` 新增 `workspace: Workspace`（`resolveWorkspace({ cwd, dataDir })` 构造），`sessionStore` / `permissionStorePath` / `configStore`（`ConfigStore<HarnessConfig>`）/ boot 的 `SecretCipher` 均改为消费 `this.workspace`。
* `runConfigCommand` 入参由 `dataDir`/`cwd` 收敛为 `workspace: Workspace`（`check` 子命令改用 `workspace.cwd`）；`main()` 复用既有 `ws` 构造 `ConfigStore<HarnessConfig>` / `SessionFileStore`。

### 测试与验证

* cli.test.ts 存储相关构造由传 `dir` 改为 `resolveWorkspace({ dataDir: dir })`。
* `@harness/workspace` 5 用例、`@harness/cli` 158 用例全部通过；两个包 typecheck 通过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md)（工作区管理（二）存储工厂）

## 2026-09-02（续 45）工作区管理（一）：@harness/workspace 核心库 resolveWorkspace

> 归属「工作区管理插件化」规划（docs/workspace-management.md §7）第一步——核心库「定位与解析」。用户选定先做 `resolveWorkspace`，其余存储工厂 / MultiDirLoader / 薄壳插件后续逐个推进。

### 包形态

* 新建 `packages/workspace`（`@harness/workspace`），仅做「定位与解析 + 目录布局」，不含 Provider/插件装配，不与 core/CLI 主逻辑耦合（对齐"全功能插件化"约束，借鉴 `@harness/snapshot`）。

### 实现（workspace/src/index.ts）

* `resolveWorkspace({ cwd?, dataDir? })`：`cwd` 缺省 process.cwd()、`dataDir` 缺省 ~/.harness，均 resolve 为绝对路径；项目级目录固定 `<cwd>/.harness`。
* 返回结构：
  * `cwd` / `dataDir`（用户级根）
  * `user` / `project`：两级 `WorkspaceLevel`（root / plugins / skills / agents）
  * `files`：dataDir 下全局数据文件/目录（config.json / permissions.json / sessions / .config-key / snapshots / file-snapshots / backups / teams）
  * `loadDirs`：两级扫描路径对（plugins/skills/agents，user 在前、project 在后，后者覆盖）
* 导出 helpers：`level(root)`、`dataFiles(dataDir)`、`defaultUserDir()`。

### 接入（cli）

* `main()` 删去硬编码 `dataDir = args.dataDir ?? join(home, '.harness')`，改用 `resolveWorkspace({ cwd, dataDir })` 取 cwd/dataDir，路径解析收敛至核心库。

### 配置

* `tsconfig.json` 增 `@harness/workspace` → `./packages/workspace/src` 路径映射。
* 依赖序：workspace 不依赖其他包（纯 node path/os）。

### 测试与验证

* 新增 5 条用例（workspace.test.ts）：两级目录 + 数据文件路径绝对化 / 两级扫描覆盖序 / dataDir 缺省 / 项目级与用户级目录独立 / helpers。全部通过。
* 全仓 typecheck 通过（含新包 + cli 接入）；@harness/cli 90 用例全过。

### 相关文档

* [docs/workspace-management.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/workspace-management.md) §7.2/§7.3

## 2026-09-01（续 44）config.json 的 agents[].tools 回读消费端

> 归属「/tools 可插件化（方案 A：补 core/CLI 配置接口）」第一步。先打通 Agent 白名单持久化的读取端。

### 调研结论（2026-09-01）

- core 的 `Harness` 接口无配置持久化访问器；`PluginContext.config.get/set` 仅是 `initialConfig` 种子的**内存 map**，set 不写盘，且 cli 调 `createHarness` 未传 `config`，运行期为 `{}`。
- config.json 唯一读写实现是 cli 私有 `ConfigStore`，不暴露给插件；`cli.command` 输入 `{raw,command,arg,out,sessionId}` 不含 dataDir/configStore。
- **缺口**：`HarnessConfig` 原无 `agents[]`，即使插件写入 Agent 白名单，cli 启动回读也无消费端 → 死数据。须先补读取端。

### 实现（cli）

- `HarnessConfig` 新增 `agents?: Array<{ id: string; tools: string[] }>`（Agent 工具白名单覆盖）。
- 新增 `HarnessApp.applyConfigAgentTools(harness)`：读 config.json → 对每项按 id 命中的已注册 Agent 用 `register({...existing, tools})` 覆盖 tools。**位置须在 createHarness 全部组装后、query 前**——工具池在 query 时经 `filterByWhitelist(agent.tools)` 实时读白名单，故可覆盖 default / options.agents / agentDirs（md）任何来源的同名 Agent。
- boot() 中 createHarness 后、`harness.start()` 前调用。

### 测试

- cli.test.ts：预置 config.json `agents:[{id:'default',tools:['bash','echo']}]`，boot 后断言 `harness.agent.get('default').tools` 被覆盖（缺省 `tools:['*']`）。

### 下一步

- 写 `/tools` 插件持久化端（upsert config.json 的 agents[].tools）+ `--global` 运行时启停（方案 B 所见即所得）。

## 2026-09-01（续 45）实现：/tools 工具管理插件

> 承接续 44 的回读消费端，按「可插件化」落地 `/tools` 命令。新增插件包 `packages/plugins/tools-manager`（`@harness/tools-manager`）。

### cli 侧注入能力

- `PluginContext` 无持久化接口，故在 `CliCommandInput`（`@harness/plugin`）扩展可选字段：`agentId`、`setAgentTools(agentId, tools)`、`harness`（unknown，由消费插件自行类型化）。
- `HarnessApp` 新增 `setAgentTools(agentId, tools)`：upsert config.json 的 `agents[].tools` 并即时 `register({...existing, tools})` 覆盖运行时（写盘 + 内存一次完成）。
- REPL 内核构造 `cli.command` 输入时注入上述三字段。

### tools-manager 插件（`/tools`）

- 经 `cli.commands` / `cli.command` hook 注册，按"全功能插件化"约束实现，不耦合 cli/core。
- 命令语义：
  - `/tools` → 当前 Agent 可用工具（filterByWhitelist）；`/tools --all`/`--json` → 全局注册清单。
  - `/tools <id>` → 详情（描述/别名/安全声明/启用态）。
  - 作用域 A（默认）：`/tools <id> on|off` → 改 agent 白名单并 `setAgentTools` 持久化。`off` 遇 `*` 白名单展开为显式（除目标外全部注册工具）后持久化。
  - 作用域 B：`/tools <id> --global on|off` → 运行时 `harness.tools.unregister/register`，插件内 `suspended` Map 缓存被卸载 Tool 供 on 恢复；不持久化，仅本轮进程。
- 安全声明为函数（`isReadOnly(isDestructive)`），展示时 `?.(undefined)` 求值。

### 注册

- 根 tsconfig `paths`、cli `dependencies` 注册 `@harness/tools-manager`；经 `BuiltinPluginRegistry` + boot 惰性加载。

### 测试

- tools-manager.test.ts 7 例：命令注册 / 空参列表 / `--global` off+on 往返 / 作用域 A off、on、通配展开 / 详情未找到。cli 86 例保持通过，全仓 typecheck 通过。

### 修复：命令处理后 fallthrough 到"未知命令"（2026-09-02）

- 现象：`/tools` 已输出工具列表，但 cli 仍打印 `未知命令：/tools`。
- 根因：cli 的 `cli.command` dispatch 只在 `cmdInput.result === 'continue'` 时认为命令已处理，否则落到 `未知命令`；tools-manager 未设置 `result`。
- 修复：hook 用 `try/finally` 统一在 `finally` 置 `input.result = 'continue'`，任何分支（含空列表）都不会 fallthrough。
- 测试：`run()` 返回 input，列表 / off 用例断言 `result === 'continue'`，防止回归。

## 2026-09-02（续 46）优化懒加载：后台静默加载 + 多级加载（描述提前加载）

> 承接续 45 的 `/tools`。目标是让启动更快、`/tools` 信息即时可看：把「静态元信息」与「运行时模块」拆成两级加载。

### 问题

- `/tools` 依赖运行时工具模块（L2）加载完成后才有 `harness.tools`，懒加载切换期间 `/tools` 未显示/滞后显示工具信息。
- 内置插件用 `lazyImport` 惰性加载，但缺少"描述提前可用"与"失败静默"机制。

### 设计：多级加载（L1 描述 / L2 模块）

- **L1（静态元信息，启动即可用）**：新增 `packages/plugins/tools-builtin/src/meta.ts` —— 纯静态 `BUILTIN_TOOL_META`（id/描述/别名/安全声明/权限键），**无副作用、不 import index.ts**（保证不含 `node:child_process` 等重依赖）。经子路径 `@harness/tools-builtin/meta` 导出（package.json `exports` + 根 tsconfig `paths`）。
- **L2（运行时模块，惰性/后台）**：`BuiltinPluginRegistry` 的 `load()` 动态 import 真正的工具实现，保持不变。
- cli 新增 `BuiltinToolRegistry`（实现 `ToolMetaLookup`）：`boot()` 早期 `getBuiltinToolRegistry()` 同步登记全部内置工具 meta；REPL 的 `cli.command` 输入注入 `toolMeta`。

### 后台静默加载

- `HarnessApp.scheduleBuiltinPreload()`：boot 末尾 **fire-and-forget** 后台预加载内置插件/工具，经 `Promise.allSettled` 采集，失败仅写 `[WARN]`，不阻塞 boot、不抛错。`options.backgroundPreload === false` 可关闭。

### tools-manager 合并展示

- `/tools --all`/`--json`：`unionTools(已加载, toolMeta)` 合并未加载的内置工具（`(meta)` 标记）。
- `/tools <id>` 详情：运行时未加载时回退内置 meta（标注"运行时未加载，以下为内置静态元信息"）。
- 归一化 `entryFlags`：兼容运行时 `isXxx`（函数）与 meta `isXxx`（布尔）两种形态。

### @harness/plugin 扩展

- `CliCommandInput` 新增可选 `toolMeta?: ToolMetaLookup`；导出 `ToolMetaEntry` / `ToolMetaLookup` 类型。

### 测试

- tools-builtin `meta.test.ts` 4 例：登记表覆盖全 / 非空 / 长度一致 / 静态安全字段。
- cli 新增 2 例：`BuiltinToolRegistry` 同步登记+别名查找；`backgroundPreload` 后台预热有日志、`false` 关闭无日志且 boot 不阻塞。
- 全量 typecheck 通过；tools-builtin（60）/ tools-manager（7）/ cli（155）测试通过。

## 2026-09-02（续 47）补全工具元信息 + /tools 状态列（元信息可提前加载覆盖全场景插件）

> 承接续 46 的多级加载（L1 元信息 / L2 运行时）。把"元信息可提前加载 + `/tools` 显示完整元信息"从工具内置原语扩展到全部随应用打包的场景化工具插件。

### 补全其他插件的工具元信息（L1）

- 新增 4 个场景工具插件各自的 `meta.ts`（纯数据、不 import 各自 index.ts，对齐 `@harness/tools-builtin/meta` 的 `BuiltinToolMeta` 结构）：
  - `@harness/tools-search/meta`：`list_dir`、`grep_file`（只读，权限键 `read`）
  - `@harness/tools-glob/meta`：`glob`（只读，权限键 `read`）
  - `@harness/tools-web/meta`：`web_fetch`（非只读/非危险，权限键 `network`）
  - `@harness/tools-media/meta`：`view_image`（只读，权限键 `read`）
- 各 package.json `exports` 新增 `./meta` 子路径；根 `tsconfig.json` `paths` 注册 `@harness/tools-*/meta`。
- cli `getBuiltinToolRegistry()` 启动早期一次性 `registerAll` 全部工具 meta（内置原语 + 场景插件），无需加载任意 L2 运行时模块即可在 `/tools` 展示描述/别名/安全声明/权限键。

### /tools 列表：元信息 + 状态列

- 列表改为对齐表格：`ID | 元信息(描述) | 权限键 | 状态`。
- **状态列** = 启用/禁用（相对当前 Agent 白名单）· 加载状态（`已加载` / `仅元信息`）· 安全声明（只读/危险/非并发）：
  - 未加载的元信息占位仅在 Agent 白名单为通配 `*` 时视为"启用"，否则"禁用"。
- 详情视图补齐：已加载工具也输出 `权限键` 行；未加载工具回退静态元信息输出描述/别名/权限键/安全。
- 归一化 `entryFlags` + 新增 `permKeyOf` / `entryLoaded` / `entryStatus` / `renderToolTable`。

### 测试

- 4 个场景插件各新增 `meta.test.ts`：覆盖工具 id/描述/只读/并发/权限键。
- cli `BuiltinToolRegistry` 测试扩展断言 search/glob/web/media 工具及其权限键。
- tools-manager 新增 2 例：列表含"状态/权限"列与 `启用·已加载`；`--all` 合并未加载元信息显示 `仅元信息` 且详情含权限键。
- 本批涉及测试全部通过；全量 typecheck 通过（存量 TUI/dom 第三方测试失败与本批无关）。

## 2026-09-02（续 48）修复：/tools 元信息、Agent 可用工具、computer-use 元信息、后台预加载、命令历史

> 承接续 47。用户反馈 4 个问题：1) `/tools` 未打印元信息且 Agent 可用工具受懒加载影响；2) computer-use 的 MCP 工具元信息需补充；3) 懒加载的后台加载功能未生效；4) 命令历史无法上下切换。

### 1) `/tools` 打印元信息 + Agent 可用工具不受懒加载影响（tools-manager）

- 原列表默认走 `filterByWhitelist`，只输出**已加载**工具 → 懒加载期间大量工具"消失"、元信息缺失。
- 新增 `agentUsableEntries(inp)`：合并「已加载且在白名单内的运行时工具」+「白名单内未加载的静态元信息」，补齐描述。
  - 通配 `*` 白名单 → 全部静态元信息（`unionTools`）；显式白名单 → 仅补白名单内未加载的工具。
- `entryStatus` 修正：未加载但显式在白名单的元信息工具标记为 `启用·仅元信息`（原只有通配 `*` 才算启用）。

### 2) computer-use MCP 工具元信息补充（L1）

- 新增 `packages/plugins/computer-use/src/meta.ts`：登记 11 个 MCP 工具（`mcp__computer-use__<toolName>`）的静态元信息（只读/可写、非并发、权限键）。
- `package.json` `exports` 新增 `./meta` 子路径；根 `tsconfig.json` `paths` 注册 `@harness/computer-use/meta`。
- cli `getBuiltinToolRegistry().registerAll` 追加 `COMPUTER_USE_TOOL_META`，使 `/tools` 在 server 未连接加载时也能展示其描述/安全/权限键。
- 新增 `meta.test.ts` 覆盖 id 前缀/非空描述/只读语义/唯一性。

### 3) 懒加载的后台加载功能未生效（cli）

- 根因：`BuiltinPluginRegistry` 只登记 `tools-builtin` 与 `tools-manager`，而这两者已在 boot 早期被**急切加载**，故 `scheduleBuiltinPreload` 实际上"无事可预热"。
- 修复：把随应用打包的场景化工具插件并入 `BuiltinPluginRegistry`（`tools-search` / `tools-glob` / `tools-web` / `tools-media`），使 boot 末尾的后台预加载真正 `lazyImport` 预热这些运行时模块，不再停留在"仅元信息"。

### 4) 命令历史无法上下切换（TUI）

- `tui.tsx` 模块 C：移除输入框为空的限制，允许输入内容时用 ↑ 回看 / ↓ 前进历史命令；输入任意字符即取消回看（`onInput` 重置 `histIdx`）。

### 测试与提交

- 根 `bun run typecheck` 全部通过；`@harness/cli`（88 例）、`@harness/tools-manager`（9 例）、`@harness/computer-use`（12 例）测试全绿。

## 2026-09-02（续 49）修复：后台预加载仍未生效 + 命令历史仍只回看一条

> 承接续 48。用户复测反馈两个问题仍未解决：1) `/tools` 一直显示「仅元信息」，手动发一条消息后才变「已加载」，且 `list_dir` 等场景化插件工具始终「仅元信息」；2) 命令历史 ↑ 仍只能取到最近一条。

### 1) 后台预加载仍未生效：工具只在首条消息后才注册（core + cli）

- 根因：续 48 的 `scheduleBuiltinPreload` 只 `lazyImport` **预热模块**（缓存 import），但**没有把预加载出的插件安装进 Harness，也没有触发工具注册**；而 `tool.pool.assemble` Hook 只在用户首条消息（query 内）才执行，故 `/tools` 一直停在「仅元信息」，`list_dir` 等场景插件也始终未注册。
- 修复（core）：`Harness` 新增 `assembleTools()`——遍历所有 Agent 触发 `tool.pool.assemble`，把插件工具注册进全局 `ToolRegistry`（幂等，`DefaultToolPool.add` 只注册尚未注册的工具）。
- 修复（cli）：`scheduleBuiltinPreload` 预加载完成后：① 把未安装的插件经 `harness.plugin.loadInternal()` 安装；② 调用 `harness.assembleTools()` 主动组装工具池。这样 boot 后无需首条消息，`/tools` 即显示「已加载」，`list_dir`/`grep_file`/`glob`/`web_fetch` 等开箱即用。
- 场景化插件依赖补齐：cli `package.json` 增加 `@harness/tools-search|glob|web|media`，根 `tsconfig.json` 增加对应 `paths`（此前 `lazyImport` 报 `Cannot find module`）。

### 2) 命令历史仍只回看一条：`__HISTLOG` 未定义导致每次 render 抛 ReferenceError（tui）

- 根因：`tui.tsx` 残留调试用的 `__HISTLOG.push(...)`，但 `__HISTLOG` 从未定义，导致 `TuiApp` **每次 render 都抛 `ReferenceError: __HISTLOG is not defined`**，历史导航与整个 TUI 渲染实质失效（测试也因 `waitFrame` 捕获到该异常超时）。
- 修复：移除三处 `__HISTLOG` 调试残留（submit / render 主体 / onInput）。
- 同时保留续 48 的导航机制并补齐细节：`histIdxRef` 同步真源（连按/自动重复 ↑ 逐级回看）+ `programmaticValueRef` 区分程序式 value 变更与用户输入（避免 OpenTUI `InputRenderable` 的 value setter 触发 `onInput` 立即重置回看索引）；↓ 到底部退出回看恢复当前输入。

### 测试与提交

- 新增 REPL 级集成测试：boot 后等待预加载完成直接 `/tools`，断言 `read_file` 与 `list_dir` 均显示「已加载」且非「仅元信息」；新增 TUI 历史导航集成测试（连按 ↑ 逐级回看 → ↓ 前进 → 底部 ↓ 退出回看）。
- 根 `bun run typecheck` 全部通过；`@harness/cli`（cli.test + tui.test 共 158 例）、`@harness/core`（31）、`tools-manager`（9）、`tools-search`（15）、`tools-builtin`（60）测试全绿。

## 2026-09-02（续 50）重构：工具元信息经抽象接口解耦（ToolMetaSource / ToolMetaRegistry）

> 承接续 49。用户提出：core/cli 里直接 `import { builtinToolMetas, type BuiltinToolMeta } from '@harness/tools-builtin/meta'`、`import { SEARCH_TOOL_META as searchToolMetas } ...` 等 6 处硬编码元信息导入，可用抽象接口解耦。

### 抽象契约（@harness/plugin）

- 新增 `ToolMetaSource`：插件包以统一契约暴露内置工具静态元信息（`{ id, description?, list(): ToolMetaEntry[] }`），自描述、不暴露具体数组结构。
- 新增 `ToolMetaRegistry` + `createToolMetaRegistry()`：CLI 经此抽象登记（`registerSource`）/查询（`get` 含别名反查 / `list` / `size`）。
- `BuiltinToolMeta` 已结构兼容 `ToolMetaEntry`（`ToolMetaEntry.description` 可选），无需改元数据字段。

### 各插件 meta 模块（L1，纯数据）

- `tools-builtin` / `tools-search` / `tools-glob` / `tools-web` / `tools-media` / `computer-use` 各自新增导出 `toolMetaSource: ToolMetaSource`（`list()` 复用既有 `*_TOOL_META`/`builtinToolMetas`），原有数组导出保留供既有测试与引用使用。

### cli（消费端）

- 移除对具体数组/类型的硬编码导入（`builtinToolMetas`、`SEARCH_TOOL_META` 等、`type BuiltinToolMeta`），改为仅消费 `toolMetaSource` 抽象契约。
- `BuiltinToolRegistry` 实现 `ToolMetaRegistry`（内部存储统一为 `ToolMetaEntry`），新增 `registerSource()`；`getBuiltinToolRegistry()` 改为逐个 `registerSource(...)` 登记 6 个来源，不再手工展开数组。

### 测试

- `@harness/plugin` 新增 4 例：`createToolMetaRegistry` 合并来源 / id+别名反查 / 多来源覆盖 / 纯静态来源实现契约。
- 6 个插件包各新增 1 例：`toolMetaSource.id` 与 `list() === 既有元信息`。
- cli `BuiltinToolRegistry` 测试补充 `registerSource` 合并断言。
- 根 `bun run typecheck` 全部通过；`@harness/plugin`（42）、`@harness/cli`（158）、`tools-builtin`（61）、`tools-search`（16）、`tools-glob`（12）、`tools-web`（16）、`tools-media`（11）、`computer-use`（13）测试全绿（存量 reference/ 第三方测试失败与本批无关）。

## 2026-08-31（续 43）开发计划：workspace 与 codeintel 插件化

> 状态：规划（待实现）。用户要求：workspace 与 codeintel 都规划成插件实现（对齐"全功能插件化"约束）。

### workspace 插件化（`@harness/workspace`）

- 「核心库 + 薄 AgentPlugin 壳」双形态：核心库只做定位/解析/存储；`createWorkspacePlugin(opts)` 薄壳复用 `harness.init`/`cli.commands` 提供 `/workspace` 命令与生命周期。
- 从 cli 抽离：路径解析、ConfigStore/SessionFileStore/SecretCipher、权限持久化路径、`MultiDirLoader`（多级扫描+来源+覆盖收敛）。
- 基础设施插件特殊性：cli 需在 harness 创建前预创建服务（路径先行），再以 internal/builtin 装载薄壳。
- 详见 [workspace-management.md](docs/workspace-management.md) §7。

### codeintel 插件化（`@harness/code-intel`）

- 独立插件包 `packages/plugins/code-intel`，引入 AST（推荐 web-tree-sitter）——该层唯一引入 AST 处。
- 注入只读工具：`code_symbols` / `code_reference` / `code_definition`（+v2 可选 `code_semantic_edit`）。
- 详见 [codeintel-plugin.md](docs/codeintel-plugin.md)。

### 相关文档

- [docs/workspace-management.md](docs/workspace-management.md)、[docs/codeintel-plugin.md](docs/codeintel-plugin.md)

## 2026-08-31（续 42）开发计划：/tools 工具管理命令

> 状态：计划（待实现）。用户已确认范围：查看 + 启停 + 其他；启停作用域双轨（当前 Agent 白名单持久化 + 全局工具池运行时）；仅 REPL、暂不 TUI 面板。

### 目标

提供 REPL 工具管理命令 `/tools`，查看可用工具、查看详情、按 Agent 白名单或全局启停、并提供结构化/权限联动等扩展。

### 命令语法

```
/tools                          # 列出当前 Agent 可用工具（filterByWhitelist(agent.tools)）
/tools --all                    # 列出全局注册的全部工具（harness.tools.list()）
/tools --json                   # 与上一视图同，JSON 结构化输出
/tools <toolId>                 # 详情：描述/文档/别名/权限key/安全声明/来源/启用态
/tools <toolId> on              # 作用域A：加入当前 agent.tools 并持久化（已在则幂等）
/tools <toolId> off             # 作用域A：从当前 agent.tools 移除并持久化
/tools <toolId> --global on|off # 作用域B：全局工具池运行时 register/unregister（本次进程生效）
/tools --permission <key>       # 联动查看某权限 key 的规则（读 permissions.json）
```

### 查看字段与局限

* 列表列：`id`、描述（截断）、来源（内置/插件，见下）、权限 key、安全声明（isReadOnly / isDestructive / isConcurrencySafe）、启用态（agent 白名单禁用 / 全局禁用 / 正常）。

* 详情额外：`documentation`、`aliases`。

* **局限**：内置工具 inputSchema 为 `makeSchema` 轻量透传（非 zod），无法内省字段结构，schema 字段暂不展示。

### 作用域 A — Agent 白名单持久化（on/off 默认路径）

* 复用 `setModel` 模式：读 `harness.agent.get(agentId)` → 改 `def.tools` → 持久化到 config 中对应 agent 定义的 `tools`（同在 configStore 装配 agents）。

* `off`：`def.tools` 非 `'*'` 时 `filter(t => t !== id)`；为 `'*'` 时转为显式 `['*', ...]` 后再剔除，或提示先转显式白名单。

* `on`：`def.tools` 为 `'*'` 或已含 id 则幂等；否则加入 `def.tools` 并持久化。

### 作用域 B — 全局工具池运行时（--global on|off）

* HarnessApp 新增 `setToolGlobalEnabled(id, on)`：`off` → `harness.tools.unregister(id)` 并缓存原 Tool 至内存 Map；`on` → `register(缓存对象)`。

* 仅本次进程生效、不持久化；与作用域 A 正交独立。

### 来源标注

* 第一版：从注册登记表/插件清单匹配工具 id 推断「内置 / 插件」，或扩展 `tool.pool.assemble` 记录来源；下限不强制精确，先标 registry 维度。

### 实施步骤

1. `packages/cli/src/index.ts`：`HarnessApp` 增 `toolInfos(opts)`、`setAgentToolsTool(id, on)`、`setToolGlobalEnabled(id, on)` 三个方法 + 工具来源推断 helper。
2. REPL dispatch 增 `case '/tools'`，解析子命令（list / <id> / on / off / --global / --all / --json / --permission）。
3. 持久化：定位 config 中 agents 的 `tools` 读写（对齐 `/model` 持久化机制），实现 Agent 白名单落盘。
4. 测试（`cli.test.tsx`）：`/tools` 列出内置工具 / 详情 / `<id> off` 持久化到 agent def 与 config / `--global off` 从 registry 移除且可 `on` 恢复 / `--all` 清单 / `--json`。
5. 文档：记录本计划到 development-log；实现完成后在 AGENTS.md 补 `/tools` 约定。
6. 全量 typecheck + test（跑测试补 `PATH=/bin:/usr/bin`）。

### 安全注意

* 全局 off 影响所有 agent，需明确提示。

* 不禁止标注：是否允许禁用 read\_file/write\_file/bash/edit\_file 等核心工具由用户决定，不在命令层强制。

### 可插件化结论（调研 2026-08-31）

`/tools` **可以做成可插拔插件**，且是更优形态（对齐"全功能插件化"，可经 `/plugins` 启停）：

- **既定模式**：`mcp-client /mcp`、`subagent /tasks`、`mcp-server-registry` 已用 `cli.commands`（注册命令）+ `cli.command`（处理命令）实现，`/tools` 照此即可。
- **harness 可达**：插件经 `harness.init` hook 捕获 `output.harness`，即可访问 `harness.tools`（register/unregister）与 `harness.agent`——查看 + `--global` 运行时启停全在插件内完成，不再需要 HarnessApp 私有方法。
- **唯一张力 —— Agent 白名单持久化**：插件不持有 cli 的 `ConfigStore`（provider/model/permissions 专用），`on/off` 写回 config.json 需二选一：
  1. **插件自持**：用 workspace 解析的 `dataDir` 直接读写 config.json 的 agent.tools（推荐，自包含，与 workspace 插件协作）；
  2. 保留该子命令在 cli 内置，插件只做查看 + `--global`。
- 落点调整：`toolInfos / setToolGlobalEnabled` 等 helper 移进 `/tools` 插件；HarnessApp 不再新增方法；REPL 内置不再加 `case '/tools'`。

### 相关文档

* [docs/agent-harness-architecture.md](docs/agent-harness-architecture.md)

## 2026-08-31（续 41）：bash 宿主回退前权限确认（requireHostApproval）

(user-request) 宿主 bash 回退会把"沙箱约束已批准"的命令提升到更特权环境执行，需在 ask 模式提示确认。

### 实现（tools-builtin）

* `BashSandboxConfig` 新增 `requireHostApproval?: boolean`（默认 true）。

* 新增 `confirmHostRun(input, ctx, config)`：宿主回退前调用 `ctx.requestPermission`，复用 bash 权限 key，pattern 前缀 `host:` 标识宿主回退执行；`decision.behavior === 'deny'` 拦截（返回 `SANDBOX_HOST_DENIED`），否则放行。无 `requestPermission`（纯工具调用）或 `requireHostApproval=false` 时静默放行。

* 白名单拦截回退、沙箱非零退出回退两个分支均接入确认；危险命令检测仍前置硬性拒绝、不进入确认环节。

### 行为

* ask 模式：宿主回退再次询问用户；allow：静默放行；deny：拦截宿主回退。

### 测试与验证

* 新增 3 条用例：requestPermission deny 拦截返回 SANDBOX\_HOST\_DENIED / allow 放行并标 viaHost / requireHostApproval=false 即使 deny 也宿主回退。

* tools-builtin 49 用例 + typecheck 通过。

### 相关文档

* [AGENTS.md](AGENTS.md)、[docs/agent-harness-architecture.md](docs/agent-harness-architecture.md) §十三

## 2026-08-31（续 40）：补全架构文档 + 工作区管理调研 + bash 沙箱宿主回退

(user-request) 三项：①将最近提交中未记录的功能补进架构文档、提取规则到 AGENTS.md；②调研工作区管理模块并输出开发文档；③沙箱非破坏性命令失败后尝试提升宿主 bash 执行。

### 架构文档补全（agent-harness-architecture.md）

* 新增 §十二「命令审批交互链路」：check→ask 两步判定、safeExecuteTool 兜底、CliPermissionEngine、TUI 审批模态。

* 新增 §十三「bash 沙箱安全防护与宿主回退」；新增 §十四「TUI 增强落地补全」（续 33\~38 + 续 35：复制/选区/欢迎页/用量统计/命令回显）。

* 新增 §十五「工作区 / 数据目录管理」（索引独立文档）。

* 在 §十一 末尾补实现状态（模块 A\~E 已落地）。

### 提取规则到 AGENTS.md

* 补充「check→ask 权限判定」「safeExecuteTool 兜底」「ToolPermissionDeniedError 用错误名判定」「permissions.json / /permission」「bash 沙箱 createBashTool 多层防护 + fallbackToHost 宿主回退 + viaHost」「bash ok 语义」「workspace 两级目录与 dataDir 约定」等规则。

### 工作区管理模块调研（workspace-management.md）

* 整理 dataDir（\~/.harness）与 project（<cwd>/.harness）两级布局、各数据存储（sessions/config/permissions/.config-key/snapshot）、plugins/skills/agents 两级加载与覆盖规则。

* 明确可抽成 `@harness/workspace` 的边界（只负责定位与解析，不含装配逻辑）。

### bash 沙箱宿主回退（tools-builtin）

* `createBashTool(config)` 新增 `fallbackToHost`：沙箱内非破坏性命令被白名单拦截 / spawn 失败 / 命令非零退出（如敏感 env 被隔离）时，提升到宿主 bash（放开白名单与 env 隔离、含系统 PATH）重跑，并在 `BashOutput.viaHost` 标注。

* 危险命令检测前置硬性拒绝，宿主回退也不可豁免（安全红线）。

* 修正 refactor 引入的 `ok` 语义：保持「执行成功即 ok:true，命令结果由 exitCode 反映」，回退触发改用 `exitCode !== 0` 判定，避免破坏既有用例（超时 kill、命令非零退出）。

### 测试与验证

* tools-builtin 新增回退用例：白名单外命令宿主回退 / 危险命令不可回退 / env 隔离致非零退出后宿主回退成功并标 viaHost。

* tools-builtin 46 用例通过 + typecheck 通过（跑测试需补 `PATH=/bin:/usr/bin`，本机 shell PATH 被精简）。

### 相关文档

* [docs/agent-harness-architecture.md](docs/agent-harness-architecture.md)

* [docs/workspace-management.md](docs/workspace-management.md)

* [AGENTS.md](AGENTS.md)

## 2026-08-31（续 39）：命令审批交互 + bash 沙箱安全防护

(user-request: 完善沙箱功能及命令审批) 本轮补齐「命令审批」的完整交互链路与「bash 沙箱」的多层安全防护。

### 权限链路：check → ask 两步判定 + 工具异常兜底

* `core` 新增 `resolvePermission`：先 `engine.check(req)`，命中非 ask 直接返回；需询问时调 `engine.ask(req)` 交上层交互。

* 三处工具执行入口（agent loop 内联工具调用 + 后置 parsed 工具调用 + `HarnessImpl` 的 `ToolPipeline.checkPermission`）统一改走 `resolvePermission`，权限请求不再止步于 `check`。

* `core` 新增 `safeExecuteTool`：把权限拒绝 / 未知异常归一化为失败的 `ToolResult`（`PERMISSION_DENIED` / `TOOL_ERROR`），作为 tool error 反馈 LLM 而非中断 agent 流；用错误名判定 `ToolPermissionDeniedError`，避免依赖类绑定。

### CLI 权限引擎

* `CliPermissionEngine` 支持 `allow-all / ask / deny-all` 三模式；`ask` 时交互支持 `allow / deny / always(a) / deny-always(d)`，永久选择写回规则并落盘 `permissions.json`。

* 新增 `setAskPrompt` 允许上层替换默认 readline 行内提问（给 TUI 注入模态审批用）；新增 `/permission` 命令查看/切换模式、设置规则、reset。

### TUI 审批模态

* `TuiApp` 注入 TUI 版 `askPrompt`：权限引擎 `ask()` 触发时把问题投递为审批弹窗并挂起 Promise。

* 全局快捷键在审批挂起期间吞掉所有按键，仅响应 `y`（允许）/ `n`/`Esc`（拒绝）/ `Shift-y`（始终允许）/ `Shift-n`（始终拒绝）。

### bash 沙箱（tools-builtin，`createBashTool(config)` 工厂）

* **危险命令检测**：默认正则表拦截 `rm -rf /`、fork bomb、`mkfs.*`、裸盘 `dd`/重定向、`shutdown/reboot`、`curl|bash`、`sudo rm -rf` 等；支持 `additionalDangerous` 追加并可用 `dangerousDetection:false` 关闭。

* **cwd 限制**：cwd 必须位于 `rootDir`（默认 `ctx.cwd`）内，防路径逃逸，命中返回 `SANDBOX_CWD`。

* **env 隔离**：从继承环境过滤敏感变量（AWS/GitHub/OpenAI/API\_KEY/PASSWORD/PRIVATE\_KEY 等），可 `keepEnv` 保留必要变量、`sanitizeEnv:false` 关闭。

* **命令白名单**：配置 `allowlist` 后仅首命令名或完整片段命中的命令可执行，其余返回 `SANDBOX_ALLOWLIST`。

* 导出 `createBashTool` 工厂后，原 `bashTool` 改为默认实例，插件可通过 `createToolsBuiltinPlugin({ bash: config })` 注入受限配置。

### 测试与踩坑

* tools-builtin 新增「bash 沙箱防护」套件：危险命令检测 / cwd 限制 / 白名单 / env 隔离（含 keepEnv）/ 插件级 bash 配置注入 / 端到端。

* cli 新增「/permission」命令用例与 TUI 审批模态用例（ask 弹窗 → `y` 允许后工具执行、`n` 拒绝后工具被拒）。

* TUI 审批模态用例一度超时：mock 工具型回复 `response:''`，工具执行后**没有**后续 assistant 正文，而断言误等「你好」；改为断言工具结果的 `stdout`（允许）与 `权限被拒绝`（拒绝）后稳定通过。

* 某终端 `PATH` 被精简（缺 `/bin`），`spawn('bash')` 报 `Executable not found in $PATH`，纯环境问题，非代码缺陷；跑片段用完整 PATH 验证。

### 相关文档

* [docs/agent-harness-architecture.md](docs/agent-harness-architecture.md)

## 2026-08-30（续 38）：TUI 命令输入回显 — 命令进入对话历史并触发欢迎页切换

用户反馈：TUI 对话历史里看不到 `/` 命令发送记录；新会话执行命令时欢迎页不消失，只有发普通消息才切换。

### 根因

`createProcessLine` 命令分支只输出命令结果，不回显命令输入。TUI 捕获按键生成输入（不经过终端原生回显），因此命令从未作为 user 块进入聊天区。而欢迎页切换条件 `hasChat = blocks.some(kind !== 'system')` —— 命令结果多为 system/文本块，无法触发切换。

### 修复

* `createProcessLine` 命令分支开头，在 TUI 模式（`options.onEvent` 存在，REPL 靠终端原生显示不重复回显）回显 `🧑  ${line}` 为 user 块：

  * 命令输入随之出现在对话历史；

  * 产生非 system 块 → 欢迎页在执行首个命令时即切换（与发消息一致）。

### 验证

* cli+tui 新增「命令输入回显为 user 块，并触发欢迎页切换」集成测试；全量 **144 用例通过**，typecheck 通过。

## 2026-08-30（续 37）：修复 `/resume` 恢复会话后发送报 `Session not found`

TUI/REPL 中用 `/resume` 恢复持久化会话后，发送消息报 `Session "<id>" not found`（会话恢复成功但无法继续对话）。

### 根因

`SessionManager` 用 `Map<id, Session>` 索引会话，键是 `create()` 生成的临时 id。CLI 恢复会话时先 `create` + `addMessage` 回填，再 `(session as any).id = savedId` 裸改对象 id —— **只改了对象属性、未同步 Map 键**。因此按 `savedId` 调用 `promptStream`/`prompt` 时 `get(savedId)` 返回 undefined 抛出 `Session not found`。`boot()` 的 `--session` 恢复路径存在同样的隐患。

### 修复

* `@harness/session` `SessionManager` 新增 `setId(oldId, newId)`：校验存在后同步删除旧键、改写 `session.id`、设新键，返回重命名后的会话。

* `@harness/core` `DefaultSessionManager.setId` 实现；`packages/revert` 的 `FakeSessionManager` 补齐该接口。

* `packages/cli` `boot()` 与 `/resume` 命令用 `await session.setId(tmpId, savedId)` 替代裸改 `(session as any).id = savedId`。

### 验证

* core 新增 `setId` 单测（重命名后新 id 命中/旧 id 失效 + 不存在抛错）；cli 新增 `/resume 恢复后发送` 集成回归测试。

* cli **143 用例**、core 31、revert 10 全通过，全 repo typecheck 通过。

## 2026-08-30（续 36）：统计命令健壮性修复 — `/stats-export` 无参数崩溃 + 报错信息可复制

续 35 交付后，用户反馈：`/stats-export` 命令报错，且 TUI 中报错堆栈渲染到了聊天框、报错信息无法复制。

### 修复 1：`/stats-export` 无参数 TypeError

* 根因：`const [cmd, arg] = line.split(/\s+/, 2)` 在无参数时 `arg === undefined`，命令分支内 `arg.trim()` 抛 TypeError。

* 修复：`(arg ?? '').trim().split(/\s+/)`，与 `default` 分支（插件命令兜底）的既有写法保持一致。

### 修复 2：命令异常友好处理，抑制裸堆栈上屏

* `if (line.startsWith('/'))` 命令分支整体包 `try/catch`，命令抛异常时输出 `❌  /<cmd> 执行失败：<message>` 并返回 `'continue'`，避免异常向上传播到 TUI 渲染层打印凌乱堆栈、破坏输入队列。

### 修复 3：报错信息可复制

* TUI `renderBlock` 的「复制」按钮由仅 user/assistant 块扩展到 **tool 块**（`🔧`/`✅`/`❌` 前缀归类），因此命令错误（以 `❌` 开头，归为 tool 块）也能一键复制到剪贴板。

### 验证

* cli+tui 全量 **142 用例通过**（新增 `/stats 与 /stats-export（无参数）正常工作且不崩溃`），typecheck 通过。

## 2026-08-30（续 35）：用量统计增强 — 会话级持久化 + 多维度时序 + 报告导出 + 侧栏图标 tab

在既有「侧栏统计面板」（本地估算 + 消息数/token/任务/用时）基础上，将统计从「本地估算」升级为「本地 + API 实际用量 + 多维归并」，并新增会话级持久化与报告导出，同时把侧栏各模块改为顶部图标 tab 切换。

### M1：扩展 TokenUsage 缓存明细并贯通链路

* `@harness/core` `TokenUsage` 新增 `cacheRead`（命中缓存输入 token）、`cacheWrite`（写入缓存输入 token），`query` / `queryStream` 的 done 事件透出；未命中缓存 = `input - cacheRead - cacheWrite`。

* provider 映射各自的缓存字段：anthropic（`usage.cache_read_input_tokens` / `cache_creation_input_tokens`）、openai/gemini/qwen（`prompt_tokens_details.cached_tokens` 等）、mock 支持模拟缓存。

### M2：UsageStats 累积器（`packages/cli/src/usage-stats.ts`）

* 统计粒度：**单轮 llm 对话**（每条 done = 一次 `llmCalls`）→ **一次 agent 任务**（agents 维度 `calls`/`tasksDone`）→ **会话级别**（整体聚合）→ **工具维度 token 用量**（本轮用量归并到紧随的工具调用）。

* 维度：`models[]` / `agents[]` / `tools[]`（含失败数）/ `hourly[]`（小时时序）。

* 纯函数 `emptyUsage` / `recordCall` / `recordTool` / `recordTaskDone` / `uncachedInput` 及格式化 `modelUsageRow` / `toolUsageRow` / `agentUsageRow` / `hourLabel` / `hourlyRow` / `sparkline`，便于单测。

### M3：TUI 接线 + 侧栏渲染

* `TuiApp.onEvent` 累积：`done` → `recordCall`（读 `message.meta.model` / `tokenUsage`）；`tool_call_result` → `recordTool`（含 `isError`，失败只计错误数）；agent 任务完成 → `recordTaskDone`。

* 统计面板展示：LLM 调用、缓存命中/写入/未命中、按模型、按 agent/任务、按工具、按小时迷你条形时序。

### M4：会话级持久化 + `/stats` 与 `/stats-export`

* 用量变化时写入 `session.meta[usageStats]` 并防抖（800ms）落盘，恢复/切换会话后 `/stats` 仍能读到历史。

* `/stats` 输出纯文本报告；`/stats-export [md|json] [path]` 导出 Markdown/JSON（默认打印，给定 path 写文件）。`usageFromMeta` / `usageFromMessages` 供未走 TUI onEvent 的场景反推统计。

### M5：侧栏顶部图标 tab

* 侧栏各模块（会话上下文/会话/任务/文件/统计）改为顶部图标 tab + 左右切换（◀/▶）与 Tab 进入列表的互斥逻辑。

### 设备与验证

* cli+tui 全量 **141 用例通过**、全 repo typecheck 通过。

* 修复两个 TUI 集成测试竞态：初始渲染后被动 effect（`useKeyboard` 订阅）异步 flush，`mountTui` 新增 `settleEffects` 统一 pump 拍数，消除「按下按键时钩子未注册」导致的 `Ctrl-B 切换侧栏面板` 失败。

## 2026-08-28（续 30）：TUI 交互增强（开工 + 模块 A/B 落地）— 方案定案并推进

用户盘点 TUI 缺口后，确认本期覆盖四项：后台任务实时面板、会话列表切换、输入体验（/命令菜单 + 历史）、帮助面板 + 复制辅助。鼠标点击/选区复制与 OpenTUI 多行输入依赖底层 API，列入后续增强。方案细节（能力边界、各模块落点、验证计划）已写入 [architecture §十一](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/agent-harness-architecture.md#L1024-L1070)。实现按模块 A→B→C→D 推进，每模块补 `tui.test.tsx` / `cli.test.tsx` 用例并 typecheck。

### 模块 A：侧栏后台任务实时面板（完成）

* `tui.tsx` 订阅 `subagentCapability.createMonitor`，任务状态并入 React state 滑入侧栏「后台任务」块；`⏳/✅/❌` + taskId + agentName + 进度步数，进行中置顶限量。

* 纯函数 `applyBackgroundTaskSnapshot` / `bgTaskRow` / `splitBgTasks` 便于单测，`tui.test.tsx` 覆盖。

### 模块 B：TUI 会话列表展示与切换（完成）

* `createProcessLine` 新增 `/resume <sessionId>`：`sessionStore.load` 恢复 → `harness.session.create` 回填 → 换绑 `current` + `setSession`（[index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）。

* `tui.tsx` 侧栏「会话」块列出持久化会话，`sessionMode`（Tab 进入，文件引用之后）↑/↓ 选中、Enter 触发 `/resume <id>` 切换。

* `setSession` 回调用 `messagesToBlocks` 把新会话历史还原为对话块刷新聊天区。

* 纯函数 `messageText` / `roleToKind` / `messagesToBlocks` / `toSessionRows` / `sessionRowText` + 5 项 `tui.test.tsx` 用例。

* cli+tui 全量 126 用例通过、typecheck 通过。

下一步：模块 C（/命令菜单补全 + 输入历史）、模块 D（帮助面板 + 复制辅助）。

***

## 2026-08-30（续 31）：TUI 交互增强 — 模块 C 输入体验（/命令菜单 + 输入历史）落地

### 模块 C：输入体验增强 — /命令补全菜单 + 输入历史（完成）

* `index.ts` 新增 `listReplCommands(harness)`：收集 TUI `/` 命令补全候选 = 内置 REPL 命令 + 插件经 `cli.commands` hook 注册的命令，异步合并去重。

* `tui.tsx`：

  * 脚本加载后调用 `listReplCommands` 预取候选；输入以 `/` 开头时按前缀过滤渲染命令菜单弹层（输入框上方、带边框、限量 8 条）。

  * 命令菜单键盘：`↑/↓` 选中，`Tab` 补全当前命令（命令以 `/` 结尾自动补齐空格），`Enter` 提交选中命令，`Esc` 收起命令菜单，其余按键被吞掉避免影响输入。

  * 输入历史：输入框为空且无命令菜单时即回看模式，`↑` 回看 / `↓` 前进，历史值回显到输入框，`Enter` 直接用回看值提交；提交成功后去重（保持最近项）并限量 100 条入栈，输入时重置回看索引。

* 模块 A/B/C 与既有能力在 `tui.tsx` 的键盘分发中按优先级互斥：会话列表 > 文件引用 > 命令菜单 > 输入回看，避免按键冲突。

* cli+tui 全量 126 用例通过、`tsc --noEmit` 通过。

> 说明：多行输入（Textarea 渲染件）、鼠标点击/选区复制依赖 OpenTUI 底层渲染触控能力，与模块 D 一并列入后续增强；命令行文本编辑方向键/退格等仍走 OpenTUI `<input>` 内置按键绑定。

下一步：模块 D（帮助面板 + 鼠标/复制辅助，视 OpenTUI 能力）。

## 2026-08-30（续 32）：TUI 交互增强 — 模块 D（帮助面板 + 复制辅助）与侧栏统计面板落地

### 模块 D1：帮助面板 + Ctrl-Y 复制辅助（完成）

* `tui.tsx` 新增 `HELP_LINES` 常量（快捷键 → 说明映射：Ctrl-C 退出 / Ctrl-B 切换面板 / Ctrl-/ 帮助 / Ctrl-Y 复制 / Tab / ↑↓ / Enter / Esc / /help）。

* 帮助面板：`Ctrl-/` 触发 `helpOpen`，在输入框上方渲染带边框的 modal 弹层，任意键关闭（`useKeyboard` 顶部拦截）。实测 OpenTUI 将 `Ctrl+/`（0x1F）解码为 `key.name === '_'`（ctl+\_），故快捷键判断同时匹配 `'/'`、`'_'`、`'?'`，与真实终端上报一致。

* 复制辅助：`Ctrl-Y` 触发 — `latestAssistantText(blocks)` 取最近 assistant 块纯文本，`copyTextToClipboard` 用 `spawn('pbcopy')` 写入系统剪贴板（macOS），失败静默不打断交互。

### 模块 D2：侧栏统计面板（完成）

* 新增纯函数 `computeTuiStats`（按角色块计数 users/assistants/thinking/tools + 字符数 + token 估算 chars/4 + 后台任务进行中/已结束 + 会话已运行毫秒）、`formatDuration`（s / m s / h m 友好时长）。

* 侧栏新增「统计」区：`消息 Nu/a Nt/ T`、`字符 N · ~N tok`、`任务 ⏳N/✅N · 时长`，随对话块与后台任务实时归并。

* 侧栏外层容器由 `<box>` 升级为 `<scrollbox>`，塞入统计块后内容不再溢出塌陷；状态栏精简至 80 列内（移除冗余 session 字段，`·` 分隔）。

* 新增 TuiStats 纯函数测试与集成测试（帮助开关、统计随块更新），修正统计初始断言（欢迎语 system 块计入字符，故初始 chars≠0）。

* cli+tui 全量 132 用例通过、`tsc --noEmit` 通过。

## 2026-08-30（续 33）：TUI 鼠标复制 — 每条消息增加可点击「复制」按钮

### 背景

模块 D1 已有 `Ctrl-Y` 复制最近助理回复，但需逐条复制历史消息时不够顺手。本续将复制能力下沉到单条消息，实现鼠标点击复制，作为 `Ctrl-Y` 的鼠标替代方案。

### 实现（[tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）

* `startTuiRepl` 创建渲染器时开启 `createCliRenderer({ useMouse: true })`，启用 SGR 鼠标协议（测试渲染器 `createTestRenderer` 亦 `useMouse: true`）。

* `TuiApp` 新增 `copiedId` 状态：标记当前已复制的块 id，用于「✓ 已复制」临时高亮。

* `renderBlock`：对非空 user/assistant 块，在正文下方渲染一行 `<text>` 复制按钮，绑定 `onMouseUp`：

  * 点击即 `preventDefault()` + `setCopiedId(b.id)` + `copyTextToClipboard(b.text)`（复用 D1 的 pbcopy 实现）。

  * 按钮文案 `⧉ 复制` ⇄ `✓ 已复制`（`copiedId === b.id` 反色加粗切换，dim+underline 常态）。

  * 复用 `copyTextToClipboard`：为其补上 `child.on('error')` 处理 —— pbcopy 缺失（非 macOS / PATH 异常）时 ENOENT 以异步 `error` 事件抛出，原 try/catch 只接同步 `spawn` 抛错，二者叠加可完全静默失败、不中断 TUI 交互。

### 测试（[tui.test.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.test.tsx)）

* 新增 `locateChar` 助手：在整宽字符帧（每行按终端宽度空格填充）中用 `indexOf` 定位任意子串的 0-based 单元格坐标，供 `mockMouse.click` 使用。

* 新增集成测试「鼠标点击消息复制按钮 → 变 ✓ 已复制」：发送消息 → 帧中出现 `⧉ 复制` → 定位其坐标 → `mockMouse.click(x, y)` → 断言该按钮翻转为 `✓ 已复制`（证明 `onMouseUp` 触发、状态更新）。

* 首轮测试暴露 pbcopy 在测试环境不可用（PATH 异常导致 `error`），正是上文 `child.on('error')` 修复的验证用例。

### 验证

* cli+tui 全量 **133** 用例通过（含新增鼠标复制集成测试）、`tsc --noEmit` 通过。

## 2026-08-30（续 34）：选区复制 + 欢迎页

### 背景

续 33 实现了每条消息的鼠标点击「复制」按钮，但尚未覆盖"鼠标拖拽选区后复制"这类交互（此前已确认可选择文本会自动建立 OpenTUI 选区，但缺少读取入口）。同时 TUI 启动时只有一行欢迎语，缺少面向新手的欢迎页引导。

### 实现（[tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）

**选区复制（模块 D4）**

* 经 `@opentui/react` 的 `useAppContext()` 在 `TuiApp` 内取到全局 `renderer`（`createRoot` 已以 `AppContext.Provider` 注入 `{ renderer }`），从而读取 `renderer.getSelection()`。

* 新增纯函数 `selectionTextFrom(renderer)`：结构性读取 `getSelection().getSelectedText()`；无 renderer/无选区/空选取均返回空串，便于单测。

* Ctrl-Y 语义升级：**有选区先复制选区并** **`clearSelection()`，否则回落复制最近 assistant 回复**（`HELP_LINES` 同步更新说明）。

**欢迎页（WelcomePanel）**

* `HARNESS_LETTERS` 5×5 字模 + `buildWelcomeBanner()`：横向拼接 "HARNESS" 生成 5 行字标（每行 ≤60 列，适配 80 列 + 26 列侧栏后的主区宽度）。

* `WelcomePanel` 组件：贯穿渲染"欢迎"头部、字标、provider/model、快捷键列表、上手引导。

* `TuiApp` 新增 `hasChat = blocks.some(b => b.kind !== 'system')`；主区 scrollbox 在会话开始前渲染 `WelcomePanel`，首条消息后切换为对话块列表（复用既有 `initialChatWithWelcome`，此处仅做可视化替换）。

### 测试（[tui.test.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.test.tsx)）

* 单测：`buildWelcomeBanner` 返回 5 行且宽度可控并含字模横笔画；`selectionTextFrom` 各无选区/有选区分支。

* 集成：欢迎页在初始（仅 system 块）展示字标与引导、首条消息后消失并切换为对话块。

### 验证

* cli+tui 全量 **136** 用例通过（新增 3 例）、`tsc --noEmit` 通过。

## 2026-08-28（续 29）：`/model` 补全列出插件注册的 Provider — `listProviders` 合并注册表类型

### 背景

`/model` 命令只列出 `config.providers` 显式定义的实例 id 与默认 provider，未查询 `ProviderTypeRegistry`。用户通过插件（`~/.harness/plugins` / `.harness/plugins` 导出 `providerTypeFactory`）注册的自定义 type，即使 boot 时已由 `loadPluginDirs` 注入注册表，也无法在 `/model` 候选列表中出现，导致无法选中或切换。

### 根因

并非惰性加载所致（boot 时 `loadPluginDirs` 已把自定义 type 注册进 `this.providerTypes`），而是 `listProviders()` 的候选枚举来源没有包括注册表里的已注册类型。

### 改动

1. **`listProviders()`** **合并注册表类型**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：候选顺序为 `config.providers` 实例 id → 默认 provider → `this.providerTypes.list()`（内置 + 插件扩展的自定义 type）。后两者不依赖该 type 是否已在 config 定义实例，因此插件注册的 type 也能在 `/model` 展示与校验。
2. 测试：新增 "listProviders 合并插件注册的自定义 type" 集成用例，boot 一个带 `.harness/plugins` 的自定义 provider 插件，断言 `listProviders()` 同时包含默认 provider、内置注册表类型（anthropic）与插件自定义类型（my-gw）。

### 验证

* `@harness/cli` 78 例全绿（含新增用例）；typecheck 通过。

* 惰性语义不变：仍不主动 import 任何 Provider 模块，仅同步读取注册表类型。

## 2026-08-28（续 28）：惰性 Provider 展示元信息 — help/config check 未加载插件即可列出

### 背景

Provider 已惰性加载（续 26 / 续 27），但 help 只静态硬编码示例、`/model?` 只列运行时已配置 id；依赖 Provider 模块 import 才能展示的类型清单在 help 场景出现缺口。用户要求：help 里列出可支持的 provider 时，即使插件未完全加载，也应能展示，且人机交互友好（附描述/默认模型/用法，调用时再自动加载）。

### 改动

1. **抽象层** **`@harness/plugin`** **增加展示元信息通道**（[plugin/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugin/src/index.ts)）

   * 新增 `ProviderTypeMeta`：`type/description/defaultModel/requiresApiKey/builtin/usage`。

   * `ProviderTypeRegistry.register(factory, meta?)` 可附带登记元信息；新增 `meta(type)` 与 `listMeta()`（未登记 meta 的类型也返回仅含 type 的占位，保证清单完整）。

   * 元信息在 register 时同步写入，**不调用 createPlugin、不 import 任何 Provider 模块**。
2. **cli 内置元信息表 + 惰性注册同步登记**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

   * 新增 `BUILTIN_PROVIDER_META`（anthropic/openai/gemini/glm/qwen/mock 的描述、默认模型、是否需 key、用法示例），`registerBuiltinProviderType` 注册惰性工厂的同时登记该元信息。

   * 新增 `formatProviderTypeList(registry, includeUsage)` 与 `buildProviderTypesSection(registry)`：从 listMeta 生成友好清单（`[内置]`/`[插件]` 标注、需 key 提示、默认模型、`/model` 用法），纯元信息驱动、零模块加载。
3. **接线展示**：`main` 的 `help` 分支追加 `buildProviderTypesSection`（同步登记内置元信息即可展示）；`config config check` 在概览后追加含外部插件的完整清单（`buildCheckRegistry` 已加载 plugins）。
4. 测试：`@harness/plugin` 增加 registry meta/listMeta（含占位）用例；cli 增加"同步注册后 listMeta 即可列出、无需加载模块"与 `formatProviderTypeList`/`buildProviderTypesSection` 输出用例。

### 验证

* 全 28 包 typecheck 通过；`@harness/plugin` 38 例、`@harness/cli` 116 例全绿。

* 惰性语义不变：`resolve(type).createPlugin` 仍按需 dynamic import；列表展示仅读元信息，不触发 Provider 模块加载。

## 2026-08-28（续 27）：抽象层扩至运行时能力（subagent / swarm），消除 cli 对业务插件的依赖倒置残留

### 背景

续 26 已把 Provider 依赖倒置消除。cli 仍残留对两个业务插件的直连：`attachBackgroundTaskPanel` 直接 `import { BackgroundTaskMonitor }` 自 `@harness/subagent`，`runTeammateCli` 直接 `import { createSwarmManagers/startTeammateLoop/TeammateTaskState/… }` 自 `@harness/swarm`。经与用户确认：「组合根直连内置插件」作为干净架构常态基线被接受，但该处残留按「完整抽象：swarm+subagent」推进。因此抽象层持续下垫：cli 业务逻辑只经抽象接口交互，具体能力对象由插件包导出并在组合根装配。

### 改动

1. **抽象契约落位** **`@harness/plugin`**（[plugin/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugin/src/index.ts)）新增「运行时能力服务契约」，全部取最小结构契约，抽象层不反向依赖具体插件：

   * `BackgroundProgressLike` / `BackgroundTaskViewLike` / `BackgroundTaskListenerLike` / `BackgroundTaskMonitorLike`：后台任务监控的最小结构视图（与 subagent `BackgroundTaskProgress/View/Listener/Monitor` 结构兼容）。

   * `SubagentCapability`（`createMonitor({ bus, parentSessionIds? })`）。

   * `SwarmLoopDeps` / `SwarmLoopHandle`（`isDone/stop`）/ `SwarmCapability`（`sanitizeName/formatAgentId/startTeammateLoop`）。
2. **subagent 插件实现抽象并导出能力**（[subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）：新增 `subagentCapability: SubagentCapability`，内部 `new BackgroundTaskMonitor(options)`。
3. **swarm 插件实现抽象并导出能力**（[swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：新增 `swarmCapability: SwarmCapability`，`startTeammateLoop(deps)` 内部完成 `createSwarmManagers`、teammate 状态构建与循环封装，并把底层 `TeammateLoopHandle` 适配为抽象 `SwarmLoopHandle`（`isDone = !running`）。
4. **cli 只消费抽象层**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：

   * 删除对 `BackgroundTaskMonitor`/`BackgroundTaskView`/`createSwarmManagers`/`startTeammateLoop`/`TeammateTaskState`/`TeammateTickDeps` 等具体实现类型的直接引用；cli 业务函数不再 import 这些类型。

   * `attachBackgroundTaskPanel` 改经 `subagentCapability.createMonitor(...)`，打印状态映射改用抽象 `BackgroundTaskViewLike['status']`。

   * `runTeammateCli` 改经 `swarmCapability.sanitizeName/formatAgentId/startTeammateLoop`，等待收尾改用 `loop.isDone()` 而非读取具体 `state.status`。

   * 组合根仅导入具体插件导出的能力对象（`subagentCapability` / `swarmCapability`），属「组合根直连内置插件」基线内。
5. 附带修复 `@harness/plugin` 的 `plugin.test.ts` 两处既有类型错误：`resolveProviderTypeFactory` 用例的 `createPlugin` 返回体补齐 AgentPlugin 最小桩，因抽象契约已把返回类型收紧为 `AgentPlugin | undefined`。

### 验证

* 全量 28 包 typecheck 通过

* `@harness/plugin` 37 例、`@harness/subagent` 93 例（新增 capability 1 例）、`@harness/swarm` 65 例（新增 capability 2 例）、`@harness/cli` 114 例均全绿

* 注：根目录 `bun test` 扫描未装依赖的 `reference/` 私有目录产生的既有失败与本改动无关

## 2026-08-28（续 26）：Provider 抽象层，消除 core/cli 对具体 Provider 的依赖倒置

### 背景

续 20 已用 `ProviderTypeRegistry` 替代硬编码 `type` 枚举，但抽象契约仍定义在 cli 内部（cli 自建 `ProviderTypeFactory`/`ProviderTypeRegistry`、`registerBuiltinProviderTypes` 逐个 `import()` 具体 `provider-*` 包并做各自的配置映射）。这仍是**高层（core/cli）直接依赖低层具体 Provider 实现**，违背依赖倒置。要求：建立一层抽象层，core 和 cli 只使用抽象层接口，插件（Provider 包）实现抽象层，core 只经抽象层交互。

### 改动

1. **抽象层落位** **`@harness/plugin`**（[plugin/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugin/src/index.ts)）：

   * 新增 `ProviderConfig`（含 `[key: string]: unknown` 透传）契约；

   * 新增 `ProviderTypeFactory`（`type` + 可异步的 `createPlugin`）契约；

   * 新增 `ProviderTypeRegistry`（`register/resolve/list/clear`）注册表；

   * 新增 `resolveProviderTypeFactory(mod)`：统一从插件模块导出识别三种工厂形态（`providerTypeFactory` / `providerType`+`createProviderPlugin` / `default` 包装）。
2. **6 个 Provider 包实现抽象层**（`provider-*`）：

   * 各包新增导出 `providerTypeFactory`，`createPlugin(config: ProviderConfig)` 在**包内部**完成「`ProviderConfig` → 该 Provider 配置结构」的映射（`model`→`defaultModel`、`id`→`providerId` 等），把原本散落在 cli 的逐类型映射下沉到实现方。
3. **cli 只消费抽象层**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：

   * 删除 cli 本地重复的 `ProviderTypeFactory` 接口、`ProviderTypeRegistry` 类、`ProviderConfig` 接口，改用 `@harness/plugin` 导入；

   * 删除对 `@harness/provider-openai/gemini/glm/qwen` 的具体配置类型导入；

   * `registerBuiltinProviderTypes` 重写为**通用惰性登记**：只登记「`type` → 模块 specifier」，`createPlugin` 时 `lazyImport()` + `resolveProviderTypeFactory()` 解析出实现方工厂并委托，**不再含任何具体 Provider 配置结构/工厂的硬编码映射**，仍保持惰性加载不影响启动速度。

   * `registerBuiltinProviderTypes` 签名收敛为单参数 `(registry)`，两处调用点与 cli 测试同步更新。

### 验证

* 全量 26 包 typecheck 通过

* `@harness/plugin` 37 例全绿（新增：`ProviderTypeRegistry`、`resolveProviderTypeFactory` 三种形态 + 无契约回退 5 例）

* `@harness/cli` 114 例全绿（新增：内置 6 个 `provider-*` 包装 `providerTypeFactory` 契约逐包校验 1 例）

* 6 个 `provider-*` 包各自用例全绿

* 注：根目录 `bun test` 会扫描未装依赖的 `reference/` 私有目录产生大量既有失败（含 `tools-builtin`/`Ctrl-B` 环境性 flaky），与本次改动无关；本改动未触碰这些文件

## 2026-08-28（续 25）：内置插件统一注册 + 惰性加载

### 背景

内置 Provider 模块（anthropic/openai/gemini/glm/qwen/mock）与 `tools-builtin` 此前在 cli 顶部**静态 import**，进程一启动就全部求值，既不"支持加载"（无法与外部插件统一管理/装卸），也拖慢启动。要求：**随应用打包的内部插件也要支持加载**，且**插件加载支持惰性加载**，尽量不影响启动速度。

### 改动

1. **内置 Provider 类型惰性化**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：

   * `registerBuiltinProviderTypes` 改为登记「`type` → 惰性 `createPlugin`」，`createPlugin` 内部经 `lazyImport()` 在真正按 `config.type` 解析 Provider 时才 `import()` 对应模块；`type` 名仍在启动时登记（供配置校验）。

   * `ProviderTypeFactory.createPlugin` 返回值放宽为 `AgentPlugin | undefined | Promise<AgentPlugin | undefined>`，`buildProviderPlugin` 改为异步；`mock`/`anthropic` 兜底改用 `lazyMockProvider()`/`lazyAnthropicProvider()`。

   * 顶部仅保留 `import type`（配置类型），移除运行时静态 import。
2. **内置通用插件统一注册表**（新增 `BuiltinPluginRegistry` / `getBuiltinRegistry` / `BuiltinGeneralPlugin`）：登记「id + 描述 + source=`builtin` + 惰性 `load()`」，`tools-builtin` 经此惰性加载（boot 时才 import），与外部插件目录 `loadPluginDirs` 并列，满足"内部插件也要支持加载"。
3. **启动速度**：`harness --help` / `--check-config` 不再加载任何 Provider 模块；repl 也只在真正用到对应 type 时加载所需 Provider，未用到的 anthropic/gemini/glm/qwen 不会加载。

### 验证

* cli 113 用例全绿（新增：内置 Provider 惰性解析、BuiltinPluginRegistry 惰性加载 2 例）；全量 26 包 typecheck 通过

* 注：`Ctrl-B 切换侧栏` TUI 用例为既有偶发 flaky（原代码上复现），与本次改动无关

## 2026-08-28（续 24）：消除 CLI 对业务插件的依赖倒置

### 背景

项目约束强调"插件化、所有插件可插拔、不与项目本身耦合"。续 23 中电脑控制实现把 `mcp-server-registry` 与 `computer-use` 硬编码进 CLI，属高层（CLI）直接依赖低层具体插件，违背依赖倒置原则，本次修正。

### 改动

1. **移除 CLI 硬编码依赖**（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：

   * 删除 `import { createMcpServerRegistryPlugin } from '@harness/mcp-server-registry'`、`import { createComputerUsePlugin } from '@harness/computer-use'`

   * 删除 `providerPlugins.push(createMcpServerRegistryPlugin()); providerPlugins.push(createComputerUsePlugin())`

   * 移除 cli/package.json 中 `@harness/computer-use`、`@harness/mcp-server-registry` 依赖
2. **改为项目级可插拔插件**（[.harness/plugins/mcp.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/.harness/plugins/mcp.ts)）：经既有 `loadPluginDirs`（user `~/.harness/plugins` → project `.harness/plugins`）加载，`export const plugins = [createMcpServerRegistryPlugin(), createComputerUsePlugin()]`；删除该文件即可停用，无需改动 CLI/core
3. **消除误报警告**（cli/src/index.ts `registerProviderTypeFactory`）：已导出通用 AgentPlugin 的模块直接返回，不再打印"未导出 Provider 工厂，已忽略"的误导日志

### 验证

* `loadPluginDirs` 实际加载 `.harness/plugins/mcp.ts` → 得到 `mcp.server-registry`、`computer-use` 两个插件，无警告

* cli 111 用例全绿；全量 26 包 typecheck 通过

## 2026-08-28（续 23）：电脑控制 MCP server 插件 + MCP Server Registry

### 背景

用户希望基于 `reference/电脑控制mcp 功能.md` 实现一个「电脑控制」MCP server 插件：插件加载时自动启动并注册到 MCP，连接统一由 mcp-client 管理。为避免与 core 集成，注册机制采用独立的 `mcp-server-registry` 插件：所有 mcp server 相关插件都依赖它去启动，提高复用度。后端选「真实 macOS 自动化」（osascript）。

### 实现

**1.** **`@harness/mcp-server-registry`（[mcp-server-registry/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/mcp-server-registry/src/index.ts)）**

* `McpServerRegistry`：`register / unregister / has / list / clear`，支持两条注册路径：

  * `config`：外部 server（stdio/http/sse），用 `@harness/mcp-client` 的 `defaultTransportFactory` 拉起

  * `createTransport`：进程内 / 自定义启动器，返回 `@harness/mcp-client` 的 `McpTransport`

* `registerMcpServer() / unregisterMcpServer() / listRegisteredMcpServers()`：模块级默认注册表

* `createMcpServerRegistryPlugin()`：在 `harness.start` 连接所有已注册 server（`McpClient` + `connect`）、`tool.pool.assemble` 暴露 `convertMcpToolToHarnessTool` 转出的工具、提供 `/mcp [servers | tools]` 命令、unload 时断开

**2.** **`@harness/computer-use`（[computer-use/src/mac.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/computer-use/src/mac.ts)** **+** **[server.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/computer-use/src/server.ts)** **+** **[index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/computer-use/src/index.ts)）**

* `ComputerUseBackend`：通过 `/usr/bin/osascript`（System Events）+ `/usr/sbin/screencapture` 实现 11 种电脑操作（check\_permissions / list\_apps / get\_app\_state / click / scroll / drag / type\_text / press\_key / perform\_action / set\_value / select\_text），执行器可注入（测试 mock）

* `ComputerUseMcpServer`：进程内 MCP JSON-RPC server（initialize / tools/list / tools/call），把后端方法映射为 MCP 工具，工具 schema 对齐参考文档

* `createComputerUseServerTransport()`：把进程内 server 包装为 `McpTransport`，供 registry 连接

* `createComputerUsePlugin()`：`dependsOn ['mcp.server-registry']`，`install` 时 `registerMcpServer` 注册进程内 server，`harness.init` 时经 `output.harness.skillManager.register` 注册一个 `loadedFrom: 'plugin'` 的「Computer Use」操作指南技能

**3. 装配（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）**

* CLI 默认安装 `createMcpServerRegistryPlugin()` + `createComputerUsePlugin()`，实现「注册 → harness.start 自动启动进程内 server 并通过 mcp-client 连接 → 工具进工具池」

### 验证

* mcp-server-registry 4 用例：注册表 CRUD、harness.start 连接 + assemble 暴露工具 + 工具可调用（pass-through）、`/mcp servers|tools`、config 缺失 command 不阻塞其余

* computer-use 9 用例：JSON-RPC initialize / tools/list（11 工具）/ tools/call 分发与报错 / 通知无响应 / 未知方法 / transport 对接 McpClient 连通性 / 插件注册 server + 注册 plugin 来源 Skill

* cli 111 用例全绿（接入新插件后无回归）；全部 26 包 typecheck 通过

## 2026-08-28（续 22）：插件 / 技能管理（enable / disable / reload + 技能来源标注）

### 背景

续 21 统一 `plugins` 目录后可加载各种插件，但缺少对插件与技能的运行时管理能力，也无法从插件注册技能、标注技能的加载来源。本次补齐「插件管理 + 技能管理 + 插件来源技能 + 来源标注」闭环。

### 实现

**1. 技能来源标注（[packages/skill/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.ts)）**

* `SkillSource` 增加 `'plugin'`（插件注册来源），与 `bundled / user / project / mcp` 并列为五来源

* 新增 `formatSkillSource(source)`：五来源的中文标注（内置 / 用户 / 项目 / MCP / 插件），供 `/skills` 界面展示

**2. SkillManager 管理能力（同文件）**

* 接口与实现新增 `disable(id)`、`enable(id)`、`isDisabled(id)`

  * `disable`：从可用列表移除，缓存到 `disabled`（enable 可恢复），重复禁用幂等返回 `false`

  * `enable`：从禁用缓存恢复；未在缓存中则回落到 `reload`（从来源文件重载，等价新增技能启用）

  * `reload` 保持原启用/禁用状态：禁用技能重载后仍不可见，启用技能重载后仍可见

**3. core 暴露 skillManager（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）**

* `Harness` 接口与实现新增 `readonly skillManager?: SkillManager`；插件可在 `harness.init` hook 中通过 `output.harness.skillManager.register(...)` 注册 `plugin` 来源的技能

**4. CLI 管理命令（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）**

* `HarnessApp` 新增 `pluginRegistry`（boot 时登记「可管理」插件对象：Provider / 插件目录 / extraPlugins，排除 `toolsBuiltin` 与 `core.*`）

* 插件管理 API：`pluginInfos()`、`disablePlugin()`（unload）、`enablePlugin()`（按登记对象重装）、`reloadPlugin()`（hotReload）

* 技能管理 API：`skillInfos()`（含 `sourceLabel` 中文标注）、`disableSkill()`、`enableSkill()`、`reloadSkill()`

* REPL 新增 `/plugins` 与 `/skills` 命令（`enable | disable | reload` + 列表），并加入 `REPL_COMMANDS`（`/help` 可见）

### 验证

* skill 包新增 `formatSkillSource`、disable/enable/reload 状态保持与禁用心得等用例；skill 29 用例全绿

* cli 新增 `/plugins`、`/skills` 命令（列表/禁用/启用/未知来源/help）等用例；cli 72 用例全绿

* core / plugin 61 用例全绿；全部 26 包 typecheck 通过

## 2026-08-27（续 21）：统一 plugins 插件目录（支持各类插件）

### 背景

续 20 的 `provider-plugins` 专用目录只承担「Provider 类型工厂」一种插件约定，无法承载通用 AgentPlugin（Hooks 生命周期插件），且目录命名与「插件」的通用语义不符。用户要求统一为 `plugins` 文件夹，在一个目录里支持加载各种插件类型。

### 实现（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

1. **目录统一**：`~/.harness/provider-plugins` / `.harness/provider-plugins` → `~/.harness/plugins` / `.harness/plugins`（user → project，后加载覆盖）
2. **`loadPluginDirs(registry, dirs, log?)`** 取代 `loadProviderPluginDirs`，返回 `PluginLoadResult { plugins }`；一个模块可同时导出两类插件：

   * **通用 AgentPlugin**（Hooks 插件）：`default` / `plugin` / `plugins` 三种形态（含一层 default 包装）；按插件 `id` 去重，project 覆盖 user，最终随 `internalPlugins` 安装进 Harness

   * **Provider 类型工厂**（扩展 `config.type`）：`providerTypeFactory` 或 `providerType`+`createProviderPlugin`，注册进 `ProviderTypeRegistry`
3. **校验/自检联动**：`buildCheckRegistry` 与 boot 均改用 `loadPluginDirs`；未知 type 报错与帮助文案改指 `plugins` 目录
4. 坏模块（既无 AgentPlugin 也无 Provider 工厂）忽略并告警，不静默、不崩溃

### 验证

* CLI 测试重构为 64 个：新增 `providerTypeFactory` 形态、通用 AgentPlugin（default/plugin/plugins）、通用插件按 id 去重（project 覆盖 user）等用例

* cli 64 用例全绿，cli typecheck 通过

## 2026-08-27（续 17）：模型配置及切换

### 背景

模型缺失统一的配置入口与运行时切换能力：此前只能通过 Provider 插件传入（anthropic 的 `defaultModel` 或 Agent 定义 `model.modelId`），命令行/会话运行时无法便捷查看与切换模型。本次补齐「配置 → 运行时切换 → 状态展示」闭环。

### 实现（[index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts) / [tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）

1. **配置来源统一（优先级：CLI > config.json > 环境变量）**

   * `ConfigStore`（dataDir/config.json）：读写 `agentId / provider / model / anthropicApiKey`，缺文件/坏 JSON 幂等返回空

   * `resolveConfig`：main() 里把 CLI 参数与 config 合并（CLI 优先），代理/mock 测试注入不受影响
2. **CLI** **`-m, --model <modelId>`**：写入默认 Agent 定义 `model.modelId`（运行时 llmIn 取 `agent.model.modelId`），并作为 provider 的 `defaultModel` 兜底
3. **运行时** **`/model`** **命令**：`/model` 查看当前模型；`/model <modelId>` 更新当前 Agent 的 model 并持久化 config.json（影响下次 send）；列入 `/help` 与 REPL\_COMMANDS
4. **TUI 状态展示**：`TuiReplOptions.model` 传入后，状态栏/侧栏初始即显示配置模型（此前要到首轮 done 才显示实际命中模型）
5. **boot() provider 合并**：anthropic 分支可按 config.json 的 `anthropicApiKey` 直接提供 key（显式配置 > config > 环境变量）

### 验证

* cli 74 用例全绿（新增 `--model` 解析、ConfigStore 往返/坏 JSON、resolveConfig 优先级、REPL `/model` 查看+切换+落盘、TUI 状态栏初始模型展示共 8 个），cli typecheck 通过

## 2026-08-27（续 20）：Provider 类型插件化（去掉硬编码 type 枚举）

### 背景

`ProviderConfig.type` 之前是硬编码枚举（anthropic/openai/gemini/glm/qwen/mock），CLI 内部 switch 分发，新增 Provider 类型必须改 CLI 代码——违背系统插件化理念。本次改为注册表 + 多级插件目录加载。

### 实现（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

1. **`ProviderConfig.type`** **开放为任意字符串**：内置类型只是「已注册」的默认项，不再是枚举限制
2. **`ProviderTypeRegistry`**：`type → createPlugin(config)` 工厂注册表，`resolve/list` 动态解析（替代硬编码 switch）

   * `registerBuiltinProviderTypes(registry, options)`：内置 openai/anthropic/gemini/glm/qwen/mock 以注册方式装配（anthropic 仍捕获 options 兜底 key）

   * `HarnessApp.providerTypes` 公开注册表，第三方可在 boot 前注入自定义 type
3. **外部插件多级加载**：`loadProviderPluginDirs` 扫描 `~/.harness/provider-plugins`（user）→ `<project>/.harness/provider-plugins`（project，后加载覆盖）

   * 插件模块约定导出 `providerType: string` + `createProviderPlugin(config): AgentPlugin`（或 `providerTypeFactory` / default 同构）

   * 缺声明/加载失败 → 告警跳过（不静默、不崩溃）
4. **校验动态化**：`validateProviderConfigs(providers, defaultId, knownTypes)` 已知类型由注册表提供，未知 type 报错时列出已注册类型并提示 provider-plugins 扩展方式
5. **自检联动**：`--check-config` / `config check` 通过 `buildCheckRegistry` 加载外部插件后再校验

### 验证

* 新增测试：ProviderTypeRegistry（register/resolve/list/覆盖）、内置 6 类型齐全、loadProviderPluginDirs（约定加载/多级覆盖/坏文件告警）、校验按注册表动态、自定义 type 经注册表装配并参与分发

* cli 101 用例全绿，cli typecheck 通过；真实冒烟：`.harness/provider-plugins` 放 my-gw 插件 → `--check-config` 识别 `type=my-gw` 并校验通过

## 2026-08-27（续 19）：多 Provider 配置健壮性增强

### 背景

续 18 的多 Provider 支持存在静默失败路径（重复 id 静默覆盖、未知 type 静默丢弃、默认 provider 缺失误导提示），apiKey 只能明文落盘。用户确认增强：启动显式校验、apiKey 环境变量引用 + 加密存储、配置自检命令。

### 实现

1. **显式校验（boot 一次性报错）**（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

   * `validateProviderConfigs`：重复 id / 未知 type / 默认 provider 未定义（非内置 mock/anthropic）→ 收集全部问题

   * `ConfigValidationError`：boot 时输出所有问题后抛错，不再静默跳过或误导提示
2. **密钥加密存储**：`SecretCipher`（AES-256-GCM）

   * 主密钥：`HARNESS_CONFIG_KEY` 环境变量（sha256 派生）→ `<data-dir>/.config-key` 文件（首次自动生成，chmod 600）

   * 格式 `enc:v1:<iv>:<tag>:<ct>`（base64），明文不落盘

   * `resolveSecret`：`${ENV_VAR}` 环境变量引用 / `enc:v1:` 解密 / 明文透传；未设置变量或解密失败报 ConfigValidationError
3. **config 子命令**：`harness config set-key <providerId> <apiKey>` 加密写入；`get-key <providerId>` 解密查看；`check` 校验 + 概览
4. **自检命令**：`--check-config`（等价 `config check`）打印 Provider/模型概览（apiKey 状态脱敏展示：已配置 / 已加密 / env(名称) / 未配置）+ 校验，REPL 新增 `/config`
5. **接入 GLM / Qwen 预设 Provider**（[packages/plugins/provider-glm](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/provider-glm/src/index.ts) / [provider-qwen](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/provider-qwen/src/index.ts)）

   * CLI `ProviderConfig.type` 支持 `glm` / `qwen`：预设 baseUrl/apiPath/默认模型（GLM=bigmodel，Qwen=dashscope），apiKey 环境变量 ZHIPU\_API\_KEY / DASHSCOPE\_API\_KEY

   * 插件 providerId 可覆盖、插件 id 随 providerId 派生（同 openai 多实例不冲突）
6. **parseCliArgs**：`config` 子命令（arg=子命令，rest=剩余非选项参数）+ `--check-config`

### 验证

* 新增测试：SecretCipher 往返/主密钥优先级、resolveSecret（env 展开/未设置报错/解密）、validateProviderConfigs（重复/未知/默认缺失）、buildConfigOverview 脱敏、boot 显式报错（一次性输出）、glm/qwen 注册分发、${ENV} boot 展开、main config set-key/get-key/check、--check-config 通过与报错

* cli 94 用例全绿，glm/qwen/cli 三包 typecheck 通过；真实 CLI 冒烟：check 概览、set-key 加密落盘、get-key 还原、错误配置一次性报错且退出码 1

## 2026-08-27（续 18）：多 Provider 自由切换（自定义模型配置）

### 背景

用户确认「自定义模型配置」期望的能力范围 = 多 Provider 自由切换：config.json 定义多个 provider（anthropic / openai / glm / qwen / gemini + 任意 OpenAI 兼容端点如 Ollama / DeepSeek），每个含 baseUrl / apiKey / model，`-m` / `/model` 可跨 Provider 任意切换。

### 实现

1. **core：ChatProvider 注册表**（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）

   * `chatProviders: Map<providerId, ChatProvider>`：`_setChatProvider` 按 `p.id` 入表

   * `resolveChatProvider(providerId)`：命中注册表 → 该 Provider；否则回退默认（context 记的 `chat.provider` / `chatProvider`）

   * AgentRuntime 调用点改为 `this.deps.chatProvider(llmIn.providerId)`，`provider.complete({ providerId, modelId, ... })` 动态分发
2. **CLI：providers 多配置 + 规格解析**

   * `HarnessConfig.providers: ProviderConfig[]`（config.json），`ProviderConfig = { id, type, baseUrl?, apiKey?, model?, apiPath?, maxTokens?, timeoutMs? }`

   * `parseModelSpec` / `formatModel`：`provider/modelId` 规格解析与格式化

   * `HarnessApp.boot()` 动态安装：非默认 Provider 先注册，默认 Provider 最后注册作兜底；`buildProviderPlugin()` 按 type 构造 openai / anthropic / gemini / mock 插件，openai 可对接任意兼容端点（DeepSeek / Ollama / GLM 等）
3. **修复 PluginDuplicateIdError**（[packages/plugins/provider-openai/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/provider-openai/src/index.ts)）

   * openai 插件 id 由写死的 `provider.openai` 改为随 `config.providerId` 派生（`provider.{providerId}`），使多个 OpenAI 兼容 Provider 不冲突
4. **`-m, --model <provider/model>`**：CLI 解析 `provider/model` 绑定 Agent 的 `providerId + modelId`，同时作为默认 Provider 的 `defaultModel` 兜底
5. **`/model`** **支持跨 Provider**：`/model openai/gpt-4o` 校验 provider 是否注册 → 更新 Agent 并持久化（provider + model）到 config.json；`/model` / `/model ?` 展示已注册 Provider 列表
6. **listProviders()**：汇总 config.providers 显式 id + 默认 provider（供状态栏 / /model 展示）

### 验证

* 新增核心测试：多 Provider 按 `agent.model.providerId` 分发 / 回退默认 / 未知 id 回退默认

* 新增 CLI 测试：`parseModelSpec` / `formatModel`、`-m provider/model` 绑定、`setModel` 跨 Provider 切换 + 落盘、多 Provider 注册按 id 分发

* 修复 openai 插件重复注册冲突 + 测试绑定丢失 `this` 的问题；cli 78 用例全绿，core 29 用例全绿，core / cli / provider-openai 三包 typecheck 通过

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

* cli 66 用例全绿（含 2 个新导航集成 + 5 个 FileRefIndex 单测），全仓 26 包 typecheck 通过

* 导航链路：mock 回复 `改动 src/foo.ts:12 与 src/bar.ts:3` → Tab → down → Enter → `openFile('src/bar.ts', 3)` 被调用，:行号解析正确

## 2026-08-26（续 15）：TUI 渲染层迁移 OpenTUI（Bun 原生 Zig 渲染核心）

### 背景

自研 ANSI TUI（续 13）满足基础需求，但要做到 Claude Code / opencode 级别的功能齐全（代码高亮、Markdown 渲染、多面板布局、鼠标支持、选区复制等），自研成本过高。对比主流 TUI 方案后选定 **@opentui/core + @opentui/react**：

* **ink**：react-reconciler 方案，但终端重建需 ink 自己的渲染管线，对 Bun 支持一般，且零依赖风格冲突

* **OpenTUI**：Bun 原生（Zig 渲染核心 + Yoga flexbox 布局），`@opentui/react` 提供 React 组件树（box/text/input/scrollbox），自带 `<code>`/`<markdown>` 语法高亮等扩展能力；官方提供 `createTestRenderer` 测试方案，可直接 mock 按键断言帧内容

### 实现（[tui.tsx](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.tsx)）

1. **t1 渲染层重写**：`KeyDecoder`/`TuiScreen` 自研 ANSI 全部移除，替换为 `TuiApp` React 组件（状态栏 + scrollbox 日志区自动滚动 + 底部 input 行）；`startTuiRepl` 改为 `createCliRenderer()` + `createRoot(renderer).render(<TuiApp/>)`；**会话内核** **`createProcessLine`** **原样保留**，TUI 与 REPL 依然共用同一套处理逻辑
2. **t2 三处真实 bug 修复**：

   * `processLineRef` 改为渲染期同步初始化（`createProcessLine` 是纯工厂），避免 Enter 提交早于 mount effect 执行时 ref 为 null

   * `<input onSubmit>` 不再读 React 状态闭包（快速输入时状态滞后于输入框内部文本），改用事件携带的 `currentValue`

   * **mount effect 覆盖竞态（pty 冒烟暴露）**：初始欢迎语/状态栏若用 `useEffect` 设置，而 processLine 已同步初始化，用户首个输入可在 effect 前被处理——回复内容先 append 进 logs，随后 effect 的 `setLogs([...欢迎语...])` 整体覆盖丢弃。修复：logs/status 直接用 `useState` 初始值，删除 mount effect
3. **t3 工程适配**：cli 新增依赖 `@opentui/core` / `@opentui/react` / `react`；tsconfig 配置 `jsx: react-jsx` + `jsxImportSource: @opentui/react`；文件名 `tui.ts` → `tui.tsx`、`tui.test.ts` → `tui.test.tsx`
4. **t4 测试重写**：旧 21 用例（KeyDecoder/TuiScreen/scriptedKeys）替换为 `@opentui/core/testing` 的 `createTestRenderer` + `mockInput` 驱动 `TuiApp`（10 用例：appendLog 4 / 集成 4 / --tui 2）；测试渲染器需手动 pump `renderer.loop()` 产出帧（waitForFrame 不驱动循环）

### 验证

* cli 38 用例全绿（含 TuiApp 输入提交流式渲染 / Ctrl-C / /exit 集成），全仓 25 包 typecheck 通过

* python pty 真实终端冒烟：`🧑 hi` 回显 → `🤖 (Mock Provider) 你好，我是测试助手。` 流式渲染 → `⏱️` 计时行 → 状态栏 session/agent 显示；注意 OpenTUI 增量渲染对变化单元格逐格写 ANSI 色码，字节流子串匹配需按单字符断言

* 保留能力：`harness repl --tui` 全屏交互、与 REPL 共用 /命令与插件 hook、自动续轮注入

## 2026-08-26（续 14）：TUI 输入修复——真实终端无法输入字符

### 现象

`harness repl --tui` 启动后界面正常渲染，但键盘输入无反应（字符不显示、回车不提交）。

### 根因（[tui.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/tui.ts)）

两个叠加 bug：

1. **drainQueue busy 标志竞态（致命）**：`draining = (async () => {...})()` 中，async IIFE 同步完成时 `finally { draining = null }` 先执行，随后赋值把已 resolve 的 promise 写回 `draining`。真实终端下字符块与回车块是两次独立 data 事件——字符块的 drainQueue 同步完成后 `draining` 仍非空，回车块调用 drainQueue 被 `if (draining) return` 拦截，**提交的行永不处理**。修复：改用 promise 链（`queueTail = queueTail.then(...)`）串行处理，天然不丢行。
2. **按键不触发重绘**：handleKeys 仅在 Enter 提交时 scheduleRender，char/退格/方向键修改 screen.input 后屏幕不刷新，用户看不到输入的字符。修复：每次按键后统一 scheduleRender。

### 排查过程

* expect（pty）复现不稳定（bun 冷启动慢 + `~/.harness` 写入 EPERM 干扰）→ 用 python `pty.fork()` 复现真实终端输入

* 逐级 stderr 调试定位：`TUI-DATA`（data 事件收到 hi ✓）→ `TUI-KEY`（char 插入 screen.input ✓）→ `TUI-DRAINQ-CALL`（enter 时 `draining=true` 拦截 ✗）

### 验证

* python pty 全流程：`🧑 hi` 回显 → `🤖 (Mock Provider) 你好，我是测试助手。` 流式渲染 → 退出序列收尾

* 新增回归测试「输入与回车分块到达（真实模式时序）也能提交处理」（修复前必失败）

* cli 50 用例全绿（+1），全仓 26 包 typecheck 通过

## 2026-08-26（续 13）：TUI 形态落地——自研 ANSI 渲染（预留迁移）

### 方案决策

* **自研 ANSI TUI**（放弃现成库：ink 依赖 react-reconciler 与零依赖风格冲突、blessed 已停维护带 CVE、clack 满足不了多面板需求）

* **渲染层严格隔离**：TUI 与 REPL 共用同一套会话处理内核（`createProcessLine`），渲染/输入层独立成模块，未来若需求膨胀（鼠标、富布局）可低成本迁移 ink

### 实现（[packages/cli/src](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src)）

1. **t1 重构**：`startReplCore` 的 `processLine` 提取为可复用工厂 `createProcessLine({ app, harness, session, out, onLine?, setSession? })`（[index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）——流式事件渲染、`/` 命令、插件 cli.command hook、`AUTO_CONTINUE_LINE` 全部共用；REPL 与 TUI 同一内核
2. **t2 新建** **`tui.ts`**：

   * `KeyDecoder`：raw-mode 键盘字节流 → KeyEvent（箭头/Enter/Backspace/Ctrl-C/Tab/Home/End/Delete；跨块转义序列缓冲）

   * `TuiScreen`：alt-screen 全屏渲染（状态栏 + 日志区自动滚动 + 底部输入行 + 光标定位 CSI）；`append` 流式拼接当前行

   * `startTuiRepl`：非阻塞输入循环，Enter 提交 → createProcessLine 处理 → 输出回流日志区；`drainQueue` 共享 promise 防并发；退出前 flushRender 保证退出序列收尾
3. **t3 CLI 入口**：`harness --tui` 进入 TUI 模式（parseCliArgs 新增 tui 标志 + main 分支 + HELP\_TEXT）
4. **t4 测试**：`tui.test.ts` 21 用例（KeyDecoder 10 / TuiScreen 5 / startTuiRepl 4 / --tui 2），cli 28 用例保持全绿

### 修复

* KeyDecoder `\x1b[n~`（Delete）解码：`fin==='~'` 分支不可达，统一到未知 CSI 路径解析

* startTuiRepl 脚本模式并发 drain：`void drainQueue()` 与 `await drainQueue()` 竞争导致提前返回丢流式输出 → 共享进行中 promise

* TuiScreen.append 把流式 token 当独立行 → 改为追加当前行（换行才分行）

### 状态

* cli 49 用例全绿（+21），全仓 26 包 typecheck 通过

* 边界：本次不做鼠标交互、富文本布局（预留迁移口的边界条件）

## 2026-08-26（续 12）：Swarm 待办收尾——tmux/iTerm2 进程后端 + send\_message 路由统一

对照架构 §9.4「Swarm 后续待办」，实现最后 2 项（8、10），Swarm 待办 10 项全部完成：

### 1. tmux/iTerm2 进程后端（out-of-process teammate）

* swarm 新增 `spawnTerminalTeammate`（[packages/plugins/swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：

  * tmux：`new-session -d`（已存在则 `new-window`）→ `send-keys` 注入 CLI 启动命令 → paneId 写入 `TeamMember.tmuxPaneId`

  * iTerm2：osascript 创建窗口 + `write text` 启动命令，返回 window id

  * 命令执行器可注入（`run`），默认 `spawn` 收集 stdout，纯逻辑可测试

* CLI 新增 `teammate` 子命令（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：`harness teammate --team <t> --name <n> --agent <a>`——复用 HarnessApp.boot + `startTeammateLoop` 持续轮询 mailbox/认领任务，直到 shutdown 退出

* `spawnTeammate` 统一分流：backend = in-process | tmux | iterm2

### 2. send\_message 路由统一

* coordinator `send_message` 双路由（[packages/plugins/coordinator/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/coordinator/src/index.ts)）：

  * **mailbox 路由**（team + to）：单播到成员 inbox；`to='*'` 广播到团队全部成员

  * **本地续跑路由**（taskId）：原 worker 子会话续跑语义不变

* mailbox 经插件选项依赖注入（`SendMailbox` 鸭子接口，不硬依赖 swarm），未注入时 mailbox 路由返回 `MAILBOX_NOT_CONFIGURED`；无目标返回 `INVALID_TARGET`

### 验证与提交

* 测试：swarm 63 用例全绿（+3：tmux 命令序列/iTerm2 osascript/spawn 分流）、coordinator 29（+4：单播/广播/未配置/无目标）、cli 28（+1：teammate 参数解析）

* 全仓 26 包 typecheck 通过

* 文档：架构 §9.4 Swarm 待办 10 项全部 ✅

## 2026-08-26（续 11）：Swarm 待办 7、9 项落地（plan approval + team file 字段补全）

对照架构 §9.4「Swarm 后续待办」，实现第 7、9 项（[packages/plugins/swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：

### 1. plan approval 自动批准 + permissionMode 继承

* helper：`createPlanApprovalRequest`（plan 内容 + 期望 permissionMode）、`createPlanApprovalResponse`（approved + leader permissionMode）

* teammate 侧：`requestPlanApproval`（写 plan\_approval\_request 到 leader inbox + 挂起回调）、`processMailboxPlanApprovalResponse`（命中 requestId 配对 resolve，返回 approved + 继承的 permissionMode）

* leader 侧：`processMailboxPlanApprovalRequests` 自动批准 plan\_approval\_request 并回写响应，携带 leader 当前 permissionMode（宿主传入）供 teammate 继承

* `runTeammateTick` 每轮先处理 plan\_approval\_response 配对（与权限响应并列）

### 2. team file 字段补全 + setLeaderTeamName

* `TeamMember` 增 joinedAt / tmuxPaneId / cwd / subscriptions；lead 与新增成员自动记录 joinedAt（同名覆盖保留原值）

* `TeamFile` 增 leaderTeamName + `TeamManager.setLeaderTeamName`（多后端共享任务池定位；out-of-process teammate 通过它找到归属团队目录）

### 验证与提交

* 测试：swarm 60 用例全绿（+5：字段补全 1 + setLeaderTeamName 1 + plan approval 3）

* 全仓 26 包 typecheck 通过

* 文档：架构 §9.4 第 7、9 项标记 ✅（tmux/iTerm2 后端、send\_message 路由统一 留待办）

## 2026-08-26（续 10）：Swarm 待办 4-6 项落地（poller 优先级 + task 依赖锁 + idle\_notification）

对照架构 §9.4「Swarm 后续待办」，实现第 4-6 项（[packages/plugins/swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：

### 1. inbox poller 优先级 + 投递后才 markRead

* `sortMessagesByPriority`：shutdown（request/approved/rejected）最高（防 peer 消息饿死）→ lead 消息 > peer 消息，同级稳定排序保持 FIFO

* `attachInboxPoller` 与 `runTeammateTick` 共用排序；**投递成功后才 markRead**——onMessage/query 失败的消息保持未读，下轮重试（防丢消息）

* `runTeammateTick` 新增中断守卫：消息循环中状态被置 shutdown（如 approve\_shutdown 触发关停）时不再认领任务

### 2. task 依赖（blockedBy）与认领锁

* `SwarmTask.blockedBy?: string[]`（task\_create 工具可选输入）：依赖任务全部 completed 才可认领，指向不存在的任务视为未解决

* `claim` 在 `withLock` 内 busy-check（状态 + 依赖双重校验，文件锁防 TOCTOU）

* `tryClaimNextTask` 跳过依赖未解决/已被并发认领的任务，认领下一个可认领任务

### 3. idle\_notification（每轮结束上报）

* `createIdleNotification` helper（idleReason: available/interrupted/failed + summary）

* `runTeammateTick` 每轮结束向 leader 发 idle\_notification：无任务 → available；结果异常 → failed；消息循环中途被关停 → interrupted（且不再认领任务）

### 验证与提交

* 测试：swarm 55 用例全绿（+10：优先级排序 2 + poller 重试 1 + blockedBy 3 + 空闲通知 3 + createIdleNotification 1）

* 全仓 26 包 typecheck 通过

* 文档：架构 §9.4 第 4-6 项标记 ✅（plan approval / tmux 后端 / team file 字段 / send\_message 路由统一 留待办）

## 2026-08-26（续 9）：Swarm 待办前三项落地（mailbox 协议 + 权限双轨 + shutdown 模型决策）

对照架构 §9.4「Swarm 后续待办」，实现前 3 项（[packages/plugins/swarm/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/swarm/src/index.ts)）：

### 1. mailbox 协作协议类型扩展

* `MailboxMessageType` 扩至 15 种：message + permission\_request/response + sandbox\_\* + plan\_approval\_\* + shutdown\_request/approved/rejected + idle\_notification + task\_assignment + team\_permission\_update + mode\_set\_request + task\_notification

* `isStructuredProtocolMessage` 路由：结构化协议消息与普通 message 区分（poller/tick 按此路由，避免被当普通 LLM 上下文吞掉）

* 协议 helper 构造函数：`generateRequestId`（前缀+自增序列）、`createPermissionRequest/Response`（requestId/replyTo + data.allow/forever）、`createShutdownRequest/Decision`（shutdown\_request → approved/rejected）

* `SendTeammateMessageInput.type` 同步扩展（shutdown\_request/shutdown\_approved/shutdown\_rejected/idle\_notification）

### 2. 权限 mailbox 双轨 fallback

* `requestSwarmPermission`：有 leader 桥走 confirm queue（workerBadge）；无桥且提供 mailbox/team/leaderName 时降级 mailbox——`sendPermissionRequestViaMailbox` 写 permission\_request 到 leader inbox + `registerPermissionCallback` 挂起回调；leader 写回 permission\_response 后由 `processMailboxPermissionResponse` 命中 requestId 配对 resolve（data.allow/forever）；双轨皆无 fail-closed 拒绝

* `runTeammateTick` 每轮最先处理挂起的权限响应，再读普通消息

* 新增 `unregisterLeaderConfirmQueue`（对称清理，测试复位全局状态）

### 3. shutdown 模型决策

* `runTeammateTick` 对 `shutdown_request` 不直接关停：注入 query（含 requestId）由模型调用 `approve_shutdown`/`reject_shutdown` 工具决策（对齐 Claude Code approveShutdown）

* `createShutdownDecisionTool('approved'|'rejected')`：回发 shutdown\_approved/shutdown\_rejected（replyTo=requestId）；approve 时通过 onDecision 回调触发关停

* 插件注入：approve 工具按 memberName 查 teammateRegistry，命中则 abort + 状态置 shutdown；reject 仅回发响应

### 验证与提交

* 测试：swarm 45 用例全绿（+11：协议 helper 5 + 权限 fallback 3 + shutdown 工具 3），插件注入清单更新为 11 个工具

* 全仓 26 包 typecheck 通过

* 文档：架构 §9.4 前三项标记 ✅（inbox poller 优先级 / task 依赖锁 / idle\_notification / plan approval / tmux 后端 / team file 字段 / send\_message 路由统一 留待办）

## 2026-08-24（续 8）：写锁设计修正（声明级 → 文件级）+ Swarm 待办记录

### 1. FileWriteArbiter：文件级写锁（替代派工声明级仲裁）

**问题（用户反馈）**：初版 `CoordinatorFileArbiter` 只在 subagent 工具调用时触发，且按 `targetFiles`/`writesTo` 在**派工时**整组阻塞——agent 实际写哪些文件执行前并不确定，声明级锁会误伤不相关 worker，且锁持有到 worker 生命周期过长。

**修正**（[packages/plugins/coordinator/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/coordinator/src/index.ts)）：

* 重命名为 `FileWriteArbiter`：按 canonical 路径跨 session 互斥（per-path FIFO 等待队列），同 session 内天然串行直接放行

* 锁持有 = **单次写工具调用**：`tool.pre.execute` 对 `write_file`/`edit_file`（从输入 `path` 提取目标）执行前 `acquireWrite`、finally `releaseWrite`；subagent 派工不再做任何声明级阻塞（仅保留 forceAsync）

* `SubagentToolInput.targetFiles` / `AgentDefinition.writesTo` 保留为提示性声明，不参与仲裁；bash 无法可靠解析写入路径，不纳入（与 Claude Code 一致靠 prompt 纪律兜底）

* 测试：coordinator 25 用例全绿（FileWriteArbiter 6 + 插件集成 5：跨 session 阻塞/并行/顺序释放/非写工具不拦截/开关）

### 2. Swarm 待实现功能记录（对照 Claude Code 源码调研）

已记录到架构文档 §9.4「Swarm 后续待办」10 项：mailbox 协议类型扩展（permission/sandbox/plan\_approval/idle\_notification 等 + isStructuredProtocolMessage 路由）、权限 mailbox 双轨 fallback、shutdown 模型决策（approveShutdown 工具）、inbox poller 优先级 + 投递后 markRead、task blockedBy 依赖 + claim 文件锁防 TOCTOU、idle\_notification、plan approval 自动批准 + permissionMode 继承、tmux/iTerm2 后端、team file 字段补全 + setLeaderTeamName、send\_message 路由统一（resume + mailbox + broadcast）

## 2026-08-24（续 7）：targetFiles 写入源 + in-process teammate 完整执行循环

### 1. targetFiles 写入源修复（Coordinator 串行化真实生效）

* **问题**：`SubagentToolInput.targetFiles` 是可选字段，但 `makeSchema` 不透传 LLM 可见 schema、工具描述未提及、coordinator 只读不填——**无任何写入来源**，仲裁器实际不会触发

* **修复**：`AgentDefinition` 新增 `writesTo?: string[]`（[packages/agent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/agent/src/index.ts)，frontmatter `writesTo:` 解析）；coordinator `tool.pre.execute` 在调用未显式传 `targetFiles` 时，自动从被派 Agent 定义 `writesTo` 填充（显式传参优先）

* 测试：agent 23 用例（+2 writesTo 解析）、coordinator 30 用例（+1 定义回退仲裁）

### 2. in-process teammate 完整执行循环（@harness/swarm）

对齐 Claude Code `spawnInProcessTeammate` + `inProcessRunner` teammateLoop + `tryClaimNextTask`：

* **`spawnInProcessTeammate`**：加入/创建团队（新建时 lead=自身）→ 创建独立子 session → 注册（默认全局 `teammateRegistry` 单例，可注入隔离实例）→ 带初始 prompt 立即执行一轮（AsyncLocalStorage 身份上下文）

* **`runTeammateTick`**（单轮执行体）：① mailbox 未读消息——普通消息作为 query 输入、回复写回发送者、标记已读；shutdown 类型消息触发 abort + 状态置 shutdown；② `tryClaimNextTask`——认领 available 任务 → query 执行 → 更新任务 completed/failed + 向 leader 发 task\_notification（replyTo=taskId）

* **`startTeammateLoop`**：周期驱动 tick（intervalMs 可配），stop()/shutdown 消息停止

* 修复：spawn 时团队新建后 teammate 未入队（补 addMember）

* 测试：swarm 34 用例全绿（+6：tick 消息处理/任务完成/任务失败/shutdown + spawn 注册/loop 自动执行）

### 验证与提交

* 全仓 26 包 typecheck 通过；agent 23 + coordinator 30 + swarm 34 测试全绿

* 文档：架构 §9.4 Coordinator 补 writesTo 自动填充说明、Swarm in-process 完整循环 ✅（tmux/iTerm2 后端留待办）

## 2026-08-24（续 6）：Coordinator 写操作串行化 + Swarm Plugin（@harness/swarm）

### 1. Coordinator 写操作按文件集串行化（§9.4 收官）

* `SubagentToolInput` 新增 `targetFiles?: string[]`（worker 派工时声明要写的文件/目录，调度元数据，subagent 工具本身不消费）

* `CoordinatorFileArbiter`（[packages/plugins/coordinator/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/coordinator/src/index.ts)）：`pathsOverlap` 前缀匹配冲突检测（相同/目录子路径/祖先后代）+ FIFO 等待队列

* `tool.pre.execute` 拦截 subagent 调用：冲突派工 `await acquire(toolUseId, targetFiles)` 阻塞；后台任务由 subagent.completed/failed 事件（按 toolUseId）释放声明，同步任务在 next() 返回时 finally 释放

* `createCoordinatorPlugin({ serializeWrites: true })` 默认开启，仅对声明了 targetFiles 的调用生效；forceAsync 与仲裁合并到同一 preHook

* 测试：coordinator 29 用例全绿（新增 pathsOverlap 6 + arbiter 5 + 串行化集成 5）

### 2. Swarm Plugin 新包 `@harness/swarm`（§9.4 Swarm 项核心落地）

参考 Claude Code swarm（teammateMailbox / TeamCreateTool / TaskCreateTool / TaskStopTool / leaderPermissionBridge / spawnInProcess），存储根 `~/.harness/teams/`：

* **TeamManager**：team file 持久化（`{name}/team.json`，name/description/lead/members，同名成员覆盖），create/get/list/addMember/delete，create 时初始化 inboxes/

* **TeammateMailbox**：`{name}/inboxes/{agent}.json` 文件收件箱，`withLock`（原子 'wx' 锁文件 + EEXIST 重试 + 超时）串行化并发写；readUnread/markMessageAsReadByRef/countUnread

* **TaskListPlane**：`{name}/tasks.json` 共享任务池，状态机 available → in\_progress → completed/failed/cancelled（生命周期校验 + claim 冲突检测 + stop 统一 kill switch）

* **LeaderPermissionBridge**：module-level `registerLeaderConfirmQueue`（CLI/REPL 注册 leader 确认入口）+ `requestPermissionThroughLeader`（teammate ask 权限带 workerBadge 回流 leader；无桥 fail-closed 拒绝）

* **InboxPoller**：`attachInboxPoller` 周期轮询未读消息回调宿主（纯逻辑 + 手动 pollOnce，可独立测试）

* **in-process teammate 基础**：`TeammateRegistry` + `withTeammateIdentity`（AsyncLocalStorage 身份隔离）+ `formatAgentId`（{name}@{team}）；完整执行循环 + tmux/iTerm2 后端列后续

* **工具**（tool.pool.assemble 注入全部 Agent）：team\_create/team\_delete/team\_status、send\_teammate\_message（mailbox 路由，避免与 coordinator send\_message 冲突）、task\_create/list/claim/update/stop

* 测试：swarm 28 用例全绿（sanitizeName 2 + TeamManager 5 + Mailbox 4 + TaskList 5 + PermissionBridge 2 + Poller 2 + teammate 2 + 工具 5 + 插件 1）

* 踩坑：`withLock` 首版 catch 吞掉 ENOENT（父目录不存在）→ 无限重试锁超时；修复为 withLock 内先 mkdir 父目录 + 仅 EEXIST 重试

### 验证与提交

* 全仓 26 包 typecheck 通过；coordinator 29 + swarm 28 + subagent 92 测试全绿

* 文档：架构 §9.4 Coordinator 全部 ✅、Swarm 核心 ✅（完整执行循环/tmux 后端留待办）；development-log 续 6

## 2026-08-24（续 5）：§10.4 双后端 + 存储治理（快照 fallback / gc / 上限）

### 重构 `@harness/snapshot` 为双后端（[packages/snapshot/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/snapshot/src/index.ts)）

实现 §10.4 全部 4 项边界外增强：

* **`SnapshotService`** **从 class 改为 interface**，`GitSnapshotService`（默认，OpenCode git tree 方案）+ 新增 `FileSnapshotService`（Claude Code fileHistory 文件副本方案）双实现

* **工厂 auto 探测**：`createSnapshotService({ backend: 'auto'|'git'|'file' })`；auto 用 `resolveGitBin()`（依次查 PATH / `/usr/bin/git` / `/opt/homebrew/bin/git`，带缓存）探测 git，不可用自动降级 file 后端；`runGit` 同步改用解析出的 git 二进制（修复终端 PATH 异常下 git 不可用）

* **FileSnapshotService**（不依赖 git）：

  * 存储：`~/.harness/file-snapshots/{worktree-hash}/`（`backups/{sha256_16}@v{n}` + `snapshots.json` 快照链，ID `fs-{seq}`）

  * **三级变更检测**（对齐 `checkOriginFileChanged`）：`FileBackupMeta` 记录 `backup/version/mode/size/mtime`；stat（mode/size/mtime）一致直接复用；变化再内容级兜底，一致仍复用（增量快照）；不同才 `copyFile` 新备份

  * `restore`/`checkout` 幂等：目标备份 null → `rm`（对齐 applySnapshot unlink 分支），否则 `copyFile` + `chmod` 恢复权限

  * diff 用简化行 diff（前缀/后缀公共行 + 中间区贪心对齐，识别"插入在中间"的公共行），unified patch + 增删统计

  * `gc()`：清理快照链不再引用的 `@v{n}` 备份

* **check-ignore**：git 后端 `--exclude-standard` 隐式复用用户 .gitignore；file 后端惰性读根 `.gitignore`（简化 matcher：`*`/`**`/`?`/目录 `/` 结尾/`!` 取反/`#` 注释）+ 跳过 `.git` 与 worktree 内 dataDir

* **git gc + 上限**：`GitSnapshotService` 新增 `snapshot-ids.json` 注册表（`maxSnapshots` 默认 100 淘汰最旧）+ `gc()`/`gcUnlocked()`（`git gc --prune=7.days`），capture 每 `gcEvery` 次（默认 50）自动 gc

### 踩坑修复

| 问题                                       | 原因                                                                             | 修复                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| 自动 gc 时 capture 返回 undefined（快照丢失）       | `recordSnapshotId` 内调 `this.gc()`，与外层 capture 的 `mutex.run('tree')` 同 key 嵌套死锁 | 抽 `gcUnlocked()` 无锁内部方法，公共 `gc()` 加锁、锁内路径直调无锁版 |
| file 后端每次 capture 都新建备份（增量快照失效）          | `FileBackupMeta` 未存 size/mtime，`info.size === prev.size` 恒 false               | 补 `size`/`mtime` 字段，三级检测 stat 级对齐              |
| file 后端 diff 统计偏差（公共行 'three' 被算作 -/+）   | 简单前后缀匹配在"插入在中间"时失准                                                             | 中间区贪心对齐：对 a 剩余行在 b 剩余区间顺序查首个匹配                 |
| tsc 报 `number \| bigint` / `Dirent` 泛型错误 | `Awaited<ReturnType<typeof stat>>` 解析为联合类型                                     | 显式 `import type { Stats, Dirent }`             |

### 测试与验证

* snapshot 包 **25 用例全绿**（原 11 + git 后端 gc/上限 3 + file 后端 8 + 工厂 3）；`typecheck` 通过

* 全仓 25 包 typecheck 通过；core/revert/cli 既有用例无回归

* 注：`@harness/tools-builtin`（bash 工具）与 `@harness/permission`/`@harness/session`（无测试文件）失败为既有环境问题（终端 PATH 缺 `/bin` 导致 `spawn('bash')` ENOENT），与本次改动无关

### 文档

* [docs/agent-harness-architecture.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/agent-harness-architecture.md) §10.4 由「后续增强（边界外）」更新为「双后端 + 存储治理（✅ 已实现）」，4 项 ☐ 全部改为 ✅

## 2026-08-24（续 4）：CLI /revert 命令（文件快照回滚交互）

### 接入 `@harness/cli`（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

实现 §10.3 第 5 条：CLI `/revert` 命令闭环（capture 挂消息 → stage 回滚 → clear/commit）：

* `HarnessAppOptions` 新增 `snapshot?: boolean`（默认 false）：开启时创建 `SnapshotService`（基于 resolve 后的 cwd）注入 `createHarness.snapshot`（自动挂载 meta.snapshot），并启用 `/revert` 命令

* `/revert` 子命令：`stage <messageID>`（回滚 + 逐文件 diff 展示，patch 截断 400 字符）/ `clear`（撤销）/ `commit`（接受）/ `status` / `help`；未启用快照时提示；异常经 try/catch 打印"回滚失败"不崩溃

* `/help` 列表新增 `/revert`；`REPL_COMMANDS` 注册

* cli 新增依赖 `@harness/snapshot`、`@harness/revert`

* 测试：cli 新增 6 用例（未启用提示 / help / status / stage 错误路径 / 未知子命令 / help 列表），27 用例全绿；全仓 typecheck 通过

## 2026-08-24（续 3）：core 自动 capture 挂载（AgentRuntimeImpl.query / queryStream）

### 接入 `@harness/core`（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）

实现 §10.3 第 1 条：AgentRuntime 每轮自动快照并挂载到消息：

* `AgentHarnessOptions` 新增可选 `snapshot?: () => SnapshotService`（@harness/snapshot 工厂），`createHarness` 透传给 `AgentRuntimeImpl`

* `AgentRuntimeImpl` 新增 `captureForMessage(sessionId)`：每轮 LLM 调用后、工具执行前 `capture()`，`files` = 相对上一轮快照的变更文件（按 sessionId 维护 `lastSnapshots`，首轮为空）；capture 失败 best-effort（返回 undefined 不中断推理）

* `query()` / `queryStream()` 生成的 assistant 消息挂 `meta.snapshot = { start, files }`（对齐 OpenCode `message.snapshot`），供 `@harness/revert` 的 `collectSnapshotMap` 收集回滚目标

* 未注入 snapshot 工厂则不启用（向后兼容，现有调用不受影响）

* core 新增依赖 `@harness/snapshot`（workspace:\*）

* 测试：core 新增 5 用例（query/queryStream 挂载、第二轮 files 计算、未注入不挂载、capture 失败 best-effort），27 用例全绿；全仓 typecheck 通过

## 2026-08-24（续 2）：Revert 三态 + Bus 事件（`@harness/revert`）

### 新包 `@harness/revert`（[packages/revert](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/revert/src/index.ts)）

实现 §10.3 会话级文件回滚三态（对齐 OpenCode `SessionRevert.stage/clear/commit`）：

* **`SessionRevert.stage({ sessionId, messageID, snapshotMap? })`**：定位边界消息 → `collectSnapshotMap` 收集其后 assistant 消息的快照引用（或显式 `snapshotMap`）→ `SnapshotService.restore` 选择性回滚 → `diff(original → 回滚后)` 生成回滚 diff → 保存 `session.meta.revert`（RevertState）→ 发布 `snapshot.revert.staged`；重复 stage 沿用首次 original

* **`clear(sessionId)`**：按 RevertState 恢复回滚前原始快照（撤销回滚）→ 发布 `snapshot.revert.cleared`；**`commit(sessionId)`**：接受回滚 → 清除状态 → 发布 `snapshot.revert.committed`

* **消息快照引用约定**（对齐 OpenCode `message.snapshot`）：`message.meta.snapshot = { start, files }`，提供 `attachSnapshotToMessage()` / `collectSnapshotMap()` 辅助

* **Bus 事件**：`RevertEvents.staged/cleared/committed`（域 `snapshot.revert.*`）

* 自定义错误 `RevertError(operation, message, cause)`

* 测试：10 用例全绿（stage 回滚 + 事件 / snapshotMap 覆盖 / 错误路径 / clear 撤销 / commit 接受 / 重复 stage 沿用 original / 挂载与收集辅助）；typecheck 通过

* ✅ 已实现（core 集成，见续 76）：AgentRuntime query 开始时自动 capture + attachSnapshotToMessage——cli 注入 `snapshotService` factory（[cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1305)），core `captureForMessage()` 在 query/queryStream 主循环开始时 capture 并把 `meta.snapshot` 挂到 assistant 消息，`core.test.ts` 覆盖。

## 2026-08-24（续）：Snapshot 调研 + `@harness/snapshot` 包骨架

### 调研：OpenCode / Claude Code 快照与回滚方案

* `reference/` 更新：新增 `opencode-dev/`（OpenCode **完整真实源码 v2**），`claude-code-analysis-main` 补充《快照与回滚.md / 快照与回滚2.md》深度分析文档

* **OpenCode v2**（`packages/core/snapshot.ts` + `git.ts`）：独立 git 仓库 + `git write-tree` 内容寻址；`capture`（diff-files + ls-files → add --sparse → write-tree）、`preview`（临时 GIT\_INDEX\_FILE 零副作用）、`restore`（ls-tree 判定 → checkout / rm）、`checkout`（read-tree + checkout-index）；消息内嵌 `snapshot.start`，`SessionRevert.stage/clear/commit` 三态

* **Claude Code**（fileHistory.ts）：文件副本方案，`{sha256_16}@v{n}` 备份 + 快照链（上限 100）；编辑前 trackEdit + 回合结束 makeSnapshot；三级变更检测（stat/mtime/内容）；`fileHistoryRewind` → applySnapshot（unlink/restoreBackup/skip 幂等）

* **结论**：本项目采用 OpenCode git tree 方案（去重、复用 git 语义、可预览），Claude Code 文件副本保留为非 git fallback

### 新包 `@harness/snapshot`（[packages/snapshot](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/snapshot/src/index.ts)）

* `SnapshotService`：`capture / files / diff / preview / restore / checkout`，快照仓库 `~/.harness/snapshots/{worktree-hash}`（独立于用户 .git）

* `GitRepo`（--git-dir/--work-tree 显式指定）+ `KeyedMutex`（按仓库串行化写操作）+ `SnapshotError`

* 安全边界：restore 路径逃逸校验；>2MB untracked 跳过；capture best-effort

* 踩坑修复：① diff/preview 内嵌套调用同 key 互斥锁 → 死锁超时，抽取 `filesUnlocked`/`diffUnlocked`；② preview 未刷新 index → 基准树过期，先 `refresh('.')` 再 write-tree

* 测试：11 用例全部通过（hash 稳定性 / files / diff / restore / checkout / preview 零副作用 / 大文件跳过 / disabled），typecheck 通过

### 文档

* [docs/agent-harness-architecture.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/agent-harness-architecture.md) 新增 §10「文件历史与回滚」（选型对比 / 包设计 / 集成路线 / 后续增强）

## 2026-08-24：Subagent 后台展示层完善 + Coordinator 插件

### 今日完成

#### 1. P0-1/P0-2：Prompt 决策指导 + Agent 级后台声明

* `SubagentTool` 描述增强：前台/后台决策规则 + "Don't sleep/poll/peek" 反模式；清理 `task_status` 工具残留文案

* `AgentDefinition` 新增 `background?: boolean`（[packages/agent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/agent/src/index.ts)），`agentFromMarkdown` 支持 frontmatter 解析；后台判定并入 `agentDef.background`

#### 2. P1-4：前端事件驱动展示

* `@harness/subagent` 新增 UI 无关 `BackgroundTaskMonitor`（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）：订阅 subagent.started/completed/failed 维护任务快照

* `@harness/cli` 新增 `attachBackgroundTaskPanel`（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）：任务状态实时打印，`startRepl` 自动挂载

#### 3. P1-5：进度推送

* 新增 `subagent.progress` Bus 事件（toolName/toolStatus/summary/timestamp）

* 后台执行改用 `agent.queryStream` 遍历工具调用事件发布进度；Monitor 任务视图新增 `progress[]`；CLI 面板增量打印

#### 4. Coordinator 插件（新包 `@harness/coordinator`）

**新包**：[packages/plugins/coordinator](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/coordinator/src/index.ts)，`dependsOn: ['subagent']`，把主 Agent 变成 orchestrator：

* **Coordinator 身份**：`AgentDefinition.mode === 'coordinator'` 时通过 `prompt.system.transform` 注入 `COORDINATOR_SYSTEM_PROMPT`（四阶段 Research→Synthesis→Implementation→Verification + 派工规则 + 反模式）

* **Barrier 自动集齐**：`CoordinatorBarrierTracker` 跟踪 per-session 后台任务，全部完成/失败后发布 `coordinator.barrier.completed` 事件；CLI `attachAutoContinue` 订阅后注入 `<continue/>` 自动触发下一轮 query（解决"多调研→等齐→自动汇总"）

* **forceAsync**：插件选项或 `HARNESS_FORCE_ASYNC=true`，`tool.pre.execute` 拦截 subagent 调用强制后台化（原 P2-6）

* **send\_message 工具**：续跑已有 taskId（延续 worker 会话上下文），仅注入 mode=coordinator 的 Agent；running 中拒绝、TASK\_NOT\_FOUND 兜底

#### 5. 测试

* coordinator 14 用例：BarrierTracker 单测 / send\_message / prompt 注入 / forceAsync / 事件发布

* cli 新增自动续轮 attachAutoContinue 2 用例；全仓 typecheck 通过

## 2026-08-23（续 6）：Subagent run\_in\_background + 并行执行

### 今日完成

为 Subagent 插件添加后台异步执行和并行子 Agent 调度能力，让主 Agent 能派出多个子 Agent 同时执行任务，提升复杂任务的并行吞吐。参考 Claude Code 的 `forkSubagent.ts` + `LocalAgentTask` 和 OpenCode 的异步任务模型。

#### 1. BackgroundTaskRegistry — 后台任务生命周期管理

**新增类** **`BackgroundTaskRegistry`**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

* 状态机：`pending → running → completed | failed`（每状态对应时间戳 `createdAt` / `startedAt` / `completedAt`）

* `register(input)`：分配 `task-{时间戳36进制}-{计数36进制}` 形式 taskId，状态初始为 `pending`

* `start(taskId)`：切换为 `running`，记录 `startedAt`

* `complete(taskId, result)`：切换为 `completed`，若未显式传 `durationMs` 则用 `completedAt - startedAt` 自动计算

* `fail(taskId, error)`：切换为 `failed`，记录 `errorCode` / `errorMessage`

* `wait(taskId, timeoutMs)`：阻塞等待任务结束，内部用 `resolvers` 队列 + `AbortController` 实现超时，已完成任务立即返回

* `list(filter?)`：支持按 `status` 和 `parentSessionId` 过滤

* `cancel(taskId)`：触发 `AbortController.abort()`，返回是否取消成功

* `clear(filter?)`：清理已完成/失败任务

#### 2. SubagentTool — runInBackground 模式

**`SubagentTool`** **扩展** **`runInBackground`** **参数**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

* 输入 schema 新增 `runInBackground?: boolean`（默认 false，保持同步调用语义）

* `runInBackground=true` 时：

  1. `registry.register()` 注册任务 → 返回 taskId
  2. `registry.start(taskId)` 切换 running
  3. `void (async () => { ... })()` 异步执行子 Agent query，主 Agent 不阻塞
  4. 完成后 `registry.complete/fail(taskId, ...)` 更新状态
  5. 立即返回 `{ ok: true, output: { sessionId, taskId, background: true, message: '后台任务已启动...' } }`

* 异步块内复用同步路径的完整逻辑：超时控制（AbortController + 120s 默认）、工具调用摘要、临时文件输出、Bus 事件发布

* Bus 事件（`subagent.started/completed/failed`）新增 `taskId` 和 `background` 字段，支持后台任务跟踪

#### 3. TaskStatusTool — 后台任务查询

**新增工具** **`task_status`**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

* 输入：`{ taskId: string, wait?: boolean, timeoutMs?: number }`

* `wait=false`（默认）：立即返回任务当前状态（pending/running/completed/failed）

* `wait=true`：阻塞等待任务结束或超时（默认 30s），底层调用 `registry.wait(taskId, timeoutMs)`

* 错误码：`TASK_NOT_FOUND`（taskId 不存在）、`REGISTRY_NOT_READY`（registry 未初始化）、`TASK_WAIT_TIMEOUT`（等待超时）

* `isReadOnly: true`（查询操作不影响状态）

#### 4. /tasks CLI 命令

**新增** **`/tasks`** **命令**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

* 用法：`/tasks [running|completed|failed]`

* 无参数：列出所有后台任务（最多显示 50 条）

* 带状态参数：按状态过滤

* 每条任务显示：taskId、agentId、agentName、status、durationMs、prompt 预览（前 60 字符）

* 无子 Agent 配置时也注册此命令（只要有 harness 引用）

#### 5. 并行子 Agent 执行

`runInBackground=true` 的并行性由异步执行块 `void (async () => {})()` 保证，**不依赖** **`partitionToolCalls`**。

* `SubagentTool.isConcurrencySafe` 保持 `() => false`：子 Agent 可能修改共享状态（如文件），即使后台模式也不做并行调度承诺

* `partitionToolCalls` 会将多个 subagent 调用分到各自的串行批次，但每个批次只是注册任务 + 启动异步块 + 立即返回 taskId，几乎不耗时

* 真正的子 Agent 执行在各自异步块中并行运行，不受 `partitionToolCalls` 影响

* 多个写操作 Agent 操作同一文件的冲突由 agent 配置/worktree 隔离负责，不在工具调度层解决

#### 6. 测试

**@harness/subagent 新增 2 个测试套件共 17 个用例**（[packages/plugins/subagent/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.test.ts)）

* `BackgroundTaskRegistry`（8 用例）：register/start/complete/fail/wait/list/cancel/clear 全链路 + 并发任务独立性

* `SubagentTool runInBackground`（9 用例）：立即返回 taskId、子 Agent 失败时状态变 failed、TaskStatusTool 查询/等待/超时/不存在/无 registry、并行 3 个 background subagent 独立完成

* 更新 4 个已有测试断言：`tool.pool.assemble` 注入 2 工具、`/subagents` 注册 2 命令、无子 Agent 时仍注册 `/tasks`、`uninstall` 后 2 工具均不可用

#### 7. 验证

* `@harness/subagent` 单元测试：83 pass / 0 fail（272 assertions）

* 全量 typecheck：22 个包全部通过

* 无回归：原有 66 个测试保持通过

## 2026-08-23（续 5）：Skill / Agent 多级加载修复

### 今日完成

修复 Skill Layer 和 Agent 加载中"承诺多级、实际只有 project 一级"的问题，落地 user 级 + project 级两层加载，实现 project 覆盖 user 的优先级策略。

#### 问题回顾

Skill 代码注释宣称三来源合并（bundled/user/project/mcp）+ 优先级覆盖，实际实现：

* `SkillManagerImpl.load(dir)` 把目录路径硬编码为 `source: 'project'`

* CLI 只配置 `skillDirs: ['.harness/skills']` 单一目录

* core 遍历 skillDirs 不区分来源

Agent 加载存在同样问题：CLI 只配置 `agentDirs: ['.harness/agents']` 单一目录。

#### 1. 模块修复

**@harness/skill —** **`load()`** **接口增加 sourceTag 参数**（[packages/skill/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.ts)）

* 接口签名：`load(source: SkillSource | string, sourceTag?: SkillSource = 'project')`

* 当 `source` 为目录路径时，用 `sourceTag` 标记来源（user/project/mcp）

* `skillFromMarkdown` 调用时传入 tag，MCP 来源强制 `allowEmbedShell=false`

* 同 ID 后加载覆盖先加载（map.set 覆盖语义）

* 注释更新：MCP 来源建议通过 register() 注册从 MCP Server 拉取的 Skill

**@harness/core —** **`skillDirs`** **/** **`agentDirs`** **接口扩展**（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）

* `skillDirs?: Array<string | { dir: string; source?: SkillSource }>`（兼容字符串和对象形式）

* `agentDirs?: Array<string | { dir: string; source?: 'user' | 'project' }>`（同上）

* Skill 加载逻辑（init() 中）：从 entry 提取 `dirPath` + `sourceTag`，调用 `this.skillManager.load(resolvedDir, sourceTag)`

* Agent 加载逻辑（构造函数中）：从 entry 提取 `dirPath`，按数组顺序遍历（同 ID 后加载覆盖先加载）

* 顶部 import 补 `type SkillSource`

**@harness/cli — 默认配置两级加载**（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

* `agentDirs: [{ dir: '~/.harness/agents', source: 'user' }, '.harness/agents']`

* `skillDirs: [{ dir: '~/.harness/skills', source: 'user' }, '.harness/skills']`

* user 在前、project 在后，project 覆盖 user

#### 2. 测试

**@harness/skill 新增 3 个测试用例**（[packages/skill/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.test.ts)）

* `多级加载：user → project 顺序，project 覆盖 user（同 ID 后加载覆盖先加载）`：同 ID 在 user/project 两级目录分别定义，验证 `loadedFrom === 'project'` 且 content 是 project 版本

* `sourceTag 缺省为 project`：调用 `mgr.load(tmpDir)` 不传 sourceTag，验证 `loadedFrom === 'project'`

* `sourceTag: user 不影响 allowEmbedShell（默认 true）`：验证 user 来源不被强制禁用 shell embed（只有 mcp 来源才强制禁用）

#### 3. 验证

* @harness/skill：21/21 测试通过（67 assertions）

* @harness/core：22/22 测试通过（86 assertions）

* @harness/cli：16/16 测试通过（52 assertions）

* 全部 22 个包 typecheck 通过，无回归

#### 4. 设计决策

* **API 兼容性**：`skillDirs`/`agentDirs` 同时支持字符串和 `{dir, source}` 对象形式，旧用法（字符串数组）默认按 project 处理

* **多级覆盖靠加载顺序**：core 按数组顺序遍历，user 目录在前、project 目录在后，依赖 `register()`/`skills.set()` 的覆盖语义，不需要显式优先级比较

* **MCP 来源不走文件目录**：MCP 来源的 Skill 一般从 MCP Server 拉取，建议通过插件用 `register()` 注册

* **Agent 不加 loadedFrom 字段**：Agent 没有来源相关的安全策略差异（不像 Skill 有 `allowEmbedShell` 安全切断），多级覆盖靠加载顺序保证即可

***

## 2026-08-23（续 4）：Skill Layer 实现

### 今日完成

实现双轨制 Skill Layer：Skill = 知识（Markdown 正文）+ Tool = 功能（代码执行），支持从文件系统加载 Markdown 格式的 Skill 定义，通过 paths 条件触发和 Agent 白名单控制注入到 system prompt。

#### 1. 模块开发

**@harness/skill — 双轨技能系统**（[packages/skill/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.ts)）

新建包，实现完整 Skill 系统：

* **Skill 接口**：id / name / description / loadedFrom / paths / userInvocable / agentBind / content / embeds / allowEmbedShell / allowedTools / model / effort

* **SkillSource 类型**：`bundled` | `user` | `project` | `mcp`（MCP 来源强制 `allowEmbedShell=false`，防 RCE）

* **SkillManager 接口**：`all() / get(id) / load(source) / matchByPath(path) / filterByAgent(agentId) / reload(id)`

* **SkillManagerImpl 实现**：

  * `load(dir)` 支持两种目录结构：`skills/skill-name/SKILL.md`（目录形式，Claude Code 风格）和 `skills/skill-name.md`（单文件形式）

  * `matchByPath(filePath)` 遍历所有 Skill，检查 paths glob 匹配

  * `filterByAgent(agentId)` 按 agentBind 过滤可用技能

  * `reload(id)` 从原始来源目录热重载

  * 同 ID 优先级：project > user > bundled > mcp（后加载覆盖先加载）

* **skillFromMarkdown** 解析函数：

  * 解析 frontmatter（简化 YAML 解析器，无外部依赖）+ body

  * `id` 优先取 `frontmatter.id`，最后 `fallbackId`（目录名）

  * `name` 优先取 `frontmatter.name`，最后 `fallbackId`

  * 提取内嵌资源：`!\`cmd\` ` → shell embed，`{{var}}\` → variable embed

  * MCP 来源强制 `allowEmbedShell=false`

* **formatSkillForPrompt** 格式化函数：`# Skill: ${name}` + `> ${description}` + Markdown 正文

**@harness/core — SkillManager 集成 + 注入 Hook**（[packages/core/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts)）

* `HarnessOptions` 新增 `skillDirs?: string[]` 配置项

* `HarnessImpl` 新增 `skillManager?: SkillManager` 字段（构造函数中实例化，避免构造函数 await）

* `init()` 方法中：

  1. 从 `skillDirs` 异步加载 SKILL.md（构造函数不能 await，延迟到 init）
  2. 仅当有 Skill 加载成功时才注册 `core.skill-injection` 插件（避免空 Hook）
  3. 插件实现 `prompt.system.transform` Hook：读取 `agent.skills` 白名单，注入对应 Skill 到 system prompt

* 新增 `core.skill-injection` 内置插件：`id: 'core.skill-injection'`，`version: '0.1.0'`，install() 返回 Hooks

**@harness/cli — 默认配置 skillDirs**（[packages/cli/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts)）

* `createHarness` 调用默认配置 `skillDirs: ['.harness/skills']`，支持从项目目录加载 Skill

#### 2. 测试

**@harness/skill 单元测试**（[packages/skill/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/skill/src/index.test.ts)）

18 个测试用例，62 个断言，全部通过：

* `skillFromMarkdown`：完整 frontmatter + body、无 name 用 fallbackId、无 frontmatter 用默认值、MCP 来源强制禁用 shell embed、非 MCP 来源默认允许、userInvocable: false、agentBind 绑定、内嵌资源提取

* `SkillManagerImpl`：register+get+all、filterByAgent（无/有 agentBind）、matchByPath glob 匹配、load 目录形式、load 单文件形式、load 不存在目录、reload 热重载

* `formatSkillForPrompt`：带描述格式化、无描述省略描述行

#### 3. 关键设计决策

* **双轨制**：Skill = 知识（Markdown），Tool = 功能（代码执行），分离关注点

* **三来源合并**：bundled / user / project / mcp，同 ID 后加载覆盖先加载

* **MCP 安全切断**：MCP 来源强制 `allowEmbedShell=false`，防 RCE（同 Claude Code 安全策略）

* **paths 条件触发**：glob 匹配文件路径自动注入上下文（参考 Claude Code loadSkillsDir）

* **Agent 白名单**：`agent.skills` 字段控制哪些 Skill 注入到该 Agent 的 system prompt

* **id 与 name 分离**：id 来自目录名或显式 `frontmatter.id`，name 是显示名（与 Claude Code 一致）

#### 4. 验证

* @harness/skill：18/18 测试通过（62 assertions）

* @harness/core：22/22 测试通过（86 assertions）

* @harness/agent：19/19 测试通过（42 assertions）

* 全部 22 个包 typecheck 通过，无回归

***

## 2026-08-23（续 3）：Subagent 工具调用摘要

### 今日完成

在 Subagent Bus 事件推送完成后，实现工具调用摘要功能：当子 Agent 最终回复过长时，自动截断文本 + 附加工具调用列表，避免上下文膨胀。

#### 1. 模块开发

**@harness/subagent — 工具调用摘要**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

新增 4 个 helper 函数 + 2 个输出字段 + 1 个配置项：

* `summarizeToolInput(toolId, input)` — 按 toolId 提取关键信息（read\_file→path, bash→command, glob→pattern, grep\_file→pattern, web\_fetch→url, 默认→第一个字符串值）

* `truncateStr(s, maxLen)` — 截断字符串加 `...` 后缀

* `countToolCalls(messages)` — 统计子 session 中所有 `type: 'tool'` part 数量

* `summarizeResult(messages, finalText, maxResultLength)` — 超过阈值时生成摘要 = 截断文本(500字) + 工具调用列表 + 截断提示

新增配置和字段：

* `SubagentPluginOptions.maxResultLength`（缺省 2000 字符）

* `SubagentToolOutput.summarized`（布尔，标记是否被摘要）

* `SubagentToolOutput.toolCallCount`（子 Agent 内部工具调用次数）

* `renderResult` 输出也包含 `summarized` 和 `toolCallCount`

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

* 8 个新增单元测试（[packages/plugins/subagent/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.test.ts) 工具调用摘要测试块）

* 覆盖：短结果不摘要 / 长结果摘要+工具调用列表 / 错误工具标记 / maxResultLength 可配置 / 无工具调用仅截断文本 / renderResult 新字段 / summarizeToolInput 按类型提取 / bash 长命令截断到 80 字符

* **subagent 包：41 pass / 0 fail / 154 assertions**

* 全量 typecheck：22 个包全绿

## 2026-08-23（续 2）：Subagent 实时进度推送（Bus 事件）

### 今日完成

在 Subagent 基础插件（独立 session + 递归白名单 + description/model/sessionId/parentId）完成后，实现 Subagent Bus 事件推送功能，让父 Agent / CLI / TUI 能实时感知子 Agent 执行进度。

#### 1. 模块开发

**@harness/subagent — Bus 事件推送**（[packages/plugins/subagent/src/index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.ts)）

定义 3 个类型安全的 Bus 事件（`SubagentEvents`）：

* `subagent.started` — 子 Agent 开始执行（agentId, agentName, subSessionId, parentSessionId, parentAgentId, parentMessageId, toolUseId, prompt, description, isContinuation, startedAt）

* `subagent.completed` — 子 Agent 完成（agentId, subSessionId, parentSessionId, toolUseId, replyPreview, messageCount, durationMs）

* `subagent.failed` — 子 Agent 失败（agentId?, subSessionId?, parentSessionId, toolUseId, code, message, durationMs）

关键设计：

* `HarnessLike` 接口扩展 `bus?: Bus`，在 `harness.start` hook 中自动获取（`HarnessImpl.bus` 是 public 字段）

* `call()` 方法在 6 个关键节点发布事件：HARNESS\_NOT\_READY / AGENT\_NOT\_FOUND / INVALID\_AGENT\_MODE / SESSION\_NOT\_FOUND / SESSION\_CREATE\_FAILED / SUBAGENT\_FAILED → `failed`；session 创建后 → `started`；成功 → `completed`

* `publishFailed` 闭包封装避免重复代码，`bus.publish().catch()` 确保事件发布失败不影响主流程

* 长 prompt 截断到 500 字符，长 reply 截断到 200 字符（均加 `...` 后缀）

* 增强 harness 健壮性检查：`!harness || !harness.agent || !harness.session` 统一返回 HARNESS\_NOT\_READY

#### 2. 测试

* 10 个新增单元测试（[packages/plugins/subagent/src/index.test.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/subagent/src/index.test.ts) Bus 事件测试块）

* 覆盖：成功执行 started+completed / 续接 session isContinuation=true / Agent 未注册 failed / Harness 未就绪 failed / 超时 started+failed / 无 bus 正常工作 / 长 reply 截断 / 长 prompt 截断 / SUBAGENT\_FAILED 含 subSessionId

* **subagent 包：33 pass / 0 fail / 122 assertions**

* 全量 typecheck：22 个包全绿

## 2026-08-22（续）：会话管理增强 + CLI 扩展 + MCP Client 插件

### 今日完成

在 Phase 4 会话 Compaction 之后，连续推进三项 P1/P2 交付：会话管理增强（标题/搜索/导出）、插件化 CLI 命令扩展（`cli.commands` / `cli.command` Hook）、MCP Client 插件（stdio + HTTP/SSE transport + resources/prompts 发现 + Bearer 鉴权）。**18 个包 typecheck 全绿，43 个新增单元测试全通过（@harness/mcp-client 34 + core/cli 新增 9）**。

#### 1. 模块开发

| # | 提交        | 模块 / 变更                                      | 能力                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 测试数 |
| - | --------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1 | `33974b1` | `@harness/core` `DefaultSessionManager` 会话增强 | ① `generateTitle()`：规则化标题生成（首条用户消息前 60 字符 + 工具调用密度提示 + 长文本截断标记）② `search(keyword)`：关键词检索（标题 + 消息文本 + 工具名 + 工具输入）③ `exportMarkdown(sessionId)`：渲染完整对话为 Markdown（系统记忆 + 用户/助手轮次 + 工具调用 codeblock + 元数据尾部）                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 6   |
| 2 | `33974b1` | `@harness/cli` 新增斜杠命令                        | `/search <keyword>` 调用 `session.search` 列出匹配会话；`/export [path]` 导出当前会话 Markdown 到文件或 stdout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —   |
| 3 | `195c12f` | `@harness/plugin` Hooks 扩展                   | 新增 `cli.commands(input)` Hook（插件注册可用斜杠命令到 `/help`）+ `cli.command(input)` Hook（插件处理自定义斜杠命令，可输出文本、控制 result: continue/exit）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 3   |
| 4 | `195c12f` | `@harness/cli` 插件命令分发                        | REPL 解析未知 `/xxx` 时依次调用插件的 `cli.command` Hook；`/help` 列出插件注册的命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —   |
| 5 | `82acf8e` | `@harness/mcp-client`（新包 v0.1.0）             | MCP Client 插件首版：`McpClient`（JSON-RPC 2.0 over stdio，initialize/tools/list/tools/call）、`StdioTransport`（spawn 子进程 + 行分隔 JSON 收发）、`convertMcpToolToHarnessTool`（MCP 工具 → Harness Tool，Fail-Closed 默认值）、`createMcpClientPlugin`（harness.start 连接 + tool.pool.assemble 注入 + `/mcp` CLI 命令）                                                                                                                                                                                                                                                                                                                                                                   | 9   |
| 6 | `139c00c` | `@harness/mcp-client` v0.2.0 增强              | ① `HttpTransport`：Streamable HTTP（MCP 2025-03-26），POST JSON-RPC，响应支持 JSON / SSE 流，自动缓存并回传 `Mcp-Session-Id` ② `SseTransport`：旧版 HTTP+SSE，GET 建立 SSE 流接收 `endpoint` 事件，POST 到该端点 ③ `defaultTransportFactory`：根据 `config.transport` 选择 ④ `McpClient` 扩展：缓存 `serverCapabilities`/`serverInfo`/`protocolVersion`；新增 `listResources`/`readResource`/`subscribeResource`/`listPrompts`/`getPrompt`；`onNotification` 接收 `resources/listChanged` 等通知 ⑤ `McpAuthConfig`：bearerToken / authorizationHeader / 自定义 headers ⑥ `/mcp` 子命令扩展：servers/tools/resources/read \<uri>/prompts/prompt \<name> ⑦ `autoInjectResources`：可选把资源 text 注入到 `prompt.system.transform` | 25  |

#### 2. 关键技术决策

* **标题生成不依赖 LLM**：规则化提取首条用户消息前 60 字符 + 工具调用密度提示，可离线、可重复、无费用，作为默认策略。后续可通过 hook 注入 LLM 生成版本。

* **搜索覆盖多维度**：标题 + 消息文本 + 工具名 + 工具输入四维匹配，单条命中即返回，避免漏检。

* **Markdown 导出格式约定**：系统记忆 → 用户/助手轮次（含工具调用 codeblock）→ 元数据尾部（会话 ID、消息数、压缩统计），可直接作为文档归档。

* **CLI 扩展用 Hook 而非硬编码**：插件通过 `cli.commands` 声明命令、`cli.command` 处理命令，CLI 层只做分发，保持开放-封闭原则。

* **MCP Transport 三态抽象**：`McpTransport` 接口统一 stdio/http/sse 三种传输，`send` 返回 `void | Promise<void>` 兼容同步/异步 transport；`defaultTransportFactory` 根据配置字段选择，缺省按 command/url 推断。

* **capabilities 驱动的方法可用性**：`McpClient.listTools/listResources/listPrompts` 先检查 `serverCapabilities` 对应字段，未声明时返回空数组（不调用 server），避免无效请求。

* **Bearer 鉴权分层**：`authorizationHeader` 优先级高于 `bearerToken`，便于用户直接传入完整 Authorization 头（如 OAuth2 流程外层拿到的 token）。

* **autoInjectResources 可选注入**：默认不注入资源到 system prompt（避免污染上下文），通过 `'all'` 或 `string[]` 策略显式启用，注入通过 `prompt.system.transform` hook 完成。

* **OAuth2 PKCE 暂不实现**：完整 OAuth2 授权码 + PKCE 流程需要独立 OAuth client 模块和回调服务器，复杂度高且与 MCP 协议本身解耦。当前提供静态 Bearer Token 注入，足以对接大多数 MCP Server。

#### 3. 遇到的问题与修复

| 问题                                              | 原因                                                                             | 修复                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 标题生成测试"长文本截断"用例失败                               | 测试用例文本长度不足 60 字符                                                               | 扩展测试用例文本长度，确保超过 60 字符触发截断逻辑                           |
| `cli.command` Hook 测试 `cliInput` 类型错误           | 缺少 `result` 可选属性                                                               | 显式定义 `cliInput` 类型，包含 `result?: 'continue' \| 'exit'` |
| MCP Client 旧测试 `listTools` 返回空                  | 扩展后 `listTools` 依赖 `capabilities.tools`，旧测试 mock initialize 响应未声明 capabilities | 补充 mock 响应 `capabilities: { tools: {} }`              |
| MCP Client `listPrompts` 请求悬挂超时                 | autoInject 测试 mock 未注册 `prompts/list`，但 capabilities 声明了 prompts               | 补注册 `prompts/list` 返回空数组                              |
| `defaultTransportFactory` stdio 测试 spawn ENOENT | 受限测试环境 PATH 缺 `/bin`，`echo` 找不到                                                | 改用绝对路径 `/bin/echo`                                    |
| HTTP transport SSE 流解析遗漏最后一段                    | `lastIndexOf('\n\n')` 未 flush 残留 buffer                                        | 循环结束后补 flush `buf + '\n\n'`                           |

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

***

## 2026-08-23：会话 Compaction（三级压缩 + 系统记忆注入）

### 今日完成

完成 Phase 4 的会话压缩能力：三种压缩策略（prune / summary / agent）、按阈值自动触发 `compactIfNeeded`、压缩后摘要作为长期系统记忆注入到 Agent system prompt；CLI 暴露 `/compact` 斜杠命令、resume/repl/run 启动时自动 compactIfNeeded。

**17 个包 typecheck 全绿（0 error）；与 compaction 相关 4 个新增单元测试全部通过**。

#### 1. 模块开发

| # | 模块 / 变更                                               | 能力点                                                                                                                                                                                                                                                                                                                                                              | 测试数     | <br /> | <br />                                                                                      | <br /> |
| - | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | :----- | :------------------------------------------------------------------------------------------ | :----- |
| 1 | `@harness/session` Session.meta schema 扩展             | 导出 `CompactionMeta`（压缩统计：count/lastStrategy/totalPrunedMessages 等）+ `CompactMemory`（摘要文本+轮次+记忆起点）+ `COMPACT_META_KEY` / `COMPACT_MEMORY_KEY` 约定；扩展 `CompactOptions`（`strategy` / `thresholdTokens` / `keepRecentMessages` / `summaryMaxChars` / `tokensPerMessage`）；`SessionManager` 接口新增 `compact(…, options?)` / `compactIfNeeded(…)` / `getCompactionInfo(…)` | —       | <br /> | <br />                                                                                      | <br /> |
| 2 | `@harness/core` `DefaultSessionManager` compaction 实现 | 三级策略：`prune`（只截断、保留最近 K 条）/ `summary`（规则摘要：角色分布+首末用户要点+助手节选+工具调用统计，无需 LLM）/ `agent`（复用 AgentRuntime.query 生成摘要，缺失时自动 fallback 到 summary）；多轮合并：把"前一轮 CompactMemory.summaryText"作为上下文附加在新摘要前方，跨压缩轮次保留长期记忆；统计写入 `Session.meta`                                                                                                                                      | —       | <br /> | <br />                                                                                      | <br /> |
| 3 | `@harness/core` `AgentRuntimeImpl` 系统记忆注入             | 新增 `appendCompactionMemory()` helper，在构建 system prompt（`query()` 与流式 `buildContext()` 两处）时把压缩记忆作为独立 system part 追加（在 `prompt.system.transform` hook 之前，允许插件二次改写）                                                                                                                                                                                                 | —       | <br /> | <br />                                                                                      | <br /> |
| 4 | `@harness/cli` 命令 + 自动压缩                              | 新增 \`/compact \[prune                                                                                                                                                                                                                                                                                                                                            | summary | agent  | auto]`命令，打印压缩后 meta+memory 摘要；在`repl / resume / run`进入交互前调用一次`compactIfNeeded\`，命中阈值时提示压缩结果 | —      |
| 5 | `@harness/core` `core.test.ts` Session Compaction 测试块 | 4 个关键验证：① summary 策略长度+meta/memory 统计 ② prune 策略不产生新摘要 ③ compactIfNeeded 阈值触发/no-op ④ system prompt 注入 memory 片段包含压缩标题、轮次与摘要正文                                                                                                                                                                                                                                   | 4       | <br /> | <br />                                                                                      | <br /> |

#### 2. 关键技术决策

* **Compaction 不直接压缩 system prompt**：我们的 system prompt 在 AgentRuntime 内动态拼合 agent.promptFragments 与 compaction memory，不写入 session.messages。压缩算法只处理 session.messages（约定不含 system 消息），避免重复拼接。

* **多轮摘要累积而非覆盖**：新一轮压缩时把"旧 CompactMemory.summaryText"作为"更早记忆"段落加在新摘要前方，避免 LLM 丢失更早语义；同时 `round` 单调递增，system memory 注入时会展示轮次。

* **默认阈值（8000 tokens × 500/msg）偏保守**：`compactIfNeeded` 默认使用 8000 tokens 触发（估算 = `messages.length × tokensPerMessage`，默认每条 500），与 keepRecentMessages=6（最近 3 轮）保证短对话永远不触发。

* **agent 策略采用 fail-closed fallback**：`agent` 策略优先走 AgentRuntime.query 调 LLM 生成摘要；若缺少 ChatProvider/AgentRuntime 或调用出错，不抛异常给业务，静默回落到 ruleBasedSummary，保证 compaction 永远可用。

* **summary 策略做确定性、无 LLM 依赖**：规则摘要按"首末用户要点 + 助手节选 + 工具调用统计 + 前压缩轮次提示"组合，可离线、可重复、无费用，作为默认策略。

* **CompactOptions 设计为单源**：`compact()` 的第二参数 `strategy` 与第三参数 `options.strategy` 等价，`strategy` 显式参数优先，便于 CLI 直接传策略、也便于程序化代码通过 CompactOptions 调用。

#### 3. 遇到的问题与修复

| 问题                                                                                                                                    | 原因                                                                                          | 修复                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 测试最初 `h.session.update(id, fn)` 报错 `update` 不存在于 `SessionManager` 接口                                                                  | `@harness/session` 暴露的是细粒度的 `updateMessage / addMessage / updatePart`，没有整 session mutate 入口 | 改用 helper `fillMessages(h, sessionId, rounds)` 循环调用 `h.session.addMessage` 注入消息                                                                   |
| core typecheck：`SessionManager` import 类型中缺 `CompactOptions / CompactionMeta / CompactMemory / COMPACT_META_KEY / COMPACT_MEMORY_KEY` | 新增类型未同步进 import                                                                             | 在 `import type` 块补齐，并 `import { COMPACT_META_KEY as COMPACT_META_KEY_VAL, COMPACT_MEMORY_KEY as COMPACT_MEMORY_KEY_VAL }` 引入运行时常量，避免同文件类型/值混合引用问题 |
| 无 test 文件的包（permission/agent/skill/session）`bun test` 返回 exit code 1                                                                  | 这些包只有 `scripts.test="bun test"`，默认 bun 找不到 \*.test.ts 返回 1                                  | 暂不在本次修（属 monorepo 历史脚本问题，与 compaction 无关）；逐个包验证 core、cli、builtin/plugin 均 0 fail                                                                  |

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

***

## 2026-08-21：流式输出 + Provider 扩展 + 工具插件化拆分

### 今日完成

在 Phase 3 基础上完成三项交付：流式输出打通全链路、新增 OpenAI Provider、按"原语才内置"原则拆分工具包。**14 个包 typecheck 全绿，215 个单元测试全通过（595 断言）**。

#### 1. 模块开发

| # | 提交        | 模块 / 变更                          | 能力                                                                                                                                                                                                                                         | 测试数 |
| - | --------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| 1 | `fb9c3ae` | `@harness/core` 流式输出             | `ChatStreamChunk` + `AgentStreamEvent` 类型；`ChatProvider.stream?()` 可选方法；`AgentRuntime.queryStream()` 边流式边处理工具调用；`SessionManager.promptStream()`；CLI REPL / `run` 子命令逐 token 打印                                                             | —   |
| 2 | `fb9c3ae` | `@harness/provider-anthropic` 流式 | `AnthropicChatProvider.stream()`：解析 SSE（`message_start` / `content_block_delta` / `message_delta`），yield `text_delta` / `tool_use_start` / `tool_use_delta` / `tool_use_stop` / `done`                                                     | 4   |
| 3 | `fb9c3ae` | `@harness/provider-mock` 流式      | `MockChatProvider.stream()`：逐 token 模拟输出，供无网络环境测试流式链路                                                                                                                                                                                      | —   |
| 4 | `ddc5db3` | `@harness/tools-builtin` 新增工具    | `list_dir`（目录列举：递归/隐藏文件/类型/大小）、`grep_file`（正则检索：glob 过滤/大小写/递归）、`edit_file`（精确替换：`oldString`→`newString`，`replaceAll`/多行/多重匹配校验）                                                                                                           | 16  |
| 5 | `4d39c29` | `@harness/provider-openai`（新包）   | OpenAI Chat Completions 对接：Bearer auth、Part→messages 序列化（`tool_calls` 数组 / `role:tool` 带 `tool_call_id` / `image_url` data: URI）、Tool Schema 导出、`complete()` 非流式 + `stream()` 流式（SSE `data:[DONE]` 终止、tool\_calls 按 index 累积 arguments 增量） | 17  |
| 6 | `e65543d` | 工具插件化拆分                          | `@harness/tools-builtin` 瘦身为 4 个原语（v0.3.0）；`list_dir`/`grep_file` 抽到新包 `@harness/tools-search`（v0.1.0，自包含 helper + `toolsSearchPlugin` 工厂）                                                                                                 | 14  |

#### 2. 关键技术决策

* **流式类型分层**：`ChatStreamChunk`（Provider 层，纯 LLM 输出）与 `AgentStreamEvent`（Agent 层，含工具执行结果）解耦，让 Provider 不感知工具执行

* **OpenAI 与 Anthropic 序列化差异**：Anthropic 用 `tool_use`/`tool_result` block；OpenAI 用 assistant.tool\_calls 数组 + 独立 `role:tool` 消息（带 `tool_call_id` 关联），两条序列化路径分别实现

* **工具流式增量累积**：OpenAI 的 `tool_calls` 按帧增量（首帧带 id+name，后续只带 arguments 片段），用 `Map<index, state>` 累积并按帧 yield `tool_use_delta`

* **"原语才内置"判定原则**：内置仅留不可替代、不可组合替代、非场景化的工具。`read_file`/`write_file`/`edit_file`/`bash` 是文件 I/O + Shell 原语；`list_dir`/`grep_file` 属搜索导航场景（`bash ls/grep` 可替代），抽为独立插件

* **插件包自包含**：`@harness/tools-search` 自带 `resolvePath`/`isWithinCwd`/`makeSchema`/`globMatch` helper，不反向依赖 `@harness/tools-builtin`，保持插件可独立装卸

* **配置三级来源一致**：OpenAI Provider 沿用 `直接传入 > ctx.config.get('provider.openai') > 环境变量 OPENAI_API_KEY/OPENAI_BASE_URL` 优先级，与 Anthropic Provider 对齐

#### 3. 遇到的问题与修复

| 问题                                                    | 原因                              | 修复                                                                                            |
| ----------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `new-tools.test.ts` 类型错误 `res.output` 可能 undefined    | 测试直接访问 `res.output.count` 未做空断言 | 统一加非空断言 `res.output!.count`（仅在 `res.ok===true` 分支）                                            |
| `ToolContext` 缺 `toolUseId` 字段                        | 测试 ctx 构造遗漏该必填字段                | 补 `toolUseId: 'tu1'`                                                                          |
| 旧测试断言 `builtinTools` 6 个工具                            | 拆分后 builtin 仅 4 个、search 2 个    | 更新断言为 `['bash','edit_file','read_file','write_file']`，search 包独立断言 `['grep_file','list_dir']` |
| Anthropic stream 测试 mock fetch 类型不匹配                  | mock 返回类型与全局 `fetch` 签名冲突       | mock 函数返回类型改 `any`                                                                            |
| 拆分后 `readdir`/`join`/`globMatch` 成为 tools-builtin 死代码 | 仅被迁出的 list\_dir/grep\_file 使用   | 清理 imports 与 helper，迁入 tools-search                                                           |

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

***

## 2026-08-22：工具插件化持续扩展（glob/web/media 三场景包）

### 今日完成

延续"原语内置，场景按插件接入"的拆分原则，新增三个场景工具包。**17 个包 typecheck 全绿，248 个单元测试全通过（690 断言，较 08-21 +33 测试）**。

#### 1. 模块开发

| # | 模块（新包）                        | 工具           | 核心能力                                                                                                                                                                                                                                                                                    | 测试数 |
| - | ----------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1 | `@harness/tools-glob` v0.1.0  | `glob`       | 多模式 `**` / `*` / `?` 通配符；`!` 取反 + `exclude` 便捷字段；隐藏文件默认跳过；文件大小 min/max 过滤；最大深度限制；结果上限截断；cwd 边界保护                                                                                                                                                                                        | 9   |
| 2 | `@harness/tools-web` v0.1.0   | `web_fetch`  | HTTP(S) 抓取，支持 GET/POST/PUT/PATCH/DELETE；自定义 headers / body（对象自动 JSON 序列化）；三种返回格式 `text` / `json` / `base64`（data: URI）；follow redirects / maxBytes 截断 / timeoutMs + AbortSignal；SSRF 防护（默认拦截 10.x / 172.16-31 / 192.168 / 127.x / fc/fd / localhost\*.local）；`allowPrivateNetwork` 显式放行 | 14  |
| 3 | `@harness/tools-media` v0.1.0 | `view_image` | 本地图片读取转 base64 data URI + 尺寸解析（PNG/JPEG/GIF/BMP/WebP 魔数识别，含 PNG/GIF/BMP 宽高、JPEG SOF0 段遍历）；maxBytes + strictSize 模式（过大报错 or 仅回元数据）；cwd 路径边界保护                                                                                                                                            | 10  |

三包均按 `tools-search` 模板统一：

* 自包含 helper（resolvePath / isWithinCwd / makeSchema / 场景专用 helper），不反向依赖 `tools-builtin`

* `defineTool` + Fail-Closed 安全声明（`isReadOnly`/`isDestructive`/`isConcurrencySafe`），`permission.key` 按场景分配（`read`/`network`）

* `createXxxPlugin({ toolIds })` 工厂 + 默认导出 `toolsXxxPlugin` 常量

* 通过 `tool.pool.assemble` Hook 注入 `ToolRegistry`

#### 2. 关键技术决策

* **三插件均** **`isConcurrencySafe=true`** **声明**：glob 纯读、web\_fetch 请求幂等、view\_image 只读，可并行执行（Fail-Closed 需显式声明）

* **web\_fetch 权限键用** **`network`（非** **`read`/`write`）**：网络访问是独立能力维度，与本地文件的读写权限体系分离，可被 permission 引擎单独管控

* **SSRF 默认 fail-closed，白名单开启**：私有 IP / localhost / .local / 169.254 link-local 全部拦截，仅当调用方显式 `allowPrivateNetwork=true` 才放行——与 fail-closed 哲学一致

* **view\_image 尺寸解析零依赖**：纯字节判断 PNG IHDR/JPEG SOF0/GIF6/7/BMP DIB 头，不引入 sharp/jimp 等本地图像库

* **已 abort signal 同步快速路径**：web\_fetch 在进入 await fetch 前同步检查 `inner.signal.aborted`，避免 mock fetch 不监听 signal 时悬挂

* **glob 正则按段构建**：`**` 段末尾位置写 `.*`（匹配任何内容到结尾）、非末尾写 `(?:.*/)?`（包含段间 `/`），其它段单独转义后拼接，避免双重 `/` 问题

#### 3. 遇到的问题与修复

| 问题                                                 | 原因                                                                          | 修复                                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| glob `**/*.ts` 匹配空（递归、排除两个用例失败）                    | `globToRegex` 用 join('/') 把 `(?:.*/)?` 与下段之间插入了额外 `/`，导致必须存在 `/` 才能匹配（根层漏掉） | 改为按段逐段拼接：非末尾 `**` → `(?:.*/)?`（自带末尾 `/`）、非末尾普通段 → `escaped` + `/`                                                                             |
| `readFile(path, null, { length: 32 })` 三参数 TS 错误   | Node `fs/promises.readFile` 仅接受 `(path, options?)` 两参数，无 `length` 选项        | 改用 `open(path, 'r') → fh.read({ buffer, length: 32 }) → fh.close()` 三步                                                                        |
| `mkdirSync(join('src', { recursive: true }))` 类型错误 | 把 mkdirSync options 当 join 第三参数传入了（括号错位）                                    | 修正括号：`mkdirSync(join('src'), { recursive: true })`                                                                                            |
| `error.detail` TS 类型不匹配（`JSON_PARSE_ERROR` 中）      | Tool `ToolError` 结构仅 `{ message, code?, cause? }`，无 `detail`                | 把原始字节片段拼接到 `message` 字符串中，移除非法 `detail` 字段                                                                                                    |
| web\_fetch AbortSignal 测试 5s 超时挂死                  | 最初 mock fetch 返回永不 settle Promise，inner.signal abort 也无法让 hanging fetch 解挂  | 改写：1) 已 abort 用例改用"提前 abort signal + fetch 前同步检查快速失败"；2) timeout 用例 mock fetch 监听 init.signal 的 abort 事件，收到后 reject AbortError，settle Promise |

#### 4. 代码统计

```
17 个 packages / 248 个测试 / 690 个 expect（较 08-21 +3 包 +33 测试）

场景工具插件（按 tools-search 模板）：
  - @harness/tools-search   v0.1.0 list_dir / grep_file（搜索导航）
  - @harness/tools-glob     v0.1.0 glob（模式匹配）
  - @harness/tools-web      v0.1.0 web_fetch（网络抓取 + SSRF 防护）
  - @harness/tools-media    v0.1.0 view_image（多模态图像 base64 + 尺寸）
```

***

## 2026-08-16：Phase 1 \~ Phase 3 核心交付

### 今日完成

从架构设计到可运行的 CLI，一天内完成了 8 个模块的开发、测试与推送，共 **170 个单元测试全绿、12 个包 typecheck 0 error**。

#### 1. 架构设计

* 产出 [agent-harness-architecture.md](./agent-harness-architecture.md)

* 融合 Claude Code（6 层严格解耦 + Tool 运行时协议 + Fail-Closed 安全策略）与 OpenCode（Plugin Hooks 管道 + Bus 类型安全事件总线 + 4 级路径权限匹配）两者的优点

* 明确 4 阶段里程碑、12 项关键设计决策、与两个参考架构的 11 维对比

#### 2. 模块开发（按交付顺序）

| # | 模块                            | 能力                                                                                                                                            | 测试数 | PR |
| - | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --- | -- |
| 1 | `@harness/bus`                | 类型安全 Pub/Sub 事件总线：`BusEvent.define` + `InMemoryBus` + 全局订阅                                                                                    | 24  | #1 |
| 2 | `@harness/tool`               | Tool 协议（10+ 属性 + Fail-Closed）+ `ToolRegistry` 注册中心 + `ToolPipeline` 7 步生命周期 + 拓扑排序                                                            | 32  | #1 |
| 3 | `@harness/plugin`             | `PluginManager` 三级加载（Internal/Builtin/User）+ Kahn 拓扑排序 + 12 个 Hook 管道 + 热重载                                                                   | 32  | #1 |
| 4 | `@harness/core`               | `HarnessImpl` 生命周期编排 + 能力模块访问器（tools/agent/session/permission/bus/chat）+ `AgentRuntimeImpl` 主循环 + `DefaultToolPool` + `DefaultSessionManager` | 13  | #2 |
| 5 | `@harness/provider-mock`      | `MockChatProvider`：可配置默认响应 / 关键词匹配 / tool call 模拟 / 调用记录                                                                                      | 12  | #2 |
| 6 | `@harness/tools-builtin`      | `read_file` / `write_file` / `bash` 三个内置工具插件                                                                                                  | 32  | #3 |
| 7 | `@harness/provider-anthropic` | Anthropic Messages API 对接：Part→Block 序列化、Tool Schema 两级导出、fetch+超时+AbortSignal、配置三级来源                                                         | 12  | #4 |
| 8 | `@harness/cli`                | 命令行入口：REPL + 会话持久化 + 权限交互 + 多子命令（repl/run/resume/list-sessions）                                                                               | 13  | #5 |

#### 3. 关键技术决策

* **TypeScript + Bun**：原生 TS、零配置运行、fast test runner

* **Monorepo**：`packages/*` + `packages/plugins/*`，workspace 协议，tsconfig path mapping

* **Fail-Closed 安全策略**：所有新工具默认不可并发、非只读，需显式声明能力边界

* **Hooks 管道而非继承**：12 个 Hook 点（`harness.init` / `tool.pre.execute` / `permission.check` 等）让插件介入生命周期

* **Provider 自动 fallback**：CLI 检测到无 `ANTHROPIC_API_KEY` 时自动切到 Mock Provider 并打印提示

* **零外部依赖**：参数解析、glob 匹配、readline 交互全部内置实现，不引入 minimist / picomatch / inquirer

#### 4. 遇到的问题与修复

| 问题                                      | 原因                                    | 修复                                    |
| --------------------------------------- | ------------------------------------- | ------------------------------------- |
| Hook 触发顺序断言错误                           | Bad 插件先注册但 Good 插件 Hook 仍执行           | 修正测试断言，确认 Good 插件 Hook 未被执行           |
| logger 错误日志字符串不匹配                       | 实际日志带 `[plugin:X]` 前缀                 | 调整测试断言匹配实际日志                          |
| `loadBuiltin` 重复 ID 测试未注入 dynamicImport | 走到真实 Bun import 失败                    | 测试注入 custom dynamicImport 模拟加载        |
| `ToolRegistry` 重复注册 echo                | 第二次 query 重复注册工具                      | `DefaultToolPool.add/addAll` 已存在时静默跳过 |
| 多行命令测试失败                                | `echo "a\nb\nc"` 未正确解释换行              | 改用 `printf "a\nb\nc\n" \| grep b`     |
| `tool_result` block 多余 `is_error` 字段    | Anthropic API 不接受非错误时的 `is_error`     | 仅 `isError=true` 时写入 `is_error`       |
| CLI 短选项 `-s=foo` 解析失败                   | 未处理短选项 `=` 形式                         | 重写 parseCliArgs 短选项分支                 |
| 权限永久 allow/deny 判断失效                    | `toLowerCase()` 把大写 A/D 变成 a/d 命中单次分支 | 先判断永久（`answer === 'A'`），再判断单次         |

#### 5. 代码统计

```
8 个 packages / 12 个 tsconfig / 170 个测试 / 449 个 expect
5 个 Draft PR（#1 ~ #5）
```

***

### 下一步计划

#### Phase 4：实用化与扩展

| 优先级        | 方向                             | 说明                                                               | 状态                                                                   |
| ---------- | ------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| **~~P0~~** | ~~更多内置工具~~                     | ~~`list_dir`~~ ~~/~~ ~~`grep_file`~~ ~~/~~ ~~`edit_file`~~       | ✅ 完成（08-21，edit\_file 留 builtin，list\_dir/grep\_file 抽 tools-search） |
| **~~P0~~** | ~~流式输出~~                       | ~~Provider~~ ~~`stream: true`~~ ~~+ REPL 逐 token~~               | ✅ 完成（08-21，core/anthropic/mock 三端 stream）                            |
| **~~P1~~** | ~~`@harness/provider-openai`~~ | ~~GPT-4o 适配，统一 ChatProvider~~                                    | ✅ 完成（08-21，complete + stream）                                        |
| **~~P0~~** | ~~工具持续插件化~~                    | ~~tools-web / tools-glob / tools-media 三场景拆包~~                   | ✅ 完成（08-22，三新包 +33 测试）                                               |
| **P1**     | 会话管理增强                         | 标题自动生成、关键词搜索、导出 Markdown、Compaction（长会话摘要压缩）                     | ⬜ 待办                                                                 |
| **P1**     | 插件化 CLI 扩展                     | 插件可往 CLI 注册自己的子命令 / `/xxx` 斜杠命令                                  | ⬜ 待办                                                                 |
| **P2**     | MCP Client 插件                  | 对接 Model Context Protocol，支持 local stdio + remote SSE MCP Server | ⬜ 待办                                                                 |
| **P2**     | Subagent 插件                    | `AgentTool` + `runAgent()`，支持子 Agent 嵌套调用                        | ⬜ 待办                                                                 |
| **P2**     | Skill Layer                    | Markdown 技能 + paths 条件触发 + 三来源发现（bundled/user/project）           | ⬜ 待办                                                                 |
| **P3**     | TUI 形态                         | 基于终端 UI 的富交互（类似 Claude Code TUI）                                 | ⬜ 待办                                                                 |
| **P3**     | Swarm 协作                       | Team + Mailbox + Task List + 权限桥接（多 Agent 协作）                    | ⬜ 待办                                                                 |

#### 近期优先推进顺序

1. **~~流式输出~~** — ✅ 已完成
2. **~~`edit_file`~~** **~~+~~** **~~`list_dir`~~** **~~+~~** **~~`grep_file`~~** — ✅ 已完成（含工具插件化拆分）
3. **~~`@harness/tools-web`~~** **~~/~~** **~~`tools-glob`~~** **~~/~~** **~~`tools-media`~~** — ✅ 已完成（三场景包 33 测试）
4. **~~会话 Compaction~~** — ✅ 已完成（三级压缩 + 系统记忆注入）
5. **~~`@harness/provider-openai`~~** — ✅ 已完成
6. **~~会话管理增强~~** — ✅ 已完成（标题生成 + 关键词搜索 + Markdown 导出）
7. **~~插件化 CLI 扩展~~** — ✅ 已完成（cli.commands / cli.command Hook）
8. **~~MCP Client 插件~~** — ✅ 已完成（stdio + HTTP/SSE transport + resources/prompts + Bearer 鉴权）

#### 剩余待办

| 优先级        | 能力                            | 说明                                                                                                                       | 状态 |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -- |
| **P2**     | ~~Subagent 实时进度推送（Bus 事件）~~   | ~~子 Agent 执行过程中通过 Bus 发布进度事件（工具调用开始/结束、中间文本），父 Agent / CLI 可订阅展示~~ ✅ 完成（08-23，3 个事件：started/completed/failed + 10 个单元测试） | ✅  |
| **P2**     | ~~Subagent 工具调用摘要~~           | ~~子 Agent 内部工具调用链过长时生成摘要后返回父 Agent，避免上下文膨胀~~ ✅ 完成（08-23，summarizeResult + 8 个单元测试）                                       | ✅  |
| **P2**     | 基于 caller.permission 过滤 Agent | 根据调用者（父 Agent / 用户）的权限动态过滤可用子 Agent 列表，权限不足的子 Agent 不在 `/subagents` 列出 ✅ 已实现（`/subagents` 经 `filterAccessibleAgents`/`isAgentDenied`） | ✅ | 
| **P2**     | 配置文件加载 Agent                  | 从配置文件（如 `.harness/agents.yaml` 或 `harness.config.ts`）加载 Agent 定义，支持运行时动态注册子 Agent ✅ 已实现（core 经 `agentDirs` user→project 多级目录加载 + 覆盖）  | ✅ |
| **P2**     | Skill Layer                   | Markdown 技能 + paths 条件触发 + 三来源发现（bundled/user/project）                                                                   | 待做 |
| **~~P2~~** | ~~Provider 补全~~               | ~~Gemini / 通义 / 智谱 等多模型适配~~ ✅ 完成（08-23，Gemini 独立实现 + Qwen/GLM 复用 OpenAIChatProvider）                                     | ✅  |
| **P3**     | Subagent run\_in\_background  | 子 Agent 后台异步执行，父 Agent 不阻塞等待，通过 Bus 事件或轮询获取结果                                                                            | 待做 |
| **P3**     | ~~Subagent git worktree 隔离~~    | ~~子 Agent 在独立 git worktree 中执行，避免与父 Agent 工作区冲突~~ ✅ 完成（09-06，worktree.ts + 会话级 cwd 注入 + diff 回传，16 新用例） | ✅ |
| **P3**     | Swarm teammate                | Team + Mailbox + Task List + 权限桥接（多 Agent 协作）                                                                            | 待做 |
| **P3**     | ~~TUI 形态~~                    | ~~基于终端 UI 的富交互（类似 Claude Code TUI）~~ ✅ 完成（08-26，自研 ANSI alt-screen：`--tui` + 日志滚动 + 输入行 + 21 测试）                         | ✅  |
| **P3**     | OAuth2 PKCE                   | 完整 OAuth2 授权码流程（回调服务器 + token 刷新），用于对接 OAuth2-protected MCP Server                                                       | 待做 |

