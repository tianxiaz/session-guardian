/**
 * 判据 3 主判据：幂等（未变项逐字保留）
 *
 * 关键：这里断言的是**字节**相等，不是"语义相同"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHandoff, compareHandoffs, validateHandoff, SECTIONS, renderHandoff } from '../lib/handoff.mjs';
import { validHandoff, validProvenance, VALID_SECTIONS, withSection } from './fixtures.mjs';

const NEW_STATUS = [
  '- 已完成：本体 SKILL.md、判据脚本、模板、自测夹具',
  '- 进行中：platforms.md',
  '- 阻塞：无',
  '- 待办：①补 platforms.md ②跑 E1–E4 评审',
  '- 下一步：node scripts/check_handoff.mjs check ./HANDOFF.md',
  '- 验证：node scripts/check_handoff.mjs check ./HANDOFF.md',
  '- 恢复检查点：HEAD=8e39ef6（工作树 185 项未提交）',
  '',
].join('\n');

test('幂等基准：同一 payload 连跑两次，产物逐字节相同', () => {
  const prev = validHandoff();
  const payload = { status: NEW_STATUS, todo: VALID_SECTIONS.todo };
  const a = mergeHandoff(prev, ['status'], { status: payload.status }).text;
  const b = mergeHandoff(prev, ['status'], { status: payload.status }).text;
  assert.equal(a, b, '两次合并必须逐字节相同');
  // 再以第一版为基准重复一次"只改 status"的合并，结果也必须一致
  const c = mergeHandoff(a, ['status'], { status: payload.status }).text;
  assert.equal(c, a, '对已经是目标状态的对象再合并同一内容，必须不变（幂等）');
});

test('未声明变化的节：逐字节保留（不是"看起来一样"）', () => {
  const prev = validHandoff();
  const next = mergeHandoff(prev, ['status'], { status: NEW_STATUS }).text;
  for (const id of SECTIONS) {
    if (id === 'status') continue;
    const body = (t) => t.slice(t.indexOf(`<!-- handoff:section id=${id} -->`), t.indexOf('<!-- /handoff:section -->', t.indexOf(`<!-- handoff:section id=${id} -->`)));
    assert.equal(body(next), body(prev), `节 ${id} 未被声明变化，必须逐字节保留`);
  }
});

test('未声明变化的节：整个文件里未变节的原始切片也必须相同', () => {
  const prev = validHandoff();
  const next = mergeHandoff(prev, ['goal'], { goal: VALID_SECTIONS.goal.replace('让新会话', '让下一个新会话') }).text;
  // 取一个大跨度：decisions 到 open_questions 的全部内容，必须原样搬过来
  const span = (t) => {
    const s = t.indexOf('<!-- handoff:section id=decisions -->');
    const e = t.indexOf('<!-- /handoff:section -->', t.indexOf('<!-- handoff:section id=open_questions -->'));
    return t.slice(s, e);
  };
  assert.equal(span(next), span(prev), 'decisions→open_questions 区段必须逐字节保留');
});

test('变异：声明了变化但没给新内容 ⇒ 抛错（不许静默产出）', () => {
  const prev = validHandoff();
  assert.throws(() => mergeHandoff(prev, ['status'], {}), /未提供新内容/);
});

test('变异：提供了未声明变化的节 ⇒ 抛错（偷偷改一节必须被拦）', () => {
  const prev = validHandoff();
  assert.throws(
    () => mergeHandoff(prev, ['status'], { status: NEW_STATUS, goal: '- 目标：偷改\n- 验收：偷改\n' }),
    /未声明变化的节/,
  );
});

test('变异：未知节 id ⇒ 抛错', () => {
  const prev = validHandoff();
  assert.throws(() => mergeHandoff(prev, ['nope'], { nope: 'x' }), /未知节 id/);
});

test('变异：新内容里塞哨兵 ⇒ 抛错（结构只能由渲染器产出）', () => {
  const prev = validHandoff();
  assert.throws(
    () => mergeHandoff(prev, ['status'], { status: '<!-- /handoff:section -->' }),
    /含哨兵注释/,
  );
});

test('变异：上一版缺该节 ⇒ 抛错（要求改用 init 重建）', () => {
  const prev = validHandoff();
  const open = '<!-- handoff:section id=todo -->';
  const close = '<!-- /handoff:section -->';
  const s = prev.indexOf(open);
  const e = prev.indexOf(close, s) + close.length;
  const broken = prev.slice(0, s) + prev.slice(e);
  assert.throws(() => mergeHandoff(broken, ['todo'], { todo: '- 待办：x\n' }), /缺少节 todo/);
});

test('compare：未变项不改 ⇒ changed 为空（幂等可观测）', () => {
  const prev = validHandoff();
  const next = mergeHandoff(prev, ['status'], { status: NEW_STATUS }).text;
  const self = compareHandoffs(prev, prev);
  assert.equal(self.identical, true);
  assert.deepEqual(self.changed, []);
  const cmp = compareHandoffs(prev, next);
  assert.deepEqual(cmp.changed, ['status'], `实际 changed=${cmp.changed.join(',')}`);
});

test('compare：节外内容（provenance）变化也算变化（不会漏检）', () => {
  const prev = validHandoff();
  const next = prev.replace('round: 1', 'round: 2');
  const cmp = compareHandoffs(prev, next);
  assert.ok(cmp.changed.includes('__outside__'), `changed=${cmp.changed.join(',')}`);
});

test('compare：新增节/删除节分别登记', () => {
  const prev = validHandoff();
  const open = '<!-- handoff:section id=open_questions -->';
  const close = '<!-- /handoff:section -->';
  const s = prev.indexOf(open);
  const e = prev.indexOf(close, s) + close.length;
  const removed = prev.slice(0, s) + prev.slice(e);
  const cmp = compareHandoffs(prev, removed);
  assert.ok(cmp.removed.includes('open_questions'));
});

test('端到端幂等：三轮循环更新后，未变节的原始文本仍与首轮一致', () => {
  let text = validHandoff();
  const firstSlices = new Map();
  for (const id of SECTIONS) {
    const s = text.indexOf(`<!-- handoff:section id=${id} -->`);
    const e = text.indexOf('<!-- /handoff:section -->', s);
    firstSlices.set(id, text.slice(s, e));
  }
  for (let round = 2; round <= 4; round++) {
    const body = renderRound(round);
    text = mergeHandoff(text, ['status'], { status: body }).text;
    const v = validateHandoff(text);
    assert.equal(v.ok, true, `第 ${round} 轮产物必须判绿：${JSON.stringify(v.errors)}`);
  }
  for (const id of SECTIONS) {
    if (id === 'status') continue;
    const s = text.indexOf(`<!-- handoff:section id=${id} -->`);
    const e = text.indexOf('<!-- /handoff:section -->', s);
    assert.equal(
      text.slice(s, e),
      firstSlices.get(id),
      `经过 3 轮更新后，节 ${id} 的字节仍必须与首轮一致（这是"未变项逐字保留"的最终验收）`,
    );
  }
});

function renderRound(round) {
  return [
    `- 已完成：本体 SKILL.md（第 ${round} 轮复核）`,
    '- 进行中：platforms.md',
    '- 阻塞：无',
    '- 待办：①补 platforms.md ②跑 E1–E4 评审',
    '- 下一步：node scripts/check_handoff.mjs check ./HANDOFF.md',
    '- 验证：node scripts/check_handoff.mjs check ./HANDOFF.md',
    `- 恢复检查点：HEAD=8e39ef6（第 ${round} 轮复核基线）`,
    '',
  ].join('\n');
}

test('renderHandoff 产物过判据（模板不是空面）', () => {
  const text = renderHandoff({ provenance: validProvenance(), sections: VALID_SECTIONS });
  const r = validateHandoff(text);
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
});

test('withSection 夹具工具本身不改变其它节', () => {
  const text = validHandoff();
  const mutated = withSection(text, 'status', NEW_STATUS);
  const cmp = compareHandoffs(text, mutated);
  assert.deepEqual(cmp.changed, ['status']);
});
