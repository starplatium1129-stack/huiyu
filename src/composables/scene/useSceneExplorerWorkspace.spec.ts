import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { useSceneExplorerWorkspace } from './useSceneExplorerWorkspace'

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn().mockResolvedValue(undefined) }) }))
vi.mock('@/composables/useFocusTrap', () => ({ useFocusTrap: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { readPreferenceHistory: async () => [] } }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({ loadBrowserScenes: async () => ({
  scenes: [{ id: 'available', title: 'Available', char: 'nene', rating: 'All' }], curation: {},
}) }) }))

afterEach(() => localStorage.removeItem('aics_scene_favorites'))

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
