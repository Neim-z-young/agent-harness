/**
 * @harness/tools-web - 网页抓取工具插件
 *
 * 提供：
 * - web_fetch：HTTP(S) 抓取 URL 内容（text / json / base64），支持方法、请求头、超时、请求体
 *
 * 通过 core.tool.pool.assemble Hook 注入到 Harness 工具池。
 *
 * 安全策略：
 * - 允许抓取任意 URL；但拒绝非 http(s) 协议、拒绝 SSRF 目标（私有 IP、localhost 可选拒绝）
 * - permission.key = 'network'（全新权限键，区别于 read/write）
 * - isReadOnly：逻辑上不写本地，但涉及网络，声明为非只读但非破坏性
 */

import { defineTool, fromJsonSchema, Tool, ToolResult, ToolContext } from '@harness/tool'
import type { AgentPlugin, Hooks } from '@harness/plugin'
// SSRF 防护的私有地址判定（P1-2 收敛）：与 bash 的网络出口策略**同一份**。
// 原来这里与 tools-builtin 各写一份（此处 isPrivateIp / 那里一份），正是"修一处漏一处"。
import { isPrivateHost } from '@harness/isolation'

// ========================================================================
// SSRF 防护
// ========================================================================

// ========================================================================
// 1. web_fetch 工具
// ========================================================================

export type WebFetchFormat = 'text' | 'json' | 'base64'

export interface WebFetchInput {
  /** 要抓取的 URL（仅 http/https） */
  url: string
  /** HTTP 方法（默认 GET） */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PATCH' | 'OPTIONS'
  /** 请求头 */
  headers?: Record<string, string>
  /** 请求体（仅 POST/PUT/PATCH 等支持），对象会 JSON 序列化，字符串直接传 */
  body?: string | Record<string, unknown> | unknown[] | Uint8Array
  /** 返回格式：text 文本 / json 解析对象 / base64 原始字节 */
  format?: WebFetchFormat
  /** 超时毫秒（默认 15000） */
  timeoutMs?: number
  /** 是否允许重定向（默认 true） */
  followRedirects?: boolean
  /** 最大响应字节（默认 2MB），超过截断 */
  maxResponseBytes?: number
  /** 是否允许访问私有 IP / localhost（默认 false，SSRF 防护） */
  allowPrivateNetwork?: boolean
}

export interface WebFetchOutput {
  /** HTTP 状态码 */
  status: number
  /** 状态文本 */
  statusText: string
  /** 响应头（小写 key） */
  headers: Record<string, string>
  /** 响应主体（随 format 变化：string / object / base64 string 前缀 data:<mime>;base64,...） */
  body?: unknown
  /** 最终 URL（可能经重定向） */
  finalUrl: string
  /** 响应实际字节数 */
  bytes: number
  /** 是否被截断（超过 maxResponseBytes） */
  truncated: boolean
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export const webFetchTool = defineTool<WebFetchInput, WebFetchOutput>({
  id: 'web_fetch',
  description: '通过 HTTP(S) 抓取 URL 内容。支持自定义方法/头/体，返回 text / json / base64。默认禁止访问私有网络（SSRF 防护）。',
  inputSchema: fromJsonSchema<WebFetchInput>({
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的 URL（仅 http/https；私有网络被 SSRF 防护拒绝）' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH', 'OPTIONS'], description: 'HTTP 方法（默认 GET）' },
      headers: { type: 'object', description: '请求头', additionalProperties: { type: 'string' } },
      body: { description: '请求体（POST/PUT/PATCH 等）：对象会 JSON 序列化，字符串直接传' },
      format: { type: 'string', enum: ['text', 'json', 'base64'], description: '返回格式：text 文本 / json 解析对象 / base64 原始字节' },
      timeoutMs: { type: 'number', description: '超时毫秒（默认 15000）' },
      followRedirects: { type: 'boolean', description: '是否跟随重定向（默认 true）' },
      maxResponseBytes: { type: 'number', description: '最大响应字节数（默认 2MB），超过即截断' },
      allowPrivateNetwork: { type: 'boolean', description: '是否允许访问私有 IP / localhost（默认 false，出于 SSRF 防护）' },
    },
    required: ['url'],
    additionalProperties: false,
  }),
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  permission: {
    key: 'network',
    extractPatterns: (input) => [input.url],
  },
  async call(input, ctx): Promise<ToolResult<WebFetchOutput>> {
    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      return { ok: false, error: { message: `URL 格式无效: ${input.url}`, code: 'INVALID_URL' } }
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: { message: `仅允许 http/https 协议，当前为 ${parsed.protocol}`, code: 'INVALID_PROTOCOL' } }
    }

    const allowPrivate = input.allowPrivateNetwork ?? false
    if (!allowPrivate && isPrivateHost(parsed.hostname)) {
      return {
        ok: false,
        error: { message: `禁止访问私有网络地址 ${parsed.hostname}（SSRF 防护），如确认安全请设置 allowPrivateNetwork=true`, code: 'SSRF_BLOCKED' },
      }
    }

    const timeout = input.timeoutMs ?? 15000
    const maxBytes = Math.min(input.maxResponseBytes ?? DEFAULT_MAX_BYTES, 10 * 1024 * 1024)
    const inner = new AbortController()
    const outerSignal = ctx.signal
    const onOuter = () => inner.abort()
    if (outerSignal) {
      if (outerSignal.aborted) inner.abort()
      else outerSignal.addEventListener('abort', onOuter, { once: true })
    }
    const timer = setTimeout(() => inner.abort(new Error(`web_fetch 超时（>${timeout}ms）`)), timeout)

    try {
      let body: any = input.body
      const headers: Record<string, string> = { ...(input.headers ?? {}) }
      if (body !== undefined) {
        if (typeof body === 'object' && !(body instanceof Uint8Array)) {
          body = JSON.stringify(body)
          if (!headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/json'
          }
        }
      }

      const method = input.method ?? 'GET'
      const redirect = (input.followRedirects ?? true) ? 'follow' : 'manual'

      if (inner.signal.aborted) throw inner.signal.reason ?? new Error('请求已取消')

      const resp = await fetch(parsed.toString(), {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        signal: inner.signal,
        redirect: redirect as any,
      })

      // 收集响应头
      const respHeaders: Record<string, string> = {}
      resp.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v })
      const finalUrl = resp.url || input.url

      // 读取响应字节（有限制）
      let raw: Uint8Array
      let truncated = false
      if (resp.body) {
        const reader = resp.body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            if (total + value.length > maxBytes) {
              const remain = maxBytes - total
              if (remain > 0) chunks.push(value.slice(0, remain))
              total = maxBytes
              truncated = true
              reader.releaseLock()
              try { await (resp.body as any).cancel() } catch {}
              break
            }
            chunks.push(value)
            total += value.length
          }
        }
        const merged = new Uint8Array(total)
        let off = 0
        for (const c of chunks) { merged.set(c, off); off += c.length }
        raw = merged
      } else {
        raw = new Uint8Array(0)
      }

      const format = input.format ?? 'text'
      let outBody: unknown
      if (format === 'text') {
        outBody = new TextDecoder('utf-8', { fatal: false }).decode(raw)
      } else if (format === 'json') {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(raw)
        try {
          outBody = text ? JSON.parse(text) : null
        } catch (e: any) {
          const snippet = text.slice(0, 200).replace(/\n/g, '\\n')
          return {
            ok: false,
            error: { message: `JSON 解析失败: ${e.message}（原始片段前 200 字节：${snippet}）`, code: 'JSON_PARSE_ERROR' },
          }
        }
      } else {
        const mime = respHeaders['content-type']?.split(';')[0].trim() || 'application/octet-stream'
        let b64: string
        if (typeof Buffer !== 'undefined') {
          b64 = Buffer.from(raw).toString('base64')
        } else {
          b64 = btoa(String.fromCharCode(...Array.from(raw)))
        }
        outBody = `data:${mime};base64,${b64}`
      }

      return {
        ok: true,
        output: {
          status: resp.status,
          statusText: resp.statusText,
          headers: respHeaders,
          body: outBody,
          finalUrl,
          bytes: raw.byteLength,
          truncated,
        },
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || inner.signal.aborted) {
        return { ok: false, error: { message: err.message ?? '请求被取消', code: 'ABORTED' } }
      }
      return { ok: false, error: { message: err.message ?? String(err), code: 'FETCH_ERROR' } }
    } finally {
      clearTimeout(timer)
      if (outerSignal) outerSignal.removeEventListener('abort', onOuter)
    }
  },
})

// ========================================================================
// 2. AgentPlugin 入口
// ========================================================================

export const webTools: Tool[] = [webFetchTool]

export function createToolsWebPlugin(options?: {
  toolIds?: string[]
}): AgentPlugin {
  const toolIds = options?.toolIds
  const tools = toolIds ? webTools.filter((t) => toolIds.includes(t.id)) : webTools

  return {
    id: 'tools.web',
    version: '0.1.0',
    name: '网页工具',
    description: '提供 web_fetch 抓取工具',
    async install(ctx) {
      ctx.log.info('网页工具插件已加载', { tools: tools.map((t) => t.id) })
      return {
        async 'core.tool.pool.assemble'(_input, pool) {
          for (const tool of tools) {
            ;(pool as { add: (t: unknown) => void }).add(tool)
          }
        },
      } as Hooks
    },
  }
}

export const toolsWebPlugin: AgentPlugin = createToolsWebPlugin()
