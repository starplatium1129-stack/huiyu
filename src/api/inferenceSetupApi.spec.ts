import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient, type FetchImplementation } from './client'
import { createInferenceSetupApi } from './inferenceSetupApi'
const access = vi.hoisted(() => ({ local: true }))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => access.local }))
const paths = { python: '/ai/inference/venv/bin/python', worker: '/worker.py', modelsRoot: '/ai/inference/models', lorasRoot: '/ai/inference/loras' }
const prepare = { basePython: '/python', wheelhouse: '/wheels', workspacePath: '/ai', reviewed: true as const }
function setup(body: object) {
  const fetch = vi.fn<FetchImplementation>(async () => new Response(JSON.stringify(body)))
  return { fetch, api: createInferenceSetupApi(createApiClient(fetch)) }
}
beforeEach(() => { access.local = true })
describe('offline inference setup boundary', () => {
  it('posts only explicit offline preparation inputs and validates its operation receipt', async () => {
    const operation = { id: 'prepare-1', kind: 'prepare-inference-runtime', status: 'running', message: '', error: '', startedAt: 1 }
    const { api, fetch } = setup({ ok: true, operation, preparedPaths: paths })
    await api.prepareRuntime(prepare)
    expect(fetch.mock.calls[0]).toEqual(['/api/inference/runtime/prepare', expect.objectContaining({ method: 'POST', body: JSON.stringify(prepare) })])
    await expect(setup({ ok: true, operation, preparedPaths: { python: '/python' } }).api.prepareRuntime(prepare)).rejects.toMatchObject({ kind: 'invalid-response' })
    access.local = false
    await expect(api.prepareRuntime(prepare)).rejects.toThrow('仅限本机')
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('enforces catalog Anima IDs and rejects readiness claims beyond layout-only inspection', async () => {
    const plan = { ok: true, planOnly: true, scope: 'layout-only', readyForInference: false, sourceDir: '/source', targetDir: '/models/anima-miaomiao-v1.6', fileCount: 8, totalBytes: 200 }
    const { api, fetch } = setup(plan)
    await api.inspectModel({ modelId: 'anima-miaomiao-v1.6', sourceDir: '/source' })
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ modelId: 'anima-miaomiao-v1.6', sourceDir: '/source' })
    await expect(api.importModel({ modelId: 'sdxl', sourceDir: '/source', modelsRoot: '/models', reviewed: true })).rejects.toThrow('Anima')
    await expect(setup({ ...plan, readyForInference: true }).api.inspectModel({ modelId: 'anima-miaomiao-v1.6', sourceDir: '/source' })).rejects.toMatchObject({ kind: 'invalid-response' })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
