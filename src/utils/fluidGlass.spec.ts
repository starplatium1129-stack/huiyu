import { describe, expect, it, vi } from 'vitest'
import { installFluidGlass } from './fluidGlass'
import { fluidLens, fluidMapSize } from './fluidGlassRenderer'

describe('structural glass optics', () => {
  it('preserves short-axis detail for wide toolbars within the shared pixel budget', () => {
    const wide = fluidMapSize(3840, 80)
    expect(wide[0]).toBeGreaterThan(1500)
    expect(wide[1]).toBeGreaterThanOrEqual(64)
    for (const [w, h] of [[3840, 80], [4000, 1800], [480, 320]]) {
      const [width, height] = fluidMapSize(w, h)
      expect(width * height).toBeLessThanOrEqual(160000)
    }
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
    const surfaces = ['nav', 'sticky-toolbar', 'gen-bar', 'toolbar-shell'].map(className => {
      const surface = document.createElement('div')
      surface.className = className
      document.body.append(surface)
      Object.defineProperties(surface, { offsetWidth: { value: 100 }, offsetHeight: { value: 40 } })
      vi.spyOn(surface, 'getClientRects').mockReturnValue([{ width: 100, height: 40 }] as unknown as DOMRectList)
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 40))
      return surface
    })
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
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['test'], { type: 'image/png' })))
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
      document.documentElement.dataset.theme = 'light'
      document.documentElement.style.setProperty('--glass-tint', '.35')
      await vi.waitFor(() => expect(document.querySelector('.fluid-glass-definitions')).not.toBeNull())
      vi.advanceTimersByTime(100)
      await vi.waitFor(() => expect(surfaces.every(surface => surface.hasAttribute('data-fluid-refracted'))).toBe(true))
      expect(document.querySelectorAll('.fluid-glass-definitions filter')).toHaveLength(surfaces.length)
      expect(document.querySelectorAll('.fluid-glass-optics')).toHaveLength(surfaces.length)
      expect(document.querySelector('.fluid-glass-optics canvas')).toBeNull()
      const curve = () => document.querySelector('feFuncR')!.getAttribute('tableValues')!.split(' ').map(Number)
      expect(curve()[4]).toBe(.5)
      expect(curve()[8]).toBe(1)
      document.documentElement.dataset.theme = 'dark'
      await vi.waitFor(() => expect(curve()[8]).toBeLessThan(1))
      expect(curve()[4]).toBe(.5)
      document.documentElement.style.setProperty('--glass-tint', '1')
      await vi.waitFor(() => expect(curve()[8]).toBeGreaterThan(.9))
      const beam = surfaces[0].querySelector<HTMLElement>('.fluid-glass-sheen')!
      surfaces[0].dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 10 }))
      expect(Number(beam.style.opacity)).toBeCloseTo(.22)
      surfaces[0].dispatchEvent(new MouseEvent('pointerdown'))
      expect(document.querySelector('feDisplacementMap')?.getAttribute('scale')).toBe('35.2')
      window.dispatchEvent(new MouseEvent('pointerup'))
      expect(document.querySelector('feDisplacementMap')?.getAttribute('scale')).toBe('32')
      expect(installFluidGlass()).toBe(dispose)
      document.documentElement.dataset.glassMaterial = 'light'
      await vi.waitFor(() => expect(document.querySelector('.fluid-glass-definitions')).toBeNull())
      expect(document.querySelector('.fluid-glass-optics')).toBeNull()
      for (const surface of surfaces) {
        expect(surface.hasAttribute('data-fluid-refracted')).toBe(false)
        expect(surface.style.getPropertyValue('--fluid-glass-filter')).toBe('')
      }
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
      dispose(); surfaces.forEach(surface => surface.remove()); delete document.documentElement.dataset.glassMaterial; document.documentElement.style.removeProperty('--glass-tint'); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
    }
  })
})
