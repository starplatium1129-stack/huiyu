import { resolveRuntimeUrl, runtimeFetch, runtimeResourceIdentity } from '../platform/runtimeUrl.ts'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { parseShowcaseManifest } from '../utils/showcaseManifest.ts'

/** Only publish reference IDs explicitly rated All in the current media catalogue. */
export function useMoodReferences(ids: readonly string[]) {
  const available = ref(new Set<string>())
  const loading = ref(true)
  let controller: AbortController | undefined
  let revision = 0
  let stopWatching: (() => void) | undefined
  async function load() {
    const ticket = ++revision
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    available.value = new Set()
    loading.value = !!resolveRuntimeUrl('/scene-showcase/manifest.json')
    if (!loading.value) return
    try {
      const response = await runtimeFetch('/scene-showcase/manifest.json', { signal, cache: 'no-cache' })
      if (!response.ok) return
      const manifest = await response.json() as { entries: Array<{ id?: unknown } | null> }
      const { entries } = parseShowcaseManifest(manifest)
      if (signal.aborted || ticket !== revision) return
      available.value = new Set(ids.filter(id => {
        const unambiguous = manifest.entries.filter(entry => entry?.id === id).length === 1
        return unambiguous && entries.some(entry => entry.id === id && entry.type === 'scene' && entry.rating === 'All')
      }))
    } catch {
      // Missing or unverified media leaves the colour palette usable.
    } finally {
      if (!signal.aborted && ticket === revision) loading.value = false
    }
  }
  // Runtime identity changes on disconnect/reconnect or gateway replacement,
  // not on every healthy handshake. One request per identity; no polling loop.
  onMounted(() => { stopWatching = watch(runtimeResourceIdentity, () => { void load() }, { immediate: true }) })
  onUnmounted(() => { stopWatching?.(); revision++; controller?.abort() })
  return { available, loading }
}
