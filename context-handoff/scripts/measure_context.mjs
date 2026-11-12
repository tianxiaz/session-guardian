#!/usr/bin/env node
/**
 * context-handoff · 量化上下文占用（平台探测）
 *
 * 设计原则：**取不到就说取不到**。绝不返回估算出来的假数字。
 * 每个探测器的返回都带 source 与 raw，供交接物 provenance 如实记录。
 *
 * 已知可用的一手来源（见 references/platforms.md 与 docs/_evidence/批L-上下文交接技能/ 下的调研文件）：
 *   dsh:contextPressure  DSH 把 `contextPressure` 投影落在
 *                        $DSH_HOME/storages/session_projcache/sessions/<session-id>.json
 *                        的 record.rows.contextPressure.val 里（字段：surfaceTokens / pressureTokens /
 *                        contextWindow / sampledSurfaceTokens）。这是**真实测量值**，不是模型自估。
 *   kimi:usage           Kimi TUI `/usage` 显示"上下文占用"；CLI 可按会话取 usage.context_tokens。
 *                        本脚本不直连其存储（格式未证实），只接受由适配层通过 --override 传入。
 *   codex:usage          Codex 有 percent_of_context_window_remaining，但对外字段名未证实，
 *                        同样只接受 --override。
 *
 * 用法（作为库）：import { measureContext } from './measure_context.mjs'
 * 用法（作为命令）：node check_handoff.mjs measure --json
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function unavailable(reason, extra = {}) {
  // 形状必须与成功分支一致（都带 thresholds/crossed），否则调用方读 result.thresholds
  // 会在"取不到占用"时 TypeError（E4 复评 R7）。
  return {
    ok: false,
    occupancy: null,
    source: 'unavailable',
    thresholds: null,
    crossed: { warn: null, hard: null },
    reason,
    ...extra,
  };
}

/** DSH：读 session projection cache。 */
export function measureDsh({ workspace, sessionId } = {}) {
  // 未显式指定会话时，优先用 DSH 注入的当前会话 id。
  // 不这样做会**挑错会话**：同工作区里子代理的投影也是候选，且它们的 createdAt 更新，
  // 于是"按 createdAt 取最新"会选到子代理 → 严重**低估**本会话占用
  // （实测：本会话 0.6735，不加 --session 却报 0.0411，低估 16 倍）。
  // 低估方向的错误最危险——该交接时不交接。
  const effSession = sessionId || process.env.DSH_SESSION_ID || '';
  const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions');
  if (!existsSync(dir)) {
    return unavailable(`DSH 投影缓存目录不存在：${dir}`);
  }
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return unavailable(`无法读取 DSH 投影缓存目录：${e.message}`);
  }
  if (effSession) {
    const exact = `${effSession}.json`;
    files = files.includes(exact) ? [exact] : files.filter((f) => f.includes(effSession));
    if (files.length === 0) return unavailable(`DSH 投影缓存里找不到会话 ${effSession}`);
  }

  const wantCwd = workspace ? resolve(workspace) : null;
  const candidates = [];
  for (const f of files) {
    const p = join(dir, f);
    try {
      const rec = JSON.parse(readFileSync(p, 'utf8'));
      const identity = rec?.record?.identity;
      if (!identity) continue;
      if (wantCwd && resolve(identity.cwd || '') !== wantCwd) continue;
      const row = rec?.record?.rows?.contextPressure;
      const val = row?.val;
      if (!val) continue;
      const window = Number(val.contextWindow ?? 0);
      if (!(window > 0)) continue;
      const surfaceTokens = Number(val.surfaceTokens ?? 0);
      const pressureTokens = Number(val.pressureTokens ?? 0);
      const projectedTokens = val.projectedTokens === undefined ? null : Number(val.projectedTokens);
      // ── 分子口径（E1 评审 F3）──────────────────────────────────────────────
      // 官方明说这些字段**不是同一次请求的原子观测**（各自 last-wins、可能配错路由），
      // 所以**禁止**再用 max() 合成一个数。改为有优先级的单字段：
      //   projectedTokens（官方定义＝"下一次请求的 prompt 成本"，最贴近即将到来的那一发）
      //   → pressureTokens（最近一次 provider 报的 prompt 大小）
      //   → surfaceTokens（仅 surface 计价总量，压缩刚发生时用它更不容易虚高）
      const pick = projectedTokens !== null
        ? { used: projectedTokens, field: 'projectedTokens' }
        : pressureTokens > 0
          ? { used: pressureTokens, field: 'pressureTokens' }
          : { used: surfaceTokens, field: 'surfaceTokens' };
      candidates.push({
        file: p,
        seq: row.seq,
        mtime: statSync(p).mtimeMs,
        createdAt: Number(identity.createdAt || 0),
        surfaceTokens,
        pressureTokens,
        projectedTokens,
        contextWindow: window,
        usedTokens: pick.used,
        usedField: pick.field,
        occupancy: pick.used / window,
      });
    } catch {
      /* 单文件解析失败跳过；只要还有别的候选就不算取不到 */
    }
  }
  if (candidates.length === 0) {
    return unavailable(
      `DSH 投影缓存里没有匹配的 contextPressure 记录（workspace=${wantCwd || '*'}，sessionId=${sessionId || '*'}` +
        `）：该会话可能还没产生 request/context 记录`,
    );
  }
  // 选择策略（未指定会话时）：取 **occupancy 最高** 的那条，而不是 createdAt 最新。
  // 理由：候选里混着子代理会话；按"最新"会把子代理的极小占用报成当前占用（实测低估 16 倍）。
  // 对"是否该交接"这个判断，**高报**只是多交接一次，**低报**会漏交接 ⇒ 取高者更安全。
  // 选择方式写进返回的 `selection`，让人能看出这不是"精确的当前会话"。
  const explicit = Boolean(effSession);
  if (explicit) {
    candidates.sort((a, b) => b.seq - a.seq || b.mtime - a.mtime);
  } else {
    candidates.sort((a, b) => b.occupancy - a.occupancy || b.seq - a.seq);
  }
  const best = candidates[0];
  const selection = !explicit
    ? candidates.length > 1
      ? 'max-occupancy-among-candidates'
      : 'single-candidate'
    : sessionId
      ? 'explicit-session'
      : 'env-DSH_SESSION_ID';
  const th = deriveThresholds(best.contextWindow);
  return {
    ok: true,
    occupancy: Number(best.occupancy.toFixed(4)),
    source: 'dsh:contextPressure',
    thresholds: th,
    crossed: { warn: best.occupancy >= th.warn, hard: th.hard === null ? null : best.occupancy >= th.hard },
    raw: {
      surfaceTokens: best.surfaceTokens,
      pressureTokens: best.pressureTokens,
      projectedTokens: best.projectedTokens,
      usedTokens: best.usedTokens,
      usedField: best.usedField,
      contextWindow: best.contextWindow,
      seq: best.seq,
      autoCompactTriggerTokens: th.triggerTokens,
      autoCompactTriggerRatio: th.triggerRatio,
    },
    evidence_file: best.file,
    selection,
    ...(explicit
      ? {}
      : candidates.length > 1
        ? { selectionNote: `同工作区有 ${candidates.length} 个候选会话；未指定 --session，故取占用最高者。要精确取当前会话请传 --session <id> 或设 $DSH_SESSION_ID。` }
        : {}),
    sampledAtSeq: best.seq,
    // stale 必须**真算**（R3-A #8：写死 false 等于"永远为假的机器可读判据"）。
    // 判据：本工作区里存在更新的 contextPressure 记录 ⇒ 本条样本已过期。
    stale: candidates.some((c) => c.seq > best.seq),
    staleHint:
      '投影是 last-wins 记录：若刚发生过压缩/切模型（或同工作区有更新的会话），本值可能取自较早时刻。' +
      'stale=true 表示同工作区存在更新的样本。',
    note:
      `numerator = ${best.usedField}（单字段，按 projected → pressure → surface 优先级取；` +
      `**不使用 max 合成**，因为 DSH 官方声明这些字段不是同一次请求的原子观测）；` +
      `分母 = contextWindow。` +
      `**已知残险（E1/E3 复评登记）**：本机实测 719 条投影样本里 projectedTokens 出现 0 次 ⇒ ` +
      `实际几乎总是退回 pressureTokens；而 pressureTokens 是"最近一次 provider 报的 prompt 大小"，` +
      `**不是下一次请求的真实成本**。压缩刚发生、切模型、图片 offload 三种情形下它可能偏高或偏低；` +
      `**偏低方向最危险（该交接时不交接）**，所以本值只作预警，不得作为唯一触发依据。` +
      `计价口径：pressure/projected 带 provider 锚点、surface 为 route 计价；工具 schema 占比大或 CJK 多时偏乐观。` +
      `阈值已按窗口解析，见 thresholds。`,
  };
}

/**
 * 按模型窗口**解析**阈值（E1 评审 F2）。
 *
 * DSH 自动压缩的真实触发点是 `floor(min(W×0.8, W−O−headroomTokens))`，
 * 其中 headroomTokens 默认 65536（dsh-compaction-basic 默认值）。
 * 关键点：`min` 会让**实际触发比例低于 0.8**，小窗口下甚至低到 0.25 或 0：
 *   W=1,000,000 ⇒ 800000（0.8000）
 *   W=  262,144 ⇒ 131072（0.5000）
 *   W=  200,000 ⇒  68928（0.3446）
 *   W=  131,072 ⇒      0（0.0000）
 * 所以**不能**写死 0.8/0.88：那在小窗口下等于"永远不预警、直接让平台压缩"。
 * 这里按窗口算出真实触发点，预警线留 5 个百分点余量（下限 0.4），硬线＝触发点本身。
 * 输出口径输出参数 `outputCapTokens` 未知时按 65536 估值，并在 note 里写明这点。
 */
export function deriveThresholds(contextWindow, { outputCapTokens = 65536, headroomTokens = 65536, margin = 0.05 } = {}) {
  const W = Number(contextWindow) || 0;
  if (!(W > 0)) {
    return { warn: 0.8, hard: 0.88, triggerTokens: null, triggerRatio: null, derived: false,
      basis: '窗口未知 ⇒ 退回保守默认 0.8/0.88' };
  }
  const triggerTokens = Math.max(0, Math.floor(Math.min(W * 0.8, W - outputCapTokens - headroomTokens)));
  const triggerRatio = triggerTokens / W;
  // 预警线与硬线的关系必须成立：**warn < hard**，且 warn ≥ 0。
  // R4β #7 实测两个反例：W=200000 时旧下限 0.4 反而 **高于** hard 0.3446（预警跑在硬线后面）；
  // W=131072 时触发点为 0，硬线返回 null，而 warn 算成了 **-0.05**（负数）。
  //
  // 规则：
  //   · 触发点 > 0：warn = clamp(trigger − margin, 下限 0.05, 上限 trigger − 0.01) ⇒ 必然 warn < hard
  //   · 触发点 = 0 （硬线失效）：warn 固定 0.4 并给出原因，此时不存在"倒挂"（hard 为 null）
  const hardEffective = triggerTokens > 0;
  const warn = hardEffective
    ? Number(Math.max(0.05, Math.min(triggerRatio - margin, triggerRatio - 0.01)).toFixed(4))
    : 0.4;
  return {
    warn,
    hard: hardEffective ? Number(triggerRatio.toFixed(4)) : null,
    hardEffective,
    ...(hardEffective ? {} : { hardDisabledReason: `真实触发点被 floor 压到 0（W=${W}）⇒ 硬线无意义，仅靠预警线 ${warn}` }),
    triggerTokens,
    triggerRatio: Number(triggerRatio.toFixed(4)),
    derived: true,
    basis:
      `floor(min(W×0.8, W−${outputCapTokens}−${headroomTokens})) = ${triggerTokens}` +
      `（W=${W}）⇒ 真实触发比例 ${triggerRatio.toFixed(4)}；预警线 = 触发点 − ${margin}（下限 0.4）`,
    caveat:
      'outputCapTokens 取的是默认估值 65536（DSH 默认路由输出预留）；若某路由实际输出上限更大，' +
      '真实触发点会更低 ⇒ 本阈值偏乐观。硬线不是可靠的第二道闸门，真正的余量来自预警线 + 主动自检。',
  };
}

/**
 * 通用取数入口。
 * @param {{workspace?:string, sessionId?:string, override?:string, platform?:string}} opts
 */
export async function measureContext(opts = {}) {
  const platform = opts.platform || process.env.CONTEXT_HANDOFF_PLATFORM || '';

  // 显式覆盖优先：适配层自己取到数就用它（例如 Kimi/Codex 的 /usage）
  const override = opts.override ?? process.env.CONTEXT_HANDOFF_OCCUPANCY;
  if (override) {
    const n = Number(override);
    if (!Number.isFinite(n)) return unavailable(`--override 不是数字：${override}`);  // 形状由 unavailable() 统一保证
    // 值域与语义（R3-A 独立评审 #7 整改）：
    //   · 0 ≤ n ≤ 1  ⇒ 小数占用率，直接用
    //   · 1 <  n ≤ 100 ⇒ **百分数**，除以 100（所以 1.5 表示 1.5%）
    //   · 其余（>100、<0、非数字）⇒ 如实失败
    // 早期实现是 `n > 1 ? n/100 : n` 且**不做值域校验**：`--override 150` 会给出 occupancy=1.5 且 ok:true，
    // 而把 1.5 写进交接物后 `check` 直接判红（E_PROVENANCE_OCCUPANCY）—— 工具产出自己的判据会拒绝的值。
    let v;
    if (n >= 0 && n <= 1) v = n;
    else if (n > 1 && n <= 100) v = n / 100;
    else {
      // ⚠️ 这是**用法错**（调用方给错了值），不是"取不到"。两者必须区分：
      // R4β #7 实测旧行为返回 ok:false 但 CLI exit 0，等于"悄悄接受了一个坏参数"。
      const r = unavailable(
        `--override 必须是 0–1 的小数，或 1–100 的百分数，实际 ${override}` +
          `（注意：1.5 表示 1.5%，不是 150%）`,
      );
      r.usageError = true;
      return r;
    }
    // R3-C 复评抓到的真缺陷：早期这里写死 {warn:0.8,hard:0.88}，而 override 恰恰是
    // **所有非 DSH 平台的实际取数路径**（Kimi/Codex/TRAE 适配器都用它）⇒ 等于"按窗口解析"
    // 在这些平台上完全没生效。现在一律走 deriveThresholds；窗口未知时它自己标 derived:false。
    const w = Number(opts.contextWindow) || Number(process.env.CONTEXT_HANDOFF_CONTEXT_WINDOW) || 0;
    const th = deriveThresholds(w);
    return {
      ok: true,
      occupancy: Number(v.toFixed(4)),
      source: opts.source || process.env.CONTEXT_HANDOFF_OCCUPANCY_SOURCE || 'override',
      thresholds: th,
      crossed: { warn: th.warn === null ? null : v >= th.warn, hard: th.hard === null ? null : v >= th.hard },
      raw: { override: n, contextWindow: w > 0 ? w : null, thresholdsDerived: th.derived },
      note:
        (th.derived
          ? `occupancy 由调用方给出；阈值按窗口 ${w} 解析得 warn=${th.warn} / hard=${th.hard}。`
          : `occupancy 由调用方给出，但**没有窗口**（--context-window 或 CONTEXT_HANDOFF_CONTEXT_WINDOW）` +
            `⇒ 阈值退回保守默认 ${JSON.stringify({ warn: th.warn, hard: th.hard })}，derived=false；` +
            `**这不是按窗口解析的结果**。`) +
        ' 要给真实阈值请传 CONTEXT_HANDOFF_CONTEXT_WINDOW=<窗口>，或直接读平台投影（不带 --override）。',
    };
  }

  const tries = [];
  if (!platform || platform === 'dsh') {
    const r = measureDsh(opts);
    if (r.ok) return r;
    tries.push(r.reason);
  }

  return unavailable(
    `本机没有可用的量化来源${platform ? `（platform=${platform}）` : ''}。逐项尝试结果：\n  - ${tries.join('\n  - ') || '（无探测器）'}\n` +
      `补救：① 在 DSH 里用 --workspace <工作区绝对路径> 指定会话；② 其它平台由适配层用 ` +
      `CONTEXT_HANDOFF_OCCUPANCY=<0-1或百分比> CONTEXT_HANDOFF_OCCUPANCY_SOURCE=<名字> 传入；` +
      `③ 都取不到时，交接物 provenance 写 occupancy: unavailable 并把 trigger 记为 self-estimate——**不许编数字**。`,
    { tried: tries },
  );
}

// 直接执行时打印结果
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const r = await measureContext({
    workspace: flag('workspace') || process.cwd(),
    sessionId: flag('session'),
    override: flag('override'),
    platform: flag('platform'),
  });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  // 取不到数据源＝正常降级 exit 0；但**参数非法**（usageError）必须是 exit 3
  process.exit(r.ok ? 0 : r.usageError ? 3 : 0);
}
