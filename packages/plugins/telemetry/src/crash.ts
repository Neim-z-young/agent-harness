/**
 * 崩溃兜底（异常场景遥测最有价值的一小块）。
 *
 * 仓库已知教训：`process.once('exit')` 覆盖不到信号退出（SIGTERM/SIGHUP 直接终止进程），
 * 所以信号类退出必须单独挂监听。约束：
 *  - **不抢 SIGINT**：REPL/TUI 用它表达"中断当前查询"，遥测不得接管；
 *  - 监听到崩溃只写一条 `telemetry.crash` 并 flush，然后交还原信号/异常默认行为，
 *    保证进程仍按宿主预期终止，不篡改退出语义。
 */

import { createHash } from 'node:crypto'

/** 内存常驻的"最后已知"会话状态，崩溃时用于还原现场 */
export interface CrashState {
  sessionId?: string
  round?: number
  lastKind?: string
}

export interface CrashGuardOpts {
  /** 当前 lastKnown 读取器 */
  getState: () => CrashState
  /** 写一条 crash 事件 */
  recordCrash: (fields: { signal?: string; reason: 'signal' | 'exception' | 'rejection'; stackHash?: string }) => void
  /** 立即 flush 落盘 */
  flush: () => void
}

export interface CrashGuard {
  attach(): void
  detach(): void
}

/** 截断堆栈并算哈希（去重用），避免泄露源码正文 */
export function stackHashStack(stack: string | undefined, limit = 2048): { hash?: string; trace?: string } {
  if (!stack) return {}
  const head = stack.slice(0, limit)
  return { hash: createHash('sha256').update(stack).digest('hex').slice(0, 16), trace: head }
}

const SIGNAL_HANDLED = ['SIGTERM', 'SIGHUP']

export function createCrashGuard(opts: CrashGuardOpts): CrashGuard {
  // 信号监听：写 crash → flush → 交还原默认信号处理（会终止进程）
  const signalHandlers = new Map<string, () => void>()
  const exceptionHandler = (err: Error | unknown) => {
    opts.recordCrash({ reason: 'exception', stackHash: stackHashStack((err as Error)?.stack).hash })
    opts.flush()
    // 交还原默认行为：重新抛出会进默认 uncaughtException → 进程退出
    throw err === undefined ? new Error('uncaughtException') : err
  }
  const rejectionHandler = (reason: unknown) => {
    opts.recordCrash({
      reason: 'rejection',
      stackHash: stackHashStack((reason as Error)?.stack).hash,
    })
    opts.flush()
  }

  return {
    attach() {
      for (const sig of SIGNAL_HANDLED) {
        const handler = () => {
          opts.recordCrash({ signal: sig, reason: 'signal' })
          opts.flush()
          // 移除自身后重发信号，触发该信号默认终止行为（SIGTERM/SIGHUP 默认即退出）
          process.removeListener(sig, handler)
          process.kill(process.pid, sig)
        }
        signalHandlers.set(sig, handler)
        process.on(sig, handler)
      }
      process.on('uncaughtException', exceptionHandler)
      process.on('unhandledRejection', rejectionHandler)
    },
    detach() {
      for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler)
      signalHandlers.clear()
      process.removeListener('uncaughtException', exceptionHandler)
      process.removeListener('unhandledRejection', rejectionHandler)
    },
  }
}