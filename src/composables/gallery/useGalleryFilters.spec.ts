import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive, ref } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import { useGalleryFilters } from './useGalleryFilters'
import { artworkTags } from './artworkTags'
import type { ArtworkRecord } from '@/types/artwork'
import type { GalleryProject } from './galleryStorage'

function setup(history = ref<ArtworkRecord[]>([]), projects = ref<GalleryProject[]>([])) {
  const scope = effectScope()
  const filters = scope.run(() => useGalleryFilters({
    history, projects, columnCount: ref(2), ratioOf: () => 1,
    route: reactive({ query: {} }) as unknown as RouteLocationNormalizedLoaded,
    router: { replace: vi.fn() } as unknown as Router,
  }))!
  return { filters, stop: () => { filters.cleanupFilterSync(); scope.stop() } }
}
afterEach(()=>vi.useRealTimers())
describe('saved artwork tag filtering',()=>{
  it('reads only explicit saved tag arrays, without parsing prompt text',()=>{
    expect(artworkTags({id:1,manual_tags:[' spring ','spring',null],tags:['night',3],prompt:'invented, tag'})).toEqual(['spring','night'])
    expect(artworkTags({id:2,collectionTags:[' album ','album'],manual_tags:['generated']})).toEqual(['album','generated'])
  })
  it('combines exact tag matching with project and favorite filters, and resets the URL',async()=>{
    vi.useFakeTimers()
    const scope=effectScope(), replace=vi.fn()
    const route=reactive({query:{tag:'春日'}}) as unknown as RouteLocationNormalizedLoaded
    const filters=scope.run(()=>useGalleryFilters({
      history:ref([{id:'one',favorite:true,manual_tags:['春日'],timestamp:3},{id:'two',manual_tags:['春日旅行'],timestamp:2},{id:'three',manual_tags:['春日'],timestamp:1}]),
      projects:ref([{id:'album',title:'画册',history_ids:['one','two']}]),columnCount:ref(2),ratioOf:()=>1,route,router:{replace} as unknown as Router,
    }))!
    filters.restoreFiltersFromQuery(); await nextTick(); expect(filters.visible.value.map(item=>item.id)).toEqual(['one','three'])
    filters.projectFilter.value='album'; filters.favoriteOnly.value=true
    expect(filters.visible.value.map(item=>item.id)).toEqual(['one'])
    await nextTick()
    filters.resetGalleryFilters(); await nextTick(); await vi.runAllTimersAsync()
    expect(filters.visible.value).toHaveLength(3); expect(replace).toHaveBeenLastCalledWith({query:{}})
    filters.cleanupFilterSync(); scope.stop()
  })
  it('restores role and smart album links, updates membership from metadata and clears both scopes', async () => {
    vi.useFakeTimers()
    const scope = effectScope(), replace = vi.fn()
    const history = ref<ArtworkRecord[]>([
      { id: 1, character: 'nene', characterId: 'popular-character', manual_tags: ['春日'], favorite: true, timestamp: 3 },
      { id: 2, characterId: 'popular-character', collectionTags: ['春日'], timestamp: 2 },
      { id: 3, character: 'triad', manual_tags: ['春日'], favorite: true, timestamp: 1 },
    ])
    const projects = ref<GalleryProject[]>([{ id: 'smart-spring', title: '角色的春日精选', history_ids: [],
      smartRule: { characterId: 'popular-character', tags: ['春日'], tagMatch: 'all', favoriteOnly: true, search: '', projectId: '' } }])
    const route = reactive({query:{project:'smart-spring',character:'popular-character'}}) as unknown as RouteLocationNormalizedLoaded
    const filters = scope.run(() => useGalleryFilters({ history, projects, columnCount: ref(2), ratioOf: () => 1, route, router: {replace} as unknown as Router }))!
    filters.restoreFiltersFromQuery()
    await nextTick()
    expect(filters.visible.value.map(item => item.id)).toEqual([1])
    history.value[0].favorite = false; history.value[1].favorite = true
    expect(filters.visible.value.map(item => item.id)).toEqual([2])
    filters.projectFilter.value = ''; filters.characterFilter.value = 'nene'
    expect(filters.visible.value.map(item => item.id)).toEqual([3])
    projects.value.push({ id: 'smart-manual', title: '手动画册', history_ids: [3] })
    filters.projectFilter.value = 'smart-manual'
    expect(filters.visible.value.map(item => item.id)).toEqual([3])
    filters.projectFilter.value = 'smart-missing'
    expect(filters.visible.value).toEqual([])
    filters.resetGalleryFilters(); await nextTick(); await vi.runAllTimersAsync()
    expect(filters.visible.value).toHaveLength(3)
    expect(replace).toHaveBeenLastCalledWith({query:{}})
    filters.cleanupFilterSync(); scope.stop()
  })
})

describe('gallery filter metadata reuse', () => {
  it('does not keep loading hidden image pages while browsing album covers', async () => {
    const { filters, stop } = setup(ref(Array.from({ length: 160 }, (_, id) => ({ id, timestamp: id }))))
    const sentinel = document.createElement('div')
    const rects = vi.spyOn(sentinel, 'getClientRects').mockReturnValue([] as unknown as DOMRectList)
    const initialCount = filters.pagedVisible.value.length
    filters.loadMoreIfNeeded(sentinel)
    await nextTick()
    expect(filters.pagedVisible.value).toHaveLength(initialCount)
    rects.mockReturnValue([new DOMRect(0, 4000, 1, 1)] as unknown as DOMRectList)
    vi.spyOn(sentinel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 4000, 1, 1))
    filters.loadMoreIfNeeded(sentinel)
    await nextTick()
    expect(filters.pagedVisible.value.length).toBeGreaterThan(initialCount)
    stop()
  })

  it('keeps stable ordering, strict project IDs and live metadata changes', () => {
    const history = ref<ArtworkRecord[]>([
      { id: 1, timestamp: 2, prompt: 'Blue Spring', favorite: true },
      { id: '1', timestamp: 2, prompt: 'Blue Summer' },
      { id: 'old', timestamp: 1, prompt: 'green spring' },
    ])
    const projects = ref<GalleryProject[]>([{ id: 'album', title: 'Album', history_ids: [1] }])
    const { filters, stop } = setup(history, projects)
    expect(filters.visible.value.map(item => item.id)).toEqual([1, '1', 'old'])
    filters.projectFilter.value = 'album'
    expect(filters.visible.value.map(item => item.id)).toEqual([1])
    projects.value[0].history_ids.push('1')
    expect(filters.visible.value.map(item => item.id)).toEqual([1, '1'])
    filters.searchQuery.value = '  BLUE   spring '
    expect(filters.visible.value.map(item => item.id)).toEqual([1])
    history.value[1].prompt = 'spring blue'
    history.value[1].timestamp = 3
    expect(filters.visible.value.map(item => item.id)).toEqual(['1', 1])
    filters.favoriteOnly.value = true
    expect(filters.visible.value.map(item => item.id)).toEqual([1])
    history.value[1].favorite = true
    expect(filters.visible.value.map(item => item.id)).toEqual(['1', 1])
    filters.projectFilter.value = 'missing'
    filters.favoriteOnly.value = false
    filters.searchQuery.value = ''
    expect(filters.visible.value).toHaveLength(0)
    filters.projectFilter.value = ''
    history.value.splice(1, 1)
    expect(filters.visible.value.map(item => item.id)).toEqual([1, 'old'])
    stop()
  })

  it('does not reread timestamps or prompt bodies on each search keystroke', () => {
    const timestamp = vi.fn(() => 123), prompt = vi.fn(() => 'blue spring sky')
    const { filters, stop } = setup(ref([{ id: 'one', get timestamp() { return timestamp() }, get prompt() { return prompt() } }]))
    filters.searchQuery.value = 'blue'
    expect(filters.visible.value).toHaveLength(1)
    timestamp.mockClear(); prompt.mockClear()
    for (const query of ['spring', 'blue sky', 'missing', '']) {
      filters.searchQuery.value = query
      expect(filters.visible.value.length).toBe(query === 'missing' ? 0 : 1)
    }
    expect(timestamp).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    stop()
  })

  it('releases a cleared search index and rebuilds it only when searching again', () => {
    const prompt = vi.fn(() => 'blue spring sky')
    const { filters, stop } = setup(ref([{ id: 'one', get prompt() { return prompt() } }]))
    filters.searchQuery.value = 'blue'
    expect(filters.visible.value).toHaveLength(1)
    const firstReads = prompt.mock.calls.length
    filters.searchQuery.value = 'spring'
    expect(filters.visible.value).toHaveLength(1)
    expect(prompt).toHaveBeenCalledTimes(firstReads)
    filters.searchQuery.value = '  '
    expect(filters.visible.value).toHaveLength(1)
    expect(prompt).toHaveBeenCalledTimes(firstReads)
    filters.searchQuery.value = 'blue'
    expect(filters.visible.value).toHaveLength(1)
    expect(prompt.mock.calls.length).toBeGreaterThan(firstReads)
    stop()
  })
})


it('does not publish delayed filter changes or schedule new ones while inactive', async () => {
  vi.useFakeTimers()
  const scope = effectScope(), replace = vi.fn()
  let active = true
  const filters = scope.run(() => useGalleryFilters({
    history: ref([]), projects: ref([]), columnCount: ref(2), ratioOf: () => 1,
    route: reactive({ query: {} }) as unknown as RouteLocationNormalizedLoaded,
    router: { replace } as unknown as Router, isViewActive: () => active,
  }))!
  try {
    filters.searchQuery.value = 'pending'
    await nextTick()
    active = false
    await vi.advanceTimersByTimeAsync(300)
    expect(replace).not.toHaveBeenCalled()
    filters.searchQuery.value = 'hidden'
    await nextTick()
    active = true
    await vi.advanceTimersByTimeAsync(300)
    expect(replace).not.toHaveBeenCalled()
    filters.searchQuery.value = 'current'
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)
    expect(replace).toHaveBeenCalledExactlyOnceWith({ query: { q: 'current' } })
  } finally { filters.cleanupFilterSync(); scope.stop() }
})
