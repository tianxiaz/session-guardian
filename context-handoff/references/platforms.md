# 平台能力矩阵与降级链（context-handoff）

> 所有「一手来源」引文与行号见仓库 `docs/_evidence/批L-上下文交接技能/` 下四份调研文件：
> `调研-claude-code.md`、`调研-codex-agents-md.md`、`调研-kimi.md`、`调研-豆包与WorkBuddy.md`。
> 抓取日期：2026-10-16。**本文件只汇总"能干什么/不能干什么"，不重复引文。**

## 1. 矩阵

| 平台 | 本体放哪 | 触发档 | 量化占用 | 自动开新会话 | 续接命令 |
|---|---|---|---|---|---|
| **DSH** | `$DSH_HOME/skills/<name>/SKILL.md`（本机 `~/.dsh/skills/`），rank 400 | T1 可做到（读 session projection cache）＋T2 **做不到**（无 PreCompact 钩子） | ✅ 真实测量值：`contextPressure.val.{surfaceTokens,pressureTokens,contextWindow}` | ❌ 无文档化的"程序化开新会话并跳转" | `dsh --profile headless --session-id <id> "…"` |
| **Claude Code** | `~/.claude/skills/<name>/SKILL.md` | T1/T2 最强：`PreCompact` 可阻断、`Stop` 每轮可查、`SessionStart(compact)` 压缩后重注入 | ⚠️ 无官方占用百分比字段；可用 `SessionStart`(resume/fork) 的 `context_tokens`，或自算 `transcript_path` | ❌ 未证实 | 无（靠 `/resume` 或新开会话） |
| **Codex** | 规则走 `AGENTS.md`（`~/.codex/AGENTS.md` 或项目根），技能按 `SKILL.md` 路径在 `skills` 字段配置 | T2：hooks 有 12 类事件**含 `PreCompact`**；`~/.codex/hooks.json` 或 `config.toml` 内联 | ✅ 源码有 `percent_of_context_window_remaining`（对外字段名未证实） | ❌ 未证实 | `codex resume`（`--last`/`--all`）、`codex exec resume --last` |
| **Kimi** | `~/.kimi-code/skills/<name>/SKILL.md`；跨工具共享用 `~/.agents/skills/`；规则 `AGENTS.md`（**不是 KIMI.md**） | T2 部分：hooks 在 `~/.kimi-code/config.toml` 的 `[[hooks]]`，18 事件含 `PreCompact`，但**返回值被忽略、不能阻断**；`SessionStart` 不能注入上下文，**只能靠 `UserPromptSubmit`** | ✅ `reserved_context_size`（压缩触发条件）＋ TUI `/usage`；归档版有 `compaction_trigger_ratio=0.85` | ⚠️ 只有 REST/ACP 能程序化新建 | `kimi --continue` / `--session <id>` / `--resume` |
| **TRAE（原 MarsCode）/ 扣子** | `.trae/skills/`、`~/.trae-cn/skills`；**支持 `.agents/skills/` 自动发现**；规则 `AGENTS.md` | TRAE hooks 6 事件（无 PreCompact）；扣子自身 hook 事件表未证实 | TRAE：`/context` ＋自动压缩；扣子：阈值可配置但**官方未给百分数** | ❌ | TRAE CLI `--resume[=SESSION_ID]`、`/resume`、`/new`；扣子 OpenAPI 建会话 |
| **WorkBuddy** | `.codebuddy/skills/<name>/SKILL.md`（项目级）／`~/.codebuddy/skills/`（用户级）；规则 `.codebuddy/rules/`（**自动加载**）；兼容 `AGENTS.md` | 有 Hook 钩子插件，但**事件名与配置格式官方未给**；另可定时任务/Webhook | ❌ 自身文档零规格（CodeBuddy 的 70–92% 阈值**不等于** WorkBuddy） | ✅ 仅**企业云侧**「自动化任务每次执行创建独立 Session」 | ❌ 桌面端无 CLI 续接 |
| **豆包 App** | **一无所获**：无官方文档站，路径全站内 404 | — | — | — | — |

## 2. 硬边界（这些不要写进本体）

1. **本体 frontmatter 只准 `name` / `description` / `metadata`。**
   Claude Code 之外的打包路径只白名单六个字段（`allowed-tools, compatibility, description, license, metadata, name`），
   多写一个 —— 例如 Claude Code 的 `hooks` —— 会**硬报错**而不是忽略。
2. **DSH 无 `PreCompact`/`PostCompact` 钩子**，其 hooks 桥只支持 7 个事件；且 `transcript_path` 恒为 `''`
   （会话日志是 zstd，hook 脚本读不到）。所以 DSH 侧"压缩前抢救"没有原生通道，只能靠**提前阈值触发**。
3. **Kimi 的 `PreCompact` 返回值被完全忽略**，不能阻断、不能改写入参。
4. **"自动开新会话"不是任何平台通用能力**：唯一被官方证实的是 WorkBuddy **企业云侧**的自动化任务。
   其余一律降级为"给命令"或"给可粘贴指令"，**不许声称已实现自动跳转**。
5. **规则 ≠ 技能**：TRAE 官方原文——规则全量加载、常驻占上下文；技能按需加载。
   所以长规则（本技能的约束）更适合**技能**载体，不要塞进总是加载的规则文件。

## 3. 降级链（步骤 4.6 的三档）

```
A 能程序化开新会话 ──► 自动开 + 送开场指令            （本机全平台：未证实可用）
B 能命令行续接/新建 ──► 给一条可复制命令               （DSH headless --session-id / Kimi --session / Codex resume / TRAE --resume）
C 都不可用     ──► 给可粘贴开场指令 OPENING_PROMPT.md   （Kimi 桌面、豆包、WorkBuddy 桌面端；Claude Code 的常态）
```

**报告时必须写明实际用了哪一档。** 用了 C 却写"已自动接管"＝造假。

## 4. 各平台触发档的诚实表述

| 平台 | 能承诺的 | 不能承诺的 |
|---|---|---|
| DSH | 技能可被发现并加载（已验证）；可用 `measure` 拿到真实占用；用户明示触发 100% 可用 | 压缩前自动触发（无钩子）；自动开新会话 |
| Claude Code | `PreCompact` 阻断 + `SessionStart(compact)` 重注入 + `Stop` 每轮自检（**配置已给，未在本机实测**） | 官方占用百分比；自动开新会话 |
| Codex | `PreCompact` 钩子存在（12 事件之一）；`AGENTS.md` 自动加载 | 具体 hook 配置格式（官方文档站 403，仅源码为证）；自动开新会话 |
| Kimi | 技能自动加载（官方证实）；`reserved_context_size` 触发条件；`kimi --session` 续接 | 用 hook 阻断压缩；`SessionStart` 注入上下文；自动开新会话 |
| TRAE/扣子 | `.agents/skills/` 自动发现；`--resume` 续接 | 压缩阈值数值（未证实）；自动开新会话 |
| WorkBuddy | `.codebuddy/skills/` 的 `SKILL.md` 自动加载；`.codebuddy/rules/` 自动加载；企业云侧自动建 Session | 桌面端 hook 配置格式；自身压缩阈值；桌面端 CLI 续接 |

## 5. 未证实清单（不许当事实引用）

- Codex：`hooks.json` 是否就在 `~/.codex/`；"剩余上下文百分比"的对外字段名；`~/.codex/skills/`、`~/.codex/prompts/` 的存在；`--continue`。
- Claude Code：是否有官方"当前上下文占用"环境变量；`transcript_path` 的 JSONL 结构规范；能否程序化开新会话。
- Kimi：`compaction_trigger_ratio` 在**现行版**是否仍生效（只有归档版文档有）；SYSTEM.md/AGENTS.md 的字符或 token 上限。
- 扣子：自身 Hook 事件表；自动压缩的具体百分比。
- WorkBuddy：桌面端 hook 事件名与配置格式；桌面端自身上下文阈值；桌面端 CLI 续接。
- 豆包 App：技能文件格式、安装路径、自动加载机制 —— **全部一无所获**。
- 通用：DSH/Claude Code 之外任何平台的"长任务自动开新会话"。
