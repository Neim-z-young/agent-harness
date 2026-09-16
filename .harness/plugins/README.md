# `.harness/plugins` —— 项目级外部插件目录

本目录下的 `.ts` / `.js` / `.mjs` 文件会在 CLI 启动时被加载，来源顺序 `user → project`
（`~/.harness/plugins` → `<cwd>/.harness/plugins`，同 id 时后者覆盖前者）。

> 本目录当前**没有插件文件**：原先的 `mcp.ts`（MCP server 能力）与 `coordinator.ts`
> （subagent + coordinator）已改为 `config.json → plugins` 声明式启用，两种写法等价。

## 两条装配路径

| 路径 | 位置 | 适用场景 |
| --- | --- | --- |
| **声明式（推荐）** | `config.json`（默认 `~/.harness/config.json`）的 `plugins` 数组 | 启用**随应用打包的内置插件**，不写代码 |
| **代码装配** | 本目录下的 `.ts / .js / .mjs` | 需要**带参**装配，或写自定义插件（Hooks / Provider 类型 / MCP server） |

### 1. 声明式（零代码）

```json
{
  "plugins": ["code-intel", "computer-use", "subagent", "coordinator"]
}
```

- 依赖**自动补齐**：`code-intel` / `computer-use` → `mcp.server-registry`；`coordinator` → `subagent`。
  安装顺序由 core 的拓扑排序保证（宿主先装），不必手写。
- 可用的内置插件 id：跑 `harness config check`（会列出全部登记项），
  或看 `packages/cli/src/index.ts` 里的 `getBuiltinRegistry()`。
- 未登记的 id 只告警、不阻断启动；`harness config check` 会报为配置错误。
- 声明式装配的实例一律**无参**。需要带参（自定义 `subagents` 数组、`forceAsync: true` 等）→ 走代码装配。
- 外部 MCP server 也零代码：`plugins: ["mcp.server-registry"]` + `mcpServers: [...]`。

### 2. 代码装配（带参 / 自定义）

```ts
// .harness/plugins/my.ts
import { createSubagentPlugin } from '@harness/subagent'
import { createCoordinatorPlugin } from '@harness/coordinator'

export default [
  createSubagentPlugin({ subagents: [/* 自定义 AgentDefinition */] }),
  createCoordinatorPlugin({ forceAsync: true }),
]
```

- 与 `config.json → plugins` **按 id 去重，本目录优先** —— 可用来临时替换内置实现。
- 注意：子 Agent 的**权威来源是 AgentRuntime 注册表**（md frontmatter 定义的 agent），
  插件里的 `subagents` 数组只表示「本插件额外注册」，`/subagents` 与 subagent 工具都以注册表为准。
- 本目录若不在仓库/安装位置内，插件里的裸导入（`@harness/*`）会由 CLI 自动补一个
  `node_modules` 解析锚点（软链到 harness 侧 node_modules，并写 `.gitignore` 条目），
  无需在插件目录手动安装依赖。

## 新增一个自定义插件

1. 在本目录建 `.ts` 文件，导出 `default` / `plugin` / `plugins`（通用 `AgentPlugin`），
   或 `providerTypeFactory` / `providerType` + `createProviderPlugin`（扩展 Provider 类型）；
2. 重启 CLI 生效（或 `/plugins reload`）；
3. `/plugins` 查看加载结果；加载失败会在启动输出里打印 `插件加载失败 <文件>：<原因>`。
