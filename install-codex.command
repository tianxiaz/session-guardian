#!/bin/bash
# session-guardian 一键安装器（给 Codex 用）
# 用法：双击本文件，按提示操作即可，无需任何命令行知识。
set -e

echo ""
echo "=============================================="
echo "  session-guardian 技能包安装器"
echo "  正在安装，请稍候……"
echo "=============================================="
echo ""

# 1. 下载技能包
echo "▶ 第 1 步：下载技能包……"
TMP=$(mktemp -d)
cd "$TMP"
curl -fsSL https://github.com/tianxiaz/session-guardian/archive/refs/heads/main.tar.gz -o sg.tar.gz
tar xzf sg.tar.gz
echo "   下载完成。"

# 2. 复制两个技能到 Codex 技能目录
echo "▶ 第 2 步：安装两个技能……"
mkdir -p "$HOME/.codex/skills"
rm -rf "$HOME/.codex/skills/session-observer" "$HOME/.codex/skills/context-handoff"
cp -R session-guardian-main/session-observer "$HOME/.codex/skills/session-observer"
cp -R session-guardian-main/context-handoff   "$HOME/.codex/skills/context-handoff"
echo "   技能已复制到 ~/.codex/skills/"

# 3. 追加规则
echo "▶ 第 3 步：写入常驻规则……"
mkdir -p "$HOME/.codex/rules"
touch "$HOME/.codex/rules/default.rules"
cat session-guardian-main/session-observer/adapters/codex/rules.snippet.md >> "$HOME/.codex/rules/default.rules"
cat session-guardian-main/context-handoff/adapters/codex/rules.snippet.md >> "$HOME/.codex/rules/default.rules"
echo "   规则已写入 ~/.codex/rules/default.rules"

# 清理
rm -rf "$TMP"

echo ""
echo "=============================================="
echo "  ✅ 安装完成！"
echo ""
echo "  接下来："
echo "  1. 完全退出 Codex 应用，重新打开；"
echo "  2. 在会话里发一句「观察」，"
echo "     如果它回复了「会话效能观察已启用…」，就说明装好了。"
echo "=============================================="
echo ""
# 只在交互式终端（双击运行）时才暂停；被 Codex 这类 agent 调用时直接结束，避免卡住
[ -t 0 ] && read -p "按回车键关闭本窗口……" _
