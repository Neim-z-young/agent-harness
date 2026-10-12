/**
 * 插件 worker 装载的**入口**（跑在 worker 线程里，P1-5）。
 *
 * 它只做一件事：`import(file)` 然后把**可序列化摘要**回传。两件必须说清的事：
 *
 * 1. **它不参与插件的 install/hooks** —— worker 模式只做"加载 + 登记"。跨线程的同步回调
 *    （hooks 是宿主在循环里同步调插件的）需要一套完整 RPC 桥，那是后续项；现在硬接会得到一个
 *    "看起来装了、实际没生效"的插件，比不装更糟。
 * 2. **它不是安全边界**（实测，2026-10-12）：worker 里 `process.env` 的键数、`process.pid`
 *    与宿主**完全一致**，`writeFileSync('/tmp/x')` 也照样成功 —— `worker_threads` 共享同一个
 *    process，只是另一个线程。它给的是**资源上限 + 事件循环隔离 + 崩溃隔离**（这些实测都成立：
 *    OOM 被 `resourceLimits` 拦住且宿主存活、`while(true){}` 不阻塞主线程）。
 *    真要"不可信代码也伤不到宿主"，答案是 WASI（默认零能力）—— 见 `sandbox-isolation-plan.md` §7.6。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { describePluginExports, type PluginWorkerRequest, type PluginWorkerResponse } from './plugin-worker-protocol'

async function main(): Promise<void> {
  const port = parentPort
  if (!port) return
  const req = workerData as PluginWorkerRequest
  try {
    const mod = (await import(req.file)) as Record<string, unknown>
    const res: PluginWorkerResponse = { ok: true, summaries: describePluginExports(mod) }
    port.postMessage(res)
  } catch (err) {
    const res: PluginWorkerResponse = { ok: false, error: (err as Error)?.message ?? String(err) }
    port.postMessage(res)
  }
}

void main()
