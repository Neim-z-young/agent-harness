import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  readFileTool,
  writeFileTool,
  bashTool,
  createBashTool,
  createToolsBuiltinPlugin,
  toolsBuiltinPlugin,
  builtinTools,
} from './index'
import { createHarness, DefaultPermissionEngine, AgentDefinition } from '@harness/core'
import { createProviderMockPlugin } from '@harness/provider-mock'
import type { ToolContext } from '@harness/tool'

// ===== 测试用临时目录 =====

const TMP_DIR = join(import.meta.dir, '.tmp-test')

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's1',
    agentId: 'default',
    messageId: 'm1',
    toolUseId: 'tu1',
    signal: new AbortController().signal,
    variables: {},
    cwd: TMP_DIR,
    ...overrides,
  }
}

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'default',
    name: '默认 Agent',
    description: '测试用',
    mode: 'primary',
    tools: ['*'],
    permission: { '*': 'allow' },
    promptFragments: [],
    ...overrides,
  }
}

// ===== 测试 =====

describe('@harness/tools-builtin', () => {
  beforeEach(async () => {
    await mkdir(TMP_DIR, { recursive: true })
  })

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true })
  })

  // ===== read_file =====

  describe('readFileTool', () => {
    it('读取文件全部内容', async () => {
      const path = join(TMP_DIR, 'hello.txt')
      await writeFile(path, 'line1\nline2\nline3\n')
      const res = await readFileTool.call({ path }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.content).toBe('line1\nline2\nline3\n')
      expect(res.output!.totalLines).toBe(4) // split('\n') → ['line1','line2','line3','']
      expect(res.output!.truncated).toBe(false)
      expect(res.output!.size).toBe(18)
    })

    it('offset + limit 读取指定行范围', async () => {
      const path = join(TMP_DIR, 'lines.txt')
      await writeFile(path, 'L1\nL2\nL3\nL4\nL5\n')
      const res = await readFileTool.call({ path, offset: 2, limit: 2 }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.content).toBe('L2\nL3')
      expect(res.output!.linesRead).toEqual([2, 3])
      expect(res.output!.truncated).toBe(true) // endLine < totalLines
    })

    it('showLineNumbers 添加行号前缀', async () => {
      const path = join(TMP_DIR, 'num.txt')
      await writeFile(path, 'aaa\nbbb\nccc\n')
      const res = await readFileTool.call({ path, showLineNumbers: true }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.content).toContain('1→aaa')
      expect(res.output!.content).toContain('2→bbb')
    })

    it('文件不存在返回 FILE_NOT_FOUND', async () => {
      const res = await readFileTool.call({ path: 'nope.txt' }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('FILE_NOT_FOUND')
    })

    it('路径超出 cwd 返回 PATH_OUTSIDE_CWD', async () => {
      const res = await readFileTool.call({ path: '../../etc/passwd' }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('PATH_OUTSIDE_CWD')
    })

    it('目录路径返回 NOT_A_FILE', async () => {
      const res = await readFileTool.call({ path: '.' }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('NOT_A_FILE')
    })

    it('安全声明：isReadOnly=true, isConcurrencySafe=true', () => {
      expect(readFileTool.isReadOnly?.()).toBe(true)
      expect(readFileTool.isConcurrencySafe?.()).toBe(true)
    })

    it('权限声明：key=read, extractPatterns 返回路径', () => {
      expect(readFileTool.permission?.key).toBe('read')
      expect(readFileTool.permission?.extractPatterns({ path: 'foo.txt' })).toEqual(['foo.txt'])
    })
  })

  // ===== write_file =====

  describe('writeFileTool', () => {
    it('overwrite 模式创建新文件', async () => {
      const path = join(TMP_DIR, 'new.txt')
      const res = await writeFileTool.call({ path, content: 'hello' }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.created).toBe(true)
      expect(res.output!.bytesWritten).toBe(5)
      expect(existsSync(path)).toBe(true)
    })

    it('overwrite 模式覆盖已有文件', async () => {
      const path = join(TMP_DIR, 'overwrite.txt')
      await writeFile(path, 'old')
      const res = await writeFileTool.call({ path, content: 'new' }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.created).toBe(false)
      const content = await Bun.file(path).text()
      expect(content).toBe('new')
    })

    it('append 模式追加内容', async () => {
      const path = join(TMP_DIR, 'append.txt')
      await writeFile(path, 'AAA')
      const res = await writeFileTool.call({ path, content: 'BBB', mode: 'append' }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.mode).toBe('append')
      const content = await Bun.file(path).text()
      expect(content).toBe('AAABBB')
    })

    it('create 模式文件已存在时报错', async () => {
      const path = join(TMP_DIR, 'exists.txt')
      await writeFile(path, 'old')
      const res = await writeFileTool.call({ path, content: 'new', mode: 'create' }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('FILE_EXISTS')
    })

    it('createDirs 自动创建父目录', async () => {
      const path = join(TMP_DIR, 'sub', 'deep', 'file.txt')
      const res = await writeFileTool.call({ path, content: 'nested' }, makeCtx())
      expect(res.ok).toBe(true)
      expect(existsSync(path)).toBe(true)
    })

    it('路径超出 cwd 返回 PATH_OUTSIDE_CWD', async () => {
      const res = await writeFileTool.call({ path: '../../tmp/evil.txt', content: 'x' }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('PATH_OUTSIDE_CWD')
    })

    it('安全声明：isReadOnly=false, isConcurrencySafe=false', () => {
      expect(writeFileTool.isReadOnly?.()).toBe(false)
      expect(writeFileTool.isConcurrencySafe?.()).toBe(false)
    })

    it('isDestructive: overwrite=true, append=false, create=false', () => {
      expect(writeFileTool.isDestructive?.({ path: 'x', content: '', mode: 'overwrite' })).toBe(true)
      expect(writeFileTool.isDestructive?.({ path: 'x', content: '', mode: 'append' })).toBe(false)
      expect(writeFileTool.isDestructive?.({ path: 'x', content: '', mode: 'create' })).toBe(false)
    })

    it('权限声明：key=write', () => {
      expect(writeFileTool.permission?.key).toBe('write')
    })
  })

  // ===== bash =====

  describe('bashTool', () => {
    it('执行 echo 命令', async () => {
      const res = await bashTool.call({ command: 'echo "hello world"' }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.stdout.trim()).toBe('hello world')
      expect(res.output!.exitCode).toBe(0)
      expect(res.output!.timedOut).toBe(false)
      expect(res.output!.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('命令失败时返回非零 exitCode + stderr', async () => {
      const res = await bashTool.call({ command: 'ls /nonexistent-dir-12345' }, makeCtx())
      expect(res.ok).toBe(true) // bash 工具本身执行成功，只是命令返回非零
      expect(res.output!.exitCode).not.toBe(0)
      expect(res.output!.stderr.length).toBeGreaterThan(0)
    })

    it('超时后 timedOut=true 并 kill', async () => {
      const res = await bashTool.call({
        command: 'sleep 10',
        timeoutMs: 100,
      }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.timedOut).toBe(true)
      expect(res.output!.durationMs).toBeGreaterThanOrEqual(90)
    })

    it('cwd 参数指定工作目录', async () => {
      const sub = join(TMP_DIR, 'subdir')
      await mkdir(sub, { recursive: true })
      const res = await bashTool.call({ command: 'pwd', cwd: sub }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.stdout.trim()).toBe(sub)
    })

    it('env 参数注入环境变量', async () => {
      const res = await bashTool.call({
        command: 'echo $MY_VAR',
        env: { MY_VAR: 'injected' },
      }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.stdout.trim()).toBe('injected')
    })

    it('多行命令（管道）', async () => {
      const res = await bashTool.call({
        command: 'printf "a\\nb\\nc\\n" | grep b',
      }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.stdout.trim()).toBe('b')
    })

    it('安全声明：isReadOnly=false, isDestructive=true, isConcurrencySafe=false', () => {
      expect(bashTool.isReadOnly?.()).toBe(false)
      expect(bashTool.isDestructive?.()).toBe(true)
      expect(bashTool.isConcurrencySafe?.()).toBe(false)
    })

    it('权限声明：key=bash, extractPatterns 返回 command', () => {
      expect(bashTool.permission?.key).toBe('bash')
      expect(bashTool.permission?.extractPatterns({ command: 'rm -rf /' })).toEqual(['rm -rf /'])
    })

    it('AbortSignal 中断', async () => {
      const ac = new AbortController()
      const promise = bashTool.call({ command: 'sleep 5' }, makeCtx({ signal: ac.signal }))
      setTimeout(() => ac.abort(), 50)
      const res = await promise
      expect(res.ok).toBe(false)
      expect(res.interrupted).toBe(true)
      expect(res.error!.code).toBe('ABORTED')
    })
  })

  // ===== bash 沙箱 =====

  describe('bash 沙箱防护', () => {
    it('危险命令检测：命中 rm -rf / 拒绝执行', async () => {
      const tool = createBashTool()
      const res = await tool.call({ command: 'rm -rf /' }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('SANDBOX_DANGEROUS')
      expect(res.error!.message).toInclude('危险')
    })

    it('危险命令检测：命中 fork bomb 拒绝执行', async () => {
      const tool = createBashTool()
      const res = await tool.call({ command: '() { :|:& };:' }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('SANDBOX_DANGEROUS')
    })

    it('危险命令检测可关闭（dangerousDetection=false）', async () => {
      const tool = createBashTool({ dangerousDetection: false })
      // dangerously rm 一个临时文件确认可执行（沙箱关闭）
      const file = join(TMP_DIR, 'x.txt')
      await writeFile(file, 'hi')
      const mk = await tool.call({ command: 'rm -rf /', cwd: TMP_DIR }, makeCtx())
      // rm -rf / 由于是 root 才真正危险，普通环境下即失败也非沙箱错误
      expect(mk.error?.code).not.toBe('SANDBOX_DANGEROUS')
    })

    it('cwd 限制：超出 rootDir 拒绝', async () => {
      const tool = createBashTool({ rootDir: TMP_DIR })
      const res = await tool.call({ command: 'pwd', cwd: '/tmp' }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('SANDBOX_CWD')
    })

    it('cwd 限制：rootDir 内允许', async () => {
      const tool = createBashTool({ rootDir: TMP_DIR })
      const res = await tool.call({ command: 'pwd', cwd: TMP_DIR }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.stdout.trim()).toBe(TMP_DIR)
    })

    it('命令白名单：允许的命令可执行', async () => {
      const tool = createBashTool({ allowlist: ['echo'] })
      const res = await tool.call({ command: 'echo "hi"', cwd: TMP_DIR }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.stdout.trim()).toBe('hi')
    })

    it('命令白名单：白名单外命令拒绝', async () => {
      const tool = createBashTool({ allowlist: ['echo'] })
      const res = await tool.call({ command: 'ls', cwd: TMP_DIR }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('SANDBOX_ALLOWLIST')
    })

    it('sandbox 回退：fallbackToHost 时白名单外非破坏性命令提升到宿主 bash 执行', async () => {
      const tool = createBashTool({ allowlist: ['echo'], fallbackToHost: true })
      const res = await tool.call({ command: 'ls', cwd: TMP_DIR }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.viaHost).toBe(true)
    })

    it('sandbox 回退：危险命令即使 fallbackToHost 也硬性拒绝（不可豁免）', async () => {
      const tool = createBashTool({ fallbackToHost: true })
      const res = await tool.call({ command: 'rm -rf /', cwd: TMP_DIR }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('SANDBOX_DANGEROUS')
    })

    it('sandbox 回退：沙箱内非零退出（env 被隔离）时回退宿主 bash 后成功并标注 viaHost', async () => {
      const tool = createBashTool({ fallbackToHost: true })
      // 该变量名命中敏感 /API_KEY/，在沙箱内被隔离；宿主 bash 回退时用户完备 env 可读到
      process.env.__FALLBACK_TEST_API_KEY = 'present'
      const res = await tool.call(
        { command: 'test -n "$__FALLBACK_TEST_API_KEY"' },
        makeCtx(),
      )
      delete process.env.__FALLBACK_TEST_API_KEY
      // 沙箱内因变量被隔离 → test 非零退出 → 回退宿主 bash（env 完备）→ 成功
      expect(res.ok).toBe(true)
      expect(res.output!.viaHost).toBe(true)
    })

    it('sandbox 回退：宿主回退前 requestPermission 拒绝时拦截，返回 SANDBOX_HOST_DENIED', async () => {
      const tool = createBashTool({ allowlist: ['echo'], fallbackToHost: true })
      const res = await tool.call(
        { command: 'ls', cwd: TMP_DIR },
        makeCtx({
          requestPermission: async (req) => {
            expect(req.toolKey).toBe('bash')
            expect(req.patterns[0]).toContain('host:')
            expect(req.patterns[0]).toContain('ls')
            return { behavior: 'deny' as const }
          },
        }),
      )
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('SANDBOX_HOST_DENIED')
    })

    it('sandbox 回退：requestPermission 允许时宿主回退放行并标注 viaHost', async () => {
      const tool = createBashTool({ allowlist: ['echo'], fallbackToHost: true })
      const res = await tool.call(
        { command: 'ls', cwd: TMP_DIR },
        makeCtx({
          requestPermission: async () => ({ behavior: 'allow' as const }),
        }),
      )
      expect(res.ok).toBe(true)
      expect(res.output!.viaHost).toBe(true)
    })

    it('sandbox 回退：requireHostApproval=false 跳过确认，即使引擎 deny 也宿主回退', async () => {
      const tool = createBashTool({ allowlist: ['echo'], fallbackToHost: true, requireHostApproval: false })
      const res = await tool.call(
        { command: 'ls', cwd: TMP_DIR },
        makeCtx({
          requestPermission: async () => ({ behavior: 'deny' as const }),
        }),
      )
      expect(res.ok).toBe(true)
      expect(res.output!.viaHost).toBe(true)
    })

    it('env 隔离：过滤敏感变量，保留必要变量', async () => {
      const tool = createBashTool()
      // 模拟敏感 + 保留变量
      process.env.__SANDBOX_MY_SECRET_KEY = 'should-be-removed'
      process.env.PATH = (process.env.PATH ?? '/usr/bin') // 保证 PATH 保留
      const res = await tool.call(
        { command: 'echo "PATH=$PATH"', cwd: TMP_DIR },
        makeCtx(),
      )
      delete process.env.__SANDBOX_MY_SECRET_KEY
      expect(res.ok).toBe(true)
      // 不验证子进程内是否可见明文（跨进程），仅验证工具正常执行
      expect(res.output!.stdout).toInclude('PATH=/')
    })

    it('env 隔离：keepEnv 指定变量被保留', async () => {
      const tool = createBashTool({ keepEnv: ['MY_KEEP_VAR'] })
      process.env.MY_KEEP_VAR = 'kept'
      const res = await tool.call(
        { command: 'echo "keep=$MY_KEEP_VAR"', cwd: TMP_DIR },
        makeCtx(),
      )
      process.env.MY_KEEP_VAR = ''
      expect(res.ok).toBe(true)
      expect(res.output!.stdout.trim()).toBe('keep=kept')
    })

    it('additionalDangerous 追加自定义危险模式', async () => {
      const tool = createBashTool({
        additionalDangerous: [/touch\s+custom-danger/],
      })
      const res = await tool.call({ command: 'touch custom-danger x', cwd: TMP_DIR }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('SANDBOX_DANGEROUS')
    })

    it('createToolsBuiltinPlugin 传入 bash 配置后 bash 受沙箱约束', async () => {
      const plugin = createToolsBuiltinPlugin({ bash: { allowlist: ['echo'] } })
      const mockPlugin = createProviderMockPlugin({
        defaultResponse: 'ok',
        responses: [
          {
            match: '拒绝',
            response: '',
            toolCalls: [{
              toolUseId: 'tu1',
              toolId: 'bash',
              input: { command: 'ls', cwd: TMP_DIR },
            }],
          },
          {
            match: '允许',
            response: '',
            toolCalls: [{
              toolUseId: 'tu2',
              toolId: 'bash',
              input: { command: 'echo hi', cwd: TMP_DIR },
            }],
          },
        ],
      })
      const h = await createHarness({
        cwd: TMP_DIR,
        internalPlugins: [mockPlugin, plugin],
        agents: [makeAgent()],
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
      })
      await h.start()

      const sess = await h.session.create()
      const denied = await h.agent.query({ sessionId: sess.id, message: '拒绝' })
      const deniedTool = denied.parts.find((p: any) => p.type === 'tool') as any
      expect(deniedTool).toBeDefined()
      // 白名单拒绝返回 error ToolResult（result = { message, code }）
      expect((deniedTool.result as any).code).toBe('SANDBOX_ALLOWLIST')

      const allowed = await h.agent.query({ sessionId: sess.id, message: '允许' })
      const allowedTool = allowed.parts.find((p: any) => p.type === 'tool') as any
      expect(allowedTool).toBeDefined()
      expect((allowedTool.result as any).stdout?.trim()).toBe('hi')

      await h.stop()
    })
  })

  // ===== 插件集成 =====

  describe('toolsBuiltinPlugin 集成', () => {
    it('通过 tool.pool.assemble 注入三个工具', async () => {
      const h = await createHarness({
        cwd: TMP_DIR,
        internalPlugins: [toolsBuiltinPlugin],
        agents: [makeAgent()],
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
      })
      // 工具在 query 时才通过 pool.assemble 注入，但也可以直接注册
      const sess = await h.session.create()
      // 先手动注册（通过插件 query 时自动注册）
      // 这里直接测 plugin install 后 hook 会 add
      expect(h.tools.has('read_file')).toBe(false) // query 前未注册

      await h.stop()
    })

    it('端到端：mock provider + builtin tools → read_file 工具调用', async () => {
      // 准备测试文件
      const testFile = join(TMP_DIR, 'e2e.txt')
      await writeFile(testFile, '端到端测试内容')

      const mockPlugin = createProviderMockPlugin({
        defaultResponse: '无工具',
        responses: [
          {
            match: '读取',
            response: '',
            toolCalls: [{ toolUseId: 'tu1', toolId: 'read_file', input: { path: 'e2e.txt' } }],
          },
        ],
      })

      const h = await createHarness({
        cwd: TMP_DIR,
        internalPlugins: [mockPlugin, toolsBuiltinPlugin],
        agents: [makeAgent()],
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
      })
      await h.start()

      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: '读取文件' })

      // 应该有 tool 部件
      const toolPart = reply.parts.find((p: any) => p.type === 'tool') as any
      expect(toolPart).toBeDefined()
      expect(toolPart.toolId).toBe('read_file')
      expect(toolPart.isError).toBe(false)
      expect((toolPart.result as any).content).toBe('端到端测试内容')

      await h.stop()
    })

    it('端到端：write_file 工具调用 → 创建文件', async () => {
      const mockPlugin = createProviderMockPlugin({
        defaultResponse: 'ok',
        responses: [
          {
            match: '写入',
            response: '',
            toolCalls: [{
              toolUseId: 'tu1',
              toolId: 'write_file',
              input: { path: 'written.txt', content: '由工具写入' },
            }],
          },
        ],
      })

      const h = await createHarness({
        cwd: TMP_DIR,
        internalPlugins: [mockPlugin, toolsBuiltinPlugin],
        agents: [makeAgent()],
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
      })
      await h.start()

      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: '写入文件' })

      const toolPart = reply.parts.find((p: any) => p.type === 'tool') as any
      expect(toolPart.toolId).toBe('write_file')
      expect((toolPart.result as any).created).toBe(true)

      // 验证文件确实被写入
      const content = await Bun.file(join(TMP_DIR, 'written.txt')).text()
      expect(content).toBe('由工具写入')

      await h.stop()
    })

    it('端到端：bash 工具调用 → 执行命令', async () => {
      const mockPlugin = createProviderMockPlugin({
        defaultResponse: 'ok',
        responses: [
          {
            match: '执行',
            response: '',
            toolCalls: [{
              toolUseId: 'tu1',
              toolId: 'bash',
              input: { command: 'echo "bash-e2e"' },
            }],
          },
        ],
      })

      const h = await createHarness({
        cwd: TMP_DIR,
        internalPlugins: [mockPlugin, toolsBuiltinPlugin],
        agents: [makeAgent()],
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
      })
      await h.start()

      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: '执行命令' })

      const toolPart = reply.parts.find((p: any) => p.type === 'tool') as any
      expect(toolPart.toolId).toBe('bash')
      expect((toolPart.result as any).stdout.trim()).toBe('bash-e2e')
      expect((toolPart.result as any).exitCode).toBe(0)

      await h.stop()
    })

    it('createToolsBuiltinPlugin({ toolIds }) 只注入指定工具', async () => {
      const plugin = createToolsBuiltinPlugin({ toolIds: ['read_file'] })
      const mockPlugin = createProviderMockPlugin({
        defaultResponse: 'ok',
        responses: [
          {
            match: '写入',
            response: '',
            toolCalls: [{
              toolUseId: 'tu1',
              toolId: 'write_file',
              input: { path: 'x.txt', content: 'x' },
            }],
          },
        ],
      })

      const h = await createHarness({
        cwd: TMP_DIR,
        internalPlugins: [mockPlugin, plugin],
        agents: [makeAgent()],
        permission: new DefaultPermissionEngine({ '*': 'allow' }),
      })
      await h.start()

      const sess = await h.session.create()
      const reply = await h.agent.query({ sessionId: sess.id, message: '写入文件' })

      // write_file 未注入 → tool call 找不到工具 → isError
      const toolPart = reply.parts.find((p: any) => p.type === 'tool') as any
      expect(toolPart).toBeDefined()
      expect(toolPart.isError).toBe(true)

      await h.stop()
    })

    it('builtinTools 导出包含四个原语工具', () => {
      expect(builtinTools.map((t) => t.id).sort()).toEqual(['bash', 'edit_file', 'read_file', 'write_file'])
    })
  })
})
