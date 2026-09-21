const archiveKv = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/composables/useKVStore', () => ({
  kvGet: vi.fn(async (key: string) => archiveKv.get(key) ?? null),
  kvSet: vi.fn(async (key: string, value: unknown) => { archiveKv.set(key, JSON.parse(JSON.stringify(value))) }),
}))
import { afterEach, expect, it, vi } from 'vitest'
import { STORAGE_KEY } from '@/config/characters'
import { CHAT_ARCHIVE_KEY, normalizeChatArchive } from '@/utils/chatArchive'
import { normalizeChatMemoryState } from '@/utils/chatMemory'
import { normalizeChatStorage } from '@/utils/chatStorageCore'
import { prepareBackupSettings } from '@/utils/backupSettings'
import { useChatStorage } from './useChatStorage'

afterEach(() => { archiveKv.clear(); localStorage.clear(); vi.restoreAllMocks() })
const options = { characterIds: ['nene'], maxMessages: 20, version: 3, createMessageId: () => 'fixture' }
it.each([undefined, 1, 2, 3])('migrates supported chat version %s with messages intact', version => {
  const result = normalizeChatStorage({ version, histories: { nene: [{ role: 'user', content: 'neutral', mid: 'fixture' }] } }, '', options)
  expect(result.state.version).toBe(3)
  expect(result.state.histories.nene[0].content).toBe('neutral')
})
it.each([999, '3', null, -1, 1.5])('rejects unsupported version %s without touching any key', async version => {
  const original = JSON.stringify({ version, sentinel: 'neutral', histories: { raiden_shogun: [] } })
  localStorage.setItem(STORAGE_KEY, original)
  const error = vi.fn(), storage = useChatStorage(error)
  const writes = vi.spyOn(localStorage, 'setItem')
  await storage.load()
  storage.setActive('natsume'); storage.setDraft('nene', 'new'); storage.clear(); storage.clearArchive(); storage.save()
  expect(writes).not.toHaveBeenCalled()
  expect(localStorage.getItem(STORAGE_KEY)).toBe(original)
  expect(storage.writeBlocked.value).toBe(true)
  expect(error).toHaveBeenCalled()
})
it('rejects another window upgrading the record after load', async () => {
  const storage = useChatStorage()
  await storage.load()
  const original = '{ "version": 999, "sentinel": "neutral" }'
  localStorage.setItem(STORAGE_KEY, original)
  expect(storage.save()).toBe(false)
  expect(localStorage.getItem(STORAGE_KEY)).toBe(original)
})
it('protects archive and memory versions and replace-mode restore', async () => {
  expect(() => normalizeChatArchive({ version: 2 }, ['nene'])).toThrow()
  expect(() => normalizeChatMemoryState({ version: 2 })).toThrow()
  expect(() => prepareBackupSettings({ [STORAGE_KEY]: '{"version":999}' }, { [STORAGE_KEY]: '{"version":3}' }, true)).toThrow()
  localStorage.setItem(CHAT_ARCHIVE_KEY, '{"version":2,"sentinel":"neutral"}')
  const storage = useChatStorage()
  await storage.load()
  storage.clearArchive()
  expect(localStorage.getItem(CHAT_ARCHIVE_KEY)).toContain('sentinel')
})
