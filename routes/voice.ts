'use strict';

import type { Response } from 'express-serve-static-core';
import type { TranslateRequest, TtsRequest, VoicePrepareRequest } from '../src/types/api';
import type { GatewayConfig } from '../server/config-types';
import { errorCode as runtimeErrorCode, errorField, errorMessage as runtimeErrorMessage } from '../scripts/lib/runtime-errors';

let express: typeof import('express') = require('express');
let httpClient: typeof import('../services/http-client') = require('../services/http-client');
let security: typeof import('../server/security') = require('../server/security');
let envelope: typeof import('../server/http-envelope') = require('../server/http-envelope');
let typedHandler: typeof import('../server/typed-route').typedHandler = require('../server/typed-route').typedHandler;
let createTranslationService = (require('../services/translation-service') as typeof import('../services/translation-service')).createTranslationService;
let createTtsService = (require('../services/tts-service') as typeof import('../services/tts-service')).createTtsService;

type VoiceConfig = Pick<GatewayConfig, 'TRANSLATE_URL' | 'TRANSLATE_PORT' | 'TRANSLATION_PYTHON' | 'TRANSLATION_SCRIPT' | 'TRANSLATION_LOG' | 'TTS_HOST' | 'VOICE_PROFILES'>;
type TranslationService = ReturnType<typeof createTranslationService>;
type TtsService = ReturnType<typeof createTtsService>;
interface VoiceRouterDependencies {
  translation?: TranslationService;
  tts?: TtsService;
}
function waitForDrain(res: Response) {
  return new Promise<void>(function (resolve, reject) {
    function cleanup() {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
    }
    function onDrain() { cleanup(); resolve(); }
    function onClose() { cleanup(); reject(httpClient.abortError()); }
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

async function relayAudio(source: AsyncIterable<unknown> | Iterable<unknown>, res: Response) {
  for await (let chunk of source) {
    if (res.destroyed || res.writableEnded) throw httpClient.abortError();
    let data = typeof chunk === 'string' || Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    if (!res.write(data)) await waitForDrain(res);
  }
}

// ── 流式播放支持（GET /api/tts）────────────────────────────────────────
// 公网访客配音慢的主因是前端等整段 WAV 下载完才播放。audio 元素直接指向
// GET 端点后浏览器对 PCM WAV 边下边播，播放开始只等"生成完 + 传输首块"。
// 服务端同时缓存最近生成的音频（按文本哈希）：重播/多访客说同一句直接
// 回放缓存，不再重复占用 GPU 队列。
let ttsAudioCache = new Map<string, Buffer>();
let TTS_CACHE_MAX_ENTRIES = 60;
// 2026-08-16 审计：缓存此前只按条数（60）淘汰，单句 WAV 数 MB → 常驻数百 MB。
// 增加总字节上限（128MB）双阈值淘汰；单条超上限时至少保留最新一条。
let TTS_CACHE_MAX_BYTES = 128 * 1024 * 1024;
let ttsAudioCacheBytes = 0;
// 正在生成中的句子：cacheKey -> Promise<Buffer>。客户端重试或多位访客
// 同时听到同一句时，直接共享同一次生成，不再重复占用 GPU 队列。
// 首个请求断开（signal abort）会连带中止共享生成；等待方会拿到 abort
// 后走客户端重试路径，不会出现同句双生成。
let inFlightTts = new Map<string, Promise<Buffer>>();

// 与前端 src/utils/stream.ts 的 fixWavHeader 等价：GPT-SoVITS 的 RIFF 长度
// 字段不可靠，修好后浏览器（含流式解码）才能稳定播放。
function fixWavHeaderServer(buffer: Buffer<ArrayBuffer>) {
  try {
    if (buffer.length < 44) return buffer;
    if (buffer.readUInt32BE(0) !== 0x52494646 || buffer.readUInt32BE(8) !== 0x57415645) return buffer;
    buffer.writeUInt32LE(buffer.length - 8, 4);
    let position = 12;
    while (position + 8 <= buffer.length) {
      let tag = buffer.readUInt32BE(position);
      let size = buffer.readUInt32LE(position + 4);
      if (tag === 0x64617461) { buffer.writeUInt32LE(buffer.length - position - 8, position + 4); break; }
      if (size > buffer.length || position + 8 + size > buffer.length + 1) break;
      position += 8 + size + (size % 2);
    }
  } catch (error) { /* 头损坏时原样返回，浏览器端还有兜底 */ }
  return buffer;
}

function cacheTtsAudio(key: string, buffer: Buffer) {
  const previous = ttsAudioCache.get(key);
  if (previous) {
    ttsAudioCacheBytes -= previous.length;
    ttsAudioCache.delete(key);
  }
  ttsAudioCache.set(key, buffer);
  ttsAudioCacheBytes += buffer.length;
  while ((ttsAudioCache.size > TTS_CACHE_MAX_ENTRIES || ttsAudioCacheBytes > TTS_CACHE_MAX_BYTES)
    && ttsAudioCache.size > 1) {
    let oldest = ttsAudioCache.keys().next().value;
    if (oldest === undefined) break;
    let removed = ttsAudioCache.get(oldest);
    if (!removed) break;
    ttsAudioCacheBytes -= removed.length;
    ttsAudioCache.delete(oldest);
  }
}

function createVoiceRouter(config: VoiceConfig, dependencies?: VoiceRouterDependencies) {
  const deps = dependencies || {};
  let router = express.Router();
  let translation = deps.translation || createTranslationService({
    url:config.TRANSLATE_URL,
    port:config.TRANSLATE_PORT,
    python:config.TRANSLATION_PYTHON,
    script:config.TRANSLATION_SCRIPT,
    logFile:config.TRANSLATION_LOG
  });
  let tts = deps.tts || createTtsService({
    host:config.TTS_HOST,
    profiles:config.VOICE_PROFILES
  });

  // 限流额度要按实时配音的真实节奏定：一条聊天回复会按句拆成多次
  // translate + tts，所以桶要足够大，只挡住持续滥用。本机直连不受限。
  let translateLimit = security.rateLimit({ capacity:40, refillMs:1000, label:'翻译' });
  let ttsLimit = security.rateLimit({ capacity:40, refillMs:1000, label:'语音合成' });
  let prepareLimit = security.rateLimit({ capacity:12, refillMs:2000, label:'声线预热' });

  router.post('/api/translate', translateLimit, express.json({ limit:'32kb' }), typedHandler<TranslateRequest>(function (req, res) {
    let text = String(req.body && req.body.text || '').trim();
    if (!text || text.length > 2000) {
      return envelope.fail(res, 400, '待翻译中文需在 1—2000 字之间。');
    }
    let controller = new AbortController();
    req.once('aborted', function () { controller.abort(); });
    res.once('close', function () { if (!res.writableEnded) controller.abort(); });

    translation.translate(text, controller.signal).then(function (result) {
      if (controller.signal.aborted || res.writableEnded) return;
      envelope.ok(res, {
        sourceLanguage:'zh',
        targetLanguage:'ja',
        translation:result.translation,
        segments:result.segments || []
      });
    }).catch(function (error) {
      if (httpClient.isAbortError(error) || controller.signal.aborted) return;
      if (!res.headersSent) envelope.fail(res, 503, runtimeErrorMessage(error) || '本地日语翻译暂不可用。');
    });
  }));

  router.get('/api/tts-status', typedHandler(function (_req, res) {
    tts.status().then(function (data) {
      res.setHeader('Cache-Control', 'no-store');
      res.json(Object.assign({}, data, { translation:translation.status() }));
    }).catch(function (error) {
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        online:false,
        engine:'GPT-SoVITS',
        voices:{ nene:false, natsume:false },
        queue:tts.queueStatus(),
        translation:translation.status(),
        error:runtimeErrorMessage(error)
      });
    });
  }));

  router.post('/api/voice/prepare', prepareLimit, express.json({ limit:'4kb' }), typedHandler<VoicePrepareRequest>(function (req, res) {
    let voice = String(req.body && req.body.voice || '');
    let needsTranslation = req.body && req.body.translation === true;
    if (!['nene', 'natsume'].includes(voice)) {
      return envelope.fail(res, 400, '不支持的角色声线');
    }

    let controller = new AbortController();
    req.once('aborted', function () { controller.abort(); });
    res.once('close', function () { if (!res.writableEnded) controller.abort(); });
    let started = Date.now();
    let tasks: Array<Promise<unknown>> = [tts.prepare(voice, controller.signal)];
    if (needsTranslation) tasks.push(translation.prepare(controller.signal));

    Promise.all(tasks).then(function () {
      if (controller.signal.aborted || res.writableEnded) return;
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok:true,
        voice:voice,
        translation:needsTranslation,
        prepareMs:Date.now() - started
      });
    }).catch(function (error) {
      if (httpClient.isAbortError(error) || controller.signal.aborted) return;
      if (!res.headersSent) {
        envelope.fail(res, envelope.statusFor(error, 503), runtimeErrorMessage(error) || '声线预热失败');
      }
    });
  }));

  router.post('/api/tts', ttsLimit, express.json({ limit:'32kb' }), typedHandler<TtsRequest>(function (req, res) {
    let validation = tts.validate(req.body);
    if (validation.error) return envelope.fail(res, validation.status, validation.error);

    let controller = new AbortController();
    req.once('aborted', function () { controller.abort(); });
    res.once('close', function () { if (!res.writableEnded) controller.abort(); });

    tts.stream(req.body, {
      signal:controller.signal,
      onResponse:async function (result) {
        if (controller.signal.aborted) throw httpClient.abortError();
        res.status(200);
        res.setHeader('Content-Type', result.contentType || 'audio/wav');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Voice-Queue-Wait', String(result.queueWaitMs || 0));
        res.flushHeaders();
        await relayAudio(result.response, res);
        if (!res.writableEnded) res.end();
      }
    }).catch(function (error) {
      if (httpClient.isAbortError(error) || controller.signal.aborted) return;
      if (!res.headersSent) {
        // 队列已满是 503（客户端可重试），不是 502（上游坏了）
        let code = runtimeErrorCode(error);
        let status = code === 'QUEUE_FULL' ? 503 : envelope.statusFor(error, 502);
        envelope.fail(res,
          status,
          code === 'QUEUE_FULL' ? '语音队列繁忙' : 'GPT-SoVITS 生成失败',
          { detail:errorField(error, 'detail') || runtimeErrorMessage(error), code:code || undefined });
      } else if (!res.writableEnded) {
        res.destroy(error instanceof Error ? error : new Error(runtimeErrorMessage(error)));
      }
    });
  }));

  // 流式播放端点：audio 元素直连（GET），浏览器对 WAV 边下边播。
  // 参数与 POST /api/tts 相同，长文本请走 POST（URL 长度限制）。
  router.get('/api/tts', ttsLimit, typedHandler(function (req, res) {
    let body = {
      voice:String(req.query.voice || ''),
      text:String(req.query.text || ''),
      language:String(req.query.language || 'ja'),
      emotion:String(req.query.emotion || 'neutral'),
      referenceEmotion:String(req.query.referenceEmotion || ''),
      consistency:String(req.query.consistency || 'adaptive'),
      speed:Number(req.query.speed || 1)
    };
    if (body.text.length > 1200) return envelope.fail(res, 413, '长文本请使用 POST /api/tts');
    let validation = tts.validate(body);
    if (validation.error) return envelope.fail(res, validation.status, validation.error);

    let cacheKey = [body.voice, body.language, body.text, body.emotion, body.referenceEmotion, body.consistency, body.speed].join('|');
    let cached = ttsAudioCache.get(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-TTS-Cache', 'hit');
      res.end(cached);
      return;
    }

    let controller = new AbortController();
    req.once('aborted', function () { controller.abort(); });
    res.once('close', function () { if (!res.writableEnded) controller.abort(); });

    function relayBufferedAudio(audio: Buffer) {
      if (res.destroyed || res.writableEnded) return;
      res.status(200);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      return relayAudio([audio], res);
    }

    let existing = inFlightTts.get(cacheKey);
    if (existing) {
      existing.then(function (audio) {
        res.setHeader('X-TTS-Cache', 'hit');
        return relayBufferedAudio(audio);
      }).then(function () {
        if (!res.writableEnded) res.end();
      }).catch(function (error) {
        if (httpClient.isAbortError(error) || controller.signal.aborted) {
          // 共享的生成被首个请求取消时，等待方不能悬挂连接：给一个明确的失败。
          if (!res.headersSent) res.status(502).end();
          else if (!res.writableEnded) res.destroy();
          return;
        }
        if (!res.headersSent) {
          let code = runtimeErrorCode(error);
          let status = code === 'QUEUE_FULL' ? 503 : envelope.statusFor(error, 502);
          envelope.fail(res,
            status,
            code === 'QUEUE_FULL' ? '语音队列繁忙' : 'GPT-SoVITS 生成失败',
            { detail:errorField(error, 'detail') || runtimeErrorMessage(error), code:code || undefined });
        } else if (!res.writableEnded) {
          res.destroy(error instanceof Error ? error : new Error(runtimeErrorMessage(error)));
        }
      });
      return;
    }

    let chunks: Buffer[] = [];
    // 2026-08-16 审计：共享生成改用独立 AbortController——此前挂在首个请求的
    // controller 上，首个访客断开会连带 abort 共享生成，所有等待方拿 502 且白耗
    // 一次 GPU。独立信号让生成照常完成并入缓存（重播直接命中）；单句成本有界
    // （上游 180s 超时兜底）；各等待方只与自己的断连解耦。
    let sharedController = new AbortController();
    let generation = tts.stream(body, {
      signal: sharedController.signal,
      onResponse:async function (result) {
        if (sharedController.signal.aborted) throw httpClient.abortError();
        for await (let chunk of result.response) { chunks.push(Buffer.from(chunk)); }
        if (sharedController.signal.aborted) throw httpClient.abortError();
      }
    }).then(function () {
      let audio = fixWavHeaderServer(Buffer.concat(chunks));
      if (audio.length < 64) throw new Error('语音服务返回空音频');
      cacheTtsAudio(cacheKey, audio);
      return audio;
    });
    inFlightTts.set(cacheKey, generation);
    generation.catch(function () {}).finally(function () {
      if (inFlightTts.get(cacheKey) === generation) inFlightTts.delete(cacheKey);
    });

    generation.then(function (audio) {
      res.setHeader('X-TTS-Cache', 'miss');
      return relayBufferedAudio(audio);
    }).then(function () {
      if (!res.writableEnded) res.end();
    }).catch(function (error) {
      if (httpClient.isAbortError(error) || controller.signal.aborted) return;
      if (!res.headersSent) {
        let code = runtimeErrorCode(error);
        let status = code === 'QUEUE_FULL' ? 503 : envelope.statusFor(error, 502);
        envelope.fail(res,
          status,
          code === 'QUEUE_FULL' ? '语音队列繁忙' : 'GPT-SoVITS 生成失败',
          { detail:errorField(error, 'detail') || runtimeErrorMessage(error), code:code || undefined });
      } else if (!res.writableEnded) {
        res.destroy(error instanceof Error ? error : new Error(runtimeErrorMessage(error)));
      }
    });
  }));

  return {
    router:router,
    tts:tts,
    translation:translation,
    close:function () { translation.close(); }
  };
}

export = {
  createVoiceRouter:createVoiceRouter,
  relayAudio:relayAudio
};
