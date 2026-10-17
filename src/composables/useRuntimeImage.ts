import { computed, onScopeDispose, readonly, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { resolveRuntimeUrl, runtimeResourceCors, runtimeResourceIdentity } from '@/platform/runtimeUrl'

/** Native img loading only: no preload, Blob ownership, canvas or automatic retry loop. */
export function useRuntimeImage(source: MaybeRefOrGetter<string | null | undefined>) {
  const src = computed(() => resolveRuntimeUrl(toValue(source)))
  const loaded = ref(false), failed = ref(false), attempt = ref(0)
  let alive = true
  onScopeDispose(() => { alive = false })
  function retry() { attempt.value++; loaded.value = false; failed.value = false }
  watch([src, runtimeResourceIdentity], retry, { immediate: true, flush: 'sync' })
  function current(event: Event): event is Event & { target: HTMLImageElement } {
    const img = event.target
    return alive && img instanceof HTMLImageElement && !!src.value
      && img.getAttribute('data-image-attempt') === String(attempt.value)
      && img.getAttribute('src') === src.value
  }
  function onLoad(event: Event) {
    if (!current(event) || !event.target.naturalWidth || !event.target.naturalHeight) return false
    failed.value = false
    const img = event.target, token = attempt.value, source = src.value
    const ready = () => { if (alive && token === attempt.value && source === src.value && !failed.value) loaded.value = true }
    // Native load exposes dimensions; an async-decoding image may still have no
    // paintable pixels. Keep the placeholder until that same attempt is decoded.
    if (typeof img.decode === 'function') void img.decode().catch(() => {}).then(ready)
    else ready()
    return true
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
