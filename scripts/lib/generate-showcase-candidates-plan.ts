'use strict';

// generate-showcase-candidates: batch and review-attempt planning.
const promptPolicy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
const popularContent: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');
const artistCatalog: typeof import('../../src/config/artistStyleCatalog.ts') = require('../../src/config/artistStyleCatalog.ts');
const kreaRecipes: typeof import('../../src/config/kreaStyleRecipes.ts') = require('../../src/config/kreaStyleRecipes.ts');
const qualityPromptContract: typeof import('../maintenance/quality-prompt-contract.js') = require('../maintenance/quality-prompt-contract.js');
const genConst: any = (require('../../routes/generation.js') as typeof import('../../routes/generation.js')).constants;
const animaConst = (require('../../routes/anima.js') as typeof import('../../routes/anima.js')).constants;
const presets: typeof import('../../data/presets.json') = require('../../data/presets.json');
const { resolveModelProfile } = promptPolicy;
const {
  waiProfile, buildArtistPrompt, buildPopularPrompt, loraMetaById, buildStudioPrompt, kreaProfile,
  buildArtistPromptFor,
}: typeof import('./generate-showcase-candidates-prompts.js') = require('./generate-showcase-candidates-prompts.js');
const {
  WAI_MODEL_ID, WAI_CHECKPOINT, popularData, blueprintData, ANIMA_AESTHETIC_ID, DEFAULT_LORA_STRENGTH,
  REVIEW_OVERRIDES, ATTEMPT_3_OVERRIDES, ATTEMPT_4_OVERRIDES, KREA_MODEL_ID,
}: typeof import('./generate-showcase-candidates-settings.js') = require('./generate-showcase-candidates-settings.js');
const { stableSeed }: typeof import('./generate-showcase-candidates-support.js') = require('./generate-showcase-candidates-support.js');

// ── batch planning ─────────────────────────────────────────────────────────

function artistBatch(seedBase: any) {
  const artists = [...artistCatalog.ARTIST_STYLE_OPTIONS];
  const size = waiProfile().size.match(/(\d+)\s*[x×]\s*(\d+)/i);
  const width = size ? Number(size[1]) : 1024;
  const height = size ? Number(size[2]) : 1344;
  const records: any[] = [];
  records.push({ key: 'no-artist', artistId: '', displayName: 'no-artist baseline' });
  artists.forEach((artist: any) => records.push({ key: artist.id, artistId: artist.id, displayName: artist.name }));
  return records.map((record: any) => {
    const { prompt, negative } = buildArtistPrompt(record.artistId ? record.artistId : null, undefined);
    return {
      batch: 'artist',
      key: `artist:${record.key}`,
      subject: 'neutral-adult-female',
      sceneId: 'artist-city-street',
      characterId: '',
      artistId: record.artistId,
      displayName: record.displayName,
      engine: 'sd',
      modelId: WAI_MODEL_ID,
      checkpoint: WAI_CHECKPOINT,
      loraId: '',
      loraFile: '',
      loraStrength: null,
      seed: seedBase,
      width, height,
      steps: 30, cfg: 6, sampler: 'Euler a', scheduler: 'normal',
      prompt, negative,
    };
  });
}

/** 默认衣装样张必须选同衣装的全年龄场景，不能因排序选中成人条目。 */
function characterDefaultBlueprint(blueprints: any, characterId: any, outfitId: any) {
  const match = blueprints.find((bp: any) => bp.characterId === characterId && !bp.adult && bp.outfitId === outfitId)
    || blueprints.find((bp: any) => !bp.characterId && !bp.adult);
  if (!match) throw new Error(`no safe default-outfit blueprint for ${characterId}`);
  return match;
}

function popularBatch(seedBase: any) {
  const characters = popularContent.parsePopularCharacters(popularData);
  const blueprints = popularContent.parseSceneBlueprints(blueprintData);
  const profile = resolveModelProfile(presets.model_profiles as any, ANIMA_AESTHETIC_ID, 'anima');
  if (!profile) throw new Error('anima_aesthetic_v11 profile missing');
  return characters.map((character: any) => {
    const blueprint = characterDefaultBlueprint(blueprints, character.id, popularContent.defaultOutfit(character).id);
    const { prompt, negative, outfit } = buildPopularPrompt(character, blueprint, profile, undefined);
    const model = animaConst.MODELS[ANIMA_AESTHETIC_ID];
    const size = blueprint.recommendedSize.match(/(\d+)\s*[x×]\s*(\d+)/i);
    return {
      batch: 'popular',
      key: `popular:${character.id}`,
      subject: character.id,
      sceneId: blueprint.id,
      characterId: character.id,
      artistId: '',
      displayName: `${character.displayName} (${character.franchise})`,
      engine: 'anima',
      modelId: ANIMA_AESTHETIC_ID,
      checkpoint: model.file,
      loraId: '',
      loraFile: '',
      loraStrength: null,
      seed: stableSeed(`popular:${character.id}:${seedBase}`),
      width: size ? Number(size[1]) : 832,
      height: size ? Number(size[2]) : 1216,
      steps: 24, cfg: 3.0, sampler: 'res_multistep', scheduler: 'simple',
      prompt, negative,
      recommendedEngine: character.recommendedEngine,
      engineOverride: character.recommendedEngine === ANIMA_AESTHETIC_ID ? '' : character.recommendedEngine,
      outfitId: outfit.id,
      adultEligibility: character.adultEligibility,
    };
  });
}

function latestLoraBatch(seedBase: any) {
  const charConfigs = [
    { characterId: 'nene', label: '绫地宁宁', sdLoraId: 'L_NENE_V18_WD14', animaLoraId: 'L_NENE_V21_ANIMA' },
    { characterId: 'natsume', label: '四季夏目', sdLoraId: 'L_NAT_V18_WD14', animaLoraId: 'L_NAT_V21_ANIMA' },
  ];
  const engineSpecs = [
    ['sd', 'wai', WAI_MODEL_ID, genConst.CHECKPOINT, 30, 6, 'Euler a', 'normal'],
    ['anima', 'anima', ANIMA_AESTHETIC_ID, animaConst.MODELS[ANIMA_AESTHETIC_ID].file, 24, 3.0, 'res_multistep', 'simple'],
  ];
  const loraFileFor = (loraId: any) => {
    const genLora = genConst.LORAS[loraId];
    if (genLora) return genLora.file;
    const animaLora = animaConst.LORAS[loraId];
    if (animaLora) return animaLora.file;
    return loraMetaById(loraId).name;
  };
  const compositionSpecs = [
    ['closeup', '近景身份', 1024, 1024],
    ['fullbody', '官方服装/全身', 832, 1216],
  ];
  const records: any[] = [];
  charConfigs.forEach((config: any) => {
    engineSpecs.forEach(([engine, engineLabel, modelId, checkpoint, steps, cfg, sampler, scheduler]: any) => {
      const loraId = engine === 'sd' ? config.sdLoraId : config.animaLoraId;
      compositionSpecs.forEach(([composition, compoLabel, width, height]: any) => {
        const { prompt, negative } = buildStudioPrompt({ engine, characterId: config.characterId, composition, loraId });
        records.push({
          batch: 'latest-lora',
          key: `latest-lora:${config.characterId}:${engine}:${composition}`,
          subject: `${config.characterId}-${composition}`,
          sceneId: composition,
          characterId: config.characterId,
          artistId: '',
          displayName: `${config.label} · ${compoLabel} · ${engineLabel.toUpperCase()}`,
          engine,
          modelId,
          checkpoint,
          loraId,
          loraFile: loraFileFor(loraId),
          loraStrength: DEFAULT_LORA_STRENGTH,
          seed: stableSeed(`latest-lora:${config.characterId}:${engine}:${composition}:${seedBase}`),
          width, height,
          steps, cfg, sampler, scheduler,
          prompt, negative,
        });
      });
    });
  });
  return records;
}

function reviewOverrideJobs(basePlan: any) {
  const byKey = new Map(basePlan.map((candidate: any) => [candidate.key, candidate]));
  return Object.keys(REVIEW_OVERRIDES).map((key: any) => {
    const base = byKey.get(key);
    if (!base) throw new Error(`review override key ${key} is not part of the candidate plan`);
    return buildAttemptTwo(base, REVIEW_OVERRIDES[key]);
  });
}

function rebuildWithOverride(base: any, override: any) {
  if (base.batch === 'artist') {
    const { prompt, negative } = buildArtistPrompt(base.artistId || null, override);
    return Object.assign({}, base, { prompt, negative });
  }
  if (base.batch === 'popular') {
    const characters = popularContent.parsePopularCharacters(popularData);
    const blueprints = popularContent.parseSceneBlueprints(blueprintData);
    const character: any = popularContent.findCharacter(characters, base.subject);
    const blueprint = popularContent.findBlueprint(blueprints, base.sceneId)
      || characterDefaultBlueprint(blueprints, base.subject, popularContent.defaultOutfit(character).id);
    const profile = resolveModelProfile(presets.model_profiles as any, ANIMA_AESTHETIC_ID, 'anima');
    const { prompt, negative } = buildPopularPrompt(character, blueprint, profile, override);
    return Object.assign({}, base, { prompt, negative });
  }
  if (base.batch === 'latest-lora') {
    const { prompt, negative } = buildStudioPrompt({
      engine: base.engine,
      characterId: base.characterId,
      composition: base.sceneId,
      loraId: base.loraId,
      override,
    });
    return Object.assign({}, base, { prompt, negative });
  }
  throw new Error(`review override not supported for batch ${base.batch}`);
}

function buildReviewAttempt(base: any, override: any, attempt: any, supersedes: any) {
  const rebuilt = rebuildWithOverride(base, override);
  return Object.assign({}, rebuilt, {
    attempt,
    recordId: `${base.key}@attempt-${attempt}`,
    supersedes,
    reviewReason: override.reviewReason,
    seed: (base.seed + (Number(override.seedOffset) || 0)) % 2147483647,
    // attempt-4 may override the base size (960x1536) to keep facial
    // micro-features legible at full-body scale; earlier attempts keep their
    // planned size because they carry no width/height override.
    width: Number(override.width) || rebuilt.width,
    height: Number(override.height) || rebuilt.height,
  });
}

function buildAttemptTwo(base: any, override: any) {
  return buildReviewAttempt(base, override, 2, `${base.key}@attempt-1`);
}

function buildAttemptThree(base: any, override: any) {
  // supersedes the key's attempt-2 when that key has one, otherwise attempt-1.
  const supersedes = REVIEW_OVERRIDES[base.key]
    ? `${base.key}@attempt-2`
    : `${base.key}@attempt-1`;
  return buildReviewAttempt(base, override, 3, supersedes);
}

function buildAttemptFour(base: any, override: any) {
  // supersedes the key's latest prior attempt: attempt-3 when that key has one,
  // otherwise attempt-2 when present, otherwise attempt-1.
  const prior = ATTEMPT_3_OVERRIDES[base.key] ? 3 : REVIEW_OVERRIDES[base.key] ? 2 : 1;
  return buildReviewAttempt(base, override, 4, `${base.key}@attempt-${prior}`);
}

function reviewAttemptThreeJobs(basePlan: any) {
  const byKey = new Map(basePlan.map((candidate: any) => [candidate.key, candidate]));
  return Object.keys(ATTEMPT_3_OVERRIDES).map((key: any) => {
    const base = byKey.get(key);
    if (!base) throw new Error(`attempt-3 key ${key} is not part of the candidate plan`);
    return buildAttemptThree(base, ATTEMPT_3_OVERRIDES[key]);
  });
}

function reviewAttemptFourJobs(basePlan: any) {
  const byKey = new Map(basePlan.map((candidate: any) => [candidate.key, candidate]));
  return Object.keys(ATTEMPT_4_OVERRIDES).map((key: any) => {
    const base = byKey.get(key);
    if (!base) throw new Error(`attempt-4 key ${key} is not part of the candidate plan`);
    return buildAttemptFour(base, ATTEMPT_4_OVERRIDES[key]);
  });
}

function nearestSize(engine: any, blueprint: any) {
  const explicit = String(blueprint.recommendedSize || '');
  const match = explicit.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  const desired = match ? [Number(match[1]), Number(match[2])] : [832, 1216];
  const sizes = engine === 'krea2'
    ? ['1024x1024', '1024x1536', '1536x1024']
    : ['832x1216', '1024x1024', '1216x832'];
  const ratio = desired[0] / desired[1];
  const nearest = sizes
    .map((size: any) => {
      const [w, h] = size.split('x').map(Number);
      return { size, w, h, delta: Math.abs(w / h - ratio) };
    })
    .sort((a: any, b: any) => a.delta - b.delta)[0];
  return { width: nearest.w, height: nearest.h };
}

function popularGridBatch(seedBase: any) {
  const characters = popularContent.parsePopularCharacters(popularData);
  const blueprints = popularContent.parseSceneBlueprints(blueprintData);
  const animaProfile = resolveModelProfile(presets.model_profiles as any, ANIMA_AESTHETIC_ID, 'anima');
  const krea = kreaProfile();
  if (!animaProfile || !krea) throw new Error('anima_aesthetic_v11 / krea2_turbo_fp8 profile missing');
  const records: any[] = [];
  for (const character of characters) {
    // 角色感知：只枚举该角色的专属原型场景 + 通用成人蓝图（fail-closed）。
    const eligible = popularContent.eligibleBlueprints(blueprints, character, { adultEnabled: true });
    for (const blueprint of eligible) {
      for (const engine of ['anima', 'krea2'] as const) {
        const profile = engine === 'anima' ? animaProfile : krea;
        const decisions = popularContent.inferBlueprintDecisions(blueprint);
        const style = kreaRecipes.resolveStyleRecipe(
          kreaRecipes.KREA_STYLE_RECIPES,
          engine,
          blueprint,
          null,
          character.adultEligibility === 'adult' ? { adultEligibility: 'adult' } : null,
          { adultEnabled: true },
        );
        const result = popularContent.buildPopularPromptPlan({
          character,
          outfit: popularContent.defaultOutfit(character),
          blueprint,
          engine,
          profile,
          adultEnabled: true,
          shot: decisions.shot,
          lighting: decisions.lighting,
          composition: decisions.composition,
          style: style ? {
            lead: style.lead,
            medium: style.medium,
            sd: style.sd,
            adult: style.adult === true,
          } : undefined,
        });
        if (!result) continue;
        const size = nearestSize(engine, blueprint);
        const model = engine === 'anima' ? animaConst.MODELS[ANIMA_AESTHETIC_ID] : animaConst.MODELS[KREA_MODEL_ID];
        records.push({
          batch: 'popular-grid',
          key: `popular-grid:${character.id}:${blueprint.id}:${engine}`,
          subject: character.id,
          sceneId: blueprint.id,
          characterId: character.id,
          artistId: '',
          displayName: `${character.displayName} / ${blueprint.title}${result.adult ? ' (R18)' : ''}`,
          engine,
          modelId: engine === 'anima' ? ANIMA_AESTHETIC_ID : KREA_MODEL_ID,
          checkpoint: model.file,
          loraId: '',
          loraFile: '',
          loraStrength: null,
          seed: stableSeed(`popular-grid:${character.id}:${blueprint.id}:${engine}:${seedBase}`),
          width: size.width,
          height: size.height,
          steps: engine === 'anima' ? 24 : 8,
          cfg: engine === 'anima' ? 3.0 : 1,
          sampler: engine === 'anima' ? 'res_multistep' : 'euler',
          scheduler: 'simple',
          prompt: result.prompt,
          negative: result.negative || '',
          adult: result.adult,
          recommendedEngine: character.recommendedEngine,
          engineOverride: character.recommendedEngine === engine ? '' : character.recommendedEngine,
          outfitId: popularContent.defaultOutfit(character).id,
          adultEligibility: character.adultEligibility,
        });
      }
    }
  }
  return records;
}

function artistGridBatch(seedBase: any) {
  const artists = [...artistCatalog.ARTIST_STYLE_OPTIONS];
  const records: any[] = [];
  for (const engine of ['anima', 'krea2']) {
    const entries = [{ key: 'no-artist', artistId: '', displayName: 'no-artist baseline' }]
      .concat(artists.map((artist: any) => ({ key: artist.id, artistId: artist.id, displayName: artist.name })));
    for (const entry of entries) {
      const { prompt, negative } = buildArtistPromptFor(engine, entry.artistId || null);
      const width = engine === 'krea2' ? 1024 : 832;
      const height = engine === 'krea2' ? 1536 : 1216;
      records.push({
        batch: 'artist-grid',
        key: `artist-grid:${entry.key}:${engine}`,
        subject: 'neutral-adult-female',
        sceneId: 'artist-city-street',
        characterId: '',
        artistId: entry.artistId,
        displayName: `${entry.displayName} (${engine})`,
        engine,
        modelId: engine === 'anima' ? ANIMA_AESTHETIC_ID : KREA_MODEL_ID,
        checkpoint: engine === 'anima' ? animaConst.MODELS[ANIMA_AESTHETIC_ID].file : animaConst.MODELS[KREA_MODEL_ID].file,
        loraId: '',
        loraFile: '',
        loraStrength: null,
        seed: stableSeed(`artist-grid:${entry.key}:${engine}:${seedBase}`),
        width,
        height,
        steps: engine === 'anima' ? 24 : 8,
        cfg: engine === 'anima' ? 3.0 : 1,
        sampler: engine === 'anima' ? 'res_multistep' : 'euler',
        scheduler: 'simple',
        prompt,
        negative,
      });
    }
  }
  return records;
}

function planAllBatches(seedBase: any) {
  const base = [
    ...artistBatch(seedBase),
    ...popularBatch(seedBase),
    ...latestLoraBatch(seedBase),
    ...popularGridBatch(seedBase),
    ...artistGridBatch(seedBase),
  ].map((candidate: any) => Object.assign({}, candidate, {
    attempt: 1,
    recordId: `${candidate.key}@attempt-1`,
  }));
  const withTwo = base.concat(reviewOverrideJobs(base));
  const withThree = withTwo.concat(reviewAttemptThreeJobs(base));
  return withThree.concat(reviewAttemptFourJobs(base)).map((candidate: any) => Object.assign({}, candidate, {
    promptHealth: qualityPromptContract.inspectCandidatePrompt(candidate),
  }));
}

/**
 * Pure candidate filter shared by the CLI and tests. An empty filter list means
 * "no constraint". `attempts` narrows to specific review rounds, so
 * `--keys a,b,c --attempt 3` selects only the attempt-3 candidates for those
 * keys instead of every attempt (the existing `--keys` behaviour of including
 * all attempts stays intact when `--attempt` is absent).
 */
function filterPlanned(planned: any, filters: any) {
  const batch = (filters && filters.batch) || [];
  const keys = (filters && filters.keys) || [];
  const attempts = (filters && filters.attempts) || [];
  return planned.filter((candidate: any) =>
    (!batch.length || batch.includes(candidate.batch))
    && (!keys.length || keys.includes(candidate.key))
    && (!attempts.length || attempts.includes(candidate.attempt)));
}

export = {
  planAllBatches, filterPlanned, artistBatch, popularBatch, latestLoraBatch, reviewOverrideJobs,
  buildAttemptTwo, buildAttemptThree, buildAttemptFour, reviewAttemptThreeJobs, reviewAttemptFourJobs,
};
