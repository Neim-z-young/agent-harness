/**
 * 插件 **worker 装载**的数据契约（宿主侧与 worker 侧共用，P1-5）。
 *
 * 单独成文件的理由：worker entry 是**独立入口**，不能 import `./index`（barrel，会拉起一大片）；
 * 两侧只共用这一份 `可序列化数据 + 纯函数`，谁都不依赖谁。
 */

/** 宿主 → worker：要装载的插件文件 */
export interface PluginWorkerRequest {
  /** 插件文件的绝对路径 */
  file: string
}

/**
 * 插件导出的**可序列化摘要**。
 *
 * ⚠️ 只抽静态字段，**不抽 hooks** —— hooks 是 `install(ctx)` 的返回值（运行期才知道），
 * 跨线程拿不到函数。硬去猜（比如扫源码里的 `'core.xxx'` 字符串）会把"猜错了"变成静默的假信息。
 */
export interface PluginExportSummary {
  id: string
  name: string
  version: string
  description?: string
  dependsOn: string[]
  hasUninstall: boolean
}

/** worker → 宿主 */
export type PluginWorkerResponse =
  | { ok: true; summaries: PluginExportSummary[] }
  | { ok: false; error: string }

/** 装载单个文件的默认内存上限（MB）：256 足够任何正常插件，又能拦住"加载即吃满内存" */
export const PLUGIN_WORKER_DEFAULT_MEMORY_MB = 256
/** 装载超时（ms）：加载期的死循环只能靠这个拦（worker 里没有"执行到一半"的中断点） */
export const PLUGIN_WORKER_DEFAULT_TIMEOUT_MS = 10_000

/** 把模块导出折成**可序列化摘要**（worker 侧调用；宿主侧不调，避免两套口径） */
export function describePluginExports(mod: Record<string, unknown>): PluginExportSummary[] {
  const out: PluginExportSummary[] = []
  const seen = new Set<unknown>()
  const push = (o: unknown): void => {
    if (Array.isArray(o)) { for (const it of o) push(it); return }
    if (!o || typeof o !== 'object' || seen.has(o)) return
    seen.add(o)
    const x = o as Record<string, unknown>
    if (typeof x['id'] !== 'string') return
    out.push({
      id: x['id'],
      name: typeof x['name'] === 'string' ? x['name'] : x['id'],
      version: typeof x['version'] === 'string' ? x['version'] : '0.0.0',
      ...(typeof x['description'] === 'string' ? { description: x['description'] as string } : {}),
      dependsOn: Array.isArray(x['dependsOn']) ? (x['dependsOn'] as unknown[]).filter((d): d is string => typeof d === 'string') : [],
      hasUninstall: typeof x['uninstall'] === 'function',
    })
  }
  push(mod['default'])
  push(mod['plugin'])
  push(mod['plugins'])
  if (mod['default'] && typeof mod['default'] === 'object') {
    const d = mod['default'] as Record<string, unknown>
    push(d['plugin'])
    push(d['plugins'])
  }
  return out
}
