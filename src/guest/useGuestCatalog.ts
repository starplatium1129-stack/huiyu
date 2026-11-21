import { onScopeDispose, ref, watch } from 'vue'
import { apiClient } from '@/api/client'

const PAGE_SIZE = 16

export interface CatalogItem {
  id: string
  kind: 'character' | 'blueprint' | 'scene'
  title: string
  characterId?: string
  category?: string
  rating?: string
}

export type GuestRatingFilter = '' | 'SFW' | 'R18'

export function useGuestCatalog(active: () => boolean) {
  const kind = ref<'character' | 'media'>('character')
  const search = ref('')
  const character = ref<CatalogItem>()
  const rating = ref<GuestRatingFilter>('')
  const items = ref<CatalogItem[]>([])
  const total = ref(0)
  const page = ref(1)
  const pages = ref(1)
  const loading = ref(false)
  const error = ref('')
  let request: AbortController | undefined
  let loadedSignature = ''

  function querySignature(which: number) {
    return [
      kind.value,
      search.value.trim(),
      kind.value !== 'character' ? (character.value?.id || '') : '',
      kind.value !== 'character' ? rating.value : '',
      String(which),
    ].join('|')
  }

  async function load(which = 1) {
    request?.abort()
    const controller = new AbortController()
    request = controller
    loading.value = true
    error.value = ''
    const params = new URLSearchParams({
      kind: kind.value,
      search: search.value.trim(),
      page: String(which),
      pageSize: String(PAGE_SIZE),
    })
    if (kind.value !== 'character') {
      if (character.value) params.set('character', character.value.id)
      if (rating.value) params.set('rating', rating.value)
    }
    try {
      const result = await apiClient.request<{ items: CatalogItem[]; total: number }>(
        '/api/guest/catalog?' + params,
        { cache: 'no-store', signal: controller.signal },
      )
      if (controller.signal.aborted) return
      items.value = result.items
      total.value = result.total
      page.value = which
      pages.value = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
      loadedSignature = querySignature(which)
    } catch (cause) {
      if (controller.signal.aborted) return
      error.value = cause instanceof Error ? cause.message : '素材暂时无法加载。'
    } finally {
      if (request === controller) {
        request = undefined
        loading.value = false
      }
    }
  }

  watch(
    [kind, search, character, rating, active],
    ([_kind, _search, _char, _rating, isActive], [_oldKind, _oldSearch, _oldChar, _oldRating, wasActive], invalidate) => {
      request?.abort()
      if (!isActive) return
      const signature = querySignature(1)
      if (!wasActive && isActive && loadedSignature === querySignature(page.value) && !error.value) {
        return
      }
      if (loadedSignature !== signature) {
        loading.value = true
        items.value = []
        total.value = 0
        page.value = 1
        pages.value = 1
      }
      const timer = setTimeout(() => { void load(1) }, 220)
      invalidate(() => clearTimeout(timer))
    },
    { immediate: true },
  )

  onScopeDispose(() => request?.abort())

  function browseScenes(item?: CatalogItem) {
    character.value = item
    search.value = ''
    kind.value = 'media'
  }

  function browseCharacters() {
    character.value = undefined
    search.value = ''
    rating.value = ''
    kind.value = 'character'
  }

  function setRating(next: GuestRatingFilter) {
    rating.value = next
  }

  return {
    kind,
    search,
    character,
    rating,
    items,
    total,
    page,
    pages,
    loading,
    error,
    browseScenes,
    browseCharacters,
    setRating,
    load,
  }
}
