const archiveKv = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/composables/useKVStore', () => ({
  kvGet: vi.fn(async (key: string) => archiveKv.get(key) ?? null),
  kvSet: vi.fn(async (key: string, value: unknown) => { archiveKv.set(key, JSON.parse(JSON.stringify(value))) }),
}))
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useChatArchiveStorage } from './useChatArchiveStorage'
import { kvGet, kvSet } from '@/composables/useKVStore'
import { CHAT_ARCHIVE_KEY } from '@/utils/chatArchive'

const message = (mid: string) => ({ mid, content: mid, role: 'user' as const, stopped: false })
const open = async (onError = vi.fn()) => { const store = useChatArchiveStorage(['nene', 'natsume'], () => true, onError); await store.ready; return store }
beforeEach(() => {
  localStorage.clear()
  let tail = Promise.resolve()
  vi.stubGlobal('navigator', { locks: { request: (_name: string, action: () => unknown) => {
    const result = tail.then(action)
    tail = result.then(() => undefined, () => undefined)
    return result
  } } })
})
afterEach(() => { archiveKv.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('preserves overlapping additions from two stale windows and deduplicates IDs', async () => {
  const a = await open(), b = await open()
  a.add('nene', [message('a'), message('shared')])
  b.add('nene', [message('b'), message('shared')])
  expect(await Promise.all([a.save(), b.save()])).toEqual([true, true])
  expect((await open()).archive.value.archived.nene.map(item => item.mid)).toEqual(['a', 'shared', 'b'])
})

it('clear defeats a delayed addition from the previous epoch without deleting another character', async () => {
  const a = await open(), b = await open()
  a.add('nene', [message('old')]); a.add('natsume', [message('keep')]); await a.save()
  b.add('nene', [message('stale')])
  a.clear('nene'); await a.save(); await b.save()
  const current = await open()
  expect(current.archive.value.archived.nene).toEqual([])
  expect(current.archive.value.archived.natsume.map(item => item.mid)).toEqual(['keep'])
  current.add('nene', [message('new')]); await current.save()
  expect((await open()).archive.value.archived.nene.map(item => item.mid)).toEqual(['new'])
})

it('accepts additions after a queued clear and preserves simultaneous clears of different characters', async () => {
  const a = await open(), b = await open()
  a.add('nene', [message('old')]); a.add('natsume', [message('old-other')]); await a.save()
  a.clear('nene'); a.add('nene', [message('new')]); b.clear('natsume')
  await Promise.all([a.save(), b.save()])
  expect((await open()).archive.value.archived.nene.map(item => item.mid)).toEqual(['new'])
  expect((await open()).archive.value.archived.natsume).toEqual([])
})

it.each(['quota', 'database unavailable'])('keeps a failed clear retryable and accurately reports %s', async failure => {
  const notice = vi.fn(), a = await open(notice)
  a.add('nene', [message('old')]); await a.save()
  const original = JSON.stringify(archiveKv.get('chat_archive_v1'))
  a.clear('nene')
  const set = vi.mocked(kvSet).mockRejectedValueOnce(failure === 'quota' ? new DOMException('Full', 'QuotaExceededError') : new Error('Database unavailable'))
  expect(await a.save()).toBe(false)
  expect(JSON.stringify(archiveKv.get('chat_archive_v1'))).toBe(original)
  expect(set).toHaveBeenCalled()
  expect(notice).toHaveBeenCalledWith(expect.stringContaining(failure === 'quota' ? '本地空间已满' : '聊天归档保存失败'))
  if (failure !== 'quota') expect(notice.mock.calls[0]![0]).not.toMatch(/空间.*(?:满|不足)/)
  expect(await a.save()).toBe(true)
  expect((await open()).archive.value.archived.nene).toEqual([])
})

it('fails closed without Web Locks while keeping the pending messages', async () => {
  vi.stubGlobal('navigator', {})
  const error = vi.fn(), a = await open(error)
  a.add('nene', [message('pending')])
  expect(await a.save()).toBe(false)
  expect(error).toHaveBeenCalledWith(expect.stringContaining('不支持'))
  expect(a.archive.value.archived.nene).toHaveLength(1)
  expect(localStorage.getItem(CHAT_ARCHIVE_KEY)).toBeNull()
})

it('invalidates queued operations on a global reset', async () => {
  const a = await open()
  a.add('nene', [message('stale')])
  const saving = a.save()
  a.reset()
  expect(await saving).toBe(false)
  expect(localStorage.getItem(CHAT_ARCHIVE_KEY)).toBeNull()
  let acknowledge!: () => void, started!: () => void, finishRead!: (value: unknown) => void
  const writing = new Promise<void>(resolve => { started = resolve })
  vi.mocked(kvSet).mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { acknowledge = resolve }) })
  a.add('nene', [message('before-reset')])
  const inFlight = a.save()
  await writing
  a.reset()
  vi.mocked(kvGet).mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
  const refresh = a.refresh()
  acknowledge()
  expect(await inFlight).toBe(false)
  finishRead({ version: 1, archived: { nene: [message('after-reset')] } })
  await refresh
  expect(a.archive.value.archived.nene.map(item => item.mid)).toEqual(['after-reset'])
})

it('migrates legacy data once and never resurrects the retained source after a clear', async () => {
  localStorage.setItem(CHAT_ARCHIVE_KEY, JSON.stringify({ version: 1, archived: { nene: [message('legacy')] } }))
  const a = await open(), b = await open()
  a.add('nene', [message('a')]); b.add('nene', [message('b')])
  await Promise.all([a.save(), b.save()])
  expect((await open()).archive.value.archived.nene.map(item => item.mid)).toEqual(['legacy', 'a', 'b'])
  a.clear(); await a.save()
  // Even a stale legacy source restored by an old page cannot revive deleted data.
  localStorage.setItem(CHAT_ARCHIVE_KEY, JSON.stringify({ version: 1, archived: { nene: [message('legacy')] } }))
  expect((await open()).archive.value.archived.nene).toEqual([])
})

it('retains an unsupported IndexedDB record without writing an empty replacement', async () => {
  archiveKv.set('chat_archive_v1', { version: 99, sentinel: 'protected' })
  const a = useChatArchiveStorage(['nene'], () => true, vi.fn())
  await expect(a.ready).rejects.toThrow()
  a.add('nene', [message('new')])
  expect(await a.save()).toBe(false)
  expect(archiveKv.get('chat_archive_v1')).toEqual({ version: 99, sentinel: 'protected' })
})

it('preserves temporarily unavailable characters through migration and edits and clears all of them explicitly', async () => {
  localStorage.setItem(CHAT_ARCHIVE_KEY, JSON.stringify({ version: 1, archived: { unavailable_model: [message('keep')] } }))
  const a = await open()
  a.add('nene', [message('new')]); await a.save()
  a.clear('nene'); await a.save()
  expect((await open()).archive.value.archived.unavailable_model.map(item => item.mid)).toEqual(['keep'])
  a.add('new_imported_model', [message('import')], true); await a.save()
  expect((await open()).archive.value.archived.new_imported_model).toHaveLength(1)
  a.clear(); await a.save()
  const current = (await open()).archive.value
  expect(current.archived.unavailable_model).toEqual([])
  expect(current.archived.new_imported_model).toEqual([])
})

it('a clear-all covers characters first observed inside the lock', async () => {
  const stale = await open(), writer = await open()
  writer.add('new_imported_model', [message('import')], true); await writer.save()
  stale.clear(); await stale.save()
  expect((await open()).archive.value.archived.new_imported_model).toEqual([])
})

it.each([{ version: 1 }, { version: 1, archived: [] }, { version: 1, archived: { nene: 'damaged' } }])('refuses malformed authoritative records without overwriting them: %j', async original => {
  archiveKv.set('chat_archive_v1', original)
  const a = useChatArchiveStorage(['nene'], () => true, vi.fn())
  await expect(a.ready).rejects.toThrow()
  a.clear()
  expect(await a.save()).toBe(false)
  expect(archiveKv.get('chat_archive_v1')).toEqual(original)
})

it('retains authoritative data after a failed initial read and permits saving only after a successful refresh', async () => {
  const original = { version: 1, archived: { nene: [message('keep')] } }
  archiveKv.set('chat_archive_v1', original)
  vi.mocked(kvGet).mockRejectedValueOnce(Error('资料已变化，请重新读取归档'))
  const a = useChatArchiveStorage(['nene'], () => true, vi.fn())
  await expect(a.ready).rejects.toThrow('资料已变化')
  a.add('nene', [message('pending')])
  expect(await a.save()).toBe(false)
  expect(archiveKv.get('chat_archive_v1')).toEqual(original)
  await a.refresh()
  expect(await a.save()).toBe(true)
  expect((await open()).archive.value.archived.nene.map(item => item.mid)).toEqual(['keep', 'pending'])
  vi.mocked(kvGet).mockRejectedValueOnce(Error('database unavailable'))
  await expect(a.refresh()).rejects.toThrow('database unavailable')
  a.add('nene', [message('blocked')])
  expect(await a.save()).toBe(false)
  expect((archiveKv.get('chat_archive_v1') as typeof original).archived.nene.map(item => item.mid)).toEqual(['keep', 'pending'])
})
