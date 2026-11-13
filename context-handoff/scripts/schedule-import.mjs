#!/usr/bin/env node
// DSH 定时提醒导入（把导出的提醒写入指定会话）
// ⚠️ 实验性：直接写 ~/.dsh/storages/schedule.json，DSH 可能需要重启才读到。
//    更稳的方式：在新会话里把导出的 JSON 贴进去，说「用 schedule_create 按这个重建」。
// 用法：node scripts/schedule-import.mjs --from sched.json --session <新会话id>
// 会先备份 schedule.json。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const P = join(homedir(), '.dsh', 'storages', 'schedule.json');
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : ''; };
const from = arg('from');
const sessionId = arg('session');
if (!from || !sessionId) { console.error('用法: node scripts/schedule-import.mjs --from <export.json> --session <newSessionId>'); process.exit(2); }

const list = JSON.parse(readFileSync(from, 'utf8'));
if (!Array.isArray(list)) { console.error('导出文件不是数组'); process.exit(2); }

const d = JSON.parse(readFileSync(P, 'utf8'));
d.tables = d.tables || {};
d.tables.tasks = d.tables.tasks || {};

const bak = P + '.bak-' + Date.now();
copyFileSync(P, bak);

let n = 0;
const now = Date.now();
for (const s of list) {
  const { _id, _status, ...record } = s;
  record.id = 'schedule-' + randomUUID();
  // 一次性/延时任务，如果时间已过，标注但不阻断（DSH 会自行处理）
  const past = record.scheduledAt && Date.parse(record.scheduledAt) < now;
  d.tables.tasks[record.id] = { sessionId, record, status: 'active' };
  if (past) console.log(`⚠️  ${record.kind}「${record.title}」时间已过（${record.scheduledAt}），可能不会触发`);
  n++;
}
writeFileSync(P, JSON.stringify(d, null, 2));
console.log(`✅ 已写入 ${n} 条定时提醒到会话 ${sessionId}`);
console.log(`   备份：${bak}`);
console.log('⚠️  DSH 可能需要重启才能读到新 schedule；更稳的方式是在新会话里用 schedule_create 重建。');
