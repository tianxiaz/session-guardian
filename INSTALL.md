# session-guardian 安装手册

session-guardian 由两个技能组成：`session-observer`（观察+触发）+ `context-handoff`（交接）。
`install.sh` 默认**两个都装**，且会检测已有、不重复装、`--force` 才覆盖更新。

---

## 1. DSH（DeepSeek Harness）

### 1.1 一键装两个技能

```bash
cd session-guardian           # 仓库根目录
./install.sh dsh
# 默认装两个：session-observer + context-handoff
# 只装一个：./install.sh dsh observer   或   ./install.sh dsh handoff
# 覆盖更新：./install.sh dsh --force
```

本机已装过 context-handoff 时，会显示「已存在…跳过不覆盖」，只新增 observer。

### 1.2 常驻入口（可选但推荐）

把 `session-observer/adapters/dsh/AGENTS.snippet.md` 的内容**追加**到 `~/.dsh/AGENTS.md` 末尾，
让每个新会话自动带上观察协议。

> 只追加那一段"入口"，别把整份 SKILL.md 塞进 AGENTS.md（AGENTS.md 常驻占上下文）。

### 1.3 验证

```bash
# ① 确定性判据（拿任一真实会话日志测）
node ~/.dsh/skills/session-observer/scripts/check_session.mjs \
  ~/.dsh/sessions/<项目>/<会话id>/session.v4.jsonl.zstd --threshold 3
# 期望输出 JSON：degraded / consecutiveContinue / compactionCount / todoCount / models / verdict

# ② 一句话诊断（在任意 DSH 会话里发）
观察
# 期望：输出「能力卡」，并分析当前会话是否该换
```

---

## 2. Kimi

```bash
./install.sh kimi
# 两个技能装到 ~/.kimi-code/skills/
```

- 启用：会话里说「**观察**」。
- 定时器：软档，产品级「定时任务」手动设置，或 API「托管智能体→triggers」（程序化建**需实测**）。
- 注意：Kimi 读不到本机 DSH 会话日志，`check_session.mjs` 不可用；交接物用「自包含形态」粘贴。

---

## 3. 豆包

豆包是云端技能，无本地 skills 目录。按 `session-observer/adapters/doubao/README.md` 在「豆包工作 → 技能」上传安装。

- 启用：会话里说「**观察**」，或把能力卡贴进系统提示。
- 定时器：软档，「定时任务」页手动（程序化建**需实测**）。
- 交接物用「自包含形态」粘贴。

---

## 4. Codex

```bash
./install.sh codex        # 装两个技能到 ~/.codex/skills/
```

- 规则：把 `session-observer/adapters/codex/rules.snippet.md` + `context-handoff/adapters/codex/rules.snippet.md` 追加到 `~/.codex/rules/default.rules`（**不是 AGENTS.md**）。
- 自动发现，无需 config.toml 的 `[skills]` 段。
- **技术小白 / GitHub 被挡**：用离线包 `session-guardian-codex.zip`（双击 `install.command`，不联网、不经 Codex 沙箱）。详见 `session-observer/adapters/codex/README.md`。
- 验证：会话里说「**观察**」→ 应回能力卡。

---

## 5. 卸载

```bash
rm -rf ~/.dsh/skills/session-observer
rm -rf ~/.kimi-code/skills/session-observer
# context-handoff 若也是本仓库装的：rm -rf ~/.dsh/skills/context-handoff
```

---

## 6. 常见问题

| 问题 | 处理 |
|---|---|
| 「已存在…跳过不覆盖」 | 用 `--force` 覆盖/更新 |
| 阈值怎么改 | 会话里说「**阈值：连续 2 次**」（本会话生效，跨平台通用） |
| 想看全部命令 | 说「**观察帮助**」 |
| Kimi/豆包能否程序化建定时器 | 标「需实测」，见对应 adapters 的 README |
| 交接物显示"过期" | observer 在切换前**重新生成**，不复用旧文件；恢复侧核对 `git rev-parse HEAD` 与 `status.恢复检查点` |
| **旧会话里说「观察」没反应/报错** | 旧会话是安装前开的，**没加载技能**（会话级快照，装完不会回灌）。**开新会话**才认；旧会话只能用手动交接：`context-handoff/templates/fallback-handoff-prompt.md` |
