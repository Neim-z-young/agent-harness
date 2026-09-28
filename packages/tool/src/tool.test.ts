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
  withJsonSchema,
  partitionToolCalls,
  parseMcpToolId,
  filterMcpTools,
  supplyMcpTools,
  normalizeToolError,
  McpToolIndex,
  resolveMcpTool,
  READONLY_TOOLS_SENTINEL,
  formatToolWhitelist,
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

    // ===== 只读哨兵：Agent 未声明 tools 时的兜底白名单 =====
    describe(`filterByWhitelist 哨兵 ${READONLY_TOOLS_SENTINEL}`, () => {
      it('listReadOnly 只返回 isReadOnly() 为 true 的工具', () => {
        reg.registerAll([readFile, writeFile])
        expect(reg.listReadOnly().map((t) => t.id)).toEqual(['read_file'])
      })

      it('未声明 isReadOnly 的工具不算只读（Fail-Closed）', () => {
        // defineTool 会把默认值补成 () => false，等价于「保守视为可写」
        reg.registerAll([readFile, writeFile])
        expect(reg.get('write_file')!.isReadOnly!(undefined)).toBe(false)
        expect(reg.listReadOnly().map((t) => t.id)).not.toContain('write_file')
      })

      it('isReadOnly 抛错时按可写处理，不影响其他工具', () => {
        reg.register(readFile)
        reg.register({
          ...writeFile,
          isReadOnly: () => { throw new Error('boom') },
        } as any)
        expect(reg.listReadOnly().map((t) => t.id)).toEqual(['read_file'])
      })

      it('哨兵展开为全部只读工具（写工具被排除）', () => {
        reg.registerAll([readFile, writeFile])
        expect(reg.filterByWhitelist([READONLY_TOOLS_SENTINEL]).map((t) => t.id)).toEqual(['read_file'])
      })

      it('哨兵可与普通 id 混写（展开处保持注册顺序，去重）', () => {
        reg.registerAll([readFile, writeFile])
        expect(reg.filterByWhitelist([READONLY_TOOLS_SENTINEL, 'write_file']).map((t) => t.id))
          .toEqual(['read_file', 'write_file'])
        expect(reg.filterByWhitelist([READONLY_TOOLS_SENTINEL, 'read_file']).map((t) => t.id))
          .toEqual(['read_file'])
      })

      it('不是通配：只读哨兵不等于「全部工具」', () => {
        reg.registerAll([readFile, writeFile])
        expect(reg.filterByWhitelist([READONLY_TOOLS_SENTINEL])).toHaveLength(1)
        expect(reg.filterByWhitelist(['*'])).toHaveLength(2)
      })

      it('同名普通工具优先直选：注册 id 恰为 @readonly 的普通（非只读）工具时，filterByWhitelist(["@readonly"]) 返回该工具本身', () => {
        const readonlyNamed = defineTool({
          id: '@readonly',
          description: '一个恰好叫 @readonly 的普通可写工具',
          inputSchema: ReadWriteSchema,
          async call() {
            return { ok: true }
          },
        })
        reg.register(readonlyNamed)
        reg.registerAll([readFile, writeFile])
        const picked = reg.filterByWhitelist([READONLY_TOOLS_SENTINEL])
        expect(picked).toHaveLength(1)
        expect(picked[0]).toBe(readonlyNamed)
        expect(picked[0]!.id).toBe('@readonly')
        expect(reg.listReadOnly().map((t) => t.id)).not.toContain('@readonly')
      })

      it('未注册同名工具时，哨兵仍展开为全部只读工具（回归保护）', () => {
        reg.registerAll([readFile, writeFile])
        expect(reg.has(READONLY_TOOLS_SENTINEL)).toBe(false)
        expect(reg.filterByWhitelist([READONLY_TOOLS_SENTINEL]).map((t) => t.id)).toEqual(['read_file'])
      })

      it('@readonly 与普通 id 混写时遵循新优先级（同名工具直选，无同名才展开哨兵）', () => {
        const readonlyNamed = defineTool({
          id: '@readonly',
          description: '恰好叫 @readonly 的普通工具',
          inputSchema: ReadWriteSchema,
          async call() {
            return { ok: true }
          },
        })
        reg.register(readonlyNamed)
        reg.registerAll([readFile, writeFile])
        expect(reg.filterByWhitelist([READONLY_TOOLS_SENTINEL, 'write_file']).map((t) => t.id))
          .toEqual(['@readonly', 'write_file'])
      })
    })
  })

  describe('formatToolWhitelist', () => {
    it('哨兵渲染为「只读工具（缺省）」，不吐内部字面量', () => {
      expect(formatToolWhitelist([READONLY_TOOLS_SENTINEL])).toBe('只读工具（缺省）')
      expect(formatToolWhitelist([READONLY_TOOLS_SENTINEL])).not.toContain('@')
    })
    it('通配与空/缺失各有明确呈现', () => {
      expect(formatToolWhitelist(['*'])).toContain('全部工具')
      expect(formatToolWhitelist([])).toBe('（无）')
      expect(formatToolWhitelist(undefined)).toBe('（无）')
    })
    it('普通白名单逐项列出', () => {
      expect(formatToolWhitelist(['read_file', 'bash'])).toBe('read_file, bash')
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

      it('抛错路径也要跑 PostHook：schema 失败时能看到归一化后的失败结果', async () => {
        // 回归：Step 1/2/3/6 都是"先 throw、后跳过 Step 7" ⇒ 这些失败对 PostHook 消费方
        // （遥测 tool.fail / skill-forge 失败轨迹）完全不可见。真机表现：同一次会话 6 次丢入参，
        // bash 的 3 次（工具内 return）上报了、read_file 的 3 次（schema 抛错）没上报。
        const p = new ToolPipeline()
        const seen: Array<{ ok?: boolean; code?: string; toolId?: string }> = []
        p.addPostHook(async (ctx, r) => {
          seen.push({ ok: r.ok, code: r.error?.code, toolId: ctx.tool.id })
          return r
        })
        const err = await p
          .execute(readFileTool, { path: 12345 } as any, makeCtx())
          .then(() => null, (e) => e)
        expect(err).toBeInstanceOf(ToolSchemaError) // 异常语义不变，仍抛给调用方
        expect(seen).toEqual([{ ok: false, code: 'TOOL_ERROR', toolId: 'read_file' }])
      })

      it('抛错路径：权限拒绝上报为 PERMISSION_DENIED（telemetry.permission.deny 的唯一来源）', async () => {
        const p = new ToolPipeline({ checkPermission: () => ({ behavior: 'deny' }) })
        const codes: Array<string | undefined> = []
        p.addPostHook(async (_ctx, r) => {
          codes.push(r.error?.code)
          return r
        })
        const err = await p
          .execute(writeFileTool, { path: '/w', content: 'x' }, makeCtx())
          .then(() => null, (e) => e)
        expect(err).toBeInstanceOf(ToolPermissionDeniedError)
        expect(codes).toEqual(['PERMISSION_DENIED'])
      })

      it('抛错路径：ToolPermissionAskRequiredError 是控制流信号，不当失败上报', async () => {
        const p = new ToolPipeline({ checkPermission: () => ({ behavior: 'ask' }) })
        let calls = 0
        p.addPostHook(async (_ctx, r) => {
          calls += 1
          return r
        })
        const err = await p
          .execute(writeFileTool, { path: '/w', content: 'x' }, makeCtx())
          .then(() => null, (e) => e)
        expect(err).toBeInstanceOf(ToolPermissionAskRequiredError)
        expect(calls).toBe(0)
      })

      it('抛错路径：PostHook 自己炸了不能顶掉原始错误', async () => {
        const p = new ToolPipeline()
        p.addPostHook(async () => {
          throw new Error('hook 崩了')
        })
        const err = await p
          .execute(readFileTool, { path: 12345 } as any, makeCtx())
          .then(() => null, (e) => e)
        expect(err).toBeInstanceOf(ToolSchemaError)
        expect(err.message).toContain('input schema validation failed')
      })

      it('normalizeToolError 是错误→结果的唯一映射点（core 侧同源）', () => {
        const denied = normalizeToolError(new ToolPermissionDeniedError('t', 'w', ['/x']))
        expect(denied.error?.code).toBe('PERMISSION_DENIED')
        expect(denied.error?.message).toContain('权限被拒绝')
        const other = normalizeToolError(new Error('boom'))
        expect(other.error?.code).toBe('TOOL_ERROR')
        expect(other.error?.message).toBe('boom')
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

  describe('parseMcpToolId', () => {
    it('解析 mcp__server__tool', () => {
      expect(parseMcpToolId('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' })
    })
    it('server 名可含 __（取首个 __ 之前为 server）', () => {
      expect(parseMcpToolId('mcp__a__b__x')).toEqual({ server: 'a', tool: 'b__x' })
    })
    it('非 mcp__ 前缀或无 __ 返回 undefined', () => {
      expect(parseMcpToolId('bash')).toBeUndefined()
      expect(parseMcpToolId('mcp__gh')).toBeUndefined()
      expect(parseMcpToolId('')).toBeUndefined()
    })
  })

  describe('McpToolIndex + resolveMcpTool', () => {
    it('server 名含 __ 时，登记索引后可精确反解 server 与 tool', () => {
      const idx = new McpToolIndex()
      // server = "a__b"，工具 "x"、"y"；启发式 parseMcpToolId('mcp__a__b__x') 会误判 server='a'
      idx.index('a__b', ['mcp__a__b__x', 'mcp__a__b__y'])
      expect(idx.serverOf('mcp__a__b__x')).toBe('a__b')
      expect(resolveMcpTool('mcp__a__b__x', idx)).toEqual({ server: 'a__b', tool: 'x' })
      expect(resolveMcpTool('mcp__a__b__y', idx)).toEqual({ server: 'a__b', tool: 'y' })
      expect(idx.has('mcp__a__b__x')).toBe(true)
      expect(idx.servers()).toEqual(['a__b'])
    })
    it('未登记的 id 回退到启发式 parseMcpToolId', () => {
      const idx = new McpToolIndex()
      idx.index('github', ['mcp__github__create_issue'])
      expect(resolveMcpTool('mcp__github__create_issue', idx)).toEqual({ server: 'github', tool: 'create_issue' })
      // 未登记的 server 名含 __：回退后按首个 __ 切分
      expect(resolveMcpTool('mcp__a__b__c', idx)).toEqual({ server: 'a', tool: 'b__c' })
    })
    it('空索引（未登记任何 server）时回退启发式切分', () => {
      const idx = new McpToolIndex()
      expect(resolveMcpTool('mcp__github__a', idx)).toEqual({ server: 'github', tool: 'a' })
    })
    it('非 mcp__ 前缀返回 undefined', () => {
      expect(resolveMcpTool('bash', new McpToolIndex())).toBeUndefined()
    })
    it('unindex 移除后回退启发式', () => {
      const idx = new McpToolIndex()
      idx.index('a__b', ['mcp__a__b__x'])
      idx.unindex('a__b')
      expect(idx.has('mcp__a__b__x')).toBe(false)
      expect(resolveMcpTool('mcp__a__b__x', idx)).toEqual({ server: 'a', tool: 'b__x' })
    })
    it('index 幂等重登记：旧工具归属被清除', () => {
      const idx = new McpToolIndex()
      idx.index('srv', ['mcp__srv__a', 'mcp__srv__b'])
      idx.index('srv', ['mcp__srv__c']) // 重新登记后只剩 c
      expect(idx.serverOf('mcp__srv__a')).toBeUndefined()
      expect(idx.serverOf('mcp__srv__c')).toBe('srv')
    })
  })

  describe('filterMcpTools', () => {
    function mkTool(id: string): Tool {
      return {
        id,
        description: id,
        call: async () => ({ ok: true, output: {} }),
      } as unknown as Tool
    }
    const set = [
      mkTool('bash'),
      mkTool('mcp__github__a'),
      mkTool('mcp__github__b'),
      mkTool('mcp__filesystem__re'),
    ]
    const ids = (arr: Tool[]) => arr.map((t) => t.id).sort()

    it('两者均 undefined → 原样透传（MCP 全可见，向后兼容）', () => {
      expect(filterMcpTools(set)).toEqual(set)
      expect(filterMcpTools(set, undefined, undefined)).toEqual(set)
    })
    it('白名单模式：仅保留 server ∈ mcpServers 的工具', () => {
      expect(ids(filterMcpTools(set, ['github']))).toEqual(['bash', 'mcp__github__a', 'mcp__github__b'])
    })
    it('白名单空数组 → 拒绝全部 MCP，普通工具保留', () => {
      expect(ids(filterMcpTools(set, []))).toEqual(['bash'])
    })
    it('黑名单模式：剔除 server ∈ excludeMcpServers 的工具', () => {
      expect(ids(filterMcpTools(set, undefined, ['github']))).toEqual(['bash', 'mcp__filesystem__re'])
    })
    it('白名单优先于黑名单（黑名单内的白名单 server 工具仍保留）', () => {
      expect(ids(filterMcpTools(set, ['github', 'filesystem'], ['github']))).toEqual([
        'bash',
        'mcp__filesystem__re',
        'mcp__github__a',
        'mcp__github__b',
      ])
    })
    it('非 MCP 工具在任意组合下均保留', () => {
      expect(filterMcpTools([mkTool('bash')], [])).toHaveLength(1)
      expect(filterMcpTools([mkTool('bash')], undefined, ['x'])).toHaveLength(1)
    })
    it('server 名匹配前 trim', () => {
      expect(ids(filterMcpTools(set, [' github ']))).toEqual(['bash', 'mcp__github__a', 'mcp__github__b'])
    })
  })

  describe('supplyMcpTools（Agent 可用工具集的最终组装：原生 + MCP 供给）', () => {
    function mkTool(id: string): Tool {
      return { id, description: id, call: async () => ({ ok: true, output: {} }) } as unknown as Tool
    }
    const ids = (arr: Tool[]) => arr.map((t) => t.id).sort()
    // 注册表全量（含两个 MCP server 的工具）
    const all = [
      mkTool('read_file'),
      mkTool('bash'),
      mkTool('mcp__github__a'),
      mkTool('mcp__github__b'),
      mkTool('mcp__filesystem__re'),
    ]
    const freshIndex = new McpToolIndex()

    /** 模拟 core 装配：filterByWhitelist 的结果（`'*'` 全给，显式列表按 id 取） */
    const pick = (whitelist: string[] | ['*']) =>
      whitelist.length === 1 && whitelist[0] === '*'
        ? [...all]
        : (whitelist as string[]).map((id) => all.find((t) => t.id === id)).filter((t): t is Tool => !!t)

    it('★ 核心回归：显式 tools 列表 + mcpServers: [server] ⇒ 该 server 的工具被**供给**进来', () => {
      // 这是修复前的真机形态：agent 写了 mcpServers: ['github']，却一个 MCP 工具都拿不到
      // （filterByWhitelist 已把它们剔掉，旧实现只能做减法 ⇒ 空集）
      const out = supplyMcpTools(pick(['read_file']), all, ['github'], undefined, freshIndex)
      expect(ids(out)).toEqual(['mcp__github__a', 'mcp__github__b', 'read_file'])
    })

    it('mcpServers undefined ⇒ 不供给（MCP 工具只能靠 tools 显式写 id / 或 *）', () => {
      const onlyExplicit = supplyMcpTools(pick(['read_file', 'mcp__github__a']), all, undefined, undefined, freshIndex)
      expect(ids(onlyExplicit)).toEqual(['mcp__github__a', 'read_file'])
      const nothing = supplyMcpTools(pick(['read_file']), all, undefined, undefined, freshIndex)
      expect(ids(nothing)).toEqual(['read_file'])
    })

    it('mcpServers: [] ⇒ 拒绝全部 MCP，连 tools 里显式列出的 MCP id 也剔除（fail-closed）', () => {
      const out = supplyMcpTools(pick(['read_file', 'mcp__github__a']), all, [], undefined, freshIndex)
      expect(ids(out)).toEqual(['read_file'])
    })

    it('通配白名单 + mcpServers: [server] ⇒ 收窄到该 server（`*` 带进来的其他 MCP 被剔除）', () => {
      const out = supplyMcpTools(pick(['*']), all, ['github'], undefined, freshIndex)
      expect(ids(out)).toEqual(['bash', 'mcp__github__a', 'mcp__github__b', 'read_file'])
    })

    it('excludeMcpServers（mcpServers 未定义时生效）剔除显式列出的 MCP 工具', () => {
      const out = supplyMcpTools(pick(['read_file', 'mcp__github__a', 'mcp__filesystem__re']), all, undefined, ['github'], freshIndex)
      expect(ids(out)).toEqual(['mcp__filesystem__re', 'read_file'])
    })

    it('白名单优先于黑名单：同时给出时按白名单供给，忽略黑名单', () => {
      const out = supplyMcpTools(pick(['read_file']), all, ['github'], ['github'], freshIndex)
      expect(ids(out)).toEqual(['mcp__github__a', 'mcp__github__b', 'read_file'])
    })

    it('非 MCP 工具始终不受影响；结果去重（`*` 已带进来时不重复）', () => {
      const out = supplyMcpTools(pick(['*']), all, ['github', 'filesystem'], undefined, freshIndex)
      expect(ids(out)).toEqual(['bash', 'mcp__filesystem__re', 'mcp__github__a', 'mcp__github__b', 'read_file'])
      expect(new Set(out.map((t) => t.id)).size).toBe(out.length)
    })

    it('server 名匹配前 trim', () => {
      const out = supplyMcpTools(pick(['read_file']), all, [' github '], undefined, freshIndex)
      expect(ids(out)).toEqual(['mcp__github__a', 'mcp__github__b', 'read_file'])
    })

    it('归属索引能精确反解 server 名含 __ 的工具（parseMcpToolId 切不出来）', () => {
      const idx = new McpToolIndex()
      idx.index('a__b', ['mcp__a__b__x'])
      const nested = [mkTool('read_file'), mkTool('mcp__a__b__x')]
      const out = supplyMcpTools([nested[0]], nested, ['a__b'], undefined, idx)
      expect(ids(out)).toEqual(['mcp__a__b__x', 'read_file'])
    })
  })
})

describe('withJsonSchema', () => {
  it('只追加 __jsonSchema，不改变 parse/safeParse 行为', () => {
    const base: Schema<{ a: string }> = {
      parse: (v) => v as { a: string },
      safeParse: (v) => ({ success: true as const, data: v as { a: string } }),
    }
    const json = {
      type: 'object' as const,
      properties: { a: { type: 'string', description: '参数 a' } },
      required: ['a'],
      additionalProperties: false,
    }
    const s = withJsonSchema(base, json)
    // 模型可读的入参描述已挂上
    expect(s.__jsonSchema).toEqual(json)
    // 运行时校验行为不变（仍委托原 schema）
    expect(s.parse({ a: 'x' })).toEqual({ a: 'x' })
    expect(s.safeParse({ a: 'x' })).toEqual({ success: true, data: { a: 'x' } })
  })
})
