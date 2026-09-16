#!/usr/bin/env node
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

/* Unified sweep: ayachi_nene_v20_anima_scientific_unified epochs 4..24.
 * Same protocol as the v20-b final round: fixed extended scene matrix
 * (sleepwear, R18 extreme angles, full body, witch props, swimsuit OOD,
 * knitwear), fixed seeds, 1216x832, LoRA 0.85. Supports the default
 * parameter group (24s/CFG3/res_multistep/simple) and the official group
 * (30s/CFG4.5/er_sde/sgm_uniform) via --params.
 *
 * Usage: node scripts/tests/evaluate-anima-unified.js [--dry-run] [--params default|official] [--concurrency <n>]
 *
 * --concurrency <n>  并发提交窗口（默认 4）：ComfyUI /prompt 入队即返回，
 *                    GPU 队列自行串行执行；窗口内同时提交多张，避免逐张
 *                    等完成再提交的串行往返浪费。断点续跑天然支持（manifest
 *                    已成功记录且图片在盘上会自动跳过）。
 */

let crypto: typeof import('crypto') = require('crypto');
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let animaRoute: any = require('../../routes/anima');

let ROOT = path.resolve(__dirname, '..', '..');
let AI_ROOT = path.resolve(ROOT, '..', 'AI');
let COMFY = process.env.COMFY_HOST || 'http://127.0.0.1:8188';
let LORA_ROOT = path.join(AI_ROOT, 'ComfyUI', 'models', 'loras');
let SCENES = ['sc261', 'sc268', 'sc269', 'sc002', 'sc105', 'sc014', 'sc006'];
let SEEDS = [20260812, 20260813, 20260814];
let WIDTH = 1216;
let HEIGHT = 832;
let LORA_STRENGTH = 0.85;
let CLIENT_ID = 'aics-anima-unified-' + crypto.randomUUID();
// 并发提交窗口：ComfyUI /prompt 入队后立即返回 prompt_id，GPU 队列自行排队，
// 无需逐张等待完成再提交下一张。默认 4 个 in-flight，避免队列无界增长。
let CONCURRENCY = 4;

let PARAM_GROUPS: any = {
  default: { label:'24s_cfg3', steps:24, cfg:3, sampler:'res_multistep', scheduler:'simple' },
  official: { label:'30s_cfg45_ersde', steps:30, cfg:4.5, sampler:'er_sde', scheduler:'sgm_uniform' },
};

let CANDIDATES = [
  { id:'u_e04', epoch:4, step:168, file:'ayachi_nene_v20_anima_unified_e04.safetensors' },
  { id:'u_e08', epoch:8, step:336, file:'ayachi_nene_v20_anima_unified_e08.safetensors' },
  { id:'u_e12', epoch:12, step:504, file:'ayachi_nene_v20_anima_unified_e12.safetensors' },
  { id:'u_e16', epoch:16, step:672, file:'ayachi_nene_v21_anima.safetensors' },
  { id:'u_e20', epoch:20, step:840, file:'ayachi_nene_v20_anima_unified_e20.safetensors' },
  { id:'u_e24', epoch:24, step:1008, file:'ayachi_nene_v20_anima_unified_e24.safetensors' },
];

function paramsGroup() {
  let raw = process.argv.find(function (a) { return a.startsWith('--params='); });
  let value = raw ? raw.split('=')[1] : (process.argv.includes('--params') ? process.argv[process.argv.indexOf('--params') + 1] : 'default');
  let group = PARAM_GROUPS[value];
  if (!group) throw new Error('Unknown --params group: ' + value + ' (default|official)');
  return group;
}

function concurrencyFromArgs() {
  let raw = process.argv.find(function (a) { return a.startsWith('--concurrency='); });
  let value = raw ? raw.split('=')[1] : (process.argv.includes('--concurrency') ? process.argv[process.argv.indexOf('--concurrency') + 1] : String(CONCURRENCY));
  let n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 32) throw new Error('--concurrency must be an integer 1..32, got: ' + value);
  return n;
}

function assert(condition: any, message: string|undefined) {
  if (!condition) throw new Error(message);
}

function readJson(file: PathOrFileDescriptor) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file: string, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  let temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

function sha256(value: string|NodeJS.ArrayBufferView<ArrayBufferLike>|NonSharedBuffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file: PathOrFileDescriptor) {
  return sha256(fs.readFileSync(file));
}

function comfyUrl(pathname: string|URL) {
  let base = new URL(COMFY);
  assert(base.protocol === 'http:' || base.protocol === 'https:', 'COMFY_HOST protocol is invalid');
  assert(['127.0.0.1', 'localhost', '::1'].includes(base.hostname), 'Sweep only allows a local ComfyUI host');
  return new URL(pathname, base).toString();
}

async function requestJson(pathname: string, options: RequestInit|undefined) {
  let response = await fetch(comfyUrl(pathname), options);
  let text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (error) {}
  if (!response.ok) throw new Error(pathname + ' returned HTTP ' + response.status + ': ' + text.slice(0, 1000));
  return data;
}

async function requestImage(image: any) {
  let query = new URLSearchParams({
    filename:String(image.filename || ''),
    subfolder:String(image.subfolder || ''),
    type:String(image.type || 'output'),
  });
  let response = await fetch(comfyUrl('/view?' + query.toString()), { cache:'no-store' });
  let mime = String(response.headers.get('content-type') || '');
  assert(response.ok && mime.startsWith('image/'), 'ComfyUI result was not an image: HTTP ' + response.status + ' ' + mime);
  let body = Buffer.from(await response.arrayBuffer());
  assert(body.length > 0, 'ComfyUI returned an empty image');
  return body;
}

async function waitFor(promptId: string|number) {
  let deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    let history = await requestJson('/history/' + encodeURIComponent(promptId), { cache:'no-store' });
    let entry = history && history[promptId];
    if (entry) {
      let messages = entry.status && entry.status.messages || [];
      let failed = messages.find(function (message: string[]) { return message && message[0] === 'execution_error'; });
      if (failed) throw new Error('ComfyUI execution failed: ' + JSON.stringify(failed));
      let images = entry.outputs && entry.outputs['10'] && entry.outputs['10'].images;
      if (Array.isArray(images) && images[0]) return images[0];
    }
    await new Promise(function (resolve) { setTimeout(resolve, 1000); });
  }
  throw new Error('ComfyUI prompt timed out: ' + promptId);
}

function preserved(token: string) {
  return /^(ayachi_nene|nene_|score_)/i.test(token);
}

function spaced(token: string) {
  if (preserved(token)) return token;
  if (/^(safe|nsfw|sensitive|explicit|1girl|1boy|solo)$/i.test(token)) return token.toLowerCase();
  return token.replace(/_/g, ' ');
}

function animaPrompt(scene: any) {
  let safety = scene.mature ? 'nsfw' : 'safe';
  let story = String(scene.story || '').trim();
  let body = String(scene.prompt || '')
    .replace(/<lora:[^>]+>/gi, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/_BREAK_/gi, ' BREAK ')
    .split(',').map(function (tag) { return tag.trim(); }).filter(Boolean)
    .map(spaced).join(', ');
  return ['masterpiece, best_quality, score_7', safety, '1girl, solo, ayachi_nene',
    'white_hair, very_long_hair, low_twintails, purple_eyes, ahoge, pink_hair_ribbons',
    story, body].filter(Boolean).join(', ');
}

function animaNegative(scene: any) {
  let tail = String(scene.negative || '')
    .replace(/<lora:[^>]+>/gi, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/_BREAK_/gi, ' BREAK ')
    .split(',').map(function (tag) { return tag.trim(); }).filter(Boolean)
    .map(spaced).join(', ');
  return ['worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration',
    tail].filter(Boolean).join(', ');
}

function buildScenes() {
  let library = readJson(path.join(ROOT, 'data', 'scenes.json'));
  let byId = new Map(library.map(function (scene: any) { return [scene.id, scene]; }));
  return SCENES.map(function (id) {
    let scene: any = byId.get(id);
    assert(scene, 'Unknown scene id: ' + id);
    return {
      id:id,
      title:String(scene.title || ''),
      mature:Boolean(scene.mature),
      prompt:animaPrompt(scene),
      negative:animaNegative(scene),
    };
  });
}

function checkedCandidates() {
  return CANDIDATES.map(function (candidate) {
    let file = path.join(LORA_ROOT, candidate.file);
    assert(fs.existsSync(file), 'Missing unified LoRA: ' + file);
    return Object.assign({}, candidate, {
      bytes:fs.statSync(file).size,
      sha256:sha256File(file),
    });
  });
}

function workflowFor(scene: any, candidate: any, seed: number, group: any, modelId: string) {
  let workflow = animaRoute.buildWorkflow({
    prompt:scene.prompt,
    negative:scene.negative,
    modelId:modelId,
    loraId:'L_NENE_V20_ANIMA',
    loraStrength:LORA_STRENGTH,
    width:WIDTH,
    height:HEIGHT,
    steps:group.steps,
    cfg:group.cfg,
    sampler:group.sampler,
    scheduler:group.scheduler,
    seed:seed,
    character:'nene',
  });
  workflow['4'].inputs.lora_name = candidate.file;
  workflow['10'].inputs.filename_prefix = [
    'anima_unified_sweep', group.label, candidate.id, scene.id, 'seed-' + seed,
  ].join('/');
  return workflow;
}

async function main() {
  let group = paramsGroup();
  let modelId = 'anima-base-v1.0';
  let modelRaw = process.argv.find(function (a) { return a.startsWith('--model='); });
  if (modelRaw) modelId = modelRaw.split('=')[1];
  else if (process.argv.includes('--model')) modelId = process.argv[process.argv.indexOf('--model') + 1];
  if (!['anima-base-v1.0', 'anima-aesthetic-v1.1'].includes(modelId)) {
    throw new Error('Unknown --model: ' + modelId + ' (anima-base-v1.0|anima-aesthetic-v1.1)');
  }
  let onlyRaw = process.argv.find(function (a) { return a.startsWith('--only='); });
  let only: string|string[]|null = null;
  if (onlyRaw) only = onlyRaw.split('=')[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  else if (process.argv.includes('--only')) only = process.argv[process.argv.indexOf('--only') + 1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  let scenes = buildScenes();
  let candidates = checkedCandidates().filter(function (c) { return !only || only.includes(c.id); });
  let modelTag = modelId === 'anima-aesthetic-v1.1' ? '_aesthetic' : '';
  let outputRoot = path.join(AI_ROOT, 'Reviews', 'AnimaUnifiedSweep', '2026-08-13_' + group.label + modelTag);
  let manifestFile = path.join(outputRoot, 'manifest.json');
  let manifest = fs.existsSync(manifestFile) ? readJson(manifestFile) : {
    version:1,
    purpose:'Unified sweep: ayachi_nene_v20_anima_scientific_unified epochs on the extended scene matrix',
    comfy:COMFY,
    paramGroup:group.label,
    modelId:modelId,
    settings:{ width:WIDTH, height:HEIGHT, steps:group.steps, cfg:group.cfg, sampler:group.sampler, scheduler:group.scheduler, loraStrength:LORA_STRENGTH, seeds:SEEDS },
    scenes:scenes,
    candidates:candidates,
    records:[],
  };
  manifest.paramGroup = group.label;
  manifest.settings = { width:WIDTH, height:HEIGHT, steps:group.steps, cfg:group.cfg, sampler:group.sampler, scheduler:group.scheduler, loraStrength:LORA_STRENGTH, seeds:SEEDS };
  manifest.scenes = scenes;
  manifest.candidates = candidates;

  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ outputRoot:outputRoot, paramGroup:group.label, scenes:scenes.map(function (s) { return s.id; }), candidates:candidates }, null, 2));
    return;
  }

  fs.mkdirSync(outputRoot, { recursive:true });
  let total = 0;
  let concurrency = concurrencyFromArgs();

  // 先收集所有待生成任务（跳过已成功且图片在盘上的记录），
  // 再用并发窗口提交：ComfyUI 入队即返回，GPU 队列自行串行执行，
  // 避免"提交→等完成→下载→再提交"的串行往返浪费。
  let pending: any[] = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    let candidate = candidates[candidateIndex];
    for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex += 1) {
      let scene = scenes[sceneIndex];
      for (let seedIndex = 0; seedIndex < SEEDS.length; seedIndex += 1) {
        let seed = SEEDS[seedIndex];
        let existing = manifest.records.find(function (item: { candidate: string; sceneId: string; seed: number; status: string; }) {
          return item.candidate === candidate.id && item.sceneId === scene.id && item.seed === seed && item.status === 'succeeded';
        });
        if (existing && fs.existsSync(path.join(outputRoot, existing.image))) continue;
        pending.push({ candidate:candidate, scene:scene, seed:seed });
      }
    }
  }
  console.log('待生成: ' + pending.length + ' 张，并发窗口: ' + concurrency);

  let next = 0;
  async function runOne() {
    while (true) {
      let index = next;
      next += 1;
      if (index >= pending.length) return;
      let job: any = pending[index];
      let candidate = job.candidate;
      let scene = job.scene;
      let seed = job.seed;
      let workflow = workflowFor(scene, candidate, seed, group, modelId);
      let startedAt = new Date().toISOString();
      let submitted = await requestJson('/prompt', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({ prompt:workflow, client_id:CLIENT_ID }),
      });
      assert(submitted && submitted.prompt_id, 'ComfyUI did not return prompt_id');
      let image = await waitFor(submitted.prompt_id);
      let body = await requestImage(image);
      let relative = path.join('images', scene.id, 'seed-' + seed + '-' + candidate.id + '.png');
      let outputFile = path.join(outputRoot, relative);
      fs.mkdirSync(path.dirname(outputFile), { recursive:true });
      fs.writeFileSync(outputFile, body);

      manifest.records = manifest.records.filter(function (item: any) {
        return !(item.candidate === candidate.id && item.sceneId === scene.id && item.seed === seed);
      });
      manifest.records.push({
        candidate:candidate.id,
        epoch:candidate.epoch,
        step:candidate.step,
        loraFile:candidate.file,
        loraSha256:candidate.sha256,
        sceneId:scene.id,
        sceneTitle:scene.title,
        mature:scene.mature,
        seed:seed,
        image:relative.replace(/\\/g, '/'),
        bytes:body.length,
        sha256:sha256(body),
        promptId:submitted.prompt_id,
        startedAt:startedAt,
        finishedAt:new Date().toISOString(),
        status:'succeeded',
      });
      manifest.records.sort(function (a: { sceneId: string; seed: number; epoch: number; }, b: { sceneId: string; seed: number; epoch: number; }) {
        return a.sceneId.localeCompare(b.sceneId) || a.seed - b.seed || a.epoch - b.epoch;
      });
      writeJson(manifestFile, manifest);
      total += 1;
      console.log(group.label + ' ' + candidate.id + ' ' + scene.id + ' ' + seed + ': ' + outputFile);
    }
  }

  let workers = [];
  for (let w = 0; w < Math.min(concurrency, pending.length || 1); w += 1) {
    workers.push(runOne());
  }
  await Promise.all(workers);

  manifest.finishedAt = new Date().toISOString();
  writeJson(manifestFile, manifest);
  console.log('Unified sweep done (' + total + ' new). Manifest: ' + manifestFile);
}

main().catch(function (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
