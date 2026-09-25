'use strict';

import type { Normalized } from '../server/chat-types';

let { normalizeMultimodalContent }: typeof import('./chat-content') = require('./chat-content');
let companionTools: typeof import('../server/companion-tools') = require('../server/companion-tools');
let chatPrompts: typeof import('../server/chat-character-prompts') = require('../server/chat-character-prompts');

function normalizeToolMessage(raw: any) {
  let role = String(raw && raw.role || '');
  if (role === 'assistant') {
    if (!Array.isArray(raw.tool_calls) || !raw.tool_calls.length || raw.tool_calls.length > 8) {
      return { error:'assistant 工具调用消息格式错误' };
    }
    let content = String(raw.content || '');
    if (content.length > 1200) return { error:'工具调用消息内容过长' };
    // DeepSeek V4 要求思考轮带 tool_calls 时必须回传 reasoning_content
    let reasoningContent = String(raw.reasoning_content || '');
    if (reasoningContent.length > 20000) return { error:'推理过程过长' };
    let toolCalls = [];
    for (let i = 0; i < raw.tool_calls.length; i += 1) {
      let call = raw.tool_calls[i] || {};
      let id = String(call.id || '');
      let name = String(call.function && call.function.name || '');
      let argsText = String(call.function && call.function.arguments || '');
      if (!id || id.length > 128) return { error:'工具调用 ID 无效' };
      if (!companionTools.isKnownToolName(name)) return { error:'未知的工具调用：' + name };
      if (argsText.length > 4000) return { error:'工具调用参数过长' };
      toolCalls.push({ id:id, type:'function', function:{ name:name, arguments:argsText } });
    }
    let message: any = { role:'assistant', content:content, tool_calls:toolCalls };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    return { message:message };
  }
  if (role === 'tool') {
    let callId = String(raw.tool_call_id || '');
    let toolContent = String(raw.content || '');
    if (!callId || callId.length > 128) return { error:'工具结果 ID 无效' };
    if (toolContent.length > 60000) return { error:'工具结果过长' };
    return { message:{ role:'tool', tool_call_id:callId, content:toolContent } };
  }
  return { error:'工具消息角色无效' };
}

declare namespace chatValidation {
  export type ChatValidationValue = {
    character: string;
    provider: 'local' | 'api';
    model: string;
    api: null | { hostConfig: true } | { baseUrl: string; pathname: string; model: string; apiKey: string; vendor: string };
    webSearch: boolean;
    companionTools: boolean;
    reasoning: string;
    messages: any[];
  };

  export type CompatibleApiValue = { baseUrl: string; pathname: string; model: string; apiKey: string; vendor: string };
}

type ChatValidationValue = chatValidation.ChatValidationValue;
type CompatibleApiValue = chatValidation.CompatibleApiValue;

function validateCompatibleApi(input: any): Normalized<CompatibleApiValue> {
  let baseUrl = String(input && input.baseUrl || '').trim();
  let model = String(input && input.model || '').trim();
  let apiKey = String(input && input.apiKey || '').trim();
  if (!baseUrl || baseUrl.length > 500) return { error:'API 地址不能为空或过长' };
  if (!model || model.length > 200) return { error:'API 模型名不能为空或过长' };
  if (apiKey.length > 1000) return { error:'API Key 过长' };

  let parsed;
  try { parsed = new URL(baseUrl); } catch (error) {
    return { error:'API 地址格式无效' };
  }
  let hostname = parsed.hostname.toLowerCase();
  let localHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHost)) {
    return { error:'远程 API 必须使用 HTTPS；本机地址可以使用 HTTP' };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { error:'API 地址不能包含账号、查询参数或锚点' };
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/';
  let endpoint = parsed.pathname.endsWith('/chat/completions')
    ? parsed
    : new URL('chat/completions', parsed);
  return {
    value:{
      baseUrl:endpoint.origin,
      pathname:endpoint.pathname,
      model:model,
      apiKey:apiKey,
      vendor:hostname === 'api.deepseek.com'
        ? 'deepseek'
        : hostname === 'opencode.ai' && endpoint.pathname.startsWith('/zen/') ? 'opencode' : 'custom'
    }
  };
}

/** 校验结果：要么带 error，要么带 value，二者互斥。 */
function validateChatBody(body: any, localPersona?: string): Normalized<ChatValidationValue> {
  let character = String(body && body.character || 'nene');
  let provider: ChatValidationValue['provider'] = body && body.provider === 'api' ? 'api' : 'local';
  let requestedModel = String(body && body.model || '');
  let rawMessages = body && body.messages;
  let companionTools = body && body.companionTools === true;
  if (!['nene', 'natsume'].includes(character) && !localPersona) return { error:'不支持的聊天角色' };
  let profileValidation = chatPrompts.normalizeUserProfile(body && body.userProfile);
  if (profileValidation.error) return { error:profileValidation.error };
  let memoryValidation = chatPrompts.normalizeMemories(body && body.memories);
  if (memoryValidation.error) return { error:memoryValidation.error };
  if (!Array.isArray(rawMessages) || !rawMessages.length) {
    return { error:'对话记录必须包含 1—24 条消息' };
  }

  // 工具消息（assistant tool_calls / role:tool）不参与裁剪：它们来自最近的
  // 工具循环（数量少、在对话尾部），且必须与配套消息相邻才能被上游接受。
  let toolMessages: any[] = [];
  let textSource: any[] = [];
  for (let i = 0; i < rawMessages.length; i += 1) {
    let role = String(rawMessages[i] && rawMessages[i].role || '');
    if (role === 'tool' || (role === 'assistant' && Array.isArray(rawMessages[i].tool_calls) && rawMessages[i].tool_calls.length)) {
      let normalized = normalizeToolMessage(rawMessages[i]);
      if (normalized.error) return { error:normalized.error };
      toolMessages.push(normalized.message);
    } else {
      textSource.push(rawMessages[i]);
    }
  }

  // 普通消息裁剪（原有逻辑）：user/assistant 文本消息。多模态 user 消息
  // （content 数组，含图片）单独校验且不参与裁剪——数量少、体积受
  // express.json body 上限约束。
  let kept: any[] = [];
  let used = 0;
  let count = 0;
  for (let j = textSource.length - 1; j >= 0 && count < 24; j -= 1) {
    let textRole = String(textSource[j] && textSource[j].role || '');
    let content = textSource[j] && textSource[j].content;
    if (textRole === 'user' && Array.isArray(content)) {
      let multimodal = normalizeMultimodalContent(content);
      if (multimodal.error) return { error:multimodal.error };
      kept.unshift({ role:'user', content:multimodal.content });
      count += 1;
      continue;
    }
    let text = String(content || '').trim();
    if (!['user', 'assistant'].includes(textRole) || !text || text.length > 1200) {
      return { error:'对话消息格式错误或内容过长' };
    }
    if (used + text.length > 12000 && kept.length) break;
    used += text.length;
    count += 1;
    kept.unshift({ role:textRole, content:text });
  }
  if (!kept.length && !toolMessages.length) return { error:'对话记录必须包含有效的消息' };

  let api: ChatValidationValue['api'] = null;
  let useHostConfig = body && body.hostConfig === true;
  if (provider === 'api') {
    if (useHostConfig) {
      // 访客模式：密钥在服务端，前端只带一个标记
      api = { hostConfig:true };
    } else {
      let apiValidation = validateCompatibleApi(body && body.api);
      if (apiValidation.error !== undefined) return { error:apiValidation.error };
      api = apiValidation.value;
    }
  }
  let reasoning = String(body && body.reasoning || '');
  if (reasoning && ['low', 'medium', 'high', 'off'].indexOf(reasoning) === -1) {
    return { error:'推理强度必须是 off / low / medium / high' };
  }
  return {
    value:{
      character:character,
      provider:provider,
      model:requestedModel,
      api:api,
      webSearch:body && body.webSearch === true,
      companionTools:companionTools,
      reasoning:reasoning,
      messages:[{ role:'system', content:chatPrompts.buildCharacterPrompt(character, { userProfile:profileValidation.value, memories:memoryValidation.value }, localPersona) }].concat(kept).concat(toolMessages)
    }
  };
}

const chatValidation = {
  normalizeToolMessage,
  validateChatBody,
  validateCompatibleApi,
};

export = chatValidation;
