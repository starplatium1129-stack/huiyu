vi.mock('virtual:data-version', () => ({ DATA_VERSION: 0 }))
import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { UseRoomMemoryOptions } from './useRoomMemory'
import type { ProfilePort } from '@/platform/web/profileStorage'
import { CHAT_USER_PROFILE_KEY } from '@/utils/storageKeys'

const submitted = { callName: 'Fixture', relationship: 'friend' as const, note: '' }
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); localStorage.clear() })
async function memory(canWrite = vi.fn(() => true)) {
  const { useRoomMemory } = await import('./useRoomMemory')
  const setError = vi.fn()
  return { ...useRoomMemory({ storage: { canWrite } as unknown as UseRoomMemoryOptions['storage'], activeChar: ref('nene'),
    setError, stopEverything: vi.fn(), voice: { stop: vi.fn() }, clearDraftInput: vi.fn() }), setError }
}

it('returns failure for a blocked or failed browser write without reporting success', async () => {
  const blocked = await memory(vi.fn(() => false))
  expect(await blocked.updateUserProfile(submitted)).toBe(false)
  expect(localStorage.getItem(CHAT_USER_PROFILE_KEY)).toBeNull()
  const room = await memory()
  vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('quota fixture') })
  expect(await room.updateUserProfile(submitted)).toBe(false)
  expect(room.userProfile.value.callName).toBe('')
  expect(room.setError).not.toHaveBeenCalledWith('用户档案已保存', 'info', 3000)
  expect(await room.updateUserProfile(submitted)).toBe(true)
  expect(room.userProfile.value).toEqual(submitted)
})

it('waits for the native receipt and uses its authoritative merged profile', async () => {
  const profileStorage = await import('@/platform/web/profileStorage')
  const snapshot = { records: [], revision: 0, resetRevision: '' }
  let acknowledge!: (record: { key: string; value: string; revision: number }) => void
  const port: ProfilePort = {
    readSettings: async () => snapshot, readChat: async () => snapshot, readDrafts: async () => snapshot,
    saveSetting: vi.fn(), saveDraft: vi.fn(), resetChat: vi.fn(),
    saveChatRecord: vi.fn(() => new Promise(resolve => { acknowledge = resolve })),
  }
  await profileStorage.activateProfileStorage(port, 'fixture')
  const room = await memory()
  const save = room.updateUserProfile(submitted)
  expect(room.userProfile.value.callName).toBe('')
  expect(room.setError).not.toHaveBeenCalled()
  const merged = { ...submitted, note: 'Other window' }
  acknowledge({ key: CHAT_USER_PROFILE_KEY, value: JSON.stringify(merged), revision: 1 })
  expect(await save).toBe(true)
  expect(room.userProfile.value).toEqual(merged)
  expect(localStorage.getItem(CHAT_USER_PROFILE_KEY)).toBeNull()
})

it('does not report success when the native receipt or post-save read fails', async () => {
  const profileStorage = await import('@/platform/web/profileStorage')
  const room = await memory()
  vi.spyOn(profileStorage, 'flushProfileWrites').mockRejectedValueOnce(new Error('receipt fixture'))
  expect(await room.updateUserProfile(submitted)).toBe(false)
  vi.spyOn(profileStorage.profileLocalStorage, 'getItem').mockImplementationOnce(() => { throw new Error('read fixture') })
  expect(await room.updateUserProfile(submitted)).toBe(false)
  expect(room.setError).not.toHaveBeenCalledWith('用户档案已保存', 'info', 3000)
})
