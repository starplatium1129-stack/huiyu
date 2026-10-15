import { onMounted, onScopeDispose, shallowRef, toRaw, watch } from 'vue'
import { apiClient } from '@/api/client'
import { catalogApi } from '@/api/catalogApi'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { profileLocalStorage } from '@/platform/web/profileStorage'
import { SCENE_DATA_TIMEOUT_MS, useSceneStore, type CurationData, type Scene, type SceneIndex } from '@/stores/sceneStore'
import { readRecent } from '@/utils/sceneUX'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

export type HomeScene = Scene & { title?: string; mature?: boolean }
interface HomeMetadata { curation: CurationData; index: SceneIndex }
let cache: { key: string; metadata?: HomeMetadata; records: Map<string, HomeScene> } | undefined

function homeScene(value: unknown): value is HomeScene {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const scene = value as Record<string, unknown>
  return typeof scene.id === 'string' && (scene.mature === undefined || typeof scene.mature === 'boolean')
}

/** Preserve the existing daily rotation after excluding IDs absent from the catalog. */
function selectScenes(curation: CurationData, available: ReadonlySet<string>, recent: string[], day: string) {
  const signatures = Array.isArray(curation.signatureSceneIds) ? curation.signatureSceneIds : []
  const curated = Array.isArray(curation.curatedSceneIds) ? curation.curatedSceneIds : []
  const pool = [...signatures, ...curated.filter(id => !signatures.includes(id))].filter(id => available.has(id))
  let seed = 0
  for (let i = 0; i < day.length; i++) seed = (seed * 31 + day.charCodeAt(i)) >>> 0
  const featured = pool.length ? Array.from({ length: 6 }, (_, i) => pool[(seed % pool.length + i) % pool.length]!) : []
  return { featured, recent: recent.filter(id => available.has(id)).slice(0, 6) }
}

/** The home cards need only their selected records; full search keeps loadHome's contract. */
export function useHomeSceneHighlights() {
  const store = useSceneStore()
  const featuredScenes = shallowRef<HomeScene[]>([]), recentScenes = shallowRef<HomeScene[]>([])
  let request: AbortController | undefined
  let disposed = false

  async function load() {
    request?.abort()
    const controller = new AbortController(), signal = controller.signal
    request = controller
    const version = store.version, identity = runtimeResourceIdentity(), day = new Date().toISOString().slice(0, 10)
    const key = JSON.stringify([version, identity, day])
    if (cache?.key !== key) cache = { key, records: new Map() }
    const snapshot = cache!
    const recent = readRecent(profileLocalStorage).map(item => item.id)
    let fullCatalogRequested = false
    const current = () => !disposed && !signal.aborted && store.version === version && runtimeResourceIdentity() === identity
    function publish(selection: ReturnType<typeof selectScenes>, records: ReadonlyMap<string, HomeScene>) {
      if (!current()) return
      const rows = (ids: string[]) => ids.map(id => structuredClone(toRaw(records.get(id)!)))
      featuredScenes.value = rows(selection.featured)
      recentScenes.value = rows(selection.recent)
    }
    async function fullCatalog() {
      fullCatalogRequested = true
      const catalog = await store.loadBrowserScenes('all')
      if (!current()) return
      const records = new Map(catalog.scenes.filter(homeScene).map(scene => [scene.id, scene]))
      publish(selectScenes(catalog.curation, new Set(records.keys()), recent, day), records)
    }
    try {
      // Static/remote hosts retain their supported shard endpoints. Local records
      // avoid transferring every scene's prompts merely to render twelve cards.
      if (!isLocalStudioHost()) { await fullCatalog(); return }
      if (!snapshot.metadata) {
        const options = { signal, timeoutMs: SCENE_DATA_TIMEOUT_MS }
        const [curation, index] = await Promise.all([
          apiClient.request<CurationData>(`/data/curation.json?v=${version}`, options),
          apiClient.request<SceneIndex>(`/data/scenes-index.json?v=${version}`, options),
        ])
        if (!current()) return
        if (!Array.isArray(index.orderedIds) || !index.orderedIds.every(id => typeof id === 'string')) throw new Error('场景索引不可用')
        snapshot.metadata = { curation, index }
      }
      const { curation, index } = snapshot.metadata
      const selection = selectScenes(curation, new Set(index.orderedIds!), recent, day)
      const ids = [...new Set([...selection.featured, ...selection.recent])]
      for (const id of snapshot.records.keys()) if (!ids.includes(id)) snapshot.records.delete(id)
      const known = new Map(store.scenes.filter(homeScene).map(scene => [scene.id, scene]))
      await Promise.all(ids.map(async id => {
        if (snapshot.records.has(id)) return
        const scene = known.get(id) ?? (await catalogApi.record('scene', id, undefined, signal)).record.data
        if (!homeScene(scene) || scene.id !== id) throw new Error(`场景 ${id} 暂不可用`)
        if (current()) snapshot.records.set(id, structuredClone(toRaw(scene)))
      }))
      if (current()) publish(selection, snapshot.records)
    } catch (error) {
      if (!current()) return
      if (fullCatalogRequested) {
        console.warn('场景加载失败：', error instanceof Error ? error.message : String(error))
        return
      }
      // A missing record or stale index must fall back to the complete source,
      // rather than silently shortening the daily pool and changing its rotation.
      try { await fullCatalog() }
      catch (fallbackError) { if (current()) console.warn('场景加载失败：', fallbackError instanceof Error ? fallbackError.message : String(fallbackError)) }
    } finally {
      controller.abort()
      if (request === controller) request = undefined
    }
  }
  onMounted(() => { void load() })
  watch([() => store.version, runtimeResourceIdentity], () => { void load() })
  onScopeDispose(() => { disposed = true; request?.abort() })
  return { featuredScenes, recentScenes }
}
