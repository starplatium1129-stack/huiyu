#!/usr/bin/env node
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

/* Real local-GPU product matrix for the Natsume Anima v19 experiment. */
var crypto: typeof import('crypto') = require('crypto');
var fs: typeof import('fs') = require('fs');
var path: typeof import('path') = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var AI_ROOT = path.resolve(ROOT, '..', 'AI');
var COMFY = process.env.COMFY_HOST || 'http://127.0.0.1:8188';
var SD = process.env.SD_HOST || 'http://127.0.0.1:7860';
var OUTPUT_ROOT = process.env.AICS_NATSUME_V19_MATRIX_DIR || path.join(
  AI_ROOT, 'Reviews', 'AnimaNatsumeV19ProductMatrix', '2026-08-09'
);
var LORA_ROOT = path.join(AI_ROOT, 'ComfyUI', 'models', 'loras');
var TRAIN_SAVE = path.join(AI_ROOT, 'OneTrainer', 'workspace', 'shiki_natsume_v19_anima_scientific_a', 'save');
var V18_SOURCE = path.join(AI_ROOT, 'Data', 'Models', 'Lora', 'shiki_natsume_v18_wd14.safetensors');
var SEEDS = [20260809, 20260810, 20260811];
var WIDTH = 1216;
var HEIGHT = 832;
var SCENES = [
  { id:'identity_closeup', label:'身份近景', safe:true, prompt:'close-up portrait, face focus, looking at viewer, calm reserved expression, simple background, soft even lighting' },
  { id:'ordinary_fullbody', label:'普通全身', safe:true, prompt:'full body, standing, casual clothes, natural body proportions, bookstore interior, warm afternoon light' },
  { id:'cafe_uniform', label:'咖啡制服', safe:true, prompt:'natsume_cafe_uniform, full body, standing, white shirt, suspenders, brown skirt, cafe interior, warm closed-cafe light' },
  { id:'official_qipao', label:'官方旗袍', safe:true, prompt:'natsume_official_qipao, full body, standing, chinese clothes, red dress, floral print, double bun, red flower, side slit, black thighhighs, simple background' },
  { id:'complex_lowlight', label:'复杂低光', safe:true, prompt:'natsume_winter_coat, upper body, holding a small birthday cake with both hands, dark entryway, candlelight, night, low light, face and red hairclips in sharp focus' },
  { id:'r18_fullbody', label:'R18 全身', safe:false, prompt:'explicit, natsume_r18, nude, full body, standing, solo, natural body proportions, accurate anatomy, simple bedroom background, soft even lighting' },
];
var CANDIDATES = [
  { id:'base', epoch:0, step:0, file:null },
  { id:'e06', epoch:6, step:234 },
  { id:'e08', epoch:8, step:312 },
  { id:'e10', epoch:10, step:390 },
  { id:'e12', epoch:12, step:468 },
  { id:'e14', epoch:14, step:546 },
];
var CLIENT_ID = 'aics-natsume-v19-product-matrix-' + crypto.randomUUID();

function assert(condition: string|boolean|undefined, message: string|undefined) { if (!condition) throw new Error(message); }
function readJson(file: PathOrFileDescriptor) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file: PathOrFileDescriptor, value: unknown) { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function sha256(value: string|NodeJS.ArrayBufferView<ArrayBufferLike>|NonSharedBuffer) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sha256File(file: PathOrFileDescriptor) { return sha256(fs.readFileSync(file)); }
function localUrl(base: string|URL, pathname: string|URL) {
  var url = new URL(base);
  assert(url.protocol === 'http:' || url.protocol === 'https:', 'upstream protocol invalid');
  assert(['127.0.0.1', 'localhost', '::1'].includes(url.hostname), 'matrix only permits local upstreams');
  return new URL(pathname, url).toString();
}
async function jsonRequest(base: string, pathname: string, options: RequestInit|undefined) {
  var response = await fetch(localUrl(base, pathname), options);
  var text = await response.text();
  var data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(pathname + ' returned HTTP ' + response.status + ': ' + text.slice(0, 500));
  return data;
}
function copyCandidate(candidate: { epoch: string; step: string; id: string; source: PathLike; file: string; sha256: string; }) {
  if (!candidate.epoch) return candidate;
  var match = fs.readdirSync(path.join(TRAIN_SAVE)).find(function (name) {
    return name.endsWith('.safetensors') && name.includes('-' + candidate.step + '-' + candidate.epoch + '-0');
  });
  assert(match, 'checkpoint not found for ' + candidate.id);
  candidate.source = path.join(TRAIN_SAVE, match);
  candidate.file = 'shiki_natsume_v19_anima_' + candidate.id + '.safetensors';
  candidate.sha256 = sha256File(candidate.source);
  var target = path.join(LORA_ROOT, candidate.file);
  if (!fs.existsSync(target) || sha256File(target) !== candidate.sha256) fs.copyFileSync(candidate.source, target);
  return candidate;
}
function prepareCandidates() {
  assert(fs.existsSync(V18_SOURCE), 'production v18 Natsume LoRA is missing');
  return CANDIDATES.map(copyCandidate);
}
function promptFor(scene: any, engine: string) {
  var identity = engine === 'anima'
    ? 'shiki_natsume, very long black hair, golden yellow eyes, two red hairclips, mole under eye'
    : 'shiki_natsume, very_long_black_hair, golden_yellow_eyes, two_red_hairclips, mole_under_eye';
  var safety = scene.safe ? 'safe' : 'explicit, natsume_r18';
  return [engine === 'anima' ? 'masterpiece, best quality, score_7' : 'masterpiece, best quality, amazing quality', safety, '1girl, solo', identity, scene.prompt].join(', ');
}
function negativeFor(scene: any, engine: string) {
  var common = engine === 'anima'
    ? 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration'
    : 'worst quality, low quality, bad anatomy, bad hands, extra fingers, extra limbs, duplicate, text, watermark, logo';
  return scene.safe ? common + ', nsfw, nude, explicit, underwear, extra person' : common + ', extra person, duplicate';
}
function sdPrompt(scene: { id: string; label: string; safe: boolean; prompt: string; }) { return promptFor(scene, 'sd') + ', <lora:shiki_natsume_v18_wd14:0.85>'; }
function imagePath(candidate: any, scene: any, seed: string|number, engine: string) { return path.join('images', candidate.id, scene.id, 'seed-' + seed + '-' + engine + '.png').replace(/\\/g, '/'); }
async function generateSd(scene: { id: string; label: string; safe: boolean; prompt: string; }, seed: number) {
  var data = await jsonRequest(SD, '/sdapi/v1/txt2img', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({
    prompt:sdPrompt(scene), negative_prompt:negativeFor(scene, 'sd'), width:WIDTH, height:HEIGHT, steps:30, cfg_scale:6, sampler_name:'Euler a', seed:seed, batch_size:1, n_iter:1, restore_faces:false, enable_hr:false,
  }) });
  assert(data && data.images && data.images[0], 'SD returned no image');
  var encoded = String(data.images[0]).replace(/^data:image\/[^;]+;base64,/i, '');
  assert(/^[A-Za-z0-9+/=]+$/.test(encoded), 'SD returned invalid image data');
  return { body:Buffer.from(encoded, 'base64'), metadata:{ checkpoint:'waiIllustriousSDXL_v170', lora:'L_NAT_V18_WD14', prompt:sdPrompt(scene), negative:negativeFor(scene, 'sd'), seed:seed } };
}
function workflow(candidate: any, scene: { id: string; }, seed: string) {
  var nodes = {
    '1':{ class_type:'UNETLoader', inputs:{ unet_name:'anima-base-v1.0.safetensors', weight_dtype:'default' } },
    '2':{ class_type:'CLIPLoader', inputs:{ clip_name:'qwen_3_06b_base.safetensors', type:'qwen_image' } },
    '3':{ class_type:'VAELoader', inputs:{ vae_name:'qwen_image_vae.safetensors' } },
    '5':{ class_type:'CLIPTextEncode', inputs:{ clip:candidate.epoch ? ['4', 1] : ['2', 0], text:promptFor(scene, 'anima') } },
    '6':{ class_type:'CLIPTextEncode', inputs:{ clip:candidate.epoch ? ['4', 1] : ['2', 0], text:negativeFor(scene, 'anima') } },
    '7':{ class_type:'EmptyLatentImage', inputs:{ width:WIDTH, height:HEIGHT, batch_size:1 } },
    '8':{ class_type:'KSampler', inputs:{ model:candidate.epoch ? ['4', 0] : ['1', 0], positive:['5', 0], negative:['6', 0], latent_image:['7', 0], seed:seed, steps:24, cfg:3, sampler_name:'res_multistep', scheduler:'simple', denoise:1 } },
    '9':{ class_type:'VAEDecode', inputs:{ samples:['8', 0], vae:['3', 0] } },
    '10':{ class_type:'SaveImage', inputs:{ images:['9', 0], filename_prefix:'natsume_v19_product_matrix/' + candidate.id + '/' + scene.id + '/seed-' + seed } },
  };
  if (candidate.epoch) nodes['4'] = { class_type:'LoraLoader', inputs:{ model:['1', 0], clip:['2', 0], lora_name:candidate.file, strength_model:0.85, strength_clip:0.85 } };
  return nodes;
}
async function waitFor(promptId: string|number|boolean) {
  var deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    var history = await jsonRequest(COMFY, '/history/' + encodeURIComponent(promptId), { cache:'no-store' });
    var entry = history && history[promptId];
    if (entry) {
      var failed = (entry.status && entry.status.messages || []).find(function (message: string[]) { return message && message[0] === 'execution_error'; });
      if (failed) throw new Error('ComfyUI execution failed: ' + JSON.stringify(failed));
      var image = entry.outputs && entry.outputs['10'] && entry.outputs['10'].images && entry.outputs['10'].images[0];
      if (image) return image;
    }
    await new Promise(function (resolve) { setTimeout(resolve, 1000); });
  }
  throw new Error('ComfyUI prompt timed out: ' + promptId);
}
async function generateAnima(candidate: any, scene: { id: string; label: string; safe: boolean; prompt: string; }, seed: number) {
  var submitted = await jsonRequest(COMFY, '/prompt', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ prompt:workflow(candidate, scene, seed), client_id:CLIENT_ID }) });
  assert(submitted && submitted.prompt_id, 'ComfyUI returned no prompt id');
  var image = await waitFor(submitted.prompt_id);
  var query = new URLSearchParams({ filename:image.filename, subfolder:image.subfolder || '', type:image.type || 'output' });
  var response = await fetch(localUrl(COMFY, '/view?' + query.toString()));
  assert(response.ok && String(response.headers.get('content-type') || '').startsWith('image/'), 'ComfyUI returned non-image result');
  return { body:Buffer.from(await response.arrayBuffer()), metadata:{ model:'anima-base-v1.0', lora:candidate.epoch ? candidate.file : null, loraId:candidate.epoch ? 'L_NAT_V19_ANIMA_CANDIDATE' : null, prompt:promptFor(scene, 'anima'), negative:negativeFor(scene, 'anima'), seed:seed, promptId:submitted.prompt_id } };
}
async function main() {
  var candidates = prepareCandidates();
  var manifestFile = path.join(OUTPUT_ROOT, 'manifest.json');
  var manifest = fs.existsSync(manifestFile) ? readJson(manifestFile) : { version:1, purpose:'Natsume Anima v19 product matrix: WAI v18 production versus Anima base-only and scientific checkpoints', scenes:SCENES, seeds:SEEDS, candidates:candidates, records:[] };
  manifest.candidates = candidates;
  fs.mkdirSync(OUTPUT_ROOT, { recursive:true });
  if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ outputRoot:OUTPUT_ROOT, scenes:SCENES, seeds:SEEDS, candidates:candidates }, null, 2)); return; }
  for (var scene of SCENES) for (var seed of SEEDS) {
    var key = function (candidateId: string, engine: string) { return candidateId + ':' + scene.id + ':' + seed + ':' + engine; };
    var baselineFile = path.join(OUTPUT_ROOT, imagePath({ id:'wai_v18' }, scene, seed, 'wai_v18'));
    var sdRecord = manifest.records.find(function (item: { key: string; }) { return item.key === key('wai_v18', 'sd'); });
    if (!sdRecord || !fs.existsSync(baselineFile)) {
      var sd = await generateSd(scene, seed); fs.mkdirSync(path.dirname(baselineFile), { recursive:true }); fs.writeFileSync(baselineFile, sd.body);
      sdRecord = { key:key('wai_v18', 'sd'), candidate:'wai_v18', engine:'sd', sceneId:scene.id, seed:seed, image:path.relative(OUTPUT_ROOT, baselineFile).replace(/\\/g, '/'), bytes:sd.body.length, sha256:sha256(sd.body), metadata:sd.metadata, status:'succeeded' };
    }
    manifest.records = manifest.records.filter(function (item: any) { return item.key !== sdRecord.key; }).concat(sdRecord);
    writeJson(manifestFile, manifest);
  }
  for (var candidate of candidates) for (var scene2 of SCENES) for (var seed2 of SEEDS) {
    var animaKey = candidate.id + ':' + scene2.id + ':' + seed2 + ':anima';
    var animaRelative = imagePath(candidate, scene2, seed2, 'anima'); var animaFile = path.join(OUTPUT_ROOT, animaRelative);
    if (manifest.records.some(function (item: { key: string; status: string; image: string; }) { return item.key === animaKey && item.status === 'succeeded' && fs.existsSync(path.join(OUTPUT_ROOT, item.image)); })) continue;
    var anima = await generateAnima(candidate, scene2, seed2); fs.mkdirSync(path.dirname(animaFile), { recursive:true }); fs.writeFileSync(animaFile, anima.body);
    manifest.records = manifest.records.filter(function (item: { key: string; }) { return item.key !== animaKey; }).concat({ key:animaKey, candidate:candidate.id, epoch:candidate.epoch, engine:'anima', sceneId:scene2.id, seed:seed2, image:animaRelative, bytes:anima.body.length, sha256:sha256(anima.body), metadata:anima.metadata, status:'succeeded' });
    writeJson(manifestFile, manifest); console.log(candidate.id + ' ' + scene2.id + ' ' + seed2);
  }
  manifest.finishedAt = new Date().toISOString(); writeJson(manifestFile, manifest); console.log(manifestFile);
}
main().catch(function (error) { console.error(error && error.stack || error); process.exitCode = 1; });
