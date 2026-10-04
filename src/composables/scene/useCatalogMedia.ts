import { computed, onScopeDispose, ref, watch } from 'vue'
import { catalogApi, type CatalogPage, type CatalogSummary } from '@/api/catalogApi'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import type { ShowcaseSceneItem } from './useSceneShowcaseUpload'

export function showcaseItem(record: Pick<CatalogSummary, 'kind' | 'id' | 'characterId' | 'title' | 'rating'>): ShowcaseSceneItem {
  return {
    id: record.kind === 'blueprint' ? `pc_${record.characterId}_${record.id}` : record.id,
    title: record.title, char: record.characterId, rating: record.rating,
    type: record.kind === 'blueprint' ? 'popular' : 'scene',
  }
}

export function useCatalogMedia() {
  const kind = ref<'media' | 'scene' | 'blueprint'>('media')
  const search = ref(''), character = ref(''), rating = ref(''), page = ref(1)
  const debouncedSearch = ref(''), result = ref<CatalogPage | null>(null)
  const loading = ref(false), error = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined, request: AbortController | undefined
  let sequence = 0
  const totalPages = computed(() => Math.max(1, Math.ceil((result.value?.total ?? 0) / 24)))
  watch(search, value => {
    clearTimeout(timer)
    timer = setTimeout(() => { debouncedSearch.value = value }, 250)
  })
  watch([kind, character, rating, debouncedSearch], () => { page.value = 1 }, { flush: 'sync' })
  async function load() {
    request?.abort()
    const controller = new AbortController(); request = controller
    const current = ++sequence
    loading.value = true; error.value = ''
    try {
      const data = await catalogApi.query({ kind: kind.value, search: debouncedSearch.value, character: character.value, rating: rating.value, page: page.value, pageSize: 24 }, controller.signal)
      if (current === sequence && !controller.signal.aborted) result.value = data
    } catch (cause) {
      if (current === sequence && !controller.signal.aborted) error.value = (cause as Error).message
    } finally { if (current === sequence) loading.value = false }
  }
  watch([kind, character, rating, debouncedSearch, page, runtimeResourceIdentity], () => { void load() }, { immediate: true })
  onScopeDispose(() => { clearTimeout(timer); request?.abort(); sequence++ })
  return { kind, search, character, rating, page, result, loading, error, totalPages, load }
}
