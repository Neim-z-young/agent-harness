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

## 2. 待补清单

### 2.0 P0 —— 会导致**安全漏判或行为错误**（先做这批）

| # | 缺口 | 为什么是 P0（判据） | 位置 |
|---|---|---|---|
| P0-1 | **危险命令表缺 Windows 原生形态** | 现有 12 条里 Windows 专属只有 `format /s /f /q`。`del /f /s /q C:\`、`rd /s /q`、`Remove-Item -Recurse -Force C:\`、`Format-Volume`、`Clear-Disk`、`Stop-Computer`、`reg delete HKLM\…` 全部**不命中** ⇒ 破坏性命令直接放行 | `DEFAULT_DANGEROUS_PATTERNS` |
| P0-2 | **`splitSegments` 不以单个 `&` 分段** | CMD 的 `cmd1 & cmd2` 是合法串联；现表只切分号、换行、双与、双竖线、单竖线，**单个 `&` 不分段** ⇒ `echo hi & shutdown -h now` 只被当成一段，段级 deny 漏判 | `splitSegments` |
| P0-3 | **`extractFirstCommand` 不认 PowerShell 调用运算符 `&`** | `& 'C:\evil.exe' -x` 的首命令被提取成 `&` ⇒ 以命令名为准的白名单/deny 规则失配 | `extractFirstCommand` |
| P0-4 | **引号/转义解析是 POSIX 方言** | PowerShell 用反引号 `` ` `` 转义、here-string `@"…"@`、`''` 表单引号。`stripQuoted` 不认 ⇒ 「去掉引号后的结构投影」在 PS 上不准，结构性检查（重定向/进程替换）可能漏判 | `stripQuoted` / `WRITE_CHANNEL_PATTERNS` |
| P0-5 | ✅ **已修**（2026-10-11，见 `sandbox-isolation-plan.md` 续 276）—— 原文：**超时只杀直接子进程，不杀进程树** | `child.kill('SIGKILL')` 在 Windows 上只终止被 spawn 的那个进程；shell 拉起的子进程（如 `npm run dev` 的 node）会残留 ⇒ 超时后仍有孤儿占用端口/文件锁 | `runBash` 的 timer 分支 |
| P0-6 | **UNC 路径未验证** | `\\server\share\x` 在 Windows 上是绝对路径；`isWithinCwd` 对 UNC 的 `relative()` 行为未测 ⇒ 沙箱边界可能被绕过或误拒 | `isWithinCwd` / `resolvePath` |

### 2.1 P1 —— **能力缺口**（Windows 上少一块功能）

| # | 缺口 | 说明 | 位置 |
|---|---|---|---|
| P1-1 | **POSIX → PowerShell / CMD 命令映射** | 现在非 bash 直接禁用 allowlist。可做「首命令名 → cmdlet」映射表（`ls`→`Get-ChildItem`、`cat`→`Get-Content`…），把白名单**翻译**而非禁用。⚠️ 映射必须**只用于判定**（不改写命令），且未命中映射时的默认行为要保持 fail-closed | `createBashTool` |
| P1-2 | **PowerShell 专用只读白名单** | `bash_ro` 在 Windows 全不可用。可为 PowerShell 定义只读集：`Get-ChildItem` / `Get-Content` / `Select-String` / `Measure-Object` / `Get-Item` / `Compare-Object` / `Where-Object`… 并写一条「无重定向/无 `Invoke-*`/无 `Remove-*`」的结构门 | `createReadOnlyBashTool` |
| P1-3 | **PowerShell 的 AST 复核门** | 现有 `checkReadOnlyByAst` 只能跑 tree-sitter-**bash**。PS 侧要么引入 PS 解析器，要么明确「PS 只读靠结构门 + 白名单，不做 AST 复核」并写进文档 | `bash-ast.ts` |
| P1-4 | **CRLF / BOM 处理** | Windows 上文件是 CRLF、可能带 BOM。`edit_file` 的 `old_string`（模型/用户给 LF）会匹配失败；`read_file` 的 `totalLines`/行号也会偏移。需要「读时记录行尾风格、写时保持、匹配时容忍」 | `tools-builtin` 的 read/write/edit |
| P1-5 | **CI 三平台矩阵** | 全仓测试只在本机 macOS 跑过。没有 ubuntu / macos / windows 矩阵，上面任何修复都会在下次改动里静默回归 | 仓库 CI 配置 |
| P1-6 | **测试的平台假设** | `tools-builtin` 用例大量用 `seq` / `cat` / bash 语法跑真机命令 ⇒ Windows 上整片红。需要「平台条件跳过」或改用 node 原生实现 | `tools-builtin.test.ts` 等 |

### 2.2 P2 —— **体验一致性**（不影响正确性，但口径不齐）

| # | 缺口 | 说明 |
|---|---|---|
| P2-1 | env-context 的 Windows 细节 | 用户名形态（`DOMAIN\user`）、PowerShell 版本（`$PSVersionTable.PSVersion`，可帮模型判断可用语法）、主机名大小写 |
| P2-2 | 注入 `env` 对象时的键名健壮性 | 真实运行时 `process.env` 在 Windows 上是**大小写不敏感代理**（Node 特性），`env.PATH` 能取到 `Path`；但**注入自定义对象**（测试 / 其他宿主）时是普通对象 ⇒ 建议 `resolveShell` / `detectShellForDisplay` 做大小写不敏感查找 |
| P2-3 | `sanitizeEnv` 的 Windows 敏感变量 | 补 `USERPROFILE` / `APPDATA` 之外的凭据位置（`*_TOKEN` 已覆盖）；确认大小写不敏感匹配 |
| P2-4 | 文档口径 | `AGENTS.md` 与 `docs/*` 的示例命令、路径全是 POSIX；至少要在 README 标「Windows 需 Git Bash / WSL 才能获得完整沙箱语义」 |
| P2-5 | `openInFileManager` 真机 | `explorer` / `xdg-open` 的引号与参数在 Windows 上未验证（含路径带空格） |

### 2.3 P3 —— **工程与分发**（长尾）

| # | 缺口 | 说明 |
|---|---|---|
| P3-1 | `bun build --compile` 的 Windows 目标 | 现在只验证过 darwin-arm64。`bun build --compile --target=bun-windows-x64` 未跑通验证 |
| P3-2 | VSCode 扩展的 Windows 端到端 | `src/bun.ts` 的 Windows 安装位置、`launch.ts` 的 sidecar 启动在真机未验证 |
| P3-3 | A2A 在 Windows 的路径/端口 | sidecar 的 `--port 0` 握手、`dataDir` 含盘符时的 JSON 序列化 |
| P3-4 | 新增插件包的跨平台约定 | 新工具插件应声明「是否需要 POSIX shell」，避免再出现「无 bash 就整片失效」 |

## 3. 建议实施顺序

1. **P0 一批**：危险表 + `&` 分段 + `&` 调用运算符 + 引号方言（都在 `tools-builtin` 一个包内，一次改完最好测）→ 补 Windows 形态的**纯函数单测**（注入 `platform`/shell 族系，不需要真 Windows）。
2. ~~**P0-5 进程树**：`taskkill /T /F` / 进程组 kill~~ ✅ **已完成**（2026-10-11，见沙箱方案续 276）：`killProcessTree()` —— POSIX 走 `detached` + `kill(-pid)`，Windows 走 `taskkill /T /F`；两条 e2e 用例真起进程验证（后台孙进程超时后不存活 / AbortSignal 同样杀整棵树）。
3. **P1-5 CI 矩阵**：先有闸，后面每条修复才不回归。建议 `ubuntu` + `macos` + `windows-latest`，`windows` 上允许「bash 相关用例跳过」白名单并**记录跳过条数**（防悄悄全跳过）。
4. **P1-1 / P1-2**：命令映射与 PS 只读白名单（安全敏感，需要 reviewer 过一遍映射表）。
5. **P1-4 CRLF/BOM**、**P2 批次**、**P3 批次**。

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
  本文 P0-5（超时不杀进程树）、P0-6（UNC 路径）在那份里同时是隔离缺口，**修的时候一次改到位**。
