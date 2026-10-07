import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import SceneManagerView from './SceneManagerView.vue'

const leave = vi.hoisted(() => vi.fn())
vi.mock('vue-router', () => ({ useRoute: () => ({ query: { tab: 'portraits' } }) }))
vi.mock('@/composables/scene/useCatalogMaintenance', () => ({ useCatalogMaintenance: () => ({
  kind: ref('character'), search: ref(''), character: ref(''), category: ref(''), rating: ref(''), sort: ref('order'), page: ref(1),
  result: ref(null), counts: ref({}), loading: ref(false), error: ref(''), hint: ref(''), selected: ref(null), currentServer: ref(null),
  detailLoading: ref(false), pending: ref([]), busy: ref(false), preview: ref(null), history: ref([]), dirtyEditor: ref(false), dirty: ref(false),
  totalPages: ref(1), bulkInput: ref(''), bulkError: ref(''), importSnapshot: ref(null), importPreview: ref(null), characterNames: ref({}),
}) }))

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); leave.mockReset() })
const portrait = defineComponent({
  setup(_props, { expose }) {
    expose({ canLeave: leave })
    return () => h('div', { 'data-portrait-draft': '' }, 'unsaved portrait')
  },
})

it.each(['media', 'records'])('keeps the portrait subpage when leaving for %s is declined, then switches after consent', async target => {
  leave.mockResolvedValue(false)
  wrapper = shallowMount(SceneManagerView, { global: { stubs: { CharacterArtManager: portrait }, directives: { 'content-motion': {} } } })
  await flushPromises()
  const destination = () => target === 'media'
    ? wrapper!.findAll('.catalog-nav-secondary button')[1]!
    : wrapper!.get('.catalog-nav-group button')
  expect(wrapper.find('[data-portrait-draft]').exists()).toBe(true)
  await destination().trigger('click')
  await flushPromises()
  expect(leave).toHaveBeenCalledOnce()
  expect(wrapper.find('[data-portrait-draft]').exists()).toBe(true)
  leave.mockResolvedValue(true)
  await destination().trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-portrait-draft]').exists()).toBe(false)
})
