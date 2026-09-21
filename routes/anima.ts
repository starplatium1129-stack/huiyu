import type { ImageGenerationConfig, ImageJob, ImageModelDefinition, ImageLoraDefinition } from './anima/types';
import { storeAdmittedImage } from '../services/image-admission';
import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage, errorStatus as runtimeErrorStatus } from '../scripts/lib/runtime-errors';
'use strict';

import { Request } from 'express-serve-static-core';

let crypto: typeof import('crypto') = require('crypto');
let express: typeof import('express') = require('express');
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let security: typeof import('../server/security') = require('../server/security');
let envelope: typeof import('../server/http-envelope') = require('../server/http-envelope');
let generationContract: typeof import('../server/anima-generation-contract') = require('../server/anima-generation-contract');
let modelCatalog: typeof import('../server/anima-model-catalog') = require('../server/anima-model-catalog');

let animaErrors: typeof import('./anima/errors') = require('./anima/errors');
let animaValidation: typeof import('./anima/validation') = require('./anima/validation');
let animaMedia: typeof import('./anima/media') = require('./anima/media');
let animaWorkflows: typeof import('./anima/workflows') = require('./anima/workflows');
let animaConstants: typeof import('./anima/constants') = require('./anima/constants');
let animaService: typeof import('./anima/service') = require('./anima/service');

let isPlainObject = animaErrors.isPlainObject;
let validateInput = animaValidation.validateInput;
let buildWorkflow = animaWorkflows.buildWorkflow;
let imageInputRoot = animaMedia.imageInputRoot;
let cleanupImageInputs = animaMedia.cleanupImageInputs;
let sniffImageExtension = animaMedia.sniffImageExtension;
let validateImageReference = animaMedia.validateImageReference;
let ensureMediaRoot = animaMedia.ensureMediaRoot;
let safeMediaPath = animaMedia.safeMediaPath;
let MAX_BODY = animaConstants.MAX_BODY;
let MAX_IMAGE_BYTES = animaConstants.MAX_IMAGE_BYTES;

let createAnimaService = animaService.createAnimaService;

let MODELS: Readonly<Record<string, ImageModelDefinition>> = modelCatalog.MODELS;
let LORAS: Readonly<Record<string, ImageLoraDefinition>> = modelCatalog.LORAS;
let KREA_STYLE_LORAS: Readonly<Record<string, { file: string; trigger: string }>> = modelCatalog.KREA_STYLE_LORAS;

function requestOwner(req: Pick<import('express').Request, 'socket' | 'headers' | 'query'>) {
  if (security.isDirectLocalRequest(req)) return 'local';
  let cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)aics_token=([^;]+)/);
  let token = req.headers['x-token'] || cookie && cookie[1] || req.query && req.query.token || '';
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createAnimaRouter(config: ImageGenerationConfig, dependencies?: { anima?: ReturnType<typeof createAnimaService> }) {
  dependencies = dependencies || {};
  let router = express.Router();
  let service = dependencies.anima || createAnimaService(config);
  let jobLimit = security.rateLimit({ capacity:12, refillMs:5000, label:'Anima 出图' });
  function routeFamily(req: Pick<Request, 'path'>) { return String(req.path || '').startsWith('/api/anima') ? 'anima' : 'creative'; }
  function routeOwnsJob(req: Pick<Request, 'path'>, job: ImageJob | null): job is ImageJob { return Boolean(job) && (routeFamily(req) === 'anima' ? job!.input.family === 'anima' : job!.input.family === 'krea2'); }

  router.get(['/api/anima/status', '/api/creative/status'], function (req, res) {
    service.probe().then(function (online) {
      let data = service.status();
      if (routeFamily(req) === 'anima') data.models = data.models.filter(function (model: { family: string; }) { return model.family === 'anima'; });
      data.online = online && data.models.some(function (model: { available: boolean; }) { return model.available === true; });
      res.setHeader('Cache-Control', 'no-store');
      envelope.ok(res, data);
    }).catch(function () {
       let data = service.status();
       if (routeFamily(req) === 'anima') data.models = data.models.filter(function (model: { family: string; }) { return model.family === 'anima'; });
       data.online = false;
      res.setHeader('Cache-Control', 'no-store');
      envelope.ok(res, data);
    });
  });

  router.post(['/api/anima/images', '/api/creative/images'], jobLimit, express.json({ limit:'28mb' }), async function (req, res) {
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    try {
      if (!isPlainObject(req.body) || typeof req.body.image !== 'string') {
        return envelope.fail(res, 400, '请求体必须包含 image base64 字符串', { code:'INVALID_BODY' });
      }
      let base64Data = req.body.image.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
      let buffer = Buffer.from(base64Data, 'base64');
      if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
        return envelope.fail(res, 400, '图片数据超出大小限制', { code:'INVALID_IMAGE' });
      }
      let ext = sniffImageExtension(buffer);
      if (!ext) {
        return envelope.fail(res, 400, '不支持的图片格式（仅限 PNG、JPEG、WebP）', { code:'INVALID_IMAGE_FORMAT' });
      }
      let filename = await storeAdmittedImage(imageInputRoot(config), buffer, 'aics_anima_input_', ext, requestOwner(req), config.IMAGE_STORAGE_LIMITS, controller.signal);
      return envelope.ok(res, { ok:true, name:filename });
    } catch (error) {
      const code = runtimeErrorCode(error) || 'IMAGE_SAVE_FAILED';
      const message = /^(IMAGE_QUOTA|IMAGE_STORAGE_BUSY|IMAGE_STORAGE_INVALID|INVALID_IMAGE|QUEUE_FULL)$/.test(String(code)) ? runtimeErrorMessage(error) : '图片保存失败，请检查存储权限和剩余空间。';
      return envelope.fail(res, runtimeErrorStatus(error) || 500, message, { code });
    } finally { res.off('close', disconnected); }
  });

  router.post(['/api/anima/jobs', '/api/creative/jobs'], jobLimit, express.json({ limit:MAX_BODY }), async function (req, res) {
    let input;
    try { input = validateInput(req, req.body, routeFamily(req) === 'anima' ? 'anima' : 'krea2'); } catch (error) {
      return envelope.fail(res, runtimeErrorStatus(error) || 400, runtimeErrorMessage(error), { code:runtimeErrorCode(error) });
    }
    let job: ImageJob | undefined;
    try {
      job = service.create(input, requestOwner(req));
      res.once('close', function () { if (!res.writableFinished && job) void service.cancel(job); });
      await service.submit(job);
    } catch (error) {
      if (job) {
        service.cancel(job);
      }
      let status = runtimeErrorStatus(error);
      return envelope.fail(res, status === 503 ? 503 : (status !== undefined && status >= 500 ? 502 : (status || 502)),
        runtimeErrorMessage(error) || 'Anima 提交失败',
        { code:runtimeErrorCode(error) || 'ANIMA_SUBMIT_FAILED' });
    }
    res.status(202);
    return envelope.ok(res, { job:service.publicJob(job) });
  });

  router.get(['/api/anima/jobs/:id/result', '/api/creative/jobs/:id/result'], function (req, res) {
    let job = service.get(req.params.id, requestOwner(req));
    if (!routeOwnsJob(req, job)) return envelope.fail(res, 404, '生成任务不存在', { code:'JOB_NOT_FOUND' });
    if (job.resultConsumed) return envelope.fail(res, 404, '结果已消费或不存在', { code:'RESULT_NOT_FOUND' });
    if (job.status !== 'succeeded' || !job.result) {
      return envelope.fail(res, job.status === 'failed' ? 502 : 409,
        job.error || '结果尚未就绪', { code:job.errorCode || 'RESULT_NOT_READY' });
    }
    let root = ensureMediaRoot(config);
    let target = safeMediaPath(root, path.basename(job.result.path));
    if (!target || target !== path.resolve(job.result.path)) return envelope.fail(res, 404, '结果不存在', { code:'RESULT_NOT_FOUND' });
    try {
      let realRoot = fs.realpathSync(root);
      let realTarget = fs.realpathSync(target);
      let stat = fs.statSync(realTarget);
      if (!stat.isFile() || realTarget.indexOf(realRoot + path.sep) !== 0) throw new Error('unsafe result');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', job.result.mime);
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('X-Content-Type-Options', 'nosniff');
       // 下载完成不等于浏览器已经持久化；允许 TTL 内重读，避免一次断线丢图。
       let stream = fs.createReadStream(realTarget);
       stream.on('error', function () {
         if (!res.headersSent) envelope.fail(res, 404, '结果不存在', { code:'RESULT_NOT_FOUND' });
         else res.destroy();
       });
       stream.pipe(res);
    } catch (error) {
      return envelope.fail(res, 404, '结果不存在', { code:'RESULT_NOT_FOUND' });
    }
  });

  router.get(['/api/anima/jobs/:id', '/api/creative/jobs/:id'], function (req, res) {
    let job = service.get(req.params.id, requestOwner(req));
    if (!routeOwnsJob(req, job)) return envelope.fail(res, 404, '生成任务不存在', { code:'JOB_NOT_FOUND' });
    res.setHeader('Cache-Control', 'no-store');
    return envelope.ok(res, { job:service.publicJob(job) });
  });

  router.delete(['/api/anima/jobs/:id', '/api/creative/jobs/:id'], async function (req, res) {
    let job = service.get(req.params.id, requestOwner(req));
    if (!routeOwnsJob(req, job)) return envelope.fail(res, 404, '生成任务不存在', { code:'JOB_NOT_FOUND' });
     let cancelled = await service.cancel(job);
     res.status(cancelled.status === 'cancelling' ? 202 : 200);
     return envelope.ok(res, { job:service.publicJob(cancelled) });
  });

  return { router:router, service:service, close:service.close };
}

export = {
  createAnimaRouter:createAnimaRouter,
  createAnimaService:createAnimaService,
  validateInput:validateInput,
  buildWorkflow:buildWorkflow,
  validateImageReference:validateImageReference,
  cleanupImageInputs:cleanupImageInputs,
  constants:{
    MODELS:MODELS,
    LORAS:LORAS,
    KREA_STYLE_LORAS:KREA_STYLE_LORAS,
    generationContract:generationContract
  }
};
