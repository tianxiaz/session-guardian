#!/usr/bin/env node
// DSH 定时提醒导出（只读，不修改任何文件）
// 用途：会话切换前，把旧会话挂着的定时提醒读出来，避免归档时丢失。
// 用法：
//   node scripts/schedule-export.mjs --session <旧会话id>
//   node scripts/schedule-export.mjs --session <旧会话id> --json > sched.json
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const P = join(homedir(), '.dsh', 'storages', 'schedule.json');
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : ''; };
const sessionId = arg('session');
if (!sessionId) { console.error('用法: node scripts/schedule-export.mjs --session <sessionId> [--json]'); process.exit(2); }

let d;
try { d = JSON.parse(readFileSync(P, 'utf8')); } catch (e) { console.error('读不到', P, ':', e.message); process.exit(2); }

const tasks = (d.tables || {}).tasks || {};
const out = [];
for (const [id, e] of Object.entries(tasks)) {
  if (!e || e.sessionId !== sessionId) continue;
  out.push({ ...(e.record || {}), _id: (e.record && e.record.id) || id, _status: e.status });
}

if (argv.includes('--json')) {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  if (!out.length) {
    console.log(`会话 ${sessionId} 下没有定时提醒。`);
  } else {
    console.log(`会话 ${sessionId} 的定时提醒共 ${out.length} 条：\n`);
    out.forEach((s, i) => {
      console.log(`${i + 1}. [${s.kind}] ${s.title}（${s._status}）`);
      if (s.scheduledAt) console.log(`   scheduledAt: ${s.scheduledAt}`);
      if (s.afterSeconds) console.log(`   afterSeconds: ${s.afterSeconds}`);
      if (s.everySeconds) console.log(`   everySeconds: ${s.everySeconds}`);
      if (s.expression) console.log(`   cron: ${s.expression} @ ${s.timeZone || ''}`);
      if (s.time) console.log(`   time: ${s.time} @ ${s.timeZone || ''}${s.weekdays ? ` weekdays=${JSON.stringify(s.weekdays)}` : ''}`);
      console.log(`   prompt: ${String(s.prompt || '').slice(0, 110)}${String(s.prompt || '').length > 110 ? '…' : ''}\n`);
    });
    console.log('导出为 JSON：');
    console.log(`  node scripts/schedule-export.mjs --session ${sessionId} --json > sched.json`);
  }
}
