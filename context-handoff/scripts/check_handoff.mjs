#!/usr/bin/env node
/**
 * context-handoff · 判据 CLI
 *
 * 子命令：
 *   init   <file>                          建立骨架（已存在则拒绝，exit 3）
 *   check  <file> [--json] [--against <prev>] [--changed id1,id2]
 *                                          校验字段完整性 + 空面判红；--against 额外做幂等/漂移判据
 *   compare <old> <new> [--json]           列出变化节
 *   next   <prev> --payload <json> [--json] [--expect-mtime <ms>]
 *                                          生成新一版；未声明变化的节**逐字节保留**
 *   measure [--json]                       量化上下文占用（平台探测见 scripts/measure_context.mjs）
 *
 * 退出码：0=绿  2=判红（有 errors）  3=用法/前提错误  4=冲突（文件在你读后被改）
 */
import {
  readFileSync, writeFileSync, renameSync, existsSync, statSync, unlinkSync, mkdirSync,
  openSync, fsyncSync, closeSync, readdirSync, copyFileSync, chmodSync,
} from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  VERSION,
  SECTIONS,
  REQUIRED_ITEMS,
  validateHandoff,
  compareHandoffs,
  mergeHandoff,
  renderHandoff,
  parseProvenance,
  parseSections,
  utcStamp,
} from './lib/handoff.mjs';

/* ── 参数解析（带白名单：拼错的 flag 必须报错，不能静默忽略 —— E3 评审 F5） ── */
const COMMANDS = new Set(['init', 'check', 'compare', 'next', 'restore', 'measure']);
const FLAG_SPEC = {
  init: new Set(['json', 'workspace', 'trigger', 'force']),
  check: new Set(['json', 'against', 'changed']),
  compare: new Set(['json']),
  next: new Set(['json', 'payload', 'out', 'expect-mtime', 'archive-dir', 'round', 'updated_utc', 'supersedes', 'trigger', 'occupancy', 'occupancy_source', 'status', 'workspace', 'restore', 'force']),
  restore: new Set(['json', 'dry-run']),
  measure: new Set(['json', 'workspace', 'session', 'override', 'platform', 'source', 'context-window']),
};

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const positional = [];
const unknownFlags = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const allowed = FLAG_SPEC[cmd];
    if (!allowed || !allowed.has(key)) unknownFlags.push(a);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  } else {
    positional.push(a);
  }
}

const useJson = Boolean(flags.json);

/**
 * 未知参数的检查必须**紧跟在解析之后**（E3 评审 F5）。
 * 早期版本把它放在全部子命令 if 块之后 ⇒ 子命令自己 `process.exit` 了，检查永远到不了，
 * 于是 `--expect-mtme`（拼错）被静默忽略、并发保护形同不存在。
 */
if (cmd && COMMANDS.has(cmd) && unknownFlags.length) {
  const payload = {
    ok: false,
    code: 3,
    message: `未知参数：${unknownFlags.join(' ')}（子命令 ${cmd} 不接受；拼错的保护参数不会被静默忽略）`,
    unknown: unknownFlags,
    allowed: [...(FLAG_SPEC[cmd] || [])],
  };
  if (useJson) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stderr.write(`✖ ${payload.message}\n`);
  process.exit(3);
}

function out(obj, human) {
  if (useJson) process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  else process.stdout.write(`${human}\n`);
}

function die(code, message, extra) {
  if (useJson) process.stdout.write(`${JSON.stringify({ ok: false, code, message, ...(extra || {}) }, null, 2)}\n`);
  else process.stderr.write(`✖ ${message}\n`);
  process.exit(code);
}

/** 兜底：任何未预期异常都要变成文档化的退出码 3，而不是裸堆栈 + exit 1（E4 B1 / E3 F11）。 */
process.on('uncaughtException', (e) => {
  die(3, `未预期的错误（已兜底为退出码 3）：${e && e.message ? e.message : String(e)}`);
});
process.on('unhandledRejection', (e) => {
  die(3, `未预期的异步错误（已兜底为退出码 3）：${e && e.message ? e.message : String(e)}`);
});

/**
 * 读入并**严格**按 UTF-8 解码。
 * E3 评审 F5 表第 6 行：非法 UTF-8 会被 Node 静默替换成 U+FFFD 后判绿 —— 那是"静默接受损坏"。
 * 这里用 fatal 解码器，解不开就判红。
 */
function readText(p) {
  const abs = resolve(p);
  if (!existsSync(abs)) die(3, `文件不存在：${abs}`);
  const buf = readFileSync(abs);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    die(2, `文件不是合法 UTF-8（解码失败，拒绝按损坏内容继续）：${abs}`);
  }
  return { abs, text, mtime: statSync(abs).mtimeMs, mode: statSync(abs).mode & 0o777 };
}

/**
 * 原子写：同目录临时文件 + fsync + rename + 目录 fsync。
 * · 保留原文件权限位（E3 F4：0600 的交接物不该被改成 0644）
 * · 目标父目录不存在则创建（E4 B1：init 到不存在的目录不该裸崩）
 */
function atomicWrite(abs, text, { mode, expectContent } = {}) {
  const dir = dirname(abs);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    die(3, `无法创建目标目录 ${dir}：${e.message}`);
  }
  let keepMode = mode;
  if (keepMode === undefined && existsSync(abs)) keepMode = statSync(abs).mode & 0o777;
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.handoff.tmp`);
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: keepMode === undefined ? 0o644 : keepMode });
    if (keepMode !== undefined) {
      try {
        chmodSync(tmp, keepMode);
      } catch {
        /* 某些平台/文件系统不支持；不因此中断写盘 */
      }
    }
    // fsync 数据落盘（E3 F9）
    try {
      const fd = openSync(tmp, 'r+');
      fsyncSync(fd);
      closeSync(fd);
    } catch {
      /* fsync 不可用时退化为仅 rename 的原子性，不中断 */
    }
    // 并发 CAS 的第二道闸（收窄窗口）：mtime 校验发生在"读入之后"，而写盘可能要几十毫秒到几秒
    // （尤其交接物很大时）。这段时间里如果**不受我们协调的外部写入**改了目标，mtime 闸就漏了。
    // 所以在 rename **之前最后一刻**再重读目标并与"我们读到的内容"逐字节比对：
    //   · 不一致 ⇒ 有人改过 ⇒ 抛冲突（由调用方转成 exit 4）
    // 这仍不是原子的（verify 与 rename 之间还有极小的窗口），但把窗口从"整个写盘耗时"压到"一次 read+rename"。
    // 残留风险已如实记录在 references/design-notes.md。
    if (expectContent !== undefined) {
      let current = null;
      try {
        current = readFileSync(abs, 'utf8');
      } catch (e) {
        if (e && e.code === 'ENOENT') current = null; // 目标被删不算覆盖冲突
        else throw e;
      }
      if (current !== null && current !== expectContent) {
        const err = new Error('CONCURRENT_MODIFICATION');
        err.code = 'CONCURRENT_MODIFICATION';
        throw err;
      }
    }
    renameSync(tmp, abs);
    // rename 之后 fsync 父目录，保证目录项落盘
    try {
      const dfd = openSync(dir, 'r');
      fsyncSync(dfd);
      closeSync(dfd);
    } catch {
      /* 目录 fsync 在部分平台不可用 */
    }
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    // ⚠️ 并发冲突**必须原样抛给调用方**去映射成 exit 4（R4β #5 实测：这里直接 die(3)，
    // 导致调用方的 die(4) 成了死代码，CAS 命中时退出码是 3 而不是文档承诺的"4＝并发冲突"）。
    if (e && (e.code === 'CONCURRENT_MODIFICATION' || /CONCURRENT_MODIFICATION/.test(String(e.message)))) {
      throw e;
    }
    die(3, `写盘失败（原文件未被改动）：${e.message}`);
  }
  return abs;
}

/**
 * 清理同目录下的孤儿临时文件（R3-B #6 整改）。
 * `.handoff.tmp` 里装着**整份交接物**；SIGKILL 落在"tmp 已写、rename 未执行"之间会留下它，
 * 旧实现没有任何清理路径 —— 既占空间、又可能泄露交接物内容（尤其原文是 0600 时）。
 * 只清理**超过 1 小时**的（避免误删另一个正在进行的写入）。
 */
function sweepOrphanTemps(dir) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!/^\.[0-9a-f]{12}\.handoff\.tmp$/.test(name)) continue;
      const fp = join(dir, name);
      try {
        if (statSync(fp).mtimeMs < cutoff) {
          unlinkSync(fp);
          removed += 1;
        }
      } catch {
        /* 单个失败不影响其它 */
      }
    }
  } catch {
    /* 目录读不到就算了 */
  }
  return removed;
}

/** 归档：把"更新前"那一版逐字复制过去，文件名内容寻址（可重放，不破坏幂等）。 */
/** 归档「更新前那一版」。命名内容寻址（round@指纹）⇒ 同一状态重放不新增文件、不破坏幂等。 */
function archivePrev({ prevText, round, fp, dir, mode }) {
  const abs = resolve(dir);
  try {
    mkdirSync(abs, { recursive: true, mode: 0o700 }); // 归档含交接物全文 ⇒ 目录收紧
  } catch (e) {
    die(3, `归档目录不可用：${abs}（${e.message}）`);
  }
  const name = `round-${round || 1}@${fp}.md`;
  const target = join(abs, name);
  if (existsSync(target)) {
    const existing = readFileSync(target, 'utf8');
    if (existing === prevText) return { target, created: false };
    die(
      4,
      `归档冲突：${target} 已存在且内容不同。拒绝覆盖历史归档。` +
        `（若这是"同一轮次、仅节外内容不同"的合法重放，请改用 --archive-dir 指定别的目录，或先归档再重试。）`,
    );
  }
  // 归档保留源文件权限位（R3-B #8：0600 的交接物不该在归档里变成 0644）
  atomicWrite(target, prevText, mode === undefined ? {} : { mode });
  return { target, created: true };
}

/* ─────────── 锁生命周期（E3 复评 N1/N2 整改） ───────────
 * 第 1 轮的实现有三个漏洞：①幂等放行分支 `process.exit(0)` 忘了 releaseLock；
 * ②`die(3)` 在加锁之后也会漏；③异常路径同样漏 ⇒ **跑两次之后永久 exit 4**。
 * 更糟的是当轮回归用例只验"锁被占要报 4"（检测侧），从未验"next 自己不许留锁"（释放侧），
 * 等于把 bug 固化成了判据。
 * 现在改成：进程级注册 + `process.on('exit')` 兜底释放，任何路径都不可能漏。
 */
let heldLockPath = null;
const LOCK_STALE_MS = 10 * 60 * 1000; // 内容不可解析的锁，超过这个年纪就当陈旧（防 0 字节锁永久死锁）

const isPidAlive = (pid) => {
  if (!Number.isFinite(pid) || pid <= 0) return null; // 未知
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !(e && e.code === 'ESRCH');
  }
};

/**
 * 抢占锁文件。返回值：{ok:true, reclaimed?:string} 或 {ok:false, reason, pid}。
 *
 * ⚠️ 这里修的是 R3-B 独立评审实测出的两个**严重**可靠性缺陷（自然条件下 610 轮里
 * 静默丢失更新 75 次 = 12.3%，两进程都 exit 0 且都打印成功）：
 *
 * 1. **陈旧锁回收必须原子**。旧实现是 `unlinkSync(陈旧锁)` + `openSync(O_EXCL)` 两步：
 *    两个进程可同时通过"PID 已死"判定，A 删掉 B 刚建的**活锁**，于是双方"同时持锁"、互相覆盖。
 *    修法：用 `renameSync(lock, tombstone)` 抢占 —— rename 是原子的，**只有一个进程能成功**，
 *    失败的看到 ENOENT 就当"锁已被别人收走"，重试创建即可。绝不再裸 unlink。
 *
 * 2. **0 字节锁必须能自愈**。旧实现把"读不到 PID"当成"持有者存活"，于是 SIGKILL 恰好落在
 *    "锁已创建、PID 还没写进内容"那个窗口时，会留下一个 0 字节锁，**此后永久 exit 4**，
 *    只有人工 rm 才能恢复。修法：内容不可解析时按 **mtime 老化**回收（LOCK_STALE_MS）。
 */
function tryAcquireLock(lockPath) {
  // 直接创建成功 ⇒ 我们确实持锁
  try {
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { encoding: 'utf8', flag: 'wx' });
    heldLockPath = lockPath;
    return { ok: true };
  } catch (e) {
    if (!e || e.code !== 'EEXIST') return { ok: false, fatal: `无法创建锁文件 ${lockPath}：${e.message}` };
  }

  // 锁已存在：判断持有者是否已死
  let pid = NaN;
  let age = null;
  let parseable = false;
  let rawContent = null; // 供 rename 后校验"挪走的是不是同一把锁"
  try {
    rawContent = readFileSync(lockPath, 'utf8');
    const raw = rawContent.split('\n');
    pid = Number(raw[0]);
    const t = Number(raw[1] || 0);
    age = Number.isFinite(t) && t > 0 ? Date.now() - t : null;
    parseable = Number.isFinite(pid) && pid > 0;
  } catch {
    /* 读不到按不可解析处理 */
  }
  let mtimeAge = null;
  try {
    mtimeAge = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    /* 可能刚被别人收走 */
  }
  const alive = parseable ? isPidAlive(pid) : null;
  const staleByAge = mtimeAge !== null && mtimeAge > LOCK_STALE_MS;
  const isStale = parseable ? alive === false : staleByAge;

  if (!isStale) {
    return {
      ok: false,
      reason: parseable
        ? `锁 ${lockPath} 由 PID ${pid} 持有（${age === null ? '年龄未知' : `${Math.round(age / 1000)}s 前取得`}）`
        : `锁 ${lockPath} 内容不可解析（可能是崩溃残留），年龄 ${mtimeAge === null ? '未知' : `${Math.round(mtimeAge / 1000)}s`}；超过 ${LOCK_STALE_MS / 60000} 分钟将自动回收`,
      pid: parseable ? pid : null,
    };
  }

  // 陈旧锁：**原子抢占**。rename 只有一个进程能成功（R3-B #1：旧实现 unlink+create 非原子，
  // 两个进程可同时通过"持有者已死"判定 → 双双持锁 → 静默丢失更新 12.3%）。
  const tomb = `${lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lockPath, tomb);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // 别人已收走：**我们并没有持锁**，必须重试创建（绝不能在这里谎报成功）
      return { ok: false, reason: '陈旧锁已被别的进程收走，正在重试' };
    }
    return { ok: false, fatal: `回收陈旧锁失败（rename）：${e.message}` };
  }
  // ⚠️ rename 走之后**必须校验挪走的确实是那把旧锁**（R4β 独立评审 #3 实测残留 0.9% 丢更新）：
  // 从"判定持有者已死"到 rename 之间，另一进程可能已经把旧锁收走并建了**自己的活锁**；
  // 此时我们的 rename 会把别人的活锁挪进墓碑，然后自己建锁成功 ⇒ **双方同时持锁**。
  // 修法：比对墓碑里的内容与我们刚才读到的原始内容；不一致 ⇒ 说明挪错了，放回去并重试。
  let movedContent = null;
  try {
    movedContent = readFileSync(tomb, 'utf8');
  } catch {
    movedContent = null;
  }
  if (movedContent !== null && rawContent !== null && movedContent !== rawContent) {
    // 挪错了：把别人的活锁放回去（尽力而为），然后重试
    try {
      if (!existsSync(lockPath)) renameSync(tomb, lockPath);
      else unlinkSync(tomb);
    } catch {
      /* 放不回去也不致命：真正的持有者仍握着它自己的 inode 语义，重试会重新判断 */
    }
    return { ok: false, reason: '锁在此期间被他人替换（可能已另持有者），正在重试' };
  }
  try {
    unlinkSync(tomb);
  } catch {
    /* 墓碑删不掉不影响正确性 */
  }
  // 抢占成功后立即以 O_EXCL 创建；若此刻别人抢先创建了，说明锁已归他 ⇒ 重试
  try {
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { encoding: 'utf8', flag: 'wx' });
    heldLockPath = lockPath;
    return { ok: true, reclaimed: lockPath };
  } catch (e) {
    if (e && e.code === 'EEXIST') return { ok: false, reason: '抢占陈旧锁后又被别的进程取得，正在重试' };
    return { ok: false, fatal: `回收旧锁后创建新锁失败：${e.message}` };
  }
}

/** 带重试的获取：raced 时重试；回收失败不直接 die（旧实现会假报 exit 3）。 */
function acquireLock(lockPath) {
  let last = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = tryAcquireLock(lockPath);
    if (r.ok) {
      if (r.reclaimed) warnText(`发现陈旧锁 ${r.reclaimed}（持有进程已不存在或锁内容不可解析）⇒ 已原子回收`);
      return lockPath;
    }
    if (r.fatal) die(3, r.fatal);
    last = r;
    // 极短退避后重试（raced 场景通常立刻成功）
    try {
      const until = Date.now() + 5;
      while (Date.now() < until) {
        /* busy-wait 5ms，避免引入异步 */
      }
    } catch {
      /* ignore */
    }
  }
  die(
    4,
    `冲突：${last && last.reason ? last.reason : lockPath} —— 另一个交接进程正在写同一目标。` +
      `禁止并行覆盖；若确认那是死进程可手工删除该锁文件。`,
    { lock: lockPath, pid: last ? last.pid : null },
  );
}

function releaseLock() {
  if (heldLockPath === null) return;
  const p = heldLockPath;
  heldLockPath = null;
  try {
    // 只删**自己的**锁：读回 PID 校验（R3-B #1 整改之一 —— 旧实现只按路径 unlink，
    // 会把别人接管后的新锁删掉）。
    let owner = NaN;
    try {
      owner = Number(String(readFileSync(p, 'utf8')).split('\n')[0]);
    } catch {
      owner = NaN;
    }
    if (Number.isFinite(owner) && owner > 0 && owner !== process.pid) return;
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* 释放失败不掩盖主流程错误 */
  }
}

// 兜底：任何退出路径（含 die 的 process.exit、未捕获异常）都释放锁
process.on('exit', () => {
  try {
    releaseLock();
  } catch {
    /* ignore */
  }
});

/**
 * 解析"真正要写哪个文件"。
 * E3 复评 N3：`next` 用 rename 覆盖目标，若目标是**符号链接**，rename 会把符号链接
 * 替换成普通文件 ⇒ 真实目标永不更新（写到错误位置）。所以写入前先 realpath 到真实路径。
 */
function resolveWriteTarget(abs) {
  let cur = abs;
  if (existsSync(cur)) {
    try {
      cur = realpathSync(cur);
    } catch {
      /* 解析失败就用原路径 */
    }
  }
  return { writePath: cur, wasSymlink: cur !== abs };
}

function fmtErrors(errors) {
  return errors.map((e) => `  ✖ [${e.code}] ${e.detail}`).join('\n');
}
function fmtWarnings(warnings) {
  return warnings.map((w) => `  ⚠ [${w.code}] ${w.detail}`).join('\n');
}

/** 骨架未填写时的总结提示（E4 I1：22 条 E_ITEM_EMPTY 洪水里没有一句"骨架本来就这样"）。 */
function skeletonHint(text, errors) {
  // 只认**节体里**的真标记（`parseSections` 后逐节查），因为说明文字里也会提到这个标记名
  const secs = parseSections(text);
  const hasUnfilled = SECTIONS.some((id) => {
    const sec = secs.sectionsById[id];
    return sec && /<!--\s*HANDOFF:CONTENT\s*-->/.test(sec.body);
  });
  if (!hasUnfilled) return null;
  const n = errors.filter((e) => e.code === 'E_ITEM_EMPTY' || e.code === 'E_ITEM_MISSING').length;
  return (
    `骨架尚未填写（这是正常的）：还有约 ${n} 项待填。` +
    `逐节把内容补上，并**删掉该节的 <!-- HANDOFF:CONTENT --> 那一行**；` +
    `确实没有内容的子项就写「无」（显式否定是合法的，留空才判红）。`
  );
}

/**
 * 内容指纹：只覆盖"节"的字节（不含 provenance）。
 *
 * 为什么需要它：`next` 要更新 provenance（round/updated_utc/supersedes），若这些字段
 * 依赖绝对路径或无条件自增，同一个 payload 连跑两次就会产出不同字节 —— 幂等判据立刻破功。
 * 所以 round / supersedes 一律由**内容指纹**决定，与文件位置、运行时刻无关。
 * `updated_utc` 是唯一的时间性字段，允许调用方显式给定。
 */
function contentFingerprint(text) {
  const parsed = parseSections(text);
  const parts = SECTIONS.map((id) => `${id}\u0000${parsed.sectionsById[id] ? parsed.sectionsById[id].body : ''}`);
  return createHash('sha256').update(parts.join('\u0001'), 'utf8').digest('hex').slice(0, 12);
}

/**
 * 归档用的**整文件**指纹（R3-A 独立评审 #3 整改）。
 * 与 contentFingerprint 的区别：后者只覆盖"节体"，用于判断内容是否变化（幂等语义）；
 * 归档名必须锚定**整份文件的字节**，否则两份"节体相同但节外内容不同"的文件会算出同一个归档名，
 * 第二次 `restore` 就会撞上"归档已存在且内容不同"而永久 exit 4 —— 把恢复通道堵死。
 */
function archiveFingerprint(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** 内容变了 ⇒ round+1；内容没变 ⇒ 沿用上一版（幂等前提）。 */
function nextRound(prevKeys, fpChanged) {
  const prevRound = Number(prevKeys.round || 1);
  return fpChanged ? prevRound + 1 : prevRound;
}

/** 非致命的提醒：走 stderr，不影响退出码。 */
function warnText(message) {
  process.stderr.write(`⚠ ${message}\n`);
}

/* ───────────────────────────── init ───────────────────────────── */

/**
 * init 的骨架**复用生成器**（`gen_template.mjs` 的 `renderTemplate`），
 * 而不是自己再拼一份 —— 否则同一产物有两条生产者，`init` 那条会丢掉全部指引
 * （E4 复评 R1 实测：模板 88 行含 9 行指引 + 每节说明，init 产物只有 80 行、零指引）。
 */
async function buildInitialSkeletonText(prov) {
  const { renderTemplate } = await import('./gen_template.mjs');
  return renderTemplate({ ...prov, hints: false });
}

if (cmd === 'init') {
  const target = positional[0];
  if (!target) die(3, '用法：check_handoff.mjs init <file> [--force] [--workspace <dir>] [--trigger <t>]');
  const abs = resolve(target);
  if (existsSync(abs) && !flags.force) {
    die(3, `目标已存在，禁止用 init 覆盖（首轮建立才用 init；后续请用 next；确要重建请显式 --force）：${abs}`, {
      target: abs,
      hint: '--force 会先把现有文件按**内容寻址**（round@指纹）归档到 <dir>/.handoff-archive/ 再重建',
    });
  }
  if (existsSync(abs) && flags.force) {
    // E3 评审 F7：重建前必须先备份，否则会丢掉 decisions/boundaries 历史。
    const prevText = readFileSync(abs, 'utf8');
    const fp = archiveFingerprint(prevText);
    const prevKeys = parseProvenance(prevText).keys || {};
    const a = archivePrev({
      prevText,
      round: prevKeys.round || 1,
      fp,
      dir: join(dirname(abs), '.handoff-archive'),
      mode: statSync(abs).mode & 0o777,
    });
    warnText(`--force 重建：已先归档旧文件 → ${a.target}`);
  }
  const text = await buildInitialSkeletonText({
    round: 1,
    updated_utc: utcStamp(new Date()),
    workspace: resolve(flags.workspace || process.cwd()),
    trigger: flags.trigger || 'user-request',
    occupancy: 'unavailable',
    occupancy_source: 'unavailable',
    supersedes: 'none',
    status: 'draft',
  });
  atomicWrite(abs, text);
  out(
    { ok: true, action: 'init', target: abs },
    `✔ 已建立骨架：${abs}\n  下一步：逐节填空；**每填完一节就删掉该节的 HANDOFF:CONTENT 标记行**，然后跑 check。`,
  );
  process.exit(0);
}

/* ───────────────────────────── check ───────────────────────────── */

if (cmd === 'check') {
  const target = positional[0];
  if (!target) die(3, '用法：check_handoff.mjs check <file> [--against <prev>] [--changed a,b]');
  const { abs, text } = readText(target);
  const result = validateHandoff(text);

  let idem = null;
  if (flags.against) {
    const prev = readText(flags.against);
    const cmp = compareHandoffs(prev.text, text);
    const declared = String(flags.changed || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    idem = { declared, ...cmp, errors: [] };
    if (declared.length) {
      for (const id of cmp.changed) {
        // E3 评审 F8：`next` 的正常产物必然改写 provenance（round/updated_utc/supersedes），
        // 而 compareHandoffs 把节外变化记成 `__outside__`。若要求调用方声明它，next 的正常产物
        // 就过不了自己的 --against 判据 —— 所以 `__outside__` 属**预期内**，不要求声明。
        if (id === '__outside__') continue;
        if (!declared.includes(id)) {
          idem.errors.push({
            code: 'E_UNDECLARED_CHANGE',
            detail: `节 ${id} 实际有变化，但未在 --changed 中声明（未变项必须逐字保留；确实变了就必须显式声明）`,
          });
        }
      }
      for (const id of declared) {
        if (id === '__outside__' || id === 'provenance') continue;
        if (!cmp.changed.includes(id)) {
          idem.errors.push({
            code: 'E_DECLARED_BUT_IDENTICAL',
            detail: `声明了节 ${id} 有变化，但两份文件该节逐字节相同（要么撤销声明，要么去掉这次"重写"）`,
          });
        }
      }
    }
  }

  const errors = result.errors.concat(idem ? idem.errors : []);
  const ok = errors.length === 0;
  const payload = {
    ok,
    file: abs,
    errors,
    warnings: result.warnings,
    meta: result.meta,
    ...(idem ? { idempotency: { declared: idem.declared, changed: idem.changed, added: idem.added, removed: idem.removed } } : {}),
  };
  if (useJson) out(payload);
  else {
    const lines = [];
    lines.push(`${ok ? '✔' : '✖'} check ${abs}`);
    const hint = skeletonHint(text, errors);
    if (hint) lines.push(`  ℹ ${hint}`);
    if (result.warnings.length) lines.push(fmtWarnings(result.warnings));
    if (errors.length) {
      // 骨架未填写时把 22 条同类错误折叠成一行，避免"判红洪水"淹没真正的问题（E4 I1）
      if (hint) {
        const byCode = new Map();
        for (const e of errors) byCode.set(e.code, (byCode.get(e.code) || 0) + 1);
        lines.push(`  ✖ 判红明细已折叠（骨架未填）：${[...byCode].map(([c, n]) => `${c}×${n}`).join('、')}；填完后若仍有红，这里会展开`);
      } else {
        lines.push(fmtErrors(errors));
      }
    }
    if (idem) {
      lines.push(
        `  幂等：声明变化 [${idem.declared.join(', ') || '-'}]｜实测变化 [${idem.changed.join(', ') || '-'}]` +
          `｜新增 [${idem.added.join(', ') || '-'}]｜缺失 [${idem.removed.join(', ') || '-'}]`,
      );
    }
    lines.push(ok ? '  判据：绿' : `  判据：红（${errors.length} 项）`);
    out(payload, lines.join('\n'));
  }
  process.exit(ok ? 0 : 2);
}

/* ───────────────────────────── compare ───────────────────────────── */

if (cmd === 'compare') {
  const [oldP, newP] = positional;
  if (!oldP || !newP) die(3, '用法：check_handoff.mjs compare <old> <new>');
  const a = readText(oldP);
  const b = readText(newP);
  const cmp = compareHandoffs(a.text, b.text);
  const payload = {
    ok: true,
    old: a.abs,
    new: b.abs,
    changed: cmp.changed,
    added: cmp.added,
    removed: cmp.removed,
    identical: cmp.identical,
  };
  if (useJson) out(payload);
  else {
    out(
      payload,
      [
        `✔ compare ${a.abs} → ${b.abs}`,
        `  变化节：[${cmp.changed.join(', ') || '-'}]`,
        `  新增节：[${cmp.added.join(', ') || '-'}]｜缺失节：[${cmp.removed.join(', ') || '-'}]`,
        cmp.identical ? '  两版语义完全相同（幂等：未变项逐字保留）' : '  存在变化',
      ].join('\n'),
    );
  }
  process.exit(0);
}

/* ───────────────────────────── next ───────────────────────────── */

if (cmd === 'next') {
  const prevP = positional[0];
  if (!prevP) {
    die(3, '用法：check_handoff.mjs next <prev> --payload <payload.json|-> [--out <file>] [--archive-dir <dir>] [--expect-mtime <ms>]');
  }
  if (!flags.payload) die(3, '必须提供 --payload <payload.json|->（"-" 表示从 stdin 读）');
  const prev = readText(prevP);

  // ── 并发保护（E3 评审 F5/F6）──────────────────────────────────────────────
  // ①目标文件（--out 时是目标，否则是 prev 自身）若已存在且声明了 --force 才允许覆盖；
  // ②读入时记下 mtime，**写盘前再校验一次**（把竞态窗口压到 rename 前的极小段）；
  // ③另用 O_CREAT|O_EXCL 锁文件做 compare-and-swap，两个进程同时 next 时后者必须拿到 exit 4。
  const targetPath = flags.out ? resolve(flags.out) : prev.abs;
  let targetMtimeAtRead = null;
  if (existsSync(targetPath)) {
    if (targetPath !== prev.abs && !flags.force) {
      die(3, `目标已存在：${targetPath}。拒绝静默覆盖；确要覆盖请显式 --force（或先用 init --force 备份）`, {
        target: targetPath,
        hint: '--force 会先把现有目标按内容寻址归档到同目录 .handoff-archive/',
      });
    }
    targetMtimeAtRead = statSync(targetPath).mtimeMs;
  }
  if (flags['expect-mtime'] !== undefined) {
    const expect = Number(flags['expect-mtime']);
    if (!Number.isFinite(expect)) die(3, `--expect-mtime 必须是数字，实际 ${flags['expect-mtime']}`);
    if (Math.abs(prev.mtime - expect) > 1) {
      die(4, `冲突：上一版在你读取后已被改动（mtime ${prev.mtime} ≠ 期望 ${expect}）。禁止覆盖，请重新读取后再合并。`, {
        file: prev.abs,
        mtime: prev.mtime,
        expected: expect,
      });
    }
  }

  // 锁文件 CAS。父目录必须先存在，否则会以 ENOENT 失败并给出误导性的"无法创建锁文件"。
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
  } catch (e) {
    die(3, `无法创建目标目录 ${dirname(targetPath)}：${e.message}`);
  }
  // 符号链接：写入前解析到真实路径（否则 rename 会把符号链接换成普通文件）
  const { writePath, wasSymlink } = resolveWriteTarget(targetPath);
  if (wasSymlink) warnText(`目标 ${targetPath} 是符号链接 ⇒ 实际写入 ${writePath}（保留符号链接语义）`);
  // 判"目标是不是 prev 本身"要用 realpath 比，否则符号链接场景会被误判成"写到别处、目标已存在"
  let prevReal = prev.abs;
  try {
    prevReal = realpathSync(prev.abs);
  } catch {
    /* 保持原样 */
  }
  const isSameTarget = writePath === prevReal || writePath === prev.abs;
  const lockPath = `${writePath}.lock`;
  const swept = sweepOrphanTemps(dirname(writePath));
  if (swept > 0) warnText(`清理了 ${swept} 个孤儿临时文件（上次写入被中断留下的）`);
  acquireLock(lockPath);

  // 前置门禁：**上一版必须本身判绿**才允许在它之上做增量（R3-B 独立评审 #5 整改）。
  // 旧行为：对一份判红的交接物跑 `next`（无实际变化时）会走"幂等放行"分支并报成功，
  // 出现 `check=2 → next=0（✔幂等）→ check=2` 这种自相矛盾的产物链。
  const prevVerdict = validateHandoff(prev.text);
  if (!prevVerdict.ok) {
    releaseLock();
    if (useJson) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: 2, stage: 'pre-merge-prev-invalid', errors: prevVerdict.errors }, null, 2)}\n`);
    } else {
      process.stderr.write(
        `✖ 上一版本身未过判据，拒绝在其之上做增量（先把它改绿，或从归档 restore）：\n${fmtErrors(prevVerdict.errors)}\n`,
      );
    }
    process.exit(2);
  }

  let raw;
  if (flags.payload === '-' || flags.payload === true) {
    raw = readFileSync(0, 'utf8');
  } else {
    const pf = resolve(flags.payload);
    if (!existsSync(pf)) {
      releaseLock();
      die(3, `payload 文件不存在：${pf}`);
    }
    raw = readFileSync(pf, 'utf8');
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    releaseLock();
    die(3, `payload 不是合法 JSON：${e.message}`);
  }

  const changed = Array.isArray(payload.changed) ? payload.changed : [];
  const provided = payload.sections || {};
  // payload 形状校验（R3-D 独立评审 #3）：这也是"新人卡在第 4 步"的直接原因 ——
  // 早期版本对形状只字未提，形状写错时报的是 E_SECTION_UNBALANCED（把人引向"我把文件改坏了"）。
  if (!Array.isArray(payload.changed)) {
    releaseLock();
    die(3, 'payload.changed 必须是数组，例如 {"changed":["status"],"sections":{"status":"- …"}}', {
      got: typeof payload.changed,
      schema: { changed: ['<节 id>'], sections: { '<节 id>': '<该节完整新节体>' }, updated_utc: '可选 YYYYMMDDTHHMMZ' },
    });
  }
  if (changed.length === 0) {
    releaseLock();
    die(3, 'payload.changed 为空：没有变化就不应该产出新一版（这正是幂等判据要拦的情况）');
  }
  const missingSections = changed.filter((id) => !(id in provided));
  if (missingSections.length) {
    releaseLock();
    die(3, `payload 形状错：changed 里声明了 [${missingSections.join(', ')}]，但 payload.sections 里没有对应内容。` +
      `正确形状：{"changed":["status"],"sections":{"status":"<该节完整新节体>"}}`, {
      declared: changed,
      providedKeys: Object.keys(provided),
    });
  }
  const unknownChanged = changed.filter((id) => !SECTIONS.includes(id));
  if (unknownChanged.length) {
    releaseLock();
    die(3, `payload.changed 里有未知节 id：${unknownChanged.join(', ')}（合法节：${SECTIONS.join(', ')}）`);
  }

  let merged;
  try {
    merged = mergeHandoff(prev.text, changed, provided);
  } catch (e) {
    releaseLock();
    die(3, `合并失败：${e.message}`);
  }

  // ── provenance 更新与幂等收口 ──────────────────────────────────────────────
  // 幂等要求：round / updated_utc / supersedes 必须只是**上一版内容的函数**，
  // 不能依赖"本次调用声明改了什么"、文件路径或当前时刻。否则对同一个状态重放
  // 同一份 HANDOFF 会产生新字节，幂等判据立刻破功。
  //   · 节内容未变 ⇒ round 沿用、supersedes 沿用（= 上一版自己的锚点）、其余沿用
  //   · 节内容变了 ⇒ round+1，supersedes 锚定上一版（round + 上一版节指纹）
  //   · updated_utc 是唯一时间性字段：沿用上一版；调用方要记真实时刻就在 payload 里给
  let text = merged.text;
  const prevProv = parseProvenance(prev.text);
  if (!prevProv.present) {
    releaseLock();
    die(3, '上一版缺少 provenance 区块，无法生成下一版');
  }
  const prevFp = contentFingerprint(prev.text);

  // 并发 CAS 必须先于"幂等放行"分支（R3-A 独立评审 #1）：
  // 早期版本把 mtime 校验放在 noop 分支**之后**，于是"读完 → 幂等放行 → 写回 prev.text"
  // 会静默覆盖这期间别人写进去的内容（实测：外部改动被吞、零告警）。
  // 幂等放行同样是**写盘**，必须受同一把并发保护。
  if (isSameTarget && existsSync(targetPath) && !flags.force) {
    const nowMs = statSync(targetPath).mtimeMs;
    if (Math.abs(nowMs - prev.mtime) > 1) {
      releaseLock();
      die(
        4,
        `冲突：${targetPath} 在本次运行期间被改动（mtime ${nowMs} ≠ 读入时 ${prev.mtime}）。` +
          `禁止覆盖，请重新读取后再合并（他人在建内容不会被静默吞掉）。`,
        { target: targetPath, mtime: nowMs, expected: prev.mtime },
      );
    }
  }

  const fpChanged = contentFingerprint(text) !== prevFp;
  const round = payload.round !== undefined ? String(payload.round) : String(nextRound(prevProv.keys, fpChanged));
  const nextProv = {
    ...prevProv.keys,
    version: String(VERSION),
    round,
    updated_utc: payload.updated_utc || prevProv.keys.updated_utc || utcStamp(new Date()),
    supersedes: payload.supersedes || prevProv.keys.supersedes || `round-${prevProv.keys.round || 1}@${prevFp}`,
  };
  // 内容变了：supersedes 必须指向刚被取代的那一版（含它的 round 与指纹），
  // 且该锚点只由上一版决定 ⇒ 可重放。
  if (fpChanged) nextProv.supersedes = `round-${prevProv.keys.round || 1}@${prevFp}`;
  // `trigger_detail` 是可选的归因字段：既可由 payload 指定，也要能从上一版**继承**。
  // R4β 实测：旧实现重建 provenance 时只写固定 9 键，于是 `next` 会**静默删掉** trigger_detail
  // （交接物上写了归因，跑一次增量就没了，而且没有任何提示）。
  const KNOWN_PROV_KEYS = ['version', 'round', 'updated_utc', 'workspace', 'trigger', 'occupancy', 'occupancy_source', 'supersedes', 'status', 'trigger_detail'];
  for (const k of ['workspace', 'trigger', 'trigger_detail', 'occupancy', 'occupancy_source', 'status']) {
    if (payload[k] !== undefined) nextProv[k] = String(payload[k]);
  }

  const provEquals = (a, b) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (String(a[k] ?? '') !== String(b[k] ?? '')) return false;
    return true;
  };

  // 幂等收口：节内容未变、且 provenance 各字段也都没变 ⇒ 逐字节复制上一版。
  // 这正是"同一输入连跑两次结果相同"的机械保证。
  if (!fpChanged && provEquals(nextProv, prevProv.keys)) {
    // 注意用 writePath（已 realpath）而不是原始 targetPath：
    // 否则 rename 会把符号链接替换成普通文件，真实目标永不更新（E3 复评 N3）。
    const target = writePath;
    // 幂等放行**同样在写盘**，必须受同一道内容 CAS（R3-A 实测：漏了这一处，
    // 大文件下 80ms 的外部写入会被吞掉而 exit 0）。
    try {
      atomicWrite(target, prev.text, { expectContent: prev.text });
    } catch (e) {
      releaseLock();
      if (e && (e.code === 'CONCURRENT_MODIFICATION' || /CONCURRENT_MODIFICATION/.test(String(e.message)))) {
        die(4, `冲突：${target} 在写入过程中被外部改动（幂等放行路径）。禁止覆盖，请重新读取。`, { target });
      }
      die(3, `写盘失败（原文件未被改动）：${e.message}`);
    }
    out(
      {
        ok: true,
        action: 'next',
        target,
        round: nextProv.round,
        changed,
        unchanged_preserved: SECTIONS.filter((id) => !changed.includes(id)),
        noop: true,
      },
      `✔ 第 ${nextProv.round} 版：内容与上一版逐字节相同（幂等），未产生改动 → ${target}`,
    );
    releaseLock();
    process.exit(0);
  }

  const nextFp = contentFingerprint(text);
  if (nextFp !== prevFp && (!nextProv.updated_utc || nextProv.updated_utc === prevProv.keys.updated_utc)) {
    warnText(
      '警告：内容已变化但没有新的 updated_utc（沿用上一版）。请在 payload 里显式给 updated_utc，' +
        '否则交接物上的时间戳会与实际不符。',
    );
  }
  const provLines = [
    '<!-- handoff:provenance -->',
    ...KNOWN_PROV_KEYS.filter((k) => k !== 'trigger_detail' || nextProv.trigger_detail !== undefined).map(
      (k) => `${k}: ${nextProv[k] ?? ''}`,
    ),
    '<!-- /handoff:provenance -->',
  ].join('\n');
  text = text.slice(0, prevProv.start) + provLines + text.slice(prevProv.end);

  // 自检：产物必须判绿，否则不许落盘。变量名避开子命令 `check` 的遮蔽（E3 F11）。
  const verdict = validateHandoff(text);
  if (!verdict.ok) {
    releaseLock();
    if (useJson) process.stdout.write(`${JSON.stringify({ ok: false, code: 2, stage: 'post-merge-check', errors: verdict.errors }, null, 2)}\n`);
    else process.stderr.write(`✖ 合并后的产物未过判据，拒绝落盘：\n${fmtErrors(verdict.errors)}\n`);
    process.exit(2);
  }

  // 未变节逐字保留的机械复核：与上版相比，节的变化必须恰好等于声明集合。
  // 说明：`__outside__` 是节外内容（provenance）——next 子命令本身就要改写它（round/updated_utc/
  // supersedes），这是它的职责，不属于"偷改节"，故从本复核里排除。
  const diff = compareHandoffs(prev.text, text);
  const extra = diff.changed.filter((id) => id !== '__outside__' && !changed.includes(id));
  if (extra.length) {
    releaseLock();
    process.stderr.write(`✖ 内部错误：未声明的节被改动了 [${extra.join(', ')}]，拒绝落盘\n`);
    process.exit(2);
  }

  const target = writePath;

  // 归档：把"更新前"那一版逐字留档（E3 F3 / E4 B3）。归档名内容寻址 ⇒ 可重放、不破坏幂等。
  // 顺序是**先归档再写正文**，反了会在崩溃时丢历史。
  let archived = null;
  if (flags['archive-dir']) {
    archived = archivePrev({
      prevText: prev.text,
      round: prevProv.keys.round || 1,
      fp: archiveFingerprint(prev.text),
      dir: flags['archive-dir'],
      mode: prev.mode,
    });
  }

  // 写出到**别的**目标时：若已存在必须 --force（绝不静默覆盖任意文件 —— E3 FMEA #8）
  if (!isSameTarget) {
    if (existsSync(target) && !flags.force) {
      releaseLock();
      die(3, `目标已存在：${target}。拒绝静默覆盖；确要覆盖请显式 --force。`, { target });
    }
    if (targetMtimeAtRead !== null && existsSync(target)) {
      const now = statSync(target).mtimeMs;
      if (Math.abs(now - targetMtimeAtRead) > 1 && !flags.force) {
        releaseLock();
        die(4, `冲突：目标 ${target} 在本次运行期间被改动（mtime ${now} ≠ ${targetMtimeAtRead}）。禁止覆盖。`, {
          target,
          mtime: now,
          expected: targetMtimeAtRead,
        });
      }
    }
    if (existsSync(target) && flags.force) {
      const oldText = readFileSync(target, 'utf8');
      archivePrev({
        prevText: oldText,
        round: (parseProvenance(oldText).keys || {}).round || 1,
        fp: archiveFingerprint(oldText),
        dir: join(dirname(target), '.handoff-archive'),
        mode: statSync(target).mode & 0o777,
      });
      warnText(`--force 覆盖：已把现有目标归档到 ${join(dirname(target), '.handoff-archive')}`);
    }
  }

  // 写盘前再校验一次被覆盖目标（原地 next 时 prev 即目标）
  if (isSameTarget) {
    const now = statSync(target).mtimeMs;
    if (Math.abs(now - prev.mtime) > 1) {
      releaseLock();
      die(4, `冲突：${target} 在本次运行期间被改动（mtime ${now} ≠ ${prev.mtime}）。禁止覆盖。`, {
        target,
        mtime: now,
        expected: prev.mtime,
      });
    }
  }

  try {
    atomicWrite(target, text, { mode: prev.mode, expectContent: prev.text });
  } catch (e) {
    releaseLock();
    if (e && (e.code === 'CONCURRENT_MODIFICATION' || /CONCURRENT_MODIFICATION/.test(String(e.message)))) {
      die(
        4,
        `冲突：${target} 在本次写入过程中被外部改动（内容已不同于读入时）。禁止覆盖，请重新读取后再合并。`,
        { target },
      );
    }
    die(3, `写盘失败（原文件未被改动）：${e.message}`);
  }
  releaseLock();
  out(
    {
      ok: true,
      action: 'next',
      target,
      round: nextProv.round,
      changed,
      unchanged_preserved: SECTIONS.filter((id) => !changed.includes(id)),
      ...(archived ? { archived: archived.target, archive_created: archived.created } : {}),
    },
    `✔ 已生成第 ${nextProv.round} 版：${target}` +
      `\n  变化节：[${changed.join(', ')}]` +
      `\n  逐字保留：[${SECTIONS.filter((id) => !changed.includes(id)).join(', ')}]` +
      (archived ? `\n  已归档上一版：${archived.target}` : ''),
  );
  process.exit(0);
}

/* ───────────────────────────── restore ───────────────────────────── */

if (cmd === 'restore') {
  const [archiveP, targetP] = positional;
  if (!archiveP || !targetP) die(3, '用法：check_handoff.mjs restore <archive.md> <target.md> [--dry-run]');
  const a = readText(archiveP);
  const t = resolve(targetP);
  const v = validateHandoff(a.text);
  if (flags['dry-run']) {
    out(
      { ok: true, action: 'restore', dry_run: true, archive: a.abs, target: t, archive_valid: v.ok, errors: v.errors },
      `✔ 预演：${a.abs} → ${t}（归档本身判据：${v.ok ? '绿' : `红（${v.errors.length} 项）`}）`,
    );
    process.exit(0);
  }
  // restore 也必须参与并发保护（R3-B #4：旧版 restore 完全不受锁与 mtime 守卫，
  // 目标有活锁时 next=exit4 而 restore=exit0 并改写目标）。符号链接同 next 处理。
  const realT = resolveWriteTarget(t);
  let restoreLocked = false;
  let curMtime = null;
  if (existsSync(t)) {
    const lockPath = `${realT.writePath}.lock`;
    acquireLock(lockPath);
    restoreLocked = true;
    curMtime = statSync(t).mtimeMs;
    // 回退前先把"当前这份"留档，避免回退本身变成新的丢历史（E3 FMEA #7）
    const cur = readFileSync(t, 'utf8');
    archivePrev({
      prevText: cur,
      round: (parseProvenance(cur).keys || {}).round || 1,
      fp: archiveFingerprint(cur),
      dir: join(dirname(t), '.handoff-archive'),
      mode: statSync(t).mode & 0o777,
    });
  }
  if (!restoreLocked) {
    // 目标还不存在：也要上锁，避免并发的 next/restore 同时创建
    acquireLock(`${realT.writePath}.lock`);
    restoreLocked = true;
  }
  atomicWrite(realT.writePath, a.text, { mode: existsSync(t) ? statSync(t).mode & 0o777 : 0o644 });
  releaseLock();
  out(
    { ok: true, action: 'restore', archive: a.abs, target: t, target_mtime_before: curMtime, archive_valid: v.ok },
    `✔ 已回退：${a.abs} → ${t}（回退前那份已留档；归档自身判据：${v.ok ? '绿' : '红'}）`,
  );
  process.exit(v.ok ? 0 : 2);
}

/* ───────────────────────────── measure ───────────────────────────── */

if (cmd === 'measure') {
  const { measureContext } = await import('./measure_context.mjs');
  const r = await measureContext({
    workspace: flags.workspace || process.cwd(),
    sessionId: flags.session,
    override: flags.override,
    source: flags.source,
    platform: flags.platform,
    contextWindow: flags['context-window'],
  });
  // E3 评审 F10：「取不到占用」是**正常降级**，不是错误 ⇒ exit 0。
  // 但要区分**参数非法**（用法错 ⇒ exit 3）：R4β #7 实测旧行为把 `--override 150` 当成降级 exit 0，
  // 等于"悄悄接受了一个坏参数"，调用方无法据此发现问题。
  if (r.ok) out(r, `✔ 占用 ${r.occupancy}（来源 ${r.source}，阈值 ${JSON.stringify(r.thresholds)}）`);
  else out(r, `ℹ 取不到量化占用（这是正常的降级，不是失败）：${r.reason}`);
  process.exit(r.ok ? 0 : r.usageError ? 3 : 0);
}

if (cmd === '--help' || cmd === '-h' || cmd === undefined) {
  process.stdout.write(
    [
      'context-handoff 判据 CLI',
      '',
      '  init    <file> [--force] [--workspace <dir>] [--trigger <t>]',
      '                                       建立骨架（已存在则 exit 3；--force 先归档再重建）',
      '  check   <file> [--json] [--against <prev>] [--changed a,b]',
      '                                       字段完整性 + 空面判红；--against 加幂等/漂移判据',
      '  compare <old> <new> [--json]         列出变化节',
      '  next    <prev> --payload <p.json|-> [--out <file>] [--archive-dir <dir>]',
      '          [--expect-mtime <ms>] [--force]',
      '                                       生成新版；未声明变化的节逐字节保留；先归档再写正文',
      '  restore <archive.md> <target.md> [--dry-run]',
      '                                       从归档回退（回退前先把当前这份留档）',
      '  measure [--json] [--workspace <dir>] [--session <id>]',
      '          [--override <0-1|百分数>] [--source <名>] [--context-window <tokens>]',
      '                                       量化上下文占用（取不到 = exit 0 + unavailable）',
      '',
      '退出码：0 绿 ｜ 2 判红 ｜ 3 用法/前提错误 ｜ 4 并发冲突（含锁被占）',
      '未知 --flag 一律 exit 3（拼错的保护参数不会被静默忽略）',
      '',
    ].join('\n'),
  );
  process.exit(cmd === undefined ? 3 : 0);
}

die(3, `未知子命令：${cmd}（用 --help 看用法）`);
