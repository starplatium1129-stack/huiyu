#!/usr/bin/env node
import { writeJsonAtomic } from '../lib/atomic-files';
'use strict';

/**
 * Real sample-candidate generation for the artist / popular-character /
 * latest-LoRA showcase refresh round.
 *
 * Writes ONLY into an isolated review directory (default
 * AI/Reviews/ShowcaseRefresh/2026-08-12_artist_popular_latest-lora) and NEVER
 * into the public SceneShowcase directory. Every image records full provenance
 * in an atomically-updated manifest; already-valid images are reused on resume.
 * Visual acceptance is a separate manual review step - this script never claims
 * a visual pass.
 *
 * Since the 2026-08-12 main-thread visual review, keys listed in
 * REVIEW_OVERRIDES are re-planned as attempt-2 candidates with minimal prompt
 * reinforcement / negative additions / deterministic seed offsets / explicit
 * camera framing. Original attempt-1 images are never overwritten; attempt-2
 * files are written beside them as `<key>_attempt-2.png` and recorded with
 * `attempt`, `supersedes` and `reviewReason` so both attempts can be compared.
 *
 * A third review round (attempt-3) re-runs the keys listed in
 * ATTEMPT_3_OVERRIDES that still failed visual acceptance. They build on the
 * same production pipeline, write beside prior attempts as
 * `<key>_attempt-3.png`, and set `supersedes` to the key's latest prior
 * attempt (attempt-2 when that key has one, otherwise attempt-1) so the
 * re-review chain stays readable. `--attempt 3` filters the plan to only
 * attempt-3 candidates, so a re-run never regenerates attempt-1/2.
 *
 * HISTORICAL NOTE (2026-08-12 correction): the attempt-2/3 mole rules for
 * 四季夏目 pinned "mole under left eye / mole on left cheek" as if they were
 * the correct contract. Visual review of assets/characters/natsume-official.webp
 * proved that was a main-thread misjudgement: the beauty mark sits under the
 * character's OWN right eye (viewer-left in a front-facing pose). Those
 * attempt-2/3 records, prompts and images are deliberately preserved verbatim
 * so the already-generated history stays consistent - they are historical
 * misjudgements, NOT the current contract. A fourth review round
 * (ATTEMPT_4_OVERRIDES) re-runs only the two keys that still fail acceptance
 * with the corrected mole side and 960x1536 coverage:
 *   latest-lora:natsume:sd:fullbody     (supersedes attempt-3)
 *   latest-lora:natsume:anima:fullbody  (supersedes attempt-2)
 * `--attempt 4` filters the plan to exactly those two candidates.
 *
 * Prompts are assembled exclusively through the production prompt pipeline
 * (src/utils/promptCompiler.ts / promptPolicy.ts / popularContent.ts) and the
 * production gateway API, so no ad-hoc prompt variant is introduced here.
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');
const {
  WAI_PROFILE_ID, WAI_MODEL_ID, DEFAULT_OUTPUT, MANIFEST_NAME, readJson, REVIEW_OVERRIDES,
  ATTEMPT_3_OVERRIDES, ATTEMPT_4_OVERRIDES, REVIEW_INDEX_NAME, CONTACT_SHEET_NAME, WAI_CHECKPOINT,
  ANIMA_BASE_ID, ANIMA_AESTHETIC_ID, POPULAR_BLUEPRINT_ID, DEFAULT_LORA_STRENGTH, STUDIO_CHAR_PROMPT,
  ARTIST_NEUTRAL_SUBJECT,
}: typeof import('../lib/generate-showcase-candidates-settings.js') = require('../lib/generate-showcase-candidates-settings.js');
const {
  splitList, argument, assertNotShowcase, recordIdOf, shouldReuse, imageRelFor, imageInfo,
}: typeof import('../lib/generate-showcase-candidates-support.js') = require('../lib/generate-showcase-candidates-support.js');
const {
  planAllBatches, filterPlanned, artistBatch, popularBatch, latestLoraBatch, reviewOverrideJobs,
  buildAttemptTwo, buildAttemptThree, buildAttemptFour, reviewAttemptThreeJobs, reviewAttemptFourJobs,
}: typeof import('../lib/generate-showcase-candidates-plan.js') = require('../lib/generate-showcase-candidates-plan.js');
const { verifyOutput }: typeof import('../lib/generate-showcase-candidates-report.js') = require('../lib/generate-showcase-candidates-report.js');
const {
  buildArtistPrompt, buildStudioPrompt, buildPopularPrompt,
}: typeof import('../lib/generate-showcase-candidates-prompts.js') = require('../lib/generate-showcase-candidates-prompts.js');

// ── gateway job runner ─────────────────────────────────────────────────────

async function gatewayJson(base: any, pathname: any, options: any) {
  const url = base.replace(/\/$/, '') + pathname;
  const response = await fetch(url, Object.assign({ cache: 'no-store' }, options || {}));
  let data = null;
  try { data = await response.json(); } catch (error) { /* keep null */ }
  return { response, data };
}

async function submitCandidate(base: any, candidate: any) {
  const body: any = { prompt: candidate.prompt, negative: candidate.negative };
  let routeBase;
  if (candidate.engine === 'krea2') {
    routeBase = '/api/creative/jobs';
    Object.assign(body, {
      modelId: candidate.modelId,
      width: candidate.width, height: candidate.height,
      seed: candidate.seed,
    });
  } else if (candidate.batch === 'artist' || (candidate.batch === 'latest-lora' && candidate.engine === 'sd')) {
    routeBase = '/api/generation/jobs';
    Object.assign(body, {
      profile: WAI_PROFILE_ID,
      modelId: WAI_MODEL_ID,
      character: candidate.characterId || '',
      loras: candidate.loraId ? [{ id: candidate.loraId, strength: candidate.loraStrength }] : [],
      width: candidate.width, height: candidate.height,
      steps: candidate.steps, cfg: candidate.cfg, seed: candidate.seed,
      sampler: candidate.sampler, scheduler: '',
      hiresFix: false,
    });
  } else {
    routeBase = '/api/anima/jobs';
    Object.assign(body, {
      modelId: candidate.modelId,
      width: candidate.width, height: candidate.height,
      steps: candidate.steps, cfg: candidate.cfg, seed: candidate.seed,
    });
    if (candidate.loraId) {
      body.loraId = candidate.loraId;
      body.loraStrength = candidate.loraStrength;
      body.character = candidate.characterId;
    }
  }
  const submitted = await gatewayJson(base, routeBase, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (submitted.response.status !== 202 || !submitted.data || !submitted.data.ok || !submitted.data.job || !submitted.data.job.id) {
    return { ok: false, error: `submission failed (HTTP ${submitted.response.status}): ${JSON.stringify(submitted.data)}` };
  }
  const job = submitted.data.job;
  const pollBase = routeBase === '/api/anima/jobs' ? '/api/anima/jobs' : (routeBase === '/api/creative/jobs' ? '/api/creative/jobs' : '/api/generation/jobs');
  const deadline = Date.now() + 15 * 60 * 1000;
  let current = job;
  while (Date.now() < deadline) {
    const state = await gatewayJson(base, `${pollBase}/${encodeURIComponent(current.id)}`, undefined);
    const polled = state.response.ok && state.data && state.data.ok ? state.data.job : null;
    if (polled) current = polled;
    if (current.status === 'failed' || current.status === 'cancelled') {
      return { ok: false, error: `job failed: ${current.error || current.status} (${current.code || ''})` };
    }
    if (current.status === 'succeeded' && current.resultUrl) break;
    await new Promise<any>((resolve: any) => setTimeout(resolve, 2000));
  }
  if (current.status !== 'succeeded' || !current.resultUrl) {
    return { ok: false, error: `job timed out: ${current.status}` };
  }
  const imageResponse = await fetch(base.replace(/\/$/, '') + current.resultUrl, { cache: 'no-store' });
  if (!imageResponse.ok) return { ok: false, error: `result fetch failed (HTTP ${imageResponse.status})` };
  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  return {
    ok: true,
    buffer,
    provider: current.provider || '',
    jobId: current.id,
    seed: (current.metadata && current.metadata.seed) || current.seed || candidate.seed,
    infotexts: current.metadata ? current.metadata : {},
  };
}

async function main() {
  const batchFilter = splitList(argument('--batch'));
  const keyFilter = splitList(argument('--keys'));
  // --attempt narrows to specific review rounds, e.g. --attempt 3 regenerates
  // only attempt-3 candidates and never re-runs attempt-1/2.
  const attemptFilter = splitList(argument('--attempt')).map(Number).filter(Number.isInteger);
  const output = assertNotShowcase(path.resolve(argument('--output', DEFAULT_OUTPUT)));
  const gateway = argument('--gateway', 'http://127.0.0.1:3000');
  const seedBase = Number(argument('--seed', '20260812')) || 20260812;
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  const limit = Math.max(1, Number(argument('--limit', '9999')) || 9999);

  fs.mkdirSync(output, { recursive: true });
  const manifestPath = path.join(output, MANIFEST_NAME);
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : [];

  const planned = planAllBatches(seedBase);
  const selected = filterPlanned(planned, {
    batch: batchFilter,
    keys: keyFilter,
    attempts: attemptFilter,
  });
  if (dryRun) {
    console.log(JSON.stringify({ output, gateway, totalPlanned: planned.length, selected: selected.length, candidates: selected }, null, 2));
    return;
  }

  console.log(`output: ${output}`);
  console.log(`planned ${planned.length} candidates, selected ${selected.length}`);

  const records = new Map(manifest.map((record: any) => [record.recordId || `${record.key}@attempt-${record.attempt || 1}`, record]));
  let generated = 0;
  let reused = 0;
  let failed = 0;

  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    if (generated + reused >= limit) break;
    const recordId = recordIdOf(candidate);
    const previous: any = records.get(recordId);
    const previousImage = previous && previous.image ? path.join(output, previous.image.split('/').join(path.sep)) : '';
    if (shouldReuse(previous, previousImage, force)) {
      console.log(`[reuse] ${candidate.key}@attempt-${candidate.attempt} -> ${previous.image}`);
      reused += 1;
      continue;
    }

    console.log(`[generate] ${candidate.key}@attempt-${candidate.attempt} seed ${candidate.seed} ${candidate.width}x${candidate.height}${candidate.reviewReason ? ` :: ${candidate.reviewReason}` : ''}`);
    const result: any = await submitCandidate(gateway, candidate);
    const imageRel = imageRelFor(candidate);
    const imageFile = path.join(output, imageRel.split('/').join(path.sep));

    if (!result.ok) {
      records.set(recordId, Object.assign({}, candidate, {
        status: 'failed', error: result.error, generatedAt: new Date().toISOString(), image: '', jobId: result.jobId || '',
      }));
      writeJsonAtomic(manifestPath, [...records.values()]);
      failed += 1;
      console.log(`[failed] ${candidate.key}@attempt-${candidate.attempt}: ${result.error}`);
      continue;
    }

    const info = imageInfo(result.buffer);
    if (!info || !result.buffer.length) {
      records.set(recordId, Object.assign({}, candidate, {
        status: 'failed', error: 'engine returned a non-image payload', generatedAt: new Date().toISOString(), image: '',
      }));
      writeJsonAtomic(manifestPath, [...records.values()]);
      failed += 1;
      console.log(`[failed] ${candidate.key}@attempt-${candidate.attempt}: non-image payload`);
      continue;
    }

    fs.mkdirSync(path.dirname(imageFile), { recursive: true });
    fs.writeFileSync(imageFile, result.buffer);
    records.set(recordId, Object.assign({}, candidate, {
      status: 'succeeded',
      error: '',
      generatedAt: new Date().toISOString(),
      image: imageRel,
      bytes: result.buffer.length,
      mime: info.mime,
      actualWidth: info.width,
      actualHeight: info.height,
      sha256: crypto.createHash('sha256').update(result.buffer).digest('hex'),
      jobId: result.jobId,
      provider: result.provider,
      actualSeed: result.seed,
      infotexts: result.infotexts,
    }));
    writeJsonAtomic(manifestPath, [...records.values()]);
    generated += 1;
    console.log(`[ok] ${candidate.key}@attempt-${candidate.attempt} -> ${imageRel} (${result.buffer.length} bytes, ${info.width}x${info.height}, ${info.mime})`);
  }

  const normalized = [...records.values()].map((record: any) =>
    record.attempt ? record : Object.assign({}, record, { attempt: 1 }))
    .sort((a: any, b: any) => (a.recordId || a.key).localeCompare(b.recordId || b.key));
  writeJsonAtomic(manifestPath, normalized);
  console.log(JSON.stringify({ output, generated, reused, failed }, null, 2));

  const verified = verifyOutput(output);
  console.log(`verification: ${verified.checked}/${verified.total} images pass mechanical checks`);
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

export = {
  planAllBatches, artistBatch, popularBatch, latestLoraBatch,
  reviewOverrideJobs, buildAttemptTwo, buildAttemptThree, buildAttemptFour,
  reviewAttemptThreeJobs, reviewAttemptFourJobs,
  buildArtistPrompt, buildStudioPrompt, buildPopularPrompt,
  assertNotShowcase, imageInfo, verifyOutput, shouldReuse, recordIdOf, imageRelFor, filterPlanned,
  REVIEW_OVERRIDES, ATTEMPT_3_OVERRIDES, ATTEMPT_4_OVERRIDES,
  constants: {
    DEFAULT_OUTPUT, MANIFEST_NAME, REVIEW_INDEX_NAME, CONTACT_SHEET_NAME,
    WAI_PROFILE_ID, WAI_MODEL_ID, WAI_CHECKPOINT, ANIMA_BASE_ID, ANIMA_AESTHETIC_ID,
    POPULAR_BLUEPRINT_ID, DEFAULT_LORA_STRENGTH, STUDIO_CHAR_PROMPT, ARTIST_NEUTRAL_SUBJECT,
  },
};
