'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const sharp: typeof import('sharp') = require('sharp');
const express: typeof import('express') = require('express');
const { createLive2dTextureService }: typeof import('../../services/live2d-textures') = require('../../services/live2d-textures');
const { createLive2dRouter }: typeof import('../../routes/live2d') = require('../../routes/live2d');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-live2d-textures-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'nene');
  fs.mkdirSync(dir);
  for (const file of ['model.moc3', 'physics.json', 'expression.json', 'motion.json', 'sound.wav']) fs.writeFileSync(path.join(dir, file), '{}');
  const model = { Version: 3, HitAreas: [{ Id: 'Head', Name: 'Head' }], Groups: [{ Name: 'EyeBlink', Ids: ['Eye'] }], FileReferences: {
    Moc: 'model.moc3', Physics: 'physics.json', Textures: ['atlas10.png', 'atlas2.png'],
    Expressions: [{ Name: 'school', File: 'expression.json' }],
    Motions: { Idle: [{ File: 'motion.json', Sound: 'sound.wav', FadeInTime: 0.5 }] },
  } };
  fs.writeFileSync(path.join(dir, 'nene.model3.json'), JSON.stringify(model));
  await sharp({ create: { width: 32, height: 16, channels: 4, background: { r: 120, g: 80, b: 30, alpha: 0.5 } } }).png().toFile(path.join(dir, 'atlas10.png'));
  await sharp({ create: { width: 16, height: 8, channels: 4, background: { r: 10, g: 90, b: 80, alpha: 1 } } }).png().toFile(path.join(dir, 'atlas2.png'));
  return { root, dir, model, service: createLive2dTextureService(root) };
}

test('derived manifests preserve atlas indices, author metadata, motions and source bytes', async t => {
  const h = await fixture(t);
  const original = fs.readFileSync(path.join(h.dir, 'nene.model3.json'));
  const model = h.service.manifest('nene', 'standard');
  assert.deepEqual(model.Groups, h.model.Groups);
  assert.deepEqual(model.HitAreas, h.model.HitAreas);
  assert.deepEqual(model.FileReferences.Textures, ['/api/live2d-texture/nene/standard/0.webp', '/api/live2d-texture/nene/standard/1.webp']);
  assert.equal(model.FileReferences.Motions.Idle[0].FadeInTime, 0.5);
  assert.equal(model.FileReferences.Motions.Idle[0].Sound, '/assets/live2d-current/nene/sound.wav');
  assert.equal(model.FileReferences.Expressions[0].File, '/assets/live2d-current/nene/expression.json');
  assert.deepEqual(fs.readFileSync(path.join(h.dir, 'nene.model3.json')), original);
});

test('profiles resize both dimensions, retain alpha, coalesce work and preserve originals', async t => {
  const h = await fixture(t);
  const original = fs.readFileSync(path.join(h.dir, 'atlas10.png'));
  const [a, b] = await Promise.all([h.service.texture('nene', 'standard', 0), h.service.texture('nene', 'standard', 0)]);
  assert.equal(a, b);
  assert.equal(await h.service.texture('nene', 'standard', 0), a);
  const meta = await sharp(a.bytes).metadata();
  assert.deepEqual([meta.width, meta.height, meta.hasAlpha], [16, 8, true]);
  const pixels = await sharp(a.bytes).raw().toBuffer();
  assert.ok(pixels[3] >= 126 && pixels[3] <= 129);
  const compact = await sharp((await h.service.texture('nene', 'compact', 1)).bytes).metadata();
  assert.deepEqual([compact.width, compact.height], [4, 2]);
  assert.deepEqual(fs.readFileSync(path.join(h.dir, 'atlas10.png')), original);
});

test('cache invalidates after an asset update and a failed conversion can be retried', async t => {
  const h = await fixture(t);
  const before = await h.service.texture('nene', 'standard', 0);
  fs.writeFileSync(path.join(h.dir, 'atlas10.png'), 'invalid image');
  await assert.rejects(h.service.texture('nene', 'standard', 0));
  await sharp({ create: { width: 64, height: 32, channels: 4, background: 'blue' } }).png().toFile(path.join(h.dir, 'atlas10.png'));
  const after = await h.service.texture('nene', 'standard', 0);
  assert.notEqual(after.etag, before.etag);
  assert.equal((await sharp(after.bytes).metadata()).width, 32);
});

test('rejects unsupported profiles, characters, indices and escaping references', async t => {
  const h = await fixture(t);
  for (const quality of ['constructor', '__proto__', 'original', 'unknown']) {
    assert.throws(() => h.service.manifest('nene', quality));
    await assert.rejects(h.service.texture('nene', quality, 0));
  }
  for (const index of [-1, 0.5, 64, 2, NaN]) await assert.rejects(h.service.texture('nene', 'standard', index));
  assert.throws(() => h.service.manifest('../nene', 'standard'));
  fs.writeFileSync(path.join(h.root, 'outside.png'), 'outside');
  h.model.FileReferences.Textures[0] = '../outside.png';
  fs.writeFileSync(path.join(h.dir, 'nene.model3.json'), JSON.stringify(h.model));
  assert.throws(() => h.service.manifest('nene', 'standard'));
  await assert.rejects(h.service.texture('nene', 'standard', 0));
});

test('quality routes deliver actual WebP, honor conditional requests and return safe 404s', async t => {
  const h = await fixture(t);
  const app = express();
  app.use(createLive2dRouter({ LIVE2D_ROOT: h.root }).router);
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const model = await (await fetch(base + '/api/live2d-model/nene/compact')).json();
  const response = await fetch(base + model.FileReferences.Textures[0]);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /image\/webp/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal((await sharp(bytes).metadata()).width, 8);
  assert.equal((await fetch(base + model.FileReferences.Textures[0], { headers: { 'If-None-Match': response.headers.get('etag') } })).status, 304);
  for (const url of ['/api/live2d-model/nene/constructor', '/api/live2d-texture/nene/compact/99.webp', '/api/live2d-texture/nene/compact/0.png']) {
    const rejected = await fetch(base + url);
    assert.equal(rejected.status, 404);
    assert.ok(!(await rejected.text()).includes(h.root));
  }
});
