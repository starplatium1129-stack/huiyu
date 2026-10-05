import { afterEach, expect, it, vi } from 'vitest'
import type { ProfilePort } from './profileStorage'
import type { ProfileSnapshot } from '../../../types/profile'
import { WORKSPACE_BACKUP_PENDING_PREFIX, BATCH_DRAW_PLAN_KEY, CHAT_DRAFT_PREFIX, SD_PENDING_QUEUE_KEY, SD_QUEUE_SNAPSHOT_KEY, TEMP_RESULT_KEY, VIDEO_CONTEXT_KEY, VIDEO_DRAFT_KEY, VIDEO_SCENARIO_CONTEXT_KEY, VIDEO_SHOTS_CONTEXT_KEY, VIDEO_SHOTS_DRAFT_KEY } from '../../utils/storageKeys'
import { classifyMigrationKey } from './migrationClassification'

afterEach(() => { vi.resetModules(); localStorage.clear(); sessionStorage.clear() })

it('keeps Web local/session domains and switches actual setting and draft consumers without replaying old values', async () => {
  expect(classifyMigrationKey('local', WORKSPACE_BACKUP_PENDING_PREFIX + '["workspace","owner"]')).toBe('transient')
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

it.each([
  { key: 'aics_pb_last_draft', local: true },
  { key: 'aics-model-draft-fixture', local: true },
  { key: `aics-model-draft-fixture:${CHAT_DRAFT_PREFIX}nene`, local: true },
  ...[BATCH_DRAW_PLAN_KEY, VIDEO_CONTEXT_KEY, VIDEO_SHOTS_CONTEXT_KEY, VIDEO_SCENARIO_CONTEXT_KEY,
    VIDEO_DRAFT_KEY, VIDEO_SHOTS_DRAFT_KEY, TEMP_RESULT_KEY, SD_PENDING_QUEUE_KEY].map(key => ({ key, local: false })),
])('retries preserved non-chat draft $key after a chat reset without losing its CAS revision', async ({ key, local }) => {
  const module = await import('./profileStorage')
  const port = fakePort()
  vi.mocked(port.readDrafts).mockResolvedValue({ records: [{ key, value: 'saved', revision: 7 }], revision: 8, resetRevision: 'reset-2' })
    .mockResolvedValueOnce({ records: [{ key, value: 'saved', revision: 7 }], revision: 7, resetRevision: 'reset-1' })
  vi.mocked(port.saveDraft).mockRejectedValueOnce(Object.assign(new Error('chat reset'), { code: 'PROFILE_RESET_CONFLICT' }))
  await module.activateProfileStorage(port, 'main')
  const storage = local ? module.profileLocalStorage : module.profileDraftStorage
  storage.setItem(key, '{"draft":"fixture"}')
  await module.flushProfileWrites()
  const calls = vi.mocked(port.saveDraft).mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[1][0]).toEqual({ ...calls[0][0], operationId: expect.any(String), expectedReset: 'reset-2' })
  expect(calls[1][0].operationId).not.toBe(calls[0][0].operationId)
  expect(calls[1][0].expectedRevision).toBe(7)
  expect(calls[1][0].windowId).toBe(local ? undefined : 'main')
  expect(port.readChat).toHaveBeenCalledTimes(1)
  expect(module.hasProfileRecoveryData()).toBe(false)
  expect(module.hasPendingProfileWrites()).toBe(false)
  expect(storage.getItem(key)).toBe('{"draft":"fixture"}')
})

it.each(['aics_chat_v1', `${CHAT_DRAFT_PREFIX}nene`])('keeps actual reset-owned content %s in recovery instead of resaving it', async key => {
  const module = await import('./profileStorage'), port = fakePort()
  const cleared: ProfileSnapshot = { records: [{ key: 'aics_chat_v1', value: '{"histories":{}}', revision: 10 }], revision: 10, resetRevision: 'reset-2' }
  vi.mocked(port.readChat).mockResolvedValue(cleared)
    .mockResolvedValueOnce({ records: [], revision: 7, resetRevision: 'reset-1' })
  vi.mocked(port.readDrafts).mockResolvedValue({ records: [], revision: 10, resetRevision: 'reset-2' })
    .mockResolvedValueOnce({ records: [], revision: 7, resetRevision: 'reset-1' })
  const write = key === 'aics_chat_v1' ? vi.mocked(port.saveChatRecord) : vi.mocked(port.saveDraft)
  write.mockRejectedValueOnce(Object.assign(new Error('chat reset'), { code: 'PROFILE_RESET_CONFLICT' }))
  await module.activateProfileStorage(port, 'main')
  module.profileLocalStorage.setItem(key, 'unsaved local chat')
  await module.flushProfileWrites()
  expect(write).toHaveBeenCalledOnce()
  expect(module.hasPendingProfileWrites()).toBe(false)
  expect(module.hasProfileRecoveryData()).toBe(true)
  expect(JSON.parse(await module.exportProfileRecovery().text()).records).toEqual([{ key, value: 'unsaved local chat', reason: 'chat-reset' }])
  expect(module.profileLocalStorage.getItem('aics_chat_v1')).toBe('{"histories":{}}')
  if (key !== 'aics_chat_v1') expect(module.profileLocalStorage.getItem(key)).toBeNull()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it('rejects a stale draft snapshot after its newer save has already drained, then allows a fresh read', async () => {
  const module = await import('./profileStorage'), port = fakePort()
  const key = 'aics_pb_last_draft'
  const snapshot = (value: string, revision: number): ProfileSnapshot => ({ records: [{ key, value, revision }], revision, resetRevision: 'reset-1' })
  vi.mocked(port.readDrafts).mockResolvedValue(snapshot('old draft', 7))
  await module.activateProfileStorage(port, 'main')
  const stale = deferred<ProfileSnapshot>(), started = deferred<void>()
  vi.mocked(port.readDrafts).mockImplementationOnce(() => { started.resolve(); return stale.promise })
  const refreshing = module.refreshProfileStorage()
  await started.promise
  module.profileLocalStorage.setItem(key, 'saved draft')
  await module.flushProfileWrites()
  expect(module.hasPendingProfileWrites()).toBe(false)
  stale.resolve(snapshot('old draft', 7))
  await refreshing
  expect(module.profileLocalStorage.getItem(key)).toBe('saved draft')
  module.profileLocalStorage.setItem(key, 'next draft')
  await module.flushProfileWrites()
  expect(vi.mocked(port.saveDraft).mock.calls[1][0].expectedRevision).toBe(9)

  // Independent remote keys are not frozen by the rejected read.
  vi.mocked(port.readSettings).mockResolvedValue({ records: [{ key: 'aics_theme', value: 'light', revision: 10 }], revision: 10, resetRevision: 'reset-1' })
  vi.mocked(port.readDrafts).mockResolvedValue(snapshot('next draft', 9))
  await module.refreshProfileStorage()
  expect(module.profileLocalStorage.getItem('aics_theme')).toBe('light')
  expect(module.profileLocalStorage.getItem(key)).toBe('next draft')
})

it('does not let an older refresh overwrite a newer completed snapshot', async () => {
  const module = await import('./profileStorage'), port = fakePort()
  await module.activateProfileStorage(port, 'main')
  const older = deferred<ProfileSnapshot>(), started = deferred<void>()
  vi.mocked(port.readSettings).mockImplementationOnce(() => { started.resolve(); return older.promise })
    .mockResolvedValueOnce({ records: [{ key: 'aics_theme', value: 'latest', revision: 9 }], revision: 9, resetRevision: 'reset-1' })
  const first = module.refreshProfileStorage()
  await started.promise
  await module.refreshProfileStorage()
  older.resolve({ records: [{ key: 'aics_theme', value: 'obsolete', revision: 8 }], revision: 8, resetRevision: 'reset-1' })
  await first
  expect(module.profileLocalStorage.getItem('aics_theme')).toBe('latest')
})

it('does not restore pre-reset chat state from a delayed profile refresh', async () => {
  const module = await import('./profileStorage'), port = fakePort()
  const before: ProfileSnapshot = { records: [{ key: 'aics_chat_v1', value: 'old chat', revision: 7 }], revision: 7, resetRevision: 'reset-1' }
  vi.mocked(port.readChat).mockResolvedValue(before)
  await module.activateProfileStorage(port, 'main')
  const stale = deferred<ProfileSnapshot>(), started = deferred<void>()
  vi.mocked(port.readChat).mockImplementationOnce(() => { started.resolve(); return stale.promise })
  const refreshing = module.refreshProfileStorage()
  await started.promise
  await module.resetProfileChat()
  stale.resolve(before)
  await refreshing
  expect(module.profileLocalStorage.getItem('aics_chat_v1')).toBeNull()
  module.profileDraftStorage.setItem('aics_video_draft_v1', 'new draft')
  await module.flushProfileWrites()
  expect(port.saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({ expectedReset: 'reset-2' }))
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


it.each(['aics_scene_favorites', 'aics_hidden_scenes'])('rebases %s as scene-ID deltas without losing another window’s changes', async key => {
  const module = await import('./profileStorage'), port = fakePort()
  const snapshot = (value: string, revision: number): ProfileSnapshot => ({ records: [{ key, value, revision }], revision, resetRevision: 'reset-1' })
  vi.mocked(port.readSettings).mockResolvedValueOnce(snapshot('["remove","keep"]', 7))
    .mockResolvedValue(snapshot('["remove","remote"]', 8))
  vi.mocked(port.saveSetting).mockRejectedValueOnce(Object.assign(new Error('concurrent edit'), { code: 'REVISION_CONFLICT' }))
  await module.activateProfileStorage(port, 'main')
  module.profileLocalStorage.setItem(key, '["keep","local","local"]')
  await module.flushProfileWrites()
  expect(port.saveSetting).toHaveBeenLastCalledWith(expect.objectContaining({ key, expectedRevision: 8, value: '["local","remote"]' }))
  expect(module.profileLocalStorage.getItem(key)).toBe('["local","remote"]')
  const { mergeProfileSettingConflict } = await import('./profileConflict')
  expect(mergeProfileSettingConflict(key, null, '["same"]', '["same","remote"]')).toBe('["remote","same"]')
  expect(mergeProfileSettingConflict('aics_recent_scenes', '["first"]', '["second","first"]', '["third","first"]')).toBe('["second","first"]')
})


it('carries merged scene IDs through queued toggles and freezes payload after an unknown receipt', async () => {
  const module = await import('./profileStorage'), port = fakePort(), key = 'aics_scene_favorites'
  const snapshot = (value: string, revision: number): ProfileSnapshot => ({ records: [{ key, value, revision }], revision, resetRevision: 'reset-1' })
  vi.mocked(port.readSettings).mockResolvedValueOnce(snapshot('[]', 7)).mockResolvedValue(snapshot('["remote"]', 8))
  let rejectFirst!: (error: Error) => void
  const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject }), started = deferred<void>()
  vi.mocked(port.saveSetting).mockImplementationOnce(() => { started.resolve(); return first })
    .mockResolvedValueOnce({ key, value: '["a","remote"]', revision: 9 })
    .mockRejectedValueOnce(new Error('receipt unknown'))
    .mockResolvedValueOnce({ key, value: '["a","b","remote"]', revision: 10 })
  await module.activateProfileStorage(port, 'main')
  module.profileLocalStorage.setItem(key, '["a"]')
  await started.promise
  module.profileLocalStorage.setItem(key, '["a","b"]')
  rejectFirst(Object.assign(new Error('concurrent edit'), { code: 'REVISION_CONFLICT' }))
  await expect(module.flushProfileWrites()).rejects.toThrow('receipt unknown')
  const calls = vi.mocked(port.saveSetting).mock.calls
  expect(calls[2][0]).toMatchObject({ expectedRevision: 9, value: '["a","b","remote"]' })
  await module.flushProfileWrites()
  expect(calls[3][0]).toEqual(calls[2][0])
  expect(module.profileLocalStorage.getItem(key)).toBe('["a","b","remote"]')
})

it('archive reads cannot roll back connection settings or accept snapshots overtaken by a write', async () => {
  const module = await import('./profileStorage'), port = fakePort(), key = 'aics_chat_v1'
  const snapshot = (archiveRevision: number): ProfileSnapshot => ({ records: [
    { key, value: '{"settings":{"apiModel":"old"}}', revision: 7 },
    { key: 'aics_chat_archive_v1', value: { version: 1, archived: {} }, revision: archiveRevision },
  ], revision: archiveRevision, resetRevision: 'reset-1' })
  vi.mocked(port.readChat).mockResolvedValue(snapshot(7))
  await module.activateProfileStorage(port, 'main')
  const stale = deferred<ProfileSnapshot>(), started = deferred<void>()
  vi.mocked(port.readChat).mockImplementationOnce(() => { started.resolve(); return stale.promise })
  const reading = module.readProfileChatArchive()
  const rejected = expect(reading).rejects.toThrow('资料已变化')
  await started.promise
  module.profileLocalStorage.setItem(key, '{"settings":{"apiModel":"new"}}')
  await module.flushProfileWrites()
  stale.resolve(snapshot(7))
  await rejected
  expect(module.profileLocalStorage.getItem(key)).toContain('new')
  vi.mocked(port.readChat).mockResolvedValue(snapshot(9))
  await module.readProfileChatArchive()
  expect(module.profileLocalStorage.getItem(key)).toContain('new')
  module.profileLocalStorage.setItem(key, module.profileLocalStorage.getItem(key)!)
  await module.flushProfileWrites()
  expect(port.saveChatRecord).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 8, value: expect.stringContaining('new') }))
})
