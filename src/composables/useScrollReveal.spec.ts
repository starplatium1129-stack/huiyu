import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useScrollReveal } from './useScrollReveal'

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; delete document.documentElement.dataset.motion })
it('only observes its own page and suspends work while cached offscreen', async () => {
  const observe = vi.fn(), disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class { observe = observe; unobserve = vi.fn(); disconnect = disconnect })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const outside = document.createElement('div'); outside.dataset.reveal = ''; document.body.append(outside)
  const active = ref(true)
  const Page = defineComponent({ setup() { useScrollReveal(); return () => h('article', [h('div', { 'data-reveal': '' })]) } })
  const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(Page) : null }) }), { attachTo: document.body })
  expect(observe.mock.calls.some(([element]) => element === outside)).toBe(false)
  active.value = false; await nextTick()
  expect(disconnect).toHaveBeenCalled()
  const before = observe.mock.calls.length
  active.value = true; await nextTick()
  expect(observe.mock.calls.length).toBeGreaterThan(before)
  wrapper.unmount()
})

it('reveals pending and late-loaded content when app motion changes to reduce', async () => {
  const observe = vi.fn(), unobserve = vi.fn()
  vi.stubGlobal('IntersectionObserver', class { observe = observe; unobserve = unobserve; disconnect = vi.fn() })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  document.documentElement.dataset.motion = 'full'
  let reveal: ReturnType<typeof useScrollReveal>
  const Page = defineComponent({ setup() { reveal = useScrollReveal(); return () => h('article', [h('div', { 'data-reveal': '' })]) } })
  const wrapper = mount(Page, { attachTo: document.body })
  expect(observe).toHaveBeenCalledOnce()
  expect(wrapper.find('[data-reveal]').classes()).not.toContain('revealed')
  document.documentElement.dataset.motion = 'reduce'
  window.dispatchEvent(new Event('atelier:motion-preference'))
  expect(wrapper.find('[data-reveal]').classes()).toContain('revealed')
  expect(unobserve).toHaveBeenCalled()
  const late = document.createElement('div'); late.dataset.reveal = ''; wrapper.element.append(late)
  reveal!.observeAll()
  expect(late.classList.contains('revealed')).toBe(true)
  wrapper.unmount()
})

it('waits for a decoded card and reveals its logical identity only once across remounts', async () => {
  const observe = vi.fn(), unobserve = vi.fn()
  let intersection!: IntersectionObserverCallback
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersection = callback }
    observe = observe; unobserve = unobserve; disconnect = vi.fn()
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const ready = ref(false), version = ref(0)
  const Page = defineComponent({ setup() {
    useScrollReveal()
    return () => h('article', [h('button', { key: version.value, 'data-reveal': '',
      'data-reveal-key': 'artwork:one', 'data-reveal-ready': String(ready.value) }, 'Open artwork')])
  } })
  const wrapper = mount(Page, { attachTo: document.body })
  try {
    expect(observe).not.toHaveBeenCalled()
    ready.value = true; await nextTick()
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce())
    const first = wrapper.get('button').element
    intersection([{ target: first, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(first.classList.contains('revealed')).toBe(true)
    expect(unobserve).toHaveBeenCalledWith(first)
    ready.value = false; version.value++; await nextTick()
    await vi.waitFor(() => expect(wrapper.get('button').classes()).toContain('revealed'))
    expect(wrapper.get('button').element).not.toBe(first)
    expect(observe).toHaveBeenCalledOnce()
  } finally { wrapper.unmount() }
})
