import { describe, expect, it, vi } from 'vitest'
import { createArtworkReads } from './artworkReads'
import { ARTWORK_HISTORY_KEY } from './artworkStorage'

describe('cancellable web recent-work reads', () => {
  it('retains the existing legacy migration and returns detached records', async () => {
    const legacy = [{ id: 1, timestamp: 3, scene: 'neutral' }]
    const kv = { get: vi.fn(async () => null), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    const storage = { getItem: vi.fn(() => JSON.stringify(legacy)), removeItem: vi.fn() } as unknown as Storage
    const reads = createArtworkReads(kv, { kv, localStorage: storage }, work => work())
    const history = await reads.readRecentHistory()
    history[0].scene = 'changed by view'
    expect(kv.set).toHaveBeenCalledWith(ARTWORK_HISTORY_KEY, legacy)
    expect(storage.removeItem).toHaveBeenCalledWith(ARTWORK_HISTORY_KEY)
    expect(legacy[0].scene).toBe('neutral')
  })
  it('rejects cancellation before migrating legacy data or publishing a pending KV read', async () => {
    let finish!: (value: unknown) => void
    const kv = { get: vi.fn(() => new Promise(resolve => { finish = resolve })), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    const storage = { getItem: vi.fn(() => JSON.stringify([{ id: 1 }])), removeItem: vi.fn() } as unknown as Storage
    const reads = createArtworkReads(kv, { kv, localStorage: storage }, work => work())
    const controller = new AbortController(), reading = reads.readRecentHistory(controller.signal)
    controller.abort(); finish(null)
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(kv.set).not.toHaveBeenCalled(); expect(storage.getItem).not.toHaveBeenCalled()
    await expect(reads.readRecentHistory(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(kv.get).toHaveBeenCalledOnce()
  })
})
