import { computed, onActivated, onScopeDispose, readonly, ref, shallowRef, watch } from 'vue'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { apiClient } from '@/api/client'
import { canonicalShowcaseId, parseShowcaseManifest, type ShowcaseEntry } from '@/utils/showcaseManifest'

// Keep catalogue identity across page visits, without retaining images or page instances.
// Revalidate on entry; only changed records or an explicit upload change image URLs.
const catalogue = shallowRef<ReadonlyMap<string, ShowcaseEntry>>(new Map())
// Older published blueprint samples repeated the character prefix. Resolve
// their declared records rather than guessing image filenames or changing IDs.
const blueprintAliases = computed(() => {
  const aliases = new Map<string, string>()
  for (const entry of catalogue.value.values()) {
    const canonical = canonicalShowcaseId(entry)
    if (canonical !== entry.id) aliases.set(canonical, entry.id)
  }
  return aliases
})
function catalogueEntry(id: string) {
  return catalogue.value.get(id) ?? catalogue.value.get(blueprintAliases.value.get(id) ?? '')
}
const versions = shallowRef<ReadonlyMap<string, number>>(new Map())
const sessionVersion = ref(Date.now())
let identity: string | undefined, nextRequest = 0, publishedRequest = 0
function syncIdentity() {
  const next = runtimeResourceIdentity()
  if (identity === next) return
  identity = next
  catalogue.value = new Map(); versions.value = new Map()
  sessionVersion.value = Date.now(); publishedRequest = 0
}

/** The manifest owns asset identity and paths, including images saved by older clients. */
export function useShowcaseAssets(errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback) {
  const loading = ref(false), error = ref('')
  let alive = true, request: AbortController | undefined
  let activated = false
  onScopeDispose(() => { alive = false; request?.abort() })

  async function reload(fresh = false, refreshImages = false) {
    syncIdentity()
    const source = identity, revision = ++nextRequest
    request?.abort()
    const controller = new AbortController()
    request = controller
    loading.value = true; error.value = ''
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 10_000)
    try {
      // Share automatic reads without retaining a TTL cache. Uploads force a new
      // transport so they cannot join a manifest read that predates the write.
      const path = `/scene-showcase/manifest.json${fresh ? '?refresh=1' : ''}`
      const raw = await apiClient.request<{ entries?: Array<{ id?: unknown } | null> }>(path, {
        signal: controller.signal, cache: 'no-cache', cachePolicy: fresh ? 'refresh' : 'default', timeoutMs: 0,
      })
      const counts = new Map<unknown, number>()
      for (const item of raw.entries ?? []) counts.set(item?.id, (counts.get(item?.id) ?? 0) + 1)
      const accepted = parseShowcaseManifest(raw).entries.filter(item => counts.get(item.id) === 1)
      if (alive && request === controller && !controller.signal.aborted && source === identity && revision >= publishedRequest) {
        const nextVersions = new Map(versions.value)
        const nextEntries = new Map<string, ShowcaseEntry>()
        let versionChanged = false
        for (const entry of accepted) {
          const previous = catalogue.value.get(entry.id)
          // Prompt/story text is already normalized at the boundary. Compare
          // strings directly instead of allocating two escaped JSON copies.
          const keys = Object.keys(entry) as Array<keyof ShowcaseEntry>
          const unchanged = previous && Object.keys(previous).length === keys.length && keys.every(key => {
            const value = entry[key], before = previous[key]
            return before === value || typeof value === 'object' && JSON.stringify(before) === JSON.stringify(value)
          })
          nextEntries.set(entry.id, unchanged ? previous : entry)
          if (refreshImages || (previous && !unchanged)) {
            nextVersions.set(entry.id, Math.max(Date.now(), (nextVersions.get(entry.id) ?? sessionVersion.value) + 1))
            versionChanged = true
          }
        }
        for (const id of nextVersions.keys()) if (!nextEntries.has(id)) { nextVersions.delete(id); versionChanged = true }
        // A successful revalidation must not rerender every cached image library.
        const previousEntries = [...catalogue.value.values()]
        if (previousEntries.length !== nextEntries.size || [...nextEntries.values()].some((entry, index) => entry !== previousEntries[index]))
          catalogue.value = nextEntries
        if (versionChanged) versions.value = nextVersions
        publishedRequest = revision
      }
    } catch (cause) {
      if (alive && request === controller && (timedOut || !controller.signal.aborted))
        error.value = timedOut ? '读取样张清单超时，请检查连接后重试' : errorMessage(cause, '样张清单暂时无法读取')
      throw cause
    } finally {
      clearTimeout(timeout)
      if (request === controller) { request = undefined; loading.value = false }
    }
  }
  watch(runtimeResourceIdentity, () => {
    syncIdentity()
    void reload().catch(() => {})
  }, { immediate: true })
  onActivated(() => {
    // Initial load belongs to the identity watcher. Returning may reveal newly saved assets.
    if (activated) void reload().catch(() => {})
    activated = true
  })

  function assetUrl(id: string, kind: 'image' | 'thumb'): string {
    const entry = catalogueEntry(id)
    if (!entry) return ''
    const path = entry[kind] || `${kind === 'image' ? 'images' : 'thumbs'}/${entry.id}.jpg`
    return /^(?:images|thumbs)\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(path)
      ? `/scene-showcase/${path}?v=${versions.value.get(entry.id) ?? sessionVersion.value}` : ''
  }
  return {
    loading, error, reload,
    refresh: () => reload(true, true),
    entries: computed(() => readonly([...catalogue.value.values()])),
    entryFor: (id: string) => { const entry = catalogueEntry(id); return entry ? readonly(entry) : undefined },
    initialLoading: computed(() => loading.value && !catalogue.value.size),
    thumbUrl: (id: string) => assetUrl(id, 'thumb'),
    imageUrl: (id: string) => assetUrl(id, 'image'),
    hasShowcase: (id: string) => Boolean(catalogueEntry(id)),
    hasPublicScene: (id: string) => { const entry = catalogueEntry(id); return entry?.type === 'scene' && entry.rating === 'All' },
    dimensions: (id: string) => { const entry = catalogueEntry(id); return entry?.width && entry.height ? { width: entry.width, height: entry.height } : undefined },
    thumbDimensions: (id: string) => {
      const entry = catalogueEntry(id)
      const width = entry?.thumbWidth || entry?.width, height = entry?.thumbHeight || entry?.height
      return width && height ? { width, height } : undefined
    },
    invalidateAsset: (id: string) => {
      const key = catalogueEntry(id)?.id ?? id
      versions.value = new Map(versions.value).set(key, Math.max(Date.now(), (versions.value.get(key) ?? sessionVersion.value) + 1))
    },
  }
}
