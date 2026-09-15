'use strict';
function publicJob(job, routeBase) {
    routeBase = routeBase || (job.input && job.input.family === 'krea2' ? '/api/creative' : '/api/anima');
    var end = ['succeeded', 'failed', 'cancelled'].includes(job.status) ? (job.finishedAt || job.createdAt) : Date.now();
    var elapsedSeconds = Math.max(0, Math.floor((end - job.createdAt) / 1000));
    var progress = job.status === 'succeeded' ? 1 : (typeof job.progress === 'number' ? job.progress : (job.status === 'queued' ? 0 : null));
    var result = {
        id: job.id,
        status: job.status,
        provider: job.provider || 'comfy',
        progress: progress,
        elapsedSeconds: elapsedSeconds,
        currentNode: job.currentNode || null,
        progressText: job.progressText || (job.status === 'queued' ? '等待 ComfyUI 调度…' : job.status === 'running' ? 'ComfyUI 正在推理…' : job.status === 'succeeded' ? '生成完成' : job.status === 'failed' ? '生成失败' : job.status === 'cancelling' ? '正在取消…' : ''),
        modelId: job.input.modelId,
        loraId: job.input.loraId,
        character: job.input.character,
        seed: job.input.seed,
        createdAt: job.createdAt,
        resultAvailable: Boolean(job.result && !job.resultConsumed),
        resultUrl: job.result && !job.resultConsumed ? routeBase + '/jobs/' + encodeURIComponent(job.id) + '/result' : null,
        metadata: Object.assign({}, job.metadata || {}, {
            resultUrl: job.result && !job.resultConsumed ? routeBase + '/jobs/' + encodeURIComponent(job.id) + '/result' : null
        }),
        error: job.error || null,
        code: job.errorCode || null
    };
    return result;
}
module.exports = { publicJob };
