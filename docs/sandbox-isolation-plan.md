# 沙箱隔离方案（盘点 + 分层目标形态）

> 起点：2026-10-10。承接[跨平台能力补齐计划](cross-platform-plan.md) §5 **原先**那句「本文不涉及
> **远程/沙箱隔离**（那是宿主职责，另议）」—— 本文就是那份"另议"（该句已改为指向本文）。
>
> **范围**：工具**执行侧**的隔离（命令执行 / 文件读写 / 网络 / 资源 / 代码加载）+ 宿主侧的
> 身份与边界。**不涉及**"换执行后端"（把 harness 接到 Codex / Claude Code 之类，见
> `external-integration-plan.md` §9）。
>
> **排法**：「静默失效或安全漏判」→「能力缺口」→「体验一致」→「工程防回归」四档。
> 每条给**现有代码位置**与**判据**，便于逐条开工与验收。
>
> **§7 是调研附录**（业界方案光谱 / 共识 / 采纳建议），用来把下面的 L0–L3 锚定到业界坐标；
> 它**不引入新待办**，待办一律以 §3 为准。
>
> **§8 是权限设计评审**（三个直答 + 缺陷清单 D1–D7）。缺陷里 D1/D2 已按 **P0-8 / P0-9** 收编
> 进 §3.0，其余（D5→P1-9、D4/D6/D7→P2-5~P2-7）同表归位 —— 本节只做分析与判据，**清单以 §3 为准**。

## 0. 现状一句话

今天的"沙箱"是**策略级（in-process policy）**，**不是 OS 级**：所有闸门都在同一个 Node 进程里、
以当前用户的全权限执行。策略能拦"模型写了什么"，拦不住"那段代码真的能干什么"。

| 能力 | 现状 | 位置 |
|---|---|---|
| 命令级策略（危险表 / AST 复核 / 白名单） | ✅ 有，且真机打磨过多轮 | `tools-builtin/src/index.ts`、`bash-ast.ts` |
| 工作目录边界 | ⚠️ **纯字符串前缀**判定，无 symlink 解析；**6 份副本** | `tools-builtin` / `tools-glob` / `tools-search` / `tools-media` / `code-intel` |
| 环境变量隔离 | ⚠️ **只覆盖 `bash`**；MCP 子进程全量继承 | `tools-builtin` / `mcp-client/src/index.ts:147` |
| 权限引擎（三模式 + 规则写回 + 风险分级 + 审计） | ✅ 有，三宿主共用一份；⚠️ **作用域是工作区级（跨会话、跨进程持久）**，不跟会话/调用方走（见 §8 D2） | `host/src/permission.ts`、`host/src/audit.ts` |
| 身份 / 调用方隔离（A2A） | ✅ token + `contextId` 归属绑定 + 默认只听 `127.0.0.1` | `a2a-server/src/auth.ts` |
| 网络出口 | ⚠️ 只有 `tools-web` 的 SSRF 防护；**`bash` 里的 `curl` 出网完全不受限** | `tools-web` / `tools-builtin` |
| 资源上限（CPU / 内存 / 磁盘 / 进程数） | ❌ **无**（只有 bash 30s 超时） | — |
| OS 级文件系统 / 网络绑定 | ❌ **无**（无 seatbelt / bwrap / landlock / 容器 / chroot） | — |
| 插件代码隔离 | ❌ 开闸即进程内全权 | `host/src/plugins.ts`、`host/src/host.ts:748` |
| 沙箱策略**可配置** | ❌ `BashSandboxConfig` 从 `config.json` **设不到** | `host/src/plugins.ts:320` |
| 补偿回滚（快照） | ✅ git 快照 + `/revert` + `/snapshot` | `packages/snapshot`、`packages/revert` |
| 多 Agent 文件系统隔离 | ✅ subagent git worktree | `subagent/src/worktree.ts` |
| 人工决策审计 | ✅ `decision.human` 落 `.audit.jsonl`（三宿主） | `host/src/audit.ts` |

一句话结论：**"该拦的都拦了，但拦在同一个进程里"** —— 缺的不是策略，是**执行边界**与
**资源边界**。

## 1. 已具备（按层归类，避免重复造）

### 1.1 工具层（`tools-builtin` 的 bash 工具，`createBashTool(config)`）

| 层 | 内容 | 位置 |
|---|---|---|
| 危险命令检测（前置硬性拒绝，回退也不可豁免） | 默认 **12 条**正则：fork bomb / `rm -rf /` / `rm -rf ~` / `mkfs.*` / `dd` 写裸盘 / 重定向写裸盘 / 破坏性命令带裸设备 / 关机重启 / `format /s /f /q` / `curl\|bash` / `chmod -R 777 /` / `sudo rm -rf /` | `DEFAULT_DANGEROUS_PATTERNS` |
| **AST 复核门**（增强，非替代） | 在**引号解码后**的字面量上重跑危险表 + 「命令名含展开 ⇒ 拒（除 `$(which x)` 路径解析惯用法）」；wasm 不可用/语法错 ⇒ 回落原始正则，**绝不因此放行** | `bash-ast.ts`、`detectAstDangerous` |
| cwd 限制 | `input.cwd` 必须落在 `rootDir`（默认 `ctx.cwd`）内 | `SANDBOX_CWD` |
| env 隔离 | 按 6 条敏感名正则过滤（AWS / GitHub / OPENAI·ANTHROPIC·… / API_KEY·SECRET / PASSWORD / PRIVATE_KEY） | `DEFAULT_SENSITIVE_ENV`、`sanitizeEnv` |
| 命令白名单 | 只认**首命令名**或**完整片段**；`allowlist=['git']` 不会放过 `echo git && rm -rf /` | `SANDBOX_ALLOWLIST` |
| 宿主回退 + 二次确认 | 白名单外非破坏性命令 / 沙箱内非零退出 ⇒ 提升宿主 bash，**回退前再经权限引擎**（pattern 前缀 `host:`，ask 模式再问一次） | `fallbackToHost`、`requireHostApproval` |
| 只读哨兵 `bash_ro` | 白名单 + 结构门（重定向 / 进程替换 / heredoc / 命令替换 / 提权）+ AST 双门 | `createReadOnlyBashTool` |
| 文件工具路径边界 | `read_file` / `write_file` / `edit_file` 一律 `PATH_OUTSIDE_CWD` | `tools-builtin:144/287/1465` |
| 网络工具 SSRF | 拒非 http(s)、拒私有 IP / localhost；`permission.key='network'` | `tools-web/src/index.ts` |

### 1.2 权限层（`@harness/host`，三宿主共用一份）

- **三模式** `allow-all` / `ask` / `deny-all`；**四态**答复 `allow` / `deny` / `always-allow` /
  `always-deny`（`always-*` 写回 `permissions.json`）。
- **缺省 fail-closed**：宿主不给 `asker` ⇒ `InteractivePermissionEngine` 取不到答复即 **deny**。
- **风险分级**（M3）：`assessRisk(toolKey, patterns, input)` → `low|medium|high`，**只打标签不决策**。
- **段级 `denyPatterns`**：`bash` 用引号感知的 `splitSegments` 上报每一段，让 `deny: ['shutdown*']`
  能拦住 `echo hi; shutdown -h now` —— 且**刻意不进 `patterns`**（allow 是任一命中即放行，混进去会放宽）。
- **结构守卫** `guardInput`：越过管道直调 `tool.call()` 那条路径的兜底。
- **审计**：`decision.human` 零内容信封（标量 + `stateHash`）落 `{dataDir}/sessions/{id}.audit.jsonl`。

### 1.3 边界与身份层

- **工作区**：一个工作区 = 一个 `cwd` + 一个 `dataDir`；user 级 `~/.harness` × project 级
  `<cwd>/.harness`，**project 覆盖 user**（见 `workspace-management.md`）。
- **Agent 能力域**：`tools: ['*']` / `mcpServers` / `excludeMcpServers` —— 按 Agent 裁剪工具面。
- **A2A**：`Bearer` token（**未配 ⇒ 匿名放行，但此时只监听 `127.0.0.1`**）；`callerKey()` 把
  `contextId` **首次使用即绑定**给调用方，他人复用同 id ⇒ `ContextForbiddenError`
  （`contextId` 就是 `sessionId`，读同一份历史与工作目录）。
- **subagent**：每个子 Agent 一个独立 **git worktree**，从文件系统层隔离并行写操作。

### 1.4 补偿控制（"拦不住"之后的兜底）

快照（`GitSnapshotService`，每轮 capture + `meta.snapshot`）/ `/revert` / `/snapshot`；
审计；doom-loop 熔断（尾部连续 3 个完全相同签名）。

## 2. 分层目标形态（本方案的骨架）

现状是"一堆布尔开关"，目标是**四层可声明、可观测、可降级**的档位。

| 档 | 名字 | 内容 | 现状 |
|---|---|---|---|
| **L0** | **策略层** | 危险表 + AST 门 + 白名单 + 权限引擎 + 段级 deny + 审计 | ✅ 已有**且已可配置**（P0-1 已修） |
| **L1** | **进程层** | 资源上限（CPU / 内存 / 文件大小 / 进程数）、**超时杀进程树**、env **默认拒绝**（不是默认放行） | ✅ 三项已修（P0-6 / P1-1 / P0-2）；原生 `setrlimit` 档位仍缺 |
| **L2** | **文件系统 / 网络绑定** | 目录读/写**分域白名单**；用 OS 原语把可写区**真的**限制在声明目录内（macOS `sandbox-exec` / Linux `bwrap`）；网络策略 `deny` / `allowlist` / `open` | ✅ **全部已落**：网络策略（P1-2，L0 静态门）、档位可声明（P1-4）、**OS 级绑定**（P1-3，2026-10-12）—— `sandbox.osBinding: "on"` 才开（默认 off），自检通过后 `probeIsolation().maxLevel` 才报 `L2` |
| **L3** | **平台层** | 容器 / microVM / 远程 executor（A2A 远程场景的终态） | ❌ 未做（与 `external-integration-plan.md` §9 的"执行后端"合流） |

**四条设计纪律**（与既有仓库纪律同源）：

1. **能力探测**：`probeIsolation()` 与 `resolveShell()` 同范式 —— 探测本机有没有
   `sandbox-exec` / `bwrap` / `landlock`，结果进档位判定。
2. **不模拟**（跨平台那轮定的原则，这里同样适用）：**拿不到 OS 原语就显式降级并告警**，
   绝不"看起来隔离了"。降级必须落 notice + 审计。
3. **可声明**：`config.json → sandbox.{level,fs,net,limits}`；宿主可要求"**至少 L2**，
   达不到就拒绝启动"（而不是静默跑在 L0）。
4. **可观测**：`BashOutput.isolation = { level, fsBound, netPolicy, viaHost }`；审计信封加
   `isolationLevel`。模型与人都要知道"我现在跑在什么边界里"。

## 3. 待补清单

### 3.0 P0 —— **静默失效或安全漏判**（先做这批）

| # | 缺口 | 为什么是 P0（判据） | 位置 |
|---|---|---|---|
| P0-1 | ✅ **已修**（2026-10-11，见开发日志续 276）—— 原文：**沙箱策略从 `config.json` 根本设不到** | 组合根用**无参单例**注册：`load: async () => (…).toolsBuiltinPlugin`，而 `toolsBuiltinPlugin = createToolsBuiltinPlugin()`。于是 `allowlist` / `rootDir` / `dangerousDetection` / `sanitizeEnv` / `fallbackToHost` **一条都不可配**。用户"在 config 里写了白名单以为生效"是**静默失效**——比没写更危险。**落地形态**：`config.json → sandbox` 段（10 个键）+ `BuiltinGeneralPlugin.load(ctx?)` 接**加载上下文**（原来是无参），boot 把已解析的 config 递进去；`tools-builtin` 与 `tools-search` 两个登记项改走工厂重建（`createToolsBuiltinPlugin({bash, readDeny, readOnlyBash})`）。另加 `checkSandboxConfig()` 未生效项告警（`config.sandbox-inactive`，与压缩段同范式）⇒ **配错至少会有声音** | `host/src/config.ts`、`host/src/plugins.ts`、`host/src/notice.ts` |
| P0-2 | ✅ **已修**（2026-10-11，见开发日志续 276）—— 原文：**MCP 子进程全量继承 env（与 bash 的隔离不对称）** | `spawn(command, args, { env: { ...process.env, ...config.env } })` ⇒ 同一个 `GITHUB_TOKEN`，bash 里被摘掉、**第三方 MCP server 里照样读得到**。而 MCP server 恰恰是外部代码。**落地形态**：`buildMcpChildEnv()` —— 默认只透传**白名单**（`PATH` / `HOME` / `TMPDIR` / `LANG` / `TERM` + Windows 启动必需项，**不含任何凭据样式名**）+ 服务自己声明的 `env`；要额外透传用 `mcpServers[].envKeep`，真要不隔离用 `mcpServers[].inheritEnv: true`（显式） | `mcp-client/src/index.ts`（`buildMcpChildEnv` / `StdioTransport`） |
| P0-3 | ✅ **已修**（2026-10-11，见开发日志续 276）—— 原文：**读侧无隔离：cwd 内的密钥文件默认可读** | `isWithinCwd` 只保证"在 cwd 里"，于是 `cat .env` / `cat .harness/.config-key` / `cat ~/.harness/permissions.json`（若 cwd 覆盖）畅通。bash 的 env 过滤挡不住**从文件里再读一遍**。**落地形态**：清单落在零依赖的 `@harness/fs-guard`（`DEFAULT_SENSITIVE_READ_POLICY` + `isSensitiveReadPath`，五类规则：名 / 前缀 / 后缀 / 目录段 / 相对路径，**不用 glob**），三个读口共用：`read_file`（入参路径）、`grep_file`（入参路径 + **递归遍历逐文件跳** —— 只查入参挡不住"顺带读到"）、`bash_ro`（AST 参数里的路径字面量 —— `cat .env` 本来完全在只读白名单内）。⚠️ **例外优先**：`.env.example` / `.env.sample` / `.env.template`（模板）与 `*.pub`（公钥）**不挡** —— 否则模型连"该配哪些键"都看不到 | `packages/fs-guard/src/index.ts`、`tools-builtin`（`read_file` / `bash_ro`）、`tools-search`（`grep_file`） |
| P0-4 | ✅ **已修**（2026-10-11，见开发日志续 275）—— 原文：**路径边界只做字符串前缀，无 `realpath` 解析 ⇒ symlink 逃逸** | `isWithinCwd = !relative(cwd, p).startsWith('..')`，而 `resolvePath` 只用 `resolve`（不做符号链接解析）。cwd 内一条 `ln -s /etc secret` ⇒ `secret/passwd` 的 `relative` 是 `secret/passwd`，**判定通过**，`stat/open` 却跟随链接读到外部。对照：`skill` / `subagent` 已经用 `realpathSync` 兜底，**工具侧没有**。**落地形态**：边界判定改到**真实路径**上比 —— 两侧都过 `realpathBestEffort()`（路径不存在时**逐级上溯到最近存在的祖先**再拼回剩余段，因此"写一个还不存在的新文件"这条路径照常被判定）；`resolvePath` 仍保持**纯字符串**（不碰文件系统），由 `isWithinCwd` 单独做真值判定。每一个有强制路径的包都补了 symlink 逃逸回归（读侧 + 写侧） | `packages/fs-guard/src/index.ts` |
| P0-5 | ✅ **已修**（2026-10-11，见开发日志续 275） | `tools-builtin` / `tools-glob` / `tools-search` / `tools-media` / `code-intel` / `subagent` 各写一份。安全边界**修一处漏五处**，且语义已开始漂移（有的比 `resolve`、有的比真实路径）。**落地形态**：新建零依赖的 **`@harness/fs-guard`**（只引 `node:path` / `node:fs`），上述 6 包（`code-intel` 是 3 个文件）全改为引它；`@harness/tool` 放不下的原因是 `code-intel` 的 `core.ts` / `server.ts` **刻意不引 harness**（要能脱离 harness 单跑），而 fs-guard 零依赖叶子包正好两边都能引。另加**静态守卫**（扫 `packages` 下不得再有第二处 `function resolvePath/isWithinCwd` 定义） | `packages/fs-guard/`、6 包的 `package.json`、根 `tsconfig.json` paths |
| P0-6 | ✅ **已修**（2026-10-11，见开发日志续 276）—— 原文：**超时只杀直接子进程，不杀进程树**（沙箱视角） | `cross-platform-plan.md` P0-5 已从"跨平台"记过；从**隔离**角度更重：超时后沙箱内的 `npm run dev` 还在跑 ⇒ 隔离边界外仍在产生副作用（占端口、写文件、出网）。**落地形态**：`killProcessTree()` —— POSIX 下 spawn 带 `detached: true` 让子进程成为**新进程组组长**，`kill(-pid)` 一次覆盖全组；Windows 走 `taskkill /T /F`；都不可用才退回单进程 kill。三处调用点（timeout / signal 已 aborted / abort 监听）统一走它。⚠️ 与 P1-1 的耦合见日志：`ulimit` 抬头会让 `bash -c '<单命令>'` 失去 exec 优化（shell 不再被替换成目标进程）⇒ **没有进程组 kill 时连 `sleep` 都杀不掉**（孤儿子进程握住 stdout 管道、`close` 永不触发） | `tools-builtin/src/index.ts`（`runBash` / `killProcessTree`） |
| P0-7 | ✅ **已修**（2026-10-11，见开发日志续 277）—— 原文：**`fallbackToHost` 的档位下沉没有记录** | 一旦开启，命令从"沙箱约束"升到"宿主全权"（放开白名单 + 放开 env 隔离 + 补系统 `PATH`）。`requireHostApproval` 默认 true 是好的，但 **allow-all 模式下静默放行且不留痕**（`viaHost` 只在返回值里，审计不记）。**落地形态**：`PermissionRequest` 加 `escalation: 'host-fallback'`（**不靠** `patterns` 里的 `host:` 前缀 —— 那是展示约定，判据不许挂在文案上）；引擎**覆写 `check()`** 落 `sandbox.escalation` 审计（零内容 + `stateHash` + `behavior`/`outcome` 双记）——`ask()` 只在规则判为 ask 时走到，`allow-all` 与规则命中都不经过它，**只有 `check()` 是每个权限请求的唯一必经点**；`requireHostApproval:false` 那条"没有请求可记"的路径改由 `checkSandboxConfig()` 装配期点名 | `host/src/permission.ts`、`host/src/config.ts`、`tools-builtin` 的 `confirmHostRun` |
| P0-8 | ✅ **已修**（2026-10-11，见开发日志续 272）—— 原文：「始终允许」写回是整键覆盖 ⇒ 段级 `denyPatterns` 永久失效（§8 D1） | 提示里显示的是**具体命令**，写回却是 `rules[toolKey] = 'allow'`：①粒度=**整工具**（`ls` 与 `rm -rf` 同键同命）；②**整键覆盖**已有 PathRules（`deny: ['shutdown*']` 直接丢）；③规则退化为 **string** 后 `check()` 走 `typeof toolRule === 'string'` **直接 return**，`denyTargets` **整体不再参与** ⇒ `echo hi; shutdown -h now` 被放行。**测试盲区**：`permission-deny-patterns.test.ts` 只钉了"string 规则不受 denyPatterns 影响"这一形态，**没有覆盖"always-allow 把 PathRules 变成 string"这条写回路径**。⚠️ 修复时发现 ② 的可行形态与初稿不同：string 形态**没有自己的 deny 列表**，"过 denyTargets"只能落成**全局 deny 否决权**（详见 §8.6） | `host/src/permission.ts:283/300`、`core/src/index.ts:492` |
| P0-9 | ✅ **已修**（2026-10-11，见开发日志续 273）—— 原文：**授权不跟调用方走，但身份跟**（§8 D2）。修复见下条注 | 规则集落 `<dataDir>/permissions.json`（dataDir 缺省 `~/.harness`），而 A2A 与本地 TUI **在该工作区解析到同一份**。身份层做得很干净（`callerKey()` 首次使用即绑定 `contextId`，他人复用 ⇒ `ContextForbiddenError`），**权限层没有跟上**：`check()` 只读 `toolKey/patterns/denyPatterns`，`sessionId` 仅用于 asker 路由与审计归属，**不进规则匹配、也不进写回**。⇒ 本地点一次「始终允许」，同工作区的远程 A2A 调用方一并继承（反向亦成立）。控制面只听 `127.0.0.1` 是缓解、不是隔离。**本仓独有**（Codex / Claude Code 是单机单用户，不存在这个面）。**落地形态**：规则键加归属前缀 `session:<sid>\|<tool>` / `caller:<hash>\|<tool>`，`check()` 按 `session` → `caller` → 工具 → 全局逐层回退；写回带 `caller:<hash>` 键。⚠️ 两处与初稿不同：①**调用方主体必须哈希** —— A2A 的调用方标识就是 Bearer token，直接写进规则键等于把凭据落盘（`callerScopeKey`）；②归属**不是给 `PermissionRequest` 加字段**，而是 core 的 `resolvePrincipalKey()` 覆写钩子 —— 只有宿主有鉴权上下文，加字段会让 core 认识 A2A 的鉴权模型 | `host/src/host.ts:361`、`workspace/src/index.ts:134`、`a2a-server/src/auth.ts:42/63` |

### 3.1 P1 —— **能力缺口**

| # | 缺口 | 说明 | 位置 |
|---|---|---|---|
| P1-1 | ✅ **已修**（2026-10-11，见开发日志续 276）—— 原文：**无资源上限** | 没有 CPU / 内存 / 文件大小 / 进程数限制。一条 `yes > /dev/null`、一次 `npm install` 打满内存即可拖垮宿主。**落地形态**：`BashSandboxConfig.limits`（`cpuSeconds` / `maxFileSizeKb` / `maxProcesses` / `memoryKb`，**0 = 不限制**、`false` = 全关）+ `buildLimitPreamble()` 在 bash 族系前置 `ulimit` 抬头（**非 bash 族系不模拟**；宿主回退路径不套，与放开白名单 / env 隔离同口径）。⚠️ 两个实测坑：①`ulimit -f` **单位不统一**（macOS 1 单位 = 1024B、Linux/POSIX = 512B 块）⇒ 按平台换算；②`ulimit -v` 在 macOS **直接 EINVAL** ⇒ 必须**逐项各起一次 `ulimit`**（合并形态会被失败项连累且 `2>/dev/null` 吞掉）。默认**只开单文件 2 GiB**，其余按需（`-u` 在 macOS 按用户计、压小会让正常构建 fork 失败） | `tools-builtin/src/index.ts`（`buildLimitPreamble` / `resolveBashLimits`）、`host/src/config.ts`（`sandbox.limits`） |
| P1-2 | ✅ **已修**（2026-10-11，见开发日志续 277）—— 原文：**无网络出口策略** | `tools-web` 有 SSRF 防护，但 **`bash` 里的 `curl` / `wget` 出网完全不受限**（含访问云元数据端点 `169.254.169.254`）。**落地形态**：`sandbox.net = open \| allowlist \| deny` + `netAllow`（默认 `open` = 逐位等于改造前）；判定用 AST 的命令名与参数字面量，拿不到时退文本兜底（与危险检测同一条降级纪律）；`allowlist` 下**父域覆盖子域但不做裸后缀匹配**、**提不出目标一律 fail-closed**、**元数据/私有地址硬拒**（写进白名单也不放行）。⚠️ 这是 **L0 静态门**不是内核边界：`deny` 表**刻意不含** `git`（本地/远端双用途）与包管理器/解释器（目标写在配置里、静态提不出来，列进去只会造成"以为挡住了"）。`tools-web` 的 `isPrivateIp` 一并收敛到 `@harness/isolation` 的 `isPrivateHost` | `packages/isolation`、`tools-builtin`、`tools-web` |
| P1-3 | ✅ **已修**（2026-10-12，见开发日志续 279）—— 原文：**无 OS 级只读绑定** | 没有把工作目录"真的"绑定成唯一可写区（macOS `sandbox-exec` profile / Linux `bwrap --ro-bind /` + `--bind cwd`）。L0 的策略一旦被绕过（P0-4 就是例子），没有第二道墙。**落地形态**：`@harness/isolation` 新增 `buildOsBinding()`（纯函数：darwin 出 `sandbox-exec -p <SBPL>` 的 **argv 前缀**、linux 出 `bwrap --ro-bind / / --bind <w> … --die-with-parent`、win32 / 无原语 ⇒ `null`）+ `renderSandboxProfile()`（**只收紧写**：可写区与 `/dev/null`·`/dev/zero`·`/dev/tty`·`/dev/fd` 例外 → `deny file-write*` → `allow default`；**顺序即语义**）+ `verifyOsBinding()`（**自检**：真跑一次「原语 + shell + echo 哨兵」）+ `detectOsBindingFailure()`（执行期识别"内核拒了 apply"）。`tools-builtin` 的 `runBash` 把 prefix 拼在被包装命令**之前**（不拼字符串），`BashOutput.isolation.fsBound` 改由**这次真绑上了没有**决定（不再由档位推导）；`bash_ro` 同样套（只读判定挡不住 symlink 逃逸写）。配置 `sandbox.osBinding: "off"（默认）/ "on"`；拿不到原语 / 自检失败 ⇒ notice `sandbox.binding-unavailable` 且**不模拟**。★**实测**：`sandbox-exec` profile 挡住了 cwd 外写**与 symlink 逃逸写**（P0-4 的 TOCTOU 只有这一层挡得住）；而**profile 语法出错时 `sandbox-exec` exit 0 且不执行任何命令** ⇒ 自检不是可选项。★平台限制：本机 `bun test` / `bun run` 派生的进程落在宿主沙箱内，**嵌套 apply 被拒**（`sandbox_apply: Operation not permitted`，exit 71）⇒ 由 `detectOsBindingFailure` 识别并如实报 `fsBound:false` + `fsBoundFailed:true` | `packages/isolation/src/index.ts`、`tools-builtin`（`runBash` / `createBashTool` / `createReadOnlyBashTool`）、`host/src/{host,config,plugins}.ts` |
| P1-4 | ✅ **已修**（2026-10-11，见开发日志续 277）—— 原文：**无"隔离档位"概念** | 现在是"策略全开 / 全关"的布尔，宿主无法表达"我要 L2，没有就拒绝启动"。**落地形态**：`IsolationLevel = L0\|L1\|L2\|L3` + `probeIsolation()`（P3-2）+ `resolveIsolation()`；`config.json → sandbox.{level,onUnmet}` —— 达不到要求时 `warn`（notice `sandbox.isolation-degraded`，说清实际档位与缺口）或 `refuse`（`ConfigValidationError` 拒绝启动）；解析发生在**内置插件装配之前**；`BashOutput.isolation = { level, fsBound, netPolicy, viaHost }` 把**解析后的实际档位**（不是愿望值）回给模型与取证脚本 | `packages/isolation`、`host/src/{host,config,notice,plugins}.ts`、`tools-builtin` |
| P1-5 | ✅ **已修**（2026-10-12，见开发日志续 279/280）—— 原文：**插件代码开闸即进程内全权** | 落地三件（三件都**只说自己能做到的**）：① **装配期静态扫描**（`host/src/plugin-scan.ts`：六类规则 + 注释行跳过 + 带行号；`sandbox.pluginCodeScan: warn（默认）/ refuse / off`；notice `plugins.code-scan` / `plugins.code-refused`）；② **装载后端**（`sandbox.pluginRunner: in-process（默认）/ worker`，`plugin-runner.ts`）：worker 给的是**资源与故障边界**（实测：`resourceLimits` 真拦住内存炸弹、加载期死循环不阻塞主线程、加载崩溃不拖垮宿主），且**只登记不装载**（跨线程拿不到 hooks ⇒ 硬接会得到"看起来装了实际没生效"的插件）；失败**不回退 in-process**（要收窄却拿到最宽的那条路是最坏降级）；③ **能力面收窄**（`plugin-context.ts`，`sandbox.pluginCapabilities` 按 id / `"*"` 声明 `ctx` 的 `bus`/`config`/`log`/`workspace`；未声明的通道**取用即抛**并给可执行指引）。⚠️ **两条都不是安全边界**（实测：worker 内 `env`/`pid`/`fs` 与宿主一致；插件仍能 `import("node:fs")`）—— 真边界是 WASI（默认零能力，见 §7.6），或"后端内装载"（L3-c，见 `docs/execution-backend-design.md` §6.3） | `host/src/plugin-scan.ts` / `plugin-runner.ts` / `plugin-worker-protocol.ts` / `plugin-worker-entry.ts` / `plugin-context.ts`、`host/src/{plugins,config,notice,index}.ts` |
| P1-6 | ✅ **已修**（2026-10-11，见开发日志续 278）—— 原文：**swarm 的 `sandbox_permission_*` 是死协议** | 类型联合、`isStructuredProtocolMessage` 白名单、inbox 消费分支**都在**，但**没有任何生产者** ⇒ 多 Agent 场景下"子 Agent 越界申请授权"这条路其实不存在。**落地形态**：**删**死类型（两个 `sandbox_permission_*` 从 `MailboxMessageType` 与 `STRUCTURED_PROTOCOL_TYPES` 移除，inbox 分支只收 `permission_response`），沙箱档位下沉改走**既有** `permission_request` 通道 + `data.escalation: 'host-fallback'` —— 与 host 侧 `PermissionRequest.escalation` 和审计 `sandbox.escalation` **同一词汇表**（一个概念两套名字就是下一次对不上的起点）。`requestSwarmPermission({escalation})` 透传。★为什么是删而不是"接生产者"：那条通道要表达的事**已经在 `permission_request` 里表达完了**（"请批准这次执行"），单列类型只是多一条永远等不到响应的路 —— 留着它会让"越界申请授权"看起来是通的 | `swarm/src/index.ts`（类型 / `createPermissionRequest` / `processMailboxPermissionResponse` / `requestSwarmPermission`） |
| P1-7 | ⚠️ **部分已修**（2026-10-12，见续 279）—— 原文：**MCP server 无能力声明** | `mcpServers` 只有名单，没有约束。**落地形态**：`mcpServers[].capabilities = { fs?: "cwd" / "unrestricted", net?: "none" / "unrestricted" }` + 纯函数 `resolveMcpCapabilities()`（**声明 ≠ 强制**：`fs:"cwd"` 只在有 OS 绑定时才 `bound=true`；`net:"none"` **任何档位都强制不了**）；可强制的那半**真强制** —— `mcp-client` 的 `mcpSpawnArgv()` 把 stdio 子进程套进**同一份** OS 绑定（P1-3 的产物复用）；强制不了的项在装配期发 notice `config.mcp-inactive`（`checkMcpCapabilities`）。**仍未做**：非 stdio（http/sse）server 的约束、`net:"none"` 的真断网（要 L3） | `mcp-server-registry`（`McpServerCapabilities` / `resolveMcpCapabilities`）、`mcp-client`（`mcpSpawnArgv` / `TransportFactoryContext.osBinding`）、`host/src/{config,plugins,host}.ts` |
| P1-8 | ✅ **已修**（2026-10-11，见开发日志续 277）—— 原文：**`read_file` 无大小 / 类型闸** | 读 2GB 日志、读块设备、读 `/dev/zero` 无任何提示。**落地形态**：`read_file` 是**整文件载入后**才切片（`offset`/`limit` 救不了），故加 `maxReadBytes`（默认 10 MiB；`sandbox.readMaxBytes` 可调，`0` = 不限制），超限**拒绝**而不是"截断读"，消息里给出人读的大小与替代路径（`grep_file` / bash 按行段读）；类型消息说清"实际是什么"（目录/块设备/字符设备/FIFO/套接字）并指出该换的工具 | `tools-builtin` 的 `createReadFileTool` |
| P1-9 | ✅ **已修**（2026-10-11，见开发日志续 273）—— 原文：**手改规则无审计**（§8 D5） | 两条"直接改规则并写盘"的路径**都不发事件**：CLI `/permission <key>=<behavior>` / `reset` 与 A2A 控制面 `harness/permission.set`（含 `reset` / `mode` / `rules` / `key+behavior` 四形态）。审计原**只有 `decision.human` 一种 kind** ⇒ "权限是被谁、何时、从 allow 改成 deny 的"不可回溯。**落地形态**：新增 `kind: 'permission.rule.changed'`（零内容 + `stateHash` + `source: cli\|control-api\|asker`），接在 **`HarnessHost.setPermissionRules()` 这一个入口**上（两条手工路径都只调它 ⇒ 一次覆盖）；`always-*` 的自动写回走引擎侧 `rememberRule`，同一 kind。⚠️ 顺带改了 `createAuditSink` 的丢弃语义：控制面规则变更是**进程级**事件、无会话归属，原先"无 `sessionId` 即丢弃"会让它静默消失 ⇒ 改为落工作区级 `{dataDir}/audit.jsonl` | `host/src/host.ts`（`setPermissionRules`）、`host/src/permission.ts`、`host/src/audit.ts` |

### 3.2 P2 —— **体验一致性**

| # | 缺口 | 说明 |
|---|---|---|
| P2-1 | ✅ **已修**（2026-10-11，见开发日志续 278）—— 原文：**档位不可见**。`env-context` 已经在注入 `Shell:`，应并排注入 `Isolation:`（L0/L1/L2 + fs/net 策略）。模型不知道自己的边界，就会反复撞同一面墙。**落地形态**：`renderIsolationLine()` 渲染 `- 隔离: L1（进程层）｜可写区仅策略判定（非 OS 级）｜出网 deny`；宿主经 `load(ctx)` 把**解析后的实际档位**递进去（`toIsolationSummary`，`fsBound` 由 `isOsBound()` 换算、`netPolicy` 走同一份 `resolveNetPolicy`）—— 与 `BashOutput.isolation` 是同一份事实。**无加载上下文 ⇒ 整行省略**（宁缺毋滥，不猜档位）。⚠️「未做 OS 绑定」刻意写成完整一句而不是省略：省略它等于让模型以为写界外会被 OS 挡住。env-context **不 import** `@harness/isolation`（只用三个字段，结构类型即可 —— 引包会让它背上对"档位语义"的编译期依赖） | `env-context/src/index.ts`、`host/src/plugins.ts` |
| P2-2 | ✅ **已修**（2026-10-11，见开发日志续 278）—— 原文：**拒绝文案要可执行**。延续既有纪律（`bash_ro` 的结构门带 `why`）：每条隔离拒绝都给「为什么 + 怎么改」。历史教训：文案指向给不出所需信息的工具 ⇒ 模型空转。**落地形态**：`@harness/isolation` 新增 `formatDenial({what, why, how})` 与 `DENIAL_HOW_PREFIX = '怎么改'`（**前缀是常量，因为它是可自动判的验收口径**）；`tools-builtin` / `tools-search` 全部隔离拒绝改走它（危险命令 / 网络 / cwd / 白名单 / 宿主回退 / 敏感读 / 大小闸 / 只读 / 越界），`assessNetAccess` 的 `reason` 拆出 `why` + `how` 两字段（`reason` 仍是拼好的完整文案，向后兼容）。守卫：`denial-copy.test.ts` 逐条触发十类拒绝，断言消息含「怎么改」且**后面真有内容**（空头衔比没有更糟）；只读的十余条 reason 共用一份 `READ_ONLY_HOW`（"接下来该怎么办"对它们全一样，分开写只会各自漂移） | `packages/isolation`、`tools-builtin/src/{index,denial-copy.test}.ts`、`tools-search` |
| P2-3 | ✅ **已修**（2026-10-11，见续 277） | `{ level, fsBound, netPolicy, viaHost }`，让模型（与取证脚本）知道这次执行的边界。随 P1-4 一并落地 |
| P2-4 | ✅ **已修**（2026-10-11，见开发日志续 278）—— 原文：**文档口径**。README / `AGENTS.md` 要写清「**当前隔离是策略级，不是 OS 级**」，并说明什么场景必须上 L2/L3。**落地形态**：README 顶层字段表加 `sandbox` 行 + 新增 `### sandbox 对象（隔离策略）` 小节（13 个键逐项说明 + 开头一段**警示块**：文件系统边界是路径判定 + 白名单 + env 过滤，**不是** OS 绑定；出网是静态门不是内核边界；要"跑什么也伤不到宿主"必须 L2/L3，而这两档**尚未接线**，写了也不生效）；`AGENTS.md` 的 bash 沙箱条目补同一口径并指向本计划 | `README.md`、`AGENTS.md` |
| P2-5 | ✅ **已修**（2026-10-11，见开发日志续 274）—— 原文：**风险标签失去区分度**（§8 D4） | `assessRisk` 的 `HIGH_RISK_TOOL_KEYS` 含 `bash` ⇒ **bash 恒为 `high`**，`ls` / `pwd` / `echo` 与 `rm -rf` 同一个标签；高危模式表（`rm -rf` / `sudo` / `dd if=` …）因此**只在工具键不在表里时**才有机会生效。标签不决策、但它是决策卡片的唯一提示。**落地形态**：`bash` 移出工具键表，按 `SHELL_TOOL_KEYS` **分流**先走 `assessShellRisk(command)`（高危模式 → 写入/替换元字符 → **每段**首词在只读白名单且无 `-exec`/`-delete` → 否则 medium；**拿不到命令文本 ⇒ high**，与改造前逐位一致），其余工具才走"入参高危模式 > 工具键表 > medium"；`bash_ro` 直接落 low；`ls 2>/dev/null` 复用 §九 的 `NULL_SINK_REDIRECT`（含负向前瞻）仍是 low。⚠️ **附带发现（本轮未修）**：判据 `toolKey` 实际是**权限键**（`read` / `write` / `bash` / `bash_ro`），而 `HIGH_RISK_TOOL_KEYS` 里写的是**工具 id**（`write_file` / `edit_file`）⇒ **`write` 落 medium**（写操作标中危）。⚠️ 该附带发现已于 2026-10-11 **收口**（见续 275，承 P2-7 那轮）：两张表的键改成**权限键**（`HIGH = write / edit`、`LOW = read / bash_ro`），`SHELL_PERMISSION_KEYS` 与两张表均**不再有工具 id**；并在 `permission.test.ts` 加了两条钉住"id 不是键 ⇒ medium"的用例（写侧 + 读侧各一条），`cli.test.ts` 的 `riskLevel` 断言由 `medium` 改为 `high` | `host/src/permission.ts`（`assessRisk` / `assessShellRisk`） |
| P2-6 | ✅ **已修**（2026-10-11，见开发日志续 274）—— 原文：**提示文案键位自相矛盾**（§8 D6） | `buildPermissionPrompt().text` 写 `allow / deny / always(a) / deny-always(d)? [a/d/A/D]` —— 前半说 `always` 是 `a`，方括号里 `a` 却是 allow、`A` 才是 always。而实际实现正是 `'A' → always-allow`、`'a' → allow`（`parseCliAnswer`）。照前面读会**把"始终允许"按成"允许一次"**（或反之）。**落地形态**：文案改成**只有一种形态 `状态(键)`** —— `allow(a) / deny(d) / always-allow(A) / always-deny(D)?`，与 `PermissionAnswer` 四态**同一词汇表**（顺带把 `deny-always` 正名为类型里的 `always-deny`）；并在 `cli.test.ts` 加守卫，从文案抓 `词(键)` 对、断言 `parseCliAnswer(键) === 词`（改文案或改解析器任一边都会红） | `host/src/permission.ts`（`buildPermissionPrompt`）、`cli/src/index.ts:397`（`parseCliAnswer`） |
| P2-7 | ✅ **已修**（2026-10-11，见开发日志续 275）—— 原文：**`mode` 是进程级，"会话级切换"不存在**（§8 D7） | `InteractivePermissionEngine.mode` 是实例字段，一个进程内**所有会话共享**；`setMode()` 注释也写明"不影响持久化规则"。CLI 的 `/permission <mode>` 文案容易被读成"只对当前会话生效"。**落地形态**：真做成**会话级**（不选"只改文案"）—— 引擎加 `sessionModes: Map<sessionId, PermissionMode>`，`getMode(sessionId?)` 会话覆盖优先、回退进程默认，`ask()` 按 `req.sessionId` 取；CLI `/permission <mode>` **默认只改本会话**，全进程用显式 `global` 后缀（能力没丢，只是不再由一个会话静默改掉别的会话）；A2A 控制面 `harness/permission.get|set` 加**可选 `sessionId`**（不给 ⇒ 进程默认，老调用行为逐位不变）。与 `mode` 同口径：内存态、不落盘、重启复位 | `host/src/permission.ts`（`getMode` / `setMode` / `ask`）、`cli/src/index.ts`、`a2a-server/src/control.ts` |

### 3.3 P3 —— **工程与防回归**

| # | 缺口 | 说明 |
|---|---|---|
| P3-1 | ✅ **已修**（2026-10-11，见开发日志续 275） | 把 `resolvePath` / `isWithinCwd`（**realpath 版**）收敛进新包 **`@harness/fs-guard`**，一处实现 + **静态守卫测试双向钉住**：① 行为侧 —— `fs-guard` 自带 symlink 逃逸 / 不存在目标 / macOS `/var` 两侧真实路径用例；② 结构侧 —— 一条扫 `packages` 源码的守卫，**别处再抄一份 `function resolvePath/isWithinCwd` 就变红**（反向验证实测：塞回一份副本 ⇒ 该守卫 1 红并精确点名文件）。收敛后 `..foo` 这类目录名不再被 `startsWith('..')` 误杀（改成只认整段 `..`） | `packages/fs-guard/src/index.ts` + `src/index.test.ts` |
| P3-2 | ✅ **已修**（2026-10-11，见开发日志续 277） | `probeIsolation({ platform, exists, osBinding })` —— 与 `resolveShell()` 同范式：**依赖全可注入**，darwin / linux / win32 行为都能纯函数单测，不需要真机。★**探到原语 ≠ 达到那一档**：有 `sandbox-exec` / `bwrap` 而没接线（P1-3）时 `maxLevel` 仍报 `'L1'` 并把"未接线"写进 reasons（§2 纪律 2「不模拟」的落点） | `packages/isolation/src/index.ts` |
| P3-3 | ✅ **已修**（2026-10-12，见续 279）—— 原文：**三平台 CI** | 与 `cross-platform-plan.md` P1-5 同一条：没有矩阵，任何隔离修复都会在下次改动里静默回归。**落地形态**：`.github/workflows/ci.yml`（`ubuntu` / `macos` / `windows` 矩阵，`bun install --frozen-lockfile` → `bun run typecheck` → `scripts/ci/test-summary.sh`）+ `scripts/ci/test-summary.sh`（**只读 bun 的汇总行**，记录 `pass / fail / skip` 并写 step summary；两条阈值：`pass ≥ 2000`（防"整包没跑起来"）、`skip ≤ 200`（防"某一片被整体跳掉"）；Windows 只放行**失败**—— pass 阈值与 skip 超额**照样拦**，那两条说的不是平台差异） |
| P3-4 | ✅ **已修**（2026-10-11，见开发日志续 278）—— 原文：**渗透用例集**。symlink 逃逸 / env 泄漏 / 内网探测 / fork bomb / 磁盘写满 / 进程树残留 —— 作为回归门，每条都能自动判。**落地形态**：`tools-builtin/src/penetration.test.ts` 十条（① symlink 读侧 ② symlink 写侧 ③ bash env 泄漏 ④ `bash_ro` 的 `input.env` 后门 ⑤ 云元数据端点在 `deny` 与 `allowlist`（**写进白名单也不放行**）下都拒 ⑥ 敏感读 ⑦ 大小闸 ⑧ 单文件配额**装到工具上**仍生效 ⑨ 超时后孙进程不残留 ⑩ `BashOutput.isolation` 自述实际档位）。★两条纪律：①**不真做破坏性操作**（不 fork bomb、不写满真实磁盘、不出网）—— 用「极小配额 + 极小超时」让同一条路径在受控条件下暴露；②**跨包条目在文件头登记落点**（MCP env 泄漏在 `mcp-client`、判定函数层在 `fs-guard`、网络目标在 `isolation`），本文件只覆盖**工具执行层** —— 策略写在代码里 ≠ 装到工具上（P0-1 的教训） | `tools-builtin/src/penetration.test.ts` |

## 4. 建议实施顺序

1. ~~**P0-1 可配置**（`sandbox` 段进 config + 组合根透传）~~ ✅ **已完成**（2026-10-11，见续 276）：
   `sandbox` 段（10 键）+ `load(ctx)` 加载上下文 + `checkSandboxConfig()` 未生效项告警。
2. ~~**P0-4 + P0-5 + P3-1 一起做**：把路径边界收敛成一份 **`realpath` 版**实现，替换 6 处副本。~~
   ✅ **已完成**（2026-10-11，见开发日志续 275）：新建 `@harness/fs-guard`，7 个文件（6 包）全改为引它，
   一次改完、一次测完；每个有强制路径的包各补了 symlink 逃逸回归（读侧 + 写侧），并加了"别处不得再有一份"的静态守卫。
3. ~~**P0-2 + P0-3**：env 白名单化（默认拒绝）覆盖 MCP 子进程；读侧对 `.env` / `.config-key` /
   `permissions.json` 这类**已知敏感名**加默认拒绝。~~ ✅ **已完成**（2026-10-11，见续 276）：
   MCP 走 `buildMcpChildEnv()` 白名单（`envKeep` / `inheritEnv` 两个**显式**出口）；读侧清单落在
   `@harness/fs-guard`，`read_file` / `grep_file` / `bash_ro` 三个读口共用（放行方式是 `sandbox.readDeny`）。
4. ~~**P0-6 + P1-1**：进程组 / 进程树 kill + `ulimit` 资源上限~~ ✅ **已完成**（2026-10-11，见续 276）：
   `killProcessTree()`（POSIX 进程组 / Windows `taskkill`）+ `buildLimitPreamble()`；两条 e2e 用例
   **真起进程**验证（后台孙进程超时后不存活 / AbortSignal 同样杀整棵树）。
5. ~~**P0-8 / P0-9 / P1-9（授权域收敛）**~~ ✅ **全部完成**（2026-10-11；P0-8 见续 272，P0-9 + P1-9 见续 273）。
   三件事共用同一处改动，一次做完了：① `rememberRule` 改 **PathRules 增量写回**；② `check()` 加
   **deny 否决权**（全局，P0-9 起推广到**任一层通配**）；③ 规则**按归属分层**
   （`session:<sid>` → `caller:<hash>` → 工具 → 全局，`check()` 逐层回退，写回带归属键）；
   ④ `kind: 'permission.rule.changed'`（零内容 + `stateHash` + 来源 `cli|control-api|asker`）。
   **反向验证已做**：四处变异（写回键去归属 / 去分层 / 去控制面审计 / 去 A2A resolver）各自
   变红并按要求还原；"远程 caller 不继承本地 always-allow"已有正反两条用例。
6. **P1-4 档位结构** ✅ **已完成**（2026-10-11，见续 277）：`probeIsolation()`（P3-2）+ 档位语义
   + `config.json → sandbox.{level,onUnmet}` + notice/拒绝启动 + `BashOutput.isolation`。
   ~~P1-3 OS 绑定仍待做~~ ✅ **已完成**（2026-10-12，见续 279）：`buildOsBinding` / `renderSandboxProfile` /
   `verifyOsBinding` / `detectOsBindingFailure` + `sandbox.osBinding` 开关 + 执行层接线。
   按 §2 纪律 2：**拿不到原语 / 自检失败 / 内核拒 apply 三种形态都显式降级告警**，绝不"看起来隔离了"。
6.1 ~~**P2 批次 + P1-6 + P3-4**~~ ✅ **已完成**（2026-10-11，见续 278）：P2-1 档位可见（env-context 注入
   「隔离」行）/ P2-2 拒绝文案可执行（`formatDenial` + 守卫）/ P2-4 文档口径（README + AGENTS.md
   写明策略级非 OS 级）；P1-6 死协议删除（档位下沉并入 `permission_request` + `data.escalation`）；
   P3-4 渗透用例集十条。**P2 至此清空**（P2-5/6/7 见续 274/275，P2-3 随 P1-4 落地）。
7. ~~**P1-2 网络策略**~~ ✅ **已完成**（2026-10-11，见续 277）：`sandbox.net` 三态 + `netAllow`，
   与 `tools-web` 的私有地址判定收敛到 `@harness/isolation` 一份。
7.2 ~~**P1-5 另一半 + L3 设计稿**~~ ✅ **本轮完成**（2026-10-12，见续 280）：P1-5 的装载后端
   （worker = 资源/故障边界）+ 能力面收窄；L3 只出设计稿（`docs/execution-backend-design.md`）。
   **P1 至此清空**（P1-5 的"真边界"转为 L3 的下游项）。
7.1 ~~**P1-3 + P1-7 + P1-5 + P3-3**~~ ✅ **已完成**（2026-10-12，见续 279）：
   P1-3 的 OS 绑定（L2 真落地）；P1-7 的 MCP 能力声明（可强制的半真强制）；P1-5 的插件代码静态扫描
   （**预警不是边界**）；P3-3 的三平台 CI 矩阵（含"跳过条数"口径）。
   **P0 / P2 / P3 已清空**（见续 276~279）；**P1 见 7.2（本轮清空）**。
8. **剩余（全部依赖 L3）**：① L3 本身 —— **设计稿已出**：`docs/execution-backend-design.md`
   （执行后端抽象：接口 / 探测自检 / 与 `osBinding` 和 `fallbackToHost` 的关系 / 8 个挂点 / 验收口径 / 五期分期，
   并给出**先做 L3-a（探测 + 声明 + 可观测，零运行时依赖）**的建议）；
   ② P1-7 的非 stdio（http/sse）server 约束与 `net:"none"` 的真断网（设计稿 §6.2 已定挂点）；
   ③ P1-5 的"真边界"（WASI 或 `runner:'backend'`，设计稿 §6.3）；
   ④ P1-3 的纵深：`srt`（Anthropic sandbox-runtime）作为 L2 的**跨平台扁平化**选项（§7.5）。

> **与 L2 的排期分叉**：第 5 步（授权域）与第 6 步（L2 OS 绑定）**互不阻塞**，但有先后意义 ——
> 第 2 步的 P0-4/P0-5 **已于 2026-10-11 完成**（realpath 版 + 全仓唯一一份，见续 275），
> 所以"先做哪个"这个分叉**已经不存在**：字符串判定守不住 symlink 这件事已被实证并修掉，
> 它现在是**纵深防御**那一层；L2（OS 级只读绑定）**已于 2026-10-12 落地**（P1-3，`sandbox.osBinding`）——
> TOCTOU（检查与打开之间换链接）只有 OS 那一层挡得住，现在那层有了（实测：symlink 逃逸写被内核拒）。

## 5. 验收口径（每一条都要能自动判）

- **纯函数层**：注入 `{ platform, shellFamily, exists }` 断言判定结果与档位（`resolveShell` 的用例即此范式），
  **不需要真机**。
- **行为层**：跨平台可用的断言（`exitCode` / 文件是否被创建 / 目标文件是否可读），避免 `seq` 之类 POSIX 命令。
- **渗透层**：每条 P0/P1 都要有**反向验证** —— 把修复注释掉，确认**指定条数**变红（本仓既有纪律，
  见 `AGENTS.md` §4 的验证协议）。symlink 逃逸与 env 泄漏两条尤其必须有真机用例。
- **降级可见**：任何"拿不到 OS 原语 ⇒ 降一档"的路径，都要断言**产生了 notice / 审计条目**，
  防止静默降级（这是本方案最容易悄悄退化成"看起来隔离了"的地方）。

## 6. 与其它计划的关系

- **平台差异**（Windows 的 shell / 路径 / 进程树）见 [`cross-platform-plan.md`](cross-platform-plan.md)
  —— 两份计划的 **P0 有交集**：它的 P0-5（超时不杀进程树）、P0-6（UNC 路径）在本方案里同时是
  P0-6 与 P0-4 的形态之一，**修的时候一次改到位**，别各修一半。
- **宿主装配**（`@harness/host` 一份、`HostOptions` 契约）见 [`host-extraction-design.md`](host-extraction-design.md)；
  本方案的 `sandbox` 配置与档位约束都进 `HostOptions`。
- **执行后端替换 / 远程执行**（Codex / Claude Code / 远程 runner）见
  [`external-integration-plan.md`](external-integration-plan.md) §9 —— 那是本方案 **L3** 的落点。
- **权限语义**（四态答复 / 规则写回 / 审计信封）见 `host/src/permission.ts` 与 `host/src/audit.ts`；
  本方案只**新增**档位与执行边界，**不改**权限语义（"决策权归人工"这条不动）。
  §8 提出的 D1/D2 是**缺陷修复**（写回粒度 / 授权作用域），不是语义变更 —— 四态答复、
  规则写回、零内容审计信封的形状都保持；改的只是"**记住什么范围**"与"**记住给谁**"。
- **多 Agent 隔离**（subagent worktree / swarm）见 `agent-harness-architecture.md` §九；
  P1-6 是那里留下的一个空壳。

## 7. 业界方案对照（光谱 · 共识 · 采纳建议）

> 本节是调研附录，用来把 §2 的 L0–L3 **锚定到业界坐标**上：我们现在在哪一格、每一格
> 别人是怎么做的、哪一格可以直接抄。**不引入新待办**（待办仍以 §3 的 P0/P1/P2/P3 为准）。

### 7.1 一条主线：边界由谁强制

不是"用哪个工具"，而是"**谁不让做**"——是应用自己拦 API，还是内核/硬件不让做。

| 层 | 边界由谁守 | 代表方案 | 谁在真用 | 越狱成本 |
|---|---|---|---|---|
| 进程内 | 应用自己（拦 API） | Node `vm`、`vm2`✝、`isolated-vm`、QuickJS-Wasm、Deno `--allow-*` | 插件 / 表达式求值 | 极低（vm2 已因无法修补的逃逸**停止维护**） |
| WASM | 运行时 + 能力句柄 | Wasmtime、Wasmer、wasmCloud、Wassette、Pyodide | Envoy 插件、多租户插件、微软 Wassette（跑 MCP） | 中（线性内存 + 无 ambient authority） |
| OS 原语 | 内核 | macOS Seatbelt、Linux bubblewrap / Landlock+seccomp、Win AppContainer+WFP | **Anthropic `srt`**、**OpenAI Codex CLI** | 中高（要内核漏洞） |
| 容器 / 强化容器 | 命名空间+cgroup（共享内核）→ gVisor/Kata 才破共享 | Docker·Podman 加固、Sysbox、gVisor(`runsc`)、Kata Containers | Modal、GKE、企业多租户 | 高 |
| MicroVM | 硬件虚拟化 | Firecracker、Cloud Hypervisor、microsandbox | E2B、Vercel Sandbox、Fly、GKE Agent Sandbox | 极高 |

对应到本文：**今天我们全部落在第 1 格的最弱形态**（甚至不是"拦截 API"，而是"写完命令后检查字符串"），
§2 的 L2 才是往第 3 格走，L3 是第 4/5 格。

### 7.2 冷启动量级（差三到四个数量级，这是选型的核心权衡）

| 方案 | 冷启动（量级） | 每实例内存 |
|---|---|---|
| WASM（Wasmtime AOT） | ~0.04 ms | 1–5 MB |
| V8 isolate（Cloudflare Workers / Dynamic Workers） | ~1.5 ms | 3–10 MB |
| 容器（gVisor） | ~50 ms | 20–50 MB |
| 容器（`runc`） | ~100 ms | 30–100 MB |
| microVM（Firecracker） | ~125 ms | 5–20 MB |
| 云沙箱（预热池：Daytona 90ms / E2B ~150ms） | 90–150 ms | — |

数字来源见 §7.6 各实现文档；此处只需记住**量级**。

### 7.3 三条可直接采纳的业界共识

1. **默认拒绝**，三个面同构：网络 `allow-only` 域名表 + **宿主侧 HTTP/SOCKS 代理**（沙箱内进程
   根本没有网络命名空间）；写 `allow-only` 路径表；读 `deny-then-allow`。加固容器侧对应
   `--cap-drop ALL --security-opt no-new-privileges --read-only --network none --pids-limit`
   + 只挂一个 Unix socket 走代理。**这正是我们 §2-L2 的目标口径**。
2. **违规要"可读"**：`srt` 把拦截事件转成**结构化 JSON 反馈**交给 agent，让它自己改道，而不是
   静默杀进程。与我们既有的 P2-2（拒绝文案必须可执行）是同一纪律；落地时它同时喂
   `BashOutput.isolation`（P2-3）与审计信封。
3. **不自研隔离原语**：各平台一律用系统自带（Seatbelt / bubblewrap·Landlock+seccomp /
   AppContainer+WFP），产品层只做**探测 + 编排 + 降级**。这正是 §2 纪律 1/2（`probeIsolation()`
   与"拿不到就显式降级"）的行业依据。

### 7.4 我们与业界的差异（三点，**不要照抄**）

1. **业界不做"命令级白名单"**。`srt` / Codex 的边界是 **FS + 网络绑定**，它们不解析命令字符串。
   我们今天的危险表 + bash 白名单 + AST 门，是"**因为还没有 L2**"的替代品。⇒ **L2 落地后，
   L0 的命令白名单应从"主边界"退到"纵深防御"**（P0-4 的 symlink 逃逸恰恰证明字符串判定守不住）。
2. **我们必须在"无常驻进程"约束下工作**。云沙箱与 Docker Sandboxes 都以"装一个
   daemon / hypervisor"为前提；我们是本地插件式 harness（CLI / A2A / VSCode 三宿主）。
   ⇒ 默认路线只能落在**第 3 格（OS 原语）**，容器 / microVM 是 **L3 可选**而非默认；这与 §2
   纪律 2「不模拟」一致——拿不到原语就降级告警，不硬凑。
3. **我们的策略层是独有的**。三模式权限引擎 + 四态答复 + 规则写回 + 零内容审计信封，
   业界（`srt` / Codex）只有"permissive / restricted"两档。**这块不抄**——"决策权归人工"是本仓
   的一等公民，本方案只**新增**执行边界，不动权限语义（§6 已钉）。

### 7.5 采纳建议（按我们的档位）

| 我们的档 | 抄谁 | 说明 |
|---|---|---|
| **L0** | （自研，无对标） | 命令级策略是我们的差异项；L2 到位后退居纵深 |
| **L1** | `ulimit` / `setrlimit` + 进程组 kill | 业界共识做法；同时解 P1-1 与 P0-6 |
| **L2** | **`@anthropic-ai/sandbox-runtime`（`srt`）** | 三平台差异已被它抹平：macOS Seatbelt / Linux bubblewrap·Landlock+seccomp / Windows 专用本地账户 + WFP，网络走宿主侧 HTTP+SOCKS 代理 + 域名 allowlist。Apache-2.0，可对标甚至 vendored |
| **L3** | Firecracker 系 | E2B / Vercel Sandbox / GKE Agent Sandbox 同一底座；与 `external-integration-plan.md` §9 合流 |

**Linux 上有一个真实分叉**：`srt` 选 **bubblewrap**（需系统预装 `bwrap`），Codex 选
**Landlock + seccomp**（内核原生 5.13+，**无外部依赖**）。⇒ **我们倾向 Landlock + seccomp**，
因为"无外部依赖"更贴合我们"开箱可用 + 探测降级"的口径；bubblewrap 作为可选增强（探测到才用）。
这条会直接决定 P3-2 `probeIsolation()` 的探测项。

### 7.6 外部参考实现

- **Anthropic `srt`**：`github.com/anthropic-experimental/sandbox-runtime`，
  npm `@anthropic-ai/sandbox-runtime`（Apache-2.0）。**本方案 L2 的首选对标**。
- **OpenAI Codex CLI 沙箱**：macOS 12+ Seatbelt（`codex debug seatbelt`）/ Linux Landlock+seccomp
  （`codex debug landlock`）/ Windows restricted token；默认 `workspace-write` 且网络默认关。
- **gVisor / Kata Containers / Firecracker**：第 4/5 格（L3 候选）。
- **WASI（Wasmtime）能力模型**：若未来要给**插件代码**（P1-5）划边界，这是比 `worker` 更强的答案
  ——默认零能力、显式导入才可达。
- ⚠️ **`vm2` 已停止维护**（作者明确"不应作为安全边界"），且**在 Bun 上明确"不是安全边界"**
  （其威胁模型基于 V8 内部，Bun 用 JSC、未审计）。**本仓跑在 Bun 上 ⇒ 这条尤其要记**：
  任何"在同一个进程里跑不可信 JS"的方案，在本仓都不成立。

## 8. 权限设计评审（三问直答 + 缺陷清单）

> 起点 2026-10-11。放在沙箱方案里的理由：**权限层（谁批准）与隔离层（批准之后能做到什么）
> 是正交的两层** —— 我们两层都有，但只把"边界"当成了问题。本节把**权限层自身的缺陷**逐条
> 钉住，其中 D1/D2 与 §3 的 P0 同族（静默失效 / 安全漏判），故已收编为 **P0-8 / P0-9**。

### 8.1 三个问题直答

| 问题 | 答案 | 依据 |
|---|---|---|
| 支持「允许一次 / 始终允许」吗 | ✅ 支持，**四态**：`allow` / `deny` / `always-allow` / `always-deny`；`always-*` 写回规则集与磁盘 | `host/src/permission.ts:30`（类型）、`:277`（`answerToDecision`）、`cli/src/index.ts:393`（`parseCliAnswer`） |
| 权限**跟会话**走吗 | ❌ **不跟**。`check()` 只读 `toolKey` / `patterns` / `denyPatterns`；`sessionId` 仅用于 **① asker 路由 ② 审计归属**，**不参与规则匹配、也不参与写回** | `core/src/index.ts:449`、`host/src/permission.ts:248/300` |
| 那权限的实际作用域是 | **工作区级**：跨会话、跨进程持久，落 `<dataDir>/permissions.json` | `host/src/host.ts:361`（`saveRules`）、`host/src/host.ts:348`（`files.permissions`） |
| `allow-all` / `ask` / `deny-all` 这个**模式**呢 | 是**进程内内存态**，不落盘、重启复位 —— `setMode` 注释写明"不影响持久化规则"。**这条是对的**，但也意味着"会话级切换"并不存在（见 P2-7） | `host/src/permission.ts:222-225` |

### 8.2 缺陷清单（按严重度）

| # | 严重度 | 缺陷 | 收编 |
|---|---|---|---|
| **D1** | 高 | 「始终允许」粒度 = **整工具**、且**整键覆盖**已有 PathRules；写回后规则退化为 string，**段级 `denyPatterns` 从此整体失效** | **P0-8** |
| **D2** | 高 | 授权**不跟调用方/会话**走（规则集是 dataDir 级共享），而**身份**是按 `contextId` 绑定的 ⇒ 一边隔离、一边不隔离 | **P0-9** |
| **D3** | 中 | `allow` 之后以**宿主全权限**执行 ⇒ 「允许一次」与「始终允许」在**本次的实际危害相同** | 无需新条目 —— 就是 §2-L2 缺失的直接后果（见 §8.5） |
| **D4** | 中 | ✅ **已修**（P2-5）：`assessRisk` 对 `bash` **恒为 `high`**（`ls` / `pwd` 也是），标签失去区分度 | P2-5 |
| **D5** | 中 | **手改规则无审计**：CLI `/permission <key>=<behavior>` 与 A2A 控制面 `harness/permission.set` 都直接写盘、**都不发事件** | P1-9 |
| **D6** | 低 | ✅ **已修**（P2-6）：提示文案键位自相矛盾 —— 写 `always(a)`，实际 `a` = 只放行一次、`A` = 永久 | P2-6 |
| **D7** | 低 | ✅ **已修**（P2-7）：`mode` 是**进程级**（一个进程内多会话共享），"会话级切换"并不存在 —— 现改为**真会话级**（`sessionModes` 覆盖 + 进程默认回退），CLI 默认只改本会话、`global` 后缀才改进程默认，A2A 控制面加可选 `sessionId` | P2-7 |

### 8.3 D1 深挖：提示一套、写回另一套

三层证据链，全部逐字可验：

```
提示（用户看到的）                    host/src/permission.ts:141
  text: `操作: allow / deny / always(a) / deny-always(d)? [a/d/A/D]`
        并列出具体 patterns（`pat = patterns.slice(0,3).join(', ')`）

写回（实际做的）                       host/src/permission.ts:283 → :300
  case 'always-allow': await this.rememberRule(toolKey, 'allow')
  rememberRule: updated = { ...getRules(), [toolKey]: 'allow' }   ← 整键覆盖

生效（下一轮的判定）                    core/src/index.ts:492
  if (typeof toolRule === 'string') return { behavior: toolRule, ... }   ← 直接 return
```

三个后果，逐条都指向"收紧方向失守"：

1. **粒度是整工具，不是命令**。用户在 `bash` 的提示上按「始终允许」，记住的是 **`bash` 整个工具**，
   不是 `ls` / 不是 `npm test`。同一键下 `rm -rf` 与 `ls` 同命。
   （对照业界：Claude Code 记 `Bash(npm test:*)` 这类**命令前缀**，Codex 记**具体命令**。）
2. **整键覆盖丢规则**。`{ bash: { allow: ['echo*'], deny: ['shutdown*'] } }` 按一次 always-allow
   就变成 `{ bash: 'allow' }` —— 用户配的 `deny` 直接消失。
3. **`denyPatterns` 永久失效**。规则退化成 string 后，`check()` 在 492 行**直接返回**，
   `denyTargets`（`[...patterns, ...denyPatterns]`，专为拦 `echo hi; shutdown -h now` 而设）
   **整体不再参与判定**。这是**唯一的段级防线**，且失效是**静默**的。

**测试盲区（为什么没被早发现）**：`core/src/permission-deny-patterns.test.ts:77` 有一条
「工具级 string 规则不受 denyPatterns 影响」—— 它钉的是**形态本身**（string ⇒ 不走 denyPatterns），
**没有覆盖"always-allow 会把 PathRules 变成 string"这条写回路径**。即：测试固化了"string 规则不受
denyPatterns 影响"这个事实，却没人问"规则**什么时候**会变成 string、变成之后谁来兜"。
⇒ 补 P0-8 时必须加两条反向用例：**①always-allow 之后段级 deny 仍生效；②写回不丢已有 `deny`/`ask`**。

### 8.4 D2 深挖：身份是一等的，授权不是

三层作用域并排看，问题一眼可见 —— **身份层做对了，权限层没跟着做**：

| 维度 | 作用域 | 是否按调用方/会话隔离 | 依据 |
|---|---|---|---|
| 会话历史 / 工作目录 | `contextId`（= `sessionId`） | ✅ 按调用方绑定 | `a2a-server/src/auth.ts:42/63`：`callerKey()` 首次使用即绑定，他人复用 ⇒ `ContextForbiddenError` |
| 询问路由（asker） | 全局单槽 + `sessionId` 分发 | ✅ 有归属 | `packages/permission/src/index.ts:99-112` |
| 审计归属 | `sessionId` 落文件名 | ✅ 有归属 | `host/src/audit.ts` |
| **权限规则** | **`<dataDir>/permissions.json`** | ❌ **无归属** | `host/src/host.ts:361`、`workspace/src/index.ts:134`（`dataDir` 缺省 `~/.harness`） |

`resolveWorkspace({cwd, dataDir})` 在 A2A 与本地 TUI 两侧**默认解析到同一个 `dataDir`**（同 cwd 时），
于是两边共用同一份规则。结果：

- 本地点一次「始终允许」⇒ 同一工作区的**远程 A2A 调用方一并继承**；
- 反向：控制面 `harness/permission.set` 写盘 ⇒ **本地继承**。

控制面只监听 `127.0.0.1` 是**缓解**（不是隔离）：它挡住了"网络上的陌生人"，挡不住"**同一台机器上的
另一个 harness 宿主/进程**"，也挡不住"运维用控制面批量改规则后，本地被顺带提权"。

**这条是本仓独有的**。Codex / Claude Code 是单机单用户，"授权对象是谁"这个问题不存在；我们多出来的
A2A 远程面，把它第一次暴露了出来 —— 而解法不需要新机制，**`PermissionRequest.sessionId` 已经在传了、
asker 路由也已在用了，只差把它接进规则匹配与写回**（P0-9 的第③条）。

### 8.5 与沙箱的关系：正交两层，但失效时互相放大

一句话：**权限管"谁批准"，沙箱管"批准之后能做到什么"。我们现在只有前者。**

- **D3 就是这两层的接缝**：「允许一次」与「始终允许」在**本次**危害相同，因为批准之后一律以
  **宿主全权限**执行（§0 / §7.1 第 1 格）。⇒ 沙箱档位（L2）落地直接缩小 D3 的影响面。
- **P0-7（`fallbackToHost` 升权不留痕）是同一族**：授权之后的执行边界一旦失守，
  "授权"这件事本身就没有意义 —— 所以它不是小毛病。
- **排期分叉（§4 第 5/6 步）**：
  - **P0-4/P0-5 已于 2026-10-11 做完**（见续 275）：路径边界现在是 realpath 版、且全仓只有一份。
    这**不替代** L2 —— 真实路径判定仍可能被 TOCTOU（检查与打开之间换链接）绕过，OS 级只读绑定
    仍是唯一挡得住那种时间窗的墙；反过来 L2 拿不到原语降级时，这份判定是唯一那道墙。
  - 若 **L2 要等**：P0-4 已就位，不必再等。
- **D1/D2 不依赖沙箱**：它们是纯粹的规则层缺陷，与 L0–L3 任何一档的落地无关 —— 可以现在就修。

### 8.6 修复建议（都不大）

| 针对 | 做法 | 反向验证 |
|---|---|---|
| **D1**（P0-8）✅ **已修** | ①`rememberRule` 改 **PathRules 增量写回**：把本次 `patterns` 并进 `allow`（或 `deny`），**保留**已有 `deny`/`ask`，不再整键覆盖；`patterns` 为空 ⇒ `**` 通配（等价旧 string，但不抹掉既有规则）。②`check()` 收紧：**全局 deny 对所有工具规则形态都有否决权** —— 实现时确认，string 形态**没有自己的 deny 列表**，所以"string allow 也过 `denyTargets`"唯一可行形态是**从全局借 deny 列表**（默认 `'*': 'ask'` 不触发 ⇒ 零行为变化，只收紧不放宽） | `permission-deny-patterns.test.ts` 补"always-allow 后段级 deny 仍生效" + "写回不丢已有 deny/ask" |
| **D2**（P0-9）✅ **已修** | 规则键加**归属前缀**：`session:<sid>\|<tool>` / `caller:<hash>\|<tool>`；`check()` 按 `session` → `caller` → 工具 → 全局**逐层回退**；写回带归属键。实现时改了两点：①**主体必须哈希**（A2A 的调用方标识就是 Bearer token，落盘即泄凭据 ⇒ `callerScopeKey()` 取 sha256 前 16 位）；②归属靠 **`resolvePrincipalKey()` 覆写钩子**而不是给 `PermissionRequest` 加字段（只有宿主有鉴权上下文；加字段等于让 core 认识 A2A 的鉴权模型）。缺省（基类）返回 `undefined` ⇒ **无归属，行为与分层前逐位相同** | 已补："远程 caller 不继承本地 always-allow"（host 单测 + A2A 端到端各一条）、"无归属时作用域键被忽略"、"层序"、"作用域通配 deny 否决" |
| **D5**（P1-9）✅ **已修** | 加 `kind: 'permission.rule.changed'`（零内容 + `stateHash` + 来源 `cli / control-api / asker`），沿用 `harness.audit.v1`。接在 **`HarnessHost.setPermissionRules()`**（两条手工路径的唯一入口）+ 引擎 `rememberRule`（asker 路径）。`createAuditSink` 的"无 sessionId 即丢弃"改为**落工作区级 `{dataDir}/audit.jsonl`**（控制面规则变更无会话归属，丢弃＝白做） | 已补：host 单测（source=asker、零内容、单次答复不产生）+ A2A 端到端（控制面 ⇒ 工作区级文件、source=control-api） |
| **D4 / D6**（P2-5/P2-6）✅ **已修** | 纯判据与文案：`assessRisk` 让 `bash` 走**模式表**（`ls` 不该是 high）—— 实际落成 `SHELL_TOOL_KEYS` 分流 + `assessShellRisk(command)`，且**执行类判据要放在工具键表之前**（否则模式表对 bash 永远不生效）；文案键位改成**只有 `状态(键)` 一种形态**（比初稿的"去掉方括号简写"更进一步：直接与 `PermissionAnswer` 四态对齐）。`cli.test.ts` 钉着文案，**改要同步** | 文案用例已同步（host 2 处逐字）+ `assessRisk` 补 6 条 bash 分级用例 + cli 加"文案↔`parseCliAnswer`"守卫。反向验证三处变异：M1 退回一刀切 high ⇒ host 5 红；M2 退回旧文案 ⇒ host 2 + cli 1 红；M3 摘掉 `NULL_SINK_REDIRECT` 负向前瞻 ⇒ host 1 红 |
| **D7**（P2-7）✅ **已修** | 真做成**会话级**（而不是只把文案改成"进程级"）：引擎加 `sessionModes` 覆盖表，`getMode/setMode` 接 `sessionId?`，`ask()` 按 `req.sessionId` 取；CLI 默认**只改本会话**、`global` 后缀改进程默认；A2A 控制面加可选 `sessionId`（不给 ⇒ 进程默认，**老调用逐位不变**）。⚠️ 实现期坑：CLI 的 `arg` 是 `line.split(/\s+/, 2)[1]`，**只截到第二个 token** ⇒ `ask global` 里的 `global` 会被丢掉，必须从 `line` 自己切 | host 补 4 条（未切过回退默认 / 只改本会话 / 不给 sessionId 改进程默认 / `ask` 按会话短路）+ cli 1 条（本会话 vs `global`）+ a2a 1 条。反向验证：退回裸字段 ⇒ host 3 + cli 2 + a2a 1 红（与预测逐项一致） |
| **P0-4 / P0-5 / P3-1** ✅ **已修**（承 D4 那轮的附带发现） | ①`assessRisk` 两张表的键由**工具 id** 改为**权限键**（`HIGH = write / edit`、`LOW = read / bash_ro`）——`toolKey` 本就是 `tool.permission.key`（`tool/src/index.ts` 的 Step 4），id 永远到不了这里，所以改造前 **`write` 落 medium**（写操作标中危，比 D4 更隐蔽：D4 至少还是 high）。②路径边界收敛成**一份 realpath 版**：新建零依赖 `@harness/fs-guard`，6 包 7 文件全改为引它，`isWithinCwd` 两侧都过 `realpathBestEffort`（不存在时逐级上溯最近存在的祖先），并加"别处不得再抄一份"的**静态守卫**；顺带修掉 `startsWith('..')` 对 `..foo` 的误杀 | `assessRisk` 补两条（写侧 + 读侧"id 不是键 ⇒ medium"）+ `cli.test.ts` 的 `riskLevel` 断言 `medium → high`；每个有强制路径的包补 symlink 逃逸回归（builtin 读+写两条）。反向验证四处：① 退回 id 表 ⇒ host 3 + cli 1 红；② 退回进程级 mode ⇒ host 3 + cli 2 + a2a 1 红；③ 退回字符串判定 ⇒ **7 红**（fs-guard 1 + builtin 2 + glob/search/media/code-intel 各 1）；④ 塞回一份副本 ⇒ 静态守卫 1 红并点名文件 |
| **P0-1 / P0-2 / P0-3 / P0-6 / P1-1** ✅ **已修**（2026-10-11，续 276） | ①**P0-1 可配置**：`load(ctx)` 加载上下文把 `config.json → sandbox` 递进内置插件（原来是无参单例 ⇒ 整段静默失效），外加 `checkSandboxConfig()` 把"写了不生效"报出来。②**P0-2 MCP env**：`buildMcpChildEnv()` 默认白名单 + 声明项（凭据必须显式；开关是 `envKeep` / `inheritEnv`）。③**P0-3 读侧**：`@harness/fs-guard` 的敏感清单被 `read_file` / `grep_file`（含遍历逐文件跳）/ `bash_ro`（AST 参数）共用，例外（模板 / 公钥）优先。④**P0-6 进程树**：`detached` + `kill(-pid)`（Windows `taskkill /T /F`）。⑤**P1-1 资源上限**：`ulimit` 抬头，逐项各起一次（合并会被 macOS 的 `-v` EINVAL 连累）、`-f` 单位按平台换算。⚠️ 实现期发现：`ulimit` 抬头会让 `bash -c "<单命令>"` 失去 exec 优化 ⇒ **P1-1 反而放大对 P0-6 的依赖** | 反向验证五处（+1 补测）：退回只杀直接子进程 ⇒ builtin **3** 红（含既有那条，因失去 exec 优化而 5s 超时）；`buildLimitPreamble` 恒空 ⇒ builtin **4** + host **1** 红；registry 无视 ctx ⇒ host **2** 红；`buildMcpChildEnv` 退回全量继承 ⇒ mcp-client **3** 红；`isSensitiveReadPath` 恒 false ⇒ **11** 红（fs-guard 5 + builtin 4 + search 2）、恒 true ⇒ **4** 红（两侧互为补集，证明不是死断言） |
| **P0-7 / P1-2 / P1-4 / P1-8 / P3-2** ✅ **已修**（2026-10-11，续 277） | ①**P0-7**：`PermissionRequest.escalation` + 引擎覆写 `check()` ⇒ `sandbox.escalation` 审计（`allow-all` 的静默放行也留痕）。②**P1-2**：`sandbox.net` 三态 + `netAllow`，元数据/私有地址硬拒、提不出目标 fail-closed。③**P1-4**：档位可声明（`sandbox.level` + `onUnmet: warn\|refuse`）+ `BashOutput.isolation` 自述边界。④**P3-2**：`probeIsolation()` 可注入探测（**探到原语 ≠ 达到那档**）。⑤**P1-8**：`read_file` 大小闸（整文件载入后才切片 ⇒ 超限拒绝而非截断）。⚠️ 实现期发现：新增 `BashOutput.isolation` 把一条既有 TUI 用例断的 `exitCode":0` 挤出了固定宽度尾窗（它原来靠"紧跟 stdout、后面没几个字段"这个偶然）⇒ 判据改成断言**真正的首/尾锚点** | 反向验证三处：去掉大小闸 ⇒ builtin **1** + host **1**；`probeIsolation` 改成"探到原语就升 L2" ⇒ isolation **6** + host **2**（builtin 0）；网络门恒放行 ⇒ isolation **8** + builtin **4** + host **1**（预测 12、实测 13，多的一条已归因） |
