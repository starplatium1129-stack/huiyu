import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
import type { Repository, Selection, Snapshot, SnapshotChange, SnapshotComparison, SnapshotEntry } from './delivery-types';
'use strict';
const fs: typeof import('node:fs') = require('node:fs');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { object, canonical, sha256, relative, excluded, resolveSafe, fileEntry }: typeof import('./delivery-paths') = require('./delivery-paths');
const HASH = /^[a-f\d]{64}$/;

function hasTreeAncestor(name: string, trees: ReadonlySet<string>): boolean {
  if (name !== '.' && trees.has('.')) return true;
  for (let slash = name.lastIndexOf('/'); slash > 0; slash = name.lastIndexOf('/', slash - 1)) {
    if (trees.has(name.slice(0, slash))) return true;
  }
  return false;
}
function selectors(input: unknown): Selection[] {
  if (!Array.isArray(input) || !input.length) throw Error('必须明确选择至少一个文件或目录');
  const items: unknown[] = input;
  const result = items.map((item): Selection => {
    if (!object(item) || (item.kind !== 'file' && item.kind !== 'tree')) throw Error('选择项需要 file/tree kind');
    const name = relative(item.path, item.kind === 'tree');
    if (excluded(name)) throw Error(`证据目录和 .git 不能作为内容输入: ${name}`);
    return { path: name, kind: item.kind };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const names = new Set<string>(), trees = new Set<string>();
  for (const item of result) {
    const name = item.path.toLowerCase();
    if (names.has(name)) throw Error('同组选择项重复或覆盖重叠');
    names.add(name);
    if (item.kind === 'tree') trees.add(name);
  }
  for (const name of names) if (hasTreeAncestor(name, trees)) throw Error('同组选择项重复或覆盖重叠');
  return result;
}
// Only paths, types and bytes enter identities. No timestamps, root, environment,
// Git status or commit: a docs-only commit need not invalidate an unrelated gate.
function payload(snapshot: Pick<Snapshot, 'selectors' | 'entries'>) {
  return { version: 1, algorithm: 'sha256', selectors: snapshot.selectors,
    entries: snapshot.entries.map(entry => ({ path: entry.path, status: entry.status,
      ...(entry.status === 'file' ? { bytes: entry.bytes, sha256: entry.sha256 } : {}) })) };
}
function snapshot(root: string, input: unknown): Snapshot {
  const selection = selectors(input), entries: SnapshotEntry[] = [], names = new Set<string>();
  function visit(name: string, kind: Selection['kind'], selectedRoot = false) {
    if (excluded(name)) return;
    if (names.has(name.toLowerCase())) throw Error(`路径大小写冲突: ${name}`);
    names.add(name.toLowerCase());
    try {
      const file = resolveSafe(root, name), stat = fs.lstatSync(file);
      if (kind === 'file' || !stat.isDirectory()) { entries.push(fileEntry(root, name)); return; }
      // Empty intermediate directories carry no input bytes. In particular,
      // creating runtime/ solely to save excluded evidence must not cause drift.
      if (selectedRoot) entries.push({ path: name, status: 'directory' });
      for (const child of fs.readdirSync(file).sort()) visit(name === '.' ? child : `${name}/${child}`, 'tree');
    } catch (error) {
      entries.push({ path: name, status: runtimeErrorCode(error) === 'ENOENT' ? 'missing' : 'unsafe-or-unreadable', message: runtimeErrorMessage(error) });
    }
  }
  for (const item of selection) {
    if (item.kind === 'tree') {
      try {
        if (!fs.statSync(resolveSafe(root, item.path)).isDirectory()) {
          entries.push({ path: item.path, status: 'not-directory' }); continue;
        }
      } catch { /* visit records missing and unsafe paths without following links. */ }
    }
    const start = entries.length;
    visit(item.path, item.kind, true);
    if (item.kind === 'tree' && entries[start]?.status === 'directory' && !entries.slice(start).some(e => e.status === 'file')) entries[start].status = 'empty';
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const result: Omit<Snapshot, 'sha256'> = { selectors: selection, entries, status: entries.every(v => ['file', 'directory'].includes(v.status)) ? 'complete' : 'incomplete' };
  return { ...result, sha256: sha256(canonical(payload(result))) };
}
function validateSnapshot(record: unknown): Snapshot {
  if (!object(record) || typeof record.sha256 !== 'string' || !HASH.test(record.sha256) || !Array.isArray(record.entries)) throw Error('内容身份记录缺失或格式错误');
  const selection = selectors(record.selectors), entries: unknown[] = record.entries;
  if (canonical(selection) !== canonical(record.selectors)) throw Error('选择项不是规范化列表');
  // Stored membership is case-sensitive, unlike selection collision checks.
  const selected = new Set(selection.map(item => item.path));
  const trees = new Set(selection.filter(item => item.kind === 'tree').map(item => item.path));
  const seen = new Set(), entryPaths = new Set();
  let previous = '';
  for (const entry of entries) {
    if (!object(entry)) throw Error('文件身份条目格式错误');
    const name = relative(entry.path, true), lower = name.toLowerCase();
    if (excluded(name) || seen.has(lower) || (previous && previous >= name)) throw Error('文件身份含排除路径、重复或乱序条目');
    if (!selected.has(name) && !hasTreeAncestor(name, trees)) throw Error('文件不属于明确选择的输入');
    seen.add(lower); previous = name;
    entryPaths.add(entry.path);
    if (typeof entry.status !== 'string' || !['file', 'directory', 'empty', 'missing', 'unsafe-or-unreadable', 'not-directory'].includes(entry.status)) throw Error('文件身份状态不支持');
    if (entry.status === 'file' && (typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)
      || typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) throw Error('文件哈希或大小错误');
    if (entry.status !== 'file' && entry.message !== undefined && typeof entry.message !== 'string') throw Error('文件身份错误说明必须为字符串');
  }
  if (!entries.length || !selection.every(s => entryPaths.has(s.path))) throw Error('身份清单遗漏选择项');
  // Selection and every entry were checked above; retain the original bytes and
  // extension fields while computing the same identity projection.
  const validatedEntries = entries as SnapshotEntry[];
  const status = validatedEntries.every(e => ['file', 'directory'].includes(e.status)) ? 'complete' : 'incomplete';
  if (record.status !== status || record.sha256 !== sha256(canonical(payload({ selectors: selection, entries: validatedEntries })))) throw Error('身份摘要与清单不一致');
  return record as Snapshot;
}
function compareSnapshot(root: string, input: unknown): SnapshotComparison {
  try {
    const recorded = validateSnapshot(input);
    const current = snapshot(root, recorded.selectors), changes: SnapshotChange[] = [];
    const old = new Map(recorded.entries.map(e => [e.path, e]));
    const now = new Map(current.entries.map(e => [e.path, e]));
    for (const name of [...new Set([...old.keys(), ...now.keys()])].sort()) {
      const before = old.get(name), after = now.get(name);
      const identity = (entry: SnapshotEntry | undefined) => entry && canonical(payload({ selectors: [], entries: [entry] }).entries[0]);
      if (identity(before) !== identity(after)) changes.push({ path: name, status: !before ? 'added' : !after || after.status === 'missing' ? 'removed' : 'changed', before, after });
    }
    const status = recorded.status !== 'complete' || current.status !== 'complete' ? 'unavailable'
      : recorded.sha256 === current.sha256 ? 'fresh' : 'stale';
    return { status, expectedSha256: recorded.sha256, actualSha256: current.sha256, changes,
      problems: current.entries.filter(e => !['file', 'directory'].includes(e.status)), current };
  } catch (error) { return { status: 'invalid', message: runtimeErrorMessage(error), changes: [] }; }
}
function repository(root: string): Repository {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  function git(args: string[]) {
    const result = spawnSync('git', args, { cwd: root, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr?.trim() || 'Git 不可用');
    return result.stdout;
  }
  try {
    // Do not accidentally use a parent repository when --root is a subdirectory.
    const canonicalRoot = (directory: string) => {
      const real = fs.realpathSync.native(directory);
      return process.platform === 'win32' ? real.toLowerCase() : real;
    };
    if (canonicalRoot(git(['rev-parse', '--show-toplevel']).trim()) !== canonicalRoot(root)) throw Error('root 必须是 Git 工作树根');
    const commit = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    if (!/^[a-f\d]{40}$/i.test(commit)) throw Error('HEAD 不是完整 Git SHA-1');
    const worktree = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return { status: 'recorded', commit: commit.toLowerCase(), worktree: worktree ? 'dirty' : 'clean' };
  } catch (error) { return { status: 'unknown', commit: null, worktree: 'unknown', message: runtimeErrorMessage(error) }; }
}
export = { HASH, selectors, snapshot, validateSnapshot, compareSnapshot, repository };
