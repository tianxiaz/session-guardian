/**
 * 判据 1：字段完整性（缺一即红）
 * 判据 2：空面判红
 *
 * 每条断言都配一个"变异 ⇒ 必须判红"的负控，防止出现"永远为真"的假判据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHandoff, SECTIONS, REQUIRED_ITEMS, parseSections } from '../lib/handoff.mjs';
import { validHandoff, withSection } from './fixtures.mjs';

const codes = (r) => r.errors.map((e) => e.code);

test('基准：完整填写的交接物判绿', () => {
  const r = validateHandoff(validHandoff());
  assert.equal(r.ok, true, `基准样本应当判绿，实际错误：\n${JSON.stringify(r.errors, null, 2)}`);
  assert.deepEqual(r.meta.sections, SECTIONS, '八节齐全且顺序正确');
});

test('变异：空文件 ⇒ 判红（空面）', () => {
  const r = validateHandoff('');
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('E_EMPTY_FILE'));
});

test('变异：删掉一整节 ⇒ 判红 E_SECTION_MISSING', () => {
  const text = validHandoff();
  const start = text.indexOf('<!-- handoff:section id=todo -->');
  const end = text.indexOf('<!-- /handoff:section -->', start) + '<!-- /handoff:section -->'.length;
  const mutated = text.slice(0, start) + text.slice(end);
  const r = validateHandoff(mutated);
  assert.equal(r.ok, false, '缺节必须判红');
  assert.ok(codes(r).includes('E_SECTION_MISSING'), codes(r).join(','));
  assert.ok(r.errors.some((e) => e.detail.includes('todo')));
});

test('变异：节顺序颠倒 ⇒ 判红 E_SECTION_ORDER', () => {
  const text = validHandoff();
  const grab = (id) => {
    const open = `<!-- handoff:section id=${id} -->`;
    const close = '<!-- /handoff:section -->';
    const s = text.indexOf(open);
    const e = text.indexOf(close, s) + close.length;
    return text.slice(s, e);
  };
  const g = grab('goal');
  const s = grab('status');
  const mutated = text.replace(g, '@@GOAL@@').replace(s, g).replace('@@GOAL@@', s);
  const r = validateHandoff(mutated);
  assert.equal(r.ok, false, '顺序错必须判红');
  assert.ok(codes(r).includes('E_SECTION_ORDER'), codes(r).join(','));
});

test('变异：同一节出现两次 ⇒ 判红 E_SECTION_DUPLICATE', () => {
  const text = validHandoff();
  const open = '<!-- handoff:section id=evidence -->';
  const close = '<!-- /handoff:section -->';
  const s = text.indexOf(open);
  const e = text.indexOf(close, s) + close.length;
  const mutated = text.slice(0, e) + '\n' + text.slice(s, e) + text.slice(e);
  const r = validateHandoff(mutated);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('E_SECTION_DUPLICATE'), codes(r).join(','));
});

test('每个节的每个必含子项：删掉它都必须判红', () => {
  for (const id of SECTIONS) {
    for (const key of REQUIRED_ITEMS[id]) {
      const text = validHandoff();
      const body = parseSections(text).sectionsById[id].body;
      const mutatedBody = body
        .split('\n')
        .filter((line) => !new RegExp(`^\\s*[-*]\\s*${key}\\s*[:：]`).test(line))
        .join('\n');
      assert.notEqual(mutatedBody, body, `夹具里应有子项 ${id}.${key}`);
      const r = validateHandoff(withSection(text, id, mutatedBody));
      assert.equal(r.ok, false, `删除 ${id}.${key} 后必须判红`);
      assert.ok(
        codes(r).includes('E_ITEM_MISSING') || codes(r).includes('E_SECTION_EMPTY'),
        `${id}.${key} 删除后应报 E_ITEM_MISSING（或整节塌空时 E_SECTION_EMPTY），实际 ${codes(r).join(',')}`,
      );
    }
  }
});

test('空面判红：节体里子项值留空 ⇒ 判红 E_ITEM_EMPTY', () => {
  const text = validHandoff();
  const body = parseSections(text).sectionsById.status.body.replace(
    /^(\s*[-*]\s*下一步\s*[:：]).*$/m,
    '$1',
  );
  const r = validateHandoff(withSection(text, 'status', body));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('E_ITEM_EMPTY'), codes(r).join(','));
});

test('空面判红：子项只写 TBD 之类占位 ⇒ 判红 E_ITEM_EMPTY', () => {
  for (const placeholder of ['TBD', '...', '—', '待填']) {
    const text = validHandoff();
    const body = parseSections(text).sectionsById.status.body.replace(
      /^(\s*[-*]\s*验证\s*[:：]).*$/m,
      `$1${placeholder}`,
    );
    const r = validateHandoff(withSection(text, 'status', body));
    assert.equal(r.ok, false, `占位符 ${placeholder} 必须判红`);
    assert.ok(codes(r).includes('E_ITEM_EMPTY'), `${placeholder}: ${codes(r).join(',')}`);
  }
});

test('空面判红：模板占位符未删（保留 HANDOFF:CONTENT 且无内容）⇒ 判红', () => {
  const text = validHandoff({
    sections: { evidence: '<!-- HANDOFF:CONTENT -->\n- 提交：\n- 文件：\n- 实测数字：\n' },
  });
  const r = validateHandoff(text);
  assert.equal(r.ok, false);
  assert.ok(
    codes(r).includes('E_ITEM_EMPTY') || codes(r).includes('E_SECTION_EMPTY'),
    codes(r).join(','),
  );
});

test('空面判红：整节只剩注释 ⇒ E_SECTION_EMPTY', () => {
  const text = validHandoff({ sections: { goal: '<!-- HANDOFF:CONTENT -->\n' } });
  const r = validateHandoff(text);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('E_SECTION_EMPTY'), codes(r).join(','));
});

test('显式写"无"是合法的（区分"没有"与"没写"）', () => {
  const text = validHandoff({
    sections: { open_questions: '- 待裁决：无\n', status: parseSections(validHandoff()).sectionsById.status.body.replace(/^(\s*[-*]\s*阻塞\s*[:：]).*$/m, '$1无') },
  });
  const r = validateHandoff(text);
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
});

test('判据 3 的正控：status.待办 与 todo.待办 不一致 ⇒ 判红 E_TODO_MISMATCH', () => {
  const text = validHandoff({ sections: { todo: '- 待办：只有一条\n' } });
  const r = validateHandoff(text);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('E_TODO_MISMATCH'), codes(r).join(','));
});

test('判据 3 的正控：两处待办一致时判绿（不是永远红）', () => {
  const text = validHandoff();
  const r = validateHandoff(text);
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
});

test('provenance：缺区块 ⇒ 判红', () => {
  const text = validHandoff();
  const s = text.indexOf('<!-- handoff:provenance -->');
  const e = text.indexOf('<!-- /handoff:provenance -->') + '<!-- /handoff:provenance -->'.length;
  const r = validateHandoff(text.slice(0, s) + text.slice(e));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('E_PROVENANCE_MISSING'), codes(r).join(','));
});

test('provenance：六个必填键逐个删掉都必须判红', () => {
  for (const key of ['version', 'round', 'updated_utc', 'workspace', 'trigger', 'status']) {
    const text = validHandoff().replace(new RegExp(`^${key}:.*$`, 'm'), '');
    const r = validateHandoff(text);
    assert.equal(r.ok, false, `删掉 provenance.${key} 必须判红`);
    assert.ok(
      codes(r).some((c) => c.startsWith('E_PROVENANCE_')),
      `${key}: ${codes(r).join(',')}`,
    );
  }
});

test('provenance：trigger 取值非法 ⇒ 判红（不许把自估写成外部阈值）', () => {
  const r = validateHandoff(validHandoff({ provenance: { trigger: 'threshold-reached' } }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('E_PROVENANCE_TRIGGER'), codes(r).join(','));
});

test('provenance：trigger=self-estimate 合法（如实标注不算错）', () => {
  const r = validateHandoff(validHandoff({ provenance: { trigger: 'self-estimate', occupancy: 'unavailable', occupancy_source: 'unavailable' } }));
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
});

test('provenance：occupancy 超范围/非数字 ⇒ 判红', () => {
  for (const v of ['1.5', 'abc', '-0.2']) {
    const r = validateHandoff(validHandoff({ provenance: { occupancy: v } }));
    assert.equal(r.ok, false, `occupancy=${v} 必须判红`);
    assert.ok(codes(r).includes('E_PROVENANCE_OCCUPANCY'), `${v}: ${codes(r).join(',')}`);
  }
});

test('provenance：occupancy 写 unavailable 合法（取不到就如实说）', () => {
  const r = validateHandoff(validHandoff({ provenance: { occupancy: 'unavailable', occupancy_source: 'unavailable' } }));
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
});

test('provenance：updated_utc 格式不对 ⇒ 判红', () => {
  const r = validateHandoff(validHandoff({ provenance: { updated_utc: '2026-10-16 15:30' } }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('E_PROVENANCE_UTC'), codes(r).join(','));
});

test('警告而非错误：boundaries.禁止 写成"无" ⇒ 只警告不判红', () => {
  const text = validHandoff({
    sections: { boundaries: '- 可改：无\n- 禁止：无\n- 归属未定：无\n' },
  });
  const r = validateHandoff(text);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === 'W_NO_BOUNDARY'), '没有禁区应当给警告');
});
