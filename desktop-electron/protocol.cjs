'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { within } = require('./config.cjs');
const ORIGIN = 'https://huiyu.localhost';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm' };
function trustedDocument(value) {
  try { const url = new URL(value); return url.origin === ORIGIN && !url.username && !url.password && ['/', '/index.html'].includes(url.pathname); } catch { return false; }
}
function installProtocol(session, config) {
  const runtime = `http://127.0.0.1:${config.gatewayPort}`;
  const policy = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${runtime}; media-src 'self' data: blob: ${runtime}; connect-src 'self' ${runtime}; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'`;
  const headers = { 'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', event => event.preventDefault());
  // The intercepted HTTPS scheme never falls through to the network for another host.
  session.protocol.handle('https', async request => {
    try {
      if (config.probe && new URL(request.url).pathname === '/') console.error('[electron:protocol]', request.method, 'local document');
      const url = new URL(request.url);
      if (url.origin !== ORIGIN || url.username || url.password) return new Response('Forbidden', { status: 403 });
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const decoded = decodeURIComponent(url.pathname);
      if (/[\\\0:]/.test(decoded) || decoded.split('/').some(part => part === '..' || part === '.')) return new Response('Forbidden', { status: 403 });
      const relative = decoded === '/' ? 'index.html' : decoded.slice(1);
      const file = await fs.realpath(path.resolve(config.webRoot, relative));
      if (!within(config.webRoot, file)) return new Response('Forbidden', { status: 403 });
      const info = await fs.stat(file);
      if (!info.isFile()) return new Response('Not found', { status: 404 });
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(request.method === 'HEAD' ? null : await fs.readFile(file), {
        status: 200, headers: { ...headers, 'Content-Type': type, 'Content-Length': String(info.size) },
      });
    } catch (error) {
      if (config.probe) console.error('[electron:protocol-error]', error.code || error.name, error.message);
      return new Response('Not found', { status: 404, headers });
    }
  });
  session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try { const url = new URL(details.url); allowed = url.origin === ORIGIN || url.origin === runtime || ['data:', 'blob:'].includes(url.protocol); } catch {}
    callback({ cancel: !allowed });
  });
}
module.exports = { ORIGIN, trustedDocument, installProtocol };
