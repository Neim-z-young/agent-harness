/**
 * 权限接缝：四态答复 + 交互引擎（P0 收尾 S2 第二步）
 *
 * ## 为什么必须上移（而不是让每个宿主各写一份 ask）
 * 今天「**先判永久（`A`/`always`）→ 写回规则集 → 再判单次**」这套顺序只写在 `@harness/cli`
 * 的 `CliPermissionEngine.ask` 里。A2A server / VSCode 扩展各起一份实现，就是**同一语义两套写法**
 * —— 将来「always 到底该写 `tool` 还是 `global` 规则」改一处漏一处，而权限是安全边界，
 * 漏一处就是漏一处漏洞。上移后只有这一份。
 *
 * ## 三条接缝（本文件只做前两条，第三条 P1 接）
 * | 接缝 | 归属 | 说明 |
 * |---|---|---|
 * | **问什么**（`PermissionPrompt`） | 本文件 | 结构（`toolKey` / `patterns`）+ 一段默认文案（`text`） |
 * | **怎么问到答复**（`PermissionAsker`） | 宿主 | CLI = readline/TUI 模态；A2A = 挂起任务等答复；VSCode = webview 授权卡 |
 * | **问到之后怎么记**（四态 → 规则写回） | 本文件 | 三个宿主共用一份 |
 *
 * `asker` 刻意返回**四态**而不是原始文本：远程宿主不该做「伪造一段文本、再解析回来」的往返
 * （那是把 CLI 的输入词汇表当成协议）。文本 → 四态的翻译属 CLI 的输入词汇（`y/n/a/d/A/D`），
 * 留在 `@harness/cli`。
 *
 * ## 缺省行为（宿主不给 `asker` 时）
 * 与 `DefaultPermissionEngine` 的 ask→deny 语义一致：**取不到答复 ⇒ deny**。
 * 这条不能反过来 —— 一个"问不到用户就放行"的默认值是安全缺陷，不是便利。
 */
import { DefaultPermissionEngine } from '@harness/core'
import type { PermissionDecision, PermissionRequest } from '@harness/core'

/** 规范答复四态。`always-*` 会写回规则集并置 `remember=true` */
export type PermissionAnswer = 'allow' | 'deny' | 'always-allow' | 'always-deny'

/**
 * 询问接缝实际依赖的输入面。
 *
 * 刻意**收窄**到引擎与路由真正要的三项，而不是整个 `PermissionRequest`：引擎读
 * `toolKey` / `patterns`，`sessionId` 则供 **asker 路由**（见下）。其余字段（`input` 等）
 * 引擎与提问材料的组装都不碰，写进契约只会让每个调用点（含测试桩）多伪造一个字段。
 * 宽类型（完整 `PermissionRequest`）传进来天然兼容 —— 依赖倒置，不是第二份定义。
 *
 * ## 为什么 `sessionId` 要进这个"窄"契约
 * `asker` 是**全局单槽**（`InteractivePermissionEngine.setAsker`），而宿主可以并存多个询问源
 * （TUI 里的 Agent、A2A 任务、进程内 MCP server）。收窄时若把归属信息一并裁掉，包装型
 * asker 就无从判断"这次询问该由谁应答"，只能靠"当前谁在忙"这类不可靠标志（并发不安全）。
 * 故它是**路由的最小必要信息**，与"引擎要读什么"是两条独立理由，不能按同一条规则裁。
 */
export type PermissionAskInput = Pick<PermissionRequest, 'toolKey' | 'patterns' | 'sessionId'>

/** 交互模式：`allow-all` / `deny-all` 直接短路，只有 `ask` 才走 asker */
export type PermissionMode = 'allow-all' | 'ask' | 'deny-all'

/**
 * 宿主无关的提问材料。
 *
 * `text` 是**默认渲染**的完整问题（CLI 直接拿去 readline）；远程宿主可以只用 `summary`
 * 落任务 metadata，也可以完全不用 —— 它是默认值，不是唯一值。
 */
export interface PermissionPrompt {
  toolKey: string
  patterns: string[]
  /** 会话归属，透传自 `PermissionAskInput`（asker 路由用；无归属时为 undefined） */
  sessionId?: string
  /** 一句话摘要，如 `权限请求 [bash] rm -rf /tmp/x`（CLI 的 readline 首行就是它） */
  summary: string
  /** 默认完整问题（含操作说明与 `[a/d/A/D]` 提示），CLI 逐字使用 */
  text: string
}

/**
 * 询问接缝。返回 `undefined` = 取不到答复 ⇒ 引擎按 **deny** 处理（与既有 readline 兜底一致）。
 * 抛错不在此处捕获：让宿主自己决定是回退 deny 还是暴露故障。
 */
export type PermissionAsker = (
  req: PermissionAskInput,
  prompt: PermissionPrompt,
) => Promise<PermissionAnswer | undefined>

/** 规则持久化（`<data-dir>/permissions.json`） */
export interface PermissionStoreFile {
  rules: Record<string, unknown> // 对应 PermissionRuleset
}

/**
 * 组装默认提问材料。**文案与改造前逐字一致**（`cli.test.ts` 的权限用例与真机输出都钉着它）：
 * 首行 `⚠️  权限请求 [<toolKey>] <patterns>`（注意 `⚠️` 后是两个空格），次行是操作说明。
 */
export function buildPermissionPrompt(req: PermissionAskInput): PermissionPrompt {
  const patterns = req.patterns ?? []
  const pat = patterns.slice(0, 3).join(', ') || '(无路径)'
  const summary = `权限请求 [${req.toolKey}] ${pat}`
  return {
    toolKey: req.toolKey,
    patterns,
    sessionId: req.sessionId,
    summary,
    text:
      `\n⚠️  ${summary}\n` +
      `  操作: allow / deny / always(a) / deny-always(d)? [a/d/A/D] `,
  }
}

/**
 * 交互式权限引擎：在 `DefaultPermissionEngine`（四级规则匹配）之上补三件事 ——
 * ① 交互模式短路；② 四态答复；③ `always-*` 的规则写回与落盘。
 *
 * 三个宿主共用这一份；宿主差异全部收在 `asker` 里。
 */
export class InteractivePermissionEngine extends DefaultPermissionEngine {
  private mode: PermissionMode
  private asker: PermissionAsker | undefined
  private readonly store: (PermissionStoreFile & { save?: (r: Record<string, unknown>) => Promise<void> }) | undefined

  constructor(
    rules: Record<string, unknown> = { '*': 'ask' },
    opts: {
      store?: PermissionStoreFile & { save?: (r: Record<string, unknown>) => Promise<void> }
      mode?: PermissionMode
      asker?: PermissionAsker
    } = {},
  ) {
    super(rules as never)
    this.store = opts.store
    this.mode = opts.mode ?? 'ask'
    this.asker = opts.asker
  }

  /** 当前交互模式（allow-all / ask / deny-all），供 /permission 查看与切换 */
  getMode(): PermissionMode {
    return this.mode
  }

  /** 切换交互模式（不影响持久化规则，仅影响「询问型请求」的自动答复） */
  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  /** 替换询问交互器（TUI 在启动后注入模态审批，替代默认 readline 行内提问） */
  setAsker(fn?: PermissionAsker): void {
    this.asker = fn
  }

  /**
   * 当前询问交互器（`undefined` = 未装，此时 ask → deny）。
   *
   * 存在的理由：**新增的询问源需要"包装"而不是"替换"现有 asker**。典型场景是进程内
   * MCP server —— 它只能处理"属于自己会话"的询问（`PermissionAskInput.sessionId`），
   * 其余的必须交回原 asker，否则就把 TUI 的模态审批顶掉了。没有 getter 时拿不到被包装者，
   * "包装"只能退化成"替换" ⇒ 两个询问源互相顶掉、先装的那个静默失效。
   */
  getAsker(): PermissionAsker | undefined {
    return this.asker
  }

  /**
   * 询问：`allow-all` / `deny-all` 直接短路；否则经 `asker` 取四态答复。
   * 无法识别的答复与取不到答复一律 deny（与改造前逐位一致）。
   */
  override async ask(req: PermissionAskInput): Promise<PermissionDecision> {
    if (this.mode === 'allow-all') return { behavior: 'allow', matchedRule: 'global' }
    if (this.mode === 'deny-all') return { behavior: 'deny', matchedRule: 'global' }
    const answer = this.asker ? await this.asker(req, buildPermissionPrompt(req)) : undefined
    switch (answer) {
      // 先判"永久"：写回规则集并置 remember，宿主重启后不再问
      case 'always-allow':
        await this.rememberRule(req.toolKey, 'allow')
        return { behavior: 'allow', matchedRule: 'tool', remember: true }
      case 'always-deny':
        await this.rememberRule(req.toolKey, 'deny')
        return { behavior: 'deny', matchedRule: 'tool', remember: true }
      // 单次：只影响本次
      case 'allow':
        return { behavior: 'allow', matchedRule: 'tool' }
      case 'deny':
        return { behavior: 'deny', matchedRule: 'tool' }
      default:
        return { behavior: 'deny', matchedRule: 'global' }
    }
  }

  /** 把「永久」答复写回规则集并落盘（`updateRules` 改内存，`save` 落盘，两者必须一起） */
  private async rememberRule(toolKey: string, behavior: 'allow' | 'deny'): Promise<void> {
    const updated = { ...this.getRules(), [toolKey]: behavior }
    this.updateRules(updated as never)
    await this.store?.save?.(updated)
  }
}
