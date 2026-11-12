/** 测试夹具：一份**判绿**的交接物 + 变异工具。 */
import { renderHandoff, utcStamp, SECTIONS, parseSections, parseProvenance } from '../lib/handoff.mjs';
import { renderTemplate } from '../gen_template.mjs';

const T_ACTIVE = '20261016T1530Z';
const T_DONE = '20261016T1400Z';

/** 各节真实内容（不是占位符）。改这里要同步改下面的变异断言。 */
export const VALID_SECTIONS = Object.freeze({
  goal: [
    '- 目标：让新会话仅凭本文件即可继续开发 context-handoff 技能',
    '- 验收：check 判绿（exit 0），且新会话能答出目标/下一步/禁区/验证命令四问',
    '',
  ].join('\n'),
  status: [
    '- 已完成：本体 SKILL.md、判据脚本、模板',
    '- 进行中：自测夹具',
    '- 阻塞：无',
    '- 待办：①补 platforms.md ②跑 E1–E4 评审',
    '- 下一步：node scripts/tests/handoff.check.test.mjs',
    '- 验证：node scripts/check_handoff.mjs check ./HANDOFF.md',
    '- 恢复检查点：HEAD=8e39ef6（工作树 185 项未提交，基线为"未落定"）',
    '',
  ].join('\n'),
  decisions: [
    '- 决定：本体只写平台无关内容，平台差异进 adapters/',
    '- 理由：平台专用字段会让他平台硬报错（Claude Code 之外的六个字段白名单）',
    '- 已否决：把 hooks 写进本体 frontmatter —— 会被 claude.ai 打包拒绝',
    '- 尝试过：把归档交给模型手工做（失败：不可核验）⇒ 改为 next --archive-dir',
    '',
  ].join('\n'),
  todo: ['- 待办：①补 platforms.md ②跑 E1–E4 评审', ''].join('\n'),
  boundaries: [
    '- 可改：SKILL.md、scripts/**、templates/**',
    '- 禁止：不得改动 web/src 下他人未提交的在建文件',
    '- 归属未定：docs/_evidence/批L-*/ 是否随技能一起提交',
    '',
  ].join('\n'),
  environment: [
    '- 路径：$HOME/.dsh/skills/context-handoff（本机示例；夹具用 $HOME 以免绑死用户名）',
    '- 服务：无',
    '- 命令：node --test "scripts/tests/*.test.mjs"',
    '- 依赖状态：node v22.19.0 可用；无第三方依赖',
    '',
  ].join('\n'),
  evidence: [
    '- 提交：8e39ef6',
    '- 文件：docs/72-调研与方案-上下文交接技能.md:20',
    '- 实测数字：DSH 占用 43229/1000000 = 0.0432',
    '',
  ].join('\n'),
  open_questions: ['- 待裁决：技能目录是否入库 intel-hub 仓库', ''].join('\n'),
});

export function validProvenance(over = {}) {
  return {
    version: '1',
    round: '1',
    updated_utc: T_ACTIVE,
    workspace: '/tmp/ws',
    trigger: 'user-request',
    occupancy: '0.0432',
    occupancy_source: 'dsh:contextPressure',
    supersedes: 'none',
    status: 'draft',
    ...over,
  };
}

/**
 * 生成一份"判绿"的交接物。
 *
 * ⚠️ 必须用**真实模板产物**（`init` 同源）作为基底，而不是自己 `renderHandoff` 拼一份 —— 否则
 * 夹具与真实产物形状不同源，缺陷会永久逃逸。历史教训（R3-D 独立评审实测）：
 * 旧夹具各节体**不含反引号**，于是 84 项自测全绿，却掩盖了"节体含行内代码时 `next` 必然失败"
 * 这个"只能 init、不能 update"级别的缺陷 —— 因为真实产物（模板的节说明 + 用户的命令）几乎都含反引号。
 */
export function validHandoff(over = {}) {
  const sections = { ...VALID_SECTIONS, ...(over.sections || {}) };
  // 从真实模板出发，只替换节体（保留节说明注释与全部哨兵），等价于"用户照 init 骨架填写"。
  const base = renderTemplate({ hints: false });
  const parsed = parseSections(base);
  let out = base;
  const targets = SECTIONS.map((id) => parsed.sectionsById[id]).filter(Boolean)
    .sort((a, b) => b.bodyStart - a.bodyStart);
  for (const t of targets) {
    const v = sections[t.id];
    if (v === undefined) continue;
    // ⚠️ 必须**保留该节的说明注释行**（模板里那些 `<!-- … -->`），只在说明之后注入内容。
    // R4β #2 实测：旧实现整段替换节体，把节说明全删了，于是夹具里 8 个节体反引号数=0 ——
    // 与 `init` 真实产物不同源，"含反引号即失败"这类缺陷会永久逃逸。
    const kept = t.body
      .split('\n')
      .filter((line) => /^\s*<!--(?!\s*HANDOFF:CONTENT)/.test(line)) // 留说明，不留 CONTENT 标记
      .join('\n');
    const body = `${kept ? `${kept}\n` : ''}${String(v).replace(/^\n+/, '').replace(/\n+$/, '')}`;
    out = out.slice(0, t.bodyStart) + `\n${body}\n\n` + out.slice(t.bodyEnd);
  }
  // provenance 用调用方给的（模板给的是占位）
  const prov = validProvenance(over.provenance);
  // 已知键按固定顺序写；额外键（如可选的 trigger_detail）追加在后面，
  // 否则夹具会**悄悄吞掉**调用方传进来的可选字段（曾导致 trigger_detail 用例假绿/假红）。
  const KNOWN = ['version', 'round', 'updated_utc', 'workspace', 'trigger', 'occupancy', 'occupancy_source', 'supersedes', 'status'];
  const extras = Object.keys(prov).filter((k) => !KNOWN.includes(k) && prov[k] !== undefined);
  const lines = [
    '<!-- handoff:provenance -->',
    ...KNOWN.map((k) => `${k}: ${prov[k] ?? ''}`),
    ...extras.map((k) => `${k}: ${prov[k]}`),
    '<!-- /handoff:provenance -->',
  ].join('\n');
  const pv = parseProvenance(out);
  out = out.slice(0, pv.start) + lines + out.slice(pv.end);
  return out;
}

/** 把某一节整体替换（用于构造"新版"）。 */
export function withSection(text, id, body) {
  const open = `<!-- handoff:section id=${id} -->`;
  const close = '<!-- /handoff:section -->';
  const start = text.indexOf(open);
  if (start < 0) throw new Error(`withSection: 找不到节 ${id}`);
  const end = text.indexOf(close, start) + close.length;
  return text.slice(0, start) + open + body + close + text.slice(end);
}

export const STAMPS = { active: T_ACTIVE, done: T_DONE };
export { utcStamp };
