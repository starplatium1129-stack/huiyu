import { onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { catalogApi, type CatalogKind, type CatalogSummary } from '@/api/catalogApi'
import type { GlobalSearchResult } from './useGlobalSearchResults'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

const kinds = ['character', 'outfit', 'scene', 'blueprint'] as const satisfies readonly CatalogKind[]
const labels = { character: '角色', outfit: '服装', scene: '场景', blueprint: '蓝图' }
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
export function useCatalogSearch(open: Readonly<Ref<boolean>>, query: Readonly<Ref<string>>, version: () => number) {
  const groups = shallowRef<Array<{ id: string; label: string; items: GlobalSearchResult[] }>>([])
  const loading = ref(false), error = ref('')
  let request: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  function reset() { clearTimeout(timer); request?.abort(); request = undefined; loading.value = false; error.value = ''; groups.value = [] }
  function search() {
    reset()
    const text = query.value.trim()
    if (!open.value || !text) return
    const controller = new AbortController(); request = controller; loading.value = true
    timer = setTimeout(async () => {
      try {
        const pages = await Promise.allSettled(kinds.map(kind => catalogApi.query({ kind, search: text, pageSize: 8 }, controller.signal)))
        if (request !== controller || controller.signal.aborted) return
        const versions = new Set(pages.flatMap(page => page.status === 'fulfilled' ? [page.value.version] : []))
        if (versions.size > 1) throw new Error('目录在搜索期间更新，请重新读取。')
        groups.value = pages.flatMap((page, index) => page.status === 'fulfilled' && page.value.items.length ? [{
          id: kinds[index], label: `${labels[kinds[index]]} · ${page.value.total}`,
          items: page.value.items.map(item => ({ key: `${item.kind}:${item.id}`, path: target(item), label: item.title || item.id,
            icon: item.kind === 'character' ? 'character' as const : 'scene' as const,
            meta: [item.characterId, item.category].filter(Boolean).join(' · ') })),
        }] : [])
        error.value = pages.some(page => page.status === 'rejected') ? '部分内容目录暂不可读，已显示其余结果。' : ''
      } catch (cause) { if (request === controller && !controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '内容目录暂不可读。' }
      finally { if (request === controller) { request = undefined; loading.value = false } }
    }, 150)
  }
  watch([open, query, version, runtimeResourceIdentity], search, { flush: 'sync' })
  onScopeDispose(reset)
  return { groups, loading, error, search }
}
