import { afterEach, describe, expect, it, vi } from 'vitest'
import { animaRequestPayload, closestSupportedSize, resolveInpaintRequestBinding, useAnimaSession, type AnimaRequest, type AnimaSessionOptions } from './useAnimaSession'
import type { ApiClient, ApiRequestOptions } from '@/api/client'
import type { AnimaJobMetadata } from '@/types/anima'
import * as environment from '@/utils/runtimeEnvironment'

const request: AnimaRequest = {
  prompt: 'cancel fixture',
  negative: '',
  profileId: 'default',
  modelId: 'anima-fixture',
  loraId: null,
  loraStrength: null,
  width: 832,
  height: 1216,
  steps: 20,
  cfg: 4,
  character: 'nene',
}

const sessions: ReturnType<typeof useAnimaSession>[] = []
afterEach(() => {
  sessions.splice(0).forEach(session => session.dispose())
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  vi.doUnmock('./animaJobPolling')
})

function createSession(client: ApiClient, options: Partial<AnimaSessionOptions> = {}) {
  const session = useAnimaSession({ getCharacter: () => 'nene', isPopular: () => false,
    getFamily: () => 'anima', getRequest: () => request, preferredSize: () => '832x1216',
    onResult: vi.fn(), flash: vi.fn(), client, ...options })
  sessions.push(session)
  return session
}

it('keeps the default MiaoMiao 1.6 offline rather than silently substituting an older available model', async () => {
  const client = { request: vi.fn(async () => ({ ok: true, online: true, models: [
    { id: 'anima-miaomiao-v1.2', family: 'anima', available: true, sizes: ['832x1216'], defaults: { steps: 30, cfg: 4.5 } },
    { id: 'anima-miaomiao-v1.6', family: 'anima', available: false, sizes: ['832x1216'], defaults: { steps: 30, cfg: 4.5 } },
  ], loras: [] })) } as unknown as ApiClient
  const session = createSession(client)
  await session.refreshBackend()
  expect(session.state.value).toMatchObject({ modelId: 'anima-miaomiao-v1.6', online: false })
  session.applyModel('anima-miaomiao-v1.2')
  await session.refreshBackend()
  expect(session.state.value).toMatchObject({ modelId: 'anima-miaomiao-v1.2', online: true })
})

describe('useAnimaSession · backend status and polling', () => {
  it('底模未发生改变的心跳轮询不覆写用户手动调整的 cfg、steps 与已选风格 LoRA', async () => {
    const statusData = {
      ok: true,
      online: true,
      models: [{
        id: 'model-a',
        family: 'krea2',
        available: true,
        sizes: ['1024x1024'],
        defaults: { steps: 20, cfg: 5 },
      }],
      loras: [{ id: 'L_NENE_V21_ANIMA', character: 'nene', available: true }],
      styleLoras: [{ id: 'style-1', label: 'Style 1' }],
    }
    const client = {
      request: vi.fn(async () => statusData),
    } as unknown as ApiClient

    const session = useAnimaSession({
      getCharacter: () => 'nene',
      isPopular: () => false,
      getFamily: () => 'krea2',
      getRequest: () => request,
      onResult: vi.fn(),
      flash: vi.fn(),
      preferredSize: () => '832x1216',
      client,
    })

    // 首次轮询拉取，套用底模默认值
    await session.refreshBackend()
    expect(session.state.value.cfg).toBe(5)
    expect(session.state.value.steps).toBe(20)
    expect(session.state.value.family).toBe('krea2')
    expect(session.state.value.loras).toEqual([])
    expect(`${session.state.value.width}x${session.state.value.height}`).toBe('1024x1024')

    // 用户手动调整了 cfg、steps 并选择了风格 LoRA
    session.patchState({ cfg: 7.5, steps: 35, styleLoraId: 'style-1' })

    // 再次触发心跳轮询（底模 model-a 未变）
    await session.refreshBackend()

    // 断言用户参数未被静默改回默认值
    expect(session.state.value.cfg).toBe(7.5)
    expect(session.state.value.steps).toBe(35)
    expect(session.state.value.styleLoraId).toBe('style-1')

    session.dispose()
  })
})

it('converges unsupported sizes and keeps character versus no-LoRA inpaint binding coherent', () => {
  const model = { sizes: ['832x1216', '1024x1536', '768x1344'] }
  expect(closestSupportedSize(model, '832x1216')).toBe('832x1216')
  expect(closestSupportedSize(model, '800x1200')).toBe('1024x1536')
  expect(closestSupportedSize(undefined, '832x1216')).toBe('832x1216')
  expect(closestSupportedSize({ sizes: [] }, '832x1216')).toBe('832x1216')
  const models = [{ id: 'character', sizes: ['832x1216', '960x1536'] },
    { id: 'no-lora', sizes: ['1216x832'], capabilities: { negative: true, lora: true, noLora: true, characterIdentity: true, experimental: false } }]
  expect(resolveInpaintRequestBinding(models, 'character', 'natsume', '900x1400'))
    .toEqual({ character: 'natsume', loraId: 'L_NAT_V21_ANIMA', modelId: 'character', width: 960, height: 1536 })
  expect(resolveInpaintRequestBinding(models, 'character', 'none', '1216x832'))
    .toEqual({ character: null, loraId: null, modelId: 'no-lora', width: 1216, height: 832 })
  expect(resolveInpaintRequestBinding([models[0]!], 'character', 'none', '832x1216')).toBeNull()
})

it('omits unset transport fields and never overrides an explicit denied adult authorization', () => {
  vi.spyOn(environment, 'isLocalStudioHost').mockReturnValue(true)
  const minimal = animaRequestPayload(request)
  expect(minimal).toEqual({ prompt: 'cancel fixture', negative: '', modelId: 'anima-fixture',
    width: 832, height: 1216, steps: 20, cfg: 4, character: 'nene', adultEnabled: true })
  expect(animaRequestPayload({ ...request, loraId: 'L', loraStrength: 0, styleLoraId: 'S', seed: 0 }))
    .toEqual({ ...minimal, loraId: 'L', loraStrength: 0, styleLoraId: 'S', seed: 0 })
  expect(animaRequestPayload({ ...request, adultEnabled: false })).not.toHaveProperty('adultEnabled')
  vi.mocked(environment.isLocalStudioHost).mockReturnValue(false)
  expect(animaRequestPayload(request)).not.toHaveProperty('adultEnabled')
})

it.each([false, true])('filters backend discovery and character LoRA with popular=%s', async popular => {
  const client = { request: vi.fn(async () => ({ ok: true, online: true,
    models: [
      { id: 'no-lora', family: 'anima', available: true, capabilities: { noLora: true }, defaults: { steps: 24, cfg: 3 } },
      { id: 'lora-only', family: 'anima', available: true },
      { id: 'krea', family: 'krea2', available: true },
    ],
    loras: [{ id: 'L_NENE_V21_ANIMA', character: 'nene', available: true }, { id: 'L_NAT_V21_ANIMA', character: 'natsume', available: true }],
  })) } as unknown as ApiClient
  const session = createSession(client, { isPopular: () => popular })
  await session.refreshBackend()
  expect(session.state.value.models.map(model => model.id)).toEqual(popular ? ['no-lora'] : ['no-lora', 'lora-only'])
  expect(session.state.value.loras.map(lora => lora.id)).toEqual(popular ? [] : ['L_NENE_V21_ANIMA'])
  expect(session.state.value).toMatchObject({ online: true, modelId: 'no-lora', steps: 24, cfg: 3 })
  expect(session.state.value.checkMsg).toContain('Anima 在线')
  session.syncCharacter('nene')
  expect(session.state.value.loraId).toBe(popular ? '' : 'L_NENE_V21_ANIMA')
  session.syncCharacter('triad'); expect(session.state.value.loraId).toBe('')
  session.syncCharacter('natsume'); expect(session.state.value.loraId).toBe('')
})

it.each(['anima', 'krea2'] as const)('%s success freezes submitted context and remains restorable after repeated failures', async family => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image']), { headers: { 'content-type': 'image/png' } })))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:completed')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  let reads = 0, prompt = 'submitted prompt'
  const context = { characterId: 'task-a', outfitId: 'outfit-a' }
  const onResult = vi.fn(), flash = vi.fn()
  const base = family === 'anima' ? '/api/anima/jobs' : '/api/creative/jobs'
  const call = vi.fn(async (url: string, _options?: ApiRequestOptions) => {
    if (url === base || ++reads === 1) return { ok: true, job: { id: 'success', status: 'queued', seed: 0 } }
    return { ok: true, job: { id: 'success', status: 'succeeded', seed: 0, resultAvailable: true, resultUrl: `${base}/success/result` } }
  })
  const session = createSession({ request: call } as unknown as ApiClient, { getFamily: () => family,
    getRequest: () => ({ ...request, prompt, modelId: family === 'krea2' ? 'krea2-turbo-fp8' : 'anima-fixture' }), getSubmitContext: () => context, onResult, flash })
  await session.generate()
  expect(call).not.toHaveBeenCalled()
  expect(flash).toHaveBeenCalledWith(expect.stringContaining('当前未连接'))
  expect(session.state.value.phase).toBe('idle')
  session.patchState({ online: true, family })
  const generating = session.generate()
  expect(call.mock.calls[0]?.[0]).toBe(base)
  expect(call.mock.calls[0]?.[1]?.method).toBe('POST')
  expect(call.mock.calls[0]?.[1]?.body).toMatchObject({ modelId: family === 'krea2' ? 'krea2-turbo-fp8' : 'anima-fixture', prompt: 'submitted prompt' })
  expect(call.mock.calls[0]?.[1]?.body).not.toHaveProperty('loraId')
  prompt = 'later prompt'; context.characterId = 'task-b'; context.outfitId = 'outfit-b'
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(2000)
  await generating
  expect(session.state.value.phase).toBe('succeeded')
  expect(onResult).toHaveBeenCalledOnce()
  expect(session.state.value.result).toMatchObject({ url: 'blob:completed', metadata: { id: 'success', seed: 0, prompt: 'submitted prompt' } })
  expect(session.state.value.resultContext).toMatchObject({ characterId: 'task-a', outfitId: 'outfit-a' })
  const recipe = session.resultSubmission()!
  expect(recipe).toMatchObject({ family, request: { prompt: 'submitted prompt', seed: 0 }, context: { characterId: 'task-a' } })
  recipe.request.prompt = 'external edit'; recipe.context!.characterId = 'external edit'
  expect(session.resultSubmission()).toMatchObject({ request: { prompt: 'submitted prompt' }, context: { characterId: 'task-a' } })
  call.mockRejectedValue(new Error('network down'))
  await session.generate({ hiresFix: true, hiresScale: 2, hiresDenoise: 0.35 }, session.resultSubmission()!)
  expect(call.mock.calls.at(-1)?.[1]?.body).toMatchObject({ prompt: 'submitted prompt', seed: 0, hiresFix: true })
  await session.generate()
  expect(session.state.value.phase).toBe('failed')
  expect(session.state.value.result).toBeNull()
  expect(session.stashedResult.value).toMatchObject({ result: { url: 'blob:completed' }, context: { characterId: 'task-a' } })
  expect(session.restoreStashedResult()).toBe(true)
  expect(session.state.value).toMatchObject({ phase: 'succeeded', errorMsg: '', resultContext: { outfitId: 'outfit-a' } })
  expect(session.restoreStashedResult()).toBe(false)
  const count = call.mock.calls.length
  session.dispose(); await session.generate()
  expect(call).toHaveBeenCalledTimes(count)

  vi.doMock('./animaJobPolling', () => { throw new Error('observer chunk unavailable') })
  const cancelled = { ok: true, job: { id: 'unobserved', status: family === 'anima' ? 'cancelled' : 'cancelling' } }
  const recoveryCall = vi.fn(async (_url: string, options?: ApiRequestOptions) => options?.method === 'POST'
    ? { ok: true, job: { id: 'unobserved', status: 'queued', seed: 0 } } : cancelled)
  const recovery = createSession({ request: recoveryCall } as unknown as ApiClient, { getFamily: () => family })
  recovery.patchState({ online: true, family })
  await recovery.generate()
  expect(recoveryCall.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([[base, 'POST'], [`${base}/unobserved`, 'DELETE']])
  expect(recovery.state.value.phase).toBe(family === 'anima' ? 'cancelled' : 'cancelling')
  expect(recovery.state.value.job?.id).toBe('unobserved')
  if (family === 'krea2') expect(recovery.state.value.statusText).toContain('取消尚未确认')
})

it('uses the accepted Web Krea metadata after provider style processing, even if the panel changes', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image']), { headers: { 'content-type': 'image/png' } })))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:completed')
  const metadata = { ...request, id: 'style-result', engine: 'krea2', prompt: request.prompt + ', actual style trigger',
    seed: 0, sampler: 'actual-sampler', scheduler: 'actual-scheduler' } as AnimaJobMetadata
  const client = { request: vi.fn(async () => ({ ok: true, job: { id: 'style-result', status: 'succeeded', metadata, seed: 0,
    resultAvailable: true, resultUrl: '/api/creative/jobs/style-result/result' } })) } as unknown as ApiClient
  const session = createSession(client)
  session.patchState({ online: true, family: 'krea2' })
  const generating = session.generate()
  session.patchState({ sampler: 'later-sampler', scheduler: 'later-scheduler' })
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(1000); await generating
  expect(session.state.value.result?.metadata).toMatchObject({ prompt: request.prompt + ', actual style trigger', seed: 0, sampler: 'actual-sampler' })
  metadata.prompt = 'Mutated transport response'
  expect(session.state.value.result?.metadata.prompt).toBe(request.prompt + ', actual style trigger')
})
