import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { apiClient, ApiClientError } from '@/api/client'
import { usePromptBatchRunners, type PromptBatchRunnersDeps } from './usePromptBatchRunners'
import { applyInterrogateResult } from './applyInterrogateResult'
import type { DraftOutfitOverride, DraftReferenceInput } from '@/utils/promptBuilderPersistence'

function setup() {
  const character = { id: 'audit', displayName: '测试角色', aliases: ['audit_(series)'], identityProse: 'An adult woman with black hair and blue eyes', identityTokens: ['1girl', 'solo', 'black_hair', 'blue_eyes'], exactTokens: ['audit_(series)'], exactPrefixes: [], adultEligibility: 'adult', outfits: [
    { id: 'school', name: '校服', tokens: ['school_uniform'], prose: 'a school uniform', default: true },
    { id: 'coat', name: '外套', tokens: ['coat'], prose: 'a long coat' },
  ] }
  const blueprint = { id: 'one', title: '雨夜', characterId: 'audit', outfitId: 'coat', promptProse: 'An adult woman sits beside a rainy cafe window', promptTokens: ['night', 'rain', 'sitting', 'cafe'], negativeTokens: ['watermark'], recommendedSize: '1216x832', adult: false, camera: 'medium shot', location: 'cafe', lighting: 'warm', sceneTags: [] }
  const pb = { subject: { kind: 'popular', characterId: 'audit', outfitId: 'school', blueprintId: null }, char: 'nene', isPopular: true, selections: { shot: null, lighting: null, composition: null }, sdParams: { seedLock: true, seed: 42 }, manualTags: new Set<string>(), artistStyleIds: [], tags: [], outfitOverride: null as DraftOutfitOverride | null, referenceInput: null as DraftReferenceInput | null, tagDictionary: { canonicalize: (tag: string) => tag }, showMatureScenes: true, story: '', visualDescription: '', emotionPrompt: '', flash: vi.fn(), commitHistoryEntry: vi.fn().mockResolvedValue({ id: 1 }), popularCharacters: [character], sceneBlueprints: [blueprint], setOutfitOverride: vi.fn(), clearOutfitOverride: vi.fn() }
  pb.setOutfitOverride.mockImplementation((tokens: string[], replaced: string | null) => { pb.outfitOverride = { tokens: [...tokens], replaced } })
  pb.clearOutfitOverride.mockImplementation(() => { pb.outfitOverride = null })
  const state = ref({ online: true, family: 'anima', models: [], modelId: 'test-model', width: 832, height: 1216, loraId: 'wrong-studio-lora', cfg: 4.5, steps: 30, sampler: 'res_multistep', scheduler: 'simple' })
  const deps = { pb, animaState: state, sd: {}, sdSize: ref('832x1216'), negativePrompt: ref('low quality'), loraSpecs: ref([]), modelProfile: ref(null), runJob: vi.fn(), historyGenerationFields: () => ({}), sceneBlueprints: () => [blueprint], popularCharacters: () => [character] } as unknown as PromptBatchRunnersDeps
  const runner = usePromptBatchRunners(deps)
  runner.batchEngine.value = 'anima'
  return { runner, deps, pb, state, blueprint }
}
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('retry keeps original model, seed, blueprint, clothing and negative prompt', async () => {
  const { runner, pb, state, blueprint } = setup()
  const request = vi.spyOn(apiClient, 'request').mockRejectedValue(new ApiClientError('invalid environment', { kind: 'http', status: 400 }))
  await runner.onBatchStart({ sceneIds: ['one'], count: 1 })
  const original = request.mock.calls[0][1]?.body as Record<string, unknown>
  expect(original.width).toBe(1216)
  expect(original.height).toBe(832)
  expect(original.negative).toContain('watermark')
  expect(original.loraId).toBeUndefined()
  expect(original.character).toBeNull()
  expect(original.prompt).toContain('coat')
  pb.manualTags.add('day'); blueprint.promptProse = 'changed scene'; state.value.modelId = 'changed'
  runner.batchEngine.value = 'sd'
  await runner.onRetryFailed()
  expect(request.mock.calls[1][1]?.body).toEqual(original)
})

it('failed persistence retries the existing image without generating again', async () => {
  vi.useFakeTimers()
  const { runner, pb } = setup()
  const request = vi.spyOn(apiClient, 'request').mockResolvedValue({ ok: true, job: { id: 'one', seed: 42, status: 'succeeded', resultAvailable: true, resultUrl: '/result.png' } })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['test'], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } })))
  pb.commitHistoryEntry.mockResolvedValueOnce(null)
  const start = runner.onBatchStart({ sceneIds: ['one'], count: 1 })
  await vi.runAllTimersAsync(); await start
  expect(runner.batchDraw.progress.value.unresolved).toBe(1)
  expect(runner.batchDraw.jobs.value[0].resultUrl).toBeTruthy()
  const calls = request.mock.calls.length
  await runner.batchDraw.resume()
  expect(request).toHaveBeenCalledTimes(calls)
  expect(runner.batchDraw.progress.value.succeeded).toBe(1)
  const entry = pb.commitHistoryEntry.mock.calls[1][0]
  expect(entry.outfitId).toBe('coat')
  expect(entry.blueprintId).toBe('one')
  expect(entry.size).toBe('1216x832')
})

it('unauthorized adult blueprints never reach the generation API', async () => {
  const { runner, pb, blueprint } = setup()
  pb.showMatureScenes = false; blueprint.adult = true
  const request = vi.spyOn(apiClient, 'request')
  await runner.onBatchStart({ sceneIds: ['one'], count: 1 })
  expect(request).not.toHaveBeenCalled()
  expect(runner.batchDraw.jobs.value[0].error).toContain('分级授权')
})

it('applying repeated tags is idempotent and compatible outfit tags remain together', async () => {
  const { deps, pb } = setup()
  // This uniform came from an earlier image; it is not a user-owned choice.
  pb.manualTags.add('school_uniform')
  pb.referenceInput = { tags: ['school_uniform'] }
  const result = { tags: ['blush', 'blush', 'swimsuit', 'bikini'], characterTags: ['audit_(series)'] }
  await applyInterrogateResult(deps.pb, result)
  expect([...pb.manualTags]).toEqual(['blush'])
  expect(pb.setOutfitOverride).toHaveBeenCalledWith(['swimsuit', 'bikini'], null)
  expect(pb.referenceInput).toEqual({ tags: ['blush'] })
  const outfit = structuredClone(pb.outfitOverride)
  await applyInterrogateResult(deps.pb, result)
  expect(pb.outfitOverride).toEqual(outfit)
  expect([...pb.manualTags]).toEqual(['blush'])
  expect(pb.referenceInput).toEqual({ tags: ['blush'] })
  expect(pb.flash.mock.calls.at(-1)?.[0]).not.toContain('识别到其他角色')
})

it('preserves a genuine manual outfit when new reference clothes conflict with it', async () => {
  const { deps, pb } = setup()
  pb.manualTags.add('school_uniform')
  await applyInterrogateResult(deps.pb, { tags: ['blush', 'kimono', 'yukata'] })
  expect([...pb.manualTags]).toEqual(['school_uniform', 'blush'])
  expect(pb.referenceInput).toEqual({ tags: ['blush'] })
  expect(pb.outfitOverride).toBeNull()
  expect(pb.setOutfitOverride).not.toHaveBeenCalled()
  expect(pb.flash.mock.calls.at(-1)?.[0]).toContain('保留')
})


it('queue-full waits without failing the remaining batch; stop cancels admission', async () => {
  vi.useFakeTimers()
  const { runner } = setup()
  const request = vi.spyOn(apiClient, 'request').mockRejectedValue(new ApiClientError('queue full', { kind: 'http', status: 429 }))
  const start = runner.onBatchStart({ sceneIds: ['one'], count: 1 })
  await vi.advanceTimersByTimeAsync(1)
  expect(runner.batchDraw.jobs.value[0].message).toContain('队列暂满')
  runner.batchDraw.cancel()
  await vi.runAllTimersAsync(); await start
  expect(request).toHaveBeenCalledTimes(1)
  expect(runner.batchDraw.progress.value.cancelled).toBe(1)
})


it('Krea batches use the creative route and natural-language compiler with no negative', async () => {
  const { runner, state } = setup()
  state.value.family = 'krea2'; state.value.modelId = 'krea2-turbo-fp8'
  const request = vi.spyOn(apiClient, 'request').mockRejectedValue(new ApiClientError('invalid environment', { kind: 'http', status: 400 }))
  await runner.onBatchStart({ sceneIds: ['one'], count: 1 })
  expect(request.mock.calls[0][0]).toBe('/api/creative/jobs')
  const body = request.mock.calls[0][1]?.body as Record<string, unknown>
  expect(body.negative).toBe('')
  expect(body.loraId).toBeUndefined()
  expect(body.prompt).not.toMatch(/<lora:|BREAK/)
})


it('character roaming removes the original identity without removing scene tags', async () => {
  const { runner, deps, pb } = setup()
  const other = { ...pb.popularCharacters[0], id: 'target', identityTokens: ['1girl', 'solo', 'red_hair', 'green_eyes'], exactTokens: ['target_character'], aliases: ['target_character'], identityProse: 'An adult woman with red hair and green eyes' }
  pb.popularCharacters.push(other)
  deps.popularCharacters = () => pb.popularCharacters as unknown as ReturnType<NonNullable<PromptBatchRunnersDeps['popularCharacters']>>
  deps.currentLivePrompt = () => '1girl, black_hair, blue_eyes, audit_(series), rain, cafe'
  pb.manualTags.add('audit_(series)')
  const request = vi.spyOn(apiClient, 'request').mockRejectedValue(new ApiClientError('invalid environment', { kind: 'http', status: 400 }))
  await runner.onBatchStartCharacters({ characterIds: ['target'], count: 1 })
  const prompt = String((request.mock.calls[0][1]?.body as Record<string, unknown>).prompt)
  expect(prompt).toMatch(/red[_ ]hair/)
  expect(prompt).toContain('rain')
  expect(prompt).not.toMatch(/audit|black[_ ]hair|blue[_ ]eyes/)
})


it('Comfy batches honor the selected engine seed rather than the SD seed', async () => {
  const { runner, deps } = setup()
  deps.animaState.value.seed = 1001
  const request = vi.spyOn(apiClient, 'request').mockRejectedValue(new ApiClientError('invalid environment', { kind: 'http', status: 400 }))
  await runner.onBatchStart({ sceneIds: ['one'], count: 3 })
  expect(request.mock.calls.map(call => (call[1]?.body as Record<string, unknown>).seed)).toEqual([1001, 2001, 3001])
})

it('legacy Anima restores a known accepted ID through GET only, preserving its original model', async () => {
  vi.useFakeTimers()
  const first = setup()
  const request = vi.spyOn(apiClient, 'request')
    .mockResolvedValueOnce({ ok: true, job: { id: 'legacy-accepted', status: 'queued' } })
    .mockRejectedValueOnce(new ApiClientError('observation unavailable', { kind: 'http', status: 503 }))
  const start = first.runner.onBatchStart({ sceneIds: ['one'], count: 1 })
  await vi.runAllTimersAsync(); await start
  expect(first.runner.batchDraw.jobs.value[0]).toMatchObject({ taskId: 'legacy-accepted', status: 'unknown' })
  first.runner.batchDraw.dispose()
  const restored = setup()
  restored.state.value.modelId = 'changed-model'
  request.mockClear().mockImplementation(async (route, options) => {
    expect(options?.method).not.toBe('POST')
    expect(route).toBe('/api/anima/jobs/legacy-accepted')
    return { ok: true, job: { id: 'legacy-accepted', seed: 42, status: 'succeeded', resultAvailable: true, resultUrl: '/result.png' } }
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['image'], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } })))
  expect(request).not.toHaveBeenCalled()
  const resume = restored.runner.batchDraw.resume()
  await vi.runAllTimersAsync(); await resume
  expect(request).toHaveBeenCalledOnce()
  expect(restored.runner.batchDraw.progress.value.succeeded).toBe(1)
  expect(restored.pb.commitHistoryEntry.mock.calls[0][0]).toMatchObject({ model: 'test-model', outfitId: 'coat', blueprintId: 'one' })
  expect(restored.pb.commitHistoryEntry.mock.calls[0][0].taskId).toBeUndefined()
})

it('legacy acceptance without an ID remains unknown after refresh and manual continue never repeats its POST', async () => {
  const first = setup()
  const request = vi.spyOn(apiClient, 'request').mockRejectedValue(new ApiClientError('lost receipt', { kind: 'network' }))
  await first.runner.onBatchStart({ sceneIds: ['one'], count: 3 })
  expect(first.runner.batchDraw.progress.value).toMatchObject({ unresolved: 1, remaining: 2 })
  first.runner.batchDraw.dispose()
  const restored = setup()
  await restored.runner.batchDraw.resume()
  expect(request).toHaveBeenCalledOnce()
  expect(restored.runner.batchDraw.progress.value).toMatchObject({ unresolved: 1, remaining: 2 })
})

it.each([400, 429])('Web SD definite HTTP %s admission rejection allows retry with frozen input', async status => {
  const { runner, deps } = setup()
  runner.batchEngine.value = 'sd'
  deps.sd.errorMsg = ref('rejected'); deps.sd.checkpoint = ref('frozen-model')
  const run = vi.mocked(deps.runJob).mockImplementation(async (_job, options) => {
    options?.onSubmitting?.(); options?.onError?.(new ApiClientError('rejected', { kind: 'http', status })); return null
  })
  await runner.onBatchStartCharacters({ characterIds: ['nene'], count: 1, basePrompt: 'rainy cafe' })
  expect(runner.batchDraw.progress.value).toMatchObject({ failed: 1, unresolved: 0 })
  await runner.onRetryFailed()
  expect(run).toHaveBeenCalledTimes(2)
  expect(run.mock.calls[1][0]).toEqual(run.mock.calls[0][0])
})

it.each(['failed', 'cancelled'] as const)('legacy Anima known terminal %s after reconnect can be retried explicitly', async status => {
  vi.useFakeTimers()
  const first = setup()
  const request = vi.spyOn(apiClient, 'request').mockResolvedValueOnce({ ok: true, job: { id: 'known-terminal', status: 'queued' } })
    .mockRejectedValueOnce(new ApiClientError('observation unavailable', { kind: 'http', status: 503 }))
  const start = first.runner.onBatchStart({ sceneIds: ['one'], count: 1 })
  await vi.runAllTimersAsync(); await start; first.runner.batchDraw.dispose()
  const restored = setup()
  request.mockClear().mockResolvedValue({ ok: true, job: { id: 'known-terminal', status, error: 'settled failure' } })
  const resume = restored.runner.batchDraw.resume()
  await vi.runAllTimersAsync(); await resume
  expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0][1]?.method).not.toBe('POST')
  expect(restored.runner.batchDraw.progress.value.unresolved).toBe(0)
  expect(restored.runner.batchDraw.jobs.value[0].status).toBe(status)
  request.mockClear().mockRejectedValue(new ApiClientError('invalid configuration', { kind: 'http', status: 400 }))
  await restored.runner.onRetryFailed()
  expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0][1]?.method).toBe('POST')
})

it('Web SD restores a known legacy accepted ID through the existing runner resume path', async () => {
  const first = setup()
  first.runner.batchEngine.value = 'sd'; first.deps.sd.errorMsg = ref('read interrupted'); first.deps.sd.checkpoint = ref('frozen-sd')
  vi.mocked(first.deps.runJob).mockImplementation(async (_job, options) => {
    options?.onSubmitting?.(); await options?.onAcceptedId?.('legacy-sd-id')
    options?.onError?.(new ApiClientError('read interrupted', { kind: 'network' })); return null
  })
  await first.runner.onBatchStartCharacters({ characterIds: ['nene'], count: 1, basePrompt: 'rainy cafe' })
  expect(first.runner.batchDraw.jobs.value[0]).toMatchObject({ taskId: 'legacy-sd-id', status: 'unknown' })
  first.runner.batchDraw.dispose()
  const restored = setup()
  restored.deps.sd.resultSeed = ref(42)
  const run = vi.mocked(restored.deps.runJob).mockImplementation(async (job, options) => {
    expect(job.checkpoint).toBe('frozen-sd'); expect(options?.resumeId).toBe('legacy-sd-id')
    await options?.onAcceptedId?.('legacy-sd-id'); return '/legacy-sd-result.png'
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['image'], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } })))
  await restored.runner.batchDraw.resume()
  expect(run).toHaveBeenCalledOnce(); expect(restored.runner.batchDraw.progress.value.succeeded).toBe(1)
  expect(restored.pb.commitHistoryEntry.mock.calls[0][0].taskId).toBeUndefined()
})
