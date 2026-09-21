import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import referenceResources from '../../routes/resources-reference';

test('reference profile API returns one character, reloads changed data and denies remote requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-profile-'));
  fs.mkdirSync(path.join(root, 'data'));
  const file = path.join(root, 'data/character-reference-view.json');
  const write = (name: string) => fs.writeFileSync(file, JSON.stringify({ one: { characterId: 'one', displayName: name, outfits: [] }, two: { characterId: 'two' } }));
  write('initial');
  const app = express();
  const config = { ROOT_DIR: root, PORT: 0 };
  app.use(referenceResources.createReferenceResources(config));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  config.PORT = address.port;
  const url = `http://127.0.0.1:${address.port}/api/character-reference-profile/`;
  try {
    const response = await fetch(url + 'one');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { characterId: 'one', displayName: 'initial', outfits: [] });
    write('updated longer');
    assert.equal((await (await fetch(url + 'one')).json()).displayName, 'updated longer');
    assert.equal((await fetch(url + 'missing')).status, 404);
    assert.equal((await fetch(url + 'bad%20id')).status, 400);
    assert.equal((await fetch(url + 'one', { headers: { 'x-forwarded-for': '198.51.100.1' } })).status, 403);
    assert.equal((await fetch(url + 'one', { headers: { origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(url + 'one', { method: 'POST' })).status, 405);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
