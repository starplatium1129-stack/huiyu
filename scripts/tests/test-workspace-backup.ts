import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { backupWorkspace, restoreBackup } from '../../server/workspace/backup';
import { openStorage } from '../../server/workspace/schema';
import { entityKey } from '../../server/workspace/records';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-backup-'));
  const context = openStorage({ root, workspaceId: 'backup-fixture', writerEpoch: 'test-owner', create: true });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLxQAAAAASUVORK5CYII=', 'base64');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const relative = `media/objects/${hash.slice(0, 2)}/${hash}`;
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), bytes);
  context.transaction(() => {
    context.db.prepare('INSERT INTO artworks VALUES(?,?,?,?,NULL)').run(entityKey(7), '7', JSON.stringify({ id: 7, image_id: 'original', title: 'snapshot' }), 1);
    context.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(entityKey('album'), '"album"', '{"id":"album","title":"album","history_ids":[7]}', 1);
    context.db.prepare('INSERT INTO project_artworks VALUES(?,?,?)').run(entityKey('album'), entityKey(7), 0);
    context.db.prepare('INSERT INTO media_objects VALUES(?,?,?)').run(hash, bytes.length, 'image/png');
    context.db.prepare('INSERT INTO media_aliases VALUES(?,?)').run('original', hash);
    context.db.prepare('INSERT INTO media_refs VALUES(?,?,?)').run('artwork', entityKey(7), hash);
    context.db.prepare("UPDATE meta SET value='1' WHERE key='revision'").run();
  });
  return { root, context, relative, hash, close() { context.db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('SQLite API snapshot releases writes during copying and restores the earlier WAL state', async () => {
  const f = fixture();
  try {
    assert.ok(fs.statSync(path.join(f.root, 'huiyu.sqlite3-wal')).size > 0);
    const backupId = randomUUID();
    let copyReady = false;
    const backup = await backupWorkspace(f.context, backupId, { onCopyReady: () => {
      copyReady = true;
      assert.equal(fs.existsSync(path.join(f.root, 'backups', backupId, 'manifest.json')), false);
      assert.equal(f.context.db.prepare("SELECT COUNT(*) AS count FROM leases WHERE kind='backup'").get()?.count, 1);
      f.context.transaction(() => {
        f.context.db.prepare('UPDATE artworks SET body=?,revision=2').run('{"id":7,"image_id":"original","title":"newer live edit"}');
        f.context.db.prepare("UPDATE meta SET value='2' WHERE key='revision'").run();
      });
      assert.equal(JSON.parse(String(f.context.db.prepare('SELECT body FROM artworks').get()?.body)).title, 'newer live edit');
    } });
    assert.equal(copyReady, true);
    assert.deepEqual(backup, { backupId, revision: 1, mediaCount: 1 });
    assert.equal(f.context.db.prepare("SELECT COUNT(*) AS count FROM leases WHERE kind='backup'").get()?.count, 0);
    assert.deepEqual(await backupWorkspace(f.context, backupId), backup);
    const candidateId = randomUUID();
    const restored = await restoreBackup(f.context, backupId, candidateId);
    assert.deepEqual(await restoreBackup(f.context, backupId, candidateId), restored);
    const candidate = new DatabaseSync(path.join(f.root, 'restore-candidates', candidateId, 'huiyu.sqlite3'), { readOnly: true });
    try {
      assert.equal(JSON.parse(String(candidate.prepare('SELECT body FROM artworks').get()?.body)).title, 'snapshot');
      assert.equal(candidate.prepare('SELECT count(*) AS count FROM project_artworks').get()?.count, 1);
      assert.equal(candidate.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally { candidate.close(); }
    assert.equal(JSON.parse(String(f.context.db.prepare('SELECT body FROM artworks').get()?.body)).title, 'newer live edit');
    assert.equal(fs.existsSync(path.join(f.root, 'workspace-active.json')), false);
  } finally { f.close(); }
});

test('failed media verification keeps backup leases, and a retry repairs only its own incomplete output', async () => {
  const f = fixture();
  try {
    const original = fs.readFileSync(path.join(f.root, f.relative));
    fs.writeFileSync(path.join(f.root, f.relative), 'corrupt');
    const backupId = randomUUID();
    await assert.rejects(backupWorkspace(f.context, backupId), /hash or size mismatch/);
    assert.equal(fs.existsSync(path.join(f.root, 'backups', backupId, 'manifest.json')), false);
    assert.equal(f.context.db.prepare("SELECT COUNT(*) AS count FROM leases WHERE kind='backup'").get()?.count, 1);
    fs.writeFileSync(path.join(f.root, f.relative), original);
    await backupWorkspace(f.context, backupId);
    assert.equal(f.context.db.prepare("SELECT COUNT(*) AS count FROM leases WHERE kind='backup'").get()?.count, 0);
    fs.writeFileSync(path.join(f.root, 'backups', backupId, f.relative), 'corrupt after completion');
    await assert.rejects(restoreBackup(f.context, backupId, randomUUID()), /byte length|digest/);
    assert.equal(fs.existsSync(path.join(f.root, 'restore-candidates')), false);
  } finally { f.close(); }
});

test('backup honours cancellation during copying; restore rejects a valid-hash unknown schema', async () => {
  const f = fixture();
  try {
    const cancelledId = randomUUID();
    let checks = 0;
    await assert.rejects(backupWorkspace(f.context, cancelledId, { isCancelled: () => ++checks >= 3 }), /cancelled/);
    assert.equal(fs.existsSync(path.join(f.root, 'backups', cancelledId, 'manifest.json')), false);
    const backupId = randomUUID();
    await backupWorkspace(f.context, backupId);
    const directory = path.join(f.root, 'backups', backupId);
    const databasePath = path.join(directory, 'huiyu.sqlite3');
    const db = new DatabaseSync(databasePath);
    try { db.exec('PRAGMA user_version=2'); } finally { db.close(); }
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bytes = fs.readFileSync(databasePath);
    manifest.database = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(restoreBackup(f.context, backupId, randomUUID()), /schema or integrity/);
    await assert.rejects(restoreBackup(f.context, '../outside', randomUUID()), /Invalid backup identity/);
  } finally { f.close(); }
});
