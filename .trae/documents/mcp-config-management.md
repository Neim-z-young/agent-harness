# MCP Server 配置化管理：JSON 配置 + 服务器/工具两级启停

## Context（背景）

当前 MCP Server 只能通过 `.harness/plugins/mcp.ts` 在代码里用 `registerMcpServer()` / `createMcpServerRegistryPlugin()` 显式装配，无法从配置文件新增外部 MCP server，也没有运行时启用/禁用能力。`/plugins` 只管理整插件粒度，`/mcp` 只读展示，无法控制插件注入的服务器及工具。

本需求：
1. 支持从 `config.json`（dataDir 主配置文件）以 JSON 形式新增外部 MCP server（stdio/sse/http）。
2. 支持 **服务器级 + 工具级两级** 启用/禁用，**即时生效（免重启）**，状态持久化到 `config.json`。
3. 预留界面添加/管理的扩展能力（本阶段以 CLI `/mcp` 命令为主，接口设计便于后续 TUI/Web 复用）。

遵循项目规范：插件持久化 config.json 不直接自持读写，优先经 CLI 注入的持久化回调（对齐 `setAgentTools` 模式）；core 不耦合 MCP 能力。

## 配置模型

扩展 `HarnessConfig`：

```ts
// packages/cli/src/index.ts -> HarnessConfig
mcpServers?: McpServerEntry[]

// McpServerEntry = { ...McpServerConfig, enabled? , tools? }
//   McpServerConfig 复用 @harness/mcp-client 的字段：name/transport/command/args/env/url/auth/protocolVersion/...
//   enabled?: boolean  服务器级开关（缺省 true）
//   tools?: Record<toolId, boolean>  工具级开关（缺省 true）
export interface McpServerEntry extends McpServerConfig {
  enabled?: boolean
  tools?: Record<string, boolean>
}
```

示例 `config.json`：

```json
{
  "mcpServers": [
    { "name": "github", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }, "enabled": true },
    { "name": "notes", "url": "https://mcp.example.com/mcp", "auth": { "bearerToken": "enc:v1:..." }, "tools": { "notes_search": false } }
  ]
}
```

`McpServerEntry` 类型定义放在 `@harness/mcp-server-registry` 导出（因为它复用 `@harness/mcp-client` 的 `McpServerConfig`，且已有该依赖），CLI 从该包 import，避免依赖倒置。

## 改动清单

### 1. mcp-server-registry 插件 — `packages/plugins/mcp-server-registry/src/index.ts`

- 新增强 MCP 配置状态 `entries: McpEntryState[]`（`{ entry: McpServerEntry, runtime?: McpServerRuntime }`），带 `enabled`（server）与 `enabledTools: Set<string>`（始终开启的 toolId 集合，缺省全开）。
- 新增 Hook **`mcp.configure`**：`install` 返回对象里注册，CLI 在 boot 时调用，把 `config.json` 的 `mcpServers` 注入插件，替换当前 entries 列表；仅建立配置态，不连接。
- `harness.start`：连接 services 时只连接 `enabled` 的 entry（server 级过滤）。
- `tool.pool.assemble`：对每个 entry，先按 `entry.enabled` 过滤；再按 `enabledTools` 过滤单个工具（`tools[name] === false` 时跳过）。由于池每 query 组装，工具级过滤天然即时生效。
- `/mcp` 命令扩展子命令：
  - `/mcp servers` / `/mcp tools`（保留，展示含 enabled 状态）
  - `/mcp enable <server>` / `/mcp disable <server>`：服务器级开关；enable 立即连接，disable 立即 close 客户端并从 runtimes 移除
  - `/mcp tool <server> <tool> on|off`：工具级开关；立即更新 entry.enabledTools
  - `/mcp add <name> -- <json...>`：新增一个 server（写回 config + 连接）
  - `/mcp remove <server>`：移除（close 客户端 + 从 config 删除）
  - 每次变更通过 CLI 注入的 `mcpStore.save(list)` 持久化到 `config.json`。
- uninstall：照旧 close 所有 runtimes。

### 2. CLI — `packages/cli/src/index.ts`

- `HarnessConfig` 加 `mcpServers?`。
- 新增 `getMcpServers()` / `setMcpServers(list)`（对齐 `setAgentTools`）：`configStore.load()` → 改 `mcpServers` → `configStore.save()`。
- **CliCommandInput 扩展字段**（对齐 `setAgentTools` 注入模式）：`mcpServers: McpServerEntry[]`、`setMcpServers(list)`，命令路由时从 `app` 注入，供 mcp-server-registry 的 `/mcp` 命令读写 config。
- **boot 应用配置**：`createHarness` 之后、`harness.start()` 之前，读 `configStore.load().mcpServers`，触发 `harness.plugin.trigger('mcp.configure', { mcpServers, save })`，把启动配置注入插件，之后 `harness.start()` 按开关连接。

### 3. 装配 — `.harness/plugins/mcp.ts`

- `createMcpServerRegistryPlugin()` 照旧启用即可，无需改（配置经 `mcp.configure` 注入）；如需覆盖 dataDir 传 `{ dataDir }`。

### 4. 测试

- `packages/plugins/mcp-server-registry/src/index.test.ts` 新增：
  - `mcp.configure` 注入配置态
  - 服务器级 enable/disable 后 assemble 只含启用 server；disable 立即移除工具、enable 立即恢复
  - 工具级 `tools[name]=false` 时 assemble 跳过该工具
  - `/mcp` 新增 enable/disable/tool/add/remove 命令落位与调用 `save` 回调
- CLI 测试：`getMcpServers`/`setMcpServers` 读写 config.json；boot 时把 `mcpServers` 注入插件。

## 验证

1. `cd packages/plugins/mcp-server-registry && bun test` 全绿；`cd packages/cli && bun test` 全绿；根 `bun run typecheck` 通过。
2. 手动：在 `~/.harness/config.json` 写好 `mcpServers`（含一个 stdio server），启动 CLI → `/mcp servers` 显示已连接 → `/mcp disable <server>` 后工具消失且/config 里 `enabled:false` → `/mcp enable <server>` 恢复 → `/mcp tool <server> <tool> off` 单工具禁用。
3. 设计接口（`mcp.configure` Hook + 注入的 `mcpServers`/`setMcpServers`）后续供 TUI/Web 界面直接调用，无需改 core。

## 待办说明

本阶段交付 CLI `/mcp` 全量管理（add/remove/enable/disable/tool + list），界面(如 TUI/网页)添加及管理仅预留数据接口与持久化回调，落地时间另行排期。