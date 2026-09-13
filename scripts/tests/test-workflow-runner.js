'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { main, plan, audit, invocation, validateRun, EFFECTS, MACHINES } = require('../lib/workflow-runner');
const { WORKFLOWS } = require('../workflow');
const { classifyFiles, main: gate } = require('../maintenance/gate-quick');
const root = path.resolve(__dirname, '../..');

test('postinstall preserves custom hooks and only removes the absent legacy override', () => {
  const { migrateHooks } = require('../maintenance/install-git-hooks');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-hooks-'));
  try {
    for (const configured of ['custom/hooks', '/shared/hooks', '.githooks']) {
      const calls = [];
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
  const registry = { a: { cmd: ['node', 'a.js'] }, b: { cmd: ['node', 'b.js'] }, all: { steps: ['a', 'b'] } };
  let calls = 0;
  assert.equal(main(['all'], registry, root, () => { calls++; return { status: 7 }; }), 7);
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
test('quick gate covers root server, dependencies, scripts and rejects typos', () => {
  assert.deepEqual(classifyFiles(['server.js']), ['server']);
  for (const file of ['package-lock.json', 'scripts/workflow.js', '.github/workflows/quality.yml', 'vite.config.ts']) assert.deepEqual(classifyFiles([file]), ['full']);
  assert.deepEqual(classifyFiles(['docs/workflow.md']), []);
  assert.deepEqual(classifyFiles(['src/中文.vue', 'data/a.json']), ['ui', 'data']);
  assert.equal(gate(['servre']), 2);
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
  assert.ok(audit({ a: { cmd: ['node', 'a.js'] } }, root).errors.some((message) => message.includes('缺少 run')));
  const readModeCompound = {
    render: { cmd: ['node', 'r.js'], run: { nature: ['external-model', 'writes-product'], machine: ['node'], switches: {}, resume: 'checkpoint', evidence: 'r.js:1' } },
    full: { steps: ['render'], run: { nature: ['read-only'], machine: ['node'], switches: {}, resume: 'na', evidence: 'x:1' } },
  };
  assert.ok(audit(readModeCompound, root).errors.some((message) => message.includes('遗漏子步骤行为')));
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
  };
  const calls = [];
  assert.equal(main(['winOnly'], registry, root, (...args) => { calls.push(args); return { status: 0 }; }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], ['x.js']);
});

test('legacy invocations keep their exact commands after metadata landed', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, args]); return { status: 0 }; };
  assert.equal(main(['data:build'], WORKFLOWS, root, run), 0);
  assert.deepEqual(calls[0], [process.execPath, ['scripts/maintenance/build-scenes.js']]);
  assert.equal(main(['check:content'], WORKFLOWS, root, run), 0);
  const [checkCmd, checkArgs] = calls[1];
  assert.equal(checkCmd, process.execPath);
  assert.equal(checkArgs[0].endsWith('npm-cli.js'), true);
  // 无转发参数时 npm 链保持原样，不插 --（转发参数时才补分隔符）。
  assert.deepEqual(checkArgs.slice(1), ['run', 'test:content']);
  assert.equal(main(['showcase:scene-candidates', '--output', 'o', '--ids', 'sc001'], WORKFLOWS, root, run), 0);
  assert.deepEqual(calls[2], [process.execPath, ['scripts/maintenance/generate-scene-showcase-anima11.js', '--model', 'anima-miaomiao-v1.2', '--output', 'o', '--ids', 'sc001']]);
});

test('help prints run conditions without spawning; plan tags steps with nature', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const logLines = [];
  const errorLines = [];
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
  assert.deepEqual(steps[0].def.run.nature, ['preview']);
  assert.ok(steps[0].def.run.switches['--apply'].includes('writes-release'));
});

test('plan distinguishes default effects from requested switch effects without executing', () => {
  const lines = [];
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
  const run = { nature: ['read-only'], machine: ['node'], switches: {}, resume: 'na', evidence: 'fixture:1' };
  const registry = { read: { cmd: ['node', 'fixture.js'], run }, all: { steps: ['read'], run } };
  assert.deepEqual(audit(registry, root).errors, []);
  registry.read.run = { ...run, nature: ['read-only', 'writes-product'] };
  registry.all.run = { ...run, nature: ['read-only', 'guard'] };
  assert.ok(audit(registry, root).errors.some(message => message.includes('遗漏子步骤行为 writes-product')));
});

test('metadata lists must be arrays so valid audit entries remain renderable', () => {
  const run = { nature: 'read-only', machine: ['node'], switches: {}, resume: 'na', evidence: 'fixture:1' };
  assert.ok(validateRun('bad', { cmd: ['node', 'fixture.js'], run }).some(message => message.includes('nature 必须是数组')));
});

test('run metadata stays semantically consistent with the registry', () => {
  for (const [name, def] of Object.entries(WORKFLOWS)) {
    const run = def.run;
    const nature = run.nature || [];
    // 生成/出图入口必须声明对应的机器条件。
    if (nature.includes('external-model')) {
      assert.ok(nature.includes('gateway') === false || run.machine.includes('gateway'), `${name}: external-model 需声明 gateway`);
      assert.ok(run.machine.some((m) => ['gateway', 'comfyui', 'vision-api'].includes(m)), `${name}: external-model 需声明 gateway/comfyui/vision-api 之一`);
    }
    if (nature.includes('writes-release') && !run.machine.includes('windows') && !name.startsWith('showcase:')) {
      // 非 Windows 工具链的发布产物（安装包）需要 windows 声明；showcase 版本目录除外。
      assert.ok(!['installer:', 'desktop:', 'deploy:'].some((prefix) => name.startsWith(prefix)) || run.machine.includes('windows'), `${name}: 安装/部署类需声明 windows`);
    }
    // 默认 preview 的发布器，默认行为不得包含写入；写入只能出现在开关里。
    if (nature.includes('preview') && nature.every((effect) => ['read-only', 'preview'].includes(effect))) {
      assert.ok(!nature.includes('writes-release'), `${name}: 默认预览不得声明默认写入`);
      assert.ok(Object.values(run.switches || {}).some((effects) => effects.includes('writes-release')), `${name}: 预览类发布器缺少 --apply 写入描述`);
    }
    // 复合工作流的 nature 必须与其子步骤有交集（不能凭空弱化）。
    if (def.steps) {
      const childEffects = new Set(def.steps.flatMap((step) => WORKFLOWS[step]?.run?.nature || []));
      assert.ok(nature.some((effect) => childEffects.has(effect)), `${name}: 复合 nature 与子步骤无交集`);
    }
    // 枚举引用健全。
    for (const effect of nature) assert.ok(EFFECTS.includes(effect));
    for (const machine of run.machine) assert.ok(MACHINES.includes(machine));
  }
  // 已确证语义的定点校验（来自盘点证据，不是实现复述）。
  assert.deepEqual(WORKFLOWS['data:build'].run.switches['--check'], ['self-heal-missing', 'guard']);
  assert.ok(WORKFLOWS['reference:register'].run.nature.includes('writes-source'), 'reference:register 默认写 standards/view');
  assert.ok(WORKFLOWS['runtime:clean'].run.switches['--prune'].includes('delete'));
  assert.ok(!WORKFLOWS['showcase:full'].run.nature.includes('writes-release'), 'showcase:full 的发布步只预览');
});
