import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { catalogApi, type CatalogKind, type CatalogSummary } from '@/api/catalogApi'
import type { GlobalSearchResult } from './useGlobalSearchResults'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

const kinds = ['character', 'outfit', 'scene', 'blueprint'] as const satisfies readonly CatalogKind[]
export type SearchCatalogKind = typeof kinds[number]
const labels = { character: '角色', outfit: '服装', scene: '场景', blueprint: '蓝图' }
const pageSize = 8
interface CatalogSearchGroup {
  id: SearchCatalogKind
  name: string
  label: string
  items: GlobalSearchResult[]
  total: number
  page: number
  version: number
  loadingMore: boolean
}
function target(item: CatalogSummary): string {
  const query = new URLSearchParams()
  if (item.kind === 'character') return '/character?' + new URLSearchParams({ character: item.id })
  if (item.kind === 'scene') query.set('scene', item.id)
  else {
    query.set('popular', item.characterId)
    if (item.kind === 'blueprint') query.set('blueprint', item.id)
    if (item.kind === 'outfit') query.set('outfit', item.id.slice(item.characterId.length + 1))
  }
  return '/prompt-builder?' + query
}
function result(item: CatalogSummary): GlobalSearchResult {
  return { key: `${item.kind}:${item.id}`, path: target(item), label: item.title || item.id,
    icon: item.kind === 'character' ? 'character' : 'scene',
    meta: [item.characterId, item.category].filter(Boolean).join(' · ') }
}
function label(kind: SearchCatalogKind, shown: number, total: number) {
  return `${labels[kind]} · ${shown < total ? `${shown} / ${total}` : total}`
}
export function useCatalogSearch(open: Readonly<Ref<boolean>>, query: Readonly<Ref<string>>, version: () => number) {
  const groups = shallowRef<CatalogSearchGroup[]>([])
  const loading = ref(false), error = ref(''), moreError = ref('')
  let request: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const moreRequests = new Map<SearchCatalogKind, AbortController>()
  function reset() {
    clearTimeout(timer); request?.abort(); request = undefined
    for (const controller of moreRequests.values()) controller.abort()
    moreRequests.clear(); loading.value = false; error.value = ''; moreError.value = ''; groups.value = []
  }
  function search() {
    reset()
    const text = query.value.trim()
    if (!open.value || !text) return
    const controller = new AbortController(); request = controller; loading.value = true
    timer = setTimeout(async () => {
      try {
        const pages = await Promise.allSettled(kinds.map(kind => catalogApi.query({ kind, search: text, sort: 'relevance', pageSize }, controller.signal)))
        if (request !== controller || controller.signal.aborted) return
        const versions = new Set(pages.flatMap(page => page.status === 'fulfilled' ? [page.value.version] : []))
        if (versions.size > 1) throw new Error('目录在搜索期间更新，请重新读取。')
        groups.value = pages.flatMap((page, index) => {
          if (page.status !== 'fulfilled' || !page.value.items.length) return []
          const id = kinds[index], items = page.value.items.map(result)
          return [{ id, name: labels[id], items, label: label(id, items.length, page.value.total), total: page.value.total,
            page: page.value.page, version: page.value.version, loadingMore: false }]
        })
        error.value = pages.some(page => page.status === 'rejected') ? '部分内容目录暂不可读，已显示其余结果。' : ''
      } catch (cause) { if (request === controller && !controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '内容目录暂不可读。' }
      finally { if (request === controller) { request = undefined; loading.value = false } }
    }, 150)
  }
  async function loadMore(kind: SearchCatalogKind) {
    const group = groups.value.find(item => item.id === kind)
    if (!open.value || !group || group.items.length >= group.total || moreRequests.has(kind)) return
    const controller = new AbortController(), text = query.value.trim()
    moreError.value = ''
    moreRequests.set(kind, controller)
    groups.value = groups.value.map(item => item.id === kind ? { ...item, loadingMore: true } : item)
    try {
      const page = await catalogApi.query({ kind, search: text, sort: 'relevance', page: group.page + 1, pageSize }, controller.signal)
      if (moreRequests.get(kind) !== controller || controller.signal.aborted) return
      if (page.version !== group.version) { moreError.value = '内容目录已更新，请重新读取。'; return }
      groups.value = groups.value.map(item => {
        if (item.id !== kind) return item
        const items = [...item.items, ...page.items.map(result)]
        return { ...item, items, label: label(kind, items.length, page.total), total: page.total, page: page.page }
      })
    } catch {
      if (moreRequests.get(kind) === controller && !controller.signal.aborted) moreError.value = `${labels[kind]}的更多结果暂未读取，请重试。`
    } finally {
      if (moreRequests.get(kind) === controller) {
        moreRequests.delete(kind)
        groups.value = groups.value.map(item => item.id === kind ? { ...item, loadingMore: false } : item)
      }
    }
  }
  watch([open, query, version, runtimeResourceIdentity], search, { flush: 'sync' })
  onScopeDispose(reset)
  return { groups, loading, error: computed(() => [error.value, moreError.value].filter(Boolean).join(' ')), search, loadMore }
}
