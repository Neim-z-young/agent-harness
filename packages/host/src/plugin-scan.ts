/**
 * 插件代码**静态扫描**（P1-5：开闸后的预警）。
 *
 * ## 它是什么、不是什么
 * `allowPluginCode: true` 之后，`.harness/plugins/*.ts` 以**完整 Node 权限**在宿主进程里跑：
 * 没有 worker 边界、没有 API 白名单。默认关闭是好的止损，但**开闸即全权**。
 *
 * 这个文件做的是**装配期预警**，**不是边界**：
 * - 能挡住的是"顺手写了点危险调用，自己没意识到"；
 * - 挡不住的是任何有心绕过（拼接 `process['e' + 'nv']`、间接 eval、动态 import）。
 *
 * 所以在文案与文档里**反复**说清这一点 —— 把它当边界用，就是新的一次"看起来隔离了"。
 * 真正的边界要等 `worker` / WASI（见 `sandbox-isolation-plan.md` §9 的 P1-5 备注）。
 *
 * ## 形态
 * 纯函数（`src: string` 进、findings 出），逐行正则。与 `checkSandboxConfig` 同范式：
 * **只给结论、不决定后果** —— 是 warn 还是 refuse 由装配方按配置决定。
 */

/** 一条扫描命中 */
export interface PluginCodeFinding {
  /** 规则 id（配置/文档引用用） */
  rule: string
  /** 人读：这类调用能动什么 */
  label: string
  /** 行号（1 起） */
  line: number
  /** 命中原文（去空白，供人一眼看出是不是误报） */
  evidence: string
}

/** 扫描规则 */
interface ScanRule {
  id: string
  label: string
  /** 命中该规则的正则（逐行匹配） */
  pattern: RegExp
}

/**
 * 规则表。**每条都要能说出"它动得了什么"** —— 说不出来的规则别进表，
 * 否则告警就成了噪声，而噪声的最终归宿是被整段忽略。
 */
export const PLUGIN_CODE_RULES: ScanRule[] = [
  {
    id: 'child-process',
    label: '起子进程（等同拿到宿主的全部执行权）',
    pattern: /\b(?:spawn|spawnSync|exec|execSync|execFile|fork)\s*\(|['"]node:child_process['"]|from\s+['"]child_process['"]/,
  },
  {
    id: 'fs-write',
    label: '写文件系统（可落到工作目录之外）',
    pattern: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|rmSync|rm|rmdirSync|unlinkSync|unlink|renameSync|rename|truncateSync|copyFileSync)\s*\(/,
  },
  {
    id: 'env',
    label: '读宿主环境变量（凭据泄漏面）',
    pattern: /\bprocess\.env\b/,
  },
  {
    id: 'eval',
    label: '动态执行代码（eval / new Function）',
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
  },
  {
    id: 'network',
    label: '出网（可外传读到的内容）',
    pattern: /\bfetch\s*\(|https?\.request\s*\(|net\.connect\s*\(|new\s+WebSocket\s*\(/,
  },
  {
    id: 'process-exit',
    label: '终止宿主进程',
    pattern: /\bprocess\.exit\s*\(/,
  },
]

/**
 * 扫描一段插件源码。
 *
 * 逐行匹配（而不是整段 match）只为拿到**行号** —— 报告里给不出位置的告警，
 * 用户只能全文搜索，那和没报差不多。
 */
export function scanPluginCode(src: string): PluginCodeFinding[] {
  const out: PluginCodeFinding[] = []
  const lines = src.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // 注释行跳过：把"文档里写了 spawn"当成命中，是最快毁掉这类告警可信度的方式
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue
    for (const r of PLUGIN_CODE_RULES) {
      const m = line.match(r.pattern)
      if (!m) continue
      out.push({ rule: r.id, label: r.label, line: i + 1, evidence: (m[0] ?? '').trim() })
    }
  }
  return out
}

/** 把命中项压成一行行可进 notice 的文本（`文件:行 [规则] 说明 —— 证据`） */
export function formatPluginScanFindings(file: string, findings: PluginCodeFinding[]): string[] {
  return findings.map((f) => `${file}:${f.line} [${f.rule}] ${f.label} —— ${f.evidence}`)
}
