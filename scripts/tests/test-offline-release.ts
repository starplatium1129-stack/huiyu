'use strict';

const test: typeof import('node:test')['test'] = require('node:test').test;
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { execFileSync }: typeof import('node:child_process') = require('node:child_process');
const { planRelease, applyRelease }: typeof import('../lib/offline-release') = require('../lib/offline-release');
const { digest }: typeof import('../lib/resource-install-fs') = require('../lib/resource-install-fs');

function fixture(t: import('node:test').TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-offline-release-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), showcaseRoot = path.join(base, 'published'), destination = path.join(base, 'output/release');
  const write = (file: string, value: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  write(path.join(root, 'package.json'), JSON.stringify({ version: '1.7.2' }));
  write(path.join(root, 'assets/characters/popular-test.png'), 'portrait');
  write(path.join(root, 'assets/characters/thumbs/popular-test.webp'), 'portrait-thumb');
  write(path.join(root, 'assets/live2d/fixture/model.moc3'), 'model');
  write(path.join(root, 'assets/live2d/fixture/model.model3.json'), '{}');
  write(path.join(root, 'assets/character-references/private.png'), 'private-reference');
  write(path.join(root, 'assets/live2d-candidates/private.png'), 'private-model');
  write(path.join(root, 'assets/theme-bootstrap.js'), 'executable');
  write(path.join(root, 'assets/theme-bootstrap.ts'), 'source');
  write(path.join(showcaseRoot, 'images/sc1000.jpg'), 'sample');
  write(path.join(showcaseRoot, 'thumbs/sc1000.jpg'), 'sample-thumb');
  write(path.join(showcaseRoot, 'images/sc999.jpg'), 'unreferenced-history');
  write(path.join(showcaseRoot, 'home/nene.jpg'), 'personal-upload');
  write(path.join(showcaseRoot, 'manifest.json'), JSON.stringify({ entries: [{ id: 'sc1000', title: 'test', rating: 'R18', type: 'scene', provenance: { batch: 'original' } }] }));
  return { base, root, showcaseRoot, destination, releaseId: 'fixture-r1', write };
}
test('planning is zero-write, preserves showcase bytes and excludes private/code/history files', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.showcaseRoot, 'manifest.json'));
  const plan = planRelease(f);
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(plan.summary.resourceFiles, 4); assert.equal(plan.summary.showcaseEntries, 1);
  assert.deepEqual(plan.summary.showcaseRatings, { R18: 1 });
  const paths = plan.inputs.map(input => input.path);
  assert.ok(paths.includes('showcase/images/sc1000.jpg'));
  assert.ok(paths.every(name => !/private|sc999|home\/|theme-bootstrap/.test(name)));
  assert.equal(plan.summary.expectedReleaseSha256, digest(plan.releaseBytes));
  assert.deepEqual(fs.readFileSync(path.join(f.showcaseRoot, 'manifest.json')), before);
  assert.deepEqual(plan.releaseBytes, planRelease(f).releaseBytes);
});
test('unsafe/missing/duplicate showcase metadata and overlapping output fail before publication', t => {
  const f = fixture(t);
  assert.throws(() => planRelease({ ...f, destination: f.showcaseRoot }), /separate/);
  assert.throws(() => planRelease({ ...f, releaseId: '../unsafe' }), /safe ASCII/);
  f.write(path.join(f.showcaseRoot, 'manifest.json'), JSON.stringify({ entries: [{ id: 'sc001', rating: 'All', image: '../private.jpg' }] }));
  assert.throws(() => planRelease(f), /Unsafe/);
  f.write(path.join(f.showcaseRoot, 'manifest.json'), JSON.stringify({ entries: [{ id: 'sc1000', rating: 'unknown' }] }));
  assert.throws(() => planRelease(f), /Invalid/);
  f.write(path.join(f.showcaseRoot, 'manifest.json'), JSON.stringify({ entries: [{ id: 'sc1000', rating: 'All' }, { id: 'SC1000', rating: 'All' }] }));
  assert.throws(() => planRelease(f), /duplicate/);
  fs.unlinkSync(path.join(f.showcaseRoot, 'thumbs/sc1000.jpg'));
  f.write(path.join(f.showcaseRoot, 'manifest.json'), JSON.stringify({ entries: [{ id: 'sc1000', rating: 'All' }] }));
  assert.throws(() => planRelease(f)); assert.equal(fs.existsSync(f.destination), false);
});
test('a source containing only excluded or executable assets cannot produce an unimportable pack', t => {
  const f = fixture(t);
  for (const rel of ['characters/popular-test.png', 'characters/thumbs/popular-test.webp', 'live2d/fixture/model.moc3', 'live2d/fixture/model.model3.json']) {
    fs.unlinkSync(path.join(f.root, 'assets', rel));
  }
  assert.throws(() => planRelease(f), /serviceable public resource/);
  assert.equal(fs.existsSync(f.destination), false);
});
test('export rechecks planned bytes and refuses changed sources or existing releases', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), plan = planRelease(f);
  const result = await applyRelease(plan);
  assert.equal(result.applied, true);
  for (const input of plan.inputs) assert.equal(digest(fs.readFileSync(path.join(f.destination, input.path))), input.entry.sha256);
  assert.equal(digest(fs.readFileSync(path.join(f.destination, 'release.json'))), plan.summary.expectedReleaseSha256);
  assert.throws(() => planRelease(f), /already exists/);
  await assert.rejects(applyRelease(plan), /already exists/);
  const next = planRelease({ ...f, destination: path.join(f.base, 'output/release2') });
  f.write(path.join(f.root, 'assets/characters/popular-test.png'), 'modified');
  await assert.rejects(applyRelease(next), /incomplete/);
  assert.equal(fs.existsSync(next.options.destination), false);
});
test('cancelled export leaves no usable release', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(applyRelease(planRelease(f), controller.signal), /incomplete/);
  assert.equal(fs.existsSync(f.destination), false);
});
test('Windows importer preview authenticates external release hash and rejects unlisted ZIP entries without writing', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), plan = planRelease(f); await applyRelease(plan);
  const repo = path.resolve(__dirname, '../..'), archive = path.join(f.base, 'release.zip');
  const install = path.join(f.base, 'installed'), runtime = path.join(f.base, 'userdata/gateway');
  f.write(path.join(install, 'gateway/huiyu-runtime.exe'), 'not-executed-in-preview');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'scripts/maintenance/archive-offline-release.ps1'), '-Source', f.destination, '-Archive', archive], { windowsHide: true });
  const args = ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'tools/install-offline-resources.ps1'), '-Archive', archive,
    '-ExpectedReleaseSha256', plan.summary.expectedReleaseSha256, '-InstallDir', install, '-RuntimeRoot', runtime];
  const run = (argv: string[]) => execFileSync('powershell.exe', argv, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
  const output = JSON.parse(run(args)); assert.equal(output.mode, 'preview'); assert.equal(output.files, plan.summary.files);
  assert.equal(fs.existsSync(runtime), false);
  const wrong = [...args]; wrong[wrong.indexOf('-ExpectedReleaseSha256') + 1] = '0'.repeat(64);
  assert.throws(() => run(wrong), /hash mismatch/);
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  run(['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::Open(${quote(archive)},'Update'); try { $entry=$zip.CreateEntry('unlisted.exe'); $stream=$entry.Open(); $stream.Dispose() } finally { $zip.Dispose() }`]);
  assert.throws(() => run(args), /inventory differs/);
  assert.equal(fs.existsSync(runtime), false);
});
test('attachment failure publishes no output and the same publisher command can be retried', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), repo = path.resolve(__dirname, '../..'), out = path.join(f.base, 'distribution');
  const args = [path.join(repo, 'scripts/maintenance/stage-offline-release.js'), '--root', f.root,
    '--showcase-root', f.showcaseRoot, '--release', f.releaseId, '--out', out, '--apply'];
  assert.throws(() => execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe', windowsHide: true }), /Incomplete distribution/);
  assert.equal(fs.existsSync(out), false);
  assert.ok(fs.readdirSync(f.base).some(name => name.startsWith('distribution.staging-')));
  f.write(path.join(f.root, 'tools/install-offline-resources.ps1'), fs.readFileSync(path.join(repo, 'tools/install-offline-resources.ps1')));
  const result = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe', windowsHide: true }));
  assert.equal(result.applied, true);
  for (const rel of [f.releaseId + '.zip', f.releaseId + '.zip.sha256', f.releaseId + '.release.sha256', 'Install-OfflineResources.ps1']) {
    assert.ok(fs.statSync(path.join(out, rel)).isFile());
  }
  assert.equal(result.destination, path.join(out, f.releaseId));
});
