/**
 * 控制面审批作用域（P3-D，设计稿 §14.2）用例。
 *
 * 只钉两件事：**包装是委派式的**（作用域内短路 / 作用域外原样转交），以及**作用域不外泄**。
 * "作用域外为什么最终是 deny" 不在这里测 —— 那是 A2A asker 的行为
 * （`executor.makeAsker` 在任务上下文外返回 undefined），已由 `executor.test.ts` 覆盖。
 */
import { describe, expect, it } from 'bun:test'
import { buildPermissionPrompt, type PermissionAsker } from '@harness/host'
import { controlApproval, wrapAskerWithControlApproval } from './control-approval'

const REQ = { toolKey: 'bash', patterns: ['rm -rf /tmp'], sessionId: 's1' }

describe('控制面审批作用域（P3-D）', () => {
  it('作用域外：原样委派给内层 asker（不短路、不改答复）', async () => {
    const seen: string[] = []
    const inner: PermissionAsker = async (req) => {
      seen.push(req.toolKey)
      return 'deny'
    }
    const wrapped = wrapAskerWithControlApproval(inner)

    expect(await wrapped(REQ, buildPermissionPrompt(REQ))).toBe('deny')
    expect(seen).toEqual(['bash'])
  })

  it('作用域内：直接给出已确认的答复，内层 asker 一次都不被调用', async () => {
    let calls = 0
    const inner: PermissionAsker = async () => {
      calls += 1
      return 'deny'
    }
    const wrapped = wrapAskerWithControlApproval(inner)

    const answer = await controlApproval.run({ answer: 'allow' }, () => wrapped(REQ, buildPermissionPrompt(REQ)))
    expect(answer).toBe('allow')
    expect(calls).toBe(0)
  })

  it('作用域**不外泄**：run() 结束后立刻回到委派语义', async () => {
    const inner: PermissionAsker = async () => 'deny'
    const wrapped = wrapAskerWithControlApproval(inner)

    await controlApproval.run({ answer: 'always-allow' }, async () => undefined)
    // 若 ALS 泄漏，这里会拿到 'always-allow'（= 上一次调用的授权替下一次作答）
    expect(await wrapped(REQ, buildPermissionPrompt(REQ))).toBe('deny')
  })

  it('并发隔离：两个作用域各自作答，互不串台', async () => {
    const inner: PermissionAsker = async () => 'deny'
    const wrapped = wrapAskerWithControlApproval(inner)

    // 都先 await 一次，确保两个 run() 的作用域在时间上真正重叠
    const inScope = (answer: 'allow' | 'always-deny'): Promise<unknown> =>
      controlApproval.run({ answer }, () => Promise.resolve().then(() => wrapped(REQ, buildPermissionPrompt(REQ))))
    const [a, b] = await Promise.all([inScope('allow'), inScope('always-deny')])

    expect([a, b]).toEqual(['allow', 'always-deny'])
  })
})
