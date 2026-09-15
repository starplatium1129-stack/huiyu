'use strict';

/*
 * Real-GPU Anima prompt A/B.
 * Run only against a gateway connected to the local ComfyUI instance.
 */
var fs: typeof import('fs') = require('fs');
var path: typeof import('path') = require('path');
var policy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
var profiles = (require('../../data/presets.json') as typeof import('../../data/presets.json')).model_profiles;

var gateway = process.env.AICS_GPU_GATEWAY_URL || 'http://127.0.0.1:3000';
var outputRoot = process.env.AICS_ANIMA_AB_DIR || path.join(
  process.cwd(), '..', 'AI', 'Reviews', 'AnimaPromptAB', '2026-08-09_v20_exact_tokens'
);
var seed = Number(process.env.AICS_ANIMA_AB_SEED || 20260809);
var profile = profiles.find(function (item) { return item.id === 'anima_base_v10'; });
if (!profile) throw new Error('anima_base_v10 profile is missing');

var common = [
  'ayachi_nene', '1girl', 'solo', 'nene_witch_canonical', 'witch_hat', 'black_cape',
  'criss-cross_halter', 'crop_top', 'white_hair', 'very_long_hair', 'low_twintails',
  'purple_eyes', 'pink_hair_ribbons', 'ahoge', 'nene_r18', 'cafe', 'warm_lighting', 'masterpiece',
  'best_quality', 'score_7'
];
var underscorePrompt = common.join(', ');
var profilePrompt = policy.formatPromptForProfile(underscorePrompt, profile, 'anima');
var warmSpacePrompt = underscorePrompt.replace('warm_lighting', 'warm lighting');
var qualitySpacePrompt = underscorePrompt.replace('best_quality', 'best quality');
var negative = [
  'worst quality', 'low quality', 'score_1', 'score_2', 'score_3', 'artist name',
  'blurry', 'jpeg artifacts', 'chromatic aberration'
].join(', ');

function assertOk(condition: boolean, message: string|undefined) {
  if (!condition) throw new Error(message);
}

async function jsonRequest(url: string|URL|Request, options: RequestInit|undefined) {
  var response = await fetch(url, options);
  var data = null;
  try { data = await response.json(); } catch (error) {}
  return { response:response, data:data };
}

async function submit(prompt: string) {
  var result = await jsonRequest(gateway + '/api/anima/jobs', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({
      prompt:prompt,
      negative:negative,
      modelId:'anima-base-v1.0',
      loraId:'L_NENE_V20_ANIMA',
      loraStrength:0.85,
      width:832,
      height:1216,
      steps:24,
      cfg:3,
      seed:seed,
      character:'nene'
    })
  });
  assertOk(result.response.status === 202 && result.data && result.data.ok, 'Anima submission failed: ' + JSON.stringify(result.data));
  return result.data.job;
}

async function waitFor(jobId: string|number|boolean) {
  var deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    var result = await jsonRequest(gateway + '/api/anima/jobs/' + encodeURIComponent(jobId), { cache:'no-store' });
    assertOk(result.response.ok && result.data && result.data.ok, 'Anima status failed: ' + JSON.stringify(result.data));
    var job = result.data.job;
    if (job.status === 'failed' || job.status === 'cancelled') throw new Error('Anima job failed: ' + JSON.stringify(job));
    if (job.status === 'succeeded' && job.resultAvailable && job.resultUrl) return job;
    await new Promise(function (resolve) { setTimeout(resolve, 1000); });
  }
  throw new Error('Anima job timed out: ' + jobId);
}

async function consume(job: { resultUrl: string; }) {
  var response = await fetch(gateway + job.resultUrl, { cache:'no-store' });
  assertOk(response.ok, 'Anima result fetch failed: ' + response.status);
  var mime = String(response.headers.get('content-type') || '');
  assertOk(mime.startsWith('image/'), 'Anima result MIME is not an image: ' + mime);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  fs.mkdirSync(outputRoot, { recursive:true });
  var startedAt = new Date().toISOString();
  var jobs = [
    { id:'underscore', prompt:underscorePrompt },
    { id:'profile', prompt:profilePrompt },
    { id:'warm-space', prompt:warmSpacePrompt },
    { id:'quality-space', prompt:qualitySpacePrompt }
  ];
  var manifest: any = {
    startedAt:startedAt,
    gateway:gateway,
    modelId:'anima-base-v1.0',
    loraId:'L_NENE_V20_ANIMA',
    profileId:'anima_base_v10',
    seed:seed,
    width:832,
    height:1216,
    steps:24,
    cfg:3,
    negative:negative,
    variants:[]
  };
  for (var i = 0; i < jobs.length; i += 1) {
    var item = jobs[i];
    var job = await submit(item.prompt);
    var finished = await waitFor(job.id);
    var body = await consume(finished);
    var file = path.join(outputRoot, item.id + '.png');
    fs.writeFileSync(file, body);
    manifest.variants.push({
      id:item.id,
      prompt:item.prompt,
      jobId:job.id,
      metadata:finished.metadata,
      file:file,
      bytes:body.length
    });
    console.log(item.id + ': ' + file + ' (' + body.length + ' bytes)');
  }
  manifest.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('A/B manifest: ' + path.join(outputRoot, 'manifest.json'));
}

main().catch(function (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
