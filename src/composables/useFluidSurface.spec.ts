import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { useFluidSurface } from './useFluidSurface'
import { createFluidMotion } from '@/utils/fluidSpring'

describe('useFluidSurface interrupted motion and cleanup', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.motion
  })

  it('applies reduced motion immediately and leaves no spatial transform', () => {
    document.documentElement.dataset.motion = 'reduce'
    const surface = useFluidSurface()
    const el = document.createElement('div')
    document.body.append(el)
    const done = vi.fn()
    surface.enter(el, done)
    expect(done).toHaveBeenCalledOnce()
    expect(el.style.transform).toBe('')
    surface.dispose(el)
  })

  it('keeps native backdrop and content in phase during interrupted motion', () => {
    document.documentElement.dataset.motion = 'full'
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const dialog = document.createElement('dialog'), panel = document.createElement('div')
    panel.className = 'viewer-layout'
    dialog.append(panel); document.body.append(dialog)
    const surface = useFluidSurface('.viewer-layout')
    surface.enter(dialog, () => {})
    frames.shift()!(16); frames.shift()!(32)
    const opacity = Number(dialog.style.opacity)
    expect(opacity).toBeGreaterThan(0)
    expect(opacity).toBeLessThan(1)
    expect(dialog.style.getPropertyValue('--fluid-backdrop-opacity')).toBe(dialog.style.opacity)
    const transform = panel.style.transform
    surface.leave(dialog, () => {})
    expect(panel.style.transform).toBe(transform)
    surface.enter(dialog, () => {})
    expect(panel.style.transform).toBe(transform)
    surface.dispose(dialog)
    expect(dialog.style.getPropertyValue('--fluid-backdrop-opacity')).toBe('')
    expect(panel.style.transform).toBe('')
  })

  it('fades an image preview shell without moving the image trajectory', () => {
    document.documentElement.dataset.motion = 'full'
    const el = document.createElement('dialog')
    el.setAttribute('data-image-transition', '')
    document.body.append(el)
    const surface = useFluidSurface()
    surface.enter(el, () => {})
    expect(el.style.transform).toBe('translateY(0px) scale(1)')
    expect(Number(el.style.opacity)).toBeLessThan(1)
    surface.dispose(el)
  })

  it('drives the native scrim without inherited frame writes and releases temporary compositor hints', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const dialog = document.createElement('dialog')
    dialog.style.willChange = 'scroll-position'
    dialog.getBoundingClientRect = () => ({ width: 960, height: 720 } as DOMRect)
    const animations: Array<{ cancel: ReturnType<typeof vi.fn>; currentTime: number; finished: Promise<Animation> }> = []
    const animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), currentTime: 0, finished: new Promise<Animation>(() => {}) }
      animations.push(animation); return animation
    })
    Object.assign(dialog, { animate })
    document.body.append(dialog)
    const surface = useFluidSurface()
    surface.enter(dialog, () => {})
    expect(animate).toHaveBeenCalledTimes(2)
    expect(animate.mock.calls[1]).toEqual([expect.any(Array), expect.objectContaining({ pseudoElement: '::backdrop' })])
    expect(frames).toHaveLength(0)
    expect(dialog.style.getPropertyValue('--fluid-backdrop-opacity')).toBe('')
    expect(dialog.style.transform).toBe('translateY(0px) scale(1)')
    expect(dialog.style.willChange).toBe('opacity')
    surface.leave(dialog, () => {})
    expect(animate).toHaveBeenCalledTimes(4)
    surface.dispose(dialog)
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true)
    expect(dialog.style.willChange).toBe('scroll-position')
  })

  it('uses a visible source control as the artwork origin and falls back for offscreen sources', () => {
    vi.stubGlobal('innerWidth', 1200)
    vi.stubGlobal('innerHeight', 900)
    const source = document.createElement('button')
    const panel = document.createElement('div')
    panel.className = 'art-viewer'
    document.body.append(source, panel)
    source.getBoundingClientRect = () => ({ x: 100, y: 180, left: 100, top: 180, right: 140, bottom: 220, width: 40, height: 40 } as DOMRect)
    panel.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 } as DOMRect)
    source.focus()
    const surface = useFluidSurface()
    surface.enter(panel, () => {})
    expect(panel.style.transformOrigin).toBe('12% 25%')
    surface.dispose(panel)

    source.getBoundingClientRect = () => ({ x: -100, y: -100, left: -100, top: -100, right: -60, bottom: -60, width: 40, height: 40 } as DOMRect)
    surface.enter(panel, () => {})
    expect(panel.style.transformOrigin).toBe('center center')
    surface.dispose(panel)
  })

  it('completes the superseded transition callback when motion reverses', () => {
    const first = vi.fn(), second = vi.fn()
    const motion = createFluidMotion([1], () => {})
    motion.to([0], false, first)
    motion.to([1], true, second)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    motion.dispose()
  })
})
