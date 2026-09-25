import { errorMessage as runtimeErrorMessage } from '../scripts/lib/runtime-errors';
'use strict';

import { Response } from 'express-serve-static-core';
import type { GatewayConfig } from '../server/config-types';
import { localLive2dRoot, readLocalCompanions } from '../services/live2d-local';

let { validateChatBody, validateCompatibleApi }: typeof import('./chat-validation') = require('./chat-validation');

let express: typeof import('express') = require('express');


import { boundedLines, type StreamLimits } from '../services/stream-budget';
let httpClient: typeof import('../services/http-client') = require('../services/http-client');
let security: typeof import('../server/security') = require('../server/security');
let envelope: typeof import('../server/http-envelope') = require('../server/http-envelope');
let companionTools: typeof import('../server/companion-tools') = require('../server/companion-tools');
let chatPrompts: typeof import('../server/chat-character-prompts') = require('../server/chat-character-prompts');
let createOllamaService = (require('../services/ollama-service') as typeof import('../services/ollama-service')).createOllamaService;

// ── 站主 API 配置托管 ──────────────────────────────────────────────
// 公网分享时访客的浏览器里没有主人的密钥；这套配置让访客直接使用
// 站主配好的 API，而 GET 接口永远不回传 apiKey。
let { readHostConfig, writeHostConfig, deleteHostConfig }: typeof import('../server/chat-host-config') = require('../server/chat-host-config');

function hostConfigPublic(config: GatewayConfig) {
  let stored = readHostConfig(config);
  if (!stored) return { configured:false };
  return {
    configured:true,
    baseUrl:stored.baseUrl,
    model:stored.model,
    // 不返回 apiKey：访客只使用，不查看
    updatedAt:null
  };
}

function chatCharacterPrompt(character: string, context?: any) {
  return chatPrompts.buildCharacterPrompt(character, context);
}

function compatibleContent(event: any) {
  let choice = event && Array.isArray(event.choices) ? event.choices[0] : null;
  if (!choice) return '';
  if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
  if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
  return typeof choice.text === 'string' ? choice.text : '';
}

/** 思考过程增量（DeepSeek reasoning_content / OpenAI 兼容 reasoning）。 */
function compatibleReasoning(event: any) {
  let choice = event && Array.isArray(event.choices) ? event.choices[0] : null;
  if (!choice) return '';
  if (choice.delta) {
    if (typeof choice.delta.reasoning_content === 'string') return choice.delta.reasoning_content;
    if (typeof choice.delta.reasoning === 'string') return choice.delta.reasoning;
  }
  if (choice.message) {
    if (typeof choice.message.reasoning_content === 'string') return choice.message.reasoning_content;
    if (typeof choice.message.reasoning === 'string') return choice.message.reasoning;
  }
  return '';
}

function buildWebSearchParams(api: { model: string; vendor: string; }) {
  if (/^gemini-/i.test(api.model)) return { tools:[{ google_search:{} }] };
  // 只有确认支持 web_search 参数的供应商才注入；未知/自定义 OpenAI 兼容端点
  // 收到未知参数会 400，联网检索直接失败。
  if (api.vendor === 'deepseek' || api.vendor === 'opencode') return { web_search:true };
  return {};
}

async function streamCompatibleApi(input: any, handlers: any, gatewayConfig?: GatewayConfig, limits: StreamLimits & { totalTimeoutMs?: number } = {}) {
  handlers = handlers || {};
  let api = input.api;
  // 访客模式（hostConfig:true）：从站主托管配置注入 baseUrl/model/key，
  // 前端始终拿不到密钥
  if (api && api.hostConfig === true) {
    let host = gatewayConfig ? readHostConfig(gatewayConfig) : null;
    if (!host) {
      throw new httpClient.UpstreamError('站主尚未配置 API，请在控制面板的聊天设置中保存', {
        code:'HOST_CONFIG_MISSING',
        status:400
      });
    }
    api = {
      baseUrl:host.baseUrl,
      pathname:host.pathname,
      model:host.model,
      apiKey:host.apiKey,
      vendor:host.baseUrl.includes('api.deepseek.com')
        ? 'deepseek'
        : host.baseUrl.includes('opencode.ai') ? 'opencode' : 'custom'
    };
    input = Object.assign({}, input, { api:api });
  }
  let result = await httpClient.request(api.baseUrl, api.pathname, {
    publicOnly:input.publicOnly === true,
    method:'POST',
    headers:Object.assign(
      { Accept:'text/event-stream, application/json' },
      api.apiKey ? { Authorization:'Bearer ' + api.apiKey } : {}
    ),
    json:Object.assign({
      model:api.model,
      messages:input.messages,
      stream:true
    },
      // 推理强度按供应商官方文档注入：
      // - DeepSeek V4：thinking.type 只有 enabled/disabled 两值；强度是
      //   顶层 reasoning_effort（high/max 两档，官方兼容映射 low/medium→high，
      //   xhigh→max）。off → 关闭思考；low → high 档；medium/high → max 档
      //   （默认 medium 即 max）。
      // - OpenCode 端点吃 OpenAI 标准的 reasoning_effort 多档参数。
      // - 其余端点不注入（防 400）。
      api.vendor === 'deepseek'
        ? (input.reasoning === 'off'
          ? { thinking:{ type:'disabled' } }
          : Object.assign(
            { thinking:{ type:'enabled' } },
            input.reasoning === 'low' ? { reasoning_effort:'high' } : { reasoning_effort:'max' }))
        : api.vendor === 'opencode' && input.reasoning && input.reasoning !== 'off'
          ? { reasoning_effort:input.reasoning }
          : {},
      input.webSearch ? buildWebSearchParams(api) : {},
      input.companionTools ? { tools:companionTools.TOOL_DEFINITIONS } : {}),
    signal:input.signal,
    timeoutMs:120000,
    totalTimeoutMs:limits.totalTimeoutMs ?? 600000,
    timeoutMessage:'自定义 API 对话超时'
  });
  let statusCode = result.response.statusCode || 0;
  if (statusCode < 200 || statusCode >= 300) {
    let errorBody = await httpClient.readBody(result.response, 64 * 1024);
    throw new httpClient.UpstreamError('自定义 API 返回 ' + statusCode, {
      code:'UPSTREAM_STATUS',
      status:statusCode,
      detail:errorBody.toString('utf8').slice(0, 500)
    });
  }

  if (handlers.onStart) await handlers.onStart({ model:api.model, queueWaitMs:0 });
  let contentType = String(result.response.headers['content-type'] || '').toLowerCase();
  let buffer = '';
  let emitted = false;
  let malformedSse = false;
  let terminal = false;
  const sse = contentType.includes('text/event-stream');

  // tool_calls 流式增量按 index 累积（OpenAI 兼容格式：id 与 name 只在
  // 首次 chunk 出现，arguments 是字符串分片）；流结束时统一 flush 成事件。
  // reasoningText 累积思考全文：DeepSeek V4 在思考轮带 tool_calls 时，
  // 下一轮必须回传 reasoning_content，否则上游 400。
  let toolCallsByIndex = Object.create(null);
  let reasoningText = '';
  function accumulateToolCalls(event: any) {
    let choice = event && Array.isArray(event.choices) ? event.choices[0] : null;
    let deltas = choice && Array.isArray(choice.delta && choice.delta.tool_calls)
      ? choice.delta.tool_calls
      : (choice && Array.isArray(choice.message && choice.message.tool_calls)
        ? choice.message.tool_calls.map(function (call: any) {
          return { id:call && call.id, function:call && call.function };
        }) : null);
    if (!deltas) return;
    for (let i = 0; i < deltas.length; i += 1) {
      let delta = deltas[i] || {};
      let rawIndex = delta.index !== undefined ? Number(delta.index) : i;
      if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= 8) throw new httpClient.UpstreamError('工具数量或索引无效', { code:'STREAM_BUDGET' });
      let index = rawIndex;
      let acc = toolCallsByIndex[index] || (toolCallsByIndex[index] = { id:'', name:'', arguments:'' });
      if (typeof delta.id === 'string' && delta.id.length > 128) throw new httpClient.UpstreamError('工具 ID 超限', { code:'STREAM_BUDGET' });
      if (typeof delta.id === 'string' && delta.id) acc.id = delta.id;
      if (delta.function) {
        if (typeof delta.function.arguments !== 'undefined' && typeof delta.function.arguments !== 'string') throw new httpClient.UpstreamError('工具参数格式无效', { code:'INVALID_SSE' });
        if (Buffer.byteLength(acc.arguments) + Buffer.byteLength(delta.function.arguments || '') > 4000 || acc.name.length + String(delta.function.name || '').length > 128) throw new httpClient.UpstreamError('工具参数超限', { code:'STREAM_BUDGET' });
        // 部分实现会把 name 也分片传输，用拼接兼容
        if (typeof delta.function.name === 'string') acc.name += delta.function.name;
        if (typeof delta.function.arguments === 'string') acc.arguments += delta.function.arguments;
      }
    }
  }
  function flushToolCalls() {
    if (!handlers.onToolCall) return Promise.resolve();
    let indexes = Object.keys(toolCallsByIndex).map(Number).sort(function (a, b) { return a - b; });
    let chain = Promise.resolve();
    // Validate the complete batch before publishing any potentially effectful call.
    for (const index of indexes) {
      const call = toolCallsByIndex[index];
      if (!call.id || !companionTools.isKnownToolName(call.name)) throw new httpClient.UpstreamError('工具调用不完整', { code:'INVALID_SSE' });
      try { const args = JSON.parse(call.arguments); if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error(); }
      catch { throw new httpClient.UpstreamError('工具参数不完整', { code:'INVALID_SSE' }); }
    }
    indexes.forEach(function (index) {
      let call = toolCallsByIndex[index];
      if (!call || !call.name) return;
      if (!call.id) call.id = 'call_' + (index + 1) + '_' + Date.now();
      chain = chain.then(function () {
        return handlers.onToolCall({
          index:index,
          id:call.id,
          name:call.name,
          arguments:call.arguments,
          reasoning:reasoningText
        });
      });
    });
    return chain;
  }

  for await (let rawLine of boundedLines(result.response, limits)) {
    if (!sse) { buffer += rawLine + '\n'; continue; }
      let line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      let payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') { terminal = true; break; }
      let event;
      try { event = JSON.parse(payload); } catch (error) {
        malformedSse = true;
        continue;
      }
      accumulateToolCalls(event);
      const finish = event?.choices?.[0]?.finish_reason;
      if (['stop', 'length', 'tool_calls', 'content_filter'].includes(finish)) terminal = true;
      let reasoning = compatibleReasoning(event);
      if (reasoning) {
        if (Buffer.byteLength(reasoningText) + Buffer.byteLength(reasoning) > 20000) throw new httpClient.UpstreamError('推理过程超限', { code:'STREAM_BUDGET' });
        reasoningText += reasoning;
        emitted = true;
        if (handlers.onReasoning) await handlers.onReasoning(reasoning);
      }
      let token = compatibleContent(event);
      if (!token) continue;
      emitted = true;
      if (handlers.onToken) await handlers.onToken(token);
  }

  if (malformedSse || (sse && !terminal)) {
    throw new httpClient.UpstreamError('自定义 API 返回了畸形 SSE', {
      code:'INVALID_SSE'
    });
  }
  if (!sse && !buffer.trim()) throw new httpClient.UpstreamError('上游返回空响应', { code:'INCOMPLETE_STREAM' });

  if (!emitted && buffer.trim()) {
    let responseBody;
    try { responseBody = JSON.parse(buffer); } catch (error) {
      throw new httpClient.UpstreamError('自定义 API 返回了无法识别的响应', {
        code:'INVALID_JSON',
      });
    }
    accumulateToolCalls(responseBody);
    let reasoningBody = compatibleReasoning(responseBody);
    if (reasoningBody) {
      if (Buffer.byteLength(reasoningBody) > 20000) throw new httpClient.UpstreamError('推理过程超限', { code:'STREAM_BUDGET' });
      reasoningText += reasoningBody;
      if (handlers.onReasoning) await handlers.onReasoning(reasoningBody);
    }
    let content = compatibleContent(responseBody);
    if (!Array.isArray(responseBody?.choices) || !responseBody.choices[0]?.message) throw new httpClient.UpstreamError('非流式响应缺少消息', { code:'INVALID_JSON' });
    if (content && handlers.onToken) await handlers.onToken(content);
  }
  await flushToolCalls();
  if (handlers.onDone) await handlers.onDone();
}

async function inspectCompatibleApi(api: any, signal?: AbortSignal) {
  let modelsPath = api.pathname.replace(/\/chat\/completions$/, '/models');
  let result = await httpClient.request(api.baseUrl, modelsPath, {
    method:'GET',
    headers:Object.assign(
      { Accept:'application/json' },
      api.apiKey ? { Authorization:'Bearer ' + api.apiKey } : {}
    ),
    signal:signal,
    timeoutMs:15000,
    timeoutMessage:'API 连接测试超时'
  });
  let body = await httpClient.readBody(result.response, 512 * 1024);
  let statusCode = result.response.statusCode || 0;
  if (statusCode < 200 || statusCode >= 300) {
    throw new httpClient.UpstreamError('API 连接测试返回 ' + statusCode, {
      code:'UPSTREAM_STATUS',
      status:statusCode,
      detail:body.toString('utf8').slice(0, 500)
    });
  }
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch (error) {
    throw new httpClient.UpstreamError('模型列表不是有效 JSON', {
      code:'INVALID_JSON',
      detail:runtimeErrorMessage(error)
    });
  }
  let rawModels = Array.isArray(data && data.data)
    ? data.data
    : Array.isArray(data && data.models) ? data.models : [];
  let models = rawModels.map(function (item: any) {
    return String(item && (item.id || item.name) || '').trim();
  }).filter(Boolean).slice(0, 200);
  return {
    online:true,
    vendor:api.vendor,
    models:models,
    modelCount:models.length
  };
}

function writeEvent(res: Response<any,Record<string,any>,number>, event: any) {
  if (res.destroyed || res.writableEnded) return Promise.reject(httpClient.abortError());
  if (res.write(JSON.stringify(event) + '\n')) return Promise.resolve();
  return new Promise<void>(function (resolve, reject) {
    function cleanup() {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
    }
    function onDrain() { cleanup(); resolve(); }
    function onClose() { cleanup(); reject(httpClient.abortError()); }
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/** 注入的 Ollama 客户端；缺省时工厂按 config 自行创建。 */
type ChatDependencies = { ollama?: ReturnType<typeof createOllamaService> };

function createChatRouter(config: GatewayConfig, dependencies?: ChatDependencies) {
  dependencies = dependencies || {};
  let router = express.Router();
  let service = dependencies.ollama || createOllamaService({
    host:config.OLLAMA_HOST,
    model:config.OLLAMA_MODEL,
    keepAlive:config.OLLAMA_KEEP_ALIVE,
    numPredict:config.OLLAMA_NUM_PREDICT,
    numContext:config.OLLAMA_NUM_CTX
  });

  router.get('/api/chat-status', async function (req, res) {
    let data = await service.status().catch(function (error) {
      return { online:false, model:'', models:[], error:runtimeErrorMessage(error) };
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  });

  router.post('/api/chat-provider/test', security.localOnly, express.json({ limit:'8kb' }), async function (req, res) {
    let validation = validateCompatibleApi(req.body);
    if (validation.error !== undefined) return envelope.fail(res, 400, validation.error);
    let controller = new AbortController();
    req.once('aborted', function () { controller.abort(); });
    // 客户端在模型列表拉取完成前断开（如关面板）也要中止，避免 15s 探测白跑
    res.once('close', function () { if (!res.writableEnded) controller.abort(); });
    try {
      let result = await inspectCompatibleApi(validation.value, controller.signal);
      envelope.ok(res, result);
    } catch (error) {
      if (httpClient.isAbortError(error)) return;
      envelope.fail(res, envelope.statusFor(error, 502), runtimeErrorMessage(error) || 'API 连接测试失败', {
        detail:(error as any).detail || ''
      });
    }
  });

  // 站主 API 配置托管：GET 任何人可读（不含密钥），写/删仅本机
  router.get('/api/chat-provider/host-config', function (req, res) {
    res.setHeader('Cache-Control', 'no-store');
    envelope.ok(res, hostConfigPublic(config));
  });

  router.post('/api/chat-provider/host-config', security.localOnly, express.json({ limit:'8kb' }), function (req, res) {
    let validation = validateCompatibleApi(req.body);
    if (validation.error !== undefined) return envelope.fail(res, 400, validation.error);
    writeHostConfig(config, {
      baseUrl:validation.value.baseUrl,
      pathname:validation.value.pathname,
      model:validation.value.model,
      apiKey:validation.value.apiKey
    });
    envelope.ok(res, hostConfigPublic(config));
  });

  router.delete('/api/chat-provider/host-config', security.localOnly, function (req, res) {
    deleteHostConfig(config);
    envelope.ok(res, { configured:false });
  });

  // 隧道来的请求限流：一次对话生成要占满 GPU 数十秒，队列上限挡不住
  // "持续以消化速度提交"这种打法。本机直连不受限。
  let chatLimit = security.rateLimit({ capacity:10, refillMs:3000, label:'聊天' });

  router.post('/api/chat', chatLimit, express.json({ limit:'14mb' }), function (req, res) {
    const localPersona = config.ROOT_DIR && !['nene', 'natsume'].includes(req.body?.character) && security.isDirectLocalRequest(req) ? readLocalCompanions(localLive2dRoot(config.ROOT_DIR, config.DESKTOP_PACKAGED ? config.RUNTIME_ROOT : undefined))
      .find(item => item.character.id === req.body?.character)?.character.personaPrompt : undefined;
    let validation = validateChatBody(req.body, localPersona);
    if (validation.error !== undefined) return envelope.fail(res, 400, validation.error);

    // 2026-08-16 审计：桌宠本地工具（list/read/write_file/run_command）只对本机会话
    // 放行——远程隧道访客即使置 companionTools:true 也不附加工具 schema，
    // 避免模型工具调用经共享 LLM 被远程访客诱发。执行端 /api/desktop-tools 本身
    // 也是 localOnly，这里是第二道防线（不产生 tool-call 事件）。
    if (validation.value.companionTools && !security.isDirectLocalRequest(req)) {
      validation.value.companionTools = false;
    }

    let controller = new AbortController();
    let doneSent = false;
    function abort() { controller.abort(); }
    req.once('aborted', abort);
    res.once('close', function () {
      if (!res.writableEnded) abort();
    });

    let chatService: any = validation.value.provider === 'api'
      ? { streamChat:function (input: any, handlers: any) { return streamCompatibleApi(input, handlers, config); } }
      : service;
    chatService.streamChat({
      character:validation.value.character,
      model:validation.value.model,
      api:validation.value.api,
      webSearch:validation.value.webSearch,
      companionTools:validation.value.companionTools,
      reasoning:validation.value.reasoning,
      messages:validation.value.messages,
      signal:controller.signal,
      publicOnly:!security.isDirectLocalRequest(req) && !(validation.value.api && (validation.value.api as { hostConfig?: boolean }).hostConfig)
    }, {
      onStart:async function (meta: any) {
        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Chat-Queue-Wait', String(meta.queueWaitMs || 0));
        res.flushHeaders();
        await writeEvent(res, { type:'meta', model:meta.model, queueWaitMs:meta.queueWaitMs || 0 });
      },
      onToken:function (content: any) {
        return writeEvent(res, { type:'token', content:content });
      },
      onToolCall:function (call: any) {
        return writeEvent(res, Object.assign({ type:'tool-call' }, call));
      },
      onReasoning:function (content: any) {
        return writeEvent(res, { type:'reasoning', content:content });
      },
      onDone:function () {
        if (doneSent) return;
        doneSent = true;
        return writeEvent(res, { type:'done' });
      }
    }).then(function () {
      if (!res.writableEnded) res.end();
    }).catch(function (error: any) {
      if (httpClient.isAbortError(error) || controller.signal.aborted) return;
      let fallback = validation.value.provider === 'api' ? '聊天 API 暂不可用' : 'Ollama 暂不可用';
      if (!res.headersSent) {
        envelope.fail(res, envelope.statusFor(error, 503), runtimeErrorMessage(error) || fallback, {
          detail:(error as any).detail || ''
        });
        return;
      }
      if (!res.writableEnded) {
        writeEvent(res, { type:'error', error:runtimeErrorMessage(error) || '聊天流中断' })
          .catch(function () {})
          .finally(function () { if (!res.writableEnded) res.end(); });
      }
    });
  });

  return { router:router, service:service };
}

export = {
  createChatRouter:createChatRouter,
  chatCharacterPrompt:chatCharacterPrompt,
  validateChatBody:validateChatBody,
  validateCompatibleApi:validateCompatibleApi,
  streamCompatibleApi:streamCompatibleApi,
  inspectCompatibleApi:inspectCompatibleApi,
  writeEvent:writeEvent
};
