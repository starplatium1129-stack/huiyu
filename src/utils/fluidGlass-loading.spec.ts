import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  delete document.documentElement.dataset.glassMaterial
  delete document.documentElement.dataset.fluidEffects
  vi.doUnmock('./fluidGlassRenderer')
  vi.resetModules()
})

describe('deferred glass renderer', () => {
  it.each(['disabled', 'disposed'])('does not mount a late renderer after it is %s', async mode => {
    vi.resetModules()
    let complete!: (renderer: { mountFluidGlass: () => () => void }) => void
    const loaded = new Promise<{ mountFluidGlass: () => () => void }>(resolve => { complete = resolve })
    const requested = vi.fn(() => loaded)
    vi.doMock('./fluidGlassRenderer', requested)
    const { installFluidGlass } = await import('./fluidGlass')
    document.documentElement.dataset.glassMaterial = 'liquid'
    document.documentElement.dataset.fluidEffects = 'full'
    const stop = installFluidGlass()
    try {
      await vi.waitFor(() => expect(requested).toHaveBeenCalledOnce())
      if (mode === 'disposed') stop()
      else document.documentElement.dataset.glassMaterial = 'light'
      const mount = vi.fn(() => vi.fn())
      complete({ mountFluidGlass: mount })
      await vi.dynamicImportSettled()
      expect(mount).not.toHaveBeenCalled()
    } finally { stop() }
  })
})
