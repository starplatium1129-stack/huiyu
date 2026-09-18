import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  aggregateIsCurrent,
  aggregatePath,
  loadTagShards,
  manifestPath,
  shardsDir,
  readJson,
  type TagManifest,
  type TagShardFile,
  type TagEntry,
} from '../lib/tag-store';

test('Tag 分片清单：manifest 包含非空 files 且分片文件全部存在', () => {
  assert.ok(fs.existsSync(manifestPath), 'data/tags/manifest.json must exist');
  const manifest = readJson<TagManifest>(manifestPath);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);

  for (const entry of manifest.files) {
    const shardFile = path.join(shardsDir, entry.file);
    assert.ok(fs.existsSync(shardFile), `Shard file ${entry.file} must exist`);
    const shard = readJson<TagShardFile>(shardFile);
    assert.strictEqual(shard.version, 1);
    assert.strictEqual(shard.category, entry.category);
    assert.ok(Array.isArray(shard.tags));
    assert.strictEqual(shard.tags.length, entry.count, `Count mismatch in ${entry.file}`);
  }
});

test('Tag 分片完整性：全局 ID 唯一，且中英文与分类非空', () => {
  const { tags, sources } = loadTagShards();
  assert.ok(tags.length >= 680, 'Total tags must be at least 680');

  const allIds = new Set<string>();
  for (const tag of tags) {
    assert.ok(tag.id, 'Tag ID must not be empty');
    assert.ok(!allIds.has(tag.id), `Duplicate Tag ID: ${tag.id}`);
    allIds.add(tag.id);

    assert.ok(tag.en && tag.en.trim(), `Tag ${tag.id} must have non-empty en`);
    assert.ok(tag.cn && tag.cn.trim(), `Tag ${tag.id} must have non-empty cn`);
    assert.ok(tag.cat && tag.cat.trim(), `Tag ${tag.id} must have non-empty cat`);
  }

  // 检查各分片内来源
  for (const { entry, tags: shardTags } of sources) {
    assert.ok(shardTags.length > 0, `${entry.file} must not be empty`);
  }
});

test('Tag 聚合一致性：aggregateIsCurrent 为 true，且聚合产物与分片完全一致', () => {
  assert.ok(aggregateIsCurrent(), 'data/tags.json must match data/tags/*.json shards');
  const aggregate = readJson<TagEntry[]>(aggregatePath);
  const { tags } = loadTagShards();
  assert.strictEqual(aggregate.length, tags.length);
  assert.deepStrictEqual(aggregate, tags);
});

test('Tag 权威字典派生：tags-dictionary.json 包含 meanings 与 aliases 且目标有效', () => {
  const dictFile = path.resolve(__dirname, '../../data/tags-dictionary.json');
  assert.ok(fs.existsSync(dictFile), 'data/tags-dictionary.json must exist');
  const dict = readJson<{ version: number; meanings: Record<string, string>; aliases: Record<string, string> }>(dictFile);
  assert.strictEqual(dict.version, 1);
  assert.ok(Object.keys(dict.meanings).length >= 600);
  assert.ok(Object.keys(dict.aliases).length > 0);

  const { tags } = loadTagShards();
  const allEn = new Set(tags.map(t => t.en));

  for (const [alias, targetEn] of Object.entries(dict.aliases)) {
    assert.ok(alias, 'Alias key must not be empty');
    assert.ok(allEn.has(targetEn), `Alias ${alias} targets unknown tag: ${targetEn}`);
  }

  assert.strictEqual(dict.aliases.jk, 'school_uniform');
  assert.strictEqual(dict.aliases.qipao, 'china_dress');
  assert.strictEqual(dict.aliases.dof, 'blurry foreground, depth of field');
});

// Isolated source/write-path regressions. No production data is modified.
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildTagDictionary } from '../lib/tag-store';
import { writeTagFiles } from '../lib/tag-files';

const sampleTag = (id = 'one', en = 'park'): TagEntry => ({ id, en, cn: '公园', cat: 'Scene', related: [] });
function tagFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-shard-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data/tags'), { recursive: true });
  const write = (file: string, data: unknown) => fs.writeFileSync(path.join(root, file), JSON.stringify(data));
  write('data/tags/manifest.json', { version: 1, files: [{ file: 'scene.json', category: 'Scene', count: 1 }] });
  write('data/tags/scene.json', { version: 1, category: 'Scene', tags: [sampleTag()] });
  fs.writeFileSync(path.join(root, 'data/tags.json'), 'aggregate sentinel');
  fs.writeFileSync(path.join(root, 'data/tags-dictionary.json'), 'dictionary sentinel');
  return { root, write };
}
function runTag(root: string, method = 'writeTagAggregate') {
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.resolve(__dirname, '../lib/tag-store.js'))}).${method}()`], {
    env: { ...process.env, AICS_DATA_ROOT: root }, encoding: 'utf8',
  });
}
function sentinels(root: string) {
  assert.equal(fs.readFileSync(path.join(root, 'data/tags.json'), 'utf8'), 'aggregate sentinel');
  assert.equal(fs.readFileSync(path.join(root, 'data/tags-dictionary.json'), 'utf8'), 'dictionary sentinel');
}

test('dictionary rejects silent collisions and preserves explicitly resolved legacy IDs', () => {
  assert.throws(() => buildTagDictionary([sampleTag(), sampleTag('two', ' PARK ')]), /Unresolved duplicate/);
  const tags = [sampleTag(), { ...sampleTag('two', ' PARK '), cn: '另一个旧释义' }];
  const dictionary = buildTagDictionary(tags, { duplicates: { park: { canonical: 'one', members: ['one', 'two'] } } });
  assert.equal(dictionary.meanings.park, '公园');
  assert.equal(tags.length, 2, 'old IDs are not deleted from source or aggregate');
  assert.throws(() => buildTagDictionary([...tags, sampleTag('three')], { duplicates: { park: { canonical: 'one', members: ['one', 'two'] } } }), /Unresolved duplicate/);
  assert.throws(() => buildTagDictionary([{ ...sampleTag(), aliases: ['common'] }, { ...sampleTag('two', 'library'), aliases: ['common'] }]), /Ambiguous tag alias/);
});

test('tag fields, duplicate IDs, reserved keys and dangling related IDs fail closed', () => {
  const bad = [
    { ...sampleTag(), en: '' }, { ...sampleTag(), cn: 1 }, { ...sampleTag(), weight: NaN },
    { ...sampleTag(), aliases: [42] }, { ...sampleTag(), en: '__proto__' },
    { ...sampleTag(), related: ['missing'] },
  ];
  for (const tag of bad) assert.throws(() => buildTagDictionary([tag as TagEntry]));
  assert.throws(() => buildTagDictionary([sampleTag(), sampleTag()]), /Duplicate tag ID/);
});

test('schema/category/count/filename failures precede all aggregate writes', t => {
  const f = tagFixture(t);
  for (const invalid of [
    { version: 2, category: 'Scene', tags: [sampleTag()] },
    { version: 1, category: 'Camera', tags: [sampleTag()] },
    { version: 1, category: 'Scene', tags: [] },
    { version: 1, category: 'Scene', tags: [{ ...sampleTag(), cat: 'Camera' }] },
  ]) {
    f.write('data/tags/scene.json', invalid);
    assert.notEqual(runTag(f.root).status, 0);
    sentinels(f.root);
  }
  for (const file of ['../outside.json', '..\\outside.json', '/tmp/outside.json', 'C:\\outside.json', 'manifest.json', 'NUL.json']) {
    f.write('data/tags/manifest.json', { version: 1, files: [{ file, category: 'Scene', count: 1 }] });
    const result = runTag(f.root);
    assert.notEqual(result.status, 0, file);
    assert.match(result.stderr, /Unsafe tag shard filename/);
    sentinels(f.root);
  }
});

test('linked source and output paths are rejected without changing previous products', t => {
  const f = tagFixture(t);
  const target = path.join(f.root, 'source.json');
  fs.copyFileSync(path.join(f.root, 'data/tags/scene.json'), target);
  fs.unlinkSync(path.join(f.root, 'data/tags/scene.json'));
  fs.symlinkSync(target, path.join(f.root, 'data/tags/scene.json'));
  assert.match(runTag(f.root).stderr, /symbolic link/);
  sentinels(f.root);
  fs.unlinkSync(path.join(f.root, 'data/tags/scene.json'));
  fs.copyFileSync(target, path.join(f.root, 'data/tags/scene.json'));
  const output = path.join(f.root, 'data/tags-dictionary.json');
  fs.renameSync(output, path.join(f.root, 'old-dictionary'));
  fs.symlinkSync(path.join(f.root, 'old-dictionary'), output);
  assert.match(runTag(f.root).stderr, /symbolic link/);
  sentinels(f.root);
});

test('aggregate and dictionary publish together and a second rename failure rolls back', t => {
  const f = tagFixture(t);
  const original = fs.renameSync;
  let calls = 0;
  fs.renameSync = (from, to) => {
    calls += 1;
    if (calls === 2) throw new Error('injected second publication failure');
    original(from, to);
  };
  try {
    assert.throws(() => writeTagFiles(f.root, [
      { path: path.join(f.root, 'data/tags.json'), content: 'new aggregate' },
      { path: path.join(f.root, 'data/tags-dictionary.json'), content: 'new dictionary' },
    ]), /injected/);
  } finally { fs.renameSync = original; }
  sentinels(f.root);
  assert.ok(!fs.readdirSync(path.join(f.root, 'data')).some(file => file.endsWith('.tmp')));
  assert.equal(runTag(f.root).status, 0);
  const aggregate = JSON.parse(fs.readFileSync(path.join(f.root, 'data/tags.json'), 'utf8'));
  assert.deepEqual(aggregate, [sampleTag()]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'data/tags-dictionary.json'), 'utf8')).meanings.park, '公园');
});

test('reverse split validates paths and category slug collisions before touching shards', t => {
  const f = tagFixture(t);
  const before = fs.readFileSync(path.join(f.root, 'data/tags/scene.json'));
  f.write('data/tags.json', [{ ...sampleTag(), cat: 'A B' }, { ...sampleTag('two', 'library'), cat: 'A-B' }]);
  assert.match(runTag(f.root, 'writeTagShards').stderr, /Duplicate tag shard file/);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'data/tags/scene.json')), before);
  f.write('data/tags/manifest.json', { version: 1, files: [{ file: '../outside.json', category: 'Scene', count: 1 }] });
  assert.match(runTag(f.root, 'writeTagShards').stderr, /Unsafe tag shard filename/);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'data/tags/scene.json')), before);
});


test('direct aggregate rebuild invalidates both products compressed siblings', t => {
  const f = tagFixture(t);
  for (const product of ['tags.json', 'tags-dictionary.json']) {
    for (const suffix of ['.gz', '.br']) fs.writeFileSync(path.join(f.root, 'data', product + suffix), 'old compressed bytes');
  }
  assert.equal(runTag(f.root).status, 0);
  for (const product of ['tags.json', 'tags-dictionary.json']) {
    for (const suffix of ['.gz', '.br']) assert.equal(fs.existsSync(path.join(f.root, 'data', product + suffix)), false);
  }
});
