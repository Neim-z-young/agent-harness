# TUI 文件引用 → `/tree` 命令打印目录树（交互树留给图形页面）

## Context

侧栏"文件"标签维持现状（扁平引用列表，Tab 进入、Enter 打开）。**交互式目录树（展开/折叠/多根浏览）不放在 TUI，留给图形页面实现**；TUI 仅新增 `/tree` 斜杠命令：把对话中已出现的文件引用汇总为「根 → 目录 → 文件」树，以 system 块打印在聊天区。

仅改 `packages/cli/src/tui.tsx`、`tui.test.tsx`、`index.ts`（命令菜单注册），不动其它包；保留增量索引性能与现有打开/编辑逻辑。

## 前置调研结论（opencode / Claude Code）

- opencode：无侧栏文件引用树；仅 `@` 输入注入 + `/editor`。
- Claude Code：`Ctrl+Shift+E` 真实扫描磁盘的目录树（.gitignore + 搜索框）。
- 两产品均无「汇总对话中出现过的引用 → 树」的形态；本项目的输出捕捉 path:line 能力独特，`/tree` 打印即为其轻量呈现。

## 一、纯函数（tui.tsx，紧跟 `parseFileRef` 之后）

```ts
export interface FileRefTreeNode {
  key: string          // root:{标签} | {root键}:{相对 root 的路径}（跨根唯一）
  name: string         // 根→./|~/|其他；目录/文件→basename
  kind: 'root' | 'dir' | 'file'
  absPath: string      // 绝对路径（文件打开用）
  line?: number        // 文件叶：原始引用里的行号
  children: FileRefTreeNode[]
}

export interface BuildFileTreeOptions { cwd?: string; home?: string } // 测试注入

export function buildFileRefTree(refs: string[], opts?): FileRefTreeNode[]
export function renderFileRefTree(tree: FileRefTreeNode[]): string
```

- **根自动推断**：cwd（→`./`）优先，其次主目录（→`~/`），其余兜底（→`其他`）；无引用的空根剪掉。
- **目录链**：按相对根的路径逐级建 `children`，`Map<key, node>` 合并共享父目录；同文件（去 `:行[:列]`）仅保留首个（首个行号为准）。
- **渲染**：根不带分支线；目录带 `/`、文件带 `:行号`；`├─`/`└─`/`│` 分支线缩进。

## 二、`/tree` 命令（submit 回调，仿 `/history`）

- `v === '/tree'` → `collectFileReferences(prev, Number.MAX_SAFE_INTEGER)`（全量，不受侧栏 8 条上限约束）→ `buildFileRefTree(refs)` → system 块打印 `文件引用（N）：\n<树>`；无引用提示「（暂无文件引用）」。
- 不入历史栈、不进会话内核（return 早退）。
- 命令菜单：`setAllCommands` 追加 `{command:'/tree', description:'打印对话中出现的文件引用目录树（/tree）'}`；`index.ts` 的 `REPL_COMMANDS` 同步追加 `/tree`。

## 三、测试

**新增**：
- `buildFileRefTree`：多根推断与空根剪除；目录层级合并共享父目录；同文件去重保留首个行号；空引用 → 空树。
- `renderFileRefTree`：分支线、目录 `/`、文件 `:行号` 的精确文本；空树 → 空串。
- 端到端：mock 回复含 `src/a.ts:1` 与 `docs/mcp.md` → `/tree` 打印 `文件引用（2）：` 与 `src/`、`a.ts:1`，输入框清空（命令未回显为消息）；无引用时提示空态。

## 验证

```
cd packages/cli && /opt/homebrew/bin/bun run typecheck && /opt/homebrew/bin/bun test
```
全绿后按项目规范 git 提交。
