import { onActivated, onScopeDispose, ref, watch } from 'vue'
import { runtimeFetch, runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { parseShowcaseManifest, type ShowcaseEntry } from '@/utils/showcaseManifest'

/** The manifest owns asset identity and paths, including images saved by older clients. */
export function useShowcaseAssets(errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback) {
  const entries = ref(new Map<string, ShowcaseEntry>())
  const loading = ref(false), error = ref('')
  const versions = ref<Record<string, number>>({})
  const version = ref(Date.now())
  let alive = true, request: AbortController | undefined
  let activated = false
  onScopeDispose(() => { alive = false; request?.abort() })

  async function reload() {
    request?.abort()
    const controller = new AbortController()
    request = controller
    loading.value = true; error.value = ''
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 10_000)
    try {
      const response = await runtimeFetch('/scene-showcase/manifest.json', { signal: controller.signal, cache: 'no-cache' })
      if (!response.ok) throw new Error('无法读取当前样张清单')
      const raw = await response.json() as { entries?: Array<{ id?: unknown } | null> }
      const counts = new Map<unknown, number>()
      for (const item of raw.entries ?? []) counts.set(item?.id, (counts.get(item?.id) ?? 0) + 1)
      const accepted = parseShowcaseManifest(raw).entries.filter(item => counts.get(item.id) === 1)
      if (alive && request === controller && !controller.signal.aborted)
        entries.value = new Map(accepted.map(item => [item.id, item]))
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
    entries.value = new Map(); versions.value = {}; version.value = Date.now()
    void reload().catch(() => {})
  }, { immediate: true })
  onActivated(() => {
    // Initial load belongs to the identity watcher. Returning may reveal newly saved assets.
    if (activated) void reload().catch(() => {})
    activated = true
  })

  function assetUrl(id: string, kind: 'image' | 'thumb'): string {
    const entry = entries.value.get(id)
    if (!entry) return ''
    const path = entry[kind] || `${kind === 'image' ? 'images' : 'thumbs'}/${id}.jpg`
    return /^(?:images|thumbs)\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(path)
      ? `/scene-showcase/${path}?v=${versions.value[id] ?? version.value}` : ''
  }
  return {
    loading, error, reload,
    thumbUrl: (id: string) => assetUrl(id, 'thumb'),
    imageUrl: (id: string) => assetUrl(id, 'image'),
    hasShowcase: (id: string) => entries.value.has(id),
    invalidateAsset: (id: string) => { versions.value = { ...versions.value, [id]: Date.now() } },
  }
}
