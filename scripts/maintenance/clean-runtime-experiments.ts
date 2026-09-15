#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

/**
 * runtime 实验孤儿目录清理（2026-08-31 七维审计 P1「~190MB 实验目录无清理机制」）。
 *
 * 设计原则（安全第一）：
 *   - 默认 dry-run：只列出可回收目录、体积、最后活动时间，不删任何东西；
 *   - 白名单保护操作型目录（git-backups / desktop-updates / logs / keys /
 *     outputs / state 等）与全部未识别目录——未识别目录只报告、永不删除；
 *   - 仅当目录已被点名收录（KNOWN_EXPERIMENTS 或 tmp-* 前缀）且 mtime 超过
 *     --days（默认 30 天）无任何文件改动时，才进入可删除清单；
 *   - 真删除必须显式 --prune，且逐目录报告删除结果；被占用删除失败立即跳过。
 *
 * 用法：
 *   node scripts/maintenance/clean-runtime-experiments.js             # dry-run 报告
 *   node scripts/maintenance/clean-runtime-experiments.js --days 60   # 改门槛
 *   node scripts/maintenance/clean-runtime-experiments.js --prune     # 真删（先看 dry-run）
 *
 * 新实验目录收编：跑完实验后把目录名加进下方 KNOWN_EXPERIMENTS（连同提交），
 * 下次启动即可被本脚本接管。
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME = path.join(ROOT, 'runtime');

// 操作型/数据型目录：永不触碰
const PROTECTED = new Set([
  'git-backups', 'desktop-updates', 'logs', 'keys',
  'outputs', 'state', 'downloads',
  'review', 'maintenance-backups', 'translation', 'render-batch',
  'pose-openpose-full',
]);

// 已知实验/临时目录（2026-08-31 审计盘点）：允许在超龄后删除
const KNOWN_EXPERIMENTS = new Set([
  'short-film', 'Arknights-FlowingPoints-ref', 'krea150w_vs_500w',
  'ling_ab_test', 'hires-compare', 'krea2_ab', 'design-sheet-test',
  'showcase-temp', 'tmp-perf-test',
]);

const daysIndex = process.argv.indexOf('--days');
const DAYS = Number(process.argv[daysIndex + 1]) || 30;
const PRUNE = process.argv.includes('--prune');
const CUTOFF = Date.now() - DAYS * 24 * 60 * 60 * 1000;

function scanDir(dir: string) {
  // 递归求体积 + 最新 mtime（实验目录均 <100MB，遍历成本可忽略）
  let bytes = 0;
  let newest = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) stack.push(p);
        else { bytes += st.size; files += 1; if (st.mtimeMs > newest) newest = st.mtimeMs; }
      } catch { /* 文件被占用/消失则忽略 */ }
    }
  }
  return { bytes, newest, files };
}

function fmtMB(bytes: number) {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB';
}

function fmtAge(ms: number) {
  return ((Date.now() - ms) / 86400000).toFixed(2) + ' 天';
}

function main() {
  if (!fs.existsSync(RUNTIME)) {
    console.log('[clean-runtime-experiments] runtime/ 不存在，无事可做');
    return;
  }
  const reclaimable = [];
  const active = [];
  const unknown = [];

  for (const name of fs.readdirSync(RUNTIME, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const full = path.join(RUNTIME, name.name);
    if (PROTECTED.has(name.name)) continue;
    const isKnown = KNOWN_EXPERIMENTS.has(name.name) || /^tmp-/.test(name.name);
    const info = scanDir(full);
    const entry = { name: name.name, bytes: info.bytes, ageDays: info.newest ? fmtAge(info.newest) : '(空)', path: full };
    if (!isKnown) { unknown.push(entry); continue; }
    if (info.newest && info.newest > CUTOFF) { active.push(entry); continue; }
    reclaimable.push(entry);
  }

  const total = reclaimable.reduce((s, e) => s + e.bytes, 0);
  console.log(`[clean-runtime-experiments] 模式=${PRUNE ? 'PRUNE（真删）' : 'DRY-RUN（仅报告）'} 门槛=${DAYS} 天`);

  if (reclaimable.length) {
    console.log(`\n可回收（${reclaimable.length} 个，合计 ${fmtMB(total)}）：`);
    for (const e of reclaimable.sort((a, b) => b.bytes - a.bytes)) {
      console.log(`  - ${e.name.padEnd(32)} ${fmtMB(e.bytes).padStart(9)}  最后活动 ${e.ageDays}`);
    }
  } else {
    console.log('\n可回收：无');
  }
  if (active.length) {
    console.log(`\n实验目录但近期有活动（跳过）：`);
    for (const e of active) console.log(`  - ${e.name.padEnd(32)} ${fmtMB(e.bytes).padStart(9)}  最后活动 ${e.ageDays}`);
  }
  if (unknown.length) {
    console.log(`\n未识别目录（未处理；确认是实验后请收编进 KNOWN_EXPERIMENTS）：`);
    for (const e of unknown) console.log(`  - ${e.name.padEnd(32)} ${fmtMB(e.bytes).padStart(9)}  最后活动 ${e.ageDays}`);
  }

  if (!PRUNE) {
    if (reclaimable.length) console.log(`\n确认无误后执行真删：node scripts/maintenance/clean-runtime-experiments.js --prune`);
    return;
  }

  let freed = 0;
  let ok = 0;
  for (const e of reclaimable) {
    // 双重防御：路径必须位于 runtime/ 直接子级，且目录名不在白名单
    if (path.dirname(e.path) !== RUNTIME || PROTECTED.has(e.name) || e.name.includes('/') || e.name.includes('\\')) {
      console.log(`  [跳过] ${e.name}（防御性拦截）`);
      continue;
    }
    try {
      fs.rmSync(e.path, { recursive: true, force: true });
      freed += e.bytes;
      ok += 1;
      console.log(`  [已删] ${e.name}（${fmtMB(e.bytes)}）`);
    } catch (err) {
      console.log(`  [失败] ${e.name}：${String(runtimeErrorMessage(err)).split('\n')[0]}（被占用则留待下次）`);
    }
  }
  console.log(`\n删除 ${ok}/${reclaimable.length} 个目录，释放 ${fmtMB(freed)}`);
}

main();
