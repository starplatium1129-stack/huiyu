'use strict';

import type { IncomingHttpHeaders } from 'node:http';
import type { Request, RequestHandler, NextFunction } from 'express';

interface SecurityRequest {
  socket?: { remoteAddress?: string | null };
  headers: IncomingHttpHeaders;
  method?: string;
}
interface HeaderWriter { setHeader(name: string, value: string): any }
interface BucketOptions { capacity?: any; refillMs?: any }

let crypto: typeof import('crypto') = require('crypto');
let envelope: typeof import('./http-envelope') = require('./http-envelope');

function tokenMatches(expectedToken: string, value: any) {
  if (typeof value !== 'string') return false;
  let actual = Buffer.from(value);
  let expected = Buffer.from(expectedToken);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function isDirectLocalRequest(req: SecurityRequest) {
  let address = req.socket && req.socket.remoteAddress || '';
  let loopback = address.startsWith('127.') || address === '::1' || /^::ffff:127\.\d+\.\d+\.\d+$/.test(address);
  let forwarded = ['cf-connecting-ip', 'x-forwarded-for', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']
    .some(function (name) { return Object.prototype.hasOwnProperty.call(req.headers, name); });
  return loopback && !forwarded && hasLocalBrowserOrigin(req);
}

// 外站表单也能直连 localhost；Host 白名单不能替代浏览器来源检查。
// 允许本机不同端口，保留 Vite 开发代理与桌面入口；原生命令行无 Origin 仍可用。
function hasLocalBrowserOrigin(req: SecurityRequest) {
  if (Object.prototype.hasOwnProperty.call(req.headers, 'origin')) {
    try {
      if (typeof req.headers.origin !== 'string') return false;
      let origin = new URL(req.headers.origin);
      if (origin.username || origin.password || (origin.pathname && origin.pathname !== '/') || origin.search || origin.hash) return false;
      if (origin.protocol === 'tauri:') return origin.hostname === 'localhost';
      return (origin.protocol === 'http:' || origin.protocol === 'https:') &&
        (LOOPBACK_HOSTNAMES.indexOf(origin.hostname) !== -1 || origin.hostname === 'tauri.localhost');
    } catch (error) { return false; }
  }
  if (req.headers['sec-fetch-site'] !== 'cross-site') return true;
  // 从其他页面点击本机链接仍可打开界面，跨站子资源与写操作不可借用本机权限。
  return req.headers['sec-fetch-mode'] === 'navigate' && /^(GET|HEAD)$/.test(req.method || 'GET');
}

// 成人内容服务端锚点（2026-08-28）：本机直连默认授权（AGENTS.md 红线 #4，
// 本机 adult 默认开启）；隧道/远程访问默认拒绝成人参数 —— 请求体自报
// adultEnabled 不再单独构成授权。分享链接给朋友的场景需在服务端显式
// AICS_ADULT_REMOTE=1 开启后重启网关；桌面端 /api/desktop-tools 路径本身
// 已被 localOnly + chat.js 双防线覆盖，不依赖此开关。
function adultRemoteEnabled() {
  return process.env.AICS_ADULT_REMOTE === '1';
}

// 唯一的 localOnly 中间件。routes/control.js 与 routes/maintenance.js 都必须用这一份 ——
// 曾经各自复制过一份，其中 control.js 的版本只比对 req.ip，隧道一开就全部失效。
function localOnly(req: SecurityRequest, res: Parameters<typeof envelope.fail>[0], next: NextFunction) {
  if (!isDirectLocalRequest(req)) return envelope.fail(res, 403, '该操作仅限本机使用');
  next();
}

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '::1', '[::1]'];

// 上游 host（SD / TTS / Ollama）只允许指向本机 http。
// 未校验时这里是 SSRF；又因为值会落盘、而代理构造时读它，重启后会变成通用开放代理。
function safeLocalUrl(value: any) {
  let raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch (error) { return ''; }
  if (url.protocol !== 'http:') return '';
  if (LOOPBACK_HOSTNAMES.indexOf(url.hostname.toLowerCase()) === -1) return '';
  if (url.username || url.password) return '';
  if (url.port && !(Number(url.port) >= 1 && Number(url.port) <= 65535)) return '';
  return url.origin;
}

// Host 白名单：阻断 DNS rebinding。
// 本机请求可以免 token，且同源 GET 未必带 Origin，所以若不校验 Host，
// 用户访问的任意网页都能把域名 rebind 到 127.0.0.1，进而以「本机」身份调用控制接口。
// 只校验 hostname，不校验端口：rebinding 攻击靠的是把域名解析到 127.0.0.1，
// 端口本来就是攻击者已知的；而比对端口会误杀挂在其他 listener 上的合法访问（含测试）。
function hostAllowed(hostHeader: any, port?: any, tunnelHost?: string) {
  let host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return false;
  let withoutPort = host.replace(/:\d+$/, '');
  if (withoutPort === '127.0.0.1' || withoutPort === 'localhost' ||
      withoutPort === '[::1]' || withoutPort === '::1') return true;
  if (tunnelHost) {
    let allowedTunnel = String(tunnelHost).toLowerCase().replace(/:\d+$/, '');
    if (withoutPort === allowedTunnel) return true;
  }
  return false;
}

function hostGuard(config: any, getTunnelUrl?: () => string): RequestHandler {
  return function (req, res, next) {
    let tunnelHost = '';
    try { tunnelHost = tunnelHostFromUrl(getTunnelUrl && getTunnelUrl()); } catch (error) {}
    if (hostAllowed(req.headers.host, config.PORT, tunnelHost)) return next();
    return envelope.fail(res, 421, 'Misdirected Request — Host 不在允许列表内');
  };
}

// HTTP 与 WebSocket 共用 URL → Host 转换，避免升级路径把 https:// 当域名比较。
function tunnelHostFromUrl(value?: string | URL) {
  try { return value ? new URL(value).host : ''; } catch (error) { return ''; }
}

/**
 * GPU 路由限流（token bucket）。
 *
 * 威胁模型：隧道一开，分享链接持有者能无限提交 txt2img / chat / tts。
 * SerialQueue 的 maxPending 只挡住"堆积"，挡不住"持续以队列消化速度提交"——
 * 那会把 GPU 永久占满，而本机用户看到的只是"一直在排队"。
 *
 * 直连本机（也就是电脑主人）不限流：他跟 GPU 的关系不是敌对的。
 * 隧道来的请求共用一个桶 —— 按 IP 分桶没有意义，cloudflared 转出来的
 * socket 全是 127.0.0.1，而 x-forwarded-for 是客户端可伪造的。
 */
function createTokenBucket(options?: BucketOptions) {
  let capacity = Math.max(1, Number(options && options.capacity) || 10);
  let refillMs = Math.max(1, Number(options && options.refillMs) || 1000);
  let tokens = capacity;
  let updatedAt = Date.now();

  function refill() {
    let now = Date.now();
    let gained = Math.floor((now - updatedAt) / refillMs);
    if (gained <= 0) return;
    tokens = Math.min(capacity, tokens + gained);
    updatedAt = now - ((now - updatedAt) % refillMs);
  }

  return {
    /** 取一个令牌；取不到时返回建议的重试秒数 */
    take:function () {
      refill();
      if (tokens > 0) {
        tokens -= 1;
        if (tokens === capacity - 1) updatedAt = Date.now();
        return { ok:true };
      }
      return { ok:false, retryAfterSeconds:Math.ceil(refillMs / 1000) };
    },
    state:function () { refill(); return { tokens:tokens, capacity:capacity }; }
  };
}

function rateLimit(options?: BucketOptions & { label?: string }): RequestHandler {
  let bucket = createTokenBucket(options);
  let label = (options && options.label) || '该接口';
  return function (req, res, next) {
    if (isDirectLocalRequest(req)) return next();
    let result = bucket.take();
    if (result.ok) return next();
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    return envelope.fail(res, 429, label + '请求过于频繁，请稍后再试', {
      code:'RATE_LIMITED',
      retryAfterSeconds:result.retryAfterSeconds
    });
  };
}

function normalizeRequestPath(pathValue?: any) {
  let value = String(pathValue || '/');
  let q = value.indexOf('?');
  if (q >= 0) value = value.slice(0, q);
  if (value.length > 1 && value.charAt(value.length - 1) === '/') value = value.slice(0, -1);
  return value || '/';
}

function buildContentSecurityPolicy(pathValue?: any) {
  let path = normalizeRequestPath(pathValue);
  // Live2D（PixiJS）需要 unsafe-eval 才能编译着色器。
  // 只对角色房间与桌宠放行；其他页面继续使用严格脚本策略。
  // 导致 Live2D 报 "Current environment does not allow unsafe-eval"。
  let live2dPage = path === '/chat' || path === '/companion';
  let scriptSrc = "'self'";
  if (live2dPage) scriptSrc += " 'unsafe-eval'";
  return "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' data: blob:; " +
    'script-src ' + scriptSrc + '; ' +
    "style-src 'self' 'unsafe-inline'; " +
    // 字体已本地自托管（@fontsource），不再放行 Google Fonts
    "font-src 'self' data:; " +
    "connect-src 'self' data: blob: https:; " +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
}

function responseHeaders(req: Pick<Request, 'path'>, res: HeaderWriter, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  let voicePage = ['/chat', '/companion', '/companion-chat'].indexOf(normalizeRequestPath(req.path)) !== -1;
  res.setHeader('Permissions-Policy', 'camera=(), microphone=' + (voicePage ? '(self)' : '()') + ', geolocation=()');
  res.setHeader('Content-Security-Policy', buildContentSecurityPolicy(req.path));
  next();
}

function tokenAuth(token: string): RequestHandler {
  return function (req, res, next) {
    if (isDirectLocalRequest(req)) return next();
    let cookieMatch = (req.headers.cookie || '').match(/(?:^|;\s*)aics_token=([^;]+)/);
    let supplied = req.query.token || req.headers['x-token'] || cookieMatch && cookieMatch[1];
    if (tokenMatches(token, supplied)) {
      if (req.query.token) {
        let secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Set-Cookie',
          'aics_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400' + (secure ? '; Secure' : ''));
        let cleanUrl = new URL(req.originalUrl, 'http://localhost');
        cleanUrl.searchParams.delete('token');
        return res.redirect(302, cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
      }
      return next();
    }
    if (req.path.startsWith('/sdapi') || req.path.startsWith('/controlnet') ||
        req.path.startsWith('/adetailer') || req.path.startsWith('/comfy') ||
        req.path.startsWith('/api/')) {
      return envelope.fail(res, 401, 'Unauthorized — 缺少 token 参数');
    }
    return res.status(403).send(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>绘遇 · HUIYU</title>' +
      '<style>body{background:#1a1a2e;color:#e8e8f0;font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}' +
      '.card{background:#2a2a40;border-radius:16px;padding:40px;max-width:480px;text-align:center}h1{margin-top:0;color:#f06292}' +
      'code{color:#90caf9}</style></head><body><div class="card">' +
      '<h1>绘遇 · HUIYU</h1><p>请使用包含 token 的链接访问，格式：</p>' +
      '<code>http://地址:端口/?token=你的token</code>' +
      '<p style="margin-top:24px;color:#a8a8c0">朋友分享的链接中应当已经包含 token。</p>' +
      '</div></body></html>');
  };
}

export = {
  tokenMatches:tokenMatches,
  isDirectLocalRequest:isDirectLocalRequest,
  adultRemoteEnabled:adultRemoteEnabled,
  localOnly:localOnly,
  safeLocalUrl:safeLocalUrl,
  hostAllowed:hostAllowed,
  hostGuard:hostGuard,
  tunnelHostFromUrl:tunnelHostFromUrl,
  createTokenBucket:createTokenBucket,
  rateLimit:rateLimit,
  normalizeRequestPath:normalizeRequestPath,
  buildContentSecurityPolicy:buildContentSecurityPolicy,
  responseHeaders:responseHeaders,
  tokenAuth:tokenAuth
};
