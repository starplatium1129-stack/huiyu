import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import CharacterView from './CharacterView.vue'

vi.mock('@/stores/sceneStore', () => ({
  useSceneStore: () => ({
    characters: ['莱万汀', '佩丽卡', '伊冯', '庄方宜', '管理员', '洛茜'].map((name, index) => ({ id: `endfield-${index}`, name, source: 'Arknights: Endfield', type: 'popular' })),
    loadCharacterShell: async () => {}, loadBrowserScenes: async () => ({ scenes: [] }), loadBlueprintCatalog: async () => {},
    sceneBlueprints: [], curation: {},
  }),
}))
vi.mock('@/composables/useCharacterPortraitTransition', () => ({
  useCharacterPortraitTransition: () => ({ preferOriginal: ref(false), enter: (_element: Element, done: () => void) => done(), dispose: () => {} }),
}))
vi.mock('@/composables/useScrollReveal', () => ({ useScrollReveal: () => {} }))

let wrapper: VueWrapper | undefined
afterEach(() => wrapper?.unmount())

it('角色页真实卸载后恢复目录搜索与作品组，书架和详情之间也保留搜索', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/character', component: CharacterView },
    { path: '/popular-scenes', component: { template: '<p>角色场景</p>' } },
  ] })
  await router.push('/character')
  await router.isReady()
  wrapper = mount(defineComponent({ setup: () => () => h(RouterView) }), {
    attachTo: document.body,
    global: { plugins: [router], stubs: { CharacterParticleStage: { template: '<div><slot /></div>' } }, directives: { 'content-motion': {} } },
  })
  await flushPromises()
  await wrapper.get('[data-franchise="Arknights: Endfield"]').trigger('click')
  expect(wrapper.get('.bookshelf-results-heading h2').text()).toBe('明日方舟：终末地')
  await wrapper.get('.bookshelf-character[data-character="endfield-0"]').trigger('click')
  await flushPromises()
  await wrapper.get('[aria-label="搜索角色或作品"]').setValue('终末地')
  await wrapper.get('.directory-item[data-character="endfield-2"]').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.query.character).toBe('endfield-2')
  await wrapper.get('.character-context-nav a:last-child').trigger('click')
  await flushPromises()
  expect(wrapper.find('.character-page').exists()).toBe(false)
  router.back()
  await flushPromises()
  expect(wrapper.get('.character-name').text()).toBe('伊冯')
  expect((wrapper.get('[aria-label="搜索角色或作品"]').element as HTMLInputElement).value).toBe('终末地')
  expect(wrapper.findAll('.directory-item')).toHaveLength(6)
  await wrapper.get('.archive-header-actions > button').trigger('click')
  await flushPromises()
  expect(wrapper.get('.bookshelf-results-heading h2').text()).toBe('明日方舟：终末地')
  expect(wrapper.findAll('.bookshelf-character')).toHaveLength(6)
  await wrapper.get('.bookshelf-character[data-character="endfield-2"]').trigger('click')
  await flushPromises()
  expect((wrapper.get('[aria-label="搜索角色或作品"]').element as HTMLInputElement).value).toBe('终末地')
})
