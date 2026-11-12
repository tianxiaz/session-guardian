#!/usr/bin/env bash
# context-handoff · Kimi 一键部署（含"自动唤醒"三层配置）
#
# 做什么（幂等，可重复跑）：
#   1) 把技能目录复制到 ~/.kimi-code/skills/context-handoff（放文件即安装）
#   2) 修权限（复制可能继承过严 umask）
#   3) 往 ~/.kimi-code/config.toml 加一条 [[hooks]]（UserPromptSubmit → kimi_remind.sh）
#   4) 往 ~/.kimi-code/AGENTS.md 追加常驻规则（已存在则跳过）
#   5) 打印验证清单
#
# 用法：
#   bash deploy.sh            # 真跑
#   bash deploy.sh --dry-run  # 只打印将要做什么
#
# ⚠️ 本脚本**未在 Kimi 上实测**（开发机没装 Kimi）。它只做文件复制与文本追加，
#    不改任何 Kimi 二进制/不理解你的既有配置；但 **config.toml 是硬约束文件**——
#    `[[hooks]]` 里多写一个字段会导致整份配置加载失败，所以这里只写 4 个允许字段。
set -uo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SKILL_DIR=$(cd "$HERE/../.." && pwd)
KIMI_HOME="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
DEST="$KIMI_HOME/skills/context-handoff"
CFG="$KIMI_HOME/config.toml"
AGENTS="$KIMI_HOME/AGENTS.md"
MARK="# >>> context-handoff (managed) >>>"

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

say "技能源目录：$SKILL_DIR"
say "Kimi 家目录：$KIMI_HOME"
say ""

# ── 0) 前置检查 ───────────────────────────────────────────────────────────
if [ ! -f "$SKILL_DIR/SKILL.md" ]; then
  say "✖ 找不到 $SKILL_DIR/SKILL.md —— 请把本脚本放在 <技能目录>/adapters/kimi-doubao/ 下运行"
  exit 3
fi
if [ ! -d "$KIMI_HOME" ]; then
  say "⚠️ $KIMI_HOME 不存在 —— 看起来本机还没装 Kimi Code CLI。"
  say "   可以继续（脚本会建目录），但**装好 Kimi 再跑验证**才有意义。"
  say "   官方安装后该目录会自动出现；本脚本不会替你安装 Kimi。"
fi

# ── 1) 复制技能（若源就是目标，则跳过——否则会删掉自己）────────────────────
paths_conflict "$SKILL_DIR" "$DEST"; _pc=$?
if [ "$_pc" = "1" ]; then explain_conflict "$SKILL_DIR" "$DEST"; exit 3; fi
if [ "$_pc" = "0" ]; then
  say "[1/4] 你正在**已安装的副本**里运行 ⇒ 跳过复制（只做配置，不会动文件）"
else
  say "[1/4] 复制技能 → $DEST"
  run "mkdir -p '$KIMI_HOME/skills'"
  run "rm -rf '$DEST'"
  run "cp -R '$SKILL_DIR' '$DEST'"
fi

# ── 2) 权限 ───────────────────────────────────────────────────────────────
say "[2/4] 修权限（目录 755 / 文件 644 / 脚本 755）"
run "chmod -R u+rwX,go+rX '$DEST'"
run "find '$DEST' -name '*.sh' -exec chmod 755 {} +"

# ── 3) config.toml 加 UserPromptSubmit 钩子 ───────────────────────────────
say "[3/4] 配置 hooks（UserPromptSubmit → kimi_remind.sh）"
if [ -f "$CFG" ] && grep -q "context-handoff (managed)" "$CFG" 2>/dev/null; then
  say "  已存在本技能写入的配置段 ⇒ 跳过（不重复追加）"
else
  BLOCK="$MARK
[[hooks]]
event = \"UserPromptSubmit\"
command = \"bash -lc '$DEST/adapters/kimi-doubao/kimi_remind.sh'\"
timeout = 10
# <<< context-handoff (managed) <<<"
  if [ "$DRY" = 1 ]; then
    say "  [dry-run] 追加到 $CFG："
    printf '%s\n' "$BLOCK" | sed 's/^/    /'
  else
    mkdir -p "$KIMI_HOME"
    # 备份一次（只在还没有备份时）
    [ -f "$CFG" ] && [ ! -f "$CFG.bak.context-handoff" ] && cp "$CFG" "$CFG.bak.context-handoff"
    printf '\n%s\n' "$BLOCK" >> "$CFG"
    say "  ✔ 已追加（原文件备份为 config.toml.bak.context-handoff，若有）"
  fi
fi

# ── 4) AGENTS.md 常驻规则 ────────────────────────────────────────────────
say "[4/4] 常驻规则 → $AGENTS"
SNIP="$DEST/adapters/kimi-doubao/AGENTS.snippet.md"
if [ ! -f "$SNIP" ]; then
  say "  ✖ 找不到 $SNIP ⇒ 跳过（常驻规则是自动唤醒最可靠的一层，建议手工补）"
elif [ -f "$AGENTS" ] && grep -q "上下文交接（context-handoff）常驻规则" "$AGENTS" 2>/dev/null; then
  say "  已有该规则 ⇒ 跳过（不重复追加）"
else
  if [ "$DRY" = 1 ]; then
    say "  [dry-run] 从 $SNIP 取 '---' 之间的内容追加到 $AGENTS"
  else
    mkdir -p "$KIMI_HOME"
    [ -f "$AGENTS" ] && [ ! -f "$AGENTS.bak.context-handoff" ] && cp "$AGENTS" "$AGENTS.bak.context-handoff"
    # 取 snippet 里**第一个** `---` 之后、第二个 `---` 之前的内容（n==1 才是正文区间；
    # 写成 n==2 会一行都取不到 —— 这个 bug 在本脚本自测里被当场发现）
    RULE=$(awk '/^---$/{n++; next} n==1' "$SNIP")
    if [ -z "$RULE" ]; then
      say "  ✖ 规则片段解析为空（snippet 格式不对）⇒ 未追加，请手工补"
    else
      printf '\n%s\n' "$RULE" >> "$AGENTS"
      say "  ✔ 已追加（原文件备份为 AGENTS.md.bak.context-handoff，若有）"
    fi
  fi
fi

# ── 验证清单 ─────────────────────────────────────────────────────────────
say ""
say "=== 接下来请**自己**验证（我没法替你在 Kimi 上跑）==="
say "1) 文件就位：ls $DEST/SKILL.md"
say "2) 配置未写坏（Kimi 对 [[hooks]] 字段是硬校验，多一个字段整份配置失效）："
say "     tail -8 $CFG"
say "3) 钩子能不能真取到数（关键！取不到就永远静默）："
say "     bash $DEST/adapters/kimi-doubao/kimi_remind.sh --debug"
say "     看它打印的 used / max / ratio；若显示“没有 usage 类字段”，说明该 Kimi 版本"
say "     不记录这些字段 ⇒ 钩子这一层等于没用，只能靠 AGENTS.md + description。"
say "4) 技能能否被发现：新开 kimi 会话，问“上下文快满了该怎么做，用哪个技能？”"
say "     应当看到它引用 context-handoff。若没有 ⇒ description 没匹配上。"
say "5) 自动唤醒（交互式）：连续对话直到占用超 75%，看是否出现"
say "     “[上下文交接提醒]”那段注入文本。不出现就回到第 3 步查取数。"
say ""
say "⚠️ 已知局限：UserPromptSubmit 只在**你发消息时**触发。"
say "   纯自主长跑（长时间没人输入）时钩子不跑，那种情况只能靠 AGENTS.md 常驻规则。"
