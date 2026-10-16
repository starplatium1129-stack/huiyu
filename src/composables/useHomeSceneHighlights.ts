import { onMounted, onScopeDispose, shallowRef, toRaw, watch } from 'vue'
import { apiClient } from '@/api/client'
import { catalogApi } from '@/api/catalogApi'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { profileLocalStorage } from '@/platform/web/profileStorage'
import { SCENE_DATA_TIMEOUT_MS, useSceneStore, type CurationData, type Scene, type SceneIndex } from '@/stores/sceneStore'
import { readRecent } from '@/utils/sceneUX'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { parseShowcaseManifest } from '@/utils/showcaseManifest'

export type HomeScene = Scene & { title?: string; mature?: boolean; image?: string }
interface HomeMetadata { curation: CurationData; index: SceneIndex }
interface HomeSample { image: string; rating: string }
interface HomeCache {
  key: string
  metadata?: HomeMetadata
  samples?: Map<string, HomeSample>
  records: Map<string, HomeScene>
  remaining: string[]
  shown: string[]
}
let cache: HomeCache | undefined

function homeScene(value: unknown): value is HomeScene {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const scene = value as Record<string, unknown>
  return typeof scene.id === 'string' && (scene.mature === undefined || typeof scene.mature === 'boolean')
}

function shuffle(ids: string[]) {
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const value = ids[i]!
    ids[i] = ids[j]!; ids[j] = value
  }
  return ids
}

/** Deal every published scene before refilling; keep the previous spread at the end. */
function selectScenes(curation: CurationData, available: ReadonlySet<string>, recent: string[], snapshot: HomeCache) {
  const signatures = Array.isArray(curation.signatureSceneIds) ? curation.signatureSceneIds : []
  const curated = Array.isArray(curation.curatedSceneIds) ? curation.curatedSceneIds : []
  const pool = new Set((snapshot.samples ? [...snapshot.samples.keys()] : [...signatures, ...curated]).filter(id => available.has(id)))
  const remaining = snapshot.remaining.filter(id => pool.has(id))
  const featured = remaining.splice(0, 3)
  if (featured.length < Math.min(3, pool.size)) {
    const refill = [...pool].filter(id => !featured.includes(id))
    remaining.push(...shuffle(refill.filter(id => !snapshot.shown.includes(id))), ...shuffle(refill.filter(id => snapshot.shown.includes(id))))
    featured.push(...remaining.splice(0, 3 - featured.length))
  }
  return { featured, remaining, canRefresh: pool.size > 3, recent: recent.filter(id => available.has(id)).slice(0, 6) }
}

/** The home cards need only their selected records; full search keeps loadHome's contract. */
export function useHomeSceneHighlights() {
  const store = useSceneStore()
  const featuredScenes = shallowRef<HomeScene[]>([]), recentScenes = shallowRef<HomeScene[]>([])
  const loading = shallowRef(false), error = shallowRef(''), canRefresh = shallowRef(false)
  let request: AbortController | undefined
  let disposed = false

  async function load() {
    if (disposed) return
    request?.abort()
    loading.value = true; error.value = ''
    const controller = new AbortController(), signal = controller.signal
    request = controller
    const version = store.version, identity = runtimeResourceIdentity(), day = new Date().toISOString().slice(0, 10)
    const key = JSON.stringify([version, identity, day])
    if (cache?.key !== key) cache = { key, records: new Map(), remaining: [], shown: [] }
    const snapshot = cache!
    const recent = readRecent(profileLocalStorage).map(item => item.id)
    let fullCatalogRequested = false
    const current = () => !disposed && !signal.aborted && store.version === version && runtimeResourceIdentity() === identity
    // Retain only published scene identities, paths and ratings from the manifest.
    const samplesRequest = snapshot.samples ? Promise.resolve(snapshot.samples) : apiClient.request('/scene-showcase/manifest.json', {
      signal, timeoutMs: SCENE_DATA_TIMEOUT_MS, cache: 'no-cache',
    }).then(raw => {
      const samples = new Map<string, HomeSample>()
      for (const entry of parseShowcaseManifest(raw).entries) {
        if (entry.type !== 'scene') continue
        const image = entry.image || `images/${entry.id}.jpg`
        if (/^images\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(image))
          samples.set(entry.id, { image: `/scene-showcase/${image}`, rating: entry.rating })
      }
      if (current()) snapshot.samples = samples
      return samples
    }).catch(() => undefined)
    function publish(selection: ReturnType<typeof selectScenes>, records: ReadonlyMap<string, HomeScene>) {
      if (!current()) return
      const rows = (ids: string[]) => ids.map(id => structuredClone(toRaw(records.get(id)!)))
      featuredScenes.value = rows(selection.featured).map(scene => {
        const sample = snapshot.samples?.get(scene.id)
        return { ...scene, image: sample?.image, rating: scene.rating === 'R18' ? 'R18' : sample?.rating ?? scene.rating }
      })
      recentScenes.value = rows(selection.recent)
      snapshot.remaining = selection.remaining; snapshot.shown = selection.featured
      canRefresh.value = selection.canRefresh
    }
    async function fullCatalog() {
      fullCatalogRequested = true
      const [catalog] = await Promise.all([store.loadBrowserScenes('all'), samplesRequest])
      if (!current()) return
      const records = new Map(catalog.scenes.filter(homeScene).map(scene => [scene.id, scene]))
      publish(selectScenes(catalog.curation, new Set(records.keys()), recent, snapshot), records)
    }
    try {
      // Static/remote hosts retain their supported shard endpoints. Local records
      // avoid transferring every scene's prompts merely to render the home cards.
      if (!isLocalStudioHost()) { await fullCatalog(); return }
      if (!snapshot.metadata) {
        const options = { signal, timeoutMs: SCENE_DATA_TIMEOUT_MS }
        const [curation, index] = await Promise.all([
          apiClient.request<CurationData>(`/data/curation.json?v=${version}`, options),
          apiClient.request<SceneIndex>(`/data/scenes-index.json?v=${version}`, options),
          samplesRequest,
        ])
        if (!current()) return
        if (!Array.isArray(index.orderedIds) || !index.orderedIds.every(id => typeof id === 'string')) throw new Error('场景索引不可用')
        snapshot.metadata = { curation, index }
      }
      await samplesRequest
      if (!current()) return
      const { curation, index } = snapshot.metadata
      const selection = selectScenes(curation, new Set(index.orderedIds!), recent, snapshot)
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
    } catch (cause) {
      if (!current()) return
      if (fullCatalogRequested) {
        error.value = '画页暂时无法更新，请再试一次。'
        console.warn('场景加载失败：', cause instanceof Error ? cause.message : String(cause))
        return
      }
      // A missing record or stale index falls back to the complete source.
      try { await fullCatalog() }
      catch (fallbackError) {
        if (current()) {
          error.value = '画页暂时无法更新，请再试一次。'
          console.warn('场景加载失败：', fallbackError instanceof Error ? fallbackError.message : String(fallbackError))
        }
      }
    } finally {
      controller.abort()
      if (request === controller) { request = undefined; loading.value = false }
    }
  }
  onMounted(() => { void load() })
  watch([() => store.version, runtimeResourceIdentity], () => { void load() })
  onScopeDispose(() => { disposed = true; request?.abort() })
  return { featuredScenes, recentScenes, loading, error, canRefresh, refresh: () => { if (!loading.value) void load() } }
}
