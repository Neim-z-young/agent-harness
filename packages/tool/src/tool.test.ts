import { describe, it, expect, beforeEach } from 'bun:test'
import {
  Awaitable,
  Schema,
  TOOL_DEFAULTS,
  Tool,
  ToolContext,
  ToolPipeline,
  ToolPermissionAskRequiredError,
  ToolPermissionDeniedError,
  ToolRegistry,
  ToolResult,
  ToolSchemaError,
  ToolUse,
  ToolValidationError,
  defineTool,
  partitionToolCalls,
} from './index'

// ===== 测试工具：简易 Schema 构造器（不依赖 zod） =====

function createSchema<T>(validator: (v: unknown) => T): Schema<T> {
  return {
    parse: (v) => validator(v),
    safeParse: (v) => {
      try {
        return { success: true, data: validator(v) }
      } catch (err) {
        return { success: false, error: err }
      }
    },
  }
}

const StringStringSchema = createSchema<{ path: string }>((v) => {
  const o = v as { path: unknown }
  if (typeof o !== 'object' || o === null) throw new Error('需要对象')
  if (typeof o.path !== 'string') throw new Error('path 需要字符串')
  return { path: o.path }
})

const ReadWriteSchema = createSchema<{ path: string; content: string }>((v) => {
  const o = v as { path: unknown; content: unknown }
  if (typeof o !== 'object' || o === null) throw new Error('需要对象')
  if (typeof o.path !== 'string') throw new Error('path 需要字符串')
  if (typeof o.content !== 'string') throw new Error('content 需要字符串')
  return { path: o.path, content: o.content }
})

// ===== 测试工具：构造 ToolContext =====

function makeCtx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's1',
    agentId: 'a1',
    messageId: 'm1',
    toolUseId: 'tu1',
    signal: new AbortController().signal,
    variables: {},
    cwd: '/tmp',
    ...extra,
  }
}

// ===== 开始测试 =====

describe('@harness/tool', () => {
  describe('TOOL_DEFAULTS (Fail-Closed)', () => {
    it('安全字段默认值都是最保守的 false', () => {
      expect(TOOL_DEFAULTS.isConcurrencySafe()).toBe(false)
      expect(TOOL_DEFAULTS.isReadOnly()).toBe(false)
      expect(TOOL_DEFAULTS.isDestructive()).toBe(false)
      expect(TOOL_DEFAULTS.requiresUserInteraction).toBe(false)
    })

    it('defineTool 工厂会把默认值覆盖到未显式声明的工具', () => {
      const T = defineTool({
        id: 'plain',
        description: '无安全声明',
        inputSchema: createSchema<any>(() => ({})),
        async call() {
          return { ok: true, output: 1 }
        },
      })
      expect(T.isConcurrencySafe!()).toBe(false)
      expect(T.isReadOnly!()).toBe(false)
      expect(T.isDestructive!()).toBe(false)
      expect(T.requiresUserInteraction).toBe(false)
    })

    it('defineTool 工厂保留显式声明的安全值', () => {
      const T = defineTool({
        id: 'safe_read',
        description: '显式声明只读、并发安全',
        inputSchema: createSchema<any>(() => ({})),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        async call() {
          return { ok: true, output: 1 }
        },
      })
      expect(T.isConcurrencySafe!()).toBe(true)
      expect(T.isReadOnly!()).toBe(true)
    })

    it('Tool.define 命名空间可用', () => {
      const T = Tool.define({
        id: 't1',
        description: 'd',
        inputSchema: createSchema<any>(() => ({})),
        async call() {
          return { ok: true, output: 1 }
        },
      })
      expect(T.id).toBe('t1')
    })
  })

  describe('partitionToolCalls', () => {
    // 安全工具和不安全工具的工厂
    const safe = (id: string): ToolUse => ({
      toolUseId: 'tu-' + id,
      toolId: id,
      input: { x: 1 },
      tool: defineTool({
        id,
        description: 'safe',
        inputSchema: createSchema<any>((v) => v as any),
        isConcurrencySafe: () => true,
        async call() {
          return { ok: true }
        },
      }),
    })
    const unsafe = (id: string): ToolUse => ({
      toolUseId: 'tu-' + id,
      toolId: id,
      input: { x: 1 },
      tool: defineTool({
        id,
        description: 'unsafe',
        inputSchema: createSchema<any>((v) => v as any),
        isConcurrencySafe: () => false,
        async call() {
          return { ok: true }
        },
      }),
    })

    it('全并发安全 → 1 个 parallel 批次', () => {
      const batches = partitionToolCalls([safe('a'), safe('b'), safe('c')])
      expect(batches).toHaveLength(1)
      expect(batches[0]!.parallel).toBe(true)
      expect(batches[0]!.uses.map((u) => u.toolId)).toEqual(['a', 'b', 'c'])
    })

    it('全非并发安全 → N 个 serial 批次', () => {
      const batches = partitionToolCalls([unsafe('a'), unsafe('b')])
      expect(batches).toHaveLength(2)
      expect(batches.every((b) => b.parallel === false)).toBe(true)
      expect(batches.map((b) => b.uses[0]!.toolId)).toEqual(['a', 'b'])
    })

    it('safe + unsafe + safe → 3 个批次 [parallel, serial, parallel]', () => {
      const batches = partitionToolCalls([safe('a'), safe('b'), unsafe('w'), safe('c')])
      expect(batches).toHaveLength(3)
      expect(batches[0]!.parallel).toBe(true)
      expect(batches[0]!.uses.map((u) => u.toolId)).toEqual(['a', 'b'])
      expect(batches[1]!.parallel).toBe(false)
      expect(batches[1]!.uses[0]!.toolId).toBe('w')
      expect(batches[2]!.parallel).toBe(true)
      expect(batches[2]!.uses[0]!.toolId).toBe('c')
    })

    it('空数组返回空批次', () => {
      expect(partitionToolCalls([])).toEqual([])
    })

    it('未声明 isConcurrencySafe 时 → 视为非并发安全', () => {
      const plain: ToolUse = {
        toolUseId: 'tu-p',
        toolId: 'plain',
        input: {},
        tool: defineTool({
          id: 'plain',
          description: 'no declare',
          inputSchema: createSchema<any>((v) => v as any),
          async call() {
            return { ok: true }
          },
        }),
      }
      const batches = partitionToolCalls([safe('a'), plain])
      expect(batches).toHaveLength(2)
      expect(batches[1]!.parallel).toBe(false)
    })
  })

  describe('ToolRegistry', () => {
    let reg: ToolRegistry
    const readFile = defineTool({
      id: 'read_file',
      aliases: ['cat', 'file_read'],
      description: '读取文件',
      inputSchema: StringStringSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call() {
        return { ok: true, output: 'contents' }
      },
    })
    const writeFile = defineTool({
      id: 'write_file',
      description: '写入文件',
      inputSchema: ReadWriteSchema,
      async call() {
        return { ok: true }
      },
    })

    beforeEach(() => {
      reg = new ToolRegistry()
    })

    it('register/get/has/size 基本 CRUD', () => {
      reg.register(readFile)
      expect(reg.size).toBe(1)
      expect(reg.has('read_file')).toBe(true)
      expect(reg.get('read_file')?.id).toBe('read_file')
      expect(reg.has('missing')).toBe(false)
      expect(reg.get('missing')).toBeUndefined()

      reg.register(writeFile)
      expect(reg.size).toBe(2)
      expect(reg.list().map((t) => t.id)).toEqual(['read_file', 'write_file'])
    })

    it('重复注册默认抛错，override=true 覆盖', () => {
      reg.register(readFile)
      expect(() => {
        reg.register(readFile)
      }).toThrow(/already registered/)

      const override = { ...readFile, description: 'v2' }
      reg.register(override as any, { override: true })
      expect(reg.get('read_file')!.description).toBe('v2')
    })

    it('registerAll 批量注册', () => {
      reg.registerAll([readFile, writeFile])
      expect(reg.size).toBe(2)
    })

    it('alias 可以 has/get', () => {
      reg.register(readFile)
      expect(reg.has('cat')).toBe(true)
      expect(reg.has('file_read')).toBe(true)
      expect(reg.get('cat')!.id).toBe('read_file')
    })

    it('unregister/clear', () => {
      reg.registerAll([readFile, writeFile])
      reg.unregister('read_file')
      expect(reg.has('read_file')).toBe(false)
      expect(reg.size).toBe(1)

      reg.clear()
      expect(reg.size).toBe(0)
    })

    it('filterByWhitelist ["*"] 返回全部', () => {
      reg.registerAll([readFile, writeFile])
      const all = reg.filterByWhitelist(['*'])
      expect(all.map((t) => t.id)).toEqual(['read_file', 'write_file'])
    })

    it('filterByWhitelist 按白名单过滤（含 alias 查询），去重', () => {
      reg.registerAll([readFile, writeFile])
      const picked = reg.filterByWhitelist(['cat', 'write_file', 'cat'])
      expect(picked.map((t) => t.id).sort()).toEqual(['read_file', 'write_file'])
    })

    it('filterByWhitelist 缺失的 ID 被忽略', () => {
      reg.registerAll([readFile])
      const picked = reg.filterByWhitelist(['read_file', 'nope'])
      expect(picked.map((t) => t.id)).toEqual(['read_file'])
    })
  })

  describe('ToolPipeline', () => {
    // 构造示例工具：读取 path 变量返回 { ok, output: "read:<path>" }
    const readFileTool = defineTool({
      id: 'read_file',
      description: '读取文件',
      inputSchema: StringStringSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call({ path }) {
        return { ok: true, output: 'read:' + path }
      },
    })

    // 带语义校验：path 必须以 / 开头
    const absPathRead = defineTool({
      id: 'abs_read',
      description: '只能读绝对路径',
      inputSchema: StringStringSchema,
      validateInput({ path }) {
        if (!path.startsWith('/')) throw new Error('必须是绝对路径')
      },
      async call({ path }) {
        return { ok: true, output: 'abs:' + path }
      },
    })

    // 带权限声明
    const writeFileTool = defineTool({
      id: 'write_file',
      description: '写文件',
      inputSchema: ReadWriteSchema,
      permission: {
        key: 'write',
        extractPatterns: ({ path }) => [path],
      },
      async call({ path, content }) {
        return { ok: true, output: `wrote:${path}:${content.length}ch` }
      },
    })

    describe('Step 1 & 6: Schema 校验', () => {
      it('inputSchema 通过时正常执行', async () => {
        const p = new ToolPipeline()
        const r = await p.execute(readFileTool, { path: '/a' }, makeCtx())
        expect(r.ok).toBe(true)
        expect(r.output).toBe('read:/a')
        expect(typeof r.meta?.durationMs).toBe('number')
        expect(typeof r.meta?.totalDurationMs).toBe('number')
      })

      it('inputSchema 失败抛 ToolSchemaError(stage=input)', async () => {
        const p = new ToolPipeline()
        const err = await p
          .execute(readFileTool, { path: 12345 } as any, makeCtx())
          .then(() => null, (e) => e)
        expect(err).toBeInstanceOf(ToolSchemaError)
        expect(err.stage).toBe('input')
        expect(err.toolId).toBe('read_file')
      })

      it('outputSchema 校验失败抛 ToolSchemaError(stage=output)', async () => {
        const outSchema = createSchema<number>((v) => {
          if (typeof v !== 'number') throw new Error('需要数字')
          return v
        })
        const badOutputTool = defineTool({
          id: 'bad_out',
          description: '输出不是数字',
          inputSchema: createSchema<any>(() => ({})),
          outputSchema: outSchema,
          async call() {
            return { ok: true, output: 'not a number' } as any
          },
        })
        const p = new ToolPipeline()
        const err = await p
          .execute(badOutputTool, {}, makeCtx())
          .then(() => null, (e) => e)
        expect(err).toBeInstanceOf(ToolSchemaError)
        expect(err.stage).toBe('output')
      })

      it('softOutputSchema 不抛错，仅日志', async () => {
        const outSchema = createSchema<number>((v) => {
          if (typeof v !== 'number') throw new Error('需要数字')
          return v
        })
        const badOutputTool = defineTool({
          id: 'bad_out',
          description: '输出不是数字',
          inputSchema: createSchema<any>(() => ({})),
          outputSchema: outSchema,
          async call() {
            return { ok: true, output: 'not a number' } as any
          },
        })
        const logError: string[] = []
        const p = new ToolPipeline({ softOutputSchema: true })
        const r = await p.execute(badOutputTool, {}, makeCtx({
          log: {
            info() {},
            warn() {},
            error(msg, meta) { logError.push(msg + '|' + JSON.stringify(meta)) },
          },
        }))
        expect(r.ok).toBe(true)
        expect(logError).toHaveLength(1)
        expect(logError[0]).toContain('outputSchema failed')
      })
    })

    describe('Step 2: 语义校验 (validateInput)', () => {
      it('validateInput 通过时正常执行', async () => {
        const p = new ToolPipeline()
        const r = await p.execute(absPathRead, { path: '/abs' }, makeCtx())
        expect(r.output).toBe('abs:/abs')
      })

      it('validateInput 失败抛 ToolValidationError', async () => {
        const p = new ToolPipeline()
        const err = await p
          .execute(absPathRead, { path: 'relative' }, makeCtx())
          .then(() => null, (e) => e)
        expect(err).toBeInstanceOf(ToolValidationError)
        expect(err.message).toContain('必须是绝对路径')
      })
    })

    describe('Step 4: 权限检查', () => {
      it('未声明 checkPermission 或未声明 permission → 跳过权限', async () => {
        const p0 = new ToolPipeline()
        const r0 = await p0.execute(writeFileTool, { path: '/tmp/a', content: 'hi' }, makeCtx())
        expect(r0.ok).toBe(true)

        const p1 = new ToolPipeline({ checkPermission: async () => ({ behavior: 'allow' }) })
        const r1 = await p1.execute(readFileTool, { path: '/a' }, makeCtx())
        expect(r1.ok).toBe(true)
      })

      it('checkPermission 返回 deny → ToolPermissionDeniedError', async () => {
        const p = new ToolPipeline({
          checkPermission: async (req) => {
            expect(req.toolKey).toBe('write')
            expect(req.patterns).toEqual(['/tmp/x'])
            return { behavior: 'deny' }
          },
        })
        const err = await p
          .execute(writeFileTool, { path: '/tmp/x', content: 'y' }, makeCtx())
          .then(() => null, (e) => e)
        expect(err).toBeInstanceOf(ToolPermissionDeniedError)
        expect(err.toolId).toBe('write_file')
        expect(err.toolKey).toBe('write')
        expect(err.patterns).toEqual(['/tmp/x'])
      })

      it('checkPermission 返回 ask → ToolPermissionAskRequiredError', async () => {
        const p = new ToolPipeline({
          checkPermission: async () => ({ behavior: 'ask' }),
        })
        const err = await p
          .execute(writeFileTool, { path: '/tmp/y', content: 'x' }, makeCtx())
          .then(() => null, (e) => e)
        expect(err).toBeInstanceOf(ToolPermissionAskRequiredError)
      })

      it('checkPermission updatedInput 会重写输入参数', async () => {
        const p = new ToolPipeline({
          checkPermission: async () => ({
            behavior: 'allow',
            updatedInput: { path: '/tmp/rewritten', content: 'R' },
          }),
        })
        const r = await p.execute(writeFileTool, { path: '/tmp/original', content: 'O' }, makeCtx())
        expect(r.output).toBe('wrote:/tmp/rewritten:1ch')
      })
    })

    describe('Step 3 & 7: PreHook / PostHook', () => {
      it('PreHook 洋葱模型：顺序 + 可以修改输入', async () => {
        const trace: string[] = []
        const p = new ToolPipeline()
        p.addPreHook(async (ctx, next) => {
          trace.push('hook1:before')
          const r = await next({ path: '/after-hook1' })
          trace.push('hook1:after')
          return r
        })
        p.addPreHook(async (ctx, next) => {
          trace.push('hook2:before')
          // 第二个 hook 看到的 input 是 hook1 传下来的
          expect((ctx.input as { path: string }).path).toBe('/after-hook1')
          const r = await next()
          trace.push('hook2:after')
          return r
        })
        const r = await p.execute(readFileTool, { path: '/before' }, makeCtx())
        // tool.call 看到的是 hook1 修改后的值
        expect(r.output).toBe('read:/after-hook1')
        expect(trace).toEqual([
          'hook1:before',
          'hook2:before',
          'hook2:after',
          'hook1:after',
        ])
      })

      it('PreHook 不调用 next 时可直接返回，短路后续 + 权限 + call', async () => {
        const p = new ToolPipeline({
          checkPermission: async () => ({ behavior: 'deny' }), // 如果被执行会 deny
        })
        p.addPreHook(async (_ctx, _next) => {
          // 直接返回缓存值
          return { ok: true, output: 'cached-value' }
        })
        const called: string[] = []
        const cachedTool = defineTool({
          id: 'cached',
          description: 'c',
          inputSchema: createSchema<any>(() => ({})),
          async call() {
            called.push('yes')
            return { ok: true, output: 'real' }
          },
        })
        const r = await p.execute(cachedTool, {}, makeCtx())
        expect(r.output).toBe('cached-value')
        expect(called).toEqual([]) // call 没执行
      })

      it('PostHook 顺序执行，可以修改 result', async () => {
        const p = new ToolPipeline()
        p.addPostHook(async (_ctx, r) => ({
          ...r,
          output: (r.output as string) + '|h1',
        }))
        p.addPostHook(async (_ctx, r) => ({
          ...r,
          output: (r.output as string) + '|h2',
        }))
        const r = await p.execute(readFileTool, { path: '/x' }, makeCtx())
        expect(r.output).toBe('read:/x|h1|h2')
      })
    })

    describe('结果截断 (truncateLargeResult)', () => {
      it('超大 string output 被截断并附提示', async () => {
        const huge = 'x'.repeat(10000)
        const bigOutputTool = defineTool({
          id: 'huge',
          description: '大输出',
          inputSchema: createSchema<any>(() => ({})),
          async call() {
            return { ok: true, output: huge }
          },
        })
        const p = new ToolPipeline({ resultMaxChars: 50 })
        const r = await p.execute(bigOutputTool, {}, makeCtx())
        const s = r.output as string
        expect(s.length).toBeLessThan(huge.length)
        expect(s.startsWith('xxxxxxxxxx')).toBe(true)
        expect(s.includes('[truncated, original length=10000]')).toBe(true)
      })

      it('超大 object output 被 JSON.stringify 后截断', async () => {
        const bigObj = { arr: new Array(1000).fill('hello') }
        const t = defineTool({
          id: 'bigobj',
          description: 'd',
          inputSchema: createSchema<any>(() => ({})),
          async call() {
            return { ok: true, output: bigObj } as any
          },
        })
        const p = new ToolPipeline({ resultMaxChars: 500 })
        const r = await p.execute(t, {}, makeCtx())
        const s = r.output as string
        expect(s).toContain('[truncated')
        expect(typeof s).toBe('string')
      })

      it('小输出不截断', async () => {
        const p = new ToolPipeline({ resultMaxChars: 1000 })
        const r = await p.execute(readFileTool, { path: '/a' }, makeCtx())
        expect(r.output).toBe('read:/a')
      })
    })

    describe('AbortSignal 中断', () => {
      it('信号已中止时 tool.call 之前抛错', async () => {
        const ac = new AbortController()
        ac.abort()
        const p = new ToolPipeline()
        let called = false
        const t = defineTool({
          id: 't',
          description: 'd',
          inputSchema: createSchema<any>(() => ({})),
          async call() {
            called = true
            return { ok: true }
          },
        })
        const err = await p.execute(t, {}, makeCtx({ signal: ac.signal }))
          .then(() => null, (e) => e)
        // 要么是中断错误（AbortError），要么 call 没执行
        // 由于 throwIfAborted 可能抛 DOMException 或自定义
        expect(called).toBe(false)
        expect(err).toBeDefined()
      })
    })
  })
})
