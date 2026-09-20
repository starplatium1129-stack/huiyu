import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, MAX_LOCAL_MESSAGES } from '@/config/characters'
import { CHAT_ARCHIVE_KEY } from '@/utils/chatArchive'
import { CHAT_DRAFT_PREFIX, CHAT_VOLUME_KEY, collectLiveLocalSettings } from '@/utils/storageKeys'
import { prepareBackupSettings } from '@/utils/backupSettings'
import { useChatStorage } from './useChatStorage'

function open(onError = vi.fn()) {
  const storage = useChatStorage(onError)
  storage.load()
  return storage
}
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => values.clear(),
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('independent chat preference persistence', () => {
  it('does not read or serialize message history or archives when typing or adjusting volume', () => {
    const storage = open()
    const content = vi.fn(() => 'expensive history')
    storage.messages().push({ mid: 'one', role: 'user', stopped: false, get content() { return content() } })
    const get = vi.spyOn(localStorage, 'getItem')
    const set = vi.spyOn(localStorage, 'setItem')
    storage.setDraft('nene', 'next question')
    storage.setVolume(0)
    expect(content).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(set.mock.calls.map(([key]) => key)).toEqual([CHAT_DRAFT_PREFIX + 'nene', CHAT_VOLUME_KEY])
    expect(open().draft('nene')).toBe('next question')
    expect(open().state.settings.volume).toBe(0)
  })

  it('keeps cleared drafts and different-character edits through stale saves and history clears', () => {
    const a = open()
    a.setDraft('nene', 'old')
    const stale = open()
    a.setDraft('nene', '')
    stale.setDraft('natsume', 'other character')
    stale.setVolume(25)
    a.clear('nene')
    stale.save()
    const restored = open()
    expect(restored.draft('nene')).toBe('')
    expect(restored.draft('natsume')).toBe('other character')
    expect(restored.state.settings.volume).toBe(25)
  })

  it('retains in-memory preferences and reports failed writes', () => {
    const onError = vi.fn(), storage = open(onError)
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
    storage.setDraft('nene', 'not lost in memory')
    storage.setVolume(0)
    expect(storage.draft('nene')).toBe('not lost in memory')
    expect(storage.state.settings.volume).toBe(0)
    expect(onError).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
    storage.save()
    expect(open().draft('nene')).toBe('not lost in memory')
    expect(open().state.settings.volume).toBe(0)
  })

  it('falls back to legacy preferences and ignores malformed optional records', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: { volume: 42, drafts: { nene: 'legacy' } } }))
    localStorage.setItem(CHAT_VOLUME_KEY, 'invalid')
    localStorage.setItem(CHAT_DRAFT_PREFIX + 'nene', '{invalid')
    const storage = open()
    expect(storage.state.settings.volume).toBe(42)
    expect(storage.draft('nene')).toBe('legacy')
  })

  it('exports separate preferences and preserves them when merging modern backups', () => {
    const storage = open()
    storage.setDraft('nene', '  { "exact": "text" }  ')
    storage.setVolume(0)
    const exported = collectLiveLocalSettings(localStorage)
    expect(JSON.parse(exported[CHAT_DRAFT_PREFIX + 'nene'])).toBe('  { "exact": "text" }  ')
    expect(exported[CHAT_VOLUME_KEY]).toBe('0')
    for (const replace of [true, false]) {
      const restored = prepareBackupSettings({ [CHAT_VOLUME_KEY]: '90' }, exported, replace)
      localStorage.clear()
      for (const [key, value] of Object.entries(restored)) localStorage.setItem(key, value)
      expect(open().draft('nene')).toBe('  { "exact": "text" }  ')
      expect(open().state.settings.volume).toBe(0)
    }
  })

  it('restores legacy backup preferences over newer separate keys in merge and replace modes', () => {
    const current = { [CHAT_VOLUME_KEY]: '90', [CHAT_DRAFT_PREFIX + 'nene']: JSON.stringify('new') }
    const incoming = { [STORAGE_KEY]: JSON.stringify({ settings: { volume: 0, drafts: { nene: 'legacy backup' } } }) }
    for (const replace of [false, true]) {
      const restored = prepareBackupSettings(current, incoming, replace)
      localStorage.clear()
      for (const [key, value] of Object.entries(restored)) localStorage.setItem(key, value)
      expect(open().draft('nene')).toBe('legacy backup')
      expect(open().state.settings.volume).toBe(0)
    }
  })
})

describe('chat archive writes', () => {
  it('only writes on archive mutations and retries an archive write failure on save', () => {
    const onError = vi.fn(), storage = open(onError)
    const write = localStorage.setItem.bind(localStorage)
    let failArchive = true
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === CHAT_ARCHIVE_KEY && failArchive) throw new Error('full')
      write(key, value)
    })
    storage.save()
    expect(set.mock.calls.some(([key]) => key === CHAT_ARCHIVE_KEY)).toBe(false)
    for (let i = 0; i <= MAX_LOCAL_MESSAGES; i++) {
      storage.messages().push({ mid: String(i), role: 'user', stopped: false, content: `message ${i}` })
    }
    storage.trim()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('聊天归档'))
    failArchive = false
    storage.save()
    expect(open().archiveCount('nene')).toBe(1)
    set.mockClear()
    storage.save()
    expect(set.mock.calls.some(([key]) => key === CHAT_ARCHIVE_KEY)).toBe(false)
    storage.clearArchive('nene')
    expect(open().archiveCount('nene')).toBe(0)
  })
})
