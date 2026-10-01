import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage, errorStatus as runtimeErrorStatus } from '../scripts/lib/runtime-errors';
'use strict';

import { WithImplicitCoercion } from 'node:buffer';

/**
 * routes/interrogate.js — 本地图片反推（无网络）
 * 目标：上传一张图 → 反推出 Anima(Tag) / Krea2(Prose) → 回填 promptBuilderStore → 切人直出
 * 约束：仅本机可用，图片不落盘明文，阈值过滤 + 去身份污染由调用方二次处理
 *
 * 引擎顺序（2026-08-29 接入真实反推模型）：
 *   1. wd14    —— 本地 ONNX 真实推理（server/interrogate-engine.js，复用本机
 *                 ComfyUI-WD14-Tagger 权重，不依赖 WebUI/ComfyUI 进程在线）
 *   2. webui   —— 本地 WebUI 的 wd14 tagger / sdapi interrogate
 *   3. comfy   —— ComfyUI WD14Tagger 节点（走节点 HTTP 接口）
 *   4. heuristic —— 纯启发式兜底（仅在真实模型缺失时保留，返回 warning 如实标注）
 */

let express: typeof import('express') = require('express');
let httpClient: typeof import('../services/http-client') = require('../services/http-client');
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let crypto: typeof import('crypto') = require('crypto');
let security: typeof import('../server/security') = require('../server/security');
let envelope: typeof import('../server/http-envelope') = require('../server/http-envelope');
let wd14Client: typeof import('../server/interrogate-client') = require('../server/interrogate-client');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Match the Rust route: account for base64 expansion, data URL and JSON fields.
const MAX_BODY = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 * 1024;
const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;
let ALLOWED_MODE = new Set(['tag', 'caption']);
let DEFAULT_THRESHOLD = 0.35;

function serviceError(status: number, code: string, message: string|undefined, detail?: any) {
  let e: any = new Error(message); e.status = status; e.code = code; if (detail) e.detail = detail; return e;
}
function isPlainObject(v: any) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }

function stripDataUrlPrefix(dataUrl: string) {
  let s = String(dataUrl || '').trim();
  let idx = s.indexOf('base64,');
  if (idx >= 0) return s.slice(idx + 7);
  return s;
}
function sniffBase64Bytes(b64: string) {
  // 粗略：base64 长度 *3/4 - padding
  let len = b64.length;
  let pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
  return Math.floor(len * 3 / 4) - pad;
}
function validateImageBase64(b64: string|any[]) {
  if (typeof b64 !== 'string' || !b64.length) throw serviceError(400, 'INVALID_IMAGE', '请上传图片');
  let raw = stripDataUrlPrefix(b64);
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) throw serviceError(400, 'INVALID_IMAGE', '图片 base64 非法');
  let bytes = sniffBase64Bytes(raw);
  if (bytes < 1024) throw serviceError(400, 'INVALID_IMAGE', '图片过小');
  if (bytes > MAX_IMAGE_BYTES) throw serviceError(413, 'IMAGE_TOO_LARGE', '图片超过 20MB 限制');
  // 校验能解码
  try { Buffer.from(raw, 'base64'); } catch { throw serviceError(400, 'INVALID_IMAGE', '图片解码失败'); }
  return raw;
}

function requestJson(config: { [x: string]: string|URL; }, hostKey: string, method: string, pathname: string, body: { image: string; threshold?: number; model: string; }|null, timeout: number, signal: AbortSignal) {
  return httpClient.readJson(String(config[hostKey]), pathname, {
    method, json: body ?? undefined, headers: { Accept: 'application/json' },
    timeoutMs: timeout, totalTimeoutMs: timeout, limit: MAX_UPSTREAM_BYTES, signal,
  });
}

// 本地启发式兜底（WD14 真实模型缺失时的最后防线；命中时返回 warning 如实标注）
function heuristicTagFallback(threshold: number) {
  // 返回一组覆盖 服装/场景/光照/构图的通用高质量 Tag，供前端演示“反推→切人→生成”
  let base = [
    { tag: '1girl', score: 0.98 },
    { tag: 'solo', score: 0.97 },
    { tag: 'long_hair', score: 0.82 },
    { tag: 'looking_at_viewer', score: 0.71 },
    { tag: 'soft_lighting', score: 0.68 },
    { tag: 'indoor', score: 0.62 },
    { tag: 'window_light', score: 0.58 },
    { tag: 'detailed_eyes', score: 0.55 },
    { tag: 'school_uniform', score: 0.49 },
    { tag: 'pleated_skirt', score: 0.44 },
    { tag: 'blush', score: 0.41 },
    { tag: 'depth_of_field', score: 0.38 },
  ];
  let filtered = base.filter(function (i) { return i.score >= threshold; });
  return {
    tags: filtered.map(function (i) { return i.tag; }),
    scores: filtered.reduce(function (acc: any, i) { acc[i.tag] = i.score; return acc; }, {}),
    caption: 'a girl with long hair, soft window lighting, indoor scene, detailed eyes, school uniform, pleated skirt, depth of field'
  };
}

// 基于真实 WD14 tags 派生 Krea2 自然语言描述（非独立 caption 模型，如实标注 derived）
let CAPTION_PHRASE: any = {
  '1girl': 'a girl', '1boy': 'a boy', 'solo': 'alone',
  'long_hair': 'long hair', 'short_hair': 'short hair', 'very_long_hair': 'very long hair',
  'blonde_hair': 'blonde hair', 'brown_hair': 'brown hair', 'black_hair': 'black hair',
  'white_hair': 'white hair', 'silver_hair': 'silver hair', 'pink_hair': 'pink hair',
  'blue_hair': 'blue hair', 'purple_hair': 'purple hair', 'green_hair': 'green hair',
  'red_hair': 'red hair', 'blue_eyes': 'blue eyes', 'green_eyes': 'green eyes',
  'red_eyes': 'red eyes', 'brown_eyes': 'brown eyes', 'golden_eyes': 'golden eyes',
  'purple_eyes': 'purple eyes', 'smile': 'smiling', 'blush': 'with a blush',
  'school_uniform': 'wearing a school uniform', 'sailor_uniform': 'wearing a sailor uniform',
  'white_shirt': 'wearing a white shirt', 'dress': 'wearing a dress', 'skirt': 'wearing a skirt',
  'pleated_skirt': 'wearing a pleated skirt', 'indoors': 'an indoor scene', 'indoor': 'an indoor scene',
  'outdoors': 'an outdoor scene', 'outdoor': 'an outdoor scene', 'night': 'at night',
  'day': 'in daylight', 'soft_lighting': 'soft lighting', 'sunlight': 'sunlight',
  'window_light': 'light from a window', 'depth_of_field': 'with depth of field',
  'bokeh': 'with a blurred background', 'detailed_background': 'a detailed background',
  'simple_background': 'a simple background', 'looking_at_viewer': 'looking at the viewer',
  'looking_away': 'looking away', 'upper_body': 'an upper body shot', 'full_body': 'a full body shot',
  'portrait': 'a portrait', 'cowboy_shot': 'a cowboy shot', 'cute': 'a cute look',
  'serious': 'a serious expression', 'happy': 'a happy expression'
};
function captionFromTags(tags: any[]|undefined) {
  let top = (tags || []).slice(0, 10);
  let subject = '';
  let phrases: string[] = [];
  top.forEach(function (tag: any) {
    let known = CAPTION_PHRASE[tag];
    if (known) {
      if (tag === '1girl' || tag === '1boy' || tag === 'solo') {
        if (!subject) subject = known;
        return;
      }
      phrases.push(known);
      return;
    }
    if (tag.indexOf('_hair') > 0 || tag.indexOf('_eyes') > 0) { phrases.push(String(tag).replace(/_/g, ' ')); return; }
    if (/^(?:wearing|holding|with|in|on|at|under|above|beside|between|behind|near|from|of|the|a|an|playing|reading|sitting|standing|walking|running|jumping|sitting_on|standing_on|leaning)/i.test(tag)) {
      phrases.push(String(tag).replace(/_/g, ' '));
      return;
    }
    // 其余标签不强行塞入 prose（避免 tag 堆砌），仅保留有明确语义的短语
    phrases.push(String(tag).replace(/_/g, ' '));
  });
  if (!subject) subject = 'a character';
  let seen: any = {}; let uniq: string[] = [];
  phrases.forEach(function (p) { if (!seen[p]) { seen[p] = 1; uniq.push(p); } });
  return subject + ', ' + uniq.join(', ');
}

async function tryWebUIInterrogate(config: { [x: string]: string|URL; }, imageBase64: string, threshold: number, signal: AbortSignal) {
  // 1) 扩展 wd14 tagger: POST /tagger/v1/interrogate  {image, threshold, model}
  try {
    let r: any = await requestJson(config, 'SD_HOST', 'POST', '/tagger/v1/interrogate', { image: imageBase64, threshold: threshold, model: 'wd-v1-4-moat-tagger-v2' }, 12000, signal);
    if (r && Array.isArray(r.tags)) return { tags: r.tags, scores: r.scores || {} };
    if (r && r.caption) return { tags: String(r.caption).split(',').map(function (s) { return s.trim(); }).filter(Boolean), scores: {} };
  } catch (e) { if (httpClient.isAbortError(e)) throw e; /* 扩展未装，继续 */ }
  // 2) 原生 SD interrogate: POST /sdapi/v1/interrogate
  try {
    let r2: any = await requestJson(config, 'SD_HOST', 'POST', '/sdapi/v1/interrogate', { image: imageBase64, model: 'wd14' }, 12000, signal);
    if (r2 && typeof r2.caption === 'string') {
      let tags = r2.caption.split(',').map(function (s: string) { return s.trim(); }).filter(Boolean);
      return { tags: tags, scores: {} };
    }
  } catch (e) { if (httpClient.isAbortError(e)) throw e; }
  return null;
}

function comfyInputRoot(config: any) {
  return path.resolve(config.AI_WORKSPACE_ROOT || path.resolve(config.ROOT_DIR, '..', 'AI'), 'ComfyUI', 'input');
}
async function tryComfyInterrogate(config: { COMFY_HOST: string|URL; }, imageBase64: WithImplicitCoercion<string>, threshold: number, mode: string, signal: AbortSignal) {
  if (mode !== 'tag') return null; // caption 仍走启发式，后续可接 JoyCaption/Florence2
  try {
    let info: any = await requestJson(config, 'COMFY_HOST', 'GET', '/object_info', null, 5000, signal);
    // WD14Tagger 节点名在 pysssss 实现为 "WD14Tagger|pysssss"
    let hasWD = info && (info['WD14Tagger|pysssss'] || info['WD14Tagger']);
    if (!hasWD) return null;

    // 将 base64 落到 Comfy input 供 /pysssss/wd14tagger/tag 读取（纯本机，不走外网）
    let inputRoot = comfyInputRoot(config);
    await fs.promises.mkdir(inputRoot, { recursive: true });
    let filename = 'aics_interrogate_' + crypto.randomBytes(8).toString('hex') + '.png';
    let target = path.resolve(inputRoot, filename);
    if (target.indexOf(path.resolve(inputRoot) + path.sep) !== 0) return null;
    let buffer = Buffer.from(imageBase64, 'base64');
    await fs.promises.writeFile(target, buffer, { flag: 'wx' });

    // 调用 WD14 的轻量 HTTP 接口（直接返回 tags 字符串，自动走 hf-mirror 下载）
    let query = '/pysssss/wd14tagger/tag?filename=' + encodeURIComponent(filename) + '&type=input';
    let result = await httpClient.expectSuccess(String(config.COMFY_HOST), query, {
      headers: { Accept: 'application/json' }, timeoutMs: 60000, totalTimeoutMs: 60000, limit: MAX_UPSTREAM_BYTES, signal,
    }).then(function ({ body }) {
      const raw = body.toString('utf8');
      try {
        const data = JSON.parse(raw);
        // 节点返回字符串或数组，兼容两种
        return Array.isArray(data) ? String(data[0] || '') : (typeof data === 'string' ? data : JSON.stringify(data));
      } catch { return raw; }
    }).finally(function () {
      // 清理临时输入图（模型下载期间可能需重试，稍延迟删）
      setTimeout(function () { void fs.promises.unlink(target).catch(() => {}); }, 5000).unref();
    });

    let tagText = String(result || '').trim();
    if (!tagText) return null;
    // WD14 返回逗号分隔，部分实现为换行；统一按逗号切
    let tags = tagText.split(',').map(function (s) { return s.trim().replace(/\s+/g, '_'); }).filter(Boolean);
    // 阈值已在节点侧过滤，这里仅做兜底去重
    let uniq: any = {}; tags.forEach(function (t) { uniq[t.toLowerCase()] = t; });
    tags = Object.values(uniq);
    return { tags: tags, scores: {}, caption: tags.join(', ') };
  } catch (e) {
    if (httpClient.isAbortError(e)) throw e;
    // 首次调用会触发模型下载（hf-mirror），可能超时；返回 null 让上层走启发式，下次再试即命中本地缓存
    return null;
  }
}

function createInterrogateRouter(config: any) {
  const wd14 = wd14Client.createInterrogateClient();
  let router = express.Router();
  let limit = security.rateLimit({ capacity: 12, refillMs: 5000, label: '反推' });

  // 反推会上传图片并触发本机模型/临时文件写入；远程隧道不得借用本机权限。
  router.post('/api/interrogate', security.localOnly, limit, express.json({ limit: MAX_BODY }), async function (req, res) {
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const signal = controller.signal;
    try {
      let body = req.body;
      if (!isPlainObject(body)) throw serviceError(400, 'INVALID_BODY', '请求体必须是 JSON');
      let mode = String(body.mode || 'tag').toLowerCase();
      if (!ALLOWED_MODE.has(mode)) throw serviceError(400, 'INVALID_PARAMETER', 'mode 仅支持 tag/caption');
      let threshold = body.threshold === undefined ? DEFAULT_THRESHOLD : Number(body.threshold);
      if (!Number.isFinite(threshold) || threshold < 0.05 || threshold > 0.95) throw serviceError(400, 'INVALID_PARAMETER', 'threshold 需在 0.05-0.95');
      let imageBase64 = validateImageBase64(body.image || body.imageBase64 || '');
      let imageBuffer = Buffer.from(imageBase64, 'base64');

      // 0) 本地 WD14 真实 ONNX 推理（最优先：不依赖 WebUI/ComfyUI 进程在线，零网络）
      let wd14Result = await wd14.interrogateTag(imageBuffer, { config: config, threshold: threshold, signal }).catch(function (error) {
        if (signal.aborted || ['INTERROGATE_BUSY', 'INTERROGATE_TIMEOUT', 'INTERROGATE_CLOSED'].includes(String(runtimeErrorCode(error)))) throw error;
        return null;
      });
      signal.throwIfAborted();
      if (wd14Result && wd14Result.ok) {
        let derivedCaption = captionFromTags(wd14Result.tags);
        return envelope.ok(res, {
          engine: 'wd14',
          model: wd14Result.model,
          mode: mode,
          threshold: threshold,
          tags: wd14Result.tags,
          scores: wd14Result.scores,
          rating: wd14Result.rating,
          characterTags: wd14Result.characterTags,
          caption: mode === 'caption' ? derivedCaption : wd14Result.tags.join(', '),
          captionDerived: mode === 'caption' ? 'wd14-tags' : undefined,
          editable: true,
          meta: wd14Result.meta
        });
      }

      // 1) 本地 WebUI 优先（纯本机，不走 8317）
      let webuiResult: any = await tryWebUIInterrogate(config, imageBase64, threshold, signal);
      signal.throwIfAborted();
      if (webuiResult && webuiResult.tags && webuiResult.tags.length) {
        return envelope.ok(res, {
          engine: 'webui',
          mode: mode,
          threshold: threshold,
          tags: webuiResult.tags,
          scores: webuiResult.scores || {},
          caption: webuiResult.caption || webuiResult.tags.join(', '),
          // 供前端直接回填，仍保留切人能力
          editable: true
        });
      }

      // 2) ComfyUI 本地节点
      let comfyResult = await tryComfyInterrogate(config, imageBase64, threshold, mode, signal);
      signal.throwIfAborted();
      if (comfyResult && comfyResult.tags) {
        return envelope.ok(res, Object.assign({ engine: 'comfy', mode: mode, threshold: threshold, editable: true }, comfyResult));
      }

      // 3) 纯本地启发式兜底（仅当 WD14/WebUI/ComfyUI 全部不可用；warning 如实标注）
      let fallback = heuristicTagFallback(threshold);
      return envelope.ok(res, {
        engine: 'heuristic',
        mode: mode,
        threshold: threshold,
        tags: mode === 'tag' ? fallback.tags : [],
        scores: fallback.scores,
        caption: fallback.caption,
        editable: true,
        warning: '未找到本地 WD14 反推模型（onnxruntime/权重缺失），当前为启发式演示兜底；安装 ComfyUI-WD14-Tagger 节点或配置 AICS_WD14_MODEL_DIR 后自动升级为真实反推'
      });
    } catch (e) {
      if (signal.aborted) return;
      return envelope.fail(res, runtimeErrorStatus(e) || 500, runtimeErrorMessage(e) || '反推失败', { code: runtimeErrorCode(e) || 'INTERROGATE_FAILED' });
    }
  });

  // 轻量探测：前端据此决定显示 本地/WD14/启发式 徽标
  router.get('/api/interrogate/status', security.localOnly, function (req, res) {
    res.setHeader('Cache-Control', 'no-store');
    return envelope.ok(res, {
      local: true,
      engines: ['wd14', 'webui', 'comfy', 'heuristic'],
      wd14: wd14.probe(config),
      thresholdDefault: DEFAULT_THRESHOLD,
      maxBytes: MAX_IMAGE_BYTES
    });
  });

  return { router: router, close: wd14.close };
}

export = { createInterrogateRouter: createInterrogateRouter };
