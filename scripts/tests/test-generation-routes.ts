'use strict';

var assert: typeof import('assert/strict') = require('assert/strict');
var gatewayStack: typeof import('./gateway-test-stack') = require('./gateway-test-stack');
var generation: typeof import('../../routes/generation') = require('../../routes/generation');

async function json(response: Response) { return response.json(); }
async function post(base: string, body: { prompt: string; negative: string; loras: { id: string; strength: number; }[]; width: number; height: number; steps: number; cfg: number; seed: number; sampler: string; scheduler: string; }&{ sampler: string; }, token?: any) {
  return fetch(base + '/api/generation/jobs', { method:'POST', headers:{ 'content-type':'application/json', ...(token ? { 'x-token':token } : {}) }, body:JSON.stringify(body) });
}

async function run() {
  var valid = generation.validateInput({ prompt:'1girl, solo', negative:'bad', loras:[{ id:'L_NENE_V18_WD14', strength:0.85 }], width:832, height:1216, steps:28, cfg:5.5, seed:12, sampler:'DPM++ 2M', scheduler:'Karras' });
  var dual = generation.validateInput({ prompt:'2girls', loras:[{ id:'L_NENE_V18_WD14', strength:0.52 }, { id:'L_NAT_V18_WD14', strength:0.62 }], width:832, height:1216 });
  assert.deepEqual(dual.loras.map(function (item: any) { return item.strength; }), [0.52, 0.62]);
  assert.throws(function () { generation.validateInput({ prompt:'x', loras:[{ id:'L_NENE_V18_WD14', strength:0.52 }], width:832, height:1216 }); }, /超出允许范围/);
  assert.throws(function () { generation.validateInput({ prompt:'x', loras:[{ id:'L_NENE_V18_WD14', strength:0.52 }, { id:'L_NENE_V18_WD14', strength:0.52 }], width:832, height:1216 }); }, /不得重复/);
  var requestBody = { prompt:'1girl, solo, <lora:ayachi_nene_v18_wd14:0.85>', negative:'bad', loras:[{ id:'L_NENE_V18_WD14', strength:0.85 }], width:832, height:1216, steps:28, cfg:5.5, seed:12, sampler:'DPM++ 2M', scheduler:'Karras' };
  var graph = generation.buildWorkflow(valid);
  assert.equal(graph['1'].class_type, 'CheckpointLoaderSimple');
  assert.equal(graph['10'].class_type, 'SaveImage');
  assert.equal(graph['2'].inputs.lora_name, 'ayachi_nene_v18_wd14.safetensors');
  var tagged = generation.validateInput({ prompt:'1girl, <lora:ayachi_nene_v18_wd14:0.85>', negative:'bad', loras:[{ id:'L_NENE_V18_WD14', strength:0.85 }], width:832, height:1216, steps:28, cfg:5.5, seed:12, sampler:'DPM++ 2M' });
  var taggedGraph = generation.buildWorkflow(tagged);
  assert.equal(taggedGraph['4'].inputs.text.includes('<lora:'), false, 'Comfy CLIP text must not contain LoRA syntax');
  var hiresGraph = generation.buildWorkflow(generation.validateInput({ prompt:'x', width:1024, height:1024, hiresFix:true, hiresUpscaler:'Latent', hiresScale:1.5, hiresSteps:20, denoisingStrength:0.4 }));
  assert.equal(hiresGraph['11'].class_type, 'LatentUpscaleBy');
  assert.equal(hiresGraph['11'].inputs.upscale_method, 'nearest-exact');
  assert.equal(hiresGraph['12'].class_type, 'KSampler');
  var autoHiresGraph = generation.buildWorkflow(generation.validateInput({ prompt:'x', width:1024, height:1024, hiresFix:true, hiresUpscaler:'Auto', hiresScale:1.5, hiresSteps:20, denoisingStrength:0.4 }));
  assert.equal(autoHiresGraph['11'].inputs.upscale_method, 'nearest-exact', 'Comfy resolves Auto hires to nearest-exact latent');
  // 2026-08-18 super-res：显式 Remacri 意图应被认定为 Comfy 能力，注入模型文件后
  // buildWorkflow 产出 ESRGAN 像素级超分链路（UpscaleModelLoader→VAEDecode→
  // ImageUpscaleWithModel→ImageScale→VAEEncode→二阶段 KSampler）。
  var superResValid = generation.validateInput({ prompt:'x', width:832, height:1216, hiresFix:true, hiresUpscaler:'Remacri', hiresScale:1.5, hiresSteps:20, denoisingStrength:0.4 });
  assert.equal(superResValid.superResWanted, true);
  assert.equal(superResValid.comfyHires, true);
  var superResGraph = generation.buildWorkflow(Object.assign({}, superResValid, { superResModel:'4x_foolhardy_Remacri.safetensors' }));
  assert.equal(superResGraph['11'].class_type, 'UpscaleModelLoader');
  assert.equal(superResGraph['11'].inputs.model_name, '4x_foolhardy_Remacri.safetensors');
  assert.equal(superResGraph['12'].class_type, 'VAEDecode');
  assert.equal(superResGraph['13'].class_type, 'ImageUpscaleWithModel');
  assert.equal(superResGraph['13'].inputs.upscale_model[0], '11');
  assert.equal(superResGraph['14'].class_type, 'ImageScale');
  assert.equal(superResGraph['15'].class_type, 'VAEEncode');
  assert.equal(superResGraph['16'].class_type, 'KSampler');
  assert.equal(superResGraph['16'].inputs.denoise, 0.4, 'second pass uses requested denoise');
  assert.equal(superResGraph['16'].inputs.steps, 20);
  assert.equal(superResGraph['8'].inputs.samples[0], '16', 'final decode consumes second-pass samples');
  assert.throws(function () { generation.validateInput({ prompt:'x', workflow:{}, width:832, height:1216 }); }, /不支持的参数/);
  assert.throws(function () { generation.validateInput({ prompt:'x', loras:[{ id:'bad', strength:0.8 }], width:832, height:1216 }); }, /未知 WAI LoRA/);
  assert.throws(function () { generation.validateInput({ prompt:'x', modelId:'other', width:832, height:1216 }); }, /未知 WAI checkpoint/);
  assert.equal(generation.isWaiCheckpoint('waiIllustriousSDXL_v170.safetensors [abc123]'), true);
  assert.equal(generation.isWaiCheckpoint('waiIllustriousSDXL_v171.safetensors [abc123]'), false);
  assert.equal(generation.isWaiCheckpoint('waiIllustriousSDXL_v170-extra.safetensors [abc123]'), false);
  assert.equal(generation.isWaiCheckpoint('waiIllustriousSDXL_v170.safetensors (abc123)'), true);

   var stack = await gatewayStack.start({ prepare:function (context: { config: { AI_WORKSPACE_ROOT: string; }; }) {
     var checkpointRoot = (require('path') as typeof import('path')).join(context.config.AI_WORKSPACE_ROOT, 'ComfyUI', 'models', 'checkpoints');
     var loraRoot = (require('path') as typeof import('path')).join(context.config.AI_WORKSPACE_ROOT, 'ComfyUI', 'models', 'loras');
     var upscaleRoot = (require('path') as typeof import('path')).join(context.config.AI_WORKSPACE_ROOT, 'ComfyUI', 'models', 'upscale_models');
     (require('fs') as typeof import('fs')).mkdirSync(checkpointRoot, { recursive:true });
     (require('fs') as typeof import('fs')).mkdirSync(loraRoot, { recursive:true });
     (require('fs') as typeof import('fs')).mkdirSync(upscaleRoot, { recursive:true });
     (require('fs') as typeof import('fs')).writeFileSync((require('path') as typeof import('path')).join(checkpointRoot, generation.constants.CHECKPOINT), 'checkpoint');
     (require('fs') as typeof import('fs')).writeFileSync((require('path') as typeof import('path')).join(loraRoot, generation.constants.LORAS.L_NENE_V18_WD14.file), 'nene');
     (require('fs') as typeof import('fs')).writeFileSync((require('path') as typeof import('path')).join(loraRoot, generation.constants.LORAS.L_NAT_V18_WD14.file), 'natsume');
     (require('fs') as typeof import('fs')).writeFileSync((require('path') as typeof import('path')).join(upscaleRoot, generation.availableSuperRes(context.config) || '4x_foolhardy_Remacri.safetensors'), 'remacri');
   } });
   try {
     var base = stack.baseUrl;
      var status = await json(await fetch(base + '/api/generation/status'));
      assert.equal(status.capabilities.hiresUpscalers.includes('Auto'), true);
      var webuiResponse = await post(base, requestBody);
     assert.equal(webuiResponse.status, 202);
     var webuiJob = (await json(webuiResponse)).job;
      assert.equal(webuiJob.provider, 'comfy', 'Comfy is preferred for compatible WAI requests');
      assert.deepEqual(webuiJob.metadata.loras, [{ id:'L_NENE_V18_WD14', strength:0.85 }]);
      var autoWebuiResponse = await post(base, Object.assign({}, requestBody, { hiresFix:true, hiresUpscaler:'Auto', hiresScale:1.5, hiresSteps:20, denoisingStrength:0.4 }));
      assert.equal(autoWebuiResponse.status, 202);
      var autoWebuiJob = (await json(autoWebuiResponse)).job;
      assert.equal(autoWebuiJob.provider, 'webui', 'Auto hires prefers Anime6B when WebUI provides it');
      assert.equal(autoWebuiJob.metadata.hiresUpscaler, 'R-ESRGAN 4x+ Anime6B');
      var autoWebuiCalls = await json(await fetch(stack.upstreams.sd.url + '/__mock/state'));
      var autoPayload = autoWebuiCalls.calls.filter(function (call: { path: string; }) { return call.path === '/sdapi/v1/txt2img'; }).at(-1).body;
      assert.equal(autoPayload.hr_upscaler, 'R-ESRGAN 4x+ Anime6B');
     var webuiSamplerFallback = await post(base, Object.assign({}, requestBody, { sampler:'DPM++ SDE' }));
      assert.equal(webuiSamplerFallback.status, 202, 'Comfy-first routing must not reject a Comfy-compatible request because WebUI lacks the sampler');
     await fetch(stack.upstreams.sd.url + '/__mock/fault', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ offline:true }) });

    var comfyResponse = await post(base, requestBody);
    assert.equal(comfyResponse.status, 202);
    var comfyJob = (await json(comfyResponse)).job;
    assert.equal(comfyJob.provider, 'comfy');
    var comfyCalls = await json(await fetch(stack.upstreams.comfy.url + '/__mock/state'));
    var comfyGraph = comfyCalls.calls.find(function (call: { path: string; }) { return call.path === '/prompt'; }).body.prompt;
    assert.equal(Object.values(comfyGraph).filter(function (node: any) { return node && node.class_type === 'CLIPTextEncode' && String(node.inputs.text).includes('<lora:'); }).length, 0);
    assert.equal((await fetch(base + '/prompt')).status, 404);
    assert.equal((await fetch(base + '/history/x')).status, 404);
    assert.equal((await fetch(base + '/view')).status, 404);
    assert.ok([401, 404].includes((await fetch(base + '/api/generation/jobs/' + comfyJob.id, { headers:{ 'x-token':'wrong-token', 'x-forwarded-for':'203.0.113.10' } })).status));

     var detailerOffline = await post(base, Object.assign({}, requestBody, { faceDetailer:true }));
     assert.equal(detailerOffline.status, 503);
     assert.equal((await json(detailerOffline)).code, 'WEBUI_RESOURCES_UNAVAILABLE');
    var hiresOffline = await post(base, Object.assign({}, requestBody, { hiresFix:true, hiresUpscaler:'Auto', hiresScale:1.5, hiresSteps:20, denoisingStrength:0.4 }));
     assert.equal(hiresOffline.status, 202, 'native super-res hires remains available when WebUI is offline');
      var hiresOfflineJob = (await json(hiresOffline)).job;
      assert.equal(hiresOfflineJob.metadata.hiresUpscaler, 'Remacri', 'Auto hires on Comfy resolves to Remacri super-res when installed');
     var hiresPrompts = await json(await fetch(stack.upstreams.comfy.url + '/__mock/state'));
      var comfyHiresGraph = hiresPrompts.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).at(-1).body.prompt;
      assert.equal(Object.values(comfyHiresGraph).some(function (node: any) { return node && node.class_type === 'UpscaleModelLoader'; }), true, 'Comfy hires graph must contain UpscaleModelLoader for super-res');

    var capabilityFallback = await post(base, Object.assign({}, requestBody, { sampler:'DPM++ SDE' }));
    assert.equal(capabilityFallback.status, 503);
    assert.equal((await json(capabilityFallback)).code, 'COMFY_CAPABILITY_UNAVAILABLE');

     await fetch(stack.upstreams.comfy.url + '/__mock/fault', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ executionError:'after prompt id' }) });
     var sdCallsBeforeComfyFailure = (await json(await fetch(stack.upstreams.sd.url + '/__mock/state'))).calls.filter(function (call: { path: string; }) { return call.path === '/sdapi/v1/txt2img'; }).length;
     var failureResponse = await post(base, requestBody);
    assert.equal(failureResponse.status, 202);
    var failureJob = (await json(failureResponse)).job;
    await new Promise(function (resolve) { setTimeout(resolve, 150); });
    var failed = await json(await fetch(base + '/api/generation/jobs/' + failureJob.id));
    assert.equal(failed.job.provider, 'comfy');
    assert.equal(failed.job.status, 'failed');
     var calls = await json(await fetch(stack.upstreams.comfy.url + '/__mock/state'));
      assert.equal(calls.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).length, 4);
     var finalSdCalls = await json(await fetch(stack.upstreams.sd.url + '/__mock/state'));
      assert.equal(finalSdCalls.calls.filter(function (call: { path: string; }) { return call.path === '/sdapi/v1/txt2img'; }).length, sdCallsBeforeComfyFailure, 'Comfy post-submit failure must not retry WebUI');
  } finally {
    await stack.close();
  }
}

if (require.main === module) run().then(function () { console.log('test-generation-routes: ok'); }).catch(function (error) { console.error(error); process.exitCode=1; });
export = { run:run };
