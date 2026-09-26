import { computed, effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempResult, type TempResultDeps } from './useTempResult'
import { clearTempResult, readTempResult, writeTempResult, type TempResultRecord } from '@/utils/tempResult'
import { artworkRepository } from '@/storage/artworkRepository'
import type { AnimaResult } from '@/types/anima'
import type { SDQueueJob } from '@/composables/generation/useSDQueue'

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
    drawEngine: ref('sd'), displayResultUrl: computed(() => url.value), displayResultSeed: computed(() => seed.value),
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

function setupAutomatic(engine: 'anima' | 'krea2' | 'sd') {
  const url = ref('')
  const autoSave = ref(true)
  const commit = vi.fn().mockResolvedValue({ id: 102 })
  const context = ref({ char: 'nene', sceneId: 'sc001' })
  const scope = effectScope(); scopes.push(scope)
  let temp: TempResultRecord | null = null
  vi.mocked(readTempResult).mockImplementation(() => temp)
  vi.mocked(writeTempResult).mockImplementation(value => { temp = value; return true })
  vi.mocked(clearTempResult).mockImplementation(() => { temp = null })
  const tools = scope.run(() => useTempResult({
    pb: { commitHistoryEntry: commit, flash: vi.fn() },
    sd: { resultSeed: ref(41), resultPrompt: ref('fixture') },
    drawEngine: ref(engine), animaState: ref({ resultContext: context.value }), resultContext: context,
    displayResultUrl: computed(() => url.value), autoSaveToGallery: autoSave,
    historyGenerationFields: () => ({}), commitJobResult: commit,
  } as unknown as TempResultDeps))!
  function deliver(id: string) {
    url.value = 'blob:' + id
    if (engine === 'sd') return tools.handleSdResult({ prompt: id, negative: '', size: '832x1216' } as Omit<SDQueueJob, 'id'>, url.value)
    return tools.handleAnimaResult({
      url: url.value, blob: new Blob([id]),
      metadata: { engine, prompt: id, negative: '', seed: 41, width: 832, height: 1216 },
    } as AnimaResult, null)
  }
  return { tools, autoSave, commit, deliver, scope, temp: () => temp }
}

describe.each(['anima', 'krea2', 'sd'] as const)('%s automatic archive ownership', engine => {
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
  await run.deliver('new')
  firstImage.resolve('old-image'); await first
  expect(run.temp()?.imageId).toBe('new-image')
  expect(imgDelete).toHaveBeenCalledWith('old-image')
  expect(imgDelete).not.toHaveBeenCalledWith('new-image')
})
