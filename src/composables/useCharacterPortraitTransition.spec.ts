import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { useCharacterPortraitTransition } from './useCharacterPortraitTransition'

const state = vi.hoisted(() => ({ reduced: false, fades: vi.fn(), failAt: -1 }))
vi.mock('@/utils/motionPreference', () => ({ prefersReducedMotion: () => state.reduced }))
vi.mock('./useFluidSurface', () => ({ useFluidSurface: () => ({ enter: (el: Element, done: () => void) => { state.fades(el); done() }, dispose: vi.fn() }) }))
let wrapper: VueWrapper | undefined
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
const animations: Array<{ element: Element; frames: Keyframe[]; options: KeyframeAnimationOptions; animation: { cancel: ReturnType<typeof vi.fn>; onfinish: null | (() => void); oncancel: null | (() => void) } }> = []

beforeEach(() => {
  state.reduced = false; state.failAt = -1; state.fades.mockClear(); animations.length = 0
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: function (this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
    if (animations.length === state.failAt) throw new Error('animation unavailable')
    const animation = { cancel: vi.fn(), onfinish: null, oncancel: null }
    animations.push({ element: this, frames: frames as Keyframe[], options, animation })
    return animation as unknown as Animation
  } })
})
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks()
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(Element.prototype, 'animate')
})

async function setup(targetReady = true) {
  const shelf = ref(true), character = ref('nene'), root = ref<HTMLElement | null>(null)
  let motion!: ReturnType<typeof useCharacterPortraitTransition>
  const image = (detail: boolean) => h('img', {
    src: '/portrait.jpg', class: detail ? 'portrait-image' : '', style: { objectFit: detail ? 'contain' : 'cover', objectPosition: 'center 20%' },
    ref: (element: unknown) => {
      if (!(element instanceof HTMLImageElement)) return
      Object.defineProperties(element, { complete: { value: !detail || targetReady, configurable: true }, naturalWidth: { value: 100, configurable: true }, naturalHeight: { value: 140, configurable: true } })
      element.getBoundingClientRect = () => new DOMRect(detail ? 300 : 10, 100, detail ? 300 : 100, detail ? 420 : 140)
    },
  })
  wrapper = mount(defineComponent({
    setup() {
      motion = useCharacterPortraitTransition(root, shelf, () => character.value)
      return () => h('article', { ref: root }, shelf.value
        ? h('section', { class: 'character-bookshelf' }, h('button', { class: 'bookshelf-character', 'data-character': 'nene' }, image(false)))
        : h('div', { class: 'library-layout' }, h('div', { class: 'library-detail' }, image(true))))
    },
  }), { attachTo: document.body })
  await flushPromises()
  return { shelf, motion, character }
}

it('connects a loaded card to the real original and releases both layers on completion', async () => {
  const { shelf, motion } = await setup()
  shelf.value = false; await flushPromises()
  expect(motion.preferOriginal.value).toBe(true)
  expect(document.querySelectorAll('[data-archive-portrait-flight]')).toHaveLength(1)
  expect(animations[0].frames[0].transform).toBe('translate(10px, 100px) scale(1, 1)')
  expect(animations[0].frames.at(-1)!.transform).toBe('translate(300px, 100px) scale(3, 3)')
  expect(animations).toHaveLength(2)
  expect(animations[0].frames.every(frame => frame.opacity === 1)).toBe(true)
  expect(wrapper!.get('.portrait-image').attributes('style')).toContain('opacity: 0')
  expect(animations[0].options.duration).toBeLessThan(300)
  animations[0].animation.onfinish!()
  expect(document.querySelector('[data-archive-portrait-flight]')).toBeNull()
  expect(wrapper!.get('.portrait-image').attributes('style') || '').not.toContain('opacity: 0')
  expect(animations.every(call => call.animation.cancel.mock.calls.length === 1)).toBe(true)
})

it('falls back without a flying placeholder when the destination has not loaded', async () => {
  const { shelf } = await setup(false)
  shelf.value = false; await flushPromises()
  expect(animations).toHaveLength(0)
  expect(document.querySelector('[data-archive-portrait-flight]')).toBeNull()
  expect(state.fades).toHaveBeenCalledOnce()
})

it('preserves the painted image ratio at every sampled crop frame and lands on the full original', async () => {
  const { shelf } = await setup()
  const source = wrapper!.get('img').element as HTMLImageElement
  source.getBoundingClientRect = () => new DOMRect(10, 100, 100, 120)
  shelf.value = false; await flushPromises()
  expect(animations[0].frames.at(-1)!.transform).toBe('translate(300px, 100px) scale(3, 3.5)')
  const axes = (frame: Keyframe) => String(frame.transform).match(/scale\(([^,]+), ([^)]+)\)/)!.slice(1).map(Number)
  animations[0].frames.forEach((frame, index) => {
    const outer = axes(frame), inner = axes(animations[1].frames[index])
    expect(outer[0] * inner[0]).toBeCloseTo(outer[1] * inner[1], 6)
  })
})

it('uses the cover clipping frame so a returning portrait cannot cover the card caption', async () => {
  const { shelf } = await setup()
  const source = wrapper!.get('img').element as HTMLImageElement
  const frame = document.createElement('span')
  frame.className = 'character-portrait'
  frame.getBoundingClientRect = () => new DOMRect(10, 100, 100, 120)
  source.replaceWith(frame); frame.append(source)
  shelf.value = false; await flushPromises()
  const clone = document.querySelector<HTMLElement>('[data-archive-portrait-flight]')!
  expect(clone.style.height).toBe('120px')
  expect(clone.querySelector('img')!.style.height).toBe('140px')
  expect(animations[0].frames.at(-1)!.transform).toBe('translate(300px, 100px) scale(3, 3.5)')
})

it('does not clone a blurred source or an enlarged image inside its clipped card', async () => {
  const { shelf, motion } = await setup()
  wrapper!.get('button').element.style.filter = 'blur(12px)'
  shelf.value = false; await flushPromises()
  expect(motion.preferOriginal.value).toBe(false)
  expect(animations).toHaveLength(0)
  shelf.value = true; await flushPromises()
  const count = animations.length
  wrapper!.get('img').element.style.transform = 'scale(1.2)'
  shelf.value = false; await flushPromises()
  expect(motion.preferOriginal.value).toBe(false)
  expect(animations).toHaveLength(count)
})

it('a quick return cancels the outgoing connection and never retains two clones', async () => {
  const { shelf } = await setup()
  shelf.value = false; await flushPromises()
  const first = animations[0].animation
  const floating = document.querySelector<HTMLElement>('[data-archive-portrait-flight]')!
  const image = floating.querySelector('img')!
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 100 }, naturalHeight: { value: 140 } })
  floating.getBoundingClientRect = () => new DOMRect(160, 120, 180, 200)
  image.getBoundingClientRect = () => new DOMRect(160, 110, 180, 252)
  shelf.value = true; await flushPromises()
  expect(first.cancel).toHaveBeenCalledOnce()
  expect(document.querySelectorAll('[data-archive-portrait-flight]')).toHaveLength(1)
  expect(animations[2].frames[0].transform).toBe('translate(160px, 120px) scale(1, 1)')
  expect(animations[3].frames[0].transform).toBe('translate(0px, -10px) scale(1, 1)')
  wrapper!.unmount(); wrapper = undefined
  expect(document.querySelector('[data-archive-portrait-flight]')).toBeNull()
})

it.each(['reduced motion', 'hidden document'])('%s skips the connection and cancels an active connection', async mode => {
  const { shelf, motion } = await setup()
  const hidden = mode === 'hidden document' ? vi.spyOn(document, 'hidden', 'get') : null
  const inactive = (value: boolean) => { if (hidden) hidden.mockReturnValue(value); else state.reduced = value }
  inactive(true)
  shelf.value = false; await flushPromises()
  expect(animations).toHaveLength(0)
  expect(document.querySelector('[data-archive-portrait-flight]')).toBeNull()
  expect(motion.preferOriginal.value).toBe(true)
  shelf.value = true; await flushPromises()
  inactive(false)
  shelf.value = false; await flushPromises()
  expect(document.querySelector('[data-archive-portrait-flight]')).not.toBeNull()
  inactive(true)
  if (hidden) document.dispatchEvent(new Event('visibilitychange'))
  else window.dispatchEvent(new Event('atelier:motion-preference'))
  expect(document.querySelector('[data-archive-portrait-flight]')).toBeNull()
  expect(animations.every(call => call.animation.cancel.mock.calls.length === 1)).toBe(true)
  expect(wrapper!.get('.portrait-image').attributes('style') || '').not.toContain('opacity: 0')
})

it('keyboard entry fades the profile while opening the same original image without a flight', async () => {
  const { shelf, motion } = await setup()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  shelf.value = false; await flushPromises()
  const done = vi.fn()
  motion.enter(wrapper!.get('.library-layout').element, done)
  expect(done).toHaveBeenCalledOnce()
  expect(motion.preferOriginal.value).toBe(true)
  expect(animations).toHaveLength(0)
  expect(state.fades).toHaveBeenCalledWith(wrapper!.get('.library-layout').element)
})

it('a different character releases the active connection instead of showing the old portrait', async () => {
  const { shelf, character } = await setup()
  shelf.value = false; await flushPromises()
  character.value = 'natsume'; await flushPromises()
  expect(document.querySelector('[data-archive-portrait-flight]')).toBeNull()
  expect(animations.every(call => call.animation.cancel.mock.calls.length === 1)).toBe(true)
  expect(wrapper!.get('.portrait-image').attributes('style') || '').not.toContain('opacity: 0')
  expect(state.fades).toHaveBeenLastCalledWith(wrapper!.get('.library-detail').element)
})

it('a partial animation failure releases started timelines and restores the real image', async () => {
  const { shelf } = await setup()
  state.failAt = 1
  shelf.value = false; await flushPromises()
  expect(animations).toHaveLength(1)
  expect(animations[0].animation.cancel).toHaveBeenCalledOnce()
  expect(document.querySelector('[data-archive-portrait-flight]')).toBeNull()
  expect(wrapper!.get('.portrait-image').attributes('style') || '').not.toContain('opacity: 0')
})
