import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import InspirationDeck from './InspirationDeck.vue'
import { DEFAULT_RAILS } from '@/composables/scene/sceneExplorerPresentation'

const activity = { canPresent: ref(true), canAnimate: ref(true) }
vi.mock('@/composables/useVisualActivity', () => ({ useVisualActivity: () => activity }))
const wrappers: ReturnType<typeof mount>[] = []
beforeEach(() => { vi.useFakeTimers(); activity.canPresent.value = true; activity.canAnimate.value = true })
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers() })
function fixture(scenes: NonNullable<InstanceType<typeof InspirationDeck>['$props']['scenes']> = []) {
  const wrapper = mount(InspirationDeck, { props: { rails: DEFAULT_RAILS, scenes }, global: { stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } } })
  wrappers.push(wrapper)
  const stage = wrapper.get('.inspiration-deck-stage')
  const captured = new Set<number>()
  Object.assign(stage.element, {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  })
  const pointer = (type: string, x: number, y = 0) => stage.trigger(type, {
    pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y,
  })
  return { wrapper, stage, captured, pointer, title: () => wrapper.get('.front h2').text() }
}
it('turns with buttons and keyboard, announces the front, and only explicit exploration selects a rail', async () => {
  const { wrapper, stage, title } = fixture()
  await vi.advanceTimersByTimeAsync(5000)
  expect(title()).toBe(DEFAULT_RAILS[0].title)
  await wrapper.get('[aria-label="下一张灵感"]').trigger('click')
  await stage.trigger('keydown', { key: 'ArrowRight' }) // no reentry during the same turn
  await vi.advanceTimersByTimeAsync(280)
  expect(title()).toBe(DEFAULT_RAILS[1].title)
  expect(wrapper.get('[role="status"]').text()).toContain(DEFAULT_RAILS[1].title)
  expect(wrapper.findAll('article[inert]')).toHaveLength(2)
  await stage.trigger('keydown', { key: 'ArrowLeft' })
  await vi.advanceTimersByTimeAsync(280)
  expect(title()).toBe(DEFAULT_RAILS[0].title)
  expect(wrapper.emitted('select')).toBeUndefined()
  await wrapper.get('.front button').trigger('click')
  expect(wrapper.emitted('select')).toEqual([[DEFAULT_RAILS[0]]])
})
it('keeps vertical scroll, short drags and interactive button presses distinct from page turns', async () => {
  const { wrapper, pointer, title } = fixture()
  await pointer('pointerdown', 150); await pointer('pointermove', 155, 40); await pointer('pointerup', 0, 50)
  await pointer('pointerdown', 150); await pointer('pointermove', 130); await pointer('pointerup', 130)
  await wrapper.get('.front button').trigger('pointerdown', { pointerId: 1, isPrimary: true, button: 0, clientX: 150, clientY: 0 })
  await pointer('pointermove', 0); await pointer('pointerup', 0)
  await vi.advanceTimersByTimeAsync(280)
  expect(title()).toBe(DEFAULT_RAILS[0].title)
  expect(wrapper.emitted('select')).toBeUndefined()
})
it('swipes in either direction without selecting and suppresses the trailing pointer click', async () => {
  const { wrapper, pointer, captured, title } = fixture()
  await pointer('pointerdown', 200); await pointer('pointermove', 60)
  expect(captured.has(1)).toBe(true)
  await pointer('pointerup', 60)
  expect(captured.size).toBe(0)
  await vi.advanceTimersByTimeAsync(280)
  expect(title()).toBe(DEFAULT_RAILS[1].title)
  await wrapper.get('.front button').trigger('click', { detail: 1 })
  expect(wrapper.emitted('select')).toBeUndefined()
  await pointer('pointerdown', 0); await pointer('pointermove', 130); await pointer('pointerup', 130)
  await vi.advanceTimersByTimeAsync(280)
  expect(title()).toBe(DEFAULT_RAILS[0].title)
})
it('cancels a captured drag on Escape or pointer cancellation', async () => {
  const { stage, pointer, captured, title } = fixture()
  for (const cancel of ['escape', 'pointercancel']) {
    await pointer('pointerdown', 200); await pointer('pointermove', 60)
    if (cancel === 'escape') await stage.trigger('keydown', { key: 'Escape' })
    else await pointer('pointercancel', 60)
    await pointer('pointerup', 60)
    expect(captured.size).toBe(0)
  }
  await vi.advanceTimersByTimeAsync(280)
  expect(title()).toBe(DEFAULT_RAILS[0].title)
})
it('keeps reduced-motion navigation immediate and clears hidden or unmounted work', async () => {
  const { wrapper, stage, pointer, captured, title } = fixture()
  activity.canAnimate.value = false
  await stage.trigger('keydown', { key: 'ArrowRight' })
  expect(title()).toBe(DEFAULT_RAILS[1].title)
  expect(vi.getTimerCount()).toBe(0)
  await pointer('pointerdown', 200); await pointer('pointermove', 60)
  activity.canPresent.value = false
  await nextTick()
  expect(captured.size).toBe(0)
  await pointer('pointerup', 60)
  expect(title()).toBe(DEFAULT_RAILS[1].title)
  activity.canPresent.value = true; activity.canAnimate.value = true
  await stage.trigger('keydown', { key: 'ArrowRight' })
  wrapper.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
it('preserves the page after a catalog reload, resets on changed rails and supports one card', async () => {
  const { wrapper, stage, title } = fixture()
  await stage.trigger('keydown', { key: 'ArrowRight' })
  await vi.advanceTimersByTimeAsync(280)
  await wrapper.setProps({ rails: DEFAULT_RAILS.map(rail => ({ ...rail })) })
  expect(title()).toBe(DEFAULT_RAILS[1].title)
  await stage.trigger('keydown', { key: 'ArrowRight' })
  await wrapper.setProps({ rails: [DEFAULT_RAILS[2]] })
  await vi.advanceTimersByTimeAsync(280)
  expect(title()).toBe(DEFAULT_RAILS[2].title)
  expect(wrapper.get('[aria-label="下一张灵感"]').attributes('disabled')).toBeDefined()
  await wrapper.get('.front button').trigger('click')
  expect(wrapper.emitted('select')).toEqual([[DEFAULT_RAILS[2]]])
})
it('uses matching All-rated catalog scenes and keeps absent or failed previews browsable', async () => {
  const base = { char: 'nene', tags: ['library'], mature: false, location: '学院图书馆' }
  const sample = { ...base, id: 'sc215', title: '月光书页', story: 'library', rating: 'All' }
  const second = { ...base, char: 'natsume', id: 'sc220', title: '咖啡馆的灯', tags: ['cafe'], rating: 'All' }
  const { wrapper, title } = fixture([
    { ...base, id: 'sc105', title: '受限样张', rating: 'R18' },
    { ...base, id: 'sc264', title: '未确认分级' },
    { ...sample, id: 'sc106', mature: true },
    { ...sample, id: 'sc214', story: '' }, sample, // A weaker match precedes the winner.
    { ...sample, id: 'sc216' }, // A tied match must not replace the first winner.
    { ...sample, id: 'sc002', tags: ['park'] }, second,
  ])
  expect(title()).toBe(sample.title)
  expect(wrapper.findAll('img')).toHaveLength(2) // Only the active thumbnail and its complete artwork load.
  const img = wrapper.get('.front img')
  expect(img.attributes('src')).toBe('/scene-showcase/thumbs/sc215.jpg')
  expect(img.attributes('alt')).toContain(sample.title)
  expect(wrapper.get('.inspiration-feature img').attributes('src')).toBe('/scene-showcase/images/sc215.jpg')
  expect(wrapper.get('.inspiration-feature-draw').attributes('href')).toBe('/prompt-builder?scene=sc215')
  await wrapper.get('.inspiration-feature-image').trigger('click')
  expect(wrapper.emitted('open')).toEqual([[sample]])
  await wrapper.get('[aria-label="下一张灵感"]').trigger('click')
  await vi.advanceTimersByTimeAsync(280)
  expect(wrapper.get('.inspiration-feature img').attributes('src')).toBe('/scene-showcase/images/sc220.jpg')
  expect(wrapper.get('.inspiration-feature-draw').attributes('href')).toBe('/prompt-builder?scene=sc220')
  await wrapper.get('[aria-label="上一张灵感"]').trigger('click')
  await vi.advanceTimersByTimeAsync(280)
  const returnedImage = wrapper.get('.front img')
  await returnedImage.trigger('error')
  expect(wrapper.get('.front [role="status"]').text()).toContain('预览未能加载')
  await wrapper.get('.front button').trigger('click')
  expect(wrapper.emitted('select')).toEqual([[DEFAULT_RAILS[0]]])
  await wrapper.setProps({ scenes: [] })
  expect(title()).toBe(DEFAULT_RAILS[0].title)
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.get('.front').text()).toContain('场景预览待收录')
})
