import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client'
import { createResourceApi } from './resourceApi'

describe('resource API boundary', () => {
  it('rejects malformed status instead of enabling a partially defined resource panel', async () => {
    const api = createResourceApi(createApiClient(async () => new Response(JSON.stringify({ ok: true, busy: false }), { status: 200 })))
    await expect(api.status()).rejects.toMatchObject({ kind: 'invalid-response' })
  })
  it('sends only the selected release ID and action, never a local path or source URL', async () => {
    const task = { id: 'e58ce240-61d8-4a71-a496-bcbd4e74a7d5', action: 'import', releaseId: 'portrait',
      resumeAction: null, state: 'running', phase: 'checking', bytes: 0, total: 0, startedAt: 1, finishedAt: 0, error: null }
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, task }), { status: 202 }))
    const api = createResourceApi(createApiClient(fetch))
    await api.start('import', 'portrait')
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls[0]?.[0]).toBe('/api/resources/tasks')
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({ action: 'import', releaseId: 'portrait' })
    expect(calls[0]?.[1].cache).toBe('no-store')
    await api.start('recover', 'ignored')
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({ action: 'recover' })
  })
})
