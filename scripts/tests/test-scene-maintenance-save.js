'use strict';

/**
 * 计划 006 D5 —— /api/maintenance/scenes 保存链路契约测试（隔离夹具）。
 *
 * 场景源分片与受治理数据文件从仓库 tracked 文件只读复制到临时目录，
 * 聚合产物在夹具内由 writeAggregate 生成；全程不写生产 data/。
 * 覆盖：scenes-state 端点、缺基线/旧基线 409、退役 ID 复用拒绝、
 * 增量落盘（无关分片字节不变）、下架登记与退役 ID 不复用、桌面打包 501。
 */

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const REPO = path.resolve(__dirname, '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-scenes-save-'));
process.env.AICS_DATA_ROOT = root;
const dataDir = path.join(root, 'data');
const shardsDir = path.join(dataDir, 'scenes');

const { createMaintenanceRouter } = require('../../routes/maintenance');
const store = require('../../scripts/lib/scene-store');

/** 从仓库复制受治理源文件；聚合产物在夹具内重建。 */
function seedFixture() {
  fs.mkdirSync(shardsDir, { recursive: true });
  const scriptsDir = path.join(root, 'scripts', 'lib');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'scripts/lib/manual-scene-ratings.js'), path.join(scriptsDir, 'manual-scene-ratings.js'));
  for (const name of fs.readdirSync(path.join(REPO, 'data', 'scenes'))) {
    if (name.endsWith('.json')) {
      fs.copyFileSync(path.join(REPO, 'data', 'scenes', name), path.join(shardsDir, name));
    }
  }
  for (const name of [
    'curation.json', 'characters.json', 'loras.json', 'tags.json', 'presets.json',
    'retired-scenes.json', 'prompt-pinned-scenes.json',
  ]) {
    fs.copyFileSync(path.join(REPO, 'data', name), path.join(dataDir, name));
  }
  store.writeAggregate(store.loadSceneShards().scenes);
  fs.writeFileSync(path.join(dataDir, 'popular-characters.json'), JSON.stringify({ characters: [] }, null, 2) + '\n');
  fs.writeFileSync(path.join(dataDir, 'scene-blueprints.json'), JSON.stringify({ version: 2, blueprints: [] }, null, 2) + '\n');
}

function buildApp(desktopPackaged) {
  const { router } = createMaintenanceRouter({
    ROOT_DIR: root,
    RUNTIME_ROOT: path.join(root, 'runtime'),
    SCENE_SHOWCASE_DIR: null,
    DESKTOP_PACKAGED: Boolean(desktopPackaged),
  });
  const app = express();
  app.use(router);
  return app;
}

let server;
let baseUrl;
async function startApp(desktopPackaged) {
  await new Promise((resolve) => {
    server = buildApp(desktopPackaged).listen(0, '127.0.0.1', resolve);
  });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
}
async function stopApp() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
}

async function get(pathname) {
  const response = await fetch(baseUrl + pathname);
  return { status: response.status, body: await response.json() };
}

async function post(pathname, body) {
  const response = await fetch(baseUrl + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function currentBaseVersion() {
  const state = await get('/api/maintenance/scenes-state');
  assert.equal(state.status, 200);
  return state.body.version;
}

function loadScenesFromShards() {
  return store.loadSceneShards().scenes.map((scene) => JSON.parse(JSON.stringify(scene)));
}

/** 克隆现有场景为新 ID：字段全部合法（过 validate 链），只换 id 与标题。 */
function cloneScene(source, newId) {
  const copy = JSON.parse(JSON.stringify(source));
  copy.id = newId;
  copy.title = source.title + '（副本）';
  return copy;
}

function shardBytes() {
  return Object.fromEntries(fs.readdirSync(shardsDir)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .map((name) => [name, fs.readFileSync(path.join(shardsDir, name), 'utf8')]));
}

test('scenes-state 返回内容版本与写入侧下一个稳定 ID', async () => {
  seedFixture();
  await startApp(false);
  try {
    const state = await get('/api/maintenance/scenes-state');
    assert.equal(state.status, 200);
    assert.equal(typeof state.body.version, 'number');
    assert.equal(state.body.nextSceneId, 'sc307');
    assert.equal(state.body.sceneCount, 302);
    assert.equal(state.body.retiredCount, 4);
    assert.deepEqual(state.body.snapshot.scenes, loadScenesFromShards());
    assert.ok(Array.isArray(state.body.snapshot.blueprints));
  } finally {
    await stopApp();
  }
});

test('缺少读取基线的旧快照被 409 拒绝且不写盘', async () => {
  await startApp(false);
  try {
    const before = shardBytes();
    const scenes = loadScenesFromShards();
    const result = await post('/api/maintenance/scenes', { scenes });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'SCENE_BASE_VERSION_REQUIRED');
    assert.deepEqual(shardBytes(), before, '被拒绝的保存不得改动分片');
  } finally {
    await stopApp();
  }
});

test('旧基线全量保存被 409 拒绝并给出可解释差异', async () => {
  await startApp(false);
  try {
    const stale = await currentBaseVersion();
    // 旧快照：外部修改前取的场景集（携带改前内容与改前基线）
    const scenes = loadScenesFromShards();
    // 模拟另一会话的落盘更新：直接改源分片并重建聚合产物（等价维护脚本行为）。
    // 内容版本哈希只覆盖浏览器可见产物——与客户端读取视图一致。
    const shardFile = path.join(shardsDir, 'nene-core.1.json');
    const shard = JSON.parse(fs.readFileSync(shardFile, 'utf8'));
    shard.find((scene) => scene.id === 'sc001').story += '（服务器侧修订）';
    fs.writeFileSync(shardFile, JSON.stringify(shard, null, 2) + '\n');
    store.writeAggregate(store.loadSceneShards().scenes);
    const result = await post('/api/maintenance/scenes', { scenes, baseVersion: stale });
    assert.equal(result.status, 409);
    assert.ok(result.body.conflict, '409 必须携带 conflict 差异');
    assert.equal(result.body.conflict.baseVersion, stale);
    assert.notEqual(result.body.conflict.currentVersion, stale);
    assert.ok(result.body.conflict.changedIds.includes('sc001'), JSON.stringify(result.body.conflict));
    // 拒绝后落盘内容保持服务器侧修订
    const after = JSON.parse(fs.readFileSync(shardFile, 'utf8'));
    assert.ok(after.find((scene) => scene.id === 'sc001').story.includes('（服务器侧修订）'));
  } finally {
    await stopApp();
  }
});

test('正确基线保存走增量落盘：无关分片字节不变', async () => {
  await startApp(false);
  try {
    const baseVersion = await currentBaseVersion();
    const before = shardBytes();
    const scenes = loadScenesFromShards();
    const target = scenes.find((scene) => scene.id === 'sc002');
    target.story += '（本轮编辑修订）';
    const added = cloneScene(scenes.find((scene) => scene.id === 'sc001'), 'sc307');
    scenes.push(added);
    const result = await post('/api/maintenance/scenes', { scenes, baseVersion });
    assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 400));
    assert.deepEqual(result.body.added, ['sc307']);
    assert.deepEqual(result.body.updated, ['sc002']);
    const after = shardBytes();
    assert.notEqual(after['nene-core.1.json'], before['nene-core.1.json'], 'sc002 所在分片必须更新');
    assert.equal(after['shared.json'], before['shared.json'], '无关分片必须字节不变');
    // 新增落在目标组的最后批次；聚合产物同步重建
    const shard = JSON.parse(fs.readFileSync(path.join(shardsDir, 'nene-core.1.json'), 'utf8'));
    assert.ok(shard.find((scene) => scene.id === 'sc002').story.includes('（本轮编辑修订）'));
    const aggregate = JSON.parse(fs.readFileSync(path.join(dataDir, 'scenes.json'), 'utf8'));
    assert.ok(aggregate.some((scene) => scene.id === 'sc307'), '聚合产物必须包含新增场景');
    assert.equal(typeof result.body.version, 'number');
    assert.notEqual(result.body.version, baseVersion, '内容变化后版本必须推进');
    assert.deepEqual(result.body.snapshot.scenes, loadScenesFromShards(), '回执必须包含规范化后的实际快照');
  } finally {
    await stopApp();
  }
});

test('下架场景登记退役，写入侧分配不再复用该 ID', async () => {
  await startApp(false);
  try {
    const baseVersion = await currentBaseVersion();
    const scenes = loadScenesFromShards().filter((scene) => scene.id !== 'sc307');
    const result = await post('/api/maintenance/scenes', { scenes, baseVersion });
    assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 400));
    assert.deepEqual(result.body.removed, ['sc307']);
    const retired = JSON.parse(fs.readFileSync(path.join(dataDir, 'retired-scenes.json'), 'utf8'));
    assert.ok(retired.records.some((record) => record.id === 'sc307' && record.reason), '下架必须登记退役');
    const state = await get('/api/maintenance/scenes-state');
    assert.equal(state.body.nextSceneId, 'sc308', '退役 ID 不得被复用');
  } finally {
    await stopApp();
  }
});

test('保存携带退役 ID 的旧快照被拒绝且回滚', async () => {
  await startApp(false);
  try {
    const baseVersion = await currentBaseVersion();
    const before = shardBytes();
    const scenes = loadScenesFromShards();
    // sc148 在 retired-scenes.json 中：复用已退役身份必须拒绝
    scenes.push(cloneScene(scenes.find((scene) => scene.id === 'sc001'), 'sc148'));
    const result = await post('/api/maintenance/scenes', { scenes, baseVersion });
    assert.equal(result.status, 400);
    assert.ok(result.body.error.includes('sc148'), result.body.error);
    assert.equal(result.body.rolledBack, true);
    assert.deepEqual(shardBytes(), before, '拒绝后的保存必须完全回滚');
  } finally {
    await stopApp();
  }
});

test('桌面打包模式拒绝保存与状态查询', async () => {
  await startApp(true);
  try {
    const postResult = await post('/api/maintenance/scenes', { scenes: [{ id: 'sc001' }], baseVersion: 1 });
    assert.equal(postResult.status, 501);
    const getResult = await get('/api/maintenance/scenes-state');
    assert.equal(getResult.status, 501);
  } finally {
    await stopApp();
  }
});

test('夹具数据在保存链的维护校验后仍然完整', async () => {
  const { status, output } = await new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['scripts/maintenance/validate-scenes.js'], {
      cwd: REPO,
      env: { ...process.env, AICS_DATA_ROOT: root },
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ status: code, output: out }));
  });
  assert.equal(status, 0, output.slice(-2000));
});

test('源分片未聚合的修改也使旧基线失效，读取快照来自源文件', async () => {
  seedFixture();
  await startApp(false);
  try {
    const baseVersion = await currentBaseVersion();
    const scenes = loadScenesFromShards();
    const file = path.join(shardsDir, 'nene-core.1.json');
    const source = JSON.parse(fs.readFileSync(file, 'utf8'));
    source[0].story += '（仅源文件更新）';
    fs.writeFileSync(file, JSON.stringify(source, null, 2) + '\n');
    const state = await get('/api/maintenance/scenes-state');
    assert.notEqual(state.body.version, baseVersion);
    assert.deepEqual(state.body.snapshot.scenes, loadScenesFromShards());
    const rejected = await post('/api/maintenance/scenes', { scenes, baseVersion });
    assert.equal(rejected.status, 409);
    assert.ok(fs.readFileSync(file, 'utf8').includes('仅源文件更新'));
  } finally { await stopApp(); }
});

test('聚合写入后失败会撤销新批次并恢复全部浏览器产物', async () => {
  seedFixture();
  // 缩小仅夹具的批次容量，确保新增场景产生一个此前不存在的分片。
  const manifestPath = path.join(shardsDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files.forEach(entry => { entry.batchSize = 1; });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await startApp(false);
  const writeAggregate = store.writeAggregate;
  try {
    const baseVersion = await currentBaseVersion();
    const before = shardBytes();
    const productPaths = require('../lib/data-version').VERSIONED_FILES.map(name => path.join(dataDir, name));
    const products = productPaths.map(file => fs.readFileSync(file));
    const scenes = loadScenesFromShards();
    scenes.push(cloneScene(scenes[0], 'sc307'));
    store.writeAggregate = incoming => {
      writeAggregate(incoming);
      throw new Error('injected failure after aggregate write');
    };
    const failed = await post('/api/maintenance/scenes', { scenes, baseVersion });
    assert.equal(failed.status, 400);
    assert.equal(failed.body.dataIntegrity, 'restored');
    assert.deepEqual(shardBytes(), before, '新增批次必须删除，已有分片必须恢复');
    productPaths.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), products[index], file));
    assert.equal(await currentBaseVersion(), baseVersion);
  } finally { store.writeAggregate = writeAggregate; await stopApp(); }
});

test('相同基线的两个并发保存仅有一个成功，状态读取与保存串行', async () => {
  seedFixture();
  await startApp(false);
  try {
    const baseVersion = await currentBaseVersion();
    const first = loadScenesFromShards();
    const second = loadScenesFromShards();
    first.find(scene => scene.id === 'sc002').story += '（第一份）';
    second.find(scene => scene.id === 'sc002').story += '（第二份）';
    const results = await Promise.all([
      post('/api/maintenance/scenes', { scenes: first, baseVersion }),
      post('/api/maintenance/scenes', { scenes: second, baseVersion }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const state = await get('/api/maintenance/scenes-state');
    const saved = results.find(result => result.status === 200).body;
    assert.equal(state.body.version, saved.version);
    assert.deepEqual(state.body.snapshot, saved.snapshot);
  } finally { await stopApp(); }
});

test('ID 用尽仍可读取现有内容与编辑基线', async () => {
  seedFixture();
  fs.writeFileSync(path.join(dataDir, 'retired-scenes.json'), JSON.stringify({ records: [{ id: 'sc999' }] }));
  await startApp(false);
  try {
    const state = await get('/api/maintenance/scenes-state');
    assert.equal(state.status, 200);
    assert.equal(state.body.nextSceneId, null);
    assert.ok(Number.isSafeInteger(state.body.version));
    assert.deepEqual(state.body.snapshot.scenes, loadScenesFromShards());
  } finally { await stopApp(); }
});
