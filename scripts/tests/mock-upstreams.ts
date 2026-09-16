'use strict';

import { IncomingMessage, ServerResponse } from 'node:http';

type JsonObject = Record<string, any>;
type MockState = { faults: JsonObject; latency: number; calls: any[]; };
type MockContext = { path: string; body: any; state: MockState; req: IncomingMessage; res: ServerResponse; };

function objectBody(value: any): JsonObject {
  return value && typeof value === 'object' ? value as JsonObject : {};
}

/**
 * scripts/tests/mock-upstreams.js
 *
 * 四个上游服务的可编程假实现：SD WebUI、Ollama、GPT-SoVITS、中日翻译。
 *
 * 为什么是「真 HTTP 服务器」而不是浏览器层 route mock：
 * 六条主流程里有五条会穿过网关代码（/sdapi 代理白名单、/api/chat 的 NDJSON
 * 中继、/api/tts 的音频背压中继、/api/translate 的常驻服务探测、
 * /api/tts-status 的声线判定）。在浏览器里拦 fetch 会把这些服务端逻辑整段
 * 跳过 —— 那样测出来的"流程通过"和真机行为脱钩，正是 2026-07-27 审计
 * 记录的那类假绿灯。
 *
 * 每个 mock 都记录收到的请求，并可通过 /__mock/* 注入故障，供 E2E 断言。
 */

let http: typeof import('http') = require('http');

/** 44 字节 WAV 头 + 一小段静音采样。useVoice 会拒收 < 64 字节的响应。 */
function silentWav(sampleCount: number) {
  let samples = Math.max(64, Number(sampleCount) || 512);
  let dataBytes = samples * 2;
  let buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);   // PCM
  buffer.writeUInt16LE(1, 22);   // mono
  buffer.writeUInt32LE(32000, 24);
  buffer.writeUInt32LE(64000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  // 一点极低振幅的波形，避免播放器把纯零当损坏文件
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(i / 12) * 24), 44 + i * 2);
  }
  return buffer;
}

/** 1×1 PNG。前端只把它转成 blob URL 塞进 <img>，内容无关紧要。 */
let PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk' +
  'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** Minimal ISO BMFF-shaped payload: enough for gateway signature/range tests. */
let MP4_MINIMAL = Buffer.concat([
  Buffer.from([0, 0, 0, 20]),
  Buffer.from('ftyp', 'ascii'),
  Buffer.from('isom', 'ascii'),
  Buffer.from([0, 0, 2, 0]),
  Buffer.from('isom', 'ascii'),
  Buffer.from([0, 0, 0, 8]),
  Buffer.from('free', 'ascii'),
]);

function readBody(req: IncomingMessage, limitBytes?: number): Promise<Buffer> {
  return new Promise<Buffer>(function (resolve, reject) {
    let chunks: Buffer[] = [];
    let size = 0;
    req.on('data', function (chunk: Buffer) {
      size += chunk.length;
      if (size > (limitBytes || 8 * 1024 * 1024)) {
        reject(new Error('mock upstream body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  let raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')) as Record<string, any>; } catch (error) { return {}; }
}

function sendJson(res: ServerResponse, status: number, payload: any) {
  let body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':Buffer.byteLength(body)
  });
  res.end(body);
}

function delay(ms: number) {
  return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, Number(ms) || 0)); });
}

/**
 * 每个 mock 共享的可编程外壳。
 *
 * `state.faults` 由 E2E 通过 POST /__mock/fault 设置，用于驱动错误恢复路径
 * （显存不足、上游 502、超时……）；`state.calls` 记录请求，供断言"网关到底
 * 转发了什么"，而不是只断言 UI 文案。
 */
function createMockServer(name: string, handler: (ctx: MockContext) => any) {
  let state = {
    name:name,
    calls: [] as any[],
    faults: {} as Record<string, any>,
    latency:0
  };

  function record(req: IncomingMessage, body: any) {
    state.calls.push({
      at:Date.now(),
      method:req.method,
      path:String(req.url || '').split('?')[0],
      query:String(req.url || '').split('?')[1] || '',
      body:body
    });
    if (state.calls.length > 200) state.calls.shift();
  }

  let server = http.createServer(function (req: IncomingMessage, res: ServerResponse) {
    let pathname = String(req.url || '/').split('?')[0];

    // ---- 控制面：清空记录 / 注入故障 / 读回记录 ----
    if (pathname === '/__mock/state' && req.method === 'GET') {
      return sendJson(res, 200, { name:name, calls:state.calls, faults:state.faults });
    }
    if (pathname === '/__mock/reset' && req.method === 'POST') {
      state.calls = [];
      state.faults = {};
      state.latency = 0;
      return sendJson(res, 200, { ok:true });
    }
    if (pathname === '/__mock/fault' && req.method === 'POST') {
      return readJsonBody(req).then(function (body) {
        state.faults = body && typeof body === 'object' ? body : {};
        if (Object.prototype.hasOwnProperty.call(state.faults, 'latency')) {
          state.latency = Number(state.faults.latency) || 0;
        }
        sendJson(res, 200, { ok:true, faults:state.faults });
      });
    }

    Promise.resolve()
      .then(function () {
        let needsBody = req.method === 'POST' || req.method === 'PUT';
        return needsBody ? readJsonBody(req) : null;
      })
      .then(async function (body) {
        record(req, body);
        if (state.latency) await delay(state.latency);
        return handler({ req:req, res:res, path:pathname, body:body, state:state });
      })
      .catch(function (error) {
        console.error('mock ' + name + ' handler error:', error && error.message || error);
        if (res.headersSent) { res.end(); return; }
        sendJson(res, 500, { error:'mock ' + name + ' failed: ' + error.message });
      });
  });

  return { server:server, state:state };
}

// ── SD WebUI ────────────────────────────────────────────────────────────────
function createSdMock() {
  return createMockServer('sd', async function (ctx) {
    let res = ctx.res;
    let faults = ctx.state.faults;

    if (faults.offline) { res.writeHead(503); res.end(); return; }

    if (ctx.path === '/sdapi/v1/sd-models') {
      if (faults.offline) { res.writeHead(503); res.end(); return; }
      return sendJson(res, 200, [
        { title:'waiIllustriousSDXL_v170.safetensors [abc123]', model_name:'waiIllustriousSDXL_v170' },
        { title:'animagineXL_v31.safetensors [def456]', model_name:'animagineXL_v31' }
      ]);
    }
    if (ctx.path === '/sdapi/v1/samplers') {
      return sendJson(res, 200, [{ name:'DPM++ 2M' }, { name:'DPM++ 2M Karras' }, { name:'Euler a' }, { name:'DPM++ SDE' }]);
    }
    if (ctx.path === '/sdapi/v1/schedulers') {
      return sendJson(res, 200, [{ name:'Karras', label:'Karras' }, { name:'Exponential', label:'Exponential' }]);
    }
    if (ctx.path === '/sdapi/v1/upscalers') {
      return sendJson(res, 200, [{ name:'R-ESRGAN 4x+ Anime6B' }, { name:'Latent' }]);
    }
    if (ctx.path === '/sdapi/v1/options') {
      return sendJson(res, 200, { sd_model_checkpoint:'waiIllustriousSDXL_v170.safetensors [abc123]' });
    }
    if (ctx.path === '/sdapi/v1/progress') {
      return sendJson(res, 200, { progress:0.42, state:{ job_count:1 }, current_image:null });
    }
    if (ctx.path === '/sdapi/v1/interrupt') {
      return sendJson(res, 200, {});
    }
    if (ctx.path === '/sdapi/v1/txt2img') {
      // 只慢 txt2img：进度轮询需要时间触发；出图瞬时返回的话请求永远测不到。
      // 一次都不会触发，"生成期间确实在轮询"就永远测不到。全局 latency 会把
      // 页面加载时的状态探测一起拖慢，所以单独一个开关。
      if (faults.renderMs) await delay(Number(faults.renderMs));
      if (faults.oom) {
        return sendJson(res, 500, {
          error:'OutOfMemoryError',
          detail:'CUDA out of memory. Tried to allocate 2.44 GiB'
        });
      }
      if (faults.txt2imgStatus) {
        return sendJson(res, Number(faults.txt2imgStatus), { error:String(faults.txt2imgError || 'mock failure') });
      }
      let body = objectBody(ctx.body);
      let seed = Number(body.seed);
      let resolved = Number.isFinite(seed) && seed >= 0 ? seed : 918273645;
      return sendJson(res, 200, {
        images:[PNG_1X1],
        parameters:body,
        info:JSON.stringify({ seed:resolved, all_seeds:[resolved], sampler_name:body.sampler_name })
      });
    }
    res.writeHead(404, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ error:'mock SD has no ' + ctx.path }));
  });
}

// ── ComfyUI ──────────────────────────────────────────────────────────────────
// 只模拟服务端 anima-service 会使用的内部端点；浏览器永远不应直接命中它。
function createComfyMock() {
  let jobs = new Map();
  let historyCalls = new Map();
  let nextId = 0;
  return createMockServer('comfy', async function (ctx) {
    let res = ctx.res;
    let faults = ctx.state.faults;

    if (ctx.path === '/system_stats') {
      if (faults.offline) return sendJson(res, 503, { error:'mock Comfy offline' });
      return sendJson(res, 200, { system:{ system: 'mock', device:'cpu' } });
    }

    if (ctx.path === '/prompt') {
      if (faults.promptStatus) {
        return sendJson(res, Number(faults.promptStatus), { error:String(faults.promptError || 'mock prompt failure') });
      }
      let promptId = 'mock-comfy-' + (++nextId);
      jobs.set(promptId, { createdAt:Date.now(), body:ctx.body, removed:false, interrupted:false });
      return sendJson(res, 200, { prompt_id:promptId });
    }

    if (ctx.path === '/queue' && ctx.req.method === 'GET') {
      if (faults.queueStatus) return sendJson(res, Number(faults.queueStatus), { error:'mock queue failure' });
      let now = Date.now();
      let renderWindow = Math.max(0, Number(faults.renderMs) || 50);
      let queueWindow = Math.min(renderWindow, Math.max(0, Number(faults.queueMs) || 10));
      let running: any[][] = [];
      let pending: any[][] = [];
      jobs.forEach(function (job, promptId) {
        if (job.removed || job.interrupted) return;
        let item = [0, promptId, job.body && job.body.prompt, {}, []];
        let age = now - job.createdAt;
        if (age < queueWindow) pending.push(item);
        else if (age < renderWindow) running.push(item);
      });
      return sendJson(res, 200, { queue_running:running, queue_pending:pending });
    }

    if (ctx.path === '/queue' && ctx.req.method === 'POST') {
      let body = objectBody(ctx.body);
      let deleted = Array.isArray(body.delete) ? body.delete : [];
      let deleteNow = Date.now();
      let deleteRenderWindow = Math.max(0, Number(faults.renderMs) || 50);
      let deleteQueueWindow = Math.min(deleteRenderWindow, Math.max(0, Number(faults.queueMs) || 10));
      deleted.forEach(function (promptId) {
        let job = jobs.get(String(promptId));
        if (job && deleteNow - job.createdAt < deleteQueueWindow) job.removed = true;
      });
      return sendJson(res, 200, { deleted:deleted });
    }

    if (ctx.path === '/free' && ctx.req.method === 'POST') {
      return sendJson(res, 200, { unload_models: true, free_memory: true });
    }

    let cancelMatch = ctx.path.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && ctx.req.method === 'POST') {
      if (faults.cancelStatus) return sendJson(res, Number(faults.cancelStatus), { error:'mock cancel failure' });
      let cancelPromptId = decodeURIComponent(cancelMatch[1]);
      let cancelledJob = jobs.get(cancelPromptId);
      if (!cancelledJob || cancelledJob.removed || cancelledJob.interrupted) {
        return sendJson(res, 200, { cancelled:false });
      }
      cancelledJob.interrupted = true;
      return sendJson(res, 200, { cancelled:true });
    }

    if (ctx.path === '/interrupt' && ctx.req.method === 'POST') {
      let interruptPromptId = objectBody(ctx.body).prompt_id;
      if (!interruptPromptId) return sendJson(res, 400, { error:'prompt_id required' });
      let interrupted = jobs.get(String(interruptPromptId));
      if (!interrupted || interrupted.removed) return sendJson(res, 200, { interrupted:false, prompt_id:interruptPromptId });
      interrupted.interrupted = true;
      return sendJson(res, 200, { interrupted:true, prompt_id:interruptPromptId });
    }

    let historyMatch = ctx.path.match(/^\/history\/([^/]+)$/);
    if (historyMatch) {
      let promptIdFromPath = decodeURIComponent(historyMatch[1]);
      let callsForJob = (historyCalls.get(promptIdFromPath) || 0) + 1;
      historyCalls.set(promptIdFromPath, callsForJob);
      let transient = Math.max(0, Number(faults.historyTransient) || 0);
      if (callsForJob <= transient) return sendJson(res, 503, { error:'mock transient history failure' });
      if (faults.historyStatus) return sendJson(res, Number(faults.historyStatus), { error:'mock history failure' });
      let job = jobs.get(promptIdFromPath);
      if (!job || job.removed) return sendJson(res, 200, {});
      if (job.interrupted) {
        return sendJson(res, 200, {
          [promptIdFromPath]: { status:{ status_str:'error', messages:[['execution_interrupted', 'cancelled']] } }
        });
      }
      if (faults.executionError) {
        return sendJson(res, 200, {
          [promptIdFromPath]: { status:{ status_str:'error', messages:[['execution_error', faults.executionError]] } }
        });
      }
      let renderMs = Math.max(0, Number(faults.renderMs) || 50);
      if (Date.now() - job.createdAt < renderMs) return sendJson(res, 200, {});
        let graph = job.body && job.body.prompt;
        let prefix = 'anima_app';
        let mediaKind = 'image';
        let outputNode = String(faults.resultNode || '10');
        if (graph && typeof graph === 'object') Object.keys(graph).some(function (id) {
          let node = graph[id];
          if (node && node.class_type === 'SaveImage' && node.inputs && typeof node.inputs.filename_prefix === 'string') {
            prefix = node.inputs.filename_prefix;
            outputNode = String(faults.resultNode || id);
            return true;
          }
          if (node && node.class_type === 'SaveVideo' && node.inputs && typeof node.inputs.filename_prefix === 'string') {
            prefix = node.inputs.filename_prefix;
            mediaKind = 'video';
            outputNode = String(faults.resultNode || id);
            return true;
          }
          return false;
        });
        let image = faults.resultImage && typeof faults.resultImage === 'object'
          ? faults.resultImage
          : { filename:prefix + (mediaKind === 'video' ? '_mock.mp4' : '_mock.png'), subfolder:'', type:'output' };
       return sendJson(res, 200, {
        [promptIdFromPath]: {
          status:{ status_str:'success' },
           outputs:{ [outputNode]:{ images:[image] } }
        }
      });
    }

    if (ctx.path === '/view') {
      if (faults.viewStatus) return sendJson(res, Number(faults.viewStatus), { error:'mock view failure' });
      let requestedUrl = new URL(ctx.req.url || '/', 'http://127.0.0.1');
      if (/\.mp4$/i.test(requestedUrl.searchParams.get('filename') || '')) {
        res.writeHead(200, {
          'Content-Type':'video/mp4',
          'Content-Length':MP4_MINIMAL.length,
          'Cache-Control':'no-store'
        });
        return res.end(MP4_MINIMAL);
      }
      let imageBody = Buffer.from(PNG_1X1, 'base64');
      res.writeHead(200, {
        'Content-Type':'image/png',
        'Content-Length':imageBody.length,
        'Cache-Control':'no-store'
      });
      return res.end(imageBody);
    }

    // These responses make accidental direct/root access observable in tests.
    if (ctx.path === '/queue' || ctx.path === '/interrupt' || ctx.path.indexOf('/object_info') === 0) {
      return sendJson(res, 200, { ok:true });
    }
    return sendJson(res, 404, { error:'mock Comfy has no ' + ctx.path });
  });
}

// ── Ollama ──────────────────────────────────────────────────────────────────
function createOllamaMock() {
  return createMockServer('ollama', async function (ctx) {
    let res = ctx.res;
    let faults = ctx.state.faults;

    if (ctx.path === '/api/tags') {
      if (faults.offline) { res.writeHead(503); res.end(); return; }
      return sendJson(res, 200, {
        models:[
          { name:'qwen3:8b', model:'qwen3:8b', size:5_200_000_000, capabilities:['completion'],
            details:{ parameter_size:'8B', quantization_level:'Q4_K_M' } },
          { name:'gemma3:4b', model:'gemma3:4b', size:3_100_000_000, capabilities:['completion'],
            details:{ parameter_size:'4B', quantization_level:'Q4_0' } }
        ]
      });
    }
    if (ctx.path === '/api/ps') {
      return sendJson(res, 200, { models:[{ name:'qwen3:8b', size_vram:5_200_000_000 }] });
    }
    if (ctx.path === '/api/generate') {
      return sendJson(res, 200, { done:true });
    }
    if (ctx.path === '/api/chat') {
      if (faults.chatStatus) {
        return sendJson(res, Number(faults.chatStatus), { error:String(faults.chatError || 'mock chat failure') });
      }
      // 逐句流式返回，让配音管线（SentenceBuffer）真的被触发
      let reply = String(faults.reply ||
        '今天也辛苦了。要不要先休息一下？如果你愿意，我可以陪你安静待一会儿。');
      res.writeHead(200, {
        'Content-Type':'application/x-ndjson; charset=utf-8',
        'Cache-Control':'no-store'
      });
      let chars = Array.from(reply);
      for (let i = 0; i < chars.length; i += 3) {
        res.write(JSON.stringify({
          model:objectBody(ctx.body).model || 'qwen3:8b',
          message:{ role:'assistant', content:chars.slice(i, i + 3).join('') },
          done:false
        }) + '\n');
        // latency 既作整体前置延迟，也作逐 token 间隔：慢速流式才测得到
        // 流中状态（如情绪标签驱动的表情窗口）。
        await delay(ctx.state.latency || 4);
      }
      res.write(JSON.stringify({ done:true, done_reason:'stop' }) + '\n');
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ error:'mock Ollama has no ' + ctx.path }));
  });
}

// ── GPT-SoVITS ──────────────────────────────────────────────────────────────
function createTtsMock() {
  return createMockServer('tts', async function (ctx) {
    let res = ctx.res;
    let faults = ctx.state.faults;

    if (ctx.path === '/docs' || ctx.path === '/') {
      if (faults.offline) { res.destroy(); return; }
      res.writeHead(200, { 'Content-Type':'text/html' });
      res.end('<html><body>mock GPT-SoVITS</body></html>');
      return;
    }
    if (ctx.path === '/set_gpt_weights' || ctx.path === '/set_sovits_weights') {
      return sendJson(res, 200, { ok:true });
    }
    if (ctx.path === '/tts') {
      if (faults.ttsStatus) {
        return sendJson(res, Number(faults.ttsStatus), { error:String(faults.ttsError || 'mock tts failure') });
      }
      if (faults.emptyAudio) {
        res.writeHead(200, { 'Content-Type':'audio/wav' });
        res.end();
        return;
      }
      let wav = silentWav(1024);
      res.writeHead(200, { 'Content-Type':'audio/wav', 'Content-Length':wav.length });
      res.end(wav);
      return;
    }
    res.writeHead(404, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ error:'mock TTS has no ' + ctx.path }));
  });
}

// ── 中日翻译常驻服务 ─────────────────────────────────────────────────────────
function createTranslateMock() {
  return createMockServer('translate', async function (ctx) {
    let res = ctx.res;
    let faults = ctx.state.faults;

    if (ctx.path === '/health') {
      if (faults.offline) { res.destroy(); return; }
      return sendJson(res, 200, { ok:true });
    }
    if (ctx.path === '/translate') {
      if (faults.translateStatus) {
        return sendJson(res, Number(faults.translateStatus), { error:'mock translate failure' });
      }
      let text = String(objectBody(ctx.body).text || '');
      // 固定前缀 + 原文长度，方便断言"译文真的来自上游"而不是前端兜底
      return sendJson(res, 200, {
        translation:'[JA] ' + text,
        segments:[{ source:text, target:'[JA] ' + text }]
      });
    }
    res.writeHead(404, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ error:'mock translate has no ' + ctx.path }));
  });
}

function listen(server: import('node:http').Server, port: number, host?: string): Promise<import('node:net').AddressInfo | string | null> {
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(port, host || '127.0.0.1', function () { resolve(server.address()); });
  });
}

export = {
  createSdMock:createSdMock,
  createComfyMock:createComfyMock,
  createOllamaMock:createOllamaMock,
  createTtsMock:createTtsMock,
  createTranslateMock:createTranslateMock,
  createMockServer:createMockServer,
  silentWav:silentWav,
  listen:listen,
  PNG_1X1:PNG_1X1
};
