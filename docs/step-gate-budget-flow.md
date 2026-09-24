# 步间闸门 · 超时预算流程图

> **本文件只承载流程图与新语义说明**。代码实现与参数细节见
> `docs/agent-harness-architecture.md` §步间闸门、`packages/core/src/index.ts` 的
> `core.agent.step.gate` 段与 `STEP_GATE_MAX_TOTAL_MS` 注释。

## 一句话语义

`STEP_GATE_MAX_TOTAL_MS`（默认 300s / 5 分钟）**不是"终止条件"，而是"提醒阈值"**：
累计等待超过它之后，引擎**仍然继续等待**（档位 60s 封顶），只是给每个后续等待打上
`overBudget: true`，让 UI 提示用户"后台任务可能卡死/异常，可 Ctrl-C"。
真正终止交还给"插件不再报存活 + 用户中断"。

> 历史教训（真机 s_1790163574429_tg1a6）：旧设计把它当**总预算**，耗尽即跳过等待——
> 后台任务只做了一半就撞预算、结果真正跑完却没等到、下一轮才送达。所以才改成提醒阈值。

```mermaid
flowchart TD
    START([每个步边界<br/>模型开跑前 · 第2步起]) --> Q1{还有存活任务?}

    Q1 -- "否·静默" --> SILENT[阶梯归零 · 不发遥测]
    Q1 -- "是" --> Q2{预算还够?<br/>gateWaitedMs+waitMs<br/>≤ maxTotalMs}

    Q2 -- "是" --> WAITED[分片等待 · waited<br/>gateWaitedMs 累加<br/>overBudget=无]
    Q2 -- "否·超预算" --> OVER_WAIT[仍分片等待 · waited<br/>overBudget=true<br/>UI 提示"可能卡死/异常"]

    OVER_WAIT --> Q1
    WAITED --> Q1

    classDef focus fill:#fef3c7,stroke:#d97706,stroke-width:2px
```

## 分支明细

| 分支 | 触发 | 等待? | step_gate 心跳 | overBudget | skipReason |
|---|---|---|---|---|---|
| 静默 | 插件报无存活任务 | 否 | 不发 | — | — |
| waited（预算内） | 有任务且累计未超预算 | 是 | 发 | 无 | — |
| **waited（超预算）** | 有任务且累计超预算 | **是（照等）** | 发 | `true` | — |
| skipped(zero_ladder) | 阶梯配成空数组 | 否 | 不发 | — | `zero_ladder` |

## 关键点

- **档位封顶 60s**（`STEP_GATE_BACKOFF_MS` 末档），`Math.min(attempt, len-1)` 让它涨到 60s 就恒定，
  之后每次查询都按 60s 等，除非探测到静默 → 阶梯归零、从 3s 重新爬。
- **探测不停止**：等待期间每 `STEP_GATE_SLICE_MS`（500ms）分片重探你一次；插件静默即提前结束这一档。
- **超预算依旧继续等**：这是本方案与旧"总预算兜底"的关键区别。
- **只提示一次**：CLI 用 `overBudgetNotified` 记录，首次超预算提示后，后续心跳照发但不再重复刷屏。
- **中断仍生效**：`Ctrl-C`（AbortSignal）随时打断等待，这是真正终止的兜底之一。

## 连续等待累计到 5 分钟要走多久

阶梯 `3s→6s→12s→24s→48s→60s`（封顶）：

```
3 + 6 + 12 + 24 + 48 + 60 + 60 + 60 + 60 = 333s 在第 9 步累计超过 300s
```

即连续等待约 **9 步** 就撞上提醒阈值；之后继续按 60s 档等待并标记 `overBudget`。
中途若探测到静默，阶梯归零从 3s 重新爬（`gateWaitedMs` 不清零，仍会被累计预算打标记）。