'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const testsRoot = path.join(root, 'scripts', 'tests');
const { QUALITY_TEST_SUITES }: typeof import('./quality-test-inventory') = require('./quality-test-inventory');

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('quality gates cover every deterministic test exactly once', () => {
  const assigned = Object.entries(QUALITY_TEST_SUITES).flatMap(([suite, files]: any) => files.map((file) => ({ suite, file })));
  const discovered = fs.readdirSync(testsRoot)
    .filter((file) => /^test-.*\.js$/.test(file))
    .filter((file) => file !== 'test-quality-gates.js')
    .sort();
  const assignedNames = assigned.map((entry) => entry.file);
  const duplicates = assignedNames.filter((file, index) => assignedNames.indexOf(file) !== index);
  const missing = discovered.filter((file) => !assignedNames.includes(file));
  const stale = assignedNames.filter((file) => !discovered.includes(file));

  assert.deepEqual(duplicates, [], `test files assigned to multiple lanes: ${duplicates.join(', ')}`);
  assert.deepEqual(missing, [], `test files missing from quality inventory: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `quality inventory references missing files: ${stale.join(', ')}`);
  assert.equal(QUALITY_TEST_SUITES.check[0], 'test-repo-hygiene.js');
  assert.equal(QUALITY_TEST_SUITES.check[1], 'test-repo-hygiene-contract.js');
  assert.ok(QUALITY_TEST_SUITES.unit.includes('test-mood-tag.js'));
  assert.ok(QUALITY_TEST_SUITES.unit.includes('test-service-watchdog.js'));
  assert.ok(QUALITY_TEST_SUITES.contract.includes('test-tunnel-restart.js'));
  assert.ok(QUALITY_TEST_SUITES.contract.includes('test-desktop-tools-route.js'));

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
  assert.equal(scripts.validate, 'npm run check && npm run test:frontend && npm run test:unit && npm run test:contract');
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
  for (const legacyStep of ['design:lint', 'lint:js', 'typecheck', 'scan-style-literals', 'check-contrast',
    'lint-colors', 'build-scenes.js --check', 'optimize-scenes.js --check',
    'classify-scene-ratings.js --check', 'validate-scenes.js', 'validate-content-contracts.js']) {
    assert.ok(orchestrator.includes(legacyStep), `parallel check orchestrator must include ${legacyStep}`);
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
  const checkStep = quality.indexOf('run: npm run check');
  const unitStep = quality.indexOf('run: npm run test:unit');
  const contractStep = quality.indexOf('run: npm run test:contract');
  assert.ok(checkStep >= 0 && checkStep < unitStep && unitStep < contractStep,
    'Ubuntu quality workflow must run check, unit, then contract');
  assert.match(quality, /AICS_HYGIENE_BASE_REF/);
  assert.doesNotMatch(quality, /npm run test:live\b|regress-anima|test:live2d-native/);
  assert.doesNotMatch(quality, /npm run test:live2d-native/);
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
