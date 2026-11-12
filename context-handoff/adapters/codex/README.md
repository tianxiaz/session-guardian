# 适配层 · Codex（OpenAI Codex CLI / IDE / cloud）

> 状态：**已实测**（Codex CLI 0.166.0）。两条重要修正见 §1.1/§1.2：规则走 `default.rules`、技能目录存在且自动发现。

## 0. 取证的重要前提（不许当没发生）

- `https://developers.openai.com/codex/` **全站 HTTP 403**（换 UA/Accept 头无效），
  官方文档措辞**无法逐字取证**。
- 仓库当日已重构：旧 `codex-cli/README.md`（完整 CLI 手册）**已删除（404）**，
  `docs/*.md` 全部退化为指向上述 403 站点的存根。
- 因此调研改用 **`openai/codex` 仓库自身 Rust 源码**（规范的实际实现）作一手来源，
  经 `cdn.jsdelivr.net/gh/openai/codex@main/...`（HTTP 200）抓取，逐条附 blob SHA。

⇒ 本文件里凡标「源码为证」的，都是"实现如此"；凡标「官方措辞未证实」的，**不要当对外承诺用**。


## 本平台的中断信号（B 轴：执行中断）

> 触发有三条轴，**B 轴（执行中断）发生时模型往往已没机会写**。完整场景见 `references/triggers.md`。

Codex 的 hooks 有 12 类事件（源码为证），其中与中断相关的：

| 信号 | 对应 `trigger` | 备注 |
|---|---|---|
| `Stop`（run 即将结束） | `checkpoint` / `phase-complete` | 每次结束都可以顺手写一次检查点 |
| `Interrupt` | `interruption` | 被中断 |
| `SessionEnd` | `interruption` | 会话结束（含异常） |
| `PreCompact` / `PostCompact` | `pre-compact` / `post-compact` | **Codex 有这两个事件**（DSH 桥不支持） |
| 压缩阈值 | `context-pressure` | 配置项 `model_auto_compact_token_limit` / `model_context_window` |

⚠️ **未证实**：Codex 侧"假死/被 kill/崩溃"是否可观测——官方文档站 403，只有源码为证，**不作断言**。
所以仍按"不可观测"处理 ⇒ 需要检查点。


## 权限（部署后必做）

```bash
# 复制到目标机器后**必须先修权限**（默认 umask 可能给出 600/711，非 root 用户会读不到）
chmod -R u+rwX,go+rX <技能目录>            # 目录 755、文件 644
find <技能目录> -name '*.sh' -exec chmod 755 {} +   # 脚本需可读+可执行
```

## 1. 部署

### 1.1 规则层（推荐承载"触发契约"与铁律）

**实测（Codex 0.166.0）**：规则文件是 `~/.codex/rules/default.rules`，**不是 `~/.codex/AGENTS.md`**。
旧调研（源码为证）曾写 AGENTS.md，实测本机 `~/.codex/` 下是 `rules/default.rules`、无 `AGENTS.md`。

⇒ 把 `rules.snippet.md` 的内容追加到 `~/.codex/rules/default.rules` 末尾。

### 1.2 技能层（本技能本体）

**实测（Codex 0.166.0）**：`~/.codex/skills/` **确实存在**，结构为 `<技能名>/SKILL.md`（与 DSH 相同），
**自动发现、无需 config.toml 的 `[skills]` 段**。frontmatter 用 `name` + `description`。

```bash
cp -R <本技能目录> ~/.codex/skills/context-handoff
```

## 2. 触发档位

Codex 的 hooks 有 **12 类事件**（源码为证）：`PreToolUse`、`PermissionRequest`、`PostToolUse`、
`PreCompact`、`PostCompact`、`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`SubagentStart`、
`SubagentStop`、`Stop`、`Interrupt`；handler 四类：`command` / `mcp_tool` / `prompt` / `agent`。
可放 `~/.codex/hooks.json`，也可在 `config.toml` 内联 `hooks` 字段。

| 档 | 事件 | 说明 |
|---|---|---|
| T2 压缩前 | `PreCompact` | ✅ Codex **有**这个事件（对比 DSH 没有、Kimi 有但返回值被忽略） |
| T2 压缩后 | `PostCompact` | ✅ |
| T1 每轮 | `Stop` | ✅ |
| T0 旧机制 | `notify` | ⚠️ 源码已标 `TODO: Remove ... when legacy notify support is removed`，**新代码不要用** |

量化：源码有 `TokenUsage::percent_of_context_window_remaining(context_window: i64) -> i64`
（0–100，扣 12000 token 基线），字段 `TokenUsageInfo{total_token_usage, last_token_usage, model_context_window}`。
**但它的对外字段名/展示位置未证实** ⇒ 适配脚本不要写死一个字段名，取不到就按 `unavailable` 处理。

## 3. 升级档

- A 自动开新会话：❌ 未证实。
- **B 命令行续接**：✅ 源码为证 —— `codex resume`（picker 默认，`--last` / `--all` /
  `--include-non-interactive`）、`codex exec resume --last`、`codex fork`；TUI 内 `/resume`、`/new`。
  **`--continue` 在当日源码中不存在**，不作断言。
- C 可粘贴开场指令：✅ 常态。

## 4. 验证

```bash
codex --help                    # 核对 skills / hooks 相关键名
cat ~/.codex/rules/default.rules | tail -20   # 确认片段已追加
# 触发一次压缩，看 PreCompact 的 command hook 是否被调用（在其脚本里写个 touch 探针最直观）
```

## 5. 来源

- 源码（逐文件 blob SHA 可复现）：`codex-rs/codex-home/src/instructions/mod.rs`、
  `codex-rs/*/src/...`（详见调研文件的 SHA 表）
- 逐字引文与行号：`docs/_evidence/批L-上下文交接技能/调研-codex-agents-md.md`
