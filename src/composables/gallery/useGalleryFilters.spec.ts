import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, effectScope, h, nextTick, reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import * as generation from './galleryGenerationConditions'
import { useGalleryFilters } from './useGalleryFilters'
import { artworkTags } from './artworkTags'
import type { ArtworkRecord } from '@/types/artwork'
import type { GalleryProject } from './galleryStorage'
import { conditionText, recordedCondition, UNRECORDED_CONDITION } from './galleryGenerationConditions'
import { createGalleryFilterPreferences, GALLERY_FILTER_PRESETS_SETTING, GALLERY_FILTER_PRESET_MAX_BYTES } from '@/storage/galleryFilterPreferences'
import { useGallerySavedFilters } from './useGallerySavedFilters'
import { GALLERY_FILTER_PRESETS_KEY } from '@/utils/storageKeys'
import { classifyMigrationKey } from '@/platform/web/migrationClassification'

function setup(history = ref<ArtworkRecord[]>([]), projects = ref<GalleryProject[]>([])) {
  const scope = effectScope()
  const route = reactive({ query: {} }) as unknown as RouteLocationNormalizedLoaded
  const replace = vi.fn()
  const filters = scope.run(() => useGalleryFilters({
    history, projects, columnCount: ref(2), ratioOf: () => 1,
    route, router: { replace } as unknown as Router,
  }))!
  return { filters, route, replace, stop: () => { filters.cleanupFilterSync(); scope.stop() } }
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
    expect(filters.projectUnavailable.value).toBe(true)
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

describe('gallery generation conditions and reusable searches', () => {
  it('combines recorded engine, either model field, role-owned outfit, seed, size and review state with existing filters', () => {
    const history = ref<ArtworkRecord[]>([
      { id: 'match', timestamp: 3, engine: 'anima', checkpoint: 'model-a', model: 'model-b', characterId: 'role-a', outfitId: 'uniform', seed: 0, size: '832 × 1216', reviewState: 'preferred', favorite: true, prompt: 'spring sky', manual_tags: ['春日'] },
      { id: 'other-role', timestamp: 2, engine: 'anima', model: 'model-b', characterId: 'role-b', outfitId: 'uniform', seed: '0', size: '832x1216', width: 832, height: 1216, reviewState: 'preferred', favorite: true, prompt: 'spring sky', manual_tags: ['春日'] },
      { id: 'candidate', timestamp: 1, engine: 'anima', model: 'model-b', characterId: 'role-a', outfitId: 'uniform', seed: '0', size: '832x1216', width: 832, height: 1216, reviewState: 'candidate', favorite: true, prompt: 'spring sky', manual_tags: ['春日'] },
    ])
    const { filters, stop } = setup(history, ref([{ id: 'album', title: 'Album', history_ids: ['match', 'other-role', 'candidate'] }]))
    filters.favoriteOnly.value = true; filters.projectFilter.value = 'album'; filters.tagFilter.value = '春日'; filters.searchQuery.value = 'spring sky'
    filters.generationConditions.value = { engine: recordedCondition('anima'), model: recordedCondition('model-b'), outfit: recordedCondition(JSON.stringify(['role-a', 'uniform'])), seed: recordedCondition('0'), size: recordedCondition('832x1216'), reviewState: recordedCondition('preferred') }
    expect(filters.visible.value.map(item => item.id)).toEqual(['match'])
    expect(filters.generationOptions.value.outfit.map(value => conditionText(value.value))).toContain(JSON.stringify(['role-b', 'uniform']))
    history.value[0].reviewState = 'rejected'
    expect(filters.visible.value).toHaveLength(0)
    filters.generationConditions.value.reviewState = recordedCondition('candidate')
    expect(filters.visible.value.map(item => item.id)).toEqual(['candidate'])
    stop()
  })

  it('keeps missing facts separate from defaults and never turns measured image dimensions into generation size', () => {
    const options = vi.spyOn(generation, 'generationConditionOptions')
    const { filters, stop } = setup(ref<ArtworkRecord[]>([
      { id: 'old', timestamp: 3, prompt: 'anima model-a seed 0', outfitId: 'uniform', actual: { width: 832, height: 1216 }, image_width: 832, image_height: 1216 },
      { id: 'recorded', timestamp: 2, engine: 'sd', checkpoint: 'model-a', character: 'role-a', outfitId: 'uniform', seed: '000', width: '832', height: 1216, reviewState: 'candidate' },
      { id: 'missing-model', timestamp: 1, engine: 'sd', seed: -1 },
      { id: 'saved-size', timestamp: 0, engine: 'anima', size: '832x1216', width: 1664, height: 2432 },
    ]))
    expect(filters.generationOptions.value.engine).toHaveLength(3)
    filters.generationConditions.value.size = UNRECORDED_CONDITION
    expect(filters.visible.value.map(item => item.id)).toEqual(['old', 'recorded', 'missing-model'])
    filters.generationConditions.value.engine = UNRECORDED_CONDITION
    filters.generationConditions.value.model = UNRECORDED_CONDITION
    filters.generationConditions.value.outfit = UNRECORDED_CONDITION
    filters.generationConditions.value.seed = UNRECORDED_CONDITION
    filters.generationConditions.value.reviewState = UNRECORDED_CONDITION
    expect(filters.visible.value.map(item => item.id)).toEqual(['old'])
    filters.clearGenerationConditions()
    filters.generationConditions.value.seed = recordedCondition('0')
    expect(filters.visible.value.map(item => item.id)).toEqual(['recorded'])
    filters.generationConditions.value.model = recordedCondition('unavailable')
    expect(filters.generationOptions.value.model.at(-1)).toEqual({ value: recordedCondition('unavailable'), label: 'unavailable · 0' })
    filters.clearGenerationConditions()
    expect(filters.generationOptions.value.model.some(option => option.value === recordedCondition('unavailable'))).toBe(false)
    expect(options).toHaveBeenCalledOnce()
    options.mockRestore()
    stop()
  })

  it('resets pagination on condition changes, replaces cleared URL fields and preserves unrelated route keys', async () => {
    vi.useFakeTimers()
    const { filters, route, replace, stop } = setup(ref(Array.from({ length: 140 }, (_, id) => ({ id, timestamp: id, engine: id < 100 ? 'anima' : 'sd' }))))
    route.query = { compare: 'preserve', fav: '1', project: 'deleted-album', character: 'role-a', q: 'old', tag: 'old', gEngine: recordedCondition('sd'), gSeed: UNRECORDED_CONDITION }
    await nextTick()
    expect(filters.projectUnavailable.value).toBe(true)
    expect(filters.visible.value).toHaveLength(0)
    route.query = { compare: 'preserve', gEngine: recordedCondition('anima') }
    await nextTick()
    expect(filters.favoriteOnly.value).toBe(false)
    expect(filters.projectFilter.value).toBe('')
    expect(filters.characterFilter.value).toBe('')
    expect(filters.searchQuery.value).toBe('')
    expect(filters.tagFilter.value).toBe('')
    expect(filters.generationConditions.value.seed).toBe('')
    expect(filters.visible.value).toHaveLength(100)
    filters.renderLimit.value = 120
    filters.generationConditions.value.engine = recordedCondition('sd')
    await nextTick()
    expect(filters.renderLimit.value).toBe(60)
    await vi.advanceTimersByTimeAsync(300)
    expect(replace).toHaveBeenLastCalledWith({ query: { compare: 'preserve', gEngine: recordedCondition('sd') } })
    filters.renderLimit.value = 120
    route.query = { compare: 'preserve', gEngine: recordedCondition('sd') }
    await nextTick()
    expect(filters.renderLimit.value).toBe(120)
    filters.resetGalleryFilters(); await nextTick(); await vi.advanceTimersByTimeAsync(300)
    expect(filters.visible.value).toHaveLength(140)
    expect(replace).toHaveBeenLastCalledWith({ query: { compare: 'preserve' } })
    stop()
  })

  it('saves detached filter preferences, updates a named combination and exposes rejected saves without reporting success', async () => {
    const { filters, stop } = setup(ref([{ id: 'one', engine: 'anima', characterId: 'role-a', favorite: true }]))
    const values = new Map<string, string>()
    let rejectWrite = false
    const flush = vi.fn(async () => {})
    const preferences = createGalleryFilterPreferences({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { if (rejectWrite) throw new Error('资料保存失败'); values.set(key, value) },
      removeItem: key => { values.delete(key) },
    }, flush)
    let saved!: ReturnType<typeof useGallerySavedFilters>
    const wrapper = mount(defineComponent({ setup() {
      saved = useGallerySavedFilters({ snapshot: () => filters.filterSnapshot.value, apply: filters.applyFilterSnapshot, preferences })
      return () => h('div')
    } }))
    try {
      filters.favoriteOnly.value = true
      filters.characterFilter.value = 'role-a'
      filters.generationConditions.value.engine = recordedCondition('anima')
      expect(await saved.savePreset('常用')).toBe(true)
      const id = saved.presets.value[0].id
      expect(classifyMigrationKey('local', GALLERY_FILTER_PRESETS_KEY)).toBe('settings')
      filters.resetGalleryFilters()
      expect(filters.characterFilter.value).toBe('')
      expect(preferences.read()[0].filters.favoriteOnly).toBe(true)
      expect(preferences.read()[0].filters.characterFilter).toBe('role-a')
      saved.applyPreset(id)
      expect(filters.favoriteOnly.value).toBe(true)
      expect(filters.characterFilter.value).toBe('role-a')
      expect(filters.generationConditions.value.engine).toBe(recordedCondition('anima'))
      filters.generationConditions.value.seed = recordedCondition('0')
      expect(await saved.savePreset('常用')).toBe(true)
      expect(saved.presets.value).toHaveLength(1)
      expect(saved.presets.value[0].id).toBe(id)
      rejectWrite = true
      expect(await saved.savePreset('另一个')).toBe(false)
      expect(saved.message.value).toBe('')
      expect(saved.error.value).toContain('资料保存失败')
      expect(saved.busy.value).toBe(false)
      expect(preferences.read()).toHaveLength(1)
      rejectWrite = false
      expect(await saved.removePreset(id)).toBe(true)
      expect(preferences.read()).toEqual([])
      expect(filters.generationConditions.value.seed).toBe(recordedCondition('0'))
      expect(flush).toHaveBeenCalled()
    } finally { wrapper.unmount(); stop() }
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


it('keeps concurrently merged preset overflow removable while enforcing creation and byte limits', async () => {
  const { filters, stop } = setup()
  const snapshot = filters.filterSnapshot.value
  let raw = GALLERY_FILTER_PRESETS_SETTING.serialize(Array.from({ length: 25 }, (_, index) => ({ id: `preset-${index}`, name: `Preset ${index}`, filters: snapshot })))
  const storage = { getItem: () => raw, setItem: vi.fn((_key: string, value: string) => { raw = value }), removeItem: vi.fn() }
  const preferences = createGalleryFilterPreferences(storage, async () => {})
  try {
    expect(preferences.read()).toHaveLength(25)
    await expect(preferences.save('New preset', snapshot)).rejects.toThrow('最多保存 24')
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(await preferences.remove('preset-0')).toHaveLength(24)
    expect(await preferences.save('Preset 1', { ...snapshot, searchQuery: 'updated' })).toHaveLength(24)
    const before = raw
    await expect(preferences.save('Preset 1', { ...snapshot, searchQuery: 'x'.repeat(GALLERY_FILTER_PRESET_MAX_BYTES) })).rejects.toThrow('资料过大')
    expect(raw).toBe(before)
    expect(GALLERY_FILTER_PRESETS_SETTING.parse('x'.repeat(GALLERY_FILTER_PRESET_MAX_BYTES + 1))).toBeNull()
  } finally { stop() }
})
