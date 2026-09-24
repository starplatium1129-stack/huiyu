import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import CharacterView from './CharacterView.vue'

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/composables/useScrollReveal', () => ({ useScrollReveal: () => {} }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({ load: async () => {}, loadCharacterShell: async () => {}, characters: [], scenes: [], curation: {} }) }))
vi.mock('@/utils/characterProfiles', () => ({
  parseCharacterProfiles: () => [{ id: 'nene', name: '宁宁', source: '', tags: [], personality: [], likes: [] }],
  parseCharacterScenes: () => [], popularPortraitSrc: () => '', isPopularPortraitPending: () => false,
}))
vi.mock('@/utils/characterReferenceData', () => ({
  ensureCharacterReferencesLoaded: async () => {},
  getCharacterReferences: () => ({ outfits: [{ outfitId: 'default', outfitName: '默认', references: [
    { id: 'front', name: '正面', url: '/front.png' },
    { id: 'pending', name: '待生成', url: '' },
    { id: 'side', name: '侧面', url: '/side.png' },
    { id: 'last-pending', name: '末尾待生成', url: '' },
  ] }] }),
}))

let wrapper: VueWrapper | undefined
afterEach(() => wrapper?.unmount())
async function openReferences() {
  wrapper = shallowMount(CharacterView, { global: { stubs: { teleport: true, RouterLink: { template: '<a><slot /></a>' }, StudioTooltip: { template: '<slot />', inheritAttrs: false } } } })
  await flushPromises()
  await wrapper.get('.char-ref-card').trigger('click')
  await flushPromises()
  return wrapper
}

describe('角色参考图浏览', () => {
  it('方向键跳过待生成图片，到最后一张可用图时禁用下一张', async () => {
    const page = await openReferences()
    expect(page.get('[aria-label="上一视角"]').attributes('disabled')).toBeDefined()
    await page.get('dialog').trigger('keydown', { key: 'ArrowRight' })
    expect(page.get('.ref-modal-copy h2').text()).toContain('侧面')
    expect(page.get('[aria-label="下一视角"]').attributes('disabled')).toBeDefined()
    await page.get('dialog').trigger('keydown', { key: 'ArrowLeft' })
    expect(page.get('.ref-modal-copy h2').text()).toContain('正面')
  })

  it('修饰键组合不意外切换图片', async () => {
    const page = await openReferences()
    await page.get('dialog').trigger('keydown', { key: 'ArrowRight', altKey: true })
    expect(page.get('.ref-modal-copy h2').text()).toContain('正面')
  })
})
