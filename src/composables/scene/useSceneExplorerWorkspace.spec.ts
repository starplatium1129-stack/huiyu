import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { profileLocalStorage } from '@/platform/web/profileStorage'
import { useSceneExplorerWorkspace } from './useSceneExplorerWorkspace'

const toastError = vi.hoisted(() => vi.fn())
const catalog = vi.hoisted(() => vi.fn())
const route = reactive({ path: '/scene-explorer', query: {} as Record<string, string> })
const replace = vi.fn(async ({ query }: { query: Record<string, string> }) => { route.query = query })
beforeEach(() => {
  route.path = '/scene-explorer'; route.query = {}; replace.mockClear(); catalog.mockReset()
  catalog.mockResolvedValue({ scenes: [{ id: 'available', title: 'Available', char: 'nene', rating: 'All' }], curation: {} })
})
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ error: toastError }) }))
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))
vi.mock('@/composables/useFocusTrap', () => ({ useFocusTrap: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { readPreferenceHistory: async () => [] } }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({ loadBrowserScenes: catalog }) }))

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); toastError.mockClear(); localStorage.removeItem('aics_scene_favorites'); localStorage.removeItem('aics_hidden_scenes') })

it('honors explicit companion choice without changing filters and resets empty recommendations to the full library', async () => {
  // A removed favorite still selects the personal startup view, which can be empty.
  localStorage.setItem('aics_scene_favorites', JSON.stringify(['removed']))
  let workspace!: ReturnType<typeof useSceneExplorerWorkspace>
  const wrapper = mount(defineComponent({ setup() { workspace = useSceneExplorerWorkspace(); return () => null } }))
  try {
    await flushPromises()
    expect(workspace.fTier.value).toBe('personal')
    expect(workspace.filtered.value).toHaveLength(0)
    workspace.fChar.value = 'natsume'
    workspace.searchQuery.value = '夏目'
    expect(workspace.companionId.value).toBe('natsume')
    workspace.manualCompanion.value = 'nene'
    expect(workspace.companionId.value).toBe('nene')
    expect(workspace.fChar.value).toBe('natsume')
    expect(workspace.searchQuery.value).toBe('夏目')
    workspace.resetFilters()
    await flushPromises()
    expect(workspace.fTier.value).toBe('all')
    expect(workspace.fChar.value).toBe('all')
    expect(workspace.filtered.value.map(scene => scene.id)).toEqual(['available'])
  } finally { wrapper.unmount() }
})


it('publishes favorite and hidden changes only after storage accepts them, keeping retry usable', async () => {
  let workspace!: ReturnType<typeof useSceneExplorerWorkspace>
  const wrapper = mount(defineComponent({ setup() { workspace = useSceneExplorerWorkspace(); return () => null } }))
  try {
    await flushPromises()
    workspace.showAllScenes(); await flushPromises()
    const write = vi.spyOn(profileLocalStorage, 'setItem')
    write.mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError') })
    workspace.toggleFav('available')
    expect(workspace.favs.value.has('available')).toBe(false)
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('收藏未保存'))
    workspace.toggleFav('available')
    expect(workspace.favs.value.has('available')).toBe(true)
    expect(JSON.parse(profileLocalStorage.getItem('aics_scene_favorites')!)).toEqual(['available'])
    write.mockImplementationOnce(() => { throw new Error('Read-only') })
    workspace.toggleHidden('available')
    expect(workspace.hiddenIds.value.has('available')).toBe(false)
    expect(workspace.filtered.value).toHaveLength(1)
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('隐藏设置未保存'))
    workspace.toggleHidden('available')
    expect(workspace.hiddenIds.value.has('available')).toBe(true)
    expect(workspace.filtered.value).toHaveLength(0)
    write.mockImplementationOnce(() => { throw new Error('Read-only') })
    workspace.toggleHidden('available')
    expect(workspace.hiddenIds.value.has('available')).toBe(true)
    expect(JSON.parse(profileLocalStorage.getItem('aics_hidden_scenes')!)).toEqual(['available'])
  } finally { wrapper.unmount() }
})


it('tracks same-path query navigation without replaying stale typing or reloading the same catalog coverage', async () => {
  vi.useFakeTimers()
  route.query = { q: 'initial', character: 'nene', extra: 'keep' }
  let workspace!: ReturnType<typeof useSceneExplorerWorkspace>
  const wrapper = mount(defineComponent({ setup() { workspace = useSceneExplorerWorkspace(); return () => null } }))
  try {
    await flushPromises()
    expect(catalog.mock.calls).toEqual([['nene']])
    expect(workspace.searchQuery.value).toBe('initial')
    workspace.activeTheme.value = 'daily'; workspace.sortBy.value = 'title'
    route.query = { extra: 'keep' }; await flushPromises()
    expect(workspace.searchQuery.value).toBe('')
    expect(workspace.fChar.value).toBe('all')
    expect(catalog).toHaveBeenLastCalledWith('core')
    workspace.searchQuery.value = 'obsolete typing'; await nextTick()
    route.query = { q: 'back-forward', character: 'natsume', theme: 'daily', sort: 'title', extra: 'keep' }
    await flushPromises(); await vi.advanceTimersByTimeAsync(150)
    expect(workspace.searchQuery.value).toBe('back-forward')
    expect(workspace.fChar.value).toBe('natsume')
    expect(workspace.activeTheme.value).toBe('daily')
    expect(workspace.sortBy.value).toBe('title')
    expect(replace).not.toHaveBeenCalled()
    route.query = { extra: 'keep' }; await flushPromises()
    workspace.searchQuery.value = 'typed'; await nextTick()
    await vi.advanceTimersByTimeAsync(149)
    expect(replace).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await flushPromises()
    expect(route.query).toEqual({ q: 'typed', extra: 'keep', tier: 'core' })
    expect(catalog).toHaveBeenLastCalledWith('all')
    const calls = catalog.mock.calls.length
    workspace.searchQuery.value = 'typed more'; await nextTick()
    await vi.advanceTimersByTimeAsync(150); await flushPromises()
    expect(catalog).toHaveBeenCalledTimes(calls)
    workspace.fChar.value = 'nene'; await flushPromises()
    expect(route.query).toEqual({ q: 'typed more', character: 'nene', extra: 'keep', tier: 'core' })
    let acknowledge!: () => void
    replace.mockImplementationOnce(({ query }) => new Promise(resolve => { acknowledge = () => { route.query = query; resolve() } }))
    workspace.searchQuery.value = 'slow navigation'; await nextTick()
    await vi.advanceTimersByTimeAsync(150)
    workspace.searchQuery.value = 'newer typing'; await nextTick()
    acknowledge(); await flushPromises()
    expect(workspace.searchQuery.value).toBe('newer typing')
    await vi.advanceTimersByTimeAsync(150); await flushPromises()
    expect(route.query.q).toBe('newer typing')
  } finally { wrapper.unmount() }
})

it('restores combined filters from the URL after creating a scene changes the startup scope', async () => {
  let workspace!: ReturnType<typeof useSceneExplorerWorkspace>
  const component = defineComponent({ setup() { workspace = useSceneExplorerWorkspace(); return () => null } })
  let wrapper = mount(component)
  try {
    await flushPromises()
    workspace.showAllScenes(); workspace.activeTheme.value = 'daily'; workspace.fChar.value = 'nene'
    workspace.fSeason.value = '夏'; workspace.fTime.value = 'night'; workspace.fSeries.value = 'after'
    workspace.fRating.value = 'All'; workspace.sortBy.value = 'title'; workspace.showHidden.value = true
    await flushPromises()
    expect(route.query).toEqual({ character: 'nene', theme: 'daily', season: '夏', time: 'night', series: 'after',
      rating: 'All', sort: 'title', tier: 'all', hidden: '1' })
    wrapper.unmount()
    localStorage.setItem('aics_scene_favorites', JSON.stringify(['available']))
    wrapper = mount(component); await flushPromises()
    expect([workspace.activeTheme.value, workspace.fChar.value, workspace.fSeason.value, workspace.fTime.value,
      workspace.fSeries.value, workspace.fRating.value, workspace.fTier.value, workspace.sortBy.value, workspace.showHidden.value])
      .toEqual(['daily', 'nene', '夏', 'night', 'after', 'All', 'all', 'title', true])
    expect(catalog).toHaveBeenLastCalledWith('nene')
    workspace.resetFilters(); await flushPromises()
    expect(route.query).toEqual({ tier: 'all' })
  } finally { wrapper.unmount() }
})

it('analyzes aliases once for one filter-and-score pass over 64 scenes', async () => {
  route.query = { q: '雨夜', tier: 'all' }
  const aliases = vi.fn(() => ({ 夜雨: ['雨夜', 'rain night'] }))
  catalog.mockResolvedValue({ scenes: Array.from({ length: 64 }, (_, index) => ({ id: `sample-${index}`, title: '雨夜', char: 'nene', rating: 'All' })),
    curation: { get searchAliases() { return aliases() } } })
  let workspace!: ReturnType<typeof useSceneExplorerWorkspace>
  const wrapper = mount(defineComponent({ setup() { workspace = useSceneExplorerWorkspace(); return () => null } }))
  try {
    await flushPromises(); aliases.mockClear()
    expect(workspace.filtered.value).toHaveLength(64)
    expect(aliases).toHaveBeenCalledOnce()
  } finally { wrapper.unmount() }
})
