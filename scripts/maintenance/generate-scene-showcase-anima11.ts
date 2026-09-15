#!/usr/bin/env node
'use strict';

/**
 * Generate a fresh candidate for EVERY current scene with the unified contract:
 *
 *   - prompt : the scene's ORIGINAL prompt (data/scenes.json `prompt`), with
 *              <lora:...> tags stripped, formatted for Anima (exact tokens
 *              preserved, everything else space-separated), then the artist tag
 *              `@rella` appended at the end (Anima artist syntax).
 *   - model  : anima-aesthetic-v1.1 (Anima Aesthetic v1.1) — uniform base.
 *   - lora   : single-character scenes load the production v21 Anima LoRA at
 *              the strength written in the scene prompt tag (fallback 0.85);
 *              dual (triad) scenes run in the route's no-LoRA mode with both
 *              identities anchored by prompt tokens.
 *   - negative: project `assembleNegative(anima)` + Anima panel suppression +
 *              single-person suppression for solo scenes (operational fixes).
 *
 * Output goes to AI/Reviews/SceneShowcaseRefresh/<round>/ and is never written
 * into the public SceneShowcase dir (mirrors generate-scene-showcase-candidates.js).
 */

const crypto: typeof import('crypto') = require('crypto');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const promptPolicy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
const sceneInference: typeof import('../../src/utils/sceneInference.ts') = require('../../src/utils/sceneInference.ts');
const animaConstants = (require('../../routes/anima.js') as typeof import('../../routes/anima.js')).constants;
const animaGenerationContract: typeof import('../../server/anima-generation-contract.js') = require('../../server/anima-generation-contract.js');

const scenes: typeof import('../../data/scenes.json') = require('../../data/scenes.json');
const presets: typeof import('../../data/presets.json') = require('../../data/presets.json');
const loraData: typeof import('../../data/loras.json') = require('../../data/loras.json');

const ROOT = path.resolve(__dirname, '..', '..');
const AI_ROOT = path.resolve(ROOT, '..', 'AI');
const SHOWCASE_ROOT = path.resolve(AI_ROOT, 'SceneShowcase');
const DEFAULT_OUTPUT = path.join(AI_ROOT, 'Reviews', 'SceneShowcaseRefresh', '2026-08-14_v16-anima11-rella');
const MANIFEST_NAME = 'generation-manifest.json';
const ANIMA_MODEL_ID = 'anima-aesthetic-v1.1';
const ANIMA_PROFILE_ID = 'anima_aesthetic_v11';
const ARTIST_TAG = '@rella';
const ANIMA_LORA_BY_CHARACTER: any = Object.freeze({
  nene: 'L_NENE_V21_ANIMA',
  natsume: 'L_NAT_V21_ANIMA',
});
const ANIMA_PANEL_SUPPRESS = 'split image, split screen, split panel, two panels, diptych, triptych, comic strip, multiple frames, panel borders, frame borders, double exposure, double image, duplicated subject, duplicated body';
const ANIMA_EXTRA_PERSON_SUPPRESS = 'multiple girls, extra girl, second person, additional woman, another woman, extra person, background person';

function argument(name: any, fallback: any = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function splitList(value: any) {
  return String(value || '').split(',').map((item: any) => item.trim()).filter(Boolean);
}
function readJson(file: any) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJsonAtomic(file: any, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}
function stableSeed(sceneId: any, attempt: any) {
  const digest = crypto.createHash('sha256').update(`scene-anima11-rella-v16:${sceneId}:${attempt}`).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}
function assertIsolated(output: any) {
  const resolved = path.resolve(output);
  if (resolved === SHOWCASE_ROOT || resolved.startsWith(SHOWCASE_ROOT + path.sep)) {
    throw new Error(`refusing to write candidates into public showcase: ${resolved}`);
  }
  return resolved;
}
function profileById(id: any) {
  const profile = (presets.model_profiles || []).find((item: any) => item.id === id);
  if (!profile) throw new Error(`presets.json missing profile ${id}`);
  return profile;
}
function loraById(id: any) {
  const lora = loraData.find((item: any) => item.id === id);
  if (!lora) throw new Error(`loras.json missing ${id}`);
  return lora;
}
function nearestAnimaSize(scene: any, modelId: any = ANIMA_MODEL_ID) {
  const desired = sceneInference.sceneRecommendedSize(scene);
  const sizes = animaConstants.MODELS[modelId].sizes;
  if (sizes.includes(desired)) return desired;
  const [desiredWidth, desiredHeight] = desired.split('x').map(Number);
  const ratio = desiredWidth / desiredHeight;
  return [...sizes].sort((left: any, right: any) => {
    const [lw, lh] = left.split('x').map(Number);
    const [rw, rh] = right.split('x').map(Number);
    return Math.abs(lw / lh - ratio) - Math.abs(rw / rh - ratio);
  })[0];
}
function animaProfileFor(loraIds: any, modelId: any = ANIMA_MODEL_ID) {
  const base = modelId === ANIMA_MODEL_ID ? profileById(ANIMA_PROFILE_ID)
    : (presets.model_profiles || []).find((profile: any) => profile.model_id === modelId && profile.engine === 'anima');
  if (!base || !animaConstants.MODELS[modelId]) throw new Error(`unsupported Anima model: ${modelId}`);
  const contract = (loraIds || []).map((id: any) => (loraById(id).prompt_contract || {}));
  return Object.assign({}, base, {
    exact_tokens: [...new Set([...(base.exact_tokens || []), ...contract.flatMap((c: any) => c.exact_tokens || [])])],
    exact_prefixes: [...new Set([...(base.exact_prefixes || []), ...contract.flatMap((c: any) => c.exact_prefixes || [])])],
  });
}
function originalPrompt(scene: any) {
  return String(scene.prompt || '').replace(/<lora:[^>]+>/gi, '').trim();
}
function sceneLoraStrength(scene: any, loraId: any) {
  const refs = promptPolicy.parseScenePromptLoras(scene);
  const weight = refs.length ? refs[0].weight : null;
  if (weight !== null && Number.isFinite(weight)) return weight;
  return Number(loraById(loraId).strength?.default) || 0.85;
}
function buildAnimaCandidate(scene: any, attempt: any, seedAttempt: any = attempt, overrides: any = {}) {
  const characterId = scene.char;
  const isTriad = characterId === 'triad';
  const loraIds = isTriad ? ['L_NENE_V21_ANIMA', 'L_NAT_V21_ANIMA'] : [ANIMA_LORA_BY_CHARACTER[characterId]];
  if (!isTriad && !loraIds[0]) throw new Error(`scene ${scene.id} has unsupported Anima character ${characterId}`);
  const modelId = overrides.modelId || ANIMA_MODEL_ID;
  const profile: any = animaProfileFor(loraIds, modelId);
  const shot = sceneInference.sceneShot(scene);
  let prompt = promptPolicy.formatPromptForEngine(originalPrompt(scene), 'anima', profile.exact_tokens, profile.exact_prefixes);
  // 单人场景强化（如 "extra person" 类失败时注入）：保持原有提示词内容，
  // 在画师 tag 之前追加显式单人 token（Anima 官方权重语法兼容）。
  const append = String(overrides.promptAppend || '').trim();
  if (append) prompt = prompt ? `${prompt}, ${append}` : append;
  prompt = prompt ? `${prompt}, ${ARTIST_TAG}` : ARTIST_TAG;
  const loraId = isTriad ? '' : loraIds[0];
  const loraStrength = isTriad ? null : sceneLoraStrength(scene, loraId);
  let negative = promptPolicy.assembleNegative(profile, scene, 'anima', {
    shot,
    character: characterId,
  });
  const negativeAppend = String(overrides.negativeAppend || '').trim();
  if (negativeAppend) negative = negative ? `${negative}, ${negativeAppend}` : negativeAppend;
  negative = negative ? `${negative}, ${ANIMA_PANEL_SUPPRESS}` : ANIMA_PANEL_SUPPRESS;
  if (!isTriad) negative = `${negative}, ${ANIMA_EXTRA_PERSON_SUPPRESS}`;
  const [width, height] = nearestAnimaSize(scene, modelId).split('x').map(Number);
  const steps = Number(overrides.steps) || animaGenerationContract.ANIMA_DEFAULTS.steps;
  const cfg = Number(overrides.cfg) || animaGenerationContract.ANIMA_DEFAULTS.cfg;
  const hiresFix = Boolean(overrides.hires);
  const hiresScale = Number(overrides.hiresScale) > 0 ? Number(overrides.hiresScale) : 1.5;
  const hiresDenoise = Number(overrides.hiresDenoise) > 0 ? Number(overrides.hiresDenoise) : 0.4;
  return {
    batch: 'scene', key: `scene:${scene.id}`, recordId: `scene:${scene.id}@attempt-${attempt}`,
    sceneId: scene.id, title: scene.title, category: scene.category, story: scene.story,
    characterId, rating: scene.rating, attempt,
    engine: 'anima', profileId: profile.id, modelId,
    checkpoint: animaConstants.MODELS[modelId].file,
    loraId: loraId || null, loraFile: loraId ? animaConstants.LORAS[loraId].file : null, loraStrength,
    artistTag: ARTIST_TAG,
    width, height,
    steps,
    cfg,
    sampler: animaGenerationContract.ANIMA_DEFAULTS.sampler,
    scheduler: animaGenerationContract.ANIMA_DEFAULTS.scheduler,
    hiresFix, hiresScale, hiresDenoise,
    seed: stableSeed(scene.id, seedAttempt), prompt, negative,
    seedAttempt,
    animaCaption: typeof scene.animaCaption === 'string' ? scene.animaCaption.trim() : '',
    sourcePrompt: scene.prompt || '', sourceNegative: scene.negative || '',
    inferred: { shot },
  };
}
function planScenes(selectedScenes: any, attempt: any, seedAttempt: any = attempt, overrides: any = {}) {
  return selectedScenes.map((scene: any) => buildAnimaCandidate(scene, attempt, seedAttempt, overrides));
}

async function gatewayJson(base: any, pathname: any, options: any) {
  let response;
  try {
    response = await fetch(base.replace(/\/$/, '') + pathname, Object.assign({ cache: 'no-store' }, options || {}));
  } catch (error) {
    return { response: null, data: null, error: error instanceof Error ? error.message : String(error) };
  }
  let data = null;
  try { data = await response.json(); } catch (error) { /* keep null */ }
  return { response, data };
}
function buildSubmissionBody(candidate: any) {
  const body: any = {
    prompt: candidate.prompt, negative: candidate.negative,
    modelId: candidate.modelId, width: candidate.width, height: candidate.height,
    steps: candidate.steps, cfg: candidate.cfg, seed: candidate.seed,
  };
  if (candidate.loraId) {
    body.loraId = candidate.loraId;
    body.loraStrength = candidate.loraStrength;
    body.character = candidate.characterId;
  }
  if (candidate.hiresFix) {
    body.hiresFix = true;
    body.hiresScale = candidate.hiresScale;
    body.hiresDenoise = candidate.hiresDenoise;
  }
  return body;
}
async function submitCandidate(base: any, candidate: any) {
  const route = '/api/anima/jobs';
  const submitted = await gatewayJson(base, route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildSubmissionBody(candidate)),
  });
  if (!submitted.response || submitted.response.status !== 202 || submitted.data?.ok !== true || !submitted.data.job?.id) {
    const status = submitted.response ? submitted.response.status : 'network';
    return { ok: false, error: `submission failed (${status}): ${submitted.error || JSON.stringify(submitted.data)}` };
  }
  let job = submitted.data.job;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const state = await gatewayJson(base, `${route}/${encodeURIComponent(job.id)}`, undefined);
    if (state.response?.ok && state.data?.ok && state.data.job) job = state.data.job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      return { ok: false, error: `job failed: ${job.error || job.status} (${job.code || ''})`, jobId: job.id };
    }
    if (job.status === 'succeeded' && job.resultUrl) break;
    await new Promise<any>((resolve: any) => setTimeout(resolve, 2000));
  }
  if (job.status !== 'succeeded' || !job.resultUrl) return { ok: false, error: `job timed out: ${job.status}`, jobId: job.id };
  const result = await fetch(base.replace(/\/$/, '') + job.resultUrl, { cache: 'no-store' });
  if (!result.ok) return { ok: false, error: `result fetch failed (HTTP ${result.status})`, jobId: job.id };
  return {
    ok: true,
    buffer: Buffer.from(await result.arrayBuffer()),
    jobId: job.id,
    provider: job.provider || '',
    actualSeed: job.metadata?.seed ?? job.seed ?? candidate.seed,
    metadata: job.metadata || {},
    mime: result.headers.get('content-type') || 'image/png',
  };
}

async function main() {
  const ids = splitList(argument('--ids'));
  const attempt = Math.max(1, Number(argument('--attempt', '1')) || 1);
  const seedAttempt = Math.max(1, Number(argument('--seed-attempt', String(attempt))) || attempt);
  const output = assertIsolated(path.resolve(argument('--output', DEFAULT_OUTPUT)));
  const gateway = argument('--gateway', 'http://127.0.0.1:3000');
  const limit = Math.max(1, Number(argument('--limit', '9999')) || 9999);
  const concurrency = Math.max(1, Math.min(4, Number(argument('--concurrency', '3')) || 3));
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  const overrides: Record<string, any> = {};
  const stepsArg = Number(argument('--steps', ''));
  const cfgArg = Number(argument('--cfg', ''));
  const promptAppend = argument('--prompt-append', '');
  const negativeAppend = argument('--negative-append', '');
  if (stepsArg > 0) overrides.steps = stepsArg;
  if (cfgArg > 0) overrides.cfg = cfgArg;
  overrides.modelId = argument('--model', ANIMA_MODEL_ID);
  if (promptAppend) overrides.promptAppend = promptAppend;
  if (negativeAppend) overrides.negativeAppend = negativeAppend;
  if (process.argv.includes('--hires')) overrides.hires = true;
  const hiresScaleArg = Number(argument('--hires-scale', ''));
  const hiresDenoiseArg = Number(argument('--hires-denoise', ''));
  if (hiresScaleArg > 0) overrides.hiresScale = hiresScaleArg;
  if (hiresDenoiseArg > 0) overrides.hiresDenoise = hiresDenoiseArg;
  const selectedScenes = ids.length ? ids.map((id: any) => scenes.find((scene: any) => scene.id === id)) : scenes;
  const missing = ids.filter((id: any, index: any) => !selectedScenes[index]);
  if (missing.length) throw new Error(`unknown scene ids: ${missing.join(', ')}`);
  const manifestPath = path.join(output, MANIFEST_NAME);
  const existing = fs.existsSync(manifestPath) ? readJson(manifestPath) : [];
  const records = new Map(existing.map((record: any) => [record.recordId, record]));
  const planned = planScenes(selectedScenes, attempt, seedAttempt, overrides);
  if (dryRun) {
    console.log(JSON.stringify({ output, gateway, count: planned.length, candidates: planned }, null, 2));
    return;
  }

  fs.mkdirSync(output, { recursive: true });
  const pending = planned.filter((candidate: any) => {
    const previous: any = records.get(candidate.recordId);
    const imageRel = `images/${candidate.sceneId}/attempt-${attempt}.png`;
    const imageFile = path.join(output, imageRel.split('/').join(path.sep));
    const matching = previous && ['modelId', 'checkpoint', 'profileId', 'prompt', 'negative', 'width', 'height', 'steps', 'cfg', 'seed', 'loraId', 'loraStrength'].every((key: any) => previous[key] === candidate[key]);
    if (!force && matching && previous?.status === 'succeeded' && fs.existsSync(imageFile) && fs.statSync(imageFile).size > 1000) {
      console.log(`[reuse] ${candidate.recordId}`);
      return false;
    }
    return true;
  });
  if (limit < pending.length) pending.length = limit;
  console.log(`[plan] ${planned.length} candidates, ${pending.length} to generate (concurrency ${concurrency})`);

  let generated = 0;
  let failed = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const candidate = pending[cursor];
      cursor += 1;
      const imageRel = `images/${candidate.sceneId}/attempt-${attempt}.png`;
      const imageFile = path.join(output, imageRel.split('/').join(path.sep));
      console.log(`[generate] ${candidate.recordId} ${candidate.modelId} ${candidate.width}x${candidate.height} seed ${candidate.seed}`);
      const result: any = await submitCandidate(gateway, candidate);
      if (!result.ok) {
        records.set(candidate.recordId, Object.assign({}, candidate, {
          status: 'failed', error: result.error, jobId: result.jobId || '', image: '', generatedAt: new Date().toISOString(),
        }));
        writeJsonAtomic(manifestPath, [...records.values()]);
        console.log(`[failed] ${candidate.recordId}: ${result.error}`);
        failed += 1;
        continue;
      }
      fs.mkdirSync(path.dirname(imageFile), { recursive: true });
      fs.writeFileSync(imageFile, result.buffer);
      records.set(candidate.recordId, Object.assign({}, candidate, {
        status: 'succeeded', error: '', image: imageRel, generatedAt: new Date().toISOString(),
        bytes: result.buffer.length, mime: result.mime, sha256: crypto.createHash('sha256').update(result.buffer).digest('hex'),
        jobId: result.jobId, provider: result.provider, actualSeed: result.actualSeed, metadata: result.metadata,
      }));
      writeJsonAtomic(manifestPath, [...records.values()]);
      console.log(`[ok] ${candidate.recordId} -> ${imageRel} (${result.buffer.length} bytes)`);
      generated += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));

  const normalized = [...records.values()].sort((left: any, right: any) => left.sceneId.localeCompare(right.sceneId) || left.attempt - right.attempt);
  writeJsonAtomic(manifestPath, normalized);
  console.log(JSON.stringify({ output, planned: planned.length, generated, failed }, null, 2));
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

export = {
  buildAnimaCandidate,
  planScenes,
  buildSubmissionBody,
  nearestAnimaSize,
  stableSeed,
  constants: { DEFAULT_OUTPUT, ANIMA_MODEL_ID, ANIMA_PROFILE_ID, ARTIST_TAG, ANIMA_LORA_BY_CHARACTER },
};
