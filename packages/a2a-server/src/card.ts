/**
 * AgentCard 生成（plan §3.6）：`AgentDefinition[]` → A2A `AgentCard`。
 *
 * ## 三个口径容易写错，这里钉死
 *
 * 1. **顶层 `version` 是"agent 自身版本"，协议版本写在 `supportedInterfaces[].protocolVersion`** ——
 *    把协议版本写到顶层 `version`（或写成 `protocol_version`）是初稿犯过的错：客户端据此判断
 *    "这个 agent 是 1.0 版"会一头雾水，而版本协商（`validateVersion`）看的是 interfaces 里那一份。
 * 2. **`securitySchemes` 只在配了 token 时才声明**：声明了却不校验（或校验了却不声明）
 *    都会让客户端行为不可预期 —— 前者让客户端白带凭据，后者让客户端**根本不知道要带**。
 * 3. **默认只暴露 `primary`**：`subagent` / `coordinator` / `teammate` 是**被主 Agent 调用的
 *    内部角色**，外部按卡片直接把一个 subagent 当独立服务调，会绕过主 Agent 的编排与权限上下文
 *    （plan §10.3 建议默认不暴露、配置开启）。
 *
 * ## 依赖面刻意收窄
 * 本模块**不收 `Host`**，只收 `AgentDefinition[]` + 几个标量。理由同 host 的
 * `ProviderWindowConfigSource`：卡片生成只需要"有哪些 agent、对外地址是什么"，
 * 依赖整个 host 会让测试必须装配一整套 harness（而这一层是纯函数）。
 */
import {
  A2A_PROTOCOL_VERSION,
  AgentCard as AgentCardFns,
  type AgentCard,
  type AgentSkill,
  type SecurityScheme,
} from '@a2a-js/sdk'
import type { AgentDefinition } from '@harness/agent'
import { TEXT_MEDIA_TYPE } from './mapping'

/** JSON-RPC 绑定的名字（SDK 的 `TransportProtocolName` 取值） */
export const JSONRPC_BINDING = 'JSONRPC'

/** 卡片里声明的安全方案名（客户端按它引用 `securityRequirements`） */
export const BEARER_SCHEME_NAME = 'bearer'

export interface BuildAgentCardOptions {
  /** 可用的 Agent 定义（来自 `host.harness.agent.list()`） */
  agents: AgentDefinition[]
  /** 服务对外 URL —— JSON-RPC 端点（如 `http://127.0.0.1:4321/a2a`） */
  url: string
  /** 顶层版本（agent/harness 自身版本），缺省 `0.1.0` */
  version?: string
  /** 卡片名（缺省取首个暴露 Agent 的 name） */
  name?: string
  /** 卡片描述（缺省取首个暴露 Agent 的 description） */
  description?: string
  /** 配了 token ⇒ 卡片声明 Bearer 安全方案；不配 ⇒ 匿名可用（默认只监听本机） */
  token?: string
  /** 是否把非 primary（subagent / coordinator / teammate）也暴露为 skill，默认 false */
  exposeNonPrimary?: boolean
  /** 只暴露这些 agentId（与 `exposeNonPrimary` 取交集之上再做白名单；空数组 = 全暴露） */
  agentIds?: string[]
}

/** 默认对外暴露的 Agent：只暴露 primary（= 可直接对用户的那一类） */
export function selectExposedAgents(
  agents: AgentDefinition[],
  opts: { exposeNonPrimary?: boolean; agentIds?: string[] } = {},
): AgentDefinition[] {
  let list = opts.exposeNonPrimary ? agents : agents.filter((a) => a.mode === 'primary')
  const ids = opts.agentIds
  if (ids && ids.length > 0) list = list.filter((a) => ids.includes(a.id))
  return list
}

/** `AgentDefinition` → A2A `AgentSkill`（一对一：一个 Agent 就是一项能力） */
export function skillOf(def: AgentDefinition): AgentSkill {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    tags: def.tags ?? [],
    examples: [],
    inputModes: [TEXT_MEDIA_TYPE],
    outputModes: [TEXT_MEDIA_TYPE],
    securityRequirements: [],
  }
}

/**
 * 生成 AgentCard。
 *
 * 无可用 Agent 时**不编造**技能清单 —— 卡片照发（客户端至少要能取到卡才知道协议版本），
 * 但 `skills` 为空。调用方（server/CLI）应在启动时把"没有可暴露 agent"作为启动诊断报出去。
 */
export function buildAgentCard(opts: BuildAgentCardOptions): AgentCard {
  const exposed = selectExposedAgents(opts.agents, {
    exposeNonPrimary: opts.exposeNonPrimary,
    agentIds: opts.agentIds,
  })
  const head = exposed[0]
  const hasAuth = Boolean(opts.token)

  const securitySchemes: Record<string, SecurityScheme> = hasAuth
    ? {
        [BEARER_SCHEME_NAME]: {
          scheme: {
            $case: 'httpAuthSecurityScheme',
            value: {
              description: 'HTTP Bearer 认证（token 由服务端配置）',
              scheme: 'Bearer',
              bearerFormat: 'opaque',
            },
          },
        },
      }
    : {}

  return {
    name: opts.name ?? head?.name ?? 'Agent Harness',
    description: opts.description ?? head?.description ?? 'Agent Harness A2A 服务',
    version: opts.version ?? '0.1.0',
    supportedInterfaces: [
      {
        // 协议版本只声明在这里（顶层 version 是 agent 自身版本，别混）
        url: opts.url,
        protocolBinding: JSONRPC_BINDING,
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: '',
      },
    ],
    provider: undefined,
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    defaultInputModes: [TEXT_MEDIA_TYPE],
    defaultOutputModes: [TEXT_MEDIA_TYPE],
    skills: exposed.map(skillOf),
    // 声明了 Bearer ⇒ 必须同时给出 securityRequirements，否则客户端不知道"哪个端点要认证"
    securitySchemes,
    securityRequirements: hasAuth
      ? [{ schemes: { [BEARER_SCHEME_NAME]: { list: [] } } }]
      : [],
    signatures: [],
  }
}

/**
 * 卡片 → 线上 JSON。
 *
 * **必须走它，不能裸 `JSON.stringify(card)`** —— 卡片里有判别式联合
 * （`securitySchemes[*].scheme` 是 `{ $case: 'httpAuthSecurityScheme', value: {…} }`），
 * 裸序列化会输出 `{"$case":…,"value":…}`，而线上格式是 `{"httpAuthSecurityScheme":{…}}`；
 * 客户端 `AgentCard.fromJSON` 读不到，**静默丢掉整个安全方案**（于是"以为匿名可用"）。
 *
 * P0.5 的 spike 恰好用 `securitySchemes: {}` 跑通了裸 `JSON.stringify` —— 那不是"裸序列化可行"，
 * 而是"没有判别式联合时看不出问题"。配了 Bearer 之后它必然错。
 */
export function cardToJSON(card: AgentCard): unknown {
  return AgentCardFns.toJSON(card)
}
