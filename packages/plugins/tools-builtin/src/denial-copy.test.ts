/**
 * P2-2：隔离类拒绝文案的**可执行性守卫**。
 *
 * 判据不是"文案好不好看"，而是**能不能自动判**：把每一条"沙箱把调用挡下来了"的路径都走一遍，
 * 断言它的 `error.message` 里带着「怎么改」那一段（前缀常量取自 `@harness/isolation`）。
 *
 * 为什么值得单独一个文件：本仓既有教训是**文案指向给不出所需信息的工具 ⇒ 模型空转**
 * —— 只写"已拒绝"，模型看不到出口，就会换个写法再撞一次同一面墙。把"每条拒绝都必须有出口"
 * 变成一条会变红的断言，它才不会在下一次改文案时悄悄退化。
 *
 * ⚠️ 新增拒绝分支时**必须**来这里加一条：漏加等于该分支不在守卫范围内。
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DENIAL_HOW_PREFIX } from '@harness/isolation'
import type { ToolContext } from '@harness/tool'
import {
  createBashTool,
  createReadFileTool,
  createReadOnlyBashTool,
  readFileTool,
} from './index'

const TMP = mkdtempSync(join(tmpdir(), 'denial-copy-'))

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's1',
    agentId: 'default',
    messageId: 'm1',
    toolUseId: 'tu1',
    signal: new AbortController().signal,
    variables: {},
    cwd: TMP,
    ...overrides,
  }
}

/** 断言一次被拒的调用：错误码对得上，且消息带「怎么改」 */
function expectDenial(res: { ok: boolean; error?: { code?: string; message?: string } }, code: string): void {
  expect(res.ok).toBe(false)
  expect(res.error?.code).toBe(code)
  const message = res.error?.message ?? ''
  expect(message).toContain(DENIAL_HOW_PREFIX)
  // 「怎么改」后面必须有内容 —— 空头衔比没有更糟（看着像给了出口，其实什么都没有）
  const how = message.slice(message.indexOf(DENIAL_HOW_PREFIX) + DENIAL_HOW_PREFIX.length)
  expect(how.replace(/^[:：\s｜|]*/, '').length).toBeGreaterThan(8)
}

describe('P2-2：每条隔离拒绝都要给「怎么改」', () => {
  beforeAll(() => {
    writeFileSync(join(TMP, '.env'), 'SECRET=1')
    writeFileSync(join(TMP, 'big.txt'), 'x'.repeat(4096))
    writeFileSync(join(TMP, 'plain.txt'), 'hello')
  })
  afterAll(() => rmSync(TMP, { recursive: true, force: true }))

  it('read_file 越界（PATH_OUTSIDE_CWD）', async () => {
    const res = await readFileTool.call!({ path: '/etc/hosts' } as never, ctx())
    expectDenial(res as never, 'PATH_OUTSIDE_CWD')
  })

  it('read_file 敏感文件（SANDBOX_READ_DENIED）', async () => {
    const res = await readFileTool.call!({ path: '.env' } as never, ctx())
    expectDenial(res as never, 'SANDBOX_READ_DENIED')
  })

  it('read_file 超过大小闸（SANDBOX_READ_TOO_LARGE）', async () => {
    const tool = createReadFileTool({ maxReadBytes: 64 })
    const res = await tool.call!({ path: 'big.txt' } as never, ctx())
    expectDenial(res as never, 'SANDBOX_READ_TOO_LARGE')
  })

  it('bash 危险命令（SANDBOX_DANGEROUS）—— 不可豁免要写明白', async () => {
    const res = await createBashTool().call!({ command: 'rm -rf /' } as never, ctx())
    expectDenial(res as never, 'SANDBOX_DANGEROUS')
    const msg = String((res as never as { error: { message: string } }).error.message)
    expect(msg).toContain('不可豁免')
  })

  it('bash 出网被网络策略拒（SANDBOX_NET_DENIED）', async () => {
    const tool = createBashTool({ net: 'deny' })
    const res = await tool.call!({ command: 'curl https://example.com' } as never, ctx())
    expectDenial(res as never, 'SANDBOX_NET_DENIED')
  })

  it('bash cwd 越界（SANDBOX_CWD）', async () => {
    const tool = createBashTool({ rootDir: TMP })
    const res = await tool.call!({ command: 'echo hi', cwd: '/etc' } as never, ctx())
    expectDenial(res as never, 'SANDBOX_CWD')
  })

  it('bash 命令不在白名单（SANDBOX_ALLOWLIST）', async () => {
    const tool = createBashTool({ allowlist: ['echo'] })
    const res = await tool.call!({ command: 'ls' } as never, ctx())
    expectDenial(res as never, 'SANDBOX_ALLOWLIST')
  })

  it('bash 宿主回退未获批准（SANDBOX_HOST_DENIED）', async () => {
    const tool = createBashTool({ allowlist: ['echo'], fallbackToHost: true })
    const res = await tool.call!({ command: 'ls' } as never, ctx({
      requestPermission: async () => ({ behavior: 'deny' as const }),
    }))
    expectDenial(res as never, 'SANDBOX_HOST_DENIED')
  })

  it('bash_ro 写特征被拒（只读白名单外的形态）', async () => {
    const res = await createReadOnlyBashTool().call!({ command: 'echo x > out.txt' } as never, ctx())
    expect(res.ok).toBe(false)
    const msg = String((res as never as { error: { message: string } }).error.message)
    expect(msg).toContain(DENIAL_HOW_PREFIX)
  })

  it('bash_ro 引用敏感文件（SANDBOX_READ_DENIED）', async () => {
    const res = await createReadOnlyBashTool().call!({ command: 'cat .env' } as never, ctx())
    expectDenial(res as never, 'SANDBOX_READ_DENIED')
  })
})
