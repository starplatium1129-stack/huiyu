import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { useVisualActivity } from './useVisualActivity'

const observers: Array<{ callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }> = []
let api: ReturnType<typeof useVisualActivity>
let visibility: DocumentVisibilityState = 'visible'
const cleanup: Array<() => void> = []
const Fixture = defineComponent({
  setup() {
    const target = ref<HTMLElement | null>(null)
    api = useVisualActivity(target)
    return () => h('div', { ref: target })
  },
})
beforeEach(() => {
  visibility = 'visible'
  document.documentElement.dataset.motion = 'full'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.stubGlobal('IntersectionObserver', class {
    disconnect = vi.fn()
    observe = vi.fn()
    unobserve = vi.fn()
    takeRecords = () => []
    root = null
    rootMargin = '0px'
    thresholds = [0]
    constructor(callback: IntersectionObserverCallback) { observers.push({ callback, disconnect: this.disconnect }) }
  })
})
afterEach(() => {
  cleanup.splice(0).forEach(fn => fn())
  observers.length = 0
  delete document.documentElement.dataset.motion
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mountedFixture() {
  const host = document.createElement('section')
  document.body.appendChild(host)
  const wrapper = mount(Fixture, { attachTo: host })
  cleanup.push(() => { wrapper.unmount(); host.remove() })
  return { host, wrapper }
}

describe('visual activity policy', () => {
  it('follows application motion mode changes without remounting', async () => {
    mountedFixture()
    await nextTick()
    expect(api.canAnimate.value).toBe(true)
    document.documentElement.dataset.motion = 'reduce'
    await vi.waitFor(() => expect(api.reducedMotion.value).toBe(true))
    expect(api.canAnimate.value).toBe(false)
    document.documentElement.dataset.motion = 'full'
    await vi.waitFor(() => expect(api.canAnimate.value).toBe(true))
  })
  it('honors ancestor battery and low-glass modes', async () => {
    const { host } = mountedFixture()
    await nextTick()
    host.dataset.powerMode = 'efficiency'
    await vi.waitFor(() => expect(api.canAnimate.value).toBe(false))
    delete host.dataset.powerMode
    host.dataset.fluidEffects = 'low'
    await vi.waitFor(() => {
      expect(api.canAnimate.value).toBe(true)
      expect(api.lowEffects.value).toBe(true)
    })
  })
  it('stops presentation while the tab is hidden and resumes when visible', async () => {
    mountedFixture()
    await nextTick()
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await nextTick()
    expect(api.canPresent.value).toBe(false)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await nextTick()
    expect(api.canPresent.value).toBe(true)
  })
  it('gates offscreen effects and disconnects observers on unmount', async () => {
    const { wrapper } = mountedFixture()
    await nextTick()
    await nextTick()
    expect(observers.length).toBeGreaterThan(0)
    const observer = observers[observers.length - 1]
    observer.callback([{ target: wrapper.element, isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver)
    await nextTick()
    expect(api.canPresent.value).toBe(false)
    observer.callback([{ target: wrapper.element, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    await nextTick()
    expect(api.canPresent.value).toBe(true)
    wrapper.unmount()
    expect(api.canPresent.value).toBe(false)
    expect(observer.disconnect).toHaveBeenCalled()
  })
  it('suspends cached routes without requiring an unmount', async () => {
    const show = ref(true)
    const wrapper = mount(defineComponent({
      setup: () => () => h(KeepAlive, null, { default: () => show.value ? h(Fixture) : h('div') }),
    }), { attachTo: document.body })
    cleanup.push(() => wrapper.unmount())
    await nextTick()
    expect(api.canPresent.value).toBe(true)
    show.value = false
    await nextTick()
    expect(api.canPresent.value).toBe(false)
    show.value = true
    await nextTick()
    expect(api.canPresent.value).toBe(true)
  })
})
