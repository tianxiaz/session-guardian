/**
 * context-handoff · 纯函数库
 *
 * 这里没有任何 I/O：解析、校验、合并、对比都是纯函数，
 * 便于 scripts/tests/*.test.mjs 直接 import 做判据测试。
 *
 * 判据三条铁律（本文件是它们的唯一实现处）：
 *   1) 字段完整性：节名/顺序/必填子项/必填 provenance 键，缺一即红
 *   2) 空面判红：节体为空、或占位符未被替换、或子项值为空 ⇒ 红
 *   3) 幂等/结构保真：render(merge(prev, changed, provided)) 未变节逐字节保留
 */

export const VERSION = 1;

/** 节名与顺序固定；脚本按此校验，声明式合并按此保持结构。 */
export const SECTIONS = Object.freeze([
  'goal',
  'status',
  'decisions',
  'todo',
  'boundaries',
  'environment',
  'evidence',
  'open_questions',
]);

/** 各节必含子项（键名固定）。
 *
 * E1 评审 F6：八节原表缺四类"接续必需"信息，其中**失败尝试**最致命——它是防"新会话重走死路"
 * 的唯一防线。故补三项必含子项：
 *   decisions.尝试过     —— 试过什么、为什么不行（无则写「无」）
 *   environment.依赖状态 —— 外部依赖当前是否可用（无则写「无」）
 *   environment.定时提醒 —— 本会话挂着的定时提醒/定时任务（kind/title/prompt/时间），归档会丢；无则写「无」
 *   status.恢复检查点    —— 交接基线的 commit 与工作树是否干净（"四问"的第 5 问靠它回答）
 */
export const REQUIRED_ITEMS = Object.freeze({
  goal: ['目标', '验收'],
  status: ['已完成', '进行中', '阻塞', '待办', '下一步', '验证', '恢复检查点'],
  decisions: ['决定', '理由', '已否决', '尝试过'],
  todo: ['待办'],
  boundaries: ['可改', '禁止', '归属未定'],
  environment: ['路径', '服务', '命令', '依赖状态', '定时提醒'],
  evidence: ['提交', '文件', '实测数字'],
  open_questions: ['待裁决'],
});

/** provenance 六项必填。 */
export const REQUIRED_PROVENANCE = Object.freeze([
  'version',
  'round',
  'updated_utc',
  'workspace',
  'trigger',
  'status',
]);

/**
 * 触发来源白名单。
 *
 * 取值按**三条失效轴**组织（详见 references/triggers.md 与 docs/77）：
 *   A 信息失真（会话还活着）：context-pressure / pre-compact / post-compact / degradation / model-switch
 *   B 执行中断（模型可能已没机会动作）：interruption / error-recovery / compaction-failed / round-limit / budget-quota
 *   C 主动边界：user-request / phase-complete / checkpoint / peer-request / device-switch
 *   兜底：self-estimate（自己觉得快不行了，**必须如实标注**）
 *
 * 关键取舍：`checkpoint` 单列出来，是因为 B 类里有一半场景（假死/被 kill/超时/崩溃）
 * **在模型侧不可观测** —— 发生时已无法写任何东西。对这些场景，唯一防线就是"趁还活着写新"（写前式检查点）。
 */
export const ALLOWED_TRIGGERS = Object.freeze([
  'user-request',
  'phase-complete',
  'checkpoint',
  'context-pressure',
  'external-threshold', // 兼容别名（= context-pressure），早期版本用过
  'pre-compact',
  'post-compact',
  'degradation',
  'model-switch',
  'interruption',
  'error-recovery',
  'compaction-failed',
  'round-limit',
  'budget-quota',
  'peer-request',
  'device-switch',
  'self-estimate',
]);

/** 可选 `trigger_detail`：平台侧具体信号名，用于事后归因；不参与判绿。 */
export const OPTIONAL_TRIGGER_DETAIL = 'trigger_detail';

export const ALLOWED_STATUS = Object.freeze(['draft', 'complete', 'blocked']);

/** 空面判红用：这些值等于"没写"。 */
const EMPTY_TOKENS = new Set(['', '-', '—', '…', '...', 'TBD', 'tbd', 'TODO', 'todo', '待填', '未填']);

/**
 * `无` 是**显式否定**，合法；`未复核` 是**显式未知**，合法。
 * 只有真正空白才是空面。
 */
const EXPLICIT_TOKENS = new Set(['无', '未复核', 'none', 'N/A', 'n/a']);

const PROV_OPEN = '<!-- handoff:provenance -->';
const PROV_CLOSE = '<!-- /handoff:provenance -->';

const SECTION_RE = /<!--\s*handoff:section\s+id=([A-Za-z0-9_]+)\s*-->([\s\S]*?)<!--\s*\/handoff:section\s*-->/g;
const SECTION_OPEN_RE = /<!--\s*handoff:section\s+id=[A-Za-z0-9_]+\s*-->/g;
const SECTION_CLOSE_RE = /<!--\s*\/handoff:section\s*-->/g;

/**
 * 日历校验：正则形状对不代表日期存在。
 * E1 评审 F1 实测出四个"应判红却判绿"的漏洞（20261399T9999Z / 20260000T0000Z /
 * 20260230T2460Z / 20261332T2500Z），故这里必须用 Date.UTC 回写比对。
 */
export function isRealUtcStamp(s) {
  if (typeof s !== 'string' || !/^[0-9]{8}T[0-9]{4}Z$/.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(9, 11));
  const mi = Number(s.slice(11, 13));
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  if (h > 23 || mi > 59) return false;
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi
  );
}

/** supersedes 的合法形态：`none`，或 `round-<正整数>@<8..64 位十六进制>`。 */
const SUPERSEDES_RE = /^round-([1-9][0-9]*)@([0-9a-f]{8,64})$/;

/** 判定一个子项值是否算"空面"。 */
export function isBlankValue(raw) {
  if (raw === undefined || raw === null) return true;
  let s = String(raw);
  // 去掉整行注释（占位提示常写成注释）
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.trim();
  if (EMPTY_TOKENS.has(s)) return true;
  if (EXPLICIT_TOKENS.has(s)) return false;
  // 全是标点/占位符号也算空
  if (/^[<>\[\]{}()（）【】*_`~|\\/\s.-]+$/.test(s)) return true;
  return false;
}

/** 解析 provenance 区块。缺失时返回 { present:false }。 */
export function parseProvenance(text) {
  const open = text.indexOf(PROV_OPEN);
  if (open < 0) return { present: false, keys: {}, raw: null };
  const close = text.indexOf(PROV_CLOSE, open + PROV_OPEN.length);
  if (close < 0) return { present: false, keys: {}, raw: null, unclosed: true };
  const body = text.slice(open + PROV_OPEN.length, close);
  const raw = text.slice(open, close + PROV_CLOSE.length);
  const keys = {};
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line.trim());
    if (m) keys[m[1]] = m[2].trim();
  }
  return { present: true, keys, raw, start: open, end: close + PROV_CLOSE.length };
}

/**
 * 解析全部节。返回：
 *   sections: [{ id, body, raw, start, end }]（按文件出现顺序）
 *   sectionsById: { id: section }（重复时保留首个并在 duplicates 里登记）
 *   duplicates: [id]
 */

/**
 * 求文档里"代码区间"（围栏代码块 + 行内反引号）的字节范围。
 *
 * 为什么需要：交接物里**合法地**会引用哨兵字面量（例如 `evidence.文件` 写
 * "哨兵形如 `<!-- handoff:section id=goal -->`"）。这些字面量一旦被节解析器当成真哨兵，
 * 就会出现"多了一个开哨兵"（open=9 close=8）这种假红 —— 我们自己的交接物被判红。
 * 所以解析器必须在这些区间内**忽略**哨兵标记。
 * （E1 复评 N4 / E4 复评 R4）
 */
function blockCodeRanges(text) {
  const ranges = [];
  const lines = text.split('\n');
  let offset = 0;
  let open = null; // {ch, len, start}
  let prevBlank = true; // 文件开头等价于"前一行是空行"
  let indented = null;  // 4 空格缩进代码块的起点

  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1; // 跳过 \n
    const isBlank = line.trim() === '';

    if (open !== null) {
      // 闭合：同字符、长度不短于开围栏、后面只有空白
      const m = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1][0] === open.ch && m[1].length >= open.len) {
        ranges.push([open.start, lineEnd]);
        open = null;
      }
      prevBlank = isBlank;
      continue;
    }

    // 开围栏：``` 或 ~~~，长度 ≥3（CommonMark 允许任意长度）
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      open = { ch: fence[1][0], len: fence[1].length, start: lineStart };
      indented = null;
      prevBlank = false;
      continue;
    }

    // 4 空格 / tab 缩进的代码块：只在其**起始行**紧跟空行时才算（CommonMark 规则），
    // 否则会把列表续行的正常缩进误判成代码（那是假阳性）。
    if (/^(?: {4}|\t)/.test(line) && !isBlank) {
      if (indented === null && prevBlank) indented = lineStart;
      if (indented !== null) ranges.push([lineStart, lineEnd]);
    } else {
      indented = null;
    }
    prevBlank = isBlank;
  }
  if (open !== null) ranges.push([open.start, text.length]); // 未闭合围栏算到文末

  // HTML 注释里的 `- 键：值` 不是真子项（R4β 实测的假绿）。
  // ⚠️ 但**绝不能掩码 handoff 自己的哨兵注释**——哨兵就是 HTML 注释，掩掉就等于没有节了。
  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) {
    if (/^<!--\s*\/?handoff:(section|provenance|CONTENT)/.test(m[0])) continue;
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/** 代码区间 = 块级（围栏/缩进块/HTML 注释） + 行内代码。 */
function codeRanges(text) {
  const ranges = blockCodeRanges(text);
  for (const m of text.matchAll(/`[^`\n]*`/g)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

/** 某位置是否落在代码区间内（含边界）。 */
function inCode(pos, ranges) {
  return ranges.some(([a, b]) => pos >= a && pos < b);
}

/** 把代码区间内的字符替换成空格（保持所有字节偏移不变），供"只扫真哨兵"的解析器使用。 */
function maskCode(text) {
  const ranges = codeRanges(text);
  if (ranges.length === 0) return text;
  const chars = text.split('');
  for (const [a, b] of ranges) for (let i = a; i < b && i < chars.length; i++) if (chars[i] !== '\n') chars[i] = ' ';
  return chars.join('');
}

export function parseSections(text) {
  const sections = [];
  // 在"掩码掉代码区间"的副本上匹配：哨兵字面量写在反引号/围栏里时不算真哨兵。
  // 掩码只把区间内字符换成空格，**字节偏移与原文完全一致**，所以 bodyStart/bodyEnd 可直接用于原文切片。
  const masked = maskCode(text);
  const re = new RegExp(SECTION_RE.source, 'g');
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(masked)) !== null) {
    // ⚠️ 坐标必须只由**开哨兵自身的长度**推出，绝不能用「整段匹配长度 − 节体长度」。
    // 原因：`m[2]` 是在**掩码文本**上捕获的（代码区里的内容被替换成等长空格），
    // 若节体里含反引号，`text.slice(bodyStart, bodyEnd) !== m[2]` 会成立 —— 用整段长度相减
    // 会把开哨兵的长度也算进去，坐标整体偏移，合并时把该节的开哨兵切掉。
    //
    // R3-D/R3-A 独立实测到的真实缺陷：只要节体含行内代码（反引号），`next` 必然产出
    // `open=7 close=8` 并拒盘 —— 而真实交接物几乎都含反引号（如 `cd … && node …`）。
    // 等价于"只能 init、不能更新"。原因是旧代码用 `m[0].indexOf(m[2], …)` 去搜一个
    // 已被空格替换过的串 ⇒ 返回 -1 ⇒ bodyStart 退化到节体中间。
    const openTagMatch = /^<!--\s*handoff:section\s+id=[A-Za-z0-9_]+\s*-->/.exec(m[0]);
    const bodyStart = m.index + (openTagMatch ? openTagMatch[0].length : 0);
    // 闭合哨兵可能写成 `<!--/handoff:section-->`（少空格）等合法变体；
    // 必须用**实际匹配到的**闭合哨兵长度，否则固定用规范长度会把节体尾部多切/少切几个字节
    // （R4β 实测：非规范闭合哨兵 + 节体无尾换行 ⇒ 合法内容被切 2 字节并假红 E_ITEM_MISSING）。
    const closeTagMatch = /<!--\s*\/handoff:section\s*-->$/.exec(m[0]);
    const bodyEnd = m.index + m[0].length - (closeTagMatch ? closeTagMatch[0].length : '<!-- /handoff:section -->'.length);
    const body = text.slice(bodyStart, bodyEnd);
    sections.push({
      id: m[1],
      body,
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
      bodyStart,
      bodyEnd: bodyStart + m[2].length,
    });
  }
  const sectionsById = {};
  const duplicates = [];
  for (const s of sections) {
    if (sectionsById[s.id]) {
      if (!duplicates.includes(s.id)) duplicates.push(s.id);
      continue;
    }
    sectionsById[s.id] = s;
  }
  // 计数也必须用**掩码后**的文本：否则反引号/围栏里的哨兵字面量会被算成真哨兵，
  // 于是 open=9 close=8（假红）。这正是 E1-N4/E4-R4 的根因。
  const openCount = (masked.match(SECTION_OPEN_RE) || []).length;
  const closeCount = (masked.match(SECTION_CLOSE_RE) || []).length;
  return {
    sections,
    sectionsById,
    duplicates,
    openCount,
    closeCount,
    unbalanced: openCount !== closeCount,
  };
}

/**
 * 解析节体里的顶层子项：`- 键：值`（也接受 `- 键: 值` 与 `**键**：值`）。
 * 后续缩进行并入上一个键的值。
 */
export function parseItems(body) {
  const items = {};
  const order = [];
  let current = null;
  // 跳过**块级代码区**里的行：围栏（``` 与 ~~~、任意长度）、4 空格缩进块、HTML 注释。
  // 否则示例块里的 `- 键：值` 会被当成真正子项，使**真正缺失**的必含子项被判绿。
  // 注意：这里只按**行**跳过块级区间，不屏蔽行内反引号 —— 子项值本身就常含 `code`，
  // 掩掉会让合法值变空面（假阳性）。行级判定与哨兵解析共用 blockCodeRanges，保证两套扫描器口径一致。
  const text = String(body);
  const lines = text.split('\n');
  const blockRanges = blockCodeRanges(text);
  const inBlock = (pos) => blockRanges.some(([a, b]) => pos >= a && pos < b);
  let pos = 0;
  const masked = lines.map((line) => {
    const start = pos;
    pos += line.length + 1;
    return inBlock(start) ? '' : line;
  });
  for (const line of masked) {
    const m = /^\s*[-*]\s*\*{0,2}([^\s:*：*]+)\*{0,2}\s*[:：]\s*([\s\S]*)$/.exec(line);
    if (m && /^\s*[-*]\s/.test(line)) {
      current = m[1].trim();
      if (!(current in items)) order.push(current);
      items[current] = m[2];
      continue;
    }
    if (current !== null && line.trim() !== '') {
      // 续行**保留原始缩进**：两份副本若续行缩进不同，必须能比对出差异（R4β #11）。
      items[current] = `${items[current]}\n${line}`;
    }
  }
  return { items, order };
}

/**
 * 校验一份交接物文本。
 * @returns {{ok:boolean, errors:Array<{code:string,detail:string}>, warnings:Array<{code:string,detail:string}>, meta:object}}
 */
export function validateHandoff(text) {
  const errors = [];
  const warnings = [];
  const err = (code, detail) => errors.push({ code, detail });
  const warn = (code, detail) => warnings.push({ code, detail });

  if (typeof text !== 'string' || text.trim() === '') {
    err('E_EMPTY_FILE', '文件为空：无任何内容可校验');
    return { ok: false, errors, warnings, meta: {} };
  }

  const prov = parseProvenance(text);
  if (!prov.present) {
    err('E_PROVENANCE_MISSING', '缺少 provenance 区块（<!-- handoff:provenance --> … <!-- /handoff:provenance -->）');
  } else {
    for (const key of REQUIRED_PROVENANCE) {
      if (!(key in prov.keys)) {
        err('E_PROVENANCE_KEY_MISSING', `provenance 缺少必填键：${key}`);
      } else if (isBlankValue(prov.keys[key])) {
        err('E_PROVENANCE_KEY_EMPTY', `provenance 键为空面：${key}`);
      }
    }
    // 可选归因字段：存在时不得为空面（否则等于没写）
    if (OPTIONAL_TRIGGER_DETAIL in prov.keys && isBlankValue(prov.keys[OPTIONAL_TRIGGER_DETAIL])) {
      err('E_PROVENANCE_TRIGGER_DETAIL', `trigger_detail 存在但为空面（要么写具体信号名，要么整删该行）`);
    }
    if (prov.keys.trigger && !ALLOWED_TRIGGERS.includes(prov.keys.trigger)) {
      err('E_PROVENANCE_TRIGGER', `trigger 取值非法：${prov.keys.trigger}（允许 ${ALLOWED_TRIGGERS.join(' | ')}）`);
    }
    if (prov.keys.status && !ALLOWED_STATUS.includes(prov.keys.status)) {
      err('E_PROVENANCE_STATUS', `status 取值非法：${prov.keys.status}（允许 ${ALLOWED_STATUS.join(' | ')}）`);
    }
    if ('version' in prov.keys && prov.keys.version !== String(VERSION)) {
      err('E_PROVENANCE_VERSION', `version 必须是 ${VERSION}，实际 ${prov.keys.version}`);
    }
    if ('round' in prov.keys && !/^[1-9][0-9]*$/.test(prov.keys.round)) {
      err('E_PROVENANCE_ROUND', `round 必须是正整数，实际 ${prov.keys.round}`);
    }
    if ('updated_utc' in prov.keys && !isRealUtcStamp(prov.keys.updated_utc)) {
      // E1 评审 F1：只校验正则形状会让 20261399T9999Z / 20260230T2460Z 这类
      // **不可能存在的时刻**判绿。必须做日历校验。
      err(
        'E_PROVENANCE_UTC',
        `updated_utc 必须是真实存在的 YYYYMMDDTHHMMZ（UTC），实际 ${prov.keys.updated_utc}`,
      );
    }
    // E1 评审 F4：取值有效性。workspace 必须是绝对路径。
    if ('workspace' in prov.keys && !isBlankValue(prov.keys.workspace)) {
      const w = prov.keys.workspace;
      if (!(w.startsWith('/') || /^[A-Za-z]:[\\/]/.test(w))) {
        err('E_PROVENANCE_WORKSPACE', `workspace 必须是绝对路径（Unix 以 / 开头、Windows 形如 C:\\），实际 ${w}`);
      }
    }
    // E1 评审 F4：supersedes 只能是 none，或 round-<正整数>@<8..64 位十六进制>。
    if ('supersedes' in prov.keys && !isBlankValue(prov.keys.supersedes)) {
      const sp = prov.keys.supersedes;
      if (sp !== 'none') {
        const mm = SUPERSEDES_RE.exec(sp);
        if (!mm) {
          err(
            'E_SUPERSEDES_MALFORMED',
            `supersedes 只能是 none 或 round-<正整数>@<8..64 位十六进制>，实际 ${sp}`,
          );
        } else if ('round' in prov.keys && /^[1-9][0-9]*$/.test(prov.keys.round)) {
          // 跨字段一致性：继承自第 N 版 ⇒ 本版必须是 N+1
          const prevRound = Number(mm[1]);
          const thisRound = Number(prov.keys.round);
          if (thisRound !== prevRound + 1 && thisRound !== prevRound) {
            err(
              'E_SUPERSEDES_ROUND_MISMATCH',
              `supersedes 指向第 ${prevRound} 版，但本版 round=${thisRound}（应为 ${prevRound} 或 ${prevRound + 1}）`,
            );
          }
        }
      }
    }
    if ('occupancy' in prov.keys && !isBlankValue(prov.keys.occupancy) && prov.keys.occupancy !== 'unavailable') {
      const n = Number(prov.keys.occupancy);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        err('E_PROVENANCE_OCCUPANCY', `occupancy 必须是 0–1 之间的小数、或 unavailable，实际 ${prov.keys.occupancy}`);
      }
    }
    if (prov.keys.occupancy === 'unavailable' && 'occupancy_source' in prov.keys && prov.keys.occupancy_source !== 'unavailable') {
      warn('W_OCCUPANCY_SOURCE', 'occupancy 为 unavailable 但 occupancy_source 不是 unavailable');
    }
  }

  const parsed = parseSections(text);
  if (parsed.unbalanced) {
    err('E_SECTION_UNBALANCED', `节哨兵不成对：open=${parsed.openCount} close=${parsed.closeCount}`);
  }
  if (parsed.duplicates.length) {
    err('E_SECTION_DUPLICATE', `同一节出现多次：${parsed.duplicates.join(', ')}`);
  }

  for (const id of SECTIONS) {
    if (!parsed.sectionsById[id]) {
      err('E_SECTION_MISSING', `缺少必填节：${id}`);
    }
  }

  const presentOrder = parsed.sections.filter((s) => SECTIONS.includes(s.id)).map((s) => s.id);
  const expectedOrder = SECTIONS.filter((id) => presentOrder.includes(id));
  if (presentOrder.join(',') !== expectedOrder.join(',')) {
    err('E_SECTION_ORDER', `节顺序错误：实际 ${presentOrder.join(' → ')}，应为 ${expectedOrder.join(' → ')}`);
  }

  const itemValues = {};
  const sentinelInBody = [];
  for (const id of SECTIONS) {
    const sec = parsed.sectionsById[id];
    if (!sec) continue;
    // E1 评审 F5：节体里混入哨兵 ⇒ 结构被破坏。必须报**根因**（E_SENTINEL_IN_BODY），
    // 并抑制该节的 E_ITEM_MISSING/E_ITEM_EMPTY，否则"你少写了一个字段"会把接续方引到错地方。
    //
    // E1 复评 N4：检测前必须**剥掉代码围栏与行内反引号** —— 正文里合法地引用哨兵字面量
    // （例如文档写"哨兵形如 `<!-- handoff:section id=goal -->`"）不该被判成结构损坏。
    const bodyForSentinelCheck = sec.body
      .replace(/```[\s\S]*?```/g, '')   // 围栏代码块
      .replace(/`[^`\n]*`/g, '');       // 行内代码
    if (/<!--\s*\/?handoff:/.test(bodyForSentinelCheck)) {
      sentinelInBody.push(id);
      err(
        'E_SENTINEL_IN_BODY',
        `节 ${id} 的节体里含有 handoff 哨兵注释 ⇒ 结构已损坏（多半是手工编辑时把哨兵粘进了内容，` +
          `或少了某个 <!-- /handoff:section -->）。请对照 templates/HANDOFF.md 修复该节边界。`,
      );
      continue;
    }
    // 模板与 SKILL.md 都承诺"保留 HANDOFF:CONTENT 标记 = 未填写 ⇒ 判红"（R3-D #5 实测此前判绿）。
    // 这里把它做成真判据；提示语里给出可执行动作（删掉那一行）。
    if (/<!--\s*HANDOFF:CONTENT\s*-->/.test(sec.body)) {
      err(
        'E_CONTENT_MARKER_HELD',
        `节 ${id} 仍保留 HANDOFF:CONTENT 标记 ⇒ 视为未填写。` +
          `若该节内容已写好，请**删掉这一行注释**（标记只用于"还没填"的状态）。`,
      );
    }
    if (isBlankValue(sec.body)) {
      err('E_SECTION_EMPTY', `节体为空面（必须写实质内容，确定没有就写"无"）：${id}`);
      continue;
    }
    const { items } = parseItems(sec.body);
    itemValues[id] = items;
    for (const key of REQUIRED_ITEMS[id] || []) {
      if (!(key in items)) {
        err('E_ITEM_MISSING', `节 ${id} 缺少必含子项：${key}`);
      } else if (isBlankValue(items[key])) {
        err('E_ITEM_EMPTY', `节 ${id} 的子项为空面：${key}`);
      }
    }
    if (id === 'boundaries' && '禁止' in items && !isBlankValue(items['禁止'])) {
      const v = items['禁止'].trim();
      if (v === '无' || v === 'none' || v === 'N/A') {
        warn('W_NO_BOUNDARY', 'boundaries.禁止 写成了"无"：没有禁区本身就是危险信号，请确认确实无禁区');
      }
    }
  }

  const st = itemValues.status || {};
  const td = itemValues.todo || {};
  if ('待办' in st && '待办' in td) {
    // **真逐字节**比较（R4β #11 实测：旧实现只"中间多空格"能红，末尾多空格/tab、续行缩进不同都漏判）。
    // 因此这里不做任何空白折叠、不 strip 末尾 —— 只容忍"整个字段尾部的那一个换行"，
    // 那是行结构带来的、不属于内容差异。
    const a = String(st['待办'] ?? '').replace(/\n$/, '');
    const b = String(td['待办'] ?? '').replace(/\n$/, '');
    if (a !== b) {
      err(
        'E_TODO_MISMATCH',
        'status.待办 与 todo.待办 不一致（同一份清单两处副本，逐字节必须相同）\n' +
          `  status.待办 = ${JSON.stringify(trimForMessage(st['待办']))}\n` +
          `  todo.待办   = ${JSON.stringify(trimForMessage(td['待办']))}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    meta: {
      provenance: prov.keys,
      sections: presentOrder,
      items: itemValues,
    },
  };
}

function trimForMessage(v) {
  const s = String(v == null ? '' : v).trim();
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/**
 * 对比两份交接物，找出变化节。
 * @returns {{changed:string[], added:string[], removed:string[], identical:boolean, meta:object}}
 */
export function compareHandoffs(prevText, nextText) {
  const a = parseSections(prevText);
  const b = parseSections(nextText);
  const changed = [];
  const added = [];
  const removed = [];
  for (const id of SECTIONS) {
    const A = a.sectionsById[id];
    const B = b.sectionsById[id];
    if (!A && B) added.push(id);
    else if (A && !B) removed.push(id);
    else if (A && B && A.body !== B.body) changed.push(id);
  }
  // 节外内容（provenance、标题等）也算变化，用固定伪 id 表示
  const stripSections = (t) => t.replace(SECTION_RE, '@@SECTION@@');
  if (stripSections(prevText) !== stripSections(nextText)) changed.push('__outside__');
  return {
    changed,
    added,
    removed,
    identical: changed.length === 0,
    meta: { prev: a.sections.map((s) => s.id), next: b.sections.map((s) => s.id) },
  };
}

/** 从节体抽取哨兵内部内容（compare/merge 只用哨兵内部）。 */
function bodyOf(text, id) {
  const p = parseSections(text);
  const s = p.sectionsById[id];
  return s ? s.body : undefined;
}

/**
 * 声明式合并：把 prev 里**未在 changedIds 中**的节逐字节搬过来，
 * 从 provided 里取 changedIds 节的新内容。
 *
 * 这是"未变项逐字保留"的机械保证：未声明变化的节根本不经过任何重写路径。
 *
 * @param {string} prevText    上一版交接物全文
 * @param {string[]} changedIds 声明发生变化的节
 * @param {Record<string,string>} provided 变化节的新节体（不含哨兵）
 * @returns {{text:string, changed:string[]}}
 * @throws {Error} 参数不一致时抛错（宁可炸，不许静默产出）
 */
export function mergeHandoff(prevText, changedIds, provided) {
  const prev = parseSections(prevText);
  const ids = Array.from(new Set(changedIds || []));
  if (!provided || typeof provided !== 'object') {
    throw new Error('mergeHandoff: provided 必须是 { 节id: 新节体 } 对象');
  }
  for (const id of ids) {
    if (!SECTIONS.includes(id)) {
      throw new Error(`mergeHandoff: 未知节 id "${id}"（允许 ${SECTIONS.join(', ')}）`);
    }
    if (!(id in provided)) {
      throw new Error(`mergeHandoff: 声明了变化但未提供新内容：${id}`);
    }
    if (!prev.sectionsById[id]) {
      throw new Error(`mergeHandoff: 上一版缺少节 ${id}，无法做增量合并（请改用 init 重建）`);
    }
    if (/<!--\s*\/?handoff:/.test(String(provided[id]))) {
      throw new Error(`mergeHandoff: 节 ${id} 的新内容里含哨兵注释，禁止（哨兵由渲染器统一产出）`);
    }
  }
  for (const key of Object.keys(provided)) {
    if (ids.includes(key)) continue;
    // 提供了未声明的节：直接炸，避免"偷偷改了一节"
    throw new Error(`mergeHandoff: 提供了未声明变化的节 "${key}"（未变节必须逐字保留，不许重写）`);
  }

  let out = prevText;
  // 从后往前替换，避免位移。**只替换节体字节区间**（跳过哨兵），并且把新节体**归一化**为
  // "哨兵各占一行、节体两侧各有一个换行"的规范形态。
  //
  // 规范形态 = 渲染器 renderHandoff 产出的形态，也就是 templates/HANDOFF.md 展示的形态：
  //   哨兵行 \n 节体（各子项独占一行）\n \n 闭哨兵
  // 归一化必须**完全复刻**这一形态，否则"声明变化但内容相同"时重放会与原文有字节差
  // （E4 评审 B2 的另一面：既要防粘连，也不能引入多余/缺失的空行）。
  const normalizeBody = (raw) => `\n${String(raw).replace(/^\n+/, '').replace(/\n+$/, '')}\n\n`;
  const targets2 = prev.sections
    .filter((s) => ids.includes(s.id))
    .sort((x, y) => y.bodyStart - x.bodyStart);
  for (const t of targets2) {
    out = out.slice(0, t.bodyStart) + normalizeBody(provided[t.id]) + out.slice(t.bodyEnd);
  }
  return { text: out, changed: ids };
}

/** 渲染一份全新交接物（init 用）。 */
export function renderHandoff({ provenance, sections }) {
  const lines = [];
  lines.push('# HANDOFF（上下文交接物）');
  lines.push('');
  lines.push('> 本文件由 `context-handoff` 技能维护。字段与节名固定，改动须过 `check_handoff.mjs`。');
  lines.push('');
  lines.push(PROV_OPEN);
  for (const key of [
    'version',
    'round',
    'updated_utc',
    'workspace',
    'trigger',
    'occupancy',
    'occupancy_source',
    'supersedes',
    'status',
  ]) {
    lines.push(`${key}: ${provenance[key] ?? ''}`);
  }
  lines.push(PROV_CLOSE);
  lines.push('');
  for (const id of SECTIONS) {
    lines.push(`<!-- handoff:section id=${id} -->`);
    lines.push(String(sections[id] ?? ''));
    lines.push('<!-- /handoff:section -->');
    lines.push('');
  }
  return lines.join('\n');
}

/** UTC 时间戳 → YYYYMMDDTHHMMZ */
export function utcStamp(d) {
  const t = new Date(d);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}` +
    `T${p(t.getUTCHours())}${p(t.getUTCMinutes())}Z`
  );
}

/* 注意：这里**故意不提供** `archiveName(stamp, seq)` 这类"时间戳 + 序号"的归档命名。
 * 归档名必须是**内容寻址**的 `round-<轮次>@<指纹>.md`（见 check_handoff.mjs 的 archivePrev）：
 * 带时间戳的名字会让"同一状态重放"产出新文件名 ⇒ 破坏幂等判据。
 * （E1/E3/E2 三轮复评均指向这里：一条被判定"会破坏幂等"的公开 API 迟早会被扩展者踩到。）
 */
