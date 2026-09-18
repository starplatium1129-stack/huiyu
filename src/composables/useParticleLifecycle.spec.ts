import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, KeepAlive, nextTick, ref, type App } from 'vue'
import { useParticleLifecycle } from './useParticleLifecycle'

let app: App | undefined, frames: Map<number, FrameRequestCallback>, id: number
let observers: Set<object>, callbacks: Array<() => void>
let hooks: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; palette: ReturnType<typeof vi.fn>; preference: ReturnType<typeof vi.fn>; visible: ReturnType<typeof vi.fn>; portrait: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> }
let api: ReturnType<typeof useParticleLifecycle>
const shown = ref(true)
async function mount() {
  const Page = defineComponent({ setup() {
    const host = ref<HTMLElement | null>(null)
    api = useParticleLifecycle(host, hooks)
    return () => h('figure', { ref: host })
  } })
  const el = document.createElement('div'); document.body.append(el)
  app = createApp({ setup: () => () => h(KeepAlive, null, { default: () => shown.value ? h(Page) : null }) })
  app.mount(el); await nextTick()
}
beforeEach(() => {
  shown.value = true; frames = new Map(); id = 0; observers = new Set(); callbacks = []
  hooks = { start: vi.fn(), stop: vi.fn(), resize: vi.fn(), palette: vi.fn(), preference: vi.fn(), visible: vi.fn(), portrait: vi.fn(), invalidate: vi.fn() }
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const next = id++; frames.set(next, callback); return next })
  vi.stubGlobal('cancelAnimationFrame', (value: number) => frames.delete(value))
  class Observer { constructor(callback: () => void) { observers.add(this); callbacks.push(callback) } observe() {} disconnect() { observers.delete(this) } }
  vi.stubGlobal('ResizeObserver', Observer); vi.stubGlobal('MutationObserver', Observer)
  vi.stubGlobal('IntersectionObserver', class extends Observer { constructor(callback: (entries: unknown[]) => void) { super(() => callback([{ isIntersecting: true }])) } })
})
afterEach(() => { app?.unmount(); app = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('009 particle lifecycle ownership', () => {
  it('mount and activation attach only one observer set', async () => {
    await mount(); expect(observers.size).toBe(3); expect(hooks.portrait).toHaveBeenCalledTimes(1); expect(api.isActive()).toBe(true)
  })
  it('balances every owner through 20 cached deactivation/reactivation cycles', async () => {
    await mount()
    for (let i = 0; i < 20; i++) {
      shown.value = false; await nextTick(); expect(observers.size).toBe(0); expect(frames.size).toBe(0); expect(api.isActive()).toBe(false)
      const count = hooks.start.mock.calls.length
      callbacks.forEach(callback => callback()); expect(hooks.start).toHaveBeenCalledTimes(count)
      shown.value = true; await nextTick(); expect(observers.size).toBe(3); expect(api.isActive()).toBe(true)
    }
    expect(hooks.invalidate).toHaveBeenCalledTimes(20); expect(hooks.portrait).toHaveBeenCalledTimes(21)
  })
  it('ignores observer callbacks from a previous activation after returning', async () => {
    await mount(); const stale = [...callbacks]
    shown.value = false; await nextTick(); shown.value = true; await nextTick()
    const starts = hooks.start.mock.calls.length, resizes = hooks.resize.mock.calls.length
    stale.forEach(callback => callback())
    expect(hooks.start).toHaveBeenCalledTimes(starts); expect(hooks.resize).toHaveBeenCalledTimes(resizes); expect(frames.size).toBe(0)
  })
  it('cancels pending palette reads on hide and only resumes current state', async () => {
    await mount(); callbacks[2](); callbacks[2](); expect(frames.size).toBe(1)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange')); expect(frames.size).toBe(0)
    const palettes = hooks.palette.mock.calls.length; callbacks[2](); expect(hooks.palette).toHaveBeenCalledTimes(palettes)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange')); expect(hooks.palette).toHaveBeenCalledTimes(palettes + 1)
  })
  it('receives the application preference and removes it on deactivation', async () => {
    await mount(); window.dispatchEvent(new Event('atelier:motion-preference'))
    expect(hooks.preference).toHaveBeenCalledTimes(2)
    shown.value = false; await nextTick(); window.dispatchEvent(new Event('atelier:motion-preference'))
    expect(hooks.preference).toHaveBeenCalledTimes(2)
  })
  it('supports legacy and missing matchMedia without preventing mounting', async () => {
    const addListener = vi.fn(), removeListener = vi.fn()
    vi.stubGlobal('matchMedia', () => ({ addListener, removeListener }))
    await mount(); app!.unmount(); app = undefined
    expect(removeListener).toHaveBeenCalledWith(addListener.mock.calls[0][0])
    vi.stubGlobal('matchMedia', undefined); await mount(); expect(hooks.start).toHaveBeenCalledTimes(2)
  })
  it('invalidates portrait ownership and pending observer callbacks on unmount', async () => {
    await mount(); callbacks[2](); app!.unmount(); app = undefined
    expect(frames.size).toBe(0); expect(observers.size).toBe(0); expect(hooks.invalidate).toHaveBeenCalledTimes(1)
    const count = hooks.start.mock.calls.length; callbacks.forEach(callback => callback())
    expect(hooks.start).toHaveBeenCalledTimes(count)
  })
})
