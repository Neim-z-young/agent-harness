# `.harness/plugins` —— 项目级外部插件目录

> **默认不加载本目录里的代码。**
> `.ts / .js / .mjs` 是**可执行代码**：若无条件 `import()`，克隆一个带 `.harness/plugins`
> 的仓库、在该目录里跑一次 harness 就会执行他人代码（代码注入）。
> 因此启动时只**登记**这些文件并打印提示，不执行；需要真正加载时显式开闸（见下）。

来源顺序 `user → project`（`~/.harness/plugins` → `<cwd>/.harness/plugins`，同 id 时后者覆盖前者）。

> 本目录当前**没有插件文件**：原先的 `mcp.ts`（MCP server 能力）与 `coordinator.ts`
> （subagent + coordinator）已改为 `config.json → plugins` 声明式启用，两种写法等价。

## 两条装配路径

| 路径 | 位置 | 适用场景 |
| --- | --- | --- |
| **声明式（推荐）** | `config.json`（默认 `~/.harness/config.json`）的 `plugins` 数组 | 启用**随应用打包的内置插件**，不写代码、不执行任何外部代码 |
| **代码装配（默认关闭）** | 本目录下的 `.ts / .js / .mjs` | 需要**带参**装配，或写自定义插件（Hooks / Provider 类型 / MCP server） |

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

### 2. 代码装配（带参 / 自定义）—— 需显式开闸

先在配置或命令行开闸，二选一：

```json
{ "allowPluginCode": true }
```

```bash
harness --allow-plugin-code
```

然后写插件：

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
- **不会**为插件目录补任何 `node_modules` 软链：那等于把 harness 内核的整棵依赖树暴露给
  工作目录下的任意文件（还会被写进用户仓库、可能悬空）。插件需放在**能解析到其依赖的位置**
  （如本仓库内），裸依赖解析不到就是解析不到。
- 关闭时会看到：`已跳过 N 个插件代码文件（默认不加载外部插件代码，防止代码注入）`。

## 新增一个自定义插件

1. 在本目录建 `.ts` 文件，导出 `default` / `plugin` / `plugins`（通用 `AgentPlugin`），
   或 `providerTypeFactory` / `providerType` + `createProviderPlugin`（扩展 Provider 类型）；
2. 开启 `allowPluginCode` 后重启 CLI 生效（或 `/plugins reload`）；
3. `/plugins` 查看加载结果；加载失败会在启动输出里打印 `插件加载失败 <文件>：<原因>`。
