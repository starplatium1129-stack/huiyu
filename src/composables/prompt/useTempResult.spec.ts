import { computed, effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempResult, type TempResultDeps } from './useTempResult'
import { clearTempResult, readTempResult, writeTempResult, type TempResultRecord } from '@/utils/tempResult'
import { artworkRepository } from '@/storage/artworkRepository'
import type { AnimaResult, AnimaResultContext } from '@/types/anima'
import type { TaskRecord } from '../../../types/tasks'
import { copyTask, taskRecords } from '@/stores/runtimeTaskState'

const runtime = vi.hoisted(() => ({ enabled: false, refresh: vi.fn(), fetch: vi.fn(), mark: vi.fn() }))
vi.mock('@/api/runtimeTaskAuthority', async importOriginal => ({ ...await importOriginal<object>(), hasRuntimeTasks: () => runtime.enabled }))
vi.mock('@/api/runtimeTasks', () => ({ refreshRuntimeTasks: runtime.refresh, fetchRuntimeResult: runtime.fetch, markRuntimeTask: runtime.mark,
  runtimeResultPath: (task: TaskRecord) => `/api/tasks/v1/${task.taskId}/results/0` }))

vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { deleteImage: vi.fn().mockResolvedValue(undefined), getImage: vi.fn(), putImage: vi.fn() } }))
const imgDelete = artworkRepository.deleteImage, imgPut = artworkRepository.putImage
vi.mock('@/utils/tempResult', () => ({ clearTempResult: vi.fn(), readTempResult: vi.fn(() => null), writeTempResult: vi.fn(() => true) }))
const scopes: ReturnType<typeof effectScope>[] = []
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { resolve, reject, promise }
}
beforeEach(() => {
  runtime.enabled = false; runtime.refresh.mockReset(); runtime.fetch.mockReset(); runtime.mark.mockReset(); taskRecords.value = []
  vi.mocked(readTempResult).mockReturnValue(null)
  vi.mocked(writeTempResult).mockReturnValue(true)
  vi.mocked(imgPut).mockResolvedValue('temporary-image')
})
function setup() {
  const url = ref('blob:original')
  const seed = ref(41)
  const submittedPrompt = ref('original submitted prompt')
  const context = ref({ char: 'nene', story: 'original story', sceneId: 'sc001' })
  const commit = vi.fn().mockResolvedValue({ id: 101 })
  const flash = vi.fn()
  const scope = effectScope(); scopes.push(scope)
  const tools = scope.run(() => useTempResult({
    pb: { commitHistoryEntry: commit, flash }, sd: { resultPrompt: submittedPrompt },
    drawEngine: ref('sd'), displayResultUrl: computed(() => url.value), displayResultSeed: computed(() => seed.value), generationBusy: ref(false),
    livePrompt: computed(() => 'edited prompt'), negativePrompt: computed(() => 'negative'),
    resultContext: context, animaState: ref({}), historyGenerationFields: () => ({ sdSteps: seed.value }),
  } as unknown as TempResultDeps))!
  return { tools, url, seed, submittedPrompt, context, commit, flash }
}
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('manual archive ownership', () => {
  it('freezes metadata before reading an image and does not mark a replacement as archived', async () => {
    const image = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => image.promise))
    const { tools, url, seed, submittedPrompt, context, commit } = setup()
    const first = tools.saveCurrentResult()
    expect(tools.savingResult.value).toBe(true)
    await tools.saveCurrentResult()
    expect(fetch).toHaveBeenCalledTimes(1)
    url.value = 'blob:replacement'; seed.value = 99
    submittedPrompt.value = 'replacement prompt'; context.value.story = 'replacement story'
    image.resolve(new Response(new Blob(['pixels'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } }))
    await first
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][0]).toMatchObject({ seed: 41, prompt: 'original submitted prompt', story: 'original story', context: { story: 'original story' } })
    expect(tools.resultArchived.value).toBe(false)
    expect(clearTempResult).not.toHaveBeenCalled()
    expect(tools.savingResult.value).toBe(false)
  })
  it('permits retry after storage failure and prevents duplicate saves after success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['pixels'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } })))
    const { tools, commit, flash } = setup()
    commit.mockResolvedValueOnce(null)
    await tools.saveCurrentResult()
    expect(tools.resultArchived.value).toBe(false)
    expect(tools.savingResult.value).toBe(false)
    expect(clearTempResult).not.toHaveBeenCalled()
    expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('重试'))
    await tools.saveCurrentResult()
    expect(tools.resultArchived.value).toBe(true)
    expect(clearTempResult).toHaveBeenCalledTimes(1)
    await tools.saveCurrentResult()
    expect(commit).toHaveBeenCalledTimes(2)
  })
})

function setupAutomatic(engine: 'anima' | 'krea2') {
  const url = ref('')
  const autoSave = ref(true)
  const commit = vi.fn().mockResolvedValue({ id: 102 })
  const context = ref<AnimaResultContext>({ char: 'nene', sceneId: 'sc001' })
  const animaState = ref({ resultContext: context.value, result: null as AnimaResult | null })
  const scope = effectScope(); scopes.push(scope)
  let temp: TempResultRecord | null = null
  vi.mocked(readTempResult).mockImplementation(() => temp)
  vi.mocked(writeTempResult).mockImplementation(value => { temp = value; return true })
  vi.mocked(clearTempResult).mockImplementation(() => { temp = null })
  const tools = scope.run(() => useTempResult({
    pb: { commitHistoryEntry: commit, flash: vi.fn() },
    sd: { resultSeed: ref(41), resultPrompt: ref('fixture') },
    drawEngine: ref(engine), animaState, resultContext: context,
    displayResultSeed: computed(() => 41), generationBusy: ref(false), livePrompt: computed(() => ''), negativePrompt: computed(() => ''),
    displayResultUrl: computed(() => url.value), autoSaveToGallery: autoSave,
    historyGenerationFields: () => ({}), commitJobResult: commit,
  } as unknown as TempResultDeps))!
  function deliver(id: string, initImage?: string) {
    url.value = 'blob:' + id
    const result = {
      url: url.value, blob: new Blob([id]),
      metadata: { engine, prompt: id, negative: '', seed: 41, width: 832, height: 1216, initImage },
    } as AnimaResult
    animaState.value.result = result
    return tools.handleAnimaResult(result)
  }
  return { tools, autoSave, commit, deliver, scope, context, temp: () => temp }
}

it('archives the frozen source parent consistently through automatic and manual saves, including explicit null', async () => {
  for (const parentId of ['source-artwork', null]) {
    const run = setupAutomatic('anima')
    run.context.value.parentId = parentId
    await run.deliver('automatic', 'source.png')
    expect(run.commit).toHaveBeenLastCalledWith(expect.objectContaining({ parentId }))
    run.autoSave.value = false
    await run.deliver('manual', 'source.png')
    await run.tools.saveCurrentResult()
    expect(run.commit).toHaveBeenCalledTimes(2)
    expect(run.commit).toHaveBeenLastCalledWith(expect.objectContaining({ parentId }))
  }
})

describe.each(['anima', 'krea2'] as const)('%s automatic archive ownership', engine => {
  for (const outcome of ['success', 'failure'] as const) {
    it(`old ${outcome} cannot mark, overwrite or remove the new temporary image`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['pixels']))))
      const pending = deferred<{ id: number }>()
      const run = setupAutomatic(engine)
      run.commit.mockReturnValueOnce(pending.promise)
      const old = run.deliver('old')
      run.autoSave.value = false
      await run.deliver('new')
      const temporary = run.temp()
      expect(temporary).not.toBeNull()
      if (outcome === 'success') pending.resolve({ id: 101 })
      else pending.reject(new Error('old save failed'))
      await old
      expect(run.tools.resultArchived.value).toBe(false)
      expect(run.tools.resultTemporary.value).toBe(true)
      expect(run.temp()).toEqual(temporary)
      expect(imgDelete).not.toHaveBeenCalled()
      expect(clearTempResult).not.toHaveBeenCalled()
    })
  }
  it('out-of-order successful saves preserve both commits but only mark the latest result', async () => {
    const first = deferred<{ id: number }>()
    const second = deferred<{ id: number }>()
    const run = setupAutomatic(engine)
    run.commit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const old = run.deliver('old')
    const newer = run.deliver('new')
    second.resolve({ id: 102 }); await newer
    first.resolve({ id: 101 }); await old
    expect(run.commit).toHaveBeenCalledTimes(2)
    expect(run.tools.displayedResultHistoryId.value).toBe(102)
    expect(clearTempResult).toHaveBeenCalledTimes(1)
  })
  it('discard and scope disposal invalidate an outstanding completion', async () => {
    const pending = deferred<{ id: number }>()
    const run = setupAutomatic(engine)
    run.commit.mockReturnValueOnce(pending.promise)
    const saving = run.deliver('old')
    run.tools.discardTemp()
    run.scope.stop()
    vi.mocked(clearTempResult).mockClear()
    pending.resolve({ id: 101 }); await saving
    expect(run.tools.resultArchived.value).toBe(false)
    expect(clearTempResult).not.toHaveBeenCalled()
  })
})

it('a late temporary blob cannot replace the newer temporary pointer', async () => {
  const firstImage = deferred<string>()
  const run = setupAutomatic('anima')
  run.autoSave.value = false
  vi.mocked(imgPut).mockReturnValueOnce(firstImage.promise).mockResolvedValueOnce('new-image')
  const first = run.deliver('old')
  // The deferred action must have reached storage before the newer image races it.
  await vi.waitFor(() => expect(imgPut).toHaveBeenCalledOnce())
  await run.deliver('new')
  firstImage.resolve('old-image'); await first
  expect(run.temp()?.imageId).toBe('new-image')
  expect(imgDelete).toHaveBeenCalledWith('old-image')
  expect(imgDelete).not.toHaveBeenCalledWith('new-image')
})

function restoreFixture() {
  runtime.enabled = true
  const taskId = '12345678-1234-1234-1234-123456789012'
  taskRecords.value = [{ taskId, kind: 'generation', resultState: 'available', deliveryState: 'unseen', provider: 'webui',
    input: { prompt: 'Requested prompt', negative: 'Requested negative', seed: 41 },
    metadata: { seed: 0, prompt: 'Actual prompt', context: { char: 'nene', story: 'Original story' } },
  } as unknown as TaskRecord]
  runtime.refresh.mockResolvedValue(undefined)
  runtime.fetch.mockResolvedValue(new Blob(['pixels'], { type: 'image/png' }))
  runtime.mark.mockImplementation(async (id, state) => { taskRecords.value = taskRecords.value.map(task => task.taskId === id ? { ...copyTask(task), deliveryState: state } : copyTask(task)) })
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:restored'); static revokeObjectURL = vi.fn() })
  const url = ref(''), resultTaskId = ref(''), resultContext = ref(null), generationBusy = ref(false)
  const sd = { resultTaskId, adoptResult: vi.fn((next: string, _seed: number | null, _prompt: string, id: string) => { url.value = next; resultTaskId.value = id }) }
  const scope = effectScope(); scopes.push(scope)
  const tools = scope.run(() => useTempResult({ sd, pb: { flash: vi.fn(), setChar: vi.fn() }, drawEngine: ref('sd'), animaState: ref({}),
    resultContext, displayResultUrl: computed(() => url.value), generationBusy, setDrawEngine: vi.fn(),
  } as unknown as TempResultDeps))!
  return { tools, url, sd, taskId, resultContext, generationBusy, scope }
}

it('restores the observed Seed and actual prompt from the runtime inbox', async () => {
  const { tools, sd, taskId, resultContext } = restoreFixture()
  expect(await tools.restoreTempResult()).toBe(true)
  expect(sd.adoptResult).toHaveBeenCalledWith('blob:restored', 0, 'Actual prompt', taskId)
  expect(resultContext.value).toMatchObject({ story: 'Original story', history: { seed: 0, prompt: 'Actual prompt' } })
})

it.each(['replacement', 'generation', 'failed-generation', 'dispose'] as const)('a late inbox restore cannot allocate or replace a result after %s', async action => {
  const { tools, url, sd, generationBusy, scope } = restoreFixture()
  const pending = deferred<Blob>()
  runtime.fetch.mockReturnValueOnce(pending.promise)
  const restoring = tools.restoreTempResult()
  await vi.waitFor(() => expect(runtime.fetch).toHaveBeenCalledOnce())
  if (action === 'replacement') url.value = 'blob:new-result'
  else if (action === 'dispose') scope.stop()
  else {
    generationBusy.value = true
    if (action === 'failed-generation') generationBusy.value = false
  }
  pending.resolve(new Blob(['late'], { type: 'image/png' }))
  expect(await restoring).toBe(false)
  expect(sd.adoptResult).not.toHaveBeenCalled()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})

it('does not start inbox restoration while a new generation is active', async () => {
  const { tools, sd, generationBusy } = restoreFixture()
  generationBusy.value = true
  expect(await tools.restoreTempResult()).toBe(false)
  expect(runtime.fetch).not.toHaveBeenCalled()
  expect(sd.adoptResult).not.toHaveBeenCalled()
})

it('a new attempt invalidates a pending browser restore without discarding its stored image', async () => {
  const { tools, sd, generationBusy } = restoreFixture()
  runtime.enabled = false
  const record: TempResultRecord = { imageId: 'previous-image', engine: 'sd', prompt: 'Previous scene', negative: '', seed: 41, size: '832x1216', savedAt: 1 }
  vi.mocked(readTempResult).mockReturnValue(record)
  const pending = deferred<Blob>()
  vi.mocked(artworkRepository.getImage).mockReturnValueOnce(pending.promise)
  const restoring = tools.restoreTempResult()
  await vi.waitFor(() => expect(artworkRepository.getImage).toHaveBeenCalledOnce())
  generationBusy.value = true
  generationBusy.value = false
  pending.resolve(new Blob(['late'], { type: 'image/png' }))
  expect(await restoring).toBe(false)
  expect(sd.adoptResult).not.toHaveBeenCalled()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  expect(clearTempResult).not.toHaveBeenCalled()
  expect(imgDelete).not.toHaveBeenCalled()

  vi.mocked(artworkRepository.getImage).mockResolvedValueOnce(new Blob(['previous'], { type: 'image/png' }))
  expect(await tools.restoreTempResult()).toBe(true)
  expect(sd.adoptResult).toHaveBeenCalledWith('blob:restored', 41, 'Previous scene')
})

it('explicitly cleared runtime results do not return on the next inbox restore', async () => {
  const { tools, url, taskId } = restoreFixture()
  await tools.restoreTempResult()
  tools.discardTemp(); url.value = ''
  await vi.waitFor(() => expect(runtime.mark).toHaveBeenCalledWith(taskId, 'discarded'))
  expect(await tools.restoreTempResult()).toBe(false)
  expect(runtime.fetch).toHaveBeenCalledOnce()
})
