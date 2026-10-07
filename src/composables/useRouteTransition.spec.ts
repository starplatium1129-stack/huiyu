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
vi.mock('@/utils/motionPreference', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/motionPreference')>(), prefersReducedMotion: () => state.reduced,
}))
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
    querySelectorAll: () => [],
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
  it('continues from the displayed archive frame when its entrance is interrupted', () => {
    let destination = '/character'
    const hooks = useRouteTransition(() => destination), previous = surface('/popular-scenes'), page = surface('/character')
    const entered = counter(), left = counter()
    hooks.onLeave(previous.el, () => {}); hooks.onEnter(page.el, entered.done)
    vi.stubGlobal('getComputedStyle', () => ({ opacity: '.34', transform: 'matrix(1, 0, 0, 1, 3, 0)' }))
    hooks.onEnterCancelled(page.el); destination = '/popular-scenes'
    hooks.onLeave(page.el, left.done)
    assert.equal(entered.count, 1)
    assert.deepEqual(page.calls[1][0], [
      { opacity: .34, transform: 'matrix(1, 0, 0, 1, 3, 0)' },
      { opacity: 0, transform: 'matrix(1, 0, 0, 1, 3, 0)' },
    ])
    page.animations[1].onfinish!(); assert.equal(left.count, 1)
  })

  it('reverses a partially faded archive page from its displayed opacity', () => {
    let destination = '/character'
    const hooks = useRouteTransition(() => destination), page = surface('/popular-scenes'), left = counter()
    hooks.onLeave(page.el, left.done)
    vi.stubGlobal('getComputedStyle', () => ({ opacity: '.27', transform: 'none' }))
    hooks.onLeaveCancelled(page.el); destination = '/popular-scenes'; hooks.onBeforeEnter(page.el)
    const returned = counter(); hooks.onEnter(page.el, returned.done)
    assert.deepEqual(page.calls[1][0], [{ opacity: .27 }, { opacity: 1 }])
    assert.equal(page.el.inert, false); assert.equal(left.count, 1)
    page.animations[1].onfinish!(); assert.equal(returned.count, 1)
  })

  it('fades all workspaces, including cached returns, without waiting for a heading', () => {
    let destination = '/gallery'
    const hooks = useRouteTransition(() => destination), gallery = surface('/gallery'), style = surface('/style')
    const first = counter(), second = counter(), returned = counter()
    const readingSurface = document.createElement('div')
    readingSurface.getBoundingClientRect = () => ({ width: 400, height: 200, top: 0, bottom: 200 } as DOMRect)
    readingSurface.animate = vi.fn(() => new AnimationStub() as unknown as Animation)
    gallery.el.querySelectorAll = (() => [readingSurface]) as unknown as typeof gallery.el.querySelectorAll
    hooks.onEnter(gallery.el, first.done)
    assert.equal(first.count, 0); gallery.animations[0].onfinish!()
    destination = '/style'; hooks.onLeave(gallery.el, () => {}); hooks.onEnter(style.el, second.done)
    assert.equal(second.count, 0); style.animations[0].onfinish!()
    destination = '/gallery'; hooks.onLeave(style.el, () => {}); hooks.onEnter(gallery.el, returned.done)
    assert.equal(returned.count, 0); gallery.animations[2].onfinish!()
    assert.equal(first.count, 1); assert.equal(second.count, 1); assert.equal(returned.count, 1)
    assert.equal(gallery.el.inert, false)
    assert.equal(gallery.animations.length + style.animations.length, 5)
    assert.deepEqual(gallery.calls[2][0], [{ opacity: 0 }, { opacity: 1 }])
    assert.equal(vi.mocked(readingSurface.animate).mock.calls.length, 1)
  })

  it('hands page entry to an immediate pointer or keyboard operation before its panel updates', () => {
    const hooks = useRouteTransition(() => '/gallery')
    for (const callback of state.mounted.splice(0)) callback()
    for (const type of ['pointerdown', 'keydown']) {
      const el = document.createElement('article'), button = document.createElement('button')
      const animation = new AnimationStub(), contentAnimation = new AnimationStub(), done = counter()
      button.dataset.routeArrive = ''
      button.getBoundingClientRect = () => ({ width: 400, height: 200, top: 0, bottom: 200 } as DOMRect)
      button.animate = vi.fn(() => contentAnimation as unknown as Animation)
      el.animate = vi.fn(() => animation as unknown as Animation)
      el.append(button); document.body.append(el)
      hooks.onBeforeEnter(el); hooks.onEnter(el, done.done)
      assert.equal(el.dataset.routeEntering, 'true')
      button.dispatchEvent(new Event(type, { bubbles: true }))
      assert.equal(done.count, 0)
      assert.equal(el.dataset.routeEntering, undefined)
      assert.equal(el.inert, false)
      assert.equal(animation.cancelCalls, 0)
      assert.equal(contentAnimation.cancelCalls, 1)
      animation.onfinish!()
      assert.equal(done.count, 1)
      assert.equal(contentAnimation.cancelCalls, 1)
      el.remove()
    }
  })

  it('crossfades peer workspaces without translating fixed controls or delaying destination input', () => {
    let destination = '/style'
    const hooks = useRouteTransition(() => destination), style = surface('/style'), scene = surface('/scene-explorer')
    hooks.onEnter(style.el, () => {})
    const left = counter(), entered = counter()
    destination = '/scene-explorer'; hooks.onLeave(style.el, left.done); hooks.onEnter(scene.el, entered.done)
    assert.equal(left.count, 0); assert.equal(entered.count, 0); assert.equal(scene.el.inert, false)
    scene.animations[0].onfinish!(); style.animations[1].onfinish!()
    assert.equal(left.count, 1); assert.equal(entered.count, 1)
    assert.deepEqual(style.calls[0][0], [{ opacity: 0 }, { opacity: 1 }])
    assert.deepEqual(scene.calls[0][0], [{ opacity: 0 }, { opacity: 1 }])
  })

  it('uses one page effect without replaying queries or retaining departed pages', () => {
    let destination = '/gallery'
    const hooks = useRouteTransition(() => destination), page = surface('/gallery')
    const entered = counter()
    hooks.onEnter(page.el, entered.done)
    assert.equal(page.el.inert, false)
    assert.equal(page.calls.length, 1)
    assert.equal((page.calls[0][1] as KeyframeAnimationOptions).delay, undefined)
    page.animations[0].onfinish!(); assert.equal(entered.count, 1)
    assert.equal(page.animations[0].cancelCalls, 1)

    destination = '/style'; hooks.onLeave(page.el, () => {})
    hooks.onLeave(surface('/style').el, () => {})
    destination = '/gallery'
    const returned = counter(); hooks.onEnter(page.el, returned.done)
    assert.deepEqual(page.calls[2][0], [{ opacity: 0 }, { opacity: 1 }])
    assert.equal((page.calls[2][1] as KeyframeAnimationOptions).duration, 280)
    page.el.dataset.routePath = '/gallery?filter=recent'
    const queryRefresh = counter(); hooks.onEnter(page.el, queryRefresh.done)
    assert.equal(queryRefresh.count, 1); assert.equal(page.calls.length, 3)
    destination = '/scene-explorer'; const left = counter(); hooks.onLeave(page.el, left.done)
    assert.equal(left.count, 0); page.animations[3].onfinish!()
    assert.equal(left.count, 1); assert.equal(returned.count, 1)
    assert.equal(page.animations[2].cancelCalls, 1)
    assert.equal(page.el.dataset.routeEntering, undefined)
  })

  it('fades standalone layouts without translating native overlay anchors', () => {
    const hooks = useRouteTransition(() => '/control', { initialFade: true }), { el, calls } = surface()
    el.dataset.routePath = '/control'
    hooks.onEnter(el, () => {})
    assert.deepEqual(calls[0][0], [{ opacity: 0 }, { opacity: 1 }])
    hooks.onEnterCancelled(el)
  })

  it('does not retain departing peer pages during rapid navigation', () => {
    let destination = '/style'
    const hooks = useRouteTransition(() => destination), first = surface('/gallery'), second = surface('/style')
    const leftFirst = counter(), leftSecond = counter()
    hooks.onLeave(first.el, leftFirst.done)
    destination = '/lora'; hooks.onLeave(second.el, leftSecond.done)
    assert.equal(leftFirst.count, 1); assert.equal(leftSecond.count, 0)
    assert.equal(first.animations.length + second.animations.length, 2); assert.equal(first.animations[0].cancelCalls, 1)
    hooks.onLeaveCancelled(second.el); assert.equal(second.el.inert, false); assert.equal(leftSecond.count, 1)
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
    assert.deepEqual(oldPage.calls[0], [[{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: 'cubic-bezier(.22, 1, .36, 1)' }])
    assert.deepEqual(newPage.calls[0][0], [{ opacity: 0, transform: 'translateX(8px)' }, { opacity: 1, transform: 'translateX(0)' }])
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
      { duration: 180, easing: 'cubic-bezier(.22, 1, .36, 1)' },
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

  it('skips a cached element entrance but animates a replacement at the same URL', () => {
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
    const replacement = surface(el.dataset.routePath), fresh = counter()
    hooks.onEnter(replacement.el, fresh.done)
    assert.equal(replacement.animations.length, 1)
    assert.equal(fresh.count, 0)
    replacement.animations[0].onfinish!()
    assert.equal(fresh.count, 1)
  })

  it('cleans a cached layout exit when its inner route owns the returning animation', () => {
    const hooks = useRouteTransition(() => '/control'), { el, calls } = surface(), entered = counter(), left = counter()
    hooks.onEnter(el, entered.done)
    hooks.onLeave(el, left.done)
    assert.equal(el.inert, true); assert.equal(entered.count, 1); assert.equal(left.count, 0)
    vi.stubGlobal('getComputedStyle', () => ({ opacity: '.27', transform: 'none' }))
    hooks.onLeaveCancelled(el); hooks.onBeforeEnter(el)
    const returned = counter(); hooks.completeEnter(el, returned.done)
    assert.equal(el.inert, false); assert.equal(el.dataset.routeEntering, undefined)
    assert.equal(returned.count, 1); assert.equal(left.count, 1)
    hooks.onLeave(el, () => {})
    assert.deepEqual(calls[2][0], [{ opacity: 1 }, { opacity: 0 }])
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

  it('settles both route callbacks when the tab hides and skips hidden navigation', () => {
    const hooks = useRouteTransition(() => '/character')
    for (const callback of state.mounted.splice(0)) callback()
    const oldPage = surface('/popular-scenes'), newPage = surface('/character'), left = counter(), entered = counter()
    hooks.onLeave(oldPage.el, left.done); hooks.onBeforeEnter(newPage.el); hooks.onEnter(newPage.el, entered.done)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(left.count, 1); assert.equal(entered.count, 1)
    assert.equal(newPage.el.dataset.routeEntering, undefined)
    assert.equal(oldPage.animations[0].cancelCalls, 1)
    assert.equal(newPage.animations[0].cancelCalls, 1)
    const hiddenPage = surface('/popular-scenes'), hiddenEnter = counter(), hiddenLeave = counter()
    hooks.onBeforeEnter(hiddenPage.el); hooks.onEnter(hiddenPage.el, hiddenEnter.done)
    hooks.onLeave(hiddenPage.el, hiddenLeave.done)
    assert.equal(hiddenEnter.count, 1); assert.equal(hiddenLeave.count, 1)
    assert.equal(hiddenPage.animations.length, 0)
    assert.equal(hiddenPage.el.dataset.routeEntering, undefined)
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    const visiblePage = surface('/character'), visibleEnter = counter()
    hooks.onEnter(visiblePage.el, visibleEnter.done)
    assert.equal(visibleEnter.count, 0)
    visiblePage.animations[0].onfinish!()
    unmount()
    // A removed listener must not settle motion started after teardown.
    const detached = surface('/character'), detachedEnter = counter()
    hooks.onEnter(detached.el, detachedEnter.done)
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(detachedEnter.count, 0)
    detached.animations[0].onfinish!()
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

  it('crossfades peer workspaces while keeping destination input enabled', () => {
    const hooks = useRouteTransition(() => '/style'), oldPage = surface('/gallery'), newPage = surface('/style')
    const left = counter(), entered = counter()
    hooks.onLeave(oldPage.el, left.done); hooks.onEnter(newPage.el, entered.done)
    assert.equal(oldPage.el.inert, true); assert.equal(newPage.el.inert, false)
    assert.equal(left.count, 0); assert.equal(entered.count, 0)
    assert.equal(oldPage.animations.length, 1); assert.equal(newPage.animations.length, 1)
    assert.deepEqual(oldPage.calls[0], [[{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'cubic-bezier(.22, 1, .36, 1)' }])
    hooks.onLeaveCancelled(oldPage.el); hooks.onEnterCancelled(newPage.el)
    assert.equal(left.count, 1); assert.equal(entered.count, 1)
  })

  it('also fades an unranked workspace without a separate navigation registration', () => {
    const hooks = useRouteTransition(() => '/new-workspace'), oldPage = surface('/gallery'), newPage = surface('/new-workspace')
    hooks.onLeave(oldPage.el, () => {}); hooks.onEnter(newPage.el, () => {})
    assert.deepEqual(newPage.calls[0][0], [{ opacity: 0 }, { opacity: 1 }])
    assert.deepEqual(oldPage.calls[0][0], [{ opacity: 1 }, { opacity: 0 }])
  })

  it('fades AppLayout content on initial paint and later navigation without blocking input', () => {
    const hooks = useRouteTransition(() => '/style', { initialFade: true })
    const oldPage = surface('/gallery'), newPage = surface('/style'), first = counter(), second = counter()
    hooks.onEnter(oldPage.el, first.done)
    hooks.onLeave(oldPage.el, () => {}); hooks.onEnter(newPage.el, second.done)
    assert.equal(first.count, 1); assert.equal(second.count, 0)
    assert.equal(oldPage.el.inert, true); assert.equal(newPage.el.inert, false)
    assert.deepEqual(oldPage.calls[0][0], [{ opacity: 0 }, { opacity: 1 }])
    assert.deepEqual(newPage.calls[0][0], [{ opacity: 0 }, { opacity: 1 }])
    newPage.animations[0].onfinish!(); assert.equal(second.count, 1)
  })

  it('settles both halves of the depth transition immediately when reduced motion changes', () => {
    const events = browser(), hooks = useRouteTransition(() => '/character')
    for (const callback of state.mounted.splice(0)) callback()
    const oldPage = surface('/popular-scenes'), newPage = surface('/character'), left = counter(), entered = counter()
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
