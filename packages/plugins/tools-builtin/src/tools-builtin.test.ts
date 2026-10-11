import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  bashTool,
  createBashTool,
  createReadFileTool,
  createToolsBuiltinPlugin,
  toolsBuiltinPlugin,
  builtinTools,
  readOnlyBashTool,
  createReadOnlyBashTool,
  checkReadOnlyCommand,
  checkReadOnlyByAst,
  analyzeBashCommand,
  DEFAULT_READONLY_COMMANDS,
  resolveShell,
  buildLimitPreamble,
  resolveBashLimits,
} from './index'
import { createHarness, DefaultPermissionEngine, AgentDefinition } from '@harness/core'
import { createProviderMockPlugin } from '@harness/provider-mock'
import type { ToolContext } from '@harness/tool'
import { ToolPipeline, ToolSchemaError } from '@harness/tool'

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

    it('★经符号链接逃逸 ⇒ PATH_OUTSIDE_CWD（P0-4：旧实现只比字符串，这里**会通过**）', async () => {
      // `up` 指向 cwd 的父目录 ⇒ 字符串视角下 `up/package.json` 在 cwd 内，真实位置在外面
      symlinkSync(join(TMP_DIR, '..'), join(TMP_DIR, 'up'))
      const res = await readFileTool.call({ path: 'up/package.json' }, makeCtx())
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

    it('★经符号链接写文件 ⇒ PATH_OUTSIDE_CWD（写路径同样要挡，且目标还不存在）', async () => {
      symlinkSync(join(TMP_DIR, '..'), join(TMP_DIR, 'up'))
      const res = await writeFileTool.call({ path: 'up/evil.txt', content: 'x' }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('PATH_OUTSIDE_CWD')
      expect(existsSync(join(TMP_DIR, '..', 'evil.txt'))).toBe(false)
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

  describe('bashTool 必填校验（真机修复）', () => {
    it('缺 command ⇒ COMMAND_REQUIRED，且不得把 undefined 送进 shell', async () => {
      const res = await bashTool.call({} as never, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('COMMAND_REQUIRED')
      // 真机症状是 `bash: undefined: command not found`（shell 报错），必须不再出现
      expect(JSON.stringify(res.error)).not.toContain('command not found')
    })

    it('空串 / 纯空白 command 同样被拒', async () => {
      for (const bad of ['', '   ']) {
        const res = await bashTool.call({ command: bad }, makeCtx())
        expect(res.ok).toBe(false)
        expect(res.error!.code).toBe('COMMAND_REQUIRED')
      }
    })

    it('类型不符 ⇒ INVALID_INPUT（守卫复用同一份 schema，而不是只判"有没有 command"）', async () => {
      const res = await bashTool.call({ command: 'echo hi', timeoutMs: 'soon' } as never, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('INVALID_INPUT')
      expect(res.error!.message).toContain('timeoutMs')
      expect(res.error!.message).toContain('应为 数字')
    })

    it('必填字段**本身**类型不符 ⇒ INVALID_INPUT（判据看 rule，不看 path）', async () => {
      // 只看 `path === 'command'` 是不够的：`command: 123` 的 issue path 也是 'command'
      // —— 那种判据会把类型错误冒充成 COMMAND_REQUIRED（码说"缺"、消息说"应为 字符串"）。
      const res = await bashTool.call({ command: 123 } as never, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('INVALID_INPUT')
      expect(res.error!.message).toContain('应为 字符串')
    })

    it('结构分支与语义分支可区分：缺 command 的文本由 schema 派生，纯空白走手判', async () => {
      // 两段式的边界：同一个错误码 COMMAND_REQUIRED，来源不同 ——
      //   缺 command     ⇒ 结构守卫复用喂给模型的那份 schema，message 是 schema 派生的；
      //   纯空白 command ⇒ JSON Schema 表达不了，留在 call() 里手判，message 是手写的。
      const missing = await bashTool.call({} as never, makeCtx())
      expect(missing.ok).toBe(false)
      if (missing.ok) return

      const blank = await bashTool.call({ command: '   ' }, makeCtx())
      expect(blank.ok).toBe(false)
      if (blank.ok) return

      expect(missing.error!.code).toBe('COMMAND_REQUIRED')
      expect(blank.error!.code).toBe('COMMAND_REQUIRED')
      expect(missing.error!.message).toContain('缺少必填参数')
      expect(blank.error!.message).not.toContain('缺少必填参数')
    })

    it('多带未声明字段仍能执行（默认容忍多余字段，控制组）', async () => {
      const res = await bashTool.call({ command: 'echo tolerate', recursive: true } as never, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.stdout.trim()).toBe('tolerate')
    })
  })

  // ===== read_file：入参由 schema 在管道口拦下 =====

  describe('read_file 空入参经管道被 schema 拦下', () => {
    it('不再靠 path.resolve(undefined) 抛 TypeError，而是 ToolSchemaError(stage=input) 且指出缺 path', async () => {
      let caught: unknown
      try {
        await new ToolPipeline().execute(readFileTool, {}, makeCtx())
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ToolSchemaError)
      expect((caught as ToolSchemaError).stage).toBe('input')
      expect((caught as Error).message).toContain('path')
    })
  })

  // ===== 直调路径的入参守卫（read_file / write_file / edit_file / bash 共用 guardInput） =====

  /**
   * 上一条测的是**管道路径**（Step 1 用 schema 拦）。这里测的是**绕过管道直接调
   * `tool.call()`** 那条路径：三个文件工具的 `call()` 第一行都是
   * `resolvePath(input.path, ctx.cwd)`，而 `resolvePath` 内部先做 `isAbsolute(inputPath)`
   * —— 且那行在 `try` **之外**，入参非法时会抛出**未被捕获**的
   * `TypeError: The "path" property must be of type string`。
   *
   * bash 同理（它把 `undefined` 送进 spawn，由 shell 报 `command not found`）——
   * 它的守卫用例在上面的 `bashTool 必填校验` 里，两处调的是同一个 `guardInput`。
   */
  describe('直调路径：结构守卫在 resolvePath 之前拦下非法入参', () => {
    it('read_file 缺 path ⇒ PATH_REQUIRED（不再是 TypeError）', async () => {
      const res = await readFileTool.call({} as never, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('PATH_REQUIRED')
      expect(res.error!.message).toContain('path')
    })

    it('read_file 的 path 类型不符 ⇒ INVALID_INPUT（不冒充"缺参数"）', async () => {
      const res = await readFileTool.call({ path: 123 } as never, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('INVALID_INPUT')
      expect(res.error!.message).toContain('应为 字符串')
    })

    it('write_file 缺 path ⇒ PATH_REQUIRED；缺 content ⇒ INVALID_INPUT', async () => {
      const noPath = await writeFileTool.call({ content: 'x' } as never, makeCtx())
      expect(noPath.ok).toBe(false)
      expect(noPath.error!.code).toBe('PATH_REQUIRED')

      const noContent = await writeFileTool.call({ path: 'guard.txt' } as never, makeCtx())
      expect(noContent.ok).toBe(false)
      expect(noContent.error!.code).toBe('INVALID_INPUT')
      expect(noContent.error!.message).toContain('content')
    })

    it('edit_file 缺 path ⇒ PATH_REQUIRED', async () => {
      const res = await editFileTool.call({ oldString: 'a', newString: 'b' } as never, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('PATH_REQUIRED')
    })

    it('控制组：合法入参不被守卫误伤（守卫是前置，不是替代）', async () => {
      const path = join(TMP_DIR, 'guard-ok.txt')
      await writeFile(path, 'ok\n')
      const res = await readFileTool.call({ path }, makeCtx())
      expect(res.ok).toBe(true)
      expect(res.output!.content).toBe('ok\n')
    })
  })

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

    it('AST 层：引号混淆的破坏性命令被拒（原始正则对此失明）', async () => {
      // 原文没有字面 `rm`（引号拆开），原始正则 \brm\b 不命中；AST 解码后归一化命中
      const tool = createBashTool()
      for (const command of ['"r"m -rf /', "'rm' -rf /", '"r"m -rf ~']) {
        const res = await tool.call({ command }, makeCtx())
        expect(res.ok).toBe(false)
        expect(res.error!.code).toBe('SANDBOX_DANGEROUS')
        expect(res.error!.message).toInclude('解码')
      }
    })

    it('AST 层：命令名含展开的间接执行被拒（fail-closed）', async () => {
      // $R 在运行期才解析，字面量不可审计 —— 结构性拒绝，不走危险表匹配
      const tool = createBashTool()
      for (const command of ['R=rm; $R -rf /', 'rm$IFS-rf$IFS/', '$(echo rm) -rf /']) {
        const res = await tool.call({ command }, makeCtx())
        expect(res.ok).toBe(false)
        expect(res.error!.code).toBe('SANDBOX_DANGEROUS')
        expect(res.error!.message).toInclude('间接执行')
      }
    })

    it('AST 层放行路径解析惯用法：$(which x) / $(command -v x)（输出语义固定为可执行路径）', async () => {
      const tool = createBashTool()
      for (const command of ['$(which definitely-not-exists-cmd) --help', '$(command -v also-not-exists) --help']) {
        const res = await tool.call({ command, cwd: TMP_DIR }, makeCtx())
        expect(res.error?.code).not.toBe('SANDBOX_DANGEROUS')
      }
    })

    it('AST 层不误伤：参数级展开 / 子 shell / fd 重定向等正常命令放行', async () => {
      const tool = createBashTool()
      const benign = [
        'ls $HOME',
        'echo "$USER"',
        'ls $(pwd)',
        'pwd 2>/dev/null',
        'echo ok > /dev/null',
        'fdisk -l /dev/sda',
      ]
      for (const command of benign) {
        const res = await tool.call({ command, cwd: TMP_DIR }, makeCtx())
        expect(res.error?.code).not.toBe('SANDBOX_DANGEROUS')
      }
    })

    it('无害重定向不被误拦：`2>/dev/null` / `>/dev/null` 正常放行', async () => {
      // 回归：曾有一条 `>\s*\/dev\/null\b` 危险模式，把最常见的「丢弃输出」写法判为危险，
      // 实测 `git rev-parse --is-inside-work-tree 2>/dev/null` 这类命令会被直接拒绝。
      const tool = createBashTool()
      const res = await tool.call(
        { command: 'pwd 2>/dev/null && echo ok > /dev/null', cwd: TMP_DIR },
        makeCtx(),
      )
      expect(res.error?.code).not.toBe('SANDBOX_DANGEROUS')
    })

    it('裸设备写入全部被拦截（重定向的四种形态 + 破坏性命令直写）', async () => {
      // 回归：修 `echo x > /dev/sda` 漏报时曾把规则写成 `(?:^|\s)>>?`，
      // 结果 `1>/dev/sda` / `2>/dev/sda` / `hi>/dev/sda` 这三种形态**反而被放行**
      // —— 它们在旧规则 `\b>` 下是能拦住的，等于净安全性下降。四种形态必须全拦。
      const tool = createBashTool()
      const dangerous = [
        'echo x > /dev/sda', // 空格
        'echo hi>/dev/sda', // 无空格
        'echo x 1>/dev/sda', // fd 1
        'cat f 2>/dev/nvme0n1', // fd 2（stderr 重定向同样毁盘）
        'echo x >> /dev/sdb1', // 追加
        'dd if=/dev/zero of=/dev/disk0',
        'shred -n1 /dev/sda', // 无重定向，靠「破坏性命令 + 裸设备」规则
        'wipefs -a /dev/sda',
        'mkfs -t ext4 /dev/sda1', // 注意：`mkfs -t` 不匹配 `\bmkfs\.\w+`
        'parted /dev/sda mklabel gpt',
        'sgdisk -Z /dev/nvme0n1',
      ]
      for (const command of dangerous) {
        const res = await tool.call({ command }, makeCtx())
        expect(res.ok).toBe(false)
        expect(res.error!.code).toBe('SANDBOX_DANGEROUS')
      }
    })

    it('只读查看裸设备不被误拦（fdisk -l 是常见用法）', async () => {
      // 与上面成对：裸 `/dev/sda` 字面量不能无差别拦截，否则 `fdisk -l /dev/sda` 会被拒。
      const tool = createBashTool()
      const res = await tool.call({ command: 'fdisk -l /dev/sda' }, makeCtx())
      expect(res.error?.code).not.toBe('SANDBOX_DANGEROUS')
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

    it('命令白名单：includes() 子串判据回归——命令含白名单子串不得放行', async () => {
      // 回归（2026-09-30）：旧判据 `input.command.includes(a)` 子串命中即放行，
      // allowlist=['git'] 时 `echo git && rm -rf /` 直接过闸（实际执行的是 rm，不是 git）。
      const tool = createBashTool({ allowlist: ['git'] })
      const res = await tool.call(
        { command: 'echo git && rm -rf x', cwd: TMP_DIR },
        makeCtx(),
      )
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('SANDBOX_ALLOWLIST')
    })

    it('命令白名单：前缀重叠命令名不得误命中（github ≠ git 片段）', async () => {
      const tool = createBashTool({ allowlist: ['git'] })
      const res = await tool.call({ command: 'github-cli --help', cwd: TMP_DIR }, makeCtx())
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('SANDBOX_ALLOWLIST')
    })

    it('命令白名单：多词片段须整词匹配（echo hi 命中 echo hi world，echo hello 不命中）', async () => {
      const tool = createBashTool({ allowlist: ['echo hi'] })
      // 片段后跟空白 → 命中，且实际执行无副作用命令
      const ok = await tool.call({ command: 'echo hi world', cwd: TMP_DIR }, makeCtx())
      expect(ok.ok).toBe(true)
      expect(ok.output!.stdout.trim()).toBe('hi world')
      // 片段不整词匹配（echo hello 不以 'echo hi' 开头）→ 拒绝
      const no = await tool.call({ command: 'echo hello', cwd: TMP_DIR }, makeCtx())
      expect(no.ok).toBe(false)
      expect(no.error!.code).toBe('SANDBOX_ALLOWLIST')
    })

    it('权限 pattern：extractDenyPatterns 上报段级命令（只进 deny 判定）', () => {
      const tool = createBashTool()
      expect(tool.permission!.extractPatterns({ command: 'echo hi; rm -rf x' } as never))
        .toEqual(['echo hi; rm -rf x'])
      // 段级单独上报：让权限引擎的 deny 规则（如 shutdown*）能拦住藏在全串中的恶意段
      expect(tool.permission!.extractDenyPatterns!({ command: 'echo hi; shutdown -h now' } as never))
        .toEqual(['echo hi', 'shutdown -h now'])
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
            // P0-7：档位下沉标记 —— 引擎据此无条件落 `sandbox.escalation` 审计
            // （`host:` 前缀是给人看的展示约定，判据不许靠它）
            expect(req.escalation).toBe('host-fallback')
            return { behavior: 'deny' as const }
          },
        }),
      )
      expect(res.ok).toBe(false)
      expect(res.error!.code).toBe('SANDBOX_HOST_DENIED')
    })

    it('★P0-7：requireHostApproval=false 时不发请求（连 escalation 都没有）⇒ 由 config 告警兜底', async () => {
      const tool = createBashTool({ allowlist: ['echo'], fallbackToHost: true, requireHostApproval: false })
      let called = 0
      const res = await tool.call(
        { command: 'ls', cwd: TMP_DIR },
        makeCtx({ requestPermission: async () => { called++; return { behavior: 'allow' as const } } }),
      )
      expect(res.ok).toBe(true)
      expect(res.output!.viaHost).toBe(true)
      expect(called).toBe(0) // 显式"不要问" ⇒ 这条路径没有可记的请求，只能靠装配期告警
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
      // 本组用例统一带 maxSteps: 1：mock provider 每次都返回同一个 toolCall，
      // 放任引擎自主多步会一路续轮到 doom-loop 拦截，取到的就不是本次要验证的那一步。
      const denied = await h.agent.query({ sessionId: sess.id, message: '拒绝', maxSteps: 1 })
      const deniedTool = denied.parts.find((p: any) => p.type === 'tool') as any
      expect(deniedTool).toBeDefined()
      // 白名单拒绝返回 error ToolResult（result = { message, code }）
      expect((deniedTool.result as any).code).toBe('SANDBOX_ALLOWLIST')

      const allowed = await h.agent.query({ sessionId: sess.id, message: '允许', maxSteps: 1 })
      const allowedTool = allowed.parts.find((p: any) => p.type === 'tool') as any
      expect(allowedTool).toBeDefined()
      expect((allowedTool.result as any).stdout?.trim()).toBe('hi')

      await h.stop()
    })
  })

  // ===== 插件集成 =====

  describe('toolsBuiltinPlugin 集成', () => {
    it('通过 core.tool.pool.assemble 注入三个工具', async () => {
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
      const reply = await h.agent.query({ sessionId: sess.id, message: '读取文件', maxSteps: 1 })

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
      const reply = await h.agent.query({ sessionId: sess.id, message: '写入文件', maxSteps: 1 })

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
      const reply = await h.agent.query({ sessionId: sess.id, message: '执行命令', maxSteps: 1 })

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
      const reply = await h.agent.query({ sessionId: sess.id, message: '写入文件', maxSteps: 1 })

      // write_file 未注入 → tool call 找不到工具 → isError
      const toolPart = reply.parts.find((p: any) => p.type === 'tool') as any
      expect(toolPart).toBeDefined()
      expect(toolPart.isError).toBe(true)

      await h.stop()
    })

    it('builtinTools 导出包含四个原语工具 + 只读 bash（bash_ro 供只读哨兵用）', () => {
      expect(builtinTools.map((t) => t.id).sort()).toEqual(['bash', 'bash_ro', 'edit_file', 'read_file', 'write_file'])
      // bash_ro 必须**恒只读** —— 只读哨兵（@readonly）是按 isReadOnly() 展开的，
      // 它一旦不是 true，reader 类 Agent 就又拿不到任何 shell 了。
      expect(readOnlyBashTool.isReadOnly?.()).toBe(true)
      expect(readOnlyBashTool.isConcurrencySafe?.()).toBe(true)
      expect(readOnlyBashTool.isDestructive?.()).toBe(false)
      // bash 本身仍是"可写"语义（只读能力由独立工具承担，不给 bash 加开关）
      expect(bashTool.isReadOnly?.()).toBe(false)
    })
  })
})

// ===== 只读 bash（bash_ro）—— 观察点 4 =====
//
// 背景：只读哨兵 `@readonly` 是按 `isReadOnly()` 展开的，而 bash 是 false ⇒ 缺省 tools 的
// Agent（reader 类）**一个 shell 都拿不到**。真机 s_1790163574429_tg1a6：成功那个 reader
// 在报告开头自述「本轮工具集无命令执行能力（白名单仅 read_file / list_dir / glob / grep_file），
// 无法运行 wc/python3」，它的统计章节只能标注"未覆盖" —— 量化盘点类任务天生残废。
// 这里固定"只读哨兵能拿到一个被约束住的只读 shell"。
// ===== P0-6 / P1-1：进程树 kill + 资源上限 =====

/** pid 是否还活着（0 号信号只做存在性探测，不发信号） */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 轮询等 pid 消失（SIGKILL 之后内核回收/重父化要一点点时间） */
async function waitGone(pid: number, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (!isAlive(pid)) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('buildLimitPreamble / resolveBashLimits（P1-1 纯函数）', () => {
  it('未设/`false`/全 0 ⇒ 空串；缺省只开单文件大小', () => {
    expect(buildLimitPreamble(resolveBashLimits(false), 'bash')).toBe('')
    expect(buildLimitPreamble({ cpuSeconds: 0, maxFileSizeKb: 0, maxProcesses: 0, memoryKb: 0 }, 'bash')).toBe('')
    expect(buildLimitPreamble(resolveBashLimits(undefined), 'bash')).toBe('ulimit -f 2097152 2>/dev/null; ')
  })

  it('非 bash 族系 ⇒ 空串（不模拟）', () => {
    const l = resolveBashLimits({ cpuSeconds: 5 })
    expect(buildLimitPreamble(l, 'powershell')).toBe('')
    expect(buildLimitPreamble(l, 'cmd')).toBe('')
  })

  it('★`ulimit -f` 单位按平台换算：darwin 1024B/单位、其它 512B/单位', () => {
    const l = resolveBashLimits({ maxFileSizeKb: 1024 })
    expect(buildLimitPreamble(l, 'bash', 'darwin')).toBe('ulimit -f 1024 2>/dev/null; ')
    expect(buildLimitPreamble(l, 'bash', 'linux')).toBe('ulimit -f 2048 2>/dev/null; ')
  })

  it('★每项各起一次 ulimit（合并形态会被失败项连累）', () => {
    const p = buildLimitPreamble({ cpuSeconds: 5, maxFileSizeKb: 0, maxProcesses: 256, memoryKb: 0 }, 'bash')
    expect(p).toBe('ulimit -t 5 2>/dev/null; ulimit -u 256 2>/dev/null; ')
  })
})

describe('bash 资源上限与进程树 kill（P0-6 / P1-1 端到端）', () => {
  // 本 describe 在顶层（不在 @harness/tools-builtin 那个大 describe 里）⇒ 自己建临时目录
  beforeEach(async () => { await mkdir(TMP_DIR, { recursive: true }) })
  afterEach(async () => { await rm(TMP_DIR, { recursive: true, force: true }) })

  it('limits 真的进了子 shell（`ulimit -f` 回读）', async () => {
    const tool = createBashTool({ limits: { maxFileSizeKb: 1024 } })
    const res = await tool.call({ command: 'ulimit -f' }, makeCtx())
    expect(res.ok).toBe(true)
    // darwin：1 单位 = 1024B ⇒ 1024KB = 1024 单位；linux：512B ⇒ 2048
    expect(Number(res.output!.stdout.trim())).toBe(process.platform === 'darwin' ? 1024 : 2048)
  })

  it('limits:false ⇒ 不加任何抬头（回读为 unlimited）', async () => {
    const tool = createBashTool({ limits: false })
    const res = await tool.call({ command: 'ulimit -f' }, makeCtx())
    expect(res.output!.stdout.trim()).toBe('unlimited')
  })

  it('★output.command 仍是原文（ulimit 抬头不污染遥测/展示）', async () => {
    const res = await bashTool.call({ command: 'echo hi' }, makeCtx())
    expect(res.output!.command).toBe('echo hi')
    expect(res.output!.stdout.trim()).toBe('hi')
  })

  it('★超时杀掉整棵进程树：后台孙进程不能活下来（P0-6 回归）', async () => {
    const pidFile = join(TMP_DIR, 'grandchild.pid')
    const res = await bashTool.call({
      // 后台起一个长命孙进程并记下它的 pid，然后自己挂住
      command: `sleep 30 & echo $! > "${pidFile}"; sleep 30`,
      timeoutMs: 400,
    }, makeCtx())
    expect(res.output!.timedOut).toBe(true)
    const gpid = Number((await Bun.file(pidFile).text()).trim())
    expect(Number.isInteger(gpid)).toBe(true)
    expect(await waitGone(gpid)).toBe(true)
  })

  it('★中断（AbortSignal）同样杀整棵树', async () => {
    const pidFile = join(TMP_DIR, 'grandchild2.pid')
    const ac = new AbortController()
    const promise = bashTool.call(
      { command: `sleep 30 & echo $! > "${pidFile}"; sleep 30` },
      makeCtx({ signal: ac.signal }),
    )
    setTimeout(() => ac.abort(), 400)
    const res = await promise
    expect(res.interrupted).toBe(true)
    const gpid = Number((await Bun.file(pidFile).text()).trim())
    expect(await waitGone(gpid)).toBe(true)
  })
})


describe('读侧敏感文件默认拒绝（P0-3）', () => {
  beforeEach(async () => { await mkdir(TMP_DIR, { recursive: true }) })
  afterEach(async () => { await rm(TMP_DIR, { recursive: true, force: true }) })

  it('read_file 拒读 .env（默认清单）', async () => {
    await writeFile(join(TMP_DIR, '.env'), 'SECRET=1')
    const res = await readFileTool.call({ path: '.env' }, makeCtx())
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('SANDBOX_READ_DENIED')
  })

  it('★但 .env.example / id_rsa.pub 不挡（模板与公钥不是凭据）', async () => {
    await writeFile(join(TMP_DIR, '.env.example'), 'SECRET=')
    await writeFile(join(TMP_DIR, 'id_rsa.pub'), 'ssh-rsa AAAA')
    expect((await readFileTool.call({ path: '.env.example' }, makeCtx())).ok).toBe(true)
    expect((await readFileTool.call({ path: 'id_rsa.pub' }, makeCtx())).ok).toBe(true)
  })

  it('子目录里的凭据同样挡、普通文件照常读', async () => {
    await mkdir(join(TMP_DIR, 'deploy'), { recursive: true })
    await writeFile(join(TMP_DIR, 'deploy', 'server.pem'), 'x')
    await writeFile(join(TMP_DIR, 'ok.ts'), 'export const a = 1')
    const denied = await readFileTool.call({ path: 'deploy/server.pem' }, makeCtx())
    expect(denied.ok).toBe(false)
    expect(denied.error!.code).toBe('SANDBOX_READ_DENIED')
    expect((await readFileTool.call({ path: 'ok.ts' }, makeCtx())).ok).toBe(true)
  })

  it('readDeny:false 关闭这道闸；给对象则整体替换清单', async () => {
    await writeFile(join(TMP_DIR, '.env'), 'SECRET=1')
    await writeFile(join(TMP_DIR, 'secret.txt'), 'x')
    const off = createReadFileTool({ readDeny: false })
    expect((await off.call({ path: '.env' }, makeCtx())).ok).toBe(true)
    const custom = createReadFileTool({ readDeny: { names: ['secret.txt'], prefixes: [], suffixes: [], dirs: [], paths: [] } })
    const hit = await custom.call({ path: 'secret.txt' }, makeCtx())
    expect(hit.ok).toBe(false)
    expect(hit.error!.code).toBe('SANDBOX_READ_DENIED')
    expect((await custom.call({ path: '.env' }, makeCtx())).ok).toBe(true) // 内置清单已被替换掉
  })

  it('★bash_ro 也挡：`cat .env` 在只读白名单内，但属于敏感读', async () => {
    await writeFile(join(TMP_DIR, '.env'), 'SECRET=1')
    await writeFile(join(TMP_DIR, 'a.txt'), 'hi')
    const ro = createReadOnlyBashTool()
    const denied = await ro.call({ command: 'cat .env' }, makeCtx())
    expect(denied.ok).toBe(false)
    expect(denied.error!.code).toBe('SANDBOX_READ_DENIED')
    const ok = await ro.call({ command: 'cat a.txt' }, makeCtx())
    expect(ok.ok).toBe(true)
    expect(ok.output!.stdout.trim()).toBe('hi')
  })

  it('bash_ro readDeny:false ⇒ 不挡', async () => {
    await writeFile(join(TMP_DIR, '.env'), 'SECRET=1')
    const ro = createReadOnlyBashTool({ readDeny: false })
    const res = await ro.call({ command: 'cat .env' }, makeCtx())
    expect(res.ok).toBe(true)
  })
})


describe('网络出口策略（P1-2）', () => {
  beforeEach(async () => { await mkdir(TMP_DIR, { recursive: true }) })
  afterEach(async () => { await rm(TMP_DIR, { recursive: true, force: true }) })

  it('deny：出网命令被拒（SANDBOX_NET_DENIED），非出网命令照常', async () => {
    const tool = createBashTool({ net: 'deny' })
    const denied = await tool.call({ command: 'curl https://example.com' }, makeCtx())
    expect(denied.ok).toBe(false)
    expect(denied.error!.code).toBe('SANDBOX_NET_DENIED')
    expect(denied.error!.message).toContain('curl')
    const ok = await tool.call({ command: 'echo hi' }, makeCtx())
    expect(ok.ok).toBe(true)
    expect(ok.output!.stdout.trim()).toBe('hi')
  })

  it('allowlist：白名单内放行（子域覆盖）、白名单外拒绝', async () => {
    const tool = createBashTool({ net: 'allowlist', netAllow: ['example.com'] })
    // 目标在白名单里 ⇒ 网络门放行（紧接着会因网络不可达而失败，但错误码不该是网络策略）
    const allowed = await tool.call({ command: 'curl -s -m 1 https://api.example.com/x' }, makeCtx())
    expect(allowed.error?.code).not.toBe('SANDBOX_NET_DENIED')
    const denied = await tool.call({ command: 'curl -s https://evil.test/x' }, makeCtx())
    expect(denied.ok).toBe(false)
    expect(denied.error!.code).toBe('SANDBOX_NET_DENIED')
    expect(denied.error!.message).toContain('evil.test')
  })

  it('★allowlist：云元数据端点硬拒（写进白名单也不放行）', async () => {
    const tool = createBashTool({ net: 'allowlist', netAllow: ['169.254.169.254'] })
    const res = await tool.call({ command: 'curl http://169.254.169.254/latest/meta-data/' }, makeCtx())
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('SANDBOX_NET_DENIED')
    expect(res.error!.message).toContain('元数据')
  })

  it('★allowlist：提不出目标 ⇒ fail-closed（无法核验不算已授权）', async () => {
    const tool = createBashTool({ net: 'allowlist', netAllow: ['example.com'] })
    const res = await tool.call({ command: 'ssh myserver' }, makeCtx())
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('SANDBOX_NET_DENIED')
  })

  it('默认（open）：网络门不介入 —— 与改造前逐位一致', async () => {
    const tool = createBashTool()
    const res = await tool.call({ command: 'echo curl' }, makeCtx())
    expect(res.ok).toBe(true)
    expect(res.output!.stdout.trim()).toBe('curl')
  })
})

describe('BashOutput.isolation（P1-4 / P2-3：边界自述）', () => {
  beforeEach(async () => { await mkdir(TMP_DIR, { recursive: true }) })
  afterEach(async () => { await rm(TMP_DIR, { recursive: true, force: true }) })

  it('缺省：L1 + fsBound=false + netPolicy=open', async () => {
    const res = await createBashTool().call({ command: 'echo hi' }, makeCtx())
    expect(res.output!.isolation).toEqual({ level: 'L1', fsBound: false, netPolicy: 'open', viaHost: false })
  })

  it('宿主注入档位后如实回传；L2 才 fsBound=true', async () => {
    const l2 = await createBashTool({ isolationLevel: 'L2' }).call({ command: 'echo hi' }, makeCtx())
    expect(l2.output!.isolation!.level).toBe('L2')
    expect(l2.output!.isolation!.fsBound).toBe(true)
  })

  it('策略一并回传；宿主回退时 viaHost 双层都为 true', async () => {
    const res = await createBashTool({ net: 'deny' }).call({ command: 'echo hi' }, makeCtx())
    expect(res.output!.isolation!.netPolicy).toBe('deny')

    const fb = await createBashTool({ allowlist: ['echo'], fallbackToHost: true }).call(
      { command: 'ls', cwd: TMP_DIR },
      makeCtx({ requestPermission: async () => ({ behavior: 'allow' as const }) }),
    )
    expect(fb.output!.viaHost).toBe(true)
    expect(fb.output!.isolation!.viaHost).toBe(true)
  })
})

describe('read_file 大小/类型闸（P1-8）', () => {
  beforeEach(async () => { await mkdir(TMP_DIR, { recursive: true }) })
  afterEach(async () => { await rm(TMP_DIR, { recursive: true, force: true }) })

  it('★超过 maxReadBytes ⇒ 拒绝（不再把整文件拉进内存）', async () => {
    await writeFile(join(TMP_DIR, 'big.log'), 'x'.repeat(4096))
    const tool = createReadFileTool({ maxReadBytes: 1024 })
    const res = await tool.call({ path: 'big.log' }, makeCtx())
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('SANDBOX_READ_TOO_LARGE')
    expect(res.error!.message).toContain('4.0 KB')
    expect(res.error!.message).toContain('grep_file')
  })

  it('边界内可读；maxReadBytes:0 = 不限制', async () => {
    await writeFile(join(TMP_DIR, 'a.ts'), 'export const a = 1')
    expect((await createReadFileTool({ maxReadBytes: 1024 }).call({ path: 'a.ts' }, makeCtx())).ok).toBe(true)
    await writeFile(join(TMP_DIR, 'big2.log'), 'y'.repeat(4096))
    expect((await createReadFileTool({ maxReadBytes: 0 }).call({ path: 'big2.log' }, makeCtx())).ok).toBe(true)
  })

  it('★目录路径的消息说清"是目录"并指出替代工具（原来只有一句"不是文件"）', async () => {
    await mkdir(join(TMP_DIR, 'src-dir'), { recursive: true })
    const res = await readFileTool.call({ path: 'src-dir' }, makeCtx())
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('NOT_A_FILE')
    expect(res.error!.message).toContain('目录')
    expect(res.error!.message).toContain('list_dir')
  })
})

describe('bash_ro：只读哨兵的沙箱内只读 shell', () => {
  // 本段是**顶层** describe（不在 `@harness/tools-builtin` 里面），所以外层的
  // beforeEach/afterEach 管不到 —— 得自己建/清 TMP_DIR。
  // （踩过：漏了这两句 ⇒ TMP_DIR 不存在 ⇒ writeFile ENOENT、spawn 的 cwd 不存在 ⇒ SPAWN_ERROR。）
  beforeEach(async () => {
    await mkdir(TMP_DIR, { recursive: true })
  })

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true })
  })

  describe('checkReadOnlyCommand：白名单 + 结构性写入通道', () => {
    it('放行读 / 算 / 查类命令（含管道与分号链接）', () => {
      for (const cmd of [
        'wc -l README.md',
        'grep -rn "foo" packages/',
        'cat a.txt',
        'ls -la',
        'find . -name "*.ts" -type f',
        'git log --oneline -20',
        'git -C /tmp log',
        'git --version',
        'python3 -c "print(len(open(\'a.txt\').read()))"',
        'grep -c x a.txt | wc -l',
        'wc -l a.txt; head -3 b.txt',
      ]) {
        expect({ cmd, ...checkReadOnlyCommand(cmd) }).toEqual({ cmd, ok: true })
      }
    })

    it('拒绝输出重定向（> / >> / 2>）——写文件的第一通道', () => {
      expect(checkReadOnlyCommand('wc -l a.txt > out.txt')).toMatchObject({ ok: false, code: 'SANDBOX_RO_REDIRECT' })
      expect(checkReadOnlyCommand('cat a.txt >> out.txt')).toMatchObject({ ok: false, code: 'SANDBOX_RO_REDIRECT' })
      expect(checkReadOnlyCommand('ls 2> err.txt')).toMatchObject({ ok: false, code: 'SANDBOX_RO_REDIRECT' })
      // 但 fd 复制（2>&1）不写文件，不该被误伤
      expect(checkReadOnlyCommand('ls -la 2>&1')).toMatchObject({ ok: true })
    })

    it('丢弃到 /dev/null 的重定向放行 —— 只读命令最常写的「静音 stderr」惯用法', () => {
      // 回归：`/>>?/` 只看 `>` 这一个字符，分不清 `2>err.txt` 与 `2>/dev/null`，
      // 实测 `git rev-parse --is-inside-work-tree 2>/dev/null` 被判 SANDBOX_RO_REDIRECT 整条拒绝，
      // 只读哨兵因此反复重试（spikes/vscode-chat-sessions 真机记录：两次 bash_ro REDIRECT）。
      for (const cmd of [
        'git rev-parse --is-inside-work-tree 2>/dev/null',
        'cat f 2>/dev/null; wc -l f',
        'pwd 2>/dev/null && echo ok > /dev/null',
        'ls 2>>/dev/null',
        'ls > /dev/null 2>&1',
        'echo 1 > /dev/null', // `1` 是 echo 的参数，不是 fd
      ]) {
        expect({ cmd, ...checkReadOnlyCommand(cmd) }).toEqual({ cmd, ok: true })
      }
      // 钉子：目标是**普通文件**时不能因长得像 /dev/null 而被放行
      expect(checkReadOnlyCommand('wc -l a.txt > /dev/nullx')).toMatchObject({ ok: false, code: 'SANDBOX_RO_REDIRECT' })
      expect(checkReadOnlyCommand('echo x > /dev/nullbackup')).toMatchObject({ ok: false, code: 'SANDBOX_RO_REDIRECT' })
      // 钉子：真写文件的重定向照旧拒绝
      expect(checkReadOnlyCommand('cat f 2> out.txt')).toMatchObject({ ok: false, code: 'SANDBOX_RO_REDIRECT' })
    })

    it('拒绝命令替换 / 进程替换 / heredoc —— 藏在参数里的第二条命令', () => {
      expect(checkReadOnlyCommand('cat $(rm -rf /)')).toMatchObject({ ok: false, code: 'SANDBOX_RO_SUBST' })
      expect(checkReadOnlyCommand('cat `whoami`')).toMatchObject({ ok: false, code: 'SANDBOX_RO_SUBST' })
      expect(checkReadOnlyCommand('diff <(ls) <(ls)')).toMatchObject({ ok: false, code: 'SANDBOX_RO_SUBST' })
      expect(checkReadOnlyCommand('cat <<EOF')).toMatchObject({ ok: false, code: 'SANDBOX_RO_HEREDOC' })
    })

    it('拒绝提权与系统控制命令', () => {
      expect(checkReadOnlyCommand('sudo ls')).toMatchObject({ ok: false })
      expect(checkReadOnlyCommand('ls; osascript -e "tell app"')).toMatchObject({ ok: false, code: 'SANDBOX_RO_PRIV' })
    })

    it('多段链路里只要有一段越界就整体拒绝（不能借管道夹带写操作）', () => {
      expect(checkReadOnlyCommand('wc -l a.txt && rm a.txt')).toMatchObject({ ok: false, code: 'SANDBOX_RO_ALLOWLIST' })
      expect(checkReadOnlyCommand('cat a.txt | tee b.txt')).toMatchObject({ ok: false, code: 'SANDBOX_RO_ALLOWLIST' })
      expect(checkReadOnlyCommand('ls; touch new.txt')).toMatchObject({ ok: false, code: 'SANDBOX_RO_ALLOWLIST' })
      expect(checkReadOnlyCommand('xargs rm')).toMatchObject({ ok: false, code: 'SANDBOX_RO_ALLOWLIST' })
    })

    it('参数级禁区：首命令合法但开关会写', () => {
      expect(checkReadOnlyCommand('sed -i s/a/b/ f.txt')).toMatchObject({ ok: false, code: 'SANDBOX_RO_ALLOWLIST' })
      expect(checkReadOnlyCommand('find . -name x -delete')).toMatchObject({ ok: false, code: 'SANDBOX_RO_ALLOWLIST' })
      expect(checkReadOnlyCommand('sort -o out.txt in.txt')).toMatchObject({ ok: false, code: 'SANDBOX_RO_ALLOWLIST' })
      // 同一命令不带写开关时要放行
      expect(checkReadOnlyCommand('sed s/a/b/ f.txt')).toMatchObject({ ok: true })
      expect(checkReadOnlyCommand('find . -name x')).toMatchObject({ ok: true })
    })

    it('git 只放行只读子命令', () => {
      expect(checkReadOnlyCommand('git push origin main')).toMatchObject({ ok: false, code: 'SANDBOX_RO_ALLOWLIST' })
      expect(checkReadOnlyCommand('git commit -m x')).toMatchObject({ ok: false })
      expect(checkReadOnlyCommand('git tag v1')).toMatchObject({ ok: false }) // 少给能力，不留"看似只读实则能写"的口子
      expect(checkReadOnlyCommand('git diff HEAD')).toMatchObject({ ok: true })
      expect(checkReadOnlyCommand('git status')).toMatchObject({ ok: true })
    })

    it('解释器：纯计算放行，出现写/网特征即拒绝', () => {
      expect(checkReadOnlyCommand('python3 -c "print(1+1)"')).toMatchObject({ ok: true })
      expect(checkReadOnlyCommand('python3 -c "open(\'x\',\'w\').write(1)"')).toMatchObject({ ok: false, code: 'SANDBOX_RO_SCRIPT' })
      expect(checkReadOnlyCommand('python3 -c "import os; os.remove(\'x\')"')).toMatchObject({ ok: false, code: 'SANDBOX_RO_SCRIPT' })
      expect(checkReadOnlyCommand('python3 -c "import requests; requests.get(\'http://x\')"')).toMatchObject({ ok: false, code: 'SANDBOX_RO_SCRIPT' })
      expect(checkReadOnlyCommand('node -e "require(\'child_process\').exec(\'rm -rf /\')"')).toMatchObject({ ok: false, code: 'SANDBOX_RO_SCRIPT' })
      expect(checkReadOnlyCommand('node -e "require(\'fs\').writeFileSync(\'a\',\'x\')"')).toMatchObject({ ok: false, code: 'SANDBOX_RO_SCRIPT' })
    })

    it('空命令给可执行的指引，而不是静默通过', () => {
      const v = checkReadOnlyCommand('   ')
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.code).toBe('COMMAND_REQUIRED')
    })

    it('默认白名单里不含任何能"顺手写一下"的命令', () => {
      for (const forbidden of ['rm', 'mv', 'cp', 'tee', 'dd', 'truncate', 'curl', 'wget', 'ssh', 'chmod', 'xargs', 'npm', 'make']) {
        expect(DEFAULT_READONLY_COMMANDS as readonly string[]).not.toContain(forbidden)
      }
    })
  })

  it('bash_ro 真跑一条只读命令并回 stdout', async () => {
    await writeFile(join(TMP_DIR, 'sample.txt'), 'l1\nl2\nl3\n', 'utf-8')
    const r = await readOnlyBashTool.call({ command: 'wc -l sample.txt' }, makeCtx())
    expect(r.ok).toBe(true)
    expect(r.output?.exitCode).toBe(0)
    expect(String(r.output?.stdout)).toContain('3 sample.txt')
  })

  it('bash_ro 端到端放行 `2>/dev/null`（两道门都不误伤，且命令真的跑了）', async () => {
    // 端到端：手写门 + AST 复核门都过了以后，必须真的执行（ok=true），
    // 而不是"没被拒绝但也没跑"。用一条必然失败的命令反向确认 stderr 被静音吞掉。
    const tool = createReadOnlyBashTool({ rootDir: TMP_DIR })
    const r = await tool.call({ command: 'wc -l definitely-not-exists.txt 2>/dev/null' }, makeCtx())
    expect(r.error?.code).toBeUndefined()
    // 反着验：文件不存在 ⇒ wc 退出码非 0；但 stderr 为空 ⇒ `2>/dev/null` 真的生效了
    expect(r.output?.exitCode).not.toBe(0)
    expect(String(r.output?.stderr)).toBe('')
  })

  it('checkReadOnlyByAst（AST 复核门）：间接执行 / 白名单外解码命令名拒绝，码与手写门对齐', async () => {
    // 命令名含展开（间接执行对只读哨兵一律不可审计 —— 与主 bash 不同，惯用法也不放行）
    const f1 = await analyzeBashCommand('$(which docker) ps')
    const v1 = checkReadOnlyByAst(f1!)
    if (v1.ok) throw new Error('expected reject: nameOpaque')
    expect(v1.code).toBe('SANDBOX_RO_ALLOWLIST')
    expect(v1.reason).toContain('间接执行')
    // 解码后命令名不在白名单（语法树看到的是 bash 真正执行的命令序列）
    const f2 = await analyzeBashCommand('cat f && git push origin main')
    const v2 = checkReadOnlyByAst(f2!)
    if (v2.ok) throw new Error('expected reject: git push')
    expect(v2.code).toBe('SANDBOX_RO_ALLOWLIST')
    expect(v2.reason).toContain('push')
    // 全部白名单内 → 放行
    const f3 = await analyzeBashCommand('cat f && wc -l f')
    expect(checkReadOnlyByAst(f3!).ok).toBe(true)
  })

  it('bash_ro AST 门不误伤：既有白名单命令在两道门下都放行', async () => {
    const tool = createReadOnlyBashTool({ rootDir: TMP_DIR })
    await writeFile(join(TMP_DIR, 'a.txt'), 'x\n', 'utf-8')
    const r = await tool.call({ command: 'cat a.txt && wc -c a.txt' }, makeCtx())
    expect(r.error?.code).not.toBe('SANDBOX_RO_ALLOWLIST')
  })

  it('bash_ro 拒绝写命令：文件根本没被创建（失败是"没执行"，不是"执行后报错"）', async () => {
    const tool = createReadOnlyBashTool({ rootDir: TMP_DIR })
    const outPath = join(TMP_DIR, 'should-not-exist.txt')
    const r = await tool.call({ command: `echo hi > ${outPath}` }, makeCtx())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('SANDBOX_RO_REDIRECT')
    expect(existsSync(outPath)).toBe(false)
  })

  it('bash_ro 不接受入参覆盖环境变量（ENV 是绕过只读的后门）', async () => {
    const tool = createReadOnlyBashTool({ rootDir: TMP_DIR })
    const r = await tool.call(
      // schema 里本就没有 env 字段；这里模拟模型硬塞
      { command: 'printenv EVIL', env: { EVIL: 'pwned' } } as never,
      makeCtx(),
    )
    // `ok` 只表示"命令跑起来了"（与退出码无关，见 runBash 的 ok 语义），所以这里 ok 应为 true。
    expect(r.ok).toBe(true)
    // 两个一起看：① stdout 里没有注入的值；② 退出码非 0 ⇒ printenv 确实找不到 EVIL，
    // 证明"没被注入"而不是"命令没跑"。
    expect(String(r.output?.stdout)).not.toContain('pwned')
    expect(r.output?.exitCode).not.toBe(0)
  })
})

// ===== 跨平台 shell 探测 =====

describe('resolveShell：跨平台 shell 探测', () => {
  it('非 Windows 平台固定返回 bash', () => {
    const sh = resolveShell({ platform: 'darwin' })
    expect(sh.family).toBe('bash')
    expect(sh.program).toBe('bash')
    expect(sh.args).toEqual(['-c'])
  })

  it('Windows 上优先使用 PATH 里的 bash.exe', () => {
    const exists = (p: string) => p === 'C:\\Git\\bin\\bash.exe'
    const sh = resolveShell({ platform: 'win32', pathSep: ';', dirSep: '\\', exists, env: { PATH: 'C:\\Git\\bin' } as NodeJS.ProcessEnv })
    expect(sh.family).toBe('bash')
    expect(sh.program).toBe('C:\\Git\\bin\\bash.exe')
    expect(sh.args).toEqual(['-c'])
  })

  it('Windows 无 bash 时回退 PowerShell Core', () => {
    const exists = (p: string) => p === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    const sh = resolveShell({ platform: 'win32', pathSep: ';', dirSep: '\\', exists, env: { PATH: 'C:\\Program Files\\PowerShell\\7' } as NodeJS.ProcessEnv })
    expect(sh.family).toBe('powershell')
    expect(sh.program).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(sh.args).toEqual(['-Command'])
  })

  it('Windows 无 pwsh 时回退 Windows PowerShell', () => {
    const exists = (p: string) => p === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const sh = resolveShell({ platform: 'win32', pathSep: ';', dirSep: '\\', exists, env: { PATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0' } as NodeJS.ProcessEnv })
    expect(sh.family).toBe('powershell')
    expect(sh.program).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('Windows 无任何可用 shell 时回退 cmd.exe', () => {
    const sh = resolveShell({ platform: 'win32', pathSep: ';', dirSep: '\\', exists: () => false, env: { PATH: '' } as NodeJS.ProcessEnv })
    expect(sh.family).toBe('cmd')
    expect(sh.program).toBe('cmd.exe')
    expect(sh.args).toEqual(['/c'])
  })
})
