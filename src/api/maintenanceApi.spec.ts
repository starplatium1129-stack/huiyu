import { describe, expect, it, vi } from 'vitest'
import { createApiClient, type FetchImplementation } from './client'
import { createMaintenanceApi } from './maintenanceApi'

function setup(body: object, status = 200) {
  const fetch = vi.fn<FetchImplementation>(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  return { fetch, api: createMaintenanceApi(createApiClient(fetch)) }
}

describe('scene maintenance HTTP contract (mock transport)', () => {
  it('accepts explicit hero uploads and keeps legacy entries identifiable', async () => {
    for (const source of [undefined, 'upload']) {
      const entry = { image: '/scene-showcase/home/nene.jpg?v=1', updatedAt: '2026-09-28T12:00:00Z', source }
      const result = await setup({ ok: true, version: 2, entries: { nene: entry } }).api.getHomeHero()
      expect(result.entries.nene?.source).toBe(source)
    }
  })
  it.each([
    { image: 'https://example.com/image.jpg', updatedAt: null },
    { image: '/scene-showcase/home/natsume.jpg?v=1', updatedAt: null },
    { image: '/scene-showcase/home/nene.jpg?v=1', updatedAt: 'invalid' },
    { image: '/scene-showcase/home/nene.jpg?v=1', updatedAt: null, source: 'unknown' },
    null,
  ])('rejects malformed hero entry %s at the HTTP boundary', async entry => {
    await expect(setup({ ok: true, version: 2, entries: { nene: entry } }).api.getHomeHero())
      .rejects.toMatchObject({ kind: 'invalid-response' })
  })
  it.each([403, 409, 501])('preserves HTTP %s and recovery details without retrying another endpoint', async status => {
    const body = { ok: false, error: '拒绝', recovery: '请重新读取', conflict: { currentVersion: 99 } }
    const { fetch, api } = setup(body, status)
    await expect(api.saveShowcase({ id: 'sc001', image: 'fixture-image', thumbnail: 'fixture-thumbnail' })).rejects.toMatchObject({ status, responseBody: body })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
