import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive, ref } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import { useGalleryFilters } from './useGalleryFilters'
import { artworkTags } from './artworkTags'
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
