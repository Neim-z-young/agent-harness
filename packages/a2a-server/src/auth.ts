/**
 * 认证与调用方隔离（plan §3.5）。
 *
 * ## 为什么"认证"和"隔离"放在同一文件
 * 两者共用同一个**调用方标识**：认证回答"你是谁"，隔离回答"这个会话是不是你的"。
 * 把标识算两遍（认证一处、隔离一处）就会出现"认证按 token、隔离按别的键"这种
 * 两套写法 —— 而隔离是安全边界，错一处就是一处漏洞。故 `callerKey()` 是唯一来源。
 *
 * ## 缺省口径（与 host 的权限接缝同一条安全原则）
 * **未配 token ⇒ 匿名放行**，但此时服务只监听 `127.0.0.1`（见 `server.ts`）——
 * 本机单用户场景不该强迫用户配 token。**配了 token ⇒ 一律要求匹配**，
 * 且卡片必须声明 Bearer 安全方案（`card.ts` 已按"配了才声明"处理）。
 * 这条不能反过来：把"没配 token"解释成"任何人都不用带凭据且仍能被远程访问"才是缺陷。
 */

/** 匿名调用方键（未配 token 时的本机调用方） */
export const LOCAL_CALLER = 'local'

/** 从 `Authorization` 头取 token；不是 `Bearer …` 形态则返回 `undefined` */
export function extractBearer(header: string | null | undefined): string | undefined {
  if (!header) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  const tok = m?.[1]?.trim()
  return tok ? tok : undefined
}

/** 校验 `Authorization` 头。未配 `token` ⇒ 匿名放行（`true`）。 */
export function verifyBearer(header: string | null | undefined, token?: string): boolean {
  if (!token) return true
  return extractBearer(header) === token
}

/**
 * 调用方标识（隔离用）。
 *
 * 配了 token ⇒ 用 token 本身当键（单 token 部署下恒为同一个键，隔离退化为
 * "同一调用方"—— 这是正确的，不是失效；将来支持多 token 时无需改这里）。
 * 未配 token ⇒ `'local'`。
 *
 * ⚠️ 该键**只用于内存比较，绝不落日志 / 不回报**（token 是凭据）。
 */
export function callerKey(header: string | null | undefined, token?: string): string {
  if (!token) return LOCAL_CALLER
  return extractBearer(header) ?? LOCAL_CALLER
}

/**
 * `contextId → 调用方` 归属表。
 *
 * ## 为什么必须隔离
 * `contextId` 就是 harness 的 `sessionId`（`executor` 的 `ensureSession`）——**它会读写
 * 同一份会话历史、同一份工作目录状态**。若别的调用方能凭一个猜测的 `contextId` 接上
 * 别人的会话，就等于读到了别人的对话与文件上下文。故 `contextId` 一旦被某调用方使用，
 * 就**绑定**给它；别的调用方再用同一个 id ⇒ 拒绝（`ContextForbiddenError`）。
 *
 * ## 首次使用即登记（而非预先分配）
 * A2A 不要求客户端先"创建会话"再发消息：客户端自带 `contextId` 就是要复用持久化会话
 * （plan §3.6）。故第一次见到某 `contextId` 即由当前调用方认领，之后校验归属。
 * 客户端**不给** `contextId` 时（服务端自动生成）无从绑定，也不构成跨调用方风险 ——
 * 自动生成的 id 不可能被猜到。
 */
export class CallerRegistry {
  private readonly owners = new Map<string, string>()

  /** 认领/校验 `contextId`；返回 `false` = 已属于别的调用方（调用方应拒绝请求） */
  claim(contextId: string, caller: string): boolean {
    if (!contextId) return true
    const cur = this.owners.get(contextId)
    if (cur === undefined) {
      this.owners.set(contextId, caller)
      return true
    }
    return cur === caller
  }

  /** 某 `contextId` 的归属（自检/测试用） */
  ownerOf(contextId: string): string | undefined {
    return this.owners.get(contextId)
  }

  /** 当前登记的会话数（自检用） */
  get size(): number {
    return this.owners.size
  }

  clear(): void {
    this.owners.clear()
  }
}
