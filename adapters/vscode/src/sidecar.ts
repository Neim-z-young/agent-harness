/**
 * sidecar 进程：`harness a2a --json --port 0` 的启动、握手与停止。
 *
 * 进程边界的事实（设计稿 §3.1）：harness 是 **Bun**，extension host 是 **Node** ——
 * 两案（HTTP / stdio）都躲不开 spawn。差别只在管道形态。
 *
 * 握手为什么是"读一行 JSON"而不是"解析启动横幅"：`--port 0` 时端口由内核分配，
 * 调用方**只能**从进程输出拿回真实端点；解析带中文标签的多行文案是一个
 * "文案改一个字就静默崩掉"的耦合面。故 CLI 侧做了 `--json`，stdout 只吐这一行
 * （其余人类信息与降级事实全部改走 stderr）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { HANDSHAKE_VERSION, type SidecarHandshake } from './types'

// ========================================================================
// 纯逻辑：握手解析（可单测）
// ========================================================================

export class HandshakeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HandshakeError'
  }
}

const REQUIRED_KEYS = [
  'v',
  'pid',
  'port',
  'protocolVersion',
  'rpcUrl',
  'cardUrl',
  'controlUrl',
  'auth',
  'permissionMode',
  'cwd',
] as const

/**
 * 解析握手行。
 *
 * **刻意严格**：字段缺失 / `v` 高于契约版本 ⇒ 抛错。宁可启动失败并说清楚，
 * 也不要拿着半个 handshake 去连一个不存在的端口（那是"连上了但一直 404"的来源）。
 */
export function parseHandshake(line: string): SidecarHandshake {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    throw new HandshakeError(`握手行不是合法 JSON：${truncate(line)}`)
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new HandshakeError(`握手行不是对象：${truncate(line)}`)
  }
  const rec = obj as Record<string, unknown>

  for (const k of REQUIRED_KEYS) {
    if (rec[k] === undefined) throw new HandshakeError(`握手缺少字段 ${k}：${truncate(line)}`)
  }

  const v = rec['v']
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new HandshakeError(`握手 v 非法：${String(v)}`)
  }
  if (v > HANDSHAKE_VERSION) {
    // 对端比我们新：它可能改了字段语义，硬解析风险太大
    throw new HandshakeError(`握手版本 ${v} 高于本扩展支持的 ${HANDSHAKE_VERSION}，请升级扩展`)
  }

  const auth = rec['auth']
  if (auth !== 'anonymous' && auth !== 'bearer') {
    throw new HandshakeError(`握手 auth 非法：${String(auth)}`)
  }
  const pm = rec['permissionMode']
  if (pm !== 'allow-all' && pm !== 'ask' && pm !== 'deny-all') {
    throw new HandshakeError(`握手 permissionMode 非法：${String(pm)}`)
  }

  return {
    v,
    pid: Number(rec['pid']),
    port: Number(rec['port']),
    protocolVersion: String(rec['protocolVersion']),
    rpcUrl: String(rec['rpcUrl']),
    cardUrl: String(rec['cardUrl']),
    controlUrl: String(rec['controlUrl']),
    auth,
    permissionMode: pm,
    cwd: String(rec['cwd']),
  }
}

/**
 * 从一段 stdout 文本里取出第一个"看起来像握手的 JSON 行"。
 *
 * 为什么不是"直接取第一行"：Bun 启动、插件加载时**可能**往 stdout 打东西
 * （正常情况下 `--json` 已保证没有，但防御性地跳过噪声比断言它干净更划算）。
 */
export function pickHandshakeLine(chunk: string): string | undefined {
  for (const raw of chunk.split('\n')) {
    const line = raw.trim()
    if (line === '' || !line.startsWith('{')) continue
    return line
  }
  return undefined
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

// ========================================================================
// 进程管理
// ========================================================================

export interface SidecarLaunchOptions {
  /** CLI 入口（如 `…/packages/cli/src/index.ts`）或可执行名 */
  readonly cliPath: string
  /** 用什么跑 `.ts` 入口；若 cliPath 本身可执行则留空 */
  readonly runner?: string
  /** 工作区根目录（harness 的 cwd） */
  readonly cwd: string
  /** Bearer token；留空则匿名 */
  readonly token?: string
  /** 握手超时（毫秒） */
  readonly timeoutMs?: number
  /** stderr 转发（用于输出通道） */
  readonly onStderr?: (chunk: string) => void
}

export class SidecarError extends Error {
  constructor(
    message: string,
    /** 已采集到的 stderr 尾部，便于定位启动失败原因 */
    readonly stderrTail?: string,
  ) {
    super(message)
    this.name = 'SidecarError'
  }
}

/** sidecar 进程句柄 */
export class Sidecar {
  private proc: ChildProcess | undefined
  private stderrTail = ''
  private handshake: SidecarHandshake | undefined

  constructor(private readonly opts: SidecarLaunchOptions) {}

  get endpoint(): SidecarHandshake {
    if (!this.handshake) throw new SidecarError('sidecar 尚未完成握手')
    return this.handshake
  }

  get started(): boolean {
    return this.handshake !== undefined
  }

  /** 启动并等握手。**只在成功时** resolve；失败时把进程一起收掉再抛。 */
  async start(): Promise<SidecarHandshake> {
    if (this.handshake) return this.handshake

    const args = this.buildArgs()
    const cmd = this.opts.runner && this.opts.runner !== '' ? this.opts.runner : this.opts.cliPath
    const argv = this.opts.runner && this.opts.runner !== '' ? [this.opts.cliPath, ...args] : args

    // 环境变量：子进程**不能**继承代理，否则对 127.0.0.1 的请求可能被劫持成 502
    // （本仓实测过的坑：shell 里 HTTP_PROXY 指向 127.0.0.1 的本地代理）。
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      delete env[k]
    }
    env['NO_PROXY'] = '127.0.0.1,localhost'
    env['no_proxy'] = '127.0.0.1,localhost'

    const proc = spawn(cmd, argv, {
      cwd: this.opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proc = proc

    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (c: string) => {
      this.stderrTail = (this.stderrTail + c).slice(-4000)
      this.opts.onStderr?.(c)
    })

    const timeoutMs = this.opts.timeoutMs ?? 30_000

    try {
      this.handshake = await this.waitForHandshake(proc, timeoutMs)
    } catch (e) {
      await this.dispose()
      if (e instanceof SidecarError) throw e
      throw new SidecarError(`sidecar 启动失败：${(e as Error).message}`, this.stderrTail)
    }

    // 进程自己挂了（不是我们杀的）⇒ 端点已失效，必须让调用方知道
    proc.on('exit', (code, signal) => {
      this.handshake = undefined
      this.proc = undefined
      const why = signal ? `信号 ${signal}` : `退出码 ${code}`
      this.opts.onStderr?.(`\n[sidecar] 进程已退出（${why}）\n`)
    })

    return this.handshake
  }

  private buildArgs(): string[] {
    // `--port 0`：让内核分配端口，免去"猜端口 / 端口被占 / 残留进程"三类问题。
    // 真实端口由握手回传（`server.ts` 里 `port: 0` 时已回填 `server.port`）。
    const args = ['a2a', '--json', '--port', '0']
    if (this.opts.token && this.opts.token !== '') args.push('--token', this.opts.token)
    return args
  }

  private waitForHandshake(proc: ChildProcess, timeoutMs: number): Promise<SidecarHandshake> {
    return new Promise<SidecarHandshake>((resolve, reject) => {
      let buf = ''
      let done = false

      const timer = setTimeout(() => {
        if (done) return
        done = true
        reject(new SidecarError(`等待握手超时（${timeoutMs}ms）`, this.stderrTail))
      }, timeoutMs)

      const finish = (fn: () => void) => {
        if (done) return
        done = true
        clearTimeout(timer)
        fn()
      }

      proc.stdout?.setEncoding('utf8')
      proc.stdout?.on('data', (chunk: string) => {
        buf += chunk
        const line = pickHandshakeLine(buf)
        if (line === undefined) return
        try {
          const hs = parseHandshake(line)
          finish(() => resolve(hs))
        } catch (e) {
          finish(() => reject(e as Error))
        }
      })

      proc.on('error', (e) => {
        finish(() => reject(new SidecarError(`无法启动 sidecar：${e.message}`, this.stderrTail)))
      })

      proc.on('exit', (code, signal) => {
        // 握手之前就退出 ⇒ 启动失败，把 stderr 一并返回
        finish(() =>
          reject(
            new SidecarError(
              `sidecar 在握手前退出（${signal ? `信号 ${signal}` : `退出码 ${code}`}）`,
              this.stderrTail,
            ),
          ),
        )
      })
    })
  }

  /** 优雅停止：先 SIGTERM，超时再 SIGKILL */
  async dispose(): Promise<void> {
    const proc = this.proc
    this.proc = undefined
    this.handshake = undefined
    if (!proc || proc.exitCode !== null) return

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        resolve()
      }, 3000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      proc.kill('SIGTERM')
    })
  }
}
