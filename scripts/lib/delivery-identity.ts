import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';
const fs: typeof import('node:fs') = require('node:fs');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { object, canonical, sha256, relative, within, excluded, resolveSafe, fileEntry }: typeof import('./delivery-paths') = require('./delivery-paths');
const HASH = /^[a-f\d]{64}$/;

function selectors(input: any) {
  if (!Array.isArray(input) || !input.length) throw Error('必须明确选择至少一个文件或目录');
  const result = input.map(item => {
    if (!object(item) || !['file', 'tree'].includes(item.kind)) throw Error('选择项需要 file/tree kind');
    const name = relative(item.path, item.kind === 'tree');
    if (excluded(name)) throw Error(`证据目录和 .git 不能作为内容输入: ${name}`);
    return { path: name, kind: item.kind };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (let i = 0; i < result.length; i++) for (let j = 0; j < i; j++) {
    const a = result[j], b = result[i], left = a.path.toLowerCase(), right = b.path.toLowerCase();
    if (left === right || (a.kind === 'tree' && (left === '.' || within(left, right)))
      || (b.kind === 'tree' && (right === '.' || within(right, left)))) throw Error('同组选择项重复或覆盖重叠');
  }
  return result;
}
// Only paths, types and bytes enter identities. No timestamps, root, environment,
// Git status or commit: a docs-only commit need not invalidate an unrelated gate.
function payload(snapshot: any) {
  return { version: 1, algorithm: 'sha256', selectors: snapshot.selectors,
    entries: snapshot.entries.map(({ path, status, bytes, sha256 }: any) => ({ path, status, ...(status === 'file' ? { bytes, sha256 } : {}) })) };
}
function snapshot(root: any, input: any) {
  const selection = selectors(input), entries = [], names = new Set();
  function visit(name: any, kind: any, selectedRoot = false) {
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
  const result: any = { selectors: selection, entries, status: entries.every(v => ['file', 'directory'].includes(v.status)) ? 'complete' : 'incomplete' };
  result.sha256 = sha256(canonical(payload(result)));
  return result;
}
function validateSnapshot(record: any) {
  if (!object(record) || !HASH.test(record.sha256) || !Array.isArray(record.entries)) throw Error('内容身份记录缺失或格式错误');
  if (canonical(selectors(record.selectors)) !== canonical(record.selectors)) throw Error('选择项不是规范化列表');
  const seen = new Set();
  let previous = '';
  for (const entry of record.entries) {
    if (!object(entry)) throw Error('文件身份条目格式错误');
    const name = relative(entry.path, true), lower = name.toLowerCase();
    if (excluded(name) || seen.has(lower) || (previous && previous >= name)) throw Error('文件身份含排除路径、重复或乱序条目');
    if (!record.selectors.some((s: any) => s.path === name || (s.kind === 'tree' && (s.path === '.' || within(s.path, name))))) throw Error('文件不属于明确选择的输入');
    seen.add(lower); previous = name;
    if (!['file', 'directory', 'empty', 'missing', 'unsafe-or-unreadable', 'not-directory'].includes(entry.status)) throw Error('文件身份状态不支持');
    if (entry.status === 'file' && (!HASH.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) throw Error('文件哈希或大小错误');
  }
  if (!record.entries.length || !record.selectors.every((s: any) => record.entries.some((e: any) => e.path === s.path))) throw Error('身份清单遗漏选择项');
  const status = record.entries.every((e: any) => ['file', 'directory'].includes(e.status)) ? 'complete' : 'incomplete';
  if (record.status !== status || record.sha256 !== sha256(canonical(payload(record)))) throw Error('身份摘要与清单不一致');
}
function compareSnapshot(root: any, recorded: any) {
  try {
    validateSnapshot(recorded);
    const current = snapshot(root, recorded.selectors), changes = [];
    const old = new Map(recorded.entries.map((e: any) => [e.path, e]));
    const now = new Map(current.entries.map((e: any) => [e.path, e]));
    for (const name of [...new Set([...old.keys(), ...now.keys()])].sort()) {
      const before = old.get(name), after: any = now.get(name);
      const identity = (entry: any) => entry && canonical(payload({ selectors: [], entries: [entry] }).entries[0]);
      if (identity(before) !== identity(after)) changes.push({ path: name, status: !before ? 'added' : !after || after.status === 'missing' ? 'removed' : 'changed', before, after });
    }
    const status = recorded.status !== 'complete' || current.status !== 'complete' ? 'unavailable'
      : recorded.sha256 === current.sha256 ? 'fresh' : 'stale';
    return { status, expectedSha256: recorded.sha256, actualSha256: current.sha256, changes,
      problems: current.entries.filter((e: any) => !['file', 'directory'].includes(e.status)), current };
  } catch (error) { return { status: 'invalid', message: runtimeErrorMessage(error), changes: [] }; }
}
function repository(root: any) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]: any) => !/^GIT_/i.test(key)));
  function git(args: any) {
    const result = spawnSync('git', args, { cwd: root, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr?.trim() || 'Git 不可用');
    return result.stdout;
  }
  try {
    // Do not accidentally use a parent repository when --root is a subdirectory.
    if (fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== root) throw Error('root 必须是 Git 工作树根');
    const commit = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    if (!/^[a-f\d]{40}$/i.test(commit)) throw Error('HEAD 不是完整 Git SHA-1');
    const worktree = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return { status: 'recorded', commit: commit.toLowerCase(), worktree: worktree ? 'dirty' : 'clean' };
  } catch (error) { return { status: 'unknown', commit: null, worktree: 'unknown', message: runtimeErrorMessage(error) }; }
}
export = { HASH, selectors, snapshot, validateSnapshot, compareSnapshot, repository };
