import { onMounted, onScopeDispose, shallowRef, toRaw, watch } from 'vue'
import { apiClient } from '@/api/client'
import { catalogApi } from '@/api/catalogApi'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { profileLocalStorage } from '@/platform/web/profileStorage'
import { SCENE_DATA_TIMEOUT_MS, useSceneStore, type CurationData, type Scene, type SceneIndex } from '@/stores/sceneStore'
import { readRecent } from '@/utils/sceneUX'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { parseShowcaseManifest, type ShowcaseEntry } from '@/utils/showcaseManifest'

type HomeScene = Scene & { title?: string; mature?: boolean }
export interface HomeJournalEntry {
  id: string; title: string; story: string; category: string
  image?: string; rating?: string; mature?: boolean
  fallbackTo: string; fallbackLabel: string
}
interface HomeMetadata { curation: CurationData; index: SceneIndex }
type HomeSample = Pick<ShowcaseEntry, 'id' | 'title' | 'story' | 'category' | 'rating' | 'char'> & { type: 'scene' | 'popular'; image: string }
interface HomeCache {
  key: string
  metadata?: HomeMetadata
  samples?: Map<string, HomeSample>
  records: Map<string, HomeScene>
  remaining: string[]
  shown: string[]
  masked: Set<string>
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

/** Deal every eligible sample before refilling; keep the previous spread at the end. */
function selectScenes(curation: CurationData, available: ReadonlySet<string>, recent: string[], snapshot: HomeCache) {
  const signatures = Array.isArray(curation.signatureSceneIds) ? curation.signatureSceneIds : []
  const curated = Array.isArray(curation.curatedSceneIds) ? curation.curatedSceneIds : []
  const ids = snapshot.samples
    ? [...snapshot.samples].filter(([id, sample]) => sample.type === 'popular' || available.has(id)).map(([id]) => id)
    : [...signatures, ...curated].filter(id => available.has(id))
  const pool = new Set(ids.filter(id => !snapshot.masked.has(id)))
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
  const featuredScenes = shallowRef<HomeJournalEntry[]>([]), recentScenes = shallowRef<HomeScene[]>([])
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
    if (cache?.key !== key) cache = { key, records: new Map(), remaining: [], shown: [], masked: new Set() }
    const snapshot = cache!
    const recent = readRecent(profileLocalStorage).map(item => item.id)
    let fullCatalogRequested = false
    const current = () => !disposed && !signal.aborted && store.version === version && runtimeResourceIdentity() === identity
    // Keep the published card metadata without retaining prompts or generation history.
    const samplesRequest = snapshot.samples ? Promise.resolve(snapshot.samples) : apiClient.request('/scene-showcase/manifest.json', {
      signal, timeoutMs: SCENE_DATA_TIMEOUT_MS, cache: 'no-cache',
    }).then(raw => {
      const samples = new Map<string, HomeSample>()
      for (const entry of parseShowcaseManifest(raw).entries) {
        if ((entry.type !== 'scene' && entry.type !== 'popular') || entry.rating === 'R18') continue
        const image = entry.image || `images/${entry.id}.jpg`
        if (/^images\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(image))
          samples.set(entry.id, {
            id: entry.id, title: entry.title, story: entry.story, category: entry.category,
            char: entry.char, type: entry.type, image: `/scene-showcase/${image}`, rating: entry.rating,
          })
      }
      if (current()) snapshot.samples = samples
      return samples
    }).catch(() => undefined)
    function publish(selection: ReturnType<typeof selectScenes>, records: ReadonlyMap<string, HomeScene>) {
      if (!current()) return
      const rows = (ids: string[]) => ids.map(id => structuredClone(toRaw(records.get(id)!)))
      featuredScenes.value = selection.featured.map(id => {
        const sample = snapshot.samples?.get(id), popular = sample?.type === 'popular'
        const source = popular ? sample : records.get(id)!
        const text = (key: 'title' | 'story' | 'category') => typeof source[key] === 'string' ? source[key] : sample?.[key] || ''
        return {
          id, title: text('title'), story: text('story'), category: text('category'), image: sample?.image,
          rating: typeof source.rating === 'string' ? source.rating : sample?.rating,
          fallbackTo: popular ? '/popular-scenes?character=' + encodeURIComponent(sample.char) : '/scene-explorer?scene=' + encodeURIComponent(id),
          fallbackLabel: popular ? '查看角色场景' : '查看场景设定',
        }
      })
      recentScenes.value = rows(selection.recent)
      snapshot.remaining = selection.remaining; snapshot.shown = selection.featured
      canRefresh.value = selection.canRefresh
    }
    async function populate(curation: CurationData, available: ReadonlySet<string>, records: Map<string, HomeScene>) {
      const known = new Map(store.scenes.filter(homeScene).map(scene => [scene.id, scene]))
      while (current()) {
        const selection = selectScenes(curation, available, recent, snapshot)
        // Popular samples use their published captions; only scene cards need catalog records.
        const ids = [...new Set([...selection.featured.filter(id => snapshot.samples?.get(id)?.type !== 'popular'), ...selection.recent])]
        await Promise.all(ids.map(async id => {
          if (records.has(id)) return
          const scene = known.get(id) ?? (await catalogApi.record('scene', id, undefined, signal)).record.data
          if (!homeScene(scene) || scene.id !== id) throw new Error(`场景 ${id} 暂不可用`)
          if (current()) records.set(id, structuredClone(toRaw(scene)))
        }))
        if (!current()) return
        const masked = selection.featured.filter(id => {
          const scene = records.get(id)
          return scene?.rating === 'R18' || scene?.mature === true
        })
        if (masked.length) {
          // Catalog flags can be newer than the manifest. Exclude them and refill the spread.
          for (const id of masked) snapshot.masked.add(id)
          continue
        }
        for (const id of records.keys()) if (!ids.includes(id)) records.delete(id)
        publish(selection, records)
        return
      }
    }
    async function fullCatalog() {
      fullCatalogRequested = true
      const [catalog] = await Promise.all([store.loadBrowserScenes('all'), samplesRequest])
      if (!current()) return
      const records = new Map(catalog.scenes.filter(homeScene).map(scene => [scene.id, scene]))
      await populate(catalog.curation, new Set(records.keys()), records)
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
      await populate(curation, new Set(index.orderedIds!), snapshot.records)
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
