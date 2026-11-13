# HANDOFF（上下文交接物）

> 本文件由 `context-handoff` 技能维护。**节名、子项名、顺序固定**，任何改动都要过
> `node <技能目录>/scripts/check_handoff.mjs check <本文件>`。
>
> 这个文件是**生成物**（`scripts/gen_template.mjs`）—— 想改字段，改 `scripts/lib/handoff.mjs`
> 的 `REQUIRED_ITEMS` 再重新生成，不要直接手改本文件（手改必然与判据漂移）。
>
> 每个节开头有一行 `HANDOFF:CONTENT` 注释，是「尚未填写」的标记：
> **填完一节就删掉该节的这一行注释**；保留它代表没填，`check` 会判红。
> 确实没有内容的子项写「无」（显式否定合法）；不确定的写「未复核」＋复核方法。
>
> `provenance`（交接头，文件开头那段键值对）的语义 —— 常被读错，故明写：
> **它描述的是「这份交接物」，不是「整个项目」**。
> - `round` = **这份交接物自己被更新了几版**（首版 1；每做一次增量交接 +1），与项目进度无关
> - `status` = **交接物是否可交付**：draft 未定稿 / complete 可交给下一个人 / blocked 被阻塞；
>   它**不表示**整个项目完没完（项目进度看 `status` 节的已完成/进行中）
> - `occupancy` = **写这份交接物那一刻**的上下文占用；占用低也完全可以做交接（例如用户明示、阶段收尾）
> - `trigger` = user-request | phase-complete | checkpoint | context-pressure | external-threshold | pre-compact | post-compact | degradation | model-switch | interruption | error-recovery | compaction-failed | round-limit | budget-quota | peer-request | device-switch | self-estimate
> - `supersedes` = none，或 `round-<正整数>@<8..64 位十六进制>`
> - `updated_utc` = 真实存在的 UTC 时刻（YYYYMMDDTHHMMZ，脚本会做日历校验）

<!-- handoff:provenance -->
version: 1
round: 1
updated_utc:             # 真实存在的 UTC 时刻，形如 20261016T1530Z（脚本会做日历校验）
workspace:               # 工作区**绝对路径**
trigger:                 # user-request | phase-complete | checkpoint | context-pressure | external-threshold | pre-compact | post-compact | degradation | model-switch | interruption | error-recovery | compaction-failed | round-limit | budget-quota | peer-request | device-switch | self-estimate
occupancy:               # 0–1 的小数，或 unavailable（取不到就写 unavailable，不许编）
occupancy_source:        # 形如 <平台>:<测量源>；取不到写 unavailable
supersedes:              # none，或 round-<正整数>@<8..64 位十六进制>
status:                  # draft | complete | blocked
<!-- /handoff:provenance -->

<!-- handoff:section id=goal -->
<!-- 目标与验收。验收必须是**可判真假**的句子（"做好了"不算）。 -->
<!-- HANDOFF:CONTENT -->
- 目标：
- 验收：
<!-- /handoff:section -->

<!-- handoff:section id=status -->
<!-- 当前状态。**下列各项都要有内容**：确实没有就写「无」。 -->
<!-- HANDOFF:CONTENT -->
- 已完成：
- 进行中：
- 阻塞：
- 待办：
- 下一步：
- 验证：
- 恢复检查点：
<!-- /handoff:section -->

<!-- handoff:section id=decisions -->
<!-- 关键决定与理由。`已否决` 写被否掉的方案＋原因；`尝试过` 写试过什么、为什么不行。 -->
<!-- HANDOFF:CONTENT -->
- 决定：
- 理由：
- 已否决：
- 尝试过：
<!-- /handoff:section -->

<!-- handoff:section id=todo -->
<!-- 待办清单。与 `status.待办` **逐字节相同**（工具会逐字节比对，不一致判红）。 -->
<!-- HANDOFF:CONTENT -->
- 待办：
<!-- /handoff:section -->

<!-- handoff:section id=boundaries -->
<!-- 边界与禁区。`禁止` 至少一条且要**具体到文件/操作**，不要写"注意安全"。 -->
<!-- HANDOFF:CONTENT -->
- 可改：
- 禁止：
- 归属未定：
<!-- /handoff:section -->

<!-- handoff:section id=environment -->
<!-- 约束与环境事实。`命令` 必须是**真跑过**的验证命令；`依赖状态` 写外部依赖现在能不能用。 -->
<!-- HANDOFF:CONTENT -->
- 路径：
- 服务：
- 命令：
- 依赖状态：
- 定时提醒：
<!-- /handoff:section -->

<!-- handoff:section id=evidence -->
<!-- 证据入口。提交写真实哈希；文件写相对路径（必要时附 `:行号`）；数字写实测值。 -->
<!-- HANDOFF:CONTENT -->
- 提交：
- 文件：
- 实测数字：
<!-- /handoff:section -->

<!-- handoff:section id=open_questions -->
<!-- 待用户/他人裁决的问题。 -->
<!-- HANDOFF:CONTENT -->
- 待裁决：
<!-- /handoff:section -->
