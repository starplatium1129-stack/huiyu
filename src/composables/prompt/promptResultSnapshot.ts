import type { PromptSdQueueDeps } from './usePromptSdQueue'
export interface ResultSnapshot {
  url: string
  seed: number | null
  styleLoraId: string | null
  size: string
  sampler: string
  cfg: number
  steps: number
  hires: string
  at: string
}
export function snapshotResult(ctx: Pick<PromptSdQueueDeps, 'animaState' | 'drawEngine' | 'displayResultSeed' | 'pb' | 'sdSize' | 'sd'>, persistentUrl: string): ResultSnapshot {
  const { animaState, drawEngine, displayResultSeed, pb, sdSize, sd } = ctx
  const metadata = animaState.value.result?.metadata
  const isComfy = drawEngine.value !== 'sd'
  return {
    url: persistentUrl,
    seed: displayResultSeed.value ?? (isComfy ? metadata?.seed ?? null : (pb.sdParams.seedLock && pb.sdParams.seed >= 0 ? pb.sdParams.seed : null)),
    styleLoraId: isComfy ? ((metadata?.styleLoraId ?? animaState.value.styleLoraId) || null) : null,
    size: isComfy ? `${metadata?.width ?? animaState.value.width}x${metadata?.height ?? animaState.value.height}` : sdSize.value,
    sampler: isComfy ? (metadata?.sampler ?? animaState.value.sampler) : (pb.sdParams.sampler || sd.samplers.value[0] || '—'),
    cfg: isComfy ? (metadata?.cfg ?? animaState.value.cfg) : pb.sdParams.cfg,
    steps: isComfy ? (metadata?.steps ?? animaState.value.steps) : pb.sdParams.steps,
    hires: isComfy ? (metadata?.hiresFix === true
      ? (typeof metadata.hiresScale === 'number' ? `×${metadata.hiresScale}` : '开')
      : metadata?.hiresFix === false ? '关' : '—') : (pb.sdParams.hiresFix ? `×${pb.sdParams.hiresScale ?? 1.5}` : '关'),
    at: new Date().toLocaleTimeString(),
  }
}
