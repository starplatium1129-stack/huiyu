import { computed, onScopeDispose, shallowRef, type Ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { indexArtworkSearch } from '@/utils/artworkSearch'

export function useGlobalSearchWorks(query: Readonly<Ref<string>>) {
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
    if (worksError.value) return
    resetWorks()
    const request = new AbortController()
    controller.value = request
    const text = query.value
    timer = setTimeout(async () => {
      try {
        const raw = await artworkRepository.searchArtworks(text, AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]))
        if (request.signal.aborted) return
        works.value = indexArtworkSearch(raw)
      } catch {
        if (!request.signal.aborted) worksError.value = '作品读取失败，请关闭搜索后重开以重试。'
      } finally {
        if (controller.value === request) controller.value = null
      }
    }, 150)
  }

  onScopeDispose(resetWorks)
  return { works, worksError, worksLoading, loadWorks, resetWorks }
}
