import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage, errorStatus as runtimeErrorStatus } from '../scripts/lib/runtime-errors';
'use strict';

const { maintenanceReadToken, assertMaintenanceReadToken }: typeof import('../scripts/lib/maintenance-lease') = require('../scripts/lib/maintenance-lease');
const installed = new WeakSet();

// Mount after authorization, before ANY precompressed/static handler. Either side
// of compression is supported: capture its encoded bytes when it runs downstream,
// or release a verified immutable buffer to it when it runs upstream. writeHead and
// flushHeaders must be deferred too, so an aborted read can replace the response.
function maintenanceReadBarrier(options: unknown) {
  return function barrier(req: { method: string; }, res: object, next: () => void) {
    if (!['GET', 'HEAD'].includes(req.method) || installed.has(res)) return next();
    let token;
    try { token = maintenanceReadToken(options); }
    catch (error) {
      res.set('Cache-Control', 'no-store');
      return res.status(runtimeErrorStatus(error, 'statusCode') || 503).json({ ok: false, code: runtimeErrorCode(error), error: runtimeErrorMessage(error), recoveryRequired: true });
    }
    if (res.headersSent) return res.destroy(new Error('维护读取屏障必须在响应头发出前挂载'));
    installed.add(res);
    const original = { write: res.write, end: res.end, writeHead: res.writeHead, flushHeaders: res.flushHeaders };
    let chunks: readonly Uint8Array<ArrayBufferLike>[]|Buffer<unknown>[] = [];
    let size = 0;
    let bufferError: Error|null = null;
    let ended = false;
    res.writeHead = function (statusCode: unknown, statusMessage: unknown, headers: string|unknown[]|{ [s: string]: unknown; }|ArrayLike<unknown>) {
      res.statusCode = statusCode;
      if (typeof statusMessage === 'string') res.statusMessage = statusMessage;
      else headers = statusMessage;
      if (Array.isArray(headers)) {
        const names = new Set();
        for (let index = 0; index < headers.length; index += 2) {
          const name = headers[index];
          const key = String(name).toLowerCase();
          if (names.has(key)) res.appendHeader(name, headers[index + 1]);
          else { res.setHeader(name, headers[index + 1]); names.add(key); }
        }
      } else if (headers) for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      return res;
    };
    res.flushHeaders = () => {};
    res.write = (chunk: unknown, encoding: number|undefined, callback: unknown) => {
      if (ended || res.destroyed) return false;
      // Copy buffers: the producer may reuse a chunk after its write callback.
      const bytes = Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
      size += bytes.length;
      if (size > 64 * 1024 * 1024) { bufferError = new Error('受保护文件超过维护读取缓冲上限'); chunks = []; }
      else if (!bufferError) chunks.push(bytes);
      const done = typeof encoding === 'function' ? encoding : callback;
      if (done) process.nextTick(done);
      return true;
    };
    res.end = (chunk: null|undefined, encoding: unknown, callback: unknown) => {
      if (ended) return res;
      const done = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback;
      if (typeof chunk === 'function') chunk = undefined;
      if (chunk !== undefined && chunk !== null) res.write(chunk, encoding);
      ended = true;
      if (done) res.once('finish', done);
      // Do not restore downstream wrappers: they may have already finished encoding.
      // Upstream compression remains in original.end and can encode the captured body.
      Object.assign(res, original);
      if (res.destroyed) { chunks = []; return res; }
      try {
        if (bufferError) throw bufferError;
        assertMaintenanceReadToken(options, token);
      } catch (error) {
        chunks = [];
        if (res.headersSent) return res.destroy(error);
        res.statusCode = runtimeErrorStatus(error, 'statusCode') || 503;
        res.statusMessage = undefined;
        for (const name of ['Content-Length', 'Content-Encoding', 'Content-Range', 'Accept-Ranges', 'Transfer-Encoding', 'ETag', 'Last-Modified']) res.removeHeader(name);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-transform');
        return original.end.call(res, JSON.stringify({ ok: false, code: runtimeErrorCode(error) || 'MAINTENANCE_READ_BLOCKED', error: runtimeErrorMessage(error), recoveryRequired: true }));
      }
      const bytes = Buffer.concat(chunks);
      chunks = [];
      return original.end.call(res, bytes);
    };
    res.once('close', () => { chunks = []; });
    next();
  };
}
export = { maintenanceReadBarrier };
