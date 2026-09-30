import assert from 'node:assert/strict'
import { computed, effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePromptSdQueue, type PromptSdQueueDeps } from './usePromptSdQueue'

const tasks = vi.hoisted(() => ({ get: vi.fn(), cancel: vi.fn() }))
vi.mock('@/api/runtimeTasks', () => ({ getRuntimeTaskByKey: tasks.get, cancelRuntimeTaskKey: tasks.cancel }))
vi.mock('@/api/runtimeTaskAuthority', () => ({ hasRuntimeTasks: () => true }))
import { activateProfileStorage, flushProfileWrites, refreshProfileStorage, type ProfilePort } from '@/platform/web/profileStorage'

import type { SDGenerateOptions } from '@/composables/generation/useSDGenerate'
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
  tasks.get.mockReset().mockResolvedValue(null); tasks.cancel.mockReset().mockResolvedValue(null)
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
  const sd = { generate: vi.fn<(params: unknown, options?: SDGenerateOptions) => Promise<string | null>>().mockResolvedValue('blob:result'), resultSeed: ref<number | null>(0),
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

it('restores two durable pending jobs after rebuilding the window, paused and without browser writes', async () => {
  const first = setup()
  first.sd.generating.value = true
  first.tools.enqueueCurrent(); first.tools.enqueueCurrent()
  await nextTick(); await flushProfileWrites()
  assert.equal(first.tools.sdQueue.queue.value.length, 2)
  first.scope.stop()
  await activateProfileStorage(port, 'atelier')
  const restored = setup()
  assert.equal(restored.tools.sdQueue.queue.value.length, 2)
  assert.equal(restored.tools.sdQueue.paused.value, true)
  assert.equal(restored.sd.generate.mock.calls.length, 0)
  assert.equal(localStorage.length, 0)
  assert.equal(sessionStorage.length, 0)
})

it('does not dispatch before the save receipt and keeps a save failure paused until explicit resume', async () => {
  let release!: () => void
  vi.mocked(port.saveDraft).mockImplementationOnce(input => new Promise(resolve => { release = () => { void saveDraft(input).then(resolve) } }))
  const { tools, sd } = setup()
  tools.enqueueCurrent()
  await nextTick()
  expect(sd.generate).not.toHaveBeenCalled()
  expect(tools.sdQueue.total.value).toBe(1)
  release()
  await vi.waitFor(() => expect(tools.sdQueue.done.value).toBe(1))
  vi.mocked(port.saveDraft).mockRejectedValue(new Error('save unavailable'))
  tools.enqueueCurrent()
  await vi.waitFor(() => expect(tools.sdQueue.paused.value).toBe(true))
  expect(sd.generate).toHaveBeenCalledTimes(1)
  vi.mocked(port.saveDraft).mockImplementation(saveDraft)
  await flushProfileWrites()
  expect(sd.generate).toHaveBeenCalledTimes(1)
  tools.sdQueue.resume()
  await vi.waitFor(() => expect(tools.sdQueue.done.value).toBe(1))
  expect(sd.generate).toHaveBeenCalledTimes(2)
})

it('restores the submitted key, queries unknown acceptance without dispatching, then observes the original task', async () => {
  const first = setup()
  first.sd.generate.mockRejectedValue(new Error('acceptance response lost'))
  first.tools.enqueueCurrent()
  await vi.waitFor(() => expect(first.tools.sdQueue.paused.value).toBe(true))
  await flushProfileWrites()
  const key = savedJobs()[0].attempt.key
  first.scope.stop()
  await activateProfileStorage(port, 'atelier')
  const restored = setup()
  restored.sd.generate.mockResolvedValue(null)
  restored.tools.sdQueue.resume()
  await vi.waitFor(() => expect(restored.tools.sdQueue.paused.value).toBe(true))
  expect(tasks.get).toHaveBeenCalledWith(key)
  expect(restored.sd.generate).not.toHaveBeenCalled()
  const accepted = { taskId: 'accepted', requestKey: key, upstreamSettled: false, status: 'running' }
  tasks.get.mockResolvedValue(accepted)
  restored.tools.sdQueue.resume()
  await vi.waitFor(() => expect(restored.sd.generate).toHaveBeenCalledOnce())
  expect(restored.sd.generate.mock.calls[0]![1]!.attempt!).toMatchObject({ key, task: accepted })
  await vi.waitFor(() => expect(restored.tools.sdQueue.paused.value).toBe(true))
  expect(savedJobs()[0].attempt.key).toBe(key)
})

it('a settled failure can use a new identity only when the user resumes', async () => {
  const { tools, sd } = setup()
  sd.generate.mockResolvedValue(null)
  tools.enqueueCurrent()
  await vi.waitFor(() => expect(tools.sdQueue.paused.value).toBe(true))
  const first = sd.generate.mock.calls[0]![1]!.attempt!.key
  tasks.get.mockResolvedValue({ taskId: 'failed', requestKey: first, upstreamSettled: true, status: 'failed' })
  await nextTick()
  expect(sd.generate).toHaveBeenCalledOnce()
  tools.sdQueue.resume()
  await vi.waitFor(() => expect(sd.generate).toHaveBeenCalledTimes(2))
  expect(sd.generate.mock.calls[1]![1]!.attempt!.key).not.toBe(first)
})

it('replays a lost removal cancellation receipt with the original key after remount', async () => {
  const first = setup()
  first.sd.generate.mockResolvedValue(null)
  first.tools.enqueueCurrent()
  await vi.waitFor(() => expect(first.tools.sdQueue.paused.value).toBe(true))
  const key = first.sd.generate.mock.calls[0]![1]!.attempt!.key
  tasks.cancel.mockRejectedValueOnce(new Error('cancel receipt lost'))
  await first.tools.sdQueue.remove(first.tools.sdQueue.queue.value[0]!.id)
  await flushProfileWrites()
  expect(savedJobs()[0].removeRequested).toBe(true)
  first.scope.stop()
  await activateProfileStorage(port, 'atelier')
  const restored = setup()
  await vi.waitFor(() => expect(restored.tools.sdQueue.total.value).toBe(0))
  await flushProfileWrites()
  expect(tasks.cancel.mock.calls).toEqual([[key], [key]])
  expect(savedJobs()).toEqual([])
  expect(restored.sd.generate).not.toHaveBeenCalled()
})

it('clear waiting preserves the active attempt and unloading never sends cancellation', async () => {
  const { tools, sd, scope } = setup()
  let finish!: () => void
  sd.generate.mockImplementation(() => new Promise(resolve => { finish = () => resolve(null) }))
  tools.enqueueCurrent(); tools.enqueueCurrent(); tools.enqueueCurrent()
  await vi.waitFor(() => expect(sd.generate).toHaveBeenCalledOnce())
  const key = sd.generate.mock.calls[0]![1]!.attempt!.key
  await tools.sdQueue.clear()
  expect(tools.sdQueue.queue.value).toHaveLength(0)
  expect(savedJobs()).toHaveLength(1)
  expect(savedJobs()[0].attempt.key).toBe(key)
  expect(tasks.cancel).not.toHaveBeenCalled()
  scope.stop(); finish(); await nextTick()
  expect(tasks.cancel).not.toHaveBeenCalled()
})

it('restores an explicit cancellation with a lost receipt and never turns recovery into generation', async () => {
  const first = setup()
  let finish!: () => void
  first.sd.generate.mockImplementation(() => new Promise(resolve => { finish = () => resolve(null) }))
  first.tools.enqueueCurrent()
  await vi.waitFor(() => expect(first.sd.generate).toHaveBeenCalledOnce())
  const attempt = first.sd.generate.mock.calls[0]![1]!.attempt!
  tasks.cancel.mockRejectedValueOnce(new Error('cancel receipt lost'))
  await expect(attempt.cancel()).rejects.toThrow('cancel receipt lost')
  expect(savedJobs()[0].attempt.cancelRequested).toBe(true)
  finish()
  await vi.waitFor(() => expect(first.tools.sdQueue.paused.value).toBe(true))
  first.scope.stop()
  await flushProfileWrites(); await activateProfileStorage(port, 'atelier')
  const restored = setup()
  await vi.waitFor(() => expect(tasks.cancel).toHaveBeenCalledTimes(2))
  await flushProfileWrites()
  expect(tasks.cancel.mock.calls).toEqual([[attempt.key], [attempt.key]])
  expect(restored.sd.generate).not.toHaveBeenCalled()
  expect(restored.tools.sdQueue.paused.value).toBe(true)
  expect(savedJobs()[0].attempt).toBeUndefined()
})

it('a late cancellation receipt cannot erase a newer explicitly resumed attempt', async () => {
  const { tools, sd } = setup()
  sd.generate.mockResolvedValue(null)
  tools.enqueueCurrent()
  await vi.waitFor(() => expect(tools.sdQueue.paused.value).toBe(true))
  const first = sd.generate.mock.calls[0]![1]!.attempt!
  let release!: () => void
  tasks.cancel.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(null) }))
  const cancelling = first.cancel()
  await vi.waitFor(() => expect(tasks.cancel).toHaveBeenCalledOnce())
  tools.sdQueue.resume()
  await vi.waitFor(() => expect(sd.generate).toHaveBeenCalledTimes(2))
  const replacement = sd.generate.mock.calls[1]![1]!.attempt!.key
  expect(replacement).not.toBe(first.key)
  release(); await cancelling; await flushProfileWrites()
  expect(savedJobs()[0].attempt.key).toBe(replacement)
})

it('cancellation racing successful completion retains the accepted result identity', async () => {
  const { tools, sd } = setup()
  sd.generate.mockResolvedValue(null)
  tools.enqueueCurrent()
  await vi.waitFor(() => expect(tools.sdQueue.paused.value).toBe(true))
  const first = sd.generate.mock.calls[0]![1]!.attempt!
  const completed = { taskId: 'completed', requestKey: first.key, upstreamSettled: true, status: 'succeeded' }
  tasks.cancel.mockResolvedValue(completed)
  await first.cancel()
  expect(savedJobs()[0].attempt.key).toBe(first.key)
  tasks.get.mockResolvedValue(completed)
  tools.sdQueue.resume()
  await vi.waitFor(() => expect(sd.generate).toHaveBeenCalledTimes(2))
  expect(sd.generate.mock.calls[1]![1]!.attempt!).toMatchObject({ key: first.key, task: completed })
})

it('a failed pre-POST identity save keeps the same unsubmitted key retryable', async () => {
  let rejected = false
  vi.mocked(port.saveDraft).mockImplementation(input => {
    if (!rejected && JSON.parse(String(input.value)).jobs[0]?.attempt?.submitted) {
      rejected = true; return Promise.reject(new Error('identity save failed'))
    }
    return saveDraft(input)
  })
  const { tools, sd } = setup()
  sd.generate.mockResolvedValue(null)
  tools.enqueueCurrent()
  await vi.waitFor(() => expect(tools.sdQueue.paused.value).toBe(true))
  await flushProfileWrites()
  expect(sd.generate).not.toHaveBeenCalled()
  const key = savedJobs()[0].attempt.key
  expect(savedJobs()[0].attempt.submitted).toBe(false)
  tools.sdQueue.resume()
  await vi.waitFor(() => expect(sd.generate).toHaveBeenCalledOnce())
  expect(sd.generate.mock.calls[0]![1]!.attempt!.key).toBe(key)
  expect(tasks.get).not.toHaveBeenCalled()
})

it('a refreshed profile revision cannot authorize an old page to overwrite a newer queue', async () => {
  const { tools, sd } = setup()
  sd.generating.value = true
  tools.enqueueCurrent(); await flushProfileWrites()
  const external = { version: 1, jobs: [{ ...savedJobs()[0], id: 'newer-writer', title: 'newer queue' }] }
  records.set(SD_PENDING_QUEUE_KEY, { key: SD_PENDING_QUEUE_KEY, value: JSON.stringify(external), revision: ++revision })
  await refreshProfileStorage()
  const writes = vi.mocked(port.saveDraft).mock.calls.length
  await tools.sdQueue.clear()
  expect(tools.sdQueue.paused.value).toBe(true)
  expect(vi.mocked(port.saveDraft).mock.calls.length).toBe(writes)
  expect(savedJobs()).toEqual(external.jobs)
})
