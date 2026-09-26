const archiveKv = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/composables/useKVStore', () => ({
  kvGet: vi.fn(async (key: string) => archiveKv.get(key) ?? null),
  kvSet: vi.fn(async (key: string, value: unknown) => { archiveKv.set(key, JSON.parse(JSON.stringify(value))) }),
}))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, MAX_LOCAL_MESSAGES } from '@/config/characters'
import { kvGet, kvSet } from '@/composables/useKVStore'
import { CHAT_ARCHIVE_KEY } from '@/utils/chatArchive'
import { CHAT_ARCHIVE_CHANGED_KEY, CHAT_DRAFT_PREFIX, CHAT_VOLUME_KEY, CHAT_RESET_KEY, collectLiveLocalSettings } from '@/utils/storageKeys'
import { prepareBackupSettings } from '@/utils/backupSettings'
import { useChatStorage } from './useChatStorage'

async function open(onError = vi.fn()) {
  const storage = useChatStorage(onError)
  await storage.load()
  return storage
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, action: () => unknown) => action() } })
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
afterEach(() => { archiveKv.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('independent chat preference persistence', () => {
  it('does not read or serialize message history or archives when typing or adjusting volume', async () => {
    const storage = await open()
    const content = vi.fn(() => 'expensive history')
    storage.messages().push({ mid: 'one', role: 'user', stopped: false, get content() { return content() } })
    const get = vi.spyOn(localStorage, 'getItem')
    const set = vi.spyOn(localStorage, 'setItem')
    storage.setDraft('nene', 'next question')
    storage.setVolume(0)
    expect(content).not.toHaveBeenCalled()
    expect(get.mock.calls.every(([key]) => key === CHAT_RESET_KEY || key === 'huiyu:migration:barrier')).toBe(true)
    expect(set.mock.calls.map(([key]) => key)).toEqual([CHAT_DRAFT_PREFIX + 'nene', CHAT_VOLUME_KEY])
    expect((await open()).draft('nene')).toBe('next question')
    expect((await open()).state.settings.volume).toBe(0)
  })

  it('keeps cleared drafts and different-character edits through stale saves and history clears', async () => {
    const a = await open()
    a.setDraft('nene', 'old')
    const stale = await open()
    a.setDraft('nene', '')
    stale.setDraft('natsume', 'other character')
    stale.setVolume(25)
    a.clear('nene')
    stale.save()
    const restored = await open()
    expect(restored.draft('nene')).toBe('')
    expect(restored.draft('natsume')).toBe('other character')
    expect(restored.state.settings.volume).toBe(25)
  })

  it('clear reports failure and restores the in-memory history when persistence fails', async () => {
    const storage = await open()
    storage.messages('nene').push({ mid: 'keep', role: 'user', stopped: false, content: '保留' })
    const write = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === STORAGE_KEY) throw new Error('full')
      write(key, value)
    })

    expect(storage.clear('nene')).toBe(false)
    expect(storage.messages('nene')).toHaveLength(1)
    expect(storage.messages('nene')[0].mid).toBe('keep')
  })

  it('retains in-memory preferences and reports failed writes', async () => {
    const onError = vi.fn(), storage = await open(onError)
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
    storage.setDraft('nene', 'not lost in memory')
    storage.setVolume(0)
    expect(storage.draft('nene')).toBe('not lost in memory')
    expect(storage.state.settings.volume).toBe(0)
    expect(onError).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
    storage.save()
    expect((await open()).draft('nene')).toBe('not lost in memory')
    expect((await open()).state.settings.volume).toBe(0)
  })

  it('falls back to legacy preferences and ignores malformed optional records', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: { volume: 42, drafts: { nene: 'legacy' } } }))
    localStorage.setItem(CHAT_VOLUME_KEY, 'invalid')
    localStorage.setItem(CHAT_DRAFT_PREFIX + 'nene', '{invalid')
    const storage = await open()
    expect(storage.state.settings.volume).toBe(42)
    expect(storage.draft('nene')).toBe('legacy')
  })

  it('exports separate preferences and preserves them when merging modern backups', async () => {
    const storage = await open()
    storage.setDraft('nene', '  { "exact": "text" }  ')
    storage.setVolume(0)
    const exported = collectLiveLocalSettings(localStorage)
    expect(JSON.parse(exported[CHAT_DRAFT_PREFIX + 'nene'])).toBe('  { "exact": "text" }  ')
    expect(exported[CHAT_VOLUME_KEY]).toBe('0')
    for (const replace of [true, false]) {
      const restored = prepareBackupSettings({ [CHAT_VOLUME_KEY]: '90' }, exported, replace)
      localStorage.clear()
      for (const [key, value] of Object.entries(restored)) localStorage.setItem(key, value)
      expect((await open()).draft('nene')).toBe('  { "exact": "text" }  ')
      expect((await open()).state.settings.volume).toBe(0)
    }
  })

  it('restores legacy backup preferences over newer separate keys in merge and replace modes', async () => {
    const current = { [CHAT_VOLUME_KEY]: '90', [CHAT_DRAFT_PREFIX + 'nene']: JSON.stringify('new') }
    const incoming = { [STORAGE_KEY]: JSON.stringify({ settings: { volume: 0, drafts: { nene: 'legacy backup' } } }) }
    for (const replace of [false, true]) {
      const restored = prepareBackupSettings(current, incoming, replace)
      localStorage.clear()
      for (const [key, value] of Object.entries(restored)) localStorage.setItem(key, value)
      expect((await open()).draft('nene')).toBe('legacy backup')
      expect((await open()).state.settings.volume).toBe(0)
    }
  })
})

describe('chat archive writes', () => {
  it('reports background synchronization read failures without erasing the current archive', async () => {
    const error = vi.fn(), storage = await open(error)
    await storage.importArchiveJson(JSON.stringify({ version: 1, archived: { nene: [{ mid: 'keep', role: 'user', content: 'keep' }] } }))
    vi.mocked(kvGet).mockRejectedValueOnce(Error('database offline'))
    window.dispatchEvent(new StorageEvent('storage', { key: CHAT_ARCHIVE_CHANGED_KEY }))
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('无法同步另一窗口')))
    expect(storage.archiveCount('nene')).toBe(1)
  })

  it('imports and exports unavailable characters and rejects failed reads instead of exporting an empty archive', async () => {
    const storage = await open()
    const unknown = { mid: 'private-model-message', role: 'user', content: 'preserve this', stopped: false }
    expect(await storage.importArchiveJson(JSON.stringify({ version: 1, archived: { unavailable_private_model: [unknown] } }))).toBe(1)
    expect(storage.archiveCount().unavailable_private_model).toBe(1)
    const exported = JSON.parse(await storage.exportArchiveJson())
    expect(exported.archived.unavailable_private_model).toEqual([unknown])
    const { kvGet } = await import('@/composables/useKVStore')
    vi.mocked(kvGet).mockRejectedValueOnce(Error('database offline'))
    await expect(storage.exportArchiveJson()).rejects.toThrow('database offline')
    vi.mocked(kvGet).mockRejectedValueOnce(Error('database offline'))
    await expect(storage.restoreFromArchive('nene')).rejects.toThrow('database offline')
    expect(storage.messages('nene')).toEqual([])
    await storage.clearArchive()
    expect(JSON.parse(await storage.exportArchiveJson()).archived.unavailable_private_model).toEqual([])
  })

  it('only writes on archive mutations and retries an archive write failure on save', async () => {
    const onError = vi.fn(), storage = await open(onError)
    const write = localStorage.setItem.bind(localStorage)
    let failArchive = true
    const put = vi.mocked(kvSet).mockImplementation(async (key, value) => { if (failArchive) throw Error('full'); archiveKv.set(key, JSON.parse(JSON.stringify(value))) })
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === CHAT_ARCHIVE_KEY && failArchive) throw new Error('full')
      write(key, value)
    })
    storage.save()
    expect(put).not.toHaveBeenCalled()
    for (let i = 0; i <= MAX_LOCAL_MESSAGES; i++) {
      storage.messages().push({ mid: String(i), role: 'user', stopped: false, content: `message ${i}` })
    }
    storage.trim()
    await storage.flushArchive()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('聊天归档'))
    expect(storage.messages()).toHaveLength(MAX_LOCAL_MESSAGES + 1)
    storage.save()
    await storage.flushArchive()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).histories.nene).toHaveLength(MAX_LOCAL_MESSAGES + 1)
    failArchive = false
    storage.save()
    await storage.flushArchive()
    expect((await open()).archiveCount('nene')).toBe(1)
    set.mockClear(); put.mockClear()
    storage.save()
    expect(set.mock.calls.some(([key]) => key === CHAT_ARCHIVE_KEY)).toBe(false)
    await storage.clearArchive('nene')
    expect((await open()).archiveCount('nene')).toBe(0)
  })
})
