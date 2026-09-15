'use strict';

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const envelope = require('../server/http-envelope');
const { sceneContentVersion, readSceneState } = require('./maintenance-scene-state');
const sceneWrite = require('../scripts/lib/scene-write');
const { MAX_SCENES, MAX_BLUEPRINTS, validateCollection, resolveSceneChangeSet, previewSceneChanges } = require('../scripts/lib/scene-change-set');
const products = require('./maintenance-content-products');
const { readJson, writeJson, writeFileAtomic, validateTags, sanitizeCuration } = require('./maintenance-validation');
const { saveSnapshotBackup } = require('./maintenance-backup');

function conflictSummary(current, incoming, baseVersion, currentVersion) {
  const old = new Map(current.map(scene => [scene.id, scene]));
  const next = new Set(incoming.map(scene => scene.id));
  return {
    baseVersion, currentVersion,
    serverOnlyIds: current.filter(scene => !next.has(scene.id)).map(scene => scene.id),
    clientNewIds: incoming.filter(scene => !old.has(scene.id)).map(scene => scene.id),
    changedIds: incoming.filter(scene => old.has(scene.id) && JSON.stringify(old.get(scene.id)) !== JSON.stringify(scene)).map(scene => scene.id),
  };
}

function registerSceneMaintenance({ router, cfg, sceneStore, localOnly, packaged, unavailable,
  maintenanceSnapshot, attemptRollback, runMaintenanceChecks, runNodeScript, syncVersion, timeoutMs }) {
  const backupRoot = path.join(cfg.RUNTIME_ROOT, 'maintenance-backups');

  async function save(req, res, mode) {
    if (packaged(cfg)) return unavailable(req, res);
    return sceneWrite.withSceneWriteLock(async () => {
      let snapshot;
      let mutationStarted = false;
      try {
        if (path.resolve(sceneStore.shardsDir) !== path.resolve(cfg.ROOT_DIR, 'data', 'scenes')) throw new Error('场景数据根与维护根不一致');
        const body = req.body || {};
        const baseVersion = body.baseVersion;
        if (!Number.isSafeInteger(baseVersion)) {
          return envelope.fail(res, 409, '保存缺少读取基线版本（baseVersion）。请先重新加载场景库再保存。', {
            code: 'SCENE_BASE_VERSION_REQUIRED', conflict: { currentVersion: sceneContentVersion(cfg.ROOT_DIR) },
          });
        }
        const state = readSceneState(cfg.ROOT_DIR, sceneStore, sceneWrite);
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
        const ids = new Set(scenes.map(scene => scene.id));
        const retiredIds = sceneWrite.readRetiredSceneIds(path.join(cfg.ROOT_DIR, 'data'));
        for (const scene of scenes) if (retiredIds.has(scene.id)) throw new Error(scene.id + ' 已退役，不能复用已退役身份');
        products.protectPinnedScenes(cfg.ROOT_DIR, state.snapshot.scenes, scenes);
        if (tags !== undefined) validateTags(tags);
        const cleanCuration = curation !== undefined ? sanitizeCuration(curation, ids, state.snapshot.curation) : null;
        const prepared = blueprints !== undefined ? products.prepareBlueprints(cfg.ROOT_DIR, blueprints, state.snapshot.blueprints) : null;
        const previous = sceneStore.loadSceneShards();
        const scenePlan = sceneWrite.applySceneChanges(scenes, previous, { retiredIds, planOnly: true });
        if (mode === 'preview') return res.json({ ok: true, ...previewSceneChanges(state.snapshot, incoming, state.version) });
        const removed = previous.scenes.filter(scene => !ids.has(scene.id)).map(scene => scene.id);
        snapshot = maintenanceSnapshot(removed);
        const captured = new Set(snapshot.map(entry => entry.file));
        for (const name of scenePlan.touchedFiles) {
          const file = path.join(sceneStore.shardsDir, name);
          if (!captured.has(file)) {
            const exists = fs.existsSync(file);
            snapshot.push({ file, exists, content: exists ? fs.readFileSync(file) : null });
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
        if (state.version !== sceneContentVersion(cfg.ROOT_DIR)) throw Object.assign(new Error('准备保存时内容发生变化，请重新读取'), { statusCode: 409, conflict: { baseVersion, currentVersion: sceneContentVersion(cfg.ROOT_DIR) } });
        const backup = saveSnapshotBackup(snapshot, backupRoot, prepared ? 'content-blueprints' : 'content');
        mutationStarted = true;
        const changes = sceneWrite.applySceneChanges(scenes, previous, { retiredIds });
        sceneStore.writeAggregate(scenes);
        if (tags !== undefined) writeJson(path.join(cfg.ROOT_DIR, 'data', 'tags.json'), tags);
        if (curation !== undefined) writeJson(path.join(cfg.ROOT_DIR, 'data', 'curation.json'), cleanCuration);
        if (prepared) products.applyBlueprints(prepared, writeFileAtomic);
        sceneWrite.retireRemovedScenes({
          incomingScenes: scenes, previousScenes: previous.scenes, rootDir: cfg.ROOT_DIR,
          showcaseDir: cfg.SCENE_SHOWCASE_DIR,
          io: { readJson, writeJson, sanitizeCuration }, log: line => console.log(line),
        });
        sceneWrite.cleanOrphanedSceneRefs({ rootDir: cfg.ROOT_DIR, io: { readJson, writeJson, sanitizeCuration } });
        await runMaintenanceChecks();
        // Normalizers and curation cleanup can change products too. Refresh all companions
        // and DATA_VERSION before the content validator observes this transaction.
        products.refreshCompressedProducts(cfg.ROOT_DIR, writeFileAtomic);
        syncVersion(cfg.ROOT_DIR);
        if (prepared) {
          const result = await runNodeScript('scripts/maintenance/validate-content-contracts.js', [], timeoutMs);
          if (result.status !== 0) throw new Error((result.stderr || result.stdout || '蓝图内容契约校验失败').trim().slice(-1200));
        }
        const saved = readSceneState(cfg.ROOT_DIR, sceneStore, sceneWrite);
        return res.json({
          ok: true, count: saved.snapshot.scenes.length,
          blueprintCount: blueprints !== undefined ? saved.snapshot.blueprints.length : undefined,
          tagCount: Array.isArray(tags) ? tags.length : undefined,
          version: saved.version, snapshot: saved.snapshot, backup: path.basename(backup),
          added: changes.addedIds, updated: changes.updatedIds, removed: changes.removedIds,
          submission: mode, message: '内容已保存并通过校验',
        });
      } catch (error) {
        const rollback = attemptRollback(mutationStarted ? snapshot : undefined, 'scenes');
        return res.status(rollback.ok ? (error.statusCode || 400) : 500).json({
          ok: false, error: error.message, conflict: error.conflict, rolledBack: rollback.ok,
          dataIntegrity: rollback.ok ? 'restored' : 'INCONSISTENT',
          recovery: rollback.ok ? undefined : '自动回滚也失败了（' + rollback.error + '）。请从本次 content 备份恢复，恢复前不要继续保存。',
        });
      }
    });
  }

  // Legacy full snapshots remain compatible; ordinary editing uses /changes.
  for (const [url, mode] of [
    ['/api/maintenance/scenes', 'import'], ['/api/maintenance/scenes/import', 'import'],
    ['/api/maintenance/scenes/changes', 'changes'], ['/api/maintenance/scenes/preview', 'preview'],
  ]) router.post(url, localOnly, express.json({ limit: '20mb' }), (req, res) => save(req, res, mode));

  router.get('/api/maintenance/scenes-state', localOnly, async (req, res) => {
    if (packaged(cfg)) return unavailable(req, res);
    return sceneWrite.withSceneWriteLock(() => {
      try {
        res.set('Cache-Control', 'no-store');
        res.json({ ok: true, ...readSceneState(cfg.ROOT_DIR, sceneStore, sceneWrite) });
      } catch (error) { envelope.fail(res, 500, error.message || '读取场景状态失败'); }
    });
  });
}

module.exports = { registerSceneMaintenance, conflictSummary };
