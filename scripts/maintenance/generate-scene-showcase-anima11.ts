#!/usr/bin/env node
import { gatewayJson, readGatewayJob } from '../lib/gateway-json';
const { object }: typeof import('../lib/content-history-reader') = require('../lib/content-history-reader');
import { writeJsonAtomic } from '../lib/atomic-files';
'use strict';

/**
 * Generate a fresh candidate for EVERY current scene with the unified contract:
 *
 *   - prompt : the scene's element tags and authored animaCaption, rendered by
 *              the shared Anima compiler with the selected model profile.
 *              Exact tokens are preserved; artist tags are only kept when authored.
 *   - model  : anima-miaomiao-v1.6 (MiaoMiao Harem Anima v1.6) by default;
 *              --model selects an explicit Anima profile.
 *   - lora   : single-character scenes load the production v21 Anima LoRA at
 *              the strength written in the scene prompt tag (fallback 0.85);
 *              dual (triad) scenes run in the route's no-LoRA mode with both
 *              identities anchored by prompt tokens.
 *   - negative: project `assembleNegative(anima)` plus explicit per-run additions.
 *
 * Output goes to AI/Reviews/SceneShowcaseRefresh/<round>/ and is never written
 * into the public SceneShowcase dir.
 */

const crypto: typeof import('crypto') = require('crypto');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const promptPolicy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
const { createPromptPlan, renderPromptPlan }: typeof import('../../src/utils/promptCompiler.ts') = require('../../src/utils/promptCompiler.ts');
const { CHAR_PROMPT, STUDIO_PROMPT_SUBJECTS }: typeof import('../../src/config/promptConstants.ts') = require('../../src/config/promptConstants.ts');
const sceneInference: typeof import('../../src/utils/sceneInference.ts') = require('../../src/utils/sceneInference.ts');
const { requireDataRecords }: typeof import('../../src/utils/dataRecords.ts') = require('../../src/utils/dataRecords.ts');
const { parsePromptScenes }: typeof import('../../src/utils/promptCatalog.ts') = require('../../src/utils/promptCatalog.ts');
const { parsePresetCatalog }: typeof import('../../src/utils/modelProfileDefaults.ts') = require('../../src/utils/modelProfileDefaults.ts');
const animaConstants = (require('../lib/generation/anima-model-catalog.js') as typeof import('../lib/generation/anima-model-catalog.js'));

type Scene = import('../../src/types/scene.ts').Scene;
const ROOT = path.resolve(__dirname, '..', '..');
const AI_ROOT = path.resolve(ROOT, '..', 'AI');
const SHOWCASE_ROOT = path.resolve(AI_ROOT, 'SceneShowcase');
const DEFAULT_OUTPUT = path.join(AI_ROOT, 'Reviews', 'SceneShowcaseRefresh', '2026-10-01_miaomiao16-rella');
const scenes: Scene[] = readSceneData(path.join(ROOT, 'data', 'scenes.json'));
const presets: typeof import('../../data/presets.json') = require('../../data/presets.json');
const loraData: typeof import('../../data/loras.json') = require('../../data/loras.json');
const profiles = parsePresetCatalog(presets).modelProfiles;

interface CandidateOverrides {
  modelId?: string;
  steps?: number;
  cfg?: number;
  promptAppend?: string;
  negativeAppend?: string;
  hires?: boolean;
  hiresScale?: number;
  hiresDenoise?: number;
}
type Candidate = ReturnType<typeof buildAnimaCandidate>;
type StoredCandidate = Record<string, unknown> & Pick<Candidate, 'recordId' | 'sceneId' | 'attempt'>;

function readRecords(value: unknown): StoredCandidate[] {
  if (!Array.isArray(value)) throw new Error('generation manifest must be an array');
  return value.map((record: unknown) => {
    if (!object(record) || typeof record.recordId !== 'string' || typeof record.sceneId !== 'string'
      || typeof record.attempt !== 'number' || !Number.isFinite(record.attempt) || record.attempt < 1) {
      throw new Error('invalid scene generation record');
    }
    return record as StoredCandidate;
  });
}

const MANIFEST_NAME = 'generation-manifest.json';
const ANIMA_MODEL_ID = 'anima-miaomiao-v1.6';
const ANIMA_PROFILE_ID = 'anima_miaomiao_v16';
const ANIMA_LORA_BY_CHARACTER: Readonly<Record<string, string>> = Object.freeze({
  nene: 'L_NENE_V21_ANIMA',
  natsume: 'L_NAT_V21_ANIMA',
});

function argument(name: string, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function splitList(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}
function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`读取 ${path.relative(ROOT, file)} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
function readSceneData(file: string): Scene[] {
  return parsePromptScenes(requireDataRecords(readJson(file), path.basename(file)));
}

function stableSeed(sceneId: string, attempt: number) {
  const digest = crypto.createHash('sha256').update(`scene-anima11-rella-v16:${sceneId}:${attempt}`).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}
function assertIsolated(output: string) {
  const resolved = path.resolve(output);
  if (resolved === SHOWCASE_ROOT || resolved.startsWith(SHOWCASE_ROOT + path.sep)) {
    throw new Error(`refusing to write candidates into public showcase: ${resolved}`);
  }
  return resolved;
}
function profileById(id: string) {
  const profile = profiles.find(item => item.id === id);
  if (!profile) throw new Error(`presets.json missing profile ${id}`);
  return profile;
}
function loraById(id: string) {
  const lora = loraData.find(item => item.id === id);
  if (!lora) throw new Error(`loras.json missing ${id}`);
  return lora;
}
function nearestAnimaSize(scene: Scene, modelId = ANIMA_MODEL_ID) {
  const desired = sceneInference.sceneRecommendedSize(scene);
  const sizes = animaConstants.MODELS[modelId].sizes;
  if (sizes.includes(desired)) return desired;
  const [desiredWidth, desiredHeight] = desired.split('x').map(Number);
  const ratio = desiredWidth / desiredHeight;
  return [...sizes].sort((left, right) => {
    const [lw, lh] = left.split('x').map(Number);
    const [rw, rh] = right.split('x').map(Number);
    return Math.abs(lw / lh - ratio) - Math.abs(rw / rh - ratio);
  })[0];
}
function animaProfileFor(loraIds: string[], modelId = ANIMA_MODEL_ID) {
  const base = modelId === ANIMA_MODEL_ID ? profileById(ANIMA_PROFILE_ID)
    : profiles.find(profile => profile.model_id === modelId && profile.engine === 'anima');
  if (!base || base.model_id !== modelId || base.engine !== 'anima' || !animaConstants.MODELS[modelId]) throw new Error(`unsupported Anima model: ${modelId}`);
  const contract = loraIds.map(id => loraById(id).prompt_contract);
  return Object.assign({}, base, {
    exact_tokens: [...new Set([...(base.exact_tokens || []), ...contract.flatMap(c => c?.exact_tokens || [])])],
    exact_prefixes: [...new Set([...(base.exact_prefixes || []), ...contract.flatMap(c => c?.exact_prefixes || [])])],
  });
}
function originalPrompt(scene: Scene) {
  return String(scene.prompt || '').replace(/<lora:[^>]+>/gi, '').trim();
}
function sceneLoraStrength(scene: Scene, loraId: string) {
  const refs = promptPolicy.parseScenePromptLoras(scene);
  const weight = refs.length ? refs[0].weight : null;
  if (weight !== null && Number.isFinite(weight)) return weight;
  return Number(loraById(loraId).strength?.default) || 0.85;
}
function buildAnimaCandidate(scene: Scene, attempt: number, seedAttempt = attempt, overrides: CandidateOverrides = {}) {
  const characterId = scene.char;
  if (typeof characterId !== 'string') throw new Error(`scene ${scene.id} has unsupported Anima character ${characterId}`);
  const isTriad = characterId === 'triad';
  const loraIds = isTriad ? ['L_NENE_V21_ANIMA', 'L_NAT_V21_ANIMA'] : [ANIMA_LORA_BY_CHARACTER[characterId]];
  if (!isTriad && !loraIds[0]) throw new Error(`scene ${scene.id} has unsupported Anima character ${characterId}`);
  const modelId = overrides.modelId || ANIMA_MODEL_ID;
  const profile = animaProfileFor(loraIds, modelId);
  const shot = sceneInference.sceneShot(scene);
  const scenePrompt = promptPolicy.sceneTemplateText(scene, { char: characterId, shot, engine: 'anima', profile });
  const artistTag = promptPolicy.tokenize(originalPrompt(scene)).find(tag => tag.startsWith('@')) || null;
  const prompt = renderPromptPlan(createPromptPlan({
    profile, scenePrompt, scene, identity: CHAR_PROMPT[characterId],
    ...STUDIO_PROMPT_SUBJECTS[characterId],
    controls: promptPolicy.characterControlTokens(scene, characterId, ANIMA_LORA_BY_CHARACTER),
    exactTokens: profile.exact_tokens,
    rating: promptPolicy.profileRatingTag(profile, scene),
    manual: promptPolicy.tokenize(String(overrides.promptAppend || '')),
  }), 'anima', profile).prompt;
  const loraId = isTriad ? '' : loraIds[0];
  const loraStrength = isTriad ? null : sceneLoraStrength(scene, loraId);
  let negative = promptPolicy.assembleNegative(profile, scene, 'anima', {
    shot,
    character: characterId,
  });
  const negativeAppend = String(overrides.negativeAppend || '').trim();
  if (negativeAppend) negative = negative ? `${negative}, ${negativeAppend}` : negativeAppend;
  const [width, height] = nearestAnimaSize(scene, modelId).split('x').map(Number);
  const steps = Number(overrides.steps) || animaConstants.MODELS[modelId].steps;
  const cfg = Number(overrides.cfg) || animaConstants.MODELS[modelId].cfg;
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
    artistTag,
    width, height,
    steps,
    cfg,
    sampler: animaConstants.MODELS[modelId].sampler,
    scheduler: animaConstants.MODELS[modelId].scheduler,
    teaCache: true, teaCacheThresh: animaConstants.MODELS[modelId].teaCacheThresh ?? 0.08,
    hiresFix, hiresScale, hiresDenoise,
    seed: stableSeed(scene.id, seedAttempt), prompt, negative,
    seedAttempt,
    animaCaption: typeof scene.animaCaption === 'string' ? scene.animaCaption.trim() : '',
    sourcePrompt: scene.prompt || '', sourceNegative: scene.negative || '',
    inferred: { shot },
  };
}
function planScenes(selectedScenes: Scene[], attempt: number, seedAttempt = attempt, overrides: CandidateOverrides = {}) {
  return selectedScenes.map(scene => buildAnimaCandidate(scene, attempt, seedAttempt, overrides));
}


function buildSubmissionBody(candidate: Candidate) {
  const body: Pick<Candidate, 'prompt' | 'negative' | 'modelId' | 'width' | 'height' | 'steps' | 'cfg' | 'seed' | 'teaCache' | 'teaCacheThresh'>
    & Partial<Pick<Candidate, 'loraId' | 'loraStrength' | 'hiresFix' | 'hiresScale' | 'hiresDenoise'>>
    & { character?: string } = {
    prompt: candidate.prompt, negative: candidate.negative,
    modelId: candidate.modelId, width: candidate.width, height: candidate.height,
    steps: candidate.steps, cfg: candidate.cfg, seed: candidate.seed,
    teaCache: candidate.teaCache, teaCacheThresh: candidate.teaCacheThresh,
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
async function submitCandidate(base: string, candidate: Candidate) {
  const route = '/api/anima/jobs';
  const submitted = await gatewayJson(base, route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildSubmissionBody(candidate)),
  });
  let job = readGatewayJob(submitted.data);
  if (!submitted.response || submitted.response.status !== 202 || !job) {
    const status = submitted.response ? submitted.response.status : 'network';
    return { ok: false as const, error: `submission failed (${status}): ${submitted.error || JSON.stringify(submitted.data)}` };
  }
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const state = await gatewayJson(base, `${route}/${encodeURIComponent(job.id)}`, undefined);
    const updated = readGatewayJob(state.data);
    if (state.response?.ok && updated) job = updated;
    if (job.status === 'failed' || job.status === 'cancelled') {
      return { ok: false as const, error: `job failed: ${job.error || job.status} (${job.code || ''})`, jobId: job.id };
    }
    if (job.status === 'succeeded' && job.resultUrl) break;
    await new Promise<void>(resolve => setTimeout(resolve, 2000));
  }
  if (job.status !== 'succeeded' || !job.resultUrl) return { ok: false as const, error: `job timed out: ${job.status}`, jobId: job.id };
  const result = await fetch(base.replace(/\/$/, '') + job.resultUrl, { cache: 'no-store' });
  if (!result.ok) return { ok: false as const, error: `result fetch failed (HTTP ${result.status})`, jobId: job.id };
  return {
    ok: true as const,
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
  const overrides: CandidateOverrides = {};
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
  const selectedScenes = ids.length ? ids.map(id => scenes.find(scene => scene.id === id)) : scenes;
  const missing = ids.filter((_id, index) => !selectedScenes[index]);
  if (missing.length) throw new Error(`unknown scene ids: ${missing.join(', ')}`);
  const manifestPath = path.join(output, MANIFEST_NAME);
  const existing = fs.existsSync(manifestPath) ? readRecords(readJson(manifestPath)) : [];
  const records = new Map(existing.map(record => [record.recordId, record]));
  const planned = planScenes(selectedScenes.filter((scene): scene is Scene => scene !== undefined), attempt, seedAttempt, overrides);
  if (dryRun) {
    console.log(JSON.stringify({ output, gateway, count: planned.length, candidates: planned }, null, 2));
    return;
  }

  fs.mkdirSync(output, { recursive: true });
  const pending = planned.filter(candidate => {
    const previous = records.get(candidate.recordId);
    const imageRel = `images/${candidate.sceneId}/attempt-${attempt}.png`;
    const imageFile = path.join(output, imageRel.split('/').join(path.sep));
    const fields = ['modelId', 'checkpoint', 'profileId', 'prompt', 'negative', 'width', 'height', 'steps', 'cfg', 'seed', 'loraId', 'loraStrength', 'sampler', 'scheduler', 'teaCache', 'teaCacheThresh'] as const;
    const matching = previous && fields.every(key => previous[key] === candidate[key]);
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
      const result = await submitCandidate(gateway, candidate);
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

  const normalized = [...records.values()].sort((left, right) => left.sceneId.localeCompare(right.sceneId) || left.attempt - right.attempt);
  writeJsonAtomic(manifestPath, normalized);
  console.log(JSON.stringify({ output, planned: planned.length, generated, failed }, null, 2));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
