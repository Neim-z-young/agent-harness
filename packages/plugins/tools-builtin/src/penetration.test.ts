/**
 * P3-4：**渗透用例集**（沙箱回归门）。
 *
 * 与 `denial-copy.test.ts` 的分工：那边钉的是**拒绝文案**（被拒了要能说清怎么办），
 * 这边钉的是**边界本身**（攻击者视角能想到的方式都得被挡住）。每条一个大类，逐条自动判。
 *
 * ## 纪律
 * - **不真做破坏性操作**：不 fork bomb、不写满真实磁盘、不出网。用"极小配额 + 极小超时"
 *   让同一条路径在受控条件下暴露（写 1 MB 到 `limits.maxFileSizeKb: 1` 的沙箱里）。
 * - **跨包条目登记在这里**（避免"以为覆盖了其实在别的包"）：
 *   - MCP 子进程 env 泄漏（P0-2）⇒ `packages/plugins/mcp-client/src/index.test.ts`（`buildMcpChildEnv`）
 *   - symlink 逃逸的**判定函数**层（P0-4/P0-5）⇒ `packages/fs-guard/src/index.test.ts`
 *   - 网络目标判定（P1-2）⇒ `packages/isolation/src/index.test.ts`
 *   本文件只覆盖**工具执行层**（策略装到 bash / 文件工具之后还能不能挡住）。
 *
 * ⚠️ 新增沙箱策略时**必须**来这里加一条：策略写在代码里不等于装到工具上（P0-1 的教训
 * 就是"写了但没递进去"），只有走到工具这一层才算真的生效。
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, statSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@harness/tool'
import { buildOsBinding, detectOsBindingFailure, verifyOsBinding } from '@harness/isolation'
import { bashTool, createBashTool, createReadOnlyBashTool, createReadFileTool, readFileTool, writeFileTool } from './index'

const TMP = mkdtempSync(join(tmpdir(), 'penetration-'))

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

/** 轮询等待进程消失（进程树 kill 的判据：孙进程不能活下来） */
async function waitGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0) // 信号 0：只探测是否存活
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      return true
    }
  }
  return false
}

/** 取一次 bash 调用的输出（失败则抛，便于定位是哪条渗透没按预期跑起来） */
async function run(command: string, opts: Record<string, unknown> = {}, overrides: Partial<ToolContext> = {}) {
  const res = await bashTool.call!({ command, ...opts } as never, ctx(overrides))
  expect(res.ok).toBe(true)
  return (res as { output: { stdout: string; stderr: string; exitCode: number; timedOut: boolean } }).output
}

describe('P3-4 渗透用例集（沙箱回归门）', () => {
  beforeAll(() => {
    writeFileSync(join(TMP, '.env'), 'SECRET=1')
    writeFileSync(join(TMP, 'plain.txt'), 'hello')
  })
  afterAll(() => rmSync(TMP, { recursive: true, force: true }))

  // ---------- 1. 路径边界：symlink 逃逸 ----------

  it('① symlink 逃逸（读侧）：cwd 内的软链指向界外 ⇒ read_file 拒（字符串判定会放行）', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pen-out-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'LEAKED')
      symlinkSync(outside, join(TMP, 'escape'))
      const res = await readFileTool.call!({ path: 'escape/secret.txt' } as never, ctx())
      expect(res.ok).toBe(false)
      expect((res as { error: { code: string } }).error.code).toBe('PATH_OUTSIDE_CWD')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('② symlink 逃逸（写侧）：经软链写界外 ⇒ write_file 拒', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pen-out2-'))
    try {
      symlinkSync(outside, join(TMP, 'escape2'))
      const res = await writeFileTool.call!({ path: 'escape2/pwned.txt', content: 'x' } as never, ctx())
      expect(res.ok).toBe(false)
      expect((res as { error: { code: string } }).error.code).toBe('PATH_OUTSIDE_CWD')
      expect(existsSync(join(outside, 'pwned.txt'))).toBe(false) // 真没写出去
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // ---------- 2. env 泄漏 ----------

  it('③ env 泄漏（bash）：敏感名变量在沙箱内读不到（env 默认拒绝）', async () => {
    process.env.__PEN_TEST_API_KEY = 'leak-me'
    try {
      const out = await run('echo "K=$__PEN_TEST_API_KEY"')
      expect(out.stdout.trim()).toBe('K=')
    } finally {
      delete process.env.__PEN_TEST_API_KEY
    }
  })

  it('④ env 后门（bash_ro）：只读工具**不接受** input.env 覆盖（PYTHONSTARTUP / NODE_OPTIONS 这类后门）', async () => {
    // 注：主 bash **允许** input.env（那是调用方显式给的值，不是从宿主 env 里漏出来的），
    // 所以渗透点不在那里；真正的后门是"让只读命令拿到能执行任意代码的环境变量"。
    const res = await createReadOnlyBashTool().call!({
      command: 'echo "K=$__PEN_RO_TOKEN"',
      env: { __PEN_RO_TOKEN: 'leak-me' },
    } as never, ctx())
    expect(res.ok).toBe(true)
    const out = (res as { output: { stdout: string } }).output
    expect(out.stdout.trim()).toBe('K=')
  })

  // ---------- 3. 内网 / 元数据探测 ----------

  it('⑤ 云元数据端点：net=deny 与 net=allowlist 两种策略下都不放行', async () => {
    const target = 'http://169.254.169.254/latest/meta-data/'
    const denied = await createBashTool({ net: 'deny' }).call!({ command: `curl -s ${target}` } as never, ctx())
    expect(denied.ok).toBe(false)
    expect((denied as { error: { code: string } }).error.code).toBe('SANDBOX_NET_DENIED')

    // ★写进白名单也不放行 —— "硬拒"不是"默认拒"
    const allowlisted = await createBashTool({ net: 'allowlist', netAllow: ['169.254.169.254'] })
      .call!({ command: `curl -s ${target}` } as never, ctx())
    expect(allowlisted.ok).toBe(false)
    expect((allowlisted as { error: { code: string } }).error.code).toBe('SANDBOX_NET_DENIED')
  })

  // ---------- 4. 读侧敏感文件与大小闸 ----------

  it('⑥ 敏感文件：read_file .env 被拒（边界内的凭据不是"在工作目录里就能读"）', async () => {
    const res = await readFileTool.call!({ path: '.env' } as never, ctx())
    expect(res.ok).toBe(false)
    expect((res as { error: { code: string } }).error.code).toBe('SANDBOX_READ_DENIED')
  })

  it('⑦ 大小闸：超过 maxReadBytes 直接拒绝，而不是把大文件拉进内存再截', async () => {
    writeFileSync(join(TMP, 'big.bin'), 'x'.repeat(200_000))
    const res = await createReadFileTool({ maxReadBytes: 1024 }).call!({ path: 'big.bin' } as never, ctx())
    expect(res.ok).toBe(false)
    expect((res as { error: { code: string } }).error.code).toBe('SANDBOX_READ_TOO_LARGE')
  })

  // ---------- 5. 资源上限（磁盘写满的类比：单文件配额） ----------

  it('⑧ 单文件配额：limits.maxFileSizeKb=1 时写 100 KB 被 ulimit 拦（不会真写满磁盘）', async () => {
    const tool = createBashTool({ limits: { maxFileSizeKb: 1 } })
    const res = await tool.call!({ command: 'head -c 102400 /dev/zero > quota.bin' } as never, ctx())
    // 拦住的形态是"写失败"（非零退出 / 被 SIGXFSZ 杀），而不是悄悄写成功
    const file = join(TMP, 'quota.bin')
    const wrote = existsSync(file) ? statSync(file).size : 0
    expect(wrote).toBeLessThan(100_000)
    if (res.ok) expect(res.ok).toBe(true) // 工具本身成功，命令结果看文件
  })

  // ---------- 6. 进程树残留 ----------

  it('⑨ 进程树残留：超时后后台孙进程不能活下来（只杀 shell 会留孤儿）', async () => {
    const pidFile = join(TMP, 'gc.pid')
    const tool = createBashTool()
    const res = await tool.call!({
      command: `sleep 20 & echo $! > "${pidFile}"; sleep 20`,
      timeoutMs: 400,
    } as never, ctx())
    expect((res as { output: { timedOut: boolean } }).output.timedOut).toBe(true)
    const gpid = Number((await Bun.file(pidFile).text()).trim())
    expect(Number.isInteger(gpid)).toBe(true)
    expect(await waitGone(gpid)).toBe(true)
  })

  // ---------- 7. 执行期自述（模型/取证看到的是事实） ----------

  it('⑩ 执行期自述：BashOutput.isolation 写的是实际档位（不是配置里的愿望值）', async () => {
    const res = await createBashTool({ isolationLevel: 'L1', net: 'deny' }).call!(
      { command: 'echo hi' } as never,
      ctx(),
    )
    const iso = (res as { output: { isolation?: { level: string; fsBound: boolean; netPolicy: string } } }).output.isolation
    expect(iso).toBeDefined()
    expect(iso!.level).toBe('L1')
    expect(iso!.fsBound).toBe(false) // L1 不是 OS 绑定 —— 自述不许抬高自己
    expect(iso!.netPolicy).toBe('deny')
  })
})

// ===== P1-3：OS 级绑定（L2）—— 唯一一层能挡住 TOCTOU 的墙 =====
//
// 与上面十条的分工：前面钉的是**策略层与进程层**（L0/L1），这里钉的是 **OS 层**。
// 判据刻意选 P0-4 那条老路：**symlink 逃逸写** —— 策略层已经能在"判定"时挡住它，
// 但检查与打开之间换链接（TOCTOU）只有 OS 绑得住。所以这条过了，才算真的有第二道墙。

/** 真机可用性：darwin 有 sandbox-exec 才跑（linux 需 bwrap，CI 上按 skip 计） */
// ⚠️ 刻意**不用**上面那个共享 TMP：它归 `P3-4` 那个 describe 的 afterAll 管，
// 跑到这一节时已经被删掉了（第一次就是这么踩的：spawn 报 ENOENT，而 ENOENT 来自 **cwd 不存在**
// —— posix_spawn 的 ENOENT 分不清"程序不存在"和"工作目录不存在"，排查时别只查前者）。
const OSB_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'penetration-osb-')))
const OS_BINDING = (() => {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return null
  const b = buildOsBinding({ writable: [OSB_DIR] })
  // ★与宿主**同一个判据**：自检跑通才算"本机可用"。
  // 实测踩到过：本机 bun test 跑在 WorkBuddy 的嵌套沙箱里，`sandbox-exec` 再 apply 一层
  // 会被内核拒（`sandbox_apply: Operation not permitted`，exit 71）—— 只看 `existsSync`
  // 就会把"环境不允许"误判成"绑定没生效"，进而在并发时随机红。
  return b && verifyOsBinding(b) ? b : null
})()

describe('P1-3 OS 级绑定（工具执行层）', () => {
  it.skipIf(!OS_BINDING)('可写区内写仍然成功（绑定不能把正常活儿挡了）', async () => {
    const t = createBashTool({ osBinding: OS_BINDING })
    const res = await t.call!({ command: `echo inner > "${join(OSB_DIR, 'osb-inner.txt')}"` } as never, ctx({ cwd: OSB_DIR }))
    const out = (res as { output?: { exitCode: number; stderr: string } }).output
    expect(out?.exitCode).toBe(0)
  })

  it.skipIf(!OS_BINDING)('区外写被 OS 拒（错误信息来自内核，不是我们的策略层）', async () => {
    const t = createBashTool({ osBinding: OS_BINDING })
    // ⚠️ "界外"必须选在 **os.tmpdir() 之外**：绑定默认把 tmp 也列入可写区（多数命令要写它），
    // 选在 tmpdir 里会误判成"没挡住"。`/tmp` 与 tmpdir（/var/folders/...）不是同一个地方。
    const outside = '/tmp/harness-osb-outside.txt'
    const res = await t.call!({ command: `echo outer > "${outside}"` } as never, ctx({ cwd: OSB_DIR }))
    const out = (res as { output?: { exitCode: number; stderr: string } }).output
    expect(out?.exitCode).not.toBe(0)
    expect(out?.stderr).toContain('Operation not permitted')
  })

  it.skipIf(!OS_BINDING)('symlink 逃逸写被挡 —— 策略层之外真的有第二道墙', async () => {
    const esc = '/tmp/harness-osb-escape-target.txt'
    const link = join(OSB_DIR, 'osb-esc')
    if (existsSync(link)) rmSync(link)
    symlinkSync(esc, link)
    const t = createBashTool({ osBinding: OS_BINDING })
    const res = await t.call!({ command: `echo leak > "${link}"` } as never, ctx({ cwd: OSB_DIR }))
    const out = (res as { output?: { exitCode: number; stderr: string } }).output
    expect(out?.exitCode).not.toBe(0)
  })

  it.skipIf(!OS_BINDING)('BashOutput.isolation.fsBound 如实报 true（真绑上了才报）', async () => {
    const t = createBashTool({ osBinding: OS_BINDING, isolationLevel: 'L2' })
    const res = await t.call!({ command: 'echo ok' } as never, ctx({ cwd: OSB_DIR }))
    const out = (res as { output?: { isolation?: { fsBound: boolean; level: string } } }).output
    expect(out?.isolation?.fsBound).toBe(true)
    expect(out?.isolation?.level).toBe('L2')
  })

  afterAll(() => {
    rmSync(OSB_DIR, { recursive: true, force: true })
    for (const f of ['/tmp/harness-osb-outside.txt', '/tmp/harness-osb-escape-target.txt']) {
      try { rmSync(f) } catch { /* 探测文件本来就该写不出来 */ }
    }
  })

  it('★自检 / 真实执行 / fsBound 三者必须一致 —— 三处都在说"到底绑上了没有"', async () => {
    const b = buildOsBinding({ writable: [OSB_DIR] })!
    const selfTest = verifyOsBinding(b)
    const res = await createBashTool({ osBinding: b, isolationLevel: 'L2' })
      .call!({ command: 'echo probe' } as never, ctx({ cwd: OSB_DIR }))
    const out = (res as {
      output?: { exitCode: number; isolation?: { fsBound: boolean; fsBoundFailed?: true } }
    }).output

    // 两种环境都合法，但三处都得给同一个答案：
    // - 干净环境（CI / 普通 shell 派生的进程）：自检 true、命令成功、fsBound true；
    // - **嵌套沙箱**（实测：本机 `bun test` / `bun run` 派生的进程都在宿主沙箱内，
    //   `sandbox-exec` 再 apply 一层被内核拒 `sandbox_apply: Operation not permitted`，
    //   exit 71）：自检 false、命令失败、**fsBound 必须是 false**（否则就是"看起来隔离了"）。
    const reallyBound = out?.exitCode === 0
    expect(selfTest).toBe(reallyBound)
    expect(out?.isolation?.fsBound).toBe(reallyBound)
    // 绑了却被拒 ⇒ 显式标注，别让 stderr 里那句 sandbox_apply 被读成命令自身报错
    if (!reallyBound) expect(out?.isolation?.fsBoundFailed).toBe(true)
  })

  it('★detectOsBindingFailure：只在"内核拒了 apply"时命中（不吞别的失败）', () => {
    expect(detectOsBindingFailure('sandbox-exec: sandbox_apply: Operation not permitted', 'darwin')).toBe(true)
    expect(detectOsBindingFailure('bash: foo: command not found', 'darwin')).toBe(false)
    expect(detectOsBindingFailure('bwrap: Creating new namespace failed: Operation not permitted', 'linux')).toBe(true)
    expect(detectOsBindingFailure('', 'win32')).toBe(false)
  })

  it('没递 osBinding ⇒ fsBound 如实报 false（不模拟：没原语就是没绑）', async () => {
    const t = createBashTool({})
    const res = await t.call!({ command: 'echo ok' } as never, ctx({ cwd: OSB_DIR }))
    const out = (res as { output?: { isolation?: { fsBound: boolean } } }).output
    expect(out?.isolation?.fsBound).toBe(false)
  })
})
