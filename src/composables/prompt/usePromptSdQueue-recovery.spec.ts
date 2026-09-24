import assert from 'node:assert/strict'
import { computed, effectScope, ref } from 'vue'
import { afterEach, it, vi } from 'vitest'
import { usePromptSdQueue, type PromptSdQueueDeps } from './usePromptSdQueue'

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
  const sd = { generate: vi.fn().mockResolvedValue('blob:result'), resultSeed: ref<number | null>(0),
    lastLoras: ref<Array<{ id: string; strength: number }>>([]), checkpoint: ref('model-a'), generating: ref(false) }
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
  return { tools, pb, sd, setResultContext }
}

it('LoRA recovery removes both inline tags and structured LoRA input without mutating the original job', async () => {
  const { tools, sd } = setup()
  const job = tools.captureJob()!
  const original = JSON.stringify(job)
  await tools.runJob(job, { disableLora: true })
  const request = sd.generate.mock.calls[0]![0]
  assert.equal(request.prompt, 'A quiet park')
  assert.equal(request.lora, undefined)
  assert.equal(JSON.stringify(job), original)
})

it('archives the effective no-LoRA recovery request rather than the original failing request', async () => {
  const { tools, pb } = setup()
  const job = tools.captureJob()!
  await tools.runJob(job, { disableLora: true })
  await tools.commitJobResult(job, 'blob:result')
  const input = pb.commitHistoryEntry.mock.calls[0]![0]
  assert.equal(input.prompt, 'A quiet park')
  assert.equal(input.context.history.lora, null)
  assert.equal(input.context.history.loraId, null)
  assert.equal(input.seed, 0)
})

it('keeps submitted prompt and settings even when the caller edits the job before archival', async () => {
  const { tools, pb } = setup()
  const job = tools.captureJob()!
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
  const job = tools.captureJob()!
  await tools.runJob(job)
  setResultContext.mock.calls[0]![0].history.cfg = 99
  await tools.commitJobResult(job, 'blob:result')
  assert.equal(pb.commitHistoryEntry.mock.calls[0]![0].context.history.cfg, 7)
})

it('uses the successful SD seed including zero, not the currently displayed seed', async () => {
  const { tools, pb } = setup()
  await tools.runJob(tools.captureJob()!)
  assert.equal(pb.sdParams.seed, 0)
})

it('a failed attempt does not overwrite the selected seed with the old display result', async () => {
  const { tools, pb, sd } = setup()
  sd.generate.mockResolvedValue(null)
  await tools.runJob(tools.captureJob()!)
  assert.equal(pb.sdParams.seed, 42)
})

it('an unknown completed seed does not borrow a later result seed during archival', async () => {
  const { tools, pb, sd } = setup()
  sd.resultSeed.value = null
  const job = tools.captureJob()!
  await tools.runJob(job)
  sd.resultSeed.value = 12345
  await tools.commitJobResult(job, 'blob:result')
  assert.equal(pb.commitHistoryEntry.mock.calls[0]![0].seed, -1)
})

for (const available of [0, 1, 2, 3]) {
  it(`reports actual variant admission with ${available} queue slots available`, () => {
    const { tools, pb } = setup()
    const base = tools.captureJob()!
    tools.sdQueue.pause()
    tools.sdQueue.restore(Array.from({ length: 8 - available }, (_, index) => ({ ...base, id: `saved-${index}` })))
    pb.flash.mockClear()
    tools.enqueue3Variants()
    assert.equal(tools.sdQueue.total.value, 8)
    const messages = pb.flash.mock.calls.map(call => String(call[0]))
    const successes = messages.filter(message => message.startsWith('已将'))
    assert.equal(successes.length, available === 0 ? 0 : 1)
    if (available > 0) assert.ok(successes[0]!.startsWith(`已将 ${available} 组`))
    assert.ok(messages.filter(message => message.includes('最多保留')).length <= 1)
  })
}
