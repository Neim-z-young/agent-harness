/**
 * LM 工具的注册台账（P3-D，设计稿 §14）。
 *
 * 本文件**不 import `vscode`**：`list` / `register` / `log` 全部注入 ⇒ "全量重注册、
 * 部分失败怎么算、旧的什么时候清"这些真正会出错的次序问题可以脱离编辑器单测
 * （与 `launch.ts` 注入 `exists`、`a2a.ts` 注入 `fetchImpl` 同一条分层纪律）。
 *
 * ## 三条次序纪律
 *
 * 1. **先取新清单，再原子换；换的时候先撤旧、再装新**。工具池是运行期可变的（`/tools` 能启停
 *    工具、插件加载会加工具），所以每次刷新都"取一次全量、整体替换"。两条次序各有理由：
 *    **取清单在换之前** ⇒ 取失败的路径不会把已有的清掉；**撤旧在装新之前** ⇒
 *    `lm.registerTool` 对同名重复注册会抛错，而"重启 sidecar 后工具集几乎完全重叠"是最常见的路径。
 * 2. **不做增量 diff**。几十次 `registerTool` 的代价可忽略，而增量 diff 要维持一份
 *    "上次注册了谁"的镜像 —— 多一份状态就多一处失真，且失真的表现是"工具在，但调不动"。
 * 3. **单个注册失败不中断整批**。一个坏名字（超长 / 撞别人）不该让整池工具都注册不上。
 *    失败记进 `skipped` 一起报出来：「部分可用 + 可见原因」优于「全不可用 + 静默」。
 */

import { parseToolList, type LmToolSpec } from './lmtools'

/** 与 `vscode.Disposable` 同形的极小接口（不 import vscode 就能表达"可撤销"） */
export interface DisposableLike {
  dispose(): void
}

export interface ToolRegistrarDeps {
  /** 拉工具清单 —— 生产是 `transport.control('harness/tools.list')` */
  readonly list: () => Promise<unknown>
  /** 注册一个 LM 工具 —— 生产是 `vscode.lm.registerTool(name, tool)` */
  readonly register: (lmName: string, spec: LmToolSpec) => DisposableLike
  /** 日志出口（输出通道）；缺省不写 */
  readonly log?: (msg: string) => void
}

/** 一次刷新的结果（调用方拿去打日志 / 断言；不吞掉失败信息） */
export interface RefreshResult {
  /** 本次成功注册的工具数 */
  readonly registered: number
  /** 被丢弃的条目及原因（解析层 + 注册层合并） */
  readonly skipped: readonly string[]
  /** 出参里的**原始条目数**（与 `registered` 对比可区分"清单为空"与"解析失效"） */
  readonly listed: number
}

export class ToolRegistrar {
  private readonly deps: ToolRegistrarDeps
  private disposables: DisposableLike[] = []
  /**
   * **注册成功**的那些规格（不是"解析出来的"）。
   *
   * 两者必须分清：`refresh` 的计数与 `names` 是**自检面**，若把注册失败的那些也算进来，
   * 诊断信息就会在"恰好有工具注册失败"时撒谎 —— 而那正是唯一需要它说真话的时候。
   * （本字段由 `lm-registrar.test.ts` 的「单个注册失败」用例钉住。）
   */
  private specs: LmToolSpec[] = []

  constructor(deps: ToolRegistrarDeps) {
    this.deps = deps
  }

  /** 当前**已注册成功**的规格（自检 / 用例用） */
  get registered(): readonly LmToolSpec[] {
    return this.specs
  }

  /** 当前已注册的 LM 工具名（自检 / 用例用） */
  get names(): readonly string[] {
    return this.specs.map((s) => s.lmName)
  }

  /**
   * 全量刷新：取清单 → 原子替换。
   *
   * `list()` 抛错时**原样抛出**（不清旧、不改状态）—— 由调用方决定是"保持现状"还是报错；
   * 这里替它决定成"静默清空"是最坏的一种（工具全没了且没人知道为什么）。
   */
  async refresh(): Promise<RefreshResult> {
    const raw = await this.deps.list()
    const { specs, listed, skipped: parseSkipped } = parseToolList(raw)
    const skipped: string[] = [...parseSkipped]

    // ---- 同步块：**先撤旧、再装新** ----
    //
    // 次序不能反：`lm.registerTool` 对**同名重复注册会抛错**，而"重启 sidecar 后工具集
    // 与上次几乎完全重叠"正是最常见的路径 ⇒ 先装新必然在第一个重名工具上炸。
    // （这一条由 `lm-registrar.test.ts` 的「二次刷新」用例钉住：假 register 把 `live`
    // 当成按名字索引的集合，先装新会被随后撤旧的那一轮一起抹掉。）
    //
    // 撤旧先行的代价是"注册失败时旧的一批已经没了" —— 但 `list()` 已经在上面拿到了，
    // 这里不存在"取不到清单"的失败路径；剩下的只有单个工具注册失败，那本来也是逐条 catch。
    for (const d of this.disposables) {
      try {
        d.dispose()
      } catch {
        /* 撤不掉只留个僵尸，不该影响这一轮装新的 */
      }
    }
    this.disposables = []
    this.specs = []

    const next: DisposableLike[] = []
    const ok: LmToolSpec[] = []
    for (const spec of specs) {
      try {
        next.push(this.deps.register(spec.lmName, spec))
        ok.push(spec)
      } catch (e) {
        // 一个坏名字不该拖垮整池（纪律 3）
        skipped.push(`${spec.lmName}：注册失败（${e instanceof Error ? e.message : String(e)}）`)
      }
    }
    this.disposables = next
    this.specs = ok

    const log = this.deps.log
    if (log) {
      log(`[lmtools] 注册 ${next.length}/${listed} 个工具`)
      // 「清单有东西但一条都没解析出来」= 解析层失效，必须显眼（不能像"空清单"那样静默）
      if (listed > 0 && specs.length === 0) log('[lmtools] ⚠️ 清单非空但全部解析失败 —— 大概率是出参形状变了')
      for (const s of skipped) log(`[lmtools] 跳过：${s}`)
    }
    return { registered: next.length, skipped, listed }
  }

  /** 撤掉全部注册（扩展停用 / 需要彻底重置时） */
  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose()
      } catch {
        /* 见 refresh 中同款说明 */
      }
    }
    this.disposables = []
    this.specs = []
  }
}
