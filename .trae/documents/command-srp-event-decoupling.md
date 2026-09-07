# 命令单一职责 + 事件跨层解耦

## Context（背景）

当前三类生命周期命令职责边界不清、存在重叠：

1. **/plugins**（插件生命周期）写在 CLI `HarnessApp` 里（`disablePlugin/enablePlugin/reloadPlugin`），不是独立插件包。
2. **/mcp** 在 `mcp-server-registry` 里，既管 server 生命周期，又带 `tool` 子命令做工具级掩码——与 `/tools`（tools-manager，Agent 白名单）控工具重叠。
3. **/tools**（tools-manager）只管 Agent 白名单，对 MCP 场景化工具的启停没有统一入口。

跨层副作用（禁用插件→其 server/工具不可用；禁用 server→其工具不可用）目前靠每 query 的 `tool.pool.assemble` 惰性体现，没有显式、可订阅的联动，耦合成分散写在各命令里。

目标：**命令单一职责**——`plugin` 只管插件生命周期、`mcp` 只管 MCP server 生命周期、`tool` 只管工具启停；**上层命令变更对下层的影响通过事件总线解耦**，下层订阅事件自行刷新，不再由上层命令直接改下层的内部状态。

## 分层与归属

```
插件生命周期（/plugins）         @harness/manage-plugin（新独立插件包）
 MCP server 生命周期（/mcp）     mcp-server-registry（仅 server；删 tool 子命令）
 工具启停（/tools）              tools-manager（统一唯一入口；含 mcp__ 前缀工具）
        └─ 跨层联动 → harness.bus 事件（plugin.* / mcp.* / tool.*）
```

数据模型不变：`config.json` 的 `agents[].tools`（Agent 白名单）与 `mcpServers[].tools`（server 级工具掩码）。工具掩码**统一经 `/tools` 写入**，`/mcp` 不再写掩码（句法上删除 `tool` 子命令）。

## 事件设计（新增，跨包复用需类型安全）

事件定义放 `@harness/core` 导出（与 `HarnessEvents` 同文件，plugins 依赖 core 拉取类型）：

```ts
export const LifecycleEvents = {
  pluginLoaded:   BusEvent.define<{ id: string }>('plugin.loaded'),
  pluginUnloaded: BusEvent.define<{ id: string }>('plugin.unloaded'),
  pluginUpdated:  BusEvent.define<{ id: string }>('plugin.updated'),
  mcpServerEnabled:  BusEvent.define<{ name: string }>('mcp.server.enabled'),
  mcpServerDisabled: BusEvent.define<{ name: string }>('mcp.server.disabled'),
  mcpServerAdded:    BusEvent.define<{ name: string }>('mcp.server.added'),
  mcpServerRemoved:  BusEvent.define<{ name: string }>('mcp.server.removed'),
  toolEnabled:   BusEvent.define<{ id: string; agentId?: string }>('tool.enabled'),
  toolDisabled:  BusEvent.define<{ id: string; agentId?: string }>('tool.disabled'),
} as const
```

职责划分：
- **谁发事件**：变更生命周期/启停状态的那一方（插件管理、mcp registry、tools-manager）。
- **谁订阅**：下层对上层变更敏感的组件注册 `harness.bus.subscribe`（在插件 `install` 里注册、`uninstall` 里退订），收到事件后自行刷新自身缓存/清单，**不反向改上层状态**。
- 排序：工具池仍每 query 组装，事件不用于实时拦截工具，而是用于让各命令（尤其 `/tools`、`/plugins` 的清单缓存与提示）保持一致。

## 改动清单

### 1. 新增插件包 `@harness/manage-plugin`（`packages/plugins/manage-plugin`）
- `createPluginManagerPlugin(): AgentPlugin`，`install` 返回 `cli.commands` + `cli.command`：
  - `/plugins`：`list`（沿用现状：读 `harness.plugin.list()` + 注入的可管理判定）；`enable|disable|reload <id>`。
  - 调用链：disable → `harness.plugin.unload(id)`；enable → 复用注入的可管理插件对象 `harness.plugin.loadInternal([obj])`；reload → `harness.plugin.hotReload(id)`。
  - 在启停成功后 `harness.bus.publish` 对应 `plugin.*` 事件。
- `setAgentTools` 式注入：CLI 通过 `CliCommandInput` 扩展字段注 `harness` 与 `manageable(enable/reload 用)：(id)=>AgentPlugin|undefined`。
- 包需注册到根 `tsconfig.json` paths + cli `package.json` dependencies + `bun install`；内置登记到 `BuiltinPluginRegistry`（`id:'manage-plugin'`）。
- AGENTS 一致：插件持久化不上手 config，启停仅运行时（对齐现状）；`/plugins` 展示保持 `ID | 元信息 | 权限键 | 状态` 风格。

### 2. `mcp-server-registry`（~0.3.0）瘦身 server 生命周期
- **删除 `/mcp tool <s> <t> on|off` 子命令**（工具级并入 `/tools`）；保留 `servers` / `tools`(只读展示) / `enable` / `disable` / `add` / `remove`。
- 对 `enable/disable/add/remove` 成功后在 `harness.bus` publish 对应 `mcp.*` 事件。
- 新增 `install` 内订阅：收到 `plugin.unloaded`（且 id=mcp-server-registry）或 `plugin.updated` 时，自行核对 managed 清单与 runtimes，必要时清理（保持只读自身状态）。
- `McpServerEntry.tools` 字段保留为「被 `/tools` 写入的 server 级掩码」，assemble 过滤逻辑不变（`managed.tools[name]===false` 跳过）。

### 3. `tools-manager`（~0.2.0）统一工具启停 + 订阅事件
- `/tools <id> on|off` 已是唯一工具级命令。扩展：
  - 对 `id` 以 `mcp__` 前缀者（`mcp__<server>__<tool>`），off 时同时写入 server 级掩码：经注入的 `mcpServers`/`setMcpServers` 把 `mcpServers[].tools[tool]=false`；on 时删除该键。这样工具掩码统一收口到 /tools。
  - 启停成功后 publish `tool.*` 事件。
- `install` 内订阅 `mcp.server.*` / `plugin.*` 事件刷新 `/tools` 清单缓存（哪些 mcp 工具当前可用），展示 `[源自 mcp__server]` 标注。
- 依赖：tools-manager 增加 `@harness/mcp-server-registry`（类型 `McpServerEntry`）/ core（事件）。经 cli 注入避免包定向依赖过强——按现状 tools-manager 通过 cmdInput 拿 `harness`，mcpServers/setMcpServers 已注入。

### 4. CLI `HarnessApp` 瘦身
- 删除 `disablePlugin/enablePlugin/reloadPlugin` 与 `/plugins` 分支（迁移到 manage-plugin）。
- 保留 `pluginRegistry`（可管理插件对象表），改为向 `manage-plugin` 注入：cmdInput 加 `manageablePlugin: (id)=>AgentPlugin|undefined`、`pluginManageable: (id)=>boolean`。
- boot 登记 `manage-plugin` 至 `BuiltinPluginRegistry` 并在 `applyExternalPlugins`/internalPlugins 中启用（对齐 tools-manager 加载方式，L1298 附近）。

### 5. core（可选、尽量不动）
- 仅导出 `LifecycleEvents` 常量（与 `HarnessEvents` 并列），无逻辑改动；若 `Harness` 接口需要 bus publish 便捷方法可加，但优先保持只读。

## 测试

- `manage-plugin` 包 `index.test.ts`：list / enable(含幂等) / disable / reload 走 harness.plugin 桩；启停后 `bus` 收到 `plugin.*` 事件；`/plugins` 输出含 `ID + 状态`。
- `mcp-server-registry`：`/mcp tool` 已被删除（断言未知子命令）；enable/disable/add/remove 后 `bus` 收到对应 `mcp.*` 事件；掩码过滤仍生效（沿用用例）。
- `tools-manager`：`/tools mcp__srv__tool off` 经注入 `setMcpServers` 写入掩码、on 删除掩码；收到 `mcp.server.disabled` 后 `/tools` 清单把该 server 工具标为不可用。
- cli：`/plugins` 命令仍可用且输出与迁移前一致；`manage-plugin` 注入字段生效。
- 回归：cli 96、registry 8、tools-manager、manage-plugin 用例全绿；`bun run typecheck`。

## 验证

1. `cd packages/plugins/manage-plugin && bun test`；`packages/plugins/mcp-server-registry && bun test`；`packages/plugins/tools-manager && bun test`；`packages/cli && bun test`；根 `bun run typecheck`。
2. 手动：启动 CLI → `bus` 日志可见 `/plugins disable` 发 `plugin.unloaded`；`/mcp disable github` 发 `mcp.server.disabled` 且 `/tools` 中 github 工具标注不可用；`/tools mcp__github__create_issue off` 写 `config.json mcpServers[].tools`；`/mcp tool ...` 提示未知子命令。
3. 事件解耦验证：停用/重载插件不改动 mcp/tool 命令内部状态，下层各自靠事件刷新。

## 待办边界

- 本次仅命令行三命令职责收拢 + 事件跨层解耦；TUI/Web 界面复用这些 `plug.*/mcp.*/tool.*` 事件做实时刷新，另行排期。
- `manage-plugin` 启停仍为运行时生效，不持久化（对齐 `/plugins` 现状）；如需持久化启用集，后续经 cli `setPlugins` 注入补充。