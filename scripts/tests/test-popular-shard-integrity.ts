'use strict';

/** 旧分片仍校验升级导入完整性；构建聚合以 data/catalog 快照为权威。
 *  独立组装预期内容，不复用 store 或 catalog.views，保留数量、顺序及 ID 校验。 */
const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const test: typeof import('node:test') = require('node:test');

const dataDir = path.resolve(__dirname, '..', '..', 'data');
const shardsDir = path.join(dataDir, 'popular');

function readJson(name: string) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
}

test('popular shards: manifest declares existing, well-formed franchise files', () => {
  const manifest = readJson('popular/manifest.json');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0,
    'manifest must declare at least one franchise file');
  const seenFiles = new Set();
  const seenIds = new Set();
  for (const entry of manifest.files) {
    assert.ok(entry.franchise && typeof entry.franchise === 'string', 'entry must have franchise');
    assert.ok(!seenFiles.has(entry.file), 'duplicate file entry ' + entry.file);
    seenFiles.add(entry.file);
    const file = path.join(shardsDir, entry.file);
    assert.ok(fs.existsSync(file), entry.file + ' missing');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(data.characters), entry.file + ' must have characters array');
    assert.strictEqual(data.franchise, entry.franchise, entry.file + ' franchise mismatch');
    assert.strictEqual(data.characters.length, entry.count,
      entry.file + ' count mismatch with manifest');
    for (const character of data.characters) {
      assert.ok(character.id && !seenIds.has(character.id), 'missing or duplicate legacy id ' + character.id);
      seenIds.add(character.id);
      assert.strictEqual(character.franchise, entry.franchise,
        character.id + ' franchise must match its file');
    }
  }
});

test('popular catalog: aggregate matches snapshot content and order, ids unique', () => {
  const aggregate = readJson('popular-characters.json');
  assert.ok(Array.isArray(aggregate.characters) && aggregate.characters.length > 0,
    'aggregate must contain characters');
  const catalog: typeof import('../lib/catalog-snapshot') = require('../lib/catalog-snapshot');
  const records = catalog.read(path.dirname(dataDir));
  assert.ok(records, 'committed catalog snapshot must exist');
  const outfits = records.filter(record => record.kind === 'outfit');
  const expected = records.filter(record => record.kind === 'character' && record.data.popular)
    .map(record => ({
      ...record.data.popular,
      outfits: outfits.filter(outfit => outfit.data.characterId === record.data.id)
        .map(outfit => outfit.data.outfit),
    }));
  assert.strictEqual(aggregate.characters.length, expected.length,
    'catalog count must equal aggregate count');
  assert.deepStrictEqual(aggregate.characters, expected,
    'aggregate must preserve catalog content and sortOrder/id ordering');

  const ids = new Set();
  for (const character of aggregate.characters) {
    assert.ok(!ids.has(character.id), 'duplicate id ' + character.id);
    ids.add(character.id);
  }
});

test('popular shards: aggregate version field is stable', () => {
  const aggregate = readJson('popular-characters.json');
  assert.strictEqual(aggregate.version, 1);
});
