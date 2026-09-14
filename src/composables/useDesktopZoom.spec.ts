import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDesktopZoom, useDesktopZoom } from './useDesktopZoom'

let stop: (() => void) | undefined
afterEach(() => { stop?.(); stop = undefined; delete (window as unknown as Record<string, unknown>).companionDesktop })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('native zoom input', () => {
  it('coalesces fast keyboard input while the native response is pending', async () => {
    let complete: ((value: number) => void) | undefined
    const setWindowZoom = vi.fn<(value: number) => Promise<number>>()
      .mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
      .mockImplementation(async value => value)
    Object.defineProperty(window, 'companionDesktop', { configurable: true, value: { getWindowZoom: async () => 1, setWindowZoom } })
    stop = installDesktopZoom(); await tick()
    for (let i = 0; i < 3; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true }))
    expect(setWindowZoom).toHaveBeenCalledTimes(1)
    complete!(1.1); await tick()
    expect(setWindowZoom.mock.calls.map(call => call[0])).toEqual([1.1, 1.3])
    expect(useDesktopZoom().zoom.value).toBe(1.3)
  })
  it('leaves normal browser shortcuts untouched without the native capability', () => {
    stop = installDesktopZoom()
    const event = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
