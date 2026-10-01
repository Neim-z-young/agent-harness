import { describe, it, expect } from 'bun:test'
import { AGENT_CARD_PATH, A2A_PROTOCOL_VERSION, AgentCard as AgentCardFns } from '@a2a-js/sdk'
import type { AgentDefinition } from '@harness/agent'
import { BEARER_SCHEME_NAME, buildAgentCard, cardToJSON, selectExposedAgents, skillOf } from './card'

function agent(over: Partial<AgentDefinition> & { id: string }): AgentDefinition {
  return {
    name: over.id,
    description: `desc:${over.id}`,
    mode: 'primary',
    tools: ['*'],
    permission: { '*': 'allow' },
    ...over,
  }
}

const AGENTS: AgentDefinition[] = [
  agent({ id: 'default', name: '默认 Agent', description: '主 Agent', tags: ['general'] }),
  agent({ id: 'reader', mode: 'subagent', description: '只读子 Agent' }),
  agent({ id: 'coord', mode: 'coordinator', description: '调度器' }),
]

const URL = 'http://127.0.0.1:4321/a2a'

describe('AgentCard 生成', () => {
  it('协议版本写在 supportedInterfaces，顶层 version 是 agent 自身版本（不混）', () => {
    const card = buildAgentCard({ agents: AGENTS, url: URL, version: '9.9.9' })
    expect(card.supportedInterfaces).toHaveLength(1)
    expect(card.supportedInterfaces[0]!.protocolVersion).toBe(A2A_PROTOCOL_VERSION)
    expect(card.supportedInterfaces[0]!.protocolVersion).toBe('1.0')
    expect(card.supportedInterfaces[0]!.url).toBe(URL)
    expect(card.supportedInterfaces[0]!.protocolBinding).toBe('JSONRPC')
    // 顶层 version 不是协议版本
    expect(card.version).toBe('9.9.9')
    // 也没有 `protocol_version` 这种字段
    expect((card as unknown as Record<string, unknown>).protocol_version).toBeUndefined()
  })

  it('默认只暴露 primary（subagent / coordinator 不对外）', () => {
    const card = buildAgentCard({ agents: AGENTS, url: URL })
    expect(card.skills.map((s) => s.id)).toEqual(['default'])
  })

  it('exposeNonPrimary 打开后才暴露全部角色', () => {
    const card = buildAgentCard({ agents: AGENTS, url: URL, exposeNonPrimary: true })
    expect(card.skills.map((s) => s.id)).toEqual(['default', 'reader', 'coord'])
  })

  it('agentIds 白名单在"可暴露集合"之上再收窄（不能借它绕过 primary 限制）', () => {
    expect(buildAgentCard({ agents: AGENTS, url: URL, agentIds: ['reader'] }).skills).toEqual([])
    expect(
      buildAgentCard({ agents: AGENTS, url: URL, exposeNonPrimary: true, agentIds: ['reader'] }).skills.map((s) => s.id),
    ).toEqual(['reader'])
  })

  it('capabilities.streaming = true（一期就要支持 SSE）', () => {
    const card = buildAgentCard({ agents: AGENTS, url: URL })
    expect(card.capabilities?.streaming).toBe(true)
    expect(card.capabilities?.pushNotifications).toBe(false)
  })

  it('未配 token ⇒ 声明匿名可用（不声明任何安全方案）', () => {
    const card = buildAgentCard({ agents: AGENTS, url: URL })
    expect(card.securitySchemes).toEqual({})
    expect(card.securityRequirements).toEqual([])
  })

  it('配了 token ⇒ 同时声明 securitySchemes 与 securityRequirements（缺一客户端会不知道要带凭据）', () => {
    const card = buildAgentCard({ agents: AGENTS, url: URL, token: 'secret' })
    const scheme = card.securitySchemes[BEARER_SCHEME_NAME]
    expect(scheme?.scheme?.$case).toBe('httpAuthSecurityScheme')
    expect(scheme?.scheme?.value).toMatchObject({ scheme: 'Bearer' })
    expect(card.securityRequirements).toEqual([{ schemes: { [BEARER_SCHEME_NAME]: { list: [] } } }])
  })

  it('卡片名/描述缺省取首个暴露 Agent，可显式覆盖', () => {
    const auto = buildAgentCard({ agents: AGENTS, url: URL })
    expect(auto.name).toBe('默认 Agent')
    expect(auto.description).toBe('主 Agent')
    const named = buildAgentCard({ agents: AGENTS, url: URL, name: 'N', description: 'D' })
    expect(named.name).toBe('N')
    expect(named.description).toBe('D')
  })

  it('无可用 Agent 时不编造技能清单，但卡片照发（客户端至少要能拿到协议版本）', () => {
    const card = buildAgentCard({ agents: [], url: URL })
    expect(card.skills).toEqual([])
    expect(card.supportedInterfaces[0]!.protocolVersion).toBe('1.0')
    expect(card.name).toBe('Agent Harness')
  })

  it('技能映射带 tags 与文本媒体类型', () => {
    const s = skillOf(AGENTS[0]!)
    expect(s).toMatchObject({
      id: 'default',
      name: '默认 Agent',
      description: '主 Agent',
      tags: ['general'],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      examples: [],
    })
    // 无 tags 时是空数组而不是 undefined（A2A 的 repeated 字段不接受 undefined）
    expect(skillOf(AGENTS[1]!).tags).toEqual([])
  })

  it('卡片必须走 cardToJSON 序列化：裸 JSON.stringify 会丢掉整个安全方案', () => {
    const card = buildAgentCard({ agents: AGENTS, url: URL, token: 't' })

    // ✅ 正确出口
    const wire = cardToJSON(card) as Record<string, any>
    expect(wire.supportedInterfaces[0].protocolVersion).toBe('1.0')
    expect(wire.skills[0].inputModes).toEqual(['text/plain'])
    expect(wire.securitySchemes[BEARER_SCHEME_NAME].httpAuthSecurityScheme.scheme).toBe('Bearer')

    // ❌ 裸序列化：判别式联合原样落成 {$case, value}，客户端读不到
    const raw = JSON.parse(JSON.stringify(card)) as Record<string, any>
    expect(raw.securitySchemes[BEARER_SCHEME_NAME].httpAuthSecurityScheme).toBeUndefined()
    expect(raw.securitySchemes[BEARER_SCHEME_NAME].scheme.$case).toBe('httpAuthSecurityScheme')

    // 走 SDK 的 fromJSON 回读，安全方案仍在（证明 wire 形状对得上）
    const back = AgentCardFns.fromJSON(wire)
    expect(back.securitySchemes[BEARER_SCHEME_NAME]?.scheme?.$case).toBe('httpAuthSecurityScheme')
  })

  it('AGENT_CARD_PATH 取自 SDK 常量（不是手写字符串）', () => {
    expect(AGENT_CARD_PATH).toBe('.well-known/agent-card.json')
  })
})

describe('selectExposedAgents', () => {
  it('缺省只 primary；exposeNonPrimary 全给；agentIds 空数组视为不限制', () => {
    expect(selectExposedAgents(AGENTS).map((a) => a.id)).toEqual(['default'])
    expect(selectExposedAgents(AGENTS, { exposeNonPrimary: true })).toHaveLength(3)
    expect(selectExposedAgents(AGENTS, { agentIds: [] }).map((a) => a.id)).toEqual(['default'])
  })
})
