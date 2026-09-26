import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import PopularSceneExplorerView from './PopularSceneExplorerView.vue'

const access = vi.hoisted(() => ({ local: true, eligibility: 'adult' }))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => access.local }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/stores/sceneStore', () => ({
  useSceneStore: () => ({
    ensureCore: async () => {}, error: '',
    popularCharacters: [{ id: 'fixture', displayName: '角色', franchise: '', adultEligibility: access.eligibility }],
    sceneBlueprints: [
      { id: 'safe', adult: false, sampleRating: 'All' },
      { id: 'legacy-safe', adult: false, sampleRating: 'SFW' },
      { id: 'adult', adult: true, sampleRating: 'R18' },
      { id: 'rated-image', adult: false, sampleRating: 'R18' },
    ].map(item => ({ ...item, characterId: 'fixture', title: item.id, category: '日常', description: '',
      location: '', timeOfDay: 'day', lighting: '', camera: '', mood: '', sceneTags: [], promptProse: '', recommendedSize: '832x1216' })),
  }),
}))

let wrapper: VueWrapper | undefined
beforeEach(() => { access.local = true; access.eligibility = 'adult' })
afterEach(() => { wrapper?.unmount() })
async function mountLibrary() {
  wrapper = shallowMount(PopularSceneExplorerView, { global: { stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }, StudioTooltip: { template: '<slot />', inheritAttrs: false } } } })
  await flushPromises()
  return wrapper
}

describe('角色场景的本机访问边界', () => {
  it('远程不渲染成人蓝图、R18 样张或绘制入口，并说明本机限制', async () => {
    access.local = false
    const page = await mountLibrary()
    expect(page.findAll('[data-blueprint-id]').map(card => card.attributes('data-blueprint-id'))).toEqual(['safe', 'legacy-safe'])
    expect(page.findAll('img').every(image => !/adult|rated-image/.test(image.attributes('src') || ''))).toBe(true)
    expect(page.get('.mature-hint').text()).toBe('成人场景 · 仅限本机')
  })

  it('本机成年角色保留成人场景和 R18 模糊遮罩', async () => {
    const page = await mountLibrary()
    expect(page.findAll('[data-blueprint-id]')).toHaveLength(4)
    expect(page.findAll('img.pop-thumb-r18')).toHaveLength(2)
    expect(page.get('.mature-hint').text()).toContain('已展示')
  })

  it.each(['minor', 'unknown', ''])('本机角色资格为 %s 时仍默认拒绝成人内容', async eligibility => {
    access.eligibility = eligibility
    const page = await mountLibrary()
    expect(page.findAll('[data-blueprint-id]').map(card => card.attributes('data-blueprint-id'))).toEqual(['safe', 'legacy-safe'])
  })

  it('全年龄筛选包含历史 SFW 样张，并且不显示成人样式的徽章', async () => {
    const page = await mountLibrary()
    await page.findAll('.pop-rating-pill').find(button => button.text() === '全年龄')!.trigger('click')
    expect(page.findAll('[data-blueprint-id]').map(card => card.attributes('data-blueprint-id'))).toEqual(['safe', 'legacy-safe'])
    expect(page.findAll('.pop-rating')).toHaveLength(0)
  })

  it('次级场景设定默认收起，绘制入口始终携带原角色与蓝图', async () => {
    const page = await mountLibrary()
    const card = page.get('[data-blueprint-id="safe"]')
    expect(card.get('details').element.open).toBe(false)
    expect(card.get('summary').text()).toBe('场景细节')
    expect(card.get('.pop-decision').text()).toContain('832×1216')
    expect(card.get('.pop-draw-action').text()).toBe('绘制这一幕')
    expect(card.get('.pop-draw-action').attributes('href')).toBe('/prompt-builder?popular=fixture&blueprint=safe')
    expect(card.get('.pop-thumb').attributes('href')).toBe(card.get('.pop-draw-action').attributes('href'))
    expect(card.find('details .pop-draw-action').exists()).toBe(false)
  })

  it('图片失败明确显示待补充，并保留对应场景的绘制入口', async () => {
    const page = await mountLibrary()
    const card = page.get('[data-blueprint-id="safe"]')
    await card.get('img').trigger('error')
    expect(card.get('.pop-preview-missing').text()).toContain('样张暂不可用')
    expect(card.get('img').classes()).toContain('pop-thumb-missing')
    expect(card.get('.pop-draw-action').attributes('href')).toBe('/prompt-builder?popular=fixture&blueprint=safe')
    expect(page.get('[data-blueprint-id="legacy-safe"]').find('.pop-preview-missing').exists()).toBe(false)
  })
})
