import { computed, onScopeDispose, shallowRef, watch, type Ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { indexArtworkSearch } from '@/utils/artworkSearch'

export function useGlobalSearchWorks(open: Readonly<Ref<boolean>>, query: Readonly<Ref<string>>) {
  const works = shallowRef<ReturnType<typeof indexArtworkSearch> | null>(null)
  const controller = shallowRef<AbortController | null>(null)
  const worksError = shallowRef('')
  const worksLoading = computed(() => controller.value !== null)
  let timer: ReturnType<typeof setTimeout> | undefined

  function resetWorks() {
    clearTimeout(timer)
    controller.value?.abort()
    controller.value = null
    works.value = null
    worksError.value = ''
  }

  function loadWorks() {
    resetWorks()
    if (!open.value || !query.value.trim()) return
    const request = new AbortController()
    controller.value = request
    const text = query.value
    timer = setTimeout(async () => {
      try {
        const raw = await artworkRepository.searchArtworks(text, AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]))
        if (request.signal.aborted) return
        works.value = indexArtworkSearch(raw)
      } catch {
        if (!request.signal.aborted) worksError.value = '作品暂时无法读取。'
      } finally {
        if (controller.value === request) controller.value = null
      }
    }, 150)
  }

  const source = shallowRef(imageMediaSession())
  const stopRuntime = onDesktopRuntime(() => { source.value = imageMediaSession() })
  watch(imageMediaSession, session => { source.value = session }, { flush: 'sync' })
  watch([open, query, source], loadWorks, { flush: 'sync' })
  onScopeDispose(() => { stopRuntime(); resetWorks() })
  return { works, worksError, worksLoading, retryWorks: loadWorks }
}
