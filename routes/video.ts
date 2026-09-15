import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage, errorStatus as runtimeErrorStatus } from '../scripts/lib/runtime-errors';
'use strict';

import { Request } from 'express-serve-static-core';
import { ParsedQs } from 'qs';

let { streamVideo }: typeof import('./video-stream') = require('./video-stream');

/**
 * routes/video.js —— 视频生成路由编排层。
 *
 * 2026-08-22 模块化拆分（原 2200+ 行单文件 → 职责单一子模块）：
 * - video/constants.js   纯数据表：上限、受控前缀、TTL、画质/时长目录
 * - video/errors.js      serviceError 工厂与基础守卫
 * - video/prose.js       H3 提示词散文派生（对白语言/冲突守卫/soundscape/music）
 * - video/media.js       媒体资产与文件系统助手（受控路径/魔数/尺寸/模型可用性）
 * - video/comfy.js       ComfyUI HTTP 客户端与结果流式物化
 * - video/workflows.js   工作流图构建器（H3 原生 / H3 T8 双时钟 / Wan）
 * - video/validation.js  输入校验归一化与提示词组装（单任务 + 分镜批量）
 * - video/batch.js       分镜批量服务（逐镜排队/尾帧衔接/拼接成片）
 *
 * 本文件只保留有状态编排：T8 探测缓存（模块级单例）、任务服务工厂、
 * HTTP 路由装配与结果流式下发。对外导出面与拆分前完全一致。
 */

let crypto: typeof import('crypto') = require('crypto');
let express: typeof import('express') = require('express');
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let security: typeof import('../server/security') = require('../server/security');
let envelope: typeof import('../server/http-envelope') = require('../server/http-envelope');
let comfyClient: typeof import('../server/comfy-client') = require('../server/comfy-client');
// P3 收口：ComfyUI 探活统一走 server/upstream-health
let upstreamHealth: typeof import('../server/upstream-health') = require('../server/upstream-health');
// 2026-08-21 收口：模型目录数据表外移；任务注册表骨架统一
let jobRunner: typeof import('../server/job-runner') = require('../server/job-runner');
// 2026-08-27 P1 审计：长任务快照落盘（崩溃/强杀后的 JOB_LOST 断崖治理）
let jobSnapshot: typeof import('../server/job-snapshot') = require('../server/job-snapshot');

let constants: typeof import('./video/constants') = require('./video/constants');
let errors: typeof import('./video/errors') = require('./video/errors');
let media: typeof import('./video/media') = require('./video/media');
let comfy: typeof import('./video/comfy') = require('./video/comfy');
let workflows: typeof import('./video/workflows') = require('./video/workflows');
let validation: typeof import('./video/validation') = require('./video/validation');
let batchFactory: typeof import('./video/batch') = require('./video/batch');
let storyboard: typeof import('./video/storyboard') = require('./video/storyboard');

let serviceError = errors.serviceError;
let MAX_BODY = constants.MAX_BODY;
let MAX_PENDING = constants.MAX_PENDING;
let JOB_TTL_MS = constants.JOB_TTL_MS;
let POLL_INTERVAL_MS = constants.POLL_INTERVAL_MS;
let MAX_BATCH_BODY = constants.MAX_BATCH_BODY;
let MAX_IMAGE_BYTES = constants.MAX_IMAGE_BYTES;
let IMAGE_INPUT_PREFIX = constants.IMAGE_INPUT_PREFIX;
let IMAGE_REF_PREFIX = constants.IMAGE_REF_PREFIX;
let OUTPUT_NODE_ID = constants.OUTPUT_NODE_ID;
let MODEL_CATALOG = constants.MODEL_CATALOG;
let MODEL_BY_ID = constants.MODEL_BY_ID;
let QUALITIES = constants.QUALITIES;

let validateInput = validation.validateInput;
let validateBatchInput = validation.validateBatchInput;
let createBatchService = batchFactory.createBatchService;
let validateVideoReference = media.validateVideoReference;

// T8 双时钟采样路径可用性（2026-08-16）：MiniMaxH3DualClockSamplerT8 +
// MiniMaxH3AudioConditioningT8 + MiniMaxH3AVDecodeT8 + 4 步加速 LoRA。
// 真机基准（4070 Ti SUPER）：standard 5s 228s → 4 步 90s / 8 步 110s（≈2.5×），
// 画质抽查可接受；无 T8 节点时回退原生采样器路径（8 步 LoRA）。
// 模块默认 false：单元/网关测试（mock 无 T8）走原生路径不受影响；
// 生产由 createVideoRouter 启动时探测真实 ComfyUI 后置 true。
// 2026-08-17 修复：探测结果此前「启动时一次性、永不刷新」——3123 启动时
// ComfyUI 未就绪/被卡死任务占满会导致探测失败并永久缓存 false，此后所有
// 视频任务错走原生慢路径（15s 503s vs T8 272s）。现在提交任务前带 TTL 重探。
let t8Available = false;
let t8ProbeAt = 0;
let T8_PROBE_TTL_MS = 60 * 1000;
function setT8Available(value: boolean) {
  t8Available = Boolean(value);
}
async function probeT8Nodes(config: unknown) {
  try {
    // object_info 返回 { <nodeName>: {...} }；必须确认节点键真实存在
    // （mock 对任意路径返回 200 {} 时不得误判为可用）。
    let data: any = await comfy.requestComfyJson(config, 'GET', '/object_info/MiniMaxH3DualClockSamplerT8', null, 10000);
    setT8Available(Boolean(data && data.MiniMaxH3DualClockSamplerT8));
    if (t8Available) {
      console.log('[video] T8 双时钟采样路径可用（4 步加速 LoRA + DualClock）');
    } else {
      console.warn('[video] T8 双时钟节点不可用，回退原生采样路径');
    }
  } catch (error) {
    setT8Available(false);
    console.warn('[video] T8 双时钟节点不可用，回退原生采样路径');
  }
}
// 提交前确保探测是最新的：T8 未启用且超过 TTL 时重探一次（ComfyUI 恢复或
// 节点就绪后，第一次提交自动重新发现 T8，不再需要重启网关）。
async function ensureT8Probe(config: unknown) {
  if (t8Available) return;
  if (Date.now() - t8ProbeAt < T8_PROBE_TTL_MS) return;
  t8ProbeAt = Date.now();
  await probeT8Nodes(config);
}

// 视频任务预估时长（秒）：帧数 × 步数 × 每帧每步耗时 + 加载/编码余量。
// 真机校准（4070 Ti SUPER）：T8 双时钟 ≈ 0.125s/帧/步（15s 4 步实测 272s），
// 原生采样 ≈ 0.25s/帧/步（15s 4 步实测 489s，含模型换入）；余量 90s 覆盖
// 模型加载与首帧编码。用于：真实进度外推（替代固定 0.12）、卡死预警
// （elapsed > 预估 × 1.5 提示异常）、动态超时（deadline = 预估 × 3）。
// 依赖本文件的 T8 探测状态，故留在编排层而非 workflows 纯函数模块。
let H3_PER_FRAME_STEP_SECONDS = { t8:0.125, native:0.25 };
let H3_ESTIMATE_MARGIN_SECONDS = 90;
function estimateH3Seconds(input: { frames: number; steps: number; }) {
  let rate = t8Available
    ? H3_PER_FRAME_STEP_SECONDS.t8
    : H3_PER_FRAME_STEP_SECONDS.native;
  return Math.round(input.frames * input.steps * rate) + H3_ESTIMATE_MARGIN_SECONDS;
}

// 工作流分派包装：把当前 T8 探测状态注入纯函数构建器（workflows 模块无状态）。
// 导出同名函数保持测试面不变（setT8Available → buildWorkflow 即时生效）。
function buildWorkflow(input: { modelId: string|number; }) {
  return workflows.buildWorkflow(input, { t8Available:t8Available });
}

function requestOwner(req: any) {
  if (security.isDirectLocalRequest(req)) return 'local';
  let cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)aics_token=([^;]+)/);
  let token = req.headers['x-token'] || cookie && cookie[1] || req.query && req.query.token || '';
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function outputReference(entry: { outputs: { [x: string]: unknown; }; }) {
  let output: any = entry && entry.outputs && entry.outputs[OUTPUT_NODE_ID];
  let values = output && (output.images || output.videos);
  return Array.isArray(values) && values.length ? values[0] : null;
}

function createVideoService(config: any, dependencies: any) {
  dependencies = dependencies || {};
  // 任务注册表骨架（Map + pendingCount + closed 标志）收口到 server/job-runner.js；
  // poll/cancel 状态机保持本路由引擎专属实现（分镜 batches 是另一套形状，不套用）。
  let registry = jobRunner.createJobRegistry();
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

  function publicJob(job: any) {
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

  function removeJob(job: any) {
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

  function schedulePoll(job: { status: string; pollTimer: string|number|NodeJS.Timeout|null|undefined; }, delay: number|undefined) {
    if (registry.isClosed() || job.status !== 'running') return;
    if (job.pollTimer) clearTimeout(job.pollTimer);
    job.pollTimer = setTimeout(function () {
      job.pollTimer = null;
      void poll(job);
    }, delay);
  }

  function failJob(job: any, error: any, fallbackCode?: string|undefined) {
    if (job.status === 'cancelled') return;
    job.status = 'failed';
    job.errorCode = error && error.code || fallbackCode || 'VIDEO_FAILED';
    job.error = error && error.code === 'INVALID_RESULT'
      ? '视频结果未通过安全校验'
      : (error && error.status >= 500 ? '视频生成上游暂不可用' : error && error.message || '视频生成失败');
    if (job.pollTimer) clearTimeout(job.pollTimer);
    job.pollTimer = null;
  }

  async function poll(job: any) {
    if (registry.isClosed() || job.status !== 'running' || !job.upstreamId) return;
    if (Date.now() > job.deadline) {
      failJob(job, serviceError(504, 'VIDEO_TIMEOUT',
        '视频任务疑似卡死（超过预估时长 ' + job.estimatedSeconds + ' 秒的 3 倍仍未完成），请检查 ComfyUI 状态后重试'),
        'VIDEO_TIMEOUT');
      return;
    }
    try {
      let history: any = await comfy.requestComfyJson(
        config,
        'GET',
        '/history/' + encodeURIComponent(job.upstreamId),
        null,
        10000
      );
      let entry = history && history[job.upstreamId];
      if (!entry) {
        schedulePoll(job, pollIntervalMs);
        return;
      }
      let status = entry.status && entry.status.status_str;
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
      if (job.status !== 'running') {
        if (job.result && job.result.path) {
          try { fs.unlinkSync(job.result.path); } catch (error) {}
        }
        job.result = null;
        return;
      }
      job.status = 'succeeded';
      job.error = null;
      job.errorCode = null;
    } catch (error: any) {
      job.pollFailures += 1;
      if (error && (error.code === 'INVALID_RESULT' || error.code === 'COMFY_NO_VIDEO')) {
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

  async function submit(job: { input: { modelId: string|number; }; upstreamId: string; status: string; }) {
    let availability = media.modelAvailability(config, MODEL_BY_ID[job.input.modelId]);
    if (!availability.available) {
      throw serviceError(503, 'VIDEO_MODEL_UNAVAILABLE', '视频模型文件尚未安装', {
        missing:availability.missing,
      });
    }
    let response: any = await comfy.requestComfyJson(config, 'POST', '/prompt', {
      prompt:buildWorkflow(job.input),
      client_id:clientId,
    }, 20000);
    let promptId = response && response.prompt_id;
    if (typeof promptId !== 'string' || !promptId || promptId.length > 200) {
      throw serviceError(502, 'COMFY_INVALID_RESPONSE', 'ComfyUI 未返回有效任务 ID');
    }
    job.upstreamId = promptId;
    // 提交期间被取消（cancel 与 submit 竞态）：不能把已经取消的任务又翻回
    // running——否则用户按了取消，任务却复活跑完全程占 45 分钟 GPU。
    // 这里直接把刚创建的上游任务一并取消，保持取消语义。
    if (job.status !== 'queued') {
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

  function create(input: { frames: number; steps: number; }, owner: unknown, opts: any) {
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
    let job: any = {
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

  function get(id: unknown, owner: unknown) {
    let job = jobs.get(String(id || ''));
    return job && job.owner === owner ? job : null;
  }

  /** 重启遗留任务的 tombstone 查询（owner 对齐内存注册表同一判定） */
  function getLost(id: unknown, owner: unknown) {
    let key = String(id || '');
    for (let i = 0; i < lostJobs.length; i++) {
      if (lostJobs[i].id === key && lostJobs[i].owner === owner) return lostJobs[i];
    }
    return null;
  }

  async function cancel(job: { status: string; pollTimer: string|number|NodeJS.Timeout|null|undefined; upstreamId: string|number|boolean; error: string; errorCode: string; }) {
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

// 结果文件 Range 流式下发（支持视频拖动进度条）。


function createVideoRouter(config: any, dependencies: any) {
  let router = express.Router();
  let service = dependencies && dependencies.videoService
    ? dependencies.videoService
    : createVideoService(config, dependencies);
  let batchService = dependencies && dependencies.batchService
    ? dependencies.batchService
    : createBatchService(config, service, dependencies);
  let jobLimit = security.rateLimit({ capacity:3, refillMs:60000, label:'视频生成' });
  // T8 双时钟采样路径（2026-08-16）：测试可注入 t8Available 固定路径；
  // 生产启动时探测真实 ComfyUI（默认 false → 探测成功前走原生路径，幂等无害）。
  if (dependencies && typeof dependencies.t8Available === 'boolean') {
    setT8Available(dependencies.t8Available);
  } else {
    void probeT8Nodes(config);
  }

  router.get('/api/video/status', async function (req, res) {
    let online = false;
    try { online = await service.probe(); } catch (error) {}
    let models = MODEL_CATALOG.map(function (model) {
      return Object.assign({}, model, media.modelAvailability(config, model), {
        requirements:model.requirements.map(function (requirement) {
          return requirement[0] + '/' + requirement[1];
        }),
      });
    });
    let t8 = {
      available:t8Available,
      reason:t8Available
        ? 'T8 双时钟采样 + 4 步加速 LoRA（最快路径）'
        : '已降级：原生采样器（速度约慢 1 倍）；提交任务时会自动重新探测',
    };
    let qualities = Object.keys(QUALITIES).map(function (id) {
      let quality = QUALITIES[id];
      return {
        id:id,
        label:quality.label,
        summary:quality.summary,
        sizes:Object.keys(quality.sizes).reduce(function (sizes: any, aspectId) {
          sizes[aspectId] = quality.sizes[aspectId].width + ' × ' + quality.sizes[aspectId].height;
          return sizes;
        }, {}),
      };
    });
    res.setHeader('Cache-Control', 'no-store');
    envelope.ok(res, {
      online:online,
      pending:service.pendingCount(),
      maxPending:MAX_PENDING,
      models:models,
      qualities:qualities,
      defaults:{
        modelId:'wan2.2-ti2v-5b',
        aspectRatio:'landscape',
        duration:3,
        camera:'still',
        motion:'subtle',
        quality:'standard',
      },
      t8:t8,
    });
  });

  // 首帧图/参考图上传：base64 JSON → 魔数校验 → 写入 ComfyUI/input（受控文件名）。
  // kind:'reference' 用 aics_video_ref_ 前缀（跨任务资产，启动清理保留）；
  // 缺省 aics_video_input_（首帧，任务结束/网关重启时清理）。
  router.post('/api/video/images', jobLimit, express.json({ limit:'28mb' }), function (req, res) {
    let body = req.body;
    let data = body && body.data;
    if (typeof data !== 'string' || !data) {
      return envelope.fail(res, 400, '缺少图片数据', { code:'INVALID_IMAGE' });
    }
    let buffer;
    try { buffer = Buffer.from(data, 'base64'); } catch (error) {
      return envelope.fail(res, 400, '图片数据编码无效', { code:'INVALID_IMAGE' });
    }
    if (buffer.length < 16 || buffer.length > MAX_IMAGE_BYTES) {
      return envelope.fail(res, 400, '图片大小需在 16B—20MB 之间', { code:'INVALID_IMAGE' });
    }
    let ext = media.sniffImageExtension(buffer);
    if (!ext) {
      return envelope.fail(res, 400, '仅支持 PNG / JPEG / WebP 图片', { code:'INVALID_IMAGE' });
    }
    let isReference = body.kind === 'reference';
    let prefix = isReference ? IMAGE_REF_PREFIX : IMAGE_INPUT_PREFIX;
    let name = prefix + crypto.randomBytes(8).toString('hex') + '.' + ext;
    let root = media.imageInputRoot(config);
    let resolvedRoot = path.resolve(root);
    let target = path.resolve(root, name);
    if (target.indexOf(resolvedRoot + path.sep) !== 0) {
      return envelope.fail(res, 500, '图片存储路径无效', { code:'IMAGE_STORAGE_INVALID' });
    }
    try {
      fs.mkdirSync(resolvedRoot, { recursive:true });
      fs.writeFileSync(target, buffer, { flag:'wx' });
    } catch (error) {
      return envelope.fail(res, 500, '图片写入失败', { code:'IMAGE_WRITE_FAILED' });
    }
    envelope.ok(res, { name:name, bytes:buffer.length });
  });

  router.post('/api/video/jobs', jobLimit, express.json({ limit:MAX_BODY }), async function (req, res) {
    try { await ensureT8Probe(config); } catch (error) { /* 探测失败沿用旧值，提交照常 */ }
    let input;
    try { input = validateInput(req.body, config, { isLocal: security.isDirectLocalRequest(req) }); } catch (error: any) {
      return envelope.fail(res, runtimeErrorStatus(error) || 400, runtimeErrorMessage(error), {
        code:runtimeErrorCode(error),
        detail:error.detail,
      });
    }
    let job;
    try {
      job = service.create(input, requestOwner(req));
      await service.submit(job);
    } catch (error: any) {
      if (job) await service.cancel(job);
      return envelope.fail(res, runtimeErrorStatus(error) || 502,
        runtimeErrorStatus!(error) >= 500 ? '视频生成环境尚未就绪' : runtimeErrorMessage(error),
        { code:runtimeErrorCode(error) || 'VIDEO_SUBMIT_FAILED', detail:error.detail });
    }
    res.status(202);
    envelope.ok(res, { job:service.publicJob(job) });
  });

  router.get('/api/video/jobs/:id', function (req, res) {
    let job = service.get(req.params.id, requestOwner(req));
    if (!job && service.getLost(req.params.id, requestOwner(req))) {
      return envelope.fail(res, 410, '网关重启导致该视频任务中断，结果已丢失；请重新提交', { code:'JOB_LOST' });
    }
    if (!job) return envelope.fail(res, 404, '视频任务不存在', { code:'JOB_NOT_FOUND' });
    res.setHeader('Cache-Control', 'no-store');
    envelope.ok(res, { job:service.publicJob(job) });
  });

  router.delete('/api/video/jobs/:id', async function (req, res) {
    let job = service.get(req.params.id, requestOwner(req));
    if (!job && service.getLost(req.params.id, requestOwner(req))) {
      return envelope.fail(res, 410, '该视频任务已随网关重启中断，无需取消', { code:'JOB_LOST' });
    }
    if (!job) return envelope.fail(res, 404, '视频任务不存在', { code:'JOB_NOT_FOUND' });
    let cancelled = await service.cancel(job);
    envelope.ok(res, { job:service.publicJob(cancelled) });
  });

  router.get('/api/video/jobs/:id/result', function (req, res) {
    let job = service.get(req.params.id, requestOwner(req));
    if (!job || job.status !== 'succeeded' || !job.result) {
      return envelope.fail(res, 404, '视频结果不存在', { code:'RESULT_NOT_FOUND' });
    }
    try {
      streamVideo(req, res, job.result);
    } catch (error) {
      if (!res.headersSent) envelope.fail(res, 404, '视频结果不存在', { code:'RESULT_NOT_FOUND' });
      else res.destroy();
    }
  });

  // ── 场景蓝图一键剧本（2026-08-23）：起承转合四镜确定性派生，零 LLM 依赖 ──
  // 素材全取蓝图字段（台词从 description 引号原样提取）；成人类蓝图 fail-closed
  // 拒绝（视频链路成人门控未接入）。输出条目与批量镜头输入对齐，前端回填
  // ShotListEditor 后走既有批量编排，不改提交链路。
  router.post('/api/video/storyboard', express.json({ limit:'4kb' }), function (req, res) {
    let body = req.body || {};
    let result = storyboard.resolveStoryboard(config, body.blueprintId, { intent: body.intent });
    if (result.error) {
      let status = result.error === 'UNKNOWN_BLUEPRINT' ? 404 : 400;
      return envelope.fail(res, status, result.message, { code: result.error });
    }
    res.setHeader('Cache-Control', 'no-store');
    envelope.ok(res, { storyboard: result.storyboard });
  });

  // ── 分镜批量（P5：批量生成 / P6：尾帧衔接 / P8：拼接成片）──────────────
  router.post('/api/video/batches', jobLimit, express.json({ limit:MAX_BATCH_BODY }), async function (req, res) {
    try { await ensureT8Probe(config); } catch (error) { /* 探测失败沿用旧值，提交照常 */ }
    let batchInput;
    try {
      batchInput = validateBatchInput(req.body, config);
    } catch (error: any) {
      return envelope.fail(res, runtimeErrorStatus(error) || 400, runtimeErrorMessage(error), {
        code:runtimeErrorCode(error),
        detail:error.detail,
      });
    }
    let batch;
    try {
      batch = await batchService.create(requestOwner(req), batchInput);
    } catch (error: any) {
      return envelope.fail(res, runtimeErrorStatus(error) || 502,
        runtimeErrorStatus!(error) >= 500 ? '视频生成环境尚未就绪' : runtimeErrorMessage(error),
        { code:runtimeErrorCode(error) || 'BATCH_SUBMIT_FAILED', detail:error.detail });
    }
    res.status(202);
    envelope.ok(res, { batch:batchService.publicBatch(batch) });
  });

  router.get('/api/video/batches/:id', function (req, res) {
    let batch = batchService.get(req.params.id, requestOwner(req));
    if (!batch) return envelope.fail(res, 404, '分镜任务不存在', { code:'BATCH_NOT_FOUND' });
    res.setHeader('Cache-Control', 'no-store');
    envelope.ok(res, { batch:batchService.publicBatch(batch) });
  });

  router.delete('/api/video/batches/:id', async function (req, res) {
    let batch = batchService.get(req.params.id, requestOwner(req));
    if (!batch) return envelope.fail(res, 404, '分镜任务不存在', { code:'BATCH_NOT_FOUND' });
    let cancelled = await batchService.cancel(batch);
    envelope.ok(res, { batch:batchService.publicBatch(cancelled) });
  });

  // 重抽单个失败/取消分镜（同 seed 确定性复现，不重跑整批）。
  router.post('/api/video/batches/:id/shots/:index/retry', async function (req, res) {
    let batch = batchService.get(req.params.id, requestOwner(req));
    if (!batch) return envelope.fail(res, 404, '分镜任务不存在', { code:'BATCH_NOT_FOUND' });
    let index = Number(req.params.index);
    if (!Number.isSafeInteger(index) || index < 1) {
      return envelope.fail(res, 400, '分镜序号无效', { code:'SHOT_INDEX_INVALID' });
    }
    try {
      await batchService.retryShot(batch, index - 1);
    } catch (error) {
      return envelope.fail(res, runtimeErrorStatus(error) || 400, runtimeErrorMessage(error), { code:runtimeErrorCode(error) || 'SHOT_RETRY_FAILED' });
    }
    res.status(202);
    envelope.ok(res, { batch:batchService.publicBatch(batch) });
  });

  router.post('/api/video/batches/:id/concat', async function (req, res) {
    let batch = batchService.get(req.params.id, requestOwner(req));
    if (!batch) return envelope.fail(res, 404, '分镜任务不存在', { code:'BATCH_NOT_FOUND' });
    try {
      await batchService.concat(batch);
    } catch (error) {
      return envelope.fail(res, runtimeErrorStatus(error) || 500, runtimeErrorMessage(error), { code:runtimeErrorCode(error) || 'BATCH_CONCAT_FAILED' });
    }
    res.setHeader('Cache-Control', 'no-store');
    envelope.ok(res, { batch:batchService.publicBatch(batch) });
  });

  router.get('/api/video/batches/:id/result', function (req, res) {
    let batch = batchService.get(req.params.id, requestOwner(req));
    if (!batch || !batch.concat) {
      return envelope.fail(res, 404, '拼接结果不存在', { code:'RESULT_NOT_FOUND' });
    }
    try {
      streamVideo(req, res, batch.concat);
    } catch (error) {
      if (!res.headersSent) envelope.fail(res, 404, '拼接结果不存在', { code:'RESULT_NOT_FOUND' });
      else res.destroy();
    }
  });

  let close = function () {
    service.close();
    batchService.close();
  };
  return { router:router, service:service, batchService:batchService, close:close };
}

export = {
  createVideoRouter:createVideoRouter,
  createVideoService:createVideoService,
  createBatchService:createBatchService,
  validateInput:validateInput,
  validateBatchInput:validateBatchInput,
  buildWorkflow:buildWorkflow,
  validateVideoReference:validateVideoReference,
  // 测试钩子：固定 T8 双时钟路径（生产由 createVideoRouter 探测 ComfyUI 决定）。
  setT8Available:setT8Available,
  constants:{
    MODEL_CATALOG:constants.MODEL_CATALOG,
    ASPECTS:constants.ASPECTS,
    QUALITIES:constants.QUALITIES,
    DURATIONS:constants.DURATIONS,
    OUTPUT_NODE_ID:constants.OUTPUT_NODE_ID,
    OUTPUT_FILENAME_PREFIX:constants.OUTPUT_FILENAME_PREFIX,
    MAX_BATCH_SHOTS:constants.MAX_BATCH_SHOTS,
    BATCH_TTL_MS:constants.BATCH_TTL_MS,
  },
};
