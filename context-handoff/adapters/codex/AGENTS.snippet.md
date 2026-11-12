# Codex 规则片段（追加到 ~/.codex/AGENTS.md 末尾）

> 依据：`~/.codex/AGENTS.md` 用户级文件存在且有优先级（`~/.codex/AGENTS.override.md` 更高，
> 若同时存在则 `AGENTS.md` 被忽略）；项目级 `AGENTS.md` 从项目根向下逐层拼接。
> 预算 `project_doc_max_bytes = 32768` —— 片段要短，别把整个技能塞进来。
> 来源：`docs/_evidence/批L-上下文交接技能/调研-codex-agents-md.md`（源码为证）。

---

## 上下文交接（常驻约定，短）

- 长任务里，上下文接近上限前必须做一次**可核验的交接**，不要靠"感觉还剩一点"。
- 交接物是工作区里的 `HANDOFF.md`（字段固定：目标与验收／当前状态／关键决定与理由／
  未完成项与下一步／边界与禁区／环境事实／证据入口／待裁决）。
- 首次＝建立；第二次起＝**增量更新**：只改真正变化的节，**未变项逐字保留**，不许重写全文。
- 判据（技能自带，用绝对路径调用）：
  ```bash
  node "<技能目录>/scripts/check_handoff.mjs" check ./HANDOFF.md
  ```
  **退出码非 0 就不许宣布交接完成。**
- 没有证据来源的事实不写进交接物；写"未验证"也不算丢人，编一句看着合理的才是错的。
- 禁区的写法必须具体（"不要动 `web/src` 下他人未提交的在建文件"），不要写"注意安全"。

触发提示：
- **主触发点＝`PreCompact`**（Codex 的 12 类 hook 事件之一）：压缩即将发生时去跑上面的流程。
- `Stop` 只作**次要**触发：在 DSH 的 Codex 钩子桥里官方记载 `stop_hook_active` 恒 `false`、
  `last_assistant_message` 恒 `null`（Codex 原生是否如此未证实）⇒ 别把 `Stop` 当唯一依赖。
- 用户说"交接/handoff/换会话"时立即跑。

> 把 `<技能目录>` 换成你机器上的实际技能目录（例如 `~/.dsh/skills/context-handoff`）。
