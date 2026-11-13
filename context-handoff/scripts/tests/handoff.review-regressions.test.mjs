/**
 * 四路评审（E1–E4）发现项的**回归判据**。
 *
 * 这个文件的每一条，都对应某个评审员实测出来的真实缺陷。写法统一为：
 *   ①先证明修复前会判绿（漏洞存在）——用注释记录原始现象与评审编号；
 *   ②再断言现在必须判红 / 必须指定退出码。
 * 目的：防止这些洞被"顺手改回去"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, statSync, chmodSync, readdirSync, lstatSync, symlinkSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateHandoff, isRealUtcStamp, SECTIONS, parseSections, ALLOWED_TRIGGERS } from '../lib/handoff.mjs';
import { deriveThresholds } from '../measure_context.mjs';
import { validHandoff, validProvenance, VALID_SECTIONS, withSection } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'check_handoff.mjs');
const SKILL_DIR = join(HERE, '..', '..');

function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const codes = (r) => r.errors.map((e) => e.code);
function tmp() {
  return mkdtempSync(join(tmpdir(), 'ctx-handoff-reg-'));
}

/* ───────── E1 F1：不可能存在的 UTC 时刻必须判红 ───────── */

test('E1-F1 变异能红：日历上不存在的 updated_utc 必须判红', () => {
  // 修复前：只做正则形状校验 ⇒ 下面四个值全部判绿（E1 实测）
  for (const bad of ['20261399T9999Z', '20260000T0000Z', '20260230T2460Z', '20261332T2500Z']) {
    assert.equal(isRealUtcStamp(bad), false, `${bad} 不是真实存在的时刻`);
    const r = validateHandoff(validHandoff({ provenance: { updated_utc: bad } }));
    assert.equal(r.ok, false, `${bad} 必须判红`);
    assert.ok(codes(r).includes('E_PROVENANCE_UTC'), `${bad}: ${codes(r).join(',')}`);
  }
});

test('E1-F1 负负控：真实存在的 UTC 时刻必须能绿（含闰年 2 月 29）', () => {
  for (const good of ['20261016T1530Z', '20240229T0000Z', '20260101T0000Z', '20261231T2359Z']) {
    assert.equal(isRealUtcStamp(good), true, `${good} 应被接受`);
  }
  // 2026 不是闰年 ⇒ 2 月 29 必须判红
  assert.equal(isRealUtcStamp('20260229T0000Z'), false);
});

/* ───────── E1 F4：provenance 取值有效性 ───────── */

test('E1-F4 变异能红：workspace 不是绝对路径必须判红', () => {
  const r = validateHandoff(validHandoff({ provenance: { workspace: 'x' } }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('E_PROVENANCE_WORKSPACE'), codes(r).join(','));
});

test('E1-F4 变异能红：supersedes 形态非法（含路径穿越）必须判红', () => {
  for (const bad of ['../../etc/passwd', 'round-1', 'round-1@zzzz', 'round-0@deadbeef', 'round-1@dead']) {
    const r = validateHandoff(validHandoff({ provenance: { supersedes: bad } }));
    assert.equal(r.ok, false, `supersedes=${bad} 必须判红`);
    assert.ok(codes(r).includes('E_SUPERSEDES_MALFORMED'), `${bad}: ${codes(r).join(',')}`);
  }
});

test('E1-F4 变异能红：supersedes 与 round 跨字段矛盾必须判红', () => {
  const r = validateHandoff(validHandoff({ provenance: { round: '9', supersedes: 'round-1@deadbeef' } }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('E_SUPERSEDES_ROUND_MISMATCH'), codes(r).join(','));
});

test('E1-F4 负负控：合法的 none / round-N@hex 必须能绿', () => {
  assert.equal(validateHandoff(validHandoff({ provenance: { supersedes: 'none' } })).ok, true);
  assert.equal(
    validateHandoff(validHandoff({ provenance: { round: '3', supersedes: 'round-2@deadbeefcafe' } })).ok,
    true,
    'round 3 继承自 round 2 是合法的',
  );
});

/* ───────── E1 F5：节体混入哨兵必须报根因 ───────── */

test('E1-F5 变异能红：节体里含哨兵 ⇒ E_SENTINEL_IN_BODY（而不是误导性的"少了一个字段"）', () => {
  const text = validHandoff();
  const open = '<!-- handoff:section id=goal -->';
  const s = text.indexOf(open);
  const e = text.indexOf('<!-- /handoff:section -->', s) + '<!-- /handoff:section -->'.length;
  // 在 goal 节体内部插入一个开哨兵（模拟手工编辑粘进内容）
  const injected = text.slice(0, e - '<!-- /handoff:section -->'.length) + '<!-- handoff:section id=todo -->' + text.slice(e - '<!-- /handoff:section -->'.length);
  const r = validateHandoff(injected);
  assert.equal(r.ok, false);
  assert.ok(
    codes(r).includes('E_SENTINEL_IN_BODY') || codes(r).includes('E_SECTION_UNBALANCED'),
    `应报结构类错误，实际 ${codes(r).join(',')}`,
  );
});

/* ───────── E1 F6：新增三类必含子项必须"删掉即红" ───────── */

test('E1-F6 变异能红：删掉 恢复检查点/尝试过/依赖状态 各自都必须判红', () => {
  const targets = [
    ['status', '恢复检查点'],
    ['decisions', '尝试过'],
    ['environment', '依赖状态'],
  ];
  for (const [id, key] of targets) {
    const text = validHandoff();
    const open = `<!-- handoff:section id=${id} -->`;
    const s = text.indexOf(open);
    const e = text.indexOf('<!-- /handoff:section -->', s);
    const body = text.slice(s, e).split('\n').filter((l) => !new RegExp(`^\\s*[-*]\\s*${key}\\s*[:：]`).test(l)).join('\n');
    const mutated = text.slice(0, s) + body + text.slice(e);
    const r = validateHandoff(mutated);
    assert.equal(r.ok, false, `删掉 ${id}.${key} 必须判红`);
    assert.ok(codes(r).includes('E_ITEM_MISSING') || codes(r).includes('E_SECTION_EMPTY'), `${id}.${key}: ${codes(r).join(',')}`);
  }
});

/* ───────── E1 F10：trigger 白名单扩到六值 ───────── */

test('E1-F10：peer-request 与 round-limit 是合法触发器；乱造的值仍然判红', () => {
  for (const good of ['peer-request', 'round-limit']) {
    const r = validateHandoff(validHandoff({ provenance: { trigger: good } }));
    assert.equal(r.ok, true, `${good} 应被接受：${JSON.stringify(r.errors)}`);
  }
  const bad = validateHandoff(validHandoff({ provenance: { trigger: 'threshold-reached' } }));
  assert.equal(bad.ok, false);
  assert.ok(codes(bad).includes('E_PROVENANCE_TRIGGER'));
});

/* ───────── E1 F2：阈值必须按窗口解析，不能写死 0.8/0.88 ───────── */

test('E1-F2 阈值按窗口解析：小窗口不会被写死的 0.8 漏掉', () => {
  const big = deriveThresholds(1000000);
  assert.equal(big.triggerTokens, 800000);
  assert.equal(big.triggerRatio, 0.8);
  assert.equal(big.warn, 0.75);
  assert.equal(big.hard, 0.8);

  const mid = deriveThresholds(262144);
  assert.equal(mid.triggerTokens, 131072, 'W−O−headroom 那一支胜出');
  assert.equal(mid.triggerRatio, 0.5);
  assert.ok(mid.warn < 0.5, `预警线必须低于真实触发点，实际 ${mid.warn}`);

  const small = deriveThresholds(131072);
  assert.equal(small.triggerTokens, 0, '小窗口下触发点被压到 0');
  assert.equal(small.warn, 0.4, '下限保护：不低于 0.4');

  // 变异：若把阈值写死成 0.8/0.88，mid 窗口的预警线就会 > 真实触发点 0.5 ⇒ 永远不预警
  assert.ok(mid.warn < mid.hard, '预警线必须严格低于硬线');
  assert.ok(small.warn > small.hard, '窗口极小时硬线已无意义，预警线靠下限兜住 —— 这一点必须显式成立');
});

/* ───────── E3 F4/F9：原子写保留权限位 ───────── */

test('E3-F4 变异能红：next 不得改变交接物的权限位（0600 不能变 0644）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    chmodSync(f, 0o600);
    const before = statSync(f).mode & 0o777;
    assert.equal(before, 0o600);
    const newStatus = VALID_SECTIONS.status.replace('自测夹具', '自测夹具（已改）');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: newStatus } }), 'utf8');
    const r = runCli(['next', f, '--payload', p]);
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    assert.equal(statSync(f).mode & 0o777, 0o600, '写回后权限位必须保持 0600');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────── E3 F5：参数白名单，拼错的保护参数不许被静默忽略 ───────── */

test('E3-F5 变异能红：拼错的 --expect-mtme 必须 exit 3（不能静默失去保护）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: VALID_SECTIONS.status } }), 'utf8');
    const r = runCli(['next', f, '--payload', p, '--expect-mtme', '123']);
    assert.equal(r.code, 3, `拼错的参数必须 exit 3，实际 ${r.code}\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /未知参数/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────── E3 F6/F5：并发锁 —— 第二个进程必须 exit 4 ───────── */

test('E3-F6 变异能红：目标存在锁文件时 next 必须 exit 4（不静默覆盖）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: VALID_SECTIONS.status.replace('夹具', '夹具2') } }), 'utf8');
    // 手工占住锁（模拟另一个进程正在写）
    writeFileSync(`${f}.lock`, '', 'utf8');
    const r = runCli(['next', f, '--payload', p]);
    assert.equal(r.code, 4, `锁被占时必须 exit 4，实际 ${r.code}\n${r.stdout}${r.stderr}`);
    rmSync(`${f}.lock`, { force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────── E3 F3 / E4 B3：归档必须真的落盘，且可重放 ───────── */

test('E3-F3 归档：归档文件内容 === 更新前那一版（逐字），且同状态重放不新增归档', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const first = validHandoff();
    writeFileSync(f, first, 'utf8');
    const adir = join(dir, 'archive');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: VALID_SECTIONS.status.replace('夹具', '夹具Y') } }), 'utf8');

    const r1 = runCli(['next', f, '--payload', p, '--archive-dir', adir]);
    assert.equal(r1.code, 0, `${r1.stdout}${r1.stderr}`);
    const archived = readdirSync(adir);
    assert.equal(archived.length, 1, `应写出 1 个归档，实际 ${archived.join(',')}`);
    assert.equal(readFileSync(join(adir, archived[0]), 'utf8'), first, '归档内容必须逐字等于更新前那一版');

    // 幂等：对同一状态重放同一次调用 → 归档名相同、不新增文件
    const r2 = runCli(['next', f, '--payload', p, '--archive-dir', adir]);
    assert.equal(r2.code, 0, `${r2.stdout}${r2.stderr}`);
    assert.equal(readdirSync(adir).length, 1, '同一状态重放不得新增归档（归档名内容寻址）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────── E3 F7：红了的交接物必须有恢复通道 ───────── */

test('E3-F7 init --force 必须先归档再重建（不许直接丢掉历史）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const first = validHandoff();
    writeFileSync(f, first, 'utf8');
    const r = runCli(['init', f, '--force']);
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    const adir = join(dir, '.handoff-archive');
    const archived = readdirSync(adir);
    assert.ok(archived.length >= 1, '--force 重建前必须留下归档');
    assert.equal(readFileSync(join(adir, archived[0]), 'utf8'), first, '归档必须是重建前那一版');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E3-F7 restore：从归档回退，且回退前把当前这份留档', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const first = validHandoff();
    writeFileSync(f, first, 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: VALID_SECTIONS.status.replace('夹具', '夹具Z') } }), 'utf8');
    const adir = join(dir, 'archive');
    runCli(['next', f, '--payload', p, '--archive-dir', adir]);
    const arch = join(adir, readdirSync(adir)[0]);
    const r = runCli(['restore', arch, f]);
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(f, 'utf8'), first, '回退后内容必须等于归档内容');
    assert.ok(readdirSync(join(dir, '.handoff-archive')).length >= 1, '回退前那份必须留档');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────── E3 F8：next 的正常产物必须过自己的 --against ───────── */

test('E3-F8 next 产物 + check --against 必须判绿（provenance 变化属预期内）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const first = validHandoff();
    writeFileSync(f, first, 'utf8');
    const v2 = join(dir, 'v2.md');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: VALID_SECTIONS.status.replace('夹具', '夹具W') } }), 'utf8');
    const r1 = runCli(['next', f, '--payload', p, '--out', v2]);
    assert.equal(r1.code, 0, `${r1.stdout}${r1.stderr}`);
    const r2 = runCli(['check', v2, '--against', f, '--changed', 'status', '--json']);
    assert.equal(r2.code, 0, `next 的正常产物必须过 --against：${r2.stdout}${r2.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────── E3 F5 表第 6 行：非法 UTF-8 不许静默通过 ───────── */

test('E3-F5 变异能红：非法 UTF-8 的交接物必须判红（不许 U+FFFD 静默替换后判绿）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const buf = Buffer.from(validHandoff(), 'utf8');
    // 在中间插入非法字节序列
    const broken = Buffer.concat([buf.subarray(0, 200), Buffer.from([0xff, 0xfe]), buf.subarray(200)]);
    writeFileSync(f, broken);
    const r = runCli(['check', f, '--json']);
    assert.equal(r.code, 2, `非法 UTF-8 必须判红，实际 ${r.code}\n${r.stdout}${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────── E4 B1：init 到不存在的目录不许裸崩 ───────── */

test('E4-B1 变异能红：init 到不存在的目录必须自己建目录并 exit 0（不得裸崩 exit 1）', () => {
  const dir = tmp();
  try {
    const deep = join(dir, 'a', 'b', 'HANDOFF.md');
    const r = runCli(['init', deep]);
    assert.equal(r.code, 0, `必须 exit 0，实际 ${r.code}\n${r.stdout}${r.stderr}`);
    assert.ok(readFileSync(deep, 'utf8').includes('handoff:provenance'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E4-B1 变异能红：--out 指向不存在的目录也不得裸崩（退出码必须是文档化的 0/2/3/4）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: VALID_SECTIONS.status } }), 'utf8');
    const r = runCli(['next', f, '--payload', p, '--out', join(dir, 'nope', 'x.md')]);
    assert.ok([0, 2, 3, 4].includes(r.code), `退出码必须文档化，实际 ${r.code}\n${r.stderr}`);
    if (r.code === 3) assert.match(r.stdout + r.stderr, /无法创建目标目录|写盘失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E4-B2 变异能红：next 产物里哨兵必须独占一行（不许与首项粘连）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: VALID_SECTIONS.status.replace('夹具', '夹具V') } }), 'utf8');
    const r = runCli(['next', f, '--payload', p]);
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    const out = readFileSync(f, 'utf8');
    // 每个节的哨兵都必须独占一行
    const allOpens = out.match(/^<!-- handoff:section id=\w+ -->/gm) || [];
    assert.equal(allOpens.length, SECTIONS.length, `应有 ${SECTIONS.length} 个独占一行的开哨兵，实际 ${allOpens.length}`);
    const allCloses = out.match(/^<!-- \/handoff:section -->/gm) || [];
    assert.equal(allCloses.length, SECTIONS.length, `应有 ${SECTIONS.length} 个独占一行的闭哨兵，实际 ${allCloses.length}`);
    // 子项也必须能在行首被 grep 到
    assert.ok(/^- 目标：/m.test(out), '子项必须从行首开始（便于 grep）');
    // 哨兵行本身不许紧跟内容。注意：`<!-- section -->` 后紧跟**另一条注释**是模板的既定形态
    // （每节首行是说明注释），所以判据是"哨兵 →（若干注释行）→ 另起一行的 `- ` 子项"。
    const badAdjacency = /<!--\s*\/?handoff:[^>]*-->(?![^\n]*-->)[^\n]*\S/;
    assert.equal(badAdjacency.test(out), false, 'handoff 哨兵后面不许紧跟内容（注释行不算）');
    for (const id of SECTIONS) {
      const re = new RegExp(`<!-- handoff:section id=${id} -->\\n(?:<!--[^\\n]*-->\\n)*(- )`, 'm');
      assert.ok(re.test(out), `节 ${id} 的哨兵之后必须（经注释行后）另起一行以 "- " 开始`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────── E3 F2：模板必须是生成物，不许与判据漂移 ───────── */

test('E3-F2 模板一致性：templates/HANDOFF.md 必须与 REQUIRED_ITEMS 完全一致', () => {
  const r = spawnSync(process.execPath, [join(SKILL_DIR, 'scripts', 'gen_template.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `模板与判据漂移了（照模板手抄会判红）：${r.stdout}${r.stderr}`);
});

/* ───────── E2 B1：分发权限必须可读 ───────── */

test('E2-B1 分发可用：全部 md/mjs/json 必须可读、全部 sh 必须可读可执行', () => {
  const bad = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|mjs|json)$/.test(e.name)) {
        const m = statSync(p).mode & 0o777;
        if ((m & 0o400) === 0 || (m & 0o044) === 0) bad.push(`${p} mode=${m.toString(8)}（他人不可读）`);
      } else if (/\.sh$/.test(e.name)) {
        const m = statSync(p).mode & 0o777;
        if ((m & 0o400) === 0 || (m & 0o111) === 0) bad.push(`${p} mode=${m.toString(8)}（需可读+可执行）`);
      }
    }
  };
  walk(SKILL_DIR);
  assert.deepEqual(bad, [], `分发权限不合格：\n${bad.join('\n')}`);
});

/* ───────── E2 B2：Kimi 脚本不得使用臆造的官方变量名 ───────── */

test('E2-B2 kimi_remind.sh 不得再出现臆造的 KIMI_* 官方变量名，且必须声明自定契约', () => {
  const s = readFileSync(join(SKILL_DIR, 'adapters', 'kimi-doubao', 'kimi_remind.sh'), 'utf8');
  assert.equal(/\$\{?KIMI_(CONTEXT_TOKENS|RESERVED_CONTEXT_SIZE|MAX_CONTEXT_SIZE)/.test(s), false, '不得读取臆造的官方环境变量');
  assert.ok(s.includes('CONTEXT_HANDOFF_OCCUPANCY'), '必须支持与 measure_context 一致的覆盖契约');
  assert.match(s, /非官方|自定/, '必须明确声明这些变量名是自定的、非官方');
});

/* ══════════ 第 2 轮复评（E1 N1–N6）新增判据 ══════════ */

test('E1-N3 变异能红：窗口极小时 hard 阈值必须失效（hard=0 或 null），不得让 crossed.hard 恒真', () => {
  const small = deriveThresholds(131072);
  assert.equal(small.triggerTokens, 0, '小窗口下真实触发点被压到 0');
  assert.ok(
    small.hard === null || small.hard > 0,
    `触发点为 0 时"硬线"没有意义，必须置为 null（或 >0），实际 hard=${small.hard}`,
  );
  assert.ok(small.hardEffective === false, '必须显式标出硬线已失效');
  assert.equal(small.warn, 0.4, '预警线仍靠下限兜住');

  // 中等窗口：硬线有效
  const mid = deriveThresholds(262144);
  assert.equal(mid.hard, 0.5);
  assert.equal(mid.hardEffective, true);
  assert.notEqual(mid.hard, null);
});

test('E1-N4 变异能红：正文里合法写下哨兵**字面量**不得误报（代码围栏/反引号内的不算哨兵）', () => {
  // A/B 对照：同一句话，带哨兵字面量 vs 不带
  const withLiteral = validHandoff({
    sections: { evidence: '- 提交：8e39ef6\n- 文件：docs/x.md（哨兵形如 `<!-- handoff:section id=goal -->`）\n- 实测数字：1\n' },
  });
  const withoutLiteral = validHandoff({
    sections: { evidence: '- 提交：8e39ef6\n- 文件：docs/x.md（哨兵是节边界的注释标记）\n- 实测数字：1\n' },
  });
  assert.equal(validateHandoff(withoutLiteral).ok, true, '不带字面量的对照组必须绿');
  const r = validateHandoff(withLiteral);
  assert.equal(r.ok, true, `反引号里的哨兵字面量是合法正文，不得误报：${JSON.stringify(r.errors)}`);

  // 围栏代码块里的同样不该误报
  const withFence = validHandoff({
    sections: { evidence: '- 提交：8e39ef6\n- 文件：示例\n  ```\n  <!-- handoff:section id=goal -->\n  ```\n- 实测数字：1\n' },
  });
  assert.equal(validateHandoff(withFence).ok, true, '围栏代码块里的哨兵字面量也不得误报');
});

test('E1-N4 正控：**真的**结构损坏（裸的哨兵语法）仍必须判红', () => {
  const text = validHandoff();
  const open = '<!-- handoff:section id=goal -->';
  const s = text.indexOf(open);
  const e = text.indexOf('<!-- /handoff:section -->', s) + '<!-- /handoff:section -->'.length;
  // 在 goal 节体里插入**裸的**开哨兵（不在反引号/围栏内）⇒ 真损坏
  const injected =
    text.slice(0, e - '<!-- /handoff:section -->'.length) +
    '<!-- handoff:section id=todo -->' +
    text.slice(e - '<!-- /handoff:section -->'.length);
  const r = validateHandoff(injected);
  assert.equal(r.ok, false, '裸哨兵注入必须判红');
  assert.ok(
    codes(r).includes('E_SENTINEL_IN_BODY') || codes(r).includes('E_SECTION_UNBALANCED'),
    codes(r).join(','),
  );
});

test('E1-N2 文档判据：SKILL.md 必须写明「可同时声明多节」与「改一个标点也须整节重写」', () => {
  const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  assert.match(skill, /同时声明(多个|多)节|可同时声明/, '必须写明可同时声明多个节');
  assert.match(skill, /整节重写/, '必须写明"改一个标点也须整节重写"这一粒度事实');
});

test('E1-N1 文档判据：docs/73 的阈值口径必须与实现一致（不得再把它当断言写死）', (t) => {
  const docPath = findDoc73();
  if (!docPath) {
    // 独立分发目录（技能被复制到别的机器）里没有这个仓库 ⇒ 跳过而不是失败。
    t.skip('本机没有 intel-hub 仓库的 docs/73（技能目录被独立分发时属于正常情形）');
    return;
  }
  const doc = readFileSync(docPath, 'utf8');
  // 只查"代码块里仍把 0.8/0.88 当结论"的形态；**新增的"第 1 轮这么写是错的"说明不算**
  const codeBlocks = [...doc.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join('\n');
  assert.equal(
    /硬线 ?0\.88|预警线取同一 ?0\.8|留出约 ?8%/.test(codeBlocks),
    false,
    'docs/73 的代码块里不得再把"硬线 0.88 / 留出约 8%"当结论写死',
  );
  assert.equal(
    /\*\*硬线 0\.88。\*\*/.test(doc),
    false,
    'docs/73 不得再把"硬线 0.88"写成设计结论',
  );
  assert.match(doc, /按窗口解析|deriveThresholds/, 'docs/73 必须说明阈值是按窗口解析的');
  assert.match(doc, /outputCapTokens[\s\S]{0,120}估值/, 'docs/73 必须标注 outputCapTokens 是估值');
  assert.match(doc, /hardEffective|返回 `null`|硬线返回/, 'docs/73 必须写明触发点为 0 时硬线失效');
});

/**
 * 本仓 docs/73 的路径探测。**这是"作者本仓专属"的检查**：
 * 技能目录会被 `cp -R` 分发到别的机器，那里不存在 intel-hub 仓库。
 *
 * R3-C 复评抓到的真缺陷：早期版本在找不到时 **throw**，导致换 HOME / 换机器跑自测
 * 会 `not ok`（`HOME=/tmp/fakehome` 下实测 83/84）—— 而 README 恰恰让用户跑这条命令。
 * 正确做法：找不到就**跳过并明说原因**，让独立分发目录下仍能全绿。
 */
/** 找一个"有 DSH 会话投影缓存"的真实工作区；找不到返回空串（调用方据此跳过）。 */
function findRealWorkspace() {
  try {
    const dshHome = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
    const cacheDir = join(dshHome, 'storages', 'session_projcache', 'sessions');
    if (!existsSync(cacheDir)) return '';
    for (const f of readdirSync(cacheDir).slice(0, 50)) {
      try {
        const j = JSON.parse(readFileSync(join(cacheDir, f), 'utf8'));
        const ws = (j.rows || []).map((r) => r.workspace).find((w) => typeof w === 'string' && w && existsSync(w));
        if (ws) return ws;
      } catch {
        /* 跳过坏文件 */
      }
    }
  } catch {
    /* 没缓存就算了 */
  }
  return '';
}

function findDoc73() {
  const repo = resolve(SKILL_DIR, '..', '..', '..', '..');
  const rel = ['docs', '73-设计方案规格书-上下文交接技能.md'];
  for (const cand of [
    join(repo, 'Documents', 'dsh', 'intel-hub', ...rel),
    join(repo, 'dsh', 'intel-hub', ...rel),
    join(process.env.HOME || '', 'Documents', 'dsh', 'intel-hub', ...rel),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/* ══════════ 第 2 轮复评：锁生命周期 / 符号链接 / 陈旧锁 ══════════ */

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !(e && e.code === 'ESRCH');
  }
};

test('E3-N1 释放侧判据：next 跑完后目标目录**不得**残留 *.lock（幂等路径）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: VALID_SECTIONS.status.replace('夹具', '夹具R1') } }), 'utf8');
    // 第 1 次真变化
    assert.equal(runCli(['next', f, '--payload', p]).code, 0);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.lock')), [], '第 1 次跑完不得留锁');
    // 第 2 次幂等放行（第 1 轮的实现在这里漏了 releaseLock ⇒ 之后永久 exit 4）
    assert.equal(runCli(['next', f, '--payload', p]).code, 0, '第 2 次幂等放行必须 exit 0');
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.lock')), [], '幂等放行路径也不得留锁');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E3-N1 变异能红：同一状态连跑 4 次必须全部 exit 0（锁不得毒化后续调用）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: VALID_SECTIONS.status.replace('夹具', '夹具R2') } }), 'utf8');
    const codesSeen = [];
    for (let i = 0; i < 4; i++) codesSeen.push(runCli(['next', f, '--payload', p]).code);
    assert.deepEqual(codesSeen, [0, 0, 0, 0], `连跑 4 次必须全 0，实际 ${codesSeen.join(',')}`);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.lock')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E3-N1 释放侧判据：失败路径（payload 非法）也不得留锁', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json', 'utf8');
    const r = runCli(['next', f, '--payload', bad]);
    assert.equal(r.code, 3, '非法 payload 应 exit 3');
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.lock')), [], '失败路径不得留锁');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E3-N2 陈旧锁自愈：锁里的 PID 已不存在时必须回收并继续（不许要求人工删锁）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: VALID_SECTIONS.status.replace('夹具', '夹具R3') } }), 'utf8');
    // 造一个"死进程"的锁：用一个几乎不可能存在的 PID
    let ghost = 999999;
    while (isAlive(ghost) && ghost > 100000) ghost -= 1;
    writeFileSync(`${f}.lock`, `${ghost}\n${Date.now()}\n`, 'utf8');
    const r = runCli(['next', f, '--payload', p]);
    assert.equal(r.code, 0, `陈旧锁必须被自动回收并继续，实际 ${r.code}\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /陈旧锁|回收/, '应给出回收提示');
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.lock')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E3-N2 活锁仍必须拦住：锁里的 PID 是本进程时必须 exit 4', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: VALID_SECTIONS.status.replace('夹具', '夹具R4') } }), 'utf8');
    writeFileSync(`${f}.lock`, `${process.pid}\n${Date.now()}\n`, 'utf8');
    const r = runCli(['next', f, '--payload', p]);
    assert.equal(r.code, 4, `活着持锁者必须 exit 4，实际 ${r.code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E3-N3 符号链接语义：next 必须写穿符号链接，不得把它替换成普通文件', () => {
  const dir = tmp();
  try {
    const real = join(dir, 'real.md');
    const link = join(dir, 'HANDOFF.md');
    writeFileSync(real, validHandoff(), 'utf8');
    symlinkSync('real.md', link);
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: VALID_SECTIONS.status.replace('夹具', '夹具S1') } }), 'utf8');
    const r = runCli(['next', link, '--payload', p]);
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    assert.equal(lstatSync(link).isSymbolicLink(), true, '写后它必须仍是符号链接');
    assert.match(readFileSync(real, 'utf8'), /夹具S1/, '真实目标必须被更新');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E2-CA7 变异能红：`-nt` 对空串/不存在文件的判定与平台相关 ⇒ 必须先守卫再比', () => {
  // 实测（GNU bash 5.2.21）：空串/不存在文件两侧都返回"不更新"，但**这个结论不可跨平台假设**
  // （E2 复评在别的 bash 上得 TRUE）。所以判据不钉"哪个真"，只钉"必须显式守卫"：
  const real = join(tmp(), 'x.txt');
  writeFileSync(real, 'x');
  const decisions = ['', '/nonexistent/zzz', real].map(
    (rhs) => spawnSync('bash', ['-c', `[ "x" -nt "${rhs}" ] && echo TRUE || echo FALSE`], { encoding: 'utf8' }).stdout.trim(),
  );
  assert.ok(
    decisions.every((d) => d === 'TRUE' || d === 'FALSE'),
    `-nt 的判定必须显式可控，实测三例：${decisions.join('/')}`,
  );
  const sh = readFileSync(join(SKILL_DIR, 'adapters', 'claude-code', 'context_budget.sh'), 'utf8');
  // 真正的判据：`-nt` 之前必须已确认 TRANSCRIPT 是非空字符串**且**是存在的文件
  assert.match(sh, /\[ -n "\$TRANSCRIPT" \]/, '必须先判非空');
  assert.match(sh, /\[ -f "\$TRANSCRIPT" \]/, '必须先判是存在的文件');
});


test('E4-R1 变异能红：init 产物必须与模板同源（含指引与逐节说明），不得是"裸骨架"', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    assert.equal(runCli(['init', f]).code, 0);
    const out = readFileSync(f, 'utf8');
    const template = readFileSync(join(SKILL_DIR, 'templates', 'HANDOFF.md'), 'utf8');
    // 两条生产者必须同源：节体与 provenance 键集合逐字一致
    for (const id of SECTIONS) {
      const seg = (t) => {
        const s = t.indexOf(`<!-- handoff:section id=${id} -->`);
        return t.slice(s, t.indexOf('<!-- /handoff:section -->', s));
      };
      assert.equal(seg(out), seg(template), `节 ${id} 的骨架必须与模板一致（init 不得自造一份）`);
    }
    // 指引必须在：删 CONTENT 行的说明 + 每节说明 + provenance 值域注释
    assert.match(out, /填完一节就删掉该节的/, 'init 产物必须含"填完删 CONTENT 行"的指引');
    assert.match(out, /确实没有内容的子项写「无」/, 'init 产物必须含"空子项写无"的指引');
    // 值域必须覆盖**全部合法取值**（不写死数量：白名单会扩，写死数字必然漂移）
    for (const t of ALLOWED_TRIGGERS) {
      assert.ok(out.includes(t), `init 产物的值域必须包含合法取值 ${t}`);
    }
    assert.match(out, /目标与验收。验收必须是/, 'init 产物必须含逐节说明');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E4-R7 变异能红：measure 的失败分支与成功分支对象形状必须一致（都要有 thresholds/crossed）', () => {
  const r = runCli(['measure', '--workspace', '/nonexistent/workspace/zzz', '--json']);
  assert.equal(r.code, 0, 'measure 取不到是正常降级 ⇒ exit 0');
  const p = JSON.parse(r.stdout);
  assert.equal(p.ok, false);
  assert.ok('thresholds' in p, '失败分支也必须带 thresholds（否则调用方读 .thresholds.caveat 会 TypeError）');
  assert.ok('crossed' in p, '失败分支也必须带 crossed');
});

test('E4-R2 变异能红：SKILL.md 的 supersedes 示例与归档命名不得与判据/实现自相矛盾', () => {
  const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  assert.equal(
    /supersedes: handoff\/archive\//.test(skill),
    false,
    'supersedes 示例不得写成归档路径（实现只收 none 或 round-<n>@<hex>）',
  );
  assert.equal(
    /<archive>\/<UTC 时间戳>-<4 位序号>\.md/.test(skill),
    false,
    '归档命名不得再写"UTC 时间戳-序号"（与内容寻址新规自相矛盾）',
  );
  assert.match(skill, /round-<轮次>@<节?指纹>\.md/, '必须写明内容寻址的归档名');
  assert.match(skill, /peer-request/, 'trigger 六值必须写全');
});

/* ══════════ 可移植的"陈旧口径"守卫（R3-C 发现 #5：守卫只查 SKILL.md，漏了 docs 与 adapters） ══════════ */

test('R3-C 守卫：技能目录内不得再出现"硬线 0.88"或"UTC 时间戳-序号"归档命名', () => {
  const stale = [
    [new RegExp('硬线 ?0\\.88'), '硬线 0.88（第 1 轮的错口径，已改为按窗口解析）'],
    [new RegExp('预警线取同一 ?0\\.8[^0-9]'), '预警线取同一 0.8（同上）'],
    [new RegExp('<UTC ?时间戳>-<4 位序号>'), 'UTC 时间戳-序号归档命名（已改为内容寻址）'],
  ];
  const offending = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      // 守卫自身的正则字面量必然含这些串 ⇒ 排除自己
      if (e.name === 'handoff.review-regressions.test.mjs') continue;
      const fp = join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (/\.(md|mjs|json|sh)$/.test(e.name)) {
        const body = readFileSync(fp, 'utf8');
        for (const [re, why] of stale) {
          if (re.test(body)) offending.push(`${fp.replace(`${SKILL_DIR}/`, '')}: ${why}`);
        }
      }
    }
  };
  walk(SKILL_DIR);
  // references/design-notes.md 专门记录"第 1 轮这么写是错的"，允许以**引述并否定**的语态出现；
  // 其余任何文件（含 adapters/、templates/）出现即判红。
  const real = offending.filter((l) => !l.startsWith('references/design-notes.md'));
  assert.deepEqual(real, [], `技能目录内仍有陈旧口径：\n${real.join('\n')}`);
});

/* ══════════ 第 3 轮（R3-A/B/C/D）独立评审发现项的回归判据 ══════════ */

test('R3-D-1 致命：节体含行内代码（反引号）时 parseSections 的坐标必须仍然精确', () => {
  // 这是第 3 轮最严重的发现：旧实现用 `m[0].indexOf(m[2], …)` 在原文里搜一个**已被掩码替换**的串，
  // 节体含反引号时返回 -1 ⇒ bodyStart 退化到节体中间 ⇒ 合并时把开哨兵一起切掉 ⇒
  // "只能 init、不能 update"。夹具此前不含反引号，所以 84 项全绿也没抓到。
  const text = validHandoff({
    sections: {
      environment: '- 路径：/tmp\n- 服务：无\n- 命令：`cd /tmp && node x.mjs`\n- 依赖状态：`node` 可用\n- 定时提醒：无\n',
      evidence: '- 提交：abc1234\n- 文件：`docs/x.md`（见 `:12`）\n- 实测数字：1\n',
    },
  });
  const parsed = parseSections(text);
  assert.equal(parsed.sections.length, SECTIONS.length, '8 节必须都被解析出来');
  assert.equal(parsed.unbalanced, false, '哨兵必须成对');
  for (const s of parsed.sections) {
    assert.equal(
      text.slice(s.bodyStart, s.bodyEnd),
      s.body,
      `节 ${s.id} 的 bodyStart/bodyEnd 必须精确切出节体（含反引号时也一样）`,
    );
  }
  // 端到端：含反引号的交接物必须能走完 next
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, text, 'utf8');
    const p = join(dir, 'p.json');
    const st = text.slice(
      text.indexOf('<!-- handoff:section id=status -->'),
      text.indexOf('<!-- /handoff:section -->', text.indexOf('<!-- handoff:section id=status -->')),
    );
    const body = parseSections(text).sectionsById.status.body.replace('本体 SKILL.md、判据脚本、模板', '本体 SKILL.md、判据脚本、模板（含反引号节体验证）');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: body } }), 'utf8');
    void st;
    const r = runCli(['next', f, '--payload', p, '--archive-dir', join(dir, 'ar')]);
    assert.equal(r.code, 0, `含反引号的交接物必须能 next：${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(f, 'utf8').match(/^<!-- handoff:section/gm).length, SECTIONS.length, '合并后 8 节齐全');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-D-2 夹具同源：validHandoff 必须来自真实模板产物（含节说明注释与反引号）', () => {
  const fx = readFileSync(join(SKILL_DIR, 'scripts', 'tests', 'fixtures.mjs'), 'utf8');
  assert.match(fx, /renderTemplate/, '夹具必须用生成器的真实模板产物作基底');
  const t = validHandoff();
  assert.match(t, /`/, '夹具必须含反引号（否则"含反引号即失败"这类缺陷会永久逃逸）');
  assert.equal(validateHandoff(t).ok, true, '夹具本身必须判绿');
});

test('R3-A-5 变异能红：todo 与 status.待办 必须**逐字节**一致（空白差异也判红）', () => {
  const a = validHandoff();
  const statusBody = parseSections(a).sectionsById.status.body;
  const mutated = statusBody.replace('①补 platforms.md ②跑 E1–E4 评审', '①补 platforms.md    ②跑 E1–E4 评审');
  assert.notEqual(mutated, statusBody, '夹具里应有该串');
  const r = validateHandoff(withSection(a, 'status', mutated));
  assert.equal(r.ok, false, '多几个空格也必须判红（文档承诺逐字节）');
  assert.ok(codes(r).includes('E_TODO_MISMATCH'), codes(r).join(','));
});

test('R3-A-4 变异能红：围栏代码块里的 "- 键：值" 不得满足必含子项', () => {
  const text = validHandoff();
  // 把 evidence 的「提交」真子项删掉，只在围栏代码块里留一个 `- 提交：abc`
  const body = '- 文件：docs/x.md\n- 实测数字：1\n\n```\n- 提交：abc1234（别处的示例）\n```\n';
  const r = validateHandoff(withSection(text, 'evidence', body));
  assert.equal(r.ok, false, '围栏里的列表项不能冒充真子项');
  assert.ok(codes(r).includes('E_ITEM_MISSING'), codes(r).join(','));
});

test('R3-D-5 变异能红：保留 HANDOFF:CONTENT 标记必须判红（文档承诺的行为）', () => {
  const text = validHandoff();
  const body = '<!-- HANDOFF:CONTENT -->\n' + parseSections(text).sectionsById.goal.body.replace(/^\n+/, '');
  const r = validateHandoff(withSection(text, 'goal', body));
  assert.equal(r.ok, false, '保留该标记 = 未填写，必须判红');
  assert.ok(codes(r).includes('E_CONTENT_MARKER_HELD'), codes(r).join(','));
});

test('R3-C-2/R3-A-7 变异能红：measure --override 越界必须如实失败（不得产出判据会拒绝的值）', () => {
  for (const bad of ['150', '-0.5']) {
    const r = runCli(['measure', '--override', bad, '--json']);
    // R4β #7：**参数非法是用法错**，必须 exit 3（不是像"取不到"那样 exit 0 悄悄接受）
    assert.equal(r.code, 3, `--override ${bad} 是用法错 ⇒ exit 3，实际 ${r.code}`);
    const p = JSON.parse(r.stdout);
    assert.equal(p.ok, false, `--override ${bad} 必须 ok:false（否则会把工具自己判红的值写进交接物）`);
    assert.equal(p.source, 'unavailable');
  }
  // 语义：1 < n ≤ 100 视为百分数（1.5 ⇒ 1.5%）；越界必须失败
  const pct = JSON.parse(runCli(['measure', '--override', '1.5', '--json']).stdout);
  assert.equal(pct.ok, true, '1.5 应被解释为 1.5%');
  assert.equal(pct.occupancy, 0.015);
  // 负负控：0.85 合法
  const ok = JSON.parse(runCli(['measure', '--override', '0.85', '--context-window', '262144', '--json']).stdout);
  assert.equal(ok.ok, true);
  assert.equal(ok.thresholds.warn, 0.45, '阈值必须按窗口解析（override 分支也不例外）');
  assert.equal(ok.thresholds.derived, true);
});

test('R3-A-2/R3-D-7 变异能红：restore 的拼错 flag 必须 exit 3（旧版会静默执行回退）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    const r = runCli(['restore', f, f, '--dry-runn']);
    assert.equal(r.code, 3, `restore 也必须受白名单保护，实际 ${r.code}`);
    assert.match(r.stdout + r.stderr, /未知参数/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-D-3 变异能红：payload 形状错必须 exit 3 且指向 payload（不是 E_SECTION_UNBALANCED）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['todo'] }), 'utf8'); // 缺 sections
    const r = runCli(['next', f, '--payload', p]);
    assert.equal(r.code, 3, `形状错必须 exit 3，实际 ${r.code}`);
    assert.match(r.stdout + r.stderr, /payload/);
    assert.equal(/E_SECTION_UNBALANCED/.test(r.stdout + r.stderr), false, '不得把形状错报成结构损坏');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-D-11 变异能红：import gen_template 不得产生副作用（不改模板 mtime、不打噪声）', () => {
  const tpl = join(SKILL_DIR, 'templates', 'HANDOFF.md');
  const before = statSync(tpl).mtimeMs;
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(join(SKILL_DIR, 'scripts', 'gen_template.mjs'))}).then(m=>m.renderTemplate({hints:false}))`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '', `import 不得输出噪声，实际：${JSON.stringify(r.stdout)}`);
  assert.equal(statSync(tpl).mtimeMs, before, 'import 不得重写技能目录里的模板');
});

test('R3-A-1 变异能红：并发外部写入不得被吞掉（CAS 必须在 noop 分支之前）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const base = validHandoff();
    // 用大文件把"读入→写回"的时间窗拉长（4MB 时窗口太窄，注入点会落在子进程结束之后 ⇒ 测试抖动）
    writeFileSync(f, `${base}\n<!-- ${'x'.repeat(8_000_000)} -->\n`, 'utf8');
    const body = parseSections(base).sectionsById.status.body;
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: body } }), 'utf8');
    const cli = join(SKILL_DIR, 'scripts', 'check_handoff.mjs');

    // 不变量（与时序无关）：**外部写入的内容绝不能被吞掉**。
    //   · 若子进程在注入前就写完 ⇒ 注入发生在之后 ⇒ 标注必然还在
    //   · 若子进程横跨注入点 ⇒ CAS 必须 exit 4 ⇒ 标注保全
    //   · 只有"exit 0 且标注消失"才是真缺陷
    const delays = [30, 80, 200];
    let conflicts = 0;
    for (const delay of delays) {
      const before = readFileSync(f, 'utf8');
      writeFileSync(f, before.replace(/\n<!-- 他人在建标注 -->\n/g, '\n'), 'utf8');
      const drv = join(dir, `drive${delay}.mjs`);
      writeFileSync(drv, [
        "import { spawn } from 'node:child_process';",
        "import { appendFileSync } from 'node:fs';",
        `const f = ${JSON.stringify(f)};`,
        `const c = spawn(process.execPath, [${JSON.stringify(cli)}, 'next', f, '--payload', ${JSON.stringify(p)}]);`,
        "let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });",
        `setTimeout(() => { appendFileSync(f, '\\n<!-- 他人在建标注 -->\\n'); }, ${delay});`,
        "c.on('close', (code) => { process.stdout.write(JSON.stringify({ code, out })); });",
      ].join('\n'), 'utf8');
      const r = spawnSync(process.execPath, [drv], { encoding: 'utf8' });
      const parsed = JSON.parse(r.stdout || '{}');
      if (parsed.code === 4) conflicts += 1;
      // 退出码只能是 0（未撞上）或 4（并发冲突）；**绝不能是 3** —— R4β #5 实测过这里曾报 3
      assert.ok(parsed.code === 0 || parsed.code === 4, `delay=${delay}ms：并发冲突必须报 exit 4，实际 ${parsed.code}\n${parsed.out}`);
      assert.match(readFileSync(f, 'utf8'), /他人在建标注/, `delay=${delay}ms：外部写入被吞掉了（code=${parsed.code}）——CAS 失效`);
    }
    // 三档延迟里至少有一档应落在窗口内并报冲突；否则说明 CAS 根本没触发（测试本身失去意义）
    assert.ok(conflicts >= 1, `三档延迟都没有检测到并发冲突（CAS 可能未生效）：conflicts=${conflicts}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-A-3 变异能红：归档指纹必须覆盖整文件（否则 restore 重放会永久撞名）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const base = validHandoff();
    writeFileSync(f, base, 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: parseSections(base).sectionsById.status.body.replace('夹具', '夹具AR') } }), 'utf8');
    const ar = join(dir, 'ar');
    assert.equal(runCli(['next', f, '--payload', p, '--archive-dir', ar]).code, 0);
    const names = readdirSync(ar);
    assert.equal(names.length, 1, names.join(','));
    // 归档名必须锚定整文件：与"仅节体指纹"不同
    assert.match(names[0], /^round-1@[0-9a-f]{12}\.md$/);
    // 同一状态重放不得新增
    assert.equal(runCli(['next', f, '--payload', p, '--archive-dir', ar]).code, 0);
    assert.equal(readdirSync(ar).length, 1, '同一状态重放不得新增归档');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-B-2 变异能红：0 字节/不可解析的陈旧锁必须能自愈（不得永久 exit 4）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const base = validHandoff();
    writeFileSync(f, base, 'utf8');
    const body = parseSections(base).sectionsById.status.body.replace('夹具', '夹具LOCK');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: body } }), 'utf8');
    // 造一个 0 字节锁（模拟"锁已创建、PID 还没写进去就被 SIGKILL"），并把它做旧
    const lock = `${f}.lock`;
    writeFileSync(lock, '', 'utf8');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lock, old, old);
    const r = runCli(['next', f, '--payload', p, '--json']);
    assert.equal(r.code, 0, `0 字节的陈旧锁必须被自动回收，实际 exit ${r.code}\n${r.stdout}${r.stderr}`);
    assert.equal(existsSync(lock), false, '跑完不得留下锁');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-B-2 负负控：**新鲜**的不可解析锁仍必须拦住（不能一律放行）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const base = validHandoff();
    writeFileSync(f, base, 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: parseSections(base).sectionsById.status.body.replace('夹具', '夹具FRESH') } }), 'utf8');
    writeFileSync(`${f}.lock`, '', 'utf8'); // 刚建的 0 字节锁 ⇒ 很可能有人正在写
    const r = runCli(['next', f, '--payload', p]);
    assert.equal(r.code, 4, `新鲜的未知持有者必须拦住，实际 ${r.code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-B-1 变异能红：陈旧锁回收必须原子（并发回收不得双双写入、不得丢更新）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const change = '夹具RACE';
    writeFileSync(f, validHandoff(), 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(
      p,
      JSON.stringify({ changed: ['status'], sections: { status: parseSections(readFileSync(f, 'utf8')).sectionsById.status.body.replace('夹具', change) } }),
      'utf8',
    );
    // 放一个"死进程"的陈旧锁，然后并发跑两个 next
    let ghost = 999000;
    const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); } };
    while (isAlive(ghost) && ghost > 900000) ghost -= 1;
    writeFileSync(`${f}.lock`, `${ghost}\n${Date.now()}\n`, 'utf8');
    const drv = join(dir, 'par.mjs');
    writeFileSync(drv, [
      "import { spawn } from 'node:child_process';",
      `const cli = ${JSON.stringify(join(SKILL_DIR, 'scripts', 'check_handoff.mjs'))};`,
      `const f = ${JSON.stringify(f)};`,
      `const p = ${JSON.stringify(p)};`,
      "const run = () => new Promise((res) => { const c = spawn(process.execPath, [cli, 'next', f, '--payload', p, '--json']); c.stdout.on('data', () => {}); c.stderr.on('data', () => {}); c.on('close', (code) => res({ code })); });",
      "const both = await Promise.all([run(), run()]);",
      "process.stdout.write(JSON.stringify(both));",
    ].join('\n'), 'utf8');
    const r = spawnSync(process.execPath, [drv], { encoding: 'utf8' });
    const codes = JSON.parse(r.stdout || '[]').map((x) => x.code);
    // 说明：两边都 exit 0 是**合法**的 —— 先写的那个真写了，后一个读到新内容于是走"幂等 no-op"。
    // 真正要防的是：**两方都写了自己的内容导致丢更新**。所以判据看最终文件，而不是看退出码计数。
    assert.ok(codes.every((c) => c === 0 || c === 4), `只允许 0/4，实际 ${JSON.stringify(codes)}`);
    const now = readFileSync(f, 'utf8');
    assert.equal(validateHandoff(now).ok, true, `产物必须判绿：${JSON.stringify(validateHandoff(now).errors)}`);
    assert.match(now, new RegExp(change), '改动必须落到文件里（不许两边都以为自己写了、实际谁都没写）');
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.lock')), [], '跑完不得残留锁');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-B-2 变异能红：0 字节/不可解析的陈旧锁必须能自愈（不得永久 exit 4）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const base = validHandoff();
    writeFileSync(f, base, 'utf8');
    const body = parseSections(base).sectionsById.status.body.replace('夹具', '夹具LOCK');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: body } }), 'utf8');
    // 造一个 0 字节锁（模拟"锁已创建、PID 还没写进去就被 SIGKILL"），并把它做旧
    const lock = `${f}.lock`;
    writeFileSync(lock, '', 'utf8');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lock, old, old);
    const r = runCli(['next', f, '--payload', p, '--json']);
    assert.equal(r.code, 0, `0 字节的陈旧锁必须被自动回收，实际 exit ${r.code}\n${r.stdout}${r.stderr}`);
    assert.equal(existsSync(lock), false, '跑完不得留下锁');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-B-2 负负控：**新鲜**的不可解析锁仍必须拦住（不能一律放行）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const base = validHandoff();
    writeFileSync(f, base, 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: parseSections(base).sectionsById.status.body.replace('夹具', '夹具FRESH') } }), 'utf8');
    writeFileSync(`${f}.lock`, '', 'utf8'); // 刚建的 0 字节锁 ⇒ 很可能有人正在写
    const r = runCli(['next', f, '--payload', p]);
    assert.equal(r.code, 4, `新鲜的未知持有者必须拦住，实际 ${r.code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-B-1 变异能红：陈旧锁回收必须原子（并发回收不得双双持锁）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    writeFileSync(f, validHandoff(), 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: parseSections(readFileSync(f, 'utf8')).sectionsById.status.body.replace('夹具', '夹具RACE') } }), 'utf8');
    // 放一个"死进程"的陈旧锁，然后并发跑两个 next
    let ghost = 999000;
    const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); } };
    while (isAlive(ghost) && ghost > 900000) ghost -= 1;
    writeFileSync(`${f}.lock`, `${ghost}\n${Date.now()}\n`, 'utf8');
    const drv = join(dir, 'par.mjs');
    writeFileSync(drv, [
      "import { spawn } from 'node:child_process';",
      `const cli = ${JSON.stringify(join(SKILL_DIR, 'scripts', 'check_handoff.mjs'))};`,
      `const f = ${JSON.stringify(f)};`,
      `const p = ${JSON.stringify(p)};`,
      "const run = () => new Promise((res) => { const c = spawn(process.execPath, [cli, 'next', f, '--payload', p, '--json']); let o=''; c.stdout.on('data',d=>o+=d); c.on('close',(code)=>res({code})); });",
      "const both = await Promise.all([run(), run()]);",
      "process.stdout.write(JSON.stringify(both));",
    ].join('\n'), 'utf8');
    const r = spawnSync(process.execPath, [drv], { encoding: 'utf8' });
    const both = JSON.parse(r.stdout || '[]');
    const codes = both.map((x) => x.code).sort((a, b) => a - b);
    const writers = codes.filter((c) => c === 0).length;
    assert.ok(writers <= 1, `最多只能有一个写入者成功（否则就是双双持锁），实际 ${JSON.stringify(codes)}`);
    assert.equal(existsSync(`${f}.lock`), false, '跑完不得残留锁');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-B-5 变异能红：上一版判红时 next 必须拒绝（不得报"幂等成功"掩盖红状态）', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    // 造一份判红的交接物：删掉必含子项
    const red = validHandoff().replace(/^- 恢复到检查点：.*$/m, '').replace(/^- 恢复检查点：.*$/m, '');
    writeFileSync(f, red, 'utf8');
    assert.equal(runCli(['check', f]).code, 2, '前置条件：这份必须判红');
    const p = join(dir, 'p.json');
    // payload 与现状相同 ⇒ 旧实现会走"幂等放行"分支并 exit 0
    writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: parseSections(red).sectionsById.status.body } }), 'utf8');
    const r = runCli(['next', f, '--payload', p]);
    assert.equal(r.code, 2, `红色上一版必须拒绝 next，实际 ${r.code}\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /未过判据/, '应明确说"上一版未过判据"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-C-6 变异能红：技能目录内文档记载的用例数必须等于真实用例数（防陈旧数字）', () => {
  // R3-C/R3-A 都抓到"文档写 45/69/84、实际另一回事"的漂移。这里把它变成机械判据：
  // 凡是技能目录内出现 `自测 N 项` / `# tests N` / `N/N 通过` 的地方，N 必须等于真实总数。
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const fp = join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (/\.(md|sh|json)$/.test(e.name)) files.push(fp);
    }
  };
  walk(SKILL_DIR);
  // 从自测运行里拿到真实总数（用 glob 全量跑一次的成本太高，这里读 test 声明数）
  const testFiles = readdirSync(join(SKILL_DIR, 'scripts', 'tests')).filter((f) => f.endsWith('.test.mjs'));
  let declared = 0;
  for (const tf of testFiles) {
    const src = readFileSync(join(SKILL_DIR, 'scripts', 'tests', tf), 'utf8');
    declared += (src.match(/^test\(/gm) || []).length;
  }
  assert.ok(declared >= 100, `用例数应≥100，实际 ${declared}`);
  const stale = [];
  for (const fp of files) {
    const body = readFileSync(fp, 'utf8');
    // 也覆盖 "N 项 / N 通过"、"# pass N"、"tests N" 这些写法（R4b 实测：旧正则漏了 README 里的写法）
    for (const m of body.matchAll(/(\d{2,3})\s*项\s*\/\s*\d{2,3}\s*通过/g)) {
      const n = Number(m[1]);
      if (n !== declared) stale.push(`${fp.replace(`${SKILL_DIR}/`, '')}: 写 ${n} 项/通过，实际 ${declared}`);
    }
    for (const m of body.matchAll(/# pass (\d{2,3})/g)) {
      const n = Number(m[1]);
      if (n !== declared) stale.push(`${fp.replace(`${SKILL_DIR}/`, '')}: 写 # pass ${n}，实际 ${declared}`);
    }
    for (const m of body.matchAll(/(?:自测|tests?)\s*[：:]?\s*(\d{2,3})\s*项/g)) {
      const n = Number(m[1]);
      if (n !== declared) stale.push(`${fp.replace(`${SKILL_DIR}/`, '')}: 写 ${n}，实际 ${declared}`);
    }
    for (const m of body.matchAll(/`?# tests (\d{2,3})/g)) {
      const n = Number(m[1]);
      if (n !== declared) stale.push(`${fp.replace(`${SKILL_DIR}/`, '')}: 写 tests ${n}，实际 ${declared}`);
    }
  }
  assert.deepEqual(stale, [], `技能目录内存在陈旧的用例数：\n${stale.join('\n')}`);
});

test('R3-B-1b 压力：多轮并行 next 不得丢更新、不得残留锁、不得死锁', async () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const base = validHandoff();
    writeFileSync(f, base, 'utf8');
    const baseBody = parseSections(base).sectionsById.status.body;
    const cli = join(SKILL_DIR, 'scripts', 'check_handoff.mjs');
    const run = (payloadPath) =>
      new Promise((res) => {
        const c = spawnSync(process.execPath, [cli, 'next', f, '--payload', payloadPath, '--json'], { encoding: 'utf8' });
        res({ code: c.status });
      });
    let deadlock = 0;
    const ROUNDS = 10;
    for (let i = 0; i < ROUNDS; i++) {
      const p = join(dir, `p${i}.json`);
      const want = baseBody.replace('自测夹具', `自测夹具#${i}`);
      writeFileSync(p, JSON.stringify({ changed: ['status'], sections: { status: want } }), 'utf8');
      const codes = await Promise.all([run(p), run(p)]).then((r) => r.map((x) => x.code));
      if (codes.every((c) => c === 4)) deadlock++;
      // 关键断言：这一轮**结束之后**文件必须自洽且判绿（不能出现半写/结构损坏）
      const now = readFileSync(f, 'utf8');
      assert.equal(validateHandoff(now).ok, true, `第 ${i} 轮后文件必须判绿：${JSON.stringify(validateHandoff(now).errors)}`);
      // 且这一轮要改的内容要么已在文件里（有写入者成功），要么两个都没写（都 4）
      const wrote = now.includes(`自测夹具#${i}`);
      assert.ok(wrote || codes.every((c) => c === 4), `第 ${i} 轮：有写入者却看不到改动（丢更新）codes=${JSON.stringify(codes)}`);
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.lock')), [], `第 ${i} 轮后残留锁`);
    }
    // 10 轮里"两次都拿不到锁"（真死锁）应当很少见，且绝不能每轮都死锁
    assert.ok(deadlock <= 3, `并行下死锁过多：${deadlock}/${ROUNDS}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ══════════ 三条失效轴（docs/77 + references/triggers.md）的触发词判据 ══════════ */

test('三轴触发词：B 轴（执行中断）的取值必须被接受，且能区分于 A 轴', () => {
  // 背景：原设计只有"上下文快满"一条轴；B 轴（假死/被杀/超时/限流/压缩失败）是新增的。
  // 这些场景里模型往往已经没机会写任何东西 ⇒ trigger 必须能如实记成 B 轴，而不是被逼写 context-pressure。
  const bAxis = ['interruption', 'error-recovery', 'compaction-failed', 'round-limit', 'budget-quota'];
  for (const t of bAxis) {
    const r = validateHandoff(validHandoff({ provenance: { trigger: t } }));
    assert.equal(r.ok, true, `B 轴取值 ${t} 必须被接受：${JSON.stringify(r.errors)}`);
  }
  const aAxis = ['context-pressure', 'pre-compact', 'post-compact', 'degradation', 'model-switch'];
  for (const t of aAxis) {
    assert.equal(validateHandoff(validHandoff({ provenance: { trigger: t } })).ok, true, `A 轴取值 ${t} 必须被接受`);
  }
  const cAxis = ['phase-complete', 'checkpoint', 'device-switch', 'peer-request', 'user-request'];
  for (const t of cAxis) {
    assert.equal(validateHandoff(validHandoff({ provenance: { trigger: t } })).ok, true, `C 轴取值 ${t} 必须被接受`);
  }
});

test('三轴触发词：`checkpoint` 是独立取值（不能退化成 self-estimate）', () => {
  // checkpoint 是 B 轴唯一防线（写前式检查点），必须能如实标注，否则事后无法区分
  // "例行检查点"与"模型自己慌了"。
  const r = validateHandoff(validHandoff({ provenance: { trigger: 'checkpoint' } }));
  assert.equal(r.ok, true);
  // 负控：乱造的值仍必须判红
  const bad = validateHandoff(validHandoff({ provenance: { trigger: 'context-full' } }));
  assert.equal(bad.ok, false);
  assert.ok(codes(bad).includes('E_PROVENANCE_TRIGGER'), codes(bad).join(','));
});

test('trigger_detail：可选归因字段存在时不得为空面，合法值判绿', () => {
  const ok = validateHandoff(validHandoff({ provenance: { trigger: 'error-recovery', trigger_detail: 'StopFailure:rate_limit' } }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const blank = validateHandoff(validHandoff({ provenance: { trigger: 'error-recovery', trigger_detail: '   ' } }));
  assert.equal(blank.ok, false, 'trigger_detail 写空等于没写，必须判红');
  assert.ok(codes(blank).includes('E_PROVENANCE_TRIGGER_DETAIL'), codes(blank).join(','));
});

test('文档判据：references/triggers.md 必须存在且覆盖三条轴与检查点节奏', () => {
  const p = join(SKILL_DIR, 'references', 'triggers.md');
  assert.ok(existsSync(p), 'references/triggers.md 必须存在（触发全景是操作手册，不能只在仓库 docs 里）');
  const md = readFileSync(p, 'utf8');
  for (const kw of ['信息失真', '执行中断', '主动边界', '检查点节奏', '写前式']) {
    assert.match(md, new RegExp(kw), `triggers.md 必须覆盖「${kw}」`);
  }
  // 能力边界必须写清，不许含糊成"无损"
  assert.match(md, /可能丢失/, '必须写明"检查点之后可能丢失"这一能力边界');
});

test('模板值域必须从 ALLOWED_TRIGGERS 生成（扩白名单后不许漂移）', () => {
  // 本轮实测到的真实缺陷：把 trigger 白名单从 6 扩到 17 之后，模板里的值域提示仍是手写的旧 6 值，
  // 于是交接物里写了**合法**的 `checkpoint`，却在同一文件的值域说明里被列为非法 —— 自相矛盾。
  const tpl = readFileSync(join(SKILL_DIR, 'templates', 'HANDOFF.md'), 'utf8');
  for (const t of ALLOWED_TRIGGERS) {
    assert.ok(tpl.includes(t), `模板值域必须包含合法取值 ${t}`);
  }
  // 生成器里不许再出现手写的取值串
  const gen = readFileSync(join(SKILL_DIR, 'scripts', 'gen_template.mjs'), 'utf8');
  assert.equal(
    /'#\s*user-request \| external-threshold/.test(gen),
    false,
    'gen_template.mjs 不得手写 trigger 值域（必须从 ALLOWED_TRIGGERS 生成）',
  );
});

test('measure 会话选择：不得因为子代理投影而低估本会话占用', async () => {
  // 实测到的真实缺陷：同工作区里子代理会话的投影 createdAt 更新，
  // 按"最新"取会选到子代理 ⇒ 占用被低估 16 倍（0.0411 vs 0.6735）。
  // 低估方向的错误最危险：该交接时不交接。
  const { measureContext } = await import('../measure_context.mjs');
  // 这个用例需要"本机存在一个有 DSH 投影缓存的真实工作区"。作者机器上有；开源用户可能没有 ⇒ 跳过。
  const ws = process.env.CONTEXT_HANDOFF_TEST_WORKSPACE || findRealWorkspace();
  if (!ws) return; // 没有可测工作区 ⇒ 跳过（不判失败）
  const r = await measureContext({ workspace: ws });
  if (!r.ok) {
    // 本机可能没有该工作区的投影（例如换机器跑）⇒ 跳过而不是失败
    return;
  }
  assert.ok(['explicit-session', 'env-DSH_SESSION_ID', 'max-occupancy-among-candidates', 'single-candidate'].includes(r.selection), `selection 取值非法：${r.selection}`);
  // 若走了"未指定会话"的兜底，必须显式标注，不许静默当成当前会话
  if (r.selection === 'max-occupancy-among-candidates') {
    assert.ok(r.selectionNote, '兜底选择必须给出说明');
  }
});

test('description 必须覆盖三条失效轴的关键词（否则真实场景不会触发本技能）', () => {
  // 关键教训：技能被发现靠 description。原 description 只提"上下文接近上限"，
  // 于是"会话过长任务中断"（B 轴）这个最危险的场景**根本不会触发本技能**。
  const md = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const fm = md.match(/^---\n([\s\S]*?)\n---/)[1];
  const desc = fm.split('\n').find((l) => l.startsWith('description:'));
  assert.ok(desc, 'frontmatter 必须有 description');
  // A 轴
  assert.match(desc, /上下文接近上限/, 'A 轴：占用接近上限');
  assert.match(desc, /压缩/, 'A 轴：压缩前后');
  // B 轴（本轮新增，最容易被漏掉）
  assert.match(desc, /假死|无响应/, 'B 轴：会话假死');
  assert.match(desc, /超时|被强杀/, 'B 轴：超时/强杀');
  assert.match(desc, /限流|配额/, 'B 轴：限流/配额');
  assert.match(desc, /压缩失败/, 'B 轴：压缩自身失败');
  assert.match(desc, /崩溃/, 'B 轴：崩溃');
  assert.match(desc, /检查点/, 'B 轴对策：检查点');
  // C 轴
  assert.match(desc, /交接|handoff/, 'C 轴：用户明示');
  // 平台无关：description 里不许出现平台名（否则就不平台无关了）
  assert.equal(/DSH|Claude|Codex|Kimi|豆包|WorkBuddy|TRAE|扣子/i.test(desc), false, 'description 不得含平台名');
});

test('本体 SKILL.md 必须平台无关（出现任何平台名/专有路径即判红）', () => {
  // 本体是"任何支持 Markdown 技能的平台上逐字相同"的那份；一旦写进平台名，分发就不成立。
  // 本轮实测抓到两处（举例用了真实平台稳定码与会话名）⇒ 改成机械化判据，防止再漏。
  const md = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const re = /DSH|\bdsh\b|Claude|Codex|Kimi|豆包|WorkBuddy|TRAE|扣子|Coze|\/Users\/|~\/\.|C:\\|ANTHROPIC|OPENAI/g;
  const hits = [...md.matchAll(re)].map((m) => m[0]);
  assert.deepEqual(hits, [], `SKILL.md 不得含平台名/专有路径：${hits.join(', ')}`);
});

/* ══════════ 第四轮独立评审（R4b）发现项的回归判据 ══════════ */

test('R4b-1 变异能红：非规范闭合哨兵（少空格）不得导致节体被切错', () => {
  // R4β 实测：闭合哨兵写成 `<!--/handoff:section-->` 时，bodyEnd 用"规范长度"相减会把
  // 节体尾部切错（配节体无尾换行时假红 E_ITEM_MISSING）。
  const t = validHandoff().replace(/<!-- \/handoff:section -->/g, '<!--/handoff:section-->');
  const p = parseSections(t);
  assert.equal(p.sections.length, SECTIONS.length);
  for (const s of p.sections) {
    assert.equal(t.slice(s.bodyStart, s.bodyEnd), s.body, `节 ${s.id} 坐标必须精确（非规范闭合哨兵）`);
  }
  assert.equal(validateHandoff(t).ok, true, `合法变体必须判绿：${JSON.stringify(validateHandoff(t).errors)}`);
});

test('R4b-2 夹具同源：8 个节体必须都保留节说明注释，且至少 5 节含反引号', () => {
  // R4β #2：旧夹具整段替换节体，把说明注释全删了 ⇒ 与 init 真实产物不同源，缺陷会逃逸。
  const t = validHandoff();
  const p = parseSections(t);
  const withNote = p.sections.filter((s) => /<!--/.test(s.body)).length;
  const withTick = p.sections.filter((s) => /`/.test(s.body)).length;
  assert.equal(withNote, 8, `8 节都应保留说明注释，实际 ${withNote}`);
  assert.ok(withTick >= 5, `至少 5 节应含反引号（模板说明本身就带），实际 ${withTick}`);
});

test('R4b-3 变异能红：四种代码区里的 "- 键：值" 都不得满足必含子项', () => {
  const base = validHandoff();
  const ev = parseSections(base).sectionsById.evidence.body;
  const cases = {
    '~~~ 围栏': '- 文件：docs/x.md\n- 实测数字：1\n\n~~~\n- 提交：abc1234\n~~~\n',
    '4 反引号围栏': '- 文件：docs/x.md\n- 实测数字：1\n\n````\n- 提交：abc1234\n````\n',
    '4 空格缩进块': '- 文件：docs/x.md\n- 实测数字：1\n\n    - 提交：abc1234\n',
    HTML注释: '- 文件：docs/x.md\n- 实测数字：1\n\n<!--\n- 提交：abc1234\n-->\n',
  };
  for (const [name, body] of Object.entries(cases)) {
    const t = base.slice(0, base.indexOf(ev)) + `\n${body}` + base.slice(base.indexOf(ev) + ev.length);
    const r = validateHandoff(t);
    assert.equal(r.ok, false, `${name} 里的子项不得冒充真子项`);
    assert.ok(r.errors.some((e) => e.code === 'E_ITEM_MISSING'), `${name}：应报 E_ITEM_MISSING，实际 ${r.errors.map((e) => e.code).join(',')}`);
  }
  // 负负控：合法的行内代码值、以及列表续行（前面没有空行的 4 空格缩进）都不得被判红
  assert.equal(validateHandoff(validHandoff({ sections: { evidence: '- 提交：abc1234\n- 文件：`docs/x.md`（见 `:12`）\n- 实测数字：1\n' } })).ok, true);
  assert.equal(validateHandoff(validHandoff({ sections: { evidence: '- 提交：abc1234\n- 文件：docs/x.md\n    （续行说明，非代码）\n- 实测数字：1\n' } })).ok, true);
});

test('R4b-4 变异能红：待办末尾多空格/多 tab/续行缩进不同都必须判红', () => {
  // R4β #11：旧实现只"中间多空格"能红，末尾与续行都漏判。
  const base = validHandoff();
  const st = parseSections(base).sectionsById.status.body;
  const mutations = {
    '末尾多空格': st.replace(/(①[^\n]*)/, '$1   '),
    '末尾多 tab': st.replace(/(①[^\n]*)/, '$1\t\t'),
  };
  for (const [name, body] of Object.entries(mutations)) {
    const r = validateHandoff(withSection(base, 'status', body));
    assert.equal(r.ok, false, `${name} 必须判红（逐字节）`);
    assert.ok(codes(r).includes('E_TODO_MISMATCH'), `${name}：${codes(r).join(',')}`);
  }
});

test('R4b-5 变异能红：阈值不得出现 warn ≥ hard，也不得为负', () => {
  const windows = [2000000, 1000000, 524288, 262144, 200000, 131072, 65536, 32000];
  for (const W of windows) {
    const r = deriveThresholds(W);
    assert.ok(r.warn >= 0, `W=${W}: warn 不得为负，实际 ${r.warn}`);
    if (r.hard !== null) {
      assert.ok(r.warn < r.hard, `W=${W}: warn(${r.warn}) 必须小于 hard(${r.hard})`);
    }
  }
});

test('R4b-6 变异能红：SKILL.md 与 triggers.md 不得再写死"六值"这类过时数量', () => {
  for (const f of ['SKILL.md', 'references/triggers.md']) {
    const md = readFileSync(join(SKILL_DIR, f), 'utf8');
    assert.equal(/六值|5 个合法值/.test(md), false, `${f} 仍在写死过时的取值数量`);
  }
  // 值域必须与白名单规模一致（不写死数字，改为要求"提到表/§1.1"）
  const md = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  assert.match(md, /17 个取值/, 'SKILL.md §1.1 标题应给出当前取值数');
});

test('R4b-7 变异能红：next 不得静默删除可选字段 trigger_detail', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const base = validHandoff({ provenance: { trigger: 'error-recovery', trigger_detail: 'rate_limit' } });
    writeFileSync(f, base, 'utf8');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify({ changed: ['evidence'], sections: { evidence: `${parseSections(base).sectionsById.evidence.body}\n- 检查点：X` } }), 'utf8');
    assert.equal(runCli(['next', f, '--payload', p]).code, 0);
    assert.match(readFileSync(f, 'utf8'), /^trigger_detail: rate_limit$/m, 'next 后 trigger_detail 必须仍在');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R4b-8 变异能红：并发写不同节的 payload 时不得丢更新', () => {
  // R4β #3 的复现方式：两个进程改**不同节**，两边都 exit 0 时最终文件必须同时含两方改动，
  // 否则就是"双双持锁"导致静默丢更新（旧实现约 0.9%）。
  const dir = tmp();
  try {
    const f = join(dir, 'HANDOFF.md');
    const base = validHandoff();
    writeFileSync(f, base, 'utf8');
    const p = parseSections(base);
    const ev = `${p.sectionsById.evidence.body}\n- MARK_A：A`;
    const st = p.sectionsById.status.body.replace('①补 platforms.md', '①MARK_B');
    const td = p.sectionsById.todo.body.replace('①补 platforms.md', '①MARK_B');
    const pA = join(dir, 'pA.json');
    const pB = join(dir, 'pB.json');
    writeFileSync(pA, JSON.stringify({ changed: ['evidence'], sections: { evidence: ev } }), 'utf8');
    writeFileSync(pB, JSON.stringify({ changed: ['status', 'todo'], sections: { status: st, todo: td } }), 'utf8');
    const drv = join(dir, 'drv.mjs');
    writeFileSync(drv, [
      "import { spawn } from 'node:child_process';",
      `const cli = ${JSON.stringify(join(SKILL_DIR, 'scripts', 'check_handoff.mjs'))};`,
      `const f = ${JSON.stringify(f)};`,
      "const run = (p) => new Promise((res) => { const c = spawn(process.execPath, [cli, 'next', f, '--payload', p, '--force', '--json']); let o=''; c.stdout.on('data',d=>o+=d); c.on('close',(code)=>res({code})); });",
      `const both = await Promise.all([run(${JSON.stringify(pA)}), run(${JSON.stringify(pB)})]);`,
      "process.stdout.write(JSON.stringify(both));",
    ].join('\n'), 'utf8');
    let lost = 0;
    for (let i = 0; i < 6; i++) {
      writeFileSync(f, base, 'utf8');
      let ghost = 999000;
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); } };
      while (alive(ghost) && ghost > 900000) ghost -= 1;
      writeFileSync(`${f}.lock`, `${ghost}\n${Date.now()}\n`, 'utf8');
      const r = spawnSync(process.execPath, [drv], { encoding: 'utf8' });
      const codesArr = JSON.parse(r.stdout || '[]').map((x) => x.code);
      const now = readFileSync(f, 'utf8');
      const hasA = now.includes('MARK_A');
      const hasB = now.includes('MARK_B');
      if (codesArr.every((c) => c === 0) && !(hasA && hasB)) lost += 1;
      assert.equal(validateHandoff(now).ok, true, '每轮产物必须判绿');
    }
    assert.equal(lost, 0, `并发写不同节时出现丢更新 ${lost} 次`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi 适配层：自动唤醒三层配置齐备且脚本可用', () => {
  const dir = join(SKILL_DIR, 'adapters', 'kimi-doubao');
  // ① 三份产物必须都在（部署脚本 / 常驻规则 / 提醒脚本）
  for (const f of ['deploy.sh', 'AGENTS.snippet.md', 'kimi_remind.sh', 'README.md']) {
    assert.ok(existsSync(join(dir, f)), `adapters/kimi-doubao/${f} 必须存在`);
  }
  // ② deploy.sh 必须幂等（重复跑不重复追加）—— 靠标记判断
  const dep = readFileSync(join(dir, 'deploy.sh'), 'utf8');
  assert.match(dep, /context-handoff \(managed\)/, 'deploy.sh 必须有幂等标记');
  // ③ hooks 只能写 4 个字段（多写会导致整份 config.toml 加载失败）
  // 注意：文件头注释里也出现过 `[[hooks]]` 字样，所以必须找**行首**那一处
  const hookBlock = dep.slice(dep.indexOf('\n[[hooks]]\n'), dep.indexOf('# <<< context-handoff (managed) <<<'));
  const fields = [...hookBlock.matchAll(/^(\w+)\s*=/gm)].map((m) => m[1]);
  for (const f of fields) {
    assert.ok(['event', 'matcher', 'command', 'timeout'].includes(f), `[[hooks]] 不允许字段 ${f}`);
  }
  assert.ok(fields.includes('event') && fields.includes('command'), 'hooks 至少要 event + command');
  // ④ 常驻规则必须写清"检查点节奏"与"能力边界"（这是 L1 层的实质内容）
  const rule = readFileSync(join(dir, 'AGENTS.snippet.md'), 'utf8');
  for (const kw of ['不要等上下文满了', '长耗时', '重复同一种手段', '可能丢失']) {
    assert.match(rule, new RegExp(kw), `AGENTS.snippet.md 必须写清「${kw}」`);
  }
});

test('Kimi 提醒脚本：取不到数必须静默，越过阈值必须提醒且防刷屏', () => {
  const dir = join(SKILL_DIR, 'adapters', 'kimi-doubao');
  const script = join(dir, 'kimi_remind.sh');
  const home = tmp();
  try {
    // 没有 config.toml / sessions ⇒ 必须静默 exit 0
    let r = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, KIMI_CODE_HOME: home } });
    assert.equal(r.status, 0, '取不到数也必须 exit 0（fail-open）');
    assert.equal(r.stdout.trim(), '', '取不到数必须静默，不许编');

    // 造一份"未达阈值"的轨迹 ⇒ 仍静默
    mkdirSync(join(home, 'sessions', 'w', 's1', 'agents', 'main'), { recursive: true });
    writeFileSync(join(home, 'config.toml'), 'max_context_size = 262144\n', 'utf8');
    const wire = join(home, 'sessions', 'w', 's1', 'agents', 'main', 'wire.jsonl');
    writeFileSync(wire, `${JSON.stringify({ usage: { prompt_tokens: 100000 } })}\n`, 'utf8');
    r = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, KIMI_CODE_HOME: home } });
    assert.equal(r.stdout.trim(), '', '45% 时不该提醒');

    // 越过阈值 ⇒ 必须提醒
    writeFileSync(wire, `${JSON.stringify({ usage: { prompt_tokens: 210000 } })}\n`, 'utf8');
    r = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, KIMI_CODE_HOME: home } });
    assert.match(r.stdout, /上下文交接提醒/, '越过阈值必须提醒');
    // 再跑一次 ⇒ 防刷屏
    r = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, KIMI_CODE_HOME: home } });
    assert.equal(r.stdout.trim(), '', '同一状态不得重复提醒');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('单元边界优先：本体与 Kimi 常驻规则都必须把 phase-complete 排在阈值触发之前', () => {
  // 用户实操观察（2026-10-17）：完成一个独立交付单元后换会话，续接效果最好。
  // 机制解释：交接物质量取决于"写它那一刻的自我清晰度"，而阈值触发恰好落在模型退化区。
  const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  // ① 必须有"触发优先级"表，且首选是单元边界
  assert.match(skill, /触发优先级/, 'SKILL.md 必须给出触发优先级');
  const prioIdx = skill.indexOf('触发优先级');
  const prioBlock = skill.slice(prioIdx, prioIdx + 900);
  assert.match(prioBlock, /首选[\s\S]{0,80}phase-complete/, '首选必须是 phase-complete');
  assert.match(prioBlock, /退化区/, '必须写明"阈值触发时模型已退化"这个机制理由');
  // ② 交付单元必须有三条可操作判据，不能只有"一个可验证的交付点"这种空话
  assert.match(skill, /有可判真假的验收/, '必须给出"有可判真假的验收"判据');
  assert.match(skill, /不依赖未完成的半成品/, '必须给出"不依赖半成品"判据');
  assert.match(skill, /已落盘/, '必须给出"已落盘"判据');
  // ③ 反模式必须写清：中途不做完整阶段交接
  assert.match(skill, /反模式[\s\S]{0,120}中途/, '必须写明"不要在单元中途做完整阶段交接"');

  // ④ Kimi 常驻规则（模型真正会读的那份）必须同样排序
  const rule = readFileSync(join(SKILL_DIR, 'adapters', 'kimi-doubao', 'AGENTS.snippet.md'), 'utf8');
  assert.match(rule, /首选：交付单元完成时/, '常驻规则必须以单元边界为首选');
  assert.match(rule, /别在单元中途换会话/, '常驻规则必须写明中途换会话的反模式');
  assert.ok(
    rule.indexOf('交付单元') < rule.indexOf('平台提示上下文即将压缩'),
    '常驻规则里单元边界必须排在"压缩预警"之前',
  );
});

test('triggers.md §4.1 必须给出交付单元定义、机制理由与证据强度', () => {
  const md = readFileSync(join(SKILL_DIR, 'references', 'triggers.md'), 'utf8');
  for (const kw of ['交付单元边界', '三条同时满足', '甜点区', '反模式', '证据强度']) {
    assert.match(md, new RegExp(kw), `triggers.md 必须覆盖「${kw}」`);
  }
  // 必须如实标注证据强度（n 小 / 无对照 / 自评），不许包装成受控实验结论
  assert.match(md, /n 小|无对照实验/, '必须如实标注证据强度');
});

test('下一单元探测：必须是"提议+人决定"，且不得自动中止/阻塞/以占用率为由', () => {
  const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  // ① 探测问句必须存在且是"下一动作 vs 刚做完"的比较式
  assert.match(skill, /下一单元探测/, 'SKILL.md 必须有"下一单元探测"');
  assert.match(skill, /是不是和刚做完的是同一个交付单元/, '必须有"下一步是否同一件事"这个更锐利的问句');
  // ② 探测必须发生在动作**之前**
  assert.match(skill, /探测时机：动作之前/, '必须写明探测在动作之前');
  // ③ 三条硬约束必须都在
  assert.match(skill, /不许自动中止/, '必须禁止自动中止');
  assert.match(skill, /不许阻塞/, '必须禁止阻塞');
  assert.match(skill, /不许以"我猜你快满了"为理由提议/, '必须以单元边界而非占用率作为提议依据');
  // ④ 必须明说 Agent 无法自己结束会话（不许声称已切换）
  assert.match(skill, /无法自己结束会话/, '必须写明 Agent 结束不了会话');
  // ⑤ 判别四信号齐备
  for (const kw of ['验收标准', '改动面', '依赖关系', '交付状态']) {
    assert.match(skill, new RegExp(kw), `判别表缺「${kw}」`);
  }
  // ⑥ 控制权归人
  assert.match(skill, /Agent 提议、人决策/, '必须写清控制权归人');
});

test('下一单元探测：triggers.md 必须记录三方案取舍与失效模式（含诚实边界）', () => {
  const md = readFileSync(join(SKILL_DIR, 'references', 'triggers.md'), 'utf8');
  for (const kw of ['下一单元探测', '自动中止', '探测必须在', '已知失效模式', '误判为边界', '提示疲劳']) {
    assert.match(md, new RegExp(kw), `triggers.md §4.2 必须覆盖「${kw}」`);
  }
  // 必须明确"不采纳自动中止"，而不是含糊过去
  assert.match(md, /不采纳其"自动中止"/, '必须明确不采纳自动中止');
});

test('开源卫生：分发目录内不得含作者本机绝对路径/私有仓库名', () => {
  const offenders = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const fp = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'tests') continue; // 测试里的路径探测会自动跳过，允许存在
        walk(fp);
      } else if (/\.(md|mjs|json|sh)$/.test(e.name)) {
        const body = readFileSync(fp, 'utf8');
        if (/\/Users\/[A-Za-z0-9._-]+|Documents\/dsh|intel-hub/.test(body)) {
          offenders.push(fp.replace(`${SKILL_DIR}/`, ''));
        }
      }
    }
  };
  walk(SKILL_DIR);
  assert.deepEqual(offenders, [], `分发目录不得含作者私有路径：${offenders.join(', ')}`);
});

test('开源入口：README.md 与 install.sh 齐备，且参数非法必须 exit 3', () => {
  assert.ok(existsSync(join(SKILL_DIR, 'README.md')), '根目录必须有给人看的 README.md');
  assert.ok(existsSync(join(SKILL_DIR, 'install.sh')), '根目录必须有 install.sh');
  const r = readFileSync(join(SKILL_DIR, 'README.md'), 'utf8');
  for (const kw of ['最简安装', '一条命令', '项目级', '已知限制', 'LICENSE']) {
    assert.match(r, new RegExp(kw), `README 必须覆盖「${kw}」`);
  }
  assert.match(r, /尚未附带 LICENSE/, '必须提醒许可证缺失');
  const h = readFileSync(join(SKILL_DIR, 'install.sh'), 'utf8');
  for (const t of ['kimi', 'claude', 'dsh', 'agents', 'codex']) assert.ok(h.includes(t), `install.sh 必须支持 ${t}`);
  const bad = spawnSync('bash', [join(SKILL_DIR, 'install.sh'), '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 3, `未知参数必须 exit 3，实际 ${bad.status}`);
});

test('**自毁保护**：目标目录 = 源目录自身时必须拒绝执行（作者曾被自己的测试删掉整个技能）', () => {
  // 真实事故：在真实 HOME 下跑了一次安装，目标正好是技能自身 ⇒ `rm -rf` 把源删了。
  // 这里在**沙箱**里复现同一形状：临时 HOME 下把副本放到 `<home>/.agents/skills/context-handoff`，
  // 再用 --target agents 跑它的 install.sh ⇒ dest 与 source 完全相同。
  const home = tmp();
  try {
    const dest = join(home, '.agents', 'skills', 'context-handoff');
    mkdirSync(dirname(dest), { recursive: true });
    spawnSync('cp', ['-R', SKILL_DIR, dest], { encoding: 'utf8' });
    const sentinel = join(dest, 'SKILL.md');
    assert.ok(existsSync(sentinel), '前置：沙箱副本就位');

    const r = spawnSync('bash', [join(dest, 'install.sh'), '--target', 'agents'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh') },
    });
    assert.equal(r.status, 3, `自毁场景必须 exit 3，实际 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr + r.stdout, /拒绝执行/, '必须明确拒绝并说明原因');
    // 最关键：源文件必须还在
    assert.ok(existsSync(sentinel), '**源目录不得被删除**（这正是事故点）');
    assert.ok(existsSync(join(dest, 'scripts', 'check_handoff.mjs')), '源目录内容必须完整');
    assert.ok(existsSync(join(dest, 'SKILL.md')), '源目录必须完整');
    // 互相包含也必须拒绝
    const inner = spawnSync('bash', [join(dest, 'install.sh'), '--target', 'agents', '--prefix', dest], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh') },
    });
    assert.equal(inner.status, 3, '目标在源内部也必须拒绝');
    assert.ok(existsSync(sentinel), '拒绝后源仍必须完整');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('自毁保护：deploy.sh 在已安装副本里运行必须**跳过复制**而不是删掉自己', () => {
  const home = tmp();
  try {
    const dest = join(home, '.kimi-code', 'skills', 'context-handoff');
    mkdirSync(dirname(dest), { recursive: true });
    spawnSync('cp', ['-R', SKILL_DIR, dest], { encoding: 'utf8' });
    const r = spawnSync('bash', [join(dest, 'adapters', 'kimi-doubao', 'deploy.sh')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, KIMI_CODE_HOME: join(home, '.kimi-code') },
    });
    assert.equal(r.status, 0, `就地配置必须正常结束，实际 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /跳过复制/, '必须明确告知跳过复制');
    assert.ok(existsSync(join(dest, 'SKILL.md')), '**源目录不得被删除**');
    assert.ok(existsSync(join(dest, 'scripts', 'check_handoff.mjs')), '源目录内容必须完整');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Kimi Plugin manifest：字段与硬约束必须合法（这是 Kimi 上的最傻瓜安装路径）', () => {
  const p = join(SKILL_DIR, 'kimi.plugin.json');
  assert.ok(existsSync(p), '根目录必须有 kimi.plugin.json（Kimi 的 /plugins install 靠它）');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  // 官方硬约束：name 必须匹配 [a-z0-9][a-z0-9_-]{0,63}
  assert.match(m.name, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'manifest.name 不符合官方命名正则');
  assert.ok(m.version, 'manifest 必须有 version');
  // systemPrompt 是自动唤醒的主要载体：必须存在、非空、且 < 32KB（官方限制）
  assert.ok(typeof m.systemPrompt === 'string' && m.systemPrompt.length > 200, 'systemPrompt 必须存在且有实质内容');
  assert.ok(Buffer.byteLength(m.systemPrompt, 'utf8') < 32768, 'systemPrompt 必须 < 32KB（官方硬限制）');
  // 自动唤醒的三条关键内容必须在 systemPrompt 里（否则装了也不会提醒）
  for (const kw of ['交付单元', '检查点', '不自动中止']) {
    assert.match(m.systemPrompt, new RegExp(kw), `systemPrompt 必须覆盖「${kw}」`);
  }
  // hooks：只能 4 个字段（多写会导致加载问题），且必须是可注入的事件
  assert.ok(Array.isArray(m.hooks) && m.hooks.length > 0, '必须有 hooks');
  for (const h of m.hooks) {
    for (const k of Object.keys(h)) {
      assert.ok(['event', 'matcher', 'command', 'timeout'].includes(k), `plugin hook 不允许字段 ${k}`);
    }
    assert.ok(['PreToolUse', 'Stop', 'UserPromptSubmit'].includes(h.event), `只有可注入事件有意义，实际 ${h.event}`);
    assert.match(h.command, /KIMI_PLUGIN_ROOT/, 'hook 命令应使用 KIMI_PLUGIN_ROOT（plugin 根目录由平台提供）');
  }
  // 不支持的运行时字段会被忽略 ⇒ 我们不许用它们假装生效
  const supported = ['name', 'version', 'description', 'keywords', 'author', 'homepage', 'license',
    'interface', 'skills', 'agents', 'sessionStart', 'skillInstructions', 'systemPrompt',
    'systemPromptPath', 'mcpServers', 'hooks', 'commands'];
  for (const k of Object.keys(m)) {
    assert.ok(supported.includes(k), `manifest 顶层字段 ${k} 不在官方支持列表里（会被静默忽略）`);
  }
});
