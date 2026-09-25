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
  const assigned = Object.entries(QUALITY_TEST_SUITES).flatMap(([suite, files]: any) => files.map((file: any) => ({ suite, file })));
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

test('quality workflows keep default, desktop, and live lanes separated', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  const quality = read('.github/workflows/quality.yml');
  const native = read('.github/workflows/windows-native.yml');
  const nightly = read('.github/workflows/nightly-e2e.yml');

  // 2026-08-22 加入 test:frontend（Vitest）道：validate 必须先跑前端单测再进 unit/contract。
  assert.equal(scripts.validate, 'npm run check && npm run test:frontend && npm run test:unit:run && npm run test:contract:run');
  assert.match(scripts['test:frontend'], /^vitest run$/);
  assert.ok(
    fs.existsSync(path.join(root, 'vitest.config.ts'))
      && /environment:\s*'happy-dom'/.test(read('vitest.config.ts')),
    'frontend tests must run in happy-dom via the dedicated vitest config',
  );
  assert.match(scripts['test:check'], /^node scripts\/tests\/test-quality-gates\.js && /);
  // 2026-08-22 起 check 由并发编排器承载：门禁必须继续包含质量套件，
  // 且编排器步骤与 package.json 的旧串行链一一对应（防编排器悄悄漏步）。
  assert.match(scripts.check, /run-check-parallel/);
  const orchestrator = read('scripts/maintenance/run-check-parallel.js');
  assert.ok(orchestrator.includes("npm run test:check"), 'parallel check must include the quality suite');
    for (const legacyStep of ['design:lint', 'lint:js', 'typecheck', 'build-scenes.js --check', 'optimize-scenes.js --check',
        'classify-scene-ratings.js --check', 'validate-scenes.js', 'validate-content-contracts.js']) {
        assert.ok(orchestrator.includes(legacyStep), `parallel check orchestrator must include ${legacyStep}`);
    }
    // test:check 负责夹具/结构样式测试；四个完整扫描由并发编排器明确登记，
    // 让 full/CI 真正执行与 test:style-debt 相同的五项检查且每项只执行一次。
    // 字面量扫描默认报告趋势，只有 test:style-debt:strict 才阻断。
    assert.ok(read('scripts/tests/quality-test-inventory.ts').includes("'test-style-debt.js'"),
        'quality check suite must own the complete style-debt gate');
    for (const [name, command] of [
        ['style-literals', 'scan-style-literals.js --check'],
        ['contrast', 'check-contrast.js --check'],
        ['colors', 'lint-colors.js --check'],
        ['animations', 'lint-animations.js --check'],
    ]) {
        assert.ok(orchestrator.includes(`['${name}', 'node scripts/maintenance/${command}']`),
            `parallel check must execute the complete ${name} style scan`);
    }
  assert.doesNotMatch(scripts.validate, /test:live2d-native|test:live|test:e2e/);
  assert.doesNotMatch(scripts.validate, /build:desktop/);
  assert.match(scripts['test:live'], /regress-anima-prompt-tags\.js/);
  assert.match(scripts['test:live'], /test:live2d-native:release/);
  assert.match(scripts['build:tauri'], /run-tauri\.js build/);
  assert.match(scripts['package:tauri'], /run-tauri\.js build/);
  assert.doesNotMatch(scripts['build:tauri'], /prepare:tauri/);
  assert.doesNotMatch(scripts['package:tauri'], /prepare:tauri/);

  assert.match(quality, /npm run check/);
  const checkStep = quality.indexOf('npm run check');
  const unitStep = quality.indexOf('npm run test:unit');
  const contractStep = quality.indexOf('npm run test:contract');
  assert.ok(checkStep >= 0 && checkStep < unitStep && unitStep < contractStep,
    'Ubuntu quality workflow must run check, unit, then contract');
  assert.match(quality, /AICS_HYGIENE_BASE_REF/);
  const summary = quality.slice(quality.indexOf('  quality-summary:'));
  assert.ok(summary.length > 0, 'quality workflow must expose a final summary job');
  assert.match(summary, /if: always\(\)/);
  assert.match(summary, /needs: \[checks, unit, contract, e2e, minimum-node\]/);
  for (const lane of ['checks', 'unit', 'contract', 'e2e', 'minimum-node']) {
    assert.match(summary, new RegExp(`needs\\.${lane}\\.result|${lane.toUpperCase().replace(/-/g, '_')}_RESULT`),
      `quality summary must inspect ${lane} result`);
  }
  const audit = read('.github/workflows/dependency-audit.yml');
  assert.match(audit, /npm ci --ignore-scripts/);
  assert.match(audit, /dependency-audit-runtime\.json/);
  assert.match(audit, /dependency-audit\.json/);
  assert.match(audit, /dependency-audit-runtime\.stderr/);
  assert.match(audit, /dependency-audit\.stderr/);
  assert.match(audit, /AUDIT_COMMAND_FAILED/);
  assert.match(audit, /exitCodes/);
  assert.match(audit, /diagnostics/);
  assert.match(audit, /steps\.audit-runtime\.outputs\.exit_code/);
  assert.match(audit, /steps\.audit-full\.outputs\.exit_code/);
  assert.match(native, /self-hosted, Windows, X64, live2d-cubism/);
  assert.match(native, /github\.ref == 'refs\/heads\/main'/);
  assert.match(native, /persist-credentials: false/);
  assert.doesNotMatch(`${quality}\n${native}\n${nightly}`, /uses:\s+actions\/(?:checkout|setup-node|cache|upload-artifact)@v\d+/,
    'official actions must be pinned to immutable commit SHAs');
  assert.match(native, /LIVE2D_CUBISM_SDK_DIR/);
  assert.match(native, /npm run build:tauri/);
  assert.match(native, /cargo test --locked --manifest-path desktop-tauri\/src-tauri\/Cargo\.toml/);
  assert.match(native, /npm run test:live2d-native:release/);
  assert.match(native, /run-live2d-renderer-soak\.js --seconds 300 --switch-every 60/);
  assert.doesNotMatch(native, /pull_request:/);
});

test('contract CI builds the SPA before testing fallback and CSP on a clean checkout', () => {
  const quality = read('.github/workflows/quality.yml');
  const contract = quality.split('\n  contract:\n')[1]?.split('\n  e2e:\n')[0];
  assert.ok(contract, 'the isolated contract job must be present');
  const install = contract.indexOf('run: npm ci');
  const build = contract.indexOf('run: npm run build');
  const run = contract.indexOf('run: npm run test:contract');
  assert.ok(install >= 0 && install < build && build < run,
    'contract routes require locally built dist; another job cannot supply it');
  assert.doesNotMatch(contract, /continue-on-error:\s*true|npm run test:contract[^\n]*\|\|/,
    'route contract failures must remain fatal');
});
