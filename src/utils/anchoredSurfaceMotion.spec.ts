import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnchoredSurfaceMotion, type AnchoredSurfaceKind } from './anchoredSurfaceMotion'

let frames: Map<number, FrameRequestCallback>
let clock: number
let sequence: number
let controllers: ReturnType<typeof createAnchoredSurfaceMotion>[]

function advance(count = 1, interval = 1000 / 60) {
  for (let index = 0; index < count; index++) {
    clock += interval
    const batch = [...frames.values()]
    frames.clear()
    batch.forEach(callback => callback(clock))
  }
}
function settle() {
  for (let index = 0; index < 120 && frames.size; index++) advance()
  expect(frames.size).toBe(0)
}
function fixture(kind: AnchoredSurfaceKind = 'popover', side = 'bottom') {
  const element = document.createElement('div')
  element.className = kind === 'select' ? 'studio-select-content' : `studio-${kind}`
  element.dataset.side = side
  document.body.appendChild(element)
  const controller = createAnchoredSurfaceMotion(kind)
  controllers.push(controller)
  return { element, controller }
}

beforeEach(() => {
  frames = new Map(); clock = 0; sequence = 0; controllers = []
  document.documentElement.dataset.motion = 'full'
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++sequence; frames.set(id, callback); return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})
afterEach(() => {
  controllers.forEach(controller => controller.dispose())
  document.body.innerHTML = ''
  delete document.documentElement.dataset.motion
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('anchored surface motion', () => {
  it.each(['popover', 'select', 'tooltip'] as const)('%s settles and releases its presentation styles', (kind) => {
    const { element, controller } = fixture(kind)
    const done = vi.fn()
    controller.enter(element, done)
    expect(element.style.opacity).toBe('0')
    expect(element.style.willChange).toContain('transform')
    advance(3)
    expect(Number(element.style.opacity)).toBeGreaterThan(0)
    expect(Number(element.style.opacity)).toBeLessThan(1)
    settle()
    expect(done).toHaveBeenCalledOnce()
    expect(element.style.transform).toBe('')
    expect(element.style.opacity).toBe('')
    expect(element.style.willChange).toBe('')
  })

  it.each([
    ['bottom', 'translate(0px, -4px)'], ['top', 'translate(0px, 4px)'],
    ['left', 'translate(4px, 0px)'], ['right', 'translate(-4px, 0px)'],
  ])('moves toward the trigger on the %s side', (side, translation) => {
    const { element, controller } = fixture('popover', side)
    controller.enter(element, () => {})
    expect(element.style.transform).toContain(translation)
  })

  it('leaves the Popper positioning transform and content origin untouched', () => {
    const { element, controller } = fixture()
    const positioning = document.createElement('div')
    positioning.style.transform = 'translate(120px, 240px)'
    element.style.transformOrigin = '20px 0px'
    positioning.append(element); document.body.append(positioning)
    controller.enter(positioning, () => {})
    advance(4)
    expect(positioning.style.transform).toBe('translate(120px, 240px)')
    expect(positioning.style.opacity).toBe('')
    expect(element.style.transformOrigin).toBe('20px 0px')
    settle()
    controller.afterLeave(positioning)
  })

  it('reverses without jumping and releases superseded callbacks once', () => {
    const { element, controller } = fixture()
    const entering = vi.fn(), leaving = vi.fn(), reopened = vi.fn()
    controller.enter(element, entering); advance(4)
    const beforeClose = element.style.transform
    controller.leave(element, leaving)
    expect(element.style.transform).toBe(beforeClose)
    expect(entering).toHaveBeenCalledOnce()
    advance(2)
    const beforeReopen = element.style.transform
    controller.enter(element, reopened)
    expect(element.style.transform).toBe(beforeReopen)
    expect(element.inert).toBe(false)
    expect(leaving).toHaveBeenCalledOnce()
    settle()
    expect(reopened).toHaveBeenCalledOnce()
    expect(entering).toHaveBeenCalledOnce()
    expect(leaving).toHaveBeenCalledOnce()
  })

  it('makes a leaving surface non-interactive and disposes it after leave', () => {
    const { element, controller } = fixture('select')
    controller.enter(element, () => {}); settle()
    const done = vi.fn()
    controller.leave(element, done)
    expect(element.inert).toBe(true)
    expect(element.style.pointerEvents).toBe('none')
    settle()
    expect(done).toHaveBeenCalledOnce()
    expect(element.style.opacity).toBe('0')
    controller.afterLeave(element)
    expect(element.style.transform).toBe('')
    expect(element.style.pointerEvents).toBe('')
    expect(element.inert).toBe(false)
    expect(frames.size).toBe(0)
  })

  it.each(['reduce', 'reduced'])('honours the app %s preference without frames', (mode) => {
    document.documentElement.dataset.motion = mode
    const { element, controller } = fixture()
    const done = vi.fn()
    controller.enter(element, done)
    expect(done).toHaveBeenCalledOnce()
    expect(element.style.transform).toBe('')
    expect(frames.size).toBe(0)
  })

  it('settles immediately when reduced motion is enabled during an animation', () => {
    const { element, controller } = fixture()
    const done = vi.fn()
    controller.enter(element, done); advance(2)
    document.documentElement.dataset.motion = 'reduce'
    window.dispatchEvent(new Event('atelier:motion-preference'))
    expect(done).toHaveBeenCalledOnce()
    expect(element.style.transform).toBe('')
    expect(element.style.willChange).toBe('')
    expect(frames.size).toBe(0)
  })

  it('does not recreate a transform when preference changes at rest', () => {
    const { element, controller } = fixture()
    controller.enter(element, () => {}); settle()
    document.documentElement.dataset.motion = 'reduce'
    window.dispatchEvent(new Event('atelier:motion-preference'))
    expect(element.style.transform).toBe('')
    expect(element.style.opacity).toBe('')
    expect(frames.size).toBe(0)
  })

  it('settles when the document is hidden instead of leaving a queued transition', () => {
    const { element, controller } = fixture()
    const done = vi.fn()
    controller.enter(element, done); advance(2)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(done).toHaveBeenCalledOnce()
    expect(element.style.transform).toBe('')
    expect(frames.size).toBe(0)
  })

  it('restores pre-existing styles and inert state rather than erasing them', () => {
    const { element, controller } = fixture()
    element.style.transform = 'rotate(1deg)'
    element.style.opacity = '0.8'
    element.style.willChange = 'auto'
    element.style.pointerEvents = 'auto'
    element.inert = true
    controller.enter(element, () => {})
    expect(element.style.willChange).toBe('transform, opacity')
    settle()
    expect(element.style.transform).toBe('rotate(1deg)')
    expect(element.style.opacity).toBe('0.8')
    expect(element.style.willChange).toBe('auto')
    expect(element.style.pointerEvents).toBe('auto')
    expect(element.inert).toBe(true)
  })

  it('does not require layout measurements in its frame loop', () => {
    const { element, controller } = fixture()
    const measure = vi.spyOn(element, 'getBoundingClientRect')
    controller.enter(element, () => {}); settle()
    controller.leave(element, () => {}); settle()
    expect(measure).not.toHaveBeenCalled()
  })

  it('bounds work to one queued frame during repeated reversals', () => {
    const { element, controller } = fixture()
    for (let index = 0; index < 100; index++) {
      controller.enter(element, () => {}); advance()
      controller.leave(element, () => {}); advance()
      expect(frames.size).toBeLessThanOrEqual(1)
    }
    controller.enter(element, () => {}); settle()
    expect(element.style.willChange).toBe('')
  })

  it('teardown cancels frames and releases the pending Vue hook exactly once', () => {
    const { element, controller } = fixture()
    const done = vi.fn()
    controller.enter(element, done); advance(2)
    controller.dispose()
    expect(frames.size).toBe(0)
    expect(element.style.transform).toBe('')
    document.documentElement.dataset.motion = 'reduce'
    window.dispatchEvent(new Event('atelier:motion-preference'))
    expect(element.style.transform).toBe('')
    expect(done).toHaveBeenCalledOnce()
    controller.dispose()
    expect(done).toHaveBeenCalledOnce()
  })

  it('releases the hook when a primitive has no matching visible content', () => {
    const controller = createAnchoredSurfaceMotion('popover'); controllers.push(controller)
    const root = document.createElement('div'), done = vi.fn()
    controller.enter(root, done)
    expect(done).toHaveBeenCalledOnce()
    expect(root.style.transform).toBe('')
    expect(frames.size).toBe(0)
  })
})
