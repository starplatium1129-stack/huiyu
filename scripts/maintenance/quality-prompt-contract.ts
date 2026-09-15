'use strict';

const QUALITY_TOKENS = Object.freeze(['masterpiece', 'best_quality', 'score_7']);
const REQUIRED_ARTISTS = Object.freeze(['@muririn', '@kobuichi']);
const AMBIENCE_TOKENS = new Set([
  'backlight', 'backlit', 'rim_light', 'soft_rim_light',
  'volumetric_lighting', 'deep_depth_of_field', 'depth_of_field',
  'window_light', 'warm_lighting', 'soft_lighting', 'cool_lighting',
  'moonlight', 'lantern_light', 'golden_hour', 'soft_diffused_light',
  'overcast',
]);
const EXPLICIT_ADULT_TOKENS = new Set([
  'nude', 'naked', 'completely_naked', 'fully_nude', 'no_clothes',
  'breasts', 'nipples', 'pussy', 'spread_legs', 'sex', 'explicit',
]);
const IDENTITY_ANCHORS: any = Object.freeze({
  nene: Object.freeze([
    'ayachi_nene', '1girl', 'solo', 'white_hair', 'very_long_hair',
    'low_twintails', 'purple_eyes', 'ahoge', 'pink_hair_ribbons',
  ]),
  natsume: Object.freeze([
    'shiki_natsume', '1girl', 'solo', 'very_long_black_hair',
    'golden_yellow_eyes', 'two_red_hairclips', 'mole_under_eye',
    'no_hair_ribbon',
  ]),
});
const QUALITY_CONTROL_TOKEN: any = Object.freeze({
  nene: 'nene_r18',
  natsume: 'natsume_r18',
});
const REVIEW_DIMENSIONS = Object.freeze([
  'lighting', 'background', 'character', 'atmosphere', 'finish',
]);
const CAMERA_TOKENS = new Set([
  'close_up', 'medium_shot', 'upper_body', 'full_body', 'wide_shot',
  'three_quarter_view', 'side_view', 'profile', 'pov', 'low_angle',
  'high_angle', 'from_above', 'from_below', 'looking_down',
  'looking_at_viewer', 'eye_contact', 'cinematic_composition',
  'rule_of_thirds', 'centered_composition', 'landscape', 'portrait',
]);
const OUTFIT_TOKENS = new Set([
  'nene_school_uniform', 'school_uniform', 'blazer', 'yellow_bowtie',
  'plaid_skirt', 'pleated_skirt', 'grey_skirt', 'black_thighhighs',
  'zettai_ryouiki', 'nene_sailor_uniform', 'grey_sailor_collar',
  'black_shirt', 'sailor_shirt', 'serafuku', 'nene_red_cardigan_uniform',
  'cardigan', 'white_shirt', 'black_skirt', 'white_socks',
  'nene_witch_canonical', 'witch_hat', 'black_cape', 'criss-cross_halter',
  'crop_top', 'strap_between_breasts', 'pink_bow', 'pink_ribbon',
  'asymmetrical_legwear', 'striped_thighhighs', 'single_thighhigh',
  'single_sock', 'frilled_socks', 'midriff', 'nene_blue_pajamas',
  'pajamas', 'animal_print', 'cat_print', 'long_sleeves',
  'nene_green_sleepwear', 'sleepwear', 'nightgown', 'polka_dot',
  'short_sleeves', 'twin_braids', 'nene_bat_dress', 'black_dress',
  'asymmetrical_clothes', 'bat_hair_ornament', 'garter_straps',
  'nene_black_dress', 'skirt', 'thighhighs', 'natsume_official_qipao',
  'chinese_clothes', 'china_dress', 'red_dress', 'floral_print',
  'side_slit', 'hair_bun', 'double_bun', 'hair_flower', 'red_flower',
  'natsume_cafe_uniform', 'suspenders', 'suspender_skirt', 'brown_skirt',
  'collared_shirt', 'purple_ribbon', 'natsume_pink_cafe_uniform',
  'pink_shirt', 'pink_skirt', 'waist_apron', 'white_apron', 'frills',
  'striped', 'natsume_maid_uniform', 'maid', 'maid_apron',
  'maid_headdress', 'natsume_winter_coat', 'coat', 'fur_trim',
  'natsume_sleepwear', 'blue_shirt', 'pillow', 'on_bed', 'hair_ribbon',
  'casual_clothes', 'adult', 'sweater', 'apron', 'sportswear',
  'swimsuit', 'beach_coverup', 'yukata', 'kimono', 'evening_gown',
  'dress_unzipped', 'oversized_sweater', 'oversized_shirt',
  'slip_dress', 'witch_costume', 'cafe_uniform', 'loose_pajamas',
].map(normalizeToken));

const CATEGORY_PATTERNS: any = Object.freeze({
  emotion: /^(?:smile|gentle_smile|shy_smile|smiling|blush|heavy_blush|shy|panicked|open_mouth|happy|in_love|pouting|laughing|tears(?:_.+)?|teary(?:_.+)?|closed_eyes|grinning|content|calm|embarrassed)$/,
  action: /^(?:standing(?:_.+)?|sitting(?:_.+)?|walking(?:_.+)?|leaning(?:_.+)?|lying(?:_.+)?|looking_back|over_shoulder|turning(?:_.+)?|kneeling(?:_.+)?|crouching(?:_.+)?|running(?:_.+)?|holding(?:_.+)?|one_hand_.+|both_hands.+|adjusting_.+|playing(?:_.+)?|reading(?:_.+)?|writing(?:_.+)?|drinking(?:_.+)?|eating(?:_.+)?|sleeping(?:_.+)?|reaching(?:_.+)?|waiting)$/,
  place: /^(?:classroom(?:_.+)?|cafe(?:_.+)?|bedroom(?:_.+)?|street(?:_.+)?|shrine(?:_.+)?|beach(?:_.+)?|library(?:_.+)?|park(?:_.+)?|rooftop(?:_.+)?|kitchen(?:_.+)?|train(?:_.+)?|station(?:_.+)?|river(?:_.+)?|festival(?:_.+)?|garden(?:_.+)?|forest(?:_.+)?|lake(?:_.+)?|sea(?:_.+)?|window(?:_.+)?|door(?:_.+)?|kotatsu|veranda|balcony|pool|onsen|bath|hallway|corridor|stage|auditorium|gym|bathroom|museum|aquarium|greenhouse|temple|pagoda|bridge|tunnel|cliff|valley|cave|campfire|hotel(?:_.+)?|mansion|courtyard|alley|intersection|store|bakery|arcade|movie_theater|theater|bar_counter|wooden_bar_counter|arched_window|photo_studio|locker_room|office|study)$/,
  weather: /^(?:snow(?:_.+)?|snowfall|rain(?:_.+)?|rainy(?:_.+)?|clear_sky|cloudy|overcast|night|afternoon|morning(?:_.+)?|day|daytime|evening|dusk|dawn|sunset|summer(?:_.+)?|winter(?:_.+)?|spring(?:_.+)?|autumn(?:_.+)?|wind|clouds|sunshine|storm|fog(?:_.+)?|mist)$/,
  prop: /^(?:gift(?:_.+)?|game_controller|papers|notes|glass|cup|coffee(?:_.+)?|tea(?:_.+)?|phone|book(?:_.+)?|umbrella|flower|bouquet|sword|staff|wand|broom|bag|backpack|hat|scarf|muffler|gloves|camera|photo(?:_.+)?|frame|charm|talisman|plush|cat|dog|food|cake|sweets|balloon|lantern|fireworks|sparkler|pastry|pillow|sofa|couch|desk|chair|bench|table|bedding|blanket|floor|cushion|basket|brush|ice_cream|cotton_candy|biometric_sensor|shopping_basket)$/,
});

function normalizeToken(value: any) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function promptTokens(prompt: any) {
  return String(prompt || '')
    .split(/\r?\n/, 1)[0]
    .split(',')
    .map((token: any) => token.trim())
    .filter(Boolean);
}

function categoryOf(token: any) {
  const key = normalizeToken(token);
  return Object.keys(CATEGORY_PATTERNS)
    .find((category: any) => CATEGORY_PATTERNS[category].test(key)) || '';
}

function isStructuralToken(token: any, character: any) {
  const key = normalizeToken(token);
  const anchors = IDENTITY_ANCHORS[character] || [];
  return anchors.some((anchor: any) => normalizeToken(anchor) === key)
    || QUALITY_TOKENS.includes(key)
    || key === QUALITY_CONTROL_TOKEN[character]
    || key === 'safe'
    || key === 'nsfw'
    || key === 'r15'
    || key.startsWith('@')
    || AMBIENCE_TOKENS.has(key)
    || CAMERA_TOKENS.has(key)
    || OUTFIT_TOKENS.has(key)
    || /(?:^|_)(?:hair|eyes?|eyebrows?|twintails?|braids?|ribbons?)$/.test(key)
    || /(?:^|_)(?:clothes|outfit|uniform|dress|skirt|shirt|sweater|cardigan|apron|coat|swimsuit|yukata|kimono|nightgown|sleepwear|sportswear)$/.test(key);
}

function inspectShortPrompt(prompt: any, options: any = {}) {
  const character = String(options.character || '');
  const rating = String(options.rating || 'ALL').toUpperCase();
  const tokens = promptTokens(prompt);
  const normalized = tokens.map(normalizeToken);
  const tokenSet = new Set(normalized);
  const errors: any[] = [];
  const warnings: any[] = [];
  const anchors = IDENTITY_ANCHORS[character] || [];
  const missingAnchors = anchors.filter((token: any) => !tokenSet.has(normalizeToken(token)));
  if (missingAnchors.length) errors.push(`缺少角色锚点：${missingAnchors.join(', ')}`);

  const missingQuality = QUALITY_TOKENS.filter((token: any) => !tokenSet.has(token));
  if (missingQuality.length) errors.push(`缺少质量词：${missingQuality.join(', ')}`);
  const qualityCount = normalized.filter((token: any) => QUALITY_TOKENS.includes(token)).length;
  if (qualityCount !== QUALITY_TOKENS.length) {
    errors.push(`质量词必须恰好 ${QUALITY_TOKENS.length} 个，当前 ${qualityCount} 个`);
  }

  const controlToken = QUALITY_CONTROL_TOKEN[character];
  if (controlToken && !tokenSet.has(controlToken)) {
    errors.push(`缺少当前 LoRA 的质量控制词：${controlToken}`);
  }
  const expectedRating = rating === 'R18' ? 'nsfw' : 'safe';
  if (!tokenSet.has(expectedRating)) errors.push(`缺少评级词：${expectedRating}`);
  if (rating !== 'R18') {
    const leaked = normalized.filter((token: any) => EXPLICIT_ADULT_TOKENS.has(token));
    if (leaked.length) errors.push(`safe prompt 含显式成人词：${[...new Set(leaked)].join(', ')}`);
  }

  const artists = tokens.filter((token: any) => token.startsWith('@'));
  const invalidArtists = artists.filter((token: any) => !/^@[a-z0-9][a-z0-9 _-]*$/i.test(token));
  if (invalidArtists.length) errors.push(`画师格式无效：${invalidArtists.join(', ')}`);
  if (options.requireHouseArtists !== false) {
    const missingArtists = REQUIRED_ARTISTS.filter((token: any) => !tokens.includes(token));
    if (missingArtists.length) errors.push(`缺少画师词：${missingArtists.join(', ')}`);
  }

  const categories: any = { place: 0, weather: 0, prop: 0, action: 0, emotion: 0, entity: 0 };
  normalized.forEach((token: any) => {
    if (isStructuralToken(token, character)) return;
    const category = categoryOf(token);
    if (category) categories[category] += 1;
    else categories.entity += 1;
  });
  const entityCount = categories.place + categories.weather + categories.prop + categories.entity;
  if (entityCount < 2 || entityCount > 4) {
    errors.push(`场景实体词必须 2-4 个，当前 ${entityCount} 个`);
  }
  const actionEmotionCount = categories.action + categories.emotion;
  if (actionEmotionCount > 2) errors.push(`动作/情绪词最多 2 个，当前 ${actionEmotionCount} 个`);
  if (categories.emotion > 1) errors.push(`情绪词最多 1 个，当前 ${categories.emotion} 个`);
  if (categories.action > 1) errors.push(`动作词最多 1 个，当前 ${categories.action} 个`);

  const ambienceCount = normalized.filter((token: any) => AMBIENCE_TOKENS.has(token)).length;
  if (ambienceCount < 2) errors.push(`氛围/光照词至少 2 个，当前 ${ambienceCount} 个`);
  if (tokens.length < 22 || tokens.length > 26) {
    errors.push(`短提示词必须 22-26 个 token，当前 ${tokens.length} 个`);
  }

  return {
    ok: errors.length === 0,
    tokenCount: tokens.length,
    entityCount,
    actionEmotionCount,
    ambienceCount,
    artists,
    categories,
    errors,
    warnings,
  };
}

function inspectCandidatePrompt(candidate: any) {
  const engine = String(candidate && candidate.engine || '');
  const prompt = String(candidate && candidate.prompt || '');
  const tokens = promptTokens(prompt);
  const normalized = tokens.map(normalizeToken);
  const artists = tokens.filter((token: any) => token.startsWith('@'));
  const warnings: any[] = [];
  if (engine === 'anima') {
    const invalidArtists = artists.filter((token: any) => !/^@[a-z0-9][a-z0-9 _-]*$/i.test(token));
    if (invalidArtists.length) warnings.push(`画师格式无效：${invalidArtists.join(', ')}`);
  }
  if (engine === 'krea2' && (artists.length || /score_\d+|<lora:/i.test(prompt))) {
    warnings.push('Krea 2 不应包含画师 tag、score 或 LoRA 语法');
  }
  const entityCount = normalized.filter((token: any) => {
    if (isStructuralToken(token, String(candidate && candidate.characterId || ''))) return false;
    const category = categoryOf(token);
    return category === 'place' || category === 'weather' || category === 'prop';
  }).length;
  if (candidate && (candidate.batch === 'artist' || candidate.batch === 'artist-grid')) {
    if (candidate.artistId && engine === 'anima' && artists.length !== 1) {
      warnings.push(`Anima 画师候选必须恰好一个 @artist，当前 ${artists.length} 个`);
    }
  }
  if (candidate && (candidate.batch === 'popular' || candidate.batch === 'popular-grid')) {
    if (!tokens.length) warnings.push('热门角色候选 prompt 为空');
    if (candidate.adultEligibility !== 'adult'
      && normalized.some((token: any) => EXPLICIT_ADULT_TOKENS.has(token))) {
      warnings.push('非成人热门角色含显式成人词');
    }
  }
  return {
    ok: warnings.length === 0,
    tokenCount: tokens.length,
    entityCount,
    artists,
    warnings,
  };
}

function assertShortPrompt(prompt: any, options: any) {
  const report = inspectShortPrompt(prompt, options);
  if (!report.ok) {
    const error = new Error(`prompt contract failed: ${report.errors.join('；')}`);
    error.code = 'PROMPT_CONTRACT_FAILED';
    error.report = report;
    throw error;
  }
  return report;
}

function buildSeedReview(seeds: any) {
  return {
    version: 1,
    threshold: 90,
    dimensions: [...REVIEW_DIMENSIONS],
    candidates: seeds.map((seed: any) => ({
      seed,
      scores: Object.fromEntries(REVIEW_DIMENSIONS.map((dimension: any) => [dimension, null])),
      notes: '',
    })),
    qualified: false,
    selectedSeed: null,
  };
}

function evaluateSeedReview(review: any, expectedSeeds: any) {
  const seeds = [...expectedSeeds];
  const candidates = Array.isArray(review && review.candidates) ? review.candidates : [];
  const bySeed = new Map(candidates.map((candidate: any) => [Number(candidate.seed), candidate]));
  const scored = seeds.map((seed: any) => {
    const candidate = bySeed.get(seed);
    const scores = candidate && candidate.scores && typeof candidate.scores === 'object'
      ? candidate.scores
      : {};
    const rawValues = REVIEW_DIMENSIONS.map((dimension: any) => scores[dimension]);
    const values = rawValues.map((value: any) => Number(value));
    const complete = rawValues.every((value: any) => value !== null && value !== undefined && value !== '')
      && values.every((value: any) => Number.isFinite(value) && value >= 0 && value <= 20);
    const total = complete ? values.reduce((sum: any, value: any) => sum + value, 0) : null;
    return { seed, complete, total, notes: candidate ? String(candidate.notes || '') : '' };
  });
  const complete = scored.every((candidate: any) => candidate.complete);
  const qualified = complete && scored.every((candidate: any) => candidate.total >= 90);
  const selected = qualified
    ? [...scored].sort((left: any, right: any) => right.total - left.total || left.seed - right.seed)[0]
    : null;
  return {
    complete,
    qualified,
    threshold: 90,
    candidates: scored,
    selectedSeed: selected ? selected.seed : null,
  };
}

export = {
  QUALITY_TOKENS,
  REQUIRED_ARTISTS,
  EXPLICIT_ADULT_TOKENS,
  IDENTITY_ANCHORS,
  QUALITY_CONTROL_TOKEN,
  REVIEW_DIMENSIONS,
  CATEGORY_PATTERNS,
  normalizeToken,
  promptTokens,
  categoryOf,
  isStructuralToken,
  inspectShortPrompt,
  inspectCandidatePrompt,
  assertShortPrompt,
  buildSeedReview,
  evaluateSeedReview,
};
