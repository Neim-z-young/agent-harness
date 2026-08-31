# 工作区管理模块 开发文档

> 记录日期：2026-08-31。调研整理既有「工作区 / 数据目录」机制，并界定可独立成模块的边界。

## 1. 概述与目标

工作区管理负责回答「数据放哪、从哪加载、谁覆盖谁」三个问题。当前能力分散在 `@harness/cli` 的 `HarnessApp` 与 `@harness/core` 的加载逻辑中，尚未抽成独立包。本文档先沉淀既有约定，再给出抽离方向。

核心原则：

- **两级加载**：`user`（`~/.harness/…`，全局共享）× `project`（`<cwd>/.harness/…`，按项目）两级，**project 覆盖 user**。
- **一个工作区 = 一个 cwd + 一个 dataDir**：`cwd` 决定 project 级目录；`dataDir` 决定全局数据落盘位置。

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
└── agents/                         # 用户级 Agent（Markdown 定义，user 来源）

<cwd>/.harness/                     # 项目级（cwd 决定）
├── plugins/                        # 项目级插件（project 来源，覆盖 user）
├── skills/                         # 项目级技能（覆盖 user）
└── agents/                         # 项目级 Agent（覆盖 user）
```

## 3. 数据存储

| 存储 | 路径 | 实现 | 说明 |
| --- | --- | --- | --- |
| 会话 | `dataDir/sessions` | `SessionFileStore` | 每会话一文件；`list/load` 支持恢复 |
| 全局配置 | `dataDir/config.json` | `ConfigStore` | `model/provider/apiKey/providers` 幂等读写，缺失/解析失败返回空配置 |
| 权限规则 | `dataDir/permissions.json` | `PermissionStoreFile` | 权限引擎规则落盘 |
| 密钥 | `dataDir/.config-key` | `SecretCipher` | AES-256-GCM 加解密提供方，用于 `enc:v1:` 密钥解析（`resolveSecret`） |
| 快照 | dataDir 下 | `SnapshotService` | 每轮 query 自动 capture + 挂载 `meta.snapshot`，支撑 `/revert` |

## 4. 可插拔目录加载（plugins / skills / agents）

`plugins` 目录可承载任意插件类型（AgentPlugin 的 Hooks 生命周期插件 + Provider 类型工厂），来源标注 `user | project`。加载顺序 user → project，**后者覆盖前者**。

- **plugins**：[loadPluginDirs](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1107-L1113) 依次加载
  - `~/.harness/plugins`（user）→ `<cwd>/.harness/plugins`（project）
  - 通用 AgentPlugin 汇总参与 Harness Hooks；Provider 类型工厂注册进 `ProviderTypeRegistry`，供 `config.type` 动态解析
- **skills / agents**：[HarnessApp 装配](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1238-L1247) 传入 core
  - `agentDirs`：`user` 目录在前 + `.harness/agents`（project）在后，同 ID 后加载覆盖先加载
  - `skillDirs`：`user` 目录在前 + `.harness/skills`（project）在后，后加载覆盖先加载
  - 技能/Agent 来源标注：内置 / 用户 / 项目 / MCP / 插件

> 注：`plugins` 目录由 CLI（`HarnessApp`）直接加载并以两用户域覆盖；`skills/agents` 两级目录由 core 的 `SkillManager`/Agent 装配消费。

## 5. 加载顺序与覆盖规则汇总

```
插件：  user (~/.harness/plugins)  →  project (<cwd>/.harness/plugins)   // 后者覆盖
技能：  user (~/.harness/skills)   →  project (<cwd>/.harness/skills)    // 后者覆盖
Agent： user (~/.harness/agents)   →  project (<cwd>/.harness/agents)    // 同 ID 后者覆盖
Provider：config.json → providers（显式多 Provider） + 默认 Provider 最后注册兜底
配置：  CLI > config.json > 环境变量
```

## 6. 现状落点（代码索引）

- CLI 入口与 `cwd/dataDir` 解析：[main()](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L2207-L2226)：`cwd = args.cwd ?? process.cwd()`；`dataDir = args.dataDir ?? ~/.harness`。
- 存储类：[SessionFileStore / ConfigStore / SecretCipher](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L205-L312)。
- 权限规则持久化：[CliPermissionEngine](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L751-L814)。
- 插件多级加载：[loadPluginDirs](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts) + [HarnessApp 装配](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/cli/src/index.ts#L1238-L1247)。
- core 侧多级加载：[options.agentDirs / options.skillDirs](file:///Users/oyoungy/Documents/project/XiaoZhi-new/packages/core/src/index.ts#L1611-L1648)。

## 7. 演进边界（如需抽成独立模块 `@harness/workspace`）

当前逻辑与 `HarnessApp` 耦合，抽离时保持以下边界：

- `workspace` 模块只负责「定位与解析」，不持有 Provider/插件装配逻辑；`HarnessApp` 仍做组装。
- 对外暴露：`resolveWorkspace({ cwd, dataDir? }) → { userDir, projectDir, paths }` + 各存储类工厂。
- plugins/skills/agents 的「多级扫描 + 来源标注 + 覆盖」可收敛为通用 `MultiDirLoader`。
- 密钥/快照仍走既有 `dataDir`，路径一律由 workspace 解析，避免散落 magic path。

## 8. 相关文档

- 架构总览 [agent-harness-architecture.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/agent-harness-architecture.md) §十五
- 开发日志 [development-log.md](file:///Users/oyoungy/Documents/project/XiaoZhi-new/docs/development-log.md)