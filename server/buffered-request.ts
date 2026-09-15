'use strict';

type RequestOptions = { method?: string; headers?: import('http').OutgoingHttpHeaders; timeoutMs?: number; maxBytes?: number; makeError?: (kind: string, error?: Error) => Error; body?: string | Buffer | null; };
type BufferedResult = { status: number; headers: import('http').IncomingHttpHeaders; body: Buffer; };
const http: typeof import('http') = require('http');
const https: typeof import('https') = require('https');

/** Bounded local HTTP transport. The deadline covers the whole response, not just idle gaps. */
function requestBuffered(target: string | URL, options: RequestOptions): Promise<BufferedResult> {
  return new Promise((resolve, reject) => {
    const url = target instanceof URL ? target : new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new Error('unsupported upstream protocol'));
    const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0 ? options.timeoutMs! : 10000;
    const limit = Number.isFinite(options.maxBytes) && options.maxBytes! > 0 ? options.maxBytes! : 2 * 1024 * 1024;
    const makeError = options.makeError || ((kind: string, error?: unknown) => error instanceof Error ? error : new Error(kind));
    let settled = false, deadline: NodeJS.Timeout | undefined, chunks: Buffer[] = [], size = 0;
    const finish = (error?: Error, result?: BufferedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      chunks = [];
      if (error) { request.destroy(); reject(error); } else if (result) resolve(result); else reject(new Error('missing result'));
    };
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: options.method || 'GET', headers: options.headers || {},
    }, response => {
      response.on('error', error => finish(makeError('aborted', error)));
      response.on('aborted', () => finish(makeError('aborted')));
      response.on('data', chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > limit) return finish(makeError('tooLarge'));
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        if (settled) return;
        if (!response.complete) return finish(makeError('aborted'));
        finish(undefined, { status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks, size) });
      });
      if (request.method !== 'HEAD' && Number(response.headers['content-length']) > limit) finish(makeError('tooLarge'));
    });
    request.on('error', error => finish(makeError('network', error)));
    deadline = setTimeout(() => finish(makeError('timeout')), timeout);
    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}
export = { requestBuffered };
