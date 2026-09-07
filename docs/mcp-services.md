# MCP 服务 使用文档

> 记录日期：2026-09-07。MCP（Model Context Protocol）服务的装配、配置与运行时管理。

## 1. 概述

项目支持两种方式接入 MCP Server：

| 方式 | 装配位置 | 说明 | 启停 |
| ---- | ---- | ---- | ---- |
| **代码注册** | `.harness/plugins/mcp.ts`（`registerMcpServer`） | 进程内/自定义 transport（computer-use、code-intel 等） | 随插件启用/卸载 |
| **配置托管** | `config.json` 的 `mcpServers` 数组 | 外部 stdio / http / sse server | `/mcp enable\|disable` 即时启停 |

- 所有 server 统一由 `@harness/mcp-server-registry` 插件在 `harness.start` 时连接，复用 `@harness/mcp-client` 管理连接，工具经 `tool.pool.assemble` 暴露为 `mcp__<server>__<tool>`。
- 插件化约束：core/CLI 不硬编码任何 MCP server；删除 `.harness/plugins/mcp.ts` 即停用所有进程内 MCP server 能力。

## 2. 配置托管（config.json）

在 `dataDir/config.json` 顶层写 `mcpServers` 数组，元素复用 `@harness/mcp-client` 的 `McpServerConfig` 字段，并附加两级启停开关：

```json
{
  "mcpServers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "enabled": true
    },
    {
      "name": "notes",
      "url": "https://mcp.example.com/mcp",
      "auth": { "bearerToken": "enc:v1:..." },
      "tools": { "notes_search": false }
    }
  ]
}
```

字段说明（`McpServerEntry`，见 [index.ts](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/plugins/mcp-server-registry/src/index.ts#L91-L100)）：

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `name` | string | 服务器名，工具命名前缀 `mcp__<name>__`（必填） |
| `transport` | `stdio \| sse \| http` | 缺省按字段推断：有 `command` → stdio，有 `url` → http |
| `command` / `args` / `env` | string / string[] / Record | stdio 模式启动命令、参数、环境变量 |
| `url` | string | sse/http 模式服务器地址 |
| `auth` | McpAuthConfig | 鉴权（bearerToken 等） |
| `enabled` | boolean | **服务器级开关**，缺省 `true` |
| `tools` | Record<string, boolean> | **工具级开关**，`{ 工具名: false }` 停用单个工具，缺省全开 |

## 3. /mcp 命令

`/mcp` 提供运行时查看与管理（REPL 内输入）：

```
/mcp                                # 服务器列表（含启停状态）
/mcp servers                        # 同上
/mcp tools                          # 工具列表（托管 server 标注工具级启停）
/mcp enable <server>                # 启用并立即连接
/mcp disable <server>               # 禁用并立即断开
/mcp tool <server> <tool> on|off    # 单个工具启用/禁用（即时生效）
/mcp add <json>                     # 新增托管 server（写回 config.json 并连接）
/mcp remove <server>                # 移除托管 server（断开并写回 config.json）
```

示例：

```
/mcp add -- {"name":"github","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}
/mcp disable github
/mcp tool github create_issue off
```

## 4. 运行时机制

- **启动**：CLI boot 时 `applyMcpServers` 读 `config.json` 的 `mcpServers`，经 `mcp.configure` Hook 注入 registry 插件（仅建立配置态）；`harness.start` 时按 `enabled` 开关连接。
- **服务器级启停**：`/mcp enable\|disable` 立即 connect/close 客户端并移除工具；状态经注入的 `setMcpServers` 写回 `config.json`，重启后生效。
- **工具级启停**：`tool.pool.assemble` 每 query 组装，按工具 base 名过滤 `tools[name]===false`，天然即时生效。
- **持久化**：插件不直接自持读写 config.json，统一走 CLI 注入的 `setMcpServers`（对齐 `setAgentTools` 模式），重启后由 `applyMcpServers` 回读恢复。
- **失败容错**：单个 server 连接失败不阻塞其他 server（仅记错误日志），也不阻塞 harness 启动。

## 5. 凭证安全

`env` / `auth` 中的敏感值支持三种格式（同 Provider API key 规范）：

- **明文**：`"GITHUB_TOKEN": "ghp_xxx"`（不推荐入库）
- **环境变量引用**：`"GITHUB_TOKEN": "${GITHUB_TOKEN}"`，运行时从环境读取
- **加密值**：`"bearerToken": "enc:v1:<iv>:<tag>:<ct>"`，AES-256-GCM 加密（`SecretCipher`，密钥在 `dataDir/.config-key`）

HTTP/SSE 的 OAuth2 授权流程见 `@harness/mcp-client` 的 OAuth 实现（PKCE S256 + token 刷新），token 加密存储在 `dataDir/oauth-tokens.json`。

## 6. 相关文档

- 架构分层与 MCP Client 插件示例：`docs/agent-harness-architecture.md`
- 插件化约定与装配目录：`docs/workspace-management.md`
- 开发日志：`docs/development-log.md`
