import { runtimeFetch } from '../../platform/runtimeUrl.ts'
import type { SDQueueJob } from '../generation/useSDQueue.ts'
import type { AnimaResultContext } from '../../types/anima.ts'
import type { GeneratedArtworkInput } from '../../application/artwork/artworkSaveInput.ts'
import type { HistoryEntry } from '../../types/promptHistory.ts'
import { writeQuickCreate } from '../../utils/quickCreate.ts'

export type SdResultSnapshot = Omit<SDQueueJob, 'id'> & { context: AnimaResultContext; taskId?: string }

/** Called only after generation; these settings are a convenience, not the result record. */
export function rememberSdResult(job: Omit<SDQueueJob, 'id'>) {
  writeQuickCreate({
    checkpoint: job.checkpoint, sampler: job.sampler, scheduler: job.scheduler,
    cfg: job.cfg, steps: job.steps, size: job.size, hiresFix: job.hiresFix,
    hiresUpscaler: job.hiresUpscaler, hiresScale: job.hiresScale,
  })
}

/** The owner captures the submitted job and result seed before loading this module. */
export async function archiveSdResult(job: SdResultSnapshot, url: string,
  commit: (entry: GeneratedArtworkInput) => Promise<HistoryEntry | null>): Promise<HistoryEntry | null> {
  const response = await runtimeFetch(url)
  const contentType = response.headers.get('content-type') || ''
  if (!response.ok || !contentType.startsWith('image/')) throw new Error('成片响应不是图片')
  const blob = await response.blob()
  if (!blob.size) throw new Error('成片数据已失效')
  return commit({
    taskId: job.taskId,
    context: job.context, blob, seed: job.seed,
    size: job.size, negative: job.negative, prompt: job.prompt,
    story: job.story, scene: job.sceneId ?? null, sceneTitle: job.sceneTitle || undefined,
    hiresFix: job.hiresFix, hiresScale: job.hiresScale, hiresUpscaler: job.hiresUpscaler,
    hiresSteps: job.hiresSteps, hiresDenoise: job.denoisingStrength, faceDetailer: job.faceDetailer,
  })
}
