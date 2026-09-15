import type { SceneChangeSet, SceneMaintenanceSnapshot } from '@/types/api'
import { isSceneId } from './sceneId'

export const MAX_SCENES = 10_000
export const MAX_BLUEPRINTS = 2_000
export const MAX_SCENE_REQUEST_BYTES = 20 * 1024 * 1024

/** JSON data only; cloning also detaches Vue proxies and unknown extension fields. */
export function cloneSceneSnapshot(snapshot: SceneMaintenanceSnapshot): SceneMaintenanceSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as SceneMaintenanceSnapshot
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

/** Never share references between the editable draft, API receipts and the baseline. */
export function freezeSceneSnapshot(snapshot: SceneMaintenanceSnapshot): SceneMaintenanceSnapshot {
  return freezeDeep(cloneSceneSnapshot(snapshot))
}

/** Object key order is not a content edit; field-array order still matters. */
export function sceneContentKey(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const record = item as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]))
  })
}

function indexCollection<T extends { id: string }>(items: T[], kind: '场景' | '蓝图', maximum: number): Map<string, T> {
  if (!Array.isArray(items) || items.length > maximum) throw new Error(`${kind}数量不能超过 ${maximum}`)
  const index = new Map<string, T>()
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || index.has(item.id)) {
      throw new Error(`${kind} ID 必须非空且唯一：${item?.id ?? ''}`)
    }
    if (kind === '场景' && !isSceneId(item.id)) throw new Error(`场景编号不规范：${item.id}`)
    index.set(item.id, item)
  }
  return index
}

function collectionChanges<T extends { id: string }>(before: T[], after: T[], kind: '场景' | '蓝图', maximum: number) {
  const old = indexCollection(before, kind, maximum)
  const current = indexCollection(after, kind, maximum)
  return {
    upsert: after.filter(item => !old.has(item.id) || sceneContentKey(old.get(item.id)) !== sceneContentKey(item)),
    remove: before.filter(item => !current.has(item.id)).map(item => item.id),
  }
}

export function buildSceneChangeSet(baseline: SceneMaintenanceSnapshot, draft: SceneMaintenanceSnapshot): SceneChangeSet {
  const changeSet: SceneChangeSet = {
    version: 1,
    scenes: collectionChanges(baseline.scenes, draft.scenes, '场景', MAX_SCENES),
  }
  const blueprints = collectionChanges(baseline.blueprints, draft.blueprints, '蓝图', MAX_BLUEPRINTS)
  if (blueprints.upsert.length || blueprints.remove.length) changeSet.blueprints = blueprints
  if (sceneContentKey(baseline.tags) !== sceneContentKey(draft.tags)) changeSet.tags = draft.tags
  if (sceneContentKey(baseline.curation) !== sceneContentKey(draft.curation)) changeSet.curation = draft.curation
  // Requests must remain unchanged while the user continues editing.
  return JSON.parse(JSON.stringify(changeSet)) as SceneChangeSet
}

export function hasSceneChanges(changeSet: SceneChangeSet): boolean {
  return !!(changeSet.scenes.upsert.length || changeSet.scenes.remove.length
    || changeSet.blueprints?.upsert.length || changeSet.blueprints?.remove.length
    || changeSet.tags !== undefined || changeSet.curation !== undefined)
}

/** Explicit full import requires all four collections; missing fields never mean deletion. */
export function parseSceneSnapshot(input: string): SceneMaintenanceSnapshot {
  if (new TextEncoder().encode(input).byteLength > MAX_SCENE_REQUEST_BYTES) throw new Error('导入 JSON 不能超过 20 MB')
  const value: unknown = JSON.parse(input)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('完整导入需要包含 scenes、blueprints、tags、curation 的快照对象')
  const data = value as Record<string, unknown>
  if (!Array.isArray(data.scenes) || !Array.isArray(data.blueprints) || !Array.isArray(data.tags)
    || !data.curation || typeof data.curation !== 'object' || Array.isArray(data.curation)) {
    throw new Error('完整快照缺少 scenes、blueprints、tags 或 curation；请先导出完整 JSON')
  }
  if (data.version !== undefined && data.version !== 1) throw new Error('不支持的快照格式版本')
  const snapshot = data as unknown as SceneMaintenanceSnapshot
  indexCollection(snapshot.scenes, '场景', MAX_SCENES)
  indexCollection(snapshot.blueprints, '蓝图', MAX_BLUEPRINTS)
  if (!snapshot.scenes.length) throw new Error('场景库不能为空')
  for (const scene of snapshot.scenes) {
    if (['title', 'story', 'char'].some(key => typeof scene[key] !== 'string' || !(scene[key] as string).trim())
      || !['All', 'R15', 'R18'].includes(scene.rating)) throw new Error('场景必填字段或分级非法：' + scene.id)
  }
  for (const blueprint of snapshot.blueprints) {
    if (!blueprint.title?.trim() || !blueprint.characterId?.trim() || typeof blueprint.promptProse !== 'string'
      || !Array.isArray(blueprint.promptTokens) || !Array.isArray(blueprint.negativeTokens)) {
      throw new Error('蓝图必填字段不完整：' + blueprint.id)
    }
  }
  const tagIds = new Set<string>()
  for (const tag of snapshot.tags) {
    if (!tag || ['id', 'en', 'cn', 'cat'].some(key => typeof tag[key] !== 'string' || !(tag[key] as string).trim())
      || typeof tag.weight !== 'number' || !Number.isFinite(tag.weight) || tagIds.has(tag.id)) throw new Error('标签字段非法或 ID 重复')
    tagIds.add(tag.id)
  }
  return cloneSceneSnapshot({ scenes: snapshot.scenes, tags: snapshot.tags, curation: snapshot.curation, blueprints: snapshot.blueprints })
}
