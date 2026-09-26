import fs from 'node:fs';
import path from 'node:path';
import type { TaskProvider, TaskObservation, TaskExecutionHooks } from './provider';
import type { TaskRecord } from '../../types/tasks';
import type { GenerationConfig } from '../generation/types';
import batchFactory = require('../../routes/video/batch');
import videoValidation = require('../../routes/video/validation');
import videoComfy = require('../../routes/video/comfy');
import videoMedia = require('../../routes/video/media');
import { queryComfy, cancelComfy } from './comfy-recovery';
import { batchCheckpoint } from './batch-checkpoint';
import { WorkspaceError } from '../workspace/types';
import { providerInputs, protectedInputHooks } from './inputs';

export function createBatchTaskProvider(config: GenerationConfig, batches: ReturnType<typeof batchFactory.createBatchService>, fingerprint: () => string): TaskProvider {
  function live(task: TaskRecord) { return batches.get(task.checkpoint?.gatewayJobId, task.principalId); }
  function recoveredShots(task: TaskRecord): Array<Record<string, any>> { return Array.isArray(task.checkpoint?.shots) ? task.checkpoint.shots as Array<Record<string, any>> : []; }
  async function recover(task: TaskRecord): Promise<TaskObservation> {
    const shots = recoveredShots(task); const outputs = [];
    if (!shots.length) return { status: task.status, settled: false, unknown: true, errorCode: 'BATCH_CHECKPOINT_PENDING' };
    let unknown = false, active = false, pending = false, failed = false;
    for (const shot of shots) {
      if (!shot.submissionIntentAt) { if (task.cancelRequestedAt) shot.status = 'cancelled'; else pending = true; continue; }
      const settled = task.resultRefs.some(ref => ref.index === Number(shot.index) - 1);
      if (settled && shot.result && fs.existsSync(String(shot.result.path))) { shot.status = 'succeeded'; continue; }
      const single = { ...task, kind: 'video' as const, upstreamId: shot.upstreamId || null,
        input: shot.input, taskId: task.taskId + '-' + shot.index, resultState: 'none' as const };
      const observation = await queryComfy(config, single, '11', async reference => {
        const result = await videoComfy.materializeResult(config, { id: single.taskId }, reference);
        shot.result = { path: result.path, mime: result.mime }; shot.status = 'succeeded';
        return { file: result.path, mime: result.mime, index: Number(shot.index) - 1 };
      });
      if (observation.outputs) outputs.push(...observation.outputs);
      if (observation.settled) shot.status = observation.status;
      unknown ||= Boolean(observation.unknown); active ||= !observation.settled; failed ||= observation.status === 'failed';
    }
    if (task.checkpoint?.concatStage === 'available' && task.checkpoint.concat && typeof task.checkpoint.concat === 'object') {
      const candidate = task.checkpoint.concat as Record<string, unknown>;
      const file = typeof candidate.path === 'string' ? path.resolve(candidate.path) : '';
      const root = path.resolve(videoMedia.ensureMediaRoot(config));
      if (file.startsWith(root + path.sep) && fs.existsSync(file) && !task.resultRefs.some(ref => ref.index === shots.length)) outputs.push({ file, mime: 'video/mp4', index: shots.length });
    }
    return { status: active || pending ? 'running' : failed ? 'failed' : 'succeeded', settled: !active && !pending,
      unknown: unknown || pending, errorCode: unknown ? 'BATCH_UPSTREAM_UNKNOWN' : pending ? 'BATCH_AWAITING_EXPLICIT_CONTINUE' : null,
      outputs, checkpoint: { ...task.checkpoint, shots } };
  }
  return {
    prepare: (task, hooks) => providerInputs(config, hooks)(task.input),
    close() { batches.close(); },
    fingerprint,
    validate(input) { return videoValidation.validateBatchInput(input, config, { isLocal: true }) as unknown as Record<string, unknown>; },
    async submit(task, hooks) { const protectedInputs = protectedInputHooks(config, hooks); await protectedInputs.protect(task.input); await batches.create(task.principalId, task.input, protectedInputs.hooks); },
    async query(task) {
      const batch = live(task);
      if (!batch) return recover(task);
      if (batch.status === 'paused') return recover({ ...task, checkpoint: batchCheckpoint(batch) });
      if (batch.status === 'cancelled') return recover(task);
      return { status: batch.status === 'done' ? 'succeeded' : 'running', settled: batch.status === 'done', metadata: batches.publicBatch(batch), checkpoint: batchCheckpoint(batch) };
    },
    async cancel(task) {
      const batch = live(task);
      if (batch) await batches.cancel(batch);
      for (const shot of recoveredShots(task)) if (shot.upstreamId) await cancelComfy(config, { ...task, upstreamId: String(shot.upstreamId) });
    },
    async action(task, name, hooks: TaskExecutionHooks) {
      const protectedInputs = protectedInputHooks(config, hooks);
      await protectedInputs.protect(task.input);
      if (task.checkpoint) await protectedInputs.protect(task.checkpoint);
      hooks = protectedInputs.hooks;
      let batch = live(task);
      if (!['concat', 'continue'].includes(name)) throw new WorkspaceError('TASK_ACTION_INVALID', 'Unsupported batch action', 400);
      if (!batch || name === 'continue') {
        const recovered = await recover(task);
        if (recovered.errorCode === 'BATCH_UPSTREAM_UNKNOWN' || (recovered.status === 'running' && !recovered.unknown)) throw new WorkspaceError('BATCH_RECOVERY_REVIEW', 'Submitted shots have not settled');
        const shots = recovered.checkpoint?.shots as Array<Record<string, any>>;
        // Continue only never submitted shots. Failed/cancelled shots require a new
        // user generation action, never a disguised replay under the previous key.
        if (shots.some(shot => shot.submissionIntentAt && shot.status !== 'succeeded')) throw new WorkspaceError('BATCH_RECOVERY_REVIEW', 'A submitted shot requires explicit replacement');
        if (recovered.outputs?.length) await hooks.collect(recovered.outputs);
        await hooks.checkpoint(recovered.checkpoint!);
        batch = await batches.create(task.principalId, task.input, hooks, recovered.checkpoint);
      }
      batch.taskHooks = hooks;
      if (name === 'concat') await batches.concat(batch);
      else await batches.resume(batch);
    },
  };
}
