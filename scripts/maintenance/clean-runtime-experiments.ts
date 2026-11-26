#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

/**
 * runtime 过期实验目录与临时文件清理（安全第一）：
 *   - 默认 dry-run：只列出可回收项、体积、最后活动时间，不删任何东西；
 *   - 严格白名单保护：content / desktop-build-sdk / models / live2d-imports /
 *     catalog-backups / delivery-evidence / scene-repair / git-backups /
 *     desktop-updates / logs / keys / outputs / state 等核心目录与活跃部署日志永不触碰；
 *   - 支持清理超龄实验目录（默认 14 天）、runtime 根目录超龄临时文件，
 *     以及可选 --include-archive 清理被忽略的本地 scripts/archive/；
 *   - 真删除必须显式 --prune。
 */

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME = path.join(ROOT, 'runtime');
const ARCHIVE = path.join(ROOT, 'scripts', 'archive');

// 操作型/数据型目录：永不触碰
const PROTECTED = new Set([
  'content', 'desktop-build-sdk', 'models', 'live2d-imports',
  'catalog-backups', 'content-sync-backups', 'delivery-evidence', 'scene-repair',
  'git-backups', 'desktop-updates', 'logs', 'keys',
  'outputs', 'state', 'downloads',
  'review', 'maintenance-backups', 'translation', 'render-batch',
  'pose-openpose-full', '.cache', 'node_modules',
]);

const PROTECTED_FILES = new Set([
  'desktop-deploy-last.log',
  'desktop-deploy-build.log',
  'offline-install-pending.json',
  'desktop-deploy-timing.json',
  'desktop-deploy.lock',
]);

const TEMP_DIR_PREFIX = /^(?:tmp-|anima-|adult-blueprint-|functional-|frontend-|moss-|natsume-|nene-|roxy-|gpu-|native-|character-|recipe-|showcase-|catalog-|upstream-|h3-|wan-|adult-|qq-|release-|python-)/;
const TEMP_FILE_EXT = /\.(?:log|json|png|jpg|jpeg|webp|py|js|cjs|patch|txt|headers|md)$/i;

const KNOWN_EXPERIMENTS = new Set([
  'short-film', 'Arknights-FlowingPoints-ref', 'krea150w_vs_500w',
  'ling_ab_test', 'hires-compare', 'krea2_ab', 'design-sheet-test',
  'showcase-temp', 'tmp-perf-test',
]);

const daysIndex = process.argv.indexOf('--days');
const DAYS = daysIndex < 0 ? 14 : Number(process.argv[daysIndex + 1]);
if (!Number.isFinite(DAYS) || DAYS <= 0) throw new Error('--days must be a positive number');
const PRUNE = process.argv.includes('--prune');
const INCLUDE_ARCHIVE = process.argv.includes('--include-archive');
const CUTOFF = Date.now() - DAYS * 24 * 60 * 60 * 1000;

function scanDir(dir: string) {
  let bytes = 0;
  let newest = 0;
  let files = 0;
  let complete = true;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    try {
      const directory = fs.lstatSync(cur);
      if (!directory.isDirectory() || directory.isSymbolicLink()) { complete = false; continue; }
      newest = Math.max(newest, directory.mtimeMs);
      for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
        const file = path.join(cur, ent.name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) { complete = false; continue; }
        if (stat.isDirectory()) stack.push(file);
        else if (stat.isFile()) {
          bytes += stat.size; files += 1;
          newest = Math.max(newest, stat.mtimeMs);
        } else complete = false;
      }
    } catch { complete = false; }
  }
  return { bytes, newest, files, complete };
}

function fmtMB(bytes: number) {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB';
}

function fmtAge(ms: number) {
  return ((Date.now() - ms) / 86400000).toFixed(2) + ' 天';
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法: npm run wf -- runtime:clean [--days 14] [--prune] [--include-archive]');
    return;
  }

  type Entry = { name: string; kind: 'dir' | 'file'; bytes: number; ageDays: string; path: string };
  const reclaimable: Entry[] = [];
  const active: Entry[] = [];
  const unknown: Entry[] = [];

  if (fs.existsSync(RUNTIME)) {
    for (const ent of fs.readdirSync(RUNTIME, { withFileTypes: true })) {
      const full = path.join(RUNTIME, ent.name);
      if (ent.isDirectory()) {
        if (PROTECTED.has(ent.name)) continue;
        const isKnown = KNOWN_EXPERIMENTS.has(ent.name) || TEMP_DIR_PREFIX.test(ent.name);
        const info = scanDir(full);
        const entry: Entry = { name: ent.name, kind: 'dir', bytes: info.bytes, ageDays: info.newest ? fmtAge(info.newest) : '(空)', path: full };
        if (!isKnown || !info.complete) { unknown.push(entry); continue; }
        if (info.newest && info.newest > CUTOFF) { active.push(entry); continue; }
        reclaimable.push(entry);
      } else if (ent.isFile()) {
        if (PROTECTED_FILES.has(ent.name) || !TEMP_FILE_EXT.test(ent.name)) continue;
        try {
          const stat = fs.lstatSync(full);
          if (stat.isSymbolicLink() || !stat.isFile()) continue;
          const entry: Entry = { name: ent.name, kind: 'file', bytes: stat.size, ageDays: fmtAge(stat.mtimeMs), path: full };
          if (stat.mtimeMs > CUTOFF) active.push(entry);
          else reclaimable.push(entry);
        } catch { /* Ignore unreadable entry. */ }
      }
    }
  } else {
    console.log('[runtime:clean] runtime/ 不存在');
  }

  const archiveInfo = fs.existsSync(ARCHIVE) ? scanDir(ARCHIVE) : null;
  const total = reclaimable.reduce((s, e) => s + e.bytes, 0);
  console.log(`[runtime:clean] 模式=${PRUNE ? 'PRUNE（真删）' : 'DRY-RUN（仅报告）'} 门槛=${DAYS} 天`);

  if (reclaimable.length) {
    const dirCount = reclaimable.filter(e => e.kind === 'dir').length;
    const fileCount = reclaimable.length - dirCount;
    console.log(`\n可回收（${dirCount} 个目录 + ${fileCount} 个临时文件，合计 ${fmtMB(total)}）：`);
    for (const e of reclaimable.sort((a, b) => b.bytes - a.bytes).slice(0, 30)) {
      console.log(`  - [${e.kind}] ${e.name.padEnd(36)} ${fmtMB(e.bytes).padStart(9)}  最后活动 ${e.ageDays}`);
    }
    if (reclaimable.length > 30) {
      console.log(`  ... 其余 ${reclaimable.length - 30} 项已省略`);
    }
  } else {
    console.log('\n可回收：无');
  }
  if (active.length) {
    console.log(`\n近期仍有活动的临时项（跳过）：${active.length} 个`);
  }
  if (unknown.length) {
    console.log(`\n未识别目录（白名单外永不自动删除）：${unknown.length} 个`);
  }
  if (archiveInfo) {
    console.log(`\n本地归档目录 scripts/archive/：${archiveInfo.files} 个文件，共 ${fmtMB(archiveInfo.bytes)}${INCLUDE_ARCHIVE ? '（已指定 --include-archive）' : '（传 --include-archive --prune 可一并清理）'}`);
  }

  if (!PRUNE) {
    if (reclaimable.length || (INCLUDE_ARCHIVE && archiveInfo)) {
      console.log(`\n确认无误后执行真删：npm run wf -- runtime:clean -- --prune${INCLUDE_ARCHIVE ? ' --include-archive' : ''}`);
    }
    return;
  }

  let freed = 0;
  let ok = 0;
  for (const e of reclaimable) {
    if (path.dirname(e.path) !== RUNTIME || PROTECTED.has(e.name) || PROTECTED_FILES.has(e.name) || e.name.includes('/') || e.name.includes('\\')) {
      console.log(`  [跳过] ${e.name}（防御性拦截）`);
      continue;
    }
    try {
      if (e.kind === 'dir') {
        const current = scanDir(e.path);
        if (!current.complete || current.newest > CUTOFF) {
          console.log(`  [跳过] ${e.name}（目录已变化或无法完整核验）`);
          continue;
        }
        fs.rmSync(e.path, { recursive: true, force: true });
      } else {
        const stat = fs.lstatSync(e.path);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.mtimeMs > CUTOFF) {
          console.log(`  [跳过] ${e.name}（文件已变化）`);
          continue;
        }
        fs.rmSync(e.path, { force: true });
      }
      freed += e.bytes;
      ok += 1;
    } catch (err) {
      console.log(`  [失败] ${e.name}：${String(runtimeErrorMessage(err)).split('\n')[0]}（被占用则留待下次）`);
    }
  }
  if (INCLUDE_ARCHIVE && archiveInfo && fs.existsSync(ARCHIVE)) {
    try {
      fs.rmSync(ARCHIVE, { recursive: true, force: true });
      freed += archiveInfo.bytes;
      console.log(`  [已删] scripts/archive/（${archiveInfo.files} 个文件，${fmtMB(archiveInfo.bytes)}）`);
    } catch (err) {
      console.log(`  [失败] scripts/archive/：${String(runtimeErrorMessage(err)).split('\n')[0]}`);
    }
  }
  console.log(`\n删除 ${ok}/${reclaimable.length} 项，释放 ${fmtMB(freed)}`);
}

if (require.main === module) main();
