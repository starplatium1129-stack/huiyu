import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import assert = require('node:assert/strict');
import { loadReferenceShards, writeReferenceLibrary, writeReferenceAggregate, aggregateIsCurrent } from '../lib/reference-store';
import io = require('../lib/maintenance-recovery-fs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-reference-shards-'));
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const read = (name: string) => fs.readFileSync(path.join(root, 'data', name), 'utf8');
try {
  const standards = { version: 2, perspectives: [{ id: 'front' }], characters: [
    { id: 'alice', outfits: [{ id: 'dress' }] }, { id: 'bob', outfits: [] },
  ] };
  const view = { bob: { characterId: 'bob', outfits: [] }, alice: { characterId: 'alice', outfits: [
    { outfitId: 'dress', references: [{ url: '/character-references/alice/front.png', pending: false, custom: 'preserve' }] },
  ] } };
  writeReferenceLibrary(root, standards, view);
  assert.equal(read('character-reference-standards.json'), json(standards));
  assert.equal(read('character-reference-view.json'), json(view));
  assert.deepEqual(loadReferenceShards(root), { standards, view });
  assert.ok(aggregateIsCurrent(root));
  const bob = path.join(root, 'data/references/bob.json');
  const before = fs.statSync(bob).mtimeMs;
  view.alice.outfits[0].references[0].custom = 'updated';
  writeReferenceLibrary(root, standards, view);
  assert.equal(fs.statSync(bob).mtimeMs, before, 'unrelated character must not be rewritten');
  assert.equal(writeReferenceLibrary(root, standards, view).changed, 0, 'repeat write must be a no-op');
  const saved = loadReferenceShards(root);
  const changedView = structuredClone(view);
  changedView.alice.outfits[0].references[0].custom = 'must roll back';
  const write = io.atomicWrite;
  let injected = false;
  io.atomicWrite = (file: string, bytes: any, createParents?: any) => {
    if (!injected && file.endsWith('character-reference-view.json')) { injected = true; throw new Error('injected write failure'); }
    return write(file, bytes, createParents);
  };
  try { assert.throws(() => writeReferenceLibrary(root, standards, changedView), /injected write failure/); }
  finally { io.atomicWrite = write; }
  assert.deepEqual(loadReferenceShards(root), saved, 'failed product write must restore source shard');
  assert.ok(aggregateIsCurrent(root), 'rollback restores products too');
  const file = path.join(root, 'data/character-reference-view.json');
  fs.writeFileSync(file + '.br', 'stale');
  fs.writeFileSync(file, '{}');
  assert.equal(aggregateIsCurrent(root), false);
  writeReferenceAggregate(root);
  assert.equal(read('character-reference-view.json'), json(view));
  assert.equal(fs.existsSync(file + '.br'), false);
  fs.unlinkSync(file);
  writeReferenceAggregate(root);
  assert.ok(aggregateIsCurrent(root), 'fresh clone product regeneration');
  const manifestPath = path.join(root, 'data/references/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, json({ ...manifest, characterIds: ['../escape'] }));
  assert.throws(() => loadReferenceShards(root), /Invalid reference character ID/);
  fs.writeFileSync(manifestPath, json({ ...manifest, characterIds: ['alice', 'alice'] }));
  assert.throws(() => loadReferenceShards(root), /Duplicate/);
  fs.writeFileSync(manifestPath, json(manifest));
  fs.writeFileSync(path.join(root, 'data/references/orphan.json'), '{}');
  assert.throws(() => loadReferenceShards(root), /Unregistered/);
  console.log('PASS reference shards: lossless order/data, isolated writes, idempotence, fresh products, compression invalidation, unsafe/duplicate/orphan sources');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
