import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref, type Ref } from 'vue'
import ThinkingOrb from './ThinkingOrb.vue'
import VoiceGlow from './VoiceGlow.vue'
import CgImageReveal from './CgImageReveal.vue'
import BorderBeam from './BorderBeam.vue'

let activity: {
  canPresent: Ref<boolean>; canAnimate: Ref<boolean>; reducedMotion: Ref<boolean>
  lowEffects: Ref<boolean>; appearanceRevision: Ref<number>
}
vi.mock('@/composables/useVisualActivity', () => ({ useVisualActivity: () => activity }))
vi.mock('@vueuse/core', () => ({ useResizeObserver: vi.fn() }))

const frames = new Map<number, FrameRequestCallback>()
const cleanups: Array<() => void> = []
let nextFrame = 0
const context = {
  clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillRect: vi.fn(),
  moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), stroke: vi.fn(), save: vi.fn(), restore: vi.fn(),
  drawImage: vi.fn(), getImageData: vi.fn(), createLinearGradient: vi.fn(),
  globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
}
function own<T extends { unmount(): void }>(wrapper: T): T {
  cleanups.push(() => wrapper.unmount())
  return wrapper
}
function tick(time: number) {
  const pending = [...frames.entries()]
  frames.clear()
  for (const [, callback] of pending) callback(time)
}
function readyImage(img: HTMLImageElement, width = 320, height = 240) {
  Object.defineProperties(img, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  })
  vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, bottom: height, right: width, width, height, toJSON() {},
  })
}

beforeEach(() => {
  activity = { canPresent: ref(true), canAnimate: ref(true), reducedMotion: ref(false), lowEffects: ref(false), appearanceRevision: ref(0) }
  frames.clear()
  nextFrame = 0
  vi.clearAllMocks()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.spyOn(performance, 'now').mockReturnValue(0)
  context.createLinearGradient.mockImplementation(() => ({ addColorStop: vi.fn() }))
  context.getImageData.mockImplementation((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(120) }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as unknown as CanvasRenderingContext2D)
})
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  frames.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ThinkingOrb rendering lifecycle', () => {
  it('paints a representative frame when initially paused without scheduling a loop', async () => {
    own(mount(ThinkingOrb, { props: { paused: true } }))
    await nextTick()
    expect(context.arc).toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })
  it('freezes an existing bitmap instead of clearing it, then resumes only one loop', async () => {
    const wrapper = own(mount(ThinkingOrb))
    await nextTick()
    tick(16)
    const canvas = wrapper.get('canvas').element
    const widthSetter = vi.spyOn(canvas, 'width', 'set')
    context.clearRect.mockClear()
    await wrapper.setProps({ paused: true })
    expect(frames.size).toBe(0)
    expect(widthSetter).not.toHaveBeenCalled()
    expect(context.clearRect).not.toHaveBeenCalled()
    await wrapper.setProps({ paused: false })
    expect(frames.size).toBe(1)
    tick(32)
    expect(frames.size).toBe(1)
    expect(context.arc).toHaveBeenCalled()
  })
  it('stops while not present and releases the pending frame on unmount', async () => {
    const wrapper = own(mount(ThinkingOrb))
    await nextTick()
    activity.canPresent.value = false
    activity.canAnimate.value = false
    await nextTick()
    expect(frames.size).toBe(0)
    activity.canPresent.value = true
    activity.canAnimate.value = true
    await nextTick()
    expect(frames.size).toBe(1)
    wrapper.unmount()
    expect(frames.size).toBe(0)
  })
  it('redraws static states without recurring frames when reduced motion is enabled', async () => {
    const wrapper = own(mount(ThinkingOrb))
    activity.reducedMotion.value = true
    activity.canAnimate.value = false
    await nextTick()
    expect(frames.size).toBe(0)
    context.arc.mockClear()
    await wrapper.setProps({ state: 'searching' })
    expect(context.arc).toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })
})

describe('VoiceGlow rendering lifecycle', () => {
  it('removes active presentation and cancels frames when deactivated', async () => {
    const wrapper = own(mount(VoiceGlow, { props: { level: 0.8 } }))
    await nextTick()
    tick(16)
    expect(context.fill).toHaveBeenCalled()
    await wrapper.setProps({ active: false })
    expect(frames.size).toBe(0)
    expect(wrapper.classes()).not.toContain('is-active')
    await wrapper.setProps({ active: true })
    expect(frames.size).toBe(1)
  })
  it('renders changing levels and processing as static frames in reduce mode', async () => {
    activity.reducedMotion.value = true
    activity.canAnimate.value = false
    const wrapper = own(mount(VoiceGlow, { props: { idleStrength: 0, level: 0 } }))
    await nextTick()
    context.fill.mockClear()
    await wrapper.setProps({ processing: true })
    expect(context.fill).toHaveBeenCalled()
    expect(frames.size).toBe(0)
    context.fill.mockClear()
    await wrapper.setProps({ processing: false, level: 0.8 })
    expect(context.fill).toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })
  it('does not keep an idle zero-strength frame loop alive', async () => {
    own(mount(VoiceGlow, { props: { idleStrength: 0, level: 0 } }))
    await nextTick()
    tick(16)
    expect(frames.size).toBe(0)
  })
})

describe('CgImageReveal ownership and fallback', () => {
  it('starts once per loaded image and completes without a leftover frame', async () => {
    const wrapper = own(mount(CgImageReveal, { props: { src: '/first.png' } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    await img.trigger('load')
    expect(wrapper.emitted('reveal-start')).toHaveLength(1)
    expect(frames.size).toBe(1)
    tick(2000)
    await nextTick()
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    expect(wrapper.classes()).not.toContain('is-revealing')
    expect(wrapper.classes()).toContain('is-loaded')
    expect(frames.size).toBe(0)
  })
  it('does not revive the old image when src changes or a late load arrives', async () => {
    const wrapper = own(mount(CgImageReveal, { props: { src: '/old.png' } }))
    const old = wrapper.get('img')
    readyImage(old.element)
    await old.trigger('load')
    expect(frames.size).toBe(1)
    await wrapper.setProps({ src: '/new.png' })
    expect(wrapper.get('img').element).not.toBe(old.element)
    expect(frames.size).toBe(0)
    await old.trigger('load')
    expect(wrapper.emitted('reveal-start')).toHaveLength(1)
    const fresh = wrapper.get('img')
    readyImage(fresh.element)
    await fresh.trigger('load')
    expect(wrapper.emitted('reveal-start')).toHaveLength(2)
    expect(frames.size).toBe(1)
  })
  it('falls back to the original when cross-origin pixel sampling throws', async () => {
    context.getImageData.mockImplementation(() => { throw new DOMException('tainted canvas', 'SecurityError') })
    const wrapper = own(mount(CgImageReveal, { props: { src: 'https://images.example/cg.png' } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    expect(wrapper.classes()).toContain('is-loaded')
    expect(wrapper.classes()).not.toContain('is-revealing')
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    expect(frames.size).toBe(0)
    expect(img.attributes('src')).toBe('https://images.example/cg.png')
  })
  it('replaces an explicit replay rather than adding a second frame loop', async () => {
    const wrapper = own(mount(CgImageReveal, { props: { src: '/image.png', autoReveal: false } }))
    readyImage(wrapper.get('img').element)
    wrapper.vm.triggerReveal()
    wrapper.vm.triggerReveal()
    expect(frames.size).toBe(1)
    activity.canAnimate.value = false
    await nextTick()
    expect(frames.size).toBe(0)
    expect(wrapper.classes()).not.toContain('is-revealing')
  })
  it('does not allocate a reveal canvas when automatic playback is disabled', async () => {
    const wrapper = own(mount(CgImageReveal, { props: { src: '/seen.png', autoReveal: false } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    expect(context.drawImage).not.toHaveBeenCalled()
    expect(wrapper.classes()).toContain('is-loaded')
    expect(frames.size).toBe(0)
  })
})

describe('BorderBeam activity', () => {
  it('removes animation promotion when hidden and removes bloom for low effects', async () => {
    const wrapper = own(mount(BorderBeam))
    await nextTick()
    expect(wrapper.classes()).toContain('is-running')
    activity.canAnimate.value = false
    await nextTick()
    expect(wrapper.classes()).not.toContain('is-running')
    activity.lowEffects.value = true
    await nextTick()
    expect(wrapper.find('.border-beam-bloom').exists()).toBe(false)
    expect(wrapper.find('.border-beam-track').exists()).toBe(true)
  })
})
