import { computed, effectScope, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { usePromptSdQueue, type PromptSdQueueDeps } from './usePromptSdQueue'
import { historyFromResultContext } from '@/utils/resultContext'

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

it('保存排队任务与手动保存上下文均保留提交参数，不读取后来的表单或结果', async () => {
  const commit = vi.fn().mockResolvedValue({ id: 1 })
  const pb = {
    subject: { kind: 'studio' }, char: 'nene', sceneId: 'scene-a', story: 'story-a', visualDescription: '',
    selections: { emotion: [], shot: null, lighting: null, composition: null }, colorMood: null,
    manualTags: new Set(), artistStyleIds: [], directorMode: 'basic', projectId: 'project-a',
    sdParams: { seed: 42, seedLock: true, cfg: 7, steps: 20, sampler: 'euler', scheduler: 'normal',
      hiresFix: false, hiresScale: 2, hiresUpscaler: '', hiresSteps: 0, hiresDenoise: 0.5, faceDetailer: false },
    sdModelName: 'model-a', commitHistoryEntry: commit, flash: vi.fn(),
  }
  let finish!: (url: string) => void
  const sd = { generate: vi.fn(() => new Promise<string>(resolve => { finish = resolve })),
    resultSeed: ref(42), lastLoras: ref([{ id: 'lora-a', strength: 0.7 }]), checkpoint: ref('model-a'), generating: ref(false) }
  const setResultContext = vi.fn()
  const scope = effectScope()
  try {
    const tools = scope.run(() => usePromptSdQueue({ pb, sd, sdSize: ref('832x1216'), drawEngine: ref('sd'),
      livePrompt: computed(() => 'submitted prompt'), negativePrompt: computed(() => 'negative-a'),
      effectiveScene: computed(() => ({ title: 'scene A' })), loraSpecs: computed(() => []),
      modelProfile: computed(() => ({ id: 'profile-a' })), animaState: ref({}),
      displayResultSeed: computed(() => 42), setResultContext,
    } as unknown as PromptSdQueueDeps))!
    const job = tools.captureJob()!
    const running = tools.runJob(job)
    pb.char = 'natsume'; pb.sceneId = 'scene-b'; pb.story = 'story-b'
    pb.sdParams.cfg = 99; pb.sdParams.steps = 99; pb.sdModelName = 'model-b'
    finish('blob:result'); await running
    let release!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve })))
    const saving = tools.commitJobResult(job, 'blob:result')
    job.prompt = 'later prompt'; job.negative = 'later negative'; job.size = '512x512'
    sd.resultSeed.value = 99; sd.lastLoras.value = []
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    release(new Response(new Blob(['image']), { headers: { 'content-type': 'image/png' } }))
    await saving
    const input = commit.mock.calls[0]![0]
    expect(input).toMatchObject({ prompt: 'submitted prompt', negative: 'negative-a', size: '832x1216' })
    const expected = { character: 'nene', scene: 'scene-a', sceneTitle: 'scene A', story: 'story-a',
      cfg: 7, steps: 20, model: 'model-a', size: '832x1216', seed: 42, lora: null,
      loras: [{ id: 'lora-a', strength: 0.7 }] }
    expect({ ...input, ...historyFromResultContext(input.context) }).toMatchObject(expected)
    expect(historyFromResultContext(setResultContext.mock.calls[0]![0])).toMatchObject(expected)
  } finally { scope.stop() }
})
