import { describe, it, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { HarnessApp, buildConfigOverview, checkTelemetryConfig, telemetryPluginOptions } from './index'
import { BusEvent } from '@harness/bus'
import type { Harness } from '@harness/core'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'tel-cfg-'))
}

describe('checkTelemetryConfig', () => {
  it('空/缺省无告警', () => {
    expect(checkTelemetryConfig(undefined)).toEqual([])
    expect(checkTelemetryConfig({ enabled: true })).toEqual([])
  })

  it('未知键提示', () => {
    expect(checkTelemetryConfig({ enabled: true, unknow: 1 }).join()).toContain('telemetry.unknow 未被识别')
  })

  it('非法类型提示', () => {
    expect(checkTelemetryConfig({ enabled: 'yes' }).join()).toContain('telemetry.enabled 应为布尔值')
    expect(checkTelemetryConfig({ debounceMs: 1.5 }).join()).toContain('telemetry.debounceMs 应为非负整数')
    expect(checkTelemetryConfig({ path: '' }).join()).toContain('telemetry.path 应为非空字符串')
    expect(checkTelemetryConfig({ crash: 'x' }).join()).toContain('telemetry.crash 应为布尔值')
  })

  it('otlp 未知键与非法类型提示', () => {
    expect(checkTelemetryConfig({ otlp: { unknow: 1 } }).join()).toContain('telemetry.otlp.unknow 未被识别')
    expect(checkTelemetryConfig({ otlp: { enabled: 'x' } }).join()).toContain('telemetry.otlp.enabled 应为布尔值')
    expect(checkTelemetryConfig({ otlp: { endpoint: 42 } }).join()).toContain('telemetry.otlp.endpoint 应为非空字符串')
    expect(checkTelemetryConfig({ otlp: { headers: 'x' } }).join()).toContain('telemetry.otlp.headers 应为对象')
  })
})

describe('telemetryPluginOptions', () => {
  it('未配置 ⇒ null（不装配）', () => {
    expect(telemetryPluginOptions(undefined)).toBeNull()
  })

  it('合法值逐项映射', () => {
    const o = telemetryPluginOptions({ enabled: false, debounceMs: 200, crash: false, userId: 'abc', path: '/tmp/x.jsonl' })
    expect(o!.enabled).toBe(false)
    expect(o!.debounceMs).toBe(200)
    expect(o!.crash).toBe(false)
    expect(o!.userID).toBe('abc')
    expect(typeof o!.pathBuilder).toBe('function')
    expect((o!.pathBuilder as (s?: string) => string)()).toBe('/tmp/x.jsonl')
  })

  it('非法值丢弃', () => {
    expect(telemetryPluginOptions({ debounceMs: '3' as never, enabled: 'x' as never })).toEqual({})
  })

  it('otlp 合法值映射', () => {
    const o = telemetryPluginOptions({ otlp: { endpoint: 'https://c:4318', enabled: true, headers: { a: 'b' } } })
    const otlp = o!.otlp as { endpoint: string; enabled: boolean; headers: Record<string, string> }
    expect(otlp.endpoint).toBe('https://c:4318')
    expect(otlp.enabled).toBe(true)
    expect(otlp.headers).toEqual({ a: 'b' })
  })
})

describe('buildConfigOverview：telemetry 段', () => {
  it('未启用时说清怎么开', () => {
    expect(buildConfigOverview({ model: 'm' }, 'mock')).toContain('遥测（telemetry）：未启用')
  })

  it('已启用时展示会话级路径', () => {
    const on = buildConfigOverview({ model: 'm', telemetry: {} }, 'mock')
    expect(on).toContain('遥测（telemetry）：已启用')
    expect(on).toContain('会话级 dataDir/sessions/*.telemetry.jsonl')
    expect(on).toContain('崩溃兜底开启')
  })

  it('关闭时展示开关与告警', () => {
    const off = buildConfigOverview({ model: 'm', telemetry: { enabled: false, crash: false } }, 'mock')
    expect(off).toContain('已装配但关闭')
    expect(off).toContain('崩溃兜底已关')
  })

  it('OTLP 开启时展示端点', () => {
    const on = buildConfigOverview({ model: 'm', telemetry: { otlp: { endpoint: 'https://c:4318' } } }, 'mock')
    expect(on).toContain('OTLP 上报开启')
    expect(on).toContain('https://c:4318')
  })
})

describe('boot：telemetry 段真的装配并写盘', () => {
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
    return { app, harness: harness as unknown as Harness, dir, dataDir, chunks }
  }

  function telemetryFilesUnder(root: string): string[] {
    const out: string[] = []
    const walk = (p: string) => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const fp = join(p, e.name)
        if (e.isDirectory()) walk(fp)
        else if (e.name.endsWith('.telemetry.jsonl')) out.push(fp)
      }
    }
    walk(root)
    return out
  }

  it('写 telemetry 段 ⇒ boot 后 publish 事件会落盘遥测文件', async () => {
    const { app, harness, dir } = await bootWith({ telemetry: { debounceMs: 10 } })
    try {
      const Probe = BusEvent.define<{ durationMs: number }>('test.probe')
      await harness.bus.publish(Probe, { durationMs: 5 })
      await new Promise((r) => setTimeout(r, 80))
      const files = telemetryFilesUnder(dir)
      expect(files.length).toBeGreaterThan(0)
      expect(readFileSync(files[0], 'utf8')).toContain('telemetry.bus.test.probe')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      app && undefined
    }
  })

  it('不写 telemetry 段 ⇒ 不生成遥测文件（默认零影响）', async () => {
    const { app, dir } = await bootWith({})
    try {
      await new Promise((r) => setTimeout(r, 80))
      expect(telemetryFilesUnder(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      app && undefined
    }
  })
})