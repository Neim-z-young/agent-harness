# 调研报告：bash tool AST 校验 与 Kitty 键盘协议接入

> 2026-09-30 · 两个方向的现状摸底 + 方案选型 + 落点建议。所有行号均对应当前工作区代码。

---

## 方向一：bash tool 命令 AST 校验（防破坏性命令绕过字符匹配）

### 1.1 现状：三层字符匹配

| 层 | 位置 | 机制 |
|---|---|---|
| 危险命令黑名单 | `packages/plugins/tools-builtin/src/index.ts:361-386`（`DEFAULT_DANGEROUS_PATTERNS`，12 条正则）+ `detectDangerous`（:399） | 对**原始字符串** `re.test`，命中即拒（`SANDBOX_DANGEROUS`），无论是否回退硬性生效（:546-554） |
| 命令白名单 | 同文件 :574-578 | `extractFirstCommand`（:423，正则取首命令）+ `firstCmd === a \|\| startsWith(a) \|\| includes(a)` |
| 只读白名单（bash_ro） | `checkReadOnlyCommand`（:801-892） | **自研手写解析器**：`stripQuoted`（:752 剥引号投影）+ `splitSegments`（:768 按 `;` `\|` `&&` `\|\|` `\n` 切段）+ 参数级禁区（:685）+ git 子命令白名单（:678）+ 解释器写/网特征（:703） |

权限链路：ToolPipeline Step 4（`packages/tool/src/index.ts:1317-1339`）→ `resolvePermission`（`packages/core/src/index.ts:337-353`，含 `core.permission.check` hook）→ DefaultPermissionEngine / CliPermissionEngine（glob 匹配；对 bash 而言 pattern 是**整条命令字符串**）。工具内沙箱检查发生在权限判定**之后**，是第二道闸。

执行方式：`spawn('bash', ['-c', command])`（:991），完整 shell 语义，**没有** `--restricted`、没有 shimgate，命令是自由文本。

### 1.2 字符匹配的可绕过面（按严重度排序）

| # | 绕过手法 | 示例 | 现状 |
|---|---|---|---|
| 1 | **白名单 `includes()` 子串判据** | allowlist=`['git']` 时 `echo git && rm -rf /` → `input.command.includes('git')` 为 true，**直接放行** | 严重逻辑缺陷，不需要高级技巧 |
| 2 | 变量赋值/展开 | `X='rm -rf /'; $X`、`rm$IFS-rf$IFS/` | 正则完全看不到 `rm` 字面量 |
| 3 | 命令替换/base64 | `echo cmFtIC1yZiAv \| base64 -d \| sh`、`` `echo ...` `` | 默认表只覆盖 `curl\|bash`；`base64 -d \| sh` 不在表内 |
| 4 | 引号/转义混淆 | `r\m -rf /`、`"r"m -rf /` | `\brm\b` 不命中 |
| 5 | 子 shell / 花括号组 | `(rm -rf /)`、`{ rm …; }` | 手写切段只处理引号，不递归进组 |
| 6 | heredoc 进 bash | `bash <<EOF\nrm -rf /\nEOF` | bash_ro 拒 heredoc（:732），主 bash 不判 |
| 7 | 解释器执行 | `python3 -c "import os; os.system('rm -rf /')"` | 解释器写/网特征扫描**只有 bash_ro 有**，主 bash 无 |
| 8 | 裸设备路径变体 | `/dev/disk/by-id/…`、`/dev/mmcblk0` | 默认表只枚举 `sd\|hd\|rdisk\|disk\|vd\|nvme` |
| 9 | 参数级写操作 | `sed -i`、`find -delete`、`awk 'system("…")'` | 只在 bash_ro 有禁区表，主 bash 不判 |
| 10 | xargs / 进程替换 | `… \| xargs rm`、`>( )` | 同上，仅 bash_ro 拦 |

> 说明：bash 的安全定位是「协作式防护 + 权限引擎兜底」（bash_ro 注释 :697-701 明说"任何基于字符串的检查都能被绕过"），但 #1 是**判据本身写错**（不是被绕过），应无条件修；#2-#10 是 AST 校验的目标空间。

### 1.3 方案选型

| 方案 | 说明 | 结论 |
|---|---|---|
| **A. tree-sitter-bash（web-tree-sitter wasm）** | 官方 bash grammar 有 wasm 构建；`packages/plugins/code-intel` 已有 `web-tree-sitter@0.27` + 多个 grammar 的**现成基建**（wasm 加载、parser 单例模式可直接复用） | **推荐**。容错解析（畸形/不完整命令也产出部分树，fail-closed 处理容易） |
| B. 纯 JS 解析器（bash-parser 等） | npm 上相关包长期停更，POSIX 子集 | 不建议 |
| C. 扩展现有手写解析器 | `stripQuoted`/`splitSegments` 升级为完整 tokenizer + 递归下降 | 无依赖但边界难穷尽（本次调研已列出 10 类），维护成本高 |

### 1.4 设计落点

1. **新增纯函数** `analyzeBashCommand(command: string): CommandFacts`（建议放 `tools-builtin/src/bash-ast.ts` 独立模块，遵循插件化约定）：
   - 遍历 AST 收集**所有** command 节点（含子 shell、命令替换、进程替换、函数体、heredoc 内 bash）；
   - 每个 word 解出引号/转义后的**字面量**；变量展开处标 `unknown`；
   - 重定向目标、fd 操作单独产出。
2. **判定模式从「正则命中」升级为「facts 驱动」**：
   - 白名单：用 AST 全命令序列判定，替换 `includes()` 判据（**先修 #1，不依赖 AST**，一行改动 + 反向测试）；
   - 危险目标：redirect 目标/参数的字面量与 `/dev/…` 等精确前缀匹配，无引号混淆；
   - 变量展开分级：展开进**命令名位置** → 拒（fail-closed）；展开进参数 → 可配置（默认放行并告警，避免误杀 `ls $dir`）；
   - `bash_ro.checkReadOnlyCommand` 内部改用 AST 实现，**保留现有错误码与函数签名**（tests-builtin.test.ts:852-935 的用例即回归基线）。
3. **降级路径**：解析失败（timeout/异常/无法建树）→ 回落现有正则表 + 告警，不静默放行。
4. **验证**：L1 纯函数单测（每条绕过面一个用例，模板同 checkReadOnlyCommand）→ L2 端到端探针 → 真机。
5. **前置验证**：`tree-sitter-bash` 的 wasm 版本与 `web-tree-sitter@0.27` 的兼容性需先跑通（code-intel 用的是 native grammar + wasm 混合，bash 需确认用哪条路）。

### 1.5 风险

- **误拒**：变量展开 fail-closed 若不分位置会杀掉正常命令 → 按 1.4-2 分级；
- **性能**：parser 单例缓存 + 仅对 `bash`/`bash_ro` 生效，单命令解析 O(n) 可忽略；
- **双实现并存期**：正则表保留为 fallback 与 `additionalDangerous` 用户扩展入口，不可删。

---

## 方向二：Kitty 键盘协议接入

### 2.1 结论先行

**OpenTUI 0.5.8 已内置完整的 Kitty keyboard protocol 支持，且本项目当前默认就是开启状态。** 这条线主要是「验证收口 + 显式化 + 能力分级提示」，不是从零接入。

### 2.2 证据链

| 层 | 事实 | 位置 |
|---|---|---|
| 解析 | `parseKeypress(raw, { useKittyKeyboard })` **默认 true**；完整 CSI-u 解析器（`parseKittyKeyboard`、正则 `/^\x1b\[([^\x1b]+)u$/`、`parseKittySpecialKey`、`fromKittyMods` 做 kitty 修饰位 → ctrl/alt/shift 映射、`kittyKeyMap`） | `node_modules/.bun/@opentui+core@0.5.8*/…/core` chunk（源码路径 `src/lib/parse.keypress-kitty.ts`） |
| 启用 | `createCliRenderer` → `config.useKittyKeyboard ?? {}` → `buildKittyKeyboardFlags`（`disambiguate`/`alternateKeys` 默认 true → flags=3）→ native `lib.setKittyKeyboardFlags(rendererPtr, flags)`；dylib 内实测含 `[=;1u` 字符串 = `CSI = flags;1u`（kitty "set" 模式；退出时 flags=0 复位）。**无 `CSI ? u` 能力探测** → 不支持的终端忽略未知 CSI，自然降级 legacy | 同上 + `libopentui.dylib` strings 取证 |
| 项目侧 | `tui.tsx:2667` `createCliRenderer({ useMouse: true })` 未传 `useKittyKeyboard` → 走默认 `{}` → **flags=3 已启用** | `packages/cli/src/tui.tsx` |
| 消费 | Shift+Enter 换行已按 `key.shift` 分支（:2012-2017）；`\`+Enter 通用兜底（:2020）；帮助文案已注明依赖（:132）；`__KEYLOG` 修饰键诊断已存在（:1886）；herdr 终端丢失修饰键的降级实测记录（:2000-2005 注释） | 同上 |
| 运行时开关 | renderer 有 `useKittyKeyboard` getter/setter（flags = DISAMBIGUATE\|ALTERNATE_KEYS 或 0） | chunk-bun-b3exa82d.js |

可选 flags（当前默认关）：`events`（press/repeat/release）、`allKeysAsEscapes`、`reportText`。

### 2.3 剩余工作（按优先级）

1. **真机验证矩阵**（核心交付物是「实测结论」而非代码）：
   - kitty / ghostty / WezTerm：预期 Shift+Enter 换行、Ctrl 组合、Alt+key（disambiguate 修复 ESC 歧义）全绿；
   - iTerm2：需用户开启 "Report modifiers using CSI u" 才生效 → 帮助文案应写明；
   - Terminal.app：不支持 → 依赖 `\`+Enter 兜底（已有）；
   - tmux/herdr：已知丢修饰键（:2000 注释），验证 passthrough 配置能否救回。
2. **显式化**：`createCliRenderer` 显式传 `useKittyKeyboard` 配置（把"默认开启"变成"声明开启"，防 OpenTUI 升级改默认值）；启动时探测 `$TERM==xterm-kitty`、`$KITTY_WINDOW_ID`、`$GHOSTTY_RESOURCES_DIR`，帮助面板按能力显示快捷键提示（替换当前固定文案 :132）。
3. **风险点**：
   - kitty 序列跨 stdin chunk 到达时，增量字节流状态机 `protocolContext.kittyKeyboardEnabled` 默认 false —— 需真机确认是否要显式传 protocolContext（低概率问题，readline buffer 通常整段到达）；
   - 若将来开 `allKeysAsEscapes`，Ctrl+C 变成普通 key 事件，退出路径要自行处理；
   - OpenTUI 升级（>0.5.8）可能改变默认行为，显式传参是唯一保险。

---

## 附：建议的执行顺序

1. **先修 #1**（白名单 `includes()` 判据）：单行改动 + "注册了但含白名单子串 ⇒ 拒绝"反向用例，独立提交；
2. **Kitty 线验证收口**：真机矩阵跑一遍，产出实测结论 + 显式化小改动（独立提交）；
3. **AST 线立项**：先验证 tree-sitter-bash wasm 兼容性 → `analyzeBashCommand` 纯函数 + L1 单测 → 替换 bash_ro 内部实现（保错误码）→ 主 bash 黑名单 facts 化 → L2/真机。

---

## 实施进展（2026-09-30 同日落地）

| 步骤 | 状态 | 产出 |
|---|---|---|
| 修复白名单 `includes()` 判据 | ✅ 完成 | `tools-builtin/src/index.ts`：改为「首命令精确匹配 / 完整片段+词边界」；补 3 条反向用例（含 `github` ≠ `git`、多词片段整词匹配） |
| Kitty 显式化 + 能力探测 | ✅ 完成（代码侧） | `cli/src/keyboard.ts`（探测 + 帮助文案分级，9 条单测）；`tui.tsx` `createCliRenderer` 显式传 `useKittyKeyboard: { disambiguate: true, alternateKeys: true }`；帮助面板 Shift+Enter 行按探测等级显示 |
| tree-sitter-bash 可用性验证 | ✅ 通过 | `tree-sitter-bash@0.25.1` 官方包自带 wasm，`web-tree-sitter@0.27` Bun 下加载解析正常（spike 实测）；已注册进 tools-builtin dependencies |
| `analyzeBashCommand` AST 模块 | ✅ 完成 | `tools-builtin/src/bash-ast.ts`：递归收集全部命令（含命令替换/进程替换体）、解码引号/转义/ANSI-C、展开标 opaque、重定向目标解码、归一化文本；21 条 L1 单测覆盖全部 10 类绕过面 |
| 主 bash 危险检测接入 | ✅ 完成 | `detectAstDangerous`（index.ts）：① 命令名含展开 → 拒（间接执行 fail-closed）；② 归一化文本重跑危险表（抓引号混淆）。AST 层是增强不是替代：wasm 不可用/语法错误回落原始正则。补 3 组集成用例（混淆命令被拒 / 间接执行被拒 / 6 类正常命令不误伤） |
| 验证收口 | ✅ | 全量 typecheck 0 error；全量 test 0 fail（tools-builtin 120、cli 429、全仓退出码 0） |

**顺手修复的既有漏洞**：`rm -rf ~` 危险正则的 `~\s` 锚点要求波浪号后必须有空白，行尾形态（`rm -rf ~` 无尾随空白）在原文上直接漏过 —— 已改为 `~(?:\s|$)`。

**按下不动（需用户决策 / 后续迭代）**：
- ~~bash_ro 内部换 AST 实现~~ → **已做**（见下轮实施）；
- ~~`$(which docker) ps` 误伤~~ → **已做**（见下轮实施）；
- ~~权限引擎层 glob 对 bash 的整串匹配~~ → **已做**（见下轮实施）；
- Kitty 真机验证矩阵（kitty / ghostty / WezTerm / iTerm2 / Terminal.app / tmux）—— 代码侧已就绪，需真实终端实测产出结论。

---

## 实施进展（第二轮，同日）：按下不动清单 1/2/4 落地

| 项 | 状态 | 产出 |
|---|---|---|
| bash_ro AST 复核门 | ✅ | `checkReadOnlyByAst`（tools-builtin/index.ts）：全部命令（含嵌套）的解码命令名必须逐个在白名单内 + git 子命令白名单复核 + 命令名展开一律拒（只读哨兵连 `$(which x)` 惯用法也不需要）。与手写门取**交集**，错误码对齐 `SANDBOX_RO_ALLOWLIST`；wasm 不可用/语法错误时跳过（手写门已放行的行为不变） |
| 路径解析惯用法放行 | ✅ | `bash-ast.ts` 新增 `namePathResolution` 判定：命令名展开**仅**为 `$(which x)` / `$(command -v x)` / `$(type -P x)`（全字面量、无嵌套替换）时标记；`detectAstDangerous` 对此类放行，其余 nameOpaque 照旧 fail-closed（`$(echo rm)` / `$R` 仍拒 —— 替换体无害≠输出无害，只有这三个命令的输出语义固定为可执行路径） |
| 权限引擎段级 deny | ✅ | 新链路：`PermissionRequest.denyPatterns`（tool/permission/plugin 三处类型对齐）+ `ToolPermission.extractDenyPatterns`（可选）+ 引擎 deny 判定目标 = patterns ∪ denyPatterns。bash/bash_ro 用 `splitSegments`（引号感知）上报段级命令 → `deny: ['shutdown*']` 能拦 `echo hi; shutdown -h now`。**allow/ask 匹配完全不变**（任一命中即生效，混入段级会放宽 allow，故绝不混入） |
| 顺手修复：deny 先于 allow | ⚠️ 行为变更 | `DefaultPermissionEngine.applyPathRule` 原先 **allow 循环先于 deny** —— 全串级 allow 规则会短路 deny（`allow: ['src/**']` + `deny: ['src/secrets/**']` 会放走 secrets），denyPatterns 更会被整串 allow 完全架空。已改为 deny → allow → ask（收紧方向先行，fail-closed）。core/cli 既有 187+429 条用例无一依赖旧顺序，全绿 |

**验证**：全量 typecheck 39 包 0 error；全量 test 39 包全部退出码 0（core 187、tools-builtin 130、cli 429）。新增测试：`core/src/permission-deny-patterns.test.ts` 6 条（含「段级不能进 patterns」的对照钉子）、bash-ast 惯用法判定 7 条、bash_ro 门 2 条、extractDenyPatterns 1 条。
