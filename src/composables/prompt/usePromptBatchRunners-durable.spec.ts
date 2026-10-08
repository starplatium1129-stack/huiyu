import { legacySdBatch } from './testFixtures/legacySdJob'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { usePromptBatchRunners, type PromptBatchRunnersDeps } from './usePromptBatchRunners'
import { BATCH_DRAW_PLAN_KEY } from '@/utils/storageKeys'
import { ApiClientError } from '@/api/client'

const api = vi.hoisted(() => ({ submit: vi.fn(), byKey: vi.fn(), wait: vi.fn(), fetch: vi.fn() }))
vi.mock('@/api/runtimeTaskAuthority', () => ({ hasRuntimeTasks: () => true }))
vi.mock('@/api/runtimeTasks', () => ({ submitRuntimeTask: api.submit, getRuntimeTaskByKey: api.byKey,
  getRuntimeTask: vi.fn(),
  waitForRuntimeTask: api.wait, fetchRuntimeResult: api.fetch, runtimeResultPath: () => '/api/tasks/v1/original/results/0', taskMessage: () => '原任务状态' }))

function setup() {
  const character = { id: 'audit', displayName: '测试角色', aliases: ['audit_(series)'], identityProse: 'An adult woman with black hair',
    identityTokens: ['1girl', 'solo', 'black_hair'], exactTokens: ['audit_(series)'], exactPrefixes: [], adultEligibility: 'adult',
    outfits: [{ id: 'coat', name: '外套', tokens: ['coat'], prose: 'a long coat', default: true }] }
  const blueprint = { id: 'one', title: '雨夜', characterId: 'audit', outfitId: 'coat', promptProse: 'An adult woman sits beside a rainy cafe window',
    promptTokens: ['night', 'rain', 'sitting', 'cafe'], negativeTokens: ['watermark'], recommendedSize: '1216x832', adult: false,
    camera: 'medium shot', location: 'cafe', lighting: 'warm', sceneTags: [] }
  const pb = { subject: { kind: 'popular', characterId: 'audit', outfitId: 'coat', blueprintId: null }, char: 'nene',
    selections: { shot: null, lighting: null, composition: null }, sdParams: { seedLock: true, seed: 42, cfg: 7, steps: 30, sampler: 'Euler', scheduler: 'normal' },
    manualTags: new Set<string>(), artistStyleIds: [], tags: [], outfitOverride: null, showMatureScenes: true,
    story: '', visualDescription: '', emotionPrompt: '', flash: vi.fn(), commitHistoryEntry: vi.fn().mockResolvedValue({ id: 1 }),
    popularCharacters: [character], sceneBlueprints: [blueprint] }
  const state = ref({ online: true, family: 'anima', models: [], modelId: 'original-model', seed: 0, width: 832, height: 1216,
    loraId: null, cfg: 4.5, steps: 30, sampler: 'res_multistep', scheduler: 'simple' })
  const deps = { pb, animaState: state, sd: { errorMsg: ref('offline'), checkpoint: ref('original-sd') }, sdSize: ref('832x1216'),
    negativePrompt: ref('low quality'), loraSpecs: ref([]), modelProfile: ref(null), runJob: vi.fn(),
    historyGenerationFields: () => ({}), sceneBlueprints: () => [blueprint], popularCharacters: () => [character] } as unknown as PromptBatchRunnersDeps
  const runner = usePromptBatchRunners(deps)
  runner.batchEngine.value = 'anima'
  return { runner, deps, pb, state, blueprint }
}
const task = (key: string, overrides = {}) => ({ taskId: 'accepted-task', requestKey: key, input: { seed: 0 }, metadata: {},
  upstreamSettled: true, recoveryState: 'none', status: 'succeeded', resultState: 'available', ...overrides })
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear()
  api.fetch.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
  api.wait.mockImplementation(async () => task('fixture-key'))
})
afterEach(() => sessionStorage.clear())

it('lost acceptance persists the exact key, pauses the rest, and resume performs lookup without a second POST', async () => {
  const { runner } = setup()
  api.submit.mockImplementation(async (_kind, _input, key) => {
    const saved = JSON.parse(sessionStorage.getItem(BATCH_DRAW_PLAN_KEY)!)
    expect(saved.jobs[0].requestKey).toBe(key); expect(saved.jobs[0].snapshot.request.modelId).toBe('original-model')
    throw new ApiClientError('acceptance unknown', { kind: 'network', code: 'TASK_ACCEPTANCE_UNKNOWN' })
  })
  api.byKey.mockResolvedValue(null)
  await runner.onBatchStart({ sceneIds: ['one'], count: 3 })
  const key = runner.batchDraw.jobs.value[0].requestKey
  expect(runner.batchDraw.progress.value).toMatchObject({ unresolved: 1, remaining: 2 })
  runner.batchDraw.dispose()
  const restored = setup()
  restored.state.value.modelId = 'changed-model'; restored.blueprint.promptProse = 'changed blueprint'
  expect(api.submit).toHaveBeenCalledOnce()
  await restored.runner.batchDraw.resume()
  expect(api.byKey).toHaveBeenLastCalledWith(key, expect.any(AbortSignal))
  expect(api.submit).toHaveBeenCalledOnce(); expect(restored.runner.batchDraw.progress.value.remaining).toBe(2)
})

it('continues only after reconciling the accepted task, then submits untouched remaining frozen inputs serially', async () => {
  const first = setup()
  api.submit.mockImplementation(async (_kind, _input, key) => task(key))
  api.wait.mockRejectedValueOnce(new Error('observation disconnected'))
  api.byKey.mockImplementation(async key => task(key, { upstreamSettled: false, status: 'running' }))
  await first.runner.onBatchStart({ sceneIds: ['one'], count: 3 })
  const key = first.runner.batchDraw.jobs.value[0].requestKey
  const original = api.submit.mock.calls[0][1]
  first.runner.batchDraw.dispose()
  const restored = setup()
  restored.state.value.modelId = 'changed-model'; restored.blueprint.promptProse = 'changed blueprint'
  restored.state.value.family = 'krea2'
  api.byKey.mockImplementation(async lookup => task(lookup))
  expect(api.submit).toHaveBeenCalledOnce()
  await restored.runner.batchDraw.resume()
  expect(api.submit).toHaveBeenCalledTimes(3)
  expect(api.byKey).toHaveBeenLastCalledWith(key, expect.any(AbortSignal))
  expect(api.submit.mock.calls.slice(1).map(call => call[1])).toEqual([{ ...original, seed: 1000 }, { ...original, seed: 2000 }])
  expect(restored.deps.runJob).not.toHaveBeenCalled()
  expect(restored.pb.commitHistoryEntry.mock.calls[0][0]).toMatchObject({ taskId: 'accepted-task', model: 'original-model', outfitId: 'coat', blueprintId: 'one', seed: 0 })
  expect(restored.runner.batchDraw.progress.value.succeeded).toBe(3)
})

it('reopening an unsaved result reads the same task output and retries archive without regenerating', async () => {
  const first = setup()
  api.submit.mockImplementation(async (_kind, _input, key) => task(key))
  first.pb.commitHistoryEntry.mockResolvedValueOnce(null)
  await first.runner.onBatchStart({ sceneIds: ['one'], count: 1 })
  expect(first.runner.batchDraw.progress.value.unresolved).toBe(1)
  first.runner.batchDraw.dispose()
  api.byKey.mockImplementation(async key => task(key))
  const restored = setup()
  await restored.runner.batchDraw.resume()
  expect(api.submit).toHaveBeenCalledOnce(); expect(api.fetch).toHaveBeenCalledTimes(2)
  expect(restored.pb.commitHistoryEntry).toHaveBeenCalledOnce()
  expect(restored.runner.batchDraw.progress.value.succeeded).toBe(1)
})

it('legacy SD never creates or retries an admission identity', async () => {
  sessionStorage.setItem(BATCH_DRAW_PLAN_KEY, JSON.stringify(legacySdBatch(true, 'failed')))
  const { runner, deps } = setup()
  await runner.onRetryFailed()
  expect(api.submit).not.toHaveBeenCalled(); expect(deps.runJob).not.toHaveBeenCalled()
  expect(runner.batchDraw.jobs.value[0].requestKey).toBe('saved-key')
})
it('restored SD archive fields come from the saved plan while the workbench displays another engine', async () => {
  sessionStorage.setItem(BATCH_DRAW_PLAN_KEY, JSON.stringify(legacySdBatch(true)))
  api.byKey.mockResolvedValue(task('saved-key'))
  const { runner, deps, pb } = setup()
  deps.historyGenerationFields = () => ({ engine: 'anima', model: 'wrong-model', cfg: 99, steps: 99, sampler: 'wrong-sampler', size: 'wrong-size' })
  await runner.batchDraw.resume()
  expect(api.submit).not.toHaveBeenCalled(); expect(deps.runJob).not.toHaveBeenCalled()
  expect(api.byKey).toHaveBeenCalledWith('saved-key', expect.any(AbortSignal))
  expect(pb.commitHistoryEntry.mock.calls[0][0]).toMatchObject({ engine: 'sd', model: 'model-a', cfg: 7, steps: 20,
    sampler: 'euler', scheduler: 'normal', size: '832x1216', taskId: 'accepted-task' })
})
