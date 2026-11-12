# [Idea] 现象触发的会话可观测原语：让会话能按"特征"而非"定时器"触发自检与交接

---

## 背景与问题

在长会话里，模型会出现一种**效能衰退**：干了一点就停下来、把控制权交回用户，即便用户反复说"继续做完再停"。模型自身往往**看不见自己在衰退**——它越衰退，越无法自判衰退。

一个真实案例（本机 DSH 会话，会话标题「抓题更新」）：

- 378 轮对话，模型是 `deepseek-flash`；
- 用户说了**几十次"继续"**（第 189–197 轮连续 6 次"继续"，第 245–287 轮约 20 次"继续/继续下一步"）；
- 上下文被压缩 **6 次**（第 29/70/129/179/235/315 轮），每次约 30 万 token；
- 模型每轮只完成一个子项就交卷，思考痕迹里出现"turn is long; report partial and stop"。

这不是偶发：**「任务进度只存在于上下文中，而上下文被反复压缩抹掉」，是长程 agentic 任务的系统性失效模式。**

## 诉求：补一个"现象触发"的观测原语

当前 DSH 的 `schedule` 只有**时间类**触发器（after/every/daily/weekly/cron），没有**现象/事件类**触发器。这使得"观察会话是否衰退"只能靠定时器心跳，或靠模型自检（循环，衰退中的模型查不出自己衰退）。

希望增加一种能力，让会话在**特定特征出现时**（而非定时器到点时）被触发，特征例如：

1. 用户连续 ≥N 次输入"继续/继续下一步"这类纯催促词；
2. 一轮只完成一个子项就返回（"一件就交卷"）；
3. 上下文发生压缩（compaction）后模型重做已完成项 / 漏掉剩余清单；
4. 同一手段连续失败多次仍在重试（loop capture）；
5. 模型产出开始越过既定约束（约束漂移）。

## 期望的最小能力（任一皆可，从易到难）

- **A（最容易落地）**：把会话日志（现为 zstd，`transcript_path` 恒为空）暴露给 hook 脚本，让脚本能读到"继续"次数、压缩次数、模型选择等，做确定性检测。
- **B**：hook 桥补事件（至少 `PreCompact`/`PostCompact`，现状只有 7 个事件、无压缩事件），让脚本能在压缩前后触发。
- **C**：一个正式的"现象触发 watcher"原语（类似 schedule，但触发条件是特征匹配而非时间）。

## 为什么值得做

- 长会话的"可观测性"目前是空白：模型不知道自己在衰退，用户只能靠人肉"继续"按钮当外置记分板。
- 这直接关系到**低成本模型跑长程任务**的可行性——把状态外置、在衰退时切换会话，是小模型做长任务的唯一可靠杠杆。
- A、B 两项相对好落地（补 hook 事件 + 暴露日志），可作为第一阶段。

## 现有绕过与局限

当前只能：定时器心跳（`schedule`）+ 模型自检。前者触发条件与现象无关，后者观察者与被观察者同一（循环）。都不是真正的"现象触发、独立观察"。

---

（附：英文摘要）
### Summary

Long sessions exhibit an "efficacy decay": the model does a little then hands control back, even when told to finish, and cannot reliably self-detect its own degradation (the degraded model is also the observer). Currently `schedule` only has time-based triggers and hooks cannot read the zstd session log (`transcript_path` is empty). We request a phenomenon/event-triggered observability primitive — minimally: expose the session log to hooks, add `PreCompact`/`PostCompact` hook events, and ideally a feature-matched "watcher" trigger — so sessions can hand off on a detected decay signature rather than on a timer.
