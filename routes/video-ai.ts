import { errorMessage as runtimeErrorMessage } from '../scripts/lib/runtime-errors';
'use strict';
let { readHostConfig }: typeof import('./video-ai-config') = require('./video-ai-config');
let { extractJsonObject, cleanRewriteOutput }: typeof import('./video-ai-output') = require('./video-ai-output');
let {
  REWRITE_SYSTEM_PROMPT,
  SHOT_SIZE_VALUES,
  CAMERA_VALUES,
  MOTION_VALUES,
  buildRewriteUserPrompt,
  POLISH_SYSTEM_PROMPT,
  MAX_POLISH_SHOTS,
  validatePolishBody,
  buildPolishUserPrompt,
  cleanPolishOutput,
  validateRewriteBody,
}: typeof import('./video-ai-prompts') = require('./video-ai-prompts');

/**
 * routes/video-ai.js — 分镜短片「AI 整理」服务
 *
 * 给 ShotListEditor 的「AI 整理分镜」提供两个端点：
 *   GET  /api/video-ai/status   可用性探测（公开，不含密钥）
 *   POST /api/video-ai/rewrite  单镜改写（localOnly：批量改写会消耗站主 LLM 额度）
 *
 * LLM 源复用聊天链路现有配置，不新增任何设置：
 *   1. 站主 API 托管配置优先（chat_api_config.json，与 routes/chat.js 同源）；
 *   2. 没有则回退本地 Ollama（OLLAMA_HOST + OLLAMA_MODEL，模型缺失时取已装第一个）。
 *
 * 改写契约：输入静态绘图提示词 → LLM 输出 JSON
 *   { prompt, shotSize, camera, motion, dialogue }
 * prompt 是英文自然句（H3 是自然语言模型）；其余字段服务端按白名单清洗，
 * 非法值回退输入原值，模型输出永远无法把镜头参数弄坏。
 */

let express: typeof import('express') = require('express');


let httpClient: typeof import('../services/http-client') = require('../services/http-client');
let security: typeof import('../server/security') = require('../server/security');
let envelope: typeof import('../server/http-envelope') = require('../server/http-envelope');
let createOllamaService = (require('../services/ollama-service') as typeof import('../services/ollama-service')).createOllamaService;

// ── 站主 API 托管配置（与 routes/chat.js 完全同源，避免两套配置漂移）──────


// 与 routes/chat.js 完全同源的读取缓存：按 (mtimeMs,size) 失效，命中时零磁盘 IO
// （2026-08-21 性能审计 #9）。本路由对配置只读，写路径在 chat.js 侧已失效。

async function callCompatibleApi(source: any, messages: { role: string; content: string; }[], signal: AbortSignal) {
  let result = await httpClient.request(source.api.baseUrl, source.api.pathname, {
    method:'POST',
    headers:source.api.apiKey ? { Authorization:'Bearer ' + source.api.apiKey } : {},
    json:Object.assign({
      model:source.api.model,
      messages:messages,
      stream:false,
      temperature:0.6
    },
      // DeepSeek：改写是机械任务，关思考更快更省（官方 thinking.type 开关）
      source.vendor === 'deepseek' ? { thinking:{ type:'disabled' } } : {}),
    signal:signal,
    timeoutMs:120000,
    timeoutMessage:'AI 分镜整理（API）超时'
  });
  let statusCode = result.response.statusCode || 0;
  if (statusCode < 200 || statusCode >= 300) {
    let errorBody = await httpClient.readBody(result.response, 64 * 1024);
    throw new httpClient.UpstreamError('AI 上游返回 ' + statusCode, {
      code:'UPSTREAM_STATUS',
      status:statusCode,
      detail:errorBody.toString('utf8').slice(0, 500)
    });
  }
  let body;
  try {
    body = JSON.parse((await httpClient.readBody(result.response, 1024 * 1024)).toString('utf8'));
  } catch (error) {
    throw new httpClient.UpstreamError('AI 上游返回了无法解析的响应', { code:'INVALID_UPSTREAM_JSON' });
  }
  let content = body && body.choices && body.choices[0]
    && body.choices[0].message && body.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new httpClient.UpstreamError('AI 上游返回空内容', { code:'EMPTY_RESPONSE' });
  }
  return content;
}

// Ollama 走 ollama-service.streamChat（NDJSON 流 + 串行队列 + 模型选择全复用），
// onToken 累积全文。模型名传空串 = 交给 service 选（OLLAMA_MODEL 或已装第一个）。
async function callOllama(ollama: any, messages: { role: string; content: string; }[], signal: AbortSignal) {
  let fullText = '';
  await ollama.streamChat({ model:'', messages:messages, signal:signal }, {
    onToken:async function (token: string) { fullText += token; }
  });
  if (!fullText.trim()) {
    throw new httpClient.UpstreamError('Ollama 返回空内容', { code:'EMPTY_RESPONSE' });
  }
  return fullText;
}

function createVideoAiRouter(config: any, dependencies: any) {
  dependencies = dependencies || {};
  let router = express.Router();
  let ollama = dependencies.ollama || createOllamaService({
    host:config.OLLAMA_HOST,
    model:config.OLLAMA_MODEL,
    keepAlive:config.OLLAMA_KEEP_ALIVE,
    numPredict:config.OLLAMA_NUM_PREDICT,
    numContext:config.OLLAMA_NUM_CTX
  });

  // 改写源解析：站主 API 优先 → Ollama 兜底；两者皆无返回 null。
  async function resolveSource() {
    let host = readHostConfig(config);
    if (host) {
      return {
        source:'api',
        model:host.model,
        api:host,
        vendor:host.baseUrl.includes('api.deepseek.com') ? 'deepseek' : 'custom'
      };
    }
    let status = await ollama.status().catch(function () {
      return { online:false, models:[] };
    });
    if (status.online && status.models.length) {
      return { source:'ollama', model:status.model || '', host:config.OLLAMA_HOST };
    }
    return null;
  }

  router.get('/api/video-ai/status', async function (req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      let source = await resolveSource();
      if (!source) {
        envelope.ok(res, {
          available:false,
          source:null,
          model:'',
          label:'',
          reason:'没有可用的 AI 模型：请在控制面板的聊天设置中配置 API，或启动本地 Ollama。'
        });
        return;
      }
      envelope.ok(res, {
        available:true,
        source:source.source,
        model:source.model,
        label:source.source === 'api'
          ? 'API · ' + source.model
          : 'Ollama · ' + (source.model || '本地模型')
      });
    } catch (error) {
      envelope.fail(res, 502, runtimeErrorMessage(error) || 'AI 状态探测失败');
    }
  });

  router.post('/api/video-ai/rewrite', security.localOnly, express.json({ limit:'64kb' }), async function (req, res) {
    let validation = validateRewriteBody(req.body);
    if (validation.error) return envelope.fail(res, 400, validation.error);
    let value = validation.value;
    let controller = new AbortController();
    req.once('aborted', function () { controller.abort(); });
    res.once('close', function () { if (!res.writableEnded) controller.abort(); });
    try {
      let source = await resolveSource();
      if (!source) {
        return envelope.fail(res, 409, 'AI 整理暂不可用：请先在聊天设置中配置 API 或启动 Ollama', {
          code:'AI_LLM_UNAVAILABLE'
        });
      }
      let messages = [
        { role:'system', content:REWRITE_SYSTEM_PROMPT },
        { role:'user', content:buildRewriteUserPrompt(value) }
      ];
      let content = source.source === 'api'
        ? await callCompatibleApi(source, messages, controller.signal)
        : await callOllama(ollama, messages, controller.signal);
      let shot = cleanRewriteOutput(extractJsonObject(content), value);
      envelope.ok(res, { source:source.source, model:source.model, shot:shot });
    } catch (error: any) {
      if (httpClient.isAbortError(error)) return;
      envelope.fail(res, envelope.statusFor(error, 502), runtimeErrorMessage(error) || 'AI 整理失败', {
        detail:error.detail || ''
      });
    }
  });

  router.post('/api/video-ai/polish', security.localOnly, express.json({ limit:'256kb' }), async function (req, res) {
    let validation = validatePolishBody(req.body);
    if (validation.error) return envelope.fail(res, 400, validation.error);
    let value = validation.value;
    let controller = new AbortController();
    req.once('aborted', function () { controller.abort(); });
    res.once('close', function () { if (!res.writableEnded) controller.abort(); });
    try {
      let source = await resolveSource();
      if (!source) {
        return envelope.fail(res, 409, 'AI 编排暂不可用：请先在聊天设置中配置 API 或启动 Ollama', {
          code:'AI_LLM_UNAVAILABLE'
        });
      }
      let messages = [
        { role:'system', content:POLISH_SYSTEM_PROMPT },
        { role:'user', content:buildPolishUserPrompt(value) }
      ];
      let content = source.source === 'api'
        ? await callCompatibleApi(source, messages, controller.signal)
        : await callOllama(ollama, messages, controller.signal);
      let shots = cleanPolishOutput(extractJsonObject(content), value);
      envelope.ok(res, { source:source.source, model:source.model, shots:shots });
    } catch (error: any) {
      if (httpClient.isAbortError(error)) return;
      envelope.fail(res, envelope.statusFor(error, 502), runtimeErrorMessage(error) || 'AI 编排失败', {
        detail:error.detail || ''
      });
    }
  });

  // 统一 LLM 调用：选源 → 提示词 → 调用 → 返回原始文本。
  async function callLlm(source: any, messages: { role: string; content: string; }[], signal: AbortSignal) {
    return source.source === 'api'
      ? await callCompatibleApi(source, messages, signal)
      : await callOllama(ollama, messages, signal);
  }

  router.post('/api/video-ai/dialogue', security.localOnly, express.json({ limit:'64kb' }), async function (req, res) {
    let validation = validateDialogueBody(req.body);
    if (validation.error) return envelope.fail(res, 400, validation.error);
    let value = validation.value;
    let controller = new AbortController();
    req.once('aborted', function () { controller.abort(); });
    res.once('close', function () { if (!res.writableEnded) controller.abort(); });
    try {
      let source = await resolveSource();
      if (!source) return envelope.fail(res, 409, 'AI 台词暂不可用：请先在聊天设置中配置 API 或启动 Ollama', { code:'AI_LLM_UNAVAILABLE' });
      let content = await callLlm(source, [
        { role:'system', content:DIALOGUE_SYSTEM_PROMPT },
        { role:'user', content:buildDialogueUserPrompt(value) }
      ], controller.signal);
      envelope.ok(res, { source:source.source, model:source.model, options:cleanDialogueOutput(extractJsonObject(content)) });
    } catch (error: any) {
      if (httpClient.isAbortError(error)) return;
      envelope.fail(res, envelope.statusFor(error, 502), runtimeErrorMessage(error) || 'AI 台词失败', { detail:error.detail || '' });
    }
  });

  router.post('/api/video-ai/review', security.localOnly, express.json({ limit:'256kb' }), async function (req, res) {
    let validation = validateReviewBody(req.body);
    if (validation.error) return envelope.fail(res, 400, validation.error);
    let value = validation.value;
    let controller = new AbortController();
    req.once('aborted', function () { controller.abort(); });
    res.once('close', function () { if (!res.writableEnded) controller.abort(); });
    try {
      let source = await resolveSource();
      if (!source) return envelope.fail(res, 409, 'AI 质检暂不可用：请先在聊天设置中配置 API 或启动 Ollama', { code:'AI_LLM_UNAVAILABLE' });
      let content = await callLlm(source, [
        { role:'system', content:REVIEW_SYSTEM_PROMPT },
        { role:'user', content:buildReviewUserPrompt(value) }
      ], controller.signal);
      envelope.ok(res, { source:source.source, model:source.model, issues:cleanReviewOutput(extractJsonObject(content), value) });
    } catch (error: any) {
      if (httpClient.isAbortError(error)) return;
      envelope.fail(res, envelope.statusFor(error, 502), runtimeErrorMessage(error) || 'AI 质检失败', { detail:error.detail || '' });
    }
  });

  router.post('/api/video-ai/script', security.localOnly, express.json({ limit:'64kb' }), async function (req, res) {
    let validation = validateScriptBody(req.body);
    if (validation.error) return envelope.fail(res, 400, validation.error);
    let value = validation.value;
    let controller = new AbortController();
    req.once('aborted', function () { controller.abort(); });
    res.once('close', function () { if (!res.writableEnded) controller.abort(); });
    try {
      let source = await resolveSource();
      if (!source) return envelope.fail(res, 409, 'AI 脚本暂不可用：请先在聊天设置中配置 API 或启动 Ollama', { code:'AI_LLM_UNAVAILABLE' });
      let content = await callLlm(source, [
        { role:'system', content:SCRIPT_SYSTEM_PROMPT },
        { role:'user', content:buildScriptUserPrompt(value) }
      ], controller.signal);
      envelope.ok(res, { source:source.source, model:source.model, shots:cleanScriptOutput(extractJsonObject(content)) });
    } catch (error: any) {
      if (httpClient.isAbortError(error)) return;
      envelope.fail(res, envelope.statusFor(error, 502), runtimeErrorMessage(error) || 'AI 脚本失败', { detail:error.detail || '' });
    }
  });

  return { router:router };
}

// ── 台词润色 / 质量检查 / 全自动脚本（2026-08-17 短片流水线扩展）─────────
let DIALOGUE_SYSTEM_PROMPT = [
  'You are a dialogue writer for an anime video shot.',
  'Write short natural spoken lines based on the shot description and character context.',
  '',
  'Reply with ONLY a JSON object: {"options":[{"text":"...","label":"..."}, ...]} with exactly 3 options.',
  'No markdown, no commentary.',
  '',
  'Rules:',
  '- Each line is at most 20 Chinese characters (or 60 English characters), natural spoken language, matching the scene language (Chinese scene -> Chinese line).',
  '- The three options must differ in tone: one short and plain, one gentle/emotional, one slightly playful or dramatic.',
  '- The line must fit the action and emotion of the shot; do not invent off-screen dialogue.',
  '- "label" is a short Chinese tone tag (e.g. "简洁", "温柔", "俏皮").',
  '- If a current dialogue is provided, the FIRST option must be a polished version of it (keep the meaning), the other two are fresh alternatives.',
  '- If the shot does not need dialogue, still give 3 short fitting lines - never return empty options.'
].join('\n');

let REVIEW_SYSTEM_PROMPT = [
  'You are a quality inspector for an anime video storyboard.',
  'Review each shot for problems and reply with ONLY a JSON object:',
  '{"issues":[{"index":0,"severity":"warn","field":"camera","message":"...","suggestion":"..."}]}',
  'No markdown, no commentary. Use an empty "issues" array when everything is fine.',
  '',
  'Check for:',
  '1. Description problems: too static (reads like a still image, no action or time flow), too short, or missing camera intent.',
  '2. Field contradictions: e.g. description says running but motion is "subtle"; says close framing but shotSize is "wide".',
  '3. Dialogue problems: longer than 20 Chinese characters, language mismatch (Chinese scene with English line), or too many consecutive shots with dialogue.',
  '4. Continuity: a shot that clearly jumps in space/time from the previous one without a transition cue.',
  '',
  '"severity" is "error" (must fix) or "warn" (should improve).',
  '"field" is one of "prompt","shotSize","camera","motion","dialogue","continuity".',
  '"message" is a short Chinese explanation; "suggestion" is a concrete fix (max 60 chars each).'
].join('\n');

let SCRIPT_SYSTEM_PROMPT = [
  'You are a director turning a story synopsis into an anime video shot list.',
  'Reply with ONLY a JSON object:',
  '{"shots":[{"prompt":"...","shotSize":"medium","camera":"still","motion":"natural","dialogue":"...","duration":5}, ...]}',
  'No markdown, no commentary.',
  '',
  'Rules:',
  '- Split the story into 8-15 shots (fewer for short synopses).',
  '- "prompt": 1-3 English sentences describing what HAPPENS in the shot: subject action, camera intent, time flow. Keep identity, outfit and scene consistent.',
  '- Use <Picture 1> / <Picture 2> labels when multiple characters are defined and appear in the shot (e.g. "Nene hands the letter to <Picture 2>.").',
  '- "shotSize": "wide"|"medium"|"closeup" - vary for rhythm: open scenes wide, emotional beats closeup.',
  '- "camera": "still"|"push"|"pull"|"pan"|"orbit" - vary; movement must serve the action.',
  '- "motion": "subtle"|"natural"|"expressive" - match action intensity.',
  '- "dialogue": a short line (at most 20 Chinese characters) for shots that need speech; "" for silent shots.',
  '- "duration": 3, 5, 10 or 15 seconds - 5s is the default; use 10/15s sparingly for key shots.',
  '- If a target total duration is given, keep the sum close to it.'
].join('\n');

function validateDialogueBody(body: any) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error:'请求体必须是 JSON 对象' };
  let prompt = String(body.prompt || '').trim();
  if (!prompt || prompt.length > 4000) return { error:'镜头描述需为 1—4000 字符' };
  let identity = String(body.identity || '').trim().slice(0, 600);
  let currentDialogue = String(body.currentDialogue || '').trim().slice(0, 300);
  let mood = String(body.mood || '').trim().slice(0, 60);
  return { value:{ prompt:prompt, identity:identity, currentDialogue:currentDialogue, mood:mood } };
}

function buildDialogueUserPrompt(value: { prompt: string; identity: string; currentDialogue: string; mood: string; }|undefined) {
  return [
    'Identity anchor (for reference only): ' + (value!.identity || '(none)'),
    'Shot description: ' + value!.prompt,
    value!.currentDialogue ? 'Current dialogue: ' + value!.currentDialogue : '',
    value!.mood ? 'Requested mood: ' + value!.mood : '',
    '',
    value!.currentDialogue ? 'Polish the current dialogue and give two alternatives:' : 'Write three dialogue options for this shot:'
  ].filter(Boolean).join('\n');
}

function cleanDialogueOutput(parsed: { options: string|any[]; }) {
  let options = [];
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.options)) {
    for (let i = 0; i < parsed.options.length && options.length < 3; i += 1) {
      let item: any = parsed.options[i];
      if (!item || typeof item !== 'object') continue;
      let text = String(item.text || '').trim();
      if (!text || text.length > 60) continue;
      options.push({ text:text, label:String(item.label || '').trim().slice(0, 12) });
    }
  }
  return options;
}

function validateReviewBody(body: { shots: string|any[]; }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error:'请求体必须是 JSON 对象' };
  if (!Array.isArray(body.shots) || body.shots.length < 1 || body.shots.length > MAX_POLISH_SHOTS) {
    return { error:'分镜数量需为 1—' + MAX_POLISH_SHOTS };
  }
  let shots = [];
  for (let i = 0; i < body.shots.length; i += 1) {
    let shot: any = body.shots[i];
    if (!shot || typeof shot !== 'object') return { error:'第 ' + (i + 1) + ' 个分镜必须是对象' };
    let prompt = String(shot.prompt || '').trim();
    if (!prompt || prompt.length > 4000) return { error:'第 ' + (i + 1) + ' 个分镜描述需为 1—4000 字符' };
    shots.push({
      prompt:prompt,
      shotSize:shot.shotSize === null || shot.shotSize === undefined || shot.shotSize === '' ? null : String(shot.shotSize),
      camera:String(shot.camera || 'still'),
      motion:String(shot.motion || 'subtle'),
      dialogue:String(shot.dialogue || '').trim().slice(0, 300),
    });
  }
  return { value:{ shots:shots } };
}

function buildReviewUserPrompt(value: { shots: { prompt: string; shotSize: string|null; camera: string; motion: string; dialogue: string; }[]; }|undefined) {
  let lines = ['Shot list (index | shotSize | camera | motion | dialogue | description):'];
  value!.shots.forEach(function (shot, index: number) {
    lines.push((index + 1) + '. ' + (shot.shotSize || 'default') + ' | ' + shot.camera + ' | ' + shot.motion
      + ' | ' + (shot.dialogue ? JSON.stringify(shot.dialogue) : '""')
      + ' | ' + shot.prompt.slice(0, 200));
  });
  lines.push('', 'Inspect this shot list:');
  return lines.join('\n');
}

let REVIEW_FIELDS = ['prompt', 'shotSize', 'camera', 'motion', 'dialogue', 'continuity'];

function cleanReviewOutput(parsed: { issues: string|any[]; }, value: { shots: { prompt: string; shotSize: string|null; camera: string; motion: string; dialogue: string; }[]; }|undefined) {
  let issues: { index: number; severity: string; field: string; message: string; suggestion: string; }[] = [];
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.issues)) return issues;
  for (let i = 0; i < parsed.issues.length; i += 1) {
    let item: any = parsed.issues[i];
    if (!item || typeof item !== 'object') continue;
    let index = Number(item.index);
    if (!Number.isInteger(index) || index < 0 || index >= value!.shots.length) continue;
    let severity = String(item.severity || '').trim();
    if (severity !== 'error' && severity !== 'warn') continue;
    let field = String(item.field || '').trim();
    if (REVIEW_FIELDS.indexOf(field) === -1) continue;
    let message = String(item.message || '').trim().slice(0, 120);
    if (!message) continue;
    issues.push({
      index:index,
      severity:severity,
      field:field,
      message:message,
      suggestion:String(item.suggestion || '').trim().slice(0, 120),
    });
  }
  return issues;
}

function validateScriptBody(body: any) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error:'请求体必须是 JSON 对象' };
  let story = String(body.story || '').trim();
  if (!story || story.length > 2000) return { error:'故事梗概需为 1—2000 字符' };
  let identity = String(body.identity || '').trim().slice(0, 600);
  let shotCount = body.shotCount === undefined || body.shotCount === null || body.shotCount === ''
    ? null
    : Number(body.shotCount);
  if (shotCount !== null && (!Number.isInteger(shotCount) || shotCount < 4 || shotCount > 20)) {
    return { error:'镜头数需为 4—20 的整数' };
  }
  let totalSeconds = body.totalSeconds === undefined || body.totalSeconds === null || body.totalSeconds === ''
    ? null
    : Number(body.totalSeconds);
  if (totalSeconds !== null && (!Number.isInteger(totalSeconds) || totalSeconds < 15 || totalSeconds > 300)) {
    return { error:'总时长需为 15—300 秒' };
  }
  let characterLabels = Array.isArray(body.characterLabels)
    ? body.characterLabels.map(String).filter(Boolean).slice(0, 6)
    : [];
  return { value:{ story:story, identity:identity, shotCount:shotCount, totalSeconds:totalSeconds, characterLabels:characterLabels } };
}

function buildScriptUserPrompt(value: any) {
  let lines = [
    'Identity anchor (for reference only): ' + (value.identity || '(none)'),
  ];
  if (value.characterLabels.length) {
    lines.push('Characters: ' + value.characterLabels.map(function (label: string, i: number) {
      return '<Picture ' + (i + 1) + '> = ' + label;
    }).join('; '));
  }
  lines.push('Story synopsis: ' + value.story);
  if (value.shotCount) lines.push('Target shot count: ' + value.shotCount);
  if (value.totalSeconds) lines.push('Target total duration: ' + value.totalSeconds + ' seconds');
  lines.push('', 'Create the shot list:');
  return lines.join('\n');
}

function cleanScriptOutput(parsed: { shots: string|any[]; }) {
  let shots: { prompt: string; shotSize: string|null; camera: string; motion: string; dialogue: string; duration: number; }[] = [];
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.shots)) return shots;
  for (let i = 0; i < parsed.shots.length && shots.length < 20; i += 1) {
    let item: any = parsed.shots[i];
    if (!item || typeof item !== 'object') continue;
    let prompt = String(item.prompt || '').trim();
    if (!prompt || prompt.length > 4000) continue;
    let shotSize = String(item.shotSize || '');
    let camera = String(item.camera || 'still');
    let motion = String(item.motion || 'subtle');
    let dialogue = String(item.dialogue || '').trim().slice(0, 300);
    let duration = Number(item.duration);
    if (![3, 5, 10, 15].includes(duration)) duration = 5;
    shots.push({
      prompt:prompt,
      shotSize:SHOT_SIZE_VALUES.indexOf(shotSize) !== -1 ? shotSize : null,
      camera:CAMERA_VALUES.indexOf(camera) !== -1 ? camera : 'still',
      motion:MOTION_VALUES.indexOf(motion) !== -1 ? motion : 'subtle',
      dialogue:dialogue,
      duration:duration,
    });
  }
  return shots;
}

export = { createVideoAiRouter:createVideoAiRouter };
