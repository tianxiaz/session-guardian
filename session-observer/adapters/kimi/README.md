# Kimi 适配层（session-observer）

## 1. 安装技能

Kimi 支持 skills 目录（`~/.kimi-code/skills/`；跨工具共享 `~/.agents/skills/`）：

```bash
cp -R session-observer ~/.kimi-code/skills/session-observer
# 依赖：context-handoff 也要装到同目录
```

## 2. 一句话启用（软档）

在现有 Kimi 会话里说「**观察**」即可启用（技能被加载后，按 SKILL.md 每轮自检 + 自报能力卡）。

## 3. 定时器（保险丝，软档）

Kimi 有产品级「定时任务」（用户手动设置），也有 API「托管智能体 → 定时运行智能体(triggers)」。
- 手动：在 Kimi 的定时任务里，设置一条周期提醒，内容是"跑一遍 session-observer 的衰退自检"。
- **程序化（需实测）**：模型是否能在对话内替用户建定时任务，本技能**未证实**，交付时标"需实测"。

## 4. 软档限制（诚实声明）

- Kimi 拿不到本机 DSH 会话日志，`check_session.mjs` 的确定性判据**在 Kimi 上不可用**；
- 判断退化为"模型对照特征清单自觉"，存在"衰退中的模型自查衰退"的循环风险；
- 交接物按 context-handoff 的「自包含形态」粘贴（Kimi 网页端可能读不到你的本机文件）。
