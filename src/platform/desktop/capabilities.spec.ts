import { afterEach, expect, it, vi } from 'vitest'
import { getDesktopCapabilities, onDesktopNavigate } from './capabilities'

const role = vi.hoisted(() => ({ value: '' }))
vi.mock('./runtime.ts', () => ({ getDesktopWindowRole: () => role.value }))
afterEach(() => vi.unstubAllGlobals())

it('returns native window command promises so callers can observe IPC failures', async () => {
  const invoke = vi.fn().mockRejectedValue(new Error('IPC unavailable'))
  vi.stubGlobal('window', { __TAURI__: { core: { invoke } } })
  const desktop = getDesktopCapabilities()!
  for (const method of ['minimizeWindow', 'toggleMaximizeWindow', 'closeWindow'] as const) {
    await expect(desktop[method]()).rejects.toThrow('IPC unavailable')
  }
  expect(invoke.mock.calls).toEqual([['window_minimize'], ['window_maximize_toggle'], ['window_close']])
})

it('routes a host broadcast only to the atelier, including after bootstrap recovers', async () => {
  let deliver: ((event: { payload: string }) => void) | undefined
  const remove = vi.fn(), navigate = vi.fn()
  vi.stubGlobal('window', { __TAURI__: { event: { listen: async (_name: string, listener: typeof deliver) => {
    deliver = listener; return remove
  } } } })
  const stop = onDesktopNavigate(navigate)
  for (const value of ['', 'companion', 'companion-chat']) {
    role.value = value
    deliver!({ payload: '/gallery' })
  }
  expect(navigate).not.toHaveBeenCalled()
  role.value = 'atelier'
  deliver!({ payload: '/gallery' })
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/gallery')
  stop()
  await Promise.resolve()
  expect(remove).toHaveBeenCalledOnce()
})

it('uses the native workspace picker without saving the selected directory', async () => {
  const invoke = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('E:\\AI files')
  vi.stubGlobal('window', { __TAURI__: { core: { invoke } } })
  const desktop = getDesktopCapabilities()!
  expect(await desktop.pickWorkspace('D:\\AI')).toBeNull()
  expect(await desktop.pickWorkspace('D:\\AI')).toBe('E:\\AI files')
  expect(invoke.mock.calls).toEqual([
    ['pick_workspace', { root: 'D:\\AI' }], ['pick_workspace', { root: 'D:\\AI' }],
  ])
})
