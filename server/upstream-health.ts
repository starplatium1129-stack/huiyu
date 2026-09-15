'use strict';

/**
 * server/upstream-health.js — 本机上游 JSON 请求与健康探测收口（P3）。
 *
 * 此前同一份「本机 JSON 请求 + 响应体上限 + 超时」在 routes/control.js、
 * routes/generation.js、routes/anima.js 各有一份拷贝，SD/TTS/Comfy/Ollama
 * 的探活谓词也分散在各路由里。这里收敛为唯一实现：
 *   - requestJson：低层本机上游 JSON 请求（非 2xx 不 throw，返回 {status,data,raw}，
 *     探活与目录拉取共用）；响应体超限与网络错误才 reject。
 *   - pingSd / pingTts / pingComfy / pingOllamaDetail：各服务探活谓词，
 *     判定口径与迁移前逐字一致（SD/TTS 宽容 2xx-4xx，Comfy 严格 2xx）。
 *
 * 面向公网的上游请求（带代理/信封语义）继续走 services/http-client.ts；
 * 这里只服务本机回环上游，不走代理。
 */

let requestBuffered = (require('./buffered-request') as typeof import('./buffered-request')).requestBuffered;

let MAX_JSON_BYTES = 8 * 1024 * 1024;

async function requestJson<T = any>(baseUrl: string|URL|undefined, apiPath: string|URL, body?: any, timeoutMs?: number, maxBytes?: number): Promise<{ status: number; data: T | null; raw: string }> {
  const target = new URL(apiPath, baseUrl);
  const payload = body === null || body === undefined ? null : JSON.stringify(body);
  const response = await requestBuffered(target, {
    method: payload === null ? 'GET' : 'POST', body: payload,
    headers: payload === null ? {} : { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) },
    timeoutMs: timeoutMs || 4000, maxBytes: maxBytes || MAX_JSON_BYTES,
    makeError(kind: string|undefined, error) { return error || new Error(kind === 'tooLarge' ? 'response too large' : kind === 'aborted' ? 'upstream response aborted' : kind); },
  });
  const raw = response.body.toString('utf8');
  let data: T | null = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  return { status: response.status, data, raw };
}

function reachable(status: number) {
  return status >= 200 && status < 500;
}

function pingSd(urlStr: string|URL|undefined, timeoutMs?: number) {
  return requestJson(urlStr, '/sdapi/v1/sd-models', null, timeoutMs || 2500)
    .then(function (r) { return reachable(r.status); })
    .catch(function () { return false; });
}

function pingTts(urlStr: string|URL|undefined, timeoutMs?: number) {
  return requestJson(urlStr, '/docs', null, timeoutMs || 2500)
    .then(function (r) { return reachable(r.status); })
    .catch(function () {
      return requestJson(urlStr, '/', null, timeoutMs || 2500)
        .then(function (r) { return reachable(r.status); })
        .catch(function () { return false; });
    });
}

function pingComfy(urlStr: string|URL|undefined, timeoutMs?: number) {
  return requestJson(urlStr, '/system_stats', null, timeoutMs || 2500)
    .then(function (r) { return r.status >= 200 && r.status < 300; })
    .catch(function () { return false; });
}

function pingOllamaDetail(urlStr: string|URL|undefined, timeoutMs?: number) {
  return requestJson<{ models?: any }>(urlStr, '/api/ps', null, timeoutMs || 3000)
    .then(function (r) {
      if (!(r.status >= 200 && r.status < 300)) return { online: false, models: [], vram: 0 };
      let rawModels = r.data && r.data.models;
      let models = Array.isArray(rawModels) ? rawModels : [];
      let vram = 0;
      models.forEach(function (m) {
        let size = Number(m.size_vram || m.size || 0);
        if (Number.isFinite(size)) vram += size;
      });
      return {
        online: true,
        models: models.map(function (m) { return String(m.name || m.model || ''); }).filter(Boolean),
        vram: vram
      };
    })
    .catch(function () {
      return requestJson(urlStr, '/api/tags', null, timeoutMs || 3000)
        .then(function (r) { return { online: r.status === 200, models: [], vram: 0 }; })
        .catch(function () { return { online: false, models: [], vram: 0 }; });
    });
}

export = {
  requestJson: requestJson,
  pingSd: pingSd,
  pingTts: pingTts,
  pingComfy: pingComfy,
  pingOllamaDetail: pingOllamaDetail,
};

