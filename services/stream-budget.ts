import type { IncomingMessage } from 'http';
import { StringDecoder } from 'string_decoder';
import httpClient = require('./http-client');

export interface StreamLimits { totalBytes?: number; frameBytes?: number }
/** Count raw bytes before decoding or concatenating; includes comments and blank lines. */
export async function* boundedLines(response: IncomingMessage, limits: StreamLimits = {}): AsyncGenerator<string> {
  const maxTotal = limits.totalBytes ?? 16 * 1024 * 1024;
  const maxFrame = limits.frameBytes ?? 1024 * 1024;
  let total = 0, frame = 0, text = '';
  const decoder = new StringDecoder('utf8');
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxTotal) throw new httpClient.UpstreamError('响应超过总字节预算', { code: 'STREAM_BUDGET' });
      let start = 0;
      for (let i = 0; i <= bytes.length; i++) {
        if (i !== bytes.length && bytes[i] !== 10) continue;
        const length = i - start;
        frame += length;
        if (frame > maxFrame) throw new httpClient.UpstreamError('响应超过单帧预算', { code: 'STREAM_BUDGET' });
        text += decoder.write(bytes.subarray(start, i));
        if (i < bytes.length) { yield text; text = ''; frame = 0; }
        start = i + 1;
      }
    }
    text += decoder.end();
    if (text) yield text;
  } finally {
    if (!response.destroyed) response.destroy();
  }
}
