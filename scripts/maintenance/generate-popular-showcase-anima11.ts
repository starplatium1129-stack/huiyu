#!/usr/bin/env node
import { gatewayJson, readGatewayJob } from '../lib/gateway-json';
const { object }: typeof import('../lib/content-history-reader') = require('../lib/content-history-reader');
import type { PopularCharacter, SceneBlueprint } from '../../src/utils/popularContent';
import type { ModelProfile } from '../../src/utils/promptPolicyTypes';
import { writeJsonAtomic } from '../lib/atomic-files';
'use strict';

/**
 * Generate showcase candidates for EVERY popular character × EVERY scene
 * blueprint (SFW + R18), unified contract:
 *
 *   - engine : MiaoMiao v1.6 by default; --model selects an explicit Anima profile
 *   - prompt : buildPopularPromptPlan (identity + outfit + blueprint scene +
 *              inferred shot/lighting/composition) with artist tag @rella
 *   - params : 30 steps / CFG 4.5 (global Anima default since 2026-08-14)
 *   - R18 blueprints retain their rating; there is no adult access gate.
 *
 * Output goes to AI/Reviews/ShowcaseRefresh/<round>/ (never the public dir).
 */

const crypto: typeof import('crypto') = require('crypto');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const popularContent: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');
const popularPrompt: typeof import('../../src/utils/popularPromptBuilder.ts') = require('../../src/utils/popularPromptBuilder.ts');
const blueprintDecisions: typeof import('../../src/utils/popularBlueprintDecisions.ts') = require('../../src/utils/popularBlueprintDecisions.ts');
const { showcaseSubjectGuards, compositionNegative }: typeof import('../../src/utils/blueprintComposition.ts') = require('../../src/utils/blueprintComposition.ts');
const { artistTagsForEngine }: typeof import('../../src/config/artistStyles.ts') = require('../../src/config/artistStyles.ts');
const { tokenize }: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
const animaConstants = (require('../lib/generation/anima-model-catalog.js') as typeof import('../lib/generation/anima-model-catalog.js'));

const ROOT = path.resolve(__dirname, '..', '..');
const AI_ROOT = path.resolve(ROOT, '..', 'AI');
const SHOWCASE_ROOT = path.resolve(AI_ROOT, 'SceneShowcase');
const DEFAULT_OUTPUT = path.join(AI_ROOT, 'Reviews', 'ShowcaseRefresh', '2026-10-01_miaomiao16-popular-all-rella');
const popularData: unknown = readJson(path.join(ROOT, 'data', 'popular-characters.json'));
const blueprintData: unknown = readJson(path.join(ROOT, 'data', 'scene-blueprints.json'));
const presets: typeof import('../../data/presets.json') = require('../../data/presets.json');
const { parsePresetCatalog }: typeof import('../../src/utils/modelProfileDefaults.ts') = require('../../src/utils/modelProfileDefaults.ts');
const profiles = parsePresetCatalog(presets).modelProfiles;

type Candidate = ReturnType<typeof buildCandidate>;
type StoredCandidate = Record<string, unknown> & Pick<Candidate, 'recordId' | 'characterId' | 'blueprintId' | 'attempt'>;

function readRecords(value: unknown): StoredCandidate[] {
  if (!Array.isArray(value)) throw new Error('generation manifest must be an array');
  return value.map((record: unknown) => {
    if (!object(record) || typeof record.recordId !== 'string' || typeof record.characterId !== 'string'
      || typeof record.blueprintId !== 'string' || typeof record.attempt !== 'number' || !Number.isFinite(record.attempt)
      || record.attempt < 1) throw new Error('invalid popular generation record');
    return record as StoredCandidate;
  });
}

const MANIFEST_NAME = 'generation-manifest.json';
const ANIMA_MODEL_ID = argument('--model', 'anima-miaomiao-v1.6');
const ANIMA_PROFILE_ID = profiles.find(item => item.model_id === ANIMA_MODEL_ID && item.engine === 'anima')?.id;
const ARTIST_TAG = 'rella';

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

function stableSeed(characterId: string, blueprintId: string, attempt: number) {
  const digest = crypto.createHash('sha256').update(`popular-all-rella:${characterId}:${blueprintId}:${attempt}`).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}
function assertIsolated(output: string) {
  const resolved = path.resolve(output);
  if (resolved === SHOWCASE_ROOT || resolved.startsWith(SHOWCASE_ROOT + path.sep)) {
    throw new Error(`refusing to write candidates into public showcase: ${resolved}`);
  }
  return resolved;
}
function resolveProfile() {
  if (!animaConstants.MODELS[ANIMA_MODEL_ID] || !ANIMA_MODEL_ID.startsWith('anima-')) {
    throw new Error(`unsupported Anima model: ${ANIMA_MODEL_ID}`);
  }
  const profile = profiles.find(item => item.id === ANIMA_PROFILE_ID);
  if (!profile) throw new Error(`presets.json missing profile ${ANIMA_PROFILE_ID}`);
  return profile;
}
function nearestAnimaSize(blueprint: SceneBlueprint) {
  const explicit = String(blueprint.recommendedSize || '832x1216');
  const match = explicit.match(/(\d+)\s*[x×]\s*(\d+)/i);
  const desired = match ? `${Number(match[1])}x${Number(match[2])}` : '832x1216';
  const sizes = animaConstants.MODELS[ANIMA_MODEL_ID].sizes;
  if (sizes.includes(desired)) return desired;
  const [desiredWidth, desiredHeight] = desired.split('x').map(Number);
  const ratio = desiredWidth / desiredHeight;
  return [...sizes].sort((left, right) => {
    const [lw, lh] = left.split('x').map(Number);
    const [rw, rh] = right.split('x').map(Number);
    return Math.abs(lw / lh - ratio) - Math.abs(rw / rh - ratio);
  })[0];
}
function buildCandidate(character: PopularCharacter, blueprint: SceneBlueprint, profile: ModelProfile, attempt: number, seedAttempt = attempt) {
  // 蓝图指定服装（outfitId）优先；缺失时回退默认服装。
  const outfit = (blueprint.outfitId && popularContent.findOutfit(character, blueprint.outfitId))
    || popularContent.defaultOutfit(character);
  const decisions = blueprintDecisions.inferBlueprintDecisions(blueprint);
  const adult = Boolean(blueprint.adult);
  const guards = showcaseSubjectGuards(blueprint);
  const result = popularPrompt.buildPopularPromptPlan({
    character,
    outfit,
    blueprint,
    engine: 'anima',
    profile,
    shot: decisions.shot,
    lighting: decisions.lighting,
    composition: decisions.composition,
    // artistTags 需传入 Anima 引擎格式（前导 @），renderPromptPlan 不做转换。
    artistTags: artistTagsForEngine([ARTIST_TAG], 'anima'),
    manual: tokenize(guards.prompt),
  });
  const prompt = result.prompt;
  const [width, height] = nearestAnimaSize(blueprint).split('x').map(Number);
  const negative = compositionNegative(result.negative, blueprint);
  return {
    batch: 'popular', key: `popular:${character.id}:${blueprint.id}`,
    recordId: `popular:${character.id}:${blueprint.id}@attempt-${attempt}`,
    characterId: character.id, blueprintId: blueprint.id, blueprintTitle: blueprint.title,
    displayName: `${character.displayName} / ${blueprint.title}${adult ? ' (R18)' : ''}`,
    adult, outfitId: outfit.id,
    engine: 'anima', profileId: profile.id, modelId: ANIMA_MODEL_ID,
    checkpoint: animaConstants.MODELS[ANIMA_MODEL_ID].file,
    artistTag: '@' + ARTIST_TAG,
    width, height,
    steps: animaConstants.MODELS[ANIMA_MODEL_ID].steps,
    cfg: animaConstants.MODELS[ANIMA_MODEL_ID].cfg,
    teaCache: !process.argv.includes('--no-tea-cache'),
    teaCacheThresh: animaConstants.MODELS[ANIMA_MODEL_ID].teaCacheThresh ?? 0.08,
    sampler: animaConstants.MODELS[ANIMA_MODEL_ID].sampler,
    scheduler: animaConstants.MODELS[ANIMA_MODEL_ID].scheduler,
    seed: stableSeed(character.id, blueprint.id, seedAttempt),
    attempt,
    prompt, negative,
    inferred: decisions,
  };
}
function planAll(attempt: number, seedAttempt = attempt, keys: string[] = []) {
  const characters = popularContent.parsePopularCharacters(popularData);
  const blueprints = popularContent.parseSceneBlueprints(blueprintData);
  const profile = resolveProfile();
  const candidates: Candidate[] = [];
  for (const character of characters) {
    const owned = blueprints.filter(bp => bp.characterId === character.id);
    if (!owned.length) throw new Error(`no blueprints for ${character.id}`);
    for (const blueprint of owned) {
      if (keys.length && !keys.includes(`popular:${character.id}:${blueprint.id}`)) continue;
      candidates.push(buildCandidate(character, blueprint, profile, attempt, seedAttempt));
    }
  }
  return candidates;
}


function buildSubmissionBody(candidate: Candidate) {
  // no-LoRA 模式：不传 loraId / loraStrength / character。
  return {
    prompt: candidate.prompt, negative: candidate.negative,
    modelId: candidate.modelId, width: candidate.width, height: candidate.height,
    steps: candidate.steps, cfg: candidate.cfg, seed: candidate.seed,
    teaCache: candidate.teaCache, teaCacheThresh: candidate.teaCacheThresh,
  };
}
function canReuseCandidate(previous: StoredCandidate | undefined, candidate: Candidate) {
  const fields = ['modelId', 'profileId', 'checkpoint', 'prompt', 'negative', 'width', 'height', 'steps', 'cfg', 'seed', 'sampler', 'scheduler', 'teaCache', 'teaCacheThresh'] as const;
  return previous?.status === 'succeeded' && fields.every(field => previous[field] === candidate[field]);
}
async function submitCandidate(base: string, candidate: Candidate) {
  const route = '/api/anima/jobs';
  let submitted: Awaited<ReturnType<typeof gatewayJson>> | null = null;
  // 429 队列满：退避重试（网关 MAX_PENDING=4，并发脚本撞队列时自愈）。
  for (let retry = 0; retry < 5; retry += 1) {
    submitted = await gatewayJson(base, route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildSubmissionBody(candidate)),
    });
    const busy = submitted.response && submitted.response.status === 429;
    if (!busy) break;
    await new Promise<void>(resolve => setTimeout(resolve, 5000 * (retry + 1)));
  }
  let job = readGatewayJob(submitted?.data);
  if (!submitted?.response || submitted.response.status !== 202 || !job) {
    const status = submitted?.response ? submitted.response.status : 'network';
    return { ok: false as const, error: `submission failed (${status}): ${submitted?.error || JSON.stringify(submitted?.data)}` };
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
  const keys = splitList(argument('--keys'));
  const attempt = Math.max(1, Number(argument('--attempt', '1')) || 1);
  const seedAttempt = Math.max(1, Number(argument('--seed-attempt', String(attempt))) || attempt);
  const output = assertIsolated(path.resolve(argument('--output', DEFAULT_OUTPUT)));
  const gateway = argument('--gateway', 'http://127.0.0.1:3000');
  const limit = Math.max(1, Number(argument('--limit', '9999')) || 9999);
  const concurrency = Math.max(1, Math.min(4, Number(argument('--concurrency', '3')) || 3));
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  const selected = planAll(attempt, seedAttempt, keys);
  if (keys.length && selected.length !== keys.length) {
    const found = new Set(selected.map(c => c.key));
    throw new Error(`unknown keys: ${keys.filter(k => !found.has(k)).join(', ')}`);
  }
  const manifestPath = path.join(output, MANIFEST_NAME);
  const existing = fs.existsSync(manifestPath) ? readRecords(readJson(manifestPath)) : [];
  const records = new Map(existing.map(record => [record.recordId, record]));
  if (dryRun) {
    console.log(JSON.stringify({ output, gateway, count: selected.length, candidates: selected }, null, 2));
    return;
  }
  fs.mkdirSync(output, { recursive: true });
  const pending = selected.filter(candidate => {
    const previous = records.get(candidate.recordId);
    const imageRel = `images/${candidate.characterId}/${candidate.blueprintId}/attempt-${attempt}.png`;
    const imageFile = path.join(output, imageRel.split('/').join(path.sep));
    if (!force && canReuseCandidate(previous, candidate) && fs.existsSync(imageFile) && fs.statSync(imageFile).size > 1000) {
      console.log(`[reuse] ${candidate.recordId}`);
      return false;
    }
    return true;
  });
  if (limit < pending.length) pending.length = limit;
  console.log(`[plan] ${selected.length} candidates, ${pending.length} to generate (concurrency ${concurrency})`);
  let generated = 0;
  let failed = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const candidate = pending[cursor];
      cursor += 1;
      const imageRel = `images/${candidate.characterId}/${candidate.blueprintId}/attempt-${attempt}.png`;
      const imageFile = path.join(output, imageRel.split('/').join(path.sep));
      console.log(`[generate] ${candidate.recordId} ${candidate.width}x${candidate.height} seed ${candidate.seed}`);
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
  const normalized = [...records.values()].sort((left, right) =>
    left.characterId.localeCompare(right.characterId) || left.blueprintId.localeCompare(right.blueprintId) || left.attempt - right.attempt);
  writeJsonAtomic(manifestPath, normalized);
  console.log(JSON.stringify({ output, planned: selected.length, generated, failed }, null, 2));
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
