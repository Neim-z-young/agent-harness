/**
 * @harness/core 压缩块性能压测（可复用，手动运行）
 *
 * 针对「上下文压缩·统一块模型」风险项4：session.compacting / setBlocks /
 * blocksPatch 等写块路径的合并去重与持久化频率是否最优。用 mock 模型 + 合成
 * 数据量化，后续可切换真实 ChatProvider 复跑。
 *
 * 用法：
 *   bun run bench/block-perf.ts --scenario=all        # 跑全部场景
 *   bun run bench/block-perf.ts --scenario=scalar-blocks --sizes=100,1000,5000
 *   bun run bench/block-perf.ts --scenario=query-path --rounds=200
 *   bun run bench/block-perf.ts --scenario=compact-gate --rep=500
 *
 * 输出 Markdown 表格，便于贴进开发日志。
 */

import { createHarness, type AgentPlugin } from '../src/index'
import { createMockProvider, makeAgent, makeBlocks, makeMessages, timeMs, createSessionId } from './helpers'

// ===== 参数解析（bun 直接执行，process.argv 可用） =====
function parseArgs(): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]
    const eq = a.indexOf('=')
    if (eq === -1) {
      out[a.replace(/^--/, '')] = '1'
    } else {
      out[a.slice(2, eq)] = a.slice(eq + 1)
    }
  }
  return out
}

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  bold: '\x1b[1m',
}

// ===== 场景1：setBlocks 规模伸缩（append 1 块时 whole-array 重建成本） =====
async function scenarioScalarBlocks(args: Record<string, string>): Promise<void> {
  const sizesStr = args.sizes ?? '100,1000,5000,20000'
  const sizes = sizesStr.split(',').map((s) => parseInt(s.trim(), 10))
  const rep = parseInt(args.rep ?? '200', 10)
  // 预热到最大规模，避免 JIT 冷启动污染小规模样本
  const warmup = Math.max(...sizes)

  const h = await createHarness({ agents: [makeAgent()], chatProvider: createMockProvider() })
  const sid = await createSessionId(h)
  await h.session.setBlocks(sid, makeBlocks(warmup))

  console.log(`\n${COLORS.bold}场景1 · setBlocks 规模伸缩（在已有 ${warmup} 块基础上追加 1 块，取 ${rep} 次平均）${COLORS.reset}`)
  console.log(`|-|---|---|`)
  console.log(`| 已有块数 | 追加 1 块平均耗时 | 推算 1 块重建(μs) |`)
  console.log(`|-|---|---|`)
  for (const size of sizes) {
    // 每档独立会话：精确控制"已有块数"
    const hs = await createHarness({ agents: [makeAgent()], chatProvider: createMockProvider() })
    const sid2 = await createSessionId(hs)
    await hs.session.setBlocks(sid2, makeBlocks(size, { prefix: `s${size}` }))
    // 预热
    for (let i = 0; i < 5; i++) await hs.session.setBlocks(sid2, makeBlocks(1, { prefix: `w${size}_${i}` }))
    let acc = 0
    for (let i = 0; i < rep; i++) {
      acc += await timeMs(() => hs.session.setBlocks(sid2, makeBlocks(1, { prefix: `a${size}_${i}` })))
    }
    const avgMs = acc / rep
    console.log(`| ${size} | ${avgMs.toFixed(3)} ms | ${(avgMs * 1000).toFixed(1)} |`)
    await hs.stop()
  }
  await h.stop()
}

// ===== 场景2：完整 query 链路（runPreModel + blocksPatch 每轮落块） =====
async function scenarioQueryPath(args: Record<string, string>): Promise<void> {
  const rounds = parseInt(args.rounds ?? '200', 10)
  let seq = 0
  const acpLike: AgentPlugin = {
    id: 'bench-acp-premodel',
    async install() {
      return {
        'session.preModel': async (input: any) => {
          // 模拟 ACP 每轮内部折叠出 1 个新块（seq 全局递增 → 每轮一个唯一 id）
          seq++
          input.blocksPatch?.push({
            id: `acp_bench_${seq}`,
            topic: 'bench ACP 折叠',
            summary: `round block ${seq}`,
            startId: `m${seq}`,
            endId: `m${seq}`,
            source: 'acp',
            archiveRef: `acp:${input.sessionId}:${seq}`,
          })
        },
      }
    },
  }
  const h = await createHarness({
    agents: [makeAgent()],
    chatProvider: createMockProvider(),
    internalPlugins: [acpLike],
  })
  const sid = await createSessionId(h)
  // 预热
  await h.agent.query({ sessionId: sid, message: 'warmup' })

  console.log(`\n${COLORS.bold}场景2 · 完整 query 链路（mock model + 每轮 1 个 acp 块，共 ${rounds} 轮）${COLORS.reset}`)
  let acc = 0
  for (let i = 0; i < rounds; i++) {
    acc += await timeMs(() => h.agent.query({ sessionId: sid, message: `round ${i}` }))
  }
  const s = (await h.session.get(sid))!
  const avg = acc / rounds
  console.log(`|-|---|---|`)
  console.log(`| 指标 | 值 |`)
  console.log(`|-|---|---|`)
  console.log(`| 总耗时 | ${acc.toFixed(1)} ms |`)
  console.log(`| 平均每轮 query | ${avg.toFixed(2)} ms |`)
  console.log(`| 结束 blocks 数 | ${s.blocks?.length ?? 0} |`)
  console.log(`| 结束 messages 数 | ${s.messages.length} |`)
  console.log(`| 每轮写块频率 | 1 块/轮 |`)
  await h.stop()
}

// ===== 场景3：compactIfNeeded 折叠门控（折叠 vs 不折叠的写块成本对比） =====
async function scenarioCompactGate(args: Record<string, string>): Promise<void> {
  const rep = parseInt(args.rep ?? '500', 10)
  const seed = 60

  async function runCase(label: string, thresholdTokens: number, refill: number): Promise<number> {
    const h = await createHarness({ agents: [makeAgent()], chatProvider: createMockProvider() })
    const sid = await createSessionId(h)
    for (let i = 0; i < seed; i++) await h.session.addMessage(sid, makeMessages(1, `seed${i}`)[0])
    for (let i = 0; i < 5; i++) await h.session.compactIfNeeded(sid, { thresholdTokens })
    let acc = 0
    for (let i = 0; i < rep; i++) {
      // refill：折叠 case 每轮补回 keepRecent 削掉的消息，保证每次都真命中折叠
      for (let r = 0; r < refill; r++) {
        await h.session.addMessage(sid, makeMessages(1, `rf${i}_${r}`)[0])
      }
      acc += await timeMs(() => h.session.compactIfNeeded(sid, { thresholdTokens }))
    }
    const s = (await h.session.get(sid))!
    const blocks = s.blocks?.length ?? 0
    await h.stop()
    console.log(`| ${label} | ${(acc / rep).toFixed(4)} ms | ${s.messages.length} | ${blocks} |`)
    return acc / rep
  }

  console.log(`\n${COLORS.bold}场景3 · compactIfNeeded 折叠门控（阈值命中折叠 / 未命中 no-op，各 ${rep} 次）${COLORS.reset}`)
  console.log(`|-|---|---|---|`)
  console.log(`| 配置 | 平均耗时 | 剩余 messages | blocks` + ` |`)
  console.log(`|-|---|---|---|`)
  await runCase('命中折叠（threshold=50，每轮真折叠）', 50, 45)
  await runCase('不折叠 no-op（threshold=1e12）', 1e12, 0)
}

// ===== main =====
async function main(): Promise<void> {
  const args = parseArgs()
  const scenario = (args.scenario ?? 'all').toLowerCase()
  const started = performance.now()
  console.log(`${COLORS.dim}@harness/core · 统一块模型性能压测开始${COLORS.reset}\n`)

  const run = {
    'scalar-blocks': () => scenarioScalarBlocks(args),
    'query-path': () => scenarioQueryPath(args),
    'compact-gate': () => scenarioCompactGate(args),
  }
  if (scenario === 'all') {
    await run['scalar-blocks']()
    await run['query-path']()
    await run['compact-gate']()
  } else if (run[scenario]) {
    await run[scenario]()
  } else {
    console.error(`未知场景: ${scenario}（可选 all | scalar-blocks | query-path | compact-gate）`)
    process.exit(1)
  }

  console.log(`\n${COLORS.green}完成，总耗时 ${(performance.now() - started).toFixed(0)} ms${COLORS.reset}`)
  console.log(`${COLORS.dim}提示：切换真实模型 → createHarness({ chatProvider: <真实Provider> }) 后复跑。${COLORS.reset}`)
}

await main()