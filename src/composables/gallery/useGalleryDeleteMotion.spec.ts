import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'
import { useGalleryDeleteMotion } from './useGalleryDeleteMotion'

const activity = { canAnimate: ref(true), lowEffects: ref(false) }
vi.mock('@/composables/useVisualActivity', () => ({ useVisualActivity: () => activity }))
const mocks = vi.hoisted(() => ({ dissolve: vi.fn() }))
vi.mock('@/utils/canvasDissolve', () => ({ startCanvasDissolve: mocks.dissolve }))
const releases: Array<ReturnType<typeof vi.fn>> = []
const cleanups: Array<() => void> = []
const rect = (top = 0) => ({ x: 0, y: top, top, left: 0, right: 240, bottom: top + 100, width: 240, height: 100, toJSON() {} })
beforeEach(() => {
  activity.canAnimate.value = true; activity.lowEffects.value = false
  releases.length = 0
  mocks.dissolve.mockReset().mockImplementation(() => { const release = vi.fn(); releases.push(release); return release })
  vi.useFakeTimers()
})
afterEach(() => {
  cleanups.splice(0).forEach(fn => fn()); vi.useRealTimers(); vi.restoreAllMocks()
  delete (HTMLElement.prototype as { animate?: unknown }).animate
})
async function fixture() {
  const items = ref([1, 2, 3, 4].map(id => ({ id }) as ArtworkRecord)), loading = ref(false)
  let motion!: ReturnType<typeof useGalleryDeleteMotion>
  const wrapper = mount(defineComponent({ setup() {
    const root = ref<HTMLElement | null>(null)
    motion = useGalleryDeleteMotion(root, () => items.value, () => loading.value)
    return () => h('div', { ref: root }, items.value.map(item => h('article', {
      key: item.id, class: 'artwork', 'data-card-id': String(item.id),
    }, h('img', { class: 'artwork-image', src: `/neutral-${item.id}.png` }))))
  } }))
  cleanups.push(() => wrapper.unmount())
  for (const image of wrapper.findAll('img')) Object.defineProperties(image.element, {
    complete: { value: true }, naturalWidth: { value: 240, configurable: true }, naturalHeight: { value: 100 },
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return rect(this.dataset.cardId ? items.value.findIndex(item => String(item.id) === this.dataset.cardId) * 100 : 0)
  })
  await vi.dynamicImportSettled()
  return { items, loading, motion, wrapper }
}
it('uses at most two decoded visible images with the shared compact renderer', async () => {
  const { items, motion } = await fixture()
  motion.onDeleted([1, 2, 3, 4])
  expect(mocks.dissolve).toHaveBeenCalledTimes(2)
  expect(mocks.dissolve.mock.calls.every(call => call[0] instanceof HTMLImageElement && call[2] === 'thumbnail')).toBe(true)
  expect(items.value).toHaveLength(4)
  items.value = []
  await nextTick()
  expect(releases.every(release => release.mock.calls.length === 0)).toBe(true)
  vi.advanceTimersByTime(800)
  expect(releases.every(release => release.mock.calls.length === 1)).toBe(true)
})
it('ignores offscreen and undecoded thumbnails without loading any original', async () => {
  const { motion, wrapper } = await fixture()
  vi.spyOn(wrapper.get('[data-card-id="1"]').element, 'getBoundingClientRect').mockReturnValue(rect(5000))
  Object.defineProperty(wrapper.get('[data-card-id="2"] img').element, 'naturalWidth', { value: 0 })
  motion.onDeleted([1, 2])
  expect(mocks.dissolve).not.toHaveBeenCalled()
})
it.each(['hidden', 'low', 'scroll', 'resize', 'pointer', 'unmount'] as const)('cancels active effects on %s', async reason => {
  const { motion, wrapper, items } = await fixture()
  motion.onDeleted([1]); items.value = items.value.filter(item => item.id !== 1)
  await nextTick()
  if (reason === 'hidden') activity.canAnimate.value = false
  if (reason === 'low') activity.lowEffects.value = true
  if (reason === 'scroll') window.dispatchEvent(new Event('scroll'))
  if (reason === 'resize') window.dispatchEvent(new Event('resize'))
  if (reason === 'pointer') wrapper.element.dispatchEvent(new Event('pointerdown'))
  if (reason === 'unmount') wrapper.unmount()
  expect(releases[0]).toHaveBeenCalledOnce()
})
it('cleans up old effects on repeated deletion and restoration of the same ID', async () => {
  const { motion, items } = await fixture()
  motion.onDeleted([1]); items.value = items.value.filter(item => item.id !== 1); await nextTick()
  motion.onDeleted([2]); items.value = items.value.filter(item => item.id !== 2); await nextTick()
  expect(releases[0]).toHaveBeenCalledOnce()
  items.value = [{ id: 2 } as ArtworkRecord, ...items.value]; await nextTick()
  expect(releases[1]).toHaveBeenCalledOnce()
})
it('skips reduced-motion allocation and leaves the business records untouched', async () => {
  const { motion, items } = await fixture()
  activity.canAnimate.value = false
  motion.onDeleted([1])
  expect(mocks.dissolve).not.toHaveBeenCalled()
  expect(items.value.map(item => item.id)).toEqual([1, 2, 3, 4])
})
it('waits for reload then animates surviving masonry positions without delaying removal', async () => {
  const { motion, items, loading } = await fixture()
  const animations: Array<{ cancel: ReturnType<typeof vi.fn>; finish: () => void }> = []
  const animate = vi.fn(() => {
    let finish!: () => void
    const animation = { cancel: vi.fn(), finished: new Promise<void>(resolve => { finish = resolve }) }
    animations.push({ ...animation, finish }); return animation
  })
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  motion.onDeleted([1]); loading.value = true
  items.value = items.value.filter(item => item.id !== 1); await nextTick()
  expect(animate).not.toHaveBeenCalled()
  loading.value = false; await nextTick()
  expect(animate).toHaveBeenCalledTimes(3)
  expect(animate.mock.calls[0]).toEqual([[{ transform: 'translate(0px, 100px)' }, { transform: 'translate(0, 0)' }], expect.objectContaining({ duration: 240 })])
  expect(items.value.map(item => item.id)).toEqual([2, 3, 4])
  animations.forEach(animation => animation.finish()); await nextTick()
  expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true)
})
it('does not resurrect pending layout animations after leave', async () => {
  const { motion, items, wrapper } = await fixture()
  const animate = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  motion.onDeleted([1]); items.value = items.value.filter(item => item.id !== 1)
  wrapper.unmount(); await nextTick()
  expect(animate).not.toHaveBeenCalled()
  expect(releases[0]).toHaveBeenCalledOnce()
})

it('rejects late success feedback after an intervening interaction or leave/return', async () => {
  const { motion } = await fixture()
  const oldAction = motion.forAction()
  activity.canAnimate.value = false
  activity.canAnimate.value = true
  oldAction([1])
  expect(mocks.dissolve).not.toHaveBeenCalled()
  const freshAction = motion.forAction()
  freshAction([1])
  expect(mocks.dissolve).toHaveBeenCalledOnce()
})
