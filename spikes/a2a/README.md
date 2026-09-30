# A2A / 分发路径 spike（P0.5）

`docs/external-integration-plan.md` §6 的 P0.5 要求先做两个 spike，结论决定 P1 的协议口径与
P3 的分发路径。本目录是这两个 spike 的**可复现脚本**，结论已回写进计划文档。

跑之前需要临时装依赖（spike 刻意不进根 `package.json`，避免污染主包依赖树）：

```bash
mkdir -p /tmp/a2a-spike && cd /tmp/a2a-spike
printf '{"name":"a2a-spike","module":"index.ts","type":"module"}\n' > package.json
bun add @a2a-js/sdk@1.3.0     # 版本必须钉死，见下
cp <repo>/spikes/a2a/*.spike.ts .
mv sdk-bun-serve.spike.ts index.ts
bun run index.ts              # 13 项自检，全绿即通过
```

## ① `sdk-bun-serve.spike.ts` —— SDK 无框架入口 + Bun.serve

**结论：可行，且比预期更干净。** `@a2a-js/sdk/server` 的 `JsonRpcTransportHandler.handle(body, ctx)`
只吃 JSON-RPC body（`string | Record`）、吐纯对象或 `AsyncGenerator` —— **完全不接触 HTTP**，
可以直接挂在 `Bun.serve` 上，不需要 express 等任何框架 peer dep。SSE 用 SDK 的
`formatSSEEvent()` + `SSE_HEADERS` 自己写。

13 项自检全绿：取卡 / 非流式 SendMessage / 流式 SSE / GetTask / ListTasks / CancelTask /
`INPUT_REQUIRED` 挂起与续接 / `A2A-Version` 校验 / executor 抛异常转 FAILED。

三条踩坑（都会**静默失败**，不报错，是 P1 最容易浪费时间的地方）：

1. **Part 有两套表示，不能混用。** 线上 JSON 是 proto 风格 `{"text":"hello","mediaType":"text/plain"}`；
   TS 内部是 `content: { $case: 'text', value }`。把内部表示直接 `JSON.stringify` 发出去，
   服务端 `fromJSON` 会**静默丢弃内容**（实测 `echo: hello` 变成 `echo: `）。
   ⇒ 出参一律走 SDK 的 `MessageFns.toJSON()`（`Message` / `Task` / `AgentCard` 都导出了）。
2. **`TaskState` 是数字 enum，线上是字符串。** `TaskState.TASK_STATE_COMPLETED === 3`，
   但 JSON 里是 `"TASK_STATE_COMPLETED"`。比较/建映射表必须用字符串（或 `taskStateFromJSON`）。
3. **版本校验不归 transport 管。** `JsonRpcTransportHandler` 不校验 `A2A-Version`，
   宿主必须自己调 `validateVersion(requestedVersion, card, 'JSONRPC')`；头缺失按 `'0.3'` 处理。

**挂起/续接（P1 核心机制）实测可行，且比计划文档设想的简单**（见 §3.4 的更新）：
不需要跨请求保存并恢复生成器 —— executor 在 `INPUT_REQUIRED` 之后**不返回**（`await` 答复），
阻塞式 `SendMessage` 照样立即返回 `INPUT_REQUIRED`（`ExecutionEventQueue` 在该状态终止），
后续带同一 `taskId` 的 `SendMessage` 会**再次调用 `execute`**，此时
`requestContext.task.status.state === INPUT_REQUIRED`，用它把答复喂给一张 `taskId → resolver`
表即可唤醒第一轮 —— 第一轮补发 COMPLETED，**续接请求的调用方直接拿到最终 artifact**。

另注：SDK 自己会 `console.error` 打印 executor 异常堆栈（"Agent execution failed for message …"），
P0 抽 host 时日志出口必须能接管它，否则污染共享 stdout、且向远程调用方泄漏堆栈。

## ② `compile-plugin-load.spike.ts` —— `bun build --compile` 与动态插件

**结论：可行，推翻了计划文档 §8 的风险假设。** 单文件二进制**内嵌了转译器**，
运行期 `await import(pathToFileURL(full).href)` 能直接加载用户目录的 `.ts`（不只是 `.js`/`.mjs`）。

实测通过：`.ts` / `.js` / `.mjs` 三种形态；插件的裸依赖按**插件文件所在目录向上**解析
（与未编译时一致 —— 不是 `--compile` 引入的新限制）；绝对路径、相对 `.ts` 导入、`node:` 内置模块
全部正常；体积 61MB、冷启动 18ms。

```bash
cd /tmp/compile-spike
bun build --compile src/main.ts --outfile bin/app
./bin/app /abs/path/to/plugin.ts
```

⇒ P3 的 sidecar 分发**可以走 `--compile` 单文件二进制**，不必退化为"随扩展带 bun"。
唯一遗留约束是**既有问题、与 `--compile` 无关**：用户插件目录（如 `~/.harness/plugins/`）
解析不到 `@harness/plugin` 这类裸依赖（`loadPluginDirs` 现在就有这条提示文案）。

## 钉死版本

`@a2a-js/sdk@1.3.0`（2026-10-01 时的 latest；1.0 GA 于 2026-07-22，1.1/1.2/1.3 是 GA 后的 minor 迭代）。
P1 建 `packages/a2a-server` 时按精确版本写入 `package.json`，升级按 minor 走回归。
