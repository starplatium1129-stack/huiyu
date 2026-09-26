import { afterEach, expect, it, vi } from 'vitest'
import { onDesktopNavigate } from './capabilities'

const role = vi.hoisted(() => ({ value: '' }))
vi.mock('./runtime.ts', () => ({ getDesktopWindowRole: () => role.value }))
afterEach(() => vi.unstubAllGlobals())

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
