import type { BatchDrawPlan } from '../../generation/batchDrawPlan'
import type { SDQueueJob } from '../../generation/useSDQueue'

/** A previously accepted record, independent of current workbench form state. */
export function legacySdJob(id = 'saved', prompt = 'A quiet park, <lora:ayachi_nene_v18_wd14:0.8>'): SDQueueJob {
  return {
    id, title: 'scene A', prompt, negative: 'negative-a', sceneId: 'scene-a', sceneTitle: 'scene A',
    char: 'nene', story: 'story-a', size: '832x1216', seed: 42, cfg: 7, steps: 20,
    sampler: 'euler', scheduler: 'normal', checkpoint: 'model-a', lora: 'ayachi_nene_v18_wd14:0.8',
    hiresFix: false, hiresScale: 2, hiresUpscaler: '', hiresSteps: 0, denoisingStrength: 0.5, faceDetailer: false,
    attempt: { key: 'request-' + id, submitted: true },
    context: { char: 'nene', sceneId: 'scene-a', story: 'story-a', history: {
      subject: 'studio', character: 'nene', scene: 'scene-a', sceneTitle: 'scene A', story: 'story-a', project: 'project-a',
    } },
  }
}

export function legacySdBatch(runtimeOwned: boolean, status: 'unknown' | 'failed' = 'unknown'): BatchDrawPlan {
  return { version: 1, createdAt: 1, engine: 'sd', runtimeOwned,
    targets: [{ id: 'nene', title: 'Saved scene', kind: 'character', characterId: 'nene' }],
    jobs: [{ id: 'saved-row', requestKey: 'saved-key', taskId: 'legacy-sd-id', sceneId: 'nene', sceneTitle: 'Saved scene',
      seed: 42, variant: 0, status, snapshot: {
        engine: 'sd', job: legacySdJob(), disableLora: false, adult: false,
        history: { prompt: 'Saved prompt', negative: 'negative-a', engine: 'sd', model: 'model-a',
          cfg: 7, steps: 20, sampler: 'euler', scheduler: 'normal', size: '832x1216', seed: 42 },
      } }],
  }
}
