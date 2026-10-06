import { describe, expect, it, vi } from 'vitest'
import { installFluidGlass } from './fluidGlass'

describe('native glass presentation', () => {
  it('keeps bitmap/SVG work absent, shares one light, and releases it on scroll or mode changes', async () => {
    const surfaces = ['nav', 'sticky-toolbar'].map(className => {
      const element = document.createElement('div'); element.className = className
      element.textContent = 'Original readable text'; document.body.append(element)
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 40))
      return element
    })
    vi.stubGlobal('CSS', { supports: () => true })
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    const root = document.documentElement
    let dispose = () => {}
    const move = (element: HTMLElement) => element.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 10 }))
    try {
      root.dataset.glassMaterial = 'light'; root.dataset.fluidEffects = 'full'; root.dataset.reducedGlass = 'false'
      dispose = installFluidGlass()
      expect(document.querySelector('.fluid-glass-optics')).toBeNull()
      root.dataset.glassMaterial = 'liquid'
      await vi.waitFor(() => { move(surfaces[0]); expect(surfaces[0].querySelector('.fluid-glass-optics')).not.toBeNull() })
      expect(canvas).not.toHaveBeenCalled()
      expect(document.querySelector('svg filter')).toBeNull()
      move(surfaces[1])
      expect(document.querySelectorAll('.fluid-glass-optics')).toHaveLength(1)
      expect(surfaces[0].querySelector('.fluid-glass-optics')).toBeNull()
      expect(surfaces[1].textContent).toBe('Original readable text')
      window.dispatchEvent(new Event('scroll'))
      expect(document.querySelector('.fluid-glass-optics')).toBeNull()
      move(surfaces[0]); root.dataset.glassMaterial = 'light'
      await vi.waitFor(() => expect(document.querySelector('.fluid-glass-optics')).toBeNull())
      expect(surfaces.every(element => !element.classList.contains('fluid-glass-lit'))).toBe(true)
      expect(installFluidGlass()).toBe(dispose)
    } finally {
      dispose(); surfaces.forEach(element => element.remove()); delete root.dataset.glassMaterial
      vi.unstubAllGlobals(); vi.restoreAllMocks()
    }
  })
})
