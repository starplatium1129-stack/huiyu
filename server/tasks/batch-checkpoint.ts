import type { TaskExecutionHooks } from './provider';
/** Private frozen batch facts: no timers, controllers or mutable service objects. */
export function batchCheckpoint(batch: any): Record<string, unknown> {
  return { gatewayJobId: batch.id, status: batch.status, linkLastFrame: batch.linkLastFrame,
    modelId: batch.modelId, aspectRatio: batch.aspectRatio, quality: batch.quality,
    concatStage: batch.concat ? 'available' : batch.concatInFlight ? 'processing' : 'none',
    concat: batch.concat ? { path: batch.concat.path, mime: batch.concat.mime } : null,
    shots: batch.shots.map((shot: any) => ({ index: shot.index, input: structuredClone(shot.input),
      status: shot.status, attempts: shot.attempts, upstreamId: shot.job?.upstreamId || null,
      submissionIntentAt: shot.submissionIntentAt || null,
      gatewayJobId: shot.job?.id || null, tailFrame: shot.tailFrame || null,
      result: shot.job?.result ? { path: shot.job.result.path, mime: shot.job.result.mime } : null,
      errorCode: shot.errorCode || null,
    })) };
}
export async function saveBatchCheckpoint(batch: any): Promise<void> {
  if (batch.taskHooks) await (batch.taskHooks as TaskExecutionHooks).checkpoint(batchCheckpoint(batch));
}
export function batchShotHooks(batch: any, shot: any): TaskExecutionHooks | undefined {
  const hooks: TaskExecutionHooks | undefined = batch.taskHooks;
  if (!hooks) return undefined;
  return {
    async submitting() { await hooks.submitting('comfy', ''); shot.submissionIntentAt = Date.now(); await saveBatchCheckpoint(batch); },
    async observed() { await saveBatchCheckpoint(batch); },
    async checkpoint() { await saveBatchCheckpoint(batch); },
    async collect(outputs) { await hooks.collect(outputs.map(output => ({ ...output, index: shot.index - 1 }))); await saveBatchCheckpoint(batch); },
  };
}
