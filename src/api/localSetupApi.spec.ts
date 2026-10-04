import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient, type FetchImplementation } from './client'
import { createLocalSetupApi } from './localSetupApi'
import type { LocalSetupResponse } from '../../types/local-setup'

const access = vi.hoisted(() => ({ local: true }))
vi.mock('../utils/runtimeEnvironment.ts', () => ({ isLocalStudioHost: () => access.local }))

function snapshot(): LocalSetupResponse {
  return {
    ok: true, checkedAt: 1_791_083_000_000,
    workspace: { path: 'D:\\AI', state: 'present' },
    comfy: { path: 'D:\\AI\\ComfyUI', installation: 'present', layout: 'portable', host: 'http://127.0.0.1:8188', connection: 'offline' },
    models: ['anima-aesthetic-v1.1', 'qwen-encoder', 'qwen-vae'].map(id => ({ id, label: id, path: `D:\\AI\\ComfyUI\\models\\${id}`, state: 'unknown', bytes: null, required: true, preparation: { url: 'https://huggingface.co/circlestone-labs/Anima/resolve/' + 'a'.repeat(40) + '/model.safetensors', modelCardUrl: 'https://huggingface.co/circlestone-labs/Anima', licenseUrl: 'https://huggingface.co/circlestone-labs/Anima/blob/' + 'a'.repeat(40) + '/LICENSE.md', upstreamLicenseUrl: null, revision: 'a'.repeat(40), expectedBytes: 10, sha256: 'b'.repeat(64) } })),
    nodes: { state: 'unknown', required: ['ImageSharpenKJ'], missing: [] },
    hardware: { state: 'unknown', devices: [], ramBytes: null },
  }
}
function setup(body: object) {
  const fetch = vi.fn<FetchImplementation>(async () => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }))
  return { fetch, api: createLocalSetupApi(createApiClient(fetch)) }
}
beforeEach(() => { access.local = true })

describe('local setup read-only HTTP boundary', () => {
  it('preserves unknown evidence and refreshes without caching', async () => {
    const body = snapshot()
    body.models.push({ id: 'other', label: 'Other', path: 'D:\\AI\\ComfyUI\\models\\other', state: 'present', bytes: 10, required: false, preparation: null })
    const { fetch, api } = setup(body)
    expect(await api.getStatus()).toEqual(body)
    await api.getStatus()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]).toEqual(['/api/local-setup', expect.objectContaining({ method: 'GET', cache: 'no-store', signal: expect.any(AbortSignal) })])
  })
  it('refuses non-local reads before contacting the runtime', async () => {
    access.local = false
    const { fetch, api } = setup(snapshot())
    await expect(api.getStatus()).rejects.toThrow('仅限本机')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects absent recommended-model evidence and malformed device reports', async () => {
    const absent = snapshot(); absent.models.pop()
    await expect(setup(absent).api.getStatus()).rejects.toMatchObject({ kind: 'invalid-response' })
    const unsafe = snapshot(); unsafe.models[0].preparation!.url = 'javascript:alert(1)'
    await expect(setup(unsafe).api.getStatus()).rejects.toMatchObject({ kind: 'invalid-response' })
    const noSource = snapshot(); noSource.models[0].preparation = null
    await expect(setup(noSource).api.getStatus()).rejects.toMatchObject({ kind: 'invalid-response' })
    const malformed = snapshot(); malformed.hardware.devices.push({ name: 'device', type: 'cuda', vramBytes: -1 })
    await expect(setup(malformed).api.getStatus()).rejects.toMatchObject({ kind: 'invalid-response' })
  })
})
