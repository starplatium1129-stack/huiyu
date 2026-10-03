'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const path: typeof import('node:path') = require('node:path');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { main, plan, audit, invocation, validateRun, EFFECTS, MACHINES }: any = require('../lib/workflow-runner');
const { WORKFLOWS }: typeof import('../workflow') = require('../workflow');
const { classifyFiles, main: gate }: typeof import('../maintenance/gate-quick') = require('../maintenance/gate-quick');
import type { WorkflowRun, WorkflowRegistry, WorkflowEffect, WorkflowCommandRunner } from '../lib/workflow-types';
const root = path.resolve(__dirname, '../..');
type CommandCall = any[];
type HookCall = string[];

function hasPreviewExecutionSwitch(run: { switches?: Record<string, WorkflowEffect[]> }) {
  return Object.entries(run.switches || {}).some(([flag, effects]: any) =>
    !['--json', '--help', '--plan'].includes(flag)
    && effects.some((effect: WorkflowEffect) => ['guard', 'writes-source', 'writes-product', 'writes-release'].includes(effect)));
}

test('postinstall preserves custom hooks and only removes the absent legacy override', () => {
  const { migrateHooks }: typeof import('../maintenance/install-git-hooks') = require('../maintenance/install-git-hooks');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-hooks-'));
  try {
    for (const configured of ['custom/hooks', '/shared/hooks', '.githooks']) {
      const calls: HookCall[] = [];
      migrateHooks(dir, (_command, args) => { calls.push(args); return configured; });
      assert.equal(calls.length, configured === '.githooks' ? 2 : 1);
      if (calls.length === 2) assert.deepEqual(calls[1], ['config', '--local', '--unset-all', 'core.hooksPath']);
    }
    fs.mkdirSync(path.join(dir, '.githooks'));
    let calls = 0;
    migrateHooks(dir, () => { calls++; return '.githooks'; });
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('orphan check fails for an unreferenced script and accepts a desktop source reference', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-orphans-'));
  const maintenance = path.join(dir, 'scripts/maintenance');
  try {
    fs.mkdirSync(maintenance, { recursive: true });
    fs.copyFileSync(path.join(root, 'scripts/maintenance/detect-orphan-scripts.js'), path.join(maintenance, 'detect-orphan-scripts.js'));
    fs.writeFileSync(path.join(maintenance, 'lonely.js'), '// no runtime side effects');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { audit: 'node scripts/maintenance/detect-orphan-scripts.js' } }));
    const run = () => spawnSync(process.execPath, [path.join(maintenance, 'detect-orphan-scripts.js'), '--check', '--json'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    let result = run();
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).orphans, [{ name: 'lonely.js' }]);
    fs.mkdirSync(path.join(dir, 'desktop-tauri'));
    fs.writeFileSync(path.join(dir, 'desktop-tauri/build.rs'), '// calls scripts/maintenance/lonely.js\n');
    result = run();
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).orphanCount, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every registered help is side-effect free; plans never spawn', () => {
  const never = () => { throw new Error('unexpected child execution'); };
  for (const name of Object.keys(WORKFLOWS)) assert.equal(main([name, '--help'], WORKFLOWS, root, never), 0);
  assert.equal(main(['data:build', '--plan'], WORKFLOWS, root, never), 0);
});
test('registry references and graph are valid', () => {
  assert.deepEqual(audit(WORKFLOWS, root).errors, []);
  assert.equal(audit({ a: { steps: ['a'] } }, root).ok, false);
});
test('composites stop after failure and preserve child errors', () => {
  const registry = { a: { cmd: ['node', 'a.js'] }, b: { cmd: ['node', 'b.js'] }, all: { steps: ['a', 'b'] } } as any as WorkflowRegistry;
  let calls = 0;
  const runner: WorkflowCommandRunner = () => { calls++; return { status: 7 }; };
  assert.equal(main(['all'], registry, root, runner), 7);
  assert.equal(calls, 1);
  assert.equal(main(['a'], registry, root, () => ({ error: new Error('ENOENT'), status: null })), 1);
  assert.throws(() => plan('all', ['--keys', 'x'], registry));
});
test('showcase uses one candidate directory across stages and previews publication', () => {
  const steps = plan('showcase:full', ['--output', 'review folder', '--source', 'old', '--target', 'new'], WORKFLOWS);
  assert.ok(steps[1].args.includes(path.join('review folder', 'generation-manifest.json')));
  assert.ok(steps[2].args.includes(path.join('review folder', 'generation-manifest.json')));
  assert.ok(!steps[2].args.includes('--apply'));
  assert.throws(() => plan('showcase:full', [], WORKFLOWS));
});
test('npm argument forwarding preserves spaces and metacharacters', () => {
  const [cmd, args] = invocation({ cmd: ['npm', 'run', 'character:onboard'] }, ['--character', 'a & b']);
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args.slice(-3), ['--', '--character', 'a & b']);
});
test('quick gate covers unknown root files, dependencies, scripts and rejects typos', async () => {
  assert.deepEqual(classifyFiles(['unknown-root.js']), { areas: ['full'], testFiles: [] });
  for (const file of ['package-lock.json', 'vite.config.ts']) assert.deepEqual(classifyFiles([file]), { areas: ['full'], testFiles: [] });
  assert.deepEqual(classifyFiles(['docs/workflow.md']), { areas: ['docs'], testFiles: [] });
  assert.deepEqual(classifyFiles(['src/中文.vue', 'data/a.json']), { areas: ['ui', 'data'], testFiles: [] });
  for (const file of ['runtime-rs/src/storage.rs', 'runtime-rs/tests/task_execution.rs', 'runtime-rs/tests/fixtures/task-fingerprints.json', 'runtime-rs/Cargo.toml', 'runtime-rs/Cargo.lock']) {
    assert.deepEqual(classifyFiles([file]), { areas:['rust'], testFiles:[] });
  }
  assert.equal(await gate(['servre']), 2);
});

test('Rust-only gate avoids Node suites and a Rust failure stops explicit full before later phases', async () => {
  const vm: typeof import('node:vm') = require('node:vm');
  const { createRequire }: typeof import('node:module') = require('node:module');
  const entry = path.join(root,'scripts/maintenance/gate-quick.js'), originalRequire = createRequire(entry);
  const calls: string[] = []; let rustCode = 0;
  const fakeRequire = (name: string) => {
    if (name === '../tests/run-quality-suite') return { ...originalRequire(name),
      runNpmScript:(script: string) => { calls.push(script); return {ok:true,duration:1,output:''}; },
      runUnitSuite:() => {calls.push('unit');return 0;}, runContractSuite:async() => {calls.push('contract');return 0;} };
    if (name === '../lib/test-process-pool') return { runTestProcessPool:async(entries: any[]) => {
      assert.equal(path.basename(entries[0].file),'run-rust-runtime.js'); assert.deepEqual(Array.from(entries[0].args),['check']); calls.push('rust:check');
      return {results:[{ok:rustCode===0,exitCode:rustCode,duration:1,output:'',reason:rustCode?'fixture failure':''}]};
    } };
    if (name === '../tests/quality-report') return {...originalRequire(name),writeQualityReport:()=>{}};
    return originalRequire(name);
  };
  const module = {exports:{} as typeof import('../maintenance/gate-quick')};
  vm.runInNewContext(fs.readFileSync(entry,'utf8'), {require:fakeRequire,module,exports:module.exports,__dirname:path.dirname(entry),process,
    AbortController,setTimeout,clearTimeout,console:{log(){},error(){}}});
  assert.equal(await module.exports.main(['rust']),0);
  assert.deepEqual(calls,['rust:check']); calls.length=0;
  assert.equal(await module.exports.main(['full']),0);
  assert.deepEqual(calls,['check','rust:check','test:frontend -- --coverage','unit','contract','test:tooling','test:release','build:web:run']); calls.length=0;
  rustCode=1;
  assert.equal(await module.exports.main(['full']),1);
  assert.deepEqual(calls,['check','rust:check']);
});

test('quick gate selects registered Node tests once across source and generated paths', () => {
  assert.deepEqual(classifyFiles([
    'scripts/tests/test-api-client.ts', 'scripts\\tests\\test-api-client.js',
    'scripts/tests/test-chat-storage.ts', 'scripts/tests/test-module-boundaries.mts', 'docs/workflow.md',
  ]), { areas: ['tests', 'docs'], testFiles: ['test-api-client.js', 'test-chat-storage.js', 'test-module-boundaries.mjs'] });
  assert.deepEqual(classifyFiles(['src/utils/stream.spec.ts', 'scripts/tests/test-chat-storage.ts']), {
    areas: ['ui', 'tests'], testFiles: ['test-chat-storage.js'], frontendFiles: ['src/utils/stream.spec.ts'],
  });
});

test('quick gate keeps unbounded fixtures, unknown or removed tests and device tests at full scope', () => {
  for (const file of [
    'scripts/tests/quality-test-inventory.ts', 'scripts/tests/mock-stack.ts',
    'scripts/tests/test-unknown.ts', 'scripts/tests/test-removed-fixture.ts',
    'scripts/tests/test-electron-shell.mts', 'tests/e2e/helpers/sceneState.ts', 'tsconfig.tests.json',
  ]) {
    assert.deepEqual(classifyFiles(['scripts/tests/test-api-client.ts', file]), { areas: ['full'], testFiles: [] }, file);
  }
});

test('known tool and CI consumers stay targeted without dropping shared runner failure checks', () => {
  assert.deepEqual(classifyFiles(['scripts/workflow.ts']), {
    areas: ['tests'], testFiles: ['test-workflow-runner.js', 'test-workflow-conditions.js'],
  });
  assert.deepEqual(classifyFiles(['scripts/tests/run-quality-suite.ts', 'scripts/lib/test-process-pool.ts']), {
    areas: ['tests'], testFiles: ['test-workflow-runner.js', 'test-quality-report.js', 'test-test-process-pool.js', 'test-quality-gates.js'],
  });
  assert.deepEqual(classifyFiles(['.github/workflows/quality.yml']), {
    areas: ['tests'], testFiles: ['test-quality-gates.js', 'test-e2e-ci-split.js'],
  });
  assert.deepEqual(classifyFiles(['tsconfig.app.json']), { areas: ['ui'], testFiles: [] });
  assert.deepEqual(classifyFiles(['start.ps1', 'control.bat']), { areas: ['tests'], testFiles: ['test-desktop-staging.js'] });
  assert.deepEqual(classifyFiles(['scripts/tests/extract-wd14-untranslated.ts', 'scripts/tests/test-untranslated-tags.ts']),
    { areas: ['tests'], testFiles: ['test-untranslated-tags.js'] });
  assert.deepEqual(classifyFiles(['tests/e2e/studio-live2d.spec.ts']), {
    areas: ['browser-types'], testFiles: [], manualFiles: ['tests/e2e/studio-live2d.spec.ts'],
  });
  const { selectOptionalTests }: typeof import('./run-optional-test-lanes') = require('./run-optional-test-lanes');
  assert.deepEqual(selectOptionalTests(['scripts/lib/scene-write.ts']), [{ lane: 'tooling', files: ['test-scene-write.js'] }]);
  assert.deepEqual(selectOptionalTests(['scripts/tests/extract-wd14-untranslated.ts']), [{ lane: 'tooling', files: ['test-untranslated-tags.js'] }]);
});

test('quick gate selects related frontend sources and exact regular browser specs', () => {
  assert.deepEqual(classifyFiles(['src/utils/characterTheme.ts', 'tests/e2e/studio.spec.ts', 'tests/e2e/studio.spec.ts']), {
    areas: ['ui', 'browser'], testFiles: [], frontendFiles: ['src/utils/characterTheme.ts'], browserFiles: ['tests/e2e/studio.spec.ts'],
  });
  assert.deepEqual(classifyFiles(['src/utils/characterTheme.ts', 'src/assets/css/companion.css']), {
    areas: ['ui', 'style'], testFiles: [], frontendFiles: ['src/utils/characterTheme.ts'],
  }, 'CSS uses its own scans and does not widen the related logic tests');
  assert.deepEqual(classifyFiles(['src/assets/css/companion.css']), { areas: ['style'], testFiles: [] });
  assert.deepEqual(classifyFiles(['tests/e2e/unknown.spec.ts']), { areas: ['full'], testFiles: [] });
  assert.deepEqual(classifyFiles(['src/utils/deleted-test.spec.ts']), { areas: ['full'], testFiles: [] });
});

test('Vue style-only changes avoid UI checks while script, template and generated bindings stay protected', () => {
  const { isVueStyleOnlyChange }: typeof import('../maintenance/gate-quick') = require('../maintenance/gate-quick');
  const previous = '<script setup>const accent = "red"</script><template><p>hello</p></template><style scoped>p { color: red }</style>';
  const current = previous.replace('color: red', 'color: blue');
  assert.equal(isVueStyleOnlyChange(previous, current, 'fixture.vue'), true);
  for (const source of [
    previous, current.replace('const accent = "red"', 'const accent = "blue"'),
    current.replace('<p>hello</p>', '<p>changed</p>'), current.replace('scoped', 'module'),
    current.replace('color: blue', 'color: v-bind(accent)'), current.replace('<style scoped>', '<style>'),
    current + '<i18n>{"hello":"changed"}</i18n>', current + '<template>duplicate</template>',
  ]) assert.equal(isVueStyleOnlyChange(previous, source, 'fixture.vue'), false);
  assert.equal(isVueStyleOnlyChange(undefined, current, 'fixture.vue'), false);
  assert.equal(isVueStyleOnlyChange(previous + '<i18n>{}</i18n>', current + '<route>{}</route>', 'fixture.vue'), false);
  const file = 'src/components/library/CharacterDirectory.vue';
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(source, /<style[^>]*>/);
  const baseline = () => source.replace(/(<style[^>]*>)/, '$1\n.baseline-only { color: red }');
  assert.deepEqual(classifyFiles([file], baseline), { areas: ['style'], testFiles: [] });
  assert.deepEqual(classifyFiles([file, 'src/utils/characterTheme.ts'], baseline), {
    areas: ['style', 'ui'], testFiles: [], frontendFiles: ['src/utils/characterTheme.ts'],
  });
});

test('quality suite selection deduplicates exact source entries and rejects typos or wrong suites', () => {
  const { selectSuiteFiles }: typeof import('./run-quality-suite') = require('./run-quality-suite');
  const { QUALITY_TEST_SUITES }: typeof import('./quality-test-inventory') = require('./quality-test-inventory');
  assert.deepEqual(selectSuiteFiles('unit', ['test-api-client.ts', 'scripts/tests/test-api-client.js', '--verbose']), ['test-api-client.js']);
  assert.deepEqual(selectSuiteFiles('contract', []), QUALITY_TEST_SUITES.contract);
  for (const arg of ['test-api-clinet.ts', 'test-tag-shards.ts', '../test-api-client.js', '--typo']) {
    assert.throws(() => selectSuiteFiles('unit', [arg]), /Unknown unit test/);
  }
});

test('optional selection narrows test-only changes, deduplicates, and expands for affected consumers', async () => {
  const { selectOptionalTests }: typeof import('./run-optional-test-lanes') = require('./run-optional-test-lanes');
  const { QUALITY_TEST_SUITES }: typeof import('./quality-test-inventory') = require('./quality-test-inventory');
  const full = (lane: 'tooling' | 'release') => ({ lane, files: QUALITY_TEST_SUITES[lane] });
  for (const [paths, lanes] of [
    [['src/views/HomeView.vue', 'data/scenes/core.json', 'docs/workflow.md'], []],
    [['scripts/lib/scene-store.ts'], ['tooling', 'release']],
    [['desktop-tauri/src-tauri/src/main.rs'], ['release']],
    [['runtime-rs/src/storage.rs', 'runtime-rs/tests/task_execution.rs', 'runtime-rs/Cargo.lock'], []],
    [['runtime-rs/native-dependencies.windows-x64.json'], ['release']], [['runtime-rs/tests/parity.mjs'], []],
    [['unclassified-code.ts'], ['tooling', 'release']],
    [['scripts/tests/test-removed.ts'], ['tooling', 'release']],
  ] as const) assert.deepEqual(selectOptionalTests(paths), lanes.map(full));
  const testFile = 'scripts/tests/test-scene-write.ts';
  assert.deepEqual(selectOptionalTests([testFile, 'scripts\\tests\\test-scene-write.js', 'scripts/tests/test-api-client.ts']),
    [{ lane: 'tooling', files: ['test-scene-write.js'] }]);
  assert.deepEqual(selectOptionalTests([testFile, 'scripts/tests/test-desktop-updates.ts']),
    [{ lane: 'tooling', files: ['test-scene-write.js'] }, { lane: 'release', files: ['test-desktop-updates.js'] }]);
  for (const paths of [[testFile, 'scripts/maintenance/build-blueprints.ts'], ['scripts/maintenance/build-blueprints.ts', testFile]]) {
    assert.deepEqual(selectOptionalTests(paths), [full('tooling')]);
  }
  // Exercise dispatch as well as selection: a correct plan must not silently
  // become a whole-lane subprocess, and an unavailable baseline must stay broad.
  const vm: typeof import('node:vm') = require('node:vm');
  const { createRequire }: typeof import('node:module') = require('node:module');
  const entry = path.join(root, 'scripts/tests/run-optional-test-lanes.js'), realRequire = createRequire(entry);
  const calls: string[][] = [];
  const fakeProcess = Object.create(process) as NodeJS.Process;
  fakeProcess.env = { ...process.env, CI: '1', AICS_HYGIENE_BASE_REF: 'a'.repeat(40) };
  const fakeRequire = (name: string) => {
    if (name === 'node:child_process') return { spawnSync: (_file: string, args: string[]) => ({ status: 0, stdout: args[0] === 'diff' ? `${testFile}\0` : '' }) };
    if (name === './run-quality-suite') return { ...realRequire(name), runNpmScript: (script: string) => {
      calls.push([script]); return { ok: true }; } };
    if (name === '../lib/test-process-pool') return { runTestProcessPool: async (entries: Array<{ args: string[] }>) => {
      calls.push(Array.from(entries[0].args)); return { results: [{ ok: true, duration: 0 }] }; } };
    return realRequire(name);
  };
  const module = { exports: {} as typeof import('./run-optional-test-lanes') };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), { require: fakeRequire, module, exports: module.exports, process: fakeProcess,
    __dirname: path.dirname(entry), AbortController, console: { log() {}, error() {} } });
  assert.equal(await module.exports.main(), 0);
  assert.deepEqual(calls, [['tooling', 'test-scene-write.js']]); calls.length = 0;
  fakeProcess.env.AICS_HYGIENE_BASE_REF = 'invalid';
  assert.equal(await module.exports.main(), 0);
  assert.deepEqual(calls, ([...(['tooling', 'release'] as const).map(lane => [lane, ...QUALITY_TEST_SUITES[lane]])]));
});

test('product unit selection executes each file once without retired maintenance phases', () => {
  const { planUnitTests }: typeof import('./run-quality-suite') = require('./run-quality-suite');
  const { QUALITY_TEST_SUITES }: typeof import('./quality-test-inventory') = require('./quality-test-inventory');
  const groups = planUnitTests(QUALITY_TEST_SUITES.unit);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].files, QUALITY_TEST_SUITES.unit);
  assert.equal(groups[0].concurrency, 4);
  assert.deepEqual(planUnitTests([]), []);
});

test('quick gate does not execute stale generated tests when their registered source was deleted', t => {
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (file: import('node:fs').PathLike) => String(file).endsWith('test-api-client.ts') ? false : exists(file));
  assert.deepEqual(classifyFiles(['scripts/tests/test-api-client.ts']), { areas: ['full'], testFiles: [] });
});

test('invalid contract concurrency fails before full-gate execution while help stays read-only', async () => {
  const previous = process.env.CONTRACT_TEST_JOBS;
  process.env.CONTRACT_TEST_JOBS = 'invalid';
  try {
    assert.equal(await gate(['--help']), 0);
    assert.equal(await gate(['full']), 2);
  } finally {
    if (previous === undefined) delete process.env.CONTRACT_TEST_JOBS;
    else process.env.CONTRACT_TEST_JOBS = previous;
  }
});
test('desktop batch preserves failure without deploying or waiting for input', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-workflow-'));
  const file = path.join(dir, 'deploy.bat');
  try {
    const source = fs.readFileSync(path.join(root, 'deploy-desktop.bat'), 'utf8');
    // Replace the sole deployment invocation with a controlled failure in an isolated copy.
    assert.equal(source.split(/\r?\n/).filter(line => line.startsWith('powershell ')).length, 1);
    fs.writeFileSync(file, source.replace(/^powershell .*$/m, 'cmd /c exit 7'));
    const result = spawnSync('cmd.exe', ['/d', '/c', file], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
      env: { ...process.env, AICS_WORKFLOW_NONINTERACTIVE: '1' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 7);
    assert.doesNotMatch(result.stdout + result.stderr, /not recognized|不是内部/);
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

// ── W1 运行条件元数据（run）───────────────────────────────────────────

test('every registered entry carries valid run metadata', () => {
  for (const [name, def] of Object.entries(WORKFLOWS)) {
    const errors = validateRun(name, def);
    assert.deepEqual(errors, [], `${name} 的 run 元数据不合法`);
  }
});

test('audit rejects missing, malformed and understated compound metadata', () => {
  assert.ok(audit({ a: { cmd: ['node', 'a.js'] } }, root).errors.some((message: any) => message.includes('缺少 run')));
  const readModeCompound = {
    render: { cmd: ['node', 'r.js'], run: { nature: ['external-model', 'writes-product'], machine: ['node'], switches: {}, resume: 'checkpoint', evidence: 'r.js:1' } },
    full: { steps: ['render'], run: { nature: ['read-only'], machine: ['node'], switches: {}, resume: 'na', evidence: 'x:1' } },
  };
  assert.ok(audit(readModeCompound, root).errors.some((message: any) => message.includes('遗漏子步骤行为')));
  const badEnum = { a: { cmd: ['node', 'a.js'], run: { nature: ['magic'], machine: ['mainframe'], switches: { 'x': ['read-only'] }, resume: 'sometimes', evidence: '' } } };
  const messages = audit(badEnum, root).errors.join('\n');
  for (const fragment of ['未知 nature "magic"', '未知 machine "mainframe"', '开关名必须以 -- 开头', 'resume 必须是', 'run.evidence 必须指向核实位置']) {
    assert.ok(messages.includes(fragment), `审计未报告: ${fragment}`);
  }
});

test('metadata is descriptive only: execution path never consults run', () => {
  // machine 声明为 windows 的 node 命令在任何平台都按原样执行（无基于元数据的拦截）。
  const registry = {
    winOnly: { cmd: ['node', 'x.js'], run: { nature: ['writes-product'], machine: ['windows'], switches: {}, resume: 'na', evidence: 'x.js:1' } },
  } as any as WorkflowRegistry;
  const calls: CommandCall[] = [];
  assert.equal(main(['winOnly'], registry, root, (...args: any[]) => { calls.push(args); return { status: 0 }; }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], ['x.js']);
});

test('legacy invocations keep their exact commands after metadata landed', () => {
  const calls: CommandCall[] = [];
  const run: WorkflowCommandRunner = (cmd, args) => { calls.push([cmd, args]); return { status: 0 }; };
  assert.equal(main(['data:build'], WORKFLOWS, root, run), 0);
  assert.deepEqual(calls[0], [process.execPath, ['scripts/maintenance/build-scenes.js']]);
  assert.equal(main(['check:content'], WORKFLOWS, root, run), 0);
  const [checkCmd, checkArgs] = calls[1]!;
  assert.equal(checkCmd, process.execPath);
  assert.equal(checkArgs[0].endsWith('npm-cli.js'), true);
  // 无转发参数时 npm 链保持原样，不插 --（转发参数时才补分隔符）。
  assert.deepEqual(checkArgs.slice(1), ['run', 'test:content']);
  assert.equal(main(['showcase:scene-candidates', '--output', 'o', '--ids', 'sc001'], WORKFLOWS, root, run), 0);
  assert.deepEqual(calls[2], [process.execPath, ['scripts/maintenance/generate-scene-showcase-anima11.js', '--model', 'anima-miaomiao-v1.6', '--output', 'o', '--ids', 'sc001']]);
});

test('help prints run conditions without spawning; plan tags steps with nature', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const logLines: string[] = [];
  const errorLines: string[] = [];
  console.log = (line) => logLines.push(String(line));
  console.error = (line) => errorLines.push(String(line));
  try {
    assert.equal(main(['data:build', '--help'], WORKFLOWS, root, () => { throw new Error('help must not spawn'); }), 0);
    const helpText = logLines.join('\n');
    assert.ok(helpText.includes('"run"'), '帮助未输出 run 元数据');
    assert.ok(helpText.includes('self-heal-missing'), '帮助未输出 --check 自愈语义');
    logLines.length = 0;
    errorLines.length = 0;
    // 预览发布步需要必填参数齐全；--plan 仍不执行任何子进程。
    assert.equal(main(['showcase:publish', '--plan', '--from', 'f', '--source', 's', '--target', 't'], WORKFLOWS, root, () => { throw new Error('plan must not spawn'); }), 0);
    assert.ok(errorLines.some((line) => line.includes('[预览]') && line.includes('[默认: preview]')), '预览未标注默认 nature');
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  // plan 的步骤组装与发布预览语义（不带 --apply）。
  const steps = plan('showcase:publish', ['--from', 'f', '--source', 's', '--target', 't'], WORKFLOWS);
  assert.deepEqual(steps[0]!.def.run!.nature, ['preview']);
  assert.ok(steps[0]!.def.run!.switches!['--apply'].includes('writes-release'));
});

test('plan distinguishes default effects from requested switch effects without executing', () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = line => lines.push(String(line));
  try {
    assert.equal(main(['showcase:publish', '--plan', '--from', 'f', '--source', 's', '--target', 't', '--apply'], WORKFLOWS, root, () => { throw new Error('must not execute'); }), 0);
    assert.ok(lines.some(line => line.includes('--apply: writes-release')));
    lines.length = 0;
    assert.equal(main(['data:build', '--check', '--plan'], WORKFLOWS, root, () => { throw new Error('must not execute'); }), 0);
    assert.ok(lines.some(line => line.includes('--check: self-heal-missing, guard')));
  } finally { console.error = original; }
});

test('audit accepts truly passive composites and rejects missing child write effects', () => {
  const run: WorkflowRun = { nature: ['read-only'], machine: ['node'], switches: {}, resume: 'na', evidence: 'fixture:1' };
  const registry = { read: { cmd: ['node', 'fixture.js'], run }, all: { steps: ['read'], run } } as any as WorkflowRegistry;
  assert.deepEqual(audit(registry, root).errors, []);
  registry.read.run = { ...run, nature: ['read-only', 'writes-product'] };
  registry.all.run = { ...run, nature: ['read-only', 'guard'] };
  assert.ok(audit(registry, root).errors.some((message: any) => message.includes('遗漏子步骤行为 writes-product')));
});

test('metadata lists must be arrays so valid audit entries remain renderable', () => {
  const run = { nature: 'read-only', machine: ['node'], switches: {}, resume: 'na', evidence: 'fixture:1' };
  assert.ok(validateRun('bad', { cmd: ['node', 'fixture.js'], run }).some((message: any) => message.includes('nature 必须是数组')));
});

test('run metadata stays semantically consistent with the registry', () => {
  assert.ok(WORKFLOWS['check:impact'].run.nature.every(effect => ['preview', 'read-only'].includes(effect)));
  for (const [name, def] of Object.entries(WORKFLOWS)) {
    const run: any = def.run;
    const nature: any = run.nature || [];
    // 生成/出图入口必须声明对应的机器条件。
    if (nature.includes('external-model')) {
      assert.ok(nature.includes('gateway') === false || run.machine.includes('gateway'), `${name}: external-model 需声明 gateway`);
      assert.ok(run.machine.some((m: any) => ['gateway', 'comfyui', 'vision-api'].includes(m)), `${name}: external-model 需声明 gateway/comfyui/vision-api 之一`);
    }
    if (nature.includes('writes-release') && !run.machine.includes('windows') && !name.startsWith('showcase:')) {
      // 非 Windows 工具链的发布产物（安装包）需要 windows 声明；showcase 版本目录除外。
      assert.ok(!['installer:', 'desktop:', 'deploy:'].some((prefix) => name.startsWith(prefix)) || run.machine.includes('windows'), `${name}: 安装/部署类需声明 windows`);
    }
    // 默认 preview 的入口，默认行为不得包含写入；写入只能出现在开关里。
    // 发布器显式 apply 写入；只读检查器显式 execute 仅做 guard。两者都不能默认写入。
    if (nature.includes('preview') && nature.every((effect: any) => ['read-only', 'preview'].includes(effect))) {
      assert.ok(!nature.includes('writes-release'), `${name}: 默认预览不得声明默认写入`);
      assert.ok(
        hasPreviewExecutionSwitch(run),
        `${name}: 预览入口缺少实际执行开关（只读 guard 或显式写入）`
      );
    }
    // 复合工作流的 nature 必须与其子步骤有交集（不能凭空弱化）。
    if (def.steps) {
      const childEffects = new Set(def.steps.flatMap((step) => WORKFLOWS[step]?.run?.nature || []));
      assert.ok(nature.some((effect: any) => childEffects.has(effect)), `${name}: 复合 nature 与子步骤无交集`);
    }
    // 枚举引用健全。
    for (const effect of nature) assert.ok(EFFECTS.includes(effect));
    for (const machine of run.machine) assert.ok(MACHINES.includes(machine));
  }
  // 已确证语义的定点校验（来自盘点证据，不是实现复述）。
  assert.deepEqual(WORKFLOWS['data:build'].run.switches!['--check'], ['self-heal-missing', 'guard']);
  assert.ok(WORKFLOWS['reference:register'].run.nature.includes('writes-source'), 'reference:register 默认写 standards/view');
  assert.ok(WORKFLOWS['runtime:clean'].run.switches!['--prune'].includes('delete'));
  assert.ok(!WORKFLOWS['showcase:full'].run.nature.includes('writes-release'), 'showcase:full 的发布步只预览');
});

test('deploy preview describes installer switches without invoking deployment', () => {
  assert.deepEqual(WORKFLOWS['deploy:desktop'].cmd, ['deploy-desktop.bat', '-SkipBuild']);
  assert.deepEqual(WORKFLOWS['deploy:desktop:full'].cmd, ['deploy-desktop.bat']);
  for (const name of ['deploy:desktop', 'deploy:desktop:full']) {
    const run = WORKFLOWS[name].run;
    assert.ok(run.switches!['-UseInstaller'].includes('writes-release'));
    assert.ok(run.nature.includes('writes-source'), `${name} 未声明 DATA_VERSION 写入`);
    assert.ok(run.nature.includes('writes-product'), `${name} 未声明数据聚合重建的 writes-product`);
    for (const flag of ['-UseInstaller', '-QuietInstall', '-NoRestart', '-StartupRepair', '-InstallDir']) {
      assert.ok(run.notes!.some((note) => note.includes(flag)), `${name} 未记录开关 ${flag}`);
    }
  }
  const lines: string[] = [], original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    assert.equal(main(['deploy:desktop', '-UseInstaller', '-NoRestart', '--plan'], WORKFLOWS, root, () => assert.fail('deployment executed')), 0);
    assert.ok(lines.some(line => line.includes('-UseInstaller: writes-release')));
    assert.ok(lines.some(line => line.includes('-SkipBuild') && line.includes('-NoRestart')));
  } finally { console.error = original; }
});

test('single-dash metadata is limited to batch alphabetic flags', () => {
  const def = WORKFLOWS['deploy:desktop'];
  for (const flag of ['-UseInstaller', '-NoRestart']) {
    const run = { ...def.run, switches: { [flag]: ['writes-release'] } };
    assert.deepEqual(validateRun('batch', { ...def, run }), []);
    assert.ok(validateRun('node', { ...def, cmd: ['node', 'example.js'], run }).length > 0);
  }
  for (const flag of ['-UseInstaller & whoami', '-InstallDir=elsewhere', '-']) {
    assert.ok(validateRun('batch', { ...def, run: { ...def.run, switches: { [flag]: ['writes-release'] } } }).length > 0);
  }
});

test('UI gate prepares only the missing popular catalog before unchanged targeted checks', async () => {
  const vm: typeof import('node:vm') = require('node:vm');
  const { createRequire }: typeof import('node:module') = require('node:module');
  const entry = path.join(root, 'scripts/maintenance/gate-quick.js'), originalRequire = createRequire(entry);
  const calls: string[] = []; let typecheckOk = true; let bootstrapError = false;
  const fakeRequire = (name: string) => {
    if (name === '../lib/ensure-data-build') return {
      ensurePopularBuilt: (options: { onlyIfMissing: boolean }) => {
        assert.equal(options.onlyIfMissing, true); calls.push('popular:only-if-missing');
        if (bootstrapError) throw new Error('invalid catalog fixture');
        return { rebuilt: false };
      },
      ensureAll: () => { throw new Error('UI must not prepare all data domains'); },
    };
    if (name === '../tests/run-quality-suite') return { ...originalRequire(name),
      runNpmScript: (script: string) => { calls.push(script); return { ok: typecheckOk, duration: 1, output: '', reason: 'fixture' }; } };
    if (name === '../lib/test-process-pool') return { runTestProcessPool: async (entries: Array<{ args: string[] }>) => {
      assert.deepEqual(Array.from(entries[0].args), ['related', '--run', '--passWithNoTests', 'src/components/library/CharacterDirectory.vue']);
      calls.push('vitest:related'); return { results: [{ ok: true, duration: 1, output: '', reason: '' }] };
    } };
    if (name === '../tests/quality-report') return { ...originalRequire(name), writeQualityReport: () => {} };
    return originalRequire(name);
  };
  const module = { exports: {} as typeof import('../maintenance/gate-quick') };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), { require: fakeRequire, module, exports: module.exports, __dirname: path.dirname(entry), process,
    AbortController, setTimeout, clearTimeout, console: { log() {}, error() {} } });
  const run = () => module.exports.AREA_STEPS.ui({ verbose: false, keepGoing: false }, ['src/components/library/CharacterDirectory.vue']);
  assert.equal(await run(), 0);
  assert.deepEqual(calls, ['popular:only-if-missing', 'typecheck:app', 'vitest:related']); calls.length = 0;
  typecheckOk = false;
  assert.equal(await run(), 1);
  assert.deepEqual(calls, ['popular:only-if-missing', 'typecheck:app']); calls.length = 0;
  bootstrapError = true;
  await assert.rejects(run(), /invalid catalog fixture/);
  assert.deepEqual(calls, ['popular:only-if-missing']);
});
