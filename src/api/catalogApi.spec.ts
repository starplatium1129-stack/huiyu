import { afterEach, expect, it, vi } from 'vitest'
import { apiClient, createApiClient } from './client'
import { catalogApi, type CatalogRecord } from './catalogApi'

const record: CatalogRecord = { kind: 'scene', id: 'sc001', revision: 1, sortOrder: 0, createdAt: null, updatedAt: null, data: { title: 'Scene' } }
const summary = { kind: record.kind, id: record.id, revision: 1, sortOrder: 0, createdAt: null, updatedAt: null, title: 'Scene', characterId: '', category: '', rating: 'ALL' }
const page = { ok: true, version: 1, items: [summary], total: 1, page: 1, pageSize: 24, facets: { characters: [], categories: [], ratings: ['ALL'] } }
const receipt = { ok: true, preview: true, version: 1, batch: 'batch', items: [{ kind: 'scene', id: 'sc001', revision: 1, removed: false }], diffs: [{ kind: 'scene', id: 'sc001', before: null, after: record }] }
function respond(body: unknown) {
  vi.spyOn(apiClient, 'request').mockImplementation(createApiClient(async () => Response.json(body)).request)
}
afterEach(() => vi.restoreAllMocks())

it('accepts the native catalog page and preview receipt without discarding extensions', async () => {
  respond({ ...page, extension: 'retained' })
  expect(await catalogApi.query({ kind: 'scene' })).toEqual({ ...page, extension: 'retained' })
  respond(receipt)
  expect(await catalogApi.changes([], true)).toEqual(receipt)
  expect(await catalogApi.importSnapshot({ version: 1, records: [record], retired: [] })).toEqual(receipt)
})

it('rejects malformed facets and summary metadata before they reach the catalog view', async () => {
  for (const body of [{ ...page, facets: { ...page.facets, categories: 'wrong' } }, { ...page, items: [{ ...summary, kind: 'unknown' }] }]) {
    respond(body)
    await expect(catalogApi.query({ kind: 'scene' })).rejects.toMatchObject({ kind: 'invalid-response' })
  }
})

it('rejects unusable change previews through both save and import responses', async () => {
  respond({ ...receipt, diffs: [{ kind: 'scene', id: 'sc001', before: null, after: null }] })
  await expect(catalogApi.changes([], true)).rejects.toMatchObject({ kind: 'invalid-response' })
  respond({ ...receipt, diffs: [{ kind: 'scene', id: 'sc001', before: null, after: { ...record, revision: '1' } }] })
  await expect(catalogApi.importSnapshot({ version: 1, records: [], retired: [] })).rejects.toMatchObject({ kind: 'invalid-response' })
})
