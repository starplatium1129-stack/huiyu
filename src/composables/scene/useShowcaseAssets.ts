import { computed, onActivated, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { apiClient } from '@/api/client'
import { parseShowcaseManifest, type ShowcaseEntry } from '@/utils/showcaseManifest'

// Keep catalogue identity across page visits, without retaining images or page instances.
// Revalidate on entry; only changed records or an explicit upload change image URLs.
const catalogue = shallowRef<ReadonlyMap<string, ShowcaseEntry>>(new Map())
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

  async function reload(fresh = false) {
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
      const raw = await apiClient.request<{ entries?: Array<{ id?: unknown } | null> }>('/scene-showcase/manifest.json', {
        signal: controller.signal, cache: 'no-cache', cachePolicy: fresh ? 'refresh' : 'default', timeoutMs: 0,
      })
      const counts = new Map<unknown, number>()
      for (const item of raw.entries ?? []) counts.set(item?.id, (counts.get(item?.id) ?? 0) + 1)
      const accepted = parseShowcaseManifest(raw).entries.filter(item => counts.get(item.id) === 1)
      if (alive && request === controller && !controller.signal.aborted && source === identity && revision >= publishedRequest) {
        const nextVersions = new Map(versions.value)
        for (const entry of accepted) {
          const previous = catalogue.value.get(entry.id)
          if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
            nextVersions.set(entry.id, Math.max(Date.now(), (nextVersions.get(entry.id) ?? sessionVersion.value) + 1))
        }
        const nextEntries = new Map(accepted.map(item => [item.id, item]))
        for (const id of nextVersions.keys()) if (!nextEntries.has(id)) nextVersions.delete(id)
        versions.value = nextVersions; catalogue.value = nextEntries; publishedRequest = revision
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
    const entry = catalogue.value.get(id)
    if (!entry) return ''
    const path = entry[kind] || `${kind === 'image' ? 'images' : 'thumbs'}/${id}.jpg`
    return /^(?:images|thumbs)\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(path)
      ? `/scene-showcase/${path}?v=${versions.value.get(id) ?? sessionVersion.value}` : ''
  }
  return {
    loading, error, reload,
    initialLoading: computed(() => loading.value && !catalogue.value.size),
    thumbUrl: (id: string) => assetUrl(id, 'thumb'),
    imageUrl: (id: string) => assetUrl(id, 'image'),
    hasShowcase: (id: string) => catalogue.value.has(id),
    hasPublicScene: (id: string) => { const entry = catalogue.value.get(id); return entry?.type === 'scene' && entry.rating === 'All' },
    dimensions: (id: string) => { const entry = catalogue.value.get(id); return entry?.width && entry.height ? { width: entry.width, height: entry.height } : undefined },
    thumbDimensions: (id: string) => {
      const entry = catalogue.value.get(id)
      const width = entry?.thumbWidth || entry?.width, height = entry?.thumbHeight || entry?.height
      return width && height ? { width, height } : undefined
    },
    invalidateAsset: (id: string) => { versions.value = new Map(versions.value).set(id, Math.max(Date.now(), (versions.value.get(id) ?? sessionVersion.value) + 1)) },
  }
}
