import { personalScore, sceneUsageScore, type PreferenceProfile, type SceneUsageMap, type SceneUXConfig } from '@/utils/sceneUX'
import type { ExplorerScene } from './sceneExplorerPresentation'

const idOrder = new Intl.Collator(undefined, { numeric: true })
const titleOrder = new Intl.Collator('zh-CN')
const baseOrder = (a: ExplorerScene, b: ExplorerScene) => (typeof a.sortOrder === 'number' ? a.sortOrder : Number.MAX_SAFE_INTEGER)
  - (typeof b.sortOrder === 'number' ? b.sortOrder : Number.MAX_SAFE_INTEGER) || idOrder.compare(a.id, b.id)
const created = (scene: ExplorerScene) => typeof scene.createdAt === 'string' ? Date.parse(scene.createdAt) || 0 : 0

/** Score each result once, instead of rescanning curation/history on every comparison. */
export function orderExplorerScenes(scenes: readonly ExplorerScene[], options: {
  mode: string
  curation: SceneUXConfig
  profile: PreferenceProfile
  usage: SceneUsageMap
  favorites: ReadonlySet<string>
  relevance: ReadonlyMap<string, number>
}): ExplorerScene[] {
  const { mode, curation, profile, usage, favorites, relevance } = options
  const ranks = new Map<string, number>()
  const scores = new Map<string, number>()
  if (mode !== 'newest' && mode !== 'title') {
    const needsCuration = mode !== 'used' && mode !== 'favorite'
    if (needsCuration) {
      const groups = [curation.personaCoreSceneIds || curation.signatureSceneIds || [], curation.signatureSceneIds || [], curation.curatedSceneIds || []]
      groups.forEach((ids, group) => ids.forEach((id, index) => {
        if (!ranks.has(id)) ranks.set(id, (3 - group) * 10000 - index)
      }))
    }
    for (const scene of scenes) {
      const curated = needsCuration ? ranks.get(scene.id) ?? 0 : 0
      const used = mode === 'used' || mode === 'favorite' || mode === 'smart' ? sceneUsageScore(usage[scene.id]) : 0
      const personal = mode === 'favorite' || mode === 'smart' ? personalScore(scene, profile) : 0
      scores.set(scene.id, mode === 'used' ? used : mode === 'favorite'
        ? (favorites.has(scene.id) ? 100000 : 0) + personal * 500 + used
        : mode === 'smart' ? used * 400 + personal * 500 + curated : curated)
    }
  }
  return [...scenes].sort((a, b) => {
    const relevant = (relevance.get(b.id) ?? 0) - (relevance.get(a.id) ?? 0)
    if (relevant) return relevant
    if (mode === 'newest') return created(b) - created(a) || baseOrder(a, b)
    if (mode === 'title') return titleOrder.compare(String(a.title), String(b.title)) || baseOrder(a, b)
    return (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || baseOrder(a, b)
  })
}
