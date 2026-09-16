'use strict';

/**
 * 优先发预压产物（.br / .gz）的静态中间件。
 *
 * compression 中间件是每个请求现场压一次，而且只有 gzip；
 * 预压之后既省 CPU 又能用上 brotli（实测 scenes.json gzip 229.7KB →
 * brotli 155.2KB）。产物由 scripts/maintenance/precompress.js 生成。
 */

let path: typeof import('path') = require('path');
let fs: typeof import('fs') = require('fs');
let publicDataFiles: typeof import('./public-data') = require('./public-data');
import type { RequestHandler } from 'express';

let PRECOMPRESSIBLE = /\.(?:js|css|html|json|svg|txt|map)$/i;

/** 与 PRECOMPRESSIBLE 同范围的内容类型映射（含文本类 charset） */
let MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function precompressed(rootDir: string, options?: { assetsRoot?: string }): RequestHandler {
  const root = path.resolve(rootDir);
  const assetRoot = path.resolve(options?.assetsRoot || path.join(root, 'assets'));
  const stat = (file: string) => fs.promises.stat(file).catch(() => null);
  return async function (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname;
    try { pathname = decodeURIComponent(req.path); } catch { return next(); }
    if (!PRECOMPRESSIBLE.test(pathname) || /[\\\0]/.test(pathname) || pathname.split('/').some(part => part.startsWith('.'))) return next();
    if (!/^\/(?:_app\/|data\/|assets\/|css\/|docs\/|index\.html$)/.test(pathname)) return next();
    if (!req.acceptsEncodings('br', 'gzip')) return next();
    if (pathname.startsWith('/data/') && !publicDataFiles.includes(pathname.slice(6))) return next();
    const isAsset = pathname.startsWith('/assets/');
    const base = isAsset ? assetRoot : root;
    const relative = isAsset ? pathname.slice(8) : (pathname === '/index.html' || pathname.startsWith('/_app/') ? 'dist' + pathname : pathname.slice(1));
    const original = path.resolve(base, relative);
    if (!original.startsWith(base + path.sep)) return next();
    try {
      const [source, brotli, gzip] = await Promise.all([stat(original), stat(original + '.br'), stat(original + '.gz')]);
      if (res.destroyed) return;
      if (!source?.isFile()) return next();
      const available = [];
      if (brotli?.isFile() && brotli.mtimeMs >= source.mtimeMs) available.push('br');
      if (gzip?.isFile() && gzip.mtimeMs >= source.mtimeMs) available.push('gzip');
      if (!available.length) return next();
      const encoding = req.acceptsEncodings(available);
      if (!encoding) return next();
      const file = original + (encoding === 'br' ? '.br' : '.gz');
      res.setHeader('Content-Encoding', encoding);
      res.vary('Accept-Encoding');
      const type = MIME_BY_EXT[path.extname(original).toLowerCase()];
      if (type) res.setHeader('Content-Type', type);
      // data/ JSON 可由维护链路更新，即使通过 .br/.gz 发送也必须协商 ETag；
      // 只有内容哈希的 SPA _app 资源才允许 immutable。
      const versioned = pathname.startsWith('/_app/');
      res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
      res.sendFile(file, error => {
        if (!error) return;
        if (res.headersSent) return next(error);
        for (const name of ['Content-Encoding', 'Content-Length', 'ETag', 'Last-Modified', 'Content-Range']) res.removeHeader(name);
        next();
      });
    } catch (error) { next(error); }
  };
}

export = { precompressed };
