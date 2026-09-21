import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import stackFactory from './gateway-test-stack';

test('remote release: same authorization before static, compression, HEAD, Range and cache', async () => {
  let index = '';
  let source = '';
  let release: { version: number; resources: Array<Record<string, unknown>> };
  const stack = await stackFactory.start({
    prepare({ root, config }: any) {
      const app = path.join(root, 'app');
      config.ROOT_DIR = app;
      config.ASSETS_ROOT = path.join(app, 'assets');
      config.SCENE_SHOWCASE_DIR = path.join(app, 'showcase');
      config.CHARACTER_REF_ROOT = '';
      config.CHARACTER_REF_EXPLICIT_ROOT = '';
      fs.mkdirSync(path.join(app, 'data'), { recursive: true });
      fs.mkdirSync(config.ASSETS_ROOT, { recursive: true });
      fs.mkdirSync(path.join(config.SCENE_SHOWCASE_DIR, 'thumbs'), { recursive: true });
      source = path.join(app, 'data/scenes.json');
      const data = Buffer.from(JSON.stringify([
        { id: 'sc001', title: 'Public directory', rating: 'All', prompt: 'private recipe', negative: 'private negative', image: '/secret.png' },
        { id: 'sc002', title: 'Restricted fixture', rating: 'R18', mature: true },
        { id: 'sc003', title: 'Unknown fixture' },
      ]));
      fs.writeFileSync(source, data);
      fs.writeFileSync(source + '.br', brotliCompressSync(data));
      fs.writeFileSync(source + '.gz', gzipSync(data));
      const picture = Buffer.from('neutral picture fixture');
      fs.writeFileSync(path.join(config.SCENE_SHOWCASE_DIR, 'thumbs/sc001.png'), picture);
      fs.writeFileSync(path.join(config.ASSETS_ROOT, 'unpublished.png'), picture);
      fs.mkdirSync(path.join(config.ASSETS_ROOT, 'live2d-candidates'));
      fs.writeFileSync(path.join(config.ASSETS_ROOT, 'live2d-candidates/private.png'), picture);
      const outside = path.join(root, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'picture.png'), picture);
      fs.symlinkSync(outside, path.join(config.ASSETS_ROOT, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      const entry = (url: string, bytes: Buffer) => ({ url, rating: 'All', bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), reviewedAt: '2026-09-21T00:00:00Z' });
      release = { version: 1, resources: [entry('/data/scenes.json', data), entry('/scene-showcase/thumbs/sc001.png', picture),
        entry('/assets/live2d-candidates/private.png', picture), entry('/assets/linked/picture.png', picture)] };
      index = path.join(config.RUNTIME_ROOT, 'state/remote-content-release.json');
      fs.mkdirSync(path.dirname(index), { recursive: true });
    },
  });
  const remote = { 'x-token': stack.config.TOKEN, 'x-forwarded-for': '198.51.100.8' };
  try {
    const fetchPath = (url: string, headers = remote, method = 'GET') => fetch(stack.baseUrl + url, { headers, method });
    assert.equal((await fetchPath('/data/scenes.json')).status, 403, 'missing review denies');
    assert.equal((await fetchPath('/data/scenes.json', { 'x-forwarded-for': '198.51.100.8' } as any)).status, 403);
    fs.writeFileSync(index, JSON.stringify(release!));
    for (const encoding of ['identity', 'br', 'gzip']) {
      const response = await fetchPath('/data/scenes.json', { ...remote, 'accept-encoding': encoding } as any);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control')!, /private, no-store/);
      assert.deepEqual(await response.json(), [{ id: 'sc001', rating: 'All', title: 'Public directory' }]);
      assert.equal((await fetchPath('/data/scenes.json', { ...remote, 'accept-encoding': encoding } as any, 'HEAD')).status, 200);
    }
    const local = await fetchPath('/data/scenes.json', {} as any);
    assert.match(local.headers.get('cache-control')!, /private/);
    assert.match(await local.text(), /private recipe/);
    for (const url of ['/data/scenes.json.br', '/DATA/scenes.json', '/data%2fscenes.json',
      '/data/scenes.json.gz', '/assets/unpublished.png', '/assets%5cunpublished.png',
      '/character-references/fixture.png', '/scene-showcase/images/sc001.png',
      '/assets/live2d-candidates/private.png', '/assets/linked/picture.png']) {
      for (const method of ['GET', 'HEAD']) assert.equal((await fetchPath(url, { ...remote,
        range: 'bytes=0-2', 'if-none-match': local.headers.get('etag') || '' } as any, method)).status, 403, url);
    }
    for (const rawPath of ['/data/./scenes.json', '/data/x/../scenes.json', '//data/scenes.json',
      '/data/%2e/scenes.json', '/data%5cscenes.json']) {
      const address = new URL(stack.baseUrl);
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = http.get({ hostname: address.hostname, port: address.port, path: rawPath, headers: remote }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
      });
      assert.equal(status, 403, rawPath);
    }
    const media = await fetchPath('/scene-showcase/thumbs/sc001.png', { ...remote, range: 'bytes=0-2' } as any);
    assert.equal(media.status, 200, 'approved bytes can ignore Range safely');
    assert.equal(await media.text(), 'neutral picture fixture');
    release!.resources.push({ ...release!.resources[0] });
    fs.writeFileSync(index, JSON.stringify(release!));
    assert.equal((await fetchPath('/data/scenes.json')).status, 403, 'ambiguous release entries deny');
    release!.resources.pop();
    release!.resources[1].rating = 'R18';
    fs.writeFileSync(index, JSON.stringify(release!));
    assert.equal((await fetchPath('/scene-showcase/thumbs/sc001.png')).status, 403);
    fs.appendFileSync(source, ' ');
    assert.equal((await fetchPath('/data/scenes.json')).status, 403, 'source mutation invalidates approval');
    fs.rmSync(index);
    assert.equal((await fetchPath('/data/scenes.json')).status, 403, 'revocation has no stale cache');
  } finally { await stack.close(); }
});

test('desktop health proves the launched instance without sending or echoing its credential', async () => {
  const secret = randomBytes(32).toString('hex');
  const challenge = randomBytes(32).toString('hex');
  const stack = await stackFactory.start({ env: { AICS_DESKTOP_GATEWAY_TOKEN: secret } });
  try {
    const response = await fetch(stack.baseUrl + '/api/health', { headers: { 'x-aics-desktop-challenge': challenge } });
    const body = await response.json();
    assert.equal(body.desktopProof, createHmac('sha256', secret).update(challenge).digest('hex'));
    assert.ok(!JSON.stringify(body).includes(secret));
    for (const headers of [{}, { 'x-aics-desktop-challenge': 'invalid' },
      { 'x-aics-desktop-challenge': challenge, 'x-forwarded-for': '198.51.100.8', 'x-token': stack.config.TOKEN }]) {
      const value = await (await fetch(stack.baseUrl + '/api/health', { headers: headers as Record<string, string> })).json();
      assert.equal(value.desktopProof, undefined);
    }
    const next = randomBytes(32).toString('hex');
    const value = await (await fetch(stack.baseUrl + '/api/health', { headers: { 'x-aics-desktop-challenge': next } })).json();
    assert.notEqual(value.desktopProof, body.desktopProof, 'a captured response cannot prove another challenge');
  } finally { await stack.close(); }
});
