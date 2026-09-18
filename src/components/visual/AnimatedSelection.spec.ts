import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, KeepAlive, nextTick, ref, type App } from 'vue'
import AnimatedSelection from './AnimatedSelection.vue'
let app: App, host: HTMLElement, frames: Map<number, FrameRequestCallback>, id: number, now: number
let resize: Set<object>, mutations: Set<object>
const shown = ref(true)
function step() { now += 1000 / 60; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb(now)) }
function drain() { for (let i = 0; i < 180 && frames.size; i++) step(); expect(frames.size).toBe(0) }
async function mount() {
  const Page = defineComponent({ name: 'SelectionPage', setup: () => () => h('div', [h('button', { 'aria-pressed': 'true' }, 'Selected'), h(AnimatedSelection)]) })
  app = createApp({ setup: () => () => h(KeepAlive, null, { default: () => shown.value ? h(Page) : null }) })
  host = document.createElement('div'); document.body.append(host); app.mount(host); await nextTick()
  return host.querySelector('.animated-selection') as HTMLElement
}
beforeEach(() => {
  shown.value = true; frames = new Map(); id = 0; now = 0; resize = new Set(); mutations = new Set()
  document.documentElement.dataset.motion = 'full'
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'BUTTON' ? new DOMRect(20, 10, 100, 40) : new DOMRect(0, 0, 300, 60)
  })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  })
  vi.stubGlobal('ResizeObserver', class { constructor() { resize.add(this) } observe() {} unobserve() {} disconnect() { resize.delete(this) } })
  vi.stubGlobal('MutationObserver', class { constructor() { mutations.add(this) } observe() {} disconnect() { mutations.delete(this) } })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const value = id++; frames.set(value, cb); return value })
  vi.stubGlobal('cancelAnimationFrame', (value: number) => frames.delete(value))
})
afterEach(() => { app?.unmount(); document.body.replaceChildren(); delete document.documentElement.dataset.motion; vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('009 cached selection indicator lifecycle', () => {
  it('mounts and activates only one observer set and one frame', async () => {
    const indicator = await mount()
    expect(resize.size).toBe(1); expect(mutations.size).toBe(1); expect(frames.size).toBe(1)
    drain(); expect(indicator.style.transform).toBe('translate(20px,10px) scale(1,1)')
    expect(indicator.getAttribute('aria-hidden')).toBe('true')
  })
  it('releases on deactivation and preserves the cached DOM through 20 round trips', async () => {
    const indicator = await mount(); drain()
    for (let round = 0; round < 20; round++) {
      shown.value = false; await nextTick()
      expect(frames.size).toBe(0); expect(resize.size).toBe(0); expect(mutations.size).toBe(0)
      shown.value = true; await nextTick()
      expect(host.querySelector('.animated-selection')).toBe(indicator)
      expect(resize.size).toBe(1); expect(mutations.size).toBe(1); drain()
    }
  })
  it('does not schedule hidden updates and snaps to current geometry on return', async () => {
    const indicator = await mount()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange')); expect(frames.size).toBe(0)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange')); document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(1); drain(); expect(indicator.style.opacity).toBe('1')
  })
  it('unmount releases all active observers and scheduled frames', async () => {
    await mount(); app.unmount()
    expect(resize.size).toBe(0); expect(mutations.size).toBe(0); expect(frames.size).toBe(0)
  })
})
