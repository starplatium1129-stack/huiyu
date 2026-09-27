import { computed, readonly, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { resolveRuntimeUrl, runtimeResourceCors, runtimeResourceIdentity } from '@/platform/runtimeUrl'

/** Native img loading only: no preload, Blob ownership, canvas or automatic retry loop. */
export function useRuntimeImage(source: MaybeRefOrGetter<string | null | undefined>) {
  const src = computed(() => resolveRuntimeUrl(toValue(source)))
  const loaded = ref(false), failed = ref(false), attempt = ref(0)
  function retry() { attempt.value++; loaded.value = false; failed.value = false }
  watch([src, runtimeResourceIdentity], retry, { immediate: true, flush: 'sync' })
  function current(event: Event): event is Event & { target: HTMLImageElement } {
    const img = event.target
    return img instanceof HTMLImageElement && !!src.value
      && img.getAttribute('data-image-attempt') === String(attempt.value)
      && img.getAttribute('src') === src.value
  }
  function onLoad(event: Event) {
    if (!current(event) || !event.target.naturalWidth || !event.target.naturalHeight) return false
    loaded.value = true; failed.value = false; return true
  }
  function onError(event: Event) {
    if (!current(event)) return false
    loaded.value = false; failed.value = true; return true
  }
  const image = computed(() => ({
    key: attempt.value, 'data-image-attempt': String(attempt.value),
    crossorigin: runtimeResourceCors(), src: src.value, onLoad, onError,
  }))
  return { image, src, loaded: readonly(loaded), failed: readonly(failed), retry }
}
