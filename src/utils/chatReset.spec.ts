const archiveKv = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/composables/useKVStore', () => ({
  kvGet: vi.fn(async (key: string) => archiveKv.get(key) ?? null),
  kvSet: vi.fn(async (key: string, value: unknown) => { archiveKv.set(key, JSON.parse(JSON.stringify(value))) }),
}))
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearStoredChatContent } from './chatReset'
import { CHAT_DRAFT_PREFIX, CHAT_USER_PROFILE_KEY, RETIRED_COMPANION_CHAT_KEY, CHAT_MEMORY_KEY, collectLiveLocalSettings } from './storageKeys'
import { useChatStorage } from '@/composables/chat/useChatStorage'

beforeEach(() => { vi.stubGlobal('navigator', { locks: { request: async (_name: string, work: () => unknown) => work() } }) })
afterEach(() => { archiveKv.clear(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it.each([CHAT_USER_PROFILE_KEY, RETIRED_COMPANION_CHAT_KEY, CHAT_DRAFT_PREFIX + 'retired', CHAT_MEMORY_KEY, 'aics_chat_archive_v1'])('clears an isolated content key %s, preserves settings, exports no sentinel', async key => {
  localStorage.setItem(key, '{"sentinel":"neutral"}')
  localStorage.setItem('aics_theme', 'light')
  localStorage.setItem('aics_chat_v1', JSON.stringify({ version: 3, settings: { apiKey: 'fixture', volume: 32, drafts: { retired: 'neutral' } } }))
  expect((await clearStoredChatContent()).failed).toEqual([])
  expect(JSON.stringify(collectLiveLocalSettings(localStorage))).not.toContain('neutral')
  expect(localStorage.getItem('aics_theme')).toBe('light')
  expect(JSON.parse(localStorage.getItem('aics_chat_v1')!).settings).toMatchObject({ apiKey: 'fixture', volume: 32 })
})
it('stale history, archive and draft writes cannot resurrect reset data', async () => {
  const old = useChatStorage()
  await old.load()
  old.messages().push({ role: 'user', content: 'neutral', mid: 'old', stopped: false })
  old.setDraft('nene', 'neutral')
  await clearStoredChatContent()
  expect(old.save()).toBe(false)
  expect(old.messages()).toEqual([])
  old.save()
  expect(JSON.stringify(collectLiveLocalSettings(localStorage))).not.toContain('neutral')
  old.setDraft('nene', 'new input')
  expect(localStorage.getItem(CHAT_DRAFT_PREFIX + 'nene')).toContain('new input')
})
it('reports partial deletion failure, keeps deleted items gone, supports retry', async () => {
  localStorage.setItem(CHAT_USER_PROFILE_KEY, '{"note":"neutral"}')
  localStorage.setItem(CHAT_DRAFT_PREFIX + 'nene', 'neutral')
  const remove = localStorage.removeItem.bind(localStorage)
  const spy = vi.spyOn(localStorage, 'removeItem').mockImplementation(function (this: Storage, key) {
    if (key === CHAT_USER_PROFILE_KEY) throw Error('fixture')
    remove(key)
  })
  expect((await clearStoredChatContent()).failed).toEqual([CHAT_USER_PROFILE_KEY])
  expect(localStorage.getItem(CHAT_DRAFT_PREFIX + 'nene')).toBeNull()
  spy.mockRestore()
  expect((await clearStoredChatContent()).failed).toEqual([])
})
it('does not delete content when publishing the tombstone fails', async () => {
  localStorage.setItem(CHAT_USER_PROFILE_KEY, 'neutral')
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw Error('fixture') })
  await expect(clearStoredChatContent()).rejects.toThrow()
  expect(localStorage.getItem(CHAT_USER_PROFILE_KEY)).toBe('neutral')
})
