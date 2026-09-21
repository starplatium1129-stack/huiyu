'use strict';

let assert: typeof import('assert/strict') = require('assert/strict');
let gatewayStack: typeof import('./gateway-test-stack') = require('./gateway-test-stack');
let generation: any = require('../../routes/generation');
import { createWebUIProbe, type requestJson } from '../../server/generation/webui';
import { createGenerationService } from '../../server/generation/service';

async function verifyProbeOwnership() {
  const releases: Array<(value: unknown) => void> = [];
  let requests = 0;
  const request: typeof requestJson = async (_config, _key, _method, pathname) => {
    requests++;
    if (pathname.endsWith('/options')) return new Promise(resolve => releases.push(resolve));
    if (pathname.endsWith('/sd-models')) return [{ title:'waiIllustriousSDXL_v170.safetensors' }];
    return [{ name:42 }, null, { name:'Euler' }];
  };
  const config = { SD_HOST:'http://fixture.invalid' };
  const probe = createWebUIProbe(config, request);
  const old = probe();
  assert.equal(probe(), old, 'ordinary status calls coalesce');
  const fresh = probe({ fresh:true });
  assert.notEqual(fresh, old, 'submission cannot reuse a pre-existing status probe');
  releases[1]({ sd_model_checkpoint:'waiIllustriousSDXL_v170.safetensors' });
  const current = await fresh;
  assert.deepEqual(current.samplers, ['Euler'], 'untrusted catalog names are decoded');
  releases[0]({ sd_model_checkpoint:'other.safetensors' });
  await old;
  assert.deepEqual(await probe(), current, 'late old status cannot replace the fresh cache');
  assert.equal(requests, 10);
  const other = createWebUIProbe({ SD_HOST:'http://fixture.invalid' }, request);
  const independent = other();
  assert.equal(requests, 15, 'each service has independent probe ownership');
  releases[2]({}); await independent;
  config.SD_HOST = 'http://second.invalid';
  const switched = probe();
  assert.equal(requests, 20, 'changing the configured host invalidates even a fresh TTL cache');
  releases[3]({}); await switched;
  const pendingOldHost = probe({ fresh:true });
  config.SD_HOST = 'http://third.invalid';
  const latestHost = probe();
  assert.equal(requests, 30, 'a new host never joins the previous host request');
  releases[5]({ sd_model_checkpoint:'waiIllustriousSDXL_v170.safetensors' });
  const latest = await latestHost;
  releases[4]({}); await pendingOldHost;
  assert.deepEqual(await probe(), latest, 'late responses from a replaced host cannot repopulate its cache');
}

async function json(response: Response) { return response.json(); }
async function post(base: string, body: any, token?: any) {
  return fetch(base + '/api/generation/jobs', { method:'POST', headers:{ 'content-type':'application/json', ...(token ? { 'x-token':token } : {}) }, body:JSON.stringify(body) });
}
type FixtureGenerationJob = { id: string; status: string; resultUrl?: string | null; [key: string]: unknown };
async function waitForGenerationJob(base: string, id: string, timeoutMs = 4000) {
  let deadline = Date.now() + timeoutMs;
  let latest: FixtureGenerationJob | null = null;
  do {
    let response = await fetch(base + '/api/generation/jobs/' + encodeURIComponent(id));
    latest = (await json(response) as { job: FixtureGenerationJob }).job;
    if (['succeeded', 'failed', 'cancelled'].includes(latest.status)) return latest;
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
  } while (Date.now() < deadline);
  throw new Error('generation job did not finish: ' + id + ' (' + (latest && latest.status) + ')');
}
function mockFault(url: string, fault: Record<string, unknown>) {
  return fetch(url + '/__mock/fault', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(fault) });
}

async function run() {
  await verifyProbeOwnership();
  for (const id of ['__proto__', 'constructor']) assert.throws(() => generation.validateInput({
    prompt:'river', width:832, height:1216, loras:[{ id, strength:0.8 }],
  }), /未知 WAI LoRA/);
  let valid = generation.validateInput({ prompt:'1girl, solo', negative:'bad', loras:[{ id:'L_NENE_V18_WD14', strength:0.85 }], width:832, height:1216, steps:28, cfg:5.5, seed:12, sampler:'DPM++ 2M', scheduler:'Karras' });
  let dual = generation.validateInput({ prompt:'2girls', loras:[{ id:'L_NENE_V18_WD14', strength:0.52 }, { id:'L_NAT_V18_WD14', strength:0.62 }], width:832, height:1216 });
  assert.deepEqual(dual.loras.map(function (item: any) { return item.strength; }), [0.52, 0.62]);
  assert.throws(function () { generation.validateInput({ prompt:'x', loras:[{ id:'L_NENE_V18_WD14', strength:0.52 }], width:832, height:1216 }); }, /超出允许范围/);
  assert.throws(function () { generation.validateInput({ prompt:'x', loras:[{ id:'L_NENE_V18_WD14', strength:0.52 }, { id:'L_NENE_V18_WD14', strength:0.52 }], width:832, height:1216 }); }, /不得重复/);
  let requestBody = { prompt:'1girl, solo, <lora:ayachi_nene_v18_wd14:0.85>', negative:'bad', loras:[{ id:'L_NENE_V18_WD14', strength:0.85 }], width:832, height:1216, steps:28, cfg:5.5, seed:12, sampler:'DPM++ 2M', scheduler:'Karras' };
  let graph = generation.buildWorkflow(valid);
  assert.equal(graph['1'].class_type, 'CheckpointLoaderSimple');
  assert.equal(graph['10'].class_type, 'SaveImage');
  assert.equal(graph['2'].inputs.lora_name, 'ayachi_nene_v18_wd14.safetensors');
  let tagged = generation.validateInput({ prompt:'1girl, <lora:ayachi_nene_v18_wd14:0.85>', negative:'bad', loras:[{ id:'L_NENE_V18_WD14', strength:0.85 }], width:832, height:1216, steps:28, cfg:5.5, seed:12, sampler:'DPM++ 2M' });
  let taggedGraph = generation.buildWorkflow(tagged);
  assert.equal(taggedGraph['4'].inputs.text.includes('<lora:'), false, 'Comfy CLIP text must not contain LoRA syntax');
  let hiresGraph = generation.buildWorkflow(generation.validateInput({ prompt:'x', width:1024, height:1024, hiresFix:true, hiresUpscaler:'Latent', hiresScale:1.5, hiresSteps:20, denoisingStrength:0.4 }));
  assert.equal(hiresGraph['11'].class_type, 'LatentUpscaleBy');
  assert.equal(hiresGraph['11'].inputs.upscale_method, 'nearest-exact');
  assert.equal(hiresGraph['12'].class_type, 'KSampler');
  let autoHiresGraph = generation.buildWorkflow(generation.validateInput({ prompt:'x', width:1024, height:1024, hiresFix:true, hiresUpscaler:'Auto', hiresScale:1.5, hiresSteps:20, denoisingStrength:0.4 }));
  assert.equal(autoHiresGraph['11'].inputs.upscale_method, 'nearest-exact', 'Comfy resolves Auto hires to nearest-exact latent');
  // 2026-08-18 super-res：显式 Remacri 意图应被认定为 Comfy 能力，注入模型文件后
  // buildWorkflow 产出 ESRGAN 像素级超分链路（UpscaleModelLoader→VAEDecode→
  // ImageUpscaleWithModel→ImageScale→VAEEncode→二阶段 KSampler）。
  let superResValid = generation.validateInput({ prompt:'x', width:832, height:1216, hiresFix:true, hiresUpscaler:'Remacri', hiresScale:1.5, hiresSteps:20, denoisingStrength:0.4 });
  assert.equal(superResValid.superResWanted, true);
  assert.equal(superResValid.comfyHires, true);
  let superResGraph = generation.buildWorkflow(Object.assign({}, superResValid, { superResModel:'4x_foolhardy_Remacri.safetensors' }));
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

   let stack = await gatewayStack.start({ prepare:function (context: { config: { AI_WORKSPACE_ROOT: string; }; }) {
     let checkpointRoot = (require('path') as typeof import('path')).join(context.config.AI_WORKSPACE_ROOT, 'ComfyUI', 'models', 'checkpoints');
     let loraRoot = (require('path') as typeof import('path')).join(context.config.AI_WORKSPACE_ROOT, 'ComfyUI', 'models', 'loras');
     let upscaleRoot = (require('path') as typeof import('path')).join(context.config.AI_WORKSPACE_ROOT, 'ComfyUI', 'models', 'upscale_models');
     (require('fs') as typeof import('fs')).mkdirSync(checkpointRoot, { recursive:true });
     (require('fs') as typeof import('fs')).mkdirSync(loraRoot, { recursive:true });
     (require('fs') as typeof import('fs')).mkdirSync(upscaleRoot, { recursive:true });
     (require('fs') as typeof import('fs')).writeFileSync((require('path') as typeof import('path')).join(checkpointRoot, generation.constants.CHECKPOINT), 'checkpoint');
     (require('fs') as typeof import('fs')).writeFileSync((require('path') as typeof import('path')).join(loraRoot, generation.constants.LORAS.L_NENE_V18_WD14.file), 'nene');
     (require('fs') as typeof import('fs')).writeFileSync((require('path') as typeof import('path')).join(loraRoot, generation.constants.LORAS.L_NAT_V18_WD14.file), 'natsume');
     (require('fs') as typeof import('fs')).writeFileSync((require('path') as typeof import('path')).join(upscaleRoot, generation.availableSuperRes(context.config) || '4x_foolhardy_Remacri.safetensors'), 'remacri');
   } });
   try {
     let base = stack.baseUrl;
     const isolated = createGenerationService(stack.config);
     try {
       const job = await isolated.submit(generation.validateInput({ ...requestBody, faceDetailer:true }), 'owner-a');
       assert.ok(job);
       assert.throws(() => isolated.getJob(job.id, 'owner-b'), /任务不存在/);
       isolated.close();
       await assert.rejects(isolated.submit(generation.validateInput(requestBody), 'owner-a'), /生成服务已关闭/);
       await new Promise(resolve => setTimeout(resolve, 30));
       assert.throws(() => isolated.getJob(job.id, 'owner-a'), /任务不存在/, 'closed service releases jobs, including late responses');
     } finally { isolated.close(); }
      let status = await json(await fetch(base + '/api/generation/status'));
      assert.equal(status.capabilities.hiresUpscalers.includes('Auto'), true);
      let queuedAutoBody = Object.assign({}, requestBody, { hiresFix:true, hiresUpscaler:'Auto', hiresScale:1.5, hiresSteps:20, denoisingStrength:0.4 });
      await mockFault(stack.upstreams.sd.url!, { renderMs:150 });
      let admissionResponses = await Promise.all(Array.from({ length:5 }, function () { return post(base, queuedAutoBody); }));
      let admissionJobs: FixtureGenerationJob[] = [];
      let queueFullResponses = 0;
      for (const response of admissionResponses) {
        if (response.status === 202) admissionJobs.push((await json(response)).job);
        if (response.status === 503) {
          queueFullResponses += 1;
          assert.equal((await json(response)).code, 'GENERATION_QUEUE_FULL');
        }
      }
      assert.equal(admissionJobs.length, 4, 'WebUI admission is bounded by the in-flight budget');
      assert.equal(queueFullResponses, 1, 'the fifth WebUI request is rejected instead of being accepted unboundedly');
      let admissionStatus = await json(await fetch(base + '/api/generation/status'));
      assert.ok(admissionStatus.webuiPending <= admissionStatus.maxPending);
      await Promise.all(admissionJobs.map(function (job) { return waitForGenerationJob(base, job.id); }));
      await mockFault(stack.upstreams.sd.url!, { renderMs:0 });
      let webuiResponse = await post(base, requestBody);
     assert.equal(webuiResponse.status, 202);
     let webuiJob = (await json(webuiResponse)).job;
      assert.equal(webuiJob.provider, 'comfy', 'Comfy is preferred for compatible WAI requests');
      assert.deepEqual(webuiJob.metadata.loras, [{ id:'L_NENE_V18_WD14', strength:0.85 }]);
      let completedComfyJob = await waitForGenerationJob(base, webuiJob.id);
      assert.equal(completedComfyJob.status, 'succeeded');
      assert.ok(completedComfyJob.resultUrl);
      let comfyPromptCountBeforeResult = (await json(await fetch(stack.upstreams.comfy.url + '/__mock/state'))).calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).length;
      let comfyFirstResult = await fetch(base + completedComfyJob.resultUrl);
      assert.equal(comfyFirstResult.status, 200);
      assert.equal(comfyFirstResult.headers.get('cache-control'), 'no-store');
      let comfyFirstBytes = Buffer.from(await comfyFirstResult.arrayBuffer());
      let comfySecondResult = await fetch(base + completedComfyJob.resultUrl);
      assert.equal(comfySecondResult.status, 200, 'Comfy results are also rereadable within their TTL');
      assert.deepEqual(Buffer.from(await comfySecondResult.arrayBuffer()), comfyFirstBytes);
      let comfyPromptCountAfterResult = (await json(await fetch(stack.upstreams.comfy.url + '/__mock/state'))).calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).length;
      assert.equal(comfyPromptCountAfterResult, comfyPromptCountBeforeResult, 'rereading a Comfy result does not submit another prompt');
      assert.ok([401, 404].includes((await fetch(base + completedComfyJob.resultUrl, { headers:{ 'x-token':'wrong-token', 'x-forwarded-for':'203.0.113.10' } })).status), 'result reads remain owner-scoped');
      let autoWebuiResponse = await post(base, Object.assign({}, requestBody, { hiresFix:true, hiresUpscaler:'Auto', hiresScale:1.5, hiresSteps:20, denoisingStrength:0.4 }));
      assert.equal(autoWebuiResponse.status, 202);
      let autoWebuiJob = (await json(autoWebuiResponse)).job;
      assert.equal(autoWebuiJob.provider, 'webui', 'Auto hires prefers Anime6B when WebUI provides it');
      assert.equal(autoWebuiJob.metadata.hiresUpscaler, 'R-ESRGAN 4x+ Anime6B');
      let autoWebuiCalls = await json(await fetch(stack.upstreams.sd.url + '/__mock/state'));
      let autoPayload = autoWebuiCalls.calls.filter(function (call: { path: string; }) { return call.path === '/sdapi/v1/txt2img'; }).at(-1).body;
      assert.equal(autoPayload.hr_upscaler, 'R-ESRGAN 4x+ Anime6B');
      let completedAutoWebuiJob = await waitForGenerationJob(base, autoWebuiJob.id);
      assert.equal(completedAutoWebuiJob.status, 'succeeded');
      assert.ok(completedAutoWebuiJob.resultUrl);
      let sdCallsBeforeResult = autoWebuiCalls.calls.filter(function (call: { path: string; }) { return call.path === '/sdapi/v1/txt2img'; }).length;
      let firstResult = await fetch(base + completedAutoWebuiJob.resultUrl);
      assert.equal(firstResult.status, 200);
      assert.equal(firstResult.headers.get('cache-control'), 'no-store');
      let firstBytes = Buffer.from(await firstResult.arrayBuffer());
      let secondResult = await fetch(base + completedAutoWebuiJob.resultUrl);
      assert.equal(secondResult.status, 200, 'a generated result remains readable within its TTL');
      assert.deepEqual(Buffer.from(await secondResult.arrayBuffer()), firstBytes);
      let sdCallsAfterResult = (await json(await fetch(stack.upstreams.sd.url + '/__mock/state'))).calls.filter(function (call: { path: string; }) { return call.path === '/sdapi/v1/txt2img'; }).length;
      assert.equal(sdCallsAfterResult, sdCallsBeforeResult, 'rereading a result does not submit a second generation');
      await mockFault(stack.upstreams.sd.url!, { renderMs:180 });
      let cancelFirstResponse = await post(base, queuedAutoBody);
      let cancelFirstJob = (await json(cancelFirstResponse)).job;
      let cancelSecondResponse = await post(base, queuedAutoBody);
      let cancelSecondJob = (await json(cancelSecondResponse)).job;
      let cancelResult = await fetch(base + '/api/generation/jobs/' + encodeURIComponent(cancelSecondJob.id), { method:'DELETE' });
      assert.equal(cancelResult.status, 200);
      assert.equal((await json(cancelResult)).job.status, 'cancelled');
      await waitForGenerationJob(base, cancelFirstJob.id);
      assert.equal((await json(await fetch(base + '/api/generation/jobs/' + encodeURIComponent(cancelSecondJob.id)))).job.status, 'cancelled');
      let cancelCalls = (await json(await fetch(stack.upstreams.sd.url + '/__mock/state'))).calls.filter(function (call: { path: string; }) { return call.path === '/sdapi/v1/txt2img'; }).length;
      assert.equal(cancelCalls - sdCallsAfterResult, 1, 'a queued cancellation does not interrupt or duplicate the active WebUI request');
      await mockFault(stack.upstreams.sd.url!, { renderMs:0 });
      await mockFault(stack.upstreams.sd.url!, { txt2imgStatus:500, txt2imgError:'fixture webui failure' });
      let failedWebuiResponse = await post(base, queuedAutoBody);
      assert.equal(failedWebuiResponse.status, 202);
      let failedWebuiJob = await waitForGenerationJob(base, (await json(failedWebuiResponse)).job.id);
      assert.equal(failedWebuiJob.status, 'failed');
      await mockFault(stack.upstreams.sd.url!, { renderMs:0 });
      let recoveredWebuiResponse = await post(base, queuedAutoBody);
      assert.equal(recoveredWebuiResponse.status, 202, 'a failed WebUI task releases its admission slot');
      assert.equal((await waitForGenerationJob(base, (await json(recoveredWebuiResponse)).job.id)).status, 'succeeded');
     let webuiSamplerFallback = await post(base, Object.assign({}, requestBody, { sampler:'DPM++ SDE' }));
      assert.equal(webuiSamplerFallback.status, 202, 'Comfy-first routing must not reject a Comfy-compatible request because WebUI lacks the sampler');
     await fetch(stack.upstreams.sd.url + '/__mock/fault', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ offline:true }) });

    let comfyResponse = await post(base, requestBody);
    assert.equal(comfyResponse.status, 202);
    let comfyJob = (await json(comfyResponse)).job;
    assert.equal(comfyJob.provider, 'comfy');
    let comfyCalls = await json(await fetch(stack.upstreams.comfy.url + '/__mock/state'));
    let comfyGraph = comfyCalls.calls.find(function (call: { path: string; }) { return call.path === '/prompt'; }).body.prompt;
    assert.equal(Object.values(comfyGraph).filter(function (node: any) { return node && node.class_type === 'CLIPTextEncode' && String(node.inputs.text).includes('<lora:'); }).length, 0);
    assert.equal((await fetch(base + '/prompt')).status, 404);
    assert.equal((await fetch(base + '/history/x')).status, 404);
    assert.equal((await fetch(base + '/view')).status, 404);
    assert.ok([401, 404].includes((await fetch(base + '/api/generation/jobs/' + comfyJob.id, { headers:{ 'x-token':'wrong-token', 'x-forwarded-for':'203.0.113.10' } })).status));

     let detailerOffline = await post(base, Object.assign({}, requestBody, { faceDetailer:true }));
     assert.equal(detailerOffline.status, 503);
     assert.equal((await json(detailerOffline)).code, 'WEBUI_RESOURCES_UNAVAILABLE');
    let hiresOffline = await post(base, Object.assign({}, requestBody, { hiresFix:true, hiresUpscaler:'Auto', hiresScale:1.5, hiresSteps:20, denoisingStrength:0.4 }));
     assert.equal(hiresOffline.status, 202, 'native super-res hires remains available when WebUI is offline');
      let hiresOfflineJob = (await json(hiresOffline)).job;
      assert.equal(hiresOfflineJob.metadata.hiresUpscaler, 'Remacri', 'Auto hires on Comfy resolves to Remacri super-res when installed');
     let hiresPrompts = await json(await fetch(stack.upstreams.comfy.url + '/__mock/state'));
      let comfyHiresGraph = hiresPrompts.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).at(-1).body.prompt;
      assert.equal(Object.values(comfyHiresGraph).some(function (node: any) { return node && node.class_type === 'UpscaleModelLoader'; }), true, 'Comfy hires graph must contain UpscaleModelLoader for super-res');

    let capabilityFallback = await post(base, Object.assign({}, requestBody, { sampler:'DPM++ SDE' }));
    assert.equal(capabilityFallback.status, 503);
    assert.equal((await json(capabilityFallback)).code, 'COMFY_CAPABILITY_UNAVAILABLE');

     await fetch(stack.upstreams.comfy.url + '/__mock/fault', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ executionError:'after prompt id' }) });
     let sdCallsBeforeComfyFailure = (await json(await fetch(stack.upstreams.sd.url + '/__mock/state'))).calls.filter(function (call: { path: string; }) { return call.path === '/sdapi/v1/txt2img'; }).length;
     let failureResponse = await post(base, requestBody);
    assert.equal(failureResponse.status, 202);
    let failureJob = (await json(failureResponse)).job;
    await new Promise(function (resolve) { setTimeout(resolve, 150); });
    let failed = await json(await fetch(base + '/api/generation/jobs/' + failureJob.id));
    assert.equal(failed.job.provider, 'comfy');
    assert.equal(failed.job.status, 'failed');
     let calls = await json(await fetch(stack.upstreams.comfy.url + '/__mock/state'));
      assert.equal(calls.calls.filter(function (call: { path: string; }) { return call.path === '/prompt'; }).length, 4);
     let finalSdCalls = await json(await fetch(stack.upstreams.sd.url + '/__mock/state'));
      assert.equal(finalSdCalls.calls.filter(function (call: { path: string; }) { return call.path === '/sdapi/v1/txt2img'; }).length, sdCallsBeforeComfyFailure, 'Comfy post-submit failure must not retry WebUI');
  } finally {
    await stack.close();
  }
}

if (require.main === module) run().then(function () { console.log('test-generation-routes: ok'); }).catch(function (error) { console.error(error); process.exitCode=1; });
export = { run:run };
