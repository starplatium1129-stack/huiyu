'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { canonical, sha256, relative, within, excluded, resolveSafe } = require('./delivery-paths');
const { validateSnapshot } = require('./delivery-identity');
const COMMIT = /^[a-f\d]{40}$/;
const MAX_BLOB = 64 * 1024 * 1024;

// No shell, filters, refresh/index writes, replacement objects or lazy fetches.
function git(root, args, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const result = spawnSync('git', ['--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, input, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    windowsHide: true, timeout: 10000, maxBuffer: MAX_BLOB + 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr?.toString().trim() || 'Git 只读证明失败');
  return result.stdout;
}
function assertRoot(root) {
  if (fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']).toString().trim()) !== root) throw Error('finalize root 必须为 Git 工作树根');
}
function ancestor(root, before, after) {
  if (!COMMIT.test(before) || !COMMIT.test(after)) throw Error('finalize 需要完整 Git SHA-1');
  if (git(root, ['rev-parse', '--verify', `${after}^{commit}`]).toString().trim() !== after) throw Error('最终提交不存在');
  git(root, ['merge-base', '--is-ancestor', before, after]);
}
function nulRecords(buffer) {
  const value = buffer.toString('utf8');
  if (!value) return [];
  if (!value.endsWith('\0') || !Buffer.from(value).equals(buffer)) throw Error('Git 路径输出无效');
  return value.slice(0, -1).split('\0');
}
const chosen = (selection, name) => !excluded(name) && selection.some(s =>
  s.path === name || (s.kind === 'tree' && (s.path === '.' || within(s.path, name))));
function commitFiles(root, commit, selection) {
  const result = [];
  for (const line of nulRecords(git(root, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit]))) {
    const match = /^(\d{6}) (blob|commit) ([a-f\d]{40})\s+(\d+|-)\t([\s\S]+)$/.exec(line);
    if (!match) throw Error('Git tree 输出无效');
    const [, mode, type, oid, bytes, name] = match;
    if (!chosen(selection, name)) continue;
    if (!['100644', '100755'].includes(mode) || type !== 'blob') throw Error(`受审输入不是普通 Git blob: ${name}`);
    relative(name);
    if (Number(bytes) > MAX_BLOB) throw Error(`Git blob 超过 64 MiB 只读上限: ${name}`);
    result.push({ path: name, mode, oid, bytes: Number(bytes) });
  }
  return result.sort((a, b) => a.path < b.path ? -1 : 1);
}
function indexFiles(root, selection) {
  const result = [];
  for (const line of nulRecords(git(root, ['ls-files', '--stage', '-z']))) {
    const match = /^(\d{6}) ([a-f\d]{40}) (\d)\t([\s\S]+)$/.exec(line);
    if (!match) throw Error('Git index 输出无效');
    const [, mode, oid, stage, name] = match;
    if (!chosen(selection, name)) continue;
    if (stage !== '0') throw Error(`受审输入存在未解决的索引冲突: ${name}`);
    result.push({ path: relative(name), mode, oid });
  }
  return result.sort((a, b) => a.path < b.path ? -1 : 1);
}
function attributes(root, names) {
  const values = nulRecords(git(root, ['check-attr', '--cached', '-z', '--stdin', 'text', 'filter', 'working-tree-encoding', 'ident'], `${names.join('\0')}\0`));
  if (values.length !== names.length * 12) throw Error('Git attributes 输出不完整');
  const result = new Map();
  for (let i = 0; i < values.length; i += 3) {
    const [name, key, value] = values.slice(i, i + 3);
    if (!result.has(name)) result.set(name, {});
    result.get(name)[key] = value;
  }
  return result;
}
function blobs(root, files, visit) {
  // Bound each batch, instead of starting a process per source file.
  for (let i = 0; i < files.length;) {
    const batch = []; let bytes = 0;
    do { const item = files[i++]; batch.push(item); bytes += item.bytes; }
    while (i < files.length && batch.length < 128 && bytes + files[i].bytes < 8 * 1024 * 1024);
    const output = git(root, ['cat-file', '--batch'], batch.map(f => f.oid).join('\n') + '\n');
    let offset = 0;
    for (const item of batch) {
      const end = output.indexOf(10, offset);
      if (end < 0 || output.subarray(offset, end).toString() !== `${item.oid} blob ${item.bytes}`) throw Error('Git blob header 不一致');
      offset = end + 1;
      const content = output.subarray(offset, offset + item.bytes);
      offset += item.bytes;
      if (content.length !== item.bytes || output[offset++] !== 10) throw Error('Git blob 内容不完整');
      visit(item, content);
    }
    if (offset !== output.length) throw Error('Git blob 输出含额外内容');
  }
}
function sourceProof(root, commit, source) {
  assertRoot(root); validateSnapshot(source);
  if (!COMMIT.test(commit) || source.status !== 'complete') throw Error('源码/最终提交身份不可用');
  const files = commitFiles(root, commit, source.selectors), recorded = source.entries.filter(e => e.status === 'file');
  if (canonical(files.map(e => e.path)) !== canonical(recorded.map(e => e.path))) throw Error('最终提交未包含完整受审源码集合（新增/删除未提交或存在未跟踪输入）');
  const index = indexFiles(root, source.selectors), expectedIndex = files.map(({ path, mode, oid }) => ({ path, mode, oid }));
  if (canonical(index) !== canonical(expectedIndex)) throw Error('受审源码索引与最终提交不一致');
  const byName = new Map(recorded.map(e => [e.path, e])), proof = [], attrs = attributes(root, files.map(e => e.path));
  blobs(root, files, (item, content) => {
    const entry = byName.get(item.path), blobSha256 = sha256(content);
    let representation = 'exact';
    if (entry.sha256 !== blobSha256 || entry.bytes !== content.length) {
      const a = attrs.get(item.path), raw = fs.readFileSync(resolveSafe(root, item.path));
      const plain = ['filter', 'working-tree-encoding', 'ident'].every(k => ['unspecified', 'unset'].includes(a?.[k]));
      // Only Git's standard text CRLF -> LF representation is accepted. Raw
      // working bytes must still match the pre-test SHA; never execute filters.
      if (!plain || !['set', 'auto'].includes(a?.text) || raw.includes(0) || content.includes(0)
        || sha256(raw) !== entry.sha256 || raw.length !== entry.bytes
        || !Buffer.from(raw.toString('latin1').replace(/\r\n/g, '\n'), 'latin1').equals(content)) {
        throw Error(`最终提交 blob 与已测源码字节不对应: ${item.path}`);
      }
      representation = 'git-crlf-to-lf';
    }
    proof.push({ ...item, blobSha256, sourceSha256: entry.sha256, representation });
  });
  const tree = git(root, ['rev-parse', '--verify', `${commit}^{tree}`]).toString().trim();
  if (!COMMIT.test(tree)) throw Error('Git tree 身份无效');
  return { tree, files: proof, indexSha256: sha256(canonical(expectedIndex)),
    scope: 'selected-source-only', buildCommitCoverage: 'not-asserted' };
}
module.exports = { COMMIT, git, ancestor, sourceProof };
