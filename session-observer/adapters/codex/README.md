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

### 1.1 给技术小白的离线安装（绕过两个坑）

让 **Codex agent 自己装**（在对话里说"帮我 clone 并运行脚本"）通常会撞上两个坑：

1. **代理挡 GitHub**：`git clone` 连不上（国内环境常见）；
2. **沙箱不让写 `~/.codex/`**：Codex 默认 `workspace-write` 沙箱，只能写当前工作区，写不到用户目录里的 `~/.codex/`。

解法：**别让 agent 装，发一个离线 zip，双击 `install.command` 装**。脚本在 macOS Terminal 里由**用户本人**运行，不受 Codex 沙箱限制、也不联网。

离线包 `session-guardian-codex.zip` 内含 `session-observer/` + `context-handoff/` + `install.command`，双击 `install.command` 即完成「复制技能到 `~/.codex/skills/` + 追加规则到 `~/.codex/rules/default.rules`」。

> 仓库根目录的 `install-codex.command` 是「联网版」（从 GitHub 下载）；离线 zip 是「无网版」。GitHub 能访问用前者，被墙就用后者。离线 zip 可用
> `zip -r session-guardian-codex.zip session-observer context-handoff install.command` 自行打包。

### 1.2 ⚠️ Codex app 的托管沙箱会隔离技能（实测，重要）

如果你用 **Codex 桌面 app（不是 CLI）**，注意：app 的 agent 跑在**托管沙箱**里，host 的 `~/.codex/skills/` 对它**不可读**——技能"广告"出来了，但读不到文件，表现为「没检测到技能」。

这是 openai/codex 的已知 issue：**#45802「automatically selected system skill is advertised but unreadable inside managed task sandbox」**。

**实测现象（2026-11-12，MacBook Air）**：
- 终端里双击 `install.command` 显示「✅ 安装完成」（host 文件系统写入成功）；
- 但 app 会话里说「没检测到会话效能观察技能」；
- agent 的交接文档确认 `~/.codex/skills/session-observer` 在 app 视角里**不存在**。

**结论**：**Codex app（沙箱模式）不支持本地技能**，别在这上面折腾。想要"自动观察/切换"：
1. 用 **Codex CLI**（非沙箱；已验证 `~/.codex/skills/` 可读）；或
2. 换 **Kimi / DSH**；或
3. 用**手动兜底 prompt**（`context-handoff/templates/fallback-handoff-prompt.md`），任何 AI 都能用、零安装。

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
