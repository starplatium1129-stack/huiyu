import { describe, expect, it, vi } from 'vitest'
import { fluidLens, installFluidGlass, FLUID_GLASS_SELECTOR } from './fluidGlass'

describe('structural glass optics', () => {
  it('includes navigation, floating toolbars and generation bar in FLUID_GLASS_SELECTOR', () => {
    expect(FLUID_GLASS_SELECTOR).toContain('.nav')
    expect(FLUID_GLASS_SELECTOR).toContain('.sticky-toolbar')
    expect(FLUID_GLASS_SELECTOR).toContain('.gen-bar')
    expect(FLUID_GLASS_SELECTOR).toContain('.toolbar-shell')
  })
  it('keeps reading centers and the outer silhouette undistorted', () => {
    expect(fluidLens(300, 100, 20, 150, 50)).toEqual([0, 0])
    expect(fluidLens(300, 100, 20, 0, 50)).toEqual([0, 0])
    expect(fluidLens(300, 100, 20, 0, 0)).toEqual([0, 0])
  })
  it('refracts opposite edges symmetrically and bounds corner displacement', () => {
    const left = fluidLens(300, 100, 20, 5, 50)
    const right = fluidLens(300, 100, 20, 295, 50)
    expect(Math.abs(left[0])).toBeGreaterThan(1)
    expect(left[0]).toBeCloseTo(-right[0])
    expect(left[1]).toBeCloseTo(0)
    for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
      for (const value of fluidLens(300, 100, 20, x, y)) {
        expect(Number.isFinite(value)).toBe(true)
        expect(Math.abs(value)).toBeLessThanOrEqual(15)
      }
    }
  })
  it('handles degenerate surfaces and an unsupported rendering environment', () => {
    expect(fluidLens(0, 0, 20, 0, 0)).toEqual([0, 0])
    expect(() => installFluidGlass()()).not.toThrow()
  })
  it('allocates optics only on explicit opt-in and releases them when returning to light', async () => {
    const disconnect = vi.fn()
    const surface = document.createElement('div')
    surface.className = 'sticky-toolbar'
    document.body.append(surface)
    Object.defineProperties(surface, { offsetWidth: { value: 100 }, offsetHeight: { value: 40 } })
    vi.spyOn(surface, 'getClientRects').mockReturnValue([{ width: 100, height: 40 }] as unknown as DOMRectList)
    vi.stubGlobal('CSS', { supports: () => true })
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect = disconnect })
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe(target: Element) { this.callback([{ target, isIntersecting: true }]) }
      unobserve() {}
      disconnect = disconnect
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData() {},
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,test')
    vi.useFakeTimers()
    let dispose = () => {}
    try {
      document.documentElement.dataset.glassMaterial = 'light'
      document.documentElement.dataset.fluidEffects = 'full'
      document.documentElement.dataset.reducedGlass = 'false'
      dispose = installFluidGlass()
      expect(document.querySelector('.fluid-glass-definitions')).toBeNull()
      expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled()
      document.documentElement.dataset.glassMaterial = 'liquid'
      await vi.waitFor(() => expect(document.querySelector('.fluid-glass-definitions')).not.toBeNull())
      vi.advanceTimersByTime(100)
      expect(surface.hasAttribute('data-fluid-refracted')).toBe(true)
      expect(document.querySelectorAll('.fluid-glass-definitions filter')).toHaveLength(1)
      expect(installFluidGlass()).toBe(dispose)
      document.documentElement.dataset.glassMaterial = 'light'
      await vi.waitFor(() => expect(document.querySelector('.fluid-glass-definitions')).toBeNull())
      expect(surface.hasAttribute('data-fluid-refracted')).toBe(false)
      expect(surface.style.getPropertyValue('--fluid-glass-filter')).toBe('')
      expect(document.querySelector('.fluid-glass-definitions')).toBeNull()
      expect(disconnect).toHaveBeenCalledTimes(2)
      dispose()
      document.documentElement.dataset.glassMaterial = 'liquid'
      dispose = installFluidGlass()
      await vi.waitFor(() => expect(document.querySelectorAll('.fluid-glass-definitions')).toHaveLength(1))
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(document.querySelector('.fluid-glass-definitions')).toBeNull()
      hidden.mockReturnValue(false)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(document.querySelectorAll('.fluid-glass-definitions')).toHaveLength(1)
    } finally {
      dispose(); surface.remove(); delete document.documentElement.dataset.glassMaterial; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
    }
  })
})
