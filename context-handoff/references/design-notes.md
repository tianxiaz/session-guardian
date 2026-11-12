# 设计依据、实测记录与已知限制

## 1. 为什么需要这个技能（有实测的事故，不是假想需求）

本项目已发生三次因"上下文触限后模型记忆失真"导致的误判：

1. 把「子代理根本没执行（停在 `[ready]`）」误判为「卡住」；
2. 把公开数据包读成"0 条"（实际 10 条，是读错了结构）；
3. 把他人未提交的在建工作当成自己的批次来处置的**风险**（已识别、未发生）。

⇒ 结论：缺的不是"更大的上下文"，而是**把接续必需的事实从对话记忆搬到可复核的文件**。

## 2. 四条设计主张及依据

| # | 主张 | 依据 |
|---|---|---|
| 1 | **触发不得只靠模型自估** | 本会话实测多次"感觉还剩一点"后立刻触限。测量值可证伪自估：见 §3 的实测数字 |
| 2 | **首轮与后续必须是两种动作** | 每次触发重写全文 ⇒ 表述漂移、细节丢失。故 `next` 采用**声明式合并**，未声明变化的节根本不经过重写路径 |
| 3 | **"无损"必须可核验** | 由第三方（新会话/评审）仅凭 `HANDOFF.md` 答**五问**（目标／下一步／禁区／验证命令／**基线与仓库是否一致**），缺项判红 |
| 4 | **"自动开新会话"是平台能力函数** | 调研四路结论：唯一被官方证实"自动建独立 Session"的是 WorkBuddy **企业云侧**自动化任务；其余平台一律降级 |

## 3. 量化：本技能真正读到的数（不是估的）

DSH 把 `contextPressure` 投影落在
`$DSH_HOME/storages/session_projcache/sessions/<session-id>.json` 的
`record.rows.contextPressure.val`，字段为 `surfaceTokens` / `pressureTokens` / `contextWindow` /
`sampledSurfaceTokens`。`scripts/measure_context.mjs` 直接读它。

作者本机实测**某时刻快照**（2026-10-16，一个真实工程工作区）。

> ⚠️ **下面是"抓取那一刻"的样本，不是常量**。同一工作区在不同时刻实测差别很大
> （后续实测举例：`occupancy 0.2593`、`surfaceTokens 202972`、`pressureTokens 259345`、`seq 1215`）。
> 只有 `seq` / `evidence_file` 是可核对的锚点；**把下面的数字写进断言或文档当常量是错的**
> （第 1 轮就踩过：文档写 `occupancy 0.0633 / seq 227`，复跑已是 `0.2402 / seq 1027`）。

```
$ node scripts/check_handoff.mjs measure --workspace "/path/to/your/project" --json
{
  "ok": true,
  "occupancy": 0.0633,
  "source": "dsh:contextPressure",
  "raw": { "surfaceTokens": 32678, "pressureTokens": 63348, "contextWindow": 1000000, "seq": 227 }
}
```

（`seq` 227 是**抓取那一刻**的投影序号；同一工作区后续实测已到四位数量级，数值也不同。）

分子取**单字段**，按 `projectedTokens → pressureTokens → surfaceTokens` 的优先级选第一个可用者；
分母取 `contextWindow`。
**为什么不用 `max(surface, pressure)`**：DSH 官方明说这些字段"不是同一次请求的原子观测"（各自 last-wins、
可能配错路由），用 `max` 合成一个数会掩盖取的是哪个时刻、哪条路由的值。
**与 DSH GUI 的关系**：GUI 的占用是 `projectedTokens ?? pressureTokens`，缺一即不显示（`return null`）。
本技能**在 projectedTokens 有值时与 GUI 等价**；差异有二，都是**有意选择**：
① `surfaceTokens > pressureTokens` 且无 projected 时，本技能退回 `surfaceTokens` 给一个参考值
（GUI 会不显示）；② 缺分母时本技能返回 `unavailable` 而非 0。
**这是参考值不是账单**：DSH 官方自己说明该投影是"用户可见的参考值，不是计费或门控输入"，
且 CJK 文本与 JSON schema 在 4 字符/token 的启发式下会被低估。
所以阈值只能当**预警**用，不能当硬门。阈值**按窗口解析**（见下），不是固定值。

**阈值必须按窗口解析**（详见 `docs/73 §5`）：DSH 自动压缩的默认触发点是
`floor(min(W × 0.8, W − O − 65536))`，`min` 会把实际触发比例压到 0.8 以下 ——
W=1e6 ⇒ 0.8000；W=262144 ⇒ 0.5000；W=200000 ⇒ 0.3446；W=131072 ⇒ **0**。
所以 `deriveThresholds(W)` 取 **预警线 = 触发比例 − 0.05（下限 0.4）**、**硬线 = 触发比例**；
触发点为 0 时硬线返回 `null`（`hardEffective:false`），否则 `occ >= 0` 会恒真。
**第 1 轮文档曾写"预警线取 0.8 ⇒ 留出约 8% 窗口"，那是错的**，只在 W=1e6 近似成立。

## 4. 为什么判据是"结构性"而不是"靠自觉"

"未变项逐字保留"如果只是一句要求，模型一定会违反（重写一遍比逐节拼接省事）。
所以本技能把它变成**工具结构**：

- `next <prev> --payload <p.json>`：未在 `payload.changed` 里的节**根本不经过重写路径** ——
  实现上是从 `prev` 原文里按哨兵切片原样搬过来（`lib/handoff.mjs` 的 `mergeHandoff`）。
- `check --against <prev> --changed a,b`：两份文件比对，**实测变化集合必须恰好等于声明集合**，
  多一个报 `E_UNDECLARED_CHANGE`，少一个报 `E_DECLARED_BUT_IDENTICAL`。
- `mergeHandoff` 对"提供了未声明变化的节"直接抛错，堵死"偷偷改一节"。

## 4.1 并发写入：两道闸与它们的残余窗口（如实记录）

写盘路径现在有两道并发保护，**都只能收窄窗口、不能消除**：

1. **mtime 闸**：读入时记下 mtime，写盘前比较；不一致 ⇒ exit 4。
2. **rename 前的内容闸**：`atomicWrite(..., { expectContent })` 在 `rename` **之前最后一刻**
   重读目标并与"我们读到的内容"逐字节比对；不一致 ⇒ `CONCURRENT_MODIFICATION` ⇒ exit 4。

**为什么需要第二道**：R3-A 独立评审实测出一处真实吞写——交接物 20MB 时，
`next` 读入 →（这段写盘耗时里）外部追加内容 → 我们 rename 覆盖 ⇒ **外部内容消失且 exit 0**。
mtime 闸只在"读入后立刻"比较一次，覆盖不了整段写盘耗时。加了内容闸后，该用例的 30/80/200ms 三档
外部写入全部能被检出。

**残余窗口（不许说成"已解决"）**：
- 内容闸的 read 与 `rename` 之间仍有**极小**窗口（微秒级）。一个**不遵守本技能锁**的外部写入者
  理论上仍可能挤进去。彻底消除需要外部协调（同一个锁），而外部写入者不会配合。
- 锁文件只约束**本技能的调用方**；编辑器、`git checkout`、别的工具都不受它约束。
- ⇒ 承诺只能是"**我们不会主动吞掉检测到的并发改动**"，不能是"绝不可能丢"。

**顺带修的第三处**：幂等放行（noop）分支**同样在写盘**，此前漏了内容闸——
即 payload 与现状相同时那条路径。R3-A 的 80ms 用例正是打在这里。

---

## 5. 已知限制（如实列出）

1. **DSH 没有压缩前钩子**：hooks 桥只支持 7 个事件（SessionStart / UserPromptSubmit / PreToolUse /
   PostToolUse / Stop / SubagentStart / SubagentStop），**不含 PreCompact/PostCompact**；
   且 `transcript_path` 恒为 `''`（会话日志是 zstd，hook 脚本读不到）。
   ⇒ DSH 侧只能"提前阈值触发"，不能"压缩前抢救"。
2. **本技能读不到会话内的占用值**：`ctx.tokenMeter` 不注册任何模型可见面，DSH 也没有 `/context`
   命令。所以只能在**会话外**读投影缓存（本技能 `measure` 的做法），或由用户看 GUI 的占用指示。
3. **`updated_utc` 不由工具猜**：为了幂等，内容未变时沿用上一版；内容变了但调用方没给
   `updated_utc`，工具会**警告**而不是替时钟撒谎。
4. **平台适配层大多未实测**：本机只有 DSH 装了，Claude Code / Codex / Kimi / TRAE / 扣子 /
   WorkBuddy 的适配片段来自官方文档，**在本机无法运行验证**。`adapters/*/README.md` 里
   每条都标了"已证实（有一手来源）/ 未实测"。
5. **豆包 App 一无所获**：无官方文档站，技能文件格式/安装路径/自动加载机制全部未找到一手来源。
   故 `adapters/kimi-doubao/` 里只覆盖 Kimi，豆包部分是明确的能力空缺说明。
6. **没有去重/冲突合并**：两个会话同时交接时，后者靠 `--expect-mtime` 或锁文件撞冲突（exit 4）后
   人工处理，本技能不做自动三方合并。
7. **跨节的"事实矛盾"无法机械校验**（UAT 实测暴露）：UAT 里的独立新会话读出了交接物**内部**的
   四处矛盾 —— 同一数字在两节不一致（工作树 `185` vs `187`）、同一矛盾主张（"他人未建"vs"归属未定"）。
   `check` 只能校验**字段层**（存在性、非空面、`todo↔status.待办` 逐字节一致），
   **校验不了"这句话是否与另一节说的是同一件事"**。⇒ 这是本技能的**真实能力边界**，
   靠"新会话真读一遍"的 UAT 兜住，不靠脚本。
8. **归档名是内容寻址而非时间戳**（`round-<N>@<指纹>.md`），刻意不用 UTC 时间戳：
   时间戳会让"同一状态重放"产出新文件名 ⇒ 破坏幂等。代价是归档目录不如按时间排序直观，
   需要"什么时候交接的"看 `updated_utc` 字段。

## 6. 判据清单（与自测一一对应）

| 判据 | 实现处 | 自测 |
|---|---|---|
| 字段完整性（节名/顺序/必含子项/provenance 必填键） | `validateHandoff` | `handoff.check.test.mjs` |
| 空面判红（空节、空子项、占位符、空文件） | `validateHandoff` + `isBlankValue` | `handoff.check.test.mjs` |
| 幂等（未变项逐字节保留） | `mergeHandoff` + `next` 幂等收口 | `handoff.idempotency.test.mjs` |
| 变异能红（真实文件上改一处必须判红） | CLI 端到端 | `handoff.mutation.test.mjs` |
| 并发冲突不覆盖 | `--expect-mtime` → exit 4 | `handoff.mutation.test.mjs` |
| 量化取数（取不到必须如实 unavailable） | `measure_context.mjs` | `handoff.mutation.test.mjs` |

跑法：`node --test "scripts/tests/*.test.mjs"`（本机 84 项通过；另有 1 项「需本仓 docs/73」的检查在独立分发目录下自动跳过）。
