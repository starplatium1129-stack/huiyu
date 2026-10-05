import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import HomeView from './HomeView.vue'
import { useSceneStore } from '@/stores/sceneStore'
import { deferred, fullRoutes, response, scene } from '@/stores/sceneStoreTestFixtures'

vi.mock('@/composables/useScrollReveal', () => ({ useScrollReveal: () => {} }))
vi.mock('@/composables/useHomeRecentWorks', () => ({ useHomeRecentWorks: () => ({ recentWorks: ref([]), coverUrl: () => '', load: async () => {} }) }))
vi.mock('@/composables/useHomeHeroes', () => ({ useHomeHeroes: () => ({ heroes: ref({ nene: { image: '' }, natsume: { image: '' } }) }) }))
vi.mock('@/composables/useRuntimeImage', () => ({ useRuntimeImage: () => ({ image: ref({}), loaded: ref(false), failed: ref(false), retry: () => {} }) }))
afterEach(() => { vi.unstubAllGlobals() })

it('updates featured scenes and counts when optional curation arrives after home loading', async () => {
  setActivePinia(createPinia())
  const curation = deferred<Response>()
  const routes: Record<string, unknown> = {
    ...fullRoutes(),
    'scenes-shared.json': [scene('safe'), scene('mature', { mature: true }), scene('rated', { rating: 'R18' })],
  }
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const file = String(input).split('?')[0].split('/').pop()!
    return file === 'curation.json' ? curation.promise : response(routes[file])
  }))
  const page = shallowMount(HomeView, { global: { stubs: { RouterLink: { props: ['to'], template: '<a><slot /></a>' } } } })
  try {
    await flushPromises()
    const store = useSceneStore()
    expect(store.loading).toBe(false)
    expect(page.text()).toContain('0 个招牌与精选，完整库共 5 个。')
    expect(page.findComponent({ name: 'HomeArtJournal' }).props('scenes')).toEqual([])

    curation.resolve(response({ signatureSceneIds: ['mature', 'safe'], curatedSceneIds: ['safe', 'rated'] }))
    await flushPromises()
    expect(page.text()).toContain('3 个招牌与精选，完整库共 5 个。')
    const featured = page.findComponent({ name: 'HomeArtJournal' }).props('scenes') as Array<{ id: string }>
    expect(featured.length).toBeGreaterThan(0)
    expect(featured.every(item => item.id === 'safe')).toBe(true)

    // Another store target must not turn the home snapshot into a partial catalog.
    store.scenes = []
    await flushPromises()
    expect(page.text()).toContain('完整库共 5 个。')
    expect(page.findComponent({ name: 'HomeArtJournal' }).props('scenes')).toEqual(featured)
  } finally { page.unmount(); curation.resolve(response({})) }
})
