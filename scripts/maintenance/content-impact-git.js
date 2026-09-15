'use strict';
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { TextDecoder } = require('node:util');
const { MAX_BYTES, safeRelative, assertWorktreePaths, reader } = require('../lib/content-history-reader');

function validateRevision(value) {
  if (typeof value !== 'string' || value.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?:[~^][0-9]*)*$/.test(value)
    || value.includes('..') || value.includes('//') || value.includes('/.') || value.endsWith('/')) {
    throw new Error('--base must be a local commit/ref (option, path and revision-expression injection refused)');
  }
  return value;
}

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '' };
}

function nulRecords(raw) {
  if (raw && !raw.endsWith('\0')) throw new Error('Git output missing NUL terminator');
  return raw ? raw.slice(0, -1).split('\0') : [];
}

// All arguments are an argv array. No shell, remote commands, checkout or index refresh.
function collectGitHistory(root, base) {
  const result = { status: 'error', base: base || null, baseCommit: null, headCommit: null,
    comparison: 'base-commit-to-working-tree', changes: [], paths: [], raw: [], unknown: [] };
  try {
    validateRevision(base);
    const settings = ['-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
    const env = gitEnvironment();
    const run = (args, allowed = [0], record = true, binary = false) => {
      const output = childProcess.spawnSync('git', [...settings, ...args], {
        cwd: root, env, timeout: 15000, maxBuffer: MAX_BYTES, windowsHide: true, shell: false,
      });
      const stdout = output.stdout || Buffer.alloc(0);
      const stderr = output.stderr?.toString('utf8') || '';
      if (record) result.raw.push({ args, status: output.status, stderr });
      if (output.error || !allowed.includes(output.status)) throw new Error(output.error?.message || `Git failed: ${args[0]}: ${stderr}`);
      return binary ? stdout : new TextDecoder('utf-8', { fatal: true }).decode(stdout);
    };
    const top = run(['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '');
    if (fs.realpathSync(top) !== fs.realpathSync(root)) throw new Error('--root must be the Git working-tree root');
    const resolve = (ref) => {
      const oid = run(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error('Invalid resolved commit');
      return oid;
    };
    result.baseCommit = resolve(base);
    result.headCommit = resolve('HEAD');
    // Git diff can run clean filters even with --no-textconv. Disable configured
    // filter commands before examining working files; don't log their values.
    const filterKeys = run(['config', '--null', '--name-only', '--get-regexp', '^filter\..*\.(clean|smudge|process|required)$'], [0, 1]);
    for (const key of nulRecords(filterKeys)) {
      if (!/^filter\.[A-Za-z0-9_.-]+\.(clean|smudge|process|required)$/.test(key)) throw new Error('Unsupported filter configuration; refuse to execute Git diff');
      settings.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
    }
    const tracked = nulRecords(run(['ls-files', '-v', '-z', '--']));
    const trackedPaths = tracked.map((line) => {
      if (!/^[A-Za-z?] /.test(line)) throw new Error('Unrecognized tracked-file state');
      const file = safeRelative(line.slice(2));
      if (line[0] !== 'H') result.unknown.push(`${file}: Git flag ${line[0]}; diff cannot prove full worktree coverage`);
      return file;
    });
    assertWorktreePaths(root, trackedPaths);
    const untracked = nulRecords(run(['ls-files', '--others', '--exclude-standard', '-z', '--'])).map(safeRelative);
    assertWorktreePaths(root, untracked);
    const changes = [];
    const tokens = nulRecords(run(['diff', '--name-status', '-z', '--find-renames=50%', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', result.baseCommit, '--']));
    for (let i = 0; i < tokens.length;) {
      const status = tokens[i++];
      if (!/^(?:[AMDTUXB]|[RC]\d{1,3})$/.test(status)) throw new Error('Unrecognized Git change status');
      const oldPath = /^[RC]/.test(status) ? safeRelative(tokens[i++]) : null;
      const file = safeRelative(tokens[i++]);
      changes.push({ status, oldPath: oldPath || (status === 'D' ? file : null), path: status === 'D' ? null : file });
    }
    for (const file of untracked) changes.push({ status: '?', oldPath: null, path: file });
    const tree = new Map();
    for (const line of nulRecords(run(['ls-tree', '-r', '-z', '--full-tree', result.baseCommit]))) {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error('Unrecognized Git tree entry');
      const file = safeRelative(match[4]);
      tree.set(file, { mode: match[1], type: match[2], oid: match[3] });
      if (match[2] === 'commit') result.unknown.push(`${file}: submodule content not inspected`);
    }
    const baseReader = reader({
      side: 'base',
      bytes(file) {
        const entry = tree.get(safeRelative(file));
        if (!entry) throw Object.assign(new Error('not in base tree; ignored/generated history unavailable'), { code: 'ENOENT' });
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`${file}: not a regular historical blob`);
        return run(['cat-file', 'blob', entry.oid], [0], false, true);
      },
      list(directory) {
        safeRelative(directory);
        const prefix = `${directory}/`;
        return [...new Set([...tree.keys()].filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split('/')[0]))].sort();
      },
    });
    result.changes = changes;
    result.paths = [...new Set(changes.flatMap((item) => [item.oldPath, item.path]).filter(Boolean))];
    result.status = 'compared';
    result.reason = 'Local base commit versus effective staged/unstaged/untracked working tree; ignored untracked files excluded. Rename similarity is Git evidence, not proof of entity identity.';
    return { result, baseReader };
  } catch (error) {
    result.reason = error.message;
    result.changes = [];
    result.paths = [];
    return { result, baseReader: null };
  }
}

// NUL records preserve spaces, quotes and newlines. Disable rename detection so
// both old and new names remain in the conservative path set.
function collectGitChanges(root) {
  const result = { status: 'error', raw: [], paths: [], reason: '' };
  try {
    const env = gitEnvironment();
    const run = (args) => {
      const output = childProcess.spawnSync('git', args, { cwd: root, env, timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      const record = { args, status: output.status, stdout: output.stdout?.toString('utf8') || '', stderr: output.stderr?.toString('utf8') || '' };
      result.raw.push(record);
      if (output.error || output.status !== 0) throw new Error(output.error?.message || `Git 命令失败：${record.stderr}`);
      return new TextDecoder('utf-8', { fatal: true }).decode(output.stdout);
    };
    const top = run(['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '');
    if (fs.realpathSync(top) !== fs.realpathSync(root)) throw new Error('--root 必须为 Git 工作树根目录，不能把父仓库路径映射到子目录');
    const paths = [];
    for (const args of [
      ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD', '--'],
      ['ls-files', '--others', '--exclude-standard', '-z', '--'],
    ]) {
      const raw = run(args);
      if (raw && !raw.endsWith('\0')) throw new Error('Git 路径输出缺少 NUL 终止符');
      for (const file of raw ? raw.slice(0, -1).split('\0') : []) {
        if (!file || file.includes('\\') || file.includes(':') || file.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Git 路径不可安全解析');
        paths.push(file);
      }
    }
    result.paths = [...new Set(paths)];
    result.status = 'collected';
    result.reason = 'HEAD 对比涵盖 staged/unstaged，另收集 untracked；重命名保留旧/新路径，仅表示路径变化，不推断内容语义或历史关系。';
  } catch (error) { result.reason = error.message; }
  return result;
}
module.exports = { collectGitChanges, collectGitHistory, validateRevision };
