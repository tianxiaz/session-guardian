#!/usr/bin/env node
// 确定性会话衰退检测器（DSH 硬档）
// 用法: node check_session.mjs <session.v4.jsonl.zstd | 已解压 .jsonl> [--threshold N]
// 输出: JSON（degraded / 计数 / verdict）
// 依赖: 系统有 zstd 命令（DSH 本机已带）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
let threshold = 3;
const ti = args.indexOf('--threshold');
if (ti >= 0 && args[ti + 1]) threshold = parseInt(args[ti + 1], 10);

if (!file) {
  console.error('用法: node check_session.mjs <path> [--threshold N]');
  process.exit(3);
}

let text;
if (file.endsWith('.zstd')) {
  const r = spawnSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 1e9 });
  if (r.error || r.status !== 0) {
    console.error('zstd 解压失败: ' + (r.error ? r.error.message : r.stderr));
    process.exit(3);
  }
  text = r.stdout;
} else {
  text = fs.readFileSync(file, 'utf8');
}

// 纯催促词：短、含"继续"（可扩展到"继续吧/继续干/继续下一步/继续重跑"等）
const CONTINUE_RE = /^\s*(继续(下一步|吧|干|做|处理|重跑|开发)?|go\s*on|continue)\s*[，。.!！~～?？]*\s*$/i;

let turnCount = 0;
let compactionCount = 0;
let todoCount = 0;
const models = new Set();
const userTexts = [];

for (const line of text.split('\n')) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const t = o.type, d = o.data || {};
  if (t === 'turn/start') turnCount = Math.max(turnCount, d.turn || 0);
  else if (t === 'compaction/end') compactionCount++;
  else if (t === 'todo/write') todoCount++;
  else if (t === 'model/selection') { const m = d.model || d.provider; if (m) models.add(String(m)); }
  else if (t === 'user/message' && d.source && d.source.kind === 'user') {
    const txt = (d.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('').trim();
    if (txt) userTexts.push(txt);
  }
}

let maxRun = 0, cur = 0;
for (const txt of userTexts) {
  if (txt.length <= 20 && CONTINUE_RE.test(txt)) { cur++; maxRun = Math.max(maxRun, cur); }
  else cur = 0;
}

const degraded = maxRun >= threshold;
console.log(JSON.stringify({
  degraded,
  threshold,
  turnCount,
  consecutiveContinue: maxRun,
  compactionCount,
  todoCount,
  models: [...models],
  verdict: degraded
    ? `效能衰退：连续 ${maxRun} 次"继续"（≥阈值 ${threshold}）。建议停下 → 委托 context-handoff（trigger=degradation）写交接 → 提议切换会话。`
    : `未达阈值（连续"继续" ${maxRun} 次 < ${threshold}）。`
}, null, 2));
