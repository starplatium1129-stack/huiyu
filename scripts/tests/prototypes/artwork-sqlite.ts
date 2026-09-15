'use strict';

// Evaluation only. Nothing in src/server imports this candidate or migrates a user database.
const { DatabaseSync }: typeof import('node:sqlite') = require('node:sqlite');
const { createHash }: typeof import('node:crypto') = require('node:crypto');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');

const digest = (value: any) => createHash('sha256').update(value).digest('hex');

function openArtworkCandidate(root: any, fault = () => {}) {
  fs.mkdirSync(path.join(root, 'media'), { recursive: true });
  const db = new DatabaseSync(path.join(root, 'candidate.sqlite'));
  if (db.prepare('PRAGMA user_version').get().user_version > 1) {
    db.close();
    throw new Error('Unsupported candidate schema version');
  }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS migrations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS artwork(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, hash TEXT NOT NULL, bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS related(key TEXT PRIMARY KEY, body TEXT NOT NULL);
    PRAGMA user_version=1;`);

  const transaction = (action: any) => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = action(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  function importSnapshot(id: any, snapshot: any) {
    const manifest = snapshot.images.map((image: any) => ({ id: image.id, hash: digest(image.bytes), bytes: image.bytes.length }));
    if (new Set(manifest.map((image: any) => image.id)).size !== manifest.length) throw new Error('Duplicate image ID');
    if (new Set(snapshot.history.map((entry: any) => entry.id)).size !== snapshot.history.length) throw new Error('Duplicate artwork ID');
    const images = new Set(manifest.map((image: any) => image.id));
    const works = new Set(snapshot.history.map((entry: any) => entry.id));
    for (const entry of [...snapshot.history, ...snapshot.trash.flatMap((entry: any) => entry.historyEntries || [])]) {
      if (entry.image_id && !images.has(entry.image_id)) throw new Error('Missing referenced original');
    }
    for (const entry of snapshot.trash) {
      if ((entry.imageIds || []).some((id: any) => !images.has(id))) throw new Error('Missing trash original');
    }
    for (const project of snapshot.projects) {
      if ((project.history_ids || []).some((id: any) => !works.has(id))) throw new Error('Missing project artwork');
    }
    const fingerprint = digest(JSON.stringify({ history: snapshot.history, projects: snapshot.projects, trash: snapshot.trash, manifest }));
    const previous = db.prepare('SELECT * FROM migrations WHERE id=?').get(id);
    if (previous && previous.fingerprint !== fingerprint) throw new Error('Source changed: start a new isolated candidate');
    if (!previous && db.prepare('SELECT count(*) AS n FROM migrations').get().n) throw new Error('Candidate already belongs to a migration');
    db.prepare('INSERT OR IGNORE INTO migrations VALUES(?,?,?)').run(id, fingerprint, 'preparing');
    // Immutable content-addressed files: a crash may leave an orphan, never a published missing image.
    for (let index = 0; index < manifest.length; index += 1) {
      const image = manifest[index];
      const destination = path.join(root, 'media', image.hash);
      if (fs.existsSync(destination)) {
        if (digest(fs.readFileSync(destination)) !== image.hash) throw new Error('Candidate media corrupt');
      } else {
        const pending = destination + '.pending';
        const descriptor = fs.openSync(pending, 'w');
        try { fs.writeFileSync(descriptor, snapshot.images[index].bytes); fs.fsyncSync(descriptor); }
        finally { fs.closeSync(descriptor); }
        fs.renameSync(pending, destination);
      }
      fault('file-published', index);
    }
    if (previous?.state === 'ready') return;
    transaction(() => {
      for (const entry of snapshot.history) db.prepare('INSERT OR REPLACE INTO artwork VALUES(?,?)').run(entry.id, JSON.stringify(entry));
      for (const image of manifest) db.prepare('INSERT OR REPLACE INTO media VALUES(?,?,?)').run(image.id, image.hash, image.bytes);
      for (const key of ['projects', 'trash']) db.prepare('INSERT OR REPLACE INTO related VALUES(?,?)').run(key, JSON.stringify(snapshot[key]));
      fault('metadata-written');
      db.prepare('UPDATE migrations SET state=? WHERE id=?').run('ready', id);
    });
    fault('committed');
  }
  function publishMetadata(history: any, projects: any, trash: any) {
    transaction(() => {
      db.exec('DELETE FROM artwork');
      const insert = db.prepare('INSERT INTO artwork VALUES(?,?)');
      for (const entry of history) insert.run(entry.id, JSON.stringify(entry));
      for (const [key, value] of Object.entries({ projects, trash })) db.prepare('INSERT OR REPLACE INTO related VALUES(?,?)').run(key, JSON.stringify(value));
    });
  }
  return {
    importSnapshot, publishMetadata,
    state: (id: any) => db.prepare('SELECT state FROM migrations WHERE id=?').get(id)?.state,
    count: () => db.prepare('SELECT count(*) AS n FROM artwork').get().n,
    history: () => db.prepare('SELECT body FROM artwork ORDER BY rowid').all().map(row => JSON.parse(row.body)),
    patch: (id: any, patch: any) => transaction(() => {
      const current = db.prepare('SELECT body FROM artwork WHERE id=?').get(id);
      if (!current) throw new Error('Artwork not found');
      db.prepare('UPDATE artwork SET body=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(current.body), ...patch }), id);
    }),
    readImage: (id: any) => {
      const record = db.prepare('SELECT hash FROM media WHERE id=?').get(id);
      return record ? fs.readFileSync(path.join(root, 'media', record.hash)) : null;
    },
    close: () => db.close(),
  };
}

export = { openArtworkCandidate, digest };
