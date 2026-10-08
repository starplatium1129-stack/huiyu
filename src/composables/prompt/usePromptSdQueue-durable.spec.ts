import { legacySdJob } from './testFixtures/legacySdJob'
import { computed, effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePromptSdQueue, type PromptSdQueueDeps } from './usePromptSdQueue'

const tasks = vi.hoisted(() => ({ get: vi.fn(), cancel: vi.fn() }))
vi.mock('@/api/runtimeTasks', () => ({ getRuntimeTaskByKey: tasks.get, cancelRuntimeTaskKey: tasks.cancel }))
vi.mock('@/api/runtimeTaskAuthority', () => ({ hasRuntimeTasks: () => true }))
import { activateProfileStorage, flushProfileWrites, refreshProfileStorage, type ProfilePort } from '@/platform/web/profileStorage'

import type { LegacySdObserveOptions } from '@/composables/generation/useLegacySdTasks'
import { SD_PENDING_QUEUE_KEY } from '@/utils/storageKeys'

let records = new Map<string, {key:string; value:unknown; revision:number}>()
let revision = 0
const snapshot = () => ({ records: [...records.values()], revision, resetRevision: '' })
const saveDraft: ProfilePort['saveDraft'] = async input => {
  const row = { key: input.key, value: input.value, revision: ++revision }; records.set(input.key, row); return row
}
const savedJobs = () => JSON.parse(String(records.get(SD_PENDING_QUEUE_KEY)?.value || '{"jobs":[]}')).jobs
const port: ProfilePort = {
  readSettings: async () => ({...snapshot(), records: []}), readChat: async () => ({...snapshot(), records: []}), readDrafts: async () => snapshot(),
  saveSetting: async input => ({ key: input.key, value: input.value, revision: ++revision }),
  saveChatRecord: async () => { throw new Error('unexpected chat') }, resetChat: async () => snapshot(),
  saveDraft: vi.fn(saveDraft),
}
beforeEach(async () => {
  records = new Map(); revision = 0
  vi.mocked(port.saveDraft).mockReset().mockImplementation(saveDraft)
  tasks.get.mockReset().mockImplementation(async key => ({ taskId: key + '-task', status: 'running', recoveryState: 'normal', upstreamSettled: false })); tasks.cancel.mockReset().mockResolvedValue(null)
  await activateProfileStorage(port, 'atelier')
})

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.mocked(port.saveDraft).mockImplementation(saveDraft)
  await flushProfileWrites()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function setup() {
  const pb = {
    subject: { kind: 'studio' }, char: 'nene', sceneId: 'scene-a', story: 'story-a', visualDescription: '',
    selections: { emotion: [], shot: null, lighting: null, composition: null }, colorMood: null,
    manualTags: new Set(), artistStyleIds: [], directorMode: 'basic', projectId: 'project-a',
    sdParams: { seed: 42, seedLock: true, cfg: 7, steps: 20, sampler: 'euler', scheduler: 'normal',
      hiresFix: false, hiresScale: 2, hiresUpscaler: '', hiresSteps: 0, hiresDenoise: 0.5, faceDetailer: false },
    sdModelName: 'model-a', commitHistoryEntry: vi.fn().mockResolvedValue({ id: 1 }), flash: vi.fn(),
  }
  const sd = { observe: vi.fn<(params: unknown, options?: LegacySdObserveOptions) => Promise<string | null>>().mockResolvedValue('blob:result'), resultSeed: ref<number | null>(0),
    lastLoras: ref<Array<{ id: string; strength: number }>>([]), checkpoint: ref('model-a'), generating: ref(false),
    errorMsg: ref(''), resultTaskId: ref('') }
  const setResultContext = vi.fn()
  const scope = effectScope()
  scopes.push(scope)
  const tools = scope.run(() => usePromptSdQueue({ pb, sd, sdSize: ref('832x1216'), drawEngine: ref('sd'),
    livePrompt: computed(() => 'A quiet park, <lora:ayachi_nene_v18_wd14:0.8>'),
    negativePrompt: computed(() => 'negative-a'), effectiveScene: computed(() => ({ title: 'scene A' })),
    loraSpecs: computed(() => [{ name: 'ayachi_nene_v18_wd14', weight: 0.8 }]),
    modelProfile: computed(() => ({ id: 'profile-a' })), animaState: ref({}),
    // The displayed engine/result may change independently of this SD attempt.
    displayResultSeed: computed(() => 999), setResultContext,
  } as unknown as PromptSdQueueDeps))!
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image']), { headers: { 'content-type': 'image/png' } })))
  return { tools, pb, sd, setResultContext, scope }
}

it('restores saved identities after rebuilding the window, paused and without browser writes', async () => {
  const first = setup()
  const recorded = [legacySdJob('a'), legacySdJob('b')]
  first.tools.sdQueue.restore(recorded); await first.tools.sdQueue.checkpoint(); await flushProfileWrites()
  first.scope.stop()
  const browserWrite = vi.spyOn(Storage.prototype, 'setItem')
  await activateProfileStorage(port, 'atelier')
  const restored = setup()
  expect(restored.tools.restoredCount).toBe(2); expect(restored.tools.sdQueue.paused.value).toBe(true)
  expect(restored.tools.sdQueue.queue.value).toEqual(recorded)
  expect(restored.sd.observe).not.toHaveBeenCalled(); expect(tasks.get).not.toHaveBeenCalled()
  expect(browserWrite).not.toHaveBeenCalled(); browserWrite.mockRestore()
})
it('waits for the queue save receipt before observing a restored task', async () => {
  const { tools, sd } = setup()
  tools.sdQueue.restore([legacySdJob('a')])
  let finish!: () => void
  vi.mocked(port.saveDraft).mockImplementationOnce(input => new Promise(resolve => { finish = () => { void saveDraft(input).then(resolve) } }))
  tools.sdQueue.resume()
  await vi.waitFor(() => expect(finish).toBeDefined())
  expect(sd.observe).not.toHaveBeenCalled(); expect(tasks.get).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => expect(sd.observe).toHaveBeenCalledOnce())
  expect(sd.observe.mock.calls[0][1]?.attempt?.key).toBe('request-a')
})
it('unknown acceptance keeps its key and resume only queries the original task', async () => {
  const { tools, sd } = setup()
  tools.sdQueue.restore([legacySdJob('a')])
  tasks.get.mockResolvedValueOnce(null)
  tools.sdQueue.resume()
  await vi.waitFor(() => expect(tools.sdQueue.paused.value).toBe(true))
  expect(sd.observe).not.toHaveBeenCalled(); expect(savedJobs()[0].attempt.key).toBe('request-a')
  tools.sdQueue.resume()
  await vi.waitFor(() => expect(sd.observe).toHaveBeenCalledOnce())
  expect(tasks.get.mock.calls.map(([key]) => key)).toEqual(['request-a', 'request-a'])
  expect(sd.observe.mock.calls[0][1]?.attempt?.task?.taskId).toBe('request-a-task')
})
it('settled failure never mints a replacement identity when the user resumes', async () => {
  const { tools, sd } = setup()
  tools.sdQueue.restore([legacySdJob('failed')])
  tasks.get.mockResolvedValue({ taskId: 'failed-task', status: 'failed', upstreamSettled: true })
  sd.observe.mockResolvedValue(null)
  tools.sdQueue.resume(); await vi.waitFor(() => expect(tools.sdQueue.paused.value).toBe(true))
  tools.sdQueue.resume(); await vi.waitFor(() => expect(sd.observe).toHaveBeenCalledTimes(2))
  await flushProfileWrites()
  expect(tasks.get.mock.calls.map(([key]) => key)).toEqual(['request-failed', 'request-failed'])
  expect(savedJobs()[0].attempt.key).toBe('request-failed')
})
it('unsent legacy rows are retained without creating an attempt or dispatching', async () => {
  const { tools, sd } = setup()
  const row = legacySdJob('unsent'); delete row.attempt
  tools.sdQueue.restore([row]); tools.sdQueue.resume()
  await vi.waitFor(() => expect(tools.sdQueue.paused.value).toBe(true))
  expect(sd.observe).not.toHaveBeenCalled(); expect(tasks.get).not.toHaveBeenCalled()
  expect(savedJobs()[0].attempt).toBeUndefined()
})
it('replays a lost removal cancellation receipt using the original key after remount', async () => {
  const first = setup()
  first.tools.sdQueue.restore([legacySdJob('a')])
  await first.tools.sdQueue.checkpoint()
  tasks.cancel.mockRejectedValueOnce(new Error('receipt lost'))
  await first.tools.sdQueue.remove('a')
  await flushProfileWrites()
  expect(savedJobs()[0].removeRequested).toBe(true)
  first.scope.stop(); await activateProfileStorage(port, 'atelier')
  const restored = setup()
  await vi.waitFor(() => expect(tasks.cancel).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(restored.tools.sdQueue.total.value).toBe(0))
  expect(tasks.cancel.mock.calls).toEqual([['request-a'], ['request-a']])
  expect(restored.sd.observe).not.toHaveBeenCalled()
})
it('clearing waiting rows preserves the active task and unloading never cancels it', async () => {
  const { tools, sd, scope } = setup()
  let finish!: () => void
  sd.observe.mockImplementation(() => new Promise(resolve => { finish = () => resolve(null) }))
  tools.sdQueue.restore([legacySdJob('a'), legacySdJob('b'), legacySdJob('c')]); tools.sdQueue.resume()
  await vi.waitFor(() => expect(sd.observe).toHaveBeenCalledOnce())
  await tools.sdQueue.clear()
  expect(tasks.cancel.mock.calls).toEqual([['request-b'], ['request-c']])
  expect(tools.sdQueue.activeJob.value?.attempt?.key).toBe('request-a')
  scope.stop(); finish(); await nextTick()
  expect(tasks.cancel).not.toHaveBeenCalledWith('request-a')
})
it('restores an explicit cancellation with a lost receipt without observing or resubmitting', async () => {
  const first = setup()
  let finish!: () => void
  first.sd.observe.mockImplementation(() => new Promise(resolve => { finish = () => resolve(null) }))
  first.tools.sdQueue.restore([legacySdJob('a')]); first.tools.sdQueue.resume()
  await vi.waitFor(() => expect(first.sd.observe).toHaveBeenCalledOnce())
  const attempt = first.sd.observe.mock.calls[0][1]!.attempt!
  tasks.cancel.mockRejectedValueOnce(new Error('cancel receipt lost'))
  await expect(attempt.cancel()).rejects.toThrow('cancel receipt lost')
  expect(savedJobs()[0].attempt.cancelRequested).toBe(true)
  finish(); await vi.waitFor(() => expect(first.tools.sdQueue.paused.value).toBe(true))
  first.scope.stop(); await flushProfileWrites(); await activateProfileStorage(port, 'atelier')
  const restored = setup()
  await vi.waitFor(() => expect(tasks.cancel).toHaveBeenCalledTimes(2)); await flushProfileWrites()
  expect(tasks.cancel.mock.calls).toEqual([['request-a'], ['request-a']])
  expect(restored.sd.observe).not.toHaveBeenCalled(); expect(savedJobs()[0].attempt).toBeUndefined()
})
it('a refreshed profile revision cannot authorize an old page to overwrite a newer queue', async () => {
  const { tools } = setup()
  tools.sdQueue.restore([legacySdJob('a')]); await tools.sdQueue.checkpoint(); await flushProfileWrites()
  const external = { version: 1, jobs: [{ ...savedJobs()[0], id: 'newer-writer', title: 'newer queue' }] }
  records.set(SD_PENDING_QUEUE_KEY, { key: SD_PENDING_QUEUE_KEY, value: JSON.stringify(external), revision: ++revision })
  await refreshProfileStorage()
  const writes = vi.mocked(port.saveDraft).mock.calls.length
  await tools.sdQueue.clear()
  expect(tools.sdQueue.paused.value).toBe(true)
  expect(vi.mocked(port.saveDraft).mock.calls.length).toBe(writes)
  expect(savedJobs()).toEqual(external.jobs)
})
