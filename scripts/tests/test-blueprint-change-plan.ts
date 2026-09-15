'use strict';

// G12 蓝图分片变更纯规划器行为测试。
// 全部使用内存夹具与系统临时目录：不读生产数据、不改生产蓝图、不触发模型。
// 在 require 任何 store 模块前固定 AICS_DATA_ROOT，blueprint-store / popular-store
// 即使被加载也只会看到临时根，绝不触达仓库真实 data/。

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');

const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-g12-blueprint-plan-'));
process.env.AICS_DATA_ROOT = FIXTURE_ROOT;

const {
  planBlueprintChanges,
  BlueprintChangePlanError,
  franchiseSlug,
  jsonText,
}: typeof import('../lib/blueprint-change-plan') = require('../lib/blueprint-change-plan');

const FRIEREN = "Frieren: Beyond Journey's End";
const FRIEREN_FILE = 'frieren-beyond-journeys-end.json';
const FATE = 'Fate';
const FATE_FILE = 'fate.json';
const MARIN = 'My Dress-Up Darling';
const MARIN_FILE = 'my-dress-up-darling.json';

function bp(id: string, characterId: string|undefined, extra: { title: string; }|undefined) {
  return Object.assign({
    id,
    title: id,
    characterId,
    category: '测试',
    promptTokens: ['tag_' + id],
    negativeTokens: [],
    promptProse: id + ' 的提示词正文。',
  }, extra);
}

function baseState() {
  const frierenGroup = [bp('frieren_1', 'frieren', { title: '魔女旅人' }), bp('frieren_2', 'frieren')];
  const fateGroup = [bp('fate_1', 'saber')];
  const shards = {
    [FRIEREN_FILE]: { version: 2, franchise: FRIEREN, blueprints: frierenGroup },
    [FATE_FILE]: { version: 2, franchise: FATE, blueprints: fateGroup },
  };
  const manifest = {
    version: 1,
    description: '热门角色场景蓝图分片清单。每个 franchise 一个文件，合并为 data/scene-blueprints.json。',
    files: [
      { file: FRIEREN_FILE, franchise: FRIEREN, count: 2 },
      { file: FATE_FILE, franchise: FATE, count: 1 },
    ],
  };
  const mapping = { frieren: FRIEREN, saber: FATE, marin: MARIN, holo: 'hololive' };
  return { manifest, shards, target: [...frierenGroup, ...fateGroup], mapping };
}

function shardInputs(shards: { [s: string]: unknown; }|ArrayLike<unknown>, textOverrides: { "fate.json": string; }|undefined) {
  const out = {};
  for (const [file, data] of Object.entries(shards)) {
    out[file] = {
      text: (textOverrides && textOverrides[file]) || jsonText(data),
      data,
    };
  }
  return out;
}

function plan(state: { manifest: unknown; shards: unknown; target: unknown; mapping: unknown; }, target: unknown, textOverrides: { "fate.json": string; }|undefined) {
  return planBlueprintChanges({
    manifest: state.manifest,
    shards: shardInputs(state.shards, textOverrides),
    blueprints: target === undefined ? state.target : target,
    franchiseByCharacter: state.mapping,
  });
}

function planError(fn, substring: string|undefined) {
  assert.throws(fn, (error) => error instanceof BlueprintChangePlanError
    && (substring === undefined || error.message.includes(substring)),
  substring || 'BlueprintChangePlanError');
}

function deepFreeze(value: { [x: string]: unknown; frieren?: string; saber?: string; marin?: string; holo?: string; }) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

test('franchiseSlug 本地副本与 popular-store 原函数对拍，防止规则漂移', () => {
  const { franchiseSlug: storeSlug }: typeof import('../lib/popular-store') = require('../lib/popular-store');
  for (const value of [
    FRIEREN, 'Genshin Impact', 'VOCALOID', MARIN,
    '2.5-Dimensional Seduction', '', null, undefined, "A'B", 'A  B--C!!',
  ]) {
    assert.equal(franchiseSlug(value), storeSlug(value), String(value));
  }
});

test('目标与当前状态一致：零写计划，unchanged 覆盖全部分片', () => {
  const state = baseState();
  const p = plan(state);
  assert.equal(p.dirty, false);
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.deletes, []);
  assert.deepEqual(p.unchanged, [
    { file: FRIEREN_FILE, franchise: FRIEREN, count: 2 },
    { file: FATE_FILE, franchise: FATE, count: 1 },
  ]);
  assert.equal(p.manifest.changed, false);
  assert.equal(p.aggregate.text, jsonText({ version: 2, blueprints: state.target }));
  assert.deepEqual(p.summary, { writes: 0, deletes: 0, unchanged: 2, blueprints: 3, franchises: 2 });
});

test('未变化分片保留原始字节：格式不同的原始文本不触发重写', () => {
  const state = baseState();
  const reformatted = JSON.stringify(state.shards[FATE_FILE], null, 4);
  assert.notEqual(reformatted, jsonText(state.shards[FATE_FILE]));
  const p = plan(state, undefined, { [FATE_FILE]: reformatted });
  assert.ok(p.unchanged.some((u) => u.file === FATE_FILE));
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.deletes, []);
});

test('修改单条蓝图：只写对应分片，组内顺序与字段保留，manifest 计数不变', () => {
  const state = baseState();
  const target = state.target.map((item) => item.id === 'frieren_1' ? { ...item, title: '新标题' } : item);
  const p = plan(state, target);
  assert.equal(p.dirty, true);
  assert.deepEqual(p.writes.map((w) => [w.file, w.kind, w.count]), [[FRIEREN_FILE, 'update', 2]]);
  assert.deepEqual(p.unchanged.map((u) => u.file), [FATE_FILE]);
  assert.deepEqual(p.deletes, []);
  assert.equal(p.manifest.changed, false);
  const shard = JSON.parse(p.writes[0].text);
  assert.equal(shard.version, 2);
  assert.equal(shard.franchise, FRIEREN);
  assert.deepEqual(shard.blueprints.map((b: { id: unknown; }) => b.id), ['frieren_1', 'frieren_2']);
  assert.equal(shard.blueprints[0].title, '新标题');
  assert.equal(shard.blueprints[1].title, 'frieren_2');
  assert.equal(p.writes[0].text, jsonText(shard));
  assert.equal(p.aggregate.text, jsonText({ version: 2, blueprints: target }));
});

test('新增系列：slug 命名、manifest 追加、聚合按 manifest 顺序拼接', () => {
  const state = baseState();
  const target = [...state.target, bp('marin_1', 'marin')];
  const p = plan(state, target);
  const create = p.writes.find((w) => w.kind === 'create');
  assert.equal(create.file, MARIN_FILE);
  assert.equal(create.franchise, MARIN);
  assert.equal(create.count, 1);
  assert.deepEqual(p.manifest.data.files.map((f: { file: unknown; }) => f.file), [FRIEREN_FILE, FATE_FILE, MARIN_FILE]);
  assert.deepEqual(p.manifest.data.files[2], { file: MARIN_FILE, franchise: MARIN, count: 1 });
  assert.equal(p.manifest.changed, true);
  assert.deepEqual(p.aggregate.data.blueprints.map((b) => b.id),
    ['frieren_1', 'frieren_2', 'fate_1', 'marin_1']);
  assert.deepEqual(p.deletes, []);
  assert.deepEqual(p.unchanged.map((u) => u.file), [FRIEREN_FILE, FATE_FILE]);
});

test('多个新系列按目标首次出现顺序追加；既有系列顺序不受目标顺序影响', () => {
  const state = baseState();
  const target = [...state.target, bp('h1', 'holo'), bp('m1', 'marin')];
  const p = plan(state, target);
  assert.deepEqual(p.manifest.data.files.map((f: { file: unknown; }) => f.file),
    [FRIEREN_FILE, FATE_FILE, 'hololive.json', MARIN_FILE]);

  const reversed = [...state.target].reverse();
  const p2 = plan(state, reversed);
  assert.deepEqual(p2.manifest.data.files.map((f: { file: unknown; }) => f.file), [FRIEREN_FILE, FATE_FILE]);
  // 组内顺序以目标为准：frieren 组反转为写；fate 组只有单条，组内顺序不变则不写
  assert.deepEqual(p2.writes.map((w) => w.file), [FRIEREN_FILE]);
  assert.deepEqual(p2.unchanged.map((u) => u.file), [FATE_FILE]);
  assert.deepEqual(JSON.parse(p2.writes[0].text).blueprints.map((b: { id: unknown; }) => b.id), ['frieren_2', 'frieren_1']);
});

test('删除组内一条是重写；删除最后一条是删片并移除 manifest 项', () => {
  const state = baseState();
  const partial = plan(state, state.target.filter((b) => b.id !== 'frieren_2'));
  assert.deepEqual(partial.deletes, []);
  assert.deepEqual(partial.writes.map((w) => [w.file, w.count]), [[FRIEREN_FILE, 1]]);
  assert.deepEqual(partial.manifest.data.files.map((f: { file: unknown; count: unknown; }) => [f.file, f.count]),
    [[FRIEREN_FILE, 1], [FATE_FILE, 1]]);
  assert.deepEqual(partial.unchanged.map((u) => u.file), [FATE_FILE]);

  const emptied = plan(state, state.target.filter((b) => b.id !== 'fate_1'));
  assert.deepEqual(emptied.deletes, [{ file: FATE_FILE, franchise: FATE }]);
  assert.deepEqual(emptied.manifest.data.files.map((f: { franchise: unknown; }) => f.franchise), [FRIEREN]);
  assert.deepEqual(emptied.aggregate.data.blueprints.map((b) => b.id), ['frieren_1', 'frieren_2']);
  assert.equal(emptied.manifest.changed, true);
  assert.equal(emptied.dirty, true);
});

test('跨系列移动：旧片移除、新片加入；旧系列清空时删片', () => {
  const state = baseState();
  const moved = state.target.map((b) => b.id === 'frieren_2' ? { ...b, characterId: 'saber' } : b);
  const p = plan(state, moved);
  assert.deepEqual(p.deletes, []);
  assert.deepEqual(p.writes.map((w) => w.file), [FRIEREN_FILE, FATE_FILE]);
  assert.deepEqual(JSON.parse(p.writes[0].text).blueprints.map((b: { id: unknown; }) => b.id), ['frieren_1']);
  assert.deepEqual(JSON.parse(p.writes[1].text).blueprints.map((b: { id: unknown; }) => b.id), ['frieren_2', 'fate_1']);
  assert.deepEqual(p.manifest.data.files.map((f: { file: unknown; count: unknown; }) => [f.file, f.count]),
    [[FRIEREN_FILE, 1], [FATE_FILE, 2]]);

  const allOut = [
    ...state.target.filter((b) => b.id !== 'fate_1'),
    { ...state.target[2], characterId: 'frieren' },
  ];
  const p2 = plan(state, allOut);
  assert.deepEqual(p2.deletes, [{ file: FATE_FILE, franchise: FATE }]);
  assert.deepEqual(p2.writes.map((w) => w.file), [FRIEREN_FILE]);
  assert.deepEqual(JSON.parse(p2.writes[0].text).blueprints.map((b: { id: unknown; }) => b.id),
    ['frieren_1', 'frieren_2', 'fate_1']);
});

test('manifest 陈旧计数被精确修正且扩展字段保留；此时 dirty 但分片零写', () => {
  const state = baseState();
  state.manifest.files[0].count = 99;
  state.manifest.files[0].note = '保留我';
  const p = plan(state);
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.deletes, []);
  assert.deepEqual(p.unchanged.map((u) => u.file), [FRIEREN_FILE, FATE_FILE]);
  assert.equal(p.manifest.changed, true);
  assert.equal(p.dirty, true);
  assert.equal(p.manifest.data.files[0].count, 2);
  assert.equal(p.manifest.data.files[0].note, '保留我');
  assert.equal(p.manifest.data.description, state.manifest.description);
  assert.equal(p.manifest.data.version, 1);
});

test('bootstrap：空 manifest 与空 shards 可以规划出首个系列', () => {
  const state = baseState();
  const solo = bp('solo_1', 'marin');
  const p = planBlueprintChanges({
    manifest: { version: 1, description: '引导态', files: [] },
    shards: {},
    blueprints: [solo],
    franchiseByCharacter: state.mapping,
  });
  assert.deepEqual(p.manifest.data.files, [{ file: MARIN_FILE, franchise: MARIN, count: 1 }]);
  assert.deepEqual(p.writes.map((w) => [w.file, w.kind]), [[MARIN_FILE, 'create']]);
  assert.deepEqual(p.deletes, []);
  assert.equal(p.aggregate.text, jsonText({ version: 2, blueprints: [solo] }));
});

test('manifest 文件名校验：traversal/绝对路径/分隔符/保留名/非法基名全部拒绝', () => {
  const state = baseState();
  const badFiles = [
    '../evil.json', 'sub/evil.json', 'sub\\evil.json', 'C:\\evil.json', 'C:evil.json',
    'manifest.json', 'MANIFEST.JSON', '.hidden.json', 'no-ext', '带空格.json', '',
    'con.json', 'NUL.json', 'aux.backup.json', 'lpt1.extra.json',
  ];
  for (const file of badFiles) {
    planError(() => planBlueprintChanges({
      manifest: { version: 1, files: [{ file, franchise: 'X', count: 1 }] },
      shards: {},
      blueprints: [bp('x1', 'marin')],
      franchiseByCharacter: state.mapping,
    }));
  }
});

test('manifest 唯一性：大小写冲突、同名重复、franchise 重复声明拒绝', () => {
  const state = baseState();
  const manifestWith = (files: { file: string; franchise: string; count: number; }[]) => ({
    manifest: { version: 1, files },
    shards: {},
    blueprints: [bp('x1', 'marin')],
    franchiseByCharacter: state.mapping,
  });
  planError(() => planBlueprintChanges(manifestWith([
    { file: 'fate.json', franchise: 'A', count: 1 },
    { file: 'FATE.json', franchise: 'B', count: 1 },
  ])), 'Windows 大小写不敏感');
  planError(() => planBlueprintChanges(manifestWith([
    { file: 'fate.json', franchise: 'A', count: 1 },
    { file: 'fate.json', franchise: 'B', count: 1 },
  ])), '冲突');
  planError(() => planBlueprintChanges(manifestWith([
    { file: 'a.json', franchise: 'Same', count: 1 },
    { file: 'b.json', franchise: 'Same', count: 1 },
  ])), 'franchise 重复声明');
});

test('新系列冲突：与既有分片同名（大小写不敏感）、新系列互撞、unknown slug、保留设备名', () => {
  const state = baseState();
  const planWith = (blueprints: ({ id: string; title: string; characterId: string|undefined; category: string; promptTokens: string[]; negativeTokens: never[]; promptProse: string; }&{ title: string; })[], extraMapping: { fx?: string; ka?: string; kb?: string; mahou?: string; con?: string; }) => planBlueprintChanges({
    manifest: state.manifest,
    shards: shardInputs(state.shards),
    blueprints,
    franchiseByCharacter: { ...state.mapping, ...extraMapping },
  });
  planError(() => planWith([...state.target, bp('fx_1', 'fx')], { fx: 'FATE' }), FATE_FILE);
  planError(() => planWith(
    [...state.target, bp('ka_1', 'ka'), bp('kb_1', 'kb')],
    { ka: 'My Dress-Up Darling', kb: 'my dress up darling' },
  ), '冲突');
  planError(() => planWith([...state.target, bp('m1', 'mahou')], { mahou: '魔法少女' }), 'unknown');
  planError(() => planWith([...state.target, bp('c1', 'con')], { con: 'CON' }), '保留设备名');
});

test('未知角色与无法确认的 franchise 明确报错，不自动建 unknown 片', () => {
  const state = baseState();
  const planWithMapping = (mapping: string) => planBlueprintChanges({
    manifest: state.manifest,
    shards: shardInputs(state.shards),
    blueprints: [...state.target, bp('x1', 'megumin')],
    franchiseByCharacter: mapping,
  });
  planError(() => planWithMapping({ ...state.mapping }), 'megumin');
  planError(() => planWithMapping({ ...state.mapping, megumin: '' }), '无法确认 franchise');
  planError(() => planWithMapping({ ...state.mapping, megumin: 'unknown' }), '无法确认 franchise');
  planError(() => planWithMapping('not-a-map'), 'franchiseByCharacter');
  planError(() => plan(state, [bp('nochar', undefined)]), 'characterId');
  planError(() => plan(state, [state.target[0], state.target[0]]), '重复');
  planError(() => plan(state, [{ ...state.target[0], id: '   ' }]), '缺少非空字符串 id');
  planError(() => plan(state, [null]), '必须是对象');
  planError(() => plan(state, 'not-array'), '必须是数组');
  planError(() => plan(state, []), '空');
});

test('来源分片不齐全、多余分片、franchise 冲突、text/data 不一致、来源 id 问题均拒绝', () => {
  const state = baseState();
  const inputs = shardInputs(state.shards);
  const planWithShards = (shards: { "orphan.json"?: { text: string; data: { blueprints: never[]; }; }; "fate.json"?: { text: string; data: { version: number; franchise: string; blueprints: ({ id: string; title: string; characterId: string|undefined; category: string; promptTokens: string[]; negativeTokens: never[]; promptProse: string; }&{ title: string; })[]; }; }|{ text: string; data: { version: number; franchise: string; blueprints: ({ id: string; title: string; characterId: string|undefined; category: string; promptTokens: string[]; negativeTokens: never[]; promptProse: string; }&{ title: string; })[]; }; }|{ text: unknown; data: { version: number; franchise: string; blueprints: never[]; }; }|{ text: string; data: { blueprints: never[]; }; }|{ text: string; data: { version: number; franchise: string; blueprints: { characterId: string; }[]; }; }; }) => planBlueprintChanges({
    manifest: state.manifest,
    shards,
    blueprints: state.target,
    franchiseByCharacter: state.mapping,
  });

  const missing = { ...inputs };
  delete missing[FATE_FILE];
  planError(() => planWithShards(missing), '不齐全');

  planError(() => planWithShards({
    ...inputs,
    'orphan.json': { text: '{"blueprints":[]}', data: { blueprints: [] } },
  }), '未在 manifest 声明');

  const conflicted = { version: 2, franchise: 'FATE', blueprints: state.shards[FATE_FILE].blueprints };
  planError(() => planWithShards({
    ...inputs,
    [FATE_FILE]: { text: jsonText(conflicted), data: conflicted },
  }), 'franchise');

  planError(() => planWithShards({
    ...inputs,
    [FATE_FILE]: { text: inputs[FATE_FILE].text, data: { version: 2, franchise: FATE, blueprints: [] } },
  }), '不一致');

  planError(() => planWithShards({
    ...inputs,
    [FATE_FILE]: { text: '{oops', data: { blueprints: [] } },
  }), '合法 JSON');

  const duplicated = {
    ...inputs,
    [FATE_FILE]: {
      text: jsonText({ version: 2, franchise: FATE, blueprints: [...state.shards[FATE_FILE].blueprints, state.shards[FRIEREN_FILE].blueprints[0]] }),
      data: { version: 2, franchise: FATE, blueprints: [...state.shards[FATE_FILE].blueprints, state.shards[FRIEREN_FILE].blueprints[0]] },
    },
  };
  planError(() => planWithShards(duplicated), '同时出现');

  planError(() => planWithShards({
    ...inputs,
    [FATE_FILE]: {
      text: jsonText({ version: 2, franchise: FATE, blueprints: [{ characterId: 'saber' }] }),
      data: { version: 2, franchise: FATE, blueprints: [{ characterId: 'saber' }] },
    },
  }), '缺少非空字符串 id');
});

test('冻结输入：规划器不修改任何输入，输出与未冻结时一致', () => {
  const state = baseState();
  const target = state.target.map((item) => item.id === 'frieren_1' ? { ...item, title: '改' } : item);
  target.push(bp('marin_1', 'marin'));
  const baseline = plan(state, target);
  const frozen = planBlueprintChanges({
    manifest: deepFreeze(JSON.parse(JSON.stringify(state.manifest))),
    shards: deepFreeze(shardInputs(state.shards)),
    blueprints: deepFreeze(JSON.parse(JSON.stringify(target))),
    franchiseByCharacter: deepFreeze({ ...state.mapping }),
  });
  assert.equal(frozen.dirty, true);
  assert.deepEqual(JSON.parse(JSON.stringify(frozen)), JSON.parse(JSON.stringify(baseline)));
});

test('计划应用到内存后重读：manifest/分片/聚合一致，unchanged 分片字节不变', () => {
  const state = baseState();
  const target = [
    { ...state.target[0], title: '改' },
    state.target[1],
    bp('marin_1', 'marin'),
  ];
  const p = plan(state, target);
  const original = shardInputs(state.shards);
  const files = new Map(Object.entries(original).map(([file, shard]) => [file, shard.text]));
  for (const d of p.deletes) files.delete(d.file);
  for (const w of p.writes) files.set(w.file, w.text);

  const manifest = JSON.parse(p.manifest.text);
  const union = [];
  for (const entry of manifest.files) {
    assert.ok(files.has(entry.file), entry.file + ' 应存在于应用后的内存文件集');
    const data = JSON.parse(files.get(entry.file));
    assert.equal(data.franchise, entry.franchise);
    assert.equal(data.blueprints.length, entry.count);
    union.push(...data.blueprints);
  }
  assert.deepEqual(union.map((b) => b.id), ['frieren_1', 'frieren_2', 'marin_1']);
  assert.equal(jsonText({ version: 2, blueprints: union }), p.aggregate.text);
  assert.ok(!files.has(FATE_FILE));
  assert.deepEqual(p.unchanged.map((u) => u.file), []);
  const frierenWrite = p.writes.find((w) => w.file === FRIEREN_FILE);
  assert.ok(frierenWrite, 'frieren 组内容已变化，应出现在 writes 中');
  assert.equal(files.get(FRIEREN_FILE), frierenWrite.text);
});

test('落盘夹具上真实 blueprint-store 对账：聚合字节一致，重规划收敛为零写', (t) => {
  const shardsDir = path.join(FIXTURE_ROOT, 'data', 'blueprints');
  fs.mkdirSync(shardsDir, { recursive: true });
  t.after(() => fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

  const state = baseState();
  for (const [file, data] of Object.entries(state.shards)) {
    fs.writeFileSync(path.join(shardsDir, file), jsonText(data));
  }
  fs.writeFileSync(path.join(shardsDir, 'manifest.json'), jsonText(state.manifest));

  const store: typeof import('../lib/blueprint-store') = require('../lib/blueprint-store');
  assert.equal(jsonText({ a: 1 }), store.jsonText({ a: 1 }), 'jsonText 格式与 store 一致');
  store.writeBlueprintAggregate();
  assert.equal(store.aggregateIsCurrent(), true);

  const target = [
    { ...state.target[0], title: '落盘修改' },
    state.target[1],
    bp('marin_1', 'marin'),
  ];
  const p = plan(state, target);
  assert.equal(p.dirty, true);
  for (const d of p.deletes) fs.unlinkSync(path.join(shardsDir, d.file));
  for (const w of p.writes) fs.writeFileSync(path.join(shardsDir, w.file), w.text);
  fs.writeFileSync(path.join(shardsDir, 'manifest.json'), p.manifest.text);

  const loaded = store.loadBlueprintShards();
  assert.deepEqual(loaded.blueprints.map((b: { id: unknown; }) => b.id), target.map((b) => b.id));
  store.writeBlueprintAggregate();
  assert.equal(fs.readFileSync(store.aggregatePath, 'utf8'), p.aggregate.text);
  assert.equal(store.aggregateIsCurrent(), true);
  for (const w of p.writes) {
    assert.equal(fs.readFileSync(path.join(shardsDir, w.file), 'utf8'), w.text);
  }

  const manifest2 = JSON.parse(fs.readFileSync(path.join(shardsDir, 'manifest.json'), 'utf8'));
  const shards2 = {};
  for (const entry of manifest2.files) {
    const text2 = fs.readFileSync(path.join(shardsDir, entry.file), 'utf8');
    shards2[entry.file] = { text: text2, data: JSON.parse(text2) };
  }
  const p2 = planBlueprintChanges({
    manifest: manifest2,
    shards: shards2,
    blueprints: target,
    franchiseByCharacter: state.mapping,
  });
  assert.equal(p2.dirty, false);
  assert.deepEqual(p2.writes, []);
  assert.deepEqual(p2.deletes, []);
  assert.deepEqual(p2.unchanged.map((u) => u.file), manifest2.files.map((f: { file: unknown; }) => f.file));
});

test('JSON extension keys and complete blueprint fields survive planning without prototype setters', () => {
  const state = baseState();
  Object.defineProperty(state.manifest, '__proto__', { value: { note: 'manifest metadata' }, enumerable: true });
  Object.defineProperty(state.manifest.files[0], '__proto__', { value: { note: 'entry metadata' }, enumerable: true });
  const target = state.target.map((item, index) => index ? item : {
    ...item, outfitId: 'canonical', rating: 'R18', mature: true,
    arbitrary: { unicode: '原文', list: [false, 0, null, ''], nested: { value: '保留' } },
    ...JSON.parse('{"__proto__":{"note":"blueprint metadata"}}'),
  });
  const result = plan(state, target);
  const manifest = JSON.parse(result.manifest.text);
  assert.ok(Object.hasOwn(manifest, '__proto__'));
  assert.deepEqual(manifest.__proto__, { note: 'manifest metadata' });
  assert.ok(Object.hasOwn(manifest.files[0], '__proto__'));
  assert.deepEqual(manifest.files[0].__proto__, { note: 'entry metadata' });
  assert.equal(Object.getPrototypeOf(result.manifest.data), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.manifest.data.files[0]), Object.prototype);
  assert.deepEqual(JSON.parse(result.writes[0].text).blueprints[0], target[0]);
  assert.deepEqual(JSON.parse(result.aggregate.text).blueprints[0], target[0]);
});
