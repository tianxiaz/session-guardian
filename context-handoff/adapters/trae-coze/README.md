# 适配层 · TRAE（原 MarsCode）／扣子 Coze

> 状态：**未实测**。两条都是字节系但**都不是豆包 App**；豆包 App 一无所获，见
> `adapters/kimi-doubao/README.md` 第二节。
> 来源：`docs/_evidence/批L-上下文交接技能/调研-豆包与WorkBuddy.md`

## 1. 为什么这两个平台值得单独写

因为它们是唯一**同时**满足以下三条的字节系平台（都有官方 Markdown 文档站，可逐字取证）：

1. 官方支持以 `SKILL.md` 为核心的技能目录；
2. 支持 `.agents/skills/` 这一**跨工具规范目录**的自动发现（与 DSH 的 rank 500、Claude Code、
   TRAE 共享同一套约定）；
3. 官方给出规则 vs 技能的**加载语义差异**，这是本技能选载体的直接依据。


## 本平台的中断信号（B 轴：执行中断）

> 触发有三条轴，**B 轴（执行中断）发生时模型往往已没机会写**。完整场景见 `references/triggers.md`。

| 信号 | 对应 `trigger` | 备注 |
|---|---|---|
| TRAE hooks 的 `Stop` / `Notification` | `checkpoint` | TRAE 有 6 类事件（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/Notification） |
| `SessionStart` | `interruption`（重开后） | 官方把"上下文增强"推荐给这个事件 |
| 自动压缩 + `/context` | `context-pressure` | TRAE CLI 有 `/context`、`/compact`、自动压缩 |
| **无 `PreCompact`** | — | 压缩前拿不到信号，只能靠阈值 + 检查点 |

⚠️ 扣子（Coze）自身**没有找到 hook 事件表**（未证实），**不要写没依据的配置**。


## 权限（部署后必做）

```bash
# 部署后修权限
chmod -R u+rwX,go+rX <技能目录>
find <技能目录> -name '*.sh' -exec chmod 755 {} +
```

## 2. TRAE（原 MarsCode，marscode.cn 已跳转 trae.cn）

### 2.1 部署

| 层 | 路径 |
|---|---|
| 项目级技能 | `.trae/skills/` |
| 用户级技能 | `~/.trae-cn/skills`、`.traecli/skills/` |
| **跨工具规范目录** | **`.agents/skills/`（官方：运行时自动发现并加载）** |
| 同名优先 | `.trae/skills/` 优先于 `.agents/skills/` |
| 规则 | `AGENTS.md` / `CLAUDE.md` 等 Markdown |

⇒ 最省事的做法：把技能放 `<项目>/.agents/skills/context-handoff/`，
这样 DSH（rank 200）、Claude Code、TRAE 都能发现同一份。

### 2.2 触发档位

TRAE 有 **6 类 hook 事件**：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` /
`Stop` / `Notification`。官方把"上下文增强"明确推荐给 **`SessionStart`**。
**没有 `PreCompact`** ⇒ 压缩前抢救这条路在 TRAE 上不通，只能提前预警。

量化：TRAE CLI 有 `/context`、`/compact`、自动压缩；Max 模式窗口**最高 1M**；
官方另给"主流模型通常在 45K 左右"的参考说法。**自动压缩的百分比阈值未给**。

升级档：**B 可用** —— `--resume[=SESSION_ID]`、`/resume`、`/new`。

### 2.3 官方关键区分（本技能选载体的依据）

> 规则采用**全量加载机制**，一旦开启对话，所有规则都会被注入并持续占用上下文窗口；
> 技能则采用**按需加载机制**，仅在实际需要被调用时才加载到上下文中，从而显著降低 Token 消耗。

⇒ 本技能的约束（长、只在临界点才需要）**必须做成技能，不能塞进 `.trae/skills` 之外的规则文件**。

## 3. 扣子 Coze（docs.coze.cn，有官方 `.md` 与 `llms.txt`）

### 3.1 部署

- 技能 = **结构化文件夹**，**必需 `SKILL.md`**，可含 `scripts/` `references/` `assets/`；
- 安装 = 上传 `.skill` 技能包；
- **桌面端会扫描本地目录**：包含 `SKILL.md` 且能解析出名称/描述的文件夹即被识别为可添加技能；
- 规则类 Markdown：**项目根放 `AGENTS.md` 即"每次开发自动加载并遵守"**；
- 长期记忆载体是官方命名的 **`MEMORY.md`**；心跳机制读 **`HEARTBEAT.md`**。

### 3.2 加载语义：官方"渐进式披露"

官方原文：启动只加载元数据，按需加载正文，明确目的就是"**避免上下文窗口过载**"。
⇒ 与本技能"本体按需加载、适配层另放"的形态天然契合。

### 3.3 触发档位与限制

| 项 | 结论 |
|---|---|
| hooks | ❌ **扣子自身的 Hook 事件表未找到一手来源**（只在本地 Agent 能力罗列里提到 Hooks）⇒ 不写配置 |
| 自动压缩阈值 | ⚠️ **可配置**（官方原文"触发自动压缩的上下文长度阈值"），但官方只写"模型上限的一定比例"，**未给百分数** ⇒ 不要编数字 |
| 模型窗口（官方数字） | Doubao-Seed-1.6 = 256k；Kimi-K2 = 256k；lite-32k = 32k |
| 新会话 | 手动新建（3 种方式，上限 100）；或 OpenAPI `POST /v1/conversation/create`、`POST /v1/conversations/:id/clear`；Coze CLI 官方声明"创建和复用 Session…恢复长任务" |
| 自动开新会话 | ❌ |

## 4. 验证（未实测，命令留待本机装好后核对）

```bash
# TRAE：放好技能后新开会话，看技能是否出现
ls -d .agents/skills/context-handoff .trae/skills/context-handoff 2>/dev/null
# 会话内
/new          # 新建
/resume       # 续接
/context      # 看上下文占用
```

## 5. 来源

`docs/_evidence/批L-上下文交接技能/调研-豆包与WorkBuddy.md` §扣子与TRAE 各小节
（含 `https://docs.trae.cn/ide_skills.md` 等 URL 与 HTTP 状态核验表）
