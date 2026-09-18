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

const critical = pkg.scripts['test:e2e:critical:run'];
const nightlyRun = pkg.scripts['test:e2e:nightly:run'];
const specNames = function (command: string) {
  return [...command.matchAll(/tests\/e2e\/([^\s]+\.spec\.ts)/g)].map(function (match) { return match[1]; }).sort();
};

assert.strictEqual(pkg.scripts['test:e2e'], 'npm run build && npm run test:e2e:all');
assert.match(pkg.scripts['test:e2e:all'], /^playwright test$/);
assert.match(pkg.scripts['test:e2e:critical'], /npm run build && npm run test:e2e:critical:run/);
assert.match(pkg.scripts['test:e2e:nightly'], /npm run build && npm run test:e2e:nightly:run/);

for (const spec of ['studio.spec.ts', 'flows.spec.ts', 'a11y-device.spec.ts', 'anima-quick.spec.ts', 'interaction-polish.spec.ts']) {
  assert(critical.includes(spec), `critical browser regression must include ${spec}`);
}
// 2026-09-05：critical/nightly 均扩至 5 spec（nightly 接入 CI 时 package.json 扩了
// 列表但本守护仍断言 3/2，导致 npm run check 必红）。守护语义改为：
// ① 每侧必须包含全部已知 spec（新增 spec 未登记会红，提示同步 workflow）
// ② 两侧互不重叠（重复收录会稀释 PR 回归与 nightly 矩阵）。
const criticalSpecs = specNames(critical);
assert(!/capture\.spec\.ts|theme-audit\.spec\.ts/.test(critical),
  'visual audit specs must not make PR browser regression slower');

for (const spec of ['theme-audit.spec.ts', 'capture.spec.ts', 'particle-atmosphere.spec.ts', 'particle-narrative.spec.ts', 'archive-visual-language.spec.ts']) {
  assert(nightlyRun.includes(spec), `nightly visual regression must include ${spec}`);
}
const nightlySpecs = specNames(nightlyRun);
const overlap = criticalSpecs.filter(function (spec) { return nightlySpecs.includes(spec); });
assert.deepStrictEqual(overlap, [], 'critical 与 nightly 分组不得重叠');
assert(!/studio\.spec\.ts|flows\.spec\.ts|a11y-device\.spec\.ts/.test(nightlyRun),
  'nightly visual regression should not duplicate the PR critical suite');

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
