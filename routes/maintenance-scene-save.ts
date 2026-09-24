import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage, errorStatus as runtimeErrorStatus } from '../scripts/lib/runtime-errors';
'use strict';

const path: typeof import('node:path') = require('node:path');
const express: typeof import('express') = require('express');
const envelope: typeof import('../server/http-envelope') = require('../server/http-envelope');
const { sceneContentVersion, readSceneState }: typeof import('./maintenance-scene-state') = require('./maintenance-scene-state');
const sceneWrite: typeof import('../scripts/lib/scene-write') = require('../scripts/lib/scene-write');
const { MAX_SCENES, MAX_BLUEPRINTS, validateCollection, resolveSceneChangeSet, previewSceneChanges }: typeof import('../scripts/lib/scene-change-set') = require('../scripts/lib/scene-change-set');
const products: typeof import('./maintenance-content-products') = require('./maintenance-content-products');
const { readJson, validateTags, sanitizeCuration }: typeof import('./maintenance-validation') = require('./maintenance-validation');
const recoveryFs: typeof import('../scripts/lib/maintenance-recovery-fs') = require('../scripts/lib/maintenance-recovery-fs');
const { acquireMaintenanceLease, maintenanceReadToken, assertMaintenanceReadToken }: typeof import('../scripts/lib/maintenance-lease') = require('../scripts/lib/maintenance-lease');
const { prepareMaintenanceTransaction, commitMaintenanceTransaction, rollbackMaintenanceTransaction }: typeof import('../scripts/lib/maintenance-transaction') = require('../scripts/lib/maintenance-transaction');
const writeFileAtomic = (file: any, bytes: any) => recoveryFs.atomicWrite(file, bytes, true);
const writeJson = (file: any, value: any) => writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');

function conflictSummary(current: any, incoming: any, baseVersion: any, currentVersion: any) {
  const old = new Map(current.map((scene: any) => [scene.id, scene]));
  const next = new Set(incoming.map((scene: any) => scene.id));
  return {
    baseVersion, currentVersion,
    serverOnlyIds: current.filter((scene: any) => !next.has(scene.id)).map((scene: any) => scene.id),
    clientNewIds: incoming.filter((scene: any) => !old.has(scene.id)).map((scene: any) => scene.id),
    changedIds: incoming.filter((scene: any) => old.has(scene.id) && JSON.stringify(old.get(scene.id)) !== JSON.stringify(scene)).map((scene: any) => scene.id),
  };
}

function registerSceneMaintenance({ router, cfg, sceneStore, localOnly, packaged, unavailable,
  maintenanceSnapshot, runMaintenanceChecks, runNodeScript, syncVersion, timeoutMs }: any) {
  const leaseOptions = { rootDir: cfg.ROOT_DIR, runtimeRoot: cfg.RUNTIME_ROOT, showcaseRoot: cfg.SCENE_SHOWCASE_DIR };
  let sceneStateCache: { root: string; version: number; value: any } | null = null;
  function invalidateSceneStateCache() { sceneStateCache = null; }
  function readSceneStateCached() {
    const version = sceneContentVersion(cfg.ROOT_DIR);
    if (sceneStateCache && sceneStateCache.root === cfg.ROOT_DIR && sceneStateCache.version === version)
      return sceneStateCache.value;
    const value = readSceneState(cfg.ROOT_DIR, sceneStore, sceneWrite, leaseOptions);
    sceneStateCache = { root: cfg.ROOT_DIR, version, value };
    return value;
  }

  async function save(req: any, res: any, mode: any) {
    if (packaged(cfg)) return unavailable(req, res);
    return sceneWrite.withSceneWriteLock(async () => {
      let snapshot;
      let lease;
      try {
        const readToken = maintenanceReadToken(leaseOptions);
        if (path.resolve(sceneStore.shardsDir) !== path.resolve(cfg.ROOT_DIR, 'data', 'scenes')) throw new Error('场景数据根与维护根不一致');
        const body = req.body || {};
        const baseVersion = body.baseVersion;
        if (!Number.isSafeInteger(baseVersion)) {
          return envelope.fail(res, 409, '保存缺少读取基线版本（baseVersion）。请先重新加载场景库再保存。', {
            code: 'SCENE_BASE_VERSION_REQUIRED', conflict: { currentVersion: sceneContentVersion(cfg.ROOT_DIR) },
          });
        }
        const state = readSceneState(cfg.ROOT_DIR, sceneStore, sceneWrite, leaseOptions);
        if (baseVersion !== state.version) {
          const incoming = mode === 'import' ? (Array.isArray(body.scenes) ? body.scenes : []) : (body.changeSet?.scenes?.upsert || []);
          const conflict = conflictSummary(state.snapshot.scenes, Array.isArray(incoming) ? incoming : [], baseVersion, state.version);
          if (mode !== 'import') conflict.serverOnlyIds = [];
          throw Object.assign(new Error('场景库在编辑期间已被更新，请先导出草稿，再重新读取并合并改动。'), { statusCode: 409, conflict });
        }
        if (mode !== 'import' && ['scenes', 'blueprints', 'tags', 'curation'].some(key => Object.hasOwn(body, key))) throw new Error('变更集请求不得混入全量快照');
        const incoming = mode === 'import' ? body : resolveSceneChangeSet(state.snapshot, body.changeSet);
        const { scenes, tags, curation, blueprints } = incoming;
        validateCollection(scenes, '场景', MAX_SCENES);
        if (!scenes.length) throw new Error('场景库不能为空');
        if (blueprints !== undefined) validateCollection(blueprints, '蓝图', MAX_BLUEPRINTS);
        const ids = new Set(scenes.map((scene: any) => scene.id));
        const retiredIds = sceneWrite.readRetiredSceneIds(path.join(cfg.ROOT_DIR, 'data'));
        for (const scene of scenes) if (retiredIds.has(scene.id)) throw new Error(scene.id + ' 已退役，不能复用已退役身份');
        products.protectPinnedScenes(cfg.ROOT_DIR, state.snapshot.scenes, scenes);
        if (tags !== undefined) validateTags(tags);
        const cleanCuration = curation !== undefined ? sanitizeCuration(curation, ids, state.snapshot.curation) : null;
        const prepared = blueprints !== undefined ? products.prepareBlueprints(cfg.ROOT_DIR, blueprints, state.snapshot.blueprints) : null;
        const previous = sceneStore.loadSceneShards();
        const scenePlan = sceneWrite.applySceneChanges(scenes, previous, { retiredIds, planOnly: true });
        assertMaintenanceReadToken(leaseOptions, readToken);
        if (mode === 'preview') return res.json({ ok: true, ...previewSceneChanges(state.snapshot, incoming, state.version) });
        lease = acquireMaintenanceLease(leaseOptions);
        if (state.version !== sceneContentVersion(cfg.ROOT_DIR)) throw Object.assign(new Error('获取保存锁后基线已变化，请重新读取'), { statusCode: 409, code: 'MAINTENANCE_CONFLICT' });
        const removed = previous.scenes.filter((scene: any) => !ids.has(scene.id)).map((scene: any) => scene.id);
        snapshot = maintenanceSnapshot(removed);
        const captured = new Set(snapshot.map((entry: any) => entry.file));
        for (const name of scenePlan.touchedFiles) {
          const file = path.join(sceneStore.shardsDir, String(name));
          if (!captured.has(file)) {
            snapshot.push(...recoveryFs.snapshotFiles([file]));
            captured.add(file);
          }
        }
        // Exact planned paths include new batches. Never delete unrelated new files
        // by scanning the shared directory during rollback.
        delete snapshot.shardsDir;
        if (prepared) {
          for (const entry of prepared.snapshotEntries) {
            if (!captured.has(entry.file)) { snapshot.push(entry); captured.add(entry.file); }
          }
        }
        snapshot = products.includeCompressedSnapshots(snapshot);
        if (state.version !== sceneContentVersion(cfg.ROOT_DIR)) throw Object.assign(new Error('准备保存时内容发生变化，请重新读取'), { statusCode: 409, conflict: { baseVersion, currentVersion: sceneContentVersion(cfg.ROOT_DIR) } });
        const backup = prepareMaintenanceTransaction(lease, leaseOptions, snapshot, prepared ? 'content-blueprints' : 'content');
        const changes = sceneWrite.applySceneChanges(scenes, previous, { retiredIds });
        sceneStore.writeAggregate(scenes);
        if (tags !== undefined) writeJson(path.join(cfg.ROOT_DIR, 'data', 'tags.json'), tags);
        if (curation !== undefined) writeJson(path.join(cfg.ROOT_DIR, 'data', 'curation.json'), cleanCuration);
        if (prepared) products.applyBlueprints(prepared, writeFileAtomic);
        sceneWrite.retireRemovedScenes({
          incomingScenes: scenes, previousScenes: previous.scenes, rootDir: cfg.ROOT_DIR,
          showcaseDir: cfg.SCENE_SHOWCASE_DIR,
          io: { readJson, writeJson, sanitizeCuration }, log: (line: any) => console.log(line),
        });
        sceneWrite.cleanOrphanedSceneRefs({ rootDir: cfg.ROOT_DIR, io: { readJson, writeJson, sanitizeCuration } });
        await runMaintenanceChecks(lease);
        // Normalizers and curation cleanup can change products too. Refresh all companions
        // and DATA_VERSION before the content validator observes this transaction.
        products.refreshCompressedProducts(cfg.ROOT_DIR, writeFileAtomic, snapshot.map((entry: any) => entry.file));
        syncVersion(cfg.ROOT_DIR);
        if (prepared) {
          const result = await runNodeScript('scripts/maintenance/validate-content-contracts.js', [], timeoutMs, lease);
          if (result.status !== 0) throw new Error((result.stderr || result.stdout || '蓝图内容契约校验失败').trim().slice(-1200));
        }
        const saved = readSceneState(cfg.ROOT_DIR, sceneStore, sceneWrite, leaseOptions, lease);
        products.protectPinnedScenes(cfg.ROOT_DIR, state.snapshot.scenes, saved.snapshot.scenes);
        commitMaintenanceTransaction(lease);
        lease = undefined;
        return res.json({
          ok: true, count: saved.snapshot.scenes.length,
          blueprintCount: blueprints !== undefined ? saved.snapshot.blueprints.length : undefined,
          tagCount: Array.isArray(tags) ? tags.length : undefined,
          version: saved.version, snapshot: saved.snapshot, backup: path.basename(backup),
          added: changes.addedIds, updated: changes.updatedIds, removed: changes.removedIds,
          submission: mode, message: '内容已保存并通过校验',
        });
      } catch (error: any) {
        const rollback = lease ? rollbackMaintenanceTransaction(lease, leaseOptions) : { ok: !error.recoveryRequired };
        return res.status(runtimeErrorStatus(error, 'statusCode') || (rollback.ok ? 400 : 500)).json({
          ok: false, error: runtimeErrorMessage(error), code: runtimeErrorCode(error), conflict: error.conflict, rolledBack: rollback.ok,
          dataIntegrity: rollback.ok ? 'restored' : 'INCONSISTENT',
          recoveryRequired: !rollback.ok, transactionId: error.transactionId || lease?.nonce,
          recovery: rollback.ok ? undefined : '维护事务尚未完整结束，请先使用恢复工具核验。' + (rollback.error || ''),
        });
      }
    });
  }

  // Legacy full snapshots remain compatible; ordinary editing uses /changes.
  for (const [url, mode] of [
    ['/api/maintenance/scenes', 'import'], ['/api/maintenance/scenes/import', 'import'],
    ['/api/maintenance/scenes/changes', 'changes'], ['/api/maintenance/scenes/preview', 'preview'],
  ]) router.post(url, localOnly, express.json({ limit: '20mb' }), (req: any, res: any) => {
    invalidateSceneStateCache();
    res.once('finish', invalidateSceneStateCache);
    res.once('close', invalidateSceneStateCache);
    return save(req, res, mode);
  });

  router.get('/api/maintenance/scenes-state', localOnly, async (req: any, res: any) => {
    if (packaged(cfg)) return unavailable(req, res);
    return sceneWrite.withSceneWriteLock(() => {
      try {
        res.set('Cache-Control', 'no-store');
        res.json({ ok: true, ...readSceneStateCached() });
      } catch (error: any) { envelope.fail(res, runtimeErrorStatus(error, 'statusCode') || 500, runtimeErrorMessage(error) || '读取场景状态失败', { code: runtimeErrorCode(error), recoveryRequired: Boolean(error.recoveryRequired) }); }
    });
  });
}

export = { registerSceneMaintenance, conflictSummary };
