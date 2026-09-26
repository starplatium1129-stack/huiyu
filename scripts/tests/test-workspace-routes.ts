import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import gatewayStack = require('./gateway-test-stack');
import { openWorkspace } from '../../server/workspace/client';
import { createWorkspaceGateway } from '../../server/workspace/gateway';
import { WORKSPACE_SESSION_HEADER } from '../../server/workspace/auth';
import type { WorkspaceResults } from '../../server/workspace/types';

const origin = 'http://127.0.0.1:32123';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64');

test('workspace API stays disabled without an explicit host binding', async () => {
  const stack = await gatewayStack.start();
  try {
    const response = await fetch(stack.baseUrl + '/api/workspace/status', {
      headers: { Origin: origin, 'x-token': stack.config.TOKEN },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'WORKSPACE_DISABLED');
  } finally { await stack.close(); }
});

test('real gateway and storage worker enforce private sessions and preserve save/revision receipts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-workspace-http-'));
  t.after(() => gatewayStack.removeFixtureRoot(root));
  const workspaceId = 'workspace-http-fixture';
  const service = await openWorkspace({ root, workspaceId, create: true });
  const binding = createWorkspaceGateway({ service, allowedOrigins: [origin] });
  let stack: Awaited<ReturnType<typeof gatewayStack.start>> | undefined;
  try {
    stack = await gatewayStack.start({ workspace: binding });
    const base = stack.baseUrl + '/api/workspace';
    const owner = binding.authority.issue({ principalId: 'owner', origin, scopes: ['workspace:read', 'workspace:write', 'workspace:backup'] });
    const auth = { Origin: origin, [WORKSPACE_SESSION_HEADER]: owner.token };
    const metadata = { workspaceId, protocolVersion: 1 };
    async function request<T>(route: string, method = 'GET', payload?: object | string, headers: Record<string, string> = auth) {
      // node:http preserves the supplied Host so the rebinding fixture reaches the server.
      return new Promise<{ response: { status: number; headers: Headers }; json: {
        ok: boolean; code?: string; result: T; runtimeEpoch?: string;
      } }>((resolve, reject) => {
        const req = http.request(base + route, { method, headers: { ...headers, 'Content-Type': 'application/json' } }, response => {
          const chunks: Buffer[] = [];
          response.on('data', data => chunks.push(Buffer.from(data)));
          response.on('error', reject);
          response.on('end', () => {
            try {
              const responseHeaders = new Headers();
              for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(key, String(value));
              resolve({ response: { status: response.statusCode!, headers: responseHeaders }, json: JSON.parse(Buffer.concat(chunks).toString()) });
            } catch (error) { reject(error); }
          });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('Workspace HTTP fixture timed out')));
        req.end(payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload));
      });
    }
    const rejectedHeaders: Array<Record<string, string>> = [
      { Origin: origin },
      { Origin: origin, 'x-token': stack.config.TOKEN },
      { ...auth, Origin: 'http://localhost:32123' },
      { ...auth, 'x-forwarded-for': '203.0.113.8', 'x-token': stack.config.TOKEN },
      { ...auth, Host: 'foreign.example' },
    ];
    for (const [index, headers] of rejectedHeaders.entries()) {
      assert.notEqual((await request('/status', 'GET', undefined, headers)).response.status, 200, 'authorization case ' + index);
    }
    const expired = binding.authority.issue({ principalId: 'owner', origin, scopes: ['workspace:read'], ttlMs: 1 });
    await delay(5);
    assert.equal((await request('/status', 'GET', undefined, { ...auth, [WORKSPACE_SESSION_HEADER]: expired.token })).response.status, 401);
    const status = await request<WorkspaceResults['status']>('/status');
    assert.equal(status.response.status, 200);
    assert.equal(status.json.result.workspaceId, workspaceId);
    assert.equal(status.json.runtimeEpoch, owner.runtimeEpoch);
    assert.equal(status.response.headers.get('access-control-allow-origin'), origin);
    const sameOrigin = { [WORKSPACE_SESSION_HEADER]: owner.token, 'Sec-Fetch-Site': 'same-origin', Referer: origin + '/gallery', Host: new URL(origin).host };
    assert.equal((await request('/status', 'GET', undefined, sameOrigin)).response.status, 200);
    assert.equal((await request('/status', 'GET', undefined, { [WORKSPACE_SESSION_HEADER]: owner.token })).response.status, 401);
    assert.equal((await request('/status', 'GET', undefined, { ...sameOrigin, Referer: 'http://localhost:32123/gallery' })).response.status, 401);
    const preflight = await fetch(base + '/artwork-saves/save-1', { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(preflight.status, 204);
    assert.equal((await request<WorkspaceResults['listArtworks']>('/artworks')).json.result.items.length, 0);

    const save = { ...metadata, principalId: 'body-cannot-choose-owner', artwork: { id: 0, prompt: 'fixture', unknownField: { preserved: true } },
      media: { alias: 'image-fixture', sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length, mime: 'image/png' } };
    const nonFinite = JSON.stringify(save).replace('"unknownField":{"preserved":true}', '"unknownField":1e400');
    assert.equal((await request('/artwork-saves/non-finite', 'POST', nonFinite)).response.status, 400);
    assert.equal((await request('/operations/non-finite')).json.result, null);
    assert.equal((await request('/artwork-saves/save-1', 'POST', { ...save, protocolVersion: 2 })).response.status, 409);
    assert.equal((await request('/artwork-saves/save-1', 'POST', { ...save, workspaceId: 'other' })).response.status, 409);
    const prepared = await request<WorkspaceResults['prepareSave']>('/artwork-saves/save-1', 'POST', save);
    assert.equal(prepared.response.status, 200);
    assert.equal(prepared.json.result.state, 'prepared');
    assert.equal((await request('/artwork-saves/save-1/chunks', 'PUT', { ...metadata, offset: 0, data: png.toString('base64') })).response.status, 200);
    const committed = await request<WorkspaceResults['commitSave']>('/artwork-saves/save-1/commit', 'POST', metadata);
    assert.equal(committed.response.status, 200);
    const receipt = committed.json.result;
    assert.deepEqual((await request('/artwork-saves/save-1/commit', 'POST', metadata)).json.result, receipt);
    assert.equal((await request<WorkspaceResults['listArtworks']>('/artworks')).json.result.items.length, 1);
    assert.deepEqual((await request<WorkspaceResults['getArtwork']>('/artworks/0?idType=number')).json.result?.body.unknownField, { preserved: true });
    assert.equal((await request<WorkspaceResults['getArtwork']>('/artworks/0')).json.result?.id, 0, 'lookup keeps existing comparable-ID semantics and preserves the stored ID type');
    assert.equal((await request('/artwork-saves/collision', 'POST', { ...save, artwork: { ...save.artwork, id: '0' } })).response.status, 409);
    const operation = await request<WorkspaceResults['getOperation']>('/operations/save-1');
    assert.equal(operation.json.result?.state, 'committed');
    const stranger = binding.authority.issue({ principalId: 'body-cannot-choose-owner', origin, scopes: ['workspace:read'] });
    assert.equal((await request('/operations/save-1', 'GET', undefined, { ...auth, [WORKSPACE_SESSION_HEADER]: stranger.token })).json.result, null);
    assert.equal((await request('/artworks/0?idType=number', 'PATCH', { ...metadata, operationId: 'patch-denied', expectedRevision: receipt.revision, patch: { note: 'blocked' } },
      { ...auth, [WORKSPACE_SESSION_HEADER]: stranger.token })).response.status, 401);

    const patch = { ...metadata, operationId: 'patch-1', expectedRevision: receipt.revision, patch: { note: 'edited' } };
    const patched = await request<WorkspaceResults['patchArtwork']>('/artworks/0?idType=number', 'PATCH', patch);
    assert.equal(patched.response.status, 200);
    assert.equal((await request('/artworks/0?idType=number', 'PATCH', { ...patch, operationId: 'patch-stale' })).response.status, 409);
    assert.equal((await request<WorkspaceResults['getArtwork']>('/artworks/0?idType=number')).json.result?.body.note, 'edited');
    const bytes = await fetch(base + '/media/image-fixture/chunks?offset=2&length=12', { headers: auth });
    assert.equal(bytes.status, 200);
    assert.equal(bytes.headers.get('x-workspace-media-total-bytes'), String(png.length));
    assert.equal(bytes.headers.get('x-workspace-media-offset'), '2');
    assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), png.subarray(2, 14));
    const backed = await request<WorkspaceResults['backup']>('/backups', 'POST', { ...metadata, operationId: 'backup-1' });
    assert.equal(backed.response.status, 200);
    const restored = await request<WorkspaceResults['restoreBackup']>('/backups/' + backed.json.result.backupId + '/restore', 'POST', { ...metadata, operationId: 'restore-1' });
    assert.equal(restored.response.status, 200);
    assert.ok(restored.json.result.candidateId);
    assert.equal((await request<WorkspaceResults['status']>('/status')).json.result.workspaceId, workspaceId, 'restore creates a candidate without switching the active workspace');
  } finally {
    if (stack) await stack.close();
    else await binding.close();
  }
});
