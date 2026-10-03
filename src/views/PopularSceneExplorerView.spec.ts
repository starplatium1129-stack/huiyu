import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import PopularSceneExplorerView from './PopularSceneExplorerView.vue'

const access = vi.hoisted(() => ({ local: true, eligibility: 'adult' }))
const navigation = vi.hoisted(() => ({
  route: { path: '/popular-scenes', query: {} as Record<string, string> }, replace: vi.fn(), loadCatalog: vi.fn(async () => {}), extra: 0,
}))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => access.local }))
vi.mock('vue-router', () => ({ useRoute: () => navigation.route, useRouter: () => ({ replace: navigation.replace }) }))
vi.mock('@/stores/sceneStore', () => ({
  useSceneStore: () => ({
    loadBlueprintCatalog: navigation.loadCatalog, error: '',
    popularCharacters: ['fixture', 'second'].map(id => ({ id, displayName: id, franchise: '', adultEligibility: access.eligibility })),
    sceneBlueprints: [
      { id: 'safe', adult: false, sampleRating: 'All' },
      { id: 'legacy-safe', adult: false, sampleRating: 'SFW' },
      { id: 'adult', adult: true, sampleRating: 'R18' },
      { id: 'rated-image', adult: false, sampleRating: 'R18' },
      { id: 'second-safe', adult: false, sampleRating: 'All', characterId: 'second' },
      ...Array.from({ length: navigation.extra }, (_, index) => ({ id: `extra-${index}`, adult: false, sampleRating: 'All' })),
    ].map(item => ({ characterId: 'fixture', ...item, title: item.id, category: '日常', description: '',
      location: '', timeOfDay: 'day', lighting: '', camera: '', mood: '', sceneTags: [], promptProse: '', recommendedSize: '832x1216' })),
  }),
}))

let wrapper: VueWrapper | undefined
beforeEach(() => {
  access.local = true; access.eligibility = 'adult'
  navigation.route = reactive({ path: '/popular-scenes', query: {} })
  navigation.replace.mockReset()
  navigation.replace.mockResolvedValue(undefined)
  navigation.loadCatalog.mockClear()
  navigation.extra = 0
})
afterEach(() => { wrapper?.unmount() })
async function mountLibrary() {
  wrapper = shallowMount(PopularSceneExplorerView, { global: { stubs: { RuntimeImage: false, RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }, StudioTooltip: { template: '<slot />', inheritAttrs: false } } } })
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
    expect(card.find('.pop-decision').exists()).toBe(false)
    card.get('details').element.open = true
    await card.get('details').trigger('toggle')
    expect(card.get('.pop-decision').text()).toContain('832×1216')
    expect(card.get('.pop-draw-action').text()).toBe('绘制这一幕')
    expect(card.get('.pop-draw-action').attributes('href')).toBe('/prompt-builder?popular=fixture&blueprint=safe')
    expect(card.get('.pop-thumb').attributes('href')).toBe(card.get('.pop-draw-action').attributes('href'))
    expect(card.find('details .pop-draw-action').exists()).toBe(false)
  })

  it('renders a bounded first batch and preserves all results through load-more and search', async () => {
    navigation.extra = 25
    const page = await mountLibrary()
    expect(page.findAll('[data-blueprint-id]')).toHaveLength(24)
    await page.findAll('button').find(button => button.text().startsWith('加载更多'))!.trigger('click')
    expect(page.findAll('[data-blueprint-id]')).toHaveLength(29)
    page.findComponent({ name: 'StudioSearch' }).vm.$emit('update:modelValue', 'extra-24')
    await flushPromises()
    expect(page.findAll('[data-blueprint-id]').map(card => card.attributes('data-blueprint-id'))).toEqual(['extra-24'])
    page.findComponent({ name: 'StudioSearch' }).vm.$emit('update:modelValue', '')
    await flushPromises()
    expect(page.findAll('[data-blueprint-id]')).toHaveLength(24)
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

  it('同页角色导航更新列表和绘制目标，清除旧搜索且不重新读取目录', async () => {
    access.local = false
    navigation.route.query = { character: 'fixture', preserved: 'keep' }
    const page = await mountLibrary()
    page.findComponent({ name: 'StudioSearch' }).vm.$emit('update:modelValue', 'no matches')
    await flushPromises()
    expect(page.findAll('[data-blueprint-id]')).toHaveLength(0)
    navigation.route.query = { character: 'second', preserved: 'keep' }
    await flushPromises()
    expect(page.get('.pop-hero-copy h2').text()).toBe('second')
    expect(page.findAll('[data-blueprint-id]').map(card => card.attributes('data-blueprint-id'))).toEqual(['second-safe'])
    expect(page.get('.pop-draw-action').attributes('href')).toBe('/prompt-builder?popular=second&blueprint=second-safe')
    navigation.route.query = { character: 'unknown', preserved: 'keep' }
    await flushPromises()
    expect(page.get('.pop-hero-copy h2').text()).toBe('fixture')
    expect(navigation.loadCatalog).toHaveBeenCalledTimes(1)
    expect(navigation.replace).toHaveBeenCalledTimes(1)
  })

  it('重开页面沿用搜索和组合筛选，换角色时清除全部旧条件并保留其他查询', async () => {
    access.local = false
    navigation.route.query = { character: 'fixture', q: 'safe', category: '日常', rating: 'All', preserved: 'keep' }
    navigation.replace.mockImplementation(async ({ query }) => { navigation.route.query = query })
    const page = await mountLibrary()
    expect(page.findAll('[data-blueprint-id]').map(card => card.attributes('data-blueprint-id'))).toEqual(['safe', 'legacy-safe'])
    expect(page.findComponent({ name: 'StudioSearch' }).props('modelValue')).toBe('safe')
    page.findComponent({ name: 'BrowsingCharacterDirectory' }).vm.$emit('select', 'second')
    await flushPromises()
    expect(navigation.route.query).toEqual({ character: 'second', preserved: 'keep' })
    expect(page.findComponent({ name: 'StudioSearch' }).props('modelValue')).toBe('')
    expect(page.get('.pop-rating-pill.active').text()).toBe('全部分级')
    expect(page.get('.pop-cat.active').text()).toContain('全部')
    expect(page.get('.pop-draw-action').attributes('href')).toBe('/prompt-builder?popular=second&blueprint=second-safe')
  })
})
