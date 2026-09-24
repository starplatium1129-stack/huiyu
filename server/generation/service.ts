import path = require('node:path');
import jobRunner = require('../job-runner');
import jobSnapshot = require('../job-snapshot');
import animaService = require('../../routes/anima/service');
const { createAnimaService } = animaService;
import { error } from './errors';
import { errorCode as runtimeErrorCode } from '../../scripts/lib/runtime-errors';
import { MAX_PENDING, WEB_JOB_TTL_MS, OUTPUT_PREFIX, LORAS, CHECKPOINT, WEBUI_UPSCALERS } from './constants';
import { safeComfyResource, availableSuperRes, comfyResourcesAvailable, validateWaiResources } from './resources';
import SerialQueue = require('../../services/serial-queue');
import { buildWorkflow } from './workflow';
import { createWebUIProbe, requestJson, createWebUIJob, startWebUIJob, publicJob } from './webui';
import type { GenerationConfig, GenerationInput, WebUIJob, GenerationStatus } from './types';
type ComfyService = ReturnType<typeof createAnimaService<GenerationInput>>;
export interface GenerationDependencies {
    waiComfy?: ComfyService;
}
export function createGenerationService(config: GenerationConfig, dependencies: GenerationDependencies = {}) {
    const probeWebUI = createWebUIProbe(config);
    let comfy = dependencies.waiComfy || createAnimaService<GenerationInput>(config, { buildWorkflow: buildWorkflow, validateResources: function (input: GenerationInput) { validateWaiResources(config, input); }, outputPrefix: OUTPUT_PREFIX, outputNodeId: '10', mediaNamespace: 'wai', engine: 'sd', routeBase: '/api/generation' });
    // 任务注册表骨架收口到 server/job-runner.js（2026-08-21）：WebUI 分支的
    // webJob 与 Comfy 分支（anima 服务内部 registry）共用同一套定时器原语。
    let registry = jobRunner.createJobRegistry<WebUIJob>();
    let jobs = registry.jobs;
    let snapshots = jobSnapshot.createJobSnapshotStore(path.join(config.RUNTIME_ROOT, 'jobs', 'wai-webui'));
    let lostWebJobs = snapshots.drain();
    // WebUI has no upstream queue contract. Keep its accepted/in-flight work in
    // the same bounded WAI budget instead of acknowledging every request at once.
    let webuiQueue = new SerialQueue('wai-webui', MAX_PENDING);
    let admitted = 0;
    let webuiAdmitted = 0;
    let comfyAdmitted = 0;
    let comfyAdmissions = new Map<string, { release: () => void; timer: ReturnType<typeof setInterval> }>();
    function reserveAdmission(provider: 'webui' | 'comfy') {
        if (admitted >= MAX_PENDING)
            throw error(503, 'GENERATION_QUEUE_FULL', 'WAI 任务队列已满，请稍后再试');
        admitted += 1;
        if (provider === 'webui')
            webuiAdmitted += 1;
        else
            comfyAdmitted += 1;
        let released = false;
        return function release() {
            if (released)
                return;
            released = true;
            admitted = Math.max(0, admitted - 1);
            if (provider === 'webui')
                webuiAdmitted = Math.max(0, webuiAdmitted - 1);
            else
                comfyAdmitted = Math.max(0, comfyAdmitted - 1);
        };
    }
    function settleComfyAdmission(job: ReturnType<ComfyService['create']>) {
        if (!['succeeded', 'failed', 'cancelled'].includes(job.status))
            return;
        let admission = comfyAdmissions.get(job.id);
        if (!admission)
            return;
        clearInterval(admission.timer);
        comfyAdmissions.delete(job.id);
        admission.release();
    }
    function watchComfyAdmission(job: ReturnType<ComfyService['create']>, release: () => void) {
        let timer = setInterval(function () { settleComfyAdmission(job); }, 100);
        if (typeof timer.unref === 'function')
            timer.unref();
        comfyAdmissions.set(job.id, { release: release, timer: timer });
        settleComfyAdmission(job);
    }
    // 2026-08-16 审计：WebUI 出图任务此前只进 Map 从不回收（内存无上限泄漏）。
    // 统一走 trackWebJob：TTL 后删除（含释放 result Buffer），与 Comfy 分支的
    // gcTimer 对齐；结果由 TTL 回收，取图端点只读，不把网络发送完成误当作客户端持久化确认。
    function trackWebJob(webJob: WebUIJob) {
        jobs.set(webJob.id, webJob);
        snapshots.save(webJob);
        registry.armTimer(webJob, 'gcTimer', WEB_JOB_TTL_MS, function () {
            if (webJob.status === 'queued') {
                webJob.status = 'cancelled';
                webJob.code = 'WEBUI_EXPIRED';
                webJob.queueAbort?.abort();
                webJob.admissionRelease?.();
            }
            if (webJob.result)
                webJob.result = null;
            jobs.delete(webJob.id);
            snapshots.remove(webJob.id);
        }, { unref: true });
        return webJob;
    }
    function status(): GenerationStatus {
        let webui = webuiQueue.status();
        let comfyPending = comfy.status().pending;
        let actualWebui = Math.max(webui.active + webui.pending, webuiAdmitted);
        let actualComfy = Math.max(comfyPending, comfyAdmitted);
        return { online: false, provider: null, webuiOnline: false, comfyFallbackOnline: false, checkpoint: '', samplers: [], schedulers: [], models: [], loras: Object.keys(LORAS).map(function (id) { return { id: id, character: LORAS[id].character, available: safeComfyResource(config, 'loras', LORAS[id].file) }; }), capabilities: { basic: false, hires: false, hiresUpscalers: [], faceDetailer: false }, pending: Math.max(admitted, actualWebui + actualComfy), maxPending: MAX_PENDING, webuiPending: actualWebui, comfyPending: actualComfy };
    }
    async function getStatus() {
        let webui = await probeWebUI();
        let comfyOnline = await comfy.probe().catch(function () { return false; });
        let data = status();
        data.online = webui.online || comfyOnline;
        data.webuiOnline = webui.online;
        data.comfyFallbackOnline = comfyOnline;
        let comfyModelAvailable = safeComfyResource(config, 'checkpoints', CHECKPOINT);
        data.checkpoint = webui.checkpoint || (comfyOnline && comfyModelAvailable ? CHECKPOINT : '');
        data.webuiOnline = Boolean(webui.online && webui.waiAvailable);
        data.comfyFallbackOnline = Boolean(comfyOnline && comfyModelAvailable);
        data.online = data.webuiOnline || data.comfyFallbackOnline;
        data.provider = data.comfyFallbackOnline ? 'comfy' : (data.webuiOnline ? 'webui' : null);
        let autoHiresAvailable = data.comfyFallbackOnline || (data.webuiOnline && (webui.upscalers.length === 0 || webui.upscalers.indexOf('R-ESRGAN 4x+ Anime6B') !== -1));
        let comfySuperRes = availableSuperRes(config);
        let hiresUpscalers: string[] = [];
        if (autoHiresAvailable)
            hiresUpscalers.push('Auto');
        if (data.comfyFallbackOnline && comfySuperRes)
            hiresUpscalers.push('Remacri');
        if (data.comfyFallbackOnline || webui.upscalers.indexOf('Latent') !== -1)
            hiresUpscalers.push('Latent', 'Latent (nearest-exact)');
        if (data.webuiOnline)
            webui.upscalers.forEach(function (name: string) { if (WEBUI_UPSCALERS.has(name) && hiresUpscalers.indexOf(name) === -1)
                hiresUpscalers.push(name); });
        data.capabilities = { basic: Boolean(data.comfyFallbackOnline || data.webuiOnline), hires: Boolean(data.comfyFallbackOnline || data.webuiOnline), hiresUpscalers: hiresUpscalers, faceDetailer: Boolean(data.webuiOnline), superResModel: data.comfyFallbackOnline ? comfySuperRes : null };
        data.samplers = webui.samplers;
        data.schedulers = webui.schedulers;
        data.models = webui.models;
        return data;
    }
    function submitWebUI(input: GenerationInput, ownerId: string) {
        let release = reserveAdmission('webui');
        let webJob: WebUIJob;
        try {
            webJob = createWebUIJob(config, input, ownerId, { start: false });
        }
        catch (cause) {
            release();
            throw cause;
        }
        let controller = new AbortController();
        webJob.queueAbort = controller;
        webJob.admissionRelease = release;
        trackWebJob(webJob);
        void webuiQueue.run(function () {
            if (webJob.status === 'cancelled') return;
            return startWebUIJob(config, webJob);
        }, { signal: controller.signal }).then(function () {
            if (['succeeded', 'failed', 'cancelled'].includes(webJob.status))
                webJob.admissionRelease?.();
        }, function (cause) {
            if (webJob.status !== 'cancelled') {
                webJob.status = 'failed';
                webJob.error = cause instanceof Error ? cause.message : String(cause);
                webJob.code = runtimeErrorCode(cause) || 'WEBUI_QUEUE_FAILED';
            }
            webJob.admissionRelease?.();
        });
        return publicJob(webJob);
    }
    async function submit(input: GenerationInput, ownerId: string) {
        if (registry.isClosed()) throw error(503, 'GENERATION_CLOSED', '生成服务已关闭');
        // fresh：路由决策不能吃缓存——上游刚下线时必须立即失败而不是送进注定失败的分支
        let webui = await probeWebUI({ fresh: true });
        let comfyOnline = await comfy.probe().catch(function () { return false; });
        if (registry.isClosed()) throw error(503, 'GENERATION_CLOSED', '生成服务已关闭');
        let webuiSupportsSampler = webui.samplers.length === 0 || webui.samplers.indexOf(input.sampler) !== -1;
        let webuiSupportsScheduler = !input.webuiScheduler || webui.schedulers.length === 0 || webui.schedulers.indexOf(input.webuiScheduler) !== -1 || webui.schedulers.indexOf(input.webuiScheduler === 'karras' ? 'Karras' : input.webuiScheduler) !== -1;
        let webuiSupportsAnimeUpscaler = webui.upscalers.length === 0 || webui.upscalers.indexOf('R-ESRGAN 4x+ Anime6B') !== -1;
        let webuiSupportsRequestedUpscaler = !input.hiresFix || input.autoHires || webui.upscalers.length === 0 || webui.upscalers.indexOf(input.hiresUpscaler) !== -1;
        let comfyUsable = comfyOnline && comfyResourcesAvailable(config, input);
        let webuiUsable = webui.online && webui.waiAvailable;
        if (input.autoHires && webuiUsable && webuiSupportsSampler && webuiSupportsScheduler && webuiSupportsAnimeUpscaler) {
            let animeInput = Object.assign({}, input, { autoHires: false, hiresUpscaler: 'R-ESRGAN 4x+ Anime6B', comfyHires: false, comfyUnsupported: true });
            return submitWebUI(animeInput, ownerId);
        }
        if (comfyUsable && !input.faceDetailer && !input.comfyUnsupported) {
            let superResModel = availableSuperRes(config);
            // Auto 在纯 Comfy 侧：有 ESRGAN 模型走真超分，否则回落潜空间 Latent。
            let preferredInput = input.autoHires
                ? (superResModel
                    ? Object.assign({}, input, { autoHires: false, hiresUpscaler: 'Remacri', superResModel: superResModel, comfyHires: true, comfyUnsupported: false })
                    : Object.assign({}, input, { autoHires: false, hiresUpscaler: 'Latent (nearest-exact)', comfyHires: true, comfyUnsupported: false }))
                : (input.superResWanted
                    ? (superResModel
                        ? Object.assign({}, input, { superResModel: superResModel, comfyHires: true, comfyUnsupported: false })
                        : null)
                    : input);
            if (!preferredInput) {
                throw error(503, 'SUPER_RES_MODEL_UNAVAILABLE', 'Comfy 本地未安装 ESRGAN 超分模型（Remacri / R-ESRGAN 4x+），请改用 WebUI 或 Latent');
            }
            return submitComfy(preferredInput, ownerId);
        }
        if (webuiUsable && (!webuiSupportsSampler || !webuiSupportsScheduler)) {
            throw error(400, 'WEBUI_CAPABILITY_UNAVAILABLE', 'WebUI 不支持当前采样器或调度器');
        }
        if (webuiUsable && !webuiSupportsRequestedUpscaler) {
            throw error(400, 'WEBUI_UPSCALER_UNAVAILABLE', 'WebUI 未安装所选放大器');
        }
        if (input.autoHires && webuiUsable) {
            let directInput = Object.assign({}, input, { autoHires: false, hiresFix: false, comfyHires: false, comfyUnsupported: false });
            return submitWebUI(directInput, ownerId);
        }
        if (webuiUsable) {
            return submitWebUI(input, ownerId);
        }
        if (input.faceDetailer) {
            throw error(503, 'WEBUI_RESOURCES_UNAVAILABLE', '当前功能需要包含 WAI checkpoint 的 SD WebUI / reForge');
        }
        if (!comfyUsable)
            throw error(503, 'COMFY_RESOURCES_UNAVAILABLE', 'WAI checkpoint 或角色 LoRA 资源不可用，未选择 ComfyUI');
        if (input.comfyUnsupported)
            throw error(503, 'COMFY_CAPABILITY_UNAVAILABLE', '当前请求不符合 ComfyUI 能力，请启用 WebUI 或改用 Latent hires');
        return submitComfy(input, ownerId);
    }
    async function submitComfy(input: GenerationInput, ownerId: string) {
        let release = reserveAdmission('comfy');
        let job;
        try {
            job = comfy.create(input, ownerId);
            await comfy.submit(job);
            watchComfyAdmission(job, release);
        } catch (cause) {
            if (job?.upstreamId) {
                watchComfyAdmission(job, release);
                throw error(502, runtimeErrorCode(cause) || 'COMFY_SUBMIT_UNCERTAIN', 'ComfyUI 已接受任务但提交响应异常');
            }
            release();
            if (job) await comfy.cancel(job).catch(() => {});
            throw error(502, runtimeErrorCode(cause) || 'COMFY_SUBMIT_FAILED', 'ComfyUI 提交失败');
        }
        return comfy.publicJob(job);
    }
    function find(id: string, ownerId: string) {
        const comfyJob = comfy.get(id, ownerId);
        if (comfyJob && comfyJob.owner === ownerId)
            return { provider: 'comfy' as const, job: comfyJob };
        const job = jobs.get(id);
        if (job && job.owner === ownerId)
            return { provider: 'webui' as const, job };
        throw error(404, 'JOB_NOT_FOUND', '任务不存在');
    }
    function getLost(id: string, ownerId: string) {
        const comfyLost = comfy.getLost(id, ownerId);
        if (comfyLost) return comfyLost;
        return lostWebJobs.find(function (job) { return job.id === id && job.owner === ownerId; }) || null;
    }
    function getJob(id: string, ownerId: string) {
        const found = find(id, ownerId);
        if (found.provider === 'comfy')
            settleComfyAdmission(found.job);
        return found.provider === 'comfy' ? comfy.publicJob(found.job) : publicJob(found.job);
    }
    function getResult(id: string, ownerId: string) {
        let found;
        try {
            found = find(id, ownerId);
        }
        catch {
            throw error(404, 'RESULT_NOT_FOUND', '结果不存在');
        }
        if (found.job.status !== 'succeeded' || !found.job.result)
            throw error(404, 'RESULT_NOT_FOUND', '结果不存在');
        if (found.provider === 'webui') {
            const job = found.job;
            return { kind: 'buffer' as const, buffer: job.result!, mime: job.mime || 'image/png', consume: () => {} };
        }
        const job = found.job;
        settleComfyAdmission(job);
        const result = job.result!;
        const root = path.resolve(config.RUNTIME?.outputs || path.join(config.RUNTIME_ROOT, 'outputs'), 'wai');
        const file = path.resolve(result.path);
        if (!file.startsWith(root + path.sep))
            throw error(404, 'RESULT_NOT_FOUND', '结果不存在');
        return { kind: 'file' as const, file, mime: result.mime, bytes: result.bytes, consume: () => {} };
    }
    async function cancel(id: string, ownerId: string) {
        const found = find(id, ownerId);
        if (found.provider === 'comfy') {
            await comfy.cancel(found.job);
            settleComfyAdmission(found.job);
            return comfy.publicJob(found.job);
        }
        const job = found.job;
        let wasQueued = job.status === 'queued';
        if (wasQueued) {
            job.queueAbort?.abort();
        } else if (job.status === 'running')
            await requestJson(config, 'SD_HOST', 'POST', '/sdapi/v1/interrupt', {}, 10000).catch(() => { });
        job.status = 'cancelled';
        job.code = 'WEBUI_CANCELLED';
        if (wasQueued)
            job.admissionRelease?.();
        return publicJob(job);
    }
    function close() {
        registry.close();
        for (const admission of comfyAdmissions.values()) {
            clearInterval(admission.timer);
            admission.release();
        }
        comfyAdmissions.clear();
        for (const job of jobs.values()) {
            let wasQueued = job.status === 'queued';
            job.queueAbort?.abort();
            registry.clearTimer(job, 'gcTimer');
            job.result = null;
            job.status = 'cancelled';
            snapshots.remove(job.id);
            if (wasQueued)
                job.admissionRelease?.();
        }
        jobs.clear();
        comfy.close();
    }
    return { getStatus, submit, getJob, getResult, getLost, cancel, close, comfy };
}
