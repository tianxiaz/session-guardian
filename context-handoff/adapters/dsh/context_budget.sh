#!/usr/bin/env bash
# context-handoff · Claude Code 阈值脚本（PreCompact / Stop 两个入口）
#
# 用法（由 hooks.settings.json 调用）：
#   context_budget.sh --precompact   压缩即将发生：拦下来要求先做交接
#   context_budget.sh --stop         每轮结束：越线则要求做交接
#
# 退出码语义（Claude Code 官方）：
#   0 = 放行；2 = 阻断（PreCompact 阻断压缩；Stop 阻断停止并让模型继续）
#
# ⚠️ 诚实声明：官方 PreCompact 输入**不含任何用量数字**，Claude Code 也**没有**公开的
#    "当前占用百分比"环境变量（本项调研未找到一手来源）。所以本脚本只能做**粗判**：
#    优先数 transcript 行数，行数不可得时退回文件字节数，并用可调阈值做启发式。
#    粗判只用于"提前预警"，绝不用作硬门。宁可多提醒一次，不可漏提醒一次。
#
# 可调参数（环境变量）：
#   CH_LINES_WARN    transcript 行数预警线（默认 2000）
#   CH_BYTES_HARD    transcript 字节数硬线（默认 6000000，约 6MB）
#   CH_DISABLE       置 1 则直接放行（调试用）
set -uo pipefail

MODE="${1:-}"
[ "${CH_DISABLE:-0}" = "1" ] && exit 0

INPUT="$(cat || true)"

# 极简 JSON 取值（不依赖 jq；值里含引号的情况对这些字段不适用）
json_get() {
  printf '%s' "$INPUT" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
}
json_get_raw() {
  printf '%s' "$INPUT" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p" | head -1
}

LINES_WARN="${CH_LINES_WARN:-2000}"
BYTES_HARD="${CH_BYTES_HARD:-6000000}"

TRANSCRIPT="$(json_get transcript_path)"

report() {
  # $1 = 触发原因
  printf '上下文交接提醒：%s\n' "$1" >&2
  printf '请立即用 context-handoff 技能做一次增量交接：\n' >&2
  printf '  1) 找/建 HANDOFF.md（工作区有 handoff/ 就放 handoff/HANDOFF.md）\n' >&2
  printf '  2) 只改真正变化的节，未变节必须逐字保留\n' >&2
  printf '  3) `check` 判绿之前不许宣布交接完成\n' >&2
  printf '  4) 产出 OPENING_PROMPT.md，然后开新会话继续\n' >&2
}

case "$MODE" in
  --precompact)
    # 压缩即将发生。这是"压缩前抢救"的唯一硬点，且**阻断有副作用**：
    # 若压缩是为从 API 已返回的 context-limit 错误恢复而触发，阻断会让该错误浮现。
    # 因此只在"这一步还能救"的情况下阻断：manual 压缩（用户主动）一律阻断要求先交接。
    TRIGGER="$(json_get trigger)"
    if [ "$TRIGGER" = "manual" ]; then
      report "你正在/compact，但交接物还没更新（$MODE, trigger=manual）"
      exit 2
    fi
    # auto：若 HANDOFF.md 存在且比 transcript 新，说明交接已经做过了，放行压缩。
    HANDOFF=""
    for cand in ./handoff/HANDOFF.md ./docs/HANDOFF.md ./HANDOFF.md; do
      [ -f "$cand" ] && HANDOFF="$cand" && break
    done
    if [ -n "$HANDOFF" ] && [ -n "$TRANSCRIPT" ] && [ "$HANDOFF" -nt "$TRANSCRIPT" ]; then
      exit 0
    fi
    if [ -n "$HANDOFF" ]; then
      report "自动压缩即将发生，但 HANDOFF.md 比会话记录旧（$HANDOFF 需要更新）"
    else
      report "自动压缩即将发生，且工作区还没有 HANDOFF.md"
    fi
    exit 2
    ;;

  --stop)
    # 官方提示：Stop hook 会被 8 连阻断后强制放行，必须检查 stop_hook_active 防死循环。
    ACTIVE="$(json_get_raw stop_hook_active)"
    [ "$ACTIVE" = "true" ] && exit 0

    [ -z "$TRANSCRIPT" ] && exit 0
    [ -f "$TRANSCRIPT" ] || exit 0

    BYTES="$(wc -c < "$TRANSCRIPT" 2>/dev/null | tr -d ' ')"
    LINES="$(wc -l < "$TRANSCRIPT" 2>/dev/null | tr -d ' ')"

    if [ -n "${BYTES:-}" ] && [ "$BYTES" -ge "$BYTES_HARD" ]; then
      report "会话记录已达 ${BYTES} 字节（硬线 ${BYTES_HARD}）"
      exit 2
    fi
    if [ -n "${LINES:-}" ] && [ "$LINES" -ge "$LINES_WARN" ]; then
      report "会话记录已达 ${LINES} 行（预警线 ${LINES_WARN}）"
      exit 2
    fi
    exit 0
    ;;

  *)
    printf 'context_budget.sh: 未知模式 "%s"（用 --precompact 或 --stop）\n' "$MODE" >&2
    exit 0
    ;;
esac
