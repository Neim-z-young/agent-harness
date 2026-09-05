# codeintel 插件开发规划（`@harness/code-intel`）

> 状态：**v1 + v2 已实现**（2026-09-04/05，见开发日志续 62/63/64/65/66/67）。承接 [workspace-management.md](workspace-management.md) §5.5：「AST 与内容索引归代码情报层」，本插件即该层的插件化具象。

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

- **AST**：规划推荐 `web-tree-sitter`；v1 按「纯 TS 域可退化 @babel/parser 起步」落地为 **`@babel/parser` + `@babel/traverse`**（纯 JS、同步、可单测，支持 TS/TSX/JS/JSX + decorators 等插件集）。多语言 grammar 后续换 web-tree-sitter 不影响工具/插件契约。
- **符号索引**：v1 内存内 + 按需增量（parse 目标文件/目录，缓存按 mtime+size 失效）；不做持久化全文索引（呼应 §5.5），性能瓶颈再演进。
- **grammar 加载**：v1 无外部 grammar 文件；解析失败多配置回退（TS 加 jsx 宽容、纯 JS 兼容 TS 语法），单文件失败跳过不中断目录索引。忽略目录由插件配置传入。

## 4. 注入工具（`tool.pool.assemble`）

| 工具 id | 作用 | 安全声明 |
| --- | --- | --- |
| `code_symbols` | 列出文件/目录符号（函数/类/变量/接口/枚举） | 只读，`isConcurrencySafe:true` |
| `code_reference` | 查找某符号的引用（usages，含跨文件） | 只读，`isConcurrencySafe:true` |
| `code_definition` | 符号 go-to-definition（返回位置） | 只读，`isConcurrencySafe:true` |
| `code_semantic_edit`（v2） | 结构感知编辑：`rename` / `replace_node` / `replace_subtree`（批量） | 协作工具，`isConcurrencySafe:false` |

权限 key：导航类用 `code`（或复用 `read`）；`code_semantic_edit` 用 `edit`。

`code_semantic_edit` 的隔离性保证（"编辑前校验隔离性"）：
- `rename`：仅替换精确的 AST 标识符 token 范围（声明 + 引用 + import 源名；含对象简写、export 说明符），字符串/注释中的同名文本与 `obj.x` 属性访问一律不触碰；支持 `export { foo as bar }`、`import { X as Y }` 等别名场景；`scope` 子目录白名单可在扫描根 path 下限定改名只作用于指定子路径内的文件（控制爆炸半径）；`resolveImporters` 跨目录反向 import 查找——开启后在 `importRoot`（缺省 cwd）内扫描，凡 `import { symbol } from '...'` / `export { symbol } from '...'` 指向本 scope 声明模块的外部导入方一并改名（解决 import 反向查找）。
- `replace_node`：按行列范围圈选，自动吸附到最小包含 AST 节点替换（`relation: exact|contains|inner`）；整行替换顺带消费行尾换行。
- `replace_subtree`：按成员链选择器（如 `config.server.host`）定位 topmost 子表达式替换；排除更长成员链里的子链，避免误伤；`path` 支持目录，按选择器批量替换所有匹配文件（输出逐文件 `files[]`）。
- 全部文件先在内存中完成变换并 `tryParse` 重解析校验结构完整性，任一失败整体放弃、不落盘；
- `dryRun` 可预览计划位点与替换后内容。

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

1. ✅ 建包，注册 paths/deps，`bun install`；v1 引入 @babel/parser + @babel/traverse。
2. ✅ 实现索引核心 `CodeIntelIndex`（parse → symbols/references/definition 查询，mtime/size 缓存）。
3. ✅ 注入 `code_symbols` / `code_reference` / `code_definition` + 单元测试（17 用例）。
4. ✅ cli 装配：登记进 `getBuiltinRegistry()`（`code-intel`，惰性 load + metaSource），后台预加载开箱即用。
5. ✅（v2）`code_semantic_edit` 结构感知编辑：`rename`（符号重命名，AST 精确位点 + 内存变换重解析校验 + dryRun）。
6. ✅（v2）`code_semantic_edit` `replace_node`：按 AST 节点范围替换（行列圈选自动吸附最小包含节点，整行替换顺带消费行尾换行）。
7. ✅ 全量 `typecheck` + `test`（code-intel 31、cli 163 全过）；更新 development-log（续 62/63/64）。
8. ✅（v2）`code_semantic_edit` `replace_subtree`：成员链选择器定位 topmost 子表达式替换（含下标/非纯成员链拒绝、精确匹配排除嵌套子链、dryRun 预览）。
9. ✅ 全量 `typecheck` + `test`（code-intel 37 全过）；更新 development-log（续 65）。
10. ✅（v2）`rename` 加 `scope` 子目录白名单限定；`replace_subtree` `path` 支持目录批量替换（输出重构为逐文件 `files[]`）。
11. ✅ 全量 `typecheck` + `test`（code-intel 43 全过）；更新 development-log（续 66）。
12. ✅（v2）`rename` 跨目录全局反向 import：`resolveImporters` + `importRoot`，反向扫描外部导入方（含再导出）纳入改名，解决 import 反向查找。
13. ✅ 全量 `typecheck` + `test`（code-intel 48 全过）；更新 development-log（续 67）。

## 8. 相关文档

- 工作区规划 [workspace-management.md](workspace-management.md)（§5.5 索引/AST 归属、§7.4 边界）
- 架构总览 [agent-harness-architecture.md](agent-harness-architecture.md)
- 开发日志 [development-log.md](development-log.md)