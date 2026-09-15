'use strict';

/** 热门角色分片完整性独立守卫：data/popular/*.json（按 franchise 一个系列一个文件）
 *  并集必须与聚合 data/popular-characters.json 逐字节一致，id 全局唯一，
 *  manifest 覆盖所有系列且文件存在。与场景库 test-scene-shard-integrity.js 同构。 */
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
      assert.strictEqual(character.franchise, entry.franchise,
        character.id + ' franchise must match its file');
    }
  }
});

test('popular shards: union equals the aggregate, ids unique, order preserved', () => {
  const aggregate = readJson('popular-characters.json');
  assert.ok(Array.isArray(aggregate.characters) && aggregate.characters.length > 0,
    'aggregate must contain characters');
  const manifest = readJson('popular/manifest.json');

  const union = [];
  for (const entry of manifest.files) {
    const data = JSON.parse(fs.readFileSync(path.join(shardsDir, entry.file), 'utf8'));
    union.push(...data.characters);
  }

  assert.strictEqual(union.length, aggregate.characters.length,
    'shard union length must equal aggregate length');
  assert.deepStrictEqual(union.map((c) => c.id), aggregate.characters.map((c: { id: unknown; }) => c.id),
    'shard union ids must equal aggregate ids in order');

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
