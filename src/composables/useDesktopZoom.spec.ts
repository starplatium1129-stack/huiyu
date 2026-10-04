import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDesktopZoom, useDesktopZoom } from './useDesktopZoom'
import { desktopWindowZoom, readDesktopBootstrap } from '@/platform/desktop/bootstrap'

vi.mock('@/platform/desktop/bootstrap', () => ({
  readDesktopBootstrap: vi.fn(),
  desktopWindowZoom: { getWindowZoom: vi.fn(), setWindowZoom: vi.fn() },
}))

let stop: (() => void) | undefined
afterEach(() => { stop?.(); stop = undefined; delete (window as unknown as Record<string, unknown>).__TAURI__; vi.resetAllMocks() })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function desktop(role: 'atelier' | 'companion' = 'atelier') {
  Object.defineProperty(window, '__TAURI__', { configurable: true, value: {} })
  vi.mocked(readDesktopBootstrap).mockResolvedValue({
    protocolVersion: 1, windowRole: role, connection: 'ready',
    windowId: role, sourceProfileId: `profile-${'a'.repeat(64)}`, sourceOrigin: 'http://127.0.0.1:4312',
    bundledUiAvailable: false,
    runtime: { origin: 'http://127.0.0.1:4312', protocolVersion: 1, ownership: 'managed', runtimeEpoch: 'epoch-1', workspace: null },
  })
  vi.mocked(desktopWindowZoom.getWindowZoom).mockResolvedValue(1)
}

describe('native zoom input', () => {
  it('coalesces fast keyboard input while the native response is pending', async () => {
    let complete: ((value: number) => void) | undefined
    desktop()
    const setWindowZoom = vi.mocked(desktopWindowZoom.setWindowZoom)
      .mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
      .mockImplementation(async value => value)
    stop = installDesktopZoom(); await tick()
    for (let i = 0; i < 3; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true }))
    expect(setWindowZoom).toHaveBeenCalledTimes(1)
    complete!(1.1); await tick()
    expect(setWindowZoom.mock.calls.map(call => call[0])).toEqual([1.1, 1.3])
    expect(useDesktopZoom().zoom.value).toBe(1.3)
  })
  it.each(['successful', 'failed'])('a %s response from a disposed installation cannot overwrite the current zoom or drop its queued input', async outcome => {
    desktop()
    let resolveOld!: (value: number) => void, rejectOld!: (reason: Error) => void
    let resolveCurrent: ((value: number) => void) | undefined
    const setWindowZoom = vi.mocked(desktopWindowZoom.setWindowZoom)
      .mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject }))
      .mockImplementation(() => new Promise(resolve => { resolveCurrent = resolve }))
    stop = installDesktopZoom(); await tick()
    useDesktopZoom().setZoom(1.2)
    stop()
    vi.mocked(desktopWindowZoom.getWindowZoom).mockResolvedValue(1.5)
    stop = installDesktopZoom(); await tick()
    useDesktopZoom().setZoom(1.7)
    try {
      expect(setWindowZoom).toHaveBeenCalledOnce()
      if (outcome === 'successful') resolveOld(1.2)
      else rejectOld(new Error('disposed zoom failed'))
      await tick()
      expect(setWindowZoom.mock.calls.map(call => call[0])).toEqual([1.2, 1.7])
      expect(useDesktopZoom().zoom.value).toBe(1.5)
      expect(useDesktopZoom().error.value).toBe('')
      resolveCurrent!(1.7); await tick()
      expect(useDesktopZoom().zoom.value).toBe(1.7)
    } finally { resolveCurrent?.(1.7); await tick() }
  })
  it('leaves normal browser shortcuts untouched without the native capability', () => {
    stop = installDesktopZoom()
    const event = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
  it('does not enable zoom for the host companion role even when the page path is different', async () => {
    desktop('companion')
    stop = installDesktopZoom(); await tick()
    expect(desktopWindowZoom.getWindowZoom).not.toHaveBeenCalled()
    expect(useDesktopZoom().available.value).toBe(false)
  })
})
