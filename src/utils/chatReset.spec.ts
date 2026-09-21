import { afterEach, expect, it, vi } from 'vitest'
import { clearStoredChatContent } from './chatReset'
import { CHAT_DRAFT_PREFIX, CHAT_USER_PROFILE_KEY, RETIRED_COMPANION_CHAT_KEY, CHAT_MEMORY_KEY, collectLiveLocalSettings } from './storageKeys'
import { useChatStorage } from '@/composables/chat/useChatStorage'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })
it.each([CHAT_USER_PROFILE_KEY, RETIRED_COMPANION_CHAT_KEY, CHAT_DRAFT_PREFIX + 'retired', CHAT_MEMORY_KEY, 'aics_chat_archive_v1'])('clears an isolated content key %s, preserves settings, exports no sentinel', key => {
  localStorage.setItem(key, '{"sentinel":"neutral"}')
  localStorage.setItem('aics_theme', 'light')
  localStorage.setItem('aics_chat_v1', JSON.stringify({ version: 3, settings: { apiKey: 'fixture', volume: 32, drafts: { retired: 'neutral' } } }))
  expect(clearStoredChatContent().failed).toEqual([])
  expect(JSON.stringify(collectLiveLocalSettings(localStorage))).not.toContain('neutral')
  expect(localStorage.getItem('aics_theme')).toBe('light')
  expect(JSON.parse(localStorage.getItem('aics_chat_v1')!).settings).toMatchObject({ apiKey: 'fixture', volume: 32 })
})
it('stale history, archive and draft writes cannot resurrect reset data', async () => {
  const old = useChatStorage()
  await old.load()
  old.messages().push({ role: 'user', content: 'neutral', mid: 'old', stopped: false })
  old.setDraft('nene', 'neutral')
  clearStoredChatContent()
  expect(old.save()).toBe(false)
  expect(old.messages()).toEqual([])
  old.save()
  expect(JSON.stringify(collectLiveLocalSettings(localStorage))).not.toContain('neutral')
  old.setDraft('nene', 'new input')
  expect(localStorage.getItem(CHAT_DRAFT_PREFIX + 'nene')).toContain('new input')
})
it('reports partial deletion failure, keeps deleted items gone, supports retry', () => {
  localStorage.setItem(CHAT_USER_PROFILE_KEY, '{"note":"neutral"}')
  localStorage.setItem(CHAT_DRAFT_PREFIX + 'nene', 'neutral')
  const remove = localStorage.removeItem.bind(localStorage)
  const spy = vi.spyOn(localStorage, 'removeItem').mockImplementation(function (this: Storage, key) {
    if (key === CHAT_USER_PROFILE_KEY) throw Error('fixture')
    remove(key)
  })
  expect(clearStoredChatContent().failed).toEqual([CHAT_USER_PROFILE_KEY])
  expect(localStorage.getItem(CHAT_DRAFT_PREFIX + 'nene')).toBeNull()
  spy.mockRestore()
  expect(clearStoredChatContent().failed).toEqual([])
})
it('does not delete content when publishing the tombstone fails', () => {
  localStorage.setItem(CHAT_USER_PROFILE_KEY, 'neutral')
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw Error('fixture') })
  expect(() => clearStoredChatContent()).toThrow()
  expect(localStorage.getItem(CHAT_USER_PROFILE_KEY)).toBe('neutral')
})
