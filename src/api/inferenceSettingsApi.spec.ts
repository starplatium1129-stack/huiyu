import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient, type FetchImplementation } from './client'
import { createInferenceSettingsApi } from './inferenceSettingsApi'
const access = vi.hoisted(() => ({ local: true }))
vi.mock('../utils/runtimeEnvironment.ts', () => ({ isLocalStudioHost: () => access.local }))
const settings = { engine: 'native', modelsRoot: '/models', lorasRoot: '/loras', python: '/python', worker: '/worker' }
const response = { ok: true, active: settings, configured: settings, restartRequired: false, environmentOverrides: [] }
const diagnostics = { basis: 'configured', configuration: 'valid', files: { python: true, worker: true, modelsRoot: true, lorasRoot: false }, dependencies: 'unchecked', runtime: 'unverified', message: 'Files only' }
function setup(body: object) {
  const fetch = vi.fn<FetchImplementation>(async () => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }))
  return { fetch, api: createInferenceSettingsApi(createApiClient(fetch)) }
}
beforeEach(() => { access.local = true })
describe('inference settings HTTP boundary', () => {
  it('reads uncached evidence and posts the full settings DTO', async () => {
    const { fetch, api } = setup({ ...response, diagnostics })
    expect(await api.getStatus()).toMatchObject({ diagnostics })
    await api.getStatus()
    expect(fetch).toHaveBeenCalledTimes(2)
    await api.save(settings as Parameters<typeof api.save>[0])
    expect(fetch.mock.calls[2]).toEqual(['/api/inference/settings', expect.objectContaining({ method: 'POST', body: JSON.stringify(settings) })])
  })
  it('rejects malformed readiness claims and propagates configuration conflicts', async () => {
    await expect(setup({ ...response, diagnostics: { ...diagnostics, runtime: 'ready' } }).api.getStatus()).rejects.toMatchObject({ kind: 'invalid-response' })
    const { fetch, api } = setup(response)
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, code: 'CONFIG_ENV_OVERRIDE', error: 'Environment override' }), { status: 409 }))
    await expect(api.save(settings as Parameters<typeof api.save>[0])).rejects.toMatchObject({ status: 409, code: 'CONFIG_ENV_OVERRIDE' })
  })
  it('validates the active-only dependency probe without claiming generation verification', async () => {
    const probe = { id: null, event: 'diagnostic', valid: true, dependencies: { torch: '2.7' }, cudaAvailable: false, deviceName: null, scope: 'dependencies-only' }
    const { api, fetch } = setup({ ok: true, basis: 'active', probe })
    expect(await api.diagnose()).toMatchObject({ basis: 'active', probe })
    expect(fetch.mock.calls[0][0]).toBe('/api/inference/diagnostics')
    await expect(setup({ ok: true, basis: 'configured', probe }).api.diagnose()).rejects.toMatchObject({ kind: 'invalid-response' })
  })
  it('does not expose paths or execute diagnostics remotely', async () => {
    access.local = false
    const { fetch, api } = setup(response)
    await expect(api.getStatus()).rejects.toThrow('仅限本机')
    await expect(api.save(settings as Parameters<typeof api.save>[0])).rejects.toThrow('仅限本机')
    await expect(api.diagnose()).rejects.toThrow('仅限本机')
    expect(fetch).not.toHaveBeenCalled()
  })
})
