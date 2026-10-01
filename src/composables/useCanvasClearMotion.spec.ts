import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useCanvasClearMotion } from './useCanvasClearMotion'

const activity = { canAnimate: ref(true), lowEffects: ref(false) }
vi.mock('./useVisualActivity', () => ({ useVisualActivity: () => activity }))
const mock = vi.hoisted(() => ({ dissolve: vi.fn(), release: vi.fn() }))
vi.mock('@/utils/canvasDissolve', () => ({ startCanvasDissolve: mock.dissolve }))
const cleanups: Array<() => void> = []
const rect = { x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, toJSON() {} }
beforeEach(() => {
  activity.canAnimate.value = true; activity.lowEffects.value = false
  mock.dissolve.mockReset(); mock.release.mockReset()
  mock.dissolve.mockReturnValue(mock.release)
})
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); delete (HTMLCanvasElement.prototype as { animate?: unknown }).animate })
async function fixture() {
  const source = ref('/neutral.png'), busy = ref(false), comparing = ref(false)
  let motion!: ReturnType<typeof useCanvasClearMotion>
  const wrapper = mount(defineComponent({ setup() {
    const root = ref<HTMLElement | null>(null)
    motion = useCanvasClearMotion(root, () => source.value, () => busy.value, () => comparing.value)
    return () => h('div', { ref: root }, h('img', { class: 'cg-image-target', src: source.value }))
  } }))
  cleanups.push(() => wrapper.unmount())
  const image = wrapper.get('img').element
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 600 } })
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(rect)
  vi.spyOn(wrapper.element, 'getBoundingClientRect').mockReturnValue(rect)
  await vi.dynamicImportSettled()
  return { source, busy, comparing, motion, wrapper, image }
}
it('captures synchronously while the old decoded image exists, without changing business state', async () => {
  const { source, motion, image, wrapper } = await fixture()
  motion.playClear()
  expect(mock.dissolve).toHaveBeenCalledExactlyOnceWith(image, wrapper.element)
  expect(source.value).toBe('/neutral.png')
  source.value = ''
  expect(mock.release).not.toHaveBeenCalled()
})
it('replaces rapid clear effects and cancels them when a new result arrives', async () => {
  const { source, motion } = await fixture()
  motion.playClear(); motion.playClear()
  expect(mock.release).toHaveBeenCalledTimes(1)
  source.value = ''
  source.value = '/next.png'
  expect(mock.release).toHaveBeenCalledTimes(2)
})
it.each(['busy', 'comparing', 'hidden', 'low', 'resize', 'unmount'] as const)('stops on %s without waiting for an animation callback', async change => {
  const { motion, busy, comparing, wrapper } = await fixture()
  motion.playClear()
  if (change === 'busy') busy.value = true
  if (change === 'comparing') comparing.value = true
  if (change === 'hidden') activity.canAnimate.value = false
  if (change === 'low') activity.lowEffects.value = true
  if (change === 'resize') window.dispatchEvent(new Event('resize'))
  if (change === 'unmount') wrapper.unmount()
  expect(mock.release).toHaveBeenCalledOnce()
})
it('does not allocate effects when reduced/hidden or busy, and ignores an empty result', async () => {
  const { motion, source, busy } = await fixture()
  activity.canAnimate.value = false; motion.playClear()
  activity.canAnimate.value = true; busy.value = true; motion.playClear()
  busy.value = false; source.value = ''; motion.playClear()
  expect(mock.dissolve).not.toHaveBeenCalled()
})
it('falls back to bounded snapshot fading when pixel sampling is unavailable and releases it', async () => {
  const { motion, wrapper } = await fixture()
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ opacity: '0.4' } as CSSStyleDeclaration)
  mock.dissolve.mockReturnValue(null)
  const drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
  let finish!: () => void
  const cancel = vi.fn()
  const animate = vi.fn(() => ({ cancel, finished: new Promise<void>(resolve => { finish = resolve }) }))
  Object.defineProperty(HTMLCanvasElement.prototype, 'animate', { configurable: true, value: animate })
  motion.playClear()
  const canvas = wrapper.get('canvas').element
  expect(canvas.getAttribute('aria-hidden')).toBe('true')
  expect(canvas.style.pointerEvents).toBe('none')
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(600_000)
  expect(drawImage).toHaveBeenCalledOnce()
  expect(animate).toHaveBeenCalledWith([{ opacity: 0.4 }, { opacity: 0 }], expect.any(Object))
  finish(); await nextTick()
  expect(wrapper.find('canvas').exists()).toBe(false)
  expect(canvas.width).toBe(0)
  expect(cancel).toHaveBeenCalledOnce()
})
it('does not throw when even the decorative snapshot is unavailable', async () => {
  const { motion } = await fixture()
  mock.dissolve.mockImplementation(() => { throw new Error('unavailable canvas') })
  expect(() => motion.playClear()).not.toThrow()
})
