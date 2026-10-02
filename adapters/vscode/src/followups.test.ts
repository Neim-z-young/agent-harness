import { describe, expect, it } from 'bun:test'
import { buildFollowups } from './followups'

describe('buildFollowups（P2-v2：按 metadata 分档，不发明它不该知道的信息）', () => {
  it('刚 /new /resume 过 → 换会话档', () => {
    const out = buildFollowups({ contextId: 's_x', sessionSwitched: true })
    expect(out.map((f) => f.prompt)).toContain('/tree')
  })

  it('有活动会话 → 常规档（继续 / stats / tree）', () => {
    const out = buildFollowups({ contextId: 's_x' })
    expect(out.map((f) => f.prompt)).toEqual(['继续', '/stats', '/tree'])
  })

  it('新线程 → 介绍档', () => {
    const out = buildFollowups(undefined)
    expect(out.map((f) => f.prompt)).toEqual(['介绍你能做什么', '/help'])
  })
})
