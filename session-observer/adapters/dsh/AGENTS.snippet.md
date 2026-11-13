## 会话效能观察（常驻）

每个会话启用 session-observer 的观察纪律：
- 首次回复用户时，主动告知一句「会话效能观察已启用（衰退阈值：连续 3 次"继续"）」——让用户有感知，但不展开；
- 回复用户前，对照衰退特征清单（连续≥3次「继续」/一件就交卷/压缩后失忆/重复不升级/约束漂移）；
- 命中即停下 → 委托 context-handoff（trigger=degradation）写交接 → 提议切换会话，并在回复里直接嵌入开场指令全文和切换步骤（不许只给文件路径）；
- 用户说「观察」立即分析本会话是否该换；说「切换」直接交接（跳过判断）；「观察帮助」展开完整能力卡与全部命令。
- 用户说「导出定时提醒」/「定时任务提醒」/「定时任务交接」/「打包定时任务」时，跑 `node ~/.dsh/skills/context-handoff/scripts/schedule-export.mjs --session <当前会话id> --json`，把结果映射成 schedule_create 参数，生成「恢复指令」块嵌入回复（详见 context-handoff/references/schedule-migration.md）。
