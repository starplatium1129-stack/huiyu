import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { openWorkspaceEngine } from '../../server/workspace/engine';
import { mediaPath } from '../../server/workspace/media';
import { thumbnailPath } from '../../server/workspace/thumbnails';
import type { WorkspaceCommand, WorkspaceResults } from '../../server/workspace/types';

test('workspace thumbnails survive restart, rebuild as disposable cache and respect original integrity and GC', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-thumbnails-'));
  const context = { workspaceId: 'thumbnail-fixture', principalId: 'fixture', protocolVersion: 1 as const };
  let engine = openWorkspaceEngine({ root, workspaceId: context.workspaceId, writerEpoch: 'fixture', create: true });
  const call = <C extends WorkspaceCommand>(command: C) => engine.execute(command, context) as Promise<WorkspaceResults[C['kind']]>;
  try {
    const png = await sharp({ create: { width: 1120, height: 700, channels: 3, background: '#778899' } }).png().toBuffer();
    const hash = createHash('sha256').update(png).digest('hex');
    await call({ kind: 'prepareMedia', operationId: 'upload', media: { alias: 'original', sha256: hash, bytes: png.length, mime: 'image/png' } });
    await call({ kind: 'uploadMediaChunk', operationId: 'upload', offset: 0, data: png });
    await call({ kind: 'commitMedia', operationId: 'upload' });
    const revision = (await call({ kind: 'status' })).revision;
    const preview = await call({ kind: 'readThumbnail', alias: 'original' });
    assert.ok(preview);
    assert.match(preview, /^data:image\/jpeg;base64,/);
    const size = await sharp(Buffer.from(preview.split(',')[1], 'base64')).metadata();
    assert.equal(size.width, 560); assert.equal(size.height, 350);
    const cachedFile = thumbnailPath(root, hash), originalFile = mediaPath(root, hash);
    assert.deepEqual(fs.readFileSync(originalFile), png, 'thumbnail generation never modifies the source');
    fs.utimesSync(cachedFile, new Date(1_000_000), new Date(1_000_000));
    engine.close();
    engine = openWorkspaceEngine({ root, workspaceId: context.workspaceId, writerEpoch: 'fixture', create: false });
    assert.equal(await call({ kind: 'readThumbnail', alias: 'original' }), preview);
    assert.equal(fs.statSync(cachedFile).mtimeMs, 1_000_000, 'restart reuses the persisted preview without another encode');
    fs.unlinkSync(cachedFile);
    assert.equal(await call({ kind: 'readThumbnail', alias: 'original' }), preview, 'derived cache is reconstructible');
    assert.equal((await call({ kind: 'status' })).revision, revision, 'derived reads do not mutate library revision');
    fs.writeFileSync(originalFile, Buffer.alloc(png.length));
    await assert.rejects(call({ kind: 'readThumbnail', alias: 'original' }), { code: 'MEDIA_INVALID' });
    fs.writeFileSync(originalFile, png);
    await call({ kind: 'releaseMedia', alias: 'original', operationId: 'release' });
    fs.utimesSync(originalFile, new Date(1_000_000), new Date(1_000_000));
    await call({ kind: 'collectGarbage', operationId: 'gc' });
    assert.equal(fs.existsSync(cachedFile), false, 'GC releases derived bytes with the original');
    assert.equal(await call({ kind: 'readThumbnail', alias: 'original' }), null, 'a missing original has no derived preview');
  } finally { engine.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
