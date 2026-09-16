'use strict';

/*
 * Real-GPU Anima prompt A/B.
 * Run only against a gateway connected to the local ComfyUI instance.
 */
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let policy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
let profiles: any[] = (require('../../data/presets.json') as typeof import('../../data/presets.json')).model_profiles;

let gateway = process.env.AICS_GPU_GATEWAY_URL || 'http://127.0.0.1:3000';
let outputRoot = process.env.AICS_ANIMA_AB_DIR || path.join(
  process.cwd(), '..', 'AI', 'Reviews', 'AnimaPromptAB', '2026-08-09_v20_exact_tokens'
);
let seed = Number(process.env.AICS_ANIMA_AB_SEED || 20260809);
let profile = profiles.find(function (item) { return item.id === 'anima_base_v10'; });
if (!profile) throw new Error('anima_base_v10 profile is missing');

let common = [
  'ayachi_nene', '1girl', 'solo', 'nene_witch_canonical', 'witch_hat', 'black_cape',
  'criss-cross_halter', 'crop_top', 'white_hair', 'very_long_hair', 'low_twintails',
  'purple_eyes', 'pink_hair_ribbons', 'ahoge', 'nene_r18', 'cafe', 'warm_lighting', 'masterpiece',
  'best_quality', 'score_7'
];
let underscorePrompt = common.join(', ');
let profilePrompt = policy.formatPromptForProfile(underscorePrompt, profile, 'anima');
let warmSpacePrompt = underscorePrompt.replace('warm_lighting', 'warm lighting');
let qualitySpacePrompt = underscorePrompt.replace('best_quality', 'best quality');
let negative = [
  'worst quality', 'low quality', 'score_1', 'score_2', 'score_3', 'artist name',
  'blurry', 'jpeg artifacts', 'chromatic aberration'
].join(', ');

function assertOk(condition: boolean, message: string|undefined) {
  if (!condition) throw new Error(message);
}

async function jsonRequest(url: string|URL|Request, options: RequestInit|undefined) {
  let response = await fetch(url, options);
  let data = null;
  try { data = await response.json(); } catch (error) {}
  return { response:response, data:data };
}

async function submit(prompt: string) {
  let result = await jsonRequest(gateway + '/api/anima/jobs', {
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
  let deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    let result = await jsonRequest(gateway + '/api/anima/jobs/' + encodeURIComponent(jobId), { cache:'no-store' });
    assertOk(result.response.ok && result.data && result.data.ok, 'Anima status failed: ' + JSON.stringify(result.data));
    let job = result.data.job;
    if (job.status === 'failed' || job.status === 'cancelled') throw new Error('Anima job failed: ' + JSON.stringify(job));
    if (job.status === 'succeeded' && job.resultAvailable && job.resultUrl) return job;
    await new Promise(function (resolve) { setTimeout(resolve, 1000); });
  }
  throw new Error('Anima job timed out: ' + jobId);
}

async function consume(job: { resultUrl: string; }) {
  let response = await fetch(gateway + job.resultUrl, { cache:'no-store' });
  assertOk(response.ok, 'Anima result fetch failed: ' + response.status);
  let mime = String(response.headers.get('content-type') || '');
  assertOk(mime.startsWith('image/'), 'Anima result MIME is not an image: ' + mime);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  fs.mkdirSync(outputRoot, { recursive:true });
  let startedAt = new Date().toISOString();
  let jobs = [
    { id:'underscore', prompt:underscorePrompt },
    { id:'profile', prompt:profilePrompt },
    { id:'warm-space', prompt:warmSpacePrompt },
    { id:'quality-space', prompt:qualitySpacePrompt }
  ];
  let manifest: any = {
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
  for (let i = 0; i < jobs.length; i += 1) {
    let item = jobs[i];
    let job = await submit(item.prompt);
    let finished = await waitFor(job.id);
    let body = await consume(finished);
    let file = path.join(outputRoot, item.id + '.png');
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
