'use strict';

const { isSceneId }: typeof import('./scene-id') = require('./scene-id');
const MAX_SCENES = 10000;
const MAX_BLUEPRINTS = 2000;

function invalid(message: any) {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function object(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function validateCollection(items: any, kind: any, maximum: any) {
  if (!Array.isArray(items) || items.length > maximum) invalid(kind + ' 数据格式或数量超出限制');
  const seen = new Set();
  for (const item of items) {
    const id = item && item.id;
    if (!object(item) || typeof id !== 'string' || !id.trim() || seen.has(id)) invalid(kind + ' ID 必须非空且唯一：' + id);
    if (kind === '场景' && !isSceneId(id)) invalid('场景 ID 必须符合 sc001 / sc1000 格式：' + id);
    if (kind === '蓝图') {
      for (const key of ['characterId', 'title']) {
        if (typeof item[key] !== 'string' || !item[key].trim()) invalid('蓝图缺少 ' + key + '：' + id);
      }
      if (!Array.isArray(item.promptTokens) || !Array.isArray(item.negativeTokens)) invalid('蓝图 promptTokens/negativeTokens 必须为数组：' + id);
      if (typeof item.promptProse !== 'string') invalid('蓝图缺少 promptProse：' + id);
    }
    seen.add(id);
  }
}

function applyCollection(current: any, change: any, kind: any, maximum: any) {
  if (!object(change) || Object.keys(change).some(key => !['upsert', 'remove'].includes(key))) invalid(kind + ' 变更集格式错误');
  validateCollection(change.upsert, kind, maximum);
  if (!Array.isArray(change.remove) || change.remove.length > maximum) invalid(kind + ' remove 必须为 ID 数组');
  const currentIds = new Set(current.map((item: any) => item.id));
  const removed = new Set();
  const updates = new Map(change.upsert.map((item: any) => [item.id, item]));
  for (const id of change.remove) {
    if (typeof id !== 'string' || !currentIds.has(id) || removed.has(id) || updates.has(id)) invalid(kind + ' 删除 ID 不存在、重复或同时更新：' + id);
    removed.add(id);
  }
  const result = current.filter((item: any) => !removed.has(item.id)).map((item: any) => updates.get(item.id) || item);
  for (const item of change.upsert) if (!currentIds.has(item.id)) result.push(item);
  validateCollection(result, kind, maximum);
  return structuredClone(result);
}

function resolveSceneChangeSet(current: any, changeSet: any) {
  if (!object(changeSet) || changeSet.version !== 1
    || Object.keys(changeSet).some(key => !['version', 'scenes', 'blueprints', 'tags', 'curation'].includes(key))) invalid('不支持的场景变更集；需要 version: 1');
  const result = {
    scenes: applyCollection(current.scenes, changeSet.scenes, '场景', MAX_SCENES),
  };
  if (!result.scenes.length) invalid('场景库不能为空');
  if (changeSet.blueprints !== undefined) result.blueprints = applyCollection(current.blueprints, changeSet.blueprints, '蓝图', MAX_BLUEPRINTS);
  for (const field of ['tags', 'curation']) {
    if (changeSet[field] !== undefined) result[field] = structuredClone(changeSet[field]);
  }
  return result;
}

function collectionDiff(before: any, after: any) {
  const old = new Map(before.map((item: any) => [item.id, item]));
  const incoming = new Set(after.map((item: any) => item.id));
  return {
    added: after.filter((item: any) => !old.has(item.id)).map((item: any) => item.id),
    updated: after.filter((item: any) => old.has(item.id) && JSON.stringify(old.get(item.id)) !== JSON.stringify(item)).map((item: any) => item.id),
    removed: before.filter((item: any) => !incoming.has(item.id)).map((item: any) => item.id),
  };
}

function previewSceneChanges(current: any, next: any, version: any) {
  const scenes = collectionDiff(current.scenes, next.scenes);
  const blueprints = collectionDiff(current.blueprints, next.blueprints || current.blueprints);
  const affected = new Set([...scenes.added, ...scenes.updated, ...scenes.removed]);
  const related = [];
  for (const [key, value] of Object.entries(current.curation || {})) {
    const ids = Array.isArray(value) ? value : object(value) ? Object.keys(value) : [];
    for (const id of ids) if (affected.has(id)) related.push({ kind: 'curation', id, reason: '策展引用：' + key });
  }
  for (const scene of next.scenes) {
    if (affected.has(scene.id)) related.push({ kind: 'scene', id: scene.id, reason: '角色：' + String(scene.char || '未知') + '；服装：' + String(scene.outfitId || '未声明') });
  }
  for (const bp of next.blueprints || current.blueprints) {
    if ([...blueprints.added, ...blueprints.updated].includes(bp.id)) related.push({ kind: 'blueprint', id: bp.id, reason: '角色：' + bp.characterId + '；服装：' + String(bp.outfitId || '未声明') });
  }
  return {
    baseVersion: version, version, ...scenes, blueprints, related,
    checks: ['场景源分片完整性与读取基线', '定稿保护、退役身份、标签与策展校验', '保存后场景校验、压缩产物与版本一致性', ...(next.blueprints ? ['蓝图源分片计划与完整内容契约'] : [])],
    unknown: ['外部样张、真实模型画面与主力机设备尚未验收；结构预览不会修改审核结论。'],
  };
}

export = { MAX_SCENES, MAX_BLUEPRINTS, validateCollection, resolveSceneChangeSet, collectionDiff, previewSceneChanges };
