import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import express = require('express');
import { createDesktopWorkspaceHost } from '../../server/workspace/host';
import { desktopHostMessage } from '../../server/workspace/host-auth';
import { classifyWorkspaceRollback } from '../../server/workspace/activation';
import { fingerprint } from '../../server/workspace/records';
import type { MigrationEnvelope, MigrationRecord } from '../../types/migration';

test('signed shutdown fences new HTTP work and drains already-admitted profile writes before releasing the owner', async () => {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-host-drain-'));
  const secret = randomBytes(32).toString('hex'), sourceProfileId = `profile-${randomBytes(32).toString('hex')}`;
  const app = express(), server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  let admit!: () => void, releaseWrite!: () => void, closing!: () => void, releaseProvider!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const closeStarted = new Promise<void>(resolve => { closing = resolve; });
  const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
  const host = await createDesktopWorkspaceHost({ configRoot, secret, gatewayOrigin: origin, sourceProfileId,
    beforeClose: () => { closing(); return providerGate; } });
  await host.prepareCandidate(); const service = host.service!;
  const owner = { workspaceId: service.workspaceId, principalId: `desktop:${sourceProfileId}`, protocolVersion: 1 as const };
  const ownerFile = path.join(configRoot, 'workspaces', service.workspaceId, '.workspace-owner.json');
  app.use(host.router);
  app.post('/fixture/write', async (_req, res, next) => {
    try { admit(); await writeGate; await service.request({ kind:'profile.saveSetting', operationId:randomUUID(), key:'aics_theme', value:'light', expectedRevision:null }, owner); res.json({ saved:true }); }
    catch (error) { next(error); }
  });
  let reopened: Awaited<ReturnType<typeof createDesktopWorkspaceHost>> | undefined;
  try {
    const saving = fetch(`${origin}/fixture/write`, { method:'POST' }); await admitted;
    const body = JSON.stringify({ action:'shutdown', windowId:'atelier', origin, sourceProfileId, timestamp:Date.now(), nonce:randomBytes(32).toString('hex') });
    let drained = false;
    const shutdown = fetch(`${origin}/api/desktop-host`, { method:'POST', body,
      headers:{ 'content-type':'application/json', 'x-aics-host-proof':createHmac('sha256', secret).update(desktopHostMessage(body)).digest('hex') } }).then(response => { drained = true; return response; });
    await closeStarted;
    assert.equal((await fetch(`${origin}/fixture/write`, { method:'POST' })).status, 503);
    releaseProvider(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false); assert.equal(fs.existsSync(ownerFile), true);
    releaseWrite(); assert.equal((await saving).status, 200);
    assert.equal((await shutdown).status, 200); assert.equal(fs.existsSync(ownerFile), false);
    reopened = await createDesktopWorkspaceHost({ configRoot, secret, gatewayOrigin:origin, sourceProfileId });
    const settings = await reopened.service!.request({ kind:'profile.readSettings' }, owner);
    assert.ok(JSON.stringify(settings).includes('light'), 'admitted setting survives the upgrade handoff');
  } finally {
    releaseWrite(); releaseProvider(); await host.close(); await reopened?.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(configRoot, { recursive:true, force:true });
  }
});

test('failed drain remains closed to admission and does not release the private owner', async () => {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-host-drain-failed-'));
  const host = await createDesktopWorkspaceHost({ configRoot, secret:randomBytes(32).toString('hex'), gatewayOrigin:'http://127.0.0.1:12345',
    sourceProfileId:`profile-${randomBytes(32).toString('hex')}`, beforeClose:async () => { throw Error('fixture drain failure'); } });
  await host.prepareCandidate(); const service = host.service!;
  try {
    await assert.rejects(host.close(), /fixture drain failure/);
    assert.equal(host.closing, true);
    assert.equal(fs.existsSync(path.join(configRoot, 'workspaces', service.workspaceId, '.workspace-owner.json')), true);
    await assert.rejects(host.prepareCandidate(), /draining/);
  } finally { await service.close(); fs.rmSync(configRoot, { recursive:true, force:true }); }
});

test('desktop authority imports, verifies backup, activates and reopens the same private library on a different port', async () => {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-desktop-host-'));
  const sourceProfileId = `profile-${randomBytes(32).toString('hex')}`;
  const nativeOrigin = 'http://tauri.localhost';
  const secret = randomBytes(32).toString('hex');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/b1sAAAAASUVORK5CYII=', 'base64');
  async function start() {
    const app = express();
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const host = await createDesktopWorkspaceHost({ configRoot, secret, gatewayOrigin: origin, sourceProfileId });
    app.use(host.router);
    async function signed(action: string, extra: Record<string, unknown> = {}) {
      const body = JSON.stringify({ action, windowId: 'atelier', origin: nativeOrigin, sourceProfileId,
        timestamp: Date.now(), nonce: randomBytes(32).toString('hex'), ...extra });
      const proof = createHmac('sha256', secret).update(desktopHostMessage(body)).digest('hex');
      const response = await fetch(`${origin}/api/desktop-host`, { method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-aics-host-proof': proof } });
      assert.equal(response.status, 200, await response.clone().text());
      return await response.json() as { workspace: { workspaceId: string; runtimeEpoch: string; token: string; domains: string[] } | null };
    }
    return { origin, host, signed, async close() { await host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
  }
  let current = await start();
  try {
    assert.equal((await current.signed('session')).workspace, null);
    assert.equal(classifyWorkspaceRollback(null, 0), 'before-activation');
    const initial = (await current.signed('prepare-candidate')).workspace!;
    assert.deepEqual(initial.domains, []);
    assert.equal(fs.existsSync(path.join(configRoot, 'workspace-active.json')), false);
    const service = current.host.service!;
    const owner = { workspaceId: service.workspaceId, principalId: `desktop:${sourceProfileId}`, protocolVersion: 1 as const };
    const migrationId = randomUUID();
    const record: MigrationRecord = { source: 'kv', key: 'aics_pb_history', index: 0, domain: 'artwork',
      value: { id: 7, image_id: 'original-7', title: 'preserved artwork', unknownLegacyField: ['retained'] } };
    const unsigned: Omit<MigrationEnvelope, 'fingerprint'> = { format: 'huiyu-migration', version: 1, migrationId,
      source: { sourceProfileId, origin: current.origin, windowIds: ['atelier'] }, createdAt: Date.now(),
      records: [{ id: 'artwork-7', sha256: fingerprint(record), source: 'kv', key: record.key, index: 0, domain: 'artwork' }],
      media: [{ alias: 'original-7', sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length,
        mime: 'image/png', metadata: {}, derived: false }], blockers: [], credentials: { references: [], verified: true } };
    await service.request({ kind: 'migration.begin', operationId: randomUUID(), envelope: { ...unsigned, fingerprint: fingerprint(unsigned) } }, owner);
    await service.request({ kind: 'migration.record', operationId: randomUUID(), migrationId, itemId: 'artwork-7', record }, owner);
    await service.request({ kind: 'migration.media', operationId: randomUUID(), migrationId, alias: 'original-7', offset: 0, data: png }, owner);
    const verified = await service.request({ kind: 'migration.verify', operationId: randomUUID(), migrationId }, owner);
    assert.deepEqual(verified.blockers, []);
    const active = (await current.signed('activate', { migrationId, bundledUi: true })).workspace!;
    assert.deepEqual(active.domains, ['artwork', 'settings', 'chat', 'draft']);
    const pointer = current.host.pointer!;
    assert.equal(classifyWorkspaceRollback(pointer, pointer.activatedRevision), 'activated-without-writes');
    const unauthorized = await fetch(`${current.origin}/api/workspace/artworks`, { headers: { origin: nativeOrigin, authorization: 'Bearer shared-gateway-token' } });
    assert.equal(unauthorized.status, 401);
    const media = await fetch(`${current.origin}/api/workspace/media-capabilities`, { method: 'POST',
      headers: { origin: nativeOrigin, 'content-type': 'application/json', 'x-aics-workspace-session': active.token }, body: JSON.stringify({ alias: 'original-7' }) });
    assert.equal(media.status, 200);
    const capability = await media.json() as { url: string };
    const ranged = await fetch(current.origin + capability.url, { headers: { origin: nativeOrigin, range: 'bytes=2-9' } });
    assert.equal(ranged.status, 206);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), png.subarray(2, 10));
    const head = await fetch(current.origin + capability.url, { method: 'HEAD', headers: { origin: nativeOrigin } });
    assert.equal(head.headers.get('content-length'), String(png.length));
    const invalidRange = await fetch(current.origin + capability.url, { headers: { origin: nativeOrigin, range: 'bytes=99999-' } });
    assert.equal(invalidRange.status, 416);
    const workspaceId = active.workspaceId, oldEpoch = active.runtimeEpoch, oldOrigin = current.origin;
    await current.close(); current = await start();
    const reopened = (await current.signed('session')).workspace!;
    assert.equal(reopened.workspaceId, workspaceId); assert.notEqual(reopened.runtimeEpoch, oldEpoch);
    assert.notEqual(current.origin, oldOrigin);
    const result = await current.host.service!.request({ kind: 'getArtwork', id: 7 }, owner);
    assert.deepEqual(result?.body.unknownLegacyField, ['retained']);
    await current.host.service!.request({ kind: 'patchArtwork', operationId: randomUUID(), id: 7,
      expectedRevision: result!.revision, patch: { title: 'new write' } }, owner);
    const status = await current.host.service!.request({ kind: 'status' }, owner);
    assert.equal(classifyWorkspaceRollback(current.host.pointer, status.revision), 'restore-required');
  } finally { await current.close(); fs.rmSync(configRoot, { recursive: true, force: true }); }
});
