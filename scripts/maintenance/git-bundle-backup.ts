#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

import { PathLike } from 'node:fs';

/**
 * git bundle 异地快照（2026-08-29 产品运营审计 P0-2；2026-08-31 改增量链）。
 *
 * 背景：2026-08-29 00:38 本地 .git 因中断的 repack/gc 几乎全毁（refs/heads 消失、
 * 对象库仅剩 217 个对象），唯一救回路径是 origin 远端。bundle 是无需服务端的
 * 本地第二副本：单文件、可 clone、可 fetch 恢复，覆盖「远端推送不及时」的窗口。
 *
 * v2 增量链（2026-08-31，七维审计 P1「全量 bundle 1.2GB 且 KEEP=14 上限 2.9GB」）：
 *   - 锚点：aics-full-<stamp>.bundle = git bundle create --all 全量（~205MB）
 *   - 增量：aics-inc-<stamp>.bundle  = --all --not <上一次备份的 rev>
 *     （只含自上次备份以来的新对象，通常 <50MB）
 *   - 每 FULL_EVERY 份增量自动落一个新锚点，最坏只损失 ≤FULL_EVERY-1 份增量
 *   - 清理：锚点保留 ANCHOR_KEEP 份、增量保留 INC_KEEP 份，并回收早于最老
 *     锚点的断链增量；磁盘上界 ≈ ANCHOR_KEEP×全量 + INC_KEEP×增量
 *   - 链状态：.chain-state.json 记录 lastRev / sinceAnchor；状态损坏自动回退全量
 *
 * 用法：node scripts/maintenance/git-bundle-backup.js [--keep N]（N 仅在传给底层
 *       时兼容旧语义：等价于 INC_KEEP=N；默认增量 10 份 + 锚点 2 份）
 * 排入 start.ps1 每次启动尽力执行；也可手动或计划任务调用。
 *
 * 恢复：
 *   git clone aics-full-<最新>.bundle <目录>                       # 锚点恢复
 *   cd <目录> && git fetch <增量序列按时间升序>.bundle main:main   # 追放增量
 * 增量 bundle 依赖其基点之前的链条，请按时间戳顺序逐个 fetch。
 */

const { execFileSync }: typeof import('child_process') = require('child_process');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKUP_DIR = path.join(ROOT, 'runtime', 'git-backups');
const STATE_FILE = path.join(BACKUP_DIR, '.chain-state.json');

const keepIndex = process.argv.indexOf('--keep');
const keepArg = keepIndex > -1 && Number(process.argv[keepIndex + 1]);
const ANCHOR_KEEP = 2;   // 全量锚点保留份数
const INC_KEEP = keepArg || 10; // 增量保留份数（兼容 --keep 旧语义）
const FULL_EVERY = 8;    // 每 N 份增量强制落一次新锚点

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sizeMB(file: PathLike) {
  return (fs.statSync(file).size / 1024 / 1024).toFixed(1);
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw.lastRev === 'string' && raw.lastRev.length >= 7) return raw;
  } catch { /* 状态损坏 → 全量回退 */ }
  return null;
}

function saveState(state: { lastRev: string; sinceAnchor: number; kind: string; at: string; }) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function sweep() {
  const names = fs.readdirSync(BACKUP_DIR).filter((f) => /^aics-.*\.bundle$/.test(f)).sort();
  const anchors = names.filter((f) => f.startsWith('aics-full-'));
  const incs = names.filter((f) => f.startsWith('aics-inc-'));
  // v1 旧命名（aics-2026-*.bundle，纯全量）：新链锚点凑齐 ANCHOR_KEEP 份后整体退役，
  // 过渡期保留最近的 (ANCHOR_KEEP - 链上锚点数) 份兜底
  const legacy = names.filter((f) => !f.startsWith('aics-full-') && !f.startsWith('aics-inc-'));
  const drop = new Set();
  // 锚点保留最近 ANCHOR_KEEP 份
  for (const name of anchors.slice(0, Math.max(0, anchors.length - ANCHOR_KEEP))) drop.add(name);
  const legacyKeep = anchors.length >= ANCHOR_KEEP ? 0 : Math.max(0, ANCHOR_KEEP - anchors.length);
  for (const name of legacy.slice(0, Math.max(0, legacy.length - legacyKeep))) drop.add(name);
  // 增量保留最近 INC_KEEP 份
  for (const name of incs.slice(0, Math.max(0, incs.length - INC_KEEP))) drop.add(name);
  // 早于最老存活锚点的增量已断链（恢复时无基点），一并回收
  const oldestAnchor = anchors.filter((n) => !drop.has(n))[0];
  if (oldestAnchor) {
    for (const name of incs) {
      if (!drop.has(name) && name < oldestAnchor) drop.add(name);
    }
  }
  for (const name of drop) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, name)); } catch { /* 被占用则留待下次 */ }
  }
}

function main() {
  try {
    git(['rev-parse', '--is-inside-work-tree']);
    git(['rev-parse', 'HEAD']); // HEAD 不可解析（如 refs 损坏）时无内容可备，直接退出
  } catch (error) {
    console.error('[git-bundle-backup] 仓库不可用，跳过备份：' + String(runtimeErrorMessage(error)).split('\n')[0]);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const headRev = git(['rev-parse', 'HEAD']);
  const state = loadState();

  // 决定锚点 or 增量：无状态 / lastRev 不可解析 / 增量连发达到 FULL_EVERY → 全量
  let kind = 'full';
  if (state) {
    if (state.lastRev === headRev) {
      console.log('[git-bundle-backup] 自上次备份以来无新提交，跳过');
      return;
    }
    try {
      git(['cat-file', '-e', state.lastRev + '^{commit}']);
      if (Number(state.sinceAnchor) < FULL_EVERY) kind = 'inc';
    } catch { /* lastRev 对象缺失（如锚点被手工删除）→ 全量 */ }
  }

  const file = path.join(BACKUP_DIR, `aics-${kind}-${stamp}.bundle`);
  try {
    if (kind === 'full') {
      git(['bundle', 'create', file, '--all']);
    } else {
      git(['bundle', 'create', file, '--all', '--not', state.lastRev]);
    }
    // 自校验：verify 失败说明 bundle 不完整，不留残次副本
    git(['bundle', 'verify', file]);
  } catch (error) {
    console.error('[git-bundle-backup] bundle 创建/校验失败（' + kind + '）：' + String(runtimeErrorMessage(error)).split('\n')[0]);
    try { fs.unlinkSync(file); } catch { /* 可能根本没生成 */ }
    process.exitCode = 1;
    return;
  }

  saveState({ lastRev: headRev, sinceAnchor: kind === 'full' ? 0 : Number(state.sinceAnchor) + 1, kind, at: new Date().toISOString() });
  sweep();

  const kindLabel = kind === 'full' ? '锚点' : '增量';
  console.log(`[git-bundle-backup] ${path.relative(ROOT, file)} (${sizeMB(file)} MB, ${kindLabel})，锚点≤${ANCHOR_KEEP} 增量≤${INC_KEEP}`);
}

main();
