'use strict';

import { PathOrFileDescriptor } from 'node:fs';

/**
 * 计划 006 D5 —— 场景写入侧治理的隔离夹具测试。
 *
 * 全程使用临时目录（AICS_DATA_ROOT 在 require 前固定），不触碰生产 data/。
 * 覆盖：稳定 ID 分配（退役不复用/容量上限）、源分片完整性（缺号/孤立/重复/
 * 归属）、增量写入（改动留原文件、满批新开批次、单文件升批、清空批保留）、
 * 保存副作用（退役登记/引用清理）与保存事务锁。
 */

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-scene-write-'));
process.env.AICS_DATA_ROOT = root;

const dataDir = path.join(root, 'data');
const shardsDir = path.join(dataDir, 'scenes');

const sceneWrite: typeof import('../../scripts/lib/scene-write') = require('../../scripts/lib/scene-write');
const store: typeof import('../../scripts/lib/scene-store') = require('../../scripts/lib/scene-store');

function scene(id: string, char: string, extra?: { category?: string; title?: string; }|undefined) {
  return Object.assign({ id, title: '场景 ' + id, char, category: '日常', rating: 'All' }, extra || {});
}

/** 小批次夹具：nene-core batchSize=3，nene-after-story 与 shared 为单文件形态。 */
function writeManifest() {
  const manifest = {
    version: 1,
    batchSize: 3,
    files: [
      { file: 'nene-core.json', label: '宁宁本篇', character: 'nene', series: 'core', batchSize: 3 },
      { file: 'nene-after-story.json', label: '宁宁After', character: 'nene', series: 'after_story' },
      { file: 'shared.json', label: '双人', character: 'triad', series: 'shared' },
    ],
  };
  fs.mkdirSync(shardsDir, { recursive: true });
  fs.writeFileSync(path.join(shardsDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

function resetFixture() {
  fs.rmSync(dataDir, { recursive: true, force: true });
  writeManifest();
  fs.writeFileSync(path.join(shardsDir, 'nene-core.1.json'), JSON.stringify(
    [scene('sc001', 'nene'), scene('sc002', 'nene'), scene('sc003', 'nene')], null, 2) + '\n');
  fs.writeFileSync(path.join(shardsDir, 'nene-core.2.json'), JSON.stringify(
    [scene('sc004', 'nene')], null, 2) + '\n');
  fs.writeFileSync(path.join(shardsDir, 'nene-after-story.json'), JSON.stringify(
    [scene('sc010', 'nene', { category: 'After_Story' })], null, 2) + '\n');
  fs.writeFileSync(path.join(shardsDir, 'shared.json'), JSON.stringify(
    [scene('sc020', 'triad')], null, 2) + '\n');
}

function readShard(file: string) {
  return JSON.parse(fs.readFileSync(path.join(shardsDir, file), 'utf8'));
}

function loadPrevious() {
  return store.loadSceneShards();
}

test('allocateSceneId 跳过活跃与退役 ID，绝不复用旧身份', () => {
  assert.equal(sceneWrite.allocateSceneId(['sc001', 'sc003'], new Set(['sc002'])), 'sc004');
  assert.equal(sceneWrite.allocateSceneId([], new Set(['sc001', 'sc099'])), 'sc100');
  assert.equal(sceneWrite.allocateSceneId(['sc005'], new Set()), 'sc006');
});

test('planOnly discovers exact new batches without changing source files or loaded data', () => {
  resetFixture();
  const previous = loadPrevious();
  const before = Object.fromEntries(fs.readdirSync(shardsDir).map(name => [name, fs.readFileSync(path.join(shardsDir, name), 'utf8')]));
  const sourceBefore = JSON.stringify(previous);
  const incoming = [...previous.scenes, scene('sc021', 'nene'), scene('sc022', 'nene'), scene('sc023', 'nene')];
  const planned = sceneWrite.applySceneChanges(incoming, previous, { planOnly: true });
  assert.ok(planned.touchedFiles.includes('nene-core.3.json'));
  assert.deepEqual(Object.fromEntries(fs.readdirSync(shardsDir).map(name => [name, fs.readFileSync(path.join(shardsDir, name), 'utf8')])), before);
  assert.equal(JSON.stringify(previous), sourceBefore);
  const applied = sceneWrite.applySceneChanges(incoming, previous);
  assert.deepEqual(applied, planned);
});

test('allocateSceneId 兼容 sc999 后续编号并拒绝安全整数溢出', () => {
  assert.equal(sceneWrite.allocateSceneId(['sc999'], new Set()), 'sc1000');
  assert.equal(sceneWrite.allocateSceneId(['sc999'], new Set(['sc1000'])), 'sc1001');
  assert.throws(() => sceneWrite.allocateSceneId(['sc9007199254740991'], new Set()), /安全整数上限/);
  assert.throws(() => sceneWrite.allocateSceneId(['sc0001'], new Set()), /不规范/);
});

test('readRetiredSceneIds 仅缺失可为空，损坏清单必须阻止分配', () => {
  resetFixture();
  assert.deepEqual([...sceneWrite.readRetiredSceneIds(dataDir)], []);
  for (const content of ['{', '{}', '{"records":{}}', '{"records":[null]}']) {
    fs.writeFileSync(path.join(dataDir, 'retired-scenes.json'), content);
    assert.throws(() => sceneWrite.readRetiredSceneIds(dataDir), /retired-scenes/);
  }
});

test('verifyShardIntegrity 单文件存在也必须识别缺失首批的孤立分片', () => {
  resetFixture();
  fs.writeFileSync(path.join(shardsDir, 'shared.2.json'), '[]\n');
  const result = sceneWrite.verifyShardIntegrity();
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('shared') && p.includes('缺号 .1')));
});

test('verifyShardIntegrity 拒绝非规范批号与无效 manifest 路径、重复声明', () => {
  for (const suffix of ['0', '01']) {
    resetFixture();
    fs.writeFileSync(path.join(shardsDir, 'nene-core.' + suffix + '.json'), '[]\n');
    assert.equal(sceneWrite.verifyShardIntegrity().ok, false, suffix);
  }
  for (const file of ['../outside.json', 'nested/file.json', 'nested\\file.json', 'shared.json']) {
    resetFixture();
    const manifest = JSON.parse(fs.readFileSync(path.join(shardsDir, 'manifest.json'), 'utf8'));
    manifest.files.push({ file });
    fs.writeFileSync(path.join(shardsDir, 'manifest.json'), JSON.stringify(manifest));
    assert.equal(sceneWrite.verifyShardIntegrity().ok, false, file);
  }
});

test('applySceneChanges 共享入口拒绝截断数据，且不写入任何文件', () => {
  resetFixture();
  fs.renameSync(path.join(shardsDir, 'nene-core.2.json'), path.join(shardsDir, 'nene-core.3.json'));
  const previous = loadPrevious(); // 现有读取器会截断在 .1。
  const before = Object.fromEntries(fs.readdirSync(shardsDir)
    .map((file) => [file, fs.readFileSync(path.join(shardsDir, file), 'utf8')]));
  assert.throws(() => sceneWrite.applySceneChanges(previous.scenes, previous), /分片完整性/);
  assert.deepEqual(Object.fromEntries(fs.readdirSync(shardsDir)
    .map((file) => [file, fs.readFileSync(path.join(shardsDir, file), 'utf8')])), before);
});

test('applySceneChanges 单文件升批后仍可修改、迁移和下架旧场景', () => {
  for (const operation of ['edit', 'move', 'remove']) {
    resetFixture();
    const previous = loadPrevious();
    const incoming = [scene('sc021', 'triad'), scene('sc022', 'triad'), scene('sc023', 'triad'),
      ...previous.scenes.filter((s) => s.id !== 'sc020')];
    if (operation !== 'remove') incoming.push(scene('sc020', operation === 'move' ? 'nene' : 'triad', { title: '更新' }));
    sceneWrite.applySceneChanges(incoming, previous);
    assert.deepEqual(loadPrevious().scenes, store.sortScenes(incoming));
    assert.equal(sceneWrite.verifyShardIntegrity().ok, true);
  }
});

test('verifyShardIntegrity 健康夹具无告警', () => {
  resetFixture();
  const result = sceneWrite.verifyShardIntegrity();
  assert.deepEqual(result, { ok: true, problems: [] });
});

test('verifyShardIntegrity 缺号且其后仍有分片 = 读取截断风险', () => {
  resetFixture();
  fs.rmSync(path.join(shardsDir, 'nene-core.2.json'));
  fs.writeFileSync(path.join(shardsDir, 'nene-core.3.json'), JSON.stringify([scene('sc009', 'nene')], null, 2) + '\n');
  const { ok, problems } = sceneWrite.verifyShardIntegrity();
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('nene-core') && p.includes('缺号 .2')), problems.join('; '));
});

test('verifyShardIntegrity 清空批留下的空文件不算缺号', () => {
  resetFixture();
  fs.writeFileSync(path.join(shardsDir, 'nene-core.2.json'), '[]\n');
  const { ok } = sceneWrite.verifyShardIntegrity();
  assert.equal(ok, true);
});

test('verifyShardIntegrity 单文件与批次并存会被展开逻辑忽略', () => {
  resetFixture();
  // shared.json 声明为单文件，但目录里同时出现 shared.1.json
  fs.writeFileSync(path.join(shardsDir, 'shared.1.json'), JSON.stringify([scene('sc021', 'triad')], null, 2) + '\n');
  const { ok, problems } = sceneWrite.verifyShardIntegrity();
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('单文件与批次文件并存')), problems.join('; '));
});

test('verifyShardIntegrity 未声明文件与重复 ID、归属冲突', () => {
  resetFixture();
  fs.writeFileSync(path.join(shardsDir, 'stray.json'), '[]\n');
  const shardA = readShard('nene-core.2.json');
  shardA.push(scene('sc020', 'triad')); // 与 shared.json 重复
  shardA.push(scene('sc099', 'natsume')); // 归属冲突
  fs.writeFileSync(path.join(shardsDir, 'nene-core.2.json'), JSON.stringify(shardA, null, 2) + '\n');
  const { ok, problems } = sceneWrite.verifyShardIntegrity();
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('stray.json')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('sc020 同时出现')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('sc099') && p.includes('不一致')), problems.join('; '));
});

test('applySceneChanges 无变更时不写任何分片', () => {
  resetFixture();
  const previous = loadPrevious();
  const before = Object.fromEntries(fs.readdirSync(shardsDir)
    .filter((f) => f.endsWith('.json')).map((f) => [f, fs.readFileSync(path.join(shardsDir, f), 'utf8')]));
  const changes = sceneWrite.applySceneChanges(previous.scenes, previous, { retiredIds: new Set() });
  assert.deepEqual(changes, { addedIds: [], updatedIds: [], removedIds: [], touchedFiles: [] });
  for (const [file, content] of Object.entries(before)) {
    assert.equal(fs.readFileSync(path.join(shardsDir, file), 'utf8'), content, file + ' 必须保持字节不变');
  }
});

test('applySceneChanges 修改留在原文件，其他分片字节不变', () => {
  resetFixture();
  const previous = loadPrevious();
  const before = Object.fromEntries(fs.readdirSync(shardsDir)
    .filter((f) => f.endsWith('.json')).map((f) => [f, fs.readFileSync(path.join(shardsDir, f), 'utf8')]));
  const incoming = previous.scenes.map((s) => JSON.parse(JSON.stringify(s)));
  const target = incoming.find((s) => s.id === 'sc002');
  target.story = '修改后的故事';
  const changes = sceneWrite.applySceneChanges(incoming, previous, { retiredIds: new Set() });
  assert.deepEqual(changes.updatedIds, ['sc002']);
  assert.deepEqual(changes.touchedFiles, ['nene-core.1.json']);
  assert.deepEqual(readShard('nene-core.1.json').find((s: { id: string; }) => s.id === 'sc002').story, '修改后的故事');
  for (const [file, content] of Object.entries(before)) {
    if (file === 'nene-core.1.json') continue;
    assert.equal(fs.readFileSync(path.join(shardsDir, file), 'utf8'), content, file + ' 不应被重写');
  }
});

test('applySceneChanges 展示分类改名不迁移物理分组（After_Story 文字）', () => {
  resetFixture();
  const previous = loadPrevious();
  const incoming = previous.scenes.map((s) => JSON.parse(JSON.stringify(s)));
  // sc001 位于 nene-core.1.json，把分类文字改成含 After_Story 也不该搬文件
  incoming.find((s) => s.id === 'sc001').category = 'After_Story · 特别篇';
  const changes = sceneWrite.applySceneChanges(incoming, previous, { retiredIds: new Set() });
  assert.deepEqual(changes.touchedFiles, ['nene-core.1.json']);
  assert.ok(readShard('nene-core.1.json').some((s: { id: string; }) => s.id === 'sc001'));
});

test('applySceneChanges char 归属变化才跨组移动', () => {
  resetFixture();
  const previous = loadPrevious();
  const incoming = previous.scenes.map((s) => JSON.parse(JSON.stringify(s)));
  incoming.find((s) => s.id === 'sc001').char = 'triad';
  const changes = sceneWrite.applySceneChanges(incoming, previous, { retiredIds: new Set() });
  assert.equal(changes.updatedIds.includes('sc001'), true);
  assert.ok(changes.touchedFiles.includes('nene-core.1.json'));
  assert.ok(changes.touchedFiles.includes('shared.json'));
  assert.equal(readShard('nene-core.1.json').some((s: { id: string; }) => s.id === 'sc001'), false);
  assert.equal(readShard('shared.json').some((s: { id: string; }) => s.id === 'sc001'), true);
});

test('applySceneChanges 新增追加到组内最后批次，不满批不新开文件', () => {
  resetFixture();
  const previous = loadPrevious();
  const incoming = previous.scenes.map((s) => JSON.parse(JSON.stringify(s)));
  incoming.push(scene('sc005', 'nene')); // nene-core.2.json 现有 1/3
  const changes = sceneWrite.applySceneChanges(incoming, previous, { retiredIds: new Set() });
  assert.deepEqual(changes.addedIds, ['sc005']);
  assert.deepEqual(changes.touchedFiles, ['nene-core.2.json']);
  assert.deepEqual(readShard('nene-core.2.json').map((s: any) => s.id), ['sc004', 'sc005']);
});

test('applySceneChanges 批次满员新开下一批次', () => {
  resetFixture();
  const previous = loadPrevious();
  const incoming = previous.scenes.map((s) => JSON.parse(JSON.stringify(s)));
  incoming.push(scene('sc005', 'nene'), scene('sc006', 'nene'), scene('sc007', 'nene'));
  // nene-core.2.json 到 4 条超出 batchSize=3 → 新开 .3.json
  const changes = sceneWrite.applySceneChanges(incoming, previous, { retiredIds: new Set() });
  assert.deepEqual(changes.touchedFiles, ['nene-core.2.json', 'nene-core.3.json']);
  assert.deepEqual(readShard('nene-core.2.json').map((s: any) => s.id), ['sc004', 'sc005', 'sc006']);
  assert.deepEqual(readShard('nene-core.3.json').map((s: any) => s.id), ['sc007']);
});

test('applySceneChanges 单文件组满批升级为批次形态', () => {
  resetFixture();
  const previous = loadPrevious();
  const incoming = previous.scenes.map((s) => JSON.parse(JSON.stringify(s)));
  // shared.json 只有 1 条，但其 batchSize 继承 manifest 根级 3 → 填满再溢出
  incoming.push(scene('sc021', 'triad'), scene('sc022', 'triad'), scene('sc023', 'triad'));
  const changes = sceneWrite.applySceneChanges(incoming, previous, { retiredIds: new Set() });
  assert.equal(changes.addedIds.length, 3);
  assert.equal(fs.existsSync(path.join(shardsDir, 'shared.json')), false, '单文件必须被 .1 取代');
  assert.deepEqual(readShard('shared.1.json').map((s: any) => s.id), ['sc020', 'sc021', 'sc022']);
  assert.deepEqual(readShard('shared.2.json').map((s: any) => s.id), ['sc023']);
  // 升级后的目录仍是完整可读数据
  assert.equal(loadPrevious().scenes.length, incoming.length);
});

test('applySceneChanges 下架清空批次保留空文件，后续分片不被截断', () => {
  resetFixture();
  const previous = loadPrevious();
  const incoming = previous.scenes.filter((s) => !['sc001', 'sc002', 'sc003'].includes(s.id));
  const changes = sceneWrite.applySceneChanges(incoming, previous, { retiredIds: new Set() });
  assert.deepEqual(changes.removedIds, ['sc001', 'sc002', 'sc003']);
  assert.deepEqual(readShard('nene-core.1.json'), [], '清空批次保留为 []');
  assert.deepEqual(readShard('nene-core.2.json').map((s: any) => s.id), ['sc004']);
  assert.equal(loadPrevious().scenes.length, incoming.length);
});

test('applySceneChanges 拒绝复用已退役 ID', () => {
  resetFixture();
  const previous = loadPrevious();
  const incoming = previous.scenes.map((s) => JSON.parse(JSON.stringify(s)));
  incoming.push(scene('sc148', 'nene'));
  assert.throws(
    () => sceneWrite.applySceneChanges(incoming, previous, { retiredIds: new Set(['sc148']) }),
    /sc148.*retired-scenes/,
  );
});

test('retireRemovedScenes 登记退役并清样张', () => {
  resetFixture();
  const showcaseDir = path.join(root, 'showcase');
  fs.mkdirSync(path.join(showcaseDir, 'images'), { recursive: true });
  fs.mkdirSync(path.join(showcaseDir, 'thumbs'), { recursive: true });
  fs.writeFileSync(path.join(showcaseDir, 'images', 'sc002.jpg'), 'img');
  fs.writeFileSync(path.join(showcaseDir, 'thumbs', 'sc002.jpg'), 'thumb');
  fs.writeFileSync(path.join(showcaseDir, 'manifest.json'), JSON.stringify({
    version: 1, entryCount: 1, sceneCount: 1, entries: [{ id: 'sc002' }],
  }, null, 2) + '\n');
  const io = {
    readJson: (source: PathOrFileDescriptor) => JSON.parse(fs.readFileSync(source, 'utf8')),
    writeJson: (source: PathOrFileDescriptor, data: any) => fs.writeFileSync(source, JSON.stringify(data, null, 2) + '\n'),
    sanitizeCuration: (value: any) => value,
  };
  fs.writeFileSync(path.join(dataDir, 'retired-scenes.json'), JSON.stringify({ records: [] }, null, 2) + '\n');
  const previous = loadPrevious();
  const incoming = previous.scenes.filter((s) => s.id !== 'sc002');
  const added = sceneWrite.retireRemovedScenes({
    incomingScenes: incoming, previousScenes: previous.scenes,
    rootDir: root, showcaseDir, io,
  });
  assert.deepEqual(added, ['sc002']);
  const retired = JSON.parse(fs.readFileSync(path.join(dataDir, 'retired-scenes.json'), 'utf8'));
  assert.equal(retired.records[0].id, 'sc002');
  assert.equal(fs.existsSync(path.join(showcaseDir, 'images', 'sc002.jpg')), false);
  const showcaseManifest = JSON.parse(fs.readFileSync(path.join(showcaseDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(showcaseManifest.entries, []);
});

test('cleanOrphanedSceneRefs 清理失效引用且保留无关设置', () => {
  resetFixture();
  fs.writeFileSync(path.join(dataDir, 'characters.json'), JSON.stringify([
    { id: 'nene', lora: { recommended_scene: ['sc001', 'sc002', 'sc404'] } },
  ], null, 2) + '\n');
  fs.writeFileSync(path.join(dataDir, 'loras.json'), JSON.stringify([
    { id: 'lora-a', related_scenes: ['sc001', 'gone'] },
    { id: 'lora-b', scenes: ['sc004'] },
  ], null, 2) + '\n');
  fs.writeFileSync(path.join(dataDir, 'curation.json'), JSON.stringify({
    curatedSceneIds: ['sc001', 'missing'],
    signatureSceneIds: [],
    reviewSceneIds: [],
    recommendationReasons: { sc001: '理由', missing: '旧理由' },
  }, null, 2) + '\n');
  sceneWrite.cleanOrphanedSceneRefs({
    rootDir: root,
    io: {
      readJson: (source: PathOrFileDescriptor) => JSON.parse(fs.readFileSync(source, 'utf8')),
      writeJson: (source: PathOrFileDescriptor, data: any) => fs.writeFileSync(source, JSON.stringify(data, null, 2) + '\n'),
      sanitizeCuration: (value: any, activeIds: any) => {
        const curation = JSON.parse(JSON.stringify(value));
        curation.curatedSceneIds = curation.curatedSceneIds.filter((id: string) => activeIds.has(id));
        curation.recommendationReasons = Object.fromEntries(Object.entries(curation.recommendationReasons)
          .filter(([id]) => activeIds.has(id)));
        return curation;
      },
    },
  });
  const characters = JSON.parse(fs.readFileSync(path.join(dataDir, 'characters.json'), 'utf8'));
  assert.deepEqual(characters[0].lora.recommended_scene, ['sc001', 'sc002']);
  const loras = JSON.parse(fs.readFileSync(path.join(dataDir, 'loras.json'), 'utf8'));
  assert.deepEqual(loras[0].related_scenes, ['sc001']);
  assert.deepEqual(loras[1].scenes, ['sc004']);
  const curation = JSON.parse(fs.readFileSync(path.join(dataDir, 'curation.json'), 'utf8'));
  assert.deepEqual(curation.curatedSceneIds, ['sc001']);
  assert.deepEqual(Object.keys(curation.recommendationReasons), ['sc001']);
});

test('withSceneWriteLock 串行化并发写入且单个失败不阻塞后续', async () => {
  const order: any = [];
  const first = sceneWrite.withSceneWriteLock(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('first');
    return 'ok-first';
  });
  const second = sceneWrite.withSceneWriteLock(async () => {
    order.push('second');
    return 'ok-second';
  });
  const third = sceneWrite.withSceneWriteLock(async () => {
    order.push('third');
    throw new Error('boom');
  });
  const fourth = sceneWrite.withSceneWriteLock(async () => {
    order.push('fourth');
    return 'ok-fourth';
  });
  assert.equal(await first, 'ok-first');
  assert.equal(await second, 'ok-second');
  await assert.rejects(third, /boom/);
  assert.equal(await fourth, 'ok-fourth');
  assert.deepEqual(order, ['first', 'second', 'third', 'fourth']);
});
