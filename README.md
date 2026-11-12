# session-guardian · 会话守护者

> 长会话里，模型会「干一点就停、交卷特别早」，而它自己往往看不见自己在衰退。
> session-guardian 在**衰退特征出现时**（不是靠定时器猜）触发一次「交接」，把任务状态无损搬到下一个干净会话——**让便宜模型也能跑长程任务**。

## 它解决什么问题

一个真实案例（本机 DeepSeek 会话「抓题更新」）：

- 378 轮对话、上下文被压缩 **6 次**（每轮压掉约 30 万 token）；
- 用户说了几十次「继续」——第 189–197 轮**连续 6 次**，第 245–287 轮约 20 次；
- 模型每轮只完成一个子项就交卷，思考里出现 *"turn is long; report partial and stop"*。

这不是偶发。**任务进度只存在于上下文中，而上下文被反复压缩抹掉**——这是长程 agentic 任务的系统性失效模式。

起因是一篇论文：《Is Your Robot's Memory Just a Clock?》（[arXiv:2611.14488](https://arxiv.org/abs/2611.14488)）发现：按时间均匀采样的机器人记忆，会把"暂停/空动作"当成"已完成的工作"，导致策略提前收手。这个机制迁移到 LLM 会话里，就是上面的"效能衰退"。

## 怎么工作

> observer 判断「该不该换」，handoff 负责「怎么无损换」。

1. **观察**：每个回复前对照衰退特征清单（连续≥3次「继续」/ 一件就交卷 / 压缩后失忆 / 重复不升级 / 约束漂移）。
2. **触发**：命中即停下——靠现象本身触发，不靠定时器猜。
3. **交接**：委托 context-handoff 写 `HANDOFF.md`（**从当前真实状态重新生成，永不复用旧文件**）+ 出新会话开场指令。
4. **切换**：提议换会话（不自动中止、不阻塞），给出新会话第一句话。

## 两个技能（可合可拆）

| 技能 | 职责 | 独立使用的局限 |
|---|---|---|
| `session-observer` | 观察 + 触发：衰退清单、阈值、心跳、一句话诊断 | 只观察不执行，不完整 |
| `context-handoff` | 交接：HANDOFF.md 格式、判绿脚本、开场指令 | 需用户理解并主动唤起，不方便 |

**两者合起来才是完整的「会话质量管理」解决方案**；分开也能各自独立使用。欢迎提 issue、贡献想法一起完善。

## 快速开始

```bash
git clone <本仓库>
cd session-guardian
./install.sh dsh            # 装两个技能；observer/handoff 只装其一；--force 覆盖更新
```

三句话使用（跨平台一致）：

- 说「**观察**」→ 立即分析当前会话是否该换；
- 说「**该换会话吗**」→ 出切换建议 + 新会话开场指令；
- 说「**观察帮助**」→ 看全部命令；说「**阈值：连续2次**」可改阈值。

## 三平台能力

| 能力 | DSH | Kimi | 豆包 |
|---|---|---|---|
| 技能载体 | ✅ | ✅ | ✅（豆包工作） |
| 模型程序化建定时器 | ✅ schedule | ⚠️ 需实测 | ⚠️ 需实测 |
| 读会话日志（确定性判据） | ✅ | ⚠️ 需实测 | ❌ |

- **DSH＝硬档**：`check_session.mjs` 扫日志做确定性判据（独立于 LLM 判断）。
- **Kimi/豆包＝软档**：模型对照特征清单自觉（存在"衰退模型自查衰退"的循环风险，诚实声明）。

## 目录结构

```
session-guardian/               # 仓库根
├── session-observer/           # 技能1：观察 + 触发
│   ├── SKILL.md
│   ├── references/{degradation,platforms}.md
│   ├── scripts/check_session.mjs   # DSH 硬档判据
│   ├── templates/capability-card.md
│   └── adapters/{dsh,kimi,doubao}/
├── context-handoff/            # 技能2：交接（HANDOFF.md）
├── docs/{design,issue-draft}.md
├── install.sh                  # 一键装两个技能（检测/复用/选择性）
├── INSTALL.md
└── LICENSE
```

## 文档

- 设计文档：[docs/design.md](docs/design.md)
- 安装手册：[INSTALL.md](INSTALL.md)
- deepseek-harness issue 草稿：[docs/issue-draft.md](docs/issue-draft.md)

## 许可证

MIT（见 [LICENSE](LICENSE)）。
