# context-handoff · 上下文交接技能

> 让 AI 会话在**换会话/被中断**时，把"接续必需的事实"写进一份字段固定、可脚本判绿、
> 可幂等增量更新的 `HANDOFF.md`，使新会话仅凭它＋仓库现状就能接着干——不重复已完成的、
> 不漏待办、不踩禁区。

**本体平台无关**：`SKILL.md` 在任何支持 Markdown 技能的平台上逐字相同；平台差异全在 `adapters/`。

---

## 最简安装：Kimi 用户（推荐，两行）

在 Kimi Code 的输入框里直接敲：

```
/plugins install /解压后的目录/context-handoff
/reload
```

（已发布到 GitHub 后，更省事：`/plugins install https://github.com/<owner>/<repo>` 然后 `/reload`。）

**为什么这是最傻瓜的**：不需要知道任何路径规则、不用 `chmod`、不用改你自己的
`~/.kimi-code/config.toml` 或 `AGENTS.md`。这个仓库根就是一份 **Kimi Plugin**，
manifest 里已经内置了：

| manifest 字段 | 作用 |
|---|---|
| 根 `SKILL.md` | 技能本体（模型按需读取） |
| `systemPrompt` | **每次会话起点自动注入的常驻规则**——自动唤醒主要靠它 |
| `hooks`（`UserPromptSubmit`） | 上下文越过阈值时**自动往上下文里注入一条提醒** |

装完的验证：随便问一句「上下文快满了该怎么做、用哪个技能？」，
应当看到它引用 `context-handoff`；或直接 `/skill:context-handoff` 手动调用。

⚠️ **plugin 是「用户级安装、对所有项目生效」**，且本地安装会被**复制**到
`$KIMI_CODE_HOME/plugins/managed/<id>/`——改了源目录不会自动生效，**重新 `/plugins install` 一次**即可。
装/启用/禁用后当前会话不刷新，要 `/reload` 或 `/new`。

---

## 其他安装方式

### A. 一条命令（Kimi / Claude Code / DSH / 跨工具目录都行）

```bash
cd 解压后的目录/context-handoff
bash install.sh            # 自动探测已装平台，装到能装的地方
```

不用 `./install.sh`（有些解压方式会丢掉可执行位）。`--dry-run` 可先看它要做什么。

### B. 项目级：让技能跟着仓库走（团队共享）

```bash
cd <你的项目根>
bash /path/to/context-handoff/install.sh --target project
```

装到 `<项目根>/.kimi-code/skills/context-handoff`，可以提交进仓库 —— 队友 clone 下来就有，
不用各自装。**不会**改任何用户级配置。

---

## 三级安装（按需要选，越往下越自动）

| 级别 | 做什么 | 效果 | 风险 |
|---|---|---|---|
| **L0 装文件** | `./install.sh` | 技能可被发现、可按需调用 | 无 |
| **L1 装文件 + 常驻规则** | `./install.sh --target kimi --with-rule`<br>（或按 `adapters/<平台>/README.md` 手工加规则） | **每轮会话都被提醒该在单元边界交接**——自动唤醒主要靠这层 | 低（只追加文本，会备份） |
| **L2 + 自动提醒钩子** | `bash <目标目录>/adapters/kimi-doubao/deploy.sh` | 上下文越过阈值时**自动往上下文里注入提醒** | 中（改平台配置，会备份；写坏可能导致配置加载失败） |

⚠️ **L2 有固有局限**：它只能挂在"用户提交消息"这类可注入事件上，
所以**长时间无人输入的自主运行里不会触发**。那种场景只能靠 L1 + 技能描述。

---

## 各平台安装位置

| 平台 | 用户级技能目录 | 一键 |
|---|---|---|
| **Kimi** | `~/.kimi-code/skills/<name>/` | `./install.sh --target kimi --with-rule` |
| **Claude Code** | `~/.claude/skills/<name>/` | `./install.sh --target claude` |
| **DSH** | `$DSH_HOME/skills/<name>/`（通常 `~/.dsh/skills/`） | `./install.sh --target dsh` |
| **跨工具共享** | `~/.agents/skills/<name>/`（多个平台都读） | `./install.sh --target agents` |
| **Codex** | 按版本不同，先读 `adapters/codex/README.md` | `./install.sh --target codex` |

各平台的能力差异、能自动拿到哪些信号、哪些拿不到 —— 见 `adapters/<平台>/README.md` 与
`references/platforms.md`。

---

## 装完怎么验（三件事）

```bash
# 1) 文件就位
ls <安装目录>/SKILL.md

# 2) 判据能跑（先建一份骨架，应判红——因为还没填）
cd <你的工程目录>
node <安装目录>/scripts/check_handoff.mjs init ./HANDOFF.md
node <安装目录>/scripts/check_handoff.mjs check ./HANDOFF.md   # exit 2 = 正常（骨架未填）

# 3) 自测（可选，约 15 秒）
cd <安装目录> && node --test "scripts/tests/*.test.mjs"
# 期望：全通过，0 失败。少数"依赖作者仓库"的检查会自动跳过——那是正常的。
```

---

## 它怎么用（最短版）

**触发时机，优先级从高到低**：

1. **一个交付单元刚完成** ← **最优**。此刻你最清楚自己做了什么，写出来的交接失真最小
   （判据：有可判真假的验收／不依赖半成品／已落盘）
2. 例行**检查点**：完成一个可验证步骤就刷一次（约 0.2 秒，成本可忽略）
3. 上下文逼近上限／即将被压缩 ← **"不得不"，不是最优**（此时模型已进入退化区）
4. 被中断、限流、压缩失败等异常

**做一次交接**：

```bash
# 首次：建骨架，然后逐节填空
node <安装目录>/scripts/check_handoff.mjs init ./HANDOFF.md

# 之后：增量更新（只声明变化的 1–2 个节，其余逐字保留）
node <安装目录>/scripts/check_handoff.mjs next ./HANDOFF.md --payload p.json --archive-dir .handoff-archive

# 落盘前必须判绿（0=绿 / 2=判红 / 3=用法错 / 4=并发冲突）
node <安装目录>/scripts/check_handoff.mjs check ./HANDOFF.md
```

`--payload` 的完整形状见 `SKILL.md §2`。

---

## 目录结构

```
SKILL.md                     平台无关本体（模型读的规范）
templates/HANDOFF.md         交接物骨架（生成物，勿手改）
templates/OPENING_PROMPT.md  新会话开场指令（含"对方读不到本机文件"的自包含降级形态）
scripts/check_handoff.mjs    判据 CLI：init / check / compare / next / restore / measure
scripts/lib/handoff.mjs      纯函数库（字段真源 REQUIRED_ITEMS 在这里）
scripts/gen_template.mjs     从字段真源生成模板（--check 校验一致性）
scripts/measure_context.mjs  量化取数（含按窗口派生阈值）
scripts/tests/               自测
adapters/<平台>/             各平台部署与验证（平台差异只在这里）
references/triggers.md       触发场景全景（三条失效轴、21 个场景、检查点节奏）
references/platforms.md      平台能力矩阵
references/design-notes.md   设计依据、实测记录、已知限制
install.sh                   通用安装
```

---

## 已知限制（如实）

1. **只有 DSH / Claude Code 的适配做过真实取数验证**；Kimi、Codex、TRAE/扣子、WorkBuddy
   的 hooks 与自动触发**未在真机实测**（各 README 里逐条标注了"未实测"）。
2. **"无损"有边界**：能承诺"上一个检查点之前可无损接续"，**之后到中断之间可能丢失**。
   假死／被 kill／超时／崩溃在模型侧不可观测，谁也承诺不了"一定接得上"。
3. **判据只覆盖字段层**：`check` 能抓缺字段、空面、两处副本不一致、结构损坏；
   但它**抓不到跨节的事实矛盾**——那只有真正的独立读者（或下游返工）能发现。
4. **并发保护只能收窄窗口**：锁 + 写盘前内容比对挡住了绝大多数并发吞写，
   但一个**不遵守本技能锁**的外部写入者理论上仍可能在微秒级窗口挤进去。
5. **"下一单元探测"依赖模型的语义判断**，没有实测判准率 —— 这是当前最大的未知。

---

## 许可证

⚠️ **本仓库目前尚未附带 LICENSE 文件。** 对外分发前请先选定一个许可证
（如 MIT / Apache-2.0），否则别人在法律上没有使用许可。
选定后建议同时在 `SKILL.md` frontmatter 加 `license:` 字段（前端只允许
`name` / `description` / `license` / `compatibility` / `metadata` / `allowed-tools` 这六个键）。
