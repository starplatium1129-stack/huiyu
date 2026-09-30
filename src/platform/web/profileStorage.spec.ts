import { afterEach, expect, it, vi } from 'vitest'
import type { ProfilePort } from './profileStorage'
import { BATCH_DRAW_PLAN_KEY, SD_PENDING_QUEUE_KEY, SD_QUEUE_SNAPSHOT_KEY } from '../../utils/storageKeys'
import { classifyMigrationKey } from './migrationClassification'

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

it('batch plans hydrate under the stable desktop window identity and remain separate from another window', async () => {
  expect(classifyMigrationKey('session', BATCH_DRAW_PLAN_KEY)).toBe('draft')
  const module = await import('./profileStorage')
  const drafts = new Map<string, string | null>()
  const port = fakePort()
  vi.mocked(port.readDrafts).mockImplementation(async id => ({ records: drafts.has(id)
    ? [{ key: 'aics_pb_batch_plan_v1', value: drafts.get(id), revision: 9 }] : [], revision: 9, resetRevision: 'reset-1' }))
  vi.mocked(port.saveDraft).mockImplementation(async input => {
    drafts.set(input.windowId!, input.value)
    return { key: input.key, value: input.value, revision: 9 }
  })
  await module.activateProfileStorage(port, 'atelier')
  module.profileDraftStorage.setItem('aics_pb_batch_plan_v1', 'atelier plan')
  await module.flushProfileWrites()
  await module.activateProfileStorage(port, 'companion')
  expect(module.profileDraftStorage.getItem('aics_pb_batch_plan_v1')).toBeNull()
  module.profileDraftStorage.setItem('aics_pb_batch_plan_v1', 'companion plan')
  await module.flushProfileWrites()
  await module.activateProfileStorage(port, 'atelier')
  expect(module.profileDraftStorage.getItem('aics_pb_batch_plan_v1')).toBe('atelier plan')
  expect(port.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ key: 'aics_pb_batch_plan_v1', windowId: 'atelier' }))
  expect(sessionStorage.getItem('aics_pb_batch_plan_v1')).toBeNull()
})

it('hydrates pending SD inputs as window drafts without writing either native browser authority', async () => {
  expect(classifyMigrationKey('session', SD_PENDING_QUEUE_KEY)).toBe('draft')
  expect(classifyMigrationKey('local', SD_QUEUE_SNAPSHOT_KEY)).toBe('history')
  localStorage.setItem(SD_PENDING_QUEUE_KEY, 'old-local')
  sessionStorage.setItem(SD_PENDING_QUEUE_KEY, 'old-session')
  const module = await import('./profileStorage')
  const port = fakePort()
  vi.mocked(port.readDrafts).mockResolvedValue({ records: [{ key: SD_PENDING_QUEUE_KEY, value: 'runtime', revision: 7 }], revision: 7, resetRevision: 'reset-1' })
  await module.activateProfileStorage(port, 'main')
  expect(module.profileDraftStorage.getItem(SD_PENDING_QUEUE_KEY)).toBe('runtime')
  module.profileDraftStorage.setItem(SD_PENDING_QUEUE_KEY, '{"pending":[]}')
  await module.flushProfileWrites()
  expect(port.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ key: SD_PENDING_QUEUE_KEY, windowId: 'main', expectedRevision: 7 }))
  expect(localStorage.getItem(SD_PENDING_QUEUE_KEY)).toBe('old-local')
  expect(sessionStorage.getItem(SD_PENDING_QUEUE_KEY)).toBe('old-session')
})

it('retries a lost pending SD receipt with exactly the same operation and inputs', async () => {
  const module = await import('./profileStorage')
  const port = fakePort()
  vi.mocked(port.saveDraft).mockRejectedValueOnce(new Error('queue receipt lost'))
  await module.activateProfileStorage(port, 'main')
  module.profileDraftStorage.setItem(SD_PENDING_QUEUE_KEY, '{"pending":["fixture"]}')
  await expect(module.flushProfileWrites()).rejects.toThrow('queue receipt lost')
  expect(module.hasPendingProfileWrites()).toBe(true)
  expect(sessionStorage.getItem(SD_PENDING_QUEUE_KEY)).toBeNull()
  await module.flushProfileWrites()
  const calls = vi.mocked(port.saveDraft).mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[1][0]).toEqual(calls[0][0])
  expect(module.hasPendingProfileWrites()).toBe(false)
})

it('fails closed on pending SD CAS conflicts instead of overwriting a newer authoritative snapshot', async () => {
  const module = await import('./profileStorage')
  const port = fakePort()
  let authoritative = '{"pending":["newer"]}'
  vi.mocked(port.readDrafts).mockResolvedValue({ records: [{ key: SD_PENDING_QUEUE_KEY, value: authoritative, revision: 9 }], revision: 9, resetRevision: 'reset-1' })
    .mockResolvedValueOnce({ records: [{ key: SD_PENDING_QUEUE_KEY, value: 'old', revision: 7 }], revision: 7, resetRevision: 'reset-1' })
  vi.mocked(port.saveDraft).mockImplementation(async input => {
    if (input.expectedRevision !== 9) throw Object.assign(new Error('newer snapshot'), { code: 'REVISION_CONFLICT' })
    authoritative = input.value!
    return { key: input.key, value: input.value, revision: 10 }
  })
  await module.activateProfileStorage(port, 'main')
  module.profileDraftStorage.setItem(SD_PENDING_QUEUE_KEY, '{"pending":["stale"]}')
  await expect(module.flushProfileWrites()).rejects.toThrow('刷新页面')
  await expect(module.flushProfileWrites()).rejects.toThrow('刷新页面')
  expect(authoritative).toBe('{"pending":["newer"]}')
  const calls = vi.mocked(port.saveDraft).mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[1][0]).toEqual(calls[0][0])
  expect(calls[0][0].expectedRevision).toBe(7)
  expect(module.hasPendingProfileWrites()).toBe(true)
  expect(module.hasProfileRecoveryData()).toBe(false)
})

it('retries pending SD saves after unrelated chat reset without swallowing them into chat recovery', async () => {
  const module = await import('./profileStorage')
  const port = fakePort()
  vi.mocked(port.readDrafts).mockResolvedValue({ records: [{ key: SD_PENDING_QUEUE_KEY, value: 'saved', revision: 7 }], revision: 8, resetRevision: 'reset-2' })
    .mockResolvedValueOnce({ records: [{ key: SD_PENDING_QUEUE_KEY, value: 'saved', revision: 7 }], revision: 7, resetRevision: 'reset-1' })
  vi.mocked(port.saveDraft).mockRejectedValueOnce(Object.assign(new Error('chat reset'), { code: 'PROFILE_RESET_CONFLICT' }))
  await module.activateProfileStorage(port, 'main')
  module.profileDraftStorage.setItem(SD_PENDING_QUEUE_KEY, '{"pending":["fixture"]}')
  await module.flushProfileWrites()
  const calls = vi.mocked(port.saveDraft).mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[1][0]).toEqual({ ...calls[0][0], operationId: expect.any(String), expectedReset: 'reset-2' })
  expect(calls[1][0].operationId).not.toBe(calls[0][0].operationId)
  expect(calls[1][0].expectedRevision).toBe(7)
  expect(port.readChat).toHaveBeenCalledTimes(1)
  expect(module.hasProfileRecoveryData()).toBe(false)
  expect(module.hasPendingProfileWrites()).toBe(false)
  expect(module.profileDraftStorage.getItem(SD_PENDING_QUEUE_KEY)).toBe('{"pending":["fixture"]}')
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
