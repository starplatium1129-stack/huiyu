#!/usr/bin/env node
'use strict';

/**
 * Generate a fresh, isolated candidate for every current preset scene.
 *
 * Single-character scenes use the audited sc300-style short prompt contract.
 * The six dual-character scenes reuse the production WAI dual-LoRA path because
 * the Anima route intentionally supports only one character LoRA. Nothing is
 * written into SceneShowcase.
 */

const crypto: typeof import('crypto') = require('crypto');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const promptPolicy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
const promptCompiler: typeof import('../../src/utils/promptCompiler.ts') = require('../../src/utils/promptCompiler.ts');
const sceneInference: typeof import('../../src/utils/sceneInference.ts') = require('../../src/utils/sceneInference.ts');
const promptConstants: typeof import('../../src/config/promptConstants.ts') = require('../../src/config/promptConstants.ts');
const generationConstants = (require('../../routes/generation.js') as typeof import('../../routes/generation.js')).constants;
const animaConstants = (require('../../routes/anima.js') as typeof import('../../routes/anima.js')).constants;
const animaGenerationContract: typeof import('../../server/anima-generation-contract.js') = require('../../server/anima-generation-contract.js');
const { buildShortPrompt }: typeof import('./short-prompt-builder.js') = require('./short-prompt-builder.js');

const scenes: typeof import('../../data/scenes.json') = require('../../data/scenes.json');
const presets: typeof import('../../data/presets.json') = require('../../data/presets.json');
const loraData: typeof import('../../data/loras.json') = require('../../data/loras.json');

const ROOT = path.resolve(__dirname, '..', '..');
const AI_ROOT = path.resolve(ROOT, '..', 'AI');
const SHOWCASE_ROOT = path.resolve(AI_ROOT, 'SceneShowcase');
const DEFAULT_OUTPUT = path.join(AI_ROOT, 'Reviews', 'SceneShowcaseRefresh', '2026-08-12_current-prompts');
const MANIFEST_NAME = 'generation-manifest.json';
const ANIMA_MODEL_ID = 'anima-base-v1.0';
const ANIMA_PROFILE_ID = 'anima_base_v10';
const WAI_MODEL_ID = 'waiIllustriousSDXL_v170';
const WAI_PROFILE_ID = 'wai_illustrious_v17';
const CHAR_PROMPT = Object.freeze({
  triad: '2girls',
});
const ANIMA_LORA_BY_CHARACTER = Object.freeze({
  nene: 'L_NENE_V21_ANIMA',
  natsume: 'L_NAT_V21_ANIMA',
});
const WAI_LORA_BY_CHARACTER = Object.freeze({
  nene: 'L_NENE_V18_WD14',
  natsume: 'L_NAT_V18_WD14',
});

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function splitList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}
function stableSeed(sceneId, attempt) {
  const digest = crypto.createHash('sha256').update(`scene-showcase-current-2026-08-12:${sceneId}:${attempt}`).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}
function assertIsolated(output) {
  const resolved = path.resolve(output);
  if (resolved === SHOWCASE_ROOT || resolved.startsWith(SHOWCASE_ROOT + path.sep)) {
    throw new Error(`refusing to write candidates into public showcase: ${resolved}`);
  }
  return resolved;
}
function profileById(id) {
  const profile = (presets.model_profiles || []).find(item => item.id === id);
  if (!profile) throw new Error(`presets.json missing profile ${id}`);
  return profile;
}
function loraById(id) {
  const lora = loraData.find(item => item.id === id);
  if (!lora) throw new Error(`loras.json missing ${id}`);
  return lora;
}
function optionPrompt(options, id) {
  return (options.find(item => item.id === id) || {}).prompt || '';
}
function nearestAnimaSize(scene) {
  const desired = sceneInference.sceneRecommendedSize(scene);
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
function waiSize(scene) {
  const explicit = sceneInference.sceneRecommendedSize(scene);
  const match = explicit.match(/^(\d+)x(\d+)$/);
  if (!match) return { width: 832, height: 1216 };
  const width = Math.max(512, Math.min(1536, Math.round(Number(match[1]) / 64) * 64));
  const height = Math.max(512, Math.min(2048, Math.round(Number(match[2]) / 64) * 64));
  return { width, height };
}
function animaProfileFor(loraId) {
  const base = profileById(ANIMA_PROFILE_ID);
  const contract = loraById(loraId).prompt_contract || {};
  return Object.assign({}, base, {
    exact_tokens: [...new Set([...(base.exact_tokens || []), ...(contract.exact_tokens || [])])],
    exact_prefixes: [...new Set([...(base.exact_prefixes || []), ...(contract.exact_prefixes || [])])],
  });
}
function inferredDirectives(scene) {
  const shot = sceneInference.sceneShot(scene);
  const lighting = sceneInference.sceneLighting(scene);
  const composition = sceneInference.sceneComposition(scene);
  return {
    shot,
    lighting,
    composition,
    cameraPrompt: shot ? optionPrompt(promptConstants.SHOT, shot) : '',
    lightingPrompt: lighting ? optionPrompt(promptConstants.LIGHTING, lighting) : '',
    compositionPrompt: composition ? optionPrompt(promptConstants.COMPOSITION, composition) : '',
  };
}
function buildAnimaCandidate(scene, attempt, seedAttempt = attempt) {
  const characterId = scene.char;
  const loraId = ANIMA_LORA_BY_CHARACTER[characterId];
  if (!loraId) throw new Error(`scene ${scene.id} has unsupported Anima character ${characterId}`);
  const profile = animaProfileFor(loraId);
  const directives = inferredDirectives(scene);
  const built = buildShortPrompt(scene, characterId);
  if (!built.health.ok) {
    throw new Error(`scene ${scene.id} short prompt failed: ${built.health.errors.join('; ')}`);
  }
  const directorCaption = typeof scene.animaCaption === 'string'
    ? scene.animaCaption.trim()
    : '';
  const prompt = directorCaption
    ? `${built.prompt}\n${directorCaption}`
    : built.prompt;
  const generationCharacter = animaGenerationContract.requiredCharacterForLora(loraId);
  if (!generationCharacter) throw new Error(`scene ${scene.id} has unsupported Anima LoRA ${loraId}`);
  var negative = promptPolicy.assembleNegative(profile, scene, 'anima', {
    shot: directives.shot,
    character: characterId,
  });
  // Anima 长标签流在高 CFG 下稳定，但低 CFG/res_multistep 下偶发多格拼图：
  // 统一追加分屏/漫画格压制，生产路径与候选集同时受益。
  var ANIMA_PANEL_SUPPRESS = 'split image, split screen, split panel, two panels, diptych, triptych, comic strip, multiple frames, panel borders, frame borders, double exposure, double image, duplicated subject, duplicated body';
  if (negative) negative = negative + ', ' + ANIMA_PANEL_SUPPRESS;
  else negative = ANIMA_PANEL_SUPPRESS;
  // 单人场景强化"只有一个人"：Anima 低 CFG 下 intimate/POV 场景偶发自动补第二人。
  if (characterId !== 'triad') {
    negative = negative + ', multiple girls, extra girl, second person, additional woman, another woman, extra person, background person';
  }
  const [width, height] = nearestAnimaSize(scene).split('x').map(Number);
  const weight = Number(loraById(loraId).strength?.default) || 0.85;
  return {
    batch: 'scene', key: `scene:${scene.id}`, recordId: `scene:${scene.id}@attempt-${attempt}`,
    sceneId: scene.id, title: scene.title, category: scene.category, story: scene.story,
    characterId, rating: scene.rating, attempt,
    generationCharacter,
    engine: 'anima', profileId: profile.id, modelId: ANIMA_MODEL_ID,
    checkpoint: animaConstants.MODELS[ANIMA_MODEL_ID].file,
    loraId, loraFile: animaConstants.LORAS[loraId].file, loraStrength: weight,
    width, height,
    steps: animaGenerationContract.ANIMA_DEFAULTS.steps,
    cfg: animaGenerationContract.ANIMA_DEFAULTS.cfg,
    sampler: animaGenerationContract.ANIMA_DEFAULTS.sampler,
    scheduler: animaGenerationContract.ANIMA_DEFAULTS.scheduler,
    seed: stableSeed(scene.id, seedAttempt), prompt, negative,
    seedAttempt,
    promptHealth: built.health,
    animaCaption: directorCaption,
    sourcePrompt: scene.prompt || '', sourceNegative: scene.negative || '',
    inferred: directives,
  };
}
function buildDualCandidate(scene, attempt, seedAttempt = attempt) {
  const profile = profileById(WAI_PROFILE_ID);
  const directives = inferredDirectives(scene);
  const scenePrompt = promptPolicy.sceneTemplateText(scene, {
    char: 'triad',
    shot: directives.shot,
    engine: 'sd',
    profile,
  });
  const plan = promptCompiler.createPromptPlan({
    profile,
    identity: CHAR_PROMPT.triad,
    controls: promptPolicy.characterControlTokens(scene, 'triad', {
      nene: generationConstants.LORAS.L_NENE_V18_WD14.file,
      natsume: generationConstants.LORAS.L_NAT_V18_WD14.file,
    }),
    scenePrompt,
    camera: directives.cameraPrompt ? [directives.cameraPrompt] : [],
    lighting: directives.lightingPrompt ? [directives.lightingPrompt] : [],
    composition: directives.compositionPrompt ? [directives.compositionPrompt] : [],
    negative: scene.negative || '',
    rating: promptPolicy.profileRatingTag(profile, scene),
  });
  const rendered = promptCompiler.renderPromptPlan(plan, 'sd', profile);
  const loras = [
    { id: WAI_LORA_BY_CHARACTER.nene, strength: 0.52 },
    { id: WAI_LORA_BY_CHARACTER.natsume, strength: 0.52 },
  ];
  const tags = loras.map(item => `<lora:${path.basename(generationConstants.LORAS[item.id].file, '.safetensors')}:${item.strength}>`);
  const negative = promptPolicy.assembleNegative(profile, scene, 'sd', {
    shot: directives.shot,
    character: 'triad',
  });
  const { width, height } = waiSize(scene);
  return {
    batch: 'scene', key: `scene:${scene.id}`, recordId: `scene:${scene.id}@attempt-${attempt}`,
    sceneId: scene.id, title: scene.title, category: scene.category, story: scene.story,
    characterId: 'triad', rating: scene.rating, attempt,
    engine: 'sd', profileId: profile.id, modelId: WAI_MODEL_ID,
    checkpoint: generationConstants.CHECKPOINT, loras,
    width, height, steps: 30, cfg: 6, sampler: 'Euler a', scheduler: 'normal',
    seed: stableSeed(scene.id, seedAttempt), prompt: `${rendered.prompt}, ${tags.join(', ')}`, negative,
    seedAttempt,
    sourcePrompt: scene.prompt || '', sourceNegative: scene.negative || '',
    inferred: directives,
  };
}
function planScenes(selectedScenes, attempt, seedAttempt = attempt) {
  // 2026-08-16 审计：单条场景（评级与显式词不一致等）不再让整批计划爆炸——逐条
  // 隔离，失败的跳过并记入非枚举属性 skipped（含原因），其余正常规划。生产批量
  // 生成与契约测试都不再被一条坏数据卡死；不一致场景清单由调用方/测试核对。
  const candidates = [];
  const skipped = [];
  for (const scene of selectedScenes) {
    try {
      candidates.push(scene.char === 'triad'
        ? buildDualCandidate(scene, attempt, seedAttempt)
        : buildAnimaCandidate(scene, attempt, seedAttempt));
    } catch (error) {
      const message = String((error && error.message) || error);
      skipped.push({ sceneId: scene.id, title: scene.title, reason: message });
      console.warn(`[scene-showcase-candidates] 跳过场景 ${scene.id}（${scene.title}）：${message}`);
    }
  }
  Object.defineProperty(candidates, 'skipped', { value: skipped, enumerable: false });
  return candidates;
}

function applyBaselineContract(candidate, baseline) {
  if (!baseline || baseline.status !== 'succeeded') {
    throw new Error(`missing succeeded baseline for ${candidate.sceneId}`);
  }
  if (baseline.engine !== candidate.engine) {
    throw new Error(`baseline engine mismatch for ${candidate.sceneId}: ${baseline.engine} != ${candidate.engine}`);
  }
  const direction = String(candidate.prompt || '').split('\n').slice(1).join('\n').trim();
  const prompt = direction ? `${baseline.prompt}\n${direction}` : String(baseline.prompt || '');
  const baselineGenerationCharacter = baseline.generationCharacter
    || animaGenerationContract.requiredCharacterForLora(baseline.loraId)
    || candidate.generationCharacter;
  return Object.assign({}, candidate, {
    profileId: baseline.profileId,
    modelId: baseline.modelId,
    checkpoint: baseline.checkpoint,
    loraId: baseline.loraId,
    loraFile: baseline.loraFile,
    loraStrength: baseline.loraStrength,
    loras: baseline.loras,
    width: baseline.width,
    height: baseline.height,
    steps: baseline.steps,
    cfg: baseline.cfg,
    sampler: baseline.sampler,
    scheduler: baseline.scheduler,
    seed: baseline.seed,
    seedAttempt: baseline.attempt,
    prompt,
    promptHealth: candidate.promptHealth,
    animaCaption: candidate.animaCaption,
    generationCharacter: baselineGenerationCharacter,
    negative: baseline.negative,
    baselineRecordId: baseline.recordId,
    comparison: 'prompt-direction-only',
  });
}

async function gatewayJson(base, pathname, options) {
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
function buildSubmissionBody(candidate) {
  const anima = candidate.engine === 'anima';
  const body = {
    prompt: candidate.prompt, negative: candidate.negative,
    modelId: candidate.modelId, width: candidate.width, height: candidate.height,
    steps: candidate.steps, cfg: candidate.cfg, seed: candidate.seed,
  };
  if (anima) {
    body.loraId = candidate.loraId;
    body.loraStrength = candidate.loraStrength;
    body.character = candidate.generationCharacter;
  } else {
    body.profile = candidate.profileId;
    body.character = candidate.characterId;
    body.loras = candidate.loras;
    body.sampler = candidate.sampler;
    body.scheduler = '';
    body.hiresFix = false;
  }
  return body;
}
async function submitCandidate(base, candidate) {
  const anima = candidate.engine === 'anima';
  const route = anima ? '/api/anima/jobs' : '/api/generation/jobs';
  const body = buildSubmissionBody(candidate);
  const submitted = await gatewayJson(base, route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!submitted.response || submitted.response.status !== 202 || submitted.data?.ok !== true || !submitted.data.job?.id) {
    const status = submitted.response ? submitted.response.status : 'network';
    return { ok: false, error: `submission failed (${status}): ${submitted.error || JSON.stringify(submitted.data)}` };
  }
  let job = submitted.data.job;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const state = await gatewayJson(base, `${route}/${encodeURIComponent(job.id)}`);
    if (state.response?.ok && state.data?.ok && state.data.job) job = state.data.job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      return { ok: false, error: `job failed: ${job.error || job.status} (${job.code || ''})`, jobId: job.id };
    }
    if (job.status === 'succeeded' && job.resultUrl) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
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
  const baselineAttempt = Math.max(0, Number(argument('--baseline-attempt', '0')) || 0);
  const output = assertIsolated(path.resolve(argument('--output', DEFAULT_OUTPUT)));
  const gateway = argument('--gateway', 'http://127.0.0.1:3000');
  const limit = Math.max(1, Number(argument('--limit', '9999')) || 9999);
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  const selectedScenes = ids.length ? ids.map(id => scenes.find(scene => scene.id === id)) : scenes;
  const missing = ids.filter((id, index) => !selectedScenes[index]);
  if (missing.length) throw new Error(`unknown scene ids: ${missing.join(', ')}`);
  const manifestPath = path.join(output, MANIFEST_NAME);
  const existing = fs.existsSync(manifestPath) ? readJson(manifestPath) : [];
  const records = new Map(existing.map(record => [record.recordId, record]));
  let planned = planScenes(selectedScenes, attempt, seedAttempt);
  if (baselineAttempt) {
    planned = planned.map(candidate => applyBaselineContract(
      candidate,
      records.get(`scene:${candidate.sceneId}@attempt-${baselineAttempt}`),
    ));
  }
  if (dryRun) {
    console.log(JSON.stringify({ output, gateway, baselineAttempt, count: planned.length, candidates: planned }, null, 2));
    return;
  }

  fs.mkdirSync(output, { recursive: true });
  let generated = 0;
  let reused = 0;
  let failed = 0;
  for (const candidate of planned) {
    if (generated + reused >= limit) break;
    const previous = records.get(candidate.recordId);
    const imageRel = `images/${candidate.sceneId}/attempt-${attempt}.png`;
    const imageFile = path.join(output, imageRel.split('/').join(path.sep));
    if (!force && previous?.status === 'succeeded' && fs.existsSync(imageFile) && fs.statSync(imageFile).size > 1000) {
      console.log(`[reuse] ${candidate.recordId}`);
      reused += 1;
      continue;
    }
    console.log(`[generate] ${candidate.recordId} ${candidate.engine} ${candidate.width}x${candidate.height} seed ${candidate.seed}`);
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
  const normalized = [...records.values()].sort((left, right) => left.sceneId.localeCompare(right.sceneId) || left.attempt - right.attempt);
  writeJsonAtomic(manifestPath, normalized);
  console.log(JSON.stringify({ output, planned: planned.length, generated, reused, failed }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

export = {
  buildAnimaCandidate,
  buildDualCandidate,
  planScenes,
  applyBaselineContract,
  buildSubmissionBody,
  nearestAnimaSize,
  stableSeed,
  constants: { DEFAULT_OUTPUT, ANIMA_MODEL_ID, ANIMA_PROFILE_ID, CHAR_PROMPT, ANIMA_LORA_BY_CHARACTER },
};
