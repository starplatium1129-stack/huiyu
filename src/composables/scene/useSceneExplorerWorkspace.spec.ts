import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { profileLocalStorage } from '@/platform/web/profileStorage'
import { useSceneExplorerWorkspace } from './useSceneExplorerWorkspace'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ error: toastError }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn().mockResolvedValue(undefined) }) }))
vi.mock('@/composables/useFocusTrap', () => ({ useFocusTrap: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { readPreferenceHistory: async () => [] } }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({ loadBrowserScenes: async () => ({
  scenes: [{ id: 'available', title: 'Available', char: 'nene', rating: 'All' }], curation: {},
}) }) }))

afterEach(() => { vi.restoreAllMocks(); toastError.mockClear(); localStorage.removeItem('aics_scene_favorites'); localStorage.removeItem('aics_hidden_scenes') })

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
