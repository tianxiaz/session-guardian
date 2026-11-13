# 定时提醒的交接（自然语言触发）

> 用途：会话切换/归档前，把当前会话挂着的定时提醒/定时任务**读出来 → 生成恢复指令 → 在新会话重建**。
> 触发词：用户说「**导出定时提醒**」「**定时任务交接**」「**打包定时任务**」「**定时任务迁移**」。

---

## 第 1 步：旧会话里导出 + 生成"恢复指令"

1. 取当前会话 id（会话路径 `~/.dsh/sessions/<项目>/<会话id>/` 里的那段，或从环境变量/上下文取）。
2. 跑导出（只读，安全）：

```bash
node <技能目录>/scripts/schedule-export.mjs --session <当前会话id> --json
```

3. 把导出结果**映射成 `schedule_create` 的参数**，生成下面这个「恢复指令」块，**整段嵌在回复里**给用户：

````markdown
【定时任务交接 · 在新会话贴这段】

请用 `schedule_create` 逐条重建下面的定时提醒（一条一条建）：

```json
[
  {"title": "…", "prompt": "…", "cron": {"expression": "10 15 * * 5", "time_zone": "Asia/Shanghai"}},
  {"title": "…", "prompt": "…", "weekly": {"time": "09:00:00", "time_zone": "Asia/Shanghai", "weekdays": [1]}},
  {"title": "…", "prompt": "…", "at": {"date": "2026-11-20", "time": "15:10:00", "time_zone": "Asia/Shanghai"}}
]
```

建完逐条确认（ID + 下次触发时间）。
````

**kind → schedule_create 参数映射**：

| export 里的 kind | schedule_create 参数 |
|---|---|
| `cron` | `cron: {expression, time_zone}` |
| `weekly` | `weekly: {time, time_zone, weekdays}` |
| `daily` | `daily: {time, time_zone}` |
| `at` | `at: {date, time, time_zone}` |
| `after` | `after_seconds`（或换算成 at） |
| `every` | `every_seconds` |

> `at`/`after` 这类一次性任务，如果时间已过，恢复时要提醒用户"这条已过期，要不要改时间"。

## 第 2 步：新会话里恢复

用户把上面那个块贴进新会话 → agent **逐条调用 `schedule_create`** → 建完逐条确认（ID + 下次触发时间）。

## 为什么不让脚本直接写存储

直接写 `~/.dsh/storages/schedule.json` 可能被 DSH 的内存态覆盖；`schedule_create` 是官方路径，稳。
（`scripts/schedule-import.mjs` 只是实验性兜底，优先走本流程。）

## 和 HANDOFF 的关系

- `HANDOFF.md` 的 `environment.定时提醒` 子项要求**交接时把这些列出来**（防漏）；
- 本流程负责**具体怎么迁**（导出 → 恢复指令 → 重建）。
