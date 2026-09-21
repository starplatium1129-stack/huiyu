import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSceneStore } from './sceneStore'

describe('model reference catalog loading', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.unstubAllGlobals() })
  it('loads only the required catalog and reuses its successful cache', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 'fixture', name: 'Fixture' }] })
    vi.stubGlobal('fetch', fetcher)
    const store = useSceneStore()
    await Promise.all([store.loadLoraCatalog(), store.loadLoraCatalog()])
    await store.loadLoraCatalog()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toMatch(/^\/data\/loras.json\?v=/)
    expect(store.loras).toEqual([{ id: 'fixture', name: 'Fixture' }])
    expect(store.loaded).toBe(false)
    expect(store.scenes).toEqual([])
  })
  it('reports failure and retries instead of treating unreadable data as an empty catalog', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetcher)
    const store = useSceneStore()
    await expect(store.loadLoraCatalog()).rejects.toThrow('503')
    expect(store.metaFailedFiles.has('loras.json')).toBe(true)
    await store.loadLoraCatalog()
    expect(store.metaFailedFiles.has('loras.json')).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects a malformed successful response instead of reporting an empty catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ unexpected: [] }) }))
    const store = useSceneStore()
    await expect(store.loadLoraCatalog()).rejects.toThrow('必须是数组')
    expect(store.metaFailedFiles.has('loras.json')).toBe(true)
  })
})
