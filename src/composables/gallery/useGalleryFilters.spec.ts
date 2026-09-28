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
})

describe('gallery filter metadata reuse', () => {
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
    expect(filters.visible.value).toHaveLength(3)
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
