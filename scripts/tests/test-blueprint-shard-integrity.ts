'use strict';

/** 热门角色场景蓝图分片完整性独立守卫：data/blueprints/*.json（按 franchise 系列分片）
 *  并集必须与聚合 data/scene-blueprints.json 逐条一致，id 全局唯一，
 *  manifest 覆盖所有系列且文件存在。与 test-popular-shard-integrity.js 同构。 */
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
      assert.ok(blueprint.id, 'blueprint must have id');
      assert.ok(blueprint.characterId, blueprint.id + ' must have characterId');
    }
  }
});

test('blueprint shards: union equals the aggregate, ids unique, order preserved', () => {
  const aggregate = readJson('scene-blueprints.json');
  assert.ok(Array.isArray(aggregate.blueprints) && aggregate.blueprints.length > 0,
    'aggregate must contain blueprints');
  const manifest = readJson('blueprints/manifest.json');

  const union = [];
  for (const entry of manifest.files) {
    const data = JSON.parse(fs.readFileSync(path.join(shardsDir, entry.file), 'utf8'));
    union.push(...data.blueprints);
  }

  assert.strictEqual(union.length, aggregate.blueprints.length,
    'shard union length must equal aggregate length');
  assert.deepStrictEqual(union.map((b) => b.id), aggregate.blueprints.map((b: { id: unknown; }) => b.id),
    'shard union ids must equal aggregate ids in order');

  const ids = new Set();
  for (const blueprint of aggregate.blueprints) {
    assert.ok(!ids.has(blueprint.id), 'duplicate id ' + blueprint.id);
    ids.add(blueprint.id);
  }
});

test('blueprint shards: no orphan files exist outside manifest', () => {
  const manifest = readJson('blueprints/manifest.json');
  const declaredFiles = new Set(manifest.files.map((e: { file: unknown; }) => e.file));
  declaredFiles.add('manifest.json');

  const diskFiles = fs.readdirSync(shardsDir).filter((name) => name.endsWith('.json'));
  for (const file of diskFiles) {
    assert.ok(declaredFiles.has(file), 'undeclared orphan file in data/blueprints/: ' + file);
  }
});
