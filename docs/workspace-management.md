# 工作区管理模块 开发文档

> 记录日期：2026-08-31。调研整理既有「工作区 / 数据目录」机制，并界定可独立成模块的边界。

## 1. 概述与目标

工作区管理负责回答「数据放哪、从哪加载、谁覆盖谁」三个问题。当前能力分散在 `@harness/cli` 的 `HarnessApp` 与 `@harness/core` 的加载逻辑中，尚未抽成独立包。本文档先沉淀既有约定，再给出抽离方向。

核心原则：

* **两级加载**：`user`（`~/.harness/…`，全局共享）× `project`（`<cwd>/.harness/…`，按项目）两级，**project 覆盖 user**。

* **一个工作区 = 一个 cwd + 一个 dataDir**：`cwd` 决定 project 级目录；`dataDir` 决定全局数据落盘位置。

## 2. 目录布局

```
~/.harness                          # 用户级（dataDir 默认值）
├── config.json                     # 全局配置（model/provider/apiKey/providers）
├── permissions.json                # 权限规则（CliPermissionEngine 持久化）
├── sessions/                       # 会话文件存储（SessionFileStore）
├── .config-key                     # SecretCipher AES-256-GCM 密钥文件
├── snapshot/                       # 文件快照（SnapshotService，open 时启用）
├── plugins/                        # 用户级插件（user 来源）
├── skills/                         # 用户级技能（SKILL.md，user 来源）
├── agents/                         # 用户级 Agent（Markdown 定义，user 来源）
└── memory/                         # 用户级记忆（MEMORY.md 索引 + 主题文件，按需创建）

<cwd>/.harness/                     # 项目级（cwd 决定）
├── plugins/                        # 项目级插件（project 来源，覆盖 user）
├── skills/                         # 项目级技能（覆盖 user）
├── agents/                         # 项目级 Agent（覆盖 user）
└── memory/                         # 项目级记忆（覆盖 user；**入 git 共享**）
```

> **memory 目录**：与 plugins/skills/agents 同属"路径约定" —— `@harness/workspace` 只给出路径
> （`ws.user.memory` / `ws.project.memory` / `ws.loadDirs.memory`），**不预创建目录、不解析内容**；
> 写入与加载由记忆能力（`@harness/memory` 插件）负责。当前仅落地目录字段，注入尚未启用，
> 详见 [记忆能力与技能锻造计划](memory-and-skill-forge-plan.md)。

## 3. 数据存储

| 存储   | 路径                         | 实现                    | 说明                                                    |
| ---- | -------------------------- | --------------------- | ----------------------------------------------------- |
| 会话   | `dataDir/sessions`         | `SessionFileStore`    | 每会话一文件；`list/load` 支持恢复                               |
| 全局配置 | `dataDir/config.json`      | `ConfigStore`         | `model/provider/apiKey/providers` 幂等读写，缺失/解析失败返回空配置   |
| 权限规则 | `dataDir/permissions.json` | `PermissionStoreFile` | 权限引擎规则落盘                                              |
| 密钥   | `dataDir/.config-key`      | `SecretCipher`        | AES-256-GCM 加解密提供方，用于 `enc:v1:` 密钥解析（`resolveSecret`） |
| 快照   | dataDir 下                  | `SnapshotService`     | 每轮 query 自动 capture + 挂载 `meta.snapshot`，支撑 `/revert` |

## 4. 可插拔目录加载（plugins / skills / agents）

`plugins` 目录可承载任意插件类型（AgentPlugin 的 Hooks 生命周期插件 + Provider 类型工厂），来源标注 `user | project`。加载顺序 user → project，**后者覆盖前者**。

* **plugins**：[loadPluginDirs](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1107-L1113) 依次加载

  * `~/.harness/plugins`（user）→ `<cwd>/.harness/plugins`（project）

  * 通用 AgentPlugin 汇总参与 Harness Hooks；Provider 类型工厂注册进 `ProviderTypeRegistry`，供 `config.type` 动态解析

* **skills / agents**：[HarnessApp 装配](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1238-L1247) 传入 core

  * `agentDirs`：`user` 目录在前 + `.harness/agents`（project）在后，同 ID 后加载覆盖先加载

  * `skillDirs`：`user` 目录在前 + `.harness/skills`（project）在后，后加载覆盖先加载

  * 技能/Agent 来源标注：内置 / 用户 / 项目 / MCP / 插件

> 注：`plugins` 目录由 CLI（`HarnessApp`）直接加载并以两用户域覆盖；`skills/agents` 两级目录由 core 的 `SkillManager`/Agent 装配消费。

## 5. 加载顺序与覆盖规则汇总

```
插件：  user (~/.harness/plugins)  →  project (<cwd>/.harness/plugins)   // 后者覆盖
技能：  user (~/.harness/skills)   →  project (<cwd>/.harness/skills)    // 后者覆盖
Agent： user (~/.harness/agents)   →  project (<cwd>/.harness/agents)    // 同 ID 后者覆盖
记忆：  user (~/.harness/memory)   →  project (<cwd>/.harness/memory)    // 索引合并，项目级覆盖同名条目
Provider：config.json → providers（显式多 Provider） + 默认 Provider 最后注册兜底
配置：  CLI > config.json > 环境变量
```

## 5.5 索引 / AST：是否需要（调研结论）

结合当前实现与演进方向，结论：**工作区管理模块本身不需要 AST，也不维护持久化的内容索引**。

### 索引（Index）

* **快照已借力 git 自身的 index**：GitSnapshotService 依赖 `~/.harness/snapshots/{worktree-hash}` 独立仓库的 staging index（`diff-files`/`ls-files`/`--cached`/`index.version=4`），与用户项目工作区**完全隔离**；FileSnapshotService 则以备份文件 + `snapshots.json` 快照链存储。两者都不在用户工作区建任何索引。

* **无内容索引**：`grep_file` 等搜索按需遍历，未建全文/结构索引；skills/plugins/agents 每次启动现场扫描目录加载，未建持久化注册索引。

* **是否需要**：对"定位与解析"职责不必要。若后续出现查找/重扫描性能瓶颈，再考虑两类轻量索引：

  1. **资源注册索引**（skills/plugins/agents 的扫描结果缓存）——属于工作区模块的合理增强；
  2. **文件内容索引**（全文/符号）——归 `tools-search` / 代码情报层，**不归**工作区模块。

### AST（抽象语法树）

* 全仓**无任何 AST 依赖**（未用 tree-sitter / acorn / babel-parser 等）。`edit_file` 为精确字符串替换，`grep_file` 为正则搜索。

* **是否需要**：代码语义（符号、结构感知编辑、AST diff）与工作区存储定位是两回事，**工作区模块不需要 AST**。如需结构感知能力（结构编辑工具、符号索引、语义 diff），应作为**独立代码情报层/插件**（如 `@harness/codeintel`）实现，仅在该层内引入 AST，不污染工作区模块边界。

> 结论速览：工作区管理 = 目录/数据/存储定位；**索引与 AST 均非其内部职责**。当前无实现缺口，无需引入。

## 6. 现状落点（代码索引）

* CLI 入口与 `cwd/dataDir` 解析：[main()](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L2207-L2226)：`cwd = args.cwd ?? process.cwd()`；`dataDir = args.dataDir ?? ~/.harness`。

* 存储类：[SessionFileStore / ConfigStore / SecretCipher](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L205-L312)。

* 权限规则持久化：[CliPermissionEngine](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L751-L814)。

* 插件多级加载：[loadPluginDirs](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts) + [HarnessApp 装配](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1238-L1247)。

* core 侧多级加载：[options.agentDirs / options.skillDirs](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts#L1611-L1648)。

## 7. 插件化实现规划（`@harness/workspace`）

按"全功能插件化"约束，工作区能力以\*\*「核心库 + 薄 AgentPlugin 壳」双形态\*\*实现，不与 core/CLI 主逻辑耦合：

### 7.1 包形态

* **核心库** **`packages/workspace`（`@harness/workspace`）**：只做「定位与解析 + 存储」，不含 Provider/插件装配。导出服务工厂（供 cli/core 启动期使用），不与插件钩子绑定——借鉴 `@harness/snapshot`、`createBashTool`（插件模块同时导出 helper 工厂与 Plugin）。

* **薄壳 AgentPlugin** **`createWorkspacePlugin(opts)`**：复用 `core.harness.init`/`cli.commands` 等 Hooks 提供生命周期与 `/workspace` 查看命令；真正服务对象由核心库工厂预创建后注入。支持子命令：`/workspace open [cwd|user|data|project|路径]` 调系统文件管理器打开目录（缺省 dataDir）、`/workspace help`。打开实现可经 `opt.open` 注入（默认按平台 `open`/`xdg-open`/`explorer`）。

### 7.2 从 cli 抽离的服务

| 服务                                                  | 现居地                                                                                                 | 抽离目标                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `cwd` / `dataDir` 路径解析（→ userDir/projectDir + 各子路径） | [main()](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L2207-L2226) | `resolveWorkspace({ cwd, dataDir? })` |
| `ConfigStore` / `SessionFileStore` / `SecretCipher` | [cli](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L205-L312)      | 各存储类工厂                                |
| 权限规则持久化                                             | `CliPermissionEngine`                                                                               | 复用 workspace 的 `dataDir` 路径           |
| 插件/技能/Agent 多级扫描+来源+覆盖                              | cli + core 重复                                                                                       | 收敛为通用 `MultiDirLoader` 归 workspace    |
| 密钥/快照 `/revert`                                     | cli / snapshot                                                                                      | 路径统一由 workspace 解析，消灭 magic path      |

### 7.3 启动时序说明（基础设施插件的特殊性）

与"运行时注入工具"的普通插件不同，workspace 属**基础设施**，cli 需在创建 harness **之前**预创建服务（路径解析在插件装配前就要求可达）。因此：

* cli 先 `import { resolveWorkspace } from '@harness/workspace'` 得基础路径；

* 再 `createWorkspacePlugin({ resolve })` 作为 internal/builtin 插件装载；

* harness/core 经 `core.harness.init` 输出消费解析结果。

该"预创建 + 薄壳"模式同样适用于 snapshot 插件化（已于 `@harness/revert` 落地，见开发日志续 56）。

#### 7.3.1 `/snapshot` 快照管理命令

薄壳插件 `createSnapshotPlugin`（id=`snapshot-shell`）依赖 cli 注入的 `input.snapshotService`，覆盖完整管理闭环：

| 类别 | 子命令                                                                 | 服务端 `SnapshotService`     |
| -- | ------------------------------------------------------------------- | ------------------------- |
| 查询 | `status` / `list` / `files <from> <to>` / `diff <from> <to> [path]` | `list` / `files` / `diff` |
| 捕获 | `capture [scope]`                                                   | `capture`                 |
| 预览 | `preview <to> <path...>`                                            | `preview`                 |
| 回滚 | `restore <to> <path...>` / `checkout <to>`                          | `restore` / `checkout`    |
| 维护 | `gc`                                                                | `gc`                      |

`status` 输出启用状态、后端（git/file）、快照数、最新快照 ID 与捕获时间（基于服务暴露的自省字段 `backend`/`enabled` + `list()`）。回滚命令复用同包 `createSessionRevert` 三态控制器（见续 56）。

#### 7.3.2 多工作区快照隔离

快照存储目录**默认即按 worktree 派生**，天然隔离多工作区（不必显式传 `gitDirectory`/`dataDir`）：

* git 后端：`~/.harness/snapshots/{sha256(worktree)[0:16]}`（独立 git 仓库，位于 worktree 之外，避免污染用户项目 `.git` 与快照自扫描）；

* file 后端：`~/.harness/file-snapshots/{sha256(worktree)[0:16]}`（备份文件 + `snapshots.json` 快照链）。

因此每个工作区各持一份独立快照链与对象库，`/snapshot list`/`restore` 只作用于当前工作区。需要显式隔离（如同一 worktree 多实例、自选存储根）时，可经 `SnapshotOptions.gitDirectory`/`dataDir` 覆盖；将来若需跨工作区共享快照（如全局 undo），可在 `createSnapshotService` 之外再加一层按 `workspace` 解析存储根的 provider，不必改两后端。

### 7.4 演进边界

* `MultiDirLoader` 通用化后，skills/agents/plugins 加载路径与来源标注都收敛于此，避免 cli/core 各写一套。

* codeintel（见 [codeintel-plugin.md](codeintel-plugin.md)）**不归属** workspace：它只消费 workspace 的根路径，引入 AST/索引。

## 8. 相关文档

* 架构总览 [agent-harness-architecture.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/agent-harness-architecture.md) §十五

* 代码情报插件规划 [codeintel-plugin.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/codeintel-plugin.md)

* 开发日志 [development-log.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/development-log.md)

