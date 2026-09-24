import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { useRouteTransition } from './useRouteTransition'

// Exercise the hooks at their lifecycle/WAAPI boundaries, without timing or rendering claims.
const state = vi.hoisted(() => ({
  mounted: [] as Array<() => void>,
  deactivated: [] as Array<() => void>,
  unmounted: [] as Array<() => void>,
  reduced: false,
  marks: [] as Array<[string, string]>,
}))
vi.mock('vue', () => ({
  onMounted: (callback: () => void) => state.mounted.push(callback),
  onDeactivated: (callback: () => void) => state.deactivated.push(callback),
  onUnmounted: (callback: () => void) => state.unmounted.push(callback),
}))
vi.mock('@/utils/motionPreference', () => ({ prefersReducedMotion: () => state.reduced }))
vi.mock('@/utils/uiFluidityMeasurement', () => ({
  markUiFluidityForPath: (path: string, phase: string) => state.marks.push([path, phase]),
}))

class AnimationStub {
  onfinish: (() => void) | null = null
  oncancel: (() => void) | null = null
  effect: object | null = {}
  cancelCalls = 0
  cancelThrows = false
  cancel() {
    this.cancelCalls++
    if (this.cancelThrows) throw new Error('optional animation cancellation unavailable')
  }
}

function surface(path = '/gallery') {
  const animations: AnimationStub[] = []
  const calls: unknown[][] = []
  const el = {
    dataset: { routePath: path },
    inert: true,
    animate: (...args: unknown[]) => {
      calls.push(args)
      const animation = new AnimationStub()
      animations.push(animation)
      return animation
    },
  } as unknown as HTMLElement
  return { el, animations, calls }
}

function mediaQuery(mode: 'modern' | 'legacy' | 'none' = 'modern') {
  const listeners = new Set<() => void>()
  const add = (callback: () => void) => { listeners.add(callback) }
  const remove = (callback: () => void) => { listeners.delete(callback) }
  return {
    listeners,
    emit: () => { for (const callback of [...listeners]) callback() },
    ...(mode === 'modern' ? {
      addEventListener: (event: string, callback: () => void) => { assert.equal(event, 'change'); add(callback) },
      removeEventListener: (event: string, callback: () => void) => { assert.equal(event, 'change'); remove(callback) },
    } : mode === 'legacy' ? { addListener: add, removeListener: remove } : {}),
  }
}

function browser(media: ReturnType<typeof mediaQuery> | null = mediaQuery()) {
  const events = new EventTarget()
  const matchMedia = media ? (query: string) => {
    assert.equal(query, '(prefers-reduced-motion: reduce)')
    return media
  } : undefined
  vi.stubGlobal('window', Object.assign(events, { matchMedia }))
  vi.stubGlobal('matchMedia', matchMedia)
  return events
}

function mountHooks() {
  const hooks = useRouteTransition()
  for (const callback of state.mounted.splice(0)) callback()
  return hooks
}
function unmount() { for (const callback of state.unmounted.splice(0)) callback() }
function counter() {
  let count = 0
  return { done: () => { count++ }, get count() { return count } }
}

beforeEach(() => {
  state.mounted.length = state.deactivated.length = state.unmounted.length = state.marks.length = 0
  state.reduced = false
  browser()
})
afterEach(() => { unmount(); vi.unstubAllGlobals() })

describe('route motion lifecycle and optional capability fallback (009 F4.6a)', () => {
  it('animates ordinary page changes and gives cached returns an opacity-only settle', () => {
    let destination = '/gallery'
    const hooks = useRouteTransition(() => destination)
    const gallery = surface(), style = surface()
    gallery.el.dataset.routePath = '/gallery'; style.el.dataset.routePath = '/style'
    hooks.onEnter(gallery.el, () => {}); gallery.animations[0].onfinish!()
    destination = '/style'; hooks.onLeave(gallery.el, () => {}); hooks.onEnter(style.el, () => {})
    assert.deepEqual(style.calls[0][0], [{ opacity: 0, transform: 'translateX(18px) scale(.992)' }, { opacity: 1, transform: 'translateX(0) scale(1)' }])
    destination = '/gallery'; hooks.onLeave(style.el, () => {}); hooks.onEnter(gallery.el, () => {})
    assert.equal(gallery.el.inert, false)
    assert.deepEqual(gallery.calls.at(-1), [[{ opacity: .88 }, { opacity: 1 }], { duration: 150, easing: 'cubic-bezier(.22, 1, .36, 1)' }])
    hooks.onEnterCancelled(gallery.el); hooks.onLeaveCancelled(style.el)
  })

  it('slides in from left when navigating backwards in the route order', () => {
    let destination = '/style'
    const hooks = useRouteTransition(() => destination)
    const style = surface('/style'), scene = surface('/scene-explorer')
    hooks.onEnter(style.el, () => {}); style.animations[0].onfinish!()
    destination = '/scene-explorer'; hooks.onLeave(style.el, () => {}); hooks.onEnter(scene.el, () => {})
    assert.deepEqual(scene.calls[0][0], [{ opacity: 0, transform: 'translateX(-18px) scale(.992)' }, { opacity: 1, transform: 'translateX(0) scale(1)' }])
    hooks.onEnterCancelled(scene.el); hooks.onLeaveCancelled(style.el)
  })

  it('fades standalone layouts without translating native overlay anchors', () => {
    const hooks = useRouteTransition(undefined, { initialFade: true }), { el, calls } = surface()
    el.dataset.routePath = '/control'
    hooks.onEnter(el, () => {})
    assert.deepEqual(calls[0][0], [{ opacity: 0 }, { opacity: 1 }])
    hooks.onEnterCancelled(el)
  })

  it('keeps only one departing page during rapid navigation', () => {
    let destination = '/style'
    const hooks = useRouteTransition(() => destination), first = surface(), second = surface()
    first.el.dataset.routePath = '/gallery'; second.el.dataset.routePath = '/style'
    const leftFirst = counter(), leftSecond = counter()
    hooks.onLeave(first.el, leftFirst.done)
    assert.equal(leftFirst.count, 0)
    destination = '/lora'; hooks.onLeave(second.el, leftSecond.done)
    assert.equal(leftFirst.count, 1)
    assert.equal(first.animations[0].cancelCalls, 1)
    assert.equal(leftSecond.count, 0)
    hooks.onLeaveCancelled(second.el)
    assert.equal(leftSecond.count, 1)
  })
  it('crossfades the archive pair without blocking input and supports cancellation', () => {
    const hooks = useRouteTransition(() => '/character')
    const oldPage = surface(), newPage = surface(), left = counter(), entered = counter()
    oldPage.el.dataset.routePath = '/popular-scenes?character=nene'
    newPage.el.dataset.routePath = '/character?character=nene'
    hooks.onLeave(oldPage.el, left.done)
    hooks.onEnter(newPage.el, entered.done)
    assert.equal(oldPage.el.inert, true)
    assert.equal(newPage.el.inert, false)
    assert.equal(left.count, 0)
    assert.deepEqual(oldPage.calls[0], [[{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-out' }])
    assert.deepEqual(newPage.calls[0][0], [{ opacity: 0, transform: 'translateX(16px)' }, { opacity: 1, transform: 'translateX(0)' }])
    hooks.onLeaveCancelled(oldPage.el)
    assert.equal(oldPage.el.inert, false)
    assert.equal(left.count, 1)
    hooks.onEnterCancelled(newPage.el)
    assert.equal(entered.count, 1)
  })

  it('skips both archive effects with reduced motion', () => {
    state.reduced = true
    const hooks = useRouteTransition(() => '/character'), oldPage = surface(), newPage = surface()
    oldPage.el.dataset.routePath = '/popular-scenes'; newPage.el.dataset.routePath = '/character'
    const left = counter(), entered = counter()
    hooks.onLeave(oldPage.el, left.done); hooks.onEnter(newPage.el, entered.done)
    assert.equal(left.count, 1); assert.equal(entered.count, 1)
    assert.equal(oldPage.animations.length + newPage.animations.length, 0)
  })
  it('preserves the existing opaque 6px / 220ms entrance and allows immediate input', () => {
    const hooks = mountHooks(), { el, calls } = surface(), done = counter()
    hooks.onEnter(el, done.done)
    assert.equal(el.inert, false)
    assert.equal(done.count, 0)
    assert.deepEqual(calls, [[
      [{ transform: 'translateY(6px)' }, { transform: 'translateY(0)' }],
      { duration: 220, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    ]])
    assert.deepEqual(state.marks, [['/gallery', 'shell-ready']])
  })

  it('finishes once, detaches callbacks and releases the effect', () => {
    const hooks = mountHooks(), { el, animations } = surface(), done = counter()
    hooks.onEnter(el, done.done)
    const animation = animations[0], finish = animation.onfinish!
    finish(); finish(); hooks.onEnterCancelled(el)
    assert.equal(done.count, 1)
    assert.equal(animation.cancelCalls, 1)
    assert.equal(animation.onfinish, null)
    assert.equal(animation.oncancel, null)
    assert.deepEqual(state.marks, [['/gallery', 'shell-ready'], ['/gallery', 'settled']])
  })

  it('settles a native animation cancellation only once', () => {
    const hooks = mountHooks(), { el, animations } = surface(), done = counter()
    hooks.onEnter(el, done.done)
    const cancelled = animations[0].oncancel!
    cancelled(); cancelled()
    assert.equal(done.count, 1)
    assert.equal(animations[0].cancelCalls, 1)
  })

  it('settles the old entrance and skips first-entry motion on the same cached element', () => {
    const hooks = mountHooks(), { el, animations } = surface(), first = counter(), second = counter()
    hooks.onEnter(el, first.done)
    const staleFinish = animations[0].onfinish!
    el.dataset.routePath = '/gallery?filter=new'
    hooks.onEnter(el, second.done)
    staleFinish()
    assert.equal(first.count, 1)
    assert.equal(second.count, 1)
    assert.equal(animations.length, 1)
    assert.deepEqual(state.marks, [
      ['/gallery', 'shell-ready'], ['/gallery', 'settled'],
      ['/gallery?filter=new', 'shell-ready'], ['/gallery?filter=new', 'settled'],
    ])
  })

  it('makes the leaving route inert and resets it when the cached element returns', () => {
    const hooks = mountHooks(), { el, animations } = surface(), entered = counter(), left = counter()
    hooks.onEnter(el, entered.done)
    hooks.onLeave(el, left.done)
    assert.equal(el.inert, true)
    assert.equal(entered.count, 1)
    assert.equal(left.count, 1)
    assert.equal(animations[0].onfinish, null)
    hooks.onBeforeEnter(el)
    assert.equal(el.inert, false)
  })

  it('removes a route immediately even when no animation is active', () => {
    const hooks = mountHooks(), { el } = surface(), done = counter()
    hooks.onLeave(el, done.done)
    assert.equal(el.inert, true)
    assert.equal(done.count, 1)
  })

  it('settles Vue enter cancellation without retaining active work', () => {
    const hooks = mountHooks(), { el, animations } = surface(), done = counter()
    hooks.onEnter(el, done.done)
    hooks.onEnterCancelled(el); hooks.onEnterCancelled(el); unmount()
    assert.equal(done.count, 1)
    assert.equal(animations[0].cancelCalls, 1)
  })

  it('skips animation when reduced motion is already enabled', () => {
    const hooks = mountHooks(), { el, calls } = surface(), done = counter()
    state.reduced = true
    hooks.onEnter(el, done.done); unmount()
    assert.equal(el.inert, false)
    assert.equal(done.count, 1)
    assert.equal(calls.length, 0)
    assert.deepEqual(state.marks, [['/gallery', 'shell-ready'], ['/gallery', 'settled']])
  })

  it('remains navigable when WAAPI is unavailable', () => {
    const hooks = mountHooks(), { el } = surface(), done = counter()
    Object.defineProperty(el, 'animate', { value: undefined })
    hooks.onEnter(el, done.done); unmount()
    assert.equal(el.inert, false)
    assert.equal(done.count, 1)
  })

  it('falls back when animate exists but throws and still allows the next navigation', () => {
    const hooks = mountHooks(), broken = surface(), next = surface('/showcase'), first = counter(), second = counter()
    broken.el.animate = () => { throw new Error('optional animation creation unavailable') }
    assert.doesNotThrow(() => hooks.onEnter(broken.el, first.done))
    assert.equal(first.count, 1)
    assert.equal(broken.el.inert, false)
    assert.deepEqual(state.marks, [['/gallery', 'shell-ready'], ['/gallery', 'settled']])
    hooks.onEnter(next.el, second.done)
    next.animations[0].onfinish!(); unmount()
    assert.equal(first.count, 1)
    assert.equal(second.count, 1)
  })

  it('falls back when a partial animation implementation returns no animation', () => {
    const hooks = mountHooks(), { el } = surface(), done = counter()
    Object.defineProperty(el, 'animate', { value: () => undefined })
    assert.doesNotThrow(() => hooks.onEnter(el, done.done))
    unmount()
    assert.equal(done.count, 1)
  })

  it('releases the effect and completes Vue leave even when animation.cancel throws', () => {
    const hooks = mountHooks(), { el, animations } = surface(), entered = counter(), left = counter()
    hooks.onEnter(el, entered.done)
    animations[0].cancelThrows = true
    assert.doesNotThrow(() => hooks.onLeave(el, left.done))
    assert.equal(animations[0].effect, null)
    assert.equal(animations[0].onfinish, null)
    assert.equal(animations[0].oncancel, null)
    assert.equal(el.inert, true)
    assert.equal(entered.count, 1)
    assert.equal(left.count, 1)
  })

  it('still releases the Vue callback when both optional cleanup operations fail', () => {
    const hooks = mountHooks(), { el, animations } = surface(), done = counter()
    hooks.onEnter(el, done.done)
    animations[0].cancelThrows = true
    Object.defineProperty(animations[0], 'effect', { set() { throw new Error('effect unavailable') } })
    assert.doesNotThrow(() => hooks.onEnterCancelled(el))
    unmount()
    assert.equal(done.count, 1)
  })

  it('settles every active route on an app reduced-motion event, not on a full-motion event', () => {
    const events = browser(), hooks = mountHooks(), a = surface(), b = surface('/showcase'), da = counter(), db = counter()
    hooks.onEnter(a.el, da.done); hooks.onEnter(b.el, db.done)
    events.dispatchEvent(new Event('atelier:motion-preference'))
    assert.equal(da.count + db.count, 0)
    state.reduced = true
    events.dispatchEvent(new Event('atelier:motion-preference'))
    events.dispatchEvent(new Event('atelier:motion-preference')); unmount()
    assert.equal(da.count, 1)
    assert.equal(db.count, 1)
  })

  it('responds to system reduced-motion changes and removes the modern listener on unmount', () => {
    const media = mediaQuery(); browser(media)
    const hooks = mountHooks(), { el } = surface(), done = counter()
    assert.equal(media.listeners.size, 1)
    hooks.onEnter(el, done.done)
    media.emit()
    assert.equal(done.count, 0)
    state.reduced = true; media.emit(); unmount()
    assert.equal(done.count, 1)
    assert.equal(media.listeners.size, 0)
  })

  it('supports legacy MediaQueryList listener methods and cleans them up', () => {
    const media = mediaQuery('legacy'); browser(media)
    const hooks = mountHooks(), { el } = surface(), done = counter()
    assert.equal(media.listeners.size, 1)
    hooks.onEnter(el, done.done)
    state.reduced = true; media.emit(); unmount()
    assert.equal(done.count, 1)
    assert.equal(media.listeners.size, 0)
  })

  it('keeps the app reduced-motion event working without matchMedia', () => {
    const events = browser(null), hooks = mountHooks(), { el } = surface(), done = counter()
    hooks.onEnter(el, done.done)
    state.reduced = true
    events.dispatchEvent(new Event('atelier:motion-preference'))
    assert.equal(done.count, 1)
  })

  it('can mount when the media query has no event subscription API', () => {
    browser(mediaQuery('none'))
    const hooks = mountHooks(), { el, animations } = surface(), done = counter()
    hooks.onEnter(el, done.done)
    animations[0].onfinish!()
    assert.equal(done.count, 1)
  })

  it('cleans up the app event listener on unmount', () => {
    const events = browser(), hooks = mountHooks(), { el, animations } = surface(), done = counter()
    unmount()
    // Invoke an exported hook only to detect an erroneously retained global listener.
    hooks.onEnter(el, done.done)
    state.reduced = true
    events.dispatchEvent(new Event('atelier:motion-preference'))
    assert.equal(done.count, 0)
    animations[0].onfinish!()
    assert.equal(done.count, 1)
  })

  it('settles on deactivation without duplicating listeners or blocking a later activation', () => {
    const media = mediaQuery(); browser(media)
    const hooks = mountHooks(), { el } = surface(), first = counter(), second = counter()
    hooks.onEnter(el, first.done)
    for (const callback of state.deactivated) callback()
    assert.equal(first.count, 1)
    assert.equal(media.listeners.size, 1)
    hooks.onBeforeEnter(el); hooks.onEnter(el, second.done)
    unmount()
    assert.equal(first.count, 1)
    assert.equal(second.count, 1)
    assert.equal(media.listeners.size, 0)
  })

  it('unmounts multiple active entrances even when one cancellation throws', () => {
    const hooks = mountHooks(), a = surface(), b = surface('/showcase'), da = counter(), db = counter()
    hooks.onEnter(a.el, da.done); hooks.onEnter(b.el, db.done)
    a.animations[0].cancelThrows = true
    assert.doesNotThrow(unmount)
    assert.equal(da.count, 1)
    assert.equal(db.count, 1)
    assert.equal(b.animations[0].cancelCalls, 1)
  })

  it('does not create measurements for elements without a route path', () => {
    const hooks = mountHooks(), { el, animations } = surface(''), done = counter()
    hooks.onEnter(el, done.done)
    animations[0].onfinish!()
    assert.equal(done.count, 1)
    assert.deepEqual(state.marks, [])
  })

  it('hands off workspace depth using only transform and opacity, without a retained fill', () => {
    const hooks = useRouteTransition(() => '/style'), oldPage = surface('/gallery'), newPage = surface('/style')
    const left = counter(), entered = counter()
    hooks.onLeave(oldPage.el, left.done); hooks.onEnter(newPage.el, entered.done)
    assert.deepEqual(oldPage.calls[0], [[
      { opacity: 1, transform: 'translateX(0) scale(1)' },
      { opacity: 0, transform: 'translateX(-8px) scale(.996)' },
    ], { duration: 160, easing: 'cubic-bezier(.4, 0, 1, 1)' }])
    assert.deepEqual(newPage.calls[0][1], { duration: 320, easing: 'cubic-bezier(.16, 1, .3, 1)' })
    for (const { calls } of [oldPage, newPage]) {
      for (const frame of calls[0][0] as Keyframe[]) {
        assert.ok(Object.keys(frame).every(key => key === 'transform' || key === 'opacity'))
      }
    }
    oldPage.animations[0].onfinish!(); newPage.animations[0].onfinish!()
    assert.equal(left.count, 1); assert.equal(entered.count, 1)
    assert.equal(oldPage.animations[0].cancelCalls, 1)
    assert.equal(newPage.animations[0].cancelCalls, 1)
  })

  it('does not invent a horizontal direction for an unranked workspace', () => {
    const hooks = useRouteTransition(() => '/new-workspace'), oldPage = surface('/gallery'), newPage = surface('/new-workspace')
    hooks.onLeave(oldPage.el, () => {}); hooks.onEnter(newPage.el, () => {})
    assert.deepEqual(newPage.calls[0][0], [
      { opacity: 0, transform: 'translateX(0px) scale(.992)' },
      { opacity: 1, transform: 'translateX(0) scale(1)' },
    ])
    assert.deepEqual((oldPage.calls[0][0] as Keyframe[])[1], { opacity: 0, transform: 'translateX(0px) scale(.996)' })
    hooks.onLeaveCancelled(oldPage.el); hooks.onEnterCancelled(newPage.el)
  })

  it('keeps AppLayout initialFade limited to first paint, not subsequent workspace navigation', () => {
    const hooks = useRouteTransition(() => '/style', { initialFade: true })
    const oldPage = surface('/gallery'), newPage = surface('/style')
    hooks.onEnter(oldPage.el, () => {}); oldPage.animations[0].onfinish!()
    assert.deepEqual(oldPage.calls[0][0], [{ opacity: 0 }, { opacity: 1 }])
    hooks.onLeave(oldPage.el, () => {}); hooks.onEnter(newPage.el, () => {})
    assert.deepEqual(newPage.calls[0][0], [
      { opacity: 0, transform: 'translateX(18px) scale(.992)' },
      { opacity: 1, transform: 'translateX(0) scale(1)' },
    ])
    hooks.onLeaveCancelled(oldPage.el); hooks.onEnterCancelled(newPage.el)
  })

  it('settles both halves of the depth transition immediately when reduced motion changes', () => {
    const events = browser(), hooks = useRouteTransition(() => '/style')
    for (const callback of state.mounted.splice(0)) callback()
    const oldPage = surface('/gallery'), newPage = surface('/style'), left = counter(), entered = counter()
    hooks.onLeave(oldPage.el, left.done); hooks.onEnter(newPage.el, entered.done)
    state.reduced = true; events.dispatchEvent(new Event('atelier:motion-preference'))
    assert.equal(left.count, 1); assert.equal(entered.count, 1)
    assert.equal(newPage.el.inert, false)
    assert.equal(oldPage.animations[0].onfinish, null)
    assert.equal(newPage.animations[0].onfinish, null)
    unmount()
    assert.equal(left.count, 1); assert.equal(entered.count, 1)
  })
})
