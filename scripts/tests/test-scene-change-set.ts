'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const { resolveSceneChangeSet, previewSceneChanges }: typeof import('../lib/scene-change-set') = require('../lib/scene-change-set');
const { isSceneId, formatSceneId, missingSceneIdRanges }: typeof import('../lib/scene-id') = require('../lib/scene-id');
const scene = (id: any, title = id) => ({ id, title, char: 'fixture' });
const current = () => ({ scenes: [scene('sc001'), scene('sc002'), scene('sc999')],
  blueprints: [], tags: [{ tag: 'fixture' }], curation: { curatedSceneIds: ['sc002'] } });
const delta = (upsert = [], remove = []) => ({ version: 1, scenes: { upsert, remove } });

test('only explicitly selected IDs change; delta values detach from submitted objects', () => {
  const before = current();
  const changes = delta([scene('sc002', 'updated'), scene('sc1000')], ['sc999']);
  const frozen = JSON.stringify({ before, changes });
  const saved = resolveSceneChangeSet(before, changes);
  assert.deepEqual(saved.scenes.map((item: any) => item.id), ['sc001', 'sc002', 'sc1000']);
  assert.equal(saved.scenes[1].title, 'updated');
  assert.equal(saved.tags, undefined);
  assert.equal(saved.curation, undefined);
  assert.equal(saved.blueprints, undefined);
  assert.equal(JSON.stringify({ before, changes }), frozen);
  saved.scenes[0].title = 'isolated';
  saved.scenes[1].title = 'isolated';
  assert.equal(before.scenes[0].title, 'sc001');
  assert.equal(changes.scenes.upsert[0].title, 'updated');
});

test('invalid schemas, duplicate IDs and ambiguous removals are rejected', () => {
  for (const changes of [
    {}, { ...delta(), version: 2 }, { ...delta(), overwrite: true },
    delta([scene('sc001'), scene('sc001')]), delta([], ['sc003']),
    delta([], ['sc001', 'sc001']), delta([scene('sc001')], ['sc001']),
    delta([], ['sc001', 'sc002', 'sc999']),
    { version: 1, scenes: { upsert: [], remove: [], other: [] } },
  ]) assert.throws(() => resolveSceneChangeSet(current(), changes));
});

test('explicit empty optional collections retain clear semantics', () => {
  const result = resolveSceneChangeSet(current(), { ...delta(), tags: [], curation: {}, blueprints: { upsert: [], remove: [] } });
  assert.deepEqual(result.tags, []);
  assert.deepEqual(result.curation, {});
  assert.deepEqual(result.blueprints, []);
});

test('preview distinguishes related references from proof of rendering or delivery', () => {
  const before = current();
  const next = resolveSceneChangeSet(before, delta([scene('sc002', 'new'), scene('sc1000')], ['sc999']));
  const preview = previewSceneChanges(before, next, 123);
  assert.deepEqual(preview.added, ['sc1000']);
  assert.deepEqual(preview.updated, ['sc002']);
  assert.deepEqual(preview.removed, ['sc999']);
  assert.ok(preview.related.some(item => item.kind === 'curation' && item.id === 'sc002'));
  assert.ok(preview.unknown.length);
  assert.equal(preview.version, 123);
});

test('scene identifiers preserve canonical spelling at all numeric boundaries', () => {
  for (const id of ['sc001', 'sc099', 'sc999', 'sc1000', 'sc9007199254740991']) {
    assert.ok(isSceneId(id), id);
    assert.equal(formatSceneId(Number(id.slice(2))), id);
  }
  for (const id of ['sc000', 'sc0001', 'sc01', 'sc-1', 'SC001', 'sc1e3', 'sc9007199254740992', 1]) assert.equal(isSceneId(id), false);
  assert.throws(() => formatSceneId(Number.MAX_SAFE_INTEGER + 1));
});

test('missing-ID checks use finite ranges even at the largest safe identifier', () => {
  assert.deepEqual(missingSceneIdRanges(['sc001', 'sc004'], ['sc002']), [{ start: 3, end: 3, count: 1 }]);
  assert.deepEqual(missingSceneIdRanges(['sc001', 'sc9007199254740991']), [
    { start: 2, end: Number.MAX_SAFE_INTEGER - 1, count: Number.MAX_SAFE_INTEGER - 2 },
  ]);
  assert.deepEqual(missingSceneIdRanges(['sc001'], ['sc002', 'sc003']), []);
});
