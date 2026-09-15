'use strict';

// G16 蓝图磁盘准备与应用适配器行为测试。
// 全部使用系统临时目录自建夹具：不读生产数据、不改生产蓝图、不触发模型、不做 Git 操作。
// 在 require 任何 store 模块前固定 AICS_DATA_ROOT（blueprint-store 加载期解析根），
// 其后 store 只会看到该临时根；blueprint-write 本身只使用显式 rootDir，不读环境。

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');

const BASE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-g16-cases-'));
const ENV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-g16-envroot-'));
process.env.AICS_DATA_ROOT = ENV_ROOT;

const {
  prepareBlueprintWrite,
  applyBlueprintWrite,
  BlueprintWriteError,
  defaultWriteFileAtomic,
  BlueprintChangePlanError,
}: typeof import('../lib/blueprint-write') = require('../lib/blueprint-write');
const { planBlueprintChanges, jsonText }: typeof import('../lib/blueprint-change-plan') = require('../lib/blueprint-change-plan');

const FRIEREN = "Frieren: Beyond Journey's End";
const FRIEREN_FILE = 'frieren-beyond-journeys-end.json';
const FATE = 'Fate';
const FATE_FILE = 'fate.json';
const MARIN = 'My Dress-Up Darling';
const MARIN_FILE = 'my-dress-up-darling.json';

let caseSeq = 0;
function makeRoot(t: any) {
  const root = path.join(BASE_ROOT, 'case-' + (++caseSeq));
  fs.mkdirSync(root, { recursive: true });
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function bp(id: any, characterId: any, extra?: any) {
  return Object.assign({
    id, title: id, characterId, category: '测试',
    promptTokens: ['tag_' + id], negativeTokens: [], promptProse: id + ' 的提示词正文。',
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

function pathsOf(root: any) {
  const dataDir = path.join(root, 'data');
  const shardsDir = path.join(dataDir, 'blueprints');
  return {
    dataDir, shardsDir,
    manifest: path.join(shardsDir, 'manifest.json'),
    aggregate: path.join(dataDir, 'scene-blueprints.json'),
    shard: (file: any) => path.join(shardsDir, file),
  };
}

function setupBlueprints(root: any, state: any, overrides?: any) {
  const options = overrides || {};
  const p = pathsOf(root);
  fs.mkdirSync(p.shardsDir, { recursive: true });
  fs.writeFileSync(p.manifest, jsonText(state.manifest));
  for (const [file, data] of Object.entries(state.shards)) {
    const text = options.shardText && options.shardText[file] !== undefined
      ? options.shardText[file] : jsonText(data);
    fs.writeFileSync(p.shard(file), text);
  }
  const aggregateText = options.aggregateText !== undefined ? options.aggregateText
    : jsonText({ version: 2, blueprints: state.manifest.files.flatMap((e: any) => state.shards[e.file].blueprints) });
  fs.writeFileSync(p.aggregate, aggregateText);
  return p;
}

/** 修改 + 新增 + 删除 的目标：frieren_1 改标题、fate 整片下架、marin 新增。 */
function mixedTarget(state: any) {
  return [
    { ...state.target[0], title: '新标题' },
    state.target[1],
    bp('marin_1', 'marin'),
  ];
}

function shardTextInputs(state: any, overrides?: any) {
  const out: any = {};
  for (const [file, data] of Object.entries(state.shards)) {
    out[file] = {
      text: (overrides && overrides[file] !== undefined) ? overrides[file] : jsonText(data),
      data,
    };
  }
  return out;
}

function recordingIo(log: any) {
  return {
    realpathSync(p: any) { log.push(['realpathSync', String(p)]); return fs.realpathSync(p); },
    lstatSync(p: any) { log.push(['lstatSync', String(p)]); return fs.lstatSync(p); },
    readFileSync(p: any) { log.push(['readFileSync', String(p)]); return fs.readFileSync(p); },
    unlinkSync(p: any) { log.push(['unlinkSync', String(p)]); return fs.unlinkSync(p); },
  };
}

function recordingWrite(log: any, impl?: any) {
  return (source: any, content: any) => {
    log.push(['writeFileAtomic', String(source)]);
    return (impl || defaultWriteFileAtomic)(source, content);
  };
}

function assertAllOpsInside(log: any, root: any) {
  for (const [, p] of log) {
    assert.ok(p === root || p.startsWith(root + path.sep), 'IO 越出夹具根: ' + p);
  }
}

function assertNoWrites(log: any) {
  assert.deepEqual(log.filter(([op]: any) => op === 'writeFileAtomic' || op === 'unlinkSync'), []);
}

function pathsOfEntries(entries: any) {
  return entries.map((entry: any) => [path.basename(entry.file), entry.exists]);
}

test('prepare 只读：零写入零删除、不读未登记分片与其他根、与纯规划器对拍、条目结构正确', (t) => {
  const root = makeRoot(t);
  const state = baseState();
  const p = setupBlueprints(root, state);
  const orphanPath = p.shard('orphan.json');
  fs.writeFileSync(orphanPath, '{"blueprints":[]}');
  const sibling = makeRoot(t);
  const decoy = path.join(sibling, 'decoy.txt');
  fs.writeFileSync(decoy, 'do not touch');

  const target = mixedTarget(state);
  const log: any = [];
  const prepared = prepareBlueprintWrite({
    rootDir: root, blueprints: target, franchiseByCharacter: state.mapping, io: recordingIo(log),
  });

  assertNoWrites(log);
  assertAllOpsInside(log, root);
  assert.ok(!log.some(([, file]: any) => file === orphanPath), '未登记分片不得被读取');
  assert.equal(fs.existsSync(orphanPath), true, '未登记分片保持原样');
  assert.equal(fs.readFileSync(decoy, 'utf8'), 'do not touch', '其他根不被触碰');

  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.plan), true);
  assert.equal(Object.isFrozen(prepared.snapshotEntries), true);
  assert.equal(prepared.kind, 'blueprint-write-prepared');
  assert.deepEqual(pathsOfEntries(prepared.snapshotEntries).sort(), [
    [FATE_FILE, true], [FRIEREN_FILE, true], ['manifest.json', true],
    [MARIN_FILE, false], ['scene-blueprints.json', true],
  ]);
  const frierenEntry = prepared.snapshotEntries.find((e: any) => e.file === p.shard(FRIEREN_FILE));
  assert.ok(frierenEntry.content.equals(fs.readFileSync(p.shard(FRIEREN_FILE))));
  assert.equal(prepared.summary.writes, 2);
  assert.equal(prepared.summary.deletes, 1);
  assert.equal(prepared.summary.unchanged, 0);
  assert.equal(prepared.summary.dirty, true);

  const direct = planBlueprintChanges({
    manifest: state.manifest,
    shards: shardTextInputs(state),
    blueprints: target,
    franchiseByCharacter: state.mapping,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.plan)), JSON.parse(JSON.stringify(direct)));
});

test('端到端修改/新增/删除：应用后真实 blueprint-store 聚合一致，再次 prepare+apply 幂等零写', (t) => {
  t.after(() => fs.rmSync(ENV_ROOT, { recursive: true, force: true }));
  const root = ENV_ROOT;
  const state = baseState();
  const p = setupBlueprints(root, state);
  const target = mixedTarget(state);
  const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: target, franchiseByCharacter: state.mapping });
  const log: any = [];
  const result = applyBlueprintWrite(prepared, {
    writeFileAtomic: recordingWrite(log), io: recordingIo(log),
  });

  assert.equal(result.ok, true);
  assertAllOpsInside(log, root);
  assert.deepEqual(result.deleted, [p.shard(FATE_FILE)]);
  assert.deepEqual(new Set(result.written), new Set([
    p.shard(FRIEREN_FILE), p.shard(MARIN_FILE), p.manifest, p.aggregate,
  ]));
  assert.equal(result.manifestWritten, true);
  assert.equal(result.aggregateWritten, true);
  assert.equal(fs.existsSync(p.shard(FATE_FILE)), false, '计划删除的分片已删除');
  assert.deepEqual(fs.readdirSync(p.shardsDir).sort(), [FRIEREN_FILE, 'manifest.json', MARIN_FILE]);
  assert.equal(fs.readFileSync(p.shard(FRIEREN_FILE), 'utf8'), prepared.plan.writes[0].text);
  assert.equal(fs.readFileSync(p.shard(MARIN_FILE), 'utf8'), prepared.plan.writes[1].text);
  assert.equal(fs.readFileSync(p.manifest, 'utf8'), prepared.plan.manifest.text);
  assert.equal(fs.readFileSync(p.aggregate, 'utf8'), prepared.plan.aggregate.text);

  const store: typeof import('../lib/blueprint-store') = require('../lib/blueprint-store');
  const loaded = store.loadBlueprintShards();
  assert.deepEqual(loaded.blueprints.map((b) => b.id), ['frieren_1', 'frieren_2', 'marin_1']);
  assert.equal(store.aggregateIsCurrent(), true, '真实读取器确认聚合与分片合并字节一致');

  const writeLog2: any = [];
  const prepared2 = prepareBlueprintWrite({ rootDir: root, blueprints: target, franchiseByCharacter: state.mapping });
  const result2 = applyBlueprintWrite(prepared2, { writeFileAtomic: recordingWrite(writeLog2), io: recordingIo(writeLog2) });
  assert.deepEqual(result2.written, []);
  assert.deepEqual(result2.deleted, []);
  assert.equal(result2.manifestWritten, false);
  assert.equal(result2.aggregateWritten, false);
  assertNoWrites(writeLog2);
});

test('未变分片原始字节保留：非规范格式不因格式差异重写', (t) => {
  const root = makeRoot(t);
  const state = baseState();
  const reformatted = JSON.stringify(state.shards[FATE_FILE], null, 4);
  const p = setupBlueprints(root, state, { shardText: { [FATE_FILE]: reformatted } });
  const target = [{ ...state.target[0], title: '只改frieren' }, state.target[1], state.target[2]];
  const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: target, franchiseByCharacter: state.mapping });
  assert.deepEqual(prepared.plan.unchanged.map((u: any) => u.file), [FATE_FILE]);
  const before = fs.readFileSync(p.shard(FATE_FILE));
  const log: any = [];
  applyBlueprintWrite(prepared, { writeFileAtomic: recordingWrite(log), io: recordingIo(log) });
  assert.equal(fs.readFileSync(p.shard(FATE_FILE)).equals(before), true, 'unchanged 分片字节不变');
  assert.ok(log.some(([op, file]: any) => op === 'readFileSync' && file === p.shard(FATE_FILE)), 'unchanged 源也复核过期基线');
  assert.ok(!log.some(([op, file]: any) => ['writeFileAtomic', 'unlinkSync'].includes(op) && file === p.shard(FATE_FILE)));
});

test('仅 manifest 计数修正：只写 manifest，分片与聚合零写', (t) => {
  const root = makeRoot(t);
  const state = baseState();
  state.manifest.files[0].count = 99;
  const p = setupBlueprints(root, state);
  const shardBefore = Object.fromEntries(state.manifest.files.map((e) => [e.file, fs.readFileSync(p.shard(e.file))]));
  const aggregateBefore = fs.readFileSync(p.aggregate);
  const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: state.target, franchiseByCharacter: state.mapping });
  assert.equal(prepared.summary.dirty, true);
  assert.equal(prepared.summary.writes, 0);
  const log: any = [];
  const result = applyBlueprintWrite(prepared, { writeFileAtomic: recordingWrite(log), io: recordingIo(log) });
  assert.equal(result.manifestWritten, true);
  assert.equal(result.aggregateWritten, false, '聚合字节已与计划一致，不重写');
  assert.deepEqual(result.written, [p.manifest]);
  for (const [file, buffer] of Object.entries(shardBefore)) {
    assert.ok(fs.readFileSync(p.shard(file)).equals(buffer), file + ' 字节不变');
  }
  assert.ok(fs.readFileSync(p.aggregate).equals(aggregateBefore));
  assert.equal(JSON.parse(fs.readFileSync(p.manifest, 'utf8')).files[0].count, 2);
  assert.deepEqual(log.filter(([op]: any) => op === 'writeFileAtomic').length, 1, '只发生一次写入（manifest）');
});

test('聚合字节漂移（内容同、格式异）被重写为计划字节；其余零写', (t) => {
  const root = makeRoot(t);
  const state = baseState();
  const drifted = JSON.stringify({ version: 2, blueprints: state.target });
  const p = setupBlueprints(root, state, { aggregateText: drifted });
  const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: state.target, franchiseByCharacter: state.mapping });
  const log: any = [];
  const result = applyBlueprintWrite(prepared, { writeFileAtomic: recordingWrite(log), io: recordingIo(log) });
  assert.equal(result.aggregateWritten, true);
  assert.deepEqual(result.written, [p.aggregate]);
  assert.equal(result.manifestWritten, false);
  assert.equal(fs.readFileSync(p.aggregate, 'utf8'), prepared.plan.aggregate.text);
  assert.deepEqual(log.filter(([op]: any) => op === 'writeFileAtomic').map(([, file]: any) => path.basename(file)),
    ['scene-blueprints.json']);
});

test('过期计划：源分片、manifest 或聚合准备后漂移 → 零写入拒绝', (t) => {
  const make = (t: any) => {
    const root = makeRoot(t);
    const state = baseState();
    const p = setupBlueprints(root, state);
    const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: mixedTarget(state), franchiseByCharacter: state.mapping });
    return { root, state, p, prepared };
  };
  const before = (p: any) => ({
    manifest: fs.readFileSync(p.manifest), aggregate: fs.readFileSync(p.aggregate),
    frieren: fs.readFileSync(p.shard(FRIEREN_FILE)), fate: fs.readFileSync(p.shard(FATE_FILE)),
  });

  const caseA = make(t);
  fs.appendFileSync(caseA.p.shard(FRIEREN_FILE), ' ');
  const logA: any = [];
  assert.throws(() => applyBlueprintWrite(caseA.prepared, {
    writeFileAtomic: recordingWrite(logA), io: recordingIo(logA),
  }), (error) => error instanceof BlueprintWriteError && error.code === 'stale');
  assertNoWrites(logA);
  const afterA = before(caseA.p);
  assert.equal(afterA.frieren.equals(fs.readFileSync(caseA.p.shard(FRIEREN_FILE))), true);

  const caseB = make(t);
  const staleManifest = JSON.parse(fs.readFileSync(caseB.p.manifest, 'utf8'));
  staleManifest.note = '准备后被人改过';
  fs.writeFileSync(caseB.p.manifest, jsonText(staleManifest));
  const logB: any = [];
  assert.throws(() => applyBlueprintWrite(caseB.prepared, {
    writeFileAtomic: recordingWrite(logB), io: recordingIo(logB),
  }), (error) => error instanceof BlueprintWriteError && error.code === 'stale');
  assertNoWrites(logB);

  const caseC = make(t);
  fs.unlinkSync(caseC.p.aggregate);
  const logC: any = [];
  assert.throws(() => applyBlueprintWrite(caseC.prepared, {
    writeFileAtomic: recordingWrite(logC), io: recordingIo(logC),
  }), (error) => error instanceof BlueprintWriteError && error.code === 'stale');
  assertNoWrites(logC);
  assert.equal(fs.existsSync(caseC.p.shard(FATE_FILE)), true);
});

test('目标占用：准备时与准备后都拒绝，绝不覆盖未登记文件', (t) => {
  const state = baseState();

  const rootA = makeRoot(t);
  const pA = setupBlueprints(rootA, state);
  fs.writeFileSync(pA.shard(MARIN_FILE), '{"occupied":true}');
  assert.throws(() => prepareBlueprintWrite({
    rootDir: rootA, blueprints: mixedTarget(state), franchiseByCharacter: state.mapping,
  }), (error) => error instanceof BlueprintWriteError && error.code === 'occupied');
  assert.equal(fs.readFileSync(pA.shard(MARIN_FILE), 'utf8'), '{"occupied":true}');

  const rootB = makeRoot(t);
  const pB = setupBlueprints(rootB, state);
  const prepared = prepareBlueprintWrite({
    rootDir: rootB, blueprints: mixedTarget(state), franchiseByCharacter: state.mapping,
  });
  fs.writeFileSync(pB.shard(MARIN_FILE), '{"occupied":true}');
  const log: any = [];
  assert.throws(() => applyBlueprintWrite(prepared, {
    writeFileAtomic: recordingWrite(log), io: recordingIo(log),
  }), (error) => error instanceof BlueprintWriteError && error.code === 'occupied');
  assertNoWrites(log);
  assert.equal(fs.readFileSync(pB.shard(MARIN_FILE), 'utf8'), '{"occupied":true}');
});

test('junction/符号链接逃逸：分片目录、分片文件、聚合任一是链接即拒绝且不读取链接目标', (t) => {
  const state = baseState();

  const outside = makeRoot(t);
  const pOut = setupBlueprints(outside, state);
  const rootA = makeRoot(t);
  fs.mkdirSync(path.join(rootA, 'data'), { recursive: true });
  fs.symlinkSync(pOut.shardsDir, path.join(rootA, 'data', 'blueprints'), 'junction');
  const logA: any = [];
  assert.throws(() => prepareBlueprintWrite({
    rootDir: rootA, blueprints: state.target, franchiseByCharacter: state.mapping, io: recordingIo(logA),
  }), (error) => error instanceof BlueprintWriteError && error.code === 'boundary');
  assert.ok(!logA.some(([, file]: any) => file.startsWith(outside)), '链接目标未被读取');
  assert.equal(fs.existsSync(pOut.manifest), true);

  // 文件级链接逃逸：本环境（非管理员/未开发者模式）无法创建文件符号链接（EPERM），
  // 改用 junction 落在文件名位置——lstat 同样报 isSymbolicLink，走同一拒绝分支；
  // 链接目标（含目标内文件）必须完全未被读取。
  const outsideB = makeRoot(t);
  const targetB = path.join(outsideB, 'outside-dir');
  fs.mkdirSync(targetB, { recursive: true });
  const decoyB = path.join(targetB, 'decoy.txt');
  fs.writeFileSync(decoyB, 'secret');
  const rootB = makeRoot(t);
  const pB = setupBlueprints(rootB, state);
  fs.unlinkSync(pB.shard(FRIEREN_FILE));
  fs.symlinkSync(targetB, pB.shard(FRIEREN_FILE), 'junction');
  const logB: any = [];
  assert.throws(() => prepareBlueprintWrite({
    rootDir: rootB, blueprints: state.target, franchiseByCharacter: state.mapping, io: recordingIo(logB),
  }), (error) => error instanceof BlueprintWriteError && error.code === 'boundary');
  assert.ok(!logB.some(([, file]: any) => file.startsWith(outsideB)), '链接目标未被读取');
  assert.equal(fs.readFileSync(decoyB, 'utf8'), 'secret');

  const outsideC = makeRoot(t);
  const targetC = path.join(outsideC, 'outside-dir');
  fs.mkdirSync(targetC, { recursive: true });
  const decoyC = path.join(targetC, 'decoy.txt');
  fs.writeFileSync(decoyC, 'secret');
  const rootC = makeRoot(t);
  const pC = setupBlueprints(rootC, state);
  fs.unlinkSync(pC.aggregate);
  fs.symlinkSync(targetC, pC.aggregate, 'junction');
  const logC: any = [];
  assert.throws(() => prepareBlueprintWrite({
    rootDir: rootC, blueprints: state.target, franchiseByCharacter: state.mapping, io: recordingIo(logC),
  }), (error) => error instanceof BlueprintWriteError && error.code === 'boundary');
  assert.ok(!logC.some(([, file]: any) => file.startsWith(outsideC)), '聚合链接目标未被读取');
  assert.equal(fs.readFileSync(decoyC, 'utf8'), 'secret');
});

test('准备后篡改：冻结对象不可变；伪造 prepared 重验路径与基线，零越界写', (t) => {
  const root = makeRoot(t);
  const state = baseState();
  setupBlueprints(root, state);
  const prepared = prepareBlueprintWrite({
    rootDir: root, blueprints: mixedTarget(state), franchiseByCharacter: state.mapping,
  });
  assert.throws(() => { prepared.plan.writes[0].file = '../../evil.json'; }, TypeError);
  assert.equal(prepared.plan.writes[0].file, FRIEREN_FILE);

  const forgedPlan = JSON.parse(JSON.stringify(prepared.plan));
  forgedPlan.writes[0].file = '../../evil.json';
  const log: any = [];
  assert.throws(() => applyBlueprintWrite({ ...prepared, plan: forgedPlan }, {
    writeFileAtomic: recordingWrite(log), io: recordingIo(log),
  }), (error) => error instanceof BlueprintWriteError && error.code === 'path-validation');
  assertNoWrites(log);
  assert.equal(fs.existsSync(path.join(root, 'evil.json')), false);

  const forgedPaths = { ...prepared, paths: { ...prepared.paths, shardsDir: 'D:\\elsewhere\\blueprints' } };
  assert.throws(() => applyBlueprintWrite(forgedPaths, {
    writeFileAtomic: recordingWrite([]), io: recordingIo([]),
  }), (error) => error instanceof BlueprintWriteError && error.code === 'path-validation');

  const forgedExtra = JSON.parse(JSON.stringify(prepared.plan));
  forgedExtra.writes.push({ kind: 'create', file: 'extra.json', text: '{"blueprints":[]}', count: 0 });
  assert.throws(() => applyBlueprintWrite({ ...prepared, plan: forgedExtra }, {
    writeFileAtomic: recordingWrite([]), io: recordingIo([]),
  }), (error) => error instanceof BlueprintWriteError && error.code === 'path-validation');
});

test('写入/删除阶段故障逐个向上传递：注入第 k 个写入失败、删除失败、读回失败都不报告成功', (t) => {
  const state = baseState();
  const build = () => {
    const root = makeRoot(t);
    const p = setupBlueprints(root, state);
    const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: mixedTarget(state), franchiseByCharacter: state.mapping });
    return { root, p, prepared };
  };
  // apply 写入序列：frieren、marin、manifest、aggregate（共 4 次写入）
  for (let k = 1; k <= 4; k += 1) {
    const { p, prepared } = build();
    let calls = 0;
    assert.throws(() => applyBlueprintWrite(prepared, {
      writeFileAtomic: (source: any, content: any) => {
        calls += 1;
        if (calls === k) throw new Error('注入写入故障 #' + k);
        return defaultWriteFileAtomic(source, content);
      },
    }), /注入写入故障 #\d/);
    assert.equal(calls, k, '故障发生在第 ' + k + ' 次写入调用');
    if (k === 1) {
      assert.equal(JSON.parse(fs.readFileSync(p.manifest, 'utf8')).files.length, 2, '首个写入失败 = 磁盘零改动');
      assert.equal(fs.existsSync(p.shard(MARIN_FILE)), false);
    }
    if (k === 3) {
      assert.equal(fs.existsSync(p.shard(MARIN_FILE)), true, '前两次分片写入已生效（由统一快照回滚）');
      assert.equal(JSON.parse(fs.readFileSync(p.manifest, 'utf8')).files.length, 2, 'manifest 尚未写入');
    }
  }

  const del = build();
  const logDel: any = [];
  const ioFail = recordingIo(logDel);
  ioFail.unlinkSync = (p) => { logDel.push(['unlinkSync', String(p)]); throw new Error('注入删除故障'); };
  assert.throws(() => applyBlueprintWrite(del.prepared, {
    writeFileAtomic: recordingWrite(logDel), io: ioFail,
  }), (error) => error instanceof BlueprintWriteError && error.code === 'io-error');
  assert.equal(fs.existsSync(del.p.shard(FATE_FILE)), true, '删除失败时旧分片保留');
  assert.equal(JSON.parse(fs.readFileSync(del.p.manifest, 'utf8')).files.length, 2, 'manifest 在删除阶段之后才写');
  assert.equal(fs.existsSync(del.p.shard(MARIN_FILE)), true);

  const lie = build();
  assert.throws(() => applyBlueprintWrite(lie.prepared, {
    writeFileAtomic: (source: any, content: any) => defaultWriteFileAtomic(source, content.slice(0, Math.max(1, content.length - 5))),
  }), (error) => error instanceof BlueprintWriteError && error.code === 'readback', '写坏字节的适配器在读回核验被拒');
});

function snapshotPaths(paths: any) {
  return paths.map((file: any) => fs.existsSync(file)
    ? { file, exists: true, content: fs.readFileSync(file) }
    : { file, exists: false, content: null });
}

/** 与 routes/maintenance.js restoreSnapshot 相同语义的测试内副本。 */
function restoreSnapshot(entries: any, writeFileAtomic: any) {
  for (const entry of entries) {
    if (entry.exists) writeFileAtomic(entry.file, entry.content);
    else if (fs.existsSync(entry.file)) fs.unlinkSync(entry.file);
  }
}

test('统一快照恢复：适配器成功、后续校验失败后按快照恢复，精确文件集合与 Buffer 等于之前', (t) => {
  const root = makeRoot(t);
  const state = baseState();
  const p = setupBlueprints(root, state);
  const snapshotList = [p.manifest, p.aggregate, p.shard(FRIEREN_FILE), p.shard(FATE_FILE), p.shard(MARIN_FILE)];
  const snapshot = snapshotPaths(snapshotList);
  assert.deepEqual(snapshot.filter((e: any) => e.exists).map((e: any) => path.basename(e.file)),
    ['manifest.json', 'scene-blueprints.json', FRIEREN_FILE, FATE_FILE]);

  const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: mixedTarget(state), franchiseByCharacter: state.mapping });
  const result = applyBlueprintWrite(prepared, {});
  assert.equal(result.ok, true, '适配器阶段成功');

  // 模拟主任务链路中的「后续校验失败」：走统一快照回滚
  restoreSnapshot(snapshot, defaultWriteFileAtomic);

  assert.deepEqual(fs.readdirSync(p.shardsDir).sort(), [FATE_FILE, FRIEREN_FILE, 'manifest.json']);
  for (const entry of snapshot) {
    if (entry.exists) {
      assert.ok(fs.readFileSync(entry.file).equals(entry.content), path.basename(entry.file) + ' 恢复后字节相等');
    } else {
      assert.equal(fs.existsSync(entry.file), false, '新增路径恢复后不存在');
    }
  }
  const restoredState = JSON.parse(fs.readFileSync(p.aggregate, 'utf8'));
  assert.deepEqual(restoredState.blueprints.map((b: any) => b.id), ['frieren_1', 'frieren_2', 'fate_1']);
});

test('回滚注入失败必须如实报告失败，不得称恢复成功', (t) => {
  const root = makeRoot(t);
  const state = baseState();
  const p = setupBlueprints(root, state);
  const snapshot = snapshotPaths([p.manifest, p.aggregate, p.shard(FRIEREN_FILE), p.shard(FATE_FILE), p.shard(MARIN_FILE)]);
  const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: mixedTarget(state), franchiseByCharacter: state.mapping });
  assert.equal(applyBlueprintWrite(prepared, {}).ok, true);

  let calls = 0;
  const attemptRollbackLike = () => {
    try {
      restoreSnapshot(snapshot, () => {
        calls += 1;
        throw new Error('注入回滚故障');
      });
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: String(error && error.message || error) };
    }
  };
  const rollback = attemptRollbackLike();
  assert.equal(rollback.ok, false, '回滚失败不得报告成功');
  assert.match(rollback.error, /注入回滚故障/);
  assert.equal(calls, 1, '故障后停止恢复（半写状态交人工处理）');
  assert.equal(fs.existsSync(p.shard(MARIN_FILE)), true, '确认未完成恢复');
});

test('参数与规划器错误：显式报错类型与退出语义', (t) => {
  assert.throws(() => prepareBlueprintWrite({}), (error) => error instanceof BlueprintWriteError && error.code === 'argument');
  assert.throws(() => prepareBlueprintWrite({ rootDir: path.join(BASE_ROOT, 'no-such-root') }),
    (error) => error instanceof BlueprintWriteError && error.code === 'boundary');

  const root = makeRoot(t);
  const state = baseState();
  setupBlueprints(root, state);
  assert.throws(() => prepareBlueprintWrite({ rootDir: root, blueprints: [], franchiseByCharacter: state.mapping }),
    (error) => error instanceof BlueprintChangePlanError && error.message.includes('空'));

  assert.throws(() => applyBlueprintWrite(null, {}), (error) => error instanceof BlueprintWriteError && error.code === 'argument');
  assert.throws(() => applyBlueprintWrite({ kind: 'other' }, {}), (error) => error instanceof BlueprintWriteError && error.code === 'argument');
  const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: state.target, franchiseByCharacter: state.mapping });
  assert.throws(() => applyBlueprintWrite(prepared, { writeFileAtomic: 'not-a-function' }),
    (error) => error instanceof BlueprintWriteError && error.code === 'argument');
});

test('根外与生产数据零触达：夹具期间环境根之外只读过 ENV_ROOT（store 加载需要），断言无生产路径', (t) => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const root = makeRoot(t);
  const state = baseState();
  setupBlueprints(root, state);
  const log: any = [];
  prepareBlueprintWrite({ rootDir: root, blueprints: mixedTarget(state), franchiseByCharacter: state.mapping, io: recordingIo(log) });
  const log2: any = [];
  applyBlueprintWrite(prepareBlueprintWrite({ rootDir: root, blueprints: mixedTarget(state), franchiseByCharacter: state.mapping }), {
    writeFileAtomic: recordingWrite(log2), io: recordingIo(log2),
  });
  for (const allLog of [log, log2]) {
    for (const [, file] of allLog) {
      assert.ok(!file.startsWith(repoRoot + path.sep + 'data'),
        '不得读取仓库生产 data: ' + file);
    }
    assertAllOpsInside(allLog, root);
  }
});

test('快照条目兼容 routes/maintenance 约定：Buffer 内容可直接用于备份写入', (t) => {
  const root = makeRoot(t);
  const state = baseState();
  const p = setupBlueprints(root, state);
  const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: mixedTarget(state), franchiseByCharacter: state.mapping });  for (const entry of prepared.snapshotEntries) {
    assert.equal(typeof entry.file, 'string');
    assert.equal(typeof entry.exists, 'boolean');
    if (entry.exists) assert.ok(Buffer.isBuffer(entry.content));
    else assert.equal(entry.content, null);
  }
  // 与 routes/maintenance-backup.saveSnapshotBackup 相同的消费方式：逐条写文件
  const backupDir = path.join(root, 'backup-sim');
  fs.mkdirSync(backupDir, { recursive: true });
  let index = 0;
  for (const entry of prepared.snapshotEntries.filter((e: any) => e.exists)) {
    fs.writeFileSync(path.join(backupDir, String(++index).padStart(3, '0') + '-' + path.basename(entry.file)), entry.content);
  }
  assert.equal(fs.readFileSync(path.join(backupDir, '001-manifest.json')).equals(fs.readFileSync(p.manifest)), true);
});

test('unchanged source drift invalidates changed and no-op plans before any writes', (t) => {
  for (const changed of [false, true]) {
    const root = makeRoot(t), state = baseState(), p = setupBlueprints(root, state);
    const target = state.target.map((item, i) => changed && i === 0 ? { ...item, title: '修改' } : item);
    const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: target, franchiseByCharacter: state.mapping });
    assert.ok(prepared.plan.unchanged.some((item: any) => item.file === FATE_FILE));
    fs.appendFileSync(p.shard(FATE_FILE), '\n');
    const log: any = [];
    assert.throws(() => applyBlueprintWrite(prepared, { io: recordingIo(log), writeFileAtomic: recordingWrite(log) }),
      (error: any) => error.code === 'stale');
    assertNoWrites(log);
  }
});

test('public snapshot Buffer cannot replace the private baseline; forged copies do no IO', (t) => {
  const root = makeRoot(t), state = baseState(), p = setupBlueprints(root, state);
  const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: mixedTarget(state), franchiseByCharacter: state.mapping });
  const entry = prepared.snapshotEntries.find((item: any) => item.file === p.shard(FRIEREN_FILE));
  const original = Buffer.from(entry.content);
  const changed = Buffer.from(original); changed[0] = 32;
  fs.writeFileSync(entry.file, changed);
  changed.copy(entry.content);
  const log: any = [];
  assert.throws(() => applyBlueprintWrite(prepared, { io: recordingIo(log), writeFileAtomic: recordingWrite(log) }),
    (error: any) => error.code === 'tampered');
  assert.deepEqual(log, [], 'tampered public buffer rejected before file access');
  original.copy(entry.content);
  const forged = { ...prepared, snapshotEntries: [] };
  assert.throws(() => applyBlueprintWrite(forged, { io: recordingIo(log), writeFileAtomic: recordingWrite(log) }),
    (error: any) => error.code === 'path-validation');
  assert.deepEqual(log, []);
});

test('directory replaced by junction after prepare is rejected before reading its files', (t) => {
  const root = makeRoot(t), state = baseState(), p = setupBlueprints(root, state);
  const outside = makeRoot(t), external = setupBlueprints(outside, state);
  const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: mixedTarget(state), franchiseByCharacter: state.mapping });
  const moved = path.join(root, 'original-data');
  fs.renameSync(p.dataDir, moved);
  fs.symlinkSync(external.dataDir, p.dataDir, 'junction');
  const log: any = [];
  assert.throws(() => applyBlueprintWrite(prepared, { io: recordingIo(log), writeFileAtomic: recordingWrite(log) }),
    (error: any) => error.code === 'boundary');
  assertNoWrites(log);
  assert.ok(!log.some(([op]: any) => op === 'readFileSync'), 'junction parent rejected before file reads');
  fs.unlinkSync(p.dataDir);
  fs.renameSync(moved, p.dataDir);
});

test('writer cannot mutate expected bytes to turn corrupt writes into successful readback', (t) => {
  const root = makeRoot(t), state = baseState(); setupBlueprints(root, state);
  const target = mixedTarget(state);
  const prepared = prepareBlueprintWrite({ rootDir: root, blueprints: target, franchiseByCharacter: state.mapping });
  assert.equal(Object.isFrozen(target[0]), false, 'prepare must not freeze caller-owned target objects');
  assert.throws(() => applyBlueprintWrite(prepared, { writeFileAtomic: (file: any, bytes: any) => {
    bytes[0] = 32;
    defaultWriteFileAtomic(file, bytes);
  } }), (error: any) => error.code === 'readback');
});
