'use strict';

/** 旧分片仍校验升级导入完整性；构建聚合以 data/catalog 快照为权威。
 *  独立组装预期内容，不复用 store 或 catalog.views，保留数量、顺序及 ID 校验。 */
const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const test: typeof import('node:test') = require('node:test');

const dataDir = path.resolve(__dirname, '..', '..', 'data');
const shardsDir = path.join(dataDir, 'blueprints');

function readJson(name: string) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
}

test('blueprint shards: manifest declares existing, well-formed franchise files', () => {
  const manifest = readJson('blueprints/manifest.json');
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
    assert.ok(Array.isArray(data.blueprints), entry.file + ' must have blueprints array');
    assert.strictEqual(data.franchise, entry.franchise, entry.file + ' franchise mismatch');
    assert.strictEqual(data.blueprints.length, entry.count,
      entry.file + ' count mismatch with manifest');
    for (const blueprint of data.blueprints) {
      assert.ok(blueprint.id && !seenIds.has(blueprint.id), 'missing or duplicate legacy id ' + blueprint.id);
      seenIds.add(blueprint.id);
      assert.ok(blueprint.id, 'blueprint must have id');
      assert.ok(blueprint.characterId, blueprint.id + ' must have characterId');
    }
  }
});

test('blueprint catalog: aggregate matches snapshot content and order, ids unique', () => {
  const aggregate = readJson('scene-blueprints.json');
  assert.ok(Array.isArray(aggregate.blueprints) && aggregate.blueprints.length > 0,
    'aggregate must contain blueprints');
  const catalog: typeof import('../lib/catalog-snapshot') = require('../lib/catalog-snapshot');
  const records = catalog.read(path.dirname(dataDir));
  assert.ok(records, 'committed catalog snapshot must exist');
  const expected = records.filter(record => record.kind === 'blueprint').map(record => record.data);
  assert.strictEqual(aggregate.blueprints.length, expected.length,
    'catalog count must equal aggregate count');
  assert.deepStrictEqual(aggregate.blueprints, expected,
    'aggregate must preserve catalog content and sortOrder/id ordering');

  const ids = new Set();
  for (const blueprint of aggregate.blueprints) {
    assert.ok(!ids.has(blueprint.id), 'duplicate id ' + blueprint.id);
    ids.add(blueprint.id);
  }
});

test('blueprint shards: no orphan files exist outside manifest', () => {
  const manifest = readJson('blueprints/manifest.json');
  const declaredFiles = new Set(manifest.files.map((e: any) => e.file));
  declaredFiles.add('manifest.json');

  const diskFiles = fs.readdirSync(shardsDir).filter((name) => name.endsWith('.json'));
  for (const file of diskFiles) {
    assert.ok(declaredFiles.has(file), 'undeclared orphan file in data/blueprints/: ' + file);
  }
});
