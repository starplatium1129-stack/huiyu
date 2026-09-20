import { onMounted, onUnmounted, ref } from 'vue'
import { parseShowcaseManifest } from '@/utils/showcaseManifest'

/** Only publish reference IDs explicitly rated All in the current media catalogue. */
export function useMoodReferences(ids: readonly string[]) {
  const available = ref(new Set<string>())
  const loading = ref(true)
  const controller = new AbortController()
  onMounted(async () => {
    try {
      const response = await fetch('/scene-showcase/manifest.json', { signal: controller.signal, cache: 'no-cache' })
      if (!response.ok) return
      const manifest = await response.json() as { entries: Array<{ id?: unknown } | null> }
      const { entries } = parseShowcaseManifest(manifest)
      if (controller.signal.aborted) return
      available.value = new Set(ids.filter(id => {
        const unambiguous = manifest.entries.filter(entry => entry?.id === id).length === 1
        return unambiguous && entries.some(entry => entry.id === id && entry.type === 'scene' && entry.rating === 'All')
      }))
    } catch {
      // Missing or unverified media leaves the colour palette usable.
    } finally {
      if (!controller.signal.aborted) loading.value = false
    }
  })
  onUnmounted(() => controller.abort())
  return { available, loading }
}
