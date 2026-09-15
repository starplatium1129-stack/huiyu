import { errorCode as runtimeErrorCode } from '../lib/runtime-errors';
'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { execFileSync }: typeof import('node:child_process') = require('node:child_process');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');

const { loadDebtFromGitRef, scanRepository, sha256 }: typeof import('./repo-hygiene-core') = require('./repo-hygiene-core');

function git(repositoryRoot: any, args: any, options = {}) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function write(repositoryRoot: any, relativePath: any, content: any) {
  const filePath = path.join(repositoryRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createRepository(t: any) {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-repo-hygiene-'));
  t.after(() => {
    assert.strictEqual(path.dirname(path.resolve(repositoryRoot)), path.resolve(os.tmpdir()));
    // Windows：git 子进程（pack-objects/index）句柄释放略有滞后，立即 rmSync
    // 会 ENOTEMPTY/EBUSY。有界重试只处理清理，不吞业务断言结果（审计 2026-09-05 P2-01）。
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.rmSync(repositoryRoot, { recursive: true, force: true });
        return;
      } catch (error) {
        const retriable = ['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(runtimeErrorCode(error));
        if (attempt >= 5 || !retriable) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  });
  // 夹具不使用符号链接，避免 Git 初始化探测遗留重解析点。
  git(repositoryRoot, ['-c', 'core.symlinks=false', 'init', '--quiet']);
  git(repositoryRoot, ['config', 'user.email', 'repo-hygiene@example.invalid']);
  git(repositoryRoot, ['config', 'user.name', 'Repo Hygiene Test']);
  git(repositoryRoot, ['config', 'core.autocrlf', 'false']);
  write(repositoryRoot, '.gitattributes', '* -text\n');
  git(repositoryRoot, ['add', '--', '.gitattributes']);
  return repositoryRoot;
}

function violationsFor(result: any, target: any, relativePath: any, kind: any) {
  return result.violations.filter((violation: any) => violation.target === target
    && violation.path === relativePath && violation.kind === kind);
}

test('staged-only BOM is read from the absolute index', async (t) => {
  const repositoryRoot = createRepository(t);
  write(repositoryRoot, 'staged.js', 'clean\n');
  git(repositoryRoot, ['add', '--', 'staged.js']);
  write(repositoryRoot, 'staged.js', Buffer.from('\ufeffstaged\n', 'utf8'));
  git(repositoryRoot, ['add', '--', 'staged.js']);
  write(repositoryRoot, 'staged.js', 'clean\n');

  const result = await scanRepository(repositoryRoot);
  assert.equal(violationsFor(result, 'index', 'staged.js', 'bom').length, 1);
  assert.equal(violationsFor(result, 'worktree', 'staged.js', 'bom').length, 0);
});

test('unstaged BOM is read from tracked worktree bytes', async (t) => {
  const repositoryRoot = createRepository(t);
  write(repositoryRoot, 'unstaged.js', 'clean\n');
  git(repositoryRoot, ['add', '--', 'unstaged.js']);
  write(repositoryRoot, 'unstaged.js', Buffer.from('\ufeffunstaged\n', 'utf8'));

  const result = await scanRepository(repositoryRoot);
  assert.equal(violationsFor(result, 'index', 'unstaged.js', 'bom').length, 0);
  assert.equal(violationsFor(result, 'worktree', 'unstaged.js', 'bom').length, 1);
});

test('untracked BOM and every illegal control character are reported', async (t) => {
  const repositoryRoot = createRepository(t);
  write(repositoryRoot, 'loose.txt', Buffer.from('\ufeffa\u0001b\u007fc\n', 'utf8'));

  const result = await scanRepository(repositoryRoot);
  assert.equal(violationsFor(result, 'untracked', 'loose.txt', 'bom').length, 1);
  assert.deepEqual(
    violationsFor(result, 'untracked', 'loose.txt', 'control').map((violation: any) => violation.message),
    ['illegal control character U+0001', 'illegal control character U+007F'],
  );
});

test('every line with trailing whitespace is reported', async (t) => {
  const repositoryRoot = createRepository(t);
  write(repositoryRoot, 'trailing.txt', 'one  \ntwo\t\nthree \n');

  const result = await scanRepository(repositoryRoot);
  assert.deepEqual(
    violationsFor(result, 'untracked', 'trailing.txt', 'trailing-whitespace')
      .map((violation: any) => violation.line),
    [1, 2, 3],
  );
});

test('nonempty text files require a final newline', async (t) => {
  const repositoryRoot = createRepository(t);
  write(repositoryRoot, 'no-newline.txt', 'missing newline');

  const result = await scanRepository(repositoryRoot);
  assert.equal(
    violationsFor(result, 'untracked', 'no-newline.txt', 'missing-final-newline').length,
    1,
  );
});

test('index uses LF while worktree and untracked scripts use path-specific EOL', async (t) => {
  const repositoryRoot = createRepository(t);
  write(repositoryRoot, 'tool.ps1', 'one\r\ntwo\r\n');
  git(repositoryRoot, ['add', '--', 'tool.ps1']);
  write(repositoryRoot, 'app.js', 'one\ntwo\n');
  git(repositoryRoot, ['add', '--', 'app.js']);
  write(repositoryRoot, 'app.js', 'one\r\ntwo\r\n');
  write(repositoryRoot, 'local.ps1', 'one\ntwo\n');

  const result = await scanRepository(repositoryRoot);
  assert.deepEqual(
    violationsFor(result, 'index', 'tool.ps1', 'line-ending').map((violation: any) => violation.line),
    [1, 2],
  );
  assert.equal(violationsFor(result, 'worktree', 'tool.ps1', 'line-ending').length, 0);
  assert.deepEqual(
    violationsFor(result, 'worktree', 'app.js', 'line-ending').map((violation: any) => violation.line),
    [1, 2],
  );
  assert.deepEqual(
    violationsFor(result, 'untracked', 'local.ps1', 'line-ending').map((violation: any) => violation.line),
    [1, 2],
  );
});

test('ignored files are excluded from the untracked scan', async (t) => {
  const repositoryRoot = createRepository(t);
  write(repositoryRoot, '.gitignore', 'ignored.txt\n');
  git(repositoryRoot, ['add', '--', '.gitignore']);
  write(repositoryRoot, 'ignored.txt', Buffer.from('\ufeffbad\u0001  \r\n', 'utf8'));

  const result = await scanRepository(repositoryRoot);
  assert.equal(result.violations.some((violation) => violation.path === 'ignored.txt'), false);
});

test('unknown extensions fail instead of guessing text or binary', async (t) => {
  const repositoryRoot = createRepository(t);
  write(repositoryRoot, 'mystery.quux', 'clean\n');
  write(repositoryRoot, 'known.png', Buffer.from([0, 1, 2, 3]));

  const result = await scanRepository(repositoryRoot);
  assert.equal(violationsFor(result, 'untracked', 'mystery.quux', 'unknown-file-type').length, 1);
  assert.equal(result.violations.some((violation) => violation.path === 'known.png'), false);
});

test('unmerged index entries fail explicitly', async (t) => {
  const repositoryRoot = createRepository(t);
  const base = git(repositoryRoot, ['hash-object', '-w', '--stdin'], { input: 'base\n' });
  const ours = git(repositoryRoot, ['hash-object', '-w', '--stdin'], { input: 'ours\n' });
  const theirs = git(repositoryRoot, ['hash-object', '-w', '--stdin'], { input: 'theirs\n' });
  git(repositoryRoot, ['update-index', '--index-info'], {
    input: [
      `100644 ${base} 1\tconflict.js`,
      `100644 ${ours} 2\tconflict.js`,
      `100644 ${theirs} 3\tconflict.js`,
      '',
    ].join('\n'),
  });

  const result = await scanRepository(repositoryRoot);
  const violations = violationsFor(result, 'index', 'conflict.js', 'unmerged-index-entry');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].message, 'unmerged index entry (stages 1, 2, 3)');
});

test('debt allowance requires the exact tracked full-blob SHA-256', async (t) => {
  const repositoryRoot = createRepository(t);
  write(repositoryRoot, 'legacy.js', 'clean\n');
  git(repositoryRoot, ['add', '--', 'legacy.js']);
  const legacyBytes = Buffer.from('legacy  \n');
  write(repositoryRoot, 'legacy.js', legacyBytes);
  const allowances = [{ path: 'legacy.js', sha256: sha256(legacyBytes) }];

  const allowed = await scanRepository(repositoryRoot, { allowances });
  assert.equal(violationsFor(allowed, 'worktree', 'legacy.js', 'trailing-whitespace').length, 0);
  assert.equal(allowed.allowed.length, 1);

  write(repositoryRoot, 'legacy.js', 'edited legacy  \n');
  const edited = await scanRepository(repositoryRoot, { allowances });
  assert.equal(violationsFor(edited, 'worktree', 'legacy.js', 'trailing-whitespace').length, 1);
});

test('untracked files never receive a debt allowance', async (t) => {
  const repositoryRoot = createRepository(t);
  const looseBytes = Buffer.from('loose  \n');
  write(repositoryRoot, 'loose.js', looseBytes);

  const result = await scanRepository(repositoryRoot, {
    allowances: [{ path: 'loose.js', sha256: sha256(looseBytes) }],
  });
  assert.equal(violationsFor(result, 'untracked', 'loose.js', 'trailing-whitespace').length, 1);
  assert.equal(result.allowed.length, 0);
});

test('Git baseline allowances cannot bless new or edited debt', async (t) => {
  const repositoryRoot = createRepository(t);
  write(repositoryRoot, 'legacy.js', 'legacy  \n');
  git(repositoryRoot, ['add', '--', 'legacy.js']);
  git(repositoryRoot, ['commit', '--quiet', '-m', 'baseline']);
  const baseline = git(repositoryRoot, ['rev-parse', 'HEAD']);
  const allowances = await loadDebtFromGitRef(repositoryRoot, baseline);

  const unchanged = await scanRepository(repositoryRoot, { allowances });
  assert.equal(unchanged.violations.length, 0);
  assert.ok(unchanged.allowed.some((entry) => entry.path === 'legacy.js'));

  write(repositoryRoot, 'new.js', 'new debt  \n');
  git(repositoryRoot, ['add', '--', 'new.js']);
  const added = await scanRepository(repositoryRoot, { allowances });
  assert.equal(violationsFor(added, 'index', 'new.js', 'trailing-whitespace').length, 1);

  write(repositoryRoot, 'legacy.js', 'edited legacy  \n');
  const edited = await scanRepository(repositoryRoot, { allowances });
  assert.equal(violationsFor(edited, 'worktree', 'legacy.js', 'trailing-whitespace').length, 1);
});

test('Git discovery errors fail closed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-repo-hygiene-no-git-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(() => scanRepository(directory), /git rev-parse --show-toplevel failed/);
});
