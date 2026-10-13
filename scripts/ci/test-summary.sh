#!/usr/bin/env bash
# P3-3：三平台 CI 的「测试汇总 + 判定」。
#
# 为什么要单独一个脚本而不是在 workflow 里直接 `bun run test`：
# 1. **记录跳过条数**：Windows 上 bash 相关用例本来就会跳过（没有 bash 语义），
#    但"跳过多少"必须看得见 —— 否则全跳过也能绿灯，那 CI 就是个摆设。
# 2. **阈值判定**：pass 数低于下限说明"整包没跑起来"（而不是"都通过了"）。
#    这两种形态在 CI 界面上长得一样，只有数字能区分。
# 3. 同样的判定本地也能跑：`bash scripts/ci/test-summary.sh /tmp/t.log`。
#
# 用法：test-summary.sh [日志路径] [平台标签]
#   平台标签缺省取 `uname -s`；CI 里传 `${{ runner.os }}`（Linux / macOS / Windows）。
set -uo pipefail

LOG="${1:-/tmp/harness-ci-test.log}"
PLATFORM="${2:-$(uname -s)}"

# 下限：本机基线约 2900 pass（2026-10-12）。取 2000 是**防"整包没跑起来"**，
# 不是防"少量回归" —— 少量回归由 `fail > 0` 抓，这两件事必须分开判。
MIN_PASS="${MIN_PASS:-2000}"
# 跳过上限：linux 上 P1-3 的 5 条会 skip（本机没有 sandbox-exec），是有意的；
# 超过这个数说明"某一片被整体跳掉了"，需要人看一眼。
MAX_SKIP="${MAX_SKIP:-200}"
# 单包超时（秒）。`0`（默认）＝ 不分包，整轮 `bun run test`（既有行为）。
#
# ★为什么要这个开关（2026-10-13 实测）：`bun run --filter '*' test` 是**逐包链式**跑的，
# 且 `core` 是绝大多数包的依赖 ⇒ **一个包挂住，它下游的 22 个包一个都不会启动**，
# 整步只能等 GitHub 的步骤超时，日志里唯一线索是"卡住的那个包"。开了单包超时之后：
#   ① 挂住的包被单独杀掉并**在日志与汇总里记名**；② 其余包照常跑完（拿到它们的真实结果）；
#   ③ `pass` 汇总仍然可信（少的那部分被记名，不会伪装成"都通过了"）。
# 本机不需要它（`bun run test` 约 1-2 分钟），CI 的 Windows 上才开。
PER_PKG_TIMEOUT="${PER_PKG_TIMEOUT:-0}"

mkdir -p "$(dirname "$LOG")"
: > "$LOG"

# coreutils 的 `timeout` 才能按秒杀进程。⚠️ Windows 的 `System32\timeout.exe` 是**另一个程序**
# （它只是"暂停若干秒"的等待工具，不执行命令）—— 用 `--version` 区分：coreutils 认它，
# Windows 那个会报语法错。拿不到就自动退回整轮跑法（不猜、不硬跑）。
have_gnu_timeout() {
  command -v timeout >/dev/null 2>&1 && timeout --version >/dev/null 2>&1
}

TIMED_OUT=""
if [ "$PER_PKG_TIMEOUT" -gt 0 ] 2>/dev/null && have_gnu_timeout; then
  echo "== bun test 逐包（单包超时 ${PER_PKG_TIMEOUT}s）（${PLATFORM}）=="
  for d in packages/*/ packages/plugins/*/; do
    [ -f "$d/package.json" ] || continue
    # 只跑声明了 test 脚本的包（与 bun 的 filter 同口径；缺脚本不算失败）
    grep -q '"test"[[:space:]]*:' "$d/package.json" || continue
    echo "===== $d =====" >>"$LOG"
    ( cd "$d" && timeout "$PER_PKG_TIMEOUT" bun run test ) >>"$LOG" 2>&1
    rc=$?
    if [ "$rc" -eq 124 ]; then
      TIMED_OUT="$TIMED_OUT $d"
      echo "!!!!! 单包超时（${PER_PKG_TIMEOUT}s 未结束，已杀掉）：$d" >>"$LOG"
    fi
  done
  # 逐包模式下"整体退出码"没有意义（上面已逐包判过），统一按 0 交给下面的阈值判定
  CODE=0
else
  if [ "$PER_PKG_TIMEOUT" -gt 0 ] 2>/dev/null; then
    echo "::warning::未找到 coreutils 的 timeout，退回整轮跑法（PER_PKG_TIMEOUT 不生效）"
  fi
  echo "== bun run test（${PLATFORM}）=="
  bun run test >"$LOG" 2>&1
  CODE=$?
fi

# ⚠️ 只读 bun 的**汇总行**（`N pass` / `N fail` / `N skip`）：
# 数 `(fail)` 明细行会双计（每个失败的包各报一次），实测对不上。
sum() { grep -oE "[0-9]+ $1" "$LOG" | awk '{s+=$1} END {print s+0}'; }
PASS=$(sum pass)
FAIL=$(sum fail)
SKIP=$(sum skip)
# "Ran 451 tests" → 取 $2（$1 是 "Ran"、$3 是 "tests"）
TOTAL=$(grep -oE "Ran [0-9]+ tests" "$LOG" | awk '{s+=$2} END {print s+0}')

echo "pass=$PASS fail=$FAIL skip=$SKIP tests=$TOTAL exit=$CODE"
if [ -n "$TIMED_OUT" ]; then
  echo "单包超时的包：$TIMED_OUT"
fi

# CI 上写进 step summary（本地没有这个文件时静默跳过）
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### 测试汇总（${PLATFORM}）"
    echo
    echo "| pass | fail | skip | 用例数 | bun 退出码 |"
    echo "|---|---|---|---|---|"
    echo "| $PASS | $FAIL | $SKIP | $TOTAL | $CODE |"
    echo
    echo "下限：pass ≥ ${MIN_PASS}；skip ≤ ${MAX_SKIP}（Windows 上 bash 相关用例会跳过，属预期）"
    if [ -n "$TIMED_OUT" ]; then
      echo
      echo "**单包超时（${PER_PKG_TIMEOUT}s 未结束，已杀掉）：**"
      for d in $TIMED_OUT; do echo "- \`$d\`"; done
      echo
      echo "> ⚠️ 这些包**没有**跑完 —— 它们的 pass 数不计入上面的汇总，别把汇总当"全绿"。"
    fi
  } >>"$GITHUB_STEP_SUMMARY"
fi

rc=0
pass_ok=1
skip_ok=1
# 单包超时 = 那一包没跑完：任何平台上都算失败（Windows 的 continue-on-error 会兜住 job 结论，
# 但这条 error 会留在日志/注解里 —— 挂住的包绝不能静默）
for d in $TIMED_OUT; do
  echo "::error::$PLATFORM 的 ${d} 单包超时（${PER_PKG_TIMEOUT}s 未结束）—— 该包一个用例都没跑完"
  rc=1
  pass_ok=0
done
if [ "$PASS" -lt "$MIN_PASS" ]; then
  echo "::error::$PLATFORM 只跑了 $PASS 条（下限 ${MIN_PASS}）—— 整包没跑起来，不是“都通过了”"
  rc=1
  pass_ok=0
fi
if [ "$SKIP" -gt "$MAX_SKIP" ]; then
  echo "::error::$PLATFORM 跳过 $SKIP 条（上限 ${MAX_SKIP}）—— 疑似某一片被整体跳掉"
  rc=1
  skip_ok=0
fi
if [ "$FAIL" -gt 0 ]; then
  echo "::error::$PLATFORM 有 $FAIL 条失败"
  grep -E "^\(fail\)" "$LOG" | head -30
  rc=1
fi

# Windows：只放行**失败**（计划里的"bash 语义差异"白名单），
# ⚠️ 不放行 pass 阈值与 skip 超额 —— 那两条说的不是平台差异，而是"这一轮没真跑"。
if [ "$PLATFORM" = "Windows" ] && [ "$FAIL" -gt 0 ] && [ "$pass_ok" -eq 1 ] && [ "$skip_ok" -eq 1 ]; then
  echo "::warning::Windows 上 $FAIL 条失败按“平台差异白名单”处理（不阻断），请对照 summary 核对是否都是 bash 相关"
  rc=0
fi

if [ "$CODE" -ne 0 ] && [ "$rc" -eq 0 ]; then
  echo "::warning::bun 退出码 ${CODE}，但汇总数字在阈值内（可能是 worker 层面的非零退出）"
fi

exit "$rc"
