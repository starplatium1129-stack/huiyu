'use strict';

import type { ComfyConfig, ProgressJob, ProgressOptions, ProgressSocket } from './comfy-types';

/**
 * ComfyUI execution progress bridge.
 * The monitor is deliberately best-effort: history polling remains authoritative
 * for completion, while this channel only enriches the public job state.
 */
let WebSocket: typeof import('ws') = require('ws');

function websocketUrl(host: string|URL, clientId: string|number|boolean) {
  let target = new URL(host);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  target.pathname = '/ws';
  target.search = '?clientId=' + encodeURIComponent(clientId);
  return target.toString();
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampProgress(value: unknown, max: unknown) {
  if (!finite(value) || !finite(max) || max <= 0) return null;
  return Math.max(0, Math.min(1, value / max));
}

function readMessage(raw: unknown): unknown {
  let data = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  try { return JSON.parse(data); } catch (error) { return null; }
}

function createComfyProgressMonitor<Job extends ProgressJob = ProgressJob>(config: ComfyConfig, clientId: string|number|boolean, options: ProgressOptions<Job> = {}) {
  options = options || {};
  let WebSocketImpl = options.WebSocket || WebSocket;
  let reconnectMs = Number(options.reconnectMs) > 0 ? Number(options.reconnectMs) : 2000;
  let subscriptions = new Map<string, Job>();
  let socket: ProgressSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, reconnectMs);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function handleMessage(raw: unknown, isBinary?: boolean) {
    // 预览帧是二进制图片；不解码为字符串，也不尝试 JSON.parse。
    if (isBinary === true) return;
    let message = readMessage(raw) as { type?: unknown; data?: Record<string, unknown>; prompt_id?: unknown } | null;
    if (!message || typeof message.type !== 'string') return;
    let data = message.data && typeof message.data === 'object' ? message.data : {};
    let promptId = data.prompt_id || message.prompt_id;
    if (!promptId || !subscriptions.has(String(promptId))) return;
    let job = subscriptions.get(String(promptId));
    if (!job || job.status !== 'running') return;

    if (message.type === 'execution_start') {
      job.progress = null;
      job.currentNode = null;
      job.progressText = 'ComfyUI 开始执行…';
    } else if (message.type === 'progress') {
      job.progress = clampProgress(data.value, data.max);
      job.currentNode = data.node == null ? job.currentNode : String(data.node);
      job.progressText = job.progress === null
        ? 'ComfyUI 正在推理…'
        : '采样 ' + data.value + ' / ' + data.max + (job.currentNode ? ' · 节点 ' + job.currentNode : '');
    } else if (message.type === 'executing') {
      job.currentNode = data.node == null ? null : String(data.node);
      job.progressText = job.currentNode ? '执行节点 ' + job.currentNode : 'ComfyUI 正在收尾…';
      if (data.node == null) job.progress = 1;
    } else if (message.type === 'execution_cached') {
      job.progressText = 'ComfyUI 使用缓存节点…';
    }
    if (typeof options.onUpdate === 'function') options.onUpdate(job, message.type, data);
  }

  function connect() {
    if (closed || socket) return;
    let next: ProgressSocket;
    try { next = new WebSocketImpl(websocketUrl(config.COMFY_HOST, clientId)); } catch (error) { scheduleReconnect(); return; }
    socket = next;
    next.on('message', handleMessage);
    next.on('open', function () { if (typeof options.onOpen === 'function') options.onOpen(); });
    next.on('error', function (error) { if (typeof options.onError === 'function') options.onError(error); });
    next.on('close', function () {
      if (socket === next) socket = null;
      scheduleReconnect();
    });
  }

  function watch(promptId: unknown, job: Job) {
    subscriptions.set(String(promptId), job);
    connect();
  }

  function unwatch(promptId: unknown) { subscriptions.delete(String(promptId)); }

  function close() {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    subscriptions.clear();
    if (socket) {
      let current = socket;
      socket = null;
      try { current.close(); } catch (error) {}
    }
  }

  connect();
  return { watch:watch, unwatch:unwatch, close:close, handleMessage:handleMessage };
}

export = { createComfyProgressMonitor, websocketUrl, clampProgress, readMessage };
