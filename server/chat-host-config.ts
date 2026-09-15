import { errorCode as runtimeErrorCode } from '../scripts/lib/runtime-errors';
import type { ChatConfigLocation, HostChatConfig } from './chat-types';
'use strict';
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { randomUUID }: typeof import('node:crypto') = require('node:crypto');

function chatHostConfigPath(config: ChatConfigLocation) {
  return path.resolve(config.RUNTIME.state, 'chat_api_config.json');
}

// Chat and video share invalidation. File identity is part of the cache key.
function createHostConfigStore(io = fs) {
  const cache = new Map<string, { signature: string; value: HostChatConfig }>();
  function readHostConfig(config: ChatConfigLocation) {
    const file = chatHostConfigPath(config);
    try {
      const stat = io.statSync(file);
      const signature = [stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino].join(':');
      const cached = cache.get(file);
      if (cached?.signature === signature) return { ...cached.value };
      const parsed = JSON.parse(io.readFileSync(file, 'utf8'));
      const baseUrl = String(parsed?.baseUrl || '').trim();
      const model = String(parsed?.model || '').trim();
      const apiKey = String(parsed?.apiKey || '').trim();
      if (!baseUrl || !model) { cache.delete(file); return null; }
      const pathname = typeof parsed?.pathname === 'string' && parsed.pathname
        ? parsed.pathname : new URL('chat/completions', baseUrl.replace(/\/+$/, '') + '/').pathname;
      const value = { baseUrl, pathname, model, apiKey };
      cache.delete(file);
      cache.set(file, { signature, value });
      if (cache.size > 16) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return { ...value };
    } catch { cache.delete(file); return null; }
  }

  function writeHostConfig(config: ChatConfigLocation, value: unknown) {
    const file = chatHostConfigPath(config);
    io.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    let descriptor;
    try {
      descriptor = io.openSync(temporary, 'wx', 0o600);
      io.writeFileSync(descriptor, JSON.stringify(value, null, 2));
      io.fsyncSync(descriptor);
      io.closeSync(descriptor); descriptor = undefined;
      io.renameSync(temporary, file);
      cache.delete(file);
    } finally {
      if (descriptor !== undefined) io.closeSync(descriptor);
      removeIfPresent(temporary);
    }
  }

  function removeIfPresent(file: string) {
    try { io.unlinkSync(file); } catch (error) { if (runtimeErrorCode(error) !== 'ENOENT') throw error; }
  }

  function deleteHostConfig(config: ChatConfigLocation) {
    const file = chatHostConfigPath(config);
    removeIfPresent(file);
    cache.delete(file);
  }
  return { readHostConfig, writeHostConfig, deleteHostConfig };
}

export = { chatHostConfigPath, createHostConfigStore, ...createHostConfigStore() };
