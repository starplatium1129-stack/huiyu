'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const testsRoot = path.join(root, 'scripts', 'tests');
const { QUALITY_TEST_SUITES, QUALITY_EXTERNAL_TESTS }: typeof import('./quality-test-inventory') = require('./quality-test-inventory');

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('quality gates cover every deterministic test exactly once', () => {
  const assigned = Object.entries(QUALITY_TEST_SUITES).flatMap(([suite, files]) => files.map(file => ({ suite, file })));
  const discovered = fs.readdirSync(testsRoot)
    .filter((file) => /^test-.*\.(?:js|mjs)$/.test(file))
    .filter((file) => file !== 'test-quality-gates.js' && !QUALITY_EXTERNAL_TESTS.includes(file))
    .sort();
  const assignedNames = assigned.map((entry) => entry.file);
  const duplicates = assignedNames.filter((file, index) => assignedNames.indexOf(file) !== index);
  const missing = discovered.filter((file) => !assignedNames.includes(file));
  const stale = assignedNames.filter((file) => !discovered.includes(file));

  assert.deepEqual(duplicates, [], `test files assigned to multiple lanes: ${duplicates.join(', ')}`);
  assert.deepEqual(missing, [], `test files missing from quality inventory: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `quality inventory references missing files: ${stale.join(', ')}`);

  for (const file of discovered) {
    assert.doesNotMatch(read(`scripts/tests/${file}`), /require\(['"]\.\/test-[^'"\)]+['"]\)/,
      `${file} must not execute another test file as a hidden side effect`);
  }
  for (const file of [...QUALITY_TEST_SUITES.unit, ...QUALITY_TEST_SUITES.contract]) {
    assert.doesNotMatch(read(`scripts/tests/${file}`), /desktop-dist[\\/]/,
      `${file} must not depend on ignored desktop-dist in the Linux lanes`);
  }
});

// These are trust boundaries, not snapshots of job names, schedules or command ordering.
test('CI keeps real devices opt-in and official actions pinned', () => {
  const native = read('.github/workflows/windows-native.yml');
  assert.doesNotMatch(native, /pull_request:/, 'untrusted PR code must not run on the native self-hosted machine');
  assert.match(native, /persist-credentials: false/);
  const workflows = fs.readdirSync(path.join(root, '.github/workflows')).filter(file => /\.ya?ml$/.test(file));
  for (const file of workflows) {
    const source = read('.github/workflows/' + file);
    for (const match of source.matchAll(/uses:\s+actions\/[\w-]+@([^\s#]+)/g)) {
      assert.match(match[1], /^[a-f0-9]{40}$/, file + ': official actions must use immutable commits');
    }
  }
});

test('quality shallow lanes fetch only validated comparison commits and retain fallbacks', () => {
  const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
  const quality = read('.github/workflows/quality.yml');
  const section = (name: string) => quality.split(`\n  ${name}:\n`)[1].split(/\n {2}[a-z-]+:\n/)[0];
  // Git for Windows exposes git.exe through cmd/, but need not add Bash to PATH.
  const git = process.platform === 'win32' ? spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout?.trim().split(/\r?\n/)[0] : '';
  const sibling = git ? path.resolve(path.dirname(git), '../bin/bash.exe') : '';
  const bash = sibling && fs.existsSync(sibling) ? sibling : 'bash';
  const scripts = new Set<string>();
  for (const name of ['unit', 'optional']) {
    const lane = section(name);
    const script = lane.split('      - name: Fetch only the comparison baseline\n')[1]
      .split('        run: |\n')[1].split('      - name:')[0].replace(/^ {10}/gm, '');
    assert.ok(script.trim(), `${name} must provide a baseline-fetch step`);
    scripts.add(script);
  }
  for (const script of scripts) {
    const mockGit = 'git() { printf "git"; printf "<%s>" "$@"; printf "\\n"; if [[ "$1" == cat-file ]]; then return "$MOCK_PRESENT"; fi; return "$MOCK_FETCH"; }\n';
    for (const [base, present, fetch, expected] of [
      ['a'.repeat(40), '1', '0', true], ['b'.repeat(64), '1', '0', true],
      ['a'.repeat(40), '0', '0', false], ['0'.repeat(40), '1', '0', false],
      ['--upload-pack=bad', '1', '0', false], ['a'.repeat(41), '1', '0', false],
      ['a'.repeat(40), '1', '1', true],
    ] as const) {
      const result = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', mockGit + script], {
        encoding: 'utf8', env: { ...process.env, AICS_HYGIENE_BASE_REF: base, MOCK_PRESENT: present, MOCK_FETCH: fetch },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes(`git<fetch><--no-tags><--no-recurse-submodules><--depth=1><origin><${base}>`), expected);
      if (fetch === '1') assert.match(result.stdout, /full fallback suites/);
    }
  }
});

// Retired backend tests must not survive in an npm or CI command.
test('declared npm and CI Node entries have current source owners', () => {
  const packageJson = JSON.parse(read('package.json'));
  const commands = [...Object.values(packageJson.scripts) as string[], ...fs.readdirSync(path.join(root, '.github/workflows'))
    .filter(file => /\.ya?ml$/.test(file)).map(file => read('.github/workflows/' + file))];
  for (const command of commands) {
    for (const match of command.matchAll(/(?:^|[\s&|])(?:node(?: --test)? )?(scripts\/[\w./-]+\.(?:m?js|m?ts))/g)) {
      const file = match[1].replace(/\.mjs$/, '.mts').replace(/\.js$/, '.ts');
      assert.ok(fs.existsSync(path.join(root, file)) || fs.existsSync(path.join(root, match[1])), `missing command entry: ${match[1]}`);
    }
  }
  assert.equal(packageJson.scripts.validate, packageJson.scripts.test);
  assert.equal(packageJson.scripts['validate:all'], packageJson.scripts.test + ' full');
});

test('static checks stop dispatching after failure or interruption, even with --all', async t => {
  const vm: typeof import('node:vm') = require('node:vm');
  const { EventEmitter }: typeof import('node:events') = require('node:events');
  const entry = path.join(root, 'scripts/maintenance/run-check-parallel.js');
  for (const signal of [null, 'SIGINT', 'SIGTERM']) {
  const spawned: string[] = [], errors: string[] = [];
  let kills = 0, exits = 0;
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'check-runner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fakeProcess = Object.assign(new EventEmitter(), { env: { CHECK_JOBS: '2' }, argv: signal ? ['--all'] : [], platform: process.platform,
    exit: (code: number) => { exits++; assert.equal(code, 1); } });
  const fakeRequire = (name: string) => {
    if (name === 'child_process') return { spawn: (command: string) => {
      spawned.push(command);
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      const first = spawned.length === 1;
      queueMicrotask(() => {
        if (signal && first) fakeProcess.emit(signal);
        child.emit('close', signal ? 0 : first ? 1 : 0);
      });
      return child;
    } };
    if (name === '../lib/ensure-data-build') return { ensureAll() {} };
    if (name === '../lib/test-process-pool') return { killOwnedTree() { kills++; } };
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), { require: fakeRequire, process: fakeProcess, exports: {},
    __dirname: path.join(directory, 'scripts/maintenance'), setTimeout, clearTimeout, console: { log() {}, error: (line: string) => errors.push(line) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawned.length, 2, 'failure must stop queued checks, while already running checks settle');
  assert.ok(errors.some(line => line.includes('未运行:')));
  assert.equal(exits, 1);
  assert.equal(kills, signal ? 2 : 0);
  }
});
