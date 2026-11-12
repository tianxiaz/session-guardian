/**
 * 变异能红（end-to-end，走真实 CLI + 真实文件系统）
 *
 * 这是"判据不放宽"的最终背书：先在真文件上判绿，再对同一文件做**微小真实变异**，
 * 同一命令必须判红；还原后必须再次判绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateHandoff, SECTIONS, parseSections } from '../lib/handoff.mjs';
import { validHandoff, withSection } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'check_handoff.mjs');

function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'ctx-handoff-mut-'));
  return d;
}

test('CLI：绿样本 exit 0，删掉一节 exit 2，还原后 exit 0', () => {
  const dir = tmpDir();
  try {
    const f = join(dir, 'HANDOFF.md');
    const good = validHandoff();
    writeFileSync(f, good, 'utf8');

    const ok1 = runCli(['check', f]);
    assert.equal(ok1.code, 0, `基准必须 exit 0，实际 ${ok1.code}\n${ok1.stdout}${ok1.stderr}`);

    // 微小真实变异：删掉 boundaries 整节
    const open = '<!-- handoff:section id=boundaries -->';
    const close = '<!-- /handoff:section -->';
    const s = good.indexOf(open);
    const e = good.indexOf(close, s) + close.length;
    const mutated = good.slice(0, s) + good.slice(e);
    writeFileSync(f, mutated, 'utf8');
    const red = runCli(['check', f]);
    assert.equal(red.code, 2, `缺节必须 exit 2，实际 ${red.code}\n${red.stdout}`);
    assert.match(red.stdout + red.stderr, /E_SECTION_MISSING/);

    // 还原 ⇒ 必须再次判绿
    writeFileSync(f, good, 'utf8');
    const ok2 = runCli(['check', f]);
    assert.equal(ok2.code, 0, `还原后必须 exit 0，实际 ${ok2.code}\n${ok2.stdout}${ok2.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI：单行内容变异（把"禁止"改成"无"）只降级为警告，但删掉"禁止"判红', () => {
  const dir = tmpDir();
  try {
    const f = join(dir, 'HANDOFF.md');
    const good = validHandoff();
    writeFileSync(f, good, 'utf8');

    const warnCase = good.replace(
      /^(\s*[-*]\s*禁止\s*[:：]).*$/m,
      '$1无',
    );
    writeFileSync(f, warnCase, 'utf8');
    const w = runCli(['check', f, '--json']);
    assert.equal(w.code, 0, `把禁止写成"无"应只警告，实际 ${w.code}`);
    const parsed = JSON.parse(w.stdout);
    assert.ok(parsed.warnings.some((x) => x.code === 'W_NO_BOUNDARY'));

    // 真变异：删掉"禁止"这一行 ⇒ 必须判红
    const redCase = good.replace(/^\s*[-*]\s*禁止\s*[:：].*$\n?/m, '');
    writeFileSync(f, redCase, 'utf8');
    const r = runCli(['check', f]);
    assert.equal(r.code, 2, '删掉必填子项必须判红');
    assert.match(r.stdout + r.stderr, /E_ITEM_MISSING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI：合法 JSON 但语义为空面 ⇒ exit 2（不是"解析成功就算过"）', () => {
  const dir = tmpDir();
  try {
    const f = join(dir, 'HANDOFF.md');
    const text = validHandoff({
      sections: { status: parseSections(validHandoff()).sectionsById.status.body.replace(/^(\s*[-*]\s*下一步\s*[:：]).*$/m, '$1') },
    });
    writeFileSync(f, text, 'utf8');
    const r = runCli(['check', f, '--json']);
    assert.equal(r.code, 2);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.errors.some((e) => e.code === 'E_ITEM_EMPTY'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI next：未变节逐字节保留，且产物判绿；同 payload 两次结果相同（幂等）', () => {
  const dir = tmpDir();
  try {
    const prev = join(dir, 'HANDOFF.md');
    writeFileSync(prev, validHandoff(), 'utf8');
    const newStatus = '- 已完成：a\n- 进行中：b\n- 阻塞：无\n- 待办：①补 platforms.md ②跑 E1–E4 评审\n- 下一步：node x\n- 验证：node y\n- 恢复检查点：HEAD=8e39ef6\n';
    const payload = join(dir, 'p.json');
    writeFileSync(payload, JSON.stringify({ changed: ['status'], sections: { status: newStatus } }), 'utf8');

    const r1 = runCli(['next', prev, '--payload', payload, '--out', join(dir, 'v2.md')]);
    assert.equal(r1.code, 0, `next 必须成功：${r1.stdout}${r1.stderr}`);
    const v2 = readFileSync(join(dir, 'v2.md'), 'utf8');
    assert.equal(validateHandoff(v2).ok, true, JSON.stringify(validateHandoff(v2).errors));

    for (const id of SECTIONS) {
      if (id === 'status') continue;
      const open = `<!-- handoff:section id=${id} -->`;
      const seg = (t) => t.slice(t.indexOf(open), t.indexOf('<!-- /handoff:section -->', t.indexOf(open)));
      assert.equal(seg(v2), seg(readFileSync(prev, 'utf8')), `节 ${id} 必须逐字节保留`);
    }

    // 幂等：以 v2 为基准再合并同一内容 ⇒ 逐字节相同
    const r2 = runCli(['next', join(dir, 'v2.md'), '--payload', payload, '--out', join(dir, 'v3.md')]);
    assert.equal(r2.code, 0, `${r2.stdout}${r2.stderr}`);
    assert.equal(readFileSync(join(dir, 'v3.md'), 'utf8'), v2, '同 payload 连跑两次必须逐字节相同');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI next：声明变化但内容相同 ⇒ 产物仍判绿，但 --changed 会被 compare 抓出（E_DECLARED_BUT_IDENTICAL）', () => {
  const dir = tmpDir();
  try {
    const prev = join(dir, 'HANDOFF.md');
    const good = validHandoff();
    writeFileSync(prev, good, 'utf8');
    const statusBody = parseSections(good).sectionsById.status.body;
    const payload = join(dir, 'p.json');
    writeFileSync(payload, JSON.stringify({ changed: ['status'], sections: { status: statusBody } }), 'utf8');
    const r = runCli(['next', prev, '--payload', payload, '--out', join(dir, 'same.md')]);
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(join(dir, 'same.md'), 'utf8'), good, '内容相同则应逐字节相同');

    const chk = runCli(['check', join(dir, 'same.md'), '--against', prev, '--changed', 'status', '--json']);
    assert.equal(chk.code, 2, '声明了变化却没有差异，必须判红');
    const parsed = JSON.parse(chk.stdout);
    assert.ok(
      parsed.errors.some((e) => e.code === 'E_DECLARED_BUT_IDENTICAL'),
      JSON.stringify(parsed.errors),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI check --against：未声明就改了一节 ⇒ E_UNDECLARED_CHANGE', () => {
  const dir = tmpDir();
  try {
    const prev = join(dir, 'HANDOFF.md');
    const good = validHandoff();
    writeFileSync(prev, good, 'utf8');
    const next = join(dir, 'next.md');
    writeFileSync(next, withSection(good, 'goal', '- 目标：被偷改\n- 验收：被偷改\n'), 'utf8');
    const r = runCli(['check', next, '--against', prev, '--changed', 'status', '--json']);
    assert.equal(r.code, 2);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.errors.some((e) => e.code === 'E_UNDECLARED_CHANGE'), JSON.stringify(parsed.errors));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI init：已存在则拒绝（exit 3），绝不覆盖', () => {
  const dir = tmpDir();
  try {
    const f = join(dir, 'HANDOFF.md');
    const r1 = runCli(['init', f]);
    assert.equal(r1.code, 0, `${r1.stdout}${r1.stderr}`);
    const before = readFileSync(f, 'utf8');
    const r2 = runCli(['init', f]);
    assert.equal(r2.code, 3, '对已存在文件 init 必须拒绝');
    assert.equal(readFileSync(f, 'utf8'), before, '拒绝时不得改动文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI init 产物：判红（骨架未填）——证明"空面必须判红"在真实模板上成立', () => {
  const dir = tmpDir();
  try {
    const f = join(dir, 'HANDOFF.md');
    runCli(['init', f]);
    const r = runCli(['check', f, '--json']);
    assert.equal(r.code, 2, '未填写的骨架必须判红（空面判红）');
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.errors.some((e) => e.code === 'E_ITEM_EMPTY' || e.code === 'E_SECTION_EMPTY'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI next：--expect-mtime 不匹配 ⇒ exit 4（并发冲突不覆盖）', () => {
  const dir = tmpDir();
  try {
    const prev = join(dir, 'HANDOFF.md');
    writeFileSync(prev, validHandoff(), 'utf8');
    const payload = join(dir, 'p.json');
    writeFileSync(payload, JSON.stringify({ changed: ['status'], sections: { status: '- 已完成：a\n- 进行中：b\n- 阻塞：无\n- 待办：x\n- 下一步：y\n- 验证：z\n' } }), 'utf8');
    const r = runCli(['next', prev, '--payload', payload, '--expect-mtime', '1', '--out', join(dir, 'o.md')]);
    assert.equal(r.code, 4, `期望冲突 exit 4，实际 ${r.code}\n${r.stdout}${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('measure：本机 DSH 能取到真实量化占用（取不到则如实 UNAVAILABLE，不许编）', () => {
  const r = runCli(['measure', '--workspace', process.cwd(), '--json']);
  // E3 评审 F10：「取不到占用」是**正常降级**不是错误 ⇒ 只允许 exit 0。
  assert.equal(r.code, 0, `measure 取不到时必须 exit 0（正常降级）；实际 ${r.code}\n${r.stdout}${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  if (parsed.ok) {
    assert.ok(parsed.occupancy >= 0 && parsed.occupancy <= 1, `占用必须在 0–1：${parsed.occupancy}`);
    assert.ok(parsed.source && parsed.source !== 'unavailable', '成功时必须给出 source');
    assert.ok(parsed.raw && parsed.raw.contextWindow > 0, '必须给出分母');
  } else {
    assert.equal(parsed.source, 'unavailable');
    assert.ok(parsed.reason && parsed.reason.length > 0, '取不到必须给出原因');
  }
});
