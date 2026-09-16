# MCP 服务 使用文档

> 记录日期：2026-09-07。MCP（Model Context Protocol）服务的装配、配置与运行时管理。

## 1. 概述

项目支持三种方式接入 MCP Server：

| 方式       | 装配位置                                           | 说明                                           | 启停                                                               |
| -------- | ---------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| **声明式启用** | `config.json` 的 `plugins` 数组（内置插件 id）          | **零代码**：自动补齐依赖（如 `mcp.server-registry`）      | 改配置即生效（重启后）                                                      |
| **代码注册** | `.harness/plugins/mcp.ts`（`registerMcpServer`） | 进程内/自定义 transport（computer-use、code-intel 等） | 随插件装卸（`/plugins enable\|disable`）；或 `/mcp enable\|disable` 会话内启停 |
| **配置托管** | `config.json` 的 `mcpServers` 数组                | 外部 stdio / http / sse server                 | `/mcp enable\|disable` 即时启停（持久化）                                 |

- 所有 server 统一由 `@harness/mcp-server-registry` 插件在 `harness.start` 时连接，复用 `@harness/mcp-client` 管理连接，工具经 `tool.pool.assemble` 暴露为 `mcp__<server>__<tool>`。

- 插件化约束：core/CLI 不硬编码任何 MCP server；删除 `.harness/plugins/mcp.ts` 即停用所有进程内 MCP server 能力（改用下面的 `plugins` 声明式启用亦可）。

## 2. 零代码启用内置插件（config.json → plugins）

只想「开一个内置能力」时**不必写 `.harness/plugins/*.ts`**：在 `dataDir/config.json` 顶层写 `plugins` 数组即可，元素取内置插件 id。

```json
{
  "plugins": ["code-intel", "computer-use"]
}
```

- **依赖自动补齐**：`code-intel` / `computer-use` 都依赖 `mcp.server-registry`（进程内 MCP server 的宿主），解析时按插件声明的 `dependsOn` 递归补上，安装顺序由 core 拓扑排序保证（宿主先装）。
- **工具开箱即用**：boot 末尾的后台预加载会装配工具池，`/tools` 里这些工具直接是「已加载」，不再停留在「仅元信息·源自mcp」。
- **失败不阻断**：未登记的 id 只告警并跳过；`harness config check` 会把未登记项报成配置错误。
- **与外部插件目录按 id 去重**（外部插件目录优先），因此 `.harness/plugins/mcp.ts` 与 `plugins` 声明可并存，也可删掉前者。

当前已登记的内置插件 id：

| id                    | 说明                                              |
| --------------------- | ----------------------------------------------- |
| `mcp.server-registry` | MCP Server 注册表（连接进程内/外部 MCP server，提供 `/mcp` 命令） |
| `code-intel`          | 代码情报 MCP server（`mcp__code-intel__*`）           |
| `computer-use`        | 电脑控制 MCP server（`mcp__computer-use__*`）         |

> **外部 MCP server 同样可零代码启用**：`plugins: ["mcp.server-registry"]` + `mcpServers: [...]`，无需再手写 `.harness/plugins/mcp.ts`。

### 2.1 插件目录可位于任意工作目录

外部插件目录（`<cwd>/.harness/plugins`、`~/.harness/plugins`）里的裸导入（`@harness/*` 等）按 node 规则从**插件文件所在目录**上溯查找 `node_modules`。工作目录不在仓库/安装位置内时该链路断开，插件会因 `Cannot find module` 被整体忽略（表现为「插件静默不生效」）。

CLI 现在会在导入前探测插件的裸依赖：无法解析时就在插件目录补一个 `node_modules` 软链指向 harness 安装位置，并写入 `.gitignore`（`node_modules`）。软链只**追加**解析根、不遮蔽原有链路，因此依赖宿主项目 node_modules 的插件不受影响。

## 3. 配置托管（config.json）

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

| 字段                         | 类型                          | 说明                                         |
| -------------------------- | --------------------------- | ------------------------------------------ |
| `name`                     | string                      | 服务器名，工具命名前缀 `mcp__<name>__`（必填）            |
| `transport`                | `stdio \| sse \| http`      | 缺省按字段推断：有 `command` → stdio，有 `url` → http |
| `command` / `args` / `env` | string / string\[] / Record | stdio 模式启动命令、参数、环境变量                       |
| `url`                      | string                      | sse/http 模式服务器地址                           |
| `auth`                     | McpAuthConfig               | 鉴权（bearerToken 等）                          |
| `enabled`                  | boolean                     | **服务器级开关**，缺省 `true`                       |
| `tools`                    | Record\<string, boolean>    | **工具级开关**，`{ 工具名: false }` 停用单个工具，缺省全开     |

## 4. /mcp 命令

`/mcp` 提供运行时查看与管理（REPL 内输入）：

```
/mcp [servers]                       # 服务器列表（含启停状态）
/mcp servers enable <server>         # 启用并立即连接（含代码注册 server，会话内生效）
/mcp servers disable <server>        # 禁用并立即断开（含代码注册 server，会话内生效）
/mcp tools                           # 工具列表（托管 server 标注工具级启停）
/mcp enable <server>                 # 同上（顶层写法）
/mcp disable <server>                # 同上（顶层写法）
/mcp add <json>                      # 新增托管 server（写回 config.json 并连接）
/mcp remove <server>                 # 移除托管 server（断开并写回 config.json）
```

- **工具级启停统一走** **`/tools`**（`mcp__<server>__<tool>` 前缀），`/mcp` 不再承担工具掩码责任：

```
/tools mcp__github__create_issue off   # 关闭某个 MCP 工具（写 mcpServers[].tools）
/tools mcp__github__create_issue on    # 重新开启（移除掩码）
```

示例：

```
/mcp add -- {"name":"github","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}
/mcp disable github
/tools mcp__github__create_issue off
```

> 说明：**代码注册** server（computer-use、code-intel 等）无 config.json 槽位，`/mcp disable` 为**本次进程生效**（重启后自动恢复连接）；随插件整体装卸请用 `/plugins disable|enable <pluginId>`——插件卸载时其注册的 MCP server 自动断开、工具从工具池移除，重载后自动重连。

## 5. 运行时机制

- **启动**：CLI boot 时 `applyMcpServers` 读 `config.json` 的 `mcpServers`，经 `mcp.configure` Hook 注入 registry 插件（仅建立配置态）；`harness.start` 时按 `enabled` 开关连接。

- **服务器级启停**：`/mcp enable\|disable` 立即 connect/close 客户端并移除工具；状态经注入的 `setMcpServers` 写回 `config.json`，重启后生效。代码注册 server 无配置槽位，仅本次进程生效。

- **随插件装卸**：registry 订阅 `plugin.unloaded` / `plugin.loaded` 事件——宿主插件（如 code-intel）卸载时自动断开其注册的 MCP server 并收敛工具，重新启用时自动重连（`registerMcpServer` 携带 `source: <插件id>` 关联）。

- **工具级启停**：`tool.pool.assemble` 每 query 组装，按工具 base 名过滤 `tools[name]===false`，天然即时生效。

- **持久化**：插件不直接自持读写 config.json，统一走 CLI 注入的 `setMcpServers`（对齐 `setAgentTools` 模式），重启后由 `applyMcpServers` 回读恢复。

- **失败容错**：单个 server 连接失败不阻塞其他 server（仅记错误日志），也不阻塞 harness 启动。

## 6. 凭证安全

`env` / `auth` 中的敏感值支持三种格式（同 Provider API key 规范）：

- **明文**：`"GITHUB_TOKEN": "ghp_xxx"`（不推荐入库）

- **环境变量引用**：`"GITHUB_TOKEN": "${GITHUB_TOKEN}"`，运行时从环境读取

- **加密值**：`"bearerToken": "enc:v1:<iv>:<tag>:<ct>"`，AES-256-GCM 加密（`SecretCipher`，密钥在 `dataDir/.config-key`）

HTTP/SSE 的 OAuth2 授权流程见 `@harness/mcp-client` 的 OAuth 实现（PKCE S256 + token 刷新），token 加密存储在 `dataDir/oauth-tokens.json`。

## 7. 相关文档

- 架构分层与 MCP Client 插件示例：`docs/agent-harness-architecture.md`

- 插件化约定与装配目录：`docs/workspace-management.md`

- 开发日志：`docs/development-log.md`

