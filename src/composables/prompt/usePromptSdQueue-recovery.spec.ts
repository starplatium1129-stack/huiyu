import { legacySdJob } from './testFixtures/legacySdJob'
import assert from 'node:assert/strict'
import { computed, effectScope, nextTick, ref } from 'vue'
import { afterEach, it, vi } from 'vitest'
import { usePromptSdQueue, type PromptSdQueueDeps } from './usePromptSdQueue'
import type { AnimaResultContext } from '@/types/anima'

let restoredSerial = 0
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
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
  const sd = { observe: vi.fn().mockResolvedValue('blob:result'), resultSeed: ref<number | null>(0),
    lastLoras: ref<Array<{ id: string; strength: number }>>([]), checkpoint: ref('model-a'), generating: ref(false),
    resultTaskId: ref(''), resultContext: ref<AnimaResultContext | null>(null) }
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

it('archives the effective no-LoRA recovery request rather than the original failing request', async () => {
  const { tools, pb, sd } = setup()
  const job = legacySdJob()
  const original = JSON.stringify(job)
  await tools.runJob(job, { disableLora: true })
  assert.equal(sd.observe.mock.calls[0]![0].prompt, 'A quiet park')
  assert.equal(sd.observe.mock.calls[0]![0].lora, undefined)
  assert.equal(JSON.stringify(job), original)
  assert.equal(pb.sdParams.seed, 0)
  await tools.commitJobResult(job, 'blob:result')
  const input = pb.commitHistoryEntry.mock.calls[0]![0]
  assert.equal(input.prompt, 'A quiet park')
  assert.equal(input.context.history.lora, null)
  assert.equal(input.context.history.loraId, null)
  assert.equal(input.seed, 0)
})

it('keeps submitted prompt and settings even when the caller edits the job before archival', async () => {
  const { tools, pb } = setup()
  const job = legacySdJob()
  const expectedPrompt = job.prompt
  const running = tools.runJob(job)
  job.prompt = 'Changed while running'; job.negative = 'changed'; job.size = '512x512'; job.cfg = 99
  await running
  await tools.commitJobResult(job, 'blob:result')
  const input = pb.commitHistoryEntry.mock.calls[0]![0]
  assert.equal(input.prompt, expectedPrompt)
  assert.equal(input.negative, 'negative-a')
  assert.equal(input.size, '832x1216')
  assert.equal(input.context.history.cfg, 7)
})

it('view context edits cannot mutate the completed archive snapshot', async () => {
  const { tools, pb, setResultContext } = setup()
  const job = legacySdJob()
  await tools.runJob(job)
  setResultContext.mock.calls[0]![0].history.cfg = 99
  await tools.commitJobResult(job, 'blob:result')
  assert.equal(pb.commitHistoryEntry.mock.calls[0]![0].context.history.cfg, 7)
})

it('restored accepted results keep their runtime recipe and original ownership instead of the queue projection', async () => {
  const { tools, pb, sd, setResultContext } = setup()
  sd.resultTaskId.value = 'accepted-task'
  sd.resultContext.value = { char: 'natsume', sceneId: 'accepted-scene', story: 'accepted-story',
    history: { prompt: 'Accepted prompt', negative: 'Accepted negative', cfg: 3, model: 'accepted-model', size: '1216x832' } }
  const job = legacySdJob()
  await tools.runJob(job)
  await tools.commitJobResult(job, 'blob:result')
  const input = pb.commitHistoryEntry.mock.calls[0]![0]
  assert.equal(input.prompt, 'Accepted prompt')
  assert.equal(input.negative, 'Accepted negative')
  assert.equal(input.context.char, 'natsume')
  assert.equal(input.context.sceneId, 'accepted-scene')
  assert.equal(input.context.history.cfg, 3)
  assert.equal(setResultContext.mock.calls[0]![0].story, 'accepted-story')
})

it('a failed attempt does not overwrite the selected seed with the old display result', async () => {
  const { tools, pb, sd } = setup()
  sd.observe.mockResolvedValue(null)
  await tools.runJob(legacySdJob())
  assert.equal(pb.sdParams.seed, 42)
})

it('an unknown completed seed does not borrow a later result seed during archival', async () => {
  const { tools, pb, sd } = setup()
  sd.resultSeed.value = null
  const job = legacySdJob()
  await tools.runJob(job)
  sd.resultSeed.value = 12345
  await tools.commitJobResult(job, 'blob:result')
  assert.equal(pb.commitHistoryEntry.mock.calls[0]![0].seed, -1)
})

// The retired three-seed creation UI has no admission path. Snapshot capacity and
// deduplication remain covered in generation/useSDQueue-restore.spec.ts.

it('starts waiting jobs after a direct generation settles, without overlapping or duplicating jobs', async () => {
  const { tools, pb, sd, setResultContext } = setup()
  const releases: Array<() => void> = []
  sd.observe.mockImplementation(() => {
    sd.generating.value = true
    sd.resultSeed.value = null
    const seed = 100 + sd.observe.mock.calls.length
    return new Promise<string>(resolve => releases.push(() => {
      sd.resultSeed.value = seed
      sd.generating.value = false
      resolve('blob:result')
    }))
  })
  const direct = tools.runJob(legacySdJob())
  tools.sdQueue.restore([legacySdJob('queued-' + (++restoredSerial))]); tools.sdQueue.resume()
  tools.sdQueue.restore([legacySdJob('queued-' + (++restoredSerial))]); tools.sdQueue.resume()
  assert.equal(sd.observe.mock.calls.length, 1)
  assert.equal(tools.sdQueue.queue.value.length, 2)
  await nextTick() // Let the busy state become observable before the delayed reply.
  releases.shift()!()
  await direct
  await nextTick()
  assert.equal(sd.observe.mock.calls.length, 2)
  assert.equal(setResultContext.mock.calls[0]![0].history.seed, 101)
  assert.equal(tools.sdQueue.queue.value.length, 1)
  releases.shift()!()
  await vi.waitFor(() => assert.equal(sd.observe.mock.calls.length, 3))
  releases.shift()!()
  await vi.waitFor(() => assert.equal(tools.sdQueue.done.value, 2))
  assert.equal(pb.commitHistoryEntry.mock.calls.length, 2)
  assert.equal(tools.sdQueue.total.value, 0)
})

it('keeps user-paused waiting jobs paused when direct generation finishes', async () => {
  const { tools, sd } = setup()
  sd.generating.value = true
  tools.sdQueue.restore([legacySdJob('queued-' + (++restoredSerial))]); tools.sdQueue.resume()
  await nextTick()
  tools.sdQueue.pause()
  sd.generating.value = false
  await nextTick()
  assert.equal(sd.observe.mock.calls.length, 0)
  assert.equal(tools.sdQueue.queue.value.length, 1)
  tools.sdQueue.resume()
  await vi.waitFor(() => assert.equal(tools.sdQueue.done.value, 1))
})

it('does not wake page-owned pending jobs after its scope is disposed', async () => {
  const { tools, sd, scope } = setup()
  sd.generating.value = true
  tools.sdQueue.restore([legacySdJob('queued-' + (++restoredSerial))]); tools.sdQueue.resume()
  await nextTick()
  scope.stop()
  sd.generating.value = false
  await nextTick()
  assert.equal(sd.observe.mock.calls.length, 0)
})
