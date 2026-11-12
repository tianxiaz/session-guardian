# DSH 适配层（session-observer）

## 1. 安装

```bash
# 把技能装进 DSH skills 目录
cp -R session-observer ~/.dsh/skills/session-observer
# 依赖：context-handoff 必须已装（~/.dsh/skills/context-handoff/）
```

## 2. 常驻入口（AGENTS.md 追加）

把下面这段追加到 `~/.dsh/AGENTS.md`（或 `adapters/dsh/AGENTS.snippet.md` 的内容），
让每个会话自动带上观察协议：

```markdown
## 会话效能观察（常驻）

每个会话启用 session-observer 的观察纪律：
- 回复用户前，对照衰退特征清单（连续≥3次「继续」/一件就交卷/压缩后失忆/重复不升级/约束漂移）；
- 命中即停下 → 委托 context-handoff（trigger=degradation）写交接 → 提议切换会话 + 给开场指令；
- 用户说「观察」立即分析本会话是否该换；「观察帮助」查看配置。
```

> 注意：AGENTS.md 是全局规则、常驻占上下文，所以只放"入口"这一段（轻），
> 完整判据在技能本体里（按需加载）。别把整份 SKILL.md 塞进 AGENTS.md。

## 3. 定时器心跳（保险丝）

观察者激活后，用 `schedule_create` 建一个周期提醒，内容是"跑一遍衰退自检清单"：
- 频率建议：每 20–30 分钟，或每 10 轮。
- 这不是主触发，只是"模型退化到连自检都不做"时的兜底。

## 4. 硬档判据脚本

```bash
node <技能目录>/scripts/check_session.mjs <session.v4.jsonl.zstd> --threshold 3
```
输出 JSON：`degraded / consecutiveContinue / compactionCount / todoCount / models / verdict`。
脚本独立于 LLM 判断，可做"独立观察者"的 DSH 侧替代。
