'use strict';

const { test } = require('node:test');
const { gzipSync } = require('node:zlib');
const { fs, path, assert, write, snapshot } = require('./resource-install-fixtures');
const { resourceFixture, request } = require('./resource-gateway-fixture');
const { scanImages, resolveReferenceRelease } = require('../lib/reference-candidate-publish');
const { digest } = require('../lib/resource-install-fs');
const { jsonHash } = require('../lib/reference-candidate-review');
const { referenceView } = require('./reference-view-fixture');

function version(f) {
  const root = path.join(f.base, 'reference-version');
  write(path.join(root, 'fixture/approved.png'), 'approved reference fixture');
  const view = referenceView({ firstUrl: '/character-references/fixture/approved.png' });
  const viewBytes = Buffer.from(JSON.stringify(view));
  write(path.join(root, 'character-reference-view.json'), viewBytes);
  const release = { schemaVersion: 1, kind: 'reference-release', files: scanImages(root),
    viewSha256: digest(viewBytes), sourceStandardsSha256: digest(fs.readFileSync(path.join(f.program, 'data/character-reference-standards.json'))),
    sourceViewSha256: digest(fs.readFileSync(path.join(f.program, 'data/character-reference-view.json'))),
    candidateManifestSha256: 'a'.repeat(64), reviewSha256: 'b'.repeat(64), baseIdentity: 'c'.repeat(64) };
  release.identity = jsonHash({ files: release.files, viewSha256: release.viewSha256, sourceStandardsSha256: release.sourceStandardsSha256,
    sourceViewSha256: release.sourceViewSha256, candidateManifestSha256: release.candidateManifestSha256, reviewSha256: release.reviewSha256, baseIdentity: release.baseIdentity });
  write(path.join(root, 'reference-release.json'), JSON.stringify(release));
  assert.ok(resolveReferenceRelease(root, { dataRoot: f.program }));
  return { root, view };
}

test('approved reference images and projection route together ahead of stale precompressed source index', async t => {
  const f = resourceFixture(t);
  const v = version(f);
  const original = snapshot(f.program);
  write(path.join(f.program, 'data/character-reference-view.json.gz'), gzipSync('{"wrong":"old-gzip"}'));
  const stack = await f.stack({ CHARACTER_REF_ROOT: v.root });
  const index = await request(stack, '/data/character-reference-view.json', undefined, { 'accept-encoding': 'gzip' });
  assert.deepEqual(index.data, v.view);
  assert.equal(index.headers['cache-control'], 'private, no-cache');
  const image = await request(stack, '/character-references/fixture/approved.png');
  assert.equal(image.text, 'approved reference fixture');
  const cached = await request(stack, '/data/character-reference-view.json', undefined, { 'if-none-match': index.headers.etag });
  assert.equal(cached.status, 304);
  assert.equal((await request(stack, '/character-references/reference-release.json')).status, 404);
  assert.equal((await request(stack, '/character-references/character-reference-view.json')).status, 404);
  assert.deepEqual(snapshot(f.program).filter(([name]) => !name.endsWith('.gz')), original);
});

for (const corruption of ['image', 'index', 'source', 'marker']) test('bad reference ' + corruption + ' blocks both routes without pairing old index/new images', async t => {
  const f = resourceFixture(t);
  const v = version(f);
  const file = { image: path.join(v.root, 'fixture/approved.png'), index: path.join(v.root, 'character-reference-view.json'),
    source: path.join(f.program, 'data/character-reference-standards.json'), marker: path.join(v.root, 'reference-release.json') }[corruption];
  write(file, '{"changed":true}');
  const stack = await f.stack({ CHARACTER_REF_ROOT: v.root });
  for (const url of ['/data/character-reference-view.json', '/character-references/fixture/approved.png']) {
    const response = await request(stack, url);
    assert.equal(response.status, 503); assert.equal(response.data.code, 'REFERENCE_RELEASE_INVALID');
    assert.equal(response.text.includes(f.base), false);
  }
});

test('reference corruption after startup disables index and images together', async t => {
  const f = resourceFixture(t);
  const v = version(f);
  const stack = await f.stack({ CHARACTER_REF_ROOT: v.root });
  write(path.join(v.root, 'fixture/approved.png'), 'bad');
  assert.equal((await request(stack, '/character-references/fixture/approved.png')).status, 503);
  assert.equal((await request(stack, '/data/character-reference-view.json')).status, 503);
});

test('versioned references reject remote/forwarded access even with gateway token', async t => {
  const f = resourceFixture(t); const v = version(f);
  const stack = await f.stack({ CHARACTER_REF_ROOT: v.root });
  const remote = { 'x-forwarded-for': '203.0.113.9', 'x-token': stack.config.TOKEN };
  for (const url of ['/data/character-reference-view.json', '/character-references/fixture/approved.png']) {
    assert.equal((await request(stack, url, undefined, remote)).status, 403);
  }
});

test('unversioned libraries keep existing handling; explicit missing root cannot serve a project index as a new release', async t => {
  const f = resourceFixture(t);
  const root = path.join(f.base, 'legacy'); write(path.join(root, 'fixture/old.png'), 'old reference');
  const legacy = await f.stack({ CHARACTER_REF_ROOT: root });
  assert.equal((await request(legacy, '/character-references/fixture/old.png')).text, 'old reference');
  assert.deepEqual((await request(legacy, '/data/character-reference-view.json')).data, { legacy: 'project-index' });
  const missing = await f.stack({ CHARACTER_REF_ROOT: '', CHARACTER_REF_EXPLICIT_ROOT: path.join(f.base, 'missing') });
  assert.equal((await request(missing, '/data/character-reference-view.json')).status, 503);
});
