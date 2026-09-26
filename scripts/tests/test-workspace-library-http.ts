import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import gatewayStack = require('./gateway-test-stack');
import { openWorkspace } from '../../server/workspace/client';
import { createWorkspaceGateway } from '../../server/workspace/gateway';
import { BASE_SCHEMA_SQL, openStorage } from '../../server/workspace/schema';
import { DatabaseSync } from 'node:sqlite';

test('desktop library HTTP saves temporary originals, deduplicates lost acknowledgements, edits and restores with project references', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-library-http-'));
  const service = await openWorkspace({ root, workspaceId: 'library-http', create: true });
  const origin = 'http://tauri.localhost';
  const binding = createWorkspaceGateway({ service, allowedOrigins: [origin] });
  const stack = await gatewayStack.start({ workspace: binding });
  t.after(async () => { await stack.close(); gatewayStack.removeFixtureRoot(root); });
  const session = binding.authority.issue({ principalId: 'fixture', origin, scopes: ['workspace:read', 'workspace:write'] });
  async function request(route: string, method = 'GET', body?: object) {
    const response = await fetch(stack.baseUrl + '/api/workspace' + route, { method,
      headers: { Origin: origin, 'x-aics-workspace-session': session.token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify({ ...body, protocolVersion: 1, workspaceId: service.workspaceId }) } : {}) });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload.result;
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64');
  const media = { alias: 'temporary-original', sha256: createHash('sha256').update(png).digest('hex'), mime: 'image/png', bytes: png.length };
  await request('/media-uploads/upload-1', 'POST', { media });
  await request('/media-uploads/upload-1/chunks', 'PUT', { offset: 0, data: png.toString('base64') });
  const original = await request('/media-uploads/upload-1/commit', 'POST', {});
  assert.deepEqual(await request('/media-uploads/upload-1/commit', 'POST', {}), original);
  assert.equal(await request('/media/count'), 1);
  assert.equal((await request('/artworks')).items.length, 0, 'temporary original does not add gallery artwork');
  const input = { operationId: 'artwork:42', artwork: { id: 42, image_id: media.alias, prompt: 'fixture', unknown: { original: true } } };
  const originalPath = path.join(root, 'media', 'objects', media.sha256.slice(0, 2), media.sha256);
  fs.renameSync(originalPath, originalPath + '.unavailable');
  try {
    const rejected = await fetch(stack.baseUrl + '/api/workspace/artworks', { method: 'POST',
      headers: { Origin: origin, 'x-aics-workspace-session': session.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, protocolVersion: 1, workspaceId: service.workspaceId }) });
    assert.equal(rejected.status, 409, 'a missing original must not produce a successful gallery save');
    assert.equal((await request('/artworks')).items.length, 0);
  } finally { fs.renameSync(originalPath + '.unavailable', originalPath); }
  const saved = await request('/artworks', 'POST', input);
  assert.deepEqual(await request('/artworks', 'POST', input), saved, 'lost acknowledgement retry returns same receipt');
  await request('/projects', 'POST', { operationId: 'project', project: { id: 'p', title: 'fixture' }, artworkIds: [42], expectedRevision: null });
  const deleted = await request('/artworks/42?idType=number', 'DELETE', { operationId: 'trash', expectedRevision: saved.artwork.revision });
  assert.equal((await request('/artworks')).items.length, 0);
  assert.deepEqual((await request('/projects')).items[0].body.history_ids, []);
  const restored = await request('/artworks/42/restore?idType=number', 'POST', { operationId: 'restore', expectedRevision: deleted.artwork.revision });
  assert.deepEqual((await request('/projects')).items[0].body.history_ids, [42]);
  assert.deepEqual(restored.artwork.body.unknown, { original: true });
  await request('/media/temporary-original', 'DELETE', { operationId: 'release' });
  assert.equal((await request('/artworks')).items[0].body.image_id, media.alias, 'release cannot destroy attached original');
  await request('/artworks/42/permanent?idType=number', 'DELETE', { operationId: 'delete', expectedRevision: restored.artwork.revision });
  assert.equal((await request('/artworks?includeDeleted=true')).items.length, 0);
  const setting = await request('/profile/settings', 'PUT', { operationId: 'theme', key: 'aics_theme', value: 'dark', expectedRevision: null });
  assert.equal(setting.value, 'dark');
  assert.equal((await request('/profile/settings')).records.find((item: { key: string }) => item.key === 'aics_theme').value, 'dark');
});

test('existing v1 workspace upgrades in place and recovers a committed schema with an old identity file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-schema-upgrade-'));
  try {
    const identity = { workspaceId: 'schema-fixture', databaseKind: 'huiyu-workspace', schemaVersion: 1 };
    fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify(identity));
    const db = new DatabaseSync(path.join(root, 'huiyu.sqlite3'));
    db.exec(BASE_SCHEMA_SQL);
    for (const [key, value] of Object.entries({ ...identity, revision: 7, writerEpoch: 'old' })) db.prepare('INSERT INTO meta VALUES(?,?)').run(key, String(value));
    db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(Date.now());
    db.prepare('INSERT INTO artworks VALUES(?,?,?,?,NULL)').run('legacy', '"legacy"', '{"id":"legacy","title":"preserved"}', 7);
    db.close();
    const options = { root, workspaceId: identity.workspaceId, writerEpoch: 'new', create: false };
    let storage = openStorage(options);
    assert.equal(storage.db.prepare('PRAGMA user_version').get()!.user_version, 3);
    assert.equal(storage.db.prepare('SELECT body FROM artworks').get()!.body, '{"id":"legacy","title":"preserved"}');
    storage.db.close();
    // SQLite COMMIT succeeded, process exited before workspace.json replacement.
    fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify(identity));
    fs.writeFileSync(path.join(root, 'schema-upgrade.json'), JSON.stringify({ workspaceId: identity.workspaceId, from: 1, to: 3 }));
    storage = openStorage(options);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8')).schemaVersion, 3);
    assert.equal(fs.existsSync(path.join(root, 'schema-upgrade.json')), false);
    assert.equal(storage.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version, 3);
    storage.db.close();
  } finally { gatewayStack.removeFixtureRoot(root); }
});
