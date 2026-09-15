import { describe, expect, it, vi } from 'vitest'
import { createApiClient, type FetchImplementation } from './client'
import { createMaintenanceApi } from './maintenanceApi'
import type { SceneChangesPayload, SceneMaintenanceSnapshot } from '@/types/api'

const snapshot: SceneMaintenanceSnapshot = { scenes: [], tags: [], curation: {}, blueprints: [] }
const payload: SceneChangesPayload = { baseVersion: 42, changeSet: { version: 1, scenes: { upsert: [], remove: ['sc1000'] } } }
const preview = { ok: true, baseVersion: 42, version: 42, added: [], updated: [], removed: ['sc1000'],
  blueprints: { added: [], updated: [], removed: [] }, related: [], checks: ['fixture'], unknown: ['未验证'] }
const receipt = { ok: true, count: 1, backup: 'fixture', version: 43, snapshot }
function setup(body: object, status = 200) {
  const fetch = vi.fn<FetchImplementation>(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  return { fetch, api: createMaintenanceApi(createApiClient(fetch)) }
}

describe('scene maintenance HTTP contract (mock transport)', () => {
  it('posts the exact delta envelope for preview and changes without full snapshot fields', async () => {
    const read = setup(preview)
    await read.api.previewSceneChanges(payload)
    const write = setup(receipt)
    await write.api.saveSceneChanges(payload)
    for (const [fetch, endpoint] of [[read.fetch, 'preview'], [write.fetch, 'changes']] as const) {
      expect(fetch.mock.calls[0][0]).toBe('/api/maintenance/scenes/' + endpoint)
      expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', cache: 'no-store' })
      expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(payload)
    }
  })
  it('keeps the legacy endpoint and offers an explicit complete import endpoint', async () => {
    const { fetch, api } = setup(receipt)
    await api.importScenesSnapshot({ ...snapshot, baseVersion: 42 })
    await api.saveScenes({ ...snapshot, baseVersion: 42 })
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/maintenance/scenes/import', '/api/maintenance/scenes'])
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ ...snapshot, baseVersion: 42 })
  })
  it.each([{ ...preview, related: [null] }, { ...preview, unknown: [1] }, { ...preview, version: 1.5 }, { ...preview, blueprints: null }])('rejects malformed impact responses', async body => {
    await expect(setup(body).api.previewSceneChanges(payload)).rejects.toMatchObject({ kind: 'invalid-response' })
  })
  it.each([403, 409, 501])('preserves HTTP %s and recovery details without retrying another endpoint', async status => {
    const body = { ok: false, error: '拒绝', recovery: '请重新读取', conflict: { currentVersion: 99 } }
    const { fetch, api } = setup(body, status)
    await expect(api.saveSceneChanges(payload)).rejects.toMatchObject({ status, responseBody: body })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
