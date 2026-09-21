import { storeAdmittedImage } from '../services/image-admission';
import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage, errorStatus as runtimeErrorStatus } from '../scripts/lib/runtime-errors';
import type { VideoConfig, VideoServiceDependencies } from './video/types';
import serviceFactory = require('./video/service');
const { createVideoService } = serviceFactory;
import engine = require('./video/engine');
const { setT8Available, probeT8Nodes, ensureT8Probe, buildWorkflow, isT8Available } = engine;
import videoStream = require('./video-stream');
const { streamVideo } = videoStream;
import crypto = require('crypto');
import express = require('express');
import security = require('../server/security');
import envelope = require('../server/http-envelope');
import constants = require('./video/constants');
import media = require('./video/media');
import validation = require('./video/validation');
import batchFactory = require('./video/batch');
import storyboard = require('./video/storyboard');
const { MAX_BODY, MAX_PENDING, MAX_BATCH_BODY, MAX_IMAGE_BYTES, IMAGE_INPUT_PREFIX, IMAGE_REF_PREFIX, MODEL_CATALOG, QUALITIES } = constants;
const { validateInput, validateBatchInput } = validation;
const { createBatchService } = batchFactory;
const { validateVideoReference } = media;
interface VideoRouterDependencies extends VideoServiceDependencies {
  videoService?: ReturnType<typeof createVideoService>;
  batchService?: ReturnType<typeof createBatchService>;
  t8Available?: boolean;
  batchPollIntervalMs?: number;
  runFfmpeg?: (args: string[]) => Promise<unknown>;
}

function requestOwner(req: express.Request) {
  if (security.isDirectLocalRequest(req)) return 'local';
  let cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)aics_token=([^;]+)/);
  let token = req.headers['x-token'] || cookie && cookie[1] || req.query && req.query.token || '';
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// 结果文件 Range 流式下发（支持视频拖动进度条）。


function createVideoRouter(config: VideoConfig, dependencies: VideoRouterDependencies = {}) {
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
      available:isT8Available(),
      reason:isT8Available()
        ? 'T8 双时钟采样 + 4 步加速 LoRA（最快路径）'
        : '已降级：原生采样器（速度约慢 1 倍）；提交任务时会自动重新探测',
    };
    let qualities = Object.keys(QUALITIES).map(function (id) {
      let quality = (QUALITIES as Record<string, any>)[id];
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
  router.post('/api/video/images', jobLimit, express.json({ limit:'28mb' }), async function (req, res) {
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
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    try {
      const name = await storeAdmittedImage(media.imageInputRoot(config), buffer, prefix, ext, requestOwner(req), config.IMAGE_STORAGE_LIMITS, controller.signal);
      return envelope.ok(res, { name, bytes:buffer.length });
    } catch (error) {
      const code = runtimeErrorCode(error) || 'IMAGE_WRITE_FAILED';
      const message = /^(IMAGE_QUOTA|IMAGE_STORAGE_BUSY|IMAGE_STORAGE_INVALID|INVALID_IMAGE|QUEUE_FULL)$/.test(String(code)) ? runtimeErrorMessage(error) : '图片写入失败，请检查存储权限和剩余空间。';
      return envelope.fail(res, runtimeErrorStatus(error) || 500, message, { code });
    } finally { res.off('close', disconnected); }
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
        (runtimeErrorStatus(error) ?? 0) >= 500 ? '视频生成环境尚未就绪' : runtimeErrorMessage(error),
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
      batchInput = validateBatchInput(req.body, config, { isLocal:security.isDirectLocalRequest(req) });
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
        (runtimeErrorStatus(error) ?? 0) >= 500 ? '视频生成环境尚未就绪' : runtimeErrorMessage(error),
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
