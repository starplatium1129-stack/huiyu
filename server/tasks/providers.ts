import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { taskFingerprint } from './runtime';
import { queryComfy, cancelComfy } from './comfy-recovery';
import type { TaskProvider, TaskObservation } from './provider';
import type { TaskRecord } from '../../types/tasks';
import type { GenerationConfig, GenerationInput } from '../generation/types';
import type { ImageJobInput } from '../../routes/anima/types';
import type { VideoInput } from '../../routes/video/types';
import type { createGenerationService } from '../generation/service';
import animaService = require('../../routes/anima/service');
import animaValidation = require('../../routes/anima/validation');
import animaMedia = require('../../routes/anima/media');
import animaConstants = require('../../routes/anima/constants');
import generationValidation = require('../generation/validation');
import generationConstants = require('../generation/constants');
import videoService = require('../../routes/video/service');
import videoValidation = require('../../routes/video/validation');
import videoComfy = require('../../routes/video/comfy');
import videoConstants = require('../../routes/video/constants');
import { WorkspaceError } from '../workspace/types';
import { createBatchTaskProvider } from './batch-provider';
import batchFactory = require('../../routes/video/batch');
import { providerInputs } from './inputs';

function binding(config: GenerationConfig): () => string {
  const root = path.join(config.AI_WORKSPACE_ROOT || path.resolve(config.ROOT_DIR, '..', 'AI'), 'ComfyUI');
  // A configured URL alone is insufficient. Local installation identity survives
  // gateway restarts; an unbound remote installation is recoverable only this epoch.
  const unboundEpoch = randomUUID();
  return () => {
    let identity: unknown = { unboundEpoch };
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(String(config.COMFY_HOST)).hostname);
    if (localHost && fs.existsSync(root)) { const stat = fs.statSync(root); identity = { root: fs.realpathSync(root), created: stat.birthtimeMs, inode: stat.ino }; }
    return taskFingerprint({ comfy: String(config.COMFY_HOST), webui: String(config.SD_HOST), identity });
  };
}
const gatewayId = (task: TaskRecord) => String(task.metadata.gatewayJobId || task.checkpoint?.gatewayJobId || '');
const metadata = (job: { metadata?: Readonly<Record<string, unknown>>; id: string }) => ({ ...job.metadata, gatewayJobId: job.id });
function liveObservation(job: { status: string; result: unknown; errorCode?: string | number | null }, extra: Record<string, unknown>): TaskObservation | null {
  if (job.status === 'succeeded' && job.result) return { status: 'succeeded', settled: true, metadata: extra };
  if (['queued', 'running', 'cancelling'].includes(job.status)) return { status: job.status as 'queued' | 'running' | 'cancelling', settled: false, metadata: extra };
  return null;
}
async function settleCancelled(observation: Promise<TaskObservation>, job: { status: string; pollTimer: ReturnType<typeof setTimeout> | null } | null): Promise<TaskObservation> {
  const result = await observation;
  if (job && result.settled && result.status === 'cancelled') { job.status = 'cancelled'; if (job.pollTimer) clearTimeout(job.pollTimer); job.pollTimer = null; }
  return result;
}
export function createTaskProviders(options: {
  config: GenerationConfig;
  generation: ReturnType<typeof createGenerationService>;
  anima: ReturnType<typeof animaService.createAnimaService>;
  video: ReturnType<typeof videoService.createVideoService>;
  batch: ReturnType<typeof batchFactory.createBatchService>;
}): Partial<Record<TaskRecord['kind'], TaskProvider>> {
  const { config, generation, anima, video } = options;
  const fingerprint = binding(config);
  function imageRecovery(task: TaskRecord, wai = false) {
    return queryComfy(config, task, wai ? '10' : animaConstants.OUTPUT_NODE_ID, async reference => {
      const result = await animaMedia.materializeResult(config, { id: task.taskId }, reference, {
        outputPrefix: wai ? generationConstants.OUTPUT_PREFIX : task.kind === 'creative' ? 'creative_app' : animaConstants.OUTPUT_FILENAME_PREFIX,
        mediaNamespace: wai ? 'wai' : 'anima',
      });
      return { file: result.path, mime: result.mime };
    });
  }
  const images = (kind: 'anima' | 'creative'): TaskProvider => ({
    prepare: (task, hooks) => providerInputs(config, hooks)(task.input),
    async close() { anima.close(); await anima.drainSubmissions(); },
    fingerprint,
    validate(input) { return animaValidation.validateInput({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, input, kind) as unknown as Record<string, unknown>; },
    async submit(task, hooks) {
      await providerInputs(config, hooks)(task.input);
      const job = anima.create(task.input as unknown as ImageJobInput, task.principalId);
      await hooks.checkpoint({ gatewayJobId: job.id, effectiveInput: job.input });
      let attempted = false;
      try { await anima.submit(job, { ...hooks, async submitting(name, identity) { await hooks.submitting(name, identity); attempted = true; } }); }
      catch (error) { if (!attempted) await anima.cancel(job); throw error; }
    },
    async query(task) {
      const job = anima.get(gatewayId(task), task.principalId);
      return (!task.cancelRequestedAt && job && liveObservation(job, metadata(job))) || settleCancelled(imageRecovery(task), job);
    },
    cancel: task => cancelComfy(config, task),
  });
  return {
    batch: createBatchTaskProvider(config, options.batch, fingerprint),
    anima: images('anima'), creative: images('creative'),
    generation: {
      async close() { generation.close(); await generation.comfy.drainSubmissions(); },
      fingerprint,
      validate(input) { return generationValidation.validate({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, input) as unknown as Record<string, unknown>; },
      async submit(task, hooks) { await generation.submit(task.input as unknown as GenerationInput, task.principalId, hooks); },
      async query(task) {
        try {
          const found = generation.find(gatewayId(task), task.principalId);
          if (found.provider === 'comfy') return (!task.cancelRequestedAt && liveObservation(found.job, metadata(found.job))) || settleCancelled(imageRecovery(task, true), found.job);
          const job = found.job;
          if (job.status === 'succeeded' && job.result) return { status: 'succeeded', settled: true, metadata: { ...job.metadata, gatewayJobId: job.id }, outputs: task.resultState === 'available' ? undefined : [{ bytes: job.result, mime: job.mime || 'image/png' }] };
          if (job.status === 'cancelled') {
            await job.execution; await job.cancellation;
            return { status: 'cancelled', settled: true };
          }
          if (job.status === 'failed') return { status: 'failed', settled: false, unknown: true, errorCode: 'WEBUI_RESPONSE_UNKNOWN' };
          return { status: job.status as TaskRecord['status'], settled: false };
        } catch (error) {
          if (task.provider !== 'webui') return imageRecovery(task, true);
          if (!(error instanceof Error)) throw error;
          return { status: task.status, settled: false, unknown: true, errorCode: 'WEBUI_RESTART_INTERRUPTED' };
        }
      },
      async cancel(task) {
        if (task.provider !== 'webui') return cancelComfy(config, task);
        // Only a live registry proves ownership of WebUI's global interrupt slot.
        try { generation.find(gatewayId(task), task.principalId); }
        catch { throw new WorkspaceError('WEBUI_CANCEL_UNKNOWN', 'Cannot interrupt an unknown WebUI execution'); }
        await generation.cancel(gatewayId(task), task.principalId);
      },
    },
    video: {
      prepare: (task, hooks) => providerInputs(config, hooks)(task.input),
      async close() { video.close(); await video.drainSubmissions(); },
      fingerprint,
      validate(input) { return videoValidation.validateInput(input, config, { isLocal: true }) as unknown as Record<string, unknown>; },
      async submit(task, hooks) {
        await providerInputs(config, hooks)(task.input);
        const job = video.create(task.input as unknown as VideoInput, task.principalId);
        await hooks.checkpoint({ gatewayJobId: job.id });
        let attempted = false;
        try { await video.submit(job, { ...hooks, async submitting(name, identity) { await hooks.submitting(name, identity); attempted = true; } }); }
        catch (error) { if (!attempted) await video.cancel(job); throw error; }
      },
      async query(task) {
        const job = video.get(gatewayId(task), task.principalId);
        return (!task.cancelRequestedAt && job && liveObservation(job, { ...video.publicJob(job), gatewayJobId: job.id })) || settleCancelled(queryComfy(config, task, videoConstants.OUTPUT_NODE_ID, async reference => {
          const result = await videoComfy.materializeResult(config, { id: task.taskId }, reference);
          return { file: result.path, mime: result.mime };
        }), job);
      },
      cancel: task => cancelComfy(config, task),
    },
  };
}
