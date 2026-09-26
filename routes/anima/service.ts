import type { ImageGenerationConfig, ImageJobInput, ImageServiceOptions, ImageJob, ImageModelDefinition, ImageLoraDefinition, ComfyHistory, PromptSubmission } from './types';
import type { ComfyQueueResponse } from '../../server/comfy-types';
import { errorField, errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from '../../scripts/lib/runtime-errors';
'use strict';

let crypto: typeof import('crypto') = require('crypto');
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let generationContract: typeof import('../../server/anima-generation-contract') = require('../../server/anima-generation-contract');
let comfyClient: typeof import('../../server/comfy-client') = require('../../server/comfy-client');
let comfyProgress: typeof import('../../server/comfy-progress') = require('../../server/comfy-progress');
let upstreamHealth: typeof import('../../server/upstream-health') = require('../../server/upstream-health');
let modelCatalog: typeof import('../../server/anima-model-catalog') = require('../../server/anima-model-catalog');
let jobRunner: typeof import('../../server/job-runner') = require('../../server/job-runner');
let jobSnapshot: typeof import('../../server/job-snapshot') = require('../../server/job-snapshot');
let superres: typeof import('../superres') = require('../superres');

let animaErrors: typeof import('./errors') = require('./errors');
let animaMedia: typeof import('./media') = require('./media');
let animaWorkflows: typeof import('./workflows') = require('./workflows');
let animaConstants: typeof import('./constants') = require('./constants');
let serviceError = animaErrors.serviceError;
let buildWorkflow = animaWorkflows.buildWorkflow;
let modelRoot = animaMedia.modelRoot;
let cleanupImageInputs = animaMedia.cleanupImageInputs;
let resourceExists = animaMedia.resourceExists;
let requiredResources = animaMedia.requiredResources;
let cleanupMediaRoot = animaMedia.cleanupMediaRoot;
let materializeResult = animaMedia.materializeResult;
let MAX_PENDING = animaConstants.MAX_PENDING;
let INPUT_IMAGE_TTL_MS = animaConstants.INPUT_IMAGE_TTL_MS;
let JOB_TIMEOUT_MS = animaConstants.JOB_TIMEOUT_MS;
let POLL_INTERVAL_MS = animaConstants.POLL_INTERVAL_MS;
let JOB_TTL_MS = animaConstants.JOB_TTL_MS;
let CANCEL_POLL_INTERVAL_MS = animaConstants.CANCEL_POLL_INTERVAL_MS;
let CANCEL_TIMEOUT_MS = animaConstants.CANCEL_TIMEOUT_MS;
let OUTPUT_NODE_ID = animaConstants.OUTPUT_NODE_ID;
let OUTPUT_FILENAME_PREFIX = animaConstants.OUTPUT_FILENAME_PREFIX;

let requestComfyJson = comfyClient.requestComfyJson;
let unloadComfyModels = comfyClient.unloadComfyModels;
let lastFamilyByComfyHost: Map<string, string> = new Map();

let MODELS: Readonly<Record<string, ImageModelDefinition>> = modelCatalog.MODELS;
let LORAS: Readonly<Record<string, ImageLoraDefinition>> = modelCatalog.LORAS;
let KREA_STYLE_LORAS: Readonly<Record<string, { file: string; trigger: string }>> = modelCatalog.KREA_STYLE_LORAS;
let CHARACTERS: Readonly<Record<string, { id: string; label: string; loraId: string }>> = modelCatalog.CHARACTERS;

let HIRES_SAMPLER = generationContract.HIRES_SAMPLER;
let HIRES_SCHEDULER = generationContract.HIRES_SCHEDULER;

let publicJob = (require('./job-state') as typeof import('./job-state')).publicJob;

function createAnimaService<Input extends ImageJobInput = ImageJobInput>(config: ImageGenerationConfig, options?: ImageServiceOptions<Input>) {
  options = options || {};
  let buildWorkflowForJob = options.buildWorkflow || buildWorkflow;
  let outputPrefix = options.outputPrefix || OUTPUT_FILENAME_PREFIX;
  let outputNodeId = options.outputNodeId || OUTPUT_NODE_ID;
  let mediaNamespace = options.mediaNamespace || 'anima';
  let engine = options.engine || 'anima';
  let provider = options.provider || 'comfy';
  let routeBase = options.routeBase || '/api/anima';
  let loraRoot = options.loraRoot || path.join(config.AI_WORKSPACE_ROOT || path.resolve(config.ROOT_DIR, '..', 'AI'), 'ComfyUI', 'models', 'loras');
  let validateResources = options.validateResources || function (input: Input) { requiredResources(config, input, loraRoot); };
  let jobTtlMs = Number(options.jobTtlMs) > 0 ? Number(options.jobTtlMs) : JOB_TTL_MS;
  let inputImageTtlMs = Number(options.inputImageTtlMs) > 0 ? Number(options.inputImageTtlMs) : INPUT_IMAGE_TTL_MS;
  let cancelPollIntervalMs = Number(options.cancelPollIntervalMs) > 0
    ? Number(options.cancelPollIntervalMs) : CANCEL_POLL_INTERVAL_MS;
  let cancelTimeoutMs = Number(options.cancelTimeoutMs) > 0
    ? Number(options.cancelTimeoutMs) : CANCEL_TIMEOUT_MS;
  // 任务注册表骨架（Map + pendingCount + closed 标志）收口到 server/job-runner.js；
  // poll/cancel 状态机保持本路由引擎专属实现。
  let registry = jobRunner.createJobRegistry<ImageJob<Input>>();
  let jobs = registry.jobs;
  const submissions = new Set<Promise<void>>();
  let runtimeRoot = config.RUNTIME && config.RUNTIME.state ? path.dirname(config.RUNTIME.state) : path.join(config.ROOT_DIR, 'runtime');
  let snapshots = jobSnapshot.createJobSnapshotStore(path.join(runtimeRoot, 'jobs', mediaNamespace));
  let lostJobs = snapshots.drain();
  function cleanupOwnedInputs() {
    let activeInputs: Set<string> = new Set();
    jobs.forEach(function (job) {
      if (job.input.initImage) activeInputs.add(job.input.initImage);
      if (job.input.maskImage) activeInputs.add(job.input.maskImage);
    });
    cleanupImageInputs(config, activeInputs, inputImageTtlMs);
  }
  // 2026-08-16 审计（方案 A）：client_id 持久化复用 + 启动清理重启遗留的 ComfyUI
  // 任务（立即 + 30s 后各试一次，重试幂等无害）；2026-08-21 收口到 comfy-client。
  let clientId = comfyClient.clientIdFor(config, engine);
  if (!options.durableTasks) comfyClient.sweepOrphanPromptsAfterStart(config, clientId, 'anima');
  let progressMonitor = comfyProgress.createComfyProgressMonitor(config, clientId);
  // 显存保护：按当前 ComfyUI 实例记录最近一次提交的底模家族；Anima ⇄ Krea2
  // 切换时先让 ComfyUI 卸载上一家族模型，避免两个大模型同时驻留显存。
  // 首次提交也释放一次，兜底网关重启后 ComfyUI 里仍驻留的旧模型。
  let comfyHostKey = String(config.COMFY_HOST || 'default');

  if (!options.durableTasks) { cleanupMediaRoot(config, mediaNamespace); cleanupOwnedInputs(); }
  let inputCleanupTimer = setInterval(() => { if (!options?.durableTasks) cleanupOwnedInputs(); }, Math.min(inputImageTtlMs, 5 * 60 * 1000));
  if (typeof inputCleanupTimer.unref === 'function') inputCleanupTimer.unref();

  let pendingCount = registry.pendingCount;

  function schedulePoll(job: ImageJob<Input>, delay?: number) {
    if (registry.isClosed() || job.status === 'cancelled' || job.status === 'cancelling' || job.status === 'succeeded' || job.status === 'failed') return;
    if (job.pollTimer) clearTimeout(job.pollTimer);
    job.pollTimer = setTimeout(function () {
      job.pollTimer = null;
      poll(job);
    }, delay);
  }

  function failJob(job: ImageJob<Input>, error: unknown, fallbackCode?: string | number) {
    if (job.status === 'cancelled' || job.status === 'cancelling') return;
    job.status = 'failed';
    job.finishedAt = Date.now();
    if (job.upstreamId) progressMonitor.unwatch(job.upstreamId);
    job.errorCode = runtimeErrorCode(error) || fallbackCode || 'ANIMA_FAILED';
    job.error = runtimeErrorCode(error) === 'INVALID_RESULT'
      ? '生成结果未通过安全校验'
      : (runtimeErrorMessage(error) || 'Anima 生成失败');
    if (job.pollTimer) { clearTimeout(job.pollTimer); job.pollTimer = null; }
  }

  function queueHasPrompt(items: unknown, promptId: string) {
    return Array.isArray(items) && items.some(function (item) {
      return Array.isArray(item) ? item[1] === promptId : item && errorField(item, 'prompt_id') === promptId;
    });
  }

  async function requestTargetedCancel(job: ImageJob<Input>) {
    if (!job.upstreamId) return;
    try {
      // Current ComfyUI exposes a state-agnostic, prompt-id-scoped cancel API.
      await requestComfyJson(config, 'POST', '/api/jobs/' + encodeURIComponent(job.upstreamId) + '/cancel', null, 10000);
      return;
    } catch (error) {
      let upstreamStatus = Number(errorField(errorField(error, 'detail'), 'upstreamStatus'));
      if (upstreamStatus !== 404 && upstreamStatus !== 405) throw error;
    }

    // Older ComfyUI can safely remove a specific pending prompt. Do not fall
    // back to a potentially global /interrupt implementation for running work.
    let queue = await requestComfyJson<ComfyQueueResponse>(config, 'GET', '/queue', null, 10000);
    let running = queue && (queue.queue_running || queue.running);
    let pending = queue && (queue.queue_pending || queue.pending);
    if (queueHasPrompt(pending, job.upstreamId)) {
      await requestComfyJson(config, 'POST', '/queue', { delete:[job.upstreamId] }, 10000);
      return;
    }
    if (queueHasPrompt(running, job.upstreamId)) {
      throw serviceError(502, 'COMFY_TARGETED_CANCEL_UNAVAILABLE', '当前 ComfyUI 不支持安全的定向运行中取消');
    }
  }

  function finishCancellation(job: ImageJob<Input>) {
    if (job.pollTimer) { clearTimeout(job.pollTimer); job.pollTimer = null; }
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    if (job.upstreamId) progressMonitor.unwatch(job.upstreamId);
    job.error = '任务已取消';
    job.errorCode = 'ANIMA_CANCELLED';
    removeResult(job);
  }

  function failCancellation(job: ImageJob<Input>) {
    if (job.pollTimer) { clearTimeout(job.pollTimer); job.pollTimer = null; }
    job.status = 'failed';
    job.finishedAt = Date.now();
    if (job.upstreamId) progressMonitor.unwatch(job.upstreamId);
    job.error = '无法确认上游任务已安全取消';
    job.errorCode = 'ANIMA_CANCEL_FAILED';
    removeResult(job);
  }

  async function confirmCancellation(job: ImageJob<Input>) {
    if (registry.isClosed() || job.status !== 'cancelling' || !job.upstreamId) return;
    // 2026-08-16 审计：cancel() 的确认定时器与 poll() 的 cancelling 分支可能并发
    // 进入本函数——两路同时推进 cancelChecks 会把「两次观测」误算成四次（提前
    // 判定取消完成），或双跑完成路径。加 in-flight 串行锁，多余进入直接返回。
    if (job.cancelPolling) return;
    job.cancelPolling = true;
    try {
      if (Date.now() > job.cancelDeadline) {
        failCancellation(job);
        return;
      }
      try {
        let queue = await requestComfyJson<ComfyQueueResponse>(config, 'GET', '/queue', null, 10000);
        let running = queue && (queue.queue_running || queue.running);
        let pending = queue && (queue.queue_pending || queue.pending);
        if (queueHasPrompt(running, job.upstreamId) || queueHasPrompt(pending, job.upstreamId)) {
          job.cancelChecks = 0;
          scheduleCancelPoll(job);
          return;
        }
        let history = await requestComfyJson<ComfyHistory>(config, 'GET', '/history/' + encodeURIComponent(job.upstreamId), null, 10000);
        let entry = history && history[job.upstreamId];
        let status = entry && entry.status && entry.status.status_str;
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
      } catch (error) {
        job.cancelFailures += 1;
        scheduleCancelPoll(job);
      }
    } finally {
      job.cancelPolling = false;
    }
  }

  function scheduleCancelPoll(job: ImageJob<Input>) {
    if (registry.isClosed() || job.status !== 'cancelling') return;
    if (job.pollTimer) clearTimeout(job.pollTimer);
    job.pollTimer = setTimeout(function () {
      job.pollTimer = null;
      void confirmCancellation(job);
    }, cancelPollIntervalMs);
  }

  async function poll(job: ImageJob<Input>) {
    if (registry.isClosed() || jobRunner.isTerminalStatus(job.status) || !job.upstreamId) return;
    if (job.status === 'cancelling') {
      await confirmCancellation(job);
      return;
    }
    if (Date.now() > job.deadline) {
      void requestTargetedCancel(job).catch(function () {});
      failJob(job, serviceError(504, 'ANIMA_TIMEOUT', 'Anima 生成超时'), 'ANIMA_TIMEOUT');
      return;
    }
    try {
      let history = await requestComfyJson<ComfyHistory>(config, 'GET', '/history/' + encodeURIComponent(job.upstreamId), null, 10000);
      if (registry.isClosed() || job.status !== 'running') return;
      job.pollFailures = 0;
      let entry = history && history[job.upstreamId];
      if (!entry) {
        schedulePoll(job, POLL_INTERVAL_MS);
        return;
      }
      let status = entry.status && entry.status.status_str;
       job.progress = null;
       job.progressText = status === 'success' ? '生成完成' : status === 'error' || status === 'failed' ? 'ComfyUI 执行失败' : 'ComfyUI 正在推理…';
      if (status === 'error' || status === 'failed') {
        let messages = entry.status && entry.status.messages;
        let executionError = Array.isArray(messages) && messages.find(function (item) { return item[0] === 'execution_error'; });
        let detail = executionError && executionError[1];
        let reason = detail ? String(detail.exception_type || '') + ': ' + String(detail.exception_message || '').slice(0, 1500) : 'ComfyUI 执行失败';
        failJob(job, serviceError(502, 'COMFY_EXECUTION_FAILED', reason), 'COMFY_EXECUTION_FAILED');
        return;
      }
      if (status !== 'success') {
        schedulePoll(job, POLL_INTERVAL_MS);
        return;
      }
       let image = null;
       let output = entry.outputs && entry.outputs[outputNodeId];
       let images = output && output.images;
       if (Array.isArray(images) && images.length) image = images[0];
       if (!image) {
         failJob(job, serviceError(502, 'COMFY_NO_IMAGE', 'ComfyUI 未返回图片'), 'COMFY_NO_IMAGE');
        return;
      }
       job.result = await materializeResult(config, job, image, { outputPrefix:job.input.family === 'krea2' ? 'creative_app' : outputPrefix, mediaNamespace:mediaNamespace });
       if (job.taskHooks) await job.taskHooks.collect([{ file: job.result.path, mime: job.result.mime }]);
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
      if (job.pollTimer) { clearTimeout(job.pollTimer); job.pollTimer = null; }
    } catch (error) {
      if (job.status === 'cancelled') return;
      if (error && ['INVALID_RESULT', 'COMFY_NO_IMAGE', 'RESULT_SAVE_FAILED'].includes(String(runtimeErrorCode(error)))) {
        failJob(job, error, runtimeErrorCode(error));
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

  async function submitUpstream(job: ImageJob<Input>, hooks?: import('../../server/tasks/provider').TaskExecutionHooks) {
    job.taskHooks = hooks;
    if (registry.isClosed() || job.status !== 'queued') throw serviceError(409, 'JOB_NOT_QUEUED', '任务已结束或服务已关闭');
    validateResources(job.input);
    // WAI/generation 复用本服务时 input 没有 family，用 engine 兜底为 'sd'，
    // 这样 Anima/Krea2/SD 三条 Comfy 链路之间切换也能正确触发卸载。
    let family = job.input.family || engine;
    // 显存保护：家族切换（或首次提交）时先让 ComfyUI 卸载已加载模型。
    // unloadComfyModels 内部静默降级，不阻塞主出图链路。
    let lastLoadedFamily = lastFamilyByComfyHost.get(comfyHostKey);
    if (lastLoadedFamily === undefined || lastLoadedFamily !== family) {
      await unloadComfyModels(config);
    }
    if (registry.isClosed() || job.status !== 'queued') return;
    if (hooks) await hooks.submitting('comfy', '');
    let response = await requestComfyJson<PromptSubmission>(config, 'POST', '/prompt', {
      prompt:buildWorkflowForJob(job.input),
      client_id:clientId
    }, 20000);
    let promptId = response && response.prompt_id;
    if (typeof promptId !== 'string' || !promptId || promptId.length > 200) {
      throw serviceError(502, 'COMFY_INVALID_RESPONSE', 'ComfyUI 未返回有效任务 ID');
    }
    job.upstreamId = promptId;
    if (hooks) await hooks.observed(promptId, { ...job.metadata, gatewayJobId: job.id });
    lastFamilyByComfyHost.set(comfyHostKey, family);
    if (registry.isClosed() && hooks) return;
    if (registry.isClosed() || ['cancelling', 'cancelled'].includes(job.status)) {
      void requestTargetedCancel(job).catch(function () {});
      return;
    }
    job.status = 'running';
    job.progressText = '已提交，等待 ComfyUI 执行…';
    progressMonitor.watch(promptId, job);
    schedulePoll(job, 0);
  }

  function submit(job: ImageJob<Input>, hooks?: import('../../server/tasks/provider').TaskExecutionHooks) {
    const work = submitUpstream(job, hooks); submissions.add(work);
    void work.then(() => submissions.delete(work), () => submissions.delete(work));
    return work;
  }

  function create(input: Input, owner: string) {
    if (registry.isClosed()) throw serviceError(503, 'SERVICE_CLOSED', '生成服务已关闭');
    if (pendingCount() >= MAX_PENDING) throw serviceError(429, 'ANIMA_QUEUE_FULL', 'Anima 队列已满，请稍后再试');
    let id = crypto.randomBytes(18).toString('hex');
    let createdAt = Date.now();
    // 2026-08-20：Anima hires 接入本地 ESRGAN 真超分（Remacri）。buildWorkflow 是纯函数
    // 无法探测模型文件，这里在入队前探测并注入；只对 anima family（非 krea2）hires 生效，
    // 未安装模型时保持原 latent bicubic 回退；'Latent' 放大器显式跳过像素超分（2026-08-25 可选）。
    if (input.hiresFix && input.family !== 'krea2' && !input.superResModel && input.hiresUpscaler !== 'Latent') {
      let localSuperRes = superres.availableSuperRes(config);
      if (localSuperRes) input.superResModel = localSuperRes;
    }
    let frozenInput = Object.freeze(Object.assign({}, input));
    let metadataLoras = frozenInput.loras
      ? Object.freeze(frozenInput.loras.map(function (lora) { return Object.freeze({ id:lora.id, strength:lora.strength }); }))
      : Object.freeze(frozenInput.loraId ? [Object.freeze({ id:frozenInput.loraId, strength:frozenInput.loraStrength })] : []);
    let job: ImageJob<Input> = {
      id:id,
      owner:owner,
      provider:provider,
      input:frozenInput,
      metadata:Object.freeze({
         engine:frozenInput.family || engine, id:id, prompt:frozenInput.prompt, negative:frozenInput.negative,
        profileId:frozenInput.profileId || '', modelId:frozenInput.modelId, loraId:frozenInput.loraId,
          loras:metadataLoras, loraStrength:frozenInput.loraStrength, styleLoraId:frozenInput.styleLoraId || null, width:frozenInput.width, height:frozenInput.height,
         hiresFix:Boolean(frozenInput.hiresFix), hiresScale:frozenInput.hiresScale, hiresUpscaler:frozenInput.superResModel ? 'Remacri' : frozenInput.hiresUpscaler,
         hiresSteps:frozenInput.hiresSteps, denoisingStrength:frozenInput.denoisingStrength, faceDetailer:Boolean(frozenInput.faceDetailer),
        steps:frozenInput.steps, cfg:frozenInput.cfg, sampler:frozenInput.sampler || 'res_multistep', scheduler:frozenInput.scheduler || 'simple',
        hiresSampler:frozenInput.family !== 'krea2' && Boolean(frozenInput.hiresFix) && !frozenInput.superResModel ? HIRES_SAMPLER : null,
        hiresScheduler:frozenInput.family !== 'krea2' && Boolean(frozenInput.hiresFix) && !frozenInput.superResModel ? HIRES_SCHEDULER : null,
        teaCache:Boolean(frozenInput.teaCache), teaCacheThresh:frozenInput.teaCacheThresh,
        seed:frozenInput.seed, character:frozenInput.character || null, preview:Boolean(LORAS[String(frozenInput.loraId)] && LORAS[String(frozenInput.loraId)].preview), createdAt:createdAt, resultUrl:null,
        provider:provider
      }),
      status:'queued',
      createdAt:createdAt,
      deadline:createdAt + JOB_TIMEOUT_MS,
      upstreamId:'',
      result:null,
      resultConsumed:false,
      error:null,
      errorCode:null,
      pollTimer:null,
      gcTimer:null,
      pollFailures:0,
       progress:null,
       progressText:'等待提交到 ComfyUI…',
       currentNode:null,
      cancelFailures:0,
      cancelChecks:0,
      cancelDeadline:0,
      cancelPolling:false
    };
    jobs.set(job.id, job);
    snapshots.save(job);
    function collect() {
      let current = jobs.get(job.id);
      if (current !== job) return;
      if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') removeJob(job);
      else job.gcTimer = setTimeout(collect, jobTtlMs).unref();
    }
    job.gcTimer = setTimeout(collect, jobTtlMs).unref();
    return job;
  }

  function get(id: unknown, owner: string) {
    let job = jobs.get(String(id || ''));
    if (!job || job.owner !== owner) return null;
    return job;
  }

  function getLost(id: unknown, owner: string) {
    let key = String(id || '');
    return lostJobs.find(function (job) { return job.id === key && job.owner === owner; }) || null;
  }

  function removeResult(job: ImageJob<Input>) {
    if (job.result && job.result.path) {
      try { fs.unlinkSync(job.result.path); } catch (error) {}
    }
    job.result = null;
    job.resultConsumed = true;
  }

  function removeJob(job: ImageJob<Input>) {
    if (job.upstreamId) progressMonitor.unwatch(job.upstreamId);
    if (job.pollTimer) { clearTimeout(job.pollTimer); job.pollTimer = null; }
    if (job.gcTimer) { clearTimeout(job.gcTimer); job.gcTimer = null; }
    removeResult(job);
    jobs.delete(job.id);
    snapshots.remove(job.id);
    cleanupOwnedInputs();
  }

  function consumeResult(job: ImageJob<Input>) {
    if (!job.result || job.resultConsumed) return;
    removeResult(job);
  }

  async function cancel(job: ImageJob<Input>) {
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
      } catch (error) {
        job.cancelFailures += 1;
      }
      scheduleCancelPoll(job);
    } else if (job.status === 'cancelling') {
      scheduleCancelPoll(job);
    } else if (job.status === 'succeeded') {
      removeResult(job);
      job.status = 'cancelled';
      job.error = '任务已删除';
      job.errorCode = 'ANIMA_CANCELLED';
    }
    return job;
  }

  function status() {
    let modelRootPath = modelRoot(config);
    function available(model: { family: string; file: string; }) {
      let encoder = model.family === 'krea2' ? 'qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors' : 'qwen_3_06b_base.safetensors';
       return resourceExists(modelRootPath, 'diffusion_models', model.file)
         && resourceExists(modelRootPath, 'text_encoders', encoder)
         && resourceExists(modelRootPath, 'vae', 'qwen_image_vae.safetensors');
    }
    return {
      online:false,
        models:Object.keys(MODELS).map(function (id) { let model = MODELS[id]; return { id:id, label:model.label, family:model.family, profileId:model.profileId, available:available(model), defaults:{ steps:model.steps, cfg:model.cfg, sampler:model.sampler, scheduler:model.scheduler }, sizes:model.sizes, capabilities:{ negative:model.family !== 'krea2', lora:model.family === 'anima', noLora:model.family === 'krea2' || model.noLora === true, characterIdentity:model.family === 'anima', experimental:model.family === 'krea2' || model.noLora === true } }; }),
      loras:Object.keys(LORAS).map(function (id) {
        let lora = LORAS[id];
        return { id:id, name:lora.name, character:lora.character, preview:Boolean(lora.preview), validation:lora.validation || 'production', available:resourceExists(loraRoot, '', lora.file) };
      }),
      styleLoras:Object.keys(KREA_STYLE_LORAS).map(function (id) { let style = KREA_STYLE_LORAS[id]; return { id:id, trigger:style.trigger, recommendedStrength:1, available:resourceExists(loraRoot, '', style.file) }; }),
      characters:Object.keys(CHARACTERS).map(function (id) { return CHARACTERS[id]; }),
      // 2026-08-20：本地 ESRGAN 真超分可用性（Anima hires 默认自动走 Remacri）。
      hires:{ superResModel:superres.availableSuperRes(config) || null },
      pending:pendingCount(),
      maxPending:MAX_PENDING
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
      if (job.pollTimer) clearTimeout(job.pollTimer);
      job.pollTimer = null;
      if (job.gcTimer) clearTimeout(job.gcTimer);
      job.gcTimer = null;
      if (!job.taskHooks && (job.status === 'queued' || job.status === 'running' || job.status === 'cancelling')) {
        void requestTargetedCancel(job).catch(function () {});
      }
      if (!job.taskHooks) removeResult(job);
      snapshots.remove(job.id);
    });
    jobs.clear();
    if (!options?.durableTasks) { cleanupMediaRoot(config, mediaNamespace); cleanupOwnedInputs(); }
  }

  return {
    create:create,
    submit:submit,
    drainSubmissions: async () => { await Promise.allSettled([...submissions]); },
    get:get,
    getLost:getLost,
    cancel:cancel,
    consumeResult:consumeResult,
      publicJob:function (job: ImageJob<Input>) { return publicJob(job, job.input && job.input.family === 'krea2' ? '/api/creative' : routeBase); },
    probe:probe,
    status:status,
    close:close,
      constants:{ MODELS:MODELS, LORAS:LORAS, KREA_STYLE_LORAS:KREA_STYLE_LORAS, MAX_PENDING:MAX_PENDING, JOB_TTL_MS:jobTtlMs, CANCEL_TIMEOUT_MS:cancelTimeoutMs }
  };
}

export = {
  createAnimaService,
  publicJob,
  MODELS,
  LORAS,
  KREA_STYLE_LORAS,
  CHARACTERS,
  HIRES_SAMPLER,
  HIRES_SCHEDULER,
};
