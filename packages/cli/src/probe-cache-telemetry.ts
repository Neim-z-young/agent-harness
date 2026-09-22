/**
 * L3 真机探针：自动前缀缓存的**端到端**取证工具（唯一需要真实 provider 的一层）。
 *
 * 为什么要有它：缓存归因/口径校正这类改动的验证分四层（见 AGENTS.md 与
 * `docs/development-log.md` 续 178 的验证矩阵）——
 *   L1 纯函数单测 → L2 端到端 mock（离线、零 token）→ **L3 真机（本脚本）** → L4 产线遥测。
 * L1/L2 能验"逻辑与装配"，但**验不了**：① `tokenCalibrationScale` 的**取值**（要真 tokenizer）；
 * ② provider 的真实缓存行为（什么时候真的过期/逐出、前缀多长才命中）。这两件事只能真机做。
 *
 * 做法（关键在"独立证据"，不是只看自家指标）：
 *   1. 用**临时 dataDir**，把真实 config.json 复制进去 ⇒ 走真实 provider/密钥，但不污染
 *      `~/.harness` 的会话与遥测文件（跑多少次都不留痕）。
 *   2. **包一层 `globalThis.fetch`**，抓真正发出去的请求体 ⇒ 这是**独立于内部指标**的证据：
 *      系统区哈希、消息条数、body 字节数都从原始请求里量，用于和遥测交叉验证。
 *   3. 读 ACP 落盘的遥测 `{dataDir}/sessions/{sessionId}.telemetry.jsonl`，逐轮打印
 *      `preModel` 与 `providerCache` 两行（含 `cacheMissReason` / `systemChangedParts` /
 *      `calibration` / `overheadTok`）。
 *   4. `PROBE_IDLE_MIN` 可在轮间插真实空闲，用于验证 `idle-expiry` 假设。
 *
 * 用法（需要真实 API 额度；3 轮≈几十秒）：
 *   bun run probe:cache
 *   PROBE_ROUNDS=6 PROBE_IDLE_MIN=6 bun run probe:cache     # 6 轮，轮间空闲 6 分钟
 *   PROBE_KEEP=1 bun run probe:cache                        # 保留临时目录（自己翻文件）
 *
 * 读结果的姿势：`calibration` 连续几轮稳定 ⇒ 把该值写进 `compression.tokenCalibrationScale`；
 * `cacheMissReason != none` 的轮次看 `systemChangedParts`/`systemChangedDetail` —— 那是"谁把
 * 前缀改了"的点名。**单次样本不能当规律**：空闲/过期类结论至少要重复跑两次。
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessApp } from './index'

// ===== 参数（全部走环境变量，不引入 CLI 解析依赖）=====

const ROUNDS = Math.max(1, Number(process.env.PROBE_ROUNDS ?? 3))
const IDLE_MS = Math.max(0, Number(process.env.PROBE_IDLE_MIN ?? 0) * 60_000)
const KEEP = process.env.PROBE_KEEP === '1'
const CONFIG_SRC = process.env.PROBE_CONFIG ?? join(homedir(), '.harness', 'config.json')
const CWD = process.env.PROBE_CWD ?? process.cwd()
const AGENT_ID = process.env.PROBE_AGENT ?? 'default'
/**
 * 每轮发给模型的 prompt。
 *
 * ⚠️ 别只用一句寒暄来测 `calibration`：请求的固定开销（system + 全部工具定义）在真实装配里
 * 可占 **十几 K token**，历史只有几十 token 时，比值反映的几乎全是"工具载荷估得准不准"，
 * 而不是会话正文的 tokenizer 偏差。要标定口径，给一段**接近真实长度**的正文
 * （`PROBE_PROMPT="…长文…"`，或复现一次真实任务）。
 */
const PROMPT = process.env.PROBE_PROMPT ?? '（探针）请只回复 ok，不要调用任何工具。'

// ===== 独立证据：包 fetch 抓请求体 =====

interface CapturedRequest {
  seq: number
  url: string
  /** provider 侧的 system 载荷（OpenAI: messages 里 role=system；anthropic/gemini: 顶层字段） */
  systemTexts: string[]
  /** 请求体里的消息条数（OpenAI 形态；其他形态记 0） */
  messages: number
  /** tools 载荷的条目数（工具载荷常在请求体里占大头，见 overheadTok） */
  tools: number
  bytes: number
  sysHash: string
}

const captured: CapturedRequest[] = []

/** djb2 → 短 hex（只为"这两份一样吗"，不用于安全） */
function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

function installFetchTap(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    try {
      const url = typeof input === 'string' ? input : (input?.url ?? '')
      const body = typeof init?.body === 'string' ? init.body : undefined
      if (body) {
        const parsed = JSON.parse(body) as Record<string, any>
        const sysTexts: string[] = []
        if (Array.isArray(parsed.messages)) {
          for (const m of parsed.messages) {
            if (m?.role !== 'system') continue
            sysTexts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
          }
        }
        // anthropic: 顶层 system（字符串或 block 数组）；gemini: systemInstruction
        if (typeof parsed.system === 'string') sysTexts.push(parsed.system)
        else if (parsed.system) sysTexts.push(JSON.stringify(parsed.system))
        if (parsed.systemInstruction) sysTexts.push(JSON.stringify(parsed.systemInstruction))

        const sysJoined = sysTexts.join('\n---\n')
        captured.push({
          seq: captured.length + 1,
          url,
          systemTexts: sysTexts,
          messages: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
          tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
          bytes: body.length,
          sysHash: shortHash(sysJoined),
        })
      }
    } catch {
      // 抓包失败绝不影响真实请求
    }
    return original(input, init)
  }) as typeof globalThis.fetch
  return () => { globalThis.fetch = original }
}

// ===== 遥测读取 =====

interface TelemetryRow { kind: string; round: number; [k: string]: unknown }

function readTelemetry(dataDir: string, sessionId: string): TelemetryRow[] {
  const p = join(dataDir, 'sessions', `${sessionId}.telemetry.jsonl`)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TelemetryRow)
}

const num = (v: unknown, w = 6): string =>
  (v === null || v === undefined ? '—' : String(v)).padStart(w)

async function main(): Promise<void> {
  // 临时 dataDir：会话/遥测/权限全落在里面，跑完即删（KEEP=1 时保留）
  const dataDir = mkdtempSync(join(tmpdir(), 'harness-probe-'))
  const sessionsDir = join(dataDir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  if (!existsSync(CONFIG_SRC)) {
    console.error(`找不到 config：${CONFIG_SRC}（用 PROBE_CONFIG=<path> 指定）`)
    process.exit(1)
  }
  // 复制而非软链：探针可能想改配置（如临时改 tokenCalibrationScale 做 A/B），
  // 软链会把改动写回真实配置 —— 这是探针绝不该做的事。
  copyFileSync(CONFIG_SRC, join(dataDir, 'config.json'))

  // provider / model 从配置里读（探针要复现**真实**装配，不应该在脚本里另写一套默认值）
  const cfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8')) as {
    provider?: string
    model?: string
  }
  const provider = process.env.PROBE_PROVIDER ?? cfg.provider
  if (!provider) {
    console.error(`config 里没有 provider（用 PROBE_PROVIDER=<id> 指定）：${CONFIG_SRC}`)
    process.exit(1)
  }
  const model = process.env.PROBE_MODEL ?? cfg.model

  const restoreFetch = installFetchTap()
  console.log(`[probe] dataDir=${dataDir}`)
  console.log(
    `[probe] rounds=${ROUNDS} idle=${IDLE_MS}ms agent=${AGENT_ID} provider=${provider} model=${model ?? '(默认)'} cwd=${CWD}\n`,
  )

  const app = new HarnessApp({
    cwd: CWD,
    dataDir,
    agentId: AGENT_ID,
    provider,
    ...(model ? { model } : {}),
    autoResume: false,
  })
  let sessionId = ''
  try {
    const { session } = await app.boot()
    sessionId = session.id
    for (let i = 1; i <= ROUNDS; i++) {
      if (i > 1 && IDLE_MS > 0) {
        console.log(`[probe] 轮间空闲 ${IDLE_MS}ms（验证 idle-expiry 假设）…`)
        await new Promise((r) => setTimeout(r, IDLE_MS))
      }
      const t0 = Date.now()
      await app.send(sessionId, `probe 第 ${i} 轮：${PROMPT}`)
      console.log(`[probe] round ${i} 完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    }
    // writer 有 debounce：等一拍再读文件，否则会以为"最后一行丢了"
    await new Promise((r) => setTimeout(r, 800))
  } finally {
    await app.shutdown().catch(() => {})
    restoreFetch()
  }

  const rows = readTelemetry(dataDir, sessionId)
  const pre = rows.filter((r) => r.kind === 'preModel')
  const cache = rows.filter((r) => r.kind === 'providerCache')

  console.log('\n===== 独立证据：抓到的真实请求体 =====')
  console.log(`${'#'.padStart(2)} ${'sysHash'.padEnd(9)} ${'msgs'.padStart(5)} ${'tools'.padStart(5)} ${'KB'.padStart(6)}`)
  for (const c of captured) {
    console.log(
      `${String(c.seq).padStart(2)} ${c.sysHash.padEnd(9)} ${String(c.messages).padStart(5)} ` +
        `${String(c.tools).padStart(5)} ${(c.bytes / 1024).toFixed(1).padStart(6)}`,
    )
  }
  const hashes = [...new Set(captured.map((c) => c.sysHash))]
  console.log(
    hashes.length === 1
      ? `系统区哈希全程恒定：${hashes[0]}  ⇒ 前缀确实是纯追加`
      : `⚠️ 系统区哈希出现 ${hashes.length} 种（${hashes.join(' / ')}）⇒ 前缀被改过，看下方 systemChangedParts 点名`,
  )

  console.log('\n===== ACP 遥测 =====')
  console.log(
    `${'rnd'.padStart(3)} ${'reqTok'.padStart(7)} ${'occup'.padStart(6)} | ${'cacheRead'.padStart(9)} ` +
      `${'drop'.padStart(6)} ${'idleMs'.padStart(8)} ${'stable'.padStart(6)} ${'kind'.padStart(14)} ${'reason'.padStart(14)} ${'calib'.padStart(6)} ${'overh'.padStart(7)}`,
  )
  const max = Math.max(pre.length, cache.length)
  for (let i = 0; i < max; i++) {
    const p = pre[i]
    const c = cache[i]
    const sys = c?.systemChangedDetail as string[] | undefined
    console.log(
      `${num(p?.round ?? c?.round, 3)} ${num(p?.requestTok, 7)} ` +
        `${p?.occupancy === undefined ? '—'.padStart(6) : (p.occupancy as number).toFixed(3).padStart(6)} | ` +
        `${num(c?.cacheRead, 9)} ${num(c?.cacheDropTokens, 6)} ${num(c?.idleMs, 8)} ${num(c?.prefixStableMessages, 6)} ` +
        `${String(c?.prefixChangedKind ?? '—').padStart(14)} ${String(c?.cacheMissReason ?? '—').padStart(14)} ` +
        `${c?.calibration === null || c?.calibration === undefined ? '—'.padStart(6) : (c.calibration as number).toFixed(3).padStart(6)} ` +
        `${num(c?.overheadTok, 7)}`,
    )
    if (Array.isArray(sys) && sys.length > 0) {
      console.log(`      ↳ 前缀区被改，点名：${sys.join('；')}`)
    }
  }

  const calibs = cache.map((c) => c.calibration).filter((v): v is number => typeof v === 'number')
  if (calibs.length > 0) {
    const mean = calibs.reduce((a, b) => a + b, 0) / calibs.length
    console.log(`\n[probe] calibration 均值 ${mean.toFixed(3)}（<1 说明本地估高了，>1 说明估低了）`)
    console.log('[probe] 取值 = 该均值 × 当前 scale；写回 compression.tokenCalibrationScale 前' +
      '请确认它是**连续多轮稳定**的值，而不是单次样本。')

    // 可信度自检：历史占比太低时，这个比值主要在测"工具载荷估得准不准"
    const last = pre[pre.length - 1]
    const hist = Number(last?.requestTok ?? 0)
    const over = Number(cache[cache.length - 1]?.overheadTok ?? 0)
    if (hist > 0 && over > hist * 10) {
      console.log(
        `[probe] ⚠️ 本轮历史仅 ${hist} tok 而固定开销 ${over} tok（${(over / hist).toFixed(0)}×）——` +
          '此时 calibration 被固定开销主导，**不足以标定会话正文的口径**；' +
          '请用 PROBE_PROMPT 给一段接近真实长度的正文再测。',
      )
    }
  }
  console.log(`\n[probe] 遥测：preModel ${pre.length} 行 / providerCache ${cache.length} 行` +
    `（两者应分别与 LLM 调用数一致；HTTP 请求数 ≠ LLM 调用数）`)

  if (!KEEP) {
    rmSync(dataDir, { recursive: true, force: true })
  } else {
    console.log(`[probe] 已保留临时目录：${dataDir}`)
  }
}

await main()
