'use strict';

import { errorMessage } from '../scripts/lib/runtime-errors';
interface LogTail { path: string; available: boolean; text: string; bytes?: number; truncated?: boolean; error?: string }
interface DiagnosticsOptions {
  logs?: any;
  exportedAt?: unknown; appVersion?: unknown; nodeVersion?: unknown; platform?: unknown;
  control?: unknown; gateway?: unknown; tunnel?: unknown; showcase?: unknown; config?: unknown; token?: unknown;
}
let fs: typeof import('fs') = require('fs');

let TOKEN_IN_URL = /([?&]token=)[^&\s"'`]+/gi;
let TOKEN_KV = /(\b(?:token|aics_token|api[-_]?key|password|secret|authorization)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
let HEX_LONG = /\b[a-f0-9]{32,}\b/gi;

function maskSecret(value?: unknown) {
  let text = String(value || '');
  if (!text) return '';
  if (text.length <= 4) return '****';
  return '…' + text.slice(-4);
}

function redactText(text?: unknown) {
  return String(text || '')
    .replace(TOKEN_IN_URL, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(TOKEN_KV, '$1[REDACTED]')
    .replace(HEX_LONG, function (match) {
      // Keep short structural hashes alone; mask likely tokens (>=32 hex).
      return match.length >= 32 ? ('…' + match.slice(-4)) : match;
    });
}

// 日志尾读缓存：控制面板每 3s 轮询 /api/logs，日志没新增时重复
// open/read/close + 正则脱敏是纯浪费；按 (maxBytes,size,mtimeMs) 失效，
// 追加写必然改 size，不会返回陈旧内容（2026-08-21 性能审计 #2）。
let LOG_TAIL_CACHE_LIMIT = 16;
let logTailCache = new Map<string, { maxBytes: number; size: number; mtimeMs: number; result: LogTail }>();

function readLogTail(filePath: string, maxBytes?: number): LogTail {
  maxBytes = Math.max(1024, Number(maxBytes) || 64 * 1024);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    return { path:filePath, available:false, text:'' };
  }
  let cached = logTailCache.get(filePath);
  if (cached && cached.maxBytes === maxBytes
    && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return Object.assign({}, cached.result);
  }
  try {
    let start = Math.max(0, stat.size - maxBytes);
    let fd = fs.openSync(filePath, 'r');
    try {
      let length = stat.size - start;
      let buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      let result = {
        path:filePath,
        available:true,
        bytes:stat.size,
        truncated:start > 0,
        text:redactText(buffer.toString('utf8'))
      };
      if (logTailCache.size >= LOG_TAIL_CACHE_LIMIT) logTailCache.clear();
      logTailCache.set(filePath, {
        maxBytes:maxBytes,
        size:stat.size,
        mtimeMs:stat.mtimeMs,
        result:result
      });
      return Object.assign({}, result);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return { path:filePath, available:false, error:errorMessage(error), text:'' };
  }
}

function redactConfig(raw: readonly unknown[]): unknown[];
function redactConfig(raw: unknown): Record<string, unknown>;
function redactConfig(raw: unknown): Record<string, unknown> | unknown[] {
  if (Array.isArray(raw)) return raw.map(function (item) { return item && typeof item === 'object' ? redactConfig(item) : typeof item === 'string' ? redactText(item) : item; });
  let source: Record<string, unknown> = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  let out: Record<string, unknown> = {};
  Object.keys(source).forEach(function (key) {
    let value = source[key];
    if (/token|password|secret|auth|api[-_]?key|cookie|credential|prompt|messages|imageData/i.test(key)) {
      out[key] = '[REDACTED]';
      return;
    }
    if (Array.isArray(value)) {
      out[key] = redactConfig(value);
      return;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactConfig(value);
      return;
    }
    out[key] = typeof value === 'string' ? redactText(value) : value;
  });
  return out;
}

function summarizeToken(token: unknown) {
  let text = String(token || '');
  return {
    present:!!text,
    length:text.length,
    suffix:text ? maskSecret(text) : ''
  };
}

function buildDiagnosticsPayload(options: DiagnosticsOptions = {}) {
  options = options || {};
  let logs = options.logs || {};
  return {
    type:'aics-diagnostics',
    schemaVersion:1,
    exportedAt:options.exportedAt || new Date().toISOString(),
    appVersion:String(options.appVersion || ''),
    nodeVersion:String(options.nodeVersion || process.version || ''),
    platform:String(options.platform || process.platform || ''),
    control:options.control || {},
    gateway:options.gateway || {},
    tunnel:options.tunnel || {},
    showcase:options.showcase || {},
    config:redactConfig(options.config || {}),
    token:summarizeToken(options.token || ''),
    logs:{
      control:logs.control || null,
      gateway:logs.gateway || null,
      tunnel:logs.tunnel || null
    }
  };
}

export = {
  maskSecret:maskSecret,
  redactText:redactText,
  redactConfig:redactConfig,
  readLogTail:readLogTail,
  summarizeToken:summarizeToken,
  buildDiagnosticsPayload:buildDiagnosticsPayload
};
