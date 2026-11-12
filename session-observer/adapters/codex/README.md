# Codex 适配层（session-observer）

> 状态：**已实测证实**（Codex CLI 0.166.0，本机核对，非源码推测）。

## 已证实的事实（2026-11-12，Codex 0.166.0 实测）

| 项 | 结论 |
|---|---|
| 技能目录 | `~/.codex/skills/<技能名>/SKILL.md`（结构同 DSH：SKILL.md + references/ + scripts/） |
| 技能发现 | **自动发现**，无需 config.toml 的 `[skills]` 段 |
| SKILL.md frontmatter | `name` + `description`（与 DSH 相同） |
| 规则位置 | `~/.codex/rules/default.rules`（**不是 AGENTS.md**） |

## 1. 安装（在装了 Codex 的那台机器上执行）

```bash
# 先拿到仓库（本机已 clone 则跳过）
git clone https://github.com/tianxiaz/session-guardian
cd session-guardian
./install.sh codex        # 装两个技能到 ~/.codex/skills/
```

等价手动命令：

```bash
cp -R session-observer ~/.codex/skills/session-observer
cp -R context-handoff   ~/.codex/skills/context-handoff
```

## 2. 常驻入口（规则）

把 `rules.snippet.md` 的内容追加到 `~/.codex/rules/default.rules` 末尾。

## 3. 注意：frontmatter 的 whenToUse

`session-observer/SKILL.md` 的 frontmatter 里有 `whenToUse` 字段，是 **DSH 专属**。
Codex 只认 `name` + `description`（实测大概率忽略多余字段）。若 Codex 报 frontmatter 错误，
删掉 `whenToUse:` 那一行即可——`description` 里已含触发词（「观察」「该换会话吗」），不影响匹配。

## 4. 验证

- 在 Codex 会话里说「**观察**」→ 应回能力卡并分析当前会话是否该换。
- 说「**观察帮助**」→ 应展开完整能力卡与全部命令。
- 触发一次上下文压缩（或连续被催"继续"）→ 应命中衰退判据、提议交接。

## 5. Codex 的独特优势

Codex 有 **`PreCompact` hook 事件**（压缩前触发），这是 DSH 没有的。后续可把"压缩前写交接"
挂到这个事件上，实现比 DSH 更早的抢救。当前版本先靠"每轮自检 + 用户说观察"触发，PreCompact 钩子留作增强。
