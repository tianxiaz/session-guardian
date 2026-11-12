# 适配层 · Claude Code

> 状态：**配置已按官方文档写好，但本机没有 Claude Code，无法实测**。
> 每条都标了来源；"未实测"的地方不许当成已验证。

## 1. 部署

技能安装位置（官方表格）：个人级 = `~/.claude/skills/<skill-name>/SKILL.md`（本机所有项目可用）。

```bash
mkdir -p ~/.claude/skills
cp -R <技能目录> ~/.claude/skills/context-handoff
```

**frontmatter 白名单警告**：Claude Code 本体接受它全部字段，但在 Claude Code **之外**
（claude.ai 上传、Skills API、`package_skill.py` 打包）只允许
`name / description / license / compatibility / metadata / allowed-tools` 六个字段，
多写一个（例如 `hooks`）会**硬报错**而不是忽略。
⇒ 所以本技能本体只用 `name` + `description`，`hooks` 一律放本目录，由用户自行粘进 `settings.json`。

## 2. 触发档位

| 档 | 事件 | 用法 |
|---|---|---|
| T2 压缩前 | `PreCompact`（matcher `manual` / `auto`） | **可阻断**：exit 2 或 `{"decision":"block"}`。这是"压缩前抢救"的唯一硬点 |
| T2 压缩后 | `SessionStart`（matcher `compact`） | 压缩后重注入"去读 HANDOFF.md"的提醒（官方推荐做法） |
| T1 每轮量化 | `Stop` | 每轮结束跑阈值检查；越线就用 `decision:"block"` + `reason` 把模型拉回来做交接 |
| T3 用户明示 | 任意 | — |

**两个必须知道的坑**（官方原文）：

1. `PreCompact` 的输入**只有 `trigger` 和 `custom_instructions`，没有任何用量数字**。
   要量化只能靠 `Stop` 读 `transcript_path`（异步写盘、可能滞后）或自己算。
2. 阻断自动压缩有副作用：若压缩是"为从 API 已返回的 context-limit 错误恢复"而触发，
   阻断会让该错误浮现、当前请求失败。⇒ **`PreCompact` 只能当兜底，主路径是提前预警**。

## 3. 配置片段

见同目录：
- `hooks.settings.json` —— **顶层只有 `hooks` 一个键**（不塞自定义说明键，避免非 schema 键的容忍度问题），
  可直接合并进 `~/.claude/settings.json`；
- `context_budget.sh` —— 阈值脚本（`--precompact` / `--stop` 两个入口，读 transcript 粗判）。

挂的事件与 matcher：

| 事件 | matcher | 作用 |
|---|---|---|
| `PreCompact` | **`manual`** 与 **`auto`** 各一组 | 压缩前拦下要求先交接。**两组都要**：只挂 auto 会让脚本里的 manual 分支永远不执行 |
| `SessionStart` | `compact` | 压缩后重注入"去读 HANDOFF.md" |
| `Stop` | 无（总是触发） | 每轮结束的阈值自检 |

安装（**含权限步骤** —— 权限不对会让 hook 在非 root 用户下直接失败）：
```bash
# 复制过来的技能目录可能继承过严的 umask ⇒ 先统一权限，否则共享/多用户场景读不到
chmod -R u+rwX,go+rX <技能目录>                      # 目录 755、文件 644
find <技能目录> -name '*.sh' -exec chmod 755 {} +
mkdir -p ~/.claude/hooks
cp <技能目录>/adapters/claude-code/context_budget.sh ~/.claude/hooks/
chmod 755 ~/.claude/hooks/context_budget.sh        # 必须 755：hook 要能读 + 能执行
# 然后把 hooks.settings.json 里的 "hooks" 对象合并进 ~/.claude/settings.json
```

用 `/hooks` 菜单确认三个事件都出现了（官方：`/hooks` 按事件分组列出）。

> ⚠️ **C-1 的硬性纪律**：`PreCompact(auto)` 是**最后一次机会**，而阻断自动压缩有副作用
> （官方原文：若压缩是为从 API 已返回的 context-limit 错误恢复而触发，阻断会让该错误浮现、
> 当前请求失败）。所以**绝不允许"阻断但不交接"** —— 要么"交接 + 阻断"成对执行，
> 要么放行。脚本已按此实现：只有 `HANDOFF.md` 比 transcript 新时才放行 auto。

## 4. 升级档

- A 自动开新会话：❌ 未证实（未找到官方"程序化创建并跳转新会话"的文档）。
- B 命令行：⚠️ 未证实（本次调研未抓到 Claude Code CLI 页；`--continue`/`--resume` 属推测，**不作断言**）。
- **C 可粘贴开场指令**：✅ 这是 Claude Code 侧的正常形态。

## 5. 验证（本机未跑，命令已给全）

```bash
claude        # 起会话
/hooks        # 确认 PreCompact(auto)/SessionStart(compact)/Stop 三个都在
```
然后手动压一次（`/compact`）看 `PreCompact` 是否按预期拦下并提示去做交接。

## 6. 来源

- Hooks reference：https://code.claude.com/docs/en/hooks （事件表、`PreCompact` 输入与阻断语义、
  10000 字符输出上限、`hooks` 可写在 skill frontmatter）
- Hooks guide：https://code.claude.com/docs/en/hooks-guide （"Re-inject context after compaction"、
  超时上限）
- Skills：https://code.claude.com/docs/en/skills （安装位置表、frontmatter 白名单）
- 逐字引文与行号：`docs/_evidence/批L-上下文交接技能/调研-claude-code.md`

## 本平台的中断信号（B 轴：执行中断）

> 触发有三条轴，**B 轴（执行中断）发生时模型往往已没机会写**。完整场景见 `references/triggers.md`。

Claude Code 的信号最全，主要靠 **`StopFailure`**（官方：turn 因 API 错误结束时触发），
它的 matcher 就是错误类型：

```
rate_limit | overloaded | authentication_failed | oauth_org_not_allowed | account_on_hold
| billing_error | invalid_request | model_not_found | server_error | max_output_tokens
| cloud_credential_error | unknown
```

| 错误类型 | 建议 `trigger` | 说明 |
|---|---|---|
| `rate_limit` / `overloaded` / `billing_error` / `account_on_hold` | `error-recovery` | 等配额，别在同一会话空转 |
| `max_output_tokens` | `error-recovery` | 输出被截断 ⇒ 状态可能不完整，必须重新核对 |
| `server_error` / `unknown` | `error-recovery` | 可能是传输层问题 |
| 其余（鉴权/模型不存在等） | `error-recovery` | 通常要人工介入，交接物仍应写新 |

⚠️ **官方明确：`StopFailure` 会丢弃 hook 的 JSON 输出**（除 `terminalSequence` 等副作用字段），
所以**不能靠 hook 在 `StopFailure` 里做阻断**，只能做**落盘/记日志**这类副作用。

另可用的信号：`PreModelSwitch` / `PostModelSwitch`（→ `model-switch`）、`PreCompact`/`PostCompact`（→ `pre-compact`/`post-compact`）。
**"假死/被 kill/崩溃"仍不可观测** ⇒ 仍需检查点。

