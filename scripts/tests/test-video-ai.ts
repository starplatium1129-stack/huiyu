'use strict';

import { Server,IncomingMessage,ServerResponse } from 'node:http';

/**
 * scripts/tests/test-video-ai.js — 分镜「AI 整理」端点回归
 *
 * 覆盖：
 *   1. 无 LLM 源（API 未托管 + Ollama 不可达）→ status unavailable / rewrite 409
 *   2. API 源（chat_api_config.json 托管，自建 OpenAI 兼容 mock）：
 *      状态探测、请求体（Bearer/stream:false/提示词结构）、JSON 清洗、
 *      markdown 围栏提取、非法枚举回退、非 JSON 回退、输入白名单 400
 *   3. Ollama 源（mock /api/tags + /api/chat NDJSON）：状态探测 + 改写
 */

var assert: typeof import('assert/strict') = require('assert/strict');
var fs: typeof import('fs') = require('fs');
var http: typeof import('http') = require('http');
var path: typeof import('path') = require('path');
var gatewayStack: typeof import('./gateway-test-stack') = require('./gateway-test-stack');

var DEAD_OLLAMA_URL = 'http://127.0.0.1:9';

// 自建 OpenAI 兼容 mock：记录请求、按队列逐次返回预设 content。
function createApiMock() {
  var state = { requests:[], replies:[] };
  var server = http.createServer(function (req, res) {
    var chunks: any = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () {
      var body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (error) { /* 保持空 */ }
      state.requests.push({ method:req.method, url:req.url, headers:req.headers, body:body });
      var reply = state.replies.length ? state.replies.shift() : DEFAULT_REPLY;
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ choices:[{ message:{ role:'assistant', content:reply } }] }));
    });
  });
  return { server:server, state:state };
}

var DEFAULT_REPLY = JSON.stringify({
  prompt:'She turns toward the counter.',
  shotSize:'medium',
  camera:'still',
  motion:'natural',
  dialogue:''
});

function listen(server: Server<IncomingMessage,ServerResponse>) {
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () { resolve(server.address().port); });
  });
}

function closeServer(server: Server<IncomingMessage,ServerResponse>) {
  return new Promise(function (resolve) {
    if (!server || !server.listening) return resolve();
    server.close(function () { resolve(); });
  });
}

async function postRewrite(base: string, body: { prompt: string; identity?: string; shotSize?: string|null; camera?: string; motion?: string; unknown?: number; }) {
  return fetch(base + '/api/video-ai/rewrite', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body)
  });
}

async function run() {
  // ── 1. 无 LLM 源：Ollama 不可达 + 未托管 API ──────────────────────────
  var stackNone = await gatewayStack.start({
    prefix:'video-ai-none-',
    configureConfig:function (config: { OLLAMA_HOST: string; }) { config.OLLAMA_HOST = DEAD_OLLAMA_URL; }
  });
  try {
    var statusNone = await (await fetch(stackNone.baseUrl + '/api/video-ai/status')).json();
    assert.equal(statusNone.available, false, 'no source -> unavailable');
    assert.match(statusNone.reason || '', /API|Ollama/, 'unavailable reason must point at the missing source');

    var rewriteNone = await postRewrite(stackNone.baseUrl, { prompt:'雨夜，她走进便利店。' });
    assert.equal(rewriteNone.status, 409, 'rewrite without a source must be 409');
  } finally {
    await stackNone.close();
  }

  // ── 2. API 源：host-config 托管 + OpenAI 兼容 mock ────────────────────
  var apiMock: any = createApiMock();
  var apiPort = await listen(apiMock.server);
  var stackApi = await gatewayStack.start({
    prefix:'video-ai-api-',
    prepare:async function (ctx: { runtime: { state: string; }; }) {
      fs.writeFileSync(path.join(ctx.runtime.state, 'chat_api_config.json'), JSON.stringify({
        baseUrl:'http://127.0.0.1:' + apiPort,
        pathname:'/v1/chat/completions',
        model:'mock-rewrite',
        apiKey:'sk-test-key'
      }, null, 2), { mode:0o600 });
    }
  });
  try {
    var statusApi = await (await fetch(stackApi.baseUrl + '/api/video-ai/status')).json();
    assert.equal(statusApi.available, true);
    assert.equal(statusApi.source, 'api', 'host-config must take priority over the online Ollama mock');
    assert.equal(statusApi.model, 'mock-rewrite');
    assert.match(statusApi.label, /API/);

    // 合法 JSON：字段全部应用
    var okRes = await postRewrite(stackApi.baseUrl, {
      identity:'a girl with silver hair',
      prompt:'车站前，少女回头微笑，黄昏逆光。',
      shotSize:'medium',
      camera:'still',
      motion:'subtle'
    });
    assert.equal(okRes.status, 200);
    var ok = await okRes.json();
    assert.equal(ok.shot.prompt, 'She turns toward the counter.');
    assert.equal(ok.shot.shotSize, 'medium');
    assert.equal(ok.shot.camera, 'still');
    assert.equal(ok.shot.motion, 'natural');
    assert.equal(ok.shot.dialogue, '');

    // 请求体断言：Bearer、非流式、提示词结构（system 规则 + user 输入）
    var req: any = apiMock.state.requests[0];
    assert.equal(req.headers.authorization, 'Bearer sk-test-key');
    assert.equal(req.body.stream, false);
    assert.equal(req.body.model, 'mock-rewrite');
    assert.match(req.body.messages[0].content, /storyboard/);
    assert.match(req.body.messages[1].content, /a girl with silver hair/);
    assert.match(req.body.messages[1].content, /车站前/);
    assert.equal(req.body.messages.length, 2, 'no tool/web_search noise for the rewrite call');

    // markdown 围栏 + 非法枚举：非法值回退输入原值，非法景别回退 null
    apiMock.state.replies.push('```json\n{"prompt":"She walks away.","shotSize":"bogus","camera":"fly","motion":"dance","dialogue":"走吧。"}\n```');
    var fenceRes = await postRewrite(stackApi.baseUrl, {
      prompt:'她转身离开。', shotSize:null, camera:'push', motion:'subtle'
    });
    assert.equal(fenceRes.status, 200);
    var fence = await fenceRes.json();
    assert.equal(fence.shot.prompt, 'She walks away.', 'markdown fences must be stripped');
    assert.equal(fence.shot.shotSize, null, 'unknown shot size falls back to null (safe)');
    assert.equal(fence.shot.camera, 'push', 'unknown camera falls back to the input value');
    assert.equal(fence.shot.motion, 'subtle', 'unknown motion falls back to the input value');
    assert.equal(fence.shot.dialogue, '走吧。');

    // 非 JSON 回复：prompt 回退原描述，其余保持输入
    apiMock.state.replies.push('sorry, I cannot help with that request');
    var gibberishRes = await postRewrite(stackApi.baseUrl, {
      prompt:'原始描述', camera:'still', motion:'subtle'
    });
    assert.equal(gibberishRes.status, 200);
    var gibberish = await gibberishRes.json();
    assert.equal(gibberish.shot.prompt, '原始描述', 'unparseable output must keep the original prompt');
    assert.equal(gibberish.shot.camera, 'still');
    assert.equal(gibberish.shot.motion, 'subtle');
    assert.equal(gibberish.shot.shotSize, null);

    // 输入白名单：空 prompt / 非法枚举 / 未知字段一律 400
    assert.equal((await postRewrite(stackApi.baseUrl, { prompt:'   ' })).status, 400);
    assert.equal((await postRewrite(stackApi.baseUrl, { prompt:'x', camera:'fly' })).status, 400);
    assert.equal((await postRewrite(stackApi.baseUrl, { prompt:'x', unknown:1 })).status, 400);
    assert.equal((await postRewrite(stackApi.baseUrl, { prompt:'x'.repeat(4001) })).status, 400);

    // ── 整批节奏编排 /api/video-ai/polish ─────────────────────────────
    function polishBody(overrides?: { shots: ({ prompt: string; camera: string; }|{ prompt: string; camera?: any; })[]; }|undefined) {
      return Object.assign({
        shots:[
          { prompt:'她走进咖啡店。', shotSize:'medium', camera:'still', motion:'subtle', dialogue:'' },
          { prompt:'她端起咖啡杯。', shotSize:'medium', camera:'still', motion:'subtle', dialogue:'' },
          { prompt:'她望向窗外。', shotSize:'medium', camera:'still', motion:'subtle', dialogue:'' },
        ],
      }, overrides || {});
    }
    async function postPolish(base: string, body: { shots: { prompt: string; }[]|{ prompt: string; }[]; }) {
      return fetch(base + '/api/video-ai/polish', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify(body)
      });
    }

    // 编排成功：index 对齐应用，null 保持，请求体含整批镜头
    apiMock.state.replies.push(JSON.stringify({
      shots:[
        { index:0, shotSize:null, camera:'push', motion:null, dialogue:null },
        { index:1, shotSize:'closeup', camera:null, motion:'natural', dialogue:'好香。' },
        { index:2, shotSize:null, camera:null, motion:null, dialogue:'' },
      ]
    }));
    var polishOkRes = await postPolish(stackApi.baseUrl, polishBody());
    assert.equal(polishOkRes.status, 200);
    var polishOk = await polishOkRes.json();
    assert.equal(polishOk.shots.length, 3);
    assert.equal(polishOk.shots[0].camera, 'push', 'camera suggestion applied by index');
    assert.equal(polishOk.shots[0].shotSize, null, 'null field keeps current value');
    assert.equal(polishOk.shots[1].shotSize, 'closeup');
    assert.equal(polishOk.shots[1].motion, 'natural');
    assert.equal(polishOk.shots[1].dialogue, '好香。');
    assert.equal(polishOk.shots[2].dialogue, '', 'empty dialogue suggestion clears the line');
    assert.match(apiMock.state.requests[apiMock.state.requests.length - 1].body.messages[0].content, /rhythm editor/);
    assert.match(apiMock.state.requests[apiMock.state.requests.length - 1].body.messages[1].content, /她走进咖啡店/);

    // 清洗：非法枚举/越界 index 跳过（保持原值）
    apiMock.state.replies.push(JSON.stringify({
      shots:[
        { index:0, shotSize:'bogus', camera:'fly', motion:'dance', dialogue:'x'.repeat(400) },
        { index:99, shotSize:'closeup', camera:null, motion:null, dialogue:null },
        { index:1, shotSize:null, camera:'pan', motion:null, dialogue:'可以。' },
      ]
    }));
    var polishDirtyRes = await postPolish(stackApi.baseUrl, polishBody());
    assert.equal(polishDirtyRes.status, 200);
    var polishDirty = await polishDirtyRes.json();
    assert.equal(polishDirty.shots[0].shotSize, null, 'unknown shot size -> keep');
    assert.equal(polishDirty.shots[0].camera, null, 'unknown camera -> keep');
    assert.equal(polishDirty.shots[0].motion, null, 'unknown motion -> keep');
    assert.equal(polishDirty.shots[0].dialogue, null, 'oversized dialogue -> keep');
    assert.equal(polishDirty.shots[1].shotSize, null, 'out-of-range index 99 entry skipped');
    assert.equal(polishDirty.shots[1].camera, 'pan', 'valid index 1 entry still applied');
    assert.equal(polishDirty.shots[2].camera, null, 'no entry for index 2 -> keep');

    // 输入校验：单镜 / 非法镜头枚举 / 缺描述 400
    assert.equal((await postPolish(stackApi.baseUrl, { shots:[{ prompt:'x' }] })).status, 400);
    assert.equal((await postPolish(stackApi.baseUrl, polishBody({ shots:[{ prompt:'x', camera:'fly' }, { prompt:'y' }] }))).status, 400);
    assert.equal((await postPolish(stackApi.baseUrl, { shots:[{ prompt:'' }, { prompt:'y' }] })).status, 400);

    // ── 台词润色 /api/video-ai/dialogue ────────────────────────────────
    apiMock.state.replies.push(JSON.stringify({
      options:[
        { text:'这杯咖啡，给你。', label:'简洁' },
        { text:'一直想请你尝尝我的手艺。', label:'温柔' },
        { text:'尝尝看，保证好喝！', label:'俏皮' },
      ]
    }));
    var diaRes = await fetch(stackApi.baseUrl + '/api/video-ai/dialogue', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ prompt:'她递过咖啡。', currentDialogue:'给你。' })
    });
    assert.equal(diaRes.status, 200);
    var dia = await diaRes.json();
    assert.equal(dia.options.length, 3);
    assert.equal(dia.options[0].text, '这杯咖啡，给你。');
    assert.equal(dia.options[1].label, '温柔');
    // 清洗：超长/空选项丢弃
    apiMock.state.replies.push(JSON.stringify({ options:[{ text:'x'.repeat(200), label:'' }, { text:'', label:'' }, { text:'好。', label:'简' }, { text:'也可以。', label:'平' }] }));
    var diaDirty = await (await fetch(stackApi.baseUrl + '/api/video-ai/dialogue', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ prompt:'她点头。' })
    })).json();
    assert.equal(diaDirty.options.length, 2);
    assert.equal(diaDirty.options[0].text, '好。');
    assert.equal((await fetch(stackApi.baseUrl + '/api/video-ai/dialogue', {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ prompt:'  ' })
    })).status, 400);

    // ── 质量检查 /api/video-ai/review ──────────────────────────────────
    apiMock.state.replies.push(JSON.stringify({
      issues:[
        { index:0, severity:'error', field:'motion', message:'描述在奔跑但运动是细微', suggestion:'natural' },
        { index:1, severity:'warn', field:'dialogue', message:'台词超 20 字', suggestion:'精简台词' },
        { index:99, severity:'error', field:'prompt', message:'越界', suggestion:'x' },
      ]
    }));
    var reviewRes = await fetch(stackApi.baseUrl + '/api/video-ai/review', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ shots:[{ prompt:'她跑向门口。', motion:'subtle' }, { prompt:'她停下。', dialogue:'这段台词实在是太长了不符合要求' }] })
    });
    assert.equal(reviewRes.status, 200);
    var review = await reviewRes.json();
    assert.equal(review.issues.length, 2, 'out-of-range index dropped');
    assert.equal(review.issues[0].severity, 'error');
    assert.equal(review.issues[0].suggestion, 'natural');
    assert.equal((await fetch(stackApi.baseUrl + '/api/video-ai/review', {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ shots:[] })
    })).status, 400);

    // ── 全自动脚本 /api/video-ai/script ────────────────────────────────
    apiMock.state.replies.push(JSON.stringify({
      shots:[
        { prompt:'She enters the cafe.', shotSize:'wide', camera:'push', motion:'natural', dialogue:'', duration:5 },
        { prompt:'She reads the letter.', shotSize:'closeup', camera:'still', motion:'subtle', dialogue:'原来是你。', duration:5 },
        { prompt:'Bad shot size.', shotSize:'bogus', camera:'fly', motion:'dance', dialogue:'x'.repeat(400), duration:99 },
      ]
    }));
    var scriptRes = await fetch(stackApi.baseUrl + '/api/video-ai/script', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ story:'她走进咖啡店读信。', shotCount:8 })
    });
    assert.equal(scriptRes.status, 200);
    var script = await scriptRes.json();
    assert.equal(script.shots.length, 3, 'invalid fields fall back to defaults, shot kept');
    assert.equal(script.shots[0].camera, 'push');
    assert.equal(script.shots[1].dialogue, '原来是你。');
    assert.equal(script.shots[1].duration, 5);
    assert.equal(script.shots[2].shotSize, null, 'unknown shot size -> null');
    assert.equal(script.shots[2].camera, 'still', 'unknown camera -> still');
    assert.equal(script.shots[2].motion, 'subtle', 'unknown motion -> subtle');
    assert.equal(script.shots[2].duration, 5, 'unknown duration -> 5s');
    assert.equal(script.shots[2].dialogue.length, 300, 'oversized dialogue truncated');
    assert.equal((await fetch(stackApi.baseUrl + '/api/video-ai/script', {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ story:'  ' })
    })).status, 400);
  } finally {
    await stackApi.close();
    await closeServer(apiMock.server);
  }

  // ── 3. Ollama 源：mock /api/tags + /api/chat NDJSON 流 ────────────────
  var stackOllama = await gatewayStack.start({ prefix:'video-ai-ollama-' });
  try {
    var statusOllama = await (await fetch(stackOllama.baseUrl + '/api/video-ai/status')).json();
    assert.equal(statusOllama.available, true);
    assert.equal(statusOllama.source, 'ollama');
    assert.equal(statusOllama.model, 'qwen3:8b', 'preferred model must come from the Ollama model list');

    // 注入 NDJSON 回复（每 3 字符一帧，验证流式累积 + JSON 提取）
    await fetch(stackOllama.upstreams.ollama.url + '/__mock/fault', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ reply:'{"prompt":"She steps into the rain.","shotSize":"wide","camera":"pan","motion":"natural","dialogue":"下雨了。"}' })
    });
    var ollamaOkRes = await postRewrite(stackOllama.baseUrl, { prompt:'雨夜，她走进便利店。' });
    assert.equal(ollamaOkRes.status, 200);
    var ollamaOk = await ollamaOkRes.json();
    assert.equal(ollamaOk.source, 'ollama');
    assert.equal(ollamaOk.shot.prompt, 'She steps into the rain.');
    assert.equal(ollamaOk.shot.shotSize, 'wide');
    assert.equal(ollamaOk.shot.camera, 'pan');
    assert.equal(ollamaOk.shot.motion, 'natural');
    assert.equal(ollamaOk.shot.dialogue, '下雨了。');

    // 上游失败 → 502 统一错误信封（不把上游错误裸透给前端）
    await fetch(stackOllama.upstreams.ollama.url + '/__mock/fault', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ chatStatus:503, chatError:'mock ollama overloaded' })
    });
    var failRes = await postRewrite(stackOllama.baseUrl, { prompt:'测试失败路径。' });
    assert.equal(failRes.status, 502);
    var failBody = await failRes.json();
    assert.equal(failBody.ok, false, 'upstream failure must use the unified error envelope');
  } finally {
    await stackOllama.close();
  }
}

if (require.main === module) {
  run().then(function () {
    console.log('test-video-ai: ok');
  }).catch(function (error) {
    console.error(error);
    process.exitCode = 1;
  });
}

export = { run:run };
