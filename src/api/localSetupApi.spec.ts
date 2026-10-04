import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient, configureApiTransport, type FetchImplementation } from './client'
import { createLocalSetupApi } from './localSetupApi'
import { initializeDesktopRuntime, refreshDesktopRuntime } from '../platform/desktop/runtime.ts'
import { setRuntimeOrigin } from '../platform/runtimeUrl.ts'
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
  return { fetch, api: createLocalSetupApi(createApiClient(fetch), fetch) }
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
    await expect(api.verifyModel('qwen-vae', { signal: new AbortController().signal, onProgress: vi.fn() })).rejects.toThrow('仅限本机')
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
  it('requires a complete, matching hash result and cancels the stream on abort', async () => {
    const modelId = 'qwen-vae'
    const terminal = { type: 'result', modelId, path: 'D:\\AI\\ComfyUI\\models\\vae\\qwen_image_vae.safetensors', state: 'sha256-match', bytes: 10, sha256: 'b'.repeat(64), checkedAt: 1, message: 'verified bytes only' }
    const progress = { type: 'progress', modelId, bytesRead: 5, expectedBytes: 10 }
    const fetch = vi.fn<FetchImplementation>(async () => new Response(JSON.stringify(progress) + '\n' + JSON.stringify(terminal) + '\n', { headers: { 'content-type': 'application/x-ndjson' } }))
    const api = createLocalSetupApi(createApiClient(fetch), fetch)
    const onProgress = vi.fn()
    expect(await api.verifyModel(modelId, { signal: new AbortController().signal, onProgress })).toEqual(terminal)
    expect(onProgress).toHaveBeenCalledWith(progress)
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(progress) + '\n', { headers: { 'content-type': 'application/x-ndjson' } }))
    await expect(api.verifyModel(modelId, { signal: new AbortController().signal, onProgress })).rejects.toThrow('意外中断')
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...terminal, modelId: 'other' }), { headers: { 'content-type': 'application/x-ndjson' } }))
    await expect(api.verifyModel(modelId, { signal: new AbortController().signal, onProgress })).rejects.toThrow('不匹配')
    const cancel = vi.fn()
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/x-ndjson' } }))
    const controller = new AbortController()
    const pending = api.verifyModel(modelId, { signal: controller.signal, onProgress })
    await Promise.resolve(); controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalled()
  })

  it('routes bundled desktop hash streams through the runtime transport and aborts on epoch replacement', async () => {
    const origin = 'http://127.0.0.1:4312', sourceOrigin = 'http://tauri.localhost'
    const descriptor = { protocolVersion: 1, windowRole: 'atelier', windowId: 'atelier', sourceProfileId: `profile-${'a'.repeat(64)}`, sourceOrigin, bundledUiAvailable: true, connection: 'ready', runtime: { origin, protocolVersion: 1, ownership: 'managed', runtimeEpoch: 'hash-desktop-1', workspace: null } }
    const invoke = vi.fn().mockResolvedValue(descriptor)
    vi.stubGlobal('window', { location: new URL(sourceOrigin), __TAURI__: { core: { invoke } } })
    const terminal = { type: 'result', modelId: 'qwen-vae', path: 'D:\\AI\\ComfyUI\\models\\vae\\qwen_image_vae.safetensors', state: 'sha256-match', bytes: 10, sha256: 'b'.repeat(64), checkedAt: 1, message: 'verified bytes only' }
    const fetch = vi.fn<FetchImplementation>(async () => new Response(JSON.stringify(terminal) + '\n', { headers: { 'content-type': 'application/x-ndjson' } }))
    vi.stubGlobal('fetch', fetch)
    let stop: (() => void) | undefined
    try {
      stop = await initializeDesktopRuntime()
      const api = createLocalSetupApi()
      await expect(api.verifyModel('qwen-vae', { signal: new AbortController().signal, onProgress: vi.fn() })).resolves.toEqual(terminal)
      expect(fetch.mock.calls[0][0]).toBe(origin + '/api/local-setup/verify/qwen-vae')
      expect(fetch.mock.calls[0][1]?.method).toBe('POST')
      let started!: () => void
      const waiting = new Promise<void>(resolve => { started = resolve })
      let transportSignal: AbortSignal | undefined
      fetch.mockImplementationOnce(async (_url, init) => {
        transportSignal = init?.signal as AbortSignal
        return new Response(new ReadableStream({ start(controller) {
          transportSignal!.addEventListener('abort', () => controller.error(new DOMException('runtime replaced', 'AbortError')), { once: true })
          started()
        } }), { headers: { 'content-type': 'application/x-ndjson' } })
      })
      const caller = new AbortController()
      const pending = api.verifyModel('qwen-vae', { signal: caller.signal, onProgress: vi.fn() })
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await waiting
      invoke.mockResolvedValueOnce({ ...descriptor, runtime: { ...descriptor.runtime, runtimeEpoch: 'hash-desktop-2' } })
      await refreshDesktopRuntime()
      await rejection
      expect(transportSignal?.aborted).toBe(true)
      expect(caller.signal.aborted).toBe(false)
    } finally { stop?.(); setRuntimeOrigin(null, false); configureApiTransport(); vi.unstubAllGlobals() }
  })

})
