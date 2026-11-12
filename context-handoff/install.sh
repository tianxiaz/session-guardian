#!/usr/bin/env bash
# context-handoff · 通用安装脚本
#
# 把它放在**技能目录根部**运行（即含 SKILL.md 的那一层）。
#
# 用法：
#   ./install.sh                     # 自动探测已装的平台，装到能装的地方
#   ./install.sh --target kimi       # 只装 Kimi
#   ./install.sh --target claude     # 只装 Claude Code
#   ./install.sh --target agents     # 装到跨工具共享目录 ~/.agents/skills（多平台通用）
#   ./install.sh --target project    # 装到**当前 git 仓库**里（.kimi-code/skills/，可提交给队友共享）
#   ./install.sh --target kimi --with-rule   # 额外写常驻规则（推荐，自动唤醒主要靠它）
#   ./install.sh --dry-run           # 只打印，不动文件
#
# 设计取舍：**安全的自动做，有风险的交给你**。
#   · 复制文件、修权限、写常驻规则 ⇒ 幂等且可回滚，脚本直接做；
#   · 改平台配置（hooks）⇒ 各平台格式不同、且写坏会让整份配置失效，所以只在
#     adapters/<平台>/deploy.sh 里做（会备份），本脚本只**告诉你那条命令**。
set -uo pipefail

DRY=0
TARGET="auto"
WITH_RULE=0
PREFIX=""
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --target) TARGET="${2:-auto}"; shift ;;
    --with-rule) WITH_RULE=1 ;;
    --prefix) PREFIX="${2:-}"; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '未知参数：%s（试 --help）\n' "$1" >&2; exit 3 ;;
  esac
  shift
done

# ── 自毁保护（必须）──────────────────────────────────────────────────────
# 本脚本会 `rm -rf "$DEST"` 再 `cp -R`。如果 DEST 恰好是**源目录自身**、或与源互相包含，
# 就会把源连同自己一起删掉。这不是假想：作者的一次自测在真实 HOME 下跑安装时，
# 目标正好是技能自身，**整个技能目录被删了**（后来从备份恢复）。
realpath_of() { ( cd "$1" 2>/dev/null && pwd -P ) || printf '%s' "$1"; }
# 判定（不打印）：0=同一目录，1=互相包含，2=互不相关（安全）
#   0 和 1 对"先删目标再复制"都是致命的；但 0 在 deploy.sh 里是**正常场景**（就地配置）。
paths_conflict() {
  local src_real dest_real
  src_real=$(realpath_of "$1")
  if [ -d "$2" ]; then dest_real=$(realpath_of "$2")
  else dest_real="$(realpath_of "$(dirname "$2")")/$(basename "$2")"; fi
  [ "$src_real" = "$dest_real" ] && return 0
  case "$src_real/" in "$dest_real"/*) return 1 ;; esac
  case "$dest_real/" in "$src_real"/*) return 1 ;; esac
  return 2
}
explain_conflict() {
  printf '✖ 拒绝执行：源目录与目标目录冲突，执行会删掉源文件。\n' >&2
  printf '   源：%s\n   目标：%s\n' "$(realpath_of "$1")" "$2" >&2
}

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  [dry-run] $*"; else eval "$@"; fi }

if [ ! -f "$HERE/SKILL.md" ]; then
  say "✖ 这个脚本必须放在技能目录根部（含 SKILL.md 的那一层）运行。"
  say "  当前目录：$HERE"
  exit 3
fi

DSH_HOME_="${DSH_HOME:-$HOME/.dsh}"

# ── 目标目录解析 ─────────────────────────────────────────────────────────
dest_for() {
  case "$1" in
    kimi)   printf '%s' "${PREFIX:-$HOME/.kimi-code/skills}/context-handoff" ;;
    claude) printf '%s' "${PREFIX:-$HOME/.claude/skills}/context-handoff" ;;
    dsh)    printf '%s' "${PREFIX:-$DSH_HOME_/skills}/context-handoff" ;;
    agents) printf '%s' "${PREFIX:-$HOME/.agents/skills}/context-handoff" ;;
    codex)  printf '%s' "${PREFIX:-$HOME/.codex/skills}/context-handoff" ;;
    project) printf '%s' "${PROJECT_ROOT:-.}/.kimi-code/skills/context-handoff" ;;
    *)      printf '' ;;
  esac
}

detect() {
  local found=""
  [ -d "$HOME/.kimi-code" ] && found="$found kimi"
  [ -d "$HOME/.claude" ] && found="$found claude"
  [ -d "$DSH_HOME_" ] && found="$found dsh"
  [ -d "$HOME/.codex" ] && found="$found codex"
  printf '%s' "${found# }"
}

say "技能源：$HERE"
say ""

# 项目根 ＝ 当前目录向上最近的含 .git 的目录（与 Kimi 官方判定一致）
find_project_root() {
  local d; d=$(pwd -P)
  while [ "$d" != "/" ]; do
    [ -d "$d/.git" ] && { printf '%s' "$d"; return 0; }
    d=$(dirname "$d")
  done
  return 1
}
PROJECT_ROOT=""

if [ "$TARGET" = "auto" ]; then
  DETECTED=$(detect)
  if [ -z "$DETECTED" ]; then
    say "⚠️ 没探测到已安装的平台（~/.kimi-code、~/.claude、~/.codex、$DSH_HOME_ 都不存在）。"
    say "   装到跨工具共享目录 ~/.agents/skills 吗？多平台会自己读这里。"
    say "   直接运行：./install.sh --target agents"
    exit 0
  fi
  say "探测到：$DETECTED"
  TARGETS="$DETECTED"
else
  case "$TARGET" in
    kimi|claude|dsh|agents|codex|project) TARGETS="$TARGET" ;;
    *) say "✖ --target 只支持：kimi / claude / dsh / agents / codex"; exit 3 ;;
  esac
fi

# ── 逐个目标安装 ─────────────────────────────────────────────────────────
for T in $TARGETS; do
  if [ "$T" = "project" ]; then
    if ! PROJECT_ROOT=$(find_project_root); then
      say "✖ --target project 需要当前目录在某个 git 仓库里（向上找不到 .git）。"
      say "  先 cd 到你的项目根，或改用 --target kimi 装到用户级。"
      exit 3
    fi
    say "项目根：$PROJECT_ROOT"
  fi
  DEST=$(dest_for "$T")

  # 有平台专用部署脚本，且用户要求"装得更全" ⇒ 直接交给它（它自己会复制文件并写配置）
  SPECIAL=""
  case "$T" in
    kimi)   SPECIAL="$HERE/adapters/kimi-doubao/deploy.sh" ;;
    claude) SPECIAL="$HERE/adapters/claude-code/deploy.sh" ;;
  esac

  say "── 目标 $T：$DEST"
  if [ -n "$SPECIAL" ] && [ -f "$SPECIAL" ] && [ "$WITH_RULE" = 1 ]; then
    say "   （用平台专用脚本：复制文件 + 写常驻规则 + 配钩子，都会备份原文件）"
    if [ "$DRY" = 1 ]; then
      bash "$SPECIAL" --dry-run 2>&1 | sed 's/^/     /'
    else
      bash "$SPECIAL" 2>&1 | sed 's/^/     /'
    fi
    continue
  fi

  # 通用路径：只放文件（L0）——先确认不会删到自己
  paths_conflict "$HERE" "$DEST"
  if [ $? -ne 2 ]; then explain_conflict "$HERE" "$DEST"; exit 3; fi
  run "mkdir -p '$(dirname "$DEST")'"
  run "rm -rf '$DEST'"
  run "cp -R '$HERE' '$DEST'"
  run "chmod -R u+rwX,go+rX '$DEST'"
  run "find '$DEST' -name '*.sh' -exec chmod 755 {} +"
  say "   ✔ 文件就位（L0：可被发现、按需调用）"

  if [ -n "$SPECIAL" ] && [ -f "$SPECIAL" ]; then
    say "   ▸ 想让它**自动唤醒**（写常驻规则 / 钩子，会备份），再跑："
    say "     bash $DEST/adapters/$(basename "$(dirname "$SPECIAL")")/$(basename "$SPECIAL")"
    say "     或重跑本脚本加 --with-rule"
  elif [ "$T" = "project" ]; then
    say "   ▸ 已装进仓库：$DEST"
    say "     · 建议把 .kimi-code/skills/context-handoff 提交进 git —— 队友 clone 下来就有"
    say "     · 项目级安装**不**改任何用户级配置，也**不**装提醒钩子"
    say "     · 想开自动唤醒（常驻规则）：把下面这份里 --- 之间的内容贴到 <项目根>/AGENTS.md"
    say "       $DEST/adapters/kimi-doubao/AGENTS.snippet.md"
    say "     · 想让 Claude Code 也发现：cp -R $DEST <项目根>/.claude/skills/context-handoff"
  elif [ -f "$HERE/adapters/$T/README.md" ]; then
    say "   ▸ 该平台的额外配置见：$DEST/adapters/$T/README.md"
  else
    say "   ▸ 已可被平台发现；自动唤醒靠技能 description（已覆盖触发场景）"
  fi
done

# ── 收尾 ─────────────────────────────────────────────────────────────────
say ""
say "=== 验证（务必自己跑一次）==="
FIRST=$(printf '%s' "$TARGETS" | awk '{print $1}')
D1=$(dest_for "$FIRST")
say "1) 文件就位：ls \"$D1/SKILL.md\""
say "2) 判据能跑：cd <你的工程目录> && node \"$D1/scripts/check_handoff.mjs\" init ./HANDOFF.md"
say "3) 自测（可选，约 15 秒）：cd \"$D1\" && node --test \"scripts/tests/*.test.mjs\""
say "   期望：全部通过；在别人机器上可能有 1–2 项自动跳过（缺作者仓库的文件），0 失败即可。"
say ""
say "⚠️ 提醒：本脚本只做文件复制与权限。各平台的 hooks/规则配置见 adapters/<平台>/README.md，"
say "   那部分**未在所有平台实测过**，请按 README 里的验证步骤自己确认。"
say "⚠️ 本仓库尚未附带 LICENSE 文件——对外分发前请先选定一个许可证。"
