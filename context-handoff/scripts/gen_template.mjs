#!/usr/bin/env node
/**
 * 从 REQUIRED_ITEMS **生成** templates/HANDOFF.md。
 *
 * 为什么要有这个脚本：模板与判据一旦手工各写一份，必然漂移
 * （E3 评审 F2 实测：模板 22 子项 vs 判据 25 子项 ⇒ 照模板手抄的文件必然判红）。
 * 所以模板改为**生成物**，并由 scripts/tests 里的一致性用例守着。
 *
 * 用法：node scripts/gen_template.mjs [--check]
 *   --check：只校验磁盘上的模板与生成结果是否一致（不一致 ⇒ exit 2），不写盘。
 *            CI/自测用这一档；改判据后忘记重生成会被它抓住。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTIONS, REQUIRED_ITEMS, VERSION, utcStamp, ALLOWED_TRIGGERS } from './lib/handoff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = join(HERE, '..', 'templates', 'HANDOFF.md');

/** 各节的一句话说明（给人看，不参与判据）。 */
const SECTION_NOTE = {
  goal: '目标与验收。验收必须是**可判真假**的句子（"做好了"不算）。',
  status: '当前状态。**下列各项都要有内容**：确实没有就写「无」。',
  decisions: '关键决定与理由。`已否决` 写被否掉的方案＋原因；`尝试过` 写试过什么、为什么不行。',
  todo: '待办清单。与 `status.待办` **逐字节相同**（工具会逐字节比对，不一致判红）。',
  boundaries: '边界与禁区。`禁止` 至少一条且要**具体到文件/操作**，不要写"注意安全"。',
  environment: '约束与环境事实。`命令` 必须是**真跑过**的验证命令；`依赖状态` 写外部依赖现在能不能用。',
  evidence: '证据入口。提交写真实哈希；文件写相对路径（必要时附 `:行号`）；数字写实测值。',
  open_questions: '待用户/他人裁决的问题。',
};

export function renderTemplate(overrides = {}) {
  const lines = [];
  lines.push('# HANDOFF（上下文交接物）');
  lines.push('');
  lines.push('> 本文件由 `context-handoff` 技能维护。**节名、子项名、顺序固定**，任何改动都要过');
  lines.push('> `node <技能目录>/scripts/check_handoff.mjs check <本文件>`。');
  lines.push('>');
  lines.push('> 这个文件是**生成物**（`scripts/gen_template.mjs`）—— 想改字段，改 `scripts/lib/handoff.mjs`');
  lines.push('> 的 `REQUIRED_ITEMS` 再重新生成，不要直接手改本文件（手改必然与判据漂移）。');
  lines.push('>');
  lines.push('> 每个节开头有一行 `HANDOFF:CONTENT` 注释，是「尚未填写」的标记：');
  lines.push('> **填完一节就删掉该节的这一行注释**；保留它代表没填，`check` 会判红。');
  lines.push('> 确实没有内容的子项写「无」（显式否定合法）；不确定的写「未复核」＋复核方法。');
  lines.push('>');
  lines.push('> `provenance`（交接头，文件开头那段键值对）的语义 —— 常被读错，故明写：');
  lines.push('> **它描述的是「这份交接物」，不是「整个项目」**。');
  lines.push('> - `round` = **这份交接物自己被更新了几版**（首版 1；每做一次增量交接 +1），与项目进度无关');
  lines.push('> - `status` = **交接物是否可交付**：draft 未定稿 / complete 可交给下一个人 / blocked 被阻塞；');
  lines.push('>   它**不表示**整个项目完没完（项目进度看 `status` 节的已完成/进行中）');
  lines.push('> - `occupancy` = **写这份交接物那一刻**的上下文占用；占用低也完全可以做交接（例如用户明示、阶段收尾）');
  // ⚠️ 值域**从常量生成**，不手写：手写必然在扩展白名单后漂移（本轮实测：白名单扩到 17 个，
  // 模板提示还停在第 6 个，于是交接物里写了合法值却在同一文件里被列为非法）。
  lines.push(`> - \`trigger\` = ${ALLOWED_TRIGGERS.join(' | ')}`);
  lines.push('> - `supersedes` = none，或 `round-<正整数>@<8..64 位十六进制>`');
  lines.push('> - `updated_utc` = 真实存在的 UTC 时刻（YYYYMMDDTHHMMZ，脚本会做日历校验）');
  lines.push('');
  // provenance：给"模板"（hints=true）时带值域注释；给"init"（hints=false）时是可直接通过的干净值
  const H = overrides.hints !== false;
  const prov = [
    ['version', VERSION, ''],
    ['round', overrides.round ?? 1, ''],
    ['updated_utc', overrides.updated_utc ?? (H ? '' : utcStamp(new Date())), H ? '# 真实存在的 UTC 时刻，形如 20261016T1530Z（脚本会做日历校验）' : ''],
    ['workspace', overrides.workspace ?? (H ? '' : process.cwd()), H ? '# 工作区**绝对路径**' : ''],
    [
      'trigger',
      // 关键：**hints:false（init 产物）时必须给真值**，否则写成 `trigger:` + 行内注释会让
      // 解析器把注释当值读出来（`# user-request | …`）⇒ 直接判红。值域信息放在文件头的说明里。
      overrides.trigger ?? (H ? '' : 'user-request'),
      H ? `# ${ALLOWED_TRIGGERS.join(' | ')}` : '',
    ],
    ['occupancy', overrides.occupancy ?? 'unavailable', H ? '# 0–1 的小数，或 unavailable（取不到就写 unavailable，不许编）' : ''],
    ['occupancy_source', overrides.occupancy_source ?? 'unavailable', H ? '# 形如 <平台>:<测量源>；取不到写 unavailable' : ''],
    ['supersedes', overrides.supersedes ?? 'none', H ? '# none，或 round-<正整数>@<8..64 位十六进制>' : ''],
    ['status', overrides.status ?? 'draft', H ? '# draft | complete | blocked' : ''],
  ];
  lines.push('<!-- handoff:provenance -->');
  for (const [k, v, hint] of prov) {
    if (hint) {
      const pad = ' '.repeat(Math.max(1, 24 - k.length));
      lines.push(`${k}:${pad}${hint}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('<!-- /handoff:provenance -->');
  lines.push('');
  for (const id of SECTIONS) {
    lines.push(`<!-- handoff:section id=${id} -->`);
    lines.push(`<!-- ${SECTION_NOTE[id] || ''} -->`);
    lines.push('<!-- HANDOFF:CONTENT -->');  // 唯一的真标记：节内的这一行
    for (const key of REQUIRED_ITEMS[id] || []) lines.push(`- ${key}：`);
    lines.push('<!-- /handoff:section -->');
    lines.push('');
  }
  return lines.join('\n');
}

const checkOnly = process.argv.includes('--check');
const generated = renderTemplate();
/* 只有**直接执行**时才落盘 / 校验。
 * ⚠️ 必须是 `import.meta.main` 守卫：`init` 会 `import` 本模块复用 renderTemplate，
 * 若无守卫，每次 `init` 都会重写技能目录里的 templates/HANDOFF.md（mtime 变化 + 多一行噪声输出）。
 * （R3-D 独立评审发现 11） */
if (import.meta.main) {
  if (checkOnly) {
    const onDisk = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null;
    if (onDisk !== generated) {
      process.stderr.write(
        `✖ templates/HANDOFF.md 与 REQUIRED_ITEMS 不一致（模板是生成物，改判据后必须重新生成）\n` +
          `  修：node scripts/gen_template.mjs\n`,
      );
      process.exit(2);
    }
    process.stdout.write('✔ templates/HANDOFF.md 与 REQUIRED_ITEMS 一致\n');
    process.exit(0);
  }
  writeFileSync(TARGET, generated, 'utf8');
  process.stdout.write(`✔ 已生成 ${TARGET}\n`);
}
