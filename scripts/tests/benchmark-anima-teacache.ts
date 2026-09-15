'use strict';

var http: typeof import('http') = require('http');

function postJson(url: any, payload: any) {
  return new Promise(function (resolve, reject) {
    var u = new URL(url);
    var body = Buffer.from(JSON.stringify(payload));
    var req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }
    }, function (res) {
      var chunks: any = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch (e) { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getJson(url: any) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      var chunks: any = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch (e) { resolve(raw); }
      });
    }).on('error', reject);
  });
}

async function waitForPrompt(promptId: any) {
  var start = Date.now();
  while (Date.now() - start < 120000) {
    var history: any = await getJson('http://127.0.0.1:8188/history/' + promptId);
    if (history && history[promptId]) {
      var status = history[promptId].status;
      var outputs = history[promptId].outputs;
      return { status: status, outputs: outputs, duration: (Date.now() - start) / 1000 };
    }
    await new Promise(function (r) { setTimeout(r, 300); });
  }
  throw new Error('Timeout waiting for prompt ' + promptId);
}

function buildAnimaPrompt(withTeaCache: any, thresh?: any) {
  var wf: any = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'anima-base-v1.0.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'qwen_image' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    '4': { class_type: 'LoraLoader', inputs: {
      model: ['1', 0],
      clip: ['2', 0],
      lora_name: 'ayachi_nene_v21_anima.safetensors',
      strength_model: 0.85,
      strength_clip: 0.85
    } },
    '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: 'ayachi_nene, 1girl, solo, smiling, cafe' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: 'worst quality, low quality' } },
    '7': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
    '8': { class_type: 'KSampler', inputs: {
      model: ['4', 0],
      positive: ['5', 0],
      negative: ['6', 0],
      latent_image: ['7', 0],
      seed: 4242,
      steps: 30,
      cfg: 4.5,
      sampler_name: 'res_multistep',
      scheduler: 'simple',
      denoise: 1
    } },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: withTeaCache ? 'bench_teacache' : 'bench_standard' } }
  };

  if (withTeaCache) {
    wf['13'] = {
      class_type: 'AnimaTeaCache',
      inputs: {
        model: ['4', 0],
        rel_l1_thresh: thresh || 0.08,
        start_percent: 0.0,
        end_percent: 1.0,
        cache_device: 'cuda'
      }
    };
    wf['8'].inputs.model = ['13', 0];
  }

  return wf;
}

async function run() {
  console.log('--- 1. Testing Standard Anima (30 steps, res_multistep) ---');
  var promptStandard = buildAnimaPrompt(false);
  var resStd: any = await postJson('http://127.0.0.1:8188/prompt', { prompt: promptStandard, client_id: 'bench' });
  console.log('Submitted standard prompt:', resStd.prompt_id);
  var t0 = Date.now();
  await waitForPrompt(resStd.prompt_id);
  var stdTime = (Date.now() - t0) / 1000;
  console.log('Standard finished in ' + stdTime.toFixed(2) + 's');

  console.log('\n--- 2. Testing TeaCache Anima (30 steps, thresh=0.08) ---');
  var promptTea = buildAnimaPrompt(true, 0.08);
  var resTea: any = await postJson('http://127.0.0.1:8188/prompt', { prompt: promptTea, client_id: 'bench' });
  console.log('Submitted TeaCache prompt:', resTea.prompt_id);
  var t1 = Date.now();
  await waitForPrompt(resTea.prompt_id);
  var teaTime = (Date.now() - t1) / 1000;
  console.log('TeaCache finished in ' + teaTime.toFixed(2) + 's');

  console.log('\n--- Summary ---');
  console.log('Standard Time: ' + stdTime.toFixed(2) + 's');
  console.log('TeaCache Time: ' + teaTime.toFixed(2) + 's');
  console.log('Speedup: ' + (stdTime / teaTime).toFixed(2) + 'x (' + ((1 - teaTime / stdTime) * 100).toFixed(1) + '% faster)');
}

run().catch(console.error);
