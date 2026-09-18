import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import { useFluidSurface } from './useFluidSurface'
let app: App, host: HTMLElement, frames: Map<number, FrameRequestCallback>, now: number, sequence: number
let hooks: ReturnType<typeof useFluidSurface>
function rect(x: number, y: number, width: number, height: number) { return new DOMRect(x, y, width, height) }
function step() { now += 1000 / 60; const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(now)) }
function drain() { for (let i = 0; i < 180 && frames.size; i++) step(); expect(frames.size).toBe(0) }
function panel(className = 'art-viewer') {
  const el = document.createElement('div'); el.className = className; document.body.append(el)
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1000, 700))
  return el
}
beforeEach(() => {
  frames = new Map(); now = 0; sequence = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = sequence++; frames.set(id, cb); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  document.documentElement.dataset.motion = 'full'
  host = document.createElement('div'); document.body.append(host)
  app = createApp({ setup() { hooks = useFluidSurface(); return () => h('div') } }); app.mount(host)
})
afterEach(() => { app.unmount(); document.body.replaceChildren(); delete document.documentElement.dataset.motion; vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('009 fluid surface ownership', () => {
  it('restores styles after entry so fixed children have no transformed ancestor', () => {
    const el = panel(), done = vi.fn(); hooks.enter(el, done); drain()
    expect(done).toHaveBeenCalledTimes(1); expect(el.style.transform).toBe(''); expect(el.style.opacity).toBe(''); expect(el.style.transformOrigin).toBe('')
    document.documentElement.dataset.motion = 'reduce'; window.dispatchEvent(new Event('atelier:motion-preference'))
    expect(el.style.transform).toBe('')
  })
  it('uses a visible artwork trigger as the origin and restores it after settling', () => {
    const trigger = document.createElement('button'); document.body.append(trigger)
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(100, 70, 100, 70)); trigger.focus()
    const el = panel(); hooks.enter(el, vi.fn())
    expect(el.style.transformOrigin).toBe('15% 15%'); drain(); expect(el.style.transformOrigin).toBe('')
  })
  it('uses a centered fallback for an offscreen trigger or zero-size panel', () => {
    const trigger = document.createElement('button'); document.body.append(trigger)
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(-1000, -1000, 50, 50)); trigger.focus()
    const el = panel(); hooks.enter(el, vi.fn()); expect(el.style.transformOrigin).toBe('center center'); drain()
    hooks.dispose(el); vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 0, 0))
    hooks.enter(el, vi.fn()); expect(el.style.transformOrigin).not.toMatch(/NaN|Infinity/)
  })
  it('reverses from the visible state and calls only the latest completion', () => {
    const el = panel(), entered = vi.fn(), left = vi.fn(), reopened = vi.fn()
    hooks.enter(el, entered); step(); step(); const during = el.style.transform
    hooks.leave(el, left); expect(el.style.transform).toBe(during); step()
    const closing = el.style.transform; hooks.enter(el, reopened); expect(el.style.transform).toBe(closing); drain()
    expect(entered).not.toHaveBeenCalled(); expect(left).not.toHaveBeenCalled(); expect(reopened).toHaveBeenCalledTimes(1)
    expect(el.style.transform).toBe('')
  })
  it('does not dispose on reversal but releases a completed leave', () => {
    const el = panel(); hooks.enter(el, vi.fn()); drain()
    const done = vi.fn(() => hooks.dispose(el)); hooks.leave(el, done); drain()
    expect(done).toHaveBeenCalledTimes(1); expect(el.style.transform).toBe(''); expect(el.style.opacity).toBe('')
    hooks.dispose(el)
  })
  it('preserves styles owned by the caller after completion', () => {
    const el = panel(); el.style.opacity = '0.8'; el.style.transform = 'translateX(2px)'; el.style.transformOrigin = 'left top'
    hooks.enter(el, vi.fn()); drain()
    expect(el.style.opacity).toBe('0.8'); expect(el.style.transform).toBe('translateX(2px)'); expect(el.style.transformOrigin).toBe('left top')
  })
  it('settles reduced motion immediately and remains reusable after the preference returns', () => {
    const el = panel(), done = vi.fn(); document.documentElement.dataset.motion = 'reduce'
    hooks.enter(el, done); expect(frames.size).toBe(0); expect(done).toHaveBeenCalledTimes(1); expect(el.style.transform).toBe('')
    document.documentElement.dataset.motion = 'full'; hooks.leave(el, done)
    expect(frames.size).toBe(1); drain(); expect(done).toHaveBeenCalledTimes(2)
  })
  it('unmount releases active frames and does not complete an obsolete Vue callback', () => {
    const el = panel(), done = vi.fn(); hooks.enter(el, done); step(); app.unmount()
    expect(frames.size).toBe(0); expect(done).not.toHaveBeenCalled(); expect(el.style.transform).toBe('')
  })
})
