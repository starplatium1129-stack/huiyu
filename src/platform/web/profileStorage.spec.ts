import { afterEach, expect, it, vi } from 'vitest'
import type { ProfilePort } from './profileStorage'

afterEach(() => { vi.resetModules(); localStorage.clear(); sessionStorage.clear() })

it('keeps Web local/session domains and switches actual setting and draft consumers without replaying old values', async () => {
  const module = await import('./profileStorage')
  module.profileLocalStorage.setItem('aics_theme', 'light')
  expect(localStorage.getItem('aics_theme')).toBe('light')
  const port = fakePort()
  await module.activateProfileStorage(port, 'main')
  expect(module.profileLocalStorage.getItem('aics_theme')).toBe('dark')
  module.profileLocalStorage.setItem('aics_theme', 'light')
  module.profileDraftStorage.setItem('aics_video_draft_v1', '{"prompt":"new"}')
  await module.flushProfileWrites()
  expect(port.saveSetting).toHaveBeenCalledWith(expect.objectContaining({ key: 'aics_theme', expectedRevision: 7 }))
  expect(port.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ windowId: 'main', expectedReset: 'reset-1' }))
  expect(sessionStorage.getItem('aics_video_draft_v1')).toBeNull()
})

it('retries a lost receipt with the same operation and retains pending data rather than writing an alternate browser authority', async () => {
  const module = await import('./profileStorage')
  const port = fakePort()
  vi.mocked(port.saveSetting).mockRejectedValueOnce(new Error('receipt lost'))
  await module.activateProfileStorage(port, 'main')
  module.profileLocalStorage.setItem('aics_theme', 'light')
  await expect(module.flushProfileWrites()).rejects.toThrow('receipt lost')
  expect(module.profileLocalStorage.getItem('aics_theme')).toBe('light')
  expect(localStorage.getItem('aics_theme')).toBeNull()
  await module.flushProfileWrites()
  const calls = vi.mocked(port.saveSetting).mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[1][0]).toEqual(calls[0][0])
})

it('blocks offline desktop startup writes before hydration without losing the readable old source', async () => {
  localStorage.setItem('aics_theme', 'dark')
  const module = await import('./profileStorage')
  module.setProfileConnectionBlocked(true)
  expect(() => module.profileLocalStorage.setItem('aics_theme', 'light')).toThrow('连接尚未确认')
  expect(module.profileLocalStorage.getItem('aics_theme')).toBe('dark')
  expect(localStorage.getItem('aics_theme')).toBe('dark')
  module.setProfileConnectionBlocked(false)
  module.profileLocalStorage.setItem('aics_theme', 'light')
  expect(localStorage.getItem('aics_theme')).toBe('light')
})

function fakePort(): ProfilePort {
  const snapshot = { records: [], revision: 7, resetRevision: 'reset-1' }
  return {
    readSettings: vi.fn(async () => ({ ...snapshot, records: [{ key: 'aics_theme', value: 'dark', revision: 7 }] })),
    readChat: vi.fn(async () => snapshot), readDrafts: vi.fn(async () => snapshot),
    saveSetting: vi.fn(async input => ({ key: input.key, value: input.value, revision: 8 })),
    saveChatRecord: vi.fn(async input => ({ key: input.key, value: input.value, revision: 8 })),
    saveDraft: vi.fn(async input => ({ key: input.key, value: input.value, revision: 9 })),
    resetChat: vi.fn(async () => ({ ...snapshot, resetRevision: 'reset-2' })),
  }
}
