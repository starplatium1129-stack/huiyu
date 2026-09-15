'use strict';

const zlib = require('node:zlib');
const { setTimeout: delay } = require('node:timers/promises');

function gatewayUrl(explicit, env = process.env) {
  const value = explicit ?? env.GATEWAY_URL ?? env.BASE ?? env.AICS_COMMS_BASE ?? 'http://127.0.0.1:3000';
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid gateway URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('gateway must be an HTTP(S) URL without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Structural/byte validation, never a visual or human review. The gateway emits PNG.
function validatePng(buffer) {
  if (buffer.length < 57 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('invalid PNG signature or truncated image');
  }
  let offset = 8, width, height, depth, color, ended = false;
  const compressed = [];
  while (offset + 12 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > buffer.length) throw new Error('truncated PNG chunk');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) {
      throw new Error('invalid PNG chunk checksum');
    }
    if (offset === 8 && (type !== 'IHDR' || size !== 13)) throw new Error('missing PNG IHDR');
    if (type === 'IHDR') {
      if (width !== undefined || size !== 13) throw new Error('invalid PNG IHDR');
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      depth = buffer[offset + 16];
      color = buffer[offset + 17];
      if (!width || !height || width > 16384 || height > 16384 || buffer[offset + 18] || buffer[offset + 19] || buffer[offset + 20]) {
        throw new Error('unsupported PNG dimensions, compression or interlace');
      }
    } else if (type === 'IDAT') compressed.push(buffer.subarray(offset + 8, end - 4));
    else if (type === 'IEND') {
      if (size || end !== buffer.length) throw new Error('invalid PNG ending');
      ended = true;
      break;
    }
    offset = end;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[color];
  if (!ended || !compressed.length || !depths?.includes(depth)) throw new Error('incomplete or unsupported PNG');
  const row = Math.ceil(width * channels * depth / 8) + 1;
  const expected = row * height;
  if (expected > 128 * 1024 * 1024) throw new Error('PNG exceeds decoded size limit');
  const pixels = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  if (pixels.length !== expected) throw new Error('invalid PNG pixel data');
  for (let y = 0; y < height; y++) if (pixels[y * row] > 4) throw new Error('invalid PNG scanline filter');
  return { mime: 'image/png', width, height };
}

async function readBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('response exceeds size limit');
  const parts = [];
  let size = 0;
  for await (const part of response.body || []) {
    size += part.length;
    if (size > limit) throw new Error('response exceeds size limit');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function definitive(message) {
  return Object.assign(new Error(message), { definitive: true });
}

async function generate(record, save, options = {}) {
  const { signal, fetchImpl = globalThis.fetch, pollMs = 2000, timeoutMs = 600000 } = options;
  const signalForRequest = () => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.min(timeoutMs, 30000))]);
  async function request(url, init) {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: signalForRequest() });
    if (!response.ok) throw new Error(`gateway HTTP ${response.status}`);
    return response;
  }
  async function json(url, init) {
    const response = await request(url, init);
    const data = JSON.parse((await readBody(response, 1024 * 1024)).toString('utf8'));
    if (!data || typeof data !== 'object' || data.ok === false) throw new Error('invalid gateway JSON response');
    return data;
  }
  signal?.throwIfAborted();
  if (!record.jobId) {
    record.status = 'submitting';
    save(record);
    const data = await json(`${record.gateway}/api/anima/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record.payload),
    });
    const id = data.job?.id ?? data.jobId ?? data.id;
    if (typeof id !== 'string' || !id.trim()) throw new Error('submission returned no valid job ID; check gateway before retry');
    record.jobId = id;
    record.status = 'submitted';
    save(record);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const data = await json(`${record.gateway}/api/anima/jobs/${encodeURIComponent(record.jobId)}`);
    const job = data.job || data;
    if (job.id !== undefined && job.id !== record.jobId) throw new Error('gateway returned a different job ID');
    if (['failed', 'cancelled'].includes(job.status)) throw definitive(`job ${job.status}`);
    if (['succeeded', 'completed'].includes(job.status)) {
      const result = job.resultUrl || job.outputs?.[0];
      if (typeof result !== 'string' || !result.trim()) throw definitive('completed job has no result URL');
      let url;
      try { url = new URL(result, `${record.gateway}/`); } catch { throw definitive('invalid result URL'); }
      if (url.origin !== new URL(record.gateway).origin || url.username || url.password) {
        throw definitive('result URL must stay on the configured gateway');
      }
      record.resultUrl = url.href;
      record.provider = typeof job.provider === 'string' ? job.provider : '';
      record.actualSeed = Number.isFinite(job.metadata?.seed) ? job.metadata.seed
        : Number.isFinite(job.seed) ? job.seed : record.seed;
      record.status = 'downloading';
      save(record);
      const response = await request(url.href);
      const buffer = await readBody(response, 32 * 1024 * 1024);
      try {
        const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (mime !== 'image/png') throw new Error('result is not image/png');
        return { buffer, ...validatePng(buffer) };
      } catch (error) { throw definitive(error.message); }
    }
    if (!['queued', 'pending', 'running', 'processing', 'submitted'].includes(job.status)) {
      throw new Error('unknown gateway job status');
    }
    await delay(pollMs, undefined, { signal });
  }
  throw new Error('gateway job timed out; saved job ID can be resumed');
}

module.exports = { gatewayUrl, validatePng, generate };
