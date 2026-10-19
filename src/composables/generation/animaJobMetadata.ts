import type { AnimaJobMetadata, AnimaPublicJob } from '@/types/anima'
import type { AnimaRequest } from './animaSessionContract'

export function metadataFromJob(job: AnimaPublicJob, request: AnimaRequest, family: 'anima' | 'krea2'): AnimaJobMetadata {
  const supplied = job.metadata
  if (supplied && supplied.id !== job.id) throw new Error('成片元数据与当前任务编号不一致，请核对任务')
  const metadata = supplied
    ? supplied
    : {
        engine: family,
        id: job.id,
        prompt: request.prompt,
        negative: request.negative,
        profileId: request.profileId,
        modelId: request.modelId,
        loraId: request.loraId,
        loraStrength: request.loraStrength,
        styleLoraId: request.styleLoraId ?? null,
        width: request.width,
        height: request.height,
        steps: request.steps,
        cfg: request.cfg,
        sampler: '',
        scheduler: '',
        seed: job.seed,
        character: request.character,
        preview: false,
        hiresFix: Boolean(request.hiresFix),
        hiresScale: request.hiresScale,
        hiresDenoise: request.hiresDenoise,
        sketchControl: request.sketchControl,
        regions: request.regions,
        createdAt: Date.now(),
        resultUrl: job.resultUrl,
      }
  const provider = job.provider === 'comfy' || job.provider === 'native' ? job.provider : undefined
  return Object.freeze({ ...JSON.parse(JSON.stringify(metadata)), provider, resultUrl: job.resultUrl || metadata.resultUrl || null }) as AnimaJobMetadata
}
