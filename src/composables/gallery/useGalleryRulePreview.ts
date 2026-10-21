import { onDeactivated, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import type { SmartAlbumRule } from '@/application/artwork/smartAlbums'
import type { ArtworkRecord } from '@/types/artwork'
import { captureGallerySource } from './galleryStorage'

export function useGalleryRulePreview(enabled: () => boolean, open: Ref<boolean>, rule: Ref<SmartAlbumRule>, revision: () => unknown) {
  const items = shallowRef<ArtworkRecord[]>([]), total = ref(0), loading = ref(false), error = ref('')
  let controller: AbortController | null = null, timer: ReturnType<typeof setTimeout> | undefined, version = 0
  function stop() { version++; clearTimeout(timer); controller?.abort(); controller = null; loading.value = false }
  watch(() => [enabled(), open.value, JSON.stringify(rule.value), revision()], () => {
    stop(); items.value = []; total.value = 0; error.value = ''
    if (!enabled() || !open.value) return
    loading.value = true
    timer = setTimeout(() => {
      const source = captureGallerySource(), current = version, abort = new AbortController(); controller = abort
      void source.repository.readGalleryPage!({ rule: JSON.parse(JSON.stringify(rule.value)) }, null, abort.signal, 3).then(page => {
        if (current === version && source.isCurrent()) { items.value = page.items; total.value = page.total }
      }).catch(cause => {
        if (current === version && source.isCurrent()) error.value = cause instanceof Error ? cause.message : String(cause)
      }).finally(() => { source.release(); if (current === version) { loading.value = false; controller = null } })
    }, 180)
  }, { immediate: true })
  onDeactivated(stop); onScopeDispose(stop)
  return { items, total, loading, error }
}
