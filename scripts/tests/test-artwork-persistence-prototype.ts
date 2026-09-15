'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { openArtworkCandidate, digest }: typeof import('./prototypes/artwork-sqlite') = require('./prototypes/artwork-sqlite');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-storage-prototype-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aics-storage-prototype-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = {
    history: [{ id: 'work-1', image_id: 'original-1' }],
    projects: [{ id: 'project-1', history_ids: ['work-1'] }], trash: [],
    images: [{ id: 'original-1', bytes: Buffer.from('fixture original') }, { id: 'thumb-1', bytes: Buffer.from('fixture thumbnail') }],
  };
  return { root, source };
}

for (const interruption of ['file-published', 'metadata-written', 'committed']) {
  test(`candidate resumes after ${interruption} without changing source`, t => {
    const { root, source } = fixture(t);
    const before = digest(JSON.stringify(source));
    let candidate = openArtworkCandidate(root, phase => { if (phase === interruption) throw new Error('injected interruption'); });
    try {
      assert.throws(() => candidate.importSnapshot('migration-1', source), /interruption/);
      assert.equal(candidate.count(), interruption === 'committed' ? 1 : 0);
      assert.equal(candidate.state('migration-1'), interruption === 'committed' ? 'ready' : 'preparing');
    } finally { candidate.close(); }
    candidate = openArtworkCandidate(root);
    try {
      candidate.importSnapshot('migration-1', source);
      candidate.importSnapshot('migration-1', source);
      assert.equal(candidate.count(), 1);
      assert.equal(candidate.state('migration-1'), 'ready');
      assert.deepEqual(candidate.history(), source.history);
      for (const image of source.images) assert.deepEqual(candidate.readImage(image.id), image.bytes);
      assert.equal(digest(JSON.stringify(source)), before);
    } finally { candidate.close(); }
  });
}

test('changed source and corrupted candidate media cannot be silently accepted', t => {
  const { root, source } = fixture(t);
  const candidate = openArtworkCandidate(root);
  try {
    candidate.importSnapshot('migration-1', source);
    assert.throws(() => candidate.importSnapshot('migration-1', { ...source, history: [{ ...source.history[0], favorite: true }] }), /Source changed/);
    assert.throws(() => candidate.importSnapshot('migration-2', source), /already belongs/);
    fs.writeFileSync(path.join(root, 'media', digest(source.images[0].bytes)), 'corrupt');
    assert.throws(() => candidate.importSnapshot('migration-1', source), /corrupt/);
    assert.equal(candidate.count(), 1);
  } finally { candidate.close(); }
});

test('discarding a candidate leaves the old backup usable for rollback', t => {
  const { root, source } = fixture(t);
  const backup = path.join(root, 'old-version-backup.json');
  const content = JSON.stringify(source);
  fs.writeFileSync(backup, content);
  const candidateRoot = path.join(root, 'candidate');
  const candidate = openArtworkCandidate(candidateRoot);
  try { candidate.importSnapshot('migration-1', source); }
  finally { candidate.close(); }
  assert.equal(path.dirname(path.resolve(candidateRoot)), path.resolve(root));
  fs.rmSync(candidateRoot, { recursive: true, force: true });
  assert.equal(fs.readFileSync(backup, 'utf8'), content);
});

test('unsupported schemas keep their original version and data', t => {
  const { root } = fixture(t);
  const { DatabaseSync }: typeof import('node:sqlite') = require('node:sqlite');
  const database = path.join(root, 'candidate.sqlite');
  let db = new DatabaseSync(database);
  db.exec('PRAGMA user_version=2; CREATE TABLE newer(value TEXT); INSERT INTO newer VALUES(\'preserved\')');
  db.close();
  assert.throws(() => openArtworkCandidate(root), /Unsupported/);
  db = new DatabaseSync(database);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(db.prepare('SELECT value FROM newer').get().value, 'preserved');
  } finally { db.close(); }
});

test('dangling original, trash, and project references cannot publish', t => {
  const { root, source } = fixture(t);
  const candidate = openArtworkCandidate(root);
  try {
    assert.throws(() => candidate.importSnapshot('migration-1', { ...source, images: [] }), /Missing referenced original/);
    assert.throws(() => candidate.importSnapshot('migration-1', { ...source, projects: [{ history_ids: ['missing'] }] }), /Missing project artwork/);
    assert.throws(() => candidate.importSnapshot('migration-1', { ...source, trash: [{ imageIds: ['missing'] }] }), /Missing trash original/);
    assert.equal(candidate.state('migration-1'), undefined);
    assert.equal(candidate.count(), 0);
  } finally { candidate.close(); }
});
