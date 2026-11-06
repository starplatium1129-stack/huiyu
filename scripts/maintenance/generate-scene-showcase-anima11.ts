#!/usr/bin/env node
import { indexShowcaseCandidates, prepareShowcaseCandidate, generateShowcaseCandidate, matchesShowcaseImage, saveShowcaseImage,
  showcaseAttempt, showcaseImagePath, showcaseManifestError, showcaseSlot } from '../lib/legacy-showcase-generation';
const { assertOutput, lockDirectory, noLinks, runCli }: typeof import('../lib/generation-candidates') = require('../lib/generation-candidates');
const { object }: typeof import('../lib/content-history-reader') = require('../lib/content-history-reader');
import { writeJsonAtomic } from '../lib/atomic-files';
'use strict';

/**
 * Generate a fresh candidate for EVERY current scene with the unified contract:
 *
 *   - prompt : the scene's element tags and authored animaCaption, rendered by
 *              compilePromptRecipe with the selected model profile and LoRA metadata.
 *              Exact tokens are preserved; artist tags are only kept when authored.
 *   - model  : anima-miaomiao-v1.6 (MiaoMiao Harem Anima v1.6) by default;
 *              --model selects an explicit Anima profile.
 *   - lora   : single-character scenes load the production v21 Anima LoRA at
 *              the strength written in the scene prompt tag (fallback 0.85);
 *              dual (triad) scenes run in the route's no-LoRA mode with both
 *              identities anchored by prompt tokens.
 *   - negative: the complete recipe result, including explicit per-run additions.
 *
 * Output goes to AI/Reviews/SceneShowcaseRefresh/<round>/ and is never written
 * into the public SceneShowcase dir.
 */

const crypto: typeof import('crypto') = require('crypto');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const promptPolicy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
const { compilePromptRecipe }: typeof import('../../src/utils/promptRecipe.ts') = require('../../src/utils/promptRecipe.ts');
const sceneInference: typeof import('../../src/utils/sceneInference.ts') = require('../../src/utils/sceneInference.ts');
const { requireDataRecords }: typeof import('../../src/utils/dataRecords.ts') = require('../../src/utils/dataRecords.ts');
const { parsePromptScenes }: typeof import('../../src/utils/promptCatalog.ts') = require('../../src/utils/promptCatalog.ts');
const { parsePresetCatalog }: typeof import('../../src/utils/modelProfileDefaults.ts') = require('../../src/utils/modelProfileDefaults.ts');
const animaConstants = (require('../lib/generation/anima-model-catalog.js') as typeof import('../lib/generation/anima-model-catalog.js'));

type Scene = import('../../src/types/scene.ts').Scene;
const ROOT = path.resolve(__dirname, '..', '..');
const AI_ROOT = path.resolve(ROOT, '..', 'AI');
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
type StoredCandidate = Record<string, unknown> & Pick<Candidate, 'key' | 'recordId' | 'sceneId' | 'attempt'>;

function readRecords(value: unknown): StoredCandidate[] {
  if (!Array.isArray(value)) throw new Error('generation manifest must be an array');
  return value.map((record: unknown) => {
    if (!object(record) || typeof record.key !== 'string' || typeof record.recordId !== 'string' || typeof record.sceneId !== 'string'
      || record.key !== `scene:${record.sceneId}`
      || typeof record.attempt !== 'number' || !Number.isSafeInteger(record.attempt) || record.attempt < 1) {
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
function animaProfileFor(modelId = ANIMA_MODEL_ID) {
  const base = modelId === ANIMA_MODEL_ID ? profileById(ANIMA_PROFILE_ID)
    : profiles.find(profile => profile.model_id === modelId && profile.engine === 'anima');
  if (!base || base.model_id !== modelId || base.engine !== 'anima' || !animaConstants.MODELS[modelId]) throw new Error(`unsupported Anima model: ${modelId}`);
  return base;
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
  const loraIds = isTriad ? [] : [ANIMA_LORA_BY_CHARACTER[characterId]];
  if (!isTriad && !loraIds[0]) throw new Error(`scene ${scene.id} has unsupported Anima character ${characterId}`);
  const modelId = overrides.modelId || ANIMA_MODEL_ID;
  const profile = animaProfileFor(modelId);
  const artistTag = promptPolicy.tokenize(originalPrompt(scene)).find(tag => tag.startsWith('@')) || null;
  const result = compilePromptRecipe({
    kind: 'studio', character: characterId, scene, engine: 'anima', profile,
    activeLoras: isTriad ? {} : { [characterId]: loraIds[0] },
    loraMeta: loraData,
    manual: promptPolicy.tokenize(String(overrides.promptAppend || '')),
    negativeCustom: overrides.negativeAppend,
  });
  const { prompt, negative } = result;
  const shot = result.selections.shot;
  const loraId = isTriad ? '' : loraIds[0];
  const loraStrength = isTriad ? null : sceneLoraStrength(scene, loraId);
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
async function main(signal?: AbortSignal) {
  const ids = splitList(argument('--ids'));
  const attempt = showcaseAttempt(argument('--attempt', '1'), '--attempt');
  const seedAttempt = showcaseAttempt(argument('--seed-attempt', String(attempt)), '--seed-attempt');
  const output = assertOutput({ output: argument('--output', DEFAULT_OUTPUT), root: ROOT, env: process.env });
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
  const planned = planScenes(selectedScenes.filter((scene): scene is Scene => scene !== undefined), attempt, seedAttempt, overrides);
  if (dryRun) {
    console.log(JSON.stringify({ output, gateway, count: planned.length, candidates: planned }, null, 2));
    return;
  }

  fs.mkdirSync(output, { recursive: true });
  const unlock = lockDirectory(output);
  try {
    if (fs.existsSync(path.join(output, 'candidate-run.json'))) throw new Error('候选目录属于另一生成流程，请选择独立目录');
    noLinks(manifestPath);
    const existing = fs.existsSync(manifestPath) ? readRecords(readJson(manifestPath)) : [];
    const records = indexShowcaseCandidates(existing);
    const pending = planned.filter(candidate => {
      const previous = records.get(showcaseSlot(candidate));
      const imageRel = `images/${candidate.sceneId}/attempt-${attempt}.png`;
      const imageFile = showcaseImagePath(output, candidate.sceneId, `attempt-${attempt}.png`);
      const fields = ['modelId', 'checkpoint', 'profileId', 'prompt', 'negative', 'width', 'height', 'steps', 'cfg', 'seed', 'loraId', 'loraStrength', 'sampler', 'scheduler', 'teaCache', 'teaCacheThresh', 'hiresFix', 'hiresScale', 'hiresDenoise'] as const;
      const matching = previous && fields.every(key => previous[key] === candidate[key]);
      if (!force && matching && previous?.status === 'succeeded' && previous.image === imageRel && matchesShowcaseImage(previous, imageFile)) {
        console.log(`[reuse] ${previous.recordId}`);
        return false;
      }
      return true;
    });
    if (limit < pending.length) pending.length = limit;
    console.log(`[plan] ${planned.length} candidates, ${pending.length} to generate (concurrency ${concurrency})`);

    let generated = 0;
    let failed = 0;
    let cursor = 0;
    let manifestFailed = false;
    const manifestFailures = new Set<string>();
    const batchAbort = new AbortController();
    const active = signal ? AbortSignal.any([signal, batchAbort.signal]) : batchAbort.signal;
    async function worker() {
      while (!active.aborted && cursor < pending.length) {
        const candidate = pending[cursor];
        cursor += 1;
        const imageRel = `images/${candidate.sceneId}/attempt-${attempt}.png`;
        const imageFile = showcaseImagePath(output, candidate.sceneId, `attempt-${attempt}.png`);
        try {
          const record = prepareShowcaseCandidate(candidate, records.get(showcaseSlot(candidate)), gateway, buildSubmissionBody(candidate), force);
          console.log(`[generate] ${record.recordId} ${candidate.modelId} ${candidate.width}x${candidate.height} seed ${candidate.seed}`);
          const expectedHash = typeof record.sha256 === 'string' ? record.sha256 : undefined;
          const save = (value: typeof record) => {
            records.set(showcaseSlot(candidate), value);
            try { writeJsonAtomic(manifestPath, [...records.values()]); }
            catch (error) {
              const failure = showcaseManifestError(value, error);
              manifestFailures.add(failure.message);
              if (!manifestFailed) { manifestFailed = true; batchAbort.abort(failure); }
              throw error;
            }
          };
          const result = await generateShowcaseCandidate(record, save, 0, active);
          const sha256 = saveShowcaseImage(imageFile, result.buffer, expectedHash);
          save(Object.assign(record, {
            status: 'succeeded', error: '', image: imageRel, generatedAt: new Date().toISOString(),
            bytes: result.buffer.length, mime: result.mime, sha256,
            jobId: result.jobId, provider: result.provider, actualSeed: result.actualSeed, metadata: result.metadata,
          }));
          console.log(`[ok] ${record.recordId} -> ${imageRel} (${result.buffer.length} bytes)`);
          generated += 1;
        } catch (error) {
          if (manifestFailed) throw error;
          if (signal?.aborted) return;
          console.log(`[failed] ${candidate.recordId}: ${error instanceof Error ? error.message : String(error)}`);
          failed += 1;
        }
      }
    }
    const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
    if (manifestFailed) throw new Error([...manifestFailures].join('\n'));
    const failure = workers.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;

    const normalized = [...records.values()].sort((left, right) => left.sceneId.localeCompare(right.sceneId) || left.attempt - right.attempt);
    writeJsonAtomic(manifestPath, normalized);
    console.log(JSON.stringify({ output, planned: planned.length, generated, failed }, null, 2));
    return { exitCode: signal?.aborted ? 130 : failed ? 1 : 0 };
  } finally { unlock(); }
}

if (require.main === module) runCli(async (_args, options) => main(options.signal));
