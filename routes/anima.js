"use strict";
const runtime_errors_1 = require("../scripts/lib/runtime-errors");
const runtime_errors_2 = require("../scripts/lib/runtime-errors");
'use strict';
var crypto = require('crypto');
var express = require('express');
var fs = require('fs');
var path = require('path');
var security = require('../server/security');
var envelope = require('../server/http-envelope');
var generationContract = require('../server/anima-generation-contract');
var comfyClient = require('../server/comfy-client');
var comfyProgress = require('../server/comfy-progress');
// P3 收口：ComfyUI 探活统一走 server/upstream-health
var upstreamHealth = require('../server/upstream-health');
// 2026-08-21 收口：模型/LoRA/角色白名单数据表外移；任务注册表骨架统一
var modelCatalog = require('../server/anima-model-catalog');
var jobRunner = require('../server/job-runner');
var superres = require('./superres');
// ══ 2026-08-27 P1-b 样板拆分（照 routes/video/）：五个子模块承接原内联实现，
//  规则与声明逐字搬运；对外导出面保持不变。 ══
var animaErrors = require('./anima/errors');
var animaValidation = require('./anima/validation');
var animaMedia = require('./anima/media');
var animaWorkflows = require('./anima/workflows');
var animaConstants = require('./anima/constants');
var serviceError = animaErrors.serviceError;
var isPlainObject = animaErrors.isPlainObject;
var validateInput = animaValidation.validateInput;
var buildWorkflow = animaWorkflows.buildWorkflow;
var modelRoot = animaMedia.modelRoot;
var imageInputRoot = animaMedia.imageInputRoot;
var cleanupImageInputs = animaMedia.cleanupImageInputs;
var sniffImageExtension = animaMedia.sniffImageExtension;
var resourceExists = animaMedia.resourceExists;
var requiredResources = animaMedia.requiredResources;
var validateImageReference = animaMedia.validateImageReference;
var ensureMediaRoot = animaMedia.ensureMediaRoot;
var safeMediaPath = animaMedia.safeMediaPath;
var cleanupMediaRoot = animaMedia.cleanupMediaRoot;
var materializeResult = animaMedia.materializeResult;
var MAX_BODY = animaConstants.MAX_BODY;
var MAX_PENDING = animaConstants.MAX_PENDING;
var MAX_IMAGE_BYTES = animaConstants.MAX_IMAGE_BYTES;
var INPUT_IMAGE_TTL_MS = animaConstants.INPUT_IMAGE_TTL_MS;
var JOB_TIMEOUT_MS = animaConstants.JOB_TIMEOUT_MS;
var POLL_INTERVAL_MS = animaConstants.POLL_INTERVAL_MS;
var JOB_TTL_MS = animaConstants.JOB_TTL_MS;
var CANCEL_POLL_INTERVAL_MS = animaConstants.CANCEL_POLL_INTERVAL_MS;
var CANCEL_TIMEOUT_MS = animaConstants.CANCEL_TIMEOUT_MS;
var OUTPUT_NODE_ID = animaConstants.OUTPUT_NODE_ID;
var OUTPUT_FILENAME_PREFIX = animaConstants.OUTPUT_FILENAME_PREFIX;
// 2026-08-27 审计收口：缓冲式 ComfyUI JSON 传输全站唯一实现（曾在本文件
// 与 routes/video/comfy.js 各持一份逐行相同的拷贝）。
var requestComfyJson = comfyClient.requestComfyJson;
var unloadComfyModels = comfyClient.unloadComfyModels;
// 显存保护状态按 ComfyUI 实例隔离：同一网关内 anima/creative/generation 多个
// service 实例共享同一上游时，切换底模家族也要能互相感知（避免 WAI/Anima 交替
// 时漏卸载；不同测试/不同 COMFY_HOST 之间互不串扰）。
var lastFamilyByComfyHost = new Map();
// 模型/LoRA/角色白名单：2026-08-21 起由 server/anima-model-catalog.js 承载
var MODELS = modelCatalog.MODELS;
var LORAS = modelCatalog.LORAS;
var KREA_STYLE_LORAS = modelCatalog.KREA_STYLE_LORAS;
var CHARACTERS = modelCatalog.CHARACTERS;
// 放大二阶段参数：固定 sgm_uniform + res_multistep（首轮 res_multistep/simple）
var HIRES_SAMPLER = generationContract.HIRES_SAMPLER;
var HIRES_SCHEDULER = generationContract.HIRES_SCHEDULER;
function requestOwner(req) {
    if (security.isDirectLocalRequest(req))
        return 'local';
    var cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)aics_token=([^;]+)/);
    var token = req.headers['x-token'] || cookie && cookie[1] || req.query && req.query.token || '';
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}
var publicJob = require('./anima/job-state').publicJob;
function createAnimaService(config, options) {
    options = options || {};
    var buildWorkflowForJob = options.buildWorkflow || buildWorkflow;
    var outputPrefix = options.outputPrefix || OUTPUT_FILENAME_PREFIX;
    var outputNodeId = options.outputNodeId || OUTPUT_NODE_ID;
    var mediaNamespace = options.mediaNamespace || 'anima';
    var engine = options.engine || 'anima';
    var provider = options.provider || 'comfy';
    var routeBase = options.routeBase || '/api/anima';
    var loraRoot = options.loraRoot || path.join(config.AI_WORKSPACE_ROOT || path.resolve(config.ROOT_DIR, '..', 'AI'), 'ComfyUI', 'models', 'loras');
    var validateResources = options.validateResources || function (input) { requiredResources(config, input, loraRoot); };
    var jobTtlMs = Number(options.jobTtlMs) > 0 ? Number(options.jobTtlMs) : JOB_TTL_MS;
    var inputImageTtlMs = Number(options.inputImageTtlMs) > 0 ? Number(options.inputImageTtlMs) : INPUT_IMAGE_TTL_MS;
    var cancelPollIntervalMs = Number(options.cancelPollIntervalMs) > 0
        ? Number(options.cancelPollIntervalMs) : CANCEL_POLL_INTERVAL_MS;
    var cancelTimeoutMs = Number(options.cancelTimeoutMs) > 0
        ? Number(options.cancelTimeoutMs) : CANCEL_TIMEOUT_MS;
    // 任务注册表骨架（Map + pendingCount + closed 标志）收口到 server/job-runner.js；
    // poll/cancel 状态机保持本路由引擎专属实现。
    var registry = jobRunner.createJobRegistry();
    var jobs = registry.jobs;
    function cleanupOwnedInputs() {
        var activeInputs = new Set();
        jobs.forEach(function (job) {
            if (job.input.initImage)
                activeInputs.add(job.input.initImage);
            if (job.input.maskImage)
                activeInputs.add(job.input.maskImage);
        });
        cleanupImageInputs(config, activeInputs, inputImageTtlMs);
    }
    // 2026-08-16 审计（方案 A）：client_id 持久化复用 + 启动清理重启遗留的 ComfyUI
    // 任务（立即 + 30s 后各试一次，重试幂等无害）；2026-08-21 收口到 comfy-client。
    var clientId = comfyClient.clientIdFor(config, engine);
    comfyClient.sweepOrphanPromptsAfterStart(config, clientId, 'anima');
    var progressMonitor = comfyProgress.createComfyProgressMonitor(config, clientId);
    // 显存保护：按当前 ComfyUI 实例记录最近一次提交的底模家族；Anima ⇄ Krea2
    // 切换时先让 ComfyUI 卸载上一家族模型，避免两个大模型同时驻留显存。
    // 首次提交也释放一次，兜底网关重启后 ComfyUI 里仍驻留的旧模型。
    var comfyHostKey = String(config.COMFY_HOST || 'default');
    cleanupMediaRoot(config, mediaNamespace);
    cleanupOwnedInputs();
    var inputCleanupTimer = setInterval(cleanupOwnedInputs, Math.min(inputImageTtlMs, 5 * 60 * 1000));
    if (typeof inputCleanupTimer.unref === 'function')
        inputCleanupTimer.unref();
    var pendingCount = registry.pendingCount;
    function schedulePoll(job, delay) {
        if (registry.isClosed() || job.status === 'cancelled' || job.status === 'cancelling' || job.status === 'succeeded' || job.status === 'failed')
            return;
        if (job.pollTimer)
            clearTimeout(job.pollTimer);
        job.pollTimer = setTimeout(function () {
            job.pollTimer = null;
            poll(job);
        }, delay);
    }
    function failJob(job, error, fallbackCode) {
        if (job.status === 'cancelled' || job.status === 'cancelling')
            return;
        job.status = 'failed';
        job.finishedAt = Date.now();
        if (job.upstreamId)
            progressMonitor.unwatch(job.upstreamId);
        job.errorCode = (0, runtime_errors_2.errorCode)(error) || fallbackCode || 'ANIMA_FAILED';
        job.error = (0, runtime_errors_2.errorCode)(error) === 'INVALID_RESULT'
            ? '生成结果未通过安全校验'
            : ((0, runtime_errors_2.errorMessage)(error) || 'Anima 生成失败');
        if (job.pollTimer) {
            clearTimeout(job.pollTimer);
            job.pollTimer = null;
        }
    }
    function queueHasPrompt(items, promptId) {
        return Array.isArray(items) && items.some(function (item) {
            return Array.isArray(item) ? item[1] === promptId : item && (0, runtime_errors_1.errorField)(item, 'prompt_id') === promptId;
        });
    }
    async function requestTargetedCancel(job) {
        if (!job.upstreamId)
            return;
        try {
            // Current ComfyUI exposes a state-agnostic, prompt-id-scoped cancel API.
            await requestComfyJson(config, 'POST', '/api/jobs/' + encodeURIComponent(job.upstreamId) + '/cancel', null, 10000);
            return;
        }
        catch (error) {
            var upstreamStatus = Number((0, runtime_errors_1.errorField)((0, runtime_errors_1.errorField)(error, 'detail'), 'upstreamStatus'));
            if (upstreamStatus !== 404 && upstreamStatus !== 405)
                throw error;
        }
        // Older ComfyUI can safely remove a specific pending prompt. Do not fall
        // back to a potentially global /interrupt implementation for running work.
        var queue = await requestComfyJson(config, 'GET', '/queue', null, 10000);
        var running = queue && (queue.queue_running || queue.running);
        var pending = queue && (queue.queue_pending || queue.pending);
        if (queueHasPrompt(pending, job.upstreamId)) {
            await requestComfyJson(config, 'POST', '/queue', { delete: [job.upstreamId] }, 10000);
            return;
        }
        if (queueHasPrompt(running, job.upstreamId)) {
            throw serviceError(502, 'COMFY_TARGETED_CANCEL_UNAVAILABLE', '当前 ComfyUI 不支持安全的定向运行中取消');
        }
    }
    function finishCancellation(job) {
        if (job.pollTimer) {
            clearTimeout(job.pollTimer);
            job.pollTimer = null;
        }
        job.status = 'cancelled';
        job.finishedAt = Date.now();
        if (job.upstreamId)
            progressMonitor.unwatch(job.upstreamId);
        job.error = '任务已取消';
        job.errorCode = 'ANIMA_CANCELLED';
        removeResult(job);
    }
    function failCancellation(job) {
        if (job.pollTimer) {
            clearTimeout(job.pollTimer);
            job.pollTimer = null;
        }
        job.status = 'failed';
        job.finishedAt = Date.now();
        if (job.upstreamId)
            progressMonitor.unwatch(job.upstreamId);
        job.error = '无法确认上游任务已安全取消';
        job.errorCode = 'ANIMA_CANCEL_FAILED';
        removeResult(job);
    }
    async function confirmCancellation(job) {
        if (registry.isClosed() || job.status !== 'cancelling' || !job.upstreamId)
            return;
        // 2026-08-16 审计：cancel() 的确认定时器与 poll() 的 cancelling 分支可能并发
        // 进入本函数——两路同时推进 cancelChecks 会把「两次观测」误算成四次（提前
        // 判定取消完成），或双跑完成路径。加 in-flight 串行锁，多余进入直接返回。
        if (job.cancelPolling)
            return;
        job.cancelPolling = true;
        try {
            if (Date.now() > job.cancelDeadline) {
                failCancellation(job);
                return;
            }
            try {
                var queue = await requestComfyJson(config, 'GET', '/queue', null, 10000);
                var running = queue && (queue.queue_running || queue.running);
                var pending = queue && (queue.queue_pending || queue.pending);
                if (queueHasPrompt(running, job.upstreamId) || queueHasPrompt(pending, job.upstreamId)) {
                    job.cancelChecks = 0;
                    scheduleCancelPoll(job);
                    return;
                }
                var history = await requestComfyJson(config, 'GET', '/history/' + encodeURIComponent(job.upstreamId), null, 10000);
                var entry = history && history[job.upstreamId];
                var status = entry && entry.status && entry.status.status_str;
                if (entry && status !== 'success' && status !== 'error' && status !== 'failed') {
                    job.cancelChecks = 0;
                    scheduleCancelPoll(job);
                    return;
                }
                // Require two consecutive queue/history observations so an interrupt
                // acknowledgement is not mistaken for actual upstream termination.
                job.cancelChecks += 1;
                if (job.cancelChecks < 2) {
                    scheduleCancelPoll(job);
                    return;
                }
                finishCancellation(job);
            }
            catch (error) {
                job.cancelFailures += 1;
                scheduleCancelPoll(job);
            }
        }
        finally {
            job.cancelPolling = false;
        }
    }
    function scheduleCancelPoll(job) {
        if (registry.isClosed() || job.status !== 'cancelling')
            return;
        if (job.pollTimer)
            clearTimeout(job.pollTimer);
        job.pollTimer = setTimeout(function () {
            job.pollTimer = null;
            void confirmCancellation(job);
        }, cancelPollIntervalMs);
    }
    async function poll(job) {
        if (registry.isClosed() || jobRunner.isTerminalStatus(job.status) || !job.upstreamId)
            return;
        if (job.status === 'cancelling') {
            await confirmCancellation(job);
            return;
        }
        if (Date.now() > job.deadline) {
            void requestTargetedCancel(job).catch(function () { });
            failJob(job, serviceError(504, 'ANIMA_TIMEOUT', 'Anima 生成超时'), 'ANIMA_TIMEOUT');
            return;
        }
        try {
            var history = await requestComfyJson(config, 'GET', '/history/' + encodeURIComponent(job.upstreamId), null, 10000);
            if (registry.isClosed() || job.status !== 'running')
                return;
            job.pollFailures = 0;
            var entry = history && history[job.upstreamId];
            if (!entry) {
                schedulePoll(job, POLL_INTERVAL_MS);
                return;
            }
            var status = entry.status && entry.status.status_str;
            job.progress = null;
            job.progressText = status === 'success' ? '生成完成' : status === 'error' || status === 'failed' ? 'ComfyUI 执行失败' : 'ComfyUI 正在推理…';
            if (status === 'error' || status === 'failed') {
                var messages = entry.status && entry.status.messages;
                var executionError = Array.isArray(messages) && messages.find(function (item) { return item[0] === 'execution_error'; });
                var detail = executionError && executionError[1];
                var reason = detail ? String(detail.exception_type || '') + ': ' + String(detail.exception_message || '').slice(0, 1500) : 'ComfyUI 执行失败';
                failJob(job, serviceError(502, 'COMFY_EXECUTION_FAILED', reason), 'COMFY_EXECUTION_FAILED');
                return;
            }
            if (status !== 'success') {
                schedulePoll(job, POLL_INTERVAL_MS);
                return;
            }
            var image = null;
            var output = entry.outputs && entry.outputs[outputNodeId];
            var images = output && output.images;
            if (Array.isArray(images) && images.length)
                image = images[0];
            if (!image) {
                failJob(job, serviceError(502, 'COMFY_NO_IMAGE', 'ComfyUI 未返回图片'), 'COMFY_NO_IMAGE');
                return;
            }
            job.result = await materializeResult(config, job, image, { outputPrefix: job.input.family === 'krea2' ? 'creative_app' : outputPrefix, mediaNamespace: mediaNamespace });
            job.resultConsumed = false;
            // 2026-08-16 审计（与 video.js 同款）：materialize 期间用户可能已取消——
            // 状态离开 running 时丢弃结果并保持取消流程，避免「取消后任务复活为
            // succeeded」且残留结果文件。
            if (registry.isClosed() || job.status !== 'running') {
                removeResult(job);
                return;
            }
            job.status = 'succeeded';
            job.finishedAt = Date.now();
            progressMonitor.unwatch(job.upstreamId);
            job.error = null;
            job.errorCode = null;
            if (job.pollTimer) {
                clearTimeout(job.pollTimer);
                job.pollTimer = null;
            }
        }
        catch (error) {
            if (job.status === 'cancelled')
                return;
            if (error && ['INVALID_RESULT', 'COMFY_NO_IMAGE', 'RESULT_SAVE_FAILED'].includes(String((0, runtime_errors_2.errorCode)(error)))) {
                failJob(job, error, (0, runtime_errors_2.errorCode)(error));
                return;
            }
            job.pollFailures += 1;
            if (Date.now() > job.deadline || job.pollFailures >= 60) {
                failJob(job, error, 'ANIMA_POLL_FAILED');
                return;
            }
            // 轮询失败只延迟下一次读取，绝不再次提交工作流。
            schedulePoll(job, Math.min(3000, POLL_INTERVAL_MS * Math.max(1, job.pollFailures)));
        }
    }
    async function submit(job) {
        if (registry.isClosed() || job.status !== 'queued')
            throw serviceError(409, 'JOB_NOT_QUEUED', '任务已结束或服务已关闭');
        validateResources(job.input);
        // WAI/generation 复用本服务时 input 没有 family，用 engine 兜底为 'sd'，
        // 这样 Anima/Krea2/SD 三条 Comfy 链路之间切换也能正确触发卸载。
        var family = job.input.family || engine;
        // 显存保护：家族切换（或首次提交）时先让 ComfyUI 卸载已加载模型。
        // unloadComfyModels 内部静默降级，不阻塞主出图链路。
        var lastLoadedFamily = lastFamilyByComfyHost.get(comfyHostKey);
        if (lastLoadedFamily === undefined || lastLoadedFamily !== family) {
            await unloadComfyModels(config);
        }
        if (registry.isClosed() || job.status !== 'queued')
            return;
        var response = await requestComfyJson(config, 'POST', '/prompt', {
            prompt: buildWorkflowForJob(job.input),
            client_id: clientId
        }, 20000);
        var promptId = response && response.prompt_id;
        if (typeof promptId !== 'string' || !promptId || promptId.length > 200) {
            throw serviceError(502, 'COMFY_INVALID_RESPONSE', 'ComfyUI 未返回有效任务 ID');
        }
        job.upstreamId = promptId;
        lastFamilyByComfyHost.set(comfyHostKey, family);
        if (registry.isClosed() || ['cancelling', 'cancelled'].includes(job.status)) {
            void requestTargetedCancel(job).catch(function () { });
            return;
        }
        job.status = 'running';
        job.progressText = '已提交，等待 ComfyUI 执行…';
        progressMonitor.watch(promptId, job);
        schedulePoll(job, 0);
    }
    function create(input, owner) {
        if (registry.isClosed())
            throw serviceError(503, 'SERVICE_CLOSED', '生成服务已关闭');
        if (pendingCount() >= MAX_PENDING)
            throw serviceError(429, 'ANIMA_QUEUE_FULL', 'Anima 队列已满，请稍后再试');
        var id = crypto.randomBytes(18).toString('hex');
        var createdAt = Date.now();
        // 2026-08-20：Anima hires 接入本地 ESRGAN 真超分（Remacri）。buildWorkflow 是纯函数
        // 无法探测模型文件，这里在入队前探测并注入；只对 anima family（非 krea2）hires 生效，
        // 未安装模型时保持原 latent bicubic 回退；'Latent' 放大器显式跳过像素超分（2026-08-25 可选）。
        if (input.hiresFix && input.family !== 'krea2' && !input.superResModel && input.hiresUpscaler !== 'Latent') {
            var localSuperRes = superres.availableSuperRes(config);
            if (localSuperRes)
                input.superResModel = localSuperRes;
        }
        var frozenInput = Object.freeze(Object.assign({}, input));
        var metadataLoras = frozenInput.loras
            ? Object.freeze(frozenInput.loras.map(function (lora) { return Object.freeze({ id: lora.id, strength: lora.strength }); }))
            : Object.freeze(frozenInput.loraId ? [Object.freeze({ id: frozenInput.loraId, strength: frozenInput.loraStrength })] : []);
        var job = {
            id: id,
            owner: owner,
            provider: provider,
            input: frozenInput,
            metadata: Object.freeze({
                engine: frozenInput.family || engine, id: id, prompt: frozenInput.prompt, negative: frozenInput.negative,
                profileId: frozenInput.profileId || '', modelId: frozenInput.modelId, loraId: frozenInput.loraId,
                loras: metadataLoras, loraStrength: frozenInput.loraStrength, styleLoraId: frozenInput.styleLoraId || null, width: frozenInput.width, height: frozenInput.height,
                hiresFix: Boolean(frozenInput.hiresFix), hiresScale: frozenInput.hiresScale, hiresUpscaler: frozenInput.superResModel ? 'Remacri' : frozenInput.hiresUpscaler,
                hiresSteps: frozenInput.hiresSteps, denoisingStrength: frozenInput.denoisingStrength, faceDetailer: Boolean(frozenInput.faceDetailer),
                steps: frozenInput.steps, cfg: frozenInput.cfg, sampler: frozenInput.sampler || 'res_multistep', scheduler: frozenInput.scheduler || 'simple',
                hiresSampler: frozenInput.family !== 'krea2' && Boolean(frozenInput.hiresFix) && !frozenInput.superResModel ? HIRES_SAMPLER : null,
                hiresScheduler: frozenInput.family !== 'krea2' && Boolean(frozenInput.hiresFix) && !frozenInput.superResModel ? HIRES_SCHEDULER : null,
                teaCache: Boolean(frozenInput.teaCache), teaCacheThresh: frozenInput.teaCacheThresh,
                seed: frozenInput.seed, character: frozenInput.character || null, preview: Boolean(LORAS[String(frozenInput.loraId)] && LORAS[String(frozenInput.loraId)].preview), createdAt: createdAt, resultUrl: null,
                provider: provider
            }),
            status: 'queued',
            createdAt: createdAt,
            deadline: createdAt + JOB_TIMEOUT_MS,
            upstreamId: '',
            result: null,
            resultConsumed: false,
            error: null,
            errorCode: null,
            pollTimer: null,
            gcTimer: null,
            pollFailures: 0,
            progress: null,
            progressText: '等待提交到 ComfyUI…',
            currentNode: null,
            cancelFailures: 0,
            cancelChecks: 0,
            cancelDeadline: 0,
            cancelPolling: false
        };
        jobs.set(job.id, job);
        function collect() {
            var current = jobs.get(job.id);
            if (current !== job)
                return;
            if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled')
                removeJob(job);
            else
                job.gcTimer = setTimeout(collect, jobTtlMs).unref();
        }
        job.gcTimer = setTimeout(collect, jobTtlMs).unref();
        return job;
    }
    function get(id, owner) {
        var job = jobs.get(String(id || ''));
        if (!job || job.owner !== owner)
            return null;
        return job;
    }
    function removeResult(job) {
        if (job.result && job.result.path) {
            try {
                fs.unlinkSync(job.result.path);
            }
            catch (error) { }
        }
        job.result = null;
        job.resultConsumed = true;
    }
    function removeJob(job) {
        if (job.upstreamId)
            progressMonitor.unwatch(job.upstreamId);
        if (job.pollTimer) {
            clearTimeout(job.pollTimer);
            job.pollTimer = null;
        }
        if (job.gcTimer) {
            clearTimeout(job.gcTimer);
            job.gcTimer = null;
        }
        removeResult(job);
        jobs.delete(job.id);
        cleanupOwnedInputs();
    }
    function consumeResult(job) {
        if (!job.result || job.resultConsumed)
            return;
        removeResult(job);
    }
    async function cancel(job) {
        if (job.status === 'queued' || job.status === 'running') {
            if (!job.upstreamId) {
                finishCancellation(job);
                return job;
            }
            job.status = 'cancelling';
            job.error = '任务取消中';
            job.errorCode = 'ANIMA_CANCELLING';
            job.cancelChecks = 0;
            job.cancelDeadline = Date.now() + cancelTimeoutMs;
            try {
                await requestTargetedCancel(job);
            }
            catch (error) {
                job.cancelFailures += 1;
            }
            scheduleCancelPoll(job);
        }
        else if (job.status === 'cancelling') {
            scheduleCancelPoll(job);
        }
        else if (job.status === 'succeeded') {
            removeResult(job);
            job.status = 'cancelled';
            job.error = '任务已删除';
            job.errorCode = 'ANIMA_CANCELLED';
        }
        return job;
    }
    function status() {
        var modelRootPath = modelRoot(config);
        function available(model) {
            var encoder = model.family === 'krea2' ? 'qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors' : 'qwen_3_06b_base.safetensors';
            return resourceExists(modelRootPath, 'diffusion_models', model.file)
                && resourceExists(modelRootPath, 'text_encoders', encoder)
                && resourceExists(modelRootPath, 'vae', 'qwen_image_vae.safetensors');
        }
        return {
            online: false,
            models: Object.keys(MODELS).map(function (id) { var model = MODELS[id]; return { id: id, label: model.label, family: model.family, profileId: model.profileId, available: available(model), defaults: { steps: model.steps, cfg: model.cfg, sampler: model.sampler, scheduler: model.scheduler }, sizes: model.sizes, capabilities: { negative: model.family !== 'krea2', lora: model.family === 'anima', noLora: model.family === 'krea2' || model.noLora === true, characterIdentity: model.family === 'anima', experimental: model.family === 'krea2' || model.noLora === true } }; }),
            loras: Object.keys(LORAS).map(function (id) {
                var lora = LORAS[id];
                return { id: id, name: lora.name, character: lora.character, preview: Boolean(lora.preview), validation: lora.validation || 'production', available: resourceExists(loraRoot, '', lora.file) };
            }),
            styleLoras: Object.keys(KREA_STYLE_LORAS).map(function (id) { var style = KREA_STYLE_LORAS[id]; return { id: id, trigger: style.trigger, recommendedStrength: 1, available: resourceExists(loraRoot, '', style.file) }; }),
            characters: Object.keys(CHARACTERS).map(function (id) { return CHARACTERS[id]; }),
            // 2026-08-20：本地 ESRGAN 真超分可用性（Anima hires 默认自动走 Remacri）。
            hires: { superResModel: superres.availableSuperRes(config) || null },
            pending: pendingCount(),
            maxPending: MAX_PENDING
        };
    }
    async function probe() {
        // P3 收口：探活统一走 server/upstream-health（与控制面板同一份判定口径）
        return upstreamHealth.pingComfy(config.COMFY_HOST, 2500);
    }
    function close() {
        registry.close();
        progressMonitor.close();
        clearInterval(inputCleanupTimer);
        jobs.forEach(function (job) {
            if (job.pollTimer)
                clearTimeout(job.pollTimer);
            job.pollTimer = null;
            if (job.gcTimer)
                clearTimeout(job.gcTimer);
            job.gcTimer = null;
            if (job.status === 'queued' || job.status === 'running' || job.status === 'cancelling') {
                void requestTargetedCancel(job).catch(function () { });
            }
            removeResult(job);
        });
        jobs.clear();
        cleanupMediaRoot(config, mediaNamespace);
        cleanupOwnedInputs();
    }
    return {
        create: create,
        submit: submit,
        get: get,
        cancel: cancel,
        consumeResult: consumeResult,
        publicJob: function (job) { return publicJob(job, job.input && job.input.family === 'krea2' ? '/api/creative' : routeBase); },
        probe: probe,
        status: status,
        close: close,
        constants: { MODELS: MODELS, LORAS: LORAS, KREA_STYLE_LORAS: KREA_STYLE_LORAS, MAX_PENDING: MAX_PENDING, JOB_TTL_MS: jobTtlMs, CANCEL_TIMEOUT_MS: cancelTimeoutMs }
    };
}
function createAnimaRouter(config, dependencies) {
    dependencies = dependencies || {};
    var router = express.Router();
    var service = dependencies.anima || createAnimaService(config);
    var jobLimit = security.rateLimit({ capacity: 12, refillMs: 5000, label: 'Anima 出图' });
    function routeFamily(req) { return String(req.path || '').startsWith('/api/anima') ? 'anima' : 'creative'; }
    function routeOwnsJob(req, job) { return Boolean(job) && (routeFamily(req) === 'anima' ? job.input.family === 'anima' : job.input.family === 'krea2'); }
    router.get(['/api/anima/status', '/api/creative/status'], function (req, res) {
        service.probe().then(function (online) {
            var data = service.status();
            if (routeFamily(req) === 'anima')
                data.models = data.models.filter(function (model) { return model.family === 'anima'; });
            data.online = online && data.models.some(function (model) { return model.available === true; });
            res.setHeader('Cache-Control', 'no-store');
            envelope.ok(res, data);
        }).catch(function () {
            var data = service.status();
            if (routeFamily(req) === 'anima')
                data.models = data.models.filter(function (model) { return model.family === 'anima'; });
            data.online = false;
            res.setHeader('Cache-Control', 'no-store');
            envelope.ok(res, data);
        });
    });
    router.post(['/api/anima/images', '/api/creative/images'], jobLimit, express.json({ limit: '28mb' }), async function (req, res) {
        try {
            if (!isPlainObject(req.body) || typeof req.body.image !== 'string') {
                return envelope.fail(res, 400, '请求体必须包含 image base64 字符串', { code: 'INVALID_BODY' });
            }
            var base64Data = req.body.image.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
            var buffer = Buffer.from(base64Data, 'base64');
            if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
                return envelope.fail(res, 400, '图片数据超出大小限制', { code: 'INVALID_IMAGE' });
            }
            var ext = sniffImageExtension(buffer);
            if (!ext) {
                return envelope.fail(res, 400, '不支持的图片格式（仅限 PNG、JPEG、WebP）', { code: 'INVALID_IMAGE_FORMAT' });
            }
            var hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
            var filename = 'aics_anima_input_' + hash + '.' + ext;
            var targetDir = imageInputRoot(config);
            fs.mkdirSync(targetDir, { recursive: true });
            var targetPath = path.resolve(targetDir, filename);
            // 异步写盘，避免 ≤20MB 同步写冻结事件循环（2026-08-21 性能审计 #1）
            await fs.promises.writeFile(targetPath, buffer);
            return envelope.ok(res, { ok: true, name: filename });
        }
        catch (error) {
            return envelope.fail(res, 500, (0, runtime_errors_2.errorMessage)(error) || '图片保存失败', { code: 'IMAGE_SAVE_FAILED' });
        }
    });
    router.post(['/api/anima/jobs', '/api/creative/jobs'], jobLimit, express.json({ limit: MAX_BODY }), async function (req, res) {
        var input;
        try {
            input = validateInput(req, req.body, routeFamily(req) === 'anima' ? 'anima' : 'krea2');
        }
        catch (error) {
            return envelope.fail(res, (0, runtime_errors_2.errorStatus)(error) || 400, (0, runtime_errors_2.errorMessage)(error), { code: (0, runtime_errors_2.errorCode)(error) });
        }
        var job;
        try {
            job = service.create(input, requestOwner(req));
            res.once('close', function () { if (!res.writableFinished && job)
                void service.cancel(job); });
            await service.submit(job);
        }
        catch (error) {
            if (job) {
                service.cancel(job);
            }
            var status = (0, runtime_errors_2.errorStatus)(error);
            return envelope.fail(res, status === 503 ? 503 : (status !== undefined && status >= 500 ? 502 : (status || 502)), (0, runtime_errors_2.errorMessage)(error) || 'Anima 提交失败', { code: (0, runtime_errors_2.errorCode)(error) || 'ANIMA_SUBMIT_FAILED' });
        }
        res.status(202);
        return envelope.ok(res, { job: service.publicJob(job) });
    });
    router.get(['/api/anima/jobs/:id/result', '/api/creative/jobs/:id/result'], function (req, res) {
        var job = service.get(req.params.id, requestOwner(req));
        if (!routeOwnsJob(req, job))
            return envelope.fail(res, 404, '生成任务不存在', { code: 'JOB_NOT_FOUND' });
        if (job.resultConsumed)
            return envelope.fail(res, 404, '结果已消费或不存在', { code: 'RESULT_NOT_FOUND' });
        if (job.status !== 'succeeded' || !job.result) {
            return envelope.fail(res, job.status === 'failed' ? 502 : 409, job.error || '结果尚未就绪', { code: job.errorCode || 'RESULT_NOT_READY' });
        }
        var root = ensureMediaRoot(config);
        var target = safeMediaPath(root, path.basename(job.result.path));
        if (!target || target !== path.resolve(job.result.path))
            return envelope.fail(res, 404, '结果不存在', { code: 'RESULT_NOT_FOUND' });
        try {
            var realRoot = fs.realpathSync(root);
            var realTarget = fs.realpathSync(target);
            var stat = fs.statSync(realTarget);
            if (!stat.isFile() || realTarget.indexOf(realRoot + path.sep) !== 0)
                throw new Error('unsafe result');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Type', job.result.mime);
            res.setHeader('Content-Length', String(stat.size));
            res.setHeader('X-Content-Type-Options', 'nosniff');
            // 下载完成不等于浏览器已经持久化；允许 TTL 内重读，避免一次断线丢图。
            var stream = fs.createReadStream(realTarget);
            stream.on('error', function () {
                if (!res.headersSent)
                    envelope.fail(res, 404, '结果不存在', { code: 'RESULT_NOT_FOUND' });
                else
                    res.destroy();
            });
            stream.pipe(res);
        }
        catch (error) {
            return envelope.fail(res, 404, '结果不存在', { code: 'RESULT_NOT_FOUND' });
        }
    });
    router.get(['/api/anima/jobs/:id', '/api/creative/jobs/:id'], function (req, res) {
        var job = service.get(req.params.id, requestOwner(req));
        if (!routeOwnsJob(req, job))
            return envelope.fail(res, 404, '生成任务不存在', { code: 'JOB_NOT_FOUND' });
        res.setHeader('Cache-Control', 'no-store');
        return envelope.ok(res, { job: service.publicJob(job) });
    });
    router.delete(['/api/anima/jobs/:id', '/api/creative/jobs/:id'], async function (req, res) {
        var job = service.get(req.params.id, requestOwner(req));
        if (!routeOwnsJob(req, job))
            return envelope.fail(res, 404, '生成任务不存在', { code: 'JOB_NOT_FOUND' });
        var cancelled = await service.cancel(job);
        res.status(cancelled.status === 'cancelling' ? 202 : 200);
        return envelope.ok(res, { job: service.publicJob(cancelled) });
    });
    return { router: router, service: service, close: service.close };
}
module.exports = {
    createAnimaRouter: createAnimaRouter,
    createAnimaService: createAnimaService,
    validateInput: validateInput,
    buildWorkflow: buildWorkflow,
    validateImageReference: validateImageReference,
    cleanupImageInputs: cleanupImageInputs,
    constants: {
        MODELS: MODELS,
        LORAS: LORAS,
        KREA_STYLE_LORAS: KREA_STYLE_LORAS,
        generationContract: generationContract
    }
};
