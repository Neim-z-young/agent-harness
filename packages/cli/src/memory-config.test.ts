/**
 * `config.json → memory` 段：校验 + 映射 + 真装配（含"参数确实生效"的端到端断言）。
 *
 * 为什么值得单独测：这段配置**错了也不报错** —— 键名拼错会被静默忽略、数值传成字符串会让
 * 兜底永不触发，而记忆是"开了就不再盯着"的能力。所以这里既测纯函数，也测 `/memory` 打出来的
 * **实际参数**（证明 config → 插件选项这条路真的通了，不是只写了个映射函数）。
 */
import { describe, it, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessApp, buildConfigOverview, checkMemoryConfig, createProcessLine, memoryPluginOptions } from './index'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'mem-cfg-'))
}

describe('checkMemoryConfig', () => {
  it('未配置 / 全合法 ⇒ 零告警', () => {
    expect(checkMemoryConfig(undefined)).toEqual([])
    expect(
      checkMemoryConfig({ flushAfterTurns: 15, maxLines: 200, maxBytes: 25600, disableInjection: false }),
    ).toEqual([])
  })

  it('拼错的键被点名（否则会被静默忽略）', () => {
    expect(checkMemoryConfig({ flushAfterTurn: 3 }).join()).toContain('memory.flushAfterTurn 未被识别')
  })

  it('类型/取值不合法被点名（字符串最危险：兜底会永不触发）', () => {
    expect(checkMemoryConfig({ flushAfterTurns: '15' }).join()).toContain('memory.flushAfterTurns 应为非负整数')
    expect(checkMemoryConfig({ maxLines: -1 }).join()).toContain('memory.maxLines 应为非负整数')
    expect(checkMemoryConfig({ disableInjection: 'yes' }).join()).toContain('memory.disableInjection 应为布尔值')
  })

  it('上限为 0 会给提示（等于完全不注入，容易被当成"坏了"）', () => {
    expect(checkMemoryConfig({ maxLines: 0 }).join()).toContain('完全不注入')
  })
})

describe('memoryPluginOptions（非法值一律丢弃，不透传给插件）', () => {
  it('合法值逐项映射', () => {
    expect(memoryPluginOptions({ flushAfterTurns: 3, maxLines: 10, maxBytes: 999, disableInjection: true })).toEqual({
      flushAfterTurns: 3,
      maxLines: 10,
      maxBytes: 999,
      disableInjection: true,
    })
  })

  it('非法值丢弃（不写进选项对象）', () => {
    expect(memoryPluginOptions({ flushAfterTurns: '3' as never, maxLines: -2, maxBytes: 1.5 })).toEqual({})
  })

  it('未配置 ⇒ 空对象（插件用自己的默认值）', () => {
    expect(memoryPluginOptions(undefined)).toEqual({})
  })
})

describe('buildConfigOverview：memory 段', () => {
  it('未启用时说清怎么开', () => {
    expect(buildConfigOverview({ model: 'm' }, 'mock')).toContain('长期记忆（memory）：未启用')
  })

  it('已启用时展示生效参数（默认值也显式给出）', () => {
    const on = buildConfigOverview({ model: 'm', plugins: ['memory'] }, 'mock')
    expect(on).toContain('长期记忆（memory）：已启用')
    expect(on).toContain('200 行 / 25600 字节')
    expect(on).toContain('15（默认）')

    const tuned = buildConfigOverview({ model: 'm', plugins: ['memory'], memory: { flushAfterTurns: 3 } }, 'mock')
    expect(tuned).toContain('3 轮')
  })

  it('写了段却没启用 ⇒ 明确告警（而不是默默无效）', () => {
    expect(buildConfigOverview({ model: 'm', memory: { flushAfterTurns: 3 } }, 'mock')).toContain('该段不会生效')
  })
})

describe('boot：memory 段真的传到了插件', () => {
  async function bootWith(config: Record<string, unknown>) {
    const dir = tmp()
    const dataDir = join(dir, '.harness')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config, null, 2))
    const chunks: string[] = []
    const app = new HarnessApp({
      cwd: dir,
      dataDir,
      agentId: 'default',
      provider: 'mock',
      permissionMode: 'allow-all',
      stdout: { write: (s: string) => void chunks.push(s) },
      mockProviderConfig: { defaultResponse: 'hi' },
    })
    const { harness } = await app.boot()
    return { app, harness, chunks, dir, dataDir }
  }

  async function runMemoryCommand(harness: Awaited<ReturnType<typeof bootWith>>['harness'], app: HarnessApp) {
    const sess = await harness.session.create()
    const lines: string[] = []
    const processLine = createProcessLine({ app, harness, session: sess, out: (s) => lines.push(s) })
    await processLine('/memory')
    return lines.join('')
  }

  it('plugins + memory 段 ⇒ /memory 打出配置的上限与轮数', async () => {
    const { app, harness, dir } = await bootWith({
      plugins: ['memory'],
      memory: { flushAfterTurns: 3, maxLines: 50, maxBytes: 4000 },
    })
    try {
      const out = await runMemoryCommand(harness, app)
      expect(out).toContain('注入上限 50 行 / 4000 字节')
      expect(out).toContain('或 3 轮')
    } finally {
      await app.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('只写 memory 段但没启用 ⇒ 告警，且插件确实没装上', async () => {
    const { app, harness, chunks, dir } = await bootWith({ memory: { flushAfterTurns: 2 } })
    try {
      expect(chunks.join('')).toContain('没有启用记忆')
      expect(harness.plugin.list().map((p) => p.plugin.id)).not.toContain('memory')
    } finally {
      await app.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非法值被拒并告警，插件回落默认 15 轮（不静默地"按怪值工作"）', async () => {
    const { app, harness, chunks, dir } = await bootWith({
      plugins: ['memory'],
      memory: { flushAfterTurns: '9' as never, maxLine: 1 as never },
    })
    try {
      const warn = chunks.join('')
      expect(warn).toContain('memory.flushAfterTurns 应为非负整数')
      expect(warn).toContain('memory.maxLine 未被识别')
      expect(await runMemoryCommand(harness, app)).toContain('或 15 轮')
    } finally {
      await app.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
