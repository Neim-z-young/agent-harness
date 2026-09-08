# TUI `/tree` 命令：磁盘文件树 + 对话引用 `*` 标记

## Context

用户指出原实现（打印「对话引用树」）与磁盘不一致：`permissions.json` 被对话提及但磁盘不存在，`sessions/` 存在于磁盘却未打印。经确认，`/tree` 语义改为**磁盘真实文件树**，同时保留对话上下文——**对话中引用过的文件在树上以 `*` 标记**（两者结合）。交互式树仍留给图形页面。

仅改 `packages/cli/src/tui.tsx`、`tui.test.tsx`；不动其它包与侧栏逻辑。

## 一、纯函数（tui.tsx）

```ts
export interface FileRefTreeNode {
  key: string          // root:{absPath} | 目录/文件的 absPath
  name: string         // 根→abbrevFileRef 缩写；目录/文件→basename
  kind: 'root' | 'dir' | 'file'
  absPath: string
  marked?: boolean     // 文件叶：被对话引用过（渲染为 *）
  children: FileRefTreeNode[]
}

export interface DiskTreeOptions {
  maxDepth?: number   // 默认 3（根=0，到层即不下钻）
  maxNodes?: number   // 默认 100，超出截断
  exclude?: string[]  // 默认 ['.git', 'node_modules', '.DS_Store']
}

export function buildDiskFileTree(root: string, refs: string[], opts?): { nodes: FileRefTreeNode[]; truncated: boolean }
export function renderFileRefTree(tree: FileRefTreeNode[]): string
```

- `readdirSync(withFileTypes)` 递归扫描；目录在前、同级字母序（类 `tree`）；symlink/特殊文件忽略（防循环）。
- 引用标记集合：每个引用 base 同时做 `resolveEditPath(base)`（cwd/~ 基准）与 `resolve(root, base)`（相对 root 基准）双解析，覆盖 `~/`、绝对、相对三种形态；文件 `absPath` 命中即 `marked`。
- 渲染：根无分支线，目录带 `/`，`marked` 文件带 `*`。

## 二、`/tree [path]` 命令

- 无参 → `process.cwd()`；有参 → `resolveEditPath`（支持 `~`、相对 cwd）。
- 目录校验：`statSync(root).isDirectory()`，非目录提示「目录不存在：<abs>」。
- 输出 system 块：`文件树（<root 缩写>）[（截断）]：\n<树>`；有标记节点时追加空行 + `* = 对话中引用过的文件` 图例。
- 不入历史栈、不进会话内核；命令菜单候选描述更新为 `/tree [path]`。

## 三、测试

- `buildDiskFileTree`：目录在前字母序、排除 `.git`/`node_modules`、引用标记命中、`maxDepth` 下钻限制、`maxNodes` 截断。
- `renderFileRefTree`：`*` 标记 + 目录 `/` + 根无分支线。
- 端到端：`/tree <tmpdir>` 打印磁盘树、引用过的 `a.ts*` 带标记、图例出现、输入框清空；`/tree <不存在路径>` 提示目录不存在。

## 验证

```
cd packages/cli && /opt/homebrew/bin/bun run typecheck && /opt/homebrew/bin/bun test
```
全绿后按项目规范 git 提交。
