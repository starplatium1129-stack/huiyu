import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref, type Ref } from 'vue'
import ThinkingOrb from './ThinkingOrb.vue'
import VoiceGlow from './VoiceGlow.vue'
import CgImageReveal from './CgImageReveal.vue'
import BorderBeam from './BorderBeam.vue'
import { startCanvasParticleReveal } from '@/utils/canvasParticleReveal'

let activity: {
  canPresent: Ref<boolean>; canAnimate: Ref<boolean>; reducedMotion: Ref<boolean>
  lowEffects: Ref<boolean>; appearanceRevision: Ref<number>
}
vi.mock('@/composables/useVisualActivity', () => ({ useVisualActivity: () => activity }))
vi.mock('@vueuse/core', () => ({ useResizeObserver: vi.fn() }))
vi.mock('@/utils/canvasParticleReveal', () => ({ startCanvasParticleReveal: vi.fn() }))

const frames = new Map<number, FrameRequestCallback>()
const cleanups: Array<() => void> = []
let nextFrame = 0
const context = {
  setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillRect: vi.fn(),
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
  type MockReveal = {
    finished: Promise<void>
    stop: ReturnType<typeof vi.fn<() => void>>
    finish: () => void
    reject: () => void
  }
  let animateDescriptor: PropertyDescriptor | undefined
  const reveals: MockReveal[] = []

  beforeEach(() => {
    reveals.length = 0
    vi.mocked(startCanvasParticleReveal).mockImplementation((_image, host) => {
      const layer = document.createElement('div')
      layer.dataset.particleReveal = ''
      host.append(layer)
      let finish!: () => void
      let reject!: (reason: Error) => void
      const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail })
      const reveal: MockReveal = {
        finished,
        // Deferred callbacks remain controllable after stop to reproduce browser races.
        stop: vi.fn(() => layer.remove()),
        finish,
        reject: () => reject(new DOMException('Animation canceled', 'AbortError')),
      }
      reveals.push(reveal)
      return reveal
    })
    animateDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, writable: true, value: vi.fn() })
  })
  afterEach(() => {
    if (animateDescriptor) Object.defineProperty(Element.prototype, 'animate', animateDescriptor)
    else Reflect.deleteProperty(Element.prototype, 'animate')
  })

  it('reveals each loaded image once while keeping pixels stationary and releasing its effect', async () => {
    const wrapper = own(mount(CgImageReveal, { props: { src: '/first.png', autoReveal: true } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    await img.trigger('load')
    expect(wrapper.emitted('reveal-start')).toHaveLength(1)
    expect(wrapper.classes()).toContain('is-revealing')
    expect(startCanvasParticleReveal).toHaveBeenCalledOnce()
    expect(startCanvasParticleReveal).toHaveBeenCalledWith(img.element, wrapper.element, expect.any(Number))
    expect(wrapper.find('[data-particle-reveal]').exists()).toBe(true)
    expect(img.element.animate).not.toHaveBeenCalled()

    reveals[0].finish()
    await Promise.resolve()
    await nextTick()
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    expect(wrapper.classes()).not.toContain('is-revealing')
    expect(wrapper.classes()).toContain('is-loaded')
    expect(wrapper.find('[data-particle-reveal]').exists()).toBe(false)
    expect(reveals.every(reveal => reveal.stop.mock.calls.length === 1)).toBe(true)
    expect(img.element.style.opacity).toBe('')
    expect(img.element.style.transform).toBe('')
    reveals[0].finish()
    await Promise.resolve()
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    expect(frames.size).toBe(0)
  })

  it('keeps history images static until an explicit reveal is requested', async () => {
    const wrapper = own(mount(CgImageReveal, { props: { src: '/seen.png', autoReveal: false } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    expect(wrapper.classes()).toContain('is-loaded')
    expect(wrapper.emitted('reveal-start')).toBeUndefined()
    expect(wrapper.emitted('reveal-complete')).toBeUndefined()
    expect(startCanvasParticleReveal).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
    wrapper.vm.triggerReveal()
    await nextTick()
    expect(startCanvasParticleReveal).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('reveal-start')).toHaveLength(1)
  })

  it('handles a generation signal arriving after a cached image load exactly once', async () => {
    const wrapper = own(mount(CgImageReveal, { props: { src: '/cached.png', autoReveal: false } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    expect(startCanvasParticleReveal).not.toHaveBeenCalled()
    await wrapper.setProps({ autoReveal: true })
    expect(startCanvasParticleReveal).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('reveal-start')).toHaveLength(1)
    await img.trigger('load')
    await wrapper.setProps({ autoReveal: false })
    await wrapper.setProps({ autoReveal: true })
    expect(startCanvasParticleReveal).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('reveal-start')).toHaveLength(1)
  })

  it('cancels the old source and ignores its late load, error, and completion callbacks', async () => {
    const wrapper = own(mount(CgImageReveal, { props: { src: '/old.png', autoReveal: true } }))
    const old = wrapper.get('img')
    readyImage(old.element)
    await old.trigger('load')
    const staleReveals = [...reveals]
    await wrapper.setProps({ src: '/new.png' })
    expect(wrapper.get('img').element).not.toBe(old.element)
    expect(staleReveals.every(reveal => reveal.stop.mock.calls.length === 1)).toBe(true)
    expect(wrapper.classes()).not.toContain('is-loaded')
    await old.trigger('load')
    await old.trigger('error')
    expect(wrapper.emitted('load')).toHaveLength(1)
    expect(wrapper.emitted('error')).toBeUndefined()
    expect(wrapper.emitted('reveal-start')).toHaveLength(1)

    const fresh = wrapper.get('img')
    readyImage(fresh.element)
    await fresh.trigger('load')
    expect(wrapper.emitted('reveal-start')).toHaveLength(2)
    staleReveals.forEach(reveal => reveal.finish())
    await Promise.resolve()
    await nextTick()
    expect(wrapper.classes()).toContain('is-revealing')
    expect(wrapper.emitted('reveal-complete')).toBeUndefined()
    expect(reveals[1].stop).not.toHaveBeenCalled()
    reveals[1].finish()
    await Promise.resolve()
    await nextTick()
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    expect(fresh.attributes('src')).toBe('/new.png')
    expect(frames.size).toBe(0)
  })

  it('replaces an explicit replay and ignores completion of the canceled animation', async () => {
    const wrapper = own(mount(CgImageReveal, { props: { src: '/image.png', autoReveal: false } }))
    readyImage(wrapper.get('img').element)
    wrapper.vm.triggerReveal()
    const previous = [...reveals]
    wrapper.vm.triggerReveal()
    await nextTick()
    expect(startCanvasParticleReveal).toHaveBeenCalledTimes(2)
    expect(previous.every(reveal => reveal.stop.mock.calls.length === 1)).toBe(true)
    expect(wrapper.emitted('reveal-start')).toHaveLength(2)
    previous.forEach(reveal => reveal.finish())
    await Promise.resolve()
    await nextTick()
    expect(wrapper.classes()).toContain('is-revealing')
    expect(wrapper.emitted('reveal-complete')).toBeUndefined()
    reveals[1].finish()
    await Promise.resolve()
    await nextTick()
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    expect(reveals.every(reveal => reveal.stop.mock.calls.length === 1)).toBe(true)
    expect(frames.size).toBe(0)
  })

  it.each(['reduced motion', 'low effects', 'hidden activity'])('shows the original immediately under %s', async mode => {
    if (mode === 'reduced motion') {
      activity.reducedMotion.value = true
      activity.canAnimate.value = false
    } else if (mode === 'low effects') activity.lowEffects.value = true
    else { activity.canPresent.value = false; activity.canAnimate.value = false }
    const wrapper = own(mount(CgImageReveal, { props: { src: '/image.png', autoReveal: true } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    expect(wrapper.classes()).toContain('is-loaded')
    expect(wrapper.classes()).not.toContain('is-revealing')
    expect(startCanvasParticleReveal).not.toHaveBeenCalled()
    expect(wrapper.emitted('reveal-start')).toBeUndefined()
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    await img.trigger('load')
    await wrapper.setProps({ autoReveal: false })
    await wrapper.setProps({ autoReveal: true })
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    expect(frames.size).toBe(0)
  })

  it.each(['reduced motion', 'low effects', 'hidden activity'])('cancels an in-progress reveal under %s without replaying on return', async mode => {
    const wrapper = own(mount(CgImageReveal, { props: { src: '/image.png', autoReveal: true } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    if (mode === 'reduced motion') {
      activity.reducedMotion.value = true
      activity.canAnimate.value = false
    } else if (mode === 'low effects') activity.lowEffects.value = true
    else { activity.canPresent.value = false; activity.canAnimate.value = false }
    await nextTick()
    expect(reveals.every(reveal => reveal.stop.mock.calls.length === 1)).toBe(true)
    expect(wrapper.classes()).toContain('is-loaded')
    expect(wrapper.classes()).not.toContain('is-revealing')
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    activity.reducedMotion.value = false
    activity.lowEffects.value = false
    activity.canPresent.value = true
    activity.canAnimate.value = true
    await nextTick()
    await img.trigger('load')
    reveals.forEach(reveal => reveal.reject())
    await Promise.resolve()
    await nextTick()
    expect(startCanvasParticleReveal).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    expect(frames.size).toBe(0)
  })

  it('shows the original when the animation API is unavailable', async () => {
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: undefined })
    const wrapper = own(mount(CgImageReveal, { props: { src: 'https://images.example/cg.png', autoReveal: true } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    expect(wrapper.classes()).toContain('is-loaded')
    expect(wrapper.classes()).not.toContain('is-revealing')
    expect(wrapper.emitted('reveal-start')).toBeUndefined()
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    expect(context.getImageData).not.toHaveBeenCalled()
    expect(img.attributes('src')).toBe('https://images.example/cg.png')
    expect(frames.size).toBe(0)
  })

  it('shows the original when particle reveal preparation throws', async () => {
    vi.mocked(startCanvasParticleReveal).mockImplementationOnce(() => { throw new Error('Particle reveal is unavailable') })
    const wrapper = own(mount(CgImageReveal, { props: { src: '/image.png', autoReveal: true } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    await Promise.resolve()
    await nextTick()
    expect(startCanvasParticleReveal).toHaveBeenCalledOnce()
    expect(wrapper.classes()).toContain('is-loaded')
    expect(wrapper.classes()).not.toContain('is-revealing')
    expect(wrapper.emitted('reveal-start')).toBeUndefined()
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    expect(wrapper.find('[data-particle-reveal]').exists()).toBe(false)
    expect(img.element.style.opacity).toBe('')
    expect(img.element.style.transform).toBe('')
    expect(frames.size).toBe(0)
  })

  it('keeps the original clear when canvas sampling cannot provide a layer', async () => {
    vi.mocked(startCanvasParticleReveal).mockReturnValue(null)
    const wrapper = own(mount(CgImageReveal, { props: { src: '/image.png' } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    expect(startCanvasParticleReveal).toHaveBeenCalledOnce()
    expect(wrapper.emitted('reveal-complete')).toHaveLength(1)
    expect(img.element.style.opacity).toBe('')
    expect(wrapper.find('[data-particle-reveal]').exists()).toBe(false)
  })

  it('stops the reveal when the current image fails', async () => {
    const wrapper = own(mount(CgImageReveal, { props: { src: '/image.png', autoReveal: true } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    await img.trigger('error')
    expect(reveals.every(reveal => reveal.stop.mock.calls.length === 1)).toBe(true)
    expect(wrapper.emitted('error')).toHaveLength(1)
    expect(wrapper.classes()).toContain('is-loaded')
    expect(wrapper.classes()).not.toContain('is-revealing')
    reveals.forEach(reveal => reveal.finish())
    await Promise.resolve()
    expect(wrapper.emitted('reveal-complete')).toBeUndefined()
  })

  it('releases the reveal on unmount without emitting a late completion', async () => {
    const wrapper = own(mount(CgImageReveal, { props: { src: '/image.png', autoReveal: true } }))
    const img = wrapper.get('img')
    readyImage(img.element)
    await img.trigger('load')
    wrapper.unmount()
    expect(reveals.every(reveal => reveal.stop.mock.calls.length === 1)).toBe(true)
    reveals.forEach(reveal => reveal.finish())
    await Promise.resolve()
    expect(wrapper.emitted('reveal-complete')).toBeUndefined()
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
