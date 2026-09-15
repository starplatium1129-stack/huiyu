'use strict';

interface JobState {
  id: string; status: string; provider?: string; progress?: number | null; progressText?: string;
  currentNode?: string | null; createdAt: number; finishedAt?: number;
  input: { family?: string; modelId?: string; loraId?: unknown; character?: unknown; seed?: number };
  result?: unknown; resultConsumed?: boolean; metadata?: Record<string, unknown>;
  error?: unknown; errorCode?: string | number | null;
}

function publicJob(job: JobState, routeBase?: string) {
  routeBase = routeBase || (job.input && job.input.family === 'krea2' ? '/api/creative' : '/api/anima');
  let end = ['succeeded', 'failed', 'cancelled'].includes(job.status) ? (job.finishedAt || job.createdAt) : Date.now();
  let elapsedSeconds = Math.max(0, Math.floor((end - job.createdAt) / 1000));
  let progress = job.status === 'succeeded' ? 1 : (typeof job.progress === 'number' ? job.progress : (job.status === 'queued' ? 0 : null));
  let result = {
    id:job.id,
    status:job.status,
    provider:job.provider || 'comfy',
    progress:progress,
    elapsedSeconds:elapsedSeconds,
    currentNode:job.currentNode || null,
     progressText:job.progressText || (job.status === 'queued' ? '等待 ComfyUI 调度…' : job.status === 'running' ? 'ComfyUI 正在推理…' : job.status === 'succeeded' ? '生成完成' : job.status === 'failed' ? '生成失败' : job.status === 'cancelling' ? '正在取消…' : ''),
    modelId:job.input.modelId,
    loraId:job.input.loraId,
    character:job.input.character,
    seed:job.input.seed,
    createdAt:job.createdAt,
    resultAvailable:Boolean(job.result && !job.resultConsumed),
    resultUrl:job.result && !job.resultConsumed ? routeBase + '/jobs/' + encodeURIComponent(job.id) + '/result' : null,
    metadata:Object.assign({}, job.metadata || {}, {
      resultUrl:job.result && !job.resultConsumed ? routeBase + '/jobs/' + encodeURIComponent(job.id) + '/result' : null
    }),
    error:job.error || null,
    code:job.errorCode || null
  };
  return result;
}


export = { publicJob };
