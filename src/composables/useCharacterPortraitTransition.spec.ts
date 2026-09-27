import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { useCharacterPortraitTransition } from './useCharacterPortraitTransition'

const state = vi.hoisted(() => ({ reduced: false, fades: vi.fn() }))
vi.mock('@/utils/motionPreference', () => ({ prefersReducedMotion: () => state.reduced }))
vi.mock('./useFluidSurface', () => ({ useFluidSurface: () => ({ enter: (el: Element, done: () => void) => { state.fades(el); done() }, dispose: vi.fn() }) }))
let wrapper: VueWrapper | undefined
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
const animations: Array<{ element: Element; frames: Keyframe[]; animation: { cancel: ReturnType<typeof vi.fn>; onfinish: null | (() => void); oncancel: null | (() => void) } }> = []

beforeEach(() => {
  state.reduced = false; state.fades.mockClear(); animations.length = 0
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: function (this: Element, frames: Keyframe[]) {
    const animation = { cancel: vi.fn(), onfinish: null, oncancel: null }
    animations.push({ element: this, frames: frames as Keyframe[], animation })
    return animation as unknown as Animation
  } })
})
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks()
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(Element.prototype, 'animate')
})

async function setup(targetReady = true) {
  const shelf = ref(true), root = ref<HTMLElement | null>(null)
  let motion!: ReturnType<typeof useCharacterPortraitTransition>
  const image = (detail: boolean) => h('img', {
    src: '/portrait.jpg', class: detail ? 'portrait-image' : '',
    ref: (element: unknown) => {
      if (!(element instanceof HTMLImageElement)) return
      Object.defineProperties(element, { complete: { value: !detail || targetReady, configurable: true }, naturalWidth: { value: 100, configurable: true }, naturalHeight: { value: 140, configurable: true } })
      element.getBoundingClientRect = () => new DOMRect(detail ? 300 : 10, 100, detail ? 300 : 100, detail ? 420 : 140)
    },
  })
  wrapper = mount(defineComponent({
    setup() {
      motion = useCharacterPortraitTransition(root, shelf, () => 'nene')
      return () => h('article', { ref: root }, shelf.value
        ? h('section', { class: 'character-bookshelf' }, h('button', { class: 'bookshelf-character', 'data-character': 'nene' }, image(false)))
        : h('div', { class: 'library-layout' }, image(true)))
    },
  }), { attachTo: document.body })
  await flushPromises()
  return { shelf, motion }
}

it('connects a loaded card to the real original and releases both layers on completion', async () => {
  const { shelf, motion } = await setup()
  shelf.value = false; await flushPromises()
  expect(motion.preferOriginal.value).toBe(true)
  expect(document.querySelectorAll('[data-archive-portrait-flight]')).toHaveLength(1)
  expect(animations[0].frames[0].transform).toBe('translate(10px, 100px) scale(1, 1)')
  expect(animations[0].frames[1].transform).toBe('translate(300px, 100px) scale(3, 3)')
  expect(animations[1].element.className).toBe('portrait-image')
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

it('keeps both scale axes equal when a cropped card meets the original aspect ratio', async () => {
  const { shelf } = await setup()
  const source = wrapper!.get('img').element as HTMLImageElement
  source.getBoundingClientRect = () => new DOMRect(10, 100, 100, 120)
  shelf.value = false; await flushPromises()
  expect(animations[0].frames[1].transform).toBe('translate(300px, 130px) scale(3, 3)')
})

it('uses the cover clipping frame so a returning portrait cannot cover the card caption', async () => {
  const { shelf } = await setup()
  const source = wrapper!.get('img').element as HTMLImageElement
  const frame = document.createElement('span')
  frame.className = 'character-portrait'
  frame.getBoundingClientRect = () => new DOMRect(10, 100, 100, 120)
  source.replaceWith(frame); frame.append(source)
  shelf.value = false; await flushPromises()
  const clone = document.querySelector<HTMLImageElement>('[data-archive-portrait-flight]')!
  expect(clone.style.height).toBe('120px')
  expect(clone.style.objectPosition).toBe('center top')
  expect(animations[0].frames[1].transform).toBe('translate(300px, 130px) scale(3, 3)')
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
  const floating = document.querySelector<HTMLImageElement>('[data-archive-portrait-flight]')!
  Object.defineProperties(floating, { complete: { value: true }, naturalWidth: { value: 100 }, naturalHeight: { value: 140 } })
  floating.getBoundingClientRect = () => new DOMRect(160, 120, 180, 252)
  shelf.value = true; await flushPromises()
  expect(first.cancel).toHaveBeenCalledOnce()
  expect(document.querySelectorAll('[data-archive-portrait-flight]')).toHaveLength(1)
  expect(animations[2].frames[0].transform).toBe('translate(160px, 120px) scale(1, 1)')
  wrapper!.unmount(); wrapper = undefined
  expect(document.querySelector('[data-archive-portrait-flight]')).toBeNull()
})

it('reduced motion skips the connection and a preference change clears an active connection', async () => {
  const { shelf } = await setup()
  state.reduced = true
  shelf.value = false; await flushPromises()
  expect(animations).toHaveLength(0)
  shelf.value = true; await flushPromises()
  state.reduced = false
  shelf.value = false; await flushPromises()
  expect(document.querySelector('[data-archive-portrait-flight]')).not.toBeNull()
  state.reduced = true; window.dispatchEvent(new Event('atelier:motion-preference'))
  expect(document.querySelector('[data-archive-portrait-flight]')).toBeNull()
})
