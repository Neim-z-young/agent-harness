# 跨平台能力补齐计划

> 起点：2026-10-09 的 bash 工具跨平台改造（`resolveShell` + `BashOutput.shell` + 安全策略按 shell 族系分档）。
> 本文盘点**已经补齐的**与**仍然缺口的**，按「会导致错误/静默失败」→「能力缺口」→「体验一致」→「工程防回归」四档排。
> 每一条都标了**现有代码位置**与**判据**，便于逐条开工与验收。

## 0. 现状一句话

三个宿主（CLI / A2A / VSCode）在 macOS / Linux 上语义完整；**Windows 上从"完全跑不起来"变成"跑得起来但安全策略降级"**：

| 能力 | macOS / Linux | Windows |
|---|---|---|
| 执行 shell | `bash -c` | `bash.exe` → `pwsh` → `powershell` → `cmd`（探测） |
| 危险命令检测 | ✅ 12 条表 | ⚠️ 表里 Windows 专属只有 1 条（`format /s /f /q`） |
| 命令白名单（`config.allowlist`） | ✅ 生效 | ❌ **禁用**（bash 首命令语义不适用，见 §1） |
| 只读哨兵 `bash_ro` | ✅ 白名单 + AST 双门 | ❌ **直接拒绝**（`SANDBOX_RO_NO_BASH`，见 §1） |
| 环境信息注入（env-context） | ✅ | ✅（shell 名做了同口径探测） |

「禁用 / 拒绝」不是偷懒 —— 强行复用会制造「看起来放行实则危险」的口子。但它们确实是**能力缺口**，见 §2.1。

## 1. 已补齐（本轮 + 既有）

| # | 能力 | 位置 |
|---|---|---|
| 1.1 | shell 探测：非 Windows 用 bash；Windows 按 `bash.exe → pwsh.exe → powershell.exe → cmd.exe` 探测 PATH | `packages/plugins/tools-builtin/src/index.ts` 的 `resolveShell()` |
| 1.2 | `runBash` 按解析结果 spawn；`BashOutput.shell` 回传实际 shell 名（可观测） | 同上 |
| 1.3 | 非 bash 族系下禁用 `allowlist` + 结果附加降级提示 | `createBashTool` |
| 1.4 | 非 bash 族系下 `bash_ro` 直接拒绝 | `createReadOnlyBashTool` |
| 1.5 | env-context 的 `Shell:` 行用同口径探测（`process.env.SHELL` 为空时按同样顺序找） | `packages/plugins/env-context/src/index.ts` 的 `detectShellForDisplay()` |
| 1.6 | 打开文件管理器三分支（darwin / win32 / xdg-open） | `packages/plugins/workspace-shell/src/index.ts` 的 `openInFileManager` |
| 1.7 | 扩展侧 bun 发现链路含 Windows 安装位置（volta / asdf / mise / 项目本地） | `adapters/vscode/src/bun.ts` |

## 1.1 P0-5 的 **Windows 边界**（2026-10-13 查证，实测 + 上游源码）

> 触发：Windows CI 上两条"进程树"e2e 用例（`sleep 30 &` 后台孙进程）表现得像**没杀掉**——
> 一条靠放宽 timeout 变成"更慢的假通过"，另一条直接撞 30s。**先查证再改**，结论如下。

**① "taskkill 不灵"不是主要原因，`killProcessTree` 自己有个静默吞错的缺陷（已修）**
`spawnSync('taskkill', …)` 在 **ENOENT / 非零退出时都不抛**，只回填 `error`/`status`；而原实现在
调用后**无条件 `return`** ⇒ "树没杀成"完全静默，连"退回杀直系子进程"这条兜底都到不了。
现改为：**绝对路径**（`%SystemRoot%\System32\taskkill.exe`，键名大小写不敏感；不靠 PATH —— 实战实现
openclaw 的 `exec-termination.ts` 同样显式取 System32）→ **看返回值** → 失败才落到 `child.kill()`。
（纯函数 `resolveTaskkillPath` / `buildTaskkillArgs` 已由本机用例钉住。）

**② 内核级兜底拿不到：libuv 的 Job Object 带 `SILENT_BREAKAWAY_OK`**
`uv__init_global_job_handle()` 建的全局 job 设了
`BREAKAWAY_OK | SILENT_BREAKAWAY_OK | DIE_ON_UNHANDLED_EXCEPTION | KILL_ON_JOB_CLOSE`，
其源码注释明写："only the processes that we explicitly add are affected, and **their subprocesses
are not**"。⇒ 我们 spawn 的 shell **在** job 里，但它拉起的**孙进程静默脱离、不在 job 里**，
`KILL_ON_JOB_CLOSE` 兜不住它们。想让孙进程随 job 一起死必须**自建 job**
（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + `TerminateJobObject`）—— Node/Bun 都没有这个 API，
需要原生扩展或外部 helper。**故本文档不声称 Windows 上有内核级兜底。**

**③ `taskkill /T` 是"对快照遍历、最深优先"，天然有竞态**
它按 Windows 的 ppid 链接遍历（这正是正确形态：`process.kill` / `Stop-Process` 都只杀**一个**进程）。
但 MSYS2/Cygwin 创建原生子进程用 `CREATE_SUSPENDED` 再唤醒，落在"快照→kill"窗口里的孩子会被漏掉；
且 `/T` 会**先杀 console host**，bash 失去控制台后会再拉 `cygwin-console-helper.exe` + `conhost.exe`
留下（Claude Code #98976 在 Git Bash 上的实测：993 次 taskkill 里 14/119 次泄漏）。实战实现的应对是
**两趟**：先 `/T`（优雅）→ 等 grace → 只在根仍活着时再来 `/T /F`；并**验证 PID 身份**再重试
（Windows PID 复用积极，重试已死/被复用的 PID 会误伤无关进程树）。

**④ 测量口径本身可疑（这条最容易被忽略）**
Node 的 `close` 事件要等**所有持有 stdio 管道写端**的进程退出。孙进程若继承了 stdout/stderr，
即使 shell 被杀、`close` 也不触发 ⇒ 用例量到的"30s"很可能是**"管道没关"而非"进程没死"**。
（同形证据：hermes-agent#103402 的 Python `subprocess.run` 在超时后 `communicate()` 等 EOF 死锁，
修法是超时后先 `taskkill /F /T /PID` 再收管道。）

**⇒ 结论与现状**（2026-10-13 更新）：`killProcessTree` **已按"路 3"落地**——
①决策侧（绝对路径 / 看返回值 / 失败兜底直系 kill）②**两趟**（`/T` → 宽限 `KILL_TREE_GRACE_MS`
→ 经 `isChildAlive` 验明"仍是我们的那个进程"后补 `/T /F`）③调用侧的测量缺陷（**`close` 会等
"持有 stdio 管道写端的进程"退出**，被留下的孙进程会把工具钉住 ⇒ 加 `CLOSE_LINGER_MS`：
`exit` 后 250ms 仍无 `close` 就主动 destroy 管道）。
三条进程树 e2e 断言因此**回到 Windows 上跑**（`waitGone` 预算只有 2~3s ⇒ **不会假通过**）。

**CI 实证**（run `38394167872`，2026-10-13）：三条在 Windows 上**全部 pass，且是真耗时**——
`⑨` 1364ms、`★超时` 816ms、`★中断` 523ms。用例里孙进程是 `sleep 20` / `sleep 30`（自然到期
20~30 秒），而 `timeoutMs` 仅 400ms、判据预算 3000ms ⇒ 这些耗时**远早于自然退出**，
不是"等它自己到期"。**路 3 在 win32 上确实有效**（Windows skip 数 11 → 8，正是这三条归位）。

⚠️ **仍未解决**的是②（快照竞态）与"内核级兜底"——那是**路 1**（见 §1.2 与 P1-7）。
路 3 只是把窗口收窄并**实证到"当前形态下能过"**，**不等于消灭了竞态**（PID 复用 / console-host
顺序 / `CREATE_SUSPENDED` 窗口仍在）；要"无竞态保证"仍需路 1 的 Job Object。

### 1.2 业界怎么做的（三平台的 containment 机制，2026-10-13 查证）

"整棵树一起收掉"在各平台都有**内建**机制，**快照式枚举（`taskkill /T` / `pidtree` / `tree-kill`）
是公认的降级方案**（duck/duct.py 的 gotchas 说得最直白：枚举与信号之间"任何进程都可能又生了新的，
退出的 PID 还可能被复用"，所以它**天生 racy**）。

| 平台 | 机制 | 为什么它没有竞态 |
|---|---|---|
| **Windows** | **Job Object**（`KILL_ON_JOB_CLOSE` + `TerminateJobObject`） | 成员是**创建时继承**的；业界的标准姿势是 **"子进程以 `CREATE_SUSPENDED` 起 → `AssignProcessToJobObject` → 再 resume"** ⇒ 连"第一瞬间 fork 出来的孙进程"都被装进去 |
| **Linux** | **cgroup v2**（systemd 的 `KillMode=control-group`，5.14+ 的原子 `cgroup.kill`） | 后代一 `fork` 就在 cgroup 里；`cgroup.kill` 是一次原子操作（5.14 之前 systemd 只能"循环扫描 PID 再逐个杀" ⇒ 同样有 PID 复用竞态） |
| **macOS / BSD** | **没有整棵树的容器**，只有 **POSIX 进程组**（`setpgid` + `killpg`） | 进程组**不是树**（每个进程只有一个 pgid），子进程**自己 `setpgid` 就能脱离** ⇒ 这是平台能力上限，不是实现偷懒 |

参考实现：`ProcessKit-rs` 的 `docs/platform-support.md`（把三种机制、以及"Windows 上没有信号分级、
优雅关闭只能塌缩成原子 job kill"、"macOS 没有 whole-tree container"都如实列成表）；Electron /
VS Code 在生产里就是**把子进程放进同一个 job**（"closing the job kills every process in it
recursively …… typical of IDEs to ensure stopping debugging will stop everything"）；
Rust 的 `uv` 有 `uv-windows/src/spawn.rs` 专门做 job 监督。

**对我们（P1-7）的含义**：POSIX 侧我们已经在用上表第三行的等价物（`detached: true` + `kill(-pid)`）；
Windows 侧**已按"路 3"降级**（两趟 + 身份校验 + 不再被 `close` 钉住），但**根治要走上表第一行** ——
它的三个 API（`CreateJobObject` / `AssignProcessToJobObject` / `TerminateJobObject`）Node/Bun 都不暴露，
所以需要原生扩展（标准姿势：**子进程 `CREATE_SUSPENDED` 起 → `AssignProcessToJobObject` → resume**，
这样"第一瞬间 fork 的孙进程"也在 job 里），这是**路 1**、记为 P1-7 的剩余工作。
另外 job 顺带能给我们 **`max_memory` / `max_processes`** —— 正好是 `bash.limits` 在 Windows 上缺的那块。


## 2. 待补清单

### 2.0 P0 —— 会导致**安全漏判或行为错误**（先做这批）

| # | 缺口 | 为什么是 P0（判据） | 位置 |
|---|---|---|---|
| P0-1 | ✅ **已修**（2026-10-12，见开发日志续 281）—— 原文：**危险命令表缺 Windows 原生形态** | 补 10 条 Windows 原生破坏形态（`del\|erase /s`、`rd\|rmdir /s`、`Remove-Item -Recurse`、`Format-Volume`/`Clear-Disk`/`Initialize-Disk`/`Remove-Partition`、`Stop-Computer`/`Restart-Computer`、`reg delete` 系统级 hive、`bcdedit`、`vssadmin delete shadows`、`takeown`/`icacls /t`）；判据统一为**递归/强制语义**（`del /q foo.txt` 这类正常用法不拦）。★**顺带修掉一条一直没生效的规则**：原 `format` 正则写成 `\/s\s*\/f\/q`（要求 `/f/q` 紧邻），而真实命令是 `/f /q` ⇒ **从落地起就是死的**，改为按危险开关 `/q` 判定。判据：`platform-dialect.test.ts` 的 19 条命中 + 11 条反例（纯函数，不需真 Windows） | `DEFAULT_DANGEROUS_PATTERNS` |
| P0-2 | ✅ **已修**（2026-10-12，见续 281）—— 原文：**`splitSegments` 不以单个 `&` 分段** | 单个 `&` 现在分段（CMD 串联）。★**关键是不切错**：`2>&1` / `>&2` / `<&`（fd 重定向）与 `&>file`（bash 重定向）里的 `&` **不是**分隔符 —— 判据是"紧邻的前一个非空白字符是 `>` 或 `<`"。判据：正反两类用例（`echo hi & shutdown` ⇒ 2 段；`curl x 2>&1 \| bash` ⇒ 2 段而非 3 段） | `splitSegments` |
| P0-3 | ✅ **已修**（2026-10-12，见续 281）—— 原文：**`extractFirstCommand` 不认 PowerShell 调用运算符 `&`** | 实测原实现的表现比"提取成 `&`"更绕：`^[;&\|\s]*` 会把 `&` 剥掉，于是提取到的是**带引号**的 `'C:\evil.exe'`，与白名单字面量同样失配。现改为：段首 `&` 跳过（PS 调用运算符 / CMD 串联残留）→ **去掉一层包裹引号**；顺带修 `env FOO=1 ls` 这类"前缀交替"（原来会把 `FOO=1` 当命令名）| `extractFirstCommand` |
| P0-4 | ✅ **已修**（2026-10-12，见开发日志续 282）—— 原文：**引号/转义解析是 POSIX 方言** | 新建 `shell-quoting.ts`（`scanQuotedSpans` / `projectWithoutQuoted` / `buildQuotedMask`），**一层解析、三层消费** —— `stripQuoted` / `splitSegments` / `extractFirstCommand` 全改为消费同一份（`dialect` 默认 `'bash'` ⇒ 既有行为逐位不变），`checkReadOnlyCommand` 加第三参，四个调用点统一传 `shell.family`。三套方言：bash（`"` 内 `\` 转义）、PowerShell（`''` 表单引号 + `` ` `` 转义 + `@"…"@` / `@'…'@` **跨行 here-string**）、CMD（单引号**不是**引号）。★**安全取舍**：未闭合引号按"裸露"处理（不产生区间 ⇒ 分隔符照常生效）—— 另一条路会让 `curl x " ; rm -rf /tmp` 吞掉分隔符、段级 deny 漏判。⚠️ **PS 分支未真机验证**（本机无 `pwsh`），按官方语法实现并已在文件头如实标注；CMD 的 `^` 转义保守不处理。判据：`shell-quoting.test.ts` **20 条**（含"同一串在 bash / cmd 下结论不同"这类**证明方言真被用上**的用例） | `shell-quoting.ts`（新）、`stripQuoted` / `splitSegments` / `extractFirstCommand` / `checkReadOnlyCommand` |
| P0-5 | ✅ **已修**（2026-10-11，见 `sandbox-isolation-plan.md` 续 276）—— 原文：**超时只杀直接子进程，不杀进程树** | `child.kill('SIGKILL')` 在 Windows 上只终止被 spawn 的那个进程；shell 拉起的子进程（如 `npm run dev` 的 node）会残留 ⇒ 超时后仍有孤儿占用端口/文件锁。⚠️ **Windows 边界见 §1.1**（2026-10-13 查证）：决策侧的空缺（绝对路径 + 看返回值 + 兜底）已补，但"孙进程一定被杀掉"**没有证据**（libuv 的 job 带 `SILENT_BREAKAWAY_OK`，孙进程不在 job 里）—— 故路 3（两趟 + 身份校验）落地后，三条进程树 e2e 断言已**回到 win32 上跑并经 CI 实证通过**（见 §1.1） | `runBash` 的 timer 分支 |
| P0-6 | ✅ **已修**（2026-10-12，见开发日志续 283）—— 原文：**UNC 路径未验证** | **路径方言显式化**：`fs-guard` 新增 `PathDialect`（`'posix'｜'win32'`）与 `defaultPathDialect()`，四个判定函数各加一个可选 `dialect`（缺省＝当前平台 ⇒ **既有行为逐位不变**），`realpathBestEffort` / `isWithinCwd` 还可注入 `realpath`。四条由实测（node 26 / Bun）钉住的方言差异：① **UNC 是绝对路径**（`win32.isAbsolute('\\\\srv\\share\\x')` 为 `true`，而 `posix` 同串为 `false` —— 反斜杠在 posix 里是普通字符）；② 跨 server ⇒ `relative` 给**绝对路径**（走 `isAbsolute` 那支）；③ 同 server 跨 share ⇒ `relative` 给 `..\\..\\s2\\b`（走"以 `..` 开头"那支）；④ **大小写折叠是 `node:path` 的 win32 自带行为**（不需要本包再折一次）。判据：`fs-guard` 的 P0-6 组 **10 条**（纯函数、注入 `dialect`/`realpath`，**不需要真 Windows**），每条都配"同串在 posix 下的相反结论"。⚠️ **未覆盖**：Windows 的 8.3 短名 / 盘符大小写归一 / `\\?\` 前缀（本机 macOS 无法覆盖，真机接入时补） | `packages/fs-guard/src/index.ts` |

### 2.1 P1 —— **能力缺口**（Windows 上少一块功能）

| # | 缺口 | 说明 | 位置 |
|---|---|---|---|
| P1-1 | ✅ **已修**（2026-10-12，见续 283）—— 原文：**POSIX → PowerShell / CMD 命令映射** | 新建 `shell-commands.ts`：`CROSS_DIALECT_COMMANDS`（posix / powershell / cmd 三列等价表）+ `allowlistNamesFor()`（把白名单条目翻译到目标方言）+ `isCommandAllowed()`。`createBashTool` 的 `allowlistActive` **去掉了 `family === 'bash'` 这个前置条件**。三条纪律（都写进代码注释）：① **翻译只用于判定**（`isCommandAllowed` 只返回布尔，接口层面就无法改写命令文本）；② **只映射语义确实等价的只读类**（`rm`/`cp`/`mv` 等写操作**刻意不进表** —— `rm -rf` 与 `Remove-Item -Recurse -Force` 风险面不同，自动放大超出用户原意）；③ **PS/CMD 命令名大小写不敏感**（判定必须折叠，否则 `DIR` 会被当未知命令），bash 侧保持敏感。未命中映射 ⇒ 该条目在目标方言下**不匹配** ⇒ 拒绝（fail-closed） | `shell-commands.ts`（新）、`createBashTool` |
| P1-2 | ✅ **已修**（2026-10-12，见续 283）—— 原文：**PowerShell 专用只读白名单** | `POWERSHELL_READONLY_COMMANDS` / `CMD_READONLY_COMMANDS` + `readonlyCommandsFor(dialect)`；`createReadOnlyBashTool` **删掉了"非 bash 直接拒绝"**（`SANDBOX_RO_NO_BASH` 这个错误码已无生产路径）。结构门：PS 三条 + CMD 一条（见 P1-3）。收录判据是"只读取、只计算、只展示，且**不带能执行代码的参数**"——`ForEach-Object` / `Invoke-*` / `Start-*` / `New-Object` / `Add-Type` / `Measure-Command` **刻意不收**（与 POSIX 侧排除 `xargs` 同理）；CMD 侧 `date`/`time`（不带参数是**询问修改**）、`set`（带参数即写）、`attrib`/`chkdsk`/`label` **刻意不收** | `shell-commands.ts`（新）、`createReadOnlyBashTool` |
| P1-3 | ✅ **已修**（2026-10-12，见续 283）—— 原文：**PowerShell 的 AST 复核门** | **结论：不引入 PS 解析器，PS / CMD 明确不做 AST 复核** —— 成本远高于收益，而只读哨兵的目标是挡"顺手写一下"（协作式只读）。这条被显式化成常量 **`AST_REVIEW_DIALECTS = ['bash']`**（用例钉住，避免以后有人以为"所有方言都有第二道门"），并在 `createReadOnlyBashTool` 里 `facts = AST_REVIEW_DIALECTS.includes(family) ? await analyzeBashCommand(...) : null`。**代价如实记着**：PS / CMD 的只读保证**弱于 bash**，因此结构门必须承担更多 —— PS 四条：脚本块 `{ }`（`Where-Object { Remove-Item x }` 是合法 PS **且真的会执行**）/ 调用运算符 `&`（`& $cmd` 是间接执行）/ here-string `@"…"@` / .NET 写静态调用（`[System.IO.File]::WriteAllText(…)` 绕过 cmdlet 白名单）；CMD 一条：`%COMSPEC%` 展开。另外三处按方言修正：`SUBSTITUTION_PATTERNS`（PS 的反引号是**转义符**不是命令替换）/ `splitSegments`（PS 的 `&` 是调用运算符，**不切段**）/ readDeny 在无 AST 方言下退到**文本级近似**（`tokenLikePaths`，宁可误拒不可漏放） | `shell-commands.ts`（新）、`index.ts` |
| P1-4 | ✅ **已修**（2026-10-12，见续 283）—— 原文：**CRLF / BOM 处理** | 新建 `line-endings.ts`（`detectEol` / `preferredEol` / `normalizeEol` / `applyEol` / `detectBom` / `stripBom` / `withBom` / `planWrite`），三处工具共用一份口径。**核实时发现 `edit_file` 早已有 CRLF 容忍**（旧实现就地写死的 `content.includes('\r\n') ? '\r\n' : '\n'`）—— 本轮的增量是把它抽成共用口径 + 补 BOM + 补另两处：`read_file` 新增 `lineEnding` / `bom` 字段（**如实报告**；`content` **剥掉 BOM**，行尾**保留原样**）；`write_file` 覆盖已有文件时**按其行尾与 BOM 写回**（只读头部 64KB 检测；不改的话"改一行"会被 diff 显示成"整文件改动"）；`edit_file` 匹配在**剥 BOM** 的文本上做、写回时拼回，且 `old_string` **自带 BOM 也认**（模型可能从旧版 read_file 里复制）。判据：`line-endings.test.ts` **24 条**（含"LF 文件逐位不变"这类回归钉子）。⚠️ **顺带纠正判据点名的"行号偏移"**：`allLines` 按 `\n` 切 ⇒ CRLF **不会**产生额外行，`totalLines` / `linesRead` 与同内容 LF 文件一致（用例钉住） | `line-endings.ts`（新）、read/write/edit 三处 |
| P1-5 | ✅ **已修**（2026-10-12，见沙箱方案续 279 / 本文件续 281） | 落地于 `.github/workflows/ci.yml`（ubuntu / macos / windows 矩阵）+ `scripts/ci/test-summary.sh`：**只读 bun 汇总行**，记录 `pass / fail / skip` 并写 step summary；`pass ≥ 2000`（防"整包没跑起来"）与 `skip ≤ 200`（防"某一片被整体跳掉"）**分开判**；Windows 只放行**失败**，pass/skip 阈值照样拦 | 仓库 CI 配置 |
| P1-6 | ⚠️ **主要部分已修**（2026-10-12，见续 283） | `tools-builtin.test.ts` 顶上加平台门：**`HAS_POSIX_SHELL = resolveShell().family === 'bash'`** + `posixIt = it.skipIf(!HAS_POSIX_SHELL)`，**31 个"真跑命令"的用例**换成 `posixIt`。★判据刻意**不是** `process.platform !== 'win32'`，而是**与运行时同一份**（`resolveShell`）：装了 Git Bash / MSYS2 / WSL 的 Windows runner 会**真跑**这些用例（拿到真实覆盖），只有确实没有 bash 的环境才跳过；跳过条数进 bun 汇总行 ⇒ 由 CI 的 `skip ≤ 200` 闸看着。**其余四个含 POSIX 字面量的测试文件经抽查是纯函数输入**（喂给 `assessRisk` / 解析器 / 格式化函数，不真执行）：`host/src/permission.test.ts`（6 处，`2>/dev/null` 字符串）、`cli/src/cli.test.ts`（2 处，命令字符串进 `formatToolInput`）、`bash-ast.test.ts`（8 处，喂解析器）、`isolation/src/index.test.ts`（3 处）—— **未逐一核查是否真执行**（如实记着） | `tools-builtin.test.ts` |
| P1-7 | 🟡 **降级已做（路 3，2026-10-13）+ 根治未做（路 1）** | **已做**：win32 走**两趟** `taskkill`（`/T` → 宽限 `KILL_TREE_GRACE_MS=300` → 经 `isChildAlive`（用**我们自己的句柄**判活，防 PID 复用误伤）后补 `/T /F`）+ 决策侧（绝对路径 / 看返回值 / 失败兜底直系 kill）+ 调用侧不再被 `close` 钉住（`CLOSE_LINGER_MS`）。三条进程树 e2e 已**回到 Windows** 并经 CI 实证通过（run `38394167872`：1364/816/523ms，**不是**等自然到期）。**未做（路 1，根治）**：自建 Job Object —— 标准姿势是"子进程 `CREATE_SUSPENDED` 起 → `AssignProcessToJobObject` → resume → `TerminateJobObject`"，这样连"第一瞬间 fork 的孙进程"都装进去，**没有快照竞态、也没有 PID 复用问题**；三个 API **Node/Bun 都不暴露** ⇒ 需原生扩展（每平台预编译产物）或外部 helper。**顺带收益**：job 还能给 `max_memory` / `max_processes`，补上 `bash.limits`（`ulimit`，POSIX 语义）在 Windows 的空白 | `tools-builtin/src/index.ts`（`killProcessTree`）、三条 e2e 断言 |

### 2.2 P2 —— **体验一致性**（不影响正确性，但口径不齐）

| # | 缺口 | 说明 |
|---|---|---|
| P2-1 | ⚠️ **部分已修**（2026-10-12，见续 284） | **① 用户名形态 ✅**：`collectStaticEnv` 在 win32 下优先用 `USERDOMAIN\USERNAME` 拼 `DOMAIN\user`（只看 `alice` 在域环境里不可定位），`USERNAME` 缺失时退回 `os.userInfo()`；`collectStaticEnv` 现在接受 `{platform, env}` 注入 ⇒ 该分支可被**纯函数**钉住（4 条用例）。**② 主机名大小写：无需处理**（`os.hostname()` 原样返回，Windows 上比较大小写不敏感是**消费方**的事，不是收集方）。**③ `$PSVersionTable.PSVersion`：刻意不做** —— 它必须 `spawn` 一个 PowerShell 才能拿到，而 `collectStaticEnv` 是**每次装配都要跑**的路径；模型自己在需要时查一次更划算（且 tools-builtin 的 PS 方言判定不需要版本号）。 |
| P2-2 | ✅ **已修**（2026-10-12，见续 284） | `resolveShell`（执行侧）与 `detectShellForDisplay`（展示侧）各加一个 **`lookupEnvCI(env, name)`**：**先精确匹配、再退到大小写不敏感扫描**（空串继续找 —— Windows 上可能同时存在空的 `PATH` 与有效的 `Path`），`ComSpec` 同样处理。两侧注释互相指向（这是**同一份口径的两个落点**：一边改了另一边没改，就会出现"提示说用 Git Bash、实际执行走 cmd"）。判据：两包**成对**用例 —— `platform-dialect.test.ts` 的 P2-2 组（执行侧）+ `env-context/src/index.test.ts` 的 P2-2 组（展示侧），形状相同、同一输入同一期望 |
| P2-3 | ✅ **已修**（2026-10-12，见续 281） | ① **六条规则全部加 `/i`** —— 原来只有两条有，`github_token` / `Github_Token` 这类写法**直接漏过**（Windows 上键名大小写不固定）；② 补后缀型（`(?:^\|_)TOKEN(?:_\|$)` / `KEY` 夹边界，避免误摘 `MONKEY`/`KEYBOARD_LAYOUT`）与专用名（`NPM_TOKEN`/`SLACK_TOKEN`/`DSN`/`DATABASE_URL` …）；③ 反向确认 `USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`TEMP` **不**进表（它们是路径不是凭据，摘掉会破坏命令）—— 由用例钉住。★`SENTRY_DSN` 上踩过 `\bDSN\b` 的坑（`_` 是词字符 ⇒ 无词边界 ⇒ 规则等于没写） |
| P2-4 | ✅ **已满足**（2026-10-12，见续 283/284） | README 新增的「跨平台（bash / PowerShell / CMD）」小节已写明：**"PS / CMD 不做语法树复核 ⇒ 只读保证弱于 bash，要完整语义请装 Git Bash / WSL"**，并列出白名单翻译边界、结构门、文件读写与路径方言的行为。⚠️ `AGENTS.md` 与 `docs/*` 里的**示例命令**仍是 POSIX —— 那是**描述现状**（本仓开发环境就是 POSIX），不是缺口；真要在 Windows 上跟做，README 那一节已给出前提 |
| P2-5 | ⚠️ **判据需更正**（2026-10-12，见续 284） | 核实：`workspace-shell/src/index.ts` 用 `execFile('explorer', [path])` —— **`execFile` 不经过 shell**（argv 直接传给进程）⇒ 判据里"引号与带空格路径"这半句**不是风险点**。真正的风险是 **`explorer.exe` 成功时也常返回非零退出码** ⇒ 现有实现会把成功报成 `{ok:false, error}`。这条**需要 Windows 真机确认**（改法是 Windows 分支忽略退出码，或改用 `cmd /c start ""`），因此仍算未完成 |

### 2.3 P3 —— **工程与分发**（长尾）

| # | 缺口 | 说明 |
|---|---|---|
| P3-1 | ⚠️ **已实测，阻塞点明确**（2026-10-12，见续 284） | 本机跑 `bun build src/index.ts --compile --target=bun-windows-x64` **失败**：`Could not resolve: "@opentui/core-win32-x64"` —— `@opentui/core` 用 **optionalDependencies 按平台分发 native 包**，本机只装了 `core-darwin-arm64` ⇒ **交叉编译不是"跑一条命令就能验"**：要么在 Windows 上构建，要么先 `bun install --os=* --cpu=*`（会拉全平台 native 包、动 lockfile，**未做**：属"可选改动先不动"）。⇒ 这条的实际解法是**在 GitHub Windows runner 上跑一次**（`ci.yml` 已就位） |
| P3-2 | VSCode 扩展的 Windows 端到端 | `src/bun.ts` 的 Windows 安装位置、`launch.ts` 的 sidecar 启动在真机未验证 |
| P3-3 | A2A 在 Windows 的路径/端口 | sidecar 的 `--port 0` 握手、`dataDir` 含盘符时的 JSON 序列化 |
| P3-4 | ✅ **已修**（2026-10-12，见续 284） | `packages/plugins/<name>/package.json` 新增约定字段 `"harness": { "shellRequirement": "posix" }`（缺省＝`'none'`）；`tools-builtin` 已声明 `'posix'`。配套**双向守卫** `host/src/plugin-shell-requirement.test.ts`：① **用了却没声明**（源码非测试、非注释行里出现 `getShell(` / `resolveShell(` ⇒ 必须声明）② **声明了却没用**（防**声明腐烂**，别让后来看声明的人被误导）③ 取值只能是 `posix` / `none` ④ 控制组钉子（`tools-builtin` 确实声明且确实在用 —— 否则前两条断言会退化成"两边都是空"而永远绿） |

## 3. 建议实施顺序

1. ~~**P0 一批**：危险表 + `&` 分段 + `&` 调用运算符 + 引号方言~~ ✅ **已完成 4/4**（2026-10-12，见续 281/282）：
   危险表（P0-1）、单个 `&` 分段且不误切 fd 重定向（P0-2）、首命令提取认 PS `&` 且去引号（P0-3）、
   引号方言三层统一（P0-4）全部落地；纯函数单测从 52 条增到 **72 条**（`platform-dialect.test.ts` +
   `shell-quoting.test.ts`，注入字符串即可判、不需要真 Windows）。
   **P0 至此只剩 P0-6（UNC 未验证）**。
2. ~~**P0-5 进程树**：`taskkill /T /F` / 进程组 kill~~ ✅ **已完成**（2026-10-11，见沙箱方案续 276）：`killProcessTree()` —— POSIX 走 `detached` + `kill(-pid)`，Windows 走 `taskkill /T /F`；两条 e2e 用例真起进程验证（后台孙进程超时后不存活 / AbortSignal 同样杀整棵树）。
3. ~~**P1-5 CI 矩阵**~~ ✅ **已完成**（2026-10-12）：`.github/workflows/ci.yml` + `scripts/ci/test-summary.sh`
   —— `ubuntu` + `macos` + `windows-latest`，**记录跳过条数**并设阈值闸（`skip ≤ 200`、`pass ≥ 2000`），
   Windows 白名单只放行失败。**P0-1 / P0-2 / P0-3 / P0-4 / P2-3 也已完成**（同批，见续 281/282）。
4. ~~**P1-1 / P1-2**：命令映射与 PS 只读白名单~~ ✅ **已完成**（2026-10-12，见续 283）：等价表 +
   只读集 + 结构门统一收在 `shell-commands.ts`（一层实现、三处消费：`createBashTool` 的白名单、
   `createReadOnlyBashTool` 的只读集、`checkReadOnlyCommand` 的逐段判定）。
   ⚠️ **这条里"需要 reviewer 过一遍映射表"的要求仍然成立且未被满足** —— 而且范围比原判据更大：
   **整批 PS / CMD 判定都没在真机上验证过**（本机 macOS 无 `pwsh` / `cmd.exe`）。用例钉的是
   **判定算法**（纯函数、逐条正反例），不是真机行为。**Windows CI 与真机复核是必要的下一步**（见第 8 条）。
5. ~~**P1-3：AST 复核门的结论**~~ ✅ **已完成**：不引入 PS 解析器，PS / CMD **明确不做 AST 复核** ——
   这条被写成常量 **`AST_REVIEW_DIALECTS = ['bash']`**（用例钉住），代价（PS/CMD 的只读保证弱于 bash）
   如实记在 §2 的 P1-3 行与代码注释里。结构门因此承担更多（PS 四条：脚本块 / 调用运算符 / here-string /
   .NET 写调用）。
6. ~~**P1-4 CRLF/BOM**~~ ✅ **已完成**（2026-10-12，见续 283）：抽出 `line-endings.ts` 供三处共用
   —— 读时如实报告、写时保持、匹配时容忍；BOM 展示剥掉、写回保留。
7. ~~**P1-6 测试的平台假设**~~ ⚠️ **主要部分已完成**（2026-10-12，见续 283）：`tools-builtin.test.ts`
   的 **31 个"真跑命令"用例**改用 `posixIt`（`it.skipIf(!HAS_POSIX_SHELL)`，判据＝**与运行时同一份**
   `resolveShell().family === 'bash'`，因此装了 Git Bash 的 Windows runner 会真跑）。其余四个含 POSIX
   字面量的测试文件经抽查是**纯函数输入**（喂 `assessRisk` / 解析器 / 格式化函数），**未逐一核查**。
8. ~~**P2-2 / P2-4 / P3-4**~~ ✅ **已完成**（2026-10-12，见续 284）：`lookupEnvCI` 大小写不敏感 env 查找
   （执行 / 展示两侧成对）、README 口径（"要完整语义装 Git Bash / WSL"已写明）、插件包的
   `harness.shellRequirement` 声明 + 双向守卫。~~**P2-1 的用户名形态**~~ ✅ 也已做（win32 ⇒ `DOMAIN\user`）；
   `$PSVersionTable` **刻意不做**（要 spawn，而这是每次装配都跑的路径）。
9. **剩余（都需要 Windows 真机）**：**P2-1 的 `$PSVersionTable` 下游**（若将来真需要版本相关的语法分支）、
   **P2-5**（`explorer.exe` 的退出码语义 —— 判据里的"引号"那半句已更正为伪风险）、
   **P3-1**（交叉编译被 optional native dep 卡住 ⇒ 交给 Windows CI）、**P3-2 / P3-3**（VSCode 端到端 /
   A2A 路径与端口）；**外加整批 PS / CMD 分支的真机复核**（第 4 条）。
   ★**P2/P3 的剩余项有一个共同点：本机（macOS）无法闭环** —— 判据里"未验证"三个字掩盖了"**不可验证**"。
   最实际的动作是**把 `ci.yml` 的 Windows 跑起来**（矩阵已就位），一次拿到 P3-1/2/3 与 PS/CMD 的第一手证据。
10. ~~**把 `ci.yml` 的 Windows 跑起来**~~ ✅ **已跑，并抓到 6 个"本机永远看不到"的问题**（2026-10-13，见续 285）：
   首次真跑（macos ✅ / ubuntu ✗ 5 条 / windows ✗ 卡在 typecheck）：
   - **Windows 阻塞（影响 4 个根脚本）**：`bun --filter=* run <script>` 里的 `*` 被 **Bun Shell** 当 glob 展开，
     无匹配即报 `bun: no matches found` ⇒ `dev`/`build`/`test`/`typecheck` **全部起不来**（测试根本没跑到）。
     ⇒ 全部改为 **`bun run --filter '*' <script>`**（加引号；`--filter '*'` 的**依赖顺序**是有文档保证的，
     故不用 `--workspaces` —— 后者在有包缺脚本时行为不同）。★**同一坑在 zsh 下也成立**（本机直接敲
     `bun --filter=* run typecheck` 就报同样的错，只是 `bun run <script>` 会挑 bash 才"看起来没事"）。
     守卫：`packages/host/src/repo-scripts-guard.test.ts`。
   - **ubuntu 5 条**：全是**测试侧平台耦合**（无一条指向产品逻辑），其中 **3 条是前两轮自己写的**：
     P1-3 三态用例的非空断言（Linux 无原语 ⇒ `buildOsBinding` 返回 `null`）、`ulimit -f` 期望值把
     **macOS 的 1024B 单位**写死、mcp-client 透传用例拿 `sandbox-exec` 真 spawn（Linux ENOENT）；
     另两条是 subagent 用例**依赖"macOS 的 tmpdir 不在 `/tmp` 下"**这条平台事实、bench 用例在
     慢 runner 上超时。**全部已修**（2026-10-13）。
   ⇒ 这条本身现在是**已验证可执行的流程**：`git push` 触发（或 `gh workflow run CI` 手动），
   结果用 `gh run view --job <id> --log` 取、artifact 用 `gh run download` 取。

## 4. 验收口径（每一条都要能自动判）

- **纯函数层**：注入 `{ platform, shellFamily }` 断言判定结果（现有 `resolveShell` 用例即此范式），**不需要真 Windows 机器**。
- **执行层**：跨平台可用的断言（如 `exitCode` / 文件是否被创建），避免依赖 `seq` 之类的 POSIX 命令。
- **防回归**：每条 P0/P1 都要有「反向验证」——把修复注释掉，确认**指定条数**变红（本仓既有纪律，见 `AGENTS.md` §4 的验证协议）。
- **CI**：三平台矩阵全绿；Windows 上的 skip 数写进测试输出，超阈值即失败。

## 5. 与其它计划的关系

- 本文只管**平台差异**；宿主装配（`@harness/host` 一份）见 `docs/host-extraction-design.md`。
- A2A / VSCode 宿主的接入状态见 `docs/external-integration-plan.md`（VSCode 的 sidecar 就是 `harness a2a`，故两侧同源）。
- **沙箱 / 隔离**（命令执行边界、文件系统与网络绑定、资源上限、插件代码边界）见
  [`docs/sandbox-isolation-plan.md`](sandbox-isolation-plan.md)。⚠️ **两份计划的 P0 有交集**：
  本文 P0-5（超时不杀进程树，✅ 已修）、P0-6（UNC 路径，待做）在那份里同时是隔离缺口，**修的时候一次改到位**。
- **L3（容器 / microVM / 远程执行）与平台差异强相关**（容器运行时三平台各不相同、Windows 无 Seatbelt/bwrap）
  —— 见 [`docs/execution-backend-design.md`](execution-backend-design.md)。
- **本文件的"已修"口径（2026-10-12 起）**：标 ✅ 的项表示**判定逻辑已落地且被纯函数用例覆盖**；
  ⚠️ **凡涉及 PowerShell / CMD 真机行为的，都还没有真机证据**（开发机是 macOS）。要升级成"真机已验证"，
  需要 Windows 机器上跑一遍：`pwsh -Command` 下的只读集与结构门、`cmd.exe /c` 下的只读集、
  UNC 路径的 `realpath`、CRLF 文件的 read/write/edit 往返。**这条是整份文档的已知可信度边界。**
