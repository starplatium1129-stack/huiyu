import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { useRouteTransition } from './useRouteTransition'

afterEach(() => { document.body.replaceChildren(); delete document.documentElement.dataset.motion })
describe('009 cached route entry', () => {
  it('does not replay first-entry motion on 20 returns of the same cached element', () => {
    let hooks!: ReturnType<typeof useRouteTransition>
    const host = document.createElement('div'); document.body.append(host)
    const app = createApp({ setup() { hooks = useRouteTransition(); return () => h('div') } }); app.mount(host)
    document.documentElement.dataset.motion = 'full'
    const el = document.createElement('article'); el.dataset.routePath = '/gallery'
    const animate = vi.fn(); el.animate = animate
    try {
      for (let round = 0; round < 20; round++) {
        const left = vi.fn(), entered = vi.fn()
        hooks.onLeave(el, left); expect(el.inert).toBe(true)
        hooks.onBeforeEnter(el); hooks.onEnter(el, entered)
        expect(el.inert).toBe(false); expect(left).toHaveBeenCalledTimes(1); expect(entered).toHaveBeenCalledTimes(1)
      }
      expect(animate).not.toHaveBeenCalled()
    } finally { app.unmount() }
  })
  it('does not suppress an entrance on a replacement DOM node at the same URL', () => {
    let hooks!: ReturnType<typeof useRouteTransition>
    const host = document.createElement('div'); document.body.append(host)
    const app = createApp({ setup() { hooks = useRouteTransition(); return () => h('div') } }); app.mount(host)
    document.documentElement.dataset.motion = 'full'
    const old = document.createElement('article'), fresh = document.createElement('article')
    old.dataset.routePath = fresh.dataset.routePath = '/gallery'
    const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null, oncancel: null }
    fresh.animate = vi.fn(() => animation as unknown as Animation)
    try {
      hooks.onLeave(old, vi.fn()); const done = vi.fn(); hooks.onEnter(fresh, done)
      expect(fresh.animate).toHaveBeenCalledTimes(1); expect(done).not.toHaveBeenCalled()
      animation.onfinish!(); expect(done).toHaveBeenCalledTimes(1)
    } finally { app.unmount() }
  })
})
