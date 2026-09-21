'use strict';

import type { IncomingMessage } from 'http';
import SerialQueue = require('./serial-queue');
import httpClient = require('./http-client');
import { boundedLines, type StreamLimits } from './stream-budget';

interface OllamaModelDetails {
  parameter_size?: string;
  quantization_level?: string;
}

interface OllamaModelItem {
  name?: string;
  model?: string;
  size?: number;
  capabilities?: string[];
  details?: OllamaModelDetails;
}

interface PublicModel {
  name: string;
  size: number;
  parameters: string;
  quantization: string;
}

interface TagsResponse {
  models?: OllamaModelItem[];
}

interface ChatMessage {
  role: string;
  content: string;
}

interface StreamChatInput {
  model?: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

interface StreamCallbacks {
  onStart?: (meta: { model: string; queueWaitMs: number }) => void | Promise<void>;
  onToken?: (content: string) => void | Promise<void>;
  onDone?: () => void | Promise<void>;
}

interface StreamChatResult {
  model: string;
  queueWaitMs: number;
}

interface OllamaServiceOptions {
  streamLimits?: StreamLimits & { totalTimeoutMs?: number };
  host: string;
  model?: string;
  keepAlive?: string;
  numPredict?: number;
  numContext?: number;
}

interface QueueStatusView {
  name: string;
  active: number;
  pending: number;
}

interface OllamaStatusOnline {
  online: true;
  model: string;
  models: PublicModel[];
  queue: QueueStatusView;
  activeModel: string;
  error?: undefined;
}

interface OllamaStatusOffline {
  online: false;
  model: string;
  models: PublicModel[];
  queue: QueueStatusView;
  activeModel: string;
  error: string;
}

type OllamaStatus = OllamaStatusOnline | OllamaStatusOffline;

interface StreamEvent {
  message?: { content?: string };
  done?: boolean;
}

function modelName(item: OllamaModelItem | null | undefined): string {
  return String((item && (item.name || item.model)) || '');
}

function publicModel(item: OllamaModelItem): PublicModel {
  return {
    name: modelName(item),
    size: Number(item && item.size) || 0,
    parameters: (item && item.details && item.details.parameter_size) || '',
    quantization: (item && item.details && item.details.quantization_level) || ''
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function createOllamaService(options: OllamaServiceOptions) {
  const host = options.host;
  const configuredModel = options.model || '';
  const keepAlive = options.keepAlive || '10m';
  const numPredict = Number(options.numPredict) || 300;
  const numContext = Number(options.numContext) || 4096;
  const queue = new SerialQueue('ollama-chat');
  let activeModel = '';

  async function listModels(signal?: AbortSignal): Promise<OllamaModelItem[]> {
    const data = (await httpClient.readJson(host, '/api/tags', {
      timeoutMs: 3000,
      timeoutMessage: 'Ollama status request timed out',
      signal: signal
    })) as TagsResponse;
    return (Array.isArray(data.models) ? data.models : []).filter(function (item) {
      const capabilities = Array.isArray(item.capabilities) ? item.capabilities : [];
      return modelName(item) && (!capabilities.length || capabilities.includes('completion'));
    });
  }

  function preferredModel(models: OllamaModelItem[]): string {
    if (
      configuredModel &&
      models.some(function (item) {
        return modelName(item) === configuredModel;
      })
    ) {
      return configuredModel;
    }
    return models.length ? modelName(models[0]) : '';
  }

  async function status(signal?: AbortSignal): Promise<OllamaStatus> {
    try {
      const models = await listModels(signal);
      return {
        online: true,
        model: preferredModel(models),
        models: models.map(publicModel),
        queue: queue.status(),
        activeModel: activeModel
      };
    } catch (error) {
      if (httpClient.isAbortError(error)) throw error;
      return {
        online: false,
        model: '',
        models: [],
        queue: queue.status(),
        activeModel: activeModel,
        error: errorMessage(error)
      };
    }
  }

  async function unload(model: string, signal?: AbortSignal): Promise<void> {
    if (!model) return;
    try {
      await httpClient.expectSuccess(host, '/api/generate', {
        method: 'POST',
        json: { model: model, keep_alive: 0, stream: false },
        timeoutMs: 8000,
        signal: signal
      });
    } catch (error) {
      if (httpClient.isAbortError(error)) throw error;
      console.warn('  ⚠️ Ollama 模型卸载失败 (' + model + '): ' + errorMessage(error));
    }
  }

  async function emitItem(item: StreamEvent | null | undefined, callbacks: StreamCallbacks): Promise<void> {
    const content = (item && item.message && item.message.content) || '';
    if (content && callbacks.onToken) await callbacks.onToken(content);
    if (item && item.done && callbacks.onDone) await callbacks.onDone();
  }

  async function consumeNdjson(response: IncomingMessage, callbacks: StreamCallbacks): Promise<void> {
    let doneEmitted = false;
    for await (const line of boundedLines(response, options.streamLimits)) {
      const lines = [line];
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].trim()) continue;
        let item: StreamEvent;
        try {
          item = JSON.parse(lines[i]) as StreamEvent;
        } catch {
          throw new httpClient.UpstreamError('Ollama returned an invalid stream event', {
            code: 'INVALID_NDJSON',
          });
        }
        if (!item || typeof item !== 'object' || (item.done !== undefined && typeof item.done !== 'boolean') || (item.message?.content !== undefined && typeof item.message.content !== 'string')) throw new httpClient.UpstreamError('Invalid stream fields', { code:'INVALID_NDJSON' });
        if (item.done === true) doneEmitted = true;
        await emitItem(item, callbacks);
      }
      if (doneEmitted) break;
    }
    if (!doneEmitted) throw new httpClient.UpstreamError('Ollama stream ended without done', { code:'INCOMPLETE_STREAM' });
  }

  function streamChat(input: StreamChatInput, callbacks?: StreamCallbacks): Promise<StreamChatResult> {
    const streamCallbacks = callbacks || {};
    // 传 signal：排队期间客户端断开就直接出队，不再占着 FIFO 位
    return queue.run(async function (queueMeta) {
      if (input.signal && input.signal.aborted) throw httpClient.abortError();
      const models = await listModels(input.signal);
      const allowed = models.map(modelName);
      const selected = input.model && allowed.includes(input.model) ? input.model : preferredModel(models);
      if (!selected) throw new Error('Ollama 中没有可用的对话模型');

      if (activeModel && activeModel !== selected) {
        const previous = activeModel;
        await unload(previous, input.signal);
        console.warn('  🔄 已卸载旧模型: ' + previous + ' → 加载: ' + selected);
      }
      activeModel = selected;

      const upstream = await httpClient.request(host, '/api/chat', {
        method: 'POST',
        timeoutMs: 3 * 60 * 1000,
        totalTimeoutMs: options.streamLimits?.totalTimeoutMs ?? 600000,
        timeoutMessage: 'Ollama 对话超时',
        signal: input.signal,
        json: {
          model: selected,
          messages: input.messages,
          stream: true,
          think: false,
          keep_alive: keepAlive,
          options: {
            temperature: 0.72,
            top_p: 0.88,
            repeat_penalty: 1.1,
            num_predict: numPredict,
            num_ctx: numContext
          }
        }
      });

      const statusCode = upstream.response.statusCode || 0;
      if (statusCode < 200 || statusCode >= 300) {
        const body = await httpClient.readBody(upstream.response, 1024 * 1024);
        throw new httpClient.UpstreamError('Ollama 对话失败', {
          code: 'OLLAMA_CHAT_FAILED',
          status: statusCode,
          detail: body.toString('utf8').slice(0, 500)
        });
      }

      if (streamCallbacks.onStart) {
        await streamCallbacks.onStart({ model: selected, queueWaitMs: queueMeta.waitMs });
      }
      await consumeNdjson(upstream.response, streamCallbacks);
      return { model: selected, queueWaitMs: queueMeta.waitMs };
    }, { signal: input.signal });
  }

  return {
    listModels: listModels,
    preferredModel: preferredModel,
    status: status,
    streamChat: streamChat,
    queueStatus: function (): QueueStatusView {
      return queue.status();
    }
  };
}

export = {
  createOllamaService: createOllamaService,
  modelName: modelName,
  publicModel: publicModel
};
