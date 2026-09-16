'use strict';

const test: typeof import('node:test')['test'] = require('node:test').test;
const { randomBytes }: typeof import('node:crypto') = require('node:crypto');
const sharp: typeof import('sharp').default = require('sharp');
const { fs, path, write, snapshot, fixture }: typeof import('./resource-install-fixtures') = require('./resource-install-fixtures');
const assert: typeof import('./resource-install-fixtures')['assert'] = require('./resource-install-fixtures').assert;
const { applyResourceProfile }: typeof import('../lib/resource-install-packaging') = require('../lib/resource-install-packaging');

async function packagingFixture(t: any) {
  const f = fixture(t);
  const image = await sharp(randomBytes(1400 * 1800 * 3), { raw: { width: 1400, height: 1800, channels: 3 } }).png().toBuffer();
  write(path.join(f.source, 'assets/characters/popular-fixture.png'), image);
  write(path.join(f.source, 'assets/characters/thumbs/popular-fixture.webp'), await sharp(image).resize(128).webp().toBuffer());
  write(path.join(f.source, 'assets/brand/logo.svg'), '<svg></svg>');
  write(path.join(f.source, 'assets/placeholder.png'), await sharp(image).resize(32).png().toBuffer());
  write(path.join(f.source, 'assets/live2d/fixture/model.moc3'), 'complete-model');
  const gatewayRoot = path.join(f.base, 'stage/gateway');
  fs.cpSync(path.join(f.source, 'assets'), path.join(gatewayRoot, 'assets'), { recursive: true });
  return { ...f, gatewayRoot, image };
}
test('base profile retains every original URL plus unchanged thumbnails/brand/placeholders/Live2D, never mutates sources', async t => {
  const f = await packagingFixture(t);
  const before = snapshot(f.source);
  const report = await applyResourceProfile({ root: f.source, gatewayRoot: f.gatewayRoot, profile: 'base' });
  assert.equal(report.firstRequiredDownloadBytes, 0);
  assert.equal(report.optional.length, 1);
  assert.ok(report.bundledBytes < report.fullResourceBytes);
  const meta = await sharp(path.join(f.gatewayRoot, 'assets/characters/popular-fixture.png')).metadata();
  assert.equal(meta.format, 'png'); assert.ok(meta.width <= 768 && meta.height <= 1024);
  for (const rel of ['characters/thumbs/popular-fixture.webp', 'brand/logo.svg', 'placeholder.png', 'live2d/fixture/model.moc3']) {
    assert.deepEqual(fs.readFileSync(path.join(f.gatewayRoot, 'assets', rel)), fs.readFileSync(path.join(f.source, 'assets', rel)));
  }
  assert.deepEqual(snapshot(f.source), before);
});
test('full profile leaves assets byte-identical and rejects unsafe output roots/profile names', async t => {
  const f = await packagingFixture(t);
  const original = fs.readFileSync(path.join(f.gatewayRoot, 'assets/characters/popular-fixture.png'));
  const report = await applyResourceProfile({ root: f.source, gatewayRoot: f.gatewayRoot });
  assert.equal(report.profile, 'full'); assert.equal(report.optional.length, 0);
  assert.equal(report.fullResourceBytes, report.bundledBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.gatewayRoot, 'assets/characters/popular-fixture.png')), original);
  await assert.rejects(applyResourceProfile({ root: f.source, gatewayRoot: f.source, profile: 'base' }), /overlap/);
  await assert.rejects(applyResourceProfile({ root: f.source, gatewayRoot: f.gatewayRoot, profile: 'unknown' }), /profile/);
});
test('base profile refuses missing thumbnails and damaged images instead of deleting offline content', async t => {
  const f = await packagingFixture(t);
  fs.unlinkSync(path.join(f.gatewayRoot, 'assets/characters/thumbs/popular-fixture.webp'));
  await assert.rejects(applyResourceProfile({ root: f.source, gatewayRoot: f.gatewayRoot, profile: 'base' }));
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'assets/characters/popular-fixture.png')), f.image);
  assert.deepEqual(fs.readFileSync(path.join(f.gatewayRoot, 'assets/characters/popular-fixture.png')), f.image);
});
