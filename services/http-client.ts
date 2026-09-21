'use strict';

import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import { resolvePublicAddress } from './public-upstream';
import type { IncomingMessage, ClientRequest } from 'http';

interface UpstreamErrorOptions {
  code?: string;
  status?: number;
  detail?: string;
}

class UpstreamError extends Error {
  code: string;
  status: number;
  detail: string;

  constructor(message: string, options?: UpstreamErrorOptions) {
    super(message);
    this.name = 'UpstreamError';
    this.message = message;
    this.code = (options && options.code) || 'UPSTREAM_ERROR';
    this.status = (options && options.status) || 0;
    this.detail = (options && options.detail) || '';
    if (Error.captureStackTrace) Error.captureStackTrace(this, UpstreamError);
  }
}

interface AbortError extends Error {
  code: string;
}

interface RequestOptions {
  publicOnly?: boolean;
  method?: string;
  headers?: Record<string, string | number | string[] | undefined>;
  json?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  timeoutMessage?: string;
  limit?: number;
}

interface RequestResult {
  request: ClientRequest;
  response: IncomingMessage;
  url: string;
}

interface SuccessBody {
  body: Buffer;
  contentType: string;
}

interface ProxyConfig {
  host: string;
  port: number;
  auth?: string;
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// 上游直连连接池（2026-08-21 性能审计 #7）：显式 keep-alive agent 复用回环
// TCP 连接（SD WebUI / ComfyUI / Ollama 高频探测与任务提交），不再依赖 Node
// 全局 agent 默认值；timeout 让空闲 socket 解除引用并按需回收。
// 注意：代理路径（CONNECT 隧道 + 手动 TLS）每请求仍新建隧道——复用需要自维护
// 隧道池且要处理半关 socket，风险大于收益，维持现状。
const DIRECT_AGENT_OPTIONS = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 32, timeout: 60000 };
const DIRECT_HTTP_AGENT = new http.Agent(DIRECT_AGENT_OPTIONS);
const DIRECT_HTTPS_AGENT = new https.Agent(DIRECT_AGENT_OPTIONS);

/**
 * 解析代理环境变量（HTTP_PROXY/HTTPS_PROXY/ALL_PROXY，支持小写变体）。
 * 只接受 http:// 代理（常见本地 Clash/v2ray 场景），其它协议视为无效。
 */
function parseProxyEnv(value: string | undefined): ProxyConfig | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : 'http://' + trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  const host = url.hostname || '';
  const port = url.port ? Number(url.port) : 8080;
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const auth = url.username || url.password
    ? (url.username ? encodeURIComponent(url.username) : '') + ':' + (url.password ? encodeURIComponent(url.password) : '')
    : undefined;
  return { host, port, auth };
}

/**
 * NO_PROXY 匹配：条目支持精确 host、.example.com / *.example.com 通配子域、
 * host:port；"*" 表示全部绕过。本地回环地址无条件绕过。
 */
function matchesNoProxy(host: string, noProxy: string | undefined): boolean {
  if (!host) return true;
  if (LOCAL_HOSTS.has(host)) return true;
  if (!noProxy) return false;
  const parts = noProxy.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.includes('*')) return true;
  const hostLower = host.toLowerCase();
  for (const part of parts) {
    let p = part.toLowerCase();
    if (p.includes('://')) {
      try { p = new URL(p).hostname; } catch { p = ''; }
    }
    if (!p) continue;
    if (p.startsWith('.')) p = p.slice(1);
    if (p.startsWith('*.')) p = p.slice(2);
    const portIdx = p.lastIndexOf(':');
    if (portIdx > 0 && !p.includes(']')) p = p.slice(0, portIdx);
    if (!p) continue;
    if (hostLower === p || hostLower.endsWith('.' + p)) return true;
  }
  return false;
}

/** 按目标协议挑选代理；NO_PROXY 命中或未配置时返回 null（直连）。 */
function resolveProxy(target: URL): ProxyConfig | null {
  if (matchesNoProxy(target.hostname, process.env.NO_PROXY || process.env.no_proxy)) return null;
  const envValue = target.protocol === 'https:'
    ? (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy)
    : (process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy);
  return parseProxyEnv(envValue);
}

function abortError(message?: string): AbortError {
  const error = new Error(message || 'Request aborted') as AbortError;
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: string; code?: string };
  return value.name === 'AbortError' || value.code === 'ABORT_ERR';
}

async function request(baseUrl: string, pathname: string, options?: RequestOptions): Promise<RequestResult> {
  const opts = options || {};
  // Pin checked DNS answers; neither proxy DNS nor pooled sockets may bypass validation.
  const publicAddress = opts.publicOnly ? await resolvePublicAddress(new URL(pathname, baseUrl)) : null;
  return new Promise(function (resolve, reject) {
    let target: URL;
    try {
      target = new URL(pathname, baseUrl);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reject(new UpstreamError('Invalid upstream URL', { code: 'INVALID_URL', detail: detail }));
      return;
    }

    if (opts.signal && opts.signal.aborted) {
      reject(abortError());
      return;
    }

    const payload = opts.json === undefined ? null : JSON.stringify(opts.json);
    const headers: Record<string, string | number | string[] | undefined> = Object.assign({}, opts.headers || {});
    if (payload !== null) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const method = opts.method || (payload === null ? 'GET' : 'POST');
    const timeoutMs = opts.timeoutMs || 15000;
    const timeoutMessage = opts.timeoutMessage || 'Upstream request timed out';

    let settled = false;
    let responseRef: IncomingMessage | null = null;
    let req: ClientRequest | null = null;
    let connectReq: ClientRequest | null = null;
    const deadline = opts.totalTimeoutMs ? setTimeout(() => {
      const error = new UpstreamError('Upstream total deadline exceeded', { code: 'UPSTREAM_DEADLINE' });
      req?.destroy(error);
      connectReq?.destroy(error);
      responseRef?.destroy(error);
      if (!settled) reject(error);
      cleanupAbort();
    }, opts.totalTimeoutMs) : null;
    deadline?.unref();

    function onResponse(response: IncomingMessage) {
      settled = true;
      responseRef = response;
      response.once('close', cleanupAbort);
      resolve({ request: req as ClientRequest, response: response, url: target.toString() });
    }

    function onAbort() {
      if (req && !req.destroyed) req.destroy(abortError());
      else if (connectReq && !connectReq.destroyed) connectReq.destroy(abortError());
    }
    function cleanupAbort() {
      if (deadline) clearTimeout(deadline);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }

    function attachResponse(clientReq: ClientRequest) {
      req = clientReq;
      clientReq.setTimeout(timeoutMs, function () {
        clientReq.destroy(new UpstreamError(timeoutMessage, { code: 'UPSTREAM_TIMEOUT' }));
      });
      clientReq.on('error', function (error) {
        cleanupAbort();
        if (!settled) {
          reject(error);
          return;
        }
        // 响应头已发出（流式场景）：不能静默吞掉 socket 错误，
        // 否则 TTS 音频流 / SSE 聊天流中途断连时调用方只看到"流提前结束"，
        // 无法区分正常结束与上游截断。把错误传给 response 流，让
        // for await / data 读取方能感知并抛给调用方的 catch。
        if (responseRef && !responseRef.destroyed && !responseRef.complete) {
          responseRef.destroy(error);
        }
      });
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
      clientReq.end(payload === null ? undefined : payload);
    }

    const proxy = opts.publicOnly ? null : resolveProxy(target);
    if (!proxy) {
      const transport = target.protocol === 'https:' ? https : http;
      const agent = target.protocol === 'https:' ? DIRECT_HTTPS_AGENT : DIRECT_HTTP_AGENT;
      const direct = transport.request(target, {
        method: method, headers: headers, agent: publicAddress ? false : agent,
        ...(publicAddress ? { lookup: (_hostname, _options, callback) => {
          if (typeof _options === 'object' && _options.all) callback(null, [publicAddress]);
          else callback(null, publicAddress.address, publicAddress.family);
        } } : {})
      }, onResponse);
      attachResponse(direct);
      return;
    }

    // 代理路径：http 目标走正向代理（path 为完整 URL）；
    // https 目标先 CONNECT 隧道，再在隧道 socket 上做 TLS。
    const proxyAuth = proxy.auth
      ? 'Basic ' + Buffer.from(proxy.auth).toString('base64')
      : undefined;

    if (target.protocol !== 'https:') {
      const proxied = http.request({
        host: proxy.host,
        port: proxy.port,
        path: target.toString(),
        method: method,
        headers: proxyAuth ? Object.assign({ 'Proxy-Authorization': proxyAuth }, headers) : headers
      }, onResponse);
      attachResponse(proxied);
      return;
    }

    const connect = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: target.hostname + ':' + (target.port || '443'),
      headers: proxyAuth ? { 'Proxy-Authorization': proxyAuth } : undefined
    });
    connectReq = connect;
    connect.setTimeout(timeoutMs, function () {
      connect.destroy(new UpstreamError(timeoutMessage, { code: 'UPSTREAM_TIMEOUT' }));
    });
    connect.on('error', function (error) {
      cleanupAbort();
      if (!settled) reject(error);
    });
    connect.on('connect', function (res, socket) {
      connectReq = null;
      if (!res || res.statusCode !== 200) {
        socket.destroy();
        cleanupAbort();
        if (!settled) {
          reject(new UpstreamError('Proxy CONNECT failed with ' + (res && res.statusCode || 0), {
            code: 'UPSTREAM_STATUS',
            status: (res && res.statusCode) || 502
          }));
        }
        return;
      }
      try {
        // https.request 对"已连接"的 socket 不会自动做 TLS 握手（会直接发明文），
        // 因此先手动 tls.connect 包装成 TLS socket 再交给请求层；
        // 握手是异步的，https.request 监听的 secureConnect 事件不会错过。
        const tlsSocket = tls.connect({
          socket: socket,
          servername: target.hostname
        });
        const secureReq = https.request({
          host: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method: method,
          headers: headers,
          createConnection: function () { return tlsSocket; }
        }, onResponse);
        attachResponse(secureReq);
      } catch (error) {
        socket.destroy();
        cleanupAbort();
        if (!settled) reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    connect.end();
  });
}

async function readBody(response: IncomingMessage, limit?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const max = limit || 2 * 1024 * 1024;
  for await (const chunk of response) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > max) {
      response.destroy();
      throw new UpstreamError('Upstream response exceeded the size limit', { code: 'RESPONSE_TOO_LARGE' });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJson(baseUrl: string, pathname: string, options?: RequestOptions): Promise<unknown> {
  const opts = options || {};
  const result = await request(baseUrl, pathname, opts);
  const body = await readBody(result.response, opts.limit);
  const statusCode = result.response.statusCode || 0;
  if (statusCode < 200 || statusCode >= 300) {
    throw new UpstreamError('Upstream returned ' + statusCode, {
      code: 'UPSTREAM_STATUS',
      status: statusCode,
      detail: body.toString('utf8').slice(0, 500)
    });
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UpstreamError('Upstream returned invalid JSON', { code: 'INVALID_JSON', detail: detail });
  }
}

async function expectSuccess(baseUrl: string, pathname: string, options?: RequestOptions): Promise<SuccessBody> {
  const opts = options || {};
  const result = await request(baseUrl, pathname, opts);
  const body = await readBody(result.response, opts.limit || 1024 * 1024);
  const statusCode = result.response.statusCode || 0;
  if (statusCode < 200 || statusCode >= 300) {
    throw new UpstreamError('Upstream returned ' + statusCode, {
      code: 'UPSTREAM_STATUS',
      status: statusCode,
      detail: body.toString('utf8').slice(0, 500)
    });
  }
  return {
    body: body,
    contentType: result.response.headers['content-type'] || 'application/octet-stream'
  };
}

export = {
  UpstreamError: UpstreamError,
  abortError: abortError,
  isAbortError: isAbortError,
  request: request,
  readBody: readBody,
  readJson: readJson,
  expectSuccess: expectSuccess,
  parseProxyEnv: parseProxyEnv,
  matchesNoProxy: matchesNoProxy,
  resolveProxy: resolveProxy
};
