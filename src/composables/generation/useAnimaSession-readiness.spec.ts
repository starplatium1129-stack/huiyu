import { afterEach, expect, it, vi } from 'vitest'
import { useAnimaSession, type AnimaSessionOptions } from './useAnimaSession'
import { apiClient, type ApiClient } from '@/api/client'
import { computed, effectScope, ref } from 'vue'
import { useAnimaInpaint, type AnimaInpaintDeps } from './useAnimaInpaint'
import * as environment from '@/utils/runtimeEnvironment'
import { imageFailurePatch } from './runtimeImageSession'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'

const sessions: ReturnType<typeof useAnimaSession>[] = []
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.restoreAllMocks() })
function createSession(client: ApiClient, options: Partial<AnimaSessionOptions> = {}) {
  const session = useAnimaSession({ getCharacter: () => 'nene', isPopular: () => false,
    getFamily: () => 'anima', preferredSize: () => '832x1216', onResult: vi.fn(), flash: vi.fn(), client,
    getRequest: () => ({ prompt: 'readiness fixture', negative: '', profileId: 'fixture', modelId: 'anima-fixture',
      loraId: null, loraStrength: null, width: 832, height: 1216, steps: 20, cfg: 4, character: null }), ...options })
  sessions.push(session)
  return session
}

it('surfaces missing Krea nodes before submission while retaining deferred managed startup', async () => {
  const nodes = { state: 'missing', required: ['ConditioningKrea2Rebalance', 'ComfyUI-Krea2T-Enhancer'], missing: ['ComfyUI-Krea2T-Enhancer'] }
  const status = { ok: true, online: true, provider: 'comfy', managedStartAvailable: true,
    models: [{ id: 'krea-fixture', family: 'krea2', available: true, nodeReadiness: nodes }], loras: [] }
  const client = { request: vi.fn(async () => status) } as unknown as ApiClient
  const flash = vi.fn()
  const session = createSession(client, { getFamily: () => 'krea2', flash })
  await session.refreshBackend()
  expect(session.state.value).toMatchObject({ online: false, managedStartAvailable: false })
  expect(session.state.value.checkMsg).toContain('ComfyUI-Krea2T-Enhancer')
  vi.mocked(client.request).mockClear()
  await session.generate()
  expect(client.request).not.toHaveBeenCalled()
  expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('一键准备包不包含'))
  nodes.state = 'unknown'; nodes.missing = []; status.online = false
  await session.refreshBackend()
  expect(session.state.value.managedStartAvailable).toBe(true)
  expect(session.state.value.checkMsg).toContain('启动受管服务并检查节点')
  nodes.state = 'ready'; status.online = true
  await session.refreshBackend()
  expect(session.state.value.online).toBe(true)
})

it('keeps Auto hires discovery distinct from absent weights and clears stale provider evidence', async () => {
  const status = { ok: true, online: true, provider: 'comfy', hires: {} as { superResModel?: string | null },
    models: [{ id: 'anima-fixture', family: 'anima', available: true }], loras: [] }
  const client = { request: vi.fn(async () => status) } as unknown as ApiClient
  const session = createSession(client)
  await session.refreshBackend()
  expect(session.state.value.autoHiresModel).toBeUndefined()
  status.hires.superResModel = '4x_foolhardy_Remacri.safetensors'
  await session.refreshBackend()
  expect(session.state.value.autoHiresModel).toBe('4x_foolhardy_Remacri.safetensors')
  status.hires.superResModel = null
  await session.refreshBackend()
  expect(session.state.value.autoHiresModel).toBeNull()
  status.hires.superResModel = '4x_foolhardy_Remacri.safetensors'
  await session.refreshBackend()
  session.patchState({ provider: 'native' })
  expect(session.state.value.autoHiresModel).toBeUndefined()
  await session.refreshBackend()
  vi.mocked(client.request).mockRejectedValueOnce(new Error('status unavailable'))
  await session.refreshBackend()
  expect(session.state.value.autoHiresModel).toBeUndefined()
})


it('keeps optional-node preparation guidance visible after both immediate and accepted-task rejection', () => {
  const message = 'Krea 2 缺少 ComfyUI 节点：ComfyUI-Krea2T-Enhancer。当前一键准备包不包含这些扩展。'
  for (const error of [{ code: 'COMFY_OPTIONAL_NODES_UNAVAILABLE', status: 409, message }, new AcceptedTaskTerminalError('accepted-task', 'failed', message)]) {
    const failure = imageFailurePatch(error, '生成失败')
    expect(failure.errorMsg).toContain('所选功能尚未就绪')
    expect(failure.errorMsg).toContain('ComfyUI-Krea2T-Enhancer')
    expect(failure.errorMsg).toContain('一键准备包不包含')
  }
})


it('carries offline managed automatic-mask intent through upload and the real session submission boundary', async () => {
  vi.spyOn(environment, 'isLocalStudioHost').mockReturnValue(false)
  const status = { ok: true, online: false, provider: 'comfy', managedStartAvailable: true,
    capabilities: { automaticMask: false, automaticMaskStatus: { state: 'unknown', required: ['AP_CLIPSeg_TextMask'], missing: [] } },
    models: [{ id: 'anima-fixture', family: 'anima', available: true, sizes: ['832x1216'], capabilities: { noLora: true } }], loras: [] }
  const client = { request: vi.fn(async (path: string) => path.endsWith('/status') ? status : { ok: false, error: 'submission boundary reached' }) } as unknown as ApiClient
  const session = createSession(client, { isPopular: () => true })
  await session.refreshBackend()
  expect(session.state.value).toMatchObject({ online: false, managedStartAvailable: true, automaticMaskAvailable: false })
  const upload = vi.spyOn(apiClient, 'request').mockResolvedValue({ ok: true, name: 'source.png' })
  const scope = effectScope()
  const tools = scope.run(() => useAnimaInpaint({ pb: { char: 'nene', flash: vi.fn() }, drawEngine: ref('anima'),
    animaState: session.state, generateAnima: session.generate, captureAnimaSubmission: session.captureSubmission,
    preparing: ref(false), isPopular: computed(() => true), popularIdentityTokens: computed(() => []),
  } as unknown as AnimaInpaintDeps))!
  try {
    tools.inpaintOpen.value = true
    await tools.handleInpaintSubmit({ imageBlob: new Blob(['original']), sourceHistoryId: null, maskBlob: null,
      maskPrompt: 'jacket', maskThreshold: .45, newOutfitPrompt: 'blue jacket', negativePrompt: '', denoisingStrength: .6, growMaskBy: 8, seed: 0 })
    expect(upload).toHaveBeenCalledOnce()
    expect(client.request).toHaveBeenCalledWith('/api/anima/jobs', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ initImage: 'source.png', maskPrompt: 'jacket' }) }))
    expect(session.state.value.automaticMaskAvailable).toBe(false)
  } finally { scope.stop() }
})
