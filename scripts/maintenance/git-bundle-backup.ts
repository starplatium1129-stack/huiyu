#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

import { PathLike } from 'node:fs';
import workspaceLock = require('../lib/workspace-lock');

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
 *   - 每 FULL_EVERY 份增量自动落一个新锚点，间隔不超过 INC_KEEP，保全最新恢复链
 *   - 清理：锚点保留 ANCHOR_KEEP 份、增量保留 INC_KEEP 份，并回收早于最老
 *     锚点的断链增量；磁盘上界 ≈ ANCHOR_KEEP×全量 + INC_KEEP×增量
 *   - 链状态记录 HEAD、全部 refs 与 sinceAnchor；引用变化或旧状态升级回退全量
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
const ANCHOR_KEEP = 2;   // 全量锚点保留份数
const INC_KEEP = keepIndex < 0 ? 10 : Number(process.argv[keepIndex + 1]);
const FULL_EVERY = Math.min(8, INC_KEEP);

type Snapshot = { lastRev: string; headRef: string; refs: string };
type ChainState = Snapshot & { sinceAnchor: number; kind: string; at: string };

function git(args: readonly string[]) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sizeMB(file: PathLike) {
  return (fs.statSync(file).size / 1024 / 1024).toFixed(1);
}

function snapshot(): Snapshot {
  let headRef = '';
  try { headRef = git(['symbolic-ref', '-q', 'HEAD']); } catch { /* detached HEAD */ }
  return { lastRev: git(['rev-parse', 'HEAD']), headRef,
    refs: git(['for-each-ref', '--sort=refname', '--format=%(refname)%09%(objectname)']) };
}

function otherRefs(state: Snapshot) {
  return state.refs.split('\n').filter(line => !line.startsWith(state.headRef + '\t')).join('\n');
}

function loadState() {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && 'lastRev' in raw && typeof raw.lastRev === 'string' && /^[a-f0-9]{40,64}$/.test(raw.lastRev)
      && 'headRef' in raw && typeof raw.headRef === 'string' && 'refs' in raw && typeof raw.refs === 'string'
      && 'sinceAnchor' in raw && typeof raw.sinceAnchor === 'number' && Number.isSafeInteger(raw.sinceAnchor) && raw.sinceAnchor >= 0) {
      return { lastRev: raw.lastRev, headRef: raw.headRef, refs: raw.refs, sinceAnchor: raw.sinceAnchor };
    }
  } catch { /* 状态损坏 → 全量回退 */ }
  return null;
}

function saveState(state: ChainState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function sweep() {
  const names = fs.readdirSync(BACKUP_DIR).filter(f => /^aics-.*\.bundle$/.test(f)).sort();
  const anchors = names.filter(f => f.startsWith('aics-full-'));
  const incs = names.filter(f => f.startsWith('aics-inc-'));
  // v1 旧命名（aics-2026-*.bundle，纯全量）：新链锚点凑齐 ANCHOR_KEEP 份后整体退役，
  // 过渡期保留最近的 (ANCHOR_KEEP - 链上锚点数) 份兜底
  const legacy = names.filter(f => !f.startsWith('aics-full-') && !f.startsWith('aics-inc-'));
  const drop = new Set<string>();
  // 锚点保留最近 ANCHOR_KEEP 份
  for (const name of anchors.slice(0, Math.max(0, anchors.length - ANCHOR_KEEP))) drop.add(name);
  const legacyKeep = anchors.length >= ANCHOR_KEEP ? 0 : Math.max(0, ANCHOR_KEEP - anchors.length);
  for (const name of legacy.slice(0, Math.max(0, legacy.length - legacyKeep))) drop.add(name);
  // 增量保留最近 INC_KEEP 份
  for (const name of incs.slice(0, Math.max(0, incs.length - INC_KEEP))) drop.add(name);
  // 早于最老存活锚点的增量已断链（恢复时无基点），一并回收
  const oldestAnchor = anchors.filter(n => !drop.has(n))[0];
  if (oldestAnchor) {
    for (const name of incs) {
      if (!drop.has(name) && name.slice('aics-inc-'.length) < oldestAnchor.slice('aics-full-'.length)) drop.add(name);
    }
  }
  for (const name of drop) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, name)); } catch { /* 被占用则留待下次 */ }
  }
}

function main() {
  if (!Number.isSafeInteger(INC_KEEP) || INC_KEEP < 1) {
    console.error('[git-bundle-backup] --keep 必须是正整数');
    process.exitCode = 1;
    return;
  }
  try {
    git(['rev-parse', '--is-inside-work-tree']);
    git(['rev-parse', 'HEAD']); // HEAD 不可解析（如 refs 损坏）时无内容可备，直接退出
  } catch (error) {
    console.error('[git-bundle-backup] 仓库不可用，跳过备份：' + String(runtimeErrorMessage(error)).split('\n')[0]);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const current = snapshot();
  const state = loadState();

  // 只有当前分支持续向前且其他引用未变才做增量，避免标签/回退引用被 --not 排除。
  let kind = 'full';
  if (state) {
    if (state.lastRev === current.lastRev && state.headRef === current.headRef && state.refs === current.refs) {
      console.log('[git-bundle-backup] 自上次备份以来 HEAD 与引用未变，跳过');
      return;
    }
    if (current.headRef && state.headRef === current.headRef && otherRefs(state) === otherRefs(current)
      && state.lastRev !== current.lastRev && state.sinceAnchor < FULL_EVERY) {
      try {
        git(['merge-base', '--is-ancestor', state.lastRev, current.lastRev]);
        kind = 'inc';
      } catch { /* 旧对象缺失或分支回退/改写 → 全量 */ }
    }
  }

  const file = path.join(BACKUP_DIR, `aics-${kind}-${stamp}.bundle`);
  try {
    if (kind === 'full' || !state) {
      git(['bundle', 'create', file, '--all']);
    } else {
      git(['bundle', 'create', file, '--all', '--not', state.lastRev]);
    }
    // 自校验：verify 失败说明 bundle 不完整，不留残次副本
    git(['bundle', 'verify', file]);
    const after = snapshot();
    if (after.lastRev !== current.lastRev || after.headRef !== current.headRef || after.refs !== current.refs)
      throw new Error('备份期间 Git 引用发生变化，保留原恢复链，请稍后重试');
  } catch (error) {
    console.error('[git-bundle-backup] bundle 创建/校验失败（' + kind + '）：' + String(runtimeErrorMessage(error)).split('\n')[0]);
    try { fs.unlinkSync(file); } catch { /* 可能根本没生成 */ }
    process.exitCode = 1;
    return;
  }

  saveState({ ...current, sinceAnchor: kind === 'full' || !state ? 0 : state.sinceAnchor + 1, kind, at: new Date().toISOString() });
  sweep();

  const kindLabel = kind === 'full' ? '锚点' : '增量';
  console.log(`[git-bundle-backup] ${path.relative(ROOT, file)} (${sizeMB(file)} MB, ${kindLabel})，锚点≤${ANCHOR_KEEP} 增量≤${INC_KEEP}`);
}

// Reuse owner/PID recovery with a separate lock root; desktop builds remain independent.
void workspaceLock.withWorkspaceLock({
  workspaceRoot: ROOT, lockRoot: path.join(BACKUP_DIR, '.locks'), waitTimeoutMs: 0,
}, main).catch((error: unknown) => {
  if (error instanceof workspaceLock.WorkspaceLockTimeoutError) {
    console.log('[git-bundle-backup] 已有备份正在执行，本次跳过');
    return;
  }
  console.error('[git-bundle-backup] 备份未完成：' + String(runtimeErrorMessage(error)).split('\n')[0]);
  process.exitCode = 1;
});
