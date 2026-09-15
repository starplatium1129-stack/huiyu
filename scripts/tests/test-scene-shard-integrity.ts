'use strict';

/** 场景分片完整性独立守卫：不复用 scripts/lib/scene-store.js 的分组逻辑，
 *  直接断言生成物之间的不变量。scenes:build --check 用同一套函数推导期望值，
 *  分组函数自身回归（如 groupBrowserShards 丢出去重守卫）时自检无法发现，
 *  本文件作为独立 oracle 补上这一盲区。
 *
 *  设计约定（勿"修复"为重复删除）：scenes-core.json 是 curation.json
 *  personaCoreSceneIds 驱动的人格核心精选层，条目允许与浏览器分片重叠；
 *  三个浏览器分片（nene/natsume/shared）之间必须互斥且并集等于聚合 scenes.json。 */
const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const test: typeof import('node:test') = require('node:test');

const dataDir = path.resolve(__dirname, '..', '..', 'data');

function readJson(name: string) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
}

test('scene shards: browser shards are mutually disjoint', () => {
  const seen = new Map();
  for (const name of ['scenes-nene.json', 'scenes-natsume.json', 'scenes-shared.json']) {
    for (const scene of readJson(name)) {
      assert.ok(!seen.has(scene.id),
        `${scene.id} appears in both ${seen.get(scene.id)} and ${name}`);
      seen.set(scene.id, name);
    }
  }
});

test('scene shards: browser shard union equals the aggregate', () => {
  const aggregate = readJson('scenes.json');
  const unionIds = new Set([
    ...readJson('scenes-nene.json').map((s: { id: unknown; }) => s.id),
    ...readJson('scenes-natsume.json').map((s: { id: unknown; }) => s.id),
    ...readJson('scenes-shared.json').map((s: { id: unknown; }) => s.id),
  ]);
  const aggregateIds = aggregate.map((s: { id: unknown; }) => s.id);
  assert.strictEqual(new Set(aggregateIds).size, aggregateIds.length,
    'aggregate scenes.json must not contain duplicate ids');
  assert.deepStrictEqual(unionIds, new Set(aggregateIds),
    'browser shard union must cover exactly the aggregate id set');
});

test('scene shards: core tier is a curated subset backed by curation', () => {
  const aggregateIds = new Set(readJson('scenes.json').map((s: { id: unknown; }) => s.id));
  const browserIds = new Set([
    ...readJson('scenes-nene.json').map((s: { id: unknown; }) => s.id),
    ...readJson('scenes-natsume.json').map((s: { id: unknown; }) => s.id),
    ...readJson('scenes-shared.json').map((s: { id: unknown; }) => s.id),
  ]);
  const coreIds = readJson('scenes-core.json').map((s: { id: unknown; }) => s.id);
  const curationIds = readJson('curation.json').personaCoreSceneIds || [];
  assert.deepStrictEqual(coreIds, curationIds.filter((id: unknown) => aggregateIds.has(id)),
    'scenes-core.json must equal personaCoreSceneIds ∩ aggregate');
  for (const id of coreIds) {
    assert.ok(browserIds.has(id),
      `core tier id ${id} must also exist in a browser shard`);
  }
});

test('scene shards: core tier obeys first-paint policy', () => {
  // 政策级断言（区别于上面的一致性断言）：一致性 oracle 只保证产物互洽，
  // 这里把 curation 的策划纪律变成可检查规则。调整阈值 = 修改政策，需评审。
  const aggregate = readJson('scenes.json');
  const aggregateIds = new Set(aggregate.map((s: { id: unknown; }) => s.id));
  const curationIds = readJson('curation.json').personaCoreSceneIds || [];
  const core = readJson('scenes-core.json');

  // 1) 意图不静默丢失：build 侧对 personaCoreSceneIds 做 filter(byId.has)，
  //    失效引用会被无声吞掉——这里要求每个引用都真实存在。
  const staleRefs = curationIds.filter((id: unknown) => !aggregateIds.has(id));
  assert.deepStrictEqual(staleRefs, [],
    'curation.json personaCoreSceneIds 引用了不存在的场景 id（失效引用不得静默过滤，请清理 curation）');

  // 2) 首屏预算：core 层是首屏精选，条数与体积双上限，防止无痛膨胀。
  assert.ok(core.length <= 16,
    `core 层 ${core.length} 条超出上限 16 —— 精简 curation.json personaCoreSceneIds`);
  const coreBytes = fs.statSync(path.join(dataDir, 'scenes-core.json')).size;
  assert.ok(coreBytes <= 48 * 1024,
    `scenes-core.json ${coreBytes}B 超出首屏预算 48KiB —— 精简 personaCoreSceneIds`);

  // 3) 角色覆盖：聚合中出现的每个角色（含 triad 双人场景）在 core 层至少 1 条。
  //    名单从数据动态推导而非硬编码——新增角色时本断言自动强制策划回顾。
  const chars = new Set(aggregate.map((s: { char: unknown; }) => s.char).filter(Boolean));
  const coreChars = new Set(core.map((s: { char: unknown; }) => s.char));
  const uncovered = [...chars].filter((char) => !coreChars.has(char));
  assert.deepStrictEqual(uncovered, [],
    `以下角色在 core 层无任何场景，首屏精选未覆盖: ${uncovered.join(', ')} —— 在 curation.json personaCoreSceneIds 补充`);
});

test('scene shards: scenes-index.json mirrors the generated files', () => {
  const index = readJson('scenes-index.json');
  const aggregate = readJson('scenes.json');
  const coreIds = readJson('scenes-core.json').map((s: { id: unknown; }) => s.id);
  const counts = {
    nene: readJson('scenes-nene.json').length,
    natsume: readJson('scenes-natsume.json').length,
    shared: readJson('scenes-shared.json').length,
  };
  assert.strictEqual(index.version, 1);
  assert.strictEqual(index.total, aggregate.length);
  for (const [char, count] of Object.entries(counts)) {
    assert.strictEqual(index.shards[char].count, count,
      `index.shards.${char}.count must match the actual shard`);
  }
  assert.deepStrictEqual(index.orderedIds, aggregate.map((s: { id: unknown; }) => s.id));
  assert.deepStrictEqual(index.tiers.core, coreIds);
});
