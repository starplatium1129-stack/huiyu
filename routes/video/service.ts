import { errorCode, errorMessage, errorStatus } from '../../scripts/lib/runtime-errors';
import type { VideoConfig, VideoJob, VideoServiceDependencies, VideoInput } from './types';
import crypto = require('crypto');
import fs = require('fs');
import path = require('path');
import comfyClient = require('../../server/comfy-client');
import upstreamHealth = require('../../server/upstream-health');
import jobRunner = require('../../server/job-runner');
import jobSnapshot = require('../../server/job-snapshot');
import constants = require('./constants');
import errors = require('./errors');
import media = require('./media');
import comfy = require('./comfy');
import engine = require('./engine');
const { serviceError } = errors;
const { MAX_PENDING, JOB_TTL_MS, POLL_INTERVAL_MS, OUTPUT_NODE_ID, MODEL_BY_ID } = constants;
const { estimateH3Seconds, buildWorkflow } = engine;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function outputReference(entry: unknown) {
  const output = record(record(record(entry).outputs)[OUTPUT_NODE_ID]);
  const values = output.images || output.videos;
  return Array.isArray(values) && values.length ? values[0] as unknown : null;
}

function createVideoService(config: VideoConfig, dependencies: VideoServiceDependencies = {}) {
  dependencies = dependencies || {};
  // 任务注册表骨架（Map + pendingCount + closed 标志）收口到 server/job-runner.js；
  // poll/cancel 状态机保持本路由引擎专属实现（分镜 batches 是另一套形状，不套用）。
  let registry = jobRunner.createJobRegistry<VideoJob>();
  let jobs = registry.jobs;
  let clientId = comfyClient.clientIdFor(config, 'video');
  // 2026-08-16 审计（方案 A）：client_id 持久化复用 + 启动清理重启遗留的 ComfyUI
  // 任务（立即 + 30s 后各试一次，重试幂等无害）；2026-08-21 收口到 comfy-client。
  comfyClient.sweepOrphanPromptsAfterStart(config, clientId, 'video');
  // 任务快照：save/remove 挂在创建与 removeJob 两端。优雅关停会逐一 removeJob
  // 天然清空快照；只有崩溃/强杀才留痕 —— drain() 启动时读走并以 tombstone 常驻，
  // 路由层据此把「未知 id」升级为 410 JOB_LOST 的明确提示。
  let snapshots = jobSnapshot.createJobSnapshotStore(
    path.join(config.RUNTIME_ROOT || path.join(config.ROOT_DIR, 'runtime'), 'jobs', 'video'));
  let lostJobs = snapshots.drain();
  // JOB_TIMEOUT_MS 已被动态超时取代（deadline = 预估时长 × 3，下限 10 分钟），
  // 见 create() 内注释；此处不再保留失效的固定超时依赖。
  let jobTtlMs = dependencies.jobTtlMs || JOB_TTL_MS;
  let pollIntervalMs = dependencies.pollIntervalMs || POLL_INTERVAL_MS;

  media.cleanupMediaRoot(config);
  media.cleanupImageInput(config);

  let pendingCount = registry.pendingCount;

  function publicJob(job: VideoJob) {
    // 进度由时间外推（elapsed/预估），不再用固定 0.12 假值误导等待；
    // 上限 90% 保留采样完成后的编码/落盘余量，succeeded 才归 1。
    let elapsedSeconds = Math.round((Date.now() - job.createdAt) / 1000);
    let progress = job.status === 'succeeded' ? 1
      : job.status === 'running'
        ? Math.min(0.9, Math.max(0.02, elapsedSeconds / job.estimatedSeconds))
        : 0;
    return {
      id:job.id,
      status:job.status,
      provider:'comfy',
      progress:progress,
      estimatedSeconds:job.estimatedSeconds,
      elapsedSeconds:elapsedSeconds,
      modelId:job.input.modelId,
      prompt:job.input.originalPrompt,
      width:job.input.width,
      height:job.input.height,
      duration:job.input.duration,
      fps:job.input.fps,
      seed:job.input.seed,
      createdAt:job.createdAt,
      resultAvailable:Boolean(job.result),
      resultUrl:job.result ? '/api/video/jobs/' + encodeURIComponent(job.id) + '/result' : null,
      error:job.error || null,
      code:job.errorCode || null,
    };
  }

  function removeJob(job: VideoJob) {
    if (job.pollTimer) clearTimeout(job.pollTimer);
    if (job.gcTimer) clearTimeout(job.gcTimer);
    if (job.result && job.result.path) {
      try { fs.unlinkSync(job.result.path); } catch (error) {}
    }
    if (job.input && job.input.image) media.removeInputImage(config, job.input.image);
    if (job.input && job.input.lastFrame) media.removeInputImage(config, job.input.lastFrame);
    jobs.delete(job.id);
    snapshots.remove(job.id);
  }

  function schedulePoll(job: VideoJob, delay: number|undefined) {
    if (registry.isClosed() || job.status !== 'running') return;
    if (job.pollTimer) clearTimeout(job.pollTimer);
    job.pollTimer = setTimeout(function () {
      job.pollTimer = null;
      void poll(job);
    }, delay);
  }

  function failJob(job: VideoJob, error: unknown, fallbackCode?: string|undefined) {
    if (job.status === 'cancelled') return;
    job.status = 'failed';
    job.errorCode = errorCode(error) || fallbackCode || 'VIDEO_FAILED';
    job.error = errorCode(error) === 'INVALID_RESULT'
      ? '视频结果未通过安全校验'
      : ((errorStatus(error) ?? 0) >= 500 ? '视频生成上游暂不可用' : errorMessage(error) || '视频生成失败');
    if (job.pollTimer) clearTimeout(job.pollTimer);
    job.pollTimer = null;
  }

  async function poll(job: VideoJob) {
    if (registry.isClosed() || job.status !== 'running' || !job.upstreamId) return;
    if (Date.now() > job.deadline) {
      failJob(job, serviceError(504, 'VIDEO_TIMEOUT',
        '视频任务疑似卡死（超过预估时长 ' + job.estimatedSeconds + ' 秒的 3 倍仍未完成），请检查 ComfyUI 状态后重试'),
        'VIDEO_TIMEOUT');
      return;
    }
    try {
      let history: unknown = await comfy.requestComfyJson(
        config,
        'GET',
        '/history/' + encodeURIComponent(job.upstreamId),
        null,
        10000
      );
      let entry = record(history)[job.upstreamId];
      if (!entry) {
        schedulePoll(job, pollIntervalMs);
        return;
      }
      let status = record(record(entry).status).status_str;
      if (status === 'error' || status === 'failed') {
        failJob(job, serviceError(502, 'COMFY_EXECUTION_FAILED', 'ComfyUI 执行视频工作流失败'));
        return;
      }
      if (status !== 'success') {
        schedulePoll(job, pollIntervalMs);
        return;
      }
      let output = outputReference(entry);
      if (!output) {
        failJob(job, serviceError(502, 'COMFY_NO_VIDEO', 'ComfyUI 未返回视频'));
        return;
      }
      job.result = await comfy.materializeResult(config, job, output);
      // 2026-08-16 审计：materialize 期间用户可能已取消（cancel 与 poll 竞态）——
      // 材料化完成不代表任务仍有效；状态已离开 running 时丢弃结果文件，保持取消态，
      // 避免「取消后任务静默复活为 succeeded」并残留下载文件。
      if (job.status !== 'running' || registry.isClosed() || !jobs.has(job.id)) {
        if (job.result && job.result.path) {
          try { fs.unlinkSync(job.result.path); } catch (error) {}
        }
        job.result = null;
        return;
      }
      job.status = 'succeeded';
      job.error = null;
      job.errorCode = null;
    } catch (error: unknown) {
      job.pollFailures += 1;
      if ((errorCode(error) === 'INVALID_RESULT' || errorCode(error) === 'COMFY_NO_VIDEO')) {
        failJob(job, error);
        return;
      }
      if (Date.now() > job.deadline || job.pollFailures >= 60) {
        failJob(job, error, 'VIDEO_POLL_FAILED');
        return;
      }
      schedulePoll(job, Math.min(5000, pollIntervalMs * Math.max(1, job.pollFailures)));
    }
  }

  async function submit(job: VideoJob) {
    let availability = media.modelAvailability(config, MODEL_BY_ID[job.input.modelId]);
    if (!availability.available) {
      throw serviceError(503, 'VIDEO_MODEL_UNAVAILABLE', '视频模型文件尚未安装', {
        missing:availability.missing,
      });
    }
    let response: unknown = await comfy.requestComfyJson(config, 'POST', '/prompt', {
      prompt:buildWorkflow(job.input),
      client_id:clientId,
    }, 20000);
    let promptId = record(response).prompt_id;
    if (typeof promptId !== 'string' || !promptId || promptId.length > 200) {
      throw serviceError(502, 'COMFY_INVALID_RESPONSE', 'ComfyUI 未返回有效任务 ID');
    }
    job.upstreamId = promptId;
    // 提交期间被取消（cancel 与 submit 竞态）：不能把已经取消的任务又翻回
    // running——否则用户按了取消，任务却复活跑完全程占 45 分钟 GPU。
    // 这里直接把刚创建的上游任务一并取消，保持取消语义。
    if (job.status !== 'queued' || registry.isClosed() || !jobs.has(job.id)) {
      try {
        await comfy.requestComfyJson(
          config,
          'POST',
          '/api/jobs/' + encodeURIComponent(promptId) + '/cancel',
          null,
          10000
        );
      } catch (error) {}
      return;
    }
    job.status = 'running';
    schedulePoll(job, 0);
  }

  function create(input: VideoInput, owner: string, opts?: { ttlMs?: number }) {
    if (pendingCount() >= MAX_PENDING) {
      throw serviceError(429, 'VIDEO_QUEUE_FULL', '视频队列已满，请等待当前任务完成');
    }
    // 分镜批量任务延长 TTL：整批生成可能数十分钟，首镜结果需留到批处理完再取。
    let ttlMs = opts && opts.ttlMs || jobTtlMs;
    let id = crypto.randomBytes(18).toString('hex');
    let createdAt = Date.now();
    // 动态超时：预估时长 × 3（下限 10 分钟）替代固定 45 分钟——卡死时
    // 不用再硬等 45 分钟才失败（2026-08-17 可观测性审计）。
    let estimatedSeconds = estimateH3Seconds(input);
    let job: VideoJob = {
      id:id,
      owner:owner,
      input:input,
      status:'queued',
      createdAt:createdAt,
      estimatedSeconds:estimatedSeconds,
      deadline:createdAt + Math.max(10 * 60 * 1000, estimatedSeconds * 3 * 1000),
      upstreamId:'',
      result:null,
      error:null,
      errorCode:null,
      pollTimer:null,
      gcTimer:null,
      pollFailures:0,
    };
    jobs.set(id, job);
    snapshots.save(job);
    job.gcTimer = setTimeout(function () { removeJob(job); }, ttlMs).unref();
    return job;
  }

  function get(id: unknown, owner: string) {
    let job = jobs.get(String(id || ''));
    return job && job.owner === owner ? job : null;
  }

  /** 重启遗留任务的 tombstone 查询（owner 对齐内存注册表同一判定） */
  function getLost(id: unknown, owner: string) {
    let key = String(id || '');
    for (let i = 0; i < lostJobs.length; i++) {
      if (lostJobs[i].id === key && lostJobs[i].owner === owner) return lostJobs[i];
    }
    return null;
  }

  async function cancel(job: VideoJob) {
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return job;
    job.status = 'cancelling';
    if (job.pollTimer) clearTimeout(job.pollTimer);
    job.pollTimer = null;
    if (job.upstreamId) {
      try {
        await comfy.requestComfyJson(
          config,
          'POST',
          '/api/jobs/' + encodeURIComponent(job.upstreamId) + '/cancel',
          null,
          10000
        );
      } catch (error) {
        job.status = 'failed';
        job.error = '无法安全取消上游视频任务';
        job.errorCode = 'VIDEO_CANCEL_FAILED';
        return job;
      }
    }
    job.status = 'cancelled';
    job.error = '任务已取消';
    job.errorCode = 'VIDEO_CANCELLED';
    return job;
  }

  async function probe() {
    // P3 收口：探活统一走 server/upstream-health（与控制面板同一份判定口径）
    return upstreamHealth.pingComfy(config.COMFY_HOST, 2500);
  }

  function close() {
    registry.close();
    jobs.forEach(removeJob);
    media.cleanupMediaRoot(config);
  }

  return {
    create:create,
    submit:submit,
    get:get,
    getLost:getLost,
    cancel:cancel,
    publicJob:publicJob,
    pendingCount:pendingCount,
    probe:probe,
    close:close,
  };
}


export = { createVideoService };
