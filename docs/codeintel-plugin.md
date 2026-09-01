# codeintel 插件开发规划（`@harness/code-intel`）

> 状态：规划（待实现）。承接 [workspace-management.md](workspace-management.md) §5.5：「AST 与内容索引归代码情报层」，本插件即该层的插件化具象。

## 1. 定位与目标

提供**代码情报**能力：基于结构化 AST 的符号、引用、导航，使 Agent 能做高质量的定位与结构感知编辑。

- 独立插件包 `packages/plugins/code-intel`，命名空间 `@harness/code-intel`。
- 按"全功能插件化"约束实现，通过 `tool.pool.assemble` 注入工具，不与 core/CLI/workspace 耦合。

## 2. 职责边界

- **只做代码语义**：符号索引、引用、定义、结构感知编辑。
- **不含存储/路径定位**：只消费 workspace 提供的根路径（`resolveWorkspace`）。
- **AST 与内容索引归此层**：`workspace-management.md` §5.5 已明确 workspace 不承担 AST/内容索引，本插件内引入。
- 不污染 core、tools-builtin（`edit_file` 仍为精确字符串替换，结构编辑走本层）。

## 3. 技术选型

- **AST**：推荐 `web-tree-sitter`（语言无关、多语言 grammar、该层唯一允许引入 AST 的位置）；纯 TS 域可退化为 `@babel/parser` 起步。
- **符号索引**：v1 内存内 + 按需增量（parse 目标文件/目录）；不做持久化全文索引（呼应 §5.5），性能瓶颈再演进。
- **grammar 加载**：按需加载 TS/TSX grammar，忽略目录由配置传入。

## 4. 注入工具（`tool.pool.assemble`）

| 工具 id | 作用 | 安全声明 |
| --- | --- | --- |
| `code_symbols` | 列出文件/目录符号（函数/类/变量/接口/枚举） | 只读，`isConcurrencySafe:true` |
| `code_reference` | 查找某符号的引用（usages，含跨文件） | 只读，`isConcurrencySafe:true` |
| `code_definition` | 符号 go-to-definition（返回位置） | 只读，`isConcurrencySafe:true` |
| `code_semantic_edit`（v2 可选） | 结构感知编辑（编辑前校验隔离性） | 协作工具，`isConcurrencySafe:false` |

权限 key：导航类用 `code`（或复用 `read`）；`code_semantic_edit` 用 `edit`。

## 5. 目录与依赖

- `packages/plugins/code-intel`：`src/index.ts` + `src/index.test.ts` + `package.json` + `tsconfig.json`（extends 根，outDir `./dist`）。
- 依赖：`@harness/tool`、`@harness/plugin`、`@harness/workspace`（根路径）、tree-sitter grammar。
- 新包同步注册根 `tsconfig.json` `paths` 与相关 `package.json` `dependencies`，再 `bun install`。

## 6. AgentPlugin 形态

- 导出 `createCodeIntelPlugin(opts)` 工厂（可配 grammar 路径、忽略目录）与默认 `codeIntelPlugin`。
- Hooks：
  - `harness.init`：建符号索引上下文（消费 workspace 根路径）。
  - `tool.pool.assemble`：注入上述工具。
  - `cli.commands`（可选）：注册 `/code` 查看符号/来源。

## 7. 实施步骤

1. 建包，注册 paths/deps，`bun install`；引入 web-tree-sitter + TS/TSX grammar。
2. 实现索引核心（parse → symbols/references/definition 查询）。
3. 注入 `code_symbols` / `code_reference` / `code_definition` + 单元测试（`index.test.ts`）。
4. cli 装配：config 或 internal 加载该插件（对齐 tools-builtin 的 `internalPlugins`/插件清单）。
5. （v2）`code_semantic_edit` 结构感知编辑。
6. 全量 `typecheck` + `test`（跑测试补 `PATH=/bin:/usr/bin`）；更新 development-log。

## 8. 相关文档

- 工作区规划 [workspace-management.md](workspace-management.md)（§5.5 索引/AST 归属、§7.4 边界）
- 架构总览 [agent-harness-architecture.md](agent-harness-architecture.md)
- 开发日志 [development-log.md](development-log.md)