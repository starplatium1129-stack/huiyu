const archiveKv = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/composables/useKVStore', () => ({
  kvGet: vi.fn(async (key: string) => archiveKv.get(key) ?? null),
  kvSet: vi.fn(async (key: string, value: unknown) => { archiveKv.set(key, JSON.parse(JSON.stringify(value))) }),
}))
vi.mock('@/platform/web/profileStorage', async importOriginal => ({
  ...await importOriginal<typeof import('@/platform/web/profileStorage')>(),
  flushProfileWrites: vi.fn(async () => {}),
}))
vi.mock('@/utils/downloadBlob', () => ({ downloadBlob: vi.fn() }))
import { downloadBlob } from '@/utils/downloadBlob'
import { resolveConfirm, useConfirmState } from '@/composables/useConfirm'
import { mount, flushPromises } from '@vue/test-utils'
import ChatArchivePanel from '@/components/ChatArchivePanel.vue'
import { clearStoredChatContent } from '@/utils/chatReset'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, MAX_LOCAL_MESSAGES } from '@/config/characters'
import { kvGet, kvSet } from '@/composables/useKVStore'
import { CHAT_ARCHIVE_KEY } from '@/utils/chatArchive'
import { CHAT_ARCHIVE_CHANGED_KEY, CHAT_DRAFT_PREFIX, CHAT_VOLUME_KEY, CHAT_RESET_KEY, collectLiveLocalSettings } from '@/utils/storageKeys'
import { prepareBackupSettings } from '@/utils/backupSettings'
import { useChatStorage } from './useChatStorage'
import { flushProfileWrites } from '@/platform/web/profileStorage'

async function open(onError = vi.fn()) {
  const storage = useChatStorage(onError)
  await storage.load()
  return storage
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(flushProfileWrites).mockResolvedValue(undefined)
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
    for (const [input, expected] of [[-10, 0], [120, 100], [NaN, 80], [Infinity, 80], [24.8, 25]]) {
      storage.setVolume(input)
      expect(storage.state.settings.volume).toBe(expected)
    }
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
  it('rejects a failed restore without losing the archive and lets the same action retry', async () => {
    const storage = await open()
    const message = { mid: 'restored', role: 'user', content: 'from archive', stopped: false }
    await storage.importArchiveJson(JSON.stringify({ version: 1, archived: { nene: [message] } }))
    storage.messages('nene').push({ mid: 'current', role: 'user', content: 'current', stopped: false })
    storage.save()
    const original = localStorage.getItem(STORAGE_KEY)
    const write = localStorage.setItem.bind(localStorage)
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === STORAGE_KEY) throw new Error('quota')
      write(key, value)
    })
    await expect(storage.restoreFromArchive('nene')).rejects.toThrow('尚未保存')
    expect(storage.messages('nene').map(item => item.mid)).toEqual(['current'])
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original)
    expect(JSON.parse(await storage.exportArchiveJson()).archived.nene).toEqual([message])
    set.mockRestore()
    expect(await storage.restoreFromArchive('nene')).toBe(1)
    expect((await open()).messages('nene').map(item => item.mid)).toEqual(['current', 'restored'])
  })

  it('rejects a version-protected restore instead of reporting an empty archive', async () => {
    const storage = await open()
    const original = JSON.stringify({ version: 999, histories: { nene: [] } })
    localStorage.setItem(STORAGE_KEY, original)
    await expect(storage.restoreFromArchive('nene')).rejects.toThrow('版本保护')
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original)
    expect(storage.messages('nene')).toEqual([])
  })

  it('waits for desktop confirmation and preserves a failed confirmation for retry', async () => {
    const storage = await open()
    const message = { mid: 'pending', role: 'user', content: 'from archive', stopped: false }
    await storage.importArchiveJson(JSON.stringify({ version: 1, archived: { nene: [message] } }))
    let reject!: (error: Error) => void
    vi.mocked(flushProfileWrites).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const restored = vi.fn()
    const pending = storage.restoreFromArchive('nene').then(restored)
    const failed = expect(pending).rejects.toThrow('receipt unconfirmed')
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    expect(restored).not.toHaveBeenCalled()
    reject(Error('receipt unconfirmed'))
    await failed
    expect(storage.messages('nene').map(item => item.mid)).toEqual(['pending'])
    expect(storage.archiveCount('nene')).toBe(1)
    expect(await storage.restoreFromArchive('nene')).toBe(0)
    expect(vi.mocked(flushProfileWrites)).toHaveBeenCalledTimes(2)
    expect((await open()).messages('nene').map(item => item.mid)).toEqual(['pending'])
  })

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

it('binds delayed archive file selection to its reset, storage owner, latest selection and mounted panel', async () => {
  const storage = await open(), importing = vi.spyOn(storage, 'importArchiveJson')
  const wrapper = mount(ChatArchivePanel, { props: { storage, activeChar: 'nene' } })
  const payload = (mid: string) => JSON.stringify({ version: 1, archived: { nene: [{ mid, role: 'user', content: mid, stopped: false }] } })
  const select = async () => {
    let finish!: (value: string) => void
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [{ size: 1, text: () => new Promise<string>(resolve => { finish = resolve }) }] })
    await input.trigger('change')
    return (mid: string) => finish(payload(mid))
  }
  try {
    const beforeReset = await select()
    await clearStoredChatContent()
    expect(storage.canWrite()).toBe(false)
    await storage.load() // The reset has already been consumed before File.text finishes.
    beforeReset('before-reset'); await flushPromises()
    expect(importing).not.toHaveBeenCalled()
    expect(storage.archiveCount('nene')).toBe(0)
    expect(wrapper.emitted('notice')?.at(-1)?.[0]).toContain('重新选择')
    const older = await select(), latest = await select()
    latest('after-reset'); await flushPromises()
    older('older-selection'); await flushPromises()
    expect(importing).toHaveBeenCalledOnce()
    expect(JSON.parse(await storage.exportArchiveJson()).archived.nene.map((message: { mid: string }) => message.mid)).toEqual(['after-reset'])
    const superseded = await select(), preceding = structuredClone(archiveKv.get('chat_archive_v1'))
    let releaseSuperseded!: (value: unknown) => void
    vi.mocked(kvGet).mockImplementationOnce(() => new Promise(resolve => { releaseSuperseded = resolve }))
    superseded('old-refresh'); await flushPromises()
    const nextSelection = await select(); nextSelection('new-refresh'); await flushPromises()
    releaseSuperseded(preceding); await flushPromises()
    expect(JSON.stringify(archiveKv.get('chat_archive_v1'))).not.toContain('old-refresh')
    expect(JSON.stringify(archiveKv.get('chat_archive_v1'))).toContain('new-refresh')
    const reading = await select()
    const oldArchive = structuredClone(archiveKv.get('chat_archive_v1'))
    let releaseArchive!: (value: unknown) => void
    vi.mocked(kvGet).mockImplementationOnce(() => new Promise(resolve => { releaseArchive = resolve }))
    reading('selected-before-second-clear'); await flushPromises()
    expect(releaseArchive).toBeTypeOf('function')
    await clearStoredChatContent()
    expect(storage.canWrite()).toBe(false)
    await storage.exportArchiveJson() // A new authoritative refresh now owns ready.
    releaseArchive(oldArchive); await flushPromises()
    expect(storage.archiveCount('nene')).toBe(0)
    expect(JSON.stringify(archiveKv.get('chat_archive_v1'))).not.toContain('selected-before-second-clear')
    const replaced = await select(), other = await open(), otherImport = vi.spyOn(other, 'importArchiveJson')
    await wrapper.setProps({ storage: other })
    replaced('wrong-storage'); await flushPromises()
    expect(otherImport).not.toHaveBeenCalled()
    const abandoned = await select()
    wrapper.unmount(); abandoned('after-unmount'); await flushPromises()
    expect(otherImport).not.toHaveBeenCalled()
  } finally { if (wrapper.exists()) wrapper.unmount() }
})

it('owns archive confirmations and delayed exports across close and unmount', async () => {
  const storage = await open()
  await storage.importArchiveJson(JSON.stringify({ version: 1, archived: { nene: [{ mid: 'keep', role: 'user', content: 'keep' }] } }))
  const clear = vi.spyOn(storage, 'clearArchive')
  const wrapper = mount(ChatArchivePanel, { props: { storage, activeChar: 'nene' } })
  const button = (label: string) => wrapper.findAll('button').find(item => item.text() === label)!
  try {
    await button('清空归档').trigger('click')
    expect(useConfirmState().value.visible).toBe(true)
    await button('收起').trigger('click')
    expect(useConfirmState().value.visible).toBe(false)
    resolveConfirm(true); await flushPromises()
    expect(clear).not.toHaveBeenCalled()
    let finish!: (text: string) => void
    const exporting = vi.spyOn(storage, 'exportArchiveJson').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await button('导出 JSON').trigger('click')
    await button('导出 JSON').trigger('click')
    expect(exporting).toHaveBeenCalledOnce()
    const other = await open()
    wrapper.unmount()
    finish('old archive'); await flushPromises()
    expect(downloadBlob).not.toHaveBeenCalled()
    const replacement = mount(ChatArchivePanel, { props: { storage: other, activeChar: 'nene' } })
    await replacement.get('button.danger').trigger('click')
    expect(useConfirmState().value.visible).toBe(true)
    replacement.unmount()
    expect(useConfirmState().value.visible).toBe(false)
    resolveConfirm(true); await flushPromises()
    expect(clear).not.toHaveBeenCalled()
    expect(storage.archiveCount('nene')).toBe(1)
  } finally { if (wrapper.exists()) wrapper.unmount() }
})

it('does not restore or clear archives after their panel action becomes stale during storage reads', async () => {
  const storage = await open()
  await storage.importArchiveJson(JSON.stringify({ version: 1, archived: { nene: [{ mid: 'keep', role: 'user', content: 'keep' }] } }))
  let current = true, release!: (value: unknown) => void
  const archived = structuredClone(archiveKv.get('chat_archive_v1'))
  vi.mocked(kvGet).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const restore = storage.restoreFromArchive('nene', () => current)
  await flushPromises(); current = false; release(archived)
  expect(await restore).toBe(0)
  expect(storage.messages('nene')).toEqual([])
  current = true
  // clearArchive first yields to flush the archive; cancellation before the
  // clear is committed must preserve the already-persisted source.
  const clearing = storage.clearArchive(undefined, () => current)
  current = false
  expect(await clearing).toBe(false)
  expect(storage.archiveCount('nene')).toBe(1)
})
