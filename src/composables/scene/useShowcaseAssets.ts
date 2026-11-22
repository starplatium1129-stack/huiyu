import { computed, onActivated, onDeactivated, onScopeDispose, readonly, ref, shallowRef, watch } from 'vue'
import { runtimeFetch, runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { readResponse } from '@/api/httpResponse'
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
let snapshot: { etag: string | null; entries: readonly ShowcaseEntry[] } | undefined
type CatalogueRead = { controller: AbortController; result: Promise<readonly ShowcaseEntry[]>; readers: number }
let pending: CatalogueRead | undefined
function syncIdentity() {
  const next = runtimeResourceIdentity()
  if (identity === next) return
  identity = next
  pending?.controller.abort()
  pending = undefined
  snapshot = undefined
  publishedRequest = ++nextRequest
  catalogue.value = new Map(); versions.value = new Map()
  sessionVersion.value = Date.now()
}

function updateCatalogue(entries: readonly ShowcaseEntry[], counts: Map<unknown, number>, refreshImages: boolean) {
  const nextVersions = new Map(versions.value)
  const nextEntries = new Map<string, ShowcaseEntry>()
  let versionChanged = false
  for (const entry of entries) {
    if (counts.get(entry.id) !== 1) continue
    const previous = catalogue.value.get(entry.id)
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
  const previousEntries = [...catalogue.value.values()]
  if (previousEntries.length !== nextEntries.size || [...nextEntries.values()].some((entry, index) => entry !== previousEntries[index]))
    catalogue.value = nextEntries
  if (versionChanged) versions.value = nextVersions
}

async function readCatalogue(signal: AbortSignal, fresh: boolean, refreshImages: boolean): Promise<readonly ShowcaseEntry[]> {
  const revision = ++nextRequest
  const source = identity
  const previous = snapshot
  const path = '/scene-showcase/manifest.json'
  // Revalidate on return without transferring or parsing unchanged prompts and metadata.
  if (previous?.etag && !fresh && !refreshImages) {
    const head = await runtimeFetch(path, { method: 'HEAD', signal, cache: 'no-cache' }).catch(() => {
      signal.throwIfAborted()
      return null // Some static hosts allow GET only.
    })
    if (head?.ok && head.headers.get('etag') === previous.etag) {
      signal.throwIfAborted()
      if (source !== identity || !snapshot) throw new DOMException('样张来源已更改', 'AbortError')
      publishedRequest = Math.max(publishedRequest, revision)
      return snapshot.entries
    }
  }
  const response = await runtimeFetch(fresh ? path + '?refresh=1' : path, { signal, cache: 'no-cache' })
  const raw = await readResponse(response, signal)
  if (source !== identity) throw new DOMException('样张来源已更改', 'AbortError')
  if (revision < publishedRequest) {
    if (snapshot) return snapshot.entries
    throw new DOMException('样张来源已更改', 'AbortError')
  }
  const entries = parseShowcaseManifest(raw).entries
  // Asset lookup rejects ambiguous IDs. The journal retains the manifest parser's first valid row.
  const counts = new Map<unknown, number>()
  for (const item of raw.entries as Array<{ id?: unknown } | null>) counts.set(item?.id, (counts.get(item?.id) ?? 0) + 1)
  updateCatalogue(entries, counts, refreshImages)
  snapshot = { etag: response.headers.get('etag'), entries: entries.map(entry => catalogue.value.get(entry.id) ?? entry) }
  publishedRequest = revision
  return snapshot.entries
}

/** A single parse and publication per read, with independent page lifetimes. */
export async function readShowcaseEntries(signal: AbortSignal, fresh = false, refreshImages = false): Promise<readonly ShowcaseEntry[]> {
  signal.throwIfAborted()
  syncIdentity()
  if (!pending || pending.controller.signal.aborted || fresh || refreshImages) {
    const controller = new AbortController()
    const result = readCatalogue(controller.signal, fresh, refreshImages).finally(() => {
      if (pending?.controller === controller) pending = undefined
    })
    pending = { controller, result, readers: 0 }
  }
  const read = pending
  read.readers++
  let onAbort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([read.result, cancelled]) }
  finally {
    signal.removeEventListener('abort', onAbort)
    if (--read.readers === 0) read.controller.abort()
  }
}

/** The manifest owns asset identity and paths, including images saved by older clients. */
export function useShowcaseAssets(
  errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  enabled: () => boolean = () => true,
) {
  const loading = ref(false), error = ref('')
  let alive = true, request: AbortController | undefined
  let activated = false, active = true
  onScopeDispose(() => { alive = false; request?.abort() })

  async function reload(fresh = false, refreshImages = false) {
    request?.abort()
    const controller = new AbortController()
    request = controller
    loading.value = true; error.value = ''
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 10_000)
    try {
      await readShowcaseEntries(controller.signal, fresh, refreshImages)
    } catch (cause) {
      if (alive && request === controller && (timedOut || !controller.signal.aborted))
        error.value = timedOut ? '读取样张清单超时，请检查连接后重试' : errorMessage(cause, '样张清单暂时无法读取')
      throw cause
    } finally {
      clearTimeout(timeout)
      if (request === controller) { request = undefined; loading.value = false }
    }
  }
  watch([runtimeResourceIdentity, enabled], ([, needed]) => {
    syncIdentity()
    if (active && needed) void reload().catch(() => {})
    else { request?.abort(); error.value = '' }
  }, { immediate: true })
  onActivated(() => {
    active = true
    // Initial load belongs to the identity watcher. Returning may reveal newly saved assets.
    if (activated && enabled()) void reload().catch(() => {})
    activated = true
  })
  onDeactivated(() => { active = false; request?.abort() })

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
