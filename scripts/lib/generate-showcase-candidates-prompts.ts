'use strict';

// generate-showcase-candidates: production prompt assembly.
const promptPolicy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
const promptCompiler: typeof import('../../src/utils/promptCompiler.ts') = require('../../src/utils/promptCompiler.ts');
const popularContent: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');
const popularPrompt: typeof import('../../src/utils/popularPromptBuilder.ts') = require('../../src/utils/popularPromptBuilder.ts');
const blueprintDecisions: typeof import('../../src/utils/popularBlueprintDecisions.ts') = require('../../src/utils/popularBlueprintDecisions.ts');
const { artistStyleProse, artistTagsForEngine }: typeof import('../../src/config/artistStyles.ts') = require('../../src/config/artistStyles.ts');
const genConst: any = (require('./generation/sd-catalog.js') as typeof import('./generation/sd-catalog.js'));
const presets: typeof import('../../data/presets.json') = require('../../data/presets.json');
const loraData: typeof import('../../data/loras.json') = require('../../data/loras.json');
const { createPromptPlan, renderPromptPlan } = promptCompiler;
const {
  assembleNegative, formatPromptForEngine, resolveModelProfile, profileRatingTag,
} = promptPolicy;
const {
  WAI_PROFILE_ID, ARTIST_NEUTRAL_SUBJECT, ANIMA_AESTHETIC_ID, STUDIO_CHAR_PROMPT,
  DEFAULT_LORA_STRENGTH, KREA_MODEL_ID,
}: typeof import('./generate-showcase-candidates-settings.js') = require('./generate-showcase-candidates-settings.js');

function profileById(id: any): any {
  const profile = (presets.model_profiles || []).find((item: any) => item.id === id);
  if (!profile) throw new Error(`presets.json missing profile ${id}`);
  return profile;
}

function loraMetaById(id: any) {
  const meta = (loraData || []).find((item: any) => item.id === id);
  if (!meta) throw new Error(`loras.json missing LoRA ${id}`);
  return meta;
}

function appendNegative(negative: any, tokens: any, engine: any, profile: any) {
  if (!tokens || !tokens.length) return negative;
  const extra = engine === 'anima' && profile
    ? formatPromptForEngine(tokens.join(', '), 'anima', profile.exact_tokens, profile.exact_prefixes)
    : tokens.join(', ');
  return [negative, extra].filter(Boolean).join(', ');
}

// ── prompt assembly (production pipeline only) ─────────────────────────────

function waiProfile() { return profileById(WAI_PROFILE_ID); }

function buildArtistPrompt(artistTag: any, override?: any) {
  const profile: any = waiProfile();
  const artists = override && override.artistTag
    ? [override.artistTag]
    : (artistTag ? [artistTag] : []);
  const plan = createPromptPlan({
    profile,
    identity: ARTIST_NEUTRAL_SUBJECT.identity,
    controls: [...ARTIST_NEUTRAL_SUBJECT.controls],
    artists,
    rating: profileRatingTag(profile, { rating: 'ALL' }),
  });
  const rendered = renderPromptPlan(plan, 'sd', profile);
  let prompt = rendered.prompt;
  if (override && override.promptAppend) {
    prompt = `${prompt}, ${override.promptAppend.join(', ')}`;
  }
  let negative = assembleNegative(profile, { rating: 'ALL' }, 'sd', { shot: 'medium' });
  negative = appendNegative(negative, override && override.negativeAppend, 'sd', null);
  return { prompt, negative };
}

// 双引擎画师 prompt：Anima 用 @artist 原生标签；Krea2 用自然语言风格短语。
function buildArtistPromptFor(engine: any, artistId: any) {
  if (engine === 'krea2') {
    const plan = createPromptPlan({
      subjectProse: 'A young adult woman with long brown hair and amber eyes',
      outfitProse: 'a white shirt under an open casual jacket',
      sceneProse: 'standing on a city street outdoors in the daytime',
      style: ['A polished anime key visual'],
      artistProse: artistId ? artistStyleProse([artistId]) : '',
      rating: 'safe',
    });
    const rendered = renderPromptPlan(plan, 'krea2', kreaProfile());
    return { prompt: rendered.prompt, negative: '' };
  }
  const base = resolveModelProfile(presets.model_profiles as any, ANIMA_AESTHETIC_ID, 'anima');
  const plan = createPromptPlan({
    profile: base,
    identity: ARTIST_NEUTRAL_SUBJECT.identity,
    controls: [...ARTIST_NEUTRAL_SUBJECT.controls],
    artists: artistId ? artistTagsForEngine([artistId], 'anima') : [],
    rating: profileRatingTag(base, { rating: 'ALL' }),
  });
  const rendered = renderPromptPlan(plan, 'anima', base);
  const negative = assembleNegative(base, { rating: 'ALL' }, 'anima', { shot: 'medium' });
  return { prompt: rendered.prompt, negative };
}

function buildStudioPrompt({ engine, characterId, composition, loraId, override }: any) {
  const charPrompt = STUDIO_CHAR_PROMPT[characterId];
  const loraMeta: any = loraId ? loraMetaById(loraId) : null;
  const closeup = composition === 'closeup';
  const scene = closeup
    ? { rating: 'ALL', prompt: 'close_up' }
    : {
        rating: 'ALL',
        prompt: characterId === 'nene' ? 'nene_witch_canonical, full_body' : 'natsume_official_qipao, full_body',
      };
  const activeLoras = {
    nene: engine === 'sd' ? genConst.LORAS.L_NENE_V18_WD14.file : loraId,
    natsume: engine === 'sd' ? genConst.LORAS.L_NAT_V18_WD14.file : loraId,
  };
  const controls = promptPolicy.characterControlTokens(scene, characterId, activeLoras);
  const camera = override && override.camera
    ? [override.camera]
    : (closeup ? ['close_up'] : ['full_body']);

  if (engine === 'sd') {
    const profile: any = waiProfile();
    const plan = createPromptPlan({
      profile,
      identity: charPrompt,
      controls,
      camera,
      rating: profileRatingTag(profile, scene),
    });
    const rendered = renderPromptPlan(plan, 'sd', profile);
    const loraTag = `<lora:${loraMeta.name}:${DEFAULT_LORA_STRENGTH}>`;
    let prompt = `${rendered.prompt}, ${loraTag}`;
    if (override && override.promptAppend) prompt = `${prompt}, ${override.promptAppend.join(', ')}`;
    let negative = assembleNegative(profile, scene, 'sd', { shot: closeup ? 'close' : 'wide' });
    negative = appendNegative(negative, override && override.negativeAppend, 'sd', null);
    return { prompt, negative };
  }

  // Anima: merge the LoRA prompt contract (exact tokens/prefixes) into the
  // base profile exactly like usePromptAssembly does at runtime.
  const base = profileById('anima_base_v10');
  const contract = loraMeta && loraMeta.prompt_contract
    ? { tokens: loraMeta.prompt_contract.exact_tokens || [], prefixes: loraMeta.prompt_contract.exact_prefixes || [] }
    : { tokens: [], prefixes: [] };
  const profile: any = Object.assign({}, base, {
    exact_tokens: [...new Set([...(base.exact_tokens || []), ...contract.tokens])],
    exact_prefixes: [...new Set([...(base.exact_prefixes || []), ...contract.prefixes])],
  });
  const plan = createPromptPlan({
    profile,
    identity: charPrompt,
    controls,
    camera,
    rating: profileRatingTag(profile, scene),
  });
  const rendered = renderPromptPlan(plan, 'anima', profile);
  let prompt = rendered.prompt;
  if (override && override.promptAppend) {
    prompt = `${prompt}, ${formatPromptForEngine(override.promptAppend.join(', '), 'anima', profile.exact_tokens, profile.exact_prefixes)}`;
  }
  let negative = assembleNegative(profile, scene, 'anima', { shot: closeup ? 'close' : 'wide' });
  negative = appendNegative(negative, override && override.negativeAppend, 'anima', profile);
  return { prompt, negative };
}

function buildPopularPrompt(character: any, blueprint: any, profile: any, override: any) {
  const outfit = popularContent.defaultOutfit(character);
  const decisions = blueprintDecisions.inferBlueprintDecisions(blueprint);
  const result = popularPrompt.buildPopularPromptPlan({
    character,
    outfit,
    blueprint,
    engine: 'anima',
    profile,
    adultEnabled: false,
    shot: decisions.shot,
    lighting: decisions.lighting,
    composition: decisions.composition,
  });
  if (!result) throw new Error(`popular prompt build failed for ${character.id}`);
  let prompt = result.prompt;
  if (override && override.promptAppend) {
    prompt = `${prompt}, ${formatPromptForEngine(override.promptAppend.join(', '), 'anima', profile && profile.exact_tokens, profile && profile.exact_prefixes)}`;
  }
  let negative = result.negative;
  negative = appendNegative(negative, override && override.negativeAppend, 'anima', profile);
  return { prompt, negative, outfit, decisions };
}

// ── 双引擎全矩阵批次（2026-08-13）───────────────────────────────────────────
// 热门角色：18 角色 × 24 蓝图 × {anima, krea2}，adultEnabled=true（3 成人角色 ×
// 3 成人蓝图 = 每引擎 9 张 R18）。fail-closed 过滤后每引擎 387 组合，双引擎 774。
// 画师：12 画师 + no-artist baseline × {anima, krea2}。

function kreaProfile() {
  return resolveModelProfile(presets.model_profiles as any, KREA_MODEL_ID, 'krea2');
}

export = {
  waiProfile, buildArtistPrompt, buildPopularPrompt, loraMetaById, buildStudioPrompt, kreaProfile,
  buildArtistPromptFor,
};
