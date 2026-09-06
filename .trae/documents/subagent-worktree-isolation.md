# Subagent git worktree 隔离 — 实现计划

## Context

多个子 Agent（尤其 `runInBackground` 后台并行）并发写同一项目时，共享同一 working tree + index，存在写冲突。本计划为每个子 Agent 提供一个**独立 git worktree** 作为其工具执行工作目录，从根上隔离写操作。

与用户确认的决策：

- **启用条件**：宿主目录是 git 仓库时自动启用；非 git 仓库回退为现状（直接在当前目录执行）。

- **落地策略**：worktree 保留在项目下，完成后把相对基线 HEAD 的 **git diff 摘要**并入返回给父 Agent 的结果文本；完整 diff 写入临时文件返回 `diffPath`。不自动 merge 回父工作区（零覆盖风险）。

- **清理**：提供 `/worktrees list` / `remove <dir>` / `remove-all`。worktree 默认保留（便于续接/调试）。

核心接线事实（已勘察）：

- 工具执行目录由 `ToolContext.cwd` 决定，core 在**两处**硬编码 `cwd: this.deps.cwd`，未读取已存在的 `Session.cwd`：

  - 同步 `query()`：`packages/core/src/index.ts` L1317；方法内已有 `session2`（L1223），直接用 `session2.cwd ?? this.deps.cwd`。

  - 流式 `queryStream()`：L1552；是 async generator，需在 tool 循环前 `await this.deps.session.get(sessionId)` 取一次，`sess?.cwd ?? this.deps.cwd`。

- `Session.create()` 已支持存 `cwd`/`meta`（core L521-538），但 AgentRuntime 构造 ToolContext 未消费它。

- subagent 插件 `HarnessLike`（`packages/plugins/subagent/src/index.ts` L221-226）只有 `{agent, session, bus}`，`harness.start` 时 core 传入整个 HarnessImpl（core L1891-1905）。`Harness` 接口（L1579-1607）无 `cwd` 字段；唯一实现是 `HarnessImpl`。

- 内置文件工具 `resolvePath(input.path, ctx.cwd)` + `isWithinCwd` 校验、bash rootDir=`ctx.cwd`：子 Agent 工具自动跟随 `session.cwd`。

- subagent 子 session 在 `session.create({title, parentId})`（L639）创建；续接读 `existing`（L622-633）。同步结果路径 L939-968，后台路径 L764-812（`registry.complete` + notification）。

## 改动清单

### 1. core — `packages/core/src/index.ts`

- 同步路径 L1317：`cwd: session2.cwd ?? this.deps.cwd`

- 流式路径 L1552：tool 循环前 `const sess = await this.deps.session.get(sessionId)`，`cwd: sess?.cwd ?? this.deps.cwd`

- `Harness` 接口（L1606 区域）：加 `readonly cwd: string`（注释标注为"全局工具工作目录，子 Agent 判 git worktree 用"）

- `HarnessImpl`：加 `public readonly cwd: string`，构造时 `this.cwd = options.cwd ?? process.cwd()`

### 2. 新增 — `packages/plugins/subagent/src/worktree.ts`

自包含 git worktree 工具模块（纯函数，不 import core/index，用 `child_process.execFile` promisify，失败归一化为 `GitCommandError`）：

- `runGit(base, args, opts?)` → 统一封装，不传 shell

- `gitTopLevel(base)` / `isGitRepo(base)` → 取仓库根；非仓库返回 null

- `worktreeDirFor(base, token)` → `<base>/.harness/worktrees/<sanitized>`

- `ensureWorktreeIgnored(base)` → 写 `.harness/.gitignore` 含 `worktrees/`（幂等），防 worktree 目录被宿主仓库当 untracked 扫描

- `createWorktree({base, token})` → `git worktree add --detach --force <dir> HEAD`，dir 已存在则幂等复用

- `getWorktreeDiff({base, dir})` → `git -C <dir> diff HEAD --stat` + `diff HEAD`，返回 `{summary, patch, hasChanges}`

- `removeWorktree({base, dir})` → `git worktree remove --force <dir>`（带目录兜底清理）

- `listWorktrees(base)` → 解析 `--porcelain` 输出 `WorktreeInfo[]`

### 3. subagent 插件 — `packages/plugins/subagent/src/index.ts`

- 导入 worktree 模块。

- `HarnessLike` 接口加 `readonly cwd?: string`（真实流 core 传入 HarnessImpl.cwd；mock 传 undefined 不会误启用）。

- 插件作用域新增两处模块级状态：

  - `let baseCwd: string | null = null`（git 仓库根）

  - `let worktreeEnabled = false`

  - 在 `harness.start`（L1059）里：`baseCwd = h.cwd ? await gitTopLevel(h.cwd) : null`，`worktreeEnabled = baseCwd !== null`（采用仓库根而非子路径），守卫包 try/catch。

- **会话创建/续接**（L622-651）新增私有辅助 `resolveWorktree(existingCwd?): Promise<string | undefined>`：

  - `worktreeEnabled=false` → 返回 undefined。

  - 续接：若 `existing.cwd` 以 `<baseCwd>/.harness/worktrees/` 为前缀则返回该 cwd 复用；否则 undefined（保持该 session 原执行目录）。

  - 新建：`createWorktree({ base: baseCwd, token: ` s\_${Date.now()}\_${Math.random().toString(36).slice(2,8)} ` })`，独立 try/catch（失败 `ctx.log.warn` 降级返回 undefined），成功后 `session.create({ title, parentId, cwd: worktreeDir, meta: { worktreeDir } })`。

  - 续接路径：会话已存在时只决定 cwd，不重复 createWorktree。

  - 调用处：新建分支 `const wcwd = await resolveWorktree(undefined)` 后 `session.create({ title, parentId: ctx.sessionId, cwd: wcwd, meta: wcwd ? { worktreeDir: wcwd } : undefined })`；续接分支 `const wcwd = await resolveWorktree(existing.cwd)`。

- **类型扩展**：`SubagentToolOutput` 加 `diffPath?: string`；`BackgroundTask` 加 `diffPath?: string`；`formatTaskNotification` 输入加 `diffPath?: string`（若无则省略该节）。

- **diff 摘要辅助**：新增 `attachWorktreeDiff(result: { text: string }, worktreeDir: string | undefined): { text: string; diffPath?: string }`，内部 `getWorktreeDiff({ base: baseCwd, dir })`（失败 catch 返回原样），有变更则追加 `\n\n## Git Diff 摘要（相对基线 HEAD，目录 <wt>）\n<summary>` 并把完整 patch 写 `join(tmpdir(), ` subagent-diff-${Date.now()}.patch`)`，返回 `diffPath`。

- **worktree 目录来源（并发安全，不用模块级状态）**：同步/后台两路径在 diff 时已有 `subSession` 对象，直接用 `const worktreeDir = subSession?.cwd`。因 cwd 已随 session 持久化，多个后台子 Agent 并发时各读各自的 session.cwd，无竞争。

- **同步路径**（L939-968）：`summarizeResult` 后（`subSession` 已取到）`const { text: resultText2, diffPath } = attachWorktreeDiff({ text: resultText }, subSession?.cwd)`，用 `resultText2` 作为返回 `message` 与 `completed` 事件 `replyPreview`，返回值加 `diffPath`。

- **后台路径**（L764-812）：同样在已有 `subSession` 处调用 `attachWorktreeDiff` 后再 `registry.complete(...)`（result 用新文本 + 传 `diffPath`）、`completed` 事件 `replyPreview` 用新文本、`formatTaskNotification` 传 `diffPath`。

- **`/worktrees`** **命令**：`cli.commands` 注入（command `'worktrees'`，usage `/worktrees [list|remove <dir>|remove-all]`），仅在 `worktreeEnabled` 时注入；`cli.command` 实现 `list`（调 `listWorktrees(baseCwd)` 打印 worktree path + HEAD）/ `remove <dir>` / `remove-all`（调 `removeWorktree`），每次置 `input.result='continue'`。

## 测试清单

- **core 单测**（`core/src/index.test.ts`）：session 带 cwd 时同步/流式工具收到 `tctx.cwd === session.cwd`；session 无 cwd 回退 `deps.cwd`；`createHarness({cwd})` → `harness.cwd`。

- **new** **`worktree.test.ts`**（临时 `git init` 仓库）：`gitTopLevel` 真/假；`createWorktree` 幂等 + `.git` 存在 + `listWorktrees` 可见；`getWorktreeDiff` 改动有 `hasChanges`/摘要/`+` 行、未改无；`removeWorktree` 后目录消失且幂等；`ensureWorktreeIgnored` 幂等；`runGit` 失败归一化为 `GitCommandError`。

- **subagent 集成**（`subagent/src/index.test.ts`，沿用 mock provider，不跑真实模型）：

  - 扩展 mock `createMockSessionManager.create` 保存 `cwd`/`meta`（当前只取 title/parentId，须补）。

  - harness.cwd=git 仓库根：子 agent 在 worktree 写文件 → `session.cwd` 以 `/.harness/worktrees/` 结尾、`output.message` 含 `## Git Diff 摘要` 与文件名、worktree 目录存在。

  - harness.cwd=非 git 目录：`session.cwd===undefined`、无 diff 摘要。

  - 后台模式：task 结果含 diff 摘要、`diffPath` 存在。

  - 续接复用：二次调用 `sessionId` 同一 worktree。

  - 创建失败降级：不中断，返回 `ok:true`、无 cwd。

  - `/worktrees list` / `remove`。

## 验证

- `cd packages/core && bun test && bun run typecheck`

- `cd packages/plugins/subagent && bun test && bun run typecheck`

- 全仓 `bun run typecheck`；`bun test`（聚焦 core + subagent/tools 相关）

- 手动冒烟（可选）：在任一 git 仓库跑 REPL，`/subagents` 派子 agent 观察产物落在 `.harness/worktrees/<token>/`，`/worktrees list` 可见、`remove` 回收。

- 更新 `docs/development-log.md`（续 78），按规范精确暂存提交。

## 风险与边界

- 非 git 回退：所有新分支带 `worktreeEnabled` 守卫，行为等价现状。

- worktree 目录 token 与 subSessionId 不一致（SessionManager 不支持显式 id），靠 `session.cwd` 复用即可，不扩大 core 面。

- 父 Agent 用 read\_file 直接读 worktree 内路径会被 `isWithinCwd(base,...)` 拒绝（已知限制）；diff 摘要 + `diffPath`（tmp 下绝对路径）已提供足够信息，设计不依赖父直读 worktree。

- `createWorktree`/`getWorktreeDiff` 失败均降级，不中断子 Agent。

