# 适配层 · DSH（DeepSeek Harness）

> 状态：**本机已部署并验证**（唯一一个真正跑过的平台）。证据见 `docs/_evidence/批L-上下文交接技能/`
> 与本文件末尾的验证记录。

## 1. 部署（就是放文件）

DSH 的技能发现根（`dsh-skill-filesystem`，rank 越小越优先）：

| rank | 来源 | 路径 | 本机 |
|---|---|---|---|
| 100 | project-dsh | `<项目根>/.dsh/skills` | — |
| 200 | project-agents | `<项目根>/.agents/skills` | — |
| 300 | custom | profile 的 `customSkillDirs` | 未配置 |
| **400** | **user-dsh** | **`$DSH_HOME/skills`**（本机通常 `~/.dsh/skills`） | 推荐装这里 |
| 500 | user-agents | `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`） | 本机不存在 |
| 600 | bundled | `$DSH_BUNDLED_SKILL_DIR` | 未设置 |

只扫一层：`<root>/<name>/SKILL.md`，**不递归** `**/SKILL.md`。

所以部署 = 把技能目录放进 `<技能目录>/`，
**无需注册、无需重启**（该 provider 会 watch 根目录，新技能进下一次目录刷新）。

本机确认（技能名已出现在会话技能目录中）：
```
$ ls <技能目录>
SKILL.md  adapters  references  scripts  templates
```

DSH 侧 frontmatter 只用到 `name` + `description`（可选 `whenToUse`/`metadata`/`user-invocable`）。
本技能**不写** `whenToUse`，理由是它属于 DSH 专有字段，写进本体就破坏"本体逐字相同"。


## 本平台的中断信号（B 轴：执行中断）

> 背景：触发有三条轴，其中 **B 轴（执行中断）发生时模型往往已没机会写任何东西**。
> 完整场景见 `references/triggers.md`。

| 信号 | 从哪拿 | 对应 `trigger` |
|---|---|---|
| `agent/request-error` 的稳定码 | `dsh-llm-deepseek` README 列出：`AUTH`/`QUOTA`/`RATE_LIMIT`/`CONTEXT_WINDOW_EXCEEDED`/`INVALID_REQUEST`/`SERVER`/`TRANSPORT`/`ABORTED`/`TIMEOUT`/`REQUEST_EXTENSION`/… | `error-recovery`（限流/配额/传输/超时） |
| `CONTEXT_WINDOW_EXCEEDED` | 同上；`dsh-compaction-basic` 会先做一次最大削减再重试 | `error-recovery`（削减后仍失败 ⇒ 交接） |
| goal 轮次耗尽 | `dsh-goal-round-driver` 稳定码 `round-limit` | `round-limit` |
| **假死 / 被 kill / 崩溃 / 会话打不开** | ❌ **模型侧不可观测**（会话日志是 zstd，hook 脚本也读不到 transcript） | 只能靠 `checkpoint` 提前写 |

**⇒ DSH 侧必须做检查点**：上表最后一行没有任何原生通道，唯一防线是"趁还活着写新"。


## 权限（部署后必做）

```bash
# 部署后修权限（默认 umask 可能给出 600/711）
chmod -R u+rwX,go+rX <技能目录>
find <技能目录> -name '*.sh' -exec chmod 755 {} +
```

## 2. 触发档位（**DSh 的真实能力，不要夸大**）

| 档 | 能力 | 结论 |
|---|---|---|
| T1 外部量化 | ✅ 可做到。`contextPressure` 投影落在 `$DSH_HOME/storages/session_projcache/sessions/<id>.json` 的 `record.rows.contextPressure.val` | 用 §3 的命令取数 |
| T2 压缩前钩子 | ❌ **做不到**。DSH hooks 桥（`dsh-hooks-claude-code` / `dsh-hooks-codex`）只支持 7 个事件，**不含 `PreCompact`/`PostCompact`**；且 `transcript_path` 恒为 `''` | 只能提前预警，不能压缩前抢救 |
| T3 用户明示 | ✅ | 100% 可用 |
| T4 自估兜底 | ✅（但必须如实标 `self-estimate`） | — |

DSH 自动压缩默认在 `floor(min(W×0.8, W−O−65536))` 触发（`dsh-compaction-basic`）。
本技能**不写死这个比例**：用 `deriveThresholds(W)` 算真实触发点，预警线 = 触发比例 − 0.05（下限 0.4）。
以 W=1e6 为例 ⇒ 触发 0.8、预警 **0.75**，即**约 5% 的窗口**做交接动作（不是 8%）。
W 更小时触发比例更低（262144 ⇒ 0.5），必须靠主动自检，不能只等阈值。

## 3. 取数（本机实测可用）

```bash
node <技能目录>/scripts/measure_context.mjs \
  --workspace "$PWD" --json
```

实测输出（2026-10-16 **某时刻快照**；数字随会话进展变化，`seq` 才是可核对锚点）：
```json
{ "ok": true, "occupancy": 0.0633, "source": "dsh:contextPressure",
  "raw": { "surfaceTokens": 32678, "pressureTokens": 63348, "contextWindow": 1000000, "seq": 227 } }
```
（同一工作区后续实测：`occupancy 0.2593`、`surfaceTokens 202972`、`pressureTokens 259345`、`seq 1215`。
**别把上面的数字当常量**。）

**取不到时不许编**：脚本会返回 `ok:false, source:"unavailable"` 并给出原因；
此时 `provenance.occupancy` 写 `unavailable`、`trigger` 记为 `self-estimate`。

## 4. 升级档（§4.6 的 A/B/C）

- **A 自动开新会话**：❌ 未证实。DSH 没有文档化的"按 session id 直达 Web 会话"的 URL 形态。
- **B 命令行续接**：✅ 可用（headless profile）：
  ```bash
  dsh --profile headless --session-id <id> "继续：<开场指令>"
  ```
  新会话（不带 `--session-id`）默认生成 `session-<uuid>`。
- **C 可粘贴开场指令**：✅ 常态，产物即 `OPENING_PROMPT.md`。

本机 `$DSH_HOME/profiles/` 只有 `web` 与 `headless`，**没有 tui**，
所以 `dsh tui --resume <session>` 这条路径本机不可用。

## 5. 判据（放哪都能跑）

```bash
cd <技能目录>
node --test "scripts/tests/*.test.mjs"     # 本机：132 项 / 132 通过（1 项在无本仓 docs/73 时自动跳过）
```

## 6. 验证记录（真实跑过的）

| 项 | 命令 | 结果 |
|---|---|---|
| 技能被发现 | 会话技能目录中出现 `context-handoff` | ✅ 已出现在系统提示的技能清单里 |
| 自测全绿 | `node --test "scripts/tests/*.test.mjs"` | ✅ 132/132 |
| 量化取数 | `measure --workspace <你的工程目录>` | ✅ 实测能取到（作者机器上 occupancy 约 0.06–0.67，随会话变化），source=`dsh:contextPressure` |
| 变异能红 | 删掉一节后 `check` | ✅ exit 2，报 `E_SECTION_MISSING` |
| 幂等 | 同 payload 连跑两次 `next` | ✅ 逐字节相同（修掉了 `supersedes` 非幂等缺陷） |

## 7. 可选增强：把 Stop 钩子接上做"每轮自检"（**未做，需你决定**）

DSH 的 hooks 桥支持 `Stop`。若把 `dsh-hooks-claude-code` 挂进 profile 并指向本技能的
**`adapters/dsh/hooks.settings.json`**，就能在每次会话开始注入提醒、并在每轮结束跑一次阈值检查。

**为什么不再需要复制脚本**：这份配置的 `Stop` 直接调用**技能自带的**
`${DSH_HOME:-$HOME/.dsh}/skills/context-handoff/scripts/check_handoff.mjs`，
所以 `adapters/dsh/` 是自包含的（R4β #8 实测：旧配置指向 `$HOME/.claude/hooks/context_budget.sh`，
而那个文件根本不存在，等于钩子必然失效）。

⚠️ 前提：技能装在默认位置 `$DSH_HOME/skills/context-handoff/`。装到别处就得改这段路径。

⚠️ **这份配置里故意没有 `PreCompact`** —— DSH 的钩子桥**不支持**该事件（官方不支持清单里有），
写了会被**静默丢弃**，反而让人误以为"DSH 侧压缩前有钩子"。DSH 侧拿不到"压缩前"这一刻，
所以它的触发只能靠 §2 的 T1（量化预警）与 T3（用户明示）。
**我没有替你动 profile 配置**（用户明确要求不做全局改动）。要做的话是：
```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 追加
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: <技能目录>/adapters/dsh/hooks.settings.json
```
注意桥会**忽略**配置里的 `PreCompact`/`PostCompact`（官方不支持清单里有），只生效
`SessionStart`/`Stop` 等 7 个事件 —— 所以 DSH 侧**拿不到「压缩前」这一刻**。
