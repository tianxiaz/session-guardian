# 适配层 · Kimi（月之暗面）／豆包

> 状态：**未实测**（本机没装 Kimi CLI）。
> Kimi 的结论有官方一手来源；**豆包 App 部分一无所获，本文不作任何编造**。

## 一、Kimi

### 1. 部署（放文件即安装，无需注册）

| 层 | 路径 | 来源 |
|---|---|---|
| 用户级技能 | `~/.kimi-code/skills/<name>/SKILL.md`（`$KIMI_CODE_HOME/skills/`） | 官方 |
| **跨工具共享技能** | `~/.agents/skills/` | 官方（明确这是跨工具共享目录） |
| 项目级技能 | `<仓库根>/.kimi-code/skills/` | 官方（项目根＝最近含 `.git` 的祖先） |
| 用户级规则 | `~/.kimi-code/AGENTS.md` | 官方（`${agents_md}` 注入） |

> ⚠️ **规则文件的官方名是 `AGENTS.md`，不是 `KIMI.md`** —— `KIMI.md` 只出现在用户 feature
> request 里，无任何官方支持。另外 `~/.kimi-code/SYSTEM.md` 可整体替换 main agent 系统提示词，
> 是"长规则固化"最直接的官方通道（慎用：它会顶掉默认系统提示）。

```bash
mkdir -p ~/.kimi-code/skills
cp -R <技能目录> ~/.kimi-code/skills/context-handoff
```

自动加载机制：会话启动时把**全部技能的 name / path / description 注入系统提示词**，
模型按 `description` + `whenToUse` 自行调用读入正文（嵌套上限 3 层）。
⇒ **触发灵不灵，几乎全看 `description` 的措辞。**

⚠️ 两处官方文档互相矛盾，写技能时按保守做法：
- 目录型 `SKILL.md` 的 `name`/`description`：现行 CLI 文档说"必须显式填写，省略任一即解析失败"，
  帮助中心/归档版说"可选" ⇒ **两个都显式写**。
- 技能调用名：现行文档说"没有独立 `/flow:` 命名空间，flow 也走 `/skill:<name>`"，
  归档文档与帮助中心写 `/flow:<name>` ⇒ **两种调用名各试一次**。

### 1.5 【首选】用 Kimi **Plugin** 安装 —— 最傻瓜的方式

这个仓库根就是一份 Kimi Plugin（`kimi.plugin.json`）。在 Kimi Code 输入框里敲两行即可：

```
/plugins install /解压后的目录/context-handoff
/reload
```

发布到 GitHub 之后更省事：

```
/plugins install https://github.com/<owner>/<repo>
/reload
```

**为什么这条最好**（官方文档一手依据）：

| 官方能力 | 我们怎么用 |
|---|---|
| `/plugins install <路径/zip URL/GitHub URL>` | 一条命令装完，不用懂任何目录规则 |
| manifest `systemPrompt` / `systemPromptPath` | **每次会话起点自动注入常驻规则** —— 自动唤醒的 L1 层，且不必改用户自己的 `config.toml`/`AGENTS.md` |
| manifest `hooks`（工作目录＝plugin 根，注入 `KIMI_PLUGIN_ROOT`） | 提醒钩子随插件走，**自包含**，不需要把脚本复制到 `~/.claude/hooks` 之类的地方 |
| 省略 `skills` ⇒ 根 `SKILL.md` 即该 plugin 的 Skill | 技能本体按需读取，不占每次会话的 token |

⚠️ 已知约束（官方文档明说）：
- **plugin 是用户级、对所有项目生效**，暂不支持项目级安装范围。
- 本地安装会被**复制**到 `$KIMI_CODE_HOME/plugins/managed/<id>/`，**改源目录不生效，要重新 install**。
- 安装/启用/禁用后当前会话不刷新，需 `/reload` 或 `/new`。
- `systemPrompt` 单文件上限 **32 KB**、所有插件合计 **64 KB**（我们只用了约 2 KB）。
- 每次 `UserPromptSubmit` 都会跑钩子，所以 `kimi_remind.sh` 里做了防刷屏与快速静默。

**未实测**：本机没装 Kimi CLI，这个 manifest 只按官方文档校验过字段合法性（有自测判据），
**没有在真机上 install 过**。装完请按下方"验证"一节自查。

---

### 1.5 【首选】用 Kimi **Plugin** 安装 —— 最傻瓜的方式

这个仓库根就是一份 Kimi Plugin（`kimi.plugin.json`）。在 Kimi Code 输入框里敲两行即可：

```
/plugins install /解压后的目录/context-handoff
/reload
```

发布到 GitHub 之后更省事：

```
/plugins install https://github.com/<owner>/<repo>
/reload
```

**为什么这条最好**（官方文档一手依据）：

| 官方能力 | 我们怎么用 |
|---|---|
| `/plugins install <路径/zip URL/GitHub URL>` | 一条命令装完，不用懂任何目录规则 |
| manifest `systemPrompt` / `systemPromptPath` | **每次会话起点自动注入常驻规则** —— 自动唤醒的 L1 层，且不必改用户自己的 `config.toml`/`AGENTS.md` |
| manifest `hooks`（工作目录＝plugin 根，注入 `KIMI_PLUGIN_ROOT`） | 提醒钩子随插件走，**自包含**，不需要把脚本复制到 `~/.claude/hooks` 之类的地方 |
| 省略 `skills` ⇒ 根 `SKILL.md` 即该 plugin 的 Skill | 技能本体按需读取，不占每次会话的 token |

⚠️ 已知约束（官方文档明说）：
- **plugin 是用户级、对所有项目生效**，暂不支持项目级安装范围。
- 本地安装会被**复制**到 `$KIMI_CODE_HOME/plugins/managed/<id>/`，**改源目录不生效，要重新 install**。
- 安装/启用/禁用后当前会话不刷新，需 `/reload` 或 `/new`。
- `systemPrompt` 单文件上限 **32 KB**、所有插件合计 **64 KB**（我们只用了约 2 KB）。
- 每次 `UserPromptSubmit` 都会跑钩子，所以 `kimi_remind.sh` 里做了防刷屏与快速静默。

**未实测**：本机没装 Kimi CLI，这个 manifest 只按官方文档校验过字段合法性（有自测判据），
**没有在真机上 install 过**。装完请按下方"验证"一节自查。

---

### 2. 自动唤醒（三层）（下面这条是**手工版**，用于不能装 plugin 的场合）

### 2. 自动唤醒（三层）——这是全篇最该先读的一节

**先说结论：Kimi 原生没有"上下文到 X% 就自动加载技能"这种机制。** 能做到"自动"的只有下面三层，
可靠性从高到低；**建议三层一起上**（`deploy.sh` 全做了）。

| 层 | 机制 | 什么时候生效 | 可靠性 | 失效场景 |
|---|---|---|---|---|
| **L1 常驻规则** | `~/.kimi-code/AGENTS.md`（官方 `${agents_md}` 注入） | **每个会话开始时**都进系统提示词 | ★★★ 最可靠 | 规则写太长被挤掉；模型忽略规则（少见但可能） |
| **L2 description** | 会话启动时把全部技能的 `name`/`path`/`description` 注入系统提示词，模型按描述自行调用 | 模型"想起来"的时候 | ★★ 取决于措辞 | 模型没意识到自己快满了（**它看不见自己的 token 用量**） |
| **L3 钩子注入** | `UserPromptSubmit` 钩子返回文本 → **追加进上下文** | **用户每发一条消息时** | ★★ 有数字就很强 | ⚠️ **用户不说话就不触发** |

**L3 的致命局限（必须先知道）**：它是唯一能"程序化往上下文塞提醒"的位置，但只在**用户提交消息**时执行。
所以**长时间的自主运行（几十分钟没人输入）里它一次也不会跑** —— 而那恰恰是"会话过长任务中断"最常发生的场景。
⇒ **L1 + L2 才是那种场景下的真正防线**，L3 只是交互式使用时的加强。

#### 为什么 `SessionStart` / `PreCompact` 指望不上（都是一手结论）

| 事件 | 官方定性 | 能不能注入/阻断 |
|---|---|---|
| `SessionStart` | **观察型事件**，即发即忘 | ❌ 不能注入上下文 |
| `PreCompact` / `PostCompact` | **返回值被完全忽略** | ❌ 不能阻断、不能改写入参 |
| `PreToolUse` / `Stop` / `UserPromptSubmit` | **可阻断事件** | ✅ 只有这类事件的返回值会影响主流程 |

⇒ 想"压缩前抢救"，Kimi 侧只能让脚本**自己往盘上写**（把 HANDOFF.md 落盘），不能指望 hook 干预压缩本身。

#### 具体怎么配（`deploy.sh` 一键做，也可手工）

```bash
# 一键部署（复制技能 + 修权限 + 写 config.toml + 追加 AGENTS.md 规则，幂等）
bash <技能目录>/adapters/kimi-doubao/deploy.sh --dry-run   # 先看要做什么
bash <技能目录>/adapters/kimi-doubao/deploy.sh             # 真跑
```

手工版三件事：

1. **L1**：把 `adapters/kimi-doubao/AGENTS.snippet.md` 里 `---` 之间的内容追加到 `~/.kimi-code/AGENTS.md`
2. **L2**：不用配置（`description` 已在本体里，覆盖三条失效轴）
3. **L3**：往 `~/.kimi-code/config.toml` 追加：

```toml
[[hooks]]
event = "UserPromptSubmit"
command = "bash -lc '<技能目录>/adapters/kimi-doubao/kimi_remind.sh'"
timeout = 10
```

> ⚠️ **字段是硬校验**：`[[hooks]]` 只允许 `event` / `matcher` / `command` / `timeout` 四个字段，
> **多写一个会导致整份 `config.toml` 加载失败**。`deploy.sh` 只写这四个。

#### `kimi_remind.sh` 能不能真拿到占用？（**必须自己验一次**）

Kimi **不会**向 hook 进程导出占用量。脚本按三条路径取数，取不到就**静默**（不猜、不编）：

1. `CONTEXT_HANDOFF_OCCUPANCY`（调用方算好，最可信）
2. `~/.kimi-code/sessions/**/agents/*/wire.jsonl` **尾部**的 usage 类字段
   （`prompt_tokens` / `context_tokens` / `input_tokens` / `total_tokens` 取最大）
3. 都没有 ⇒ 静默

⚠️ **路径 2 是基于官方文档描述的推断实现，未在 Kimi 上实测**（开发机没装 Kimi）。
**部署后请务必跑一次**：

```bash
bash <技能目录>/adapters/kimi-doubao/kimi_remind.sh --debug
```

- 打印出 `used=… max=… ratio=…` ⇒ L3 真能用
- 打印"没有 usage 类字段" ⇒ 该 Kimi 版本不记这些字段，**L3 等于没用，只剩 L1+L2**
- 打印"拿不到 max_context_size" ⇒ 在 `config.toml` 里设 `max_context_size`，或用
  `CONTEXT_HANDOFF_MAX_CONTEXT_SIZE` 环境变量

阈值默认 **0.75**（改：`CONTEXT_HANDOFF_WARN_RATIO`）；同一次越线只提醒一次（降回阈值以下再越线才会再提醒），
避免每轮刷屏。

### 3. 基础模型/上下文窗口（官方数字，供算阈值）

| 模型 | 窗口 |
|---|---|
| Kimi K3 | 1048576（1M） |
| K3-256K / K2.7 Code | 262144 |

`/goal` 是唯一面向长指令的硬上限：**4000 字符**。cron 注入文本上限 8 KB。
**SYSTEM.md / AGENTS.md / prompt 的字符或 token 上限——未找到一手来源**，真实约束是上下文预算。

### 4. 升级档

- A 自动开新会话：⚠️ 只有 REST（`POST /api/v1/sessions`，实验性）或 ACP（`session/new`）
  能程序化新建；cron 定时任务官方明确"**不会带入全新的会话**"。
- **B 命令行续接**：✅ 官方齐备 —— `kimi --continue`(-c)、`kimi --session <id>`(-S)、
  `kimi --resume`(-r，`--session` 的隐藏别名)；新建＝`kimi`(无参)、`/new`、`/fork`
  （fork 后 CLI 直接打印可运行的 `kimi --resume` 命令）。
- **C 可粘贴开场指令**：✅ Kimi 桌面端的正常形态。

### 5. 验证

```bash
ls ~/.kimi-code/skills/context-handoff/SKILL.md     # 文件就位
kimi                                                # 起会话
/usage                                              # 看"上下文占用"是否有数
kimi --session <id>                                 # 验证续接可用
```
触发验证：说一句"帮我做上下文交接"，看技能是否被自动调用（若没有，就是 `description` 措辞问题）。

---


## 本平台的中断信号（B 轴：执行中断）

> 触发有三条轴，**B 轴（执行中断）发生时模型往往已没机会写**。完整场景见 `references/triggers.md`。

Kimi 侧的一手证据（官方 issue）：

| 现象 | 证据 | 可观测性 | 对应 `trigger` |
|---|---|---|---|
| **会话假死**：请求挂起无响应 | [kimi-code#3664](https://github.com/MoonshotAI/kimi-code/issues/3664)：长会话 8 个请求全部挂起，`ttft` 达 164 秒，客户端**无超时/无提示/无自动重试** | ❌ | 重开后 `interruption` |
| **会话被外部杀死** | [kimi-code#2622](https://github.com/MoonshotAI/kimi-code/issues/2622)：「Goal/task state was lost with the kill」 | ❌ | 重开后 `interruption` |
| 网络中断直接终止 | [kimi-cli#1540](https://github.com/MoonshotAI/kimi-cli/issues/1540)：「terminate completely」 | ⚠️ | `error-recovery` |
| 工具超时被强杀 | [kimi-cli#1761](https://github.com/MoonshotAI/kimi-cli/issues/1761)：「terminated at 60s」 | ❌ | 重开后 `interruption` |
| **压缩自身失败** | [kimi-code#4193](https://github.com/MoonshotAI/kimi-code/issues/4193)：turn 以 `[compaction.failed]` 硬失败、goal 暂停 | ✅ | `compaction-failed` |
| 长会话打不开 | [kimi-code#3592](https://github.com/MoonshotAI/kimi-code/issues/3592)：30 秒超时 | ❌ | 重开后 `interruption` |
| 轮次/目标耗尽 | `kimi -p` 退出码：完成 `0`、阻塞 `3`、暂停 `6` | ✅ | `round-limit` |
| 配额/预算 | `/usage` 同时显示 token 用量与**配额**；官方有"按 token 预算触发压缩"的需求单 [kimi-code#2603](https://github.com/MoonshotAI/kimi-code/issues/2603) | ✅ | `budget-quota` |

**⇒ Kimi 側尤其需要检查点**：上表 5 个 ❌ 项都不可观测，而 #2622 明确记录
"被 kill 时 goal/task 状态丢失"——这正是检查点要防的。

⚠️ 本平台 `PreCompact`/`PostCompact` **返回值被忽略**（不能阻断、不能注入），`SessionStart` 不能注入上下文
⇒ **不能指望在这些事件里自动提醒模型**；能注入文本的只有 `UserPromptSubmit`。


## 权限（部署后必做）

```bash
# 复制到 Kimi 技能目录后修权限
chmod -R u+rwX,go+rX <技能目录>
find <技能目录> -name '*.sh' -exec chmod 755 {} +
```

## 二、豆包（Doubao）

**能力空缺，不做编造。** 调研结论：

- 豆包 App（doubao.com）**没有公开文档站**：`/help` `/docs` `/legal` `/skills` `/help-center`
  `/agent` 六个路径全部 HTTP 200 但返回**同一个 191,230 字节的 SPA 外壳**，
  渲染后均为"未找到页面"。仅在其 `/chat/` 页面内嵌 JSON 里找到
  `{"skill_type":5007,"show_name":"技能"}` —— 只能证实**入口存在**。
- ⇒ **豆包 App 的技能文件格式、安装路径、自动加载机制：全部一无所获。**

若要在字节生态落地，**可用的官方文档在两个 Markdown 站**（同属字节系，但**不是豆包 App**）：

| 平台 | 技能路径 | 规则 | hooks | 备注 |
|---|---|---|---|---|
| **扣子 Coze** | 技能＝结构化文件夹，**必需 `SKILL.md`**（含 `scripts/` `references/` `assets/`）；桌面端会扫本地目录，含 `SKILL.md` 且能解析出名称/描述即被识别 | 项目根 `AGENTS.md` "每次开发自动加载并遵守"；另有官方命名的 `MEMORY.md`（长期记忆）、`HEARTBEAT.md`（心跳） | 扣子自身 hook 事件表**未找到** | 官方"渐进式披露"：启动只加载元数据、按需加载正文，明确目的是"避免上下文窗口过载"——与本技能的"技能按需加载"思路一致 |
| **TRAE（原 MarsCode）** | `.trae/skills/`、`~/.trae-cn/skills`；**支持 `.agents/skills/` 运行时自动发现**（同名时 `.trae/skills/` 优先） | `AGENTS.md` / `CLAUDE.md` 等 | **6 类事件**：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / Notification；官方把"上下文增强"明确推荐给 `SessionStart` | TRAE CLI 有 `/context`、`/compact`、`--resume[=SESSION_ID]`、`/resume`、`/new`；Max 模式窗口最高 1M |

**TRAE/扣子的关键区分（官方原文）**：规则采用**全量加载**（一旦开启对话，所有规则都被注入并
持续占用上下文窗口）；技能采用**按需加载**。⇒ 长规则别塞进 `AGENTS.md`，放技能。

## 三、来源

- Kimi：`docs/_evidence/批L-上下文交接技能/调研-kimi.md`（44 条证据，43 已证实；含两代官方文档
  不一致对照表）
- 豆包/扣子/TRAE：`docs/_evidence/批L-上下文交接技能/调研-豆包与WorkBuddy.md`
  （56 条留证；**13 条"一无所获"清单必须一起看**）
