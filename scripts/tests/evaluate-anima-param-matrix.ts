#!/usr/bin/env node
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

/* Anima 参数矩阵对照：首轮采样器 × 放大开关。
 * 复用生产 buildWorkflow（TeaCache/RCAS/hires 结构全保留），仅注入参数变量。
 *
 * 矩阵（6 组 × 固定 seed × 固定 prompt）：
 *   A  res_multistep / simple            30s CFG4.5 无放大   —— 旧默认基线
 *   B  euler_ancestral / simple          30s CFG4.5 无放大   —— 新默认首轮
 *   C  euler_ancestral / simple          30s CFG4.5 放大 on  —— 新默认完整链路
 *   D  res_multistep / simple            30s CFG4.5 放大 on  —— 旧首轮 + 冻结二阶段
 *   E  er_sde / sgm_uniform              30s CFG4.5 无放大   —— 历史官方参数组
 *   F  er_sde / sgm_uniform              30s CFG4.5 放大 on  —— 官方组 + 冻结二阶段
 * 放大二阶段统一为生产冻结组合：res_multistep + sgm_uniform（HIRES 常量），
 * Remacri ESRGAN 像素超分 + denoise 0.35。
 *
 * Usage: node scripts/tests/evaluate-anima-param-matrix.js [--dry-run] [--only A,B] [--seeds a,b] [--concurrency <n>]
 */

var crypto: typeof import('crypto') = require('crypto');
var fs: typeof import('fs') = require('fs');
var path: typeof import('path') = require('path');
var animaRoute: typeof import('../../routes/anima') = require('../../routes/anima');

var ROOT = path.resolve(__dirname, '..', '..');
var AI_ROOT = path.resolve(ROOT, '..', 'AI');
var COMFY = process.env.COMFY_HOST || 'http://127.0.0.1:8188';
var WIDTH = 832;
var HEIGHT = 1216;
var LORA_STRENGTH = 0.85;
var MODEL_ID = 'anima-base-v1.0';
var LORA_ID = 'L_NENE_V21_ANIMA';
var CHARACTER = 'nene';
var SUPER_RES = '4x_foolhardy_Remacri.safetensors';
var CLIENT_ID = 'aics-anima-param-matrix-' + crypto.randomUUID();
var CONCURRENCY = 3;

var PROMPT = [
  'masterpiece, best_quality, score_7, safe',
  '1girl, solo, ayachi_nene',
  'white_hair, very_long_hair, low_twintails, purple_eyes, ahoge, pink_hair_ribbons',
  'nene_school_uniform, blazer, yellow_bowtie, plaid_skirt',
  'classroom, classroom_window, holding_papers, shy, window_light, rim_light',
].join(', ');

var NEGATIVE = 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration';

var GROUPS: any = {
  A: { label:'A_rm_simple', sampler:'res_multistep', scheduler:'simple', hires:false },
  B: { label:'B_euler_simple', sampler:'euler_ancestral', scheduler:'simple', hires:false },
  C: { label:'C_euler_hires', sampler:'euler_ancestral', scheduler:'simple', hires:true },
  D: { label:'D_rm_hires', sampler:'res_multistep', scheduler:'simple', hires:true },
  E: { label:'E_ersde_sgm', sampler:'er_sde', scheduler:'sgm_uniform', hires:false },
  F: { label:'F_ersde_sgm_hires', sampler:'er_sde', scheduler:'sgm_uniform', hires:true },
  // 二阶段变量隔离组（2026-08-25 后用户实测放大全不合格，锁定二阶段组合可疑）：
  // X1 = 完整复原 433f93f（Remacri 接入当时的“好用”版本：二阶段缺省 euler/normal + TeaCache + 无 RCAS）
  // X2 = 当前生产（二阶段冻结 res_multistep/sgm_uniform + TeaCache + RCAS）
  // X3 = 1ba33b5「放大发糊根治」版（去 TeaCache 直连原模型全量重绘）
  // X4 = 冻结组合 + 去 TeaCache（隔离 TeaCache 在冻结组合下的作用）
  X1: { label:'X1_euler_norm_teacache_norcas', sampler:'euler_ancestral', scheduler:'simple', hires:true, h2Sampler:'euler', h2Scheduler:'normal', h2TeaCache:true, h2Rcas:false },
  X2: { label:'X2_rm_sgm_teacache_rcas', sampler:'euler_ancestral', scheduler:'simple', hires:true, h2Sampler:'res_multistep', h2Scheduler:'sgm_uniform', h2TeaCache:true, h2Rcas:true },
  X3: { label:'X3_euler_norm_notea_rcas', sampler:'euler_ancestral', scheduler:'simple', hires:true, h2Sampler:'euler', h2Scheduler:'normal', h2TeaCache:false, h2Rcas:true },
  X4: { label:'X4_rm_sgm_notea_rcas', sampler:'euler_ancestral', scheduler:'simple', hires:true, h2Sampler:'res_multistep', h2Scheduler:'sgm_uniform', h2TeaCache:false, h2Rcas:true },
  // P 组（2026-08-25 后用户实测放大“脏”）：隔离“二阶段重绘”整段——P1 纯像素放大
  // （Remacri 4x → lanczos 缩到 2x → 直出，无 VAEEncode/KSampler 重绘），P2 复现当前生产。
  P1: { label:'P1_pure_pixel', sampler:'euler_ancestral', scheduler:'simple', hires:true, purePixel:true },
  P2: { label:'P2_full_chain', sampler:'euler_ancestral', scheduler:'simple', hires:true, h2Sampler:'res_multistep', h2Scheduler:'sgm_uniform', h2TeaCache:true, h2Rcas:true },
  // X1r = 433f93f 完全复刻：首轮也回到当时的 res_multistep/simple（非 euler_ancestral），
  // 二阶段缺省 euler/normal + TeaCache + 末端无 RCAS —— 逐字还原“刚组装 Remacri 时不脏”的状态。
  X1r: { label:'X1r_433f93f_full', sampler:'res_multistep', scheduler:'simple', hires:true, h2Sampler:'euler', h2Scheduler:'normal', h2TeaCache:true, h2Rcas:false },
  // Z 组（2026-08-25 晚）：隔离 VAE 4MP 往返 vs KSampler 重绘——
  // Z1 = VAEEncode(24)→VAEDecode 直出，无二阶段 KSampler；Z2 = 现行全链复现。
  Z1: { label:'Z1_vae_roundtrip', sampler:'euler_ancestral', scheduler:'simple', hires:true, vaeOnly:true },
  Z2: { label:'Z2_full_chain', sampler:'euler_ancestral', scheduler:'simple', hires:true, h2Sampler:'res_multistep', h2Scheduler:'sgm_uniform', h2TeaCache:true, h2Rcas:true },
};

var DEFAULT_SEEDS = [20260826, 20260827];

function assert(condition: boolean, message: string|undefined) {
  if (!condition) throw new Error(message);
}

function readJson(file: PathOrFileDescriptor) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file: PathLike, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  var temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

function sha256(value: string|NodeJS.ArrayBufferView<ArrayBufferLike>|Buffer<ArrayBuffer>) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function comfyUrl(pathname: string|URL) {
  var base = new URL(COMFY);
  assert(base.protocol === 'http:' || base.protocol === 'https:', 'COMFY_HOST protocol is invalid');
  assert(['127.0.0.1', 'localhost', '::1'].includes(base.hostname), 'Matrix only allows a local ComfyUI host');
  return new URL(pathname, base).toString();
}

async function requestJson(pathname: string, options: RequestInit|undefined) {
  var response = await fetch(comfyUrl(pathname), options);
  var text = await response.text();
  var data = null;
  try { data = text ? JSON.parse(text) : null; } catch (error) {}
  if (!response.ok) throw new Error(pathname + ' returned HTTP ' + response.status + ': ' + text.slice(0, 1000));
  return data;
}

async function requestImage(image: any) {
  var query = new URLSearchParams({
    filename:String(image.filename || ''),
    subfolder:String(image.subfolder || ''),
    type:String(image.type || 'output'),
  });
  var response = await fetch(comfyUrl('/view?' + query.toString()), { cache:'no-store' });
  var mime = String(response.headers.get('content-type') || '');
  assert(response.ok && mime.startsWith('image/'), 'ComfyUI result was not an image: HTTP ' + response.status + ' ' + mime);
  var body = Buffer.from(await response.arrayBuffer());
  assert(body.length > 0, 'ComfyUI returned an empty image');
  return body;
}

async function waitFor(promptId: string|number|boolean) {
  var deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    var history = await requestJson('/history/' + encodeURIComponent(promptId), { cache:'no-store' });
    var entry = history && history[promptId];
    if (entry) {
      var messages = entry.status && entry.status.messages || [];
      var failed = messages.find(function (message: string[]) { return message && message[0] === 'execution_error'; });
      if (failed) throw new Error('ComfyUI execution failed: ' + JSON.stringify(failed));
      var images = entry.outputs && entry.outputs['10'] && entry.outputs['10'].images;
      if (Array.isArray(images) && images[0]) return images[0];
    }
    await new Promise(function (resolve) { setTimeout(resolve, 1000); });
  }
  throw new Error('ComfyUI prompt timed out: ' + promptId);
}

function workflowFor(group: any, seed: string) {
  var workflow = animaRoute.buildWorkflow({
    prompt:PROMPT,
    negative:NEGATIVE,
    modelId:MODEL_ID,
    loraId:LORA_ID,
    loraStrength:LORA_STRENGTH,
    width:WIDTH,
    height:HEIGHT,
    steps:30,
    cfg:4.5,
    sampler:group.sampler,
    scheduler:group.scheduler,
    seed:seed,
    character:CHARACTER,
    hiresFix:group.hires,
    hiresScale:group.hires ? 2.0 : 1.0,
    hiresDenoise:group.hires ? 0.35 : 0.35,
    superResModel:group.hires ? SUPER_RES : null,
    hiresUpscaler:group.hires ? 'Remacri' : null,
  });
  if (group.hires && group.purePixel) {
    // 纯像素放大：Remacri 像素超分结果（节点 23 ImageScale 的 IMAGE 输出）直出保存，
    // 移除 VAEEncode(24) + 二阶段 KSampler(25) + 解码重绘段。
    var scale = workflow['23'];
    if (!scale || scale.class_type !== 'ImageScale') throw new Error('纯像素放大路径节点 23 不在预期位置');
    workflow['10'].inputs.images = ['23', 0];
    delete workflow['24'];
    delete workflow['25'];
  } else if (group.hires && group.vaeOnly) {
    // VAE 往返直出：保留 VAEEncode(24)，删掉二阶段 KSampler(25)，解码节点直吃 24。
    var enc = workflow['24'];
    if (!enc || enc.class_type !== 'VAEEncode') throw new Error('VAE 往返路径节点 24 不在预期位置');
    // 解码节点（lora 分支为 9）：直接消费 VAEEncode 输出，绕过 KSampler
    workflow['9'].inputs.samples = ['24', 0];
    delete workflow['25'];
    workflow['10'].inputs.images = ['9', 0];
  } else if (group.hires && group.h2Sampler) {
    // 二阶段变量注入：Remacri 路径二阶段节点固定为 25，解码节点 lora 分支为 9。
    var h2 = workflow['25'];
    if (!h2 || h2.class_type !== 'KSampler') throw new Error('hires 二阶段节点 25 不在预期位置');
    h2.inputs.sampler_name = group.h2Sampler;
    h2.inputs.scheduler = group.h2Scheduler;
    if (group.h2TeaCache === false) {
      // 绕过 TeaCache：直接连 LoraLoader 输出（lora 分支 ['4',0]）
      h2.inputs.model = ['4', 0];
    }
    if (group.h2Rcas === false) {
      // 还原 433f93f：末端不挂 RCAS，解码节点直出
      workflow['10'].inputs.images = ['9', 0];
    }
  }
  workflow['10'].inputs.filename_prefix = ['anima_param_matrix', group.label, 'seed-' + seed].join('/');
  return workflow;
}

function argValue(name: string, fallback: string) {
  var raw = process.argv.find(function (a) { return a.startsWith('--' + name + '='); });
  return raw ? raw.split('=')[1] : (process.argv.includes('--' + name) ? process.argv[process.argv.indexOf('--' + name) + 1] : fallback);
}

async function main() {
  var onlyRaw = argValue('only', '');
  var only = onlyRaw ? onlyRaw.split(',').map(function (s: string) { return s.trim(); }).filter(Boolean) : Object.keys(GROUPS);
  var seedsRaw = argValue('seeds', '');
  var seeds = seedsRaw ? seedsRaw.split(',').map(function (s: string) { return Number(s.trim()); }).filter(Number.isFinite) : DEFAULT_SEEDS;
  var concurrency = Number(argValue('concurrency', String(CONCURRENCY)));
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8, '--concurrency must be an integer 1..8');

  var outputRoot = path.join(AI_ROOT, 'Reviews', 'AnimaParamMatrix');
  var manifestFile = path.join(outputRoot, 'manifest.json');
  var manifest = fs.existsSync(manifestFile) ? readJson(manifestFile) : {
    version:1,
    purpose:'Anima first-pass sampler x hires matrix (buildWorkflow production chain)',
    comfy:COMFY,
    modelId:MODEL_ID,
    loraId:LORA_ID,
    loraStrength:LORA_STRENGTH,
    width:WIDTH,
    height:HEIGHT,
    steps:30,
    cfg:4.5,
    prompt:PROMPT,
    negative:NEGATIVE,
    hiresSecondPass:{ sampler:'res_multistep', scheduler:'sgm_uniform', superRes:SUPER_RES, denoise:0.35 },
    groups:GROUPS,
    records:[],
  };

  var pending: any[] = [];
  for (var groupKey of only) {
    var group = GROUPS[groupKey];
    assert(group, 'Unknown group: ' + groupKey);
    for (var seed of seeds) {
      var existing = manifest.records.find(function (r: { group: string; seed: number; status: string; }) { return r.group === groupKey && r.seed === seed && r.status === 'succeeded'; });
      if (existing && fs.existsSync(path.join(outputRoot, existing.image))) continue;
      pending.push({ groupKey:groupKey, group:group, seed:seed });
    }
  }

  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ outputRoot:outputRoot, pending:pending.map(function (j: any) { return j.groupKey + ':' + j.seed; }) }, null, 2));
    return;
  }

  // 提交前先确认 ComfyUI 在线
  var stats = null;
  try { stats = await requestJson('/system_stats', { cache:'no-store' }); } catch (error) {}
  assert(stats && stats.system, 'ComfyUI is not reachable at ' + COMFY + ' — start it first');

  console.log('待生成: ' + pending.length + ' 张，并发窗口: ' + concurrency);
  var next = 0;
  var total = 0;

  async function runOne() {
    while (true) {
      var index = next;
      next += 1;
      if (index >= pending.length) return;
      var job: any = pending[index];
      var workflow = workflowFor(job.group, job.seed);
      var startedAt = new Date().toISOString();
      var submitted = await requestJson('/prompt', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({ prompt:workflow, client_id:CLIENT_ID }),
      });
      assert(submitted && submitted.prompt_id, 'ComfyUI did not return prompt_id');
      var image = await waitFor(submitted.prompt_id);
      var body = await requestImage(image);
      var relative = path.join('images', job.groupKey + '-' + job.seed + '.png');
      var outputFile = path.join(outputRoot, relative);
      fs.mkdirSync(path.dirname(outputFile), { recursive:true });
      fs.writeFileSync(outputFile, body);

      manifest.records = manifest.records.filter(function (r: any) { return !(r.group === job.groupKey && r.seed === job.seed); });
      manifest.records.push({
        group:job.groupKey,
        label:job.group.label,
        sampler:job.group.sampler,
        scheduler:job.group.scheduler,
        hires:job.group.hires,
        seed:job.seed,
        image:relative.replace(/\\/g, '/'),
        bytes:body.length,
        sha256:sha256(body),
        promptId:submitted.prompt_id,
        startedAt:startedAt,
        finishedAt:new Date().toISOString(),
        status:'succeeded',
      });
      writeJson(manifestFile, manifest);
      total += 1;
      console.log(job.groupKey + ' seed-' + job.seed + ': ' + outputFile);
    }
  }

  var workers = [];
  for (var w = 0; w < Math.min(concurrency, pending.length || 1); w += 1) {
    workers.push(runOne());
  }
  await Promise.all(workers);

  manifest.finishedAt = new Date().toISOString();
  writeJson(manifestFile, manifest);
  console.log('Anima param matrix done (' + total + ' new). Manifest: ' + manifestFile);
}

main().catch(function (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
