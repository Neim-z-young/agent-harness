# codeintel 插件开发规划（`@harness/code-intel`）

> 状态：**v1 + v2 已实现**（2026-09-04/05，见开发日志续 62/63/64/65/66/67）；**v3 Java 语义编辑已接入 rename**（CST token 位点 + 重解析校验，见 §3.2）。承接 [workspace-management.md](workspace-management.md) §5.5：「AST 与内容索引归代码情报层」，本插件即该层的插件化具象。
>
> **语义编辑边界（续 75 决策）**：语义编辑基于本地 AST（babel + tree-sitter），tree-sitter 无作用域绑定，rename 为**同名 token 弱语义**。已接入的 Java 语义编辑保留为**离线/轻量兜底**；不继续扩展到更多语言（Kotlin/PHP 等）。需要**真作用域/类型感知**的重型语义能力（跨文件精确 rename、move、inline、类型层次）时，改为以**外部标准 MCP server（如 Serena）**按需接入，不内置复刻（详见开发日志续 75）。

## 1. 定位与目标

提供**代码情报**能力：基于结构化 AST 的符号、引用、导航，使 Agent 能做高质量的定位与结构感知编辑。

- 独立插件包 `packages/plugins/code-intel`，命名空间 `@harness/code-intel`。
- 按"全功能插件化"约束实现，通过 `core.tool.pool.assemble` 注入工具，不与 core/CLI/workspace 耦合。

## 2. 职责边界

- **只做代码语义**：符号索引、引用、定义、结构感知编辑。
- **不含存储/路径定位**：只消费 workspace 提供的根路径（`resolveWorkspace`）。
- **AST 与内容索引归此层**：`workspace-management.md` §5.5 已明确 workspace 不承担 AST/内容索引，本插件内引入。
- 不污染 core、tools-builtin（`edit_file` 仍为精确字符串替换，结构编辑走本层）。

## 3. 技术选型

- **AST**：规划推荐 `web-tree-sitter`；v1 按「纯 TS 域可退化 @babel/parser 起步」落地为 **`@babel/parser` + `@babel/traverse`**（纯 JS、同步、可单测，支持 TS/TSX/JS/JSX + decorators 等插件集）。多语言 grammar 后续换 web-tree-sitter 不影响工具/插件契约。
- **符号索引**：v1 内存内 + 按需增量（parse 目标文件/目录，缓存按 mtime+size 失效）；不做持久化全文索引（呼应 §5.5），性能瓶颈再演进。
- **grammar 加载**：v1 无外部 grammar 文件；解析失败多配置回退（TS 加 jsx 宽容、纯 JS 兼容 TS 语法），单文件失败跳过不中断目录索引。忽略目录由插件配置传入。

### 3.1 竞品对标（opencode / claude code，2026-09 调研）

调研 `reference/opencode-dev`（源码）与 `reference/claude-code-analysis-main`（Web 版源码反推分析）结论：**两者都没有内建完整 AST 符号索引 / 跨文件 go-to-definition**，本插件的 AST 结构化为差异化能力。

| 能力 | opencode | Claude Code（Web） | `@harness/code-intel` |
| --- | --- | --- | --- |
| grep / 搜索 | `ripgrep`（正则文本），fallback `fff`（文件名/模糊索引，fuzzysort） | `GrepTool`（正则文本） | AST 索引（babel/tree-sitter）做符号/引用/定义 |
| go-to-definition / references | 无（LSP 仅配置 schema，`tool/edit.ts` 仍为 `TODO: LSP runtime`） | 无内建，靠大模型 + grep | `code_definition` / `code_reference` 结构化返回 |
| 代码语义编辑 | 字符串 `edit` / `apply_patch` | 字符串 `EditTool`（diff） | `code_semantic_edit`：AST 节点级 rename/replace_node/replace_subtree |
| 结构完整性 | 无（文本补丁） | 无 | 落盘前内存重解析校验，失败整体放弃 |

关键证据：opencode 内建工具为 `read/grep/glob/bash/edit/write/apply_patch/webfetch/websearch`（`packages/core/src/tool/`）；其代码语义计划走 LSP，但 [tool/edit.ts](reference/opencode-dev/packages/core/src/tool/edit.ts) 标注 `TODO: Add LSP ... after V2 LSP runtime exists`，尚未落地。Claude Code 工具集为 `Read / Grep / Glob / 只读 Bash / Edit / Write`（`claude-code-analysis-main/analysis/04g-prompt-management.md`）。二者均以「正则 grep + 大模型理解」代替结构化索引。

对比本项目：`code-intel` 已内置了上述两者未提供的 AST 符号索引与结构感知编辑。**Java 语义编辑（v3）** 正在将 Java 从「名字命中型」提升为「语义」：连同已实现的 rename（TS/JAVA）与 replace_node/replace_subtree，使成员链定位与跨文件重命名在多语言一致。

### 3.2 Java 语义 rename（v3，2026-09-06）

对非 JS 语言，tree-sitter 是通用 CST、无 babel 的作用域绑定，故 `code_reference` 为名字命中型；但 `code_semantic_edit` 的 **rename** 对 Java 走独立实现，从「名字命中」提升为「语义位点」：

- **声明位点精确化**：仅在拥有 `name` 字段的声明节点（class/record/interface/annotation_type/enum 的 `name`→type_identifier、method/constructor 的 `name`→identifier、variable_declarator 的 `name`）取声明名 token，标记为 `decl`。
- **引用位点**：其余同名 `identifier` / `type_identifier` / `field_identifier` token（含 import 说明符尾部、字段访问、类型引用、调用）归为 `ref`。
- **CST token 级隔离**：只在真实标识符 token 上替换，注释 / 字符串 / 字面量天然被排除（非 token）。
- **偏移即字符索引**：web-tree-sitter 已把 UTF-8 字节偏移换算为 JS 字符索引（实测含中文注释时 `startIndex/endIndex` 仍与 `content.slice` 对齐），位点可直接用于替换，无需再字节→字符换算。
- **结构校验**：rename 落盘前对每个改动文件用 `verifyJavaSource` 重解析（`!root.hasError`），任一失败整体放弃（对齐 TS/JS 的 `tryParse` 校验）。

实现：`multi.ts` 的 `collectJavaRenameSites` / `verifyJavaSource` / `collectJavaModuleInfo`；`core.ts` 的 `CodeIntelIndex.collectRenameSitesFromScope` 按 `.java` 分派 + `execRename` 校验分支 + `reverseImporters` 的 Java 包名匹配分支。作用域限定（scope）与 dryRun 预览对 Java 同样生效。

**反向 import（Java）：** `resolveImporters` 对 Java 按**包名匹配**——`collectJavaModuleInfo` 提取声明方 `package a.b;` 与外部导入方 `import a.b.Symbol;`，凡 import 限定名末段 == 符号且前缀 == 声明方包名，该导入方整文件纳入改名（声明+引用全改）。仅全限定名引用（无 import 绑定）或非本包的开发者不会被误拉入。

## 4. 注入工具（`core.tool.pool.assemble`）

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
  - `core.harness.init`：建符号索引上下文（消费 workspace 根路径）。
  - `core.tool.pool.assemble`：注入上述工具。
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