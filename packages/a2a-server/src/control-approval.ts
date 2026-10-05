/**
 * 控制面工具调用的**审批作用域**（P3-D，设计稿 §14.2）。
 *
 * ## 它解决的问题
 * `harness/tools.call` 是"扩展侧已经弹过 VSCode 原生确认框、现在告诉你结果"的调用。
 * 但工具执行链的提问点（`InteractivePermissionEngine.ask` → `asker`）**不在调用栈的相邻位置** ——
 * 中间隔着 `ToolPipeline.execute` → `resolvePermission` → `engine.check` →（hook）→ `engine.ask`。
 * 一个 flag 要穿过这四层，就只有逐层加参数（= 改 `@harness/tool` 的公开签名）。
 *
 * ## 为什么用 ALS
 * `AsyncLocalStorage` 让"这次调用已被确认"只存在于**当前异步上下文**里：
 * 作用域外天然读不到（不会泄漏给下一次调用），并发调用天然隔离（不互相顶替）。
 * 与 `executor.ts` 用 ALS 定位 A2A task 是同一个手法 —— 本仓对"跨层传递与本次调用绑定的事实"
 * 已有既定解法，不另发明。
 *
 * ## 语义边界（Fail-Closed，关键）
 * `getStore()` 为 `undefined` **不等于 deny**，它是"**不劫持询问**"：询问照常委派给装在外层的
 * 那条 asker（A2A 的任务挂起桥）。只有作用域**在**且 `answer` 有值时才短路返回。
 * ⇒ "客户端没带 approve" 的最终结果由原 asker 决定 —— 而控制面调用不在 A2A 任务上下文里，
 * 那里同样 deny（并打一条 warn）。本模块**不负责**兜底拒绝，否则就把"谁在拒绝"这件事藏起来了。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { PermissionAnswer, PermissionAsker } from '@harness/host'

export interface ControlApproval {
  /** 本次调用**已经过调用方交互式确认** ⇒ 询问阶段直接给出这个四态答复 */
  readonly answer: PermissionAnswer
}

/** 控制面审批作用域：`run()` 内部发起的权限询问由调用方代为作答 */
export const controlApproval = new AsyncLocalStorage<ControlApproval>()

/**
 * 把"控制面审批作用域"接进宿主已有的询问接缝 —— **包装，不替换**。
 *
 * `asker` 是全局单槽（`InteractivePermissionEngine.setAsker`），宿主已经装了 A2A 的任务挂起桥。
 * 直接 `setAsker(我们的)` 会把那条桥顶掉（PermissionRequired 用例静默退化成"任务直接 COMPLETED"）；
 * 所以这里返回一个**委派式**包装：作用域内才短路，其余原样转交 `inner`。
 *
 * 抽成独立函数（而不是内联在 `server.ts` 里）是为了让"包装语义"本身可单测 ——
 * 接线一行，语义一处。
 */
export function wrapAskerWithControlApproval(inner: PermissionAsker): PermissionAsker {
  return async (req, prompt) => {
    const approval = controlApproval.getStore()
    if (approval) return approval.answer
    return inner(req, prompt)
  }
}
