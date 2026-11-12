#!/usr/bin/env bash
# 安装 session-guardian（session-observer + context-handoff 两个技能）
# 用法:
#   ./install.sh [dsh|kimi|doubao|codex|all] [observer|handoff] [--force]
#   平台默认 all（DSH+Kimi+Codex）；observer/handoff 只装其一（默认两个都装）
#   --force 覆盖已存在（默认跳过不覆盖，避免装重）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OBSERVER_SRC="$SCRIPT_DIR/session-observer"
HANDOFF_SRC="$SCRIPT_DIR/context-handoff"

PLATFORM="all"; WHAT="all"; FORCE=0
for a in "$@"; do
  case "$a" in
    dsh|kimi|doubao|codex|all) PLATFORM="$a" ;;
    observer|handoff) WHAT="$a" ;;
    --force|-f) FORCE=1 ;;
  esac
done

[ -f "$OBSERVER_SRC/SKILL.md" ] || { echo "错误：缺少 session-observer/SKILL.md"; exit 1; }
[ -f "$HANDOFF_SRC/SKILL.md" ] || { echo "错误：缺少 context-handoff/SKILL.md"; exit 1; }

install_skill() {
  local src="$1" dest="$2" label="$3"
  if [ -d "$dest" ]; then
    if [ "$FORCE" -eq 1 ]; then
      rm -rf "$dest"; cp -R "$src" "$dest"; echo "🔁 已覆盖更新 $label → $dest"
    else
      echo "ℹ️  已存在 $label（$dest），跳过不覆盖。用 --force 覆盖/更新。"
    fi
  else
    mkdir -p "$(dirname "$dest")"; cp -R "$src" "$dest"; echo "✅ 已安装 $label → $dest"
  fi
}

install_to() {
  local skills="$1"
  if [ "$WHAT" = "all" ] || [ "$WHAT" = "observer" ]; then
    install_skill "$OBSERVER_SRC" "$skills/session-observer" "session-observer"
  fi
  if [ "$WHAT" = "all" ] || [ "$WHAT" = "handoff" ]; then
    install_skill "$HANDOFF_SRC" "$skills/context-handoff" "context-handoff"
  fi
}

case "$PLATFORM" in
  dsh)        install_to "$HOME/.dsh/skills" ;;
  kimi)       install_to "$HOME/.kimi-code/skills" ;;
  codex)      install_to "$HOME/.codex/skills" ;;
  all)        install_to "$HOME/.dsh/skills"; install_to "$HOME/.kimi-code/skills"; install_to "$HOME/.codex/skills" ;;
  doubao)     : ;;
esac

case "$PLATFORM" in
  doubao|all) echo "ℹ️  豆包：云端技能，请按 session-observer/adapters/doubao/README.md 在「豆包工作」上传安装。" ;;
esac

echo "完成。使用见 README.md / INSTALL.md；DSH 常驻入口见 session-observer/adapters/dsh/AGENTS.snippet.md。"
