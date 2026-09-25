'use strict';

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const { test }: typeof import('node:test') = require('node:test');

test("E2E CI split tests passed: critical PR paths and nightly visual matrix stay separated", () => {
const root = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const quality = fs.readFileSync(path.join(root, '.github', 'workflows', 'quality.yml'), 'utf8');
const nightly = fs.readFileSync(path.join(root, '.github', 'workflows', 'nightly-e2e.yml'), 'utf8');
const native = fs.readFileSync(path.join(root, '.github', 'workflows', 'windows-native.yml'), 'utf8');

// E2E 归一架构：以 tests/e2e/e2e-lanes.json 为唯一测试登记清单，
// package.json 的 critical 与 nightly 均通过 run-e2e-lane.js 统一派发；
// 新测试只需在 e2e-lanes.json 登记一次即可自动纳入对应泳道。
const critical = pkg.scripts['test:e2e:critical:run'];
const nightlyRun = pkg.scripts['test:e2e:nightly:run'];
assert.strictEqual(critical, 'node scripts/tests/run-e2e-lane.js critical',
  'critical browser command must execute the unified lane runner');
assert.strictEqual(nightlyRun, 'node scripts/tests/run-e2e-lane.js nightly',
  'nightly browser command must execute the unified lane runner');

const { getSpecsForLane }: typeof import('./run-e2e-lane') = require('./run-e2e-lane');
const laneManifest = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'e2e', 'e2e-lanes.json'), 'utf8')) as {
  schemaVersion: number;
  specs: Array<{ file: string; lane: string; risk: string; reason: string }>;
};
assert.strictEqual(laneManifest.schemaVersion, 1, 'E2E lane manifest schema must be supported');
const discoveredSpecs = fs.readdirSync(path.join(root, 'tests', 'e2e'))
  .filter(function (file) { return file.endsWith('.spec.ts'); })
  .sort();
const manifestSpecs = laneManifest.specs.map(function (entry) { return entry.file; });
assert.deepStrictEqual([...new Set(manifestSpecs)].sort(), discoveredSpecs,
  'every browser spec must have exactly one lane entry');
assert.ok(laneManifest.specs.every(function (entry) {
  return ['critical', 'nightly', 'device', 'manual'].includes(entry.lane)
    && entry.risk.trim().length > 0 && entry.reason.trim().length > 0;
}), 'every E2E lane entry must declare a supported lane, risk, and reason');
const specsForLane = function (lane: string) {
  return laneManifest.specs.filter(function (entry) { return entry.lane === lane; })
    .map(function (entry) { return entry.file; }).sort();
};

assert.strictEqual(pkg.scripts['test:e2e'], 'npm run build && npm run test:e2e:all');
assert.match(pkg.scripts['test:e2e:all'], /^playwright test$/);
assert.match(pkg.scripts['test:e2e:critical'], /npm run build && npm run test:e2e:critical:run/);
assert.match(pkg.scripts['test:e2e:nightly'], /npm run build && npm run test:e2e:nightly:run/);

const criticalSpecs = getSpecsForLane('critical');
assert.deepStrictEqual(criticalSpecs, specsForLane('critical'),
  'runner critical specs must match the lane manifest');
const manifestNightlySpecs = getSpecsForLane('nightly');
assert.deepStrictEqual(manifestNightlySpecs, specsForLane('nightly'),
  'runner nightly specs must match the lane manifest');

for (const spec of ['studio.spec.ts', 'flows.spec.ts', 'a11y-device.spec.ts', 'anima-quick.spec.ts', 'interaction-polish.spec.ts']) {
  assert(criticalSpecs.includes(spec), `critical browser regression must include ${spec}`);
}
assert(!criticalSpecs.some(spec => /capture\.spec\.ts|theme-audit\.spec\.ts/.test(spec)),
  'visual audit specs must not make PR browser regression slower');

for (const spec of ['theme-audit.spec.ts', 'capture.spec.ts', 'particle-atmosphere.spec.ts', 'particle-narrative.spec.ts', 'archive-visual-language.spec.ts']) {
  assert(manifestNightlySpecs.includes(spec), `nightly visual regression must include ${spec}`);
}
const nightlySpecs = manifestNightlySpecs;
const overlap = criticalSpecs.filter(function (spec) { return nightlySpecs.includes(spec); });
assert.deepStrictEqual(overlap, [], 'critical 与 nightly 分组不得重叠');
assert(!nightlySpecs.some(spec => ['studio.spec.ts', 'flows.spec.ts', 'a11y-device.spec.ts'].includes(spec)),
  'nightly visual regression should not duplicate the PR critical suite');
for (const lane of ['device', 'manual']) {
  assert.deepStrictEqual(criticalSpecs.filter(function (spec) { return specsForLane(lane).includes(spec); }), [],
    `${lane} E2E specs must stay out of the critical browser command`);
  assert.deepStrictEqual(nightlySpecs.filter(function (spec) { return specsForLane(lane).includes(spec); }), [],
    `${lane} E2E specs must stay out of the nightly browser command`);
}

assert.match(quality, /pull_request:/);
assert.match(quality, /npm run test:e2e:critical:run/);
assert(!/npm run test:e2e\s*$/.test(quality), 'PR workflow must not run the full E2E suite');
assert.doesNotMatch(quality, /windows-latest/, 'Windows desktop gates live in windows-native.yml');
assert.doesNotMatch(quality, /npm run test:live2d-native/);
assert.doesNotMatch(quality, /npm run test:live\b|regress-anima|ComfyUI/i);

assert.match(nightly, /schedule:/);
assert.match(nightly, /cron: '0 18 \* \* \*'/);
assert.match(nightly, /workflow_dispatch:/);
assert.match(nightly, /npm run test:e2e:nightly:run/);
assert.match(nightly, /Upload visual review screenshots/);

assert.match(native, /self-hosted, Windows, X64, live2d-cubism/);
assert.match(native, /LIVE2D_CUBISM_SDK_DIR/);
assert.match(native, /npm run build:tauri/);
assert.match(native, /npm run test:live2d-native:release/);
assert.match(native, /run-live2d-renderer-soak\.js --seconds 300 --switch-every 60/);
assert.doesNotMatch(native, /pull_request:/);

});

test('nightly screenshots are uploaded from the hidden review directory without silent loss', () => {
  const root = path.resolve(__dirname, '..', '..');
  const nightly = fs.readFileSync(path.join(root, '.github', 'workflows', 'nightly-e2e.yml'), 'utf8');
  const upload = nightly.split('      - name: Upload visual review screenshots\n')[1]?.split('\n      - name:')[0];
  assert.ok(upload, 'nightly must keep the dedicated screenshot upload step');
  assert.match(upload, /^\s+if:\s+always\(\)\s*$/m,
    'screenshots must remain available when another visual assertion fails');
  assert.match(upload, /^\s+path:\s+\.review-shots\/\*\.png\s*$/m,
    'hidden-file opt-in must be scoped to generated review PNGs');
  assert.match(upload, /^\s+include-hidden-files:\s+true\s*$/m,
    'upload-artifact otherwise excludes the hidden .review-shots directory');
  assert.match(upload, /^\s+if-no-files-found:\s+error\s*$/m,
    'missing screenshot evidence must fail instead of silently reporting success');
});
