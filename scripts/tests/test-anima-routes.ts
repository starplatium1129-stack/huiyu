'use strict';

var assert: typeof import('assert') = require('assert');
var fs: typeof import('fs') = require('fs');
var http: typeof import('http') = require('http');
var path: typeof import('path') = require('path');
var test: typeof import('node:test') = require('node:test');
var animaRoute: typeof import('../../routes/anima.js') = require('../../routes/anima.js');
var createAnimaService = animaRoute.createAnimaService;
var gatewayTestStack: typeof import('./gateway-test-stack.js') = require('./gateway-test-stack.js');

function request(port: string, options: any) {
  return new Promise(function (resolve, reject) {
    var body = options.body === undefined ? null : Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    var headers = Object.assign({ Host:'127.0.0.1:' + port }, options.headers || {});
    if (body) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = body.length;
    }
    var req = http.request({
      host:'127.0.0.1',
      port:port,
      method:options.method || 'GET',
      path:options.path,
      headers:headers
    }, function (res) {
      var chunks: any = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks);
        var json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch (error) {}
        resolve({ status:res.statusCode, headers:res.headers, body:raw, json:json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function postJson(port: string|number, pathname: string, payload: { prompt?: string|{ '1': { class_type: string; inputs: { path: string; }; }; }; modelId?: string; width?: number; height?: number; styleLoraId?: string; seed?: number; detailBoost?: boolean; negative?: string; loraId?: string; loraStrength?: number; character?: string|null; teaCache?: boolean; image?: string; }, headers?: any) {
  return request(port, {
    method:'POST',
    path:pathname,
    body:payload,
    headers:headers
  });
}

async function mockState(port: string|number|undefined) {
  var response: any = await request(port, { path:'/__mock/state' });
  assert.strictEqual(response.status, 200);
  return response.json;
}

async function mockFault(port: number|undefined, faults: { historyTransient?: number; renderMs?: number; resultImage?: { filename: string; subfolder: string; type: string; }|{ filename: string; subfolder: string; type: string; }; resultNode?: string; cancelStatus?: number; queueStatus?: number; }) {
  var response: any = await postJson(port, '/__mock/fault', faults);
  assert.strictEqual(response.status, 200);
}

async function waitForJob(port: string|number, id: string|number|boolean, predicate: any, routeBase?: string|undefined) {
  var last = null;
  var jobPath = (routeBase || '/api/anima/jobs/') + encodeURIComponent(id);
  for (var i = 0; i < 80; i += 1) {
    var response: any = await request(port, { path:jobPath });
    assert.strictEqual(response.status, 200);
    last = response.json && response.json.job;
    if (predicate(last)) return last;
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
  }
  throw new Error('job did not reach expected state: ' + JSON.stringify(last));
}

function validJob(overrides?: any) {
  return Object.assign({
    prompt:'ayachi_nene, 1girl, solo, cafe',
    negative:'worst quality, low quality',
    modelId:'anima-base-v1.0',
    loraId:'L_NENE_V21_ANIMA',
    loraStrength:0.85,
    width:832,
    height:1216,
    steps:24,
    cfg:3,
    seed:4242,
    character:'nene'
  }, overrides || {});
}

function prepareComfyResources(context: { config: { AI_WORKSPACE_ROOT: string; }; }) {
  var root = path.join(context.config.AI_WORKSPACE_ROOT, 'ComfyUI', 'models');
  [
    ['diffusion_models', 'anima-base-v1.0.safetensors'],
    ['diffusion_models', 'anima-aesthetic-v1.1.safetensors'],
    ['diffusion_models', 'AnimaYume_v10_final_base.safetensors'],
    ['diffusion_models', 'Anima-2.9B-preview-v1.safetensors'],
    ['diffusion_models', 'miaomiaoHarem_anima12.safetensors'],
    ['diffusion_models', 'krea2_turbo_fp8_scaled.safetensors'],
    ['text_encoders', 'qwen_3_06b_base.safetensors'],
    ['text_encoders', 'qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors'],
    ['vae', 'qwen_image_vae.safetensors'],
    ['loras', 'ayachi_nene_v21_anima.safetensors'],
    ['loras', 'shiki_natsume_v21_anima.safetensors']
  ].forEach(function (item) {
    var directory = path.join(root, item[0]);
    fs.mkdirSync(directory, { recursive:true });
    fs.writeFileSync(path.join(directory, item[1]), 'authorized-fixture');
  });
}

test('Anima routes enforce application job and result boundaries over real HTTP', async function () {
  var stack = await gatewayTestStack.start({
    prefix:'aics-anima-route-',
    token:'anima-contract-token-0123456789abcdef0123456789',
    prepare:function (context: { runtime: { outputs: string; }; }) {
      prepareComfyResources(context);
      fs.mkdirSync(path.join(context.runtime.outputs, 'anima'), { recursive:true });
      fs.writeFileSync(path.join(context.runtime.outputs, 'anima', 'orphan-startup.png'), 'orphan');
    }
  });
  var runtime = stack.runtime;
  var comfy = stack.upstreams.comfy;
  var gateway: any = stack.gateway;
  var port = stack.address.port;
  assert.strictEqual(fs.existsSync(path.join(runtime.outputs, 'anima', 'orphan-startup.png')), false,
    'gateway startup must remove orphan Anima result files');

  try {
    var remote = { 'x-forwarded-for':'8.8.8.8' };
    var unauthorized: any = await request(port, { path:'/api/anima/status', headers:remote });
    assert.strictEqual(unauthorized.status, 401, 'remote Anima requests need a token');

    var blockedPaths = ['/comfy/prompt', '/comfy/history/abc', '/comfy/queue', '/comfy/interrupt', '/comfy/view?filename=x.png', '/history', '/queue', '/interrupt', '/view'];
    for (var i = 0; i < blockedPaths.length; i += 1) {
      var blocked: any = await request(port, { path:blockedPaths[i] });
      assert.strictEqual(blocked.status, 404, blockedPaths[i] + ' must not be exposed');
      assert.ok(blocked.json && blocked.json.ok === false, blockedPaths[i] + ' must return an error envelope');
    }

    var status: any = await request(port, { path:'/api/anima/status' });
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.json.ok, true);
    assert.strictEqual(status.json.online, true);
    assert.ok(Array.isArray(status.json.models) && status.json.models.every(function (model: any) { return model.id; }));
    var yumeInStatus = status.json.models.find(function (model: { id: string; }) { return model.id === 'anima-yume-v1.0'; });
    assert.ok(yumeInStatus, 'AnimaYume must be discoverable after review sign-off');
    assert.strictEqual(yumeInStatus.family, 'anima');
    assert.strictEqual(yumeInStatus.available, true, 'Yume fixture must mark the model available');
    assert.strictEqual(yumeInStatus.capabilities.noLora, true, 'Yume keeps no-LoRA creative mode');
    assert.ok(status.json.loras.some(function (lora: { id: string; }) { return lora.id === 'L_NENE_V21_ANIMA'; }));
    assert.ok(status.json.models.every(function (model: { family: string; }) { return model.family === 'anima'; }), 'Anima status must not expose Krea models');
    var creativeStatus: any = await request(port, { path:'/api/creative/status' });
    assert.ok(creativeStatus.json.models.some(function (model: { id: string; }) { return model.id === 'krea2-turbo-fp8'; }), 'creative status must expose Krea');
    var unavailableStyle: any = await postJson(port, '/api/creative/jobs', { prompt:'A rainy cafe scene.', modelId:'krea2-turbo-fp8', width:1024, height:1024, styleLoraId:'rainywindow' });
    assert.strictEqual(unavailableStyle.status, 503, 'unavailable Krea Style LoRA must remain a resource error');
    assert.strictEqual(unavailableStyle.json.code, 'KREA_STYLE_LORA_UNAVAILABLE');
    var kreaOnAnima: any = await postJson(port, '/api/anima/jobs', { prompt:'x', modelId:'krea2-turbo-fp8', width:1024, height:1024 });
    assert.strictEqual(kreaOnAnima.status, 400);
    assert.strictEqual(kreaOnAnima.json.code, 'WRONG_ROUTE_FAMILY');
    var animaOnCreative: any = await postJson(port, '/api/creative/jobs', validJob());
    assert.strictEqual(animaOnCreative.status, 400);
    assert.strictEqual(animaOnCreative.json.code, 'WRONG_ROUTE_FAMILY');
    assert.strictEqual((await request(port, { path:'/api/creative/status' })).json.pending, 0, 'rejected cross-family submissions must not create jobs');
    var creativeJob: any = await postJson(port, '/api/creative/jobs', { prompt:'A rainy cafe scene.', modelId:'krea2-turbo-fp8', width:1024, height:1536, seed:9001 });
    assert.strictEqual(creativeJob.status, 202);
    assert.strictEqual(creativeJob.json.job.metadata.steps, 12);
    assert.strictEqual(creativeJob.json.job.metadata.cfg, 1);
    assert.strictEqual(creativeJob.json.job.metadata.sampler, 'er_sde');
    assert.strictEqual((await request(port, { path:'/api/anima/jobs/' + creativeJob.json.job.id })).status, 404, 'Anima route must not read Krea jobs');
    assert.strictEqual((await request(port, { path:'/api/creative/jobs/' + creativeJob.json.job.id })).status, 200);
    await request(port, { method:'DELETE', path:'/api/creative/jobs/' + creativeJob.json.job.id });

    // 2026-08-23 链路替换：实测增强链路与原 euler 标准链路出图时间一致，原链路退役。
    // 默认 Krea 图必须无条件产出 Krea2T-Enhancer + er_sde + ImageSharpenKJ 增强图；
    // detailBoost 开关随标准链路一并退役，任何家族传参都按未知参数拒绝（fail closed）。
    var detailJob: any = await postJson(port, '/api/creative/jobs', { prompt:'A rainy cafe scene with rising steam.', modelId:'krea2-turbo-fp8', width:1024, height:1024, seed:9002 });
    assert.strictEqual(detailJob.status, 202);
    await waitForJob(port, detailJob.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; }, '/api/creative/jobs/');
    var detailState = await mockState(comfy.port);
    var detailPrompt = detailState.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).pop().body.prompt;
    assert.strictEqual(detailPrompt['14'].class_type, 'ComfyUI-Krea2T-Enhancer', 'default Krea graph must chain the T-Enhancer patch');
    assert.strictEqual(detailPrompt['14'].inputs.enabled, true);
    assert.strictEqual(detailPrompt['7'].inputs.model[0], '14', 'KSampler must sample through the enhancer');
    assert.strictEqual(detailPrompt['7'].inputs.sampler_name, 'er_sde', 'the retired euler pairing must not resurface');
    assert.strictEqual(detailPrompt['15'].class_type, 'ImageSharpenKJ');
    assert.strictEqual(detailPrompt['15'].inputs.method, 'rcas');
    assert.strictEqual(detailPrompt['10'].inputs.images[0], '15', 'SaveImage must persist the sharpened image');

    var retiredDetailBoost: any = await postJson(port, '/api/creative/jobs', { prompt:'A quiet library at noon.', modelId:'krea2-turbo-fp8', width:1024, height:1024, seed:9003, detailBoost:false });
    assert.strictEqual(retiredDetailBoost.status, 400);
    assert.strictEqual(retiredDetailBoost.json.code, 'UNKNOWN_PARAMETER');

    var animaDetailBoost: any = await postJson(port, '/api/anima/jobs', validJob({ detailBoost:true }));
    assert.strictEqual(animaDetailBoost.status, 400);
    assert.strictEqual(animaDetailBoost.json.code, 'UNKNOWN_PARAMETER');
    assert.ok(!status.json.loras.some(function (lora: { id: string; }) { return lora.id === 'L_NENE_V19_ANIMA'; }), 'superseded v19 must not remain selectable');

    var arbitraryWorkflow: any = await postJson(port, '/api/anima/jobs', { prompt:{ '1':{ class_type:'ReadFile', inputs:{ path:'C:/secret' } } } });
    assert.strictEqual(arbitraryWorkflow.status, 400, 'raw workflow graph must be rejected');
    assert.ok(['INVALID_PARAMETER', 'MISSING_PARAMETER'].includes(arbitraryWorkflow.json.code));

    var unknownKey: any = await postJson(port, '/api/anima/jobs', Object.assign(validJob(), { workflow:{} }));
    assert.strictEqual(unknownKey.status, 400);
    assert.strictEqual(unknownKey.json.code, 'UNKNOWN_PARAMETER');

    var unknownModel: any = await postJson(port, '/api/anima/jobs', validJob({ modelId:'unknown-model' }));
    assert.strictEqual(unknownModel.status, 400);
    assert.strictEqual(unknownModel.json.code, 'UNKNOWN_MODEL');
    for (const modelId of ['constructor', '__proto__', 'toString']) {
      const invalidCatalogKey: any = await postJson(port, '/api/anima/jobs', validJob({ modelId }));
      assert.strictEqual(invalidCatalogKey.status, 400);
      assert.strictEqual(invalidCatalogKey.json.code, 'UNKNOWN_MODEL');
    }
    var browserProfile: any = await postJson(port, '/api/anima/jobs', validJob({ profileId:'anima_base_v10' }));
    assert.strictEqual(browserProfile.status, 400, 'profile metadata must be derived by the server, not accepted from the browser');
    assert.strictEqual(browserProfile.json.code, 'UNKNOWN_PARAMETER');
    // 2026-08-15 用户决策：AnimaYume 正式接入（无 LoRA 创作模式 + 显式 LoRA 兼容两条路径都要通）。
    var yumeBare: any = await postJson(port, '/api/anima/jobs', validJob({ modelId:'anima-yume-v1.0', loraId:null, loraStrength:undefined, character:null }));
    assert.strictEqual(yumeBare.status, 202, 'AnimaYume no-LoRA mode must be accepted after review sign-off');
    assert.strictEqual(yumeBare.json.job.metadata.profileId, 'anima_yume_v10');
    var yumeWithLora: any = await postJson(port, '/api/anima/jobs', validJob({ modelId:'anima-yume-v1.0' }));
    assert.strictEqual(yumeWithLora.status, 202, 'AnimaYume must accept declared-compatible character LoRA');
    assert.strictEqual(yumeWithLora.json.job.metadata.loraId, 'L_NENE_V21_ANIMA');
    var unknownYume: any = await postJson(port, '/api/anima/jobs', validJob({ modelId:'anima-yume-v2.0' }));
    assert.strictEqual(unknownYume.status, 400, 'unknown models must stay rejected');
    assert.strictEqual(unknownYume.json.code, 'UNKNOWN_MODEL');
    var yumeBareJobId = yumeBare.json.job.id;
    var yumeLoraJobId = yumeWithLora.json.job.id;

    var unknownLora: any = await postJson(port, '/api/anima/jobs', validJob({ loraId:'ayachi_nene_v18_wd14' }));
    assert.strictEqual(unknownLora.status, 400);
    assert.strictEqual(unknownLora.json.code, 'UNKNOWN_LORA');

    var wrongCharacter: any = await postJson(port, '/api/anima/jobs', validJob({ character:'natsume' }));
    assert.strictEqual(wrongCharacter.status, 400);
    assert.strictEqual(wrongCharacter.json.code, 'INCOMPATIBLE_CHARACTER');

    var oversized: any = await postJson(port, '/api/anima/jobs', validJob({ prompt:'x'.repeat(70000) }));
    assert.strictEqual(oversized.status, 413, 'oversized Anima JSON must be rejected before service submission');

    var created: any = await postJson(port, '/api/anima/jobs', validJob());
    assert.strictEqual(created.status, 202);
    assert.strictEqual(created.json.ok, true);
    assert.ok(created.json.job && created.json.job.id);
    assert.strictEqual(created.json.job.metadata.profileId, 'anima_base_v10');
    assert.strictEqual(created.json.job.metadata.modelId, 'anima-base-v1.0');
    assert.strictEqual(created.json.job.metadata.width, 832);
    assert.strictEqual(created.json.job.metadata.height, 1216);
    assert.strictEqual(created.json.job.prompt_id, undefined, 'Comfy prompt id must not cross the application boundary');
    var jobId = created.json.job.id;

    var state = await mockState(comfy.port);
    var freeCalls = state.calls.filter(function (call: { path: string; }) { return call.path === '/free'; });
    assert.strictEqual(freeCalls.length, 2, 'Anima ⇄ Krea2 family switches must unload Comfy models only when crossing families');
    var promptCalls = state.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; });
    assert.strictEqual(promptCalls.length, 5, 'base + krea + enhanced krea + two Yume must each reach Comfy once');
    var yumePromptCalls = promptCalls.filter(function (call: { body: { prompt: { [x: string]: { inputs: { unet_name: string; }; }; }; }; }) { return call.body.prompt['1'].inputs.unet_name === 'AnimaYume_v10_final_base.safetensors'; });
    assert.strictEqual(yumePromptCalls.length, 2, 'both Yume jobs (bare and with LoRA) must load the Yume checkpoint');
    var animaPromptCall = promptCalls.find(function (call: { body: { prompt: { [x: string]: { inputs: { unet_name: string; }; }; }; }; }) { return call.body.prompt['1'].inputs.unet_name === 'anima-base-v1.0.safetensors'; });
    assert.ok(animaPromptCall && animaPromptCall.body && animaPromptCall.body.prompt);
    assert.strictEqual(animaPromptCall.body.workflow, undefined);
    assert.deepStrictEqual(Object.keys(animaPromptCall.body.prompt).sort(), ['1','10','13','2','3','35','4','5','6','7','8','9'], 'workflow must include AnimaTeaCache node');
    assert.strictEqual(animaPromptCall.body.prompt['13'].class_type, 'AnimaTeaCache');
    assert.strictEqual(animaPromptCall.body.prompt['8'].inputs.model[0], '13');
    // 2026-08-23 社区增强回流：纯文生图末端必须落盘 RCAS 锐化结果。
    assert.strictEqual(animaPromptCall.body.prompt['35'].class_type, 'ImageSharpenKJ');
    assert.strictEqual(animaPromptCall.body.prompt['35'].inputs.method, 'rcas');
    assert.deepStrictEqual(animaPromptCall.body.prompt['10'].inputs.images, ['35', 0]);
    assert.strictEqual(animaPromptCall.body.prompt['7'].inputs.batch_size, 1);
    assert.strictEqual(animaPromptCall.body.prompt['1'].class_type, 'UNETLoader');
    assert.strictEqual(animaPromptCall.body.prompt['1'].inputs.unet_name, 'anima-base-v1.0.safetensors');

    var succeeded = await waitForJob(port, jobId, function (job: { status: string; }) { return job && job.status === 'succeeded'; });
    assert.ok(succeeded.resultUrl && succeeded.resultUrl.indexOf('/api/anima/jobs/' + jobId + '/result') !== -1);
    var result: any = await request(port, { path:succeeded.resultUrl });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.headers['content-type'], 'image/png');
    assert.strictEqual(result.body[0], 137);
    // Yume jobs also complete; consume their results so the runtime output dir drains.
    var yumeJobIds = [yumeBareJobId, yumeLoraJobId];
    for (var idx = 0; idx < yumeJobIds.length; idx += 1) {
      var yumeJob = await waitForJob(port, yumeJobIds[idx], function (job: { status: string; }) { return job && job.status === 'succeeded'; });
      assert.ok(yumeJob.resultUrl);
      var yumeResult: any = await request(port, { path:yumeJob.resultUrl });
      assert.strictEqual(yumeResult.status, 200);
    }
    // Enhanced Krea job also completes; consume its result so nothing lingers.
    var detailDone = await waitForJob(port, detailJob.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; }, '/api/creative/jobs/');
    assert.ok(detailDone.resultUrl);
    var detailResult: any = await request(port, { path:detailDone.resultUrl });
    assert.strictEqual(detailResult.status, 200);
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
    assert.ok(fs.readdirSync(path.join(runtime.outputs, 'anima')).length > 0, 'results remain available until TTL or explicit deletion');
    var consumedAgain: any = await request(port, { path:succeeded.resultUrl });
    assert.strictEqual(consumedAgain.status, 200, 'result download must be retryable');
    assert.deepStrictEqual(consumedAgain.body, result.body);
    await request(port, { method:'DELETE', path:'/api/anima/jobs/' + succeeded.id });
    assert.strictEqual((await request(port, { path:succeeded.resultUrl })).status, 404, 'explicit deletion removes the result');

    await mockFault(comfy.port, { historyTransient:2, renderMs:10 });
    var transientJob: any = await postJson(port, '/api/anima/jobs', validJob({ seed:4243 }));
    assert.strictEqual(transientJob.status, 202);
    await waitForJob(port, transientJob.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; });
    state = await mockState(comfy.port);
    promptCalls = state.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; });
    assert.strictEqual(promptCalls.length, 6, 'history polling failures must not resubmit the workflow (base + krea + enhanced krea + 2 Yume + transient)');

    await mockFault(comfy.port, { renderMs:5000 });
    state = await mockState(comfy.port);
    var promptCountBeforeCancel = state.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).length;
    var expectedCancelPromptId = 'mock-comfy-' + (promptCountBeforeCancel + 1);
    var cancelResponse: any = await postJson(port, '/api/anima/jobs', validJob({ seed:4244 }));
    assert.strictEqual(cancelResponse.status, 202);
    var cancelId = cancelResponse.json.job.id;
    var cancelled: any = await request(port, { method:'DELETE', path:'/api/anima/jobs/' + cancelId });
    assert.strictEqual(cancelled.status, 202, 'cancellation stays pending until upstream termination is confirmed');
    assert.strictEqual(cancelled.json.job.status, 'cancelling');
    var cancelledFinal = await waitForJob(port, cancelId, function (job: { status: string; }) { return job && job.status === 'cancelled'; });
    assert.strictEqual(cancelledFinal.status, 'cancelled');
    state = await mockState(comfy.port);
    var targetedCancelCalls = state.calls.filter(function (call: { path: string; }) {
      return call.path === '/api/jobs/' + expectedCancelPromptId + '/cancel';
    });
    assert.strictEqual(targetedCancelCalls.length, 1, 'cancellation must use the matching Comfy job id');

    await mockFault(comfy.port, { renderMs:5000 });
    var jobA: any = await postJson(port, '/api/anima/jobs', validJob({ seed:6001 }));
    var jobB: any = await postJson(port, '/api/anima/jobs', validJob({ seed:6002 }));
    assert.strictEqual(jobA.status, 202);
    assert.strictEqual(jobB.status, 202);
    var cancelledA: any = await request(port, { method:'DELETE', path:'/api/anima/jobs/' + jobA.json.job.id });
    assert.strictEqual(cancelledA.status, 202);
    await waitForJob(port, jobA.json.job.id, function (job: { status: string; }) { return job && job.status === 'cancelled'; });
    await mockFault(comfy.port, { renderMs:0 });
    var successB = await waitForJob(port, jobB.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; });
    assert.strictEqual(successB.status, 'succeeded', 'cancelling A must not cancel B');

    await mockFault(comfy.port, { renderMs:5000 });
    var maxJobs = [];
    for (var maxIndex = 0; maxIndex < 4; maxIndex += 1) {
      var maxJob: any = await postJson(port, '/api/anima/jobs', validJob({ seed:6100 + maxIndex }));
      assert.strictEqual(maxJob.status, 202);
      maxJobs.push(maxJob.json.job.id);
    }
    var full: any = await postJson(port, '/api/anima/jobs', validJob({ seed:6199 }));
    assert.strictEqual(full.status, 429, 'MAX_PENDING must include all queued/running jobs');
    var cancelOne: any = await request(port, { method:'DELETE', path:'/api/anima/jobs/' + maxJobs[0] });
    assert.strictEqual(cancelOne.status, 202);
    var stillFull: any = await postJson(port, '/api/anima/jobs', validJob({ seed:6200 }));
    assert.strictEqual(stillFull.status, 429, 'cancelling jobs must continue occupying MAX_PENDING');
    await waitForJob(port, maxJobs[0], function (job: { status: string; }) { return job && job.status === 'cancelled'; });
    await mockFault(comfy.port, { renderMs:0 });
    for (var remainingIndex = 1; remainingIndex < maxJobs.length; remainingIndex += 1) {
      await waitForJob(port, maxJobs[remainingIndex], function (job: { status: string; }) { return job && job.status === 'succeeded'; });
    }

    var unsafeRefs = [
      { filename:'C:\\secret.png', subfolder:'', type:'output' },
      { filename:'%2e%2e%2fsecret.png', subfolder:'', type:'output' },
      { filename:'safe.png', subfolder:'input', type:'output' },
      { filename:'safe.png', subfolder:'temp', type:'output' },
      { filename:'annotation.png', subfolder:'', type:'output' },
      { filename:'hash.png', subfolder:'', type:'output' },
      { filename:'safe.png', subfolder:'junction-link', type:'output' }
    ];
    state = await mockState(comfy.port);
    var viewsBeforeUnsafe = state.calls.filter(function (call: { path: string; }) { return call.path === '/view'; }).length;
    for (var r = 0; r < unsafeRefs.length; r += 1) {
      await mockFault(comfy.port, { renderMs:0, resultImage:unsafeRefs[r] });
      var unsafeJob: any = await postJson(port, '/api/anima/jobs', validJob({ seed:5000 + r }));
      assert.strictEqual(unsafeJob.status, 202);
      var failed = await waitForJob(port, unsafeJob.json.job.id, function (job: { status: string; }) { return job && (job.status === 'failed' || job.status === 'cancelled'); });
      assert.strictEqual(failed.status, 'failed', 'unsafe result reference must fail closed');
    }
    state = await mockState(comfy.port);
    assert.strictEqual(state.calls.filter(function (call: { path: string; }) { return call.path === '/view'; }).length, viewsBeforeUnsafe,
      'unsafe result references must not be forwarded to Comfy view');

    await mockFault(comfy.port, { renderMs:0, resultNode:'11' });
    var wrongNode: any = await postJson(port, '/api/anima/jobs', validJob({ seed:7001 }));
    assert.strictEqual(wrongNode.status, 202);
    var wrongNodeFailed = await waitForJob(port, wrongNode.json.job.id, function (job: { status: string; }) { return job && job.status === 'failed'; });
    assert.strictEqual(wrongNodeFailed.code, 'COMFY_NO_IMAGE', 'only SaveImage node 10 may provide results');

    await mockFault(comfy.port, { renderMs:0, resultNode:'10', resultImage:{ filename:'other_prefix.png', subfolder:'', type:'output' } });
    var wrongPrefix: any = await postJson(port, '/api/anima/jobs', validJob({ seed:7002 }));
    assert.strictEqual(wrongPrefix.status, 202);
    var wrongPrefixFailed = await waitForJob(port, wrongPrefix.json.job.id, function (job: { status: string; }) { return job && job.status === 'failed'; });
    assert.strictEqual(wrongPrefixFailed.code, 'INVALID_RESULT', 'only anima_app result files may be consumed');

    await mockFault(comfy.port, {});
    var finalState = await mockState(comfy.port);
    assert.ok(finalState.calls.every(function (call: any) {
      if (call.path === '/interrupt') return false;
      if (call.path === '/queue' && call.method === 'POST') return call.body && Array.isArray(call.body.delete);
      return true;
    }), 'gateway must never issue a global or legacy running interrupt operation');
    fs.writeFileSync(path.join(runtime.outputs, 'anima', 'orphan-close.png'), 'orphan');
    gateway.close();
    assert.strictEqual(fs.existsSync(path.join(runtime.outputs, 'anima', 'orphan-close.png')), false,
      'gateway close must remove runtime Anima result files');
  } finally {
    await stack.close();
  }
});
test('Anima runtime TTL removes an unconsumed result file', async function () {
  var stack = await gatewayTestStack.start({
    prefix:'aics-anima-ttl-',
    token:'anima-ttl-token-0123456789abcdef0123456789',
    prepare:prepareComfyResources,
    createServices:function (context: any) {
      return {
        anima:createAnimaService(context.config, { jobTtlMs:1000, cancelPollIntervalMs:10 })
      };
    }
  });
  var runtime = stack.runtime;
  var port = stack.address.port;
  try {
    var created: any = await postJson(port, '/api/anima/jobs', validJob({ seed:8001 }));
    assert.strictEqual(created.status, 202);
    await waitForJob(port, created.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; });
    var resultRoot = path.join(runtime.outputs, 'anima');
    assert.ok(fs.readdirSync(resultRoot).length > 0, 'unconsumed result must exist before TTL');
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    assert.strictEqual(fs.readdirSync(resultRoot).length, 0, 'TTL must delete the unconsumed runtime result');
    var expired: any = await request(port, { path:'/api/anima/jobs/' + created.json.job.id });
    assert.strictEqual(expired.status, 404, 'TTL must remove the expired job record');
  } finally {
    await stack.close();
  }
});

test('Anima exposes and submits the promoted Natsume v20 LoRA without crossing character boundaries', async function () {
  var stack = await gatewayTestStack.start({
    prefix:'aics-anima-natsume-v20-',
    token:'anima-natsume-v20-token-0123456789abcdef012345',
    prepare:function (context: { config: { AI_WORKSPACE_ROOT: string; }; }) {
      prepareComfyResources(context);
    }
  });
  var port = stack.address.port;
  var comfy = stack.upstreams.comfy;
  try {
    var status: any = await request(port, { path:'/api/anima/status' });
    assert.strictEqual(status.status, 200);
    var natsume = status.json.loras.find(function (lora: { id: string; }) { return lora.id === 'L_NAT_V21_ANIMA'; });
    assert.ok(natsume && natsume.available && !natsume.preview, 'natsume v21 must be discoverable and no longer experimental');
    assert.ok(!status.json.loras.some(function (lora: { id: string; }) { return lora.id === 'L_NAT_V19_ANIMA_PREVIEW'; }), 'superseded preview must not remain selectable');
    assert.ok(!status.json.loras.some(function (lora: { id: string; }) { return lora.id === 'L_NAT_V20_ANIMA'; }), 'superseded natsume v20 must not remain selectable');
    assert.ok(status.json.characters.some(function (character: any) { return character.id === 'natsume' && !character.preview; }));

    var natsumeJob: any = await postJson(port, '/api/anima/jobs', validJob({
      prompt:'shiki_natsume, 1girl, solo, natsume_cafe_uniform',
      loraId:'L_NAT_V21_ANIMA', character:'natsume'
    }));
    assert.strictEqual(natsumeJob.status, 202);
    assert.strictEqual(natsumeJob.json.job.character, 'natsume');
    assert.strictEqual(natsumeJob.json.job.loraId, 'L_NAT_V21_ANIMA');
    await waitForJob(port, natsumeJob.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; });
    var state = await mockState(comfy.port);
    var promptCall = state.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).pop();
    assert.strictEqual(promptCall.body.prompt['4'].inputs.lora_name, 'shiki_natsume_v21_anima.safetensors');

    var neneJob: any = await postJson(port, '/api/anima/jobs', validJob({ loraId:'L_NAT_V21_ANIMA' }));
    assert.strictEqual(neneJob.status, 400);
    assert.strictEqual(neneJob.json.code, 'INCOMPATIBLE_CHARACTER');
    var natsumeNene: any = await postJson(port, '/api/anima/jobs', validJob({ character:'natsume' }));
    assert.strictEqual(natsumeNene.status, 400);
    assert.strictEqual(natsumeNene.json.code, 'INCOMPATIBLE_CHARACTER');
    var triad: any = await postJson(port, '/api/anima/jobs', validJob({ character:'triad', loraId:'L_NAT_V21_ANIMA' }));
    assert.strictEqual(triad.status, 400);
    assert.strictEqual(triad.json.code, 'INCOMPATIBLE_CHARACTER');
    var unknownPath: any = await postJson(port, '/api/anima/jobs', validJob({ character:'natsume', loraId:'C:\\secret\\preview.safetensors' }));
    assert.strictEqual(unknownPath.status, 400);
    assert.strictEqual(unknownPath.json.code, 'UNKNOWN_LORA');
  } finally {
    await stack.close();
  }
});

test('Anima no-LoRA mode submits an anima-aesthetic job without LoraLoader and a negative encode', async function () {
  var stack = await gatewayTestStack.start({
    prefix:'aics-anima-nolora-',
    token:'anima-nolora-token-0123456789abcdef01234',
    prepare:prepareComfyResources,
  });
  var port = stack.address.port;
  var comfy = stack.upstreams.comfy;
  try {
    var status: any = await request(port, { path:'/api/anima/status' });
    assert.strictEqual(status.status, 200);
    var aesthetic = status.json.models.find(function (model: { id: string; }) { return model.id === 'anima-aesthetic-v1.1'; });
    assert.ok(aesthetic, 'anima-aesthetic-v1.1 must be discoverable');
    assert.strictEqual(aesthetic.capabilities.noLora, true, 'no-LoRA capability must be advertised for aesthetic');
    assert.strictEqual(aesthetic.capabilities.characterIdentity, true, 'character identity capability stays a server fact');

    var noLora: any = await postJson(port, '/api/anima/jobs', {
      prompt:'raiden_shogun, 1girl, solo, flower field',
      negative:'worst quality, low quality',
      modelId:'anima-aesthetic-v1.1',
      width:832,
      height:1216,
      seed:4242
    });
    assert.strictEqual(noLora.status, 202);
    assert.ok(noLora.json.job.loraId == null, 'no-LoRA job must carry no loraId');
    assert.ok(noLora.json.job.character == null, 'no-LoRA job must carry no character');
    assert.strictEqual(noLora.json.job.metadata.profileId, 'anima_aesthetic_v11');
    await waitForJob(port, noLora.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; });

    var state = await mockState(comfy.port);
    var promptCall = state.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).pop();
    var graph = promptCall.body.prompt;
    assert.strictEqual(graph['1'].inputs.unet_name, 'anima-aesthetic-v1.1.safetensors');
    var classes = Object.keys(graph).map(function (id) { return graph[id].class_type; });
    assert.ok(!classes.includes('LoraLoader'), 'no-LoRA workflow must not load a LoRA');
    assert.strictEqual(graph['2'].inputs.clip_name, 'qwen_3_06b_base.safetensors');
    assert.strictEqual(graph['4'].inputs.text.indexOf('raiden_shogun') !== -1, true);
    assert.strictEqual(graph['5'].inputs.text, 'worst quality, low quality');
    assert.strictEqual(graph['7'].inputs.sampler_name, 'res_multistep');
    assert.strictEqual(graph['7'].inputs.scheduler, 'simple');
    assert.strictEqual(graph['7'].inputs.cfg, 4.5);
    assert.strictEqual(graph['7'].inputs.steps, 30);
    assert.strictEqual(graph['13'].class_type, 'AnimaTeaCache');
    assert.strictEqual(graph['7'].inputs.model[0], '13');
    assert.strictEqual(graph['10'].class_type, 'SaveImage');
    assert.strictEqual(graph['35'].class_type, 'ImageSharpenKJ', 'no-LoRA text-to-image must also end with the RCAS sharpener');
    assert.deepStrictEqual(graph['10'].inputs.images, ['35', 0]);

    var disabledTeaCache: any = await postJson(port, '/api/anima/jobs', {
      prompt:'ayachi_nene, 1girl',
      negative:'worst quality',
      modelId:'anima-base-v1.0',
      loraId:'L_NENE_V21_ANIMA',
      loraStrength:0.85,
      character:'nene',
      width:832,
      height:1216,
      teaCache:false
    });
    assert.strictEqual(disabledTeaCache.status, 202);
    await waitForJob(port, disabledTeaCache.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; });
    state = await mockState(comfy.port);
    promptCall = state.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).pop();
    assert.strictEqual(promptCall.body.prompt['13'], undefined, 'disabled teaCache must omit node 13');
    assert.strictEqual(promptCall.body.prompt['8'].inputs.model[0], '4', 'KSampler must connect directly to LoraLoader when teaCache is false');

    var loraOnNoLora: any = await postJson(port, '/api/anima/jobs', {
      prompt:'x', modelId:'anima-aesthetic-v1.1', loraId:'L_NENE_V21_ANIMA', loraStrength:0.85,
      width:832, height:1216, character:'nene'
    });
    assert.strictEqual(loraOnNoLora.status, 202, 'aesthetic still accepts its authorized LoRA path');
    var wrongChar: any = await postJson(port, '/api/anima/jobs', {
      prompt:'x', modelId:'anima-aesthetic-v1.1', loraId:'L_NAT_V21_ANIMA',
      width:832, height:1216, character:'nene'
    });
    assert.strictEqual(wrongChar.status, 400);
    assert.strictEqual(wrongChar.json.code, 'INCOMPATIBLE_CHARACTER');

    // 无 LoRA 模式 fail closed：loraStrength 无 loraId、非空 character 都是自相矛盾参数。
    var strengthNoLora: any = await postJson(port, '/api/anima/jobs', {
      prompt:'x', modelId:'anima-aesthetic-v1.1', loraStrength:0.85, width:832, height:1216
    });
    assert.strictEqual(strengthNoLora.status, 400);
    assert.strictEqual(strengthNoLora.json.code, 'INVALID_PARAMETER');
    var characterNoLora: any = await postJson(port, '/api/anima/jobs', {
      prompt:'x', modelId:'anima-aesthetic-v1.1', character:'nene', width:832, height:1216
    });
    assert.strictEqual(characterNoLora.status, 400);
    assert.strictEqual(characterNoLora.json.code, 'INVALID_PARAMETER');
    var nullCharacter: any = await postJson(port, '/api/anima/jobs', {
      prompt:'x', modelId:'anima-aesthetic-v1.1', character:null, width:832, height:1216
    });
    assert.strictEqual(nullCharacter.status, 202, 'character=null must be accepted and ignored in no-LoRA mode');
  } finally {
    await stack.close();
  }
});

test('Anima cancellation failure releases the pending slot after a bounded timeout', async function () {
  var stack = await gatewayTestStack.start({
    prefix:'aics-anima-cancel-timeout-',
    token:'anima-cancel-token-0123456789abcdef012345',
    prepare:prepareComfyResources,
    createServices:function (context: any) {
      return {
        anima:createAnimaService(context.config, { cancelPollIntervalMs:10, cancelTimeoutMs:100 })
      };
    }
  });
  var port = stack.address.port;
  var comfy = stack.upstreams.comfy;
  try {
    await mockFault(comfy.port, { renderMs:5000, cancelStatus:503, queueStatus:503 });
    var created: any = await postJson(port, '/api/anima/jobs', validJob({ seed:8101 }));
    assert.strictEqual(created.status, 202);
    var cancelled: any = await request(port, { method:'DELETE', path:'/api/anima/jobs/' + created.json.job.id });
    assert.strictEqual(cancelled.status, 202);
    var failed = await waitForJob(port, created.json.job.id, function (job: { status: string; }) { return job && job.status === 'failed'; });
    assert.strictEqual(failed.code, 'ANIMA_CANCEL_FAILED');
    var status: any = await request(port, { path:'/api/anima/status' });
    assert.strictEqual(status.json.pending, 0, 'failed cancellation must not occupy MAX_PENDING forever');
  } finally {
    await stack.close();
  }
});

test('Anima size contract: anima-base-v1.0 accepts 960x1536, anima-aesthetic-v1.1 rejects it', async function () {
  var stack = await gatewayTestStack.start({
    prefix:'aics-anima-960x1536-',
    token:'anima-960x1536-token-0123456789abcdef012345',
    prepare:prepareComfyResources,
  });
  var port = stack.address.port;
  try {
    // 960x1536 (area 1,474,560) is whitelisted for anima-base-v1.0 only; used by
    // the latest-lora natsume fullbody attempt-4 candidates (WAI + Anima share
    // the same size so the two routes can be compared).
    var baseJob: any = await postJson(port, '/api/anima/jobs', validJob({ width:960, height:1536, seed:9601 }));
    assert.strictEqual(baseJob.status, 202, 'anima-base-v1.0 must accept 960x1536');
    assert.strictEqual(baseJob.json.job.metadata.width, 960);
    assert.strictEqual(baseJob.json.job.metadata.height, 1536);
    await waitForJob(port, baseJob.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; });

    // anima-aesthetic-v1.1 keeps its original sizes list: 960x1536 must fail closed.
    var aesthetic: any = await postJson(port, '/api/anima/jobs', {
      prompt:'raiden_shogun, 1girl, solo, flower field',
      negative:'worst quality, low quality',
      modelId:'anima-aesthetic-v1.1',
      width:960,
      height:1536,
      seed:9602
    });
    assert.strictEqual(aesthetic.status, 400, 'anima-aesthetic-v1.1 must reject 960x1536');
    assert.strictEqual(aesthetic.json.code, 'INVALID_PARAMETER');
  } finally {
    await stack.close();
  }
});

test('Anima input cleanup deletes expired unreferenced uploads but preserves active inputs', function () {
  var root = fs.mkdtempSync(path.join((require('os') as typeof import('os')).tmpdir(), 'aics-anima-input-cleanup-'));
  var config = { ROOT_DIR:root, AI_WORKSPACE_ROOT:root };
  var inputRoot = path.join(root, 'ComfyUI', 'input');
  fs.mkdirSync(inputRoot, { recursive:true });
  var stale = 'aics_anima_input_aaaaaaaaaaaaaaaa.png';
  var active = 'aics_anima_input_bbbbbbbbbbbbbbbb.png';
  var fresh = 'aics_anima_input_cccccccccccccccc.png';
  [stale, active, fresh].forEach(function (name) { fs.writeFileSync(path.join(inputRoot, name), 'fixture'); });
  var old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(inputRoot, stale), old, old);
  fs.utimesSync(path.join(inputRoot, active), old, old);
  try {
    animaRoute.cleanupImageInputs(config, new Set([active]), 60 * 60 * 1000);
    assert.strictEqual(fs.existsSync(path.join(inputRoot, stale)), false);
    assert.strictEqual(fs.existsSync(path.join(inputRoot, active)), true);
    assert.strictEqual(fs.existsSync(path.join(inputRoot, fresh)), true);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('Anima inpainting: accepts uploaded image and builds VAEEncode + SetLatentNoiseMask workflow', async function () {
  var stack = await gatewayTestStack.start({
    prefix:'aics-anima-inpaint-',
    token:'anima-inpaint-token-0123456789abcdef012345',
    prepare:prepareComfyResources,
  });
  var port = stack.address.port;
  var comfy = stack.upstreams.comfy;
  try {
    // 1. Upload mock base64 image (1x1 transparent PNG)
    var samplePngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    var uploadRes: any = await postJson(port, '/api/anima/images', { image: samplePngBase64 });
    assert.strictEqual(uploadRes.status, 200);
    assert.ok(uploadRes.json.ok);
    assert.ok(uploadRes.json.name.startsWith('aics_anima_input_'));

    // 2. Submit Inpaint job with maskPrompt
    var inpaintJob: any = await postJson(port, '/api/anima/jobs', validJob({
      initImage: uploadRes.json.name,
      maskPrompt: 'clothes, dress',
      denoisingStrength: 0.85,
      growMaskBy: 0,
      width: 1024,
      height: 1344,
      seed: 7788
    }));
    assert.strictEqual(inpaintJob.status, 202);
    await waitForJob(port, inpaintJob.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; });

    var state = await mockState(comfy.port);
    var promptCall = state.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).pop();
    var graph = promptCall.body.prompt;
    assert.strictEqual(graph['15'].class_type, 'LoadImage');
    assert.strictEqual(graph['15'].inputs.image, uploadRes.json.name);
    assert.strictEqual(graph['19'].class_type, 'ResizeAndPadImage');
    assert.strictEqual(graph['19'].inputs.target_width, 1024);
    assert.strictEqual(graph['19'].inputs.target_height, 1344);
    assert.strictEqual(graph['16'].class_type, 'AP_CLIPSeg_TextMask');
    assert.strictEqual(graph['16'].inputs.prompt, 'clothes, dress');
    assert.strictEqual(graph['16'].inputs.threshold, 0.45, 'CLIPSeg default threshold must be the tuned 0.45 (0.20 leaked body/background into the redraw area)');
    assert.strictEqual(graph['16'].inputs.mask_dilate, 0, 'Grow=0 must stay an explicit no-expand mask');
    assert.strictEqual(graph['17'].class_type, 'SetLatentNoiseMask');
    assert.strictEqual(graph['8'].inputs.latent_image[0], '17');
    assert.strictEqual(graph['8'].inputs.denoise, 0.85);
    // 2026-08-21 换装完善：CLIPSeg 分支与手绘遮罩一致，必须按 mask 回贴原图（非重绘区像素级保真）
    assert.strictEqual(graph['30'].class_type, 'ImageCompositeMasked', 'CLIPSeg branch must composite decoded result back over the source like the painted-mask branch');
    assert.deepStrictEqual(graph['30'].inputs.destination, ['19', 0]);
    assert.deepStrictEqual(graph['10'].inputs.images, ['30', 0]);
    assert.strictEqual(graph['35'], undefined, 'inpaint must NOT sharpen: pixel-faithful composite wins over global post-processing');

    // 自定义识别阈值必须透传到 CLIPSeg 节点
    var thresholdJob: any = await postJson(port, '/api/anima/jobs', validJob({
      initImage: uploadRes.json.name,
      maskPrompt: 'clothes, dress',
      maskThreshold: 0.6,
      width: 1024,
      height: 1344,
      seed: 7789
    }));
    assert.strictEqual(thresholdJob.status, 202);
    await waitForJob(port, thresholdJob.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; });
    state = await mockState(comfy.port);
    promptCall = state.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).pop();
    graph = promptCall.body.prompt;
    assert.strictEqual(graph['16'].class_type, 'AP_CLIPSeg_TextMask');
    assert.strictEqual(graph['16'].inputs.threshold, 0.6, 'caller-provided maskThreshold must reach AP_CLIPSeg_TextMask');

    var maskUpload: any = await postJson(port, '/api/anima/images', { image: samplePngBase64 });
    var paintedMaskJob: any = await postJson(port, '/api/anima/jobs', validJob({
      initImage: uploadRes.json.name,
      maskImage: maskUpload.json.name,
      width: 1024,
      height: 1344,
      seed: 7790
    }));
    assert.strictEqual(paintedMaskJob.status, 202);
    await waitForJob(port, paintedMaskJob.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; });
    state = await mockState(comfy.port);
    promptCall = state.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).pop();
    graph = promptCall.body.prompt;
    assert.strictEqual(graph['15_mask'].class_type, 'LoadImage');
    assert.strictEqual(graph['15_mask'].inputs.image, maskUpload.json.name);
    assert.strictEqual(graph['19_mask'].class_type, 'ResizeAndPadImage');
    assert.strictEqual(graph['16'].class_type, 'ImageToMask');
    assert.deepStrictEqual(graph['16'].inputs.image, ['19_mask', 0]);
    assert.strictEqual(graph['16'].inputs.channel, 'red');
    assert.strictEqual(graph['16_grow'].class_type, 'GrowMask');
    assert.strictEqual(graph['16_grow'].inputs.expand, 6);
    assert.strictEqual(graph['17'].inputs.mask[0], '16_grow');
    assert.strictEqual(graph['30'].class_type, 'ImageCompositeMasked');
    assert.deepStrictEqual(graph['30'].inputs.destination, ['19', 0]);
    assert.deepStrictEqual(graph['30'].inputs.source, ['9', 0]);
    assert.deepStrictEqual(graph['10'].inputs.images, ['30', 0]);

    // 手绘遮罩叠加 hires：最终结果必须在解码前对合成图做 hires，不能复用旧的高分潜空间路径
    var hiresWithMask: any = await postJson(port, '/api/anima/jobs', validJob({
      initImage: uploadRes.json.name,
      maskImage: maskUpload.json.name,
      width: 832,
      height: 1216,
      hiresFix: true,
      hiresScale: 2.0,
      seed: 7791
    }));
    assert.strictEqual(hiresWithMask.status, 202);
    await waitForJob(port, hiresWithMask.json.job.id, function (job: { status: string; }) { return job && job.status === 'succeeded'; });
    state = await mockState(comfy.port);
    promptCall = state.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).pop();
    graph = promptCall.body.prompt;
    assert.ok(graph['30'] && graph['30'].class_type === 'ImageCompositeMasked');
    // 普通 hires（LatentUpscaleBy）仍应对合成图生效，不应再单独针对首轮 latent 放大
    assert.ok(graph['31'] && graph['32'] && graph['34'], 'hires on inpaint must run VAEEncode→LatentUpscaleBy→KSampler→VAEDecode over the composited image');
    assert.strictEqual(graph['33'].inputs.scheduler, 'sgm_uniform', 'hires-on-inpaint 2nd pass must use the turned-on sgm_uniform scheduler');
    assert.strictEqual(graph['33'].inputs.sampler_name, 'res_multistep', 'hires-on-inpaint 2nd pass keeps the decoupled res_multistep sampler');

    var unaligned: any = await postJson(port, '/api/anima/jobs', validJob({
      initImage: uploadRes.json.name,
      maskPrompt: 'clothes',
      width: 1001,
      height: 1333
    }));
    assert.strictEqual(unaligned.status, 400);
    assert.strictEqual(unaligned.json.code, 'INVALID_PARAMETER');
  } finally {
    await stack.close();
  }
});
