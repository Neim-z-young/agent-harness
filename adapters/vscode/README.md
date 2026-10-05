# Agent Harness for VSCode

在 VSCode Chat 里用 `@harness` 直接使用本仓的 Agent Harness。

## 它是什么

一个 **Chat Participant**（`harness.agent`）。它不借用 Chat 视图的模型 —— harness 自带
Provider 与 agentic loop，扩展只负责把 A2A v1.0 的流翻成 `ChatResponseStream`。

进程模型：

```
VSCode extension host (Node)
        │  spawn
        ▼
harness a2a --json --port 0        (Bun)
        │  单行 JSON 握手回传端点
        ▼
POST /a2a            → A2A 协议面（SendStreamingMessage / CancelTask，SSE）
POST /harness/rpc    → 控制面（斜杠命令：会话/agent/模型/权限/技能…）
```

## 三条设计约束

1. **不使用 `request.model`** —— 借 VSCode 的模型等于把 harness 的 loop 劈成两半。
   代价：Chat 视图的模型下拉对本参与者无效。
2. **控制面与协议面分开** —— CLI 的 18 个斜杠命令里 12 个是本地管理操作，A2A 协议
   里无处安放；故走另一条路径 `/harness/rpc`，且不进 AgentCard。
3. **扩展不依赖任何 `@harness/*`** —— 它是纯协议客户端，跨进程只讲 A2A。

## 使用

1. 打开本仓工作区（扩展会自动探测 `packages/cli/src/index.ts`）。
2. 在 Chat 视图里 `@harness <你的问题>`。
3. 权限询问会弹模态对话框（允许一次 / 拒绝一次 / 总是允许 / 总是拒绝）。

命令面板：`Agent Harness: 显示 sidecar 状态`、`Agent Harness: 重启 sidecar`。

## 设置

| 设置 | 说明 |
|---|---|
| `harness.cliPath` | CLI 入口；留空则探测工作区内的 `packages/cli/src/index.ts` |
| `harness.token` | sidecar 的 Bearer token；留空则匿名（仅 127.0.0.1） |
| `harness.trace` | 把 A2A 事件原样写到 “Agent Harness” 输出通道 |

## 开发

```bash
npm install       # @types/vscode / typescript / vsce
npm run typecheck # 真 @types/vscode 类型检查
bun test          # 含真 sidecar 端到端（会 spawn harness a2a）
npm run package   # 出 VSIX
```

### ⚠️ `contributes.languageModelTools` 是**生成的**，不要手改

`package.json` 里那一段（P3-D：把 harness 工具暴露给 Copilot agent mode）由
**仓库根**的脚本从**真实工具池**生成：

```bash
bun run gen:lm-tools          # 改完工具（新增工具 / 改描述 / 改入参 schema）后跑这一步
bun run gen:lm-tools --check  # 只比对，不写
```

为什么必须生成：`lm.registerTool` 只提供实现体，**模型看到的描述与入参 schema 全部来自
package.json 这份静态声明** —— 手写必然漂移，而漂移的后果不是报错，是模型拿不到 schema、
于是发 `input: {}`（`read_file` 在真机上被这样发过 14 次）。

守卫：`packages/cli/src/gen-lm-tools.test.ts` 会现场取一份工具池与已提交的清单比对，
**漂移即测试变红**。设计稿 §14.4。

设计稿：`docs/vscode-integration-design.md`。
