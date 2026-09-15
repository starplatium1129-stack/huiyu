import { errorCode as runtimeErrorCode } from '../scripts/lib/runtime-errors';
'use strict';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');
const { VERSIONED_FILES }: typeof import('../scripts/lib/data-version') = require('../scripts/lib/data-version');
const recoveryFs: typeof import('../scripts/lib/maintenance-recovery-fs') = require('../scripts/lib/maintenance-recovery-fs');
const { maintenanceReadToken, assertMaintenanceReadToken }: typeof import('../scripts/lib/maintenance-lease') = require('../scripts/lib/maintenance-lease');

// 编辑基线包含源文件；浏览器缓存的 DATA_VERSION 不能保护尚未聚合的源修改。
function sourceFiles(root) {
  const files = [];
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    recoveryFs.safePath(dir, 'directory', false);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.json')) { recoveryFs.safePath(file, 'file', false); files.push(file); }
    }
  }
  for (const name of ['scenes', 'blueprints', 'popular']) visit(path.join(root, 'data', name));
  return files.sort();
}

function sceneContentVersion(root) {
  const hash = crypto.createHash('sha256');
  const files = VERSIONED_FILES.flatMap(name => ['', '.gz', '.br'].map(ext => path.join(root, 'data', name + ext)))
    .concat(['retired-scenes.json', 'prompt-pinned-scenes.json'].map(name => path.join(root, 'data', name)),
      path.join(root, 'src/stores/sceneStore.ts'), sourceFiles(root));
  for (const file of files) {
    const bytes = recoveryFs.readBytes(file, true);
    hash.update(JSON.stringify([path.relative(root, file), bytes ? bytes.length : null]));
    if (bytes) hash.update(bytes);
  }
  return Number.parseInt(hash.digest('hex').slice(0, 12), 16);
}

// 调用方持有保存锁；内容和基线一起返回，避免客户端先读旧产物再领取新版本。
function readSceneState(root, store, sceneWrite, options = { rootDir: root }, lease) {
  const token = maintenanceReadToken(options, lease);
  const version = sceneContentVersion(root);
  const integrity = sceneWrite.verifyShardIntegrity();
  if (!integrity.ok) throw new Error(integrity.problems.join('\n'));
  const loaded = store.loadSceneShards();
  const dataDir = path.join(root, 'data');
  const read = name => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
  const retiredIds = sceneWrite.readRetiredSceneIds(dataDir);
  let blueprints = read('scene-blueprints.json');
  if (fs.existsSync(path.join(dataDir, 'blueprints', 'manifest.json'))) {
    const store: typeof import('../scripts/lib/blueprint-store') = require('../scripts/lib/blueprint-store');
    if (path.resolve(store.shardsDir) !== path.resolve(dataDir, 'blueprints')) throw new Error('蓝图数据根与维护根不一致');
    blueprints = { blueprints: store.loadBlueprintShards().blueprints };
  }
  const snapshot = {
    scenes: loaded.scenes,
    tags: read('tags.json'),
    curation: read('curation.json'),
    blueprints: Array.isArray(blueprints) ? blueprints : blueprints.blueprints,
  };
  if (version !== sceneContentVersion(root)) throw new Error('读取期间内容发生变化，请重新读取');
  let nextSceneId = null;
  try { nextSceneId = sceneWrite.allocateSceneId(loaded.scenes.map(scene => scene.id), retiredIds); }
  catch (error) {
    if (runtimeErrorCode(error) !== 'SCENE_ID_EXHAUSTED') throw error;
  }
  assertMaintenanceReadToken(options, token, lease);
  return { version, snapshot, nextSceneId, sceneCount: loaded.scenes.length, retiredCount: retiredIds.size };
}

export = { sceneContentVersion, readSceneState };
