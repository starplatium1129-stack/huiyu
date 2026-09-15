'use strict';

const http: typeof import('node:http') = require('node:http');
const https: typeof import('node:https') = require('node:https');
const { fail, ResourceError, relativePath, cancelled }: typeof import('./resource-install-fs') = require('./resource-install-fs');

function sourceUrl(release: any, relative: any) {
  const source = release.source;
  let base;
  try { base = new URL(source.baseUrl); } catch { fail('SOURCE_REQUIRED', 'A valid configured source baseUrl is required'); }
  if (base!.username || base!.password || base!.search || base!.hash || !base!.pathname.endsWith('/')) {
    fail('UNSAFE_SOURCE', 'Source URL must have a directory path and no credentials/query/fragment');
  }
  const loopback = ['127.0.0.1', '[::1]'].includes(base!.hostname);
  if (base!.protocol !== 'https:' && !(base!.protocol === 'http:' && loopback && source.loopbackFixture === true)) {
    fail('UNSAFE_SOURCE', 'HTTPS is required; HTTP is limited to explicitly configured numeric loopback fixtures');
  }
  // Source and release locations come only from reviewed local configuration, never a request URL.
  if (base!.pathname !== '/') relativePath(decodeURIComponent(base!.pathname.slice(1, -1)));
  relativePath(release.path);
  relativePath(relative);
  const url = new URL([release.path, relative].join('/').split('/').map(encodeURIComponent).join('/'), base);
  if (url.origin !== base!.origin || !url.pathname.startsWith(base!.pathname)) fail('UNSAFE_SOURCE', 'URL left its approved source directory');
  return url;
}
function response(url: any, { headers = {}, signal, timeoutMs = 30000 } = {}) {
  cancelled(signal);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('CONFIG_REQUIRED', 'timeoutMs must be 1..60000');
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    let activeResponse: any;
    // Own the connection and abort listener. Passing signal through the pooled HTTP socket can
    // leave a late abort on a released socket while an asynchronous progress callback is paused.
    const request = client.get(url, { headers: { 'accept-encoding': 'identity', ...headers }, agent: false }, incoming => {
      activeResponse = incoming;
      // Cancellation may arrive while the consumer is validating headers or awaiting a progress
      // callback. Keep an error listener during that gap; async iteration still observes errored.
      incoming.on('error', () => {});
      // No redirects, cookie jar, proxy, auth forwarding, decompression or content execution.
      if (incoming.statusCode! >= 300 && incoming.statusCode! < 400) {
        incoming.destroy();
        reject(new ResourceError('REDIRECT_REJECTED', 'Resource redirects are not followed'));
      } else if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') {
        incoming.destroy();
        reject(new ResourceError('HTTP_ENCODING', 'Encoded response cannot be checked against resource byte ranges'));
      } else resolve(incoming);
    });
    const stop = (error: any) => { activeResponse?.destroy(error); request.destroy(error); };
    const abort = () => stop(new ResourceError('CANCELLED', 'Download cancelled; partial bytes are retained'));
    signal?.addEventListener('abort', abort, { once: true });
    request.once('close', () => signal?.removeEventListener('abort', abort));
    request.setTimeout(timeoutMs, () => stop(new ResourceError('HTTP_TIMEOUT', 'Resource source timed out')));
    request.on('error', error => reject(signal?.aborted
      ? new ResourceError('CANCELLED', 'Download cancelled; partial bytes are retained') : error));
    if (signal?.aborted) abort();
  });
}
function contentLength(res: any) {
  const length = res.headers['content-length'];
  if (length === undefined) return null;
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) fail('HTTP_SIZE', 'Invalid Content-Length');
  return Number(length);
}
async function fetchMetadata(url: any, options: any = {}) {
  const maxBytes = options.maxBytes || 16 * 1024 * 1024;
  const res: any = await response(url, options);
  try {
    if (res.statusCode !== 200) fail('HTTP_STATUS', 'Metadata request failed: ' + res.statusCode);
    const declared = contentLength(res);
    if (declared !== null && declared > maxBytes) fail('HTTP_SIZE', 'Metadata exceeds size limit');
    const chunks = [];
    let total = 0;
    for await (const chunk of res) {
      cancelled(options.signal);
      total += chunk.length;
      if (total > maxBytes) fail('HTTP_SIZE', 'Metadata exceeds size limit');
      chunks.push(chunk);
    }
    if (declared !== null && declared !== total) fail('HTTP_SIZE', 'Metadata response is incomplete');
    return Buffer.concat(chunks);
  } finally { res.destroy(); }
}
function rangeStart(res: any, offset: any, total: any, previousEtag: any) {
  const length = contentLength(res);
  if (res.statusCode === 200) {
    if (length !== null && length !== total) fail('HTTP_SIZE', 'Full response length differs from manifest');
    return 0; // Range ignored or If-Range invalidated: restart, never append a full response.
  }
  if (res.statusCode !== 206) fail('HTTP_STATUS', 'Resource request failed: ' + res.statusCode);
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers['content-range'] || '');
  if (!match || Number(match[1]) !== offset || Number(match[2]) !== total - 1 || Number(match[3]) !== total
    || (length !== null && length !== total - offset)) fail('HTTP_RANGE', 'Response range differs from requested approved resource');
  if (previousEtag && res.headers.etag !== previousEtag) fail('HTTP_RANGE', 'ETag changed during partial response');
  return offset;
}
export = { sourceUrl, response, contentLength, fetchMetadata, rangeStart };
