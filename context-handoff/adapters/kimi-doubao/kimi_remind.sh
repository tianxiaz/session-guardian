#!/usr/bin/env bash
# context-handoff · Kimi 每轮提醒脚本（挂 UserPromptSubmit）
#
# ── 为什么挂 UserPromptSubmit ────────────────────────────────────────────────
# Kimi 的 18 个 hook 事件里**只有 3 个可阻断**（PreToolUse / Stop / UserPromptSubmit）；
# `SessionStart` 是观察型（不能注入上下文），`PreCompact`/`PostCompact` 的**返回值被完全忽略**。
# 所以"能往上下文里塞一段提醒"的唯一位置就是 UserPromptSubmit —— 即**用户每发一条消息时**。
#
# ⚠️ 固有局限（必须知道）：**用户不说话它就不触发**。
# 纯自主长跑（几十分钟没有用户输入）时本脚本一次也不会执行 ⇒ 那种情况只能靠
# AGENTS.md 常驻规则 + 技能 description（见 README §2 的三层设计）。
#
# ── 它怎么拿到"上下文用了多少" ──────────────────────────────────────────────
# Kimi **不会**向 hook 进程导出占用量。本脚本三条取数路径，从最可信到最粗：
#   1) 显式覆盖：CONTEXT_HANDOFF_OCCUPANCY=<0–1 或百分数>（调用方算好，最可信）
#   2) 会话轨迹：从 ~/.kimi-code/sessions/**/agents/*/wire.jsonl **尾部**找 usage 类字段
#      （prompt_tokens / context_tokens / input_tokens / total_tokens）取最大值
#   3) 都没有 ⇒ **静默放行**（宁可不出声，也不制造"我猜你快满了"的噪音）
#
# ⚠️ 路径 2 是**基于官方文档描述的推断实现，未在 Kimi 上实测**（开发机没装 Kimi）。
#    可能因版本/字段名不同而永远取不到数——那时脚本静默、不报错。
#    想确认它在你机器上真取到数：`kimi_remind.sh --debug`
#
# ── 变量名声明 ──────────────────────────────────────────────────────────────
# Kimi 官方**没有**任何向 hook 导出占用量的环境变量。本脚本认识的那些
# `CONTEXT_HANDOFF_*` 全部是**本技能自定的契约**（不是官方变量名）；
# 若你的 Kimi 版本确实导出了真实变量，请把它接到本脚本上，别去猜。
#
# 阈值：默认 0.75（与 SKILL.md §1.3 一致：预警线低于硬线）。
# 算比例需要 max_context_size —— 依次取 CONTEXT_HANDOFF_MAX_CONTEXT_SIZE、
# ~/.kimi-code/config.toml 的 max_context_size；**都取不到就静默**（不猜窗口大小）。
#
# 防刷屏：同一次越线只提醒一次；降回阈值以下再越线才会再提醒
# （状态存 ~/.kimi-code/.handoff-remind）。
# 退出码：Kimi hooks fail-open，一律 exit 0。
set -uo pipefail

DEBUG=0
[ "${1:-}" = "--debug" ] && DEBUG=1
dbg() { if [ "$DEBUG" = 1 ]; then printf '[kimi_remind] %s\n' "$*" >&2; fi; return 0; }

KIMI_HOME="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
STATE_FILE="$KIMI_HOME/.handoff-remind"
WARN_RATIO="${CONTEXT_HANDOFF_WARN_RATIO:-0.75}"

remind() {
  local pct="$1" src="$2"
  cat <<EOF
[上下文交接提醒] 当前上下文占用约 ${pct}%（来源：${src}），已接近自动压缩触发点。
请立刻用 context-handoff 技能做一次**增量**交接：只声明真正变化的节，未变节由工具逐字搬运。
落盘前必须判绿：node "<技能目录>/scripts/check_handoff.mjs" check ./HANDOFF.md
判绿后再产出开场指令，在新会话继续（kimi --continue 或 kimi --session <id>）。
注意：压缩之后的摘要不可信，新会话第一件事是把"已完成"逐条当**未验证**核对。
EOF
}

# ── 1) 显式覆盖（最可信）──────────────────────────────────────────────────
OV="${CONTEXT_HANDOFF_OCCUPANCY:-}"
if [ -n "$OV" ]; then
  R=$(awk -v v="$OV" 'BEGIN{ if (v>1) v=v/100; printf "%.4f", v }')
  if awk -v v="$R" -v w="$WARN_RATIO" 'BEGIN{ exit !(v>=w) }'; then
    remind "$(awk -v v="$R" 'BEGIN{printf "%.0f", v*100}')" "CONTEXT_HANDOFF_OCCUPANCY"
  else
    dbg "override $R 未达阈值 $WARN_RATIO"
  fi
  exit 0
fi

# ── 2) 从会话轨迹尾部找 usage 字段 ─────────────────────────────────────────
MAX="${CONTEXT_HANDOFF_MAX_CONTEXT_SIZE:-}"
if [ -z "$MAX" ] && [ -f "$KIMI_HOME/config.toml" ]; then
  MAX=$(sed -n 's/^[[:space:]]*max_context_size[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$KIMI_HOME/config.toml" | tail -1)
fi
if [ -z "$MAX" ] || ! [ "$MAX" -gt 0 ] 2>/dev/null; then
  dbg "拿不到 max_context_size ⇒ 静默（不猜窗口大小）"
  exit 0
fi

# 最近被写过的会话轨迹（不依赖 hook payload 的形状）
WIRE=$(find "$KIMI_HOME/sessions" -name 'wire.jsonl' -type f -newermt '-2 hours' 2>/dev/null \
       | xargs -r ls -t 2>/dev/null | head -1)
if [ -z "${WIRE:-}" ]; then
  dbg "找不到近 2 小时的 wire.jsonl ⇒ 静默"
  exit 0
fi
dbg "轨迹文件：$WIRE"

USED=$(tail -c 400000 "$WIRE" 2>/dev/null \
  | grep -oE '"(prompt_tokens|context_tokens|input_tokens|total_tokens)"[[:space:]]*:[[:space:]]*[0-9]+' \
  | grep -oE '[0-9]+$' | sort -n | tail -1)
if [ -z "${USED:-}" ]; then
  dbg "轨迹里没有 usage 类字段 ⇒ 静默（该版本可能不记录，或字段名不同）"
  exit 0
fi

R=$(awk -v u="$USED" -v m="$MAX" 'BEGIN{ printf "%.4f", u/m }')
dbg "used=$USED max=$MAX ratio=$R 阈值=$WARN_RATIO"

if ! awk -v v="$R" -v w="$WARN_RATIO" 'BEGIN{ exit !(v>=w) }'; then
  rm -f "$STATE_FILE" 2>/dev/null
  exit 0
fi

# ── 3) 防刷屏：同一次越线只提醒一次 ────────────────────────────────────────
LAST=$(sed -n 's/^ratio=//p' "$STATE_FILE" 2>/dev/null | tail -1)
if [ -n "${LAST:-}" ]; then
  dbg "已在占用 $LAST 时提醒过，跳过（降回阈值以下才会再提醒）"
  exit 0
fi
printf 'ratio=%s\nat=%s\n' "$R" "$(date -u +%Y%m%dT%H%M%SZ)" > "$STATE_FILE" 2>/dev/null || true
remind "$(awk -v v="$R" 'BEGIN{printf "%.0f", v*100}')" "wire.jsonl:usage(max=${MAX})"
exit 0
