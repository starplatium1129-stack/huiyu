import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
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
  assert.strictEqual(tags.length, 624, 'Total tags must be 624');

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
